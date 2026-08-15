<table>
  <tr>
    <td><img src="./dashboard/public/aisubs-mark.svg" alt="AISubs icon" width="72"></td>
    <td><h1>AISubs</h1><strong>Connect your AI subscriptions. Use them anywhere.</strong></td>
  </tr>
</table>

AISubs connects provider accounts once and exposes each account through a local,
account-scoped API. Use it from the official OpenAI or Anthropic SDK, Vercel AI SDK,
TanStack AI, Python, cURL, or an app that accepts a custom API base URL.

<p align="center">
  <img src="./public/aisubs-dashboard.png" alt="AI Subs dashboard with provider connections and local API access" width="100%" />
</p>

<p align="center">
  <img src="./public/aisubs-chatgpt-account.png" alt="AISubs ChatGPT demo account details" width="100%" />
</p>

<p align="center">
  <img src="./public/aisubs-copilot-account.png" alt="AISubs GitHub Copilot demo account details" width="100%" />
</p>

<p align="center">
  <img src="./public/aisubs-grok-account.png" alt="AISubs Grok demo account details" width="100%" />
</p>

> Credentials, API keys, and requests remain on your computer. AISubs collects no
> telemetry or analytics. The dashboard keeps up to 200 redacted account request logs in memory for debugging.

## Quick start

