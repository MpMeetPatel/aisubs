#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const home = homedir();
const base = (process.env.AISUBS_URL ?? "http://127.0.0.1:4319").replace(/\/+$/, "");
const keyPath = join(home, ".aisubs", "api-key");
const key = (
  process.env.AISUBS_API_KEY ?? (await readFile(keyPath, "utf8").catch(() => ""))
).trim();
const output = process.env.CODEX_CATALOG ?? join(home, ".codex", "aisubs-catalog.json");
const codexConfig = process.env.CODEX_CONFIG ?? join(home, ".codex", "config.toml");
const providers = (
  process.env.AISUBS_PROVIDERS ?? "chatgpt,claude,copilot,grok,opencode-go,opencode-zen"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!key) throw new Error(`AISubs API key not found in ${keyPath}`);

const message = (error) => (error instanceof Error ? error.message : String(error));

const headers = { authorization: `Bearer ${key}`, accept: "application/json" };
async function get(path) {
  const response = await fetch(`${base}${path}`, { headers });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    const failure = body?.error;
    const detail =
      typeof body === "string"
        ? body.slice(0, 240)
        : typeof failure === "string"
          ? failure
          : (failure?.message ?? body?.message ?? response.status);
    throw new Error(`${path}: ${detail}`);
  }
  return body;
}

try {
  await get("/health");
} catch (error) {
  throw new Error(
    `AISubs is not reachable at ${base}. Start it with "nub run dev" and run this command again. ${message(error)}`,
  );
}

const native = await readFile(join(home, ".codex", "models_cache.json"), "utf8")
  .then(JSON.parse)
  .catch(() => ({ models: [] }));
const template = native.models?.[0] ?? {
  default_reasoning_level: "medium",
  supported_reasoning_levels: ["low", "medium", "high"].map((effort) => ({ effort })),
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
};
const entries = new Map();
const failures = [];
const usable = (model) => {
  const endpoints = model.capabilities?.endpoints ?? model.endpoints ?? [];
  return endpoints.some((endpoint) => {
    const normalized = String(endpoint).replace(/^\/?(?:v1\/)?/, "");
    return (
      ["responses", "chat/completions", "messages"].includes(normalized) ||
      normalized.startsWith("models/")
    );
  });
};
for (const provider of providers) {
  let accounts;
  try {
    accounts = await get(`/v1/auth/${provider}/accounts`);
  } catch (error) {
    failures.push(`${provider}: ${message(error)}`);
    continue;
  }
  for (const account of accounts.accounts ?? accounts) {
    // The account-list API returns the route key as `accountKey`; `account`
    // is the nested display/identity object.
    const accountId = account.accountKey ?? account.account ?? account.name;
    if (!accountId) continue;
    let catalog;
    try {
      catalog = await get(`/aisubs/${provider}/${encodeURIComponent(accountId)}/v1/models`);
    } catch (error) {
      failures.push(`${provider}/${accountId}: ${message(error)}`);
      continue;
    }
    for (const model of catalog.data ?? catalog.models ?? []) {
      const id = model.id;
      if (!id) continue;
      if (!usable(model)) continue;
      // GitHub currently advertises this legacy alias but rejects it at
      // generation time (the backend asks for gpt-5-mini-2025-08-07).
      // Omitting it prevents Codex from presenting a model that cannot run.
      if (provider === "copilot" && id === "gpt-5-mini") continue;
      // Keep OpenAI/ChatGPT's official catalog entries native. Re-emitting
      // them as `chatgpt/<model>` makes Codex treat them as third-party IDs
      // and reject them for ChatGPT-authenticated sessions.
      if (provider === "chatgpt") continue;
      const slug = `${provider}/${id}`;
      if (entries.has(slug)) continue;
      entries.set(slug, {
        ...template,
        slug,
        display_name: `${provider} / ${id}`,
        description: `AISubs ${provider} account ${accountId}`,
        visibility: "list",
        supported_in_api: true,
        priority: 10,
        additional_speed_tiers: undefined,
        service_tiers: undefined,
        aisubs_provider: provider,
        aisubs_account: accountId,
        aisubs_model: id,
      });
    }
  }
}

