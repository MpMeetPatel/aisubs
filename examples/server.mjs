import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FileCredentialStore,
  chatGptProvider,
  copilotProvider,
  createSubscriptionAuth,
  grokProvider,
} from "aisubs";
import { createSubscriptionAuthServer } from "aisubs/http";

const apiKey = process.env.AISUBS_API_KEY ?? randomBytes(24).toString("hex");
const auth = createSubscriptionAuth({
  store: new FileCredentialStore(join(homedir(), ".aisubs-demo", "credentials.json")),
  providers: [chatGptProvider(), copilotProvider(), grokProvider()],
});
const server = await createSubscriptionAuthServer({ auth, apiKey, port: 4319 });
console.log(`AI Subs API: ${server.url}`);
console.log(`API key: ${apiKey}`);