AISubs requires [Node.js 24 or newer](https://nodejs.org/en/download/). Run it
without adding it to a project:

```bash
nubx aisubs@latest dashboard       # Nub
npx aisubs@latest dashboard        # npm
pnpm dlx aisubs@latest dashboard   # pnpm
bunx aisubs@latest dashboard       # Bun
```

The terminal prints only the local dashboard URL. Open it, click **Add account**,
and complete the provider sign-in. The dashboard manages the persistent local API
key: reveal it, copy it, or deliberately regenerate it there.

The default URL is `http://127.0.0.1:4319`. Credentials and the API key are stored
under `~/.aisubs` and reused on later starts.

## Use an account from any compatible app

Open an account in the dashboard and copy its base URL:

```text
http://127.0.0.1:4319/aisubs/PROVIDER/ACCOUNT/v1
```

Then configure the app with:

```text
API base URL: the account URL copied from AISubs
API key:      the persistent key shown on the AISubs dashboard
Model:        an exact model ID shown for that account
```

For apps configured with environment variables:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:4319/aisubs/grok/personal/v1"
export OPENAI_API_KEY="aisubs_..."
```

AISubs removes its local key before forwarding a request and adds only the
selected account's provider credential.

### Compatibility contract

AISubs preserves the provider's native request and response protocol. It also
provides a focused, non-streaming text Chat Completions adapter for ChatGPT
accounts.

| Provider/model protocol            | Base URL                    | Supported request path                  |
| ---------------------------------- | --------------------------- | --------------------------------------- |
| OpenAI Responses                   | Account URL ending in `/v1` | `POST /responses`                       |
| OpenAI-compatible Chat Completions | Account URL ending in `/v1` | `POST /chat/completions`                |
| Anthropic Messages                 | Account URL ending in `/v1` | `POST /messages`                        |
| Google generateContent             | Account URL ending in `/v1` | `POST /models/MODEL_ID:generateContent` |
| Model discovery                    | Account URL ending in `/v1` | `GET /models`                           |

Embeddings are intentionally not exposed. The ChatGPT compatibility adapter
supports text messages and JSON-schema response formats; tools, images, audio,
and streaming Chat Completions remain native-Responses-only features.

## SDK examples

Set the key once for the shell running your client:

```bash
export AISUBS_API_KEY="aisubs_..."
```

<details>
<summary><strong>Official OpenAI JavaScript SDK: Responses and Chat Completions</strong></summary>

Install:

```bash
nub install openai
npm install openai
pnpm add openai
bun add openai
```

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:4319/aisubs/chatgpt/personal/v1",
  apiKey: process.env.AISUBS_API_KEY,
});

const stream = await client.responses.create({
  model: "MODEL_ID_FROM_DASHBOARD",
  input: "Hello from AISubs",
  store: false,
  stream: true,
});

for await (const event of stream) console.log(event);
```

Chat Completions uses the same client with an account/model that reports that
endpoint:

```js
const response = await client.chat.completions.create({
  model: "MODEL_ID_FROM_DASHBOARD",
  messages: [{ role: "user", content: "Hello from AISubs" }],
});

console.log(response.choices[0]?.message.content);
```

</details>

<details>
<summary><strong>Official Anthropic JavaScript SDK</strong></summary>

Install:

```bash
nub install @anthropic-ai/sdk
npm install @anthropic-ai/sdk
pnpm add @anthropic-ai/sdk
bun add @anthropic-ai/sdk
```

```js
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://127.0.0.1:4319/aisubs/claude/team",
  apiKey: process.env.AISUBS_API_KEY,
});

const message = await client.messages.create({
  model: "MODEL_ID_FROM_DASHBOARD",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello from AISubs" }],
});

console.log(message.content);
```

</details>

<details>
<summary><strong>Vercel AI SDK</strong></summary>

For a Responses model:

```bash
nub install ai @ai-sdk/openai
npm install ai @ai-sdk/openai
pnpm add ai @ai-sdk/openai
bun add ai @ai-sdk/openai
```

```js
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

const aisubs = createOpenAI({
  baseURL: "http://127.0.0.1:4319/aisubs/chatgpt/personal/v1",
  apiKey: process.env.AISUBS_API_KEY,
});

const result = streamText({
  model: aisubs.responses("MODEL_ID_FROM_DASHBOARD"),
  prompt: "Hello from AISubs",
  providerOptions: { openai: { store: false } },
});

for await (const text of result.textStream) process.stdout.write(text);
```

For Chat Completions, install `@ai-sdk/openai-compatible`, create the provider
with the same account base URL, and select the model with `provider("MODEL_ID")`.

</details>

<details>
<summary><strong>TanStack AI: Chat Completions</strong></summary>

TanStack's generic compatibility adapter targets Chat Completions. Use it only
for a model that lists `chat/completions`.

```bash
nub install @tanstack/ai @tanstack/ai-openai
npm install @tanstack/ai @tanstack/ai-openai
pnpm add @tanstack/ai @tanstack/ai-openai
bun add @tanstack/ai @tanstack/ai-openai
```

```ts
import { chat } from "@tanstack/ai";
import { openaiCompatible } from "@tanstack/ai-openai/compatible";

const aisubs = openaiCompatible({
  name: "aisubs",
  baseURL: "http://127.0.0.1:4319/aisubs/grok/personal/v1",
  apiKey: process.env.AISUBS_API_KEY!,
  models: ["MODEL_ID_FROM_DASHBOARD"],
});

const stream = chat({
  adapter: aisubs("MODEL_ID_FROM_DASHBOARD"),
  messages: [{ role: "user", content: "Hello from AISubs" }],
});

for await (const event of stream) console.log(event);
```

</details>

<details>
<summary><strong>Python OpenAI SDK</strong></summary>

```bash
python -m pip install openai
```

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:4319/aisubs/grok/personal/v1",
    api_key=os.environ["AISUBS_API_KEY"],
)

response = client.chat.completions.create(
    model="MODEL_ID_FROM_DASHBOARD",
    messages=[{"role": "user", "content": "Hello from AISubs"}],
)
print(response.choices[0].message.content)
```

</details>

<details>
<summary><strong>cURL: Responses, Chat Completions, Anthropic, and Google</strong></summary>

```bash
curl "http://127.0.0.1:4319/aisubs/chatgpt/personal/v1/responses" \
  -H "Authorization: Bearer $AISUBS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID_FROM_DASHBOARD","store":false,"input":"Hello"}'
```

Chat Completions:

```bash
curl "http://127.0.0.1:4319/aisubs/grok/personal/v1/chat/completions" \
  -H "Authorization: Bearer $AISUBS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID_FROM_DASHBOARD","messages":[{"role":"user","content":"Hello from AISubs"}]}'
