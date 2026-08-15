import { homedir } from "node:os";
import { join } from "node:path";
import {
  FileCredentialStore,
  chatGptProvider,
  copilotProvider,
  createSubscriptionAuth,
  grokProvider,
} from "aisubs";

const provider = process.argv[2] ?? "chatgpt";
const accountKey = process.argv[3] ?? "default";
if (!["chatgpt", "copilot", "grok"].includes(provider)) {
  throw new Error("Use chatgpt, copilot, or grok");
}

const auth = createSubscriptionAuth({
  store: new FileCredentialStore(join(homedir(), ".aisubs-demo", "credentials.json")),
  providers: [chatGptProvider(), copilotProvider(), grokProvider()],
});
const account = auth.account(provider, accountKey);

if (!(await account.status()).authenticated) {
  const login = await account.signIn();
  if (login.prompt.mode === "browser") {
    console.log(`Open ${login.prompt.authorizationUri}`);
  } else if (login.prompt.mode === "device") {
    console.log(`Open ${login.prompt.verificationUri}`);
    console.log(`Enter code: ${login.prompt.userCode}`);
  }
  await login.wait();
  console.log("Signed in; refresh credentials were saved securely.");
}

// In-process request: no localhost server, port, CORS, or control API key.
const response = await account.proxy("models");
console.log(`Provider response: ${response.status}`);
console.log((await response.text()).slice(0, 1000));
