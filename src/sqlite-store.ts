import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  CoordinatedCredentialStore,
  OAuthCredential,
  ProviderId,
  VersionedCredential,
} from "./types.js";

type CredentialRow = { credential_json: string; version: number };

/** Node SQLite persistence. Pass a DatabaseSync to share a host-owned connection. */
export class SqliteCredentialStore implements CoordinatedCredentialStore {
  private readonly database: DatabaseSync;
  private readonly ownsConnection: boolean;
  private readonly queues = new Map<ProviderId, Promise<void>>();

  constructor(database: string | DatabaseSync) {
    if (typeof database === "string") {
      mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(database, { timeout: 5_000 });
      this.ownsConnection = true;
    } else {
      this.database = database;
      this.ownsConnection = false;
    }
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS aisubs_credentials (
        account_key TEXT PRIMARY KEY,
        credential_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS aisubs_refresh_claims (
        account_key TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL UNIQUE,
        credential_version INTEGER NOT NULL,
        account_generation INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS aisubs_account_generations (
        account_key TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS aisubs_operations (
        operation_id TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS aisubs_api_keys (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  async read(provider: ProviderId): Promise<OAuthCredential | null> {
    const row = this.row(provider);
    return row ? (JSON.parse(row.credential_json) as OAuthCredential) : null;
  }

  async listKeys(): Promise<string[]> {
    return (
      this.database.prepare("SELECT account_key FROM aisubs_credentials ORDER BY rowid").all() as {
        account_key: string;
      }[]
    ).map(({ account_key }) => account_key);
  }

  async readVersioned(provider: ProviderId): Promise<VersionedCredential> {
    const row = this.row(provider);
    return {
      credential: row ? (JSON.parse(row.credential_json) as OAuthCredential) : null,
      version: row?.version ?? 0,
      generation: this.generation(provider),
    };
  }

  async replaceCredential(input: {
    provider: ProviderId;
    credential: OAuthCredential;
    expectedGeneration: number;
    operationId: string;
  }): Promise<{ applied: boolean; record: VersionedCredential }> {
    const replay = this.operation(input.operationId);
    if (replay) return replay;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const generation = this.generation(input.provider);
      if (generation !== input.expectedGeneration) {
        const result = { applied: false, record: this.versioned(input.provider) };
        this.rememberOperation(input.operationId, result);
        this.database.exec("COMMIT");
        return result;
      }
      this.writeCredential(input.provider, input.credential);
      this.setGeneration(input.provider, generation + 1);
      this.database
        .prepare("DELETE FROM aisubs_refresh_claims WHERE account_key = ?")
        .run(input.provider);
      const result = { applied: true, record: this.versioned(input.provider) };
      this.rememberOperation(input.operationId, result);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async deleteCredential(input: { provider: ProviderId; operationId: string }): Promise<void> {
    if (this.operation(input.operationId)) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("DELETE FROM aisubs_credentials WHERE account_key = ?")
        .run(input.provider);
      this.database
        .prepare("DELETE FROM aisubs_refresh_claims WHERE account_key = ?")
        .run(input.provider);
      this.setGeneration(input.provider, this.generation(input.provider) + 1);
      this.rememberOperation(input.operationId, { applied: true });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async claimRefresh(input: {
    provider: ProviderId;
    expectedVersion: number;
    expectedGeneration: number;
    claimId: string;
    operationId: string;
  }): Promise<"claimed" | "busy" | "changed" | "missing"> {
    const replay = this.operation(input.operationId) as
      | { value?: "claimed" | "busy" | "changed" | "missing" }
      | undefined;
    if (replay?.value) return replay.value;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.row(input.provider);
      const generation = this.generation(input.provider);
      const value = !row
        ? "missing"
        : row.version !== input.expectedVersion || generation !== input.expectedGeneration
          ? "changed"
          : this.database
                .prepare("SELECT 1 FROM aisubs_refresh_claims WHERE account_key = ?")
                .get(input.provider)
            ? "busy"
            : "claimed";
      if (value === "claimed") {
        this.database
          .prepare(`INSERT INTO aisubs_refresh_claims(account_key, claim_id, credential_version, account_generation, created_at)
            VALUES(?, ?, ?, ?, ?)`)
          .run(
            input.provider,
            input.claimId,
            input.expectedVersion,
            input.expectedGeneration,
            Date.now(),
          );
      }
      this.rememberOperation(input.operationId, { value });
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async commitRefresh(input: {
    provider: ProviderId;
    claimId: string;
    expectedGeneration: number;
    credential: OAuthCredential;
    operationId: string;
  }): Promise<{ applied: boolean; record: VersionedCredential }> {
    const replay = this.operation(input.operationId);
    if (replay) return replay;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const claim = this.database
        .prepare(`SELECT account_generation FROM aisubs_refresh_claims
          WHERE account_key = ? AND claim_id = ?`)
        .get(input.provider, input.claimId) as { account_generation: number } | undefined;
      const applied = Boolean(
        claim &&
        claim.account_generation === input.expectedGeneration &&
        this.generation(input.provider) === input.expectedGeneration,
      );
      if (applied) {
        this.writeCredential(input.provider, input.credential);
        this.database
          .prepare("DELETE FROM aisubs_refresh_claims WHERE account_key = ? AND claim_id = ?")
          .run(input.provider, input.claimId);
      }
      const result = { applied, record: this.versioned(input.provider) };
      this.rememberOperation(input.operationId, result);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
      for (;;) {
        const observed = this.row(provider);
        result = await update(
          observed ? (JSON.parse(observed.credential_json) as OAuthCredential) : null,
        );
        this.database.exec("BEGIN IMMEDIATE");
        try {
          const latest = this.row(provider);
          if ((latest?.version ?? 0) !== (observed?.version ?? 0)) {
            this.database.exec("ROLLBACK");
            continue;
          }
          if (result) {
            this.database
              .prepare(`INSERT INTO aisubs_credentials(account_key, credential_json, version, updated_at)
                VALUES(?, ?, 1, ?)
                ON CONFLICT(account_key) DO UPDATE SET credential_json = excluded.credential_json,
                  version = aisubs_credentials.version + 1, updated_at = excluded.updated_at`)
              .run(provider, JSON.stringify(result), Date.now());
          } else {
            this.database
              .prepare("DELETE FROM aisubs_credentials WHERE account_key = ?")
              .run(provider);
          }
          this.database.exec("COMMIT");
          return;
        } catch (error) {
          this.database.exec("ROLLBACK");
          throw error;
        }
      }
    });
    const settled = current.catch(() => {});
    this.queues.set(provider, settled);
    try {
      await current;
    } finally {
      if (this.queues.get(provider) === settled) this.queues.delete(provider);
    }
    return result;
  }

  async delete(provider: ProviderId): Promise<void> {
    await this.modify(provider, () => null);
  }

  close(): void {
    if (this.ownsConnection) this.database.close();
  }

  private row(provider: ProviderId): CredentialRow | undefined {
    return this.database
      .prepare("SELECT credential_json, version FROM aisubs_credentials WHERE account_key = ?")
      .get(provider) as CredentialRow | undefined;
  }

  private generation(provider: ProviderId): number {
    const row = this.database
      .prepare("SELECT generation FROM aisubs_account_generations WHERE account_key = ?")
      .get(provider) as { generation: number } | undefined;
    return row?.generation ?? 0;
  }

  private setGeneration(provider: ProviderId, generation: number): void {
    this.database
      .prepare(`INSERT INTO aisubs_account_generations(account_key, generation, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at`)
      .run(provider, generation, Date.now());
  }

  private writeCredential(provider: ProviderId, credential: OAuthCredential): void {
    this.database
      .prepare(`INSERT INTO aisubs_credentials(account_key, credential_json, version, updated_at)
        VALUES(?, ?, 1, ?)
        ON CONFLICT(account_key) DO UPDATE SET credential_json = excluded.credential_json,
          version = aisubs_credentials.version + 1, updated_at = excluded.updated_at`)
      .run(provider, JSON.stringify(credential), Date.now());
  }

  private versioned(provider: ProviderId): VersionedCredential {
    const row = this.row(provider);
    return {
      credential: row ? (JSON.parse(row.credential_json) as OAuthCredential) : null,
      version: row?.version ?? 0,
      generation: this.generation(provider),
    };
  }

  private operation(operationId: string): any | undefined {
    const row = this.database
      .prepare("SELECT result_json FROM aisubs_operations WHERE operation_id = ?")
      .get(operationId) as { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) : undefined;
  }

  private rememberOperation(operationId: string, result: unknown): void {
    this.database
      .prepare(
        "INSERT OR IGNORE INTO aisubs_operations(operation_id, result_json, created_at) VALUES(?, ?, ?)",
      )
      .run(operationId, JSON.stringify(result), Date.now());
  }
}

export class SqliteApiKeyStore {
  private readonly database: DatabaseSync;
  private readonly ownsConnection: boolean;

  constructor(database: string | DatabaseSync) {
    if (typeof database === "string") {
      mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(database, { timeout: 5_000 });
      this.ownsConnection = true;
    } else {
      this.database = database;
      this.ownsConnection = false;
    }
    this.database.exec(`CREATE TABLE IF NOT EXISTS aisubs_api_keys (
      name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;`);
  }

  async readOrCreate(): Promise<string> {
    const existing = this.read();
    if (existing) return existing;
    const value = apiKey();
    this.database
      .prepare(
        "INSERT OR IGNORE INTO aisubs_api_keys(name, value, updated_at) VALUES('default', ?, ?)",
      )
      .run(value, Date.now());
    return this.read() ?? value;
  }

  async regenerate(): Promise<string> {
    const value = apiKey();
    this.database
      .prepare(`INSERT INTO aisubs_api_keys(name, value, updated_at) VALUES('default', ?, ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(value, Date.now());
    return value;
  }

  close(): void {
    if (this.ownsConnection) this.database.close();
  }

  private read(): string | null {
    const row = this.database
      .prepare("SELECT value FROM aisubs_api_keys WHERE name = 'default'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  }
}

function apiKey(): string {
  return `aisubs_${randomBytes(32).toString("base64url")}_${randomUUID().slice(0, 8)}`;
}