```

Anthropic Messages:

```bash
curl "http://127.0.0.1:4319/aisubs/claude/team/v1/messages" \
  -H "x-api-key: $AISUBS_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID_FROM_DASHBOARD","max_tokens":1024,"messages":[{"role":"user","content":"Hello from AISubs"}]}'
```

Google `generateContent`:

```bash
curl "http://127.0.0.1:4319/aisubs/opencode-zen/lab/v1/models/MODEL_ID_FROM_DASHBOARD:generateContent" \
  -H "Authorization: Bearer $AISUBS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Hello from AISubs"}]}]}'
```

</details>

## Direct AISubs SDK

Use the in-process SDK when AISubs is part of your trusted Node.js backend. It
needs no local server or AISubs API key.

Install the package in a project:

```bash
nub install aisubs
npm install aisubs
pnpm add aisubs
bun add aisubs
```

```js
import { chatGptProvider, createSubscriptionAuth } from "aisubs";

const subscriptions = createSubscriptionAuth({ providers: [chatGptProvider()] });
const account = subscriptions.account("chatgpt", "personal");

if (!(await account.status()).authenticated) {
  const login = await account.signIn();
  console.log(login.prompt);
  await login.wait();
}

const catalog = await account.getModels();
const model = catalog?.models.find((item) => item.selectable !== false)?.id;
if (!model) throw new Error("No selectable model is available");

const response = await account.proxy("responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, input: "Hello", store: false, stream: true }),
});

if (!response.ok) throw new Error(await response.text());
for await (const chunk of response.body ?? []) process.stdout.write(Buffer.from(chunk));
```

Available provider factories are `chatGptProvider()`, `claudeProvider()`,
`copilotProvider()`, `grokProvider()`, `openCodeGoProvider()`, and
`openCodeZenProvider()`.

Useful account methods:

| Method               | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `status()`           | Check whether the account is connected                 |
| `signIn(options?)`   | Start browser, device-code, or API-key sign-in         |
| `signOut()`          | Remove the account's locally stored credential         |
| `getModels()`        | Read the current provider model catalog                |
| `getUsage()`         | Read current provider usage when available             |
| `details()`          | Read safe identity, credential, usage, and model data  |
| `fetch(url, init?)`  | Send an authorized request to an allowed provider host |
| `proxy(path, init?)` | Send a provider-native request without handling tokens |

<details>
<summary><strong>Configure every provider and custom credential storage</strong></summary>

```js
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

const subscriptions = createSubscriptionAuth({
  store: new FileCredentialStore("./data/aisubs-credentials.json"),
  providers: [
    chatGptProvider(),
    claudeProvider(),
    copilotProvider(),
    grokProvider(),
    openCodeGoProvider(),
    openCodeZenProvider(),
  ],
});
```

Without a custom store, credentials are saved to
`~/.aisubs/credentials.json`. Select an account with its provider ID and a
local account name:

```js
const chatgpt = subscriptions.account("chatgpt", "personal");
const claude = subscriptions.account("claude", "team");
const copilot = subscriptions.account("copilot", "github");
const grok = subscriptions.account("grok", "personal");
const go = subscriptions.account("opencode-go", "team");
const zen = subscriptions.account("opencode-zen", "lab");
```

Account names are 1–128 characters and cannot contain control characters.

</details>

<details>
<summary><strong>Browser, device-code, and API-key sign-in</strong></summary>

The default ChatGPT flow opens a browser. On a headless machine, request its
device-code flow explicitly:

```js
const login = await chatgpt.signIn({ mode: "device" });
console.log(login.prompt);
await login.wait();
```

Copilot uses device-code sign-in and can target a supported GitHub Enterprise
Cloud domain:

```js
const login = await copilot.signIn({ enterpriseDomain: "company.ghe.com" });
console.log(login.prompt);
await login.wait();
```

OpenCode Go and Zen use API keys:

```js
const login = await go.signIn({ apiKey: process.env.OPENCODE_API_KEY });
await login.wait();
```

</details>

<details>
<summary><strong>Inspect account details and switch between accounts</strong></summary>

```js
const details = await chatgpt.details();