const clean = [...entries.values()].map((entry) =>
  Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)),
);
if (!clean.length) {
  const detail = failures.length ? `\n${failures.join("\n")}` : "";
  throw new Error(
    `No non-ChatGPT models were discovered; refusing to overwrite the existing catalog.${detail}`,
  );
}
// Codex has one active provider per configuration. Keep this catalog scoped to
// AISubs models; native models are restored by the dashboard's Restore action.
// Mixing native IDs here makes Codex probe them through the AISubs provider.
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ models: clean }, null, 2)}\n`, { mode: 0o600 });
await syncCodexConfig();
console.log(`Wrote ${clean.length} models to ${output}`);
if (failures.length) console.warn(`Some accounts were skipped:\n${failures.join("\n")}`);

function setRootSetting(config, name, value) {
  const firstTable = config.search(/^\[/m);
  const rootEnd = firstTable < 0 ? config.length : firstTable;
  const root = config.slice(0, rootEnd);
  const rest = config.slice(rootEnd);
  const pattern = new RegExp(`^${name}\\s*=.*$`, "m");
  if (pattern.test(root)) return `${root.replace(pattern, value)}${rest}`;

  const updatedRoot = `${root.trimEnd()}${root.trim() ? "\n" : ""}${value}\n`;
  return rest ? `${updatedRoot}\n${rest}` : updatedRoot;
}

async function syncCodexConfig() {
  await mkdir(dirname(codexConfig), { recursive: true });
  let config = await readFile(codexConfig, "utf8").catch(() => "");
  const previousKey = config.match(/^AISUBS_API_KEY\s*=\s*"([^"]+)"/m)?.[1];
  const keyRotated = previousKey && previousKey !== key;
  config = setRootSetting(
    config,
    "model_catalog_json",
    `model_catalog_json = ${JSON.stringify(output)}`,
  );
  // Codex has one active model_provider per config. Native models are restored
  // by switching back to the official provider/profile.
  config = setRootSetting(config, "model_provider", 'model_provider = "aisubs-codex"');
  const providerBlock = `[model_providers.aisubs-codex]\nname = "AISubs Codex Router"\nbase_url = "${base}/aisubs-codex/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nenv_key = "AISUBS_API_KEY"\n`;
  const providerPattern = /\[model_providers\.aisubs-codex\][\s\S]*?(?=\n\[|$)/;
  config = providerPattern.test(config)
    ? config.replace(providerPattern, providerBlock.trimEnd())
    : `${config.trimEnd()}\n\n${providerBlock}`;

  const envLine = `AISUBS_API_KEY = ${JSON.stringify(key)}`;
  if (/^\[shell_environment_policy\.set\]$/m.test(config)) {
    const marker = "[shell_environment_policy.set]";
    const start = config.indexOf(marker) + marker.length;
    const next = config.indexOf("\n[", start);
    const end = next < 0 ? config.length : next;
    const section = config.slice(start, end);
    config = /^AISUBS_API_KEY\s*=.*$/m.test(section)
      ? `${config.slice(0, start)}${section.replace(/^AISUBS_API_KEY\s*=.*$/m, envLine)}${config.slice(end)}`
      : `${config.slice(0, end)}\n${envLine}${config.slice(end)}`;
  } else {
    config += `\n\n[shell_environment_policy.set]\n${envLine}\n`;
  }
  await writeFile(codexConfig, config, { mode: 0o600 });
  console.log(`Updated ${codexConfig}`);
  if (keyRotated) {
    console.log(
      `\nAISubs API key changed. Next steps:\n` +
        `1. Restart the AISubs server (nub run dev).\n` +
        `2. Restart Codex Desktop completely.\n` +
        `3. Run this sync again if the model catalog is stale.\n` +
        `4. Send a small test prompt before normal use.\n`,
    );
  }
}
