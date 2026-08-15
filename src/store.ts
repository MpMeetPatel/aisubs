import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CredentialStore, OAuthCredential, ProviderId } from "./types.js";
import { abortableDelay, isRecord } from "./utils.js";

const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 120_000;

export function defaultAiSubsDataDir(): string {
  const override = process.env.AISUBS_DATA_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".aisubs");
}

async function readEnvelope(file: string): Promise<Record<string, OAuthCredential>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? (parsed as Record<string, OAuthCredential>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function withFileLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS)
          await rm(path, { force: true });
      } catch {}
      if (Date.now() >= deadline) throw new Error("Timed out waiting for credential-store lock");
      await abortableDelay(25);
    }
  }
  try {
    return await task();
  } finally {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
  }
}

async function writeEnvelope(file: string, value: Record<string, OAuthCredential>): Promise<void> {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, file);
    if (process.platform !== "win32") await chmod(file, 0o600);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async read(provider: ProviderId): Promise<OAuthCredential | null> {
    return (await readEnvelope(this.file))[provider] ?? null;
  }

  async listKeys(): Promise<string[]> {
    return Object.keys(await readEnvelope(this.file));
  }

  async modify(
    provider: ProviderId,
    update: (
      current: OAuthCredential | null,
    ) => OAuthCredential | null | Promise<OAuthCredential | null>,
  ): Promise<OAuthCredential | null> {
    const lockId = createHash("sha256").update(provider).digest("hex");
    return withFileLock(join(dirname(this.file), `${lockId}.credential.lock`), async () => {
      const next = await update(await this.read(provider));
      await withFileLock(`${this.file}.lock`, async () => {
        const all = await readEnvelope(this.file);
        if (next) all[provider] = next;
        else delete all[provider];
        await writeEnvelope(this.file, all);
      });
      return next;
    });
  }

  async delete(provider: ProviderId): Promise<void> {
    await this.modify(provider, () => null);
  }
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<ProviderId, OAuthCredential>();
  private readonly queues = new Map<ProviderId, Promise<void>>();

  async read(provider: ProviderId): Promise<OAuthCredential | null> {
    return this.values.get(provider) ?? null;
  }

  async listKeys(): Promise<string[]> {
    return [...this.values.keys()];
  }

  async modify(
    provider: ProviderId,
    update: (
      current: OAuthCredential | null,
    ) => OAuthCredential | null | Promise<OAuthCredential | null>,
  ): Promise<OAuthCredential | null> {
    const previous = this.queues.get(provider) ?? Promise.resolve();
    let result: OAuthCredential | null = null;
    const current = previous.then(async () => {
      result = await update(this.values.get(provider) ?? null);
      if (result) this.values.set(provider, result);
      else this.values.delete(provider);
    });
    this.queues.set(
      provider,
      current.catch(() => {}),
    );
    await current;
    return result;
  }

  async delete(provider: ProviderId): Promise<void> {
    await this.modify(provider, () => null);
  }
}