console.log(details.session); // connection state and safe account identity
console.log(details.credential); // expiry and refresh state, never token values
console.log(details.usage); // limits and reset information, or null
console.log(details.models); // available models, or null
```

`details()`, `getUsage()`, and `getModels()` never return access or refresh
tokens. Prefer `fetch()` or `proxy()` over handling a token directly.

Each named account keeps separate credentials, refresh state, usage, and model
data, so selection can happen at request time:

```js
const personal = subscriptions.account("chatgpt", "personal");
const work = subscriptions.account("chatgpt", "work");

const selected = user.isWorkAccount ? work : personal;
const response = await selected.proxy("responses", requestOptions);
```

</details>

<details>
<summary><strong>Run the local HTTP server from Node.js</strong></summary>

This is the programmatic equivalent of `aisubs dashboard`. The API key is
created once and reused across restarts; delete or regenerate the key file only
when clients should receive a new key.

```js
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FileApiKeyStore,
  FileCredentialStore,
  chatGptProvider,
  claudeProvider,
  createSubscriptionAuth,
} from "aisubs";
import { createSubscriptionAuthServer } from "aisubs/http";

const directory = join(homedir(), ".aisubs");
const apiKey = await new FileApiKeyStore(join(directory, "api-key")).readOrCreate();
const auth = createSubscriptionAuth({
  store: new FileCredentialStore(join(directory, "credentials.json")),
  providers: [chatGptProvider(), claudeProvider()],
});

const server = await createSubscriptionAuthServer({ auth, apiKey, port: 4319 });
console.log(`AISubs API: ${server.url}`);
```

A runnable version is available in [`examples/server.mjs`](./examples/server.mjs).

</details>

## Dashboard options

```text
aisubs dashboard [options]

--data-dir <path>  State directory (default: ~/.aisubs)
--port <number>    Local port (default: 4319; 0 chooses an available port)
--no-open          Do not open the browser
--help             Show help
```

`AISUBS_DATA_DIR` also changes the state directory. The built-in server binds
only to localhost.

## Local management API

These routes are for the dashboard and advanced integrations:

```text
GET    /health
GET    /v1/providers
GET    /v1/auth
GET    /v1/auth/:provider
GET    /v1/auth/:provider/accounts
POST   /v1/auth/:provider/login
DELETE /v1/auth/:provider?account=work
GET    /v1/logins/:loginId
DELETE /v1/logins/:loginId
GET    /v1/usage/:provider?account=work
GET    /v1/models/:provider?account=work
GET    /v1/api-key                 # dashboard session only
POST   /v1/api-key/regenerate      # dashboard session only
*      /aisubs/:provider/:account/v1/*
```

The provider and account routes require `Authorization: Bearer AISUBS_API_KEY`
or `x-api-key: AISUBS_API_KEY`. Regenerating the key immediately invalidates the
old key.

## Storage and security

- Credentials: `~/.aisubs/credentials.json`.
- Persistent local API key: `~/.aisubs/api-key`.
- State directories and files use private permissions where the platform supports them.
- Provider credentials are attached only after provider-host allowlist validation.
- Local authorization, cookie, origin, and proxy headers are never forwarded.
- Account and model APIs never return provider access or refresh tokens.
- Keep AISubs on localhost and never put its API key in browser-delivered code.

## Development

From the package directory:

```bash
nub install
nub run check
```

Package-manager equivalents:

```bash
npm install && npm run check
pnpm install && pnpm run check
bun install && bun run check
```

For the watch dashboard use `nub run dev`, `npm run dev`, `pnpm run dev`, or
`bun run dev`. Before publishing, also inspect the package with `nub pack --dry-run`,
`npm pack --dry-run`, `pnpm pack --dry-run`, or `bun pm pack --dry-run`.

## Provider terms

Provider subscriptions, OAuth clients, and model access are governed by each
provider's terms and may change. Use accounts you are authorized to use, discover
models at runtime, and pin the AISubs version your integration has tested.

## License

[MIT](./LICENSE)
