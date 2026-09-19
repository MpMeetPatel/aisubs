import { homedir } from "node:os";
import { join } from "node:path";
import { createSubscriptionAuth } from "aisubs";
import { createSubscriptionAuthServer } from "aisubs/http";
import { SqliteApiKeyStore, SqliteCredentialStore } from "aisubs/node";
import { chatGptProvider } from "aisubs/providers/chatgpt";
import { claudeProvider } from "aisubs/providers/claude";
import { copilotProvider } from "aisubs/providers/copilot";
import { grokProvider } from "aisubs/providers/grok";
import { openCodeGoProvider, openCodeZenProvider } from "aisubs/providers/opencode";

const directory = join(homedir(), ".aisubs-demo");
const database = join(directory, "aisubs.db");
const apiKey = process.env.AISUBS_API_KEY ?? (await new SqliteApiKeyStore(database).readOrCreate());
const auth = createSubscriptionAuth({
  store: new SqliteCredentialStore(database),
  providers: [
    chatGptProvider(),
    claudeProvider(),
    copilotProvider(),
    grokProvider(),
    openCodeGoProvider(),
    openCodeZenProvider(),
  ],
});
const server = await createSubscriptionAuthServer({ auth, apiKey, port: 4319 });
console.log(`AI Subs API: ${server.url}`);
