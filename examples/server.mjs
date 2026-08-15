import { homedir } from "node:os";
import { join } from "node:path";
import {
  FileCredentialStore,
  FileApiKeyStore,
  chatGptProvider,
  copilotProvider,
  createSubscriptionAuth,
  grokProvider,
} from "aisubs";
import { createSubscriptionAuthServer } from "aisubs/http";

const directory = join(homedir(), ".aisubs-demo");
const apiKey =
  process.env.AISUBS_API_KEY ??
  (await new FileApiKeyStore(join(directory, "api-key")).readOrCreate());
const auth = createSubscriptionAuth({
  store: new FileCredentialStore(join(directory, "credentials.json")),
  providers: [chatGptProvider(), copilotProvider(), grokProvider()],
});
const server = await createSubscriptionAuthServer({ auth, apiKey, port: 4319 });
console.log(`AI Subs API: ${server.url}`);
