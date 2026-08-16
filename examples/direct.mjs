import { homedir } from "node:os";
import { join } from "node:path";
import {
  FileCredentialStore,
  chatGptProvider,
  claudeProvider,
  copilotProvider,
  createSubscriptionAuth,
  grokProvider,
  openCodeGoProvider,
  openCodeZenProvider,
} from "aisubs";

const provider = process.argv[2] ?? "chatgpt";
const accountKey = process.argv[3] ?? "default";
const providers = [
  chatGptProvider(),
  claudeProvider(),
  copilotProvider(),
  grokProvider(),
  openCodeGoProvider(),
  openCodeZenProvider(),
];
if (!providers.some((candidate) => candidate.id === provider)) {
  throw new Error(`Use one of: ${providers.map((candidate) => candidate.id).join(", ")}`);
}

const auth = createSubscriptionAuth({
  store: new FileCredentialStore(join(homedir(), ".aisubs-demo", "credentials.json")),
  providers,
});
const account = auth.account(provider, accountKey);

if (!(await account.status()).authenticated) {
  const apiKey =
    provider === "opencode-go"
      ? process.env.OPENCODE_GO_API_KEY
      : provider === "opencode-zen"
        ? process.env.OPENCODE_API_KEY
        : undefined;
  if (provider.startsWith("opencode-") && !apiKey) {
    throw new Error(
      provider === "opencode-go"
        ? "Set OPENCODE_GO_API_KEY before signing in"
        : "Set OPENCODE_API_KEY before signing in",
    );
  }
  const login = await account.signIn(apiKey ? { apiKey } : undefined);
  if (login.prompt.mode === "browser") {
    console.log(`Open ${login.prompt.authorizationUri}`);
  } else if (login.prompt.mode === "device") {
    console.log(`Open ${login.prompt.verificationUri}`);
    console.log(`Enter code: ${login.prompt.userCode}`);
  }
  await login.wait();
  console.log("Signed in; refresh credentials were saved securely.");
}

// In-process SDK request: no localhost server, port, CORS, or control API key.
const catalog = await account.getModels();
console.log(catalog?.models ?? []);
