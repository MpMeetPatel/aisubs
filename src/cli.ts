#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { createSubscriptionAuth } from "./auth.js";
import { createSubscriptionAuthDashboardServer } from "./dashboard.js";
import { chatGptProvider } from "./providers/chatgpt.js";
import { claudeProvider } from "./providers/claude.js";
import { copilotProvider } from "./providers/copilot.js";
import { grokProvider } from "./providers/grok.js";
import { openCodeGoProvider, openCodeZenProvider } from "./providers/opencode.js";
import { defaultAiSubsDataDir, FileCredentialStore } from "./store.js";

const DEFAULT_DASHBOARD_PORT = 4319;

function usage(): void {
  console.log(`AI Subs

Usage:
  aisubs dashboard [options]

Options:
  --data-dir <path>       State directory (default: ~/.aisubs)
  --port <number>         Local port (default: 4319; use 0 for any available port)
  --no-open               Print the secure link without opening a browser
  --help                   Show this help
`);
}

function value(args: string[], index: number, flag: string): string {
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
  return next;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    usage();
    return;
  }
  const command = args[0];
  if (command !== "dashboard") throw new Error(`Unknown command: ${command}`);

  let dataDirectory = defaultAiSubsDataDir();
  let port = DEFAULT_DASHBOARD_PORT;
  let shouldOpen = true;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") shouldOpen = false;
    else if (argument === "--data-dir") dataDirectory = resolve(value(args, index++, argument));
    else if (argument === "--port") port = Number(value(args, index++, argument));
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");

  const store = new FileCredentialStore(join(dataDirectory, "credentials.json"));
  const auth = createSubscriptionAuth({
    store,
    providers: [
      chatGptProvider(),
      claudeProvider(),
      copilotProvider(),
      grokProvider(),
      openCodeGoProvider(),
      openCodeZenProvider(),
    ],
  });
  const dashboard = await createSubscriptionAuthDashboardServer({ auth, port });

  console.log(`AI Subs is running at ${dashboard.url}`);
  console.log(`Credentials: ${store.file}`);
  console.log(`Control API key: ${dashboard.apiKey}`);
  console.log(`Dashboard link: ${dashboard.bootstrapUrl}`);
  console.log("Press Ctrl+C to stop.");
  if (shouldOpen) openBrowser(dashboard.bootstrapUrl);

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await dashboard.close();
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
