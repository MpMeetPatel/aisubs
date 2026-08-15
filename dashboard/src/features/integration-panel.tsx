import { ChevronDown, KeyRound, Terminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { icon } from "../lib";
import type { Provider, ProviderModel, Snippet } from "../types";
import { CopyButton, panel } from "../components/ui";
import { highlightCode, snippetLanguage } from "../components/syntax";

export type ModelApi = "chat" | "responses" | "messages" | "google";
type PackageManager = "nub" | "npm" | "pnpm" | "bun";

function installCommand(command: string, manager: PackageManager): string {
  const packages = command.replace(/^nub install /, "");
  if (manager === "npm") return `npm install ${packages}`;
  if (manager === "pnpm") return `pnpm add ${packages}`;
  if (manager === "bun") return `bun add ${packages}`;
  return command;
}

export function modelApi(provider: Provider, model?: ProviderModel): ModelApi {
  if (provider.id === "chatgpt") return "responses";
  const endpoints = new Set(
    model?.endpoints?.map((endpoint) => {
      const normalized = endpoint.replace(/^\/?(?:v1\/)?/, "");
      return normalized === "chat" ? "chat/completions" : normalized;
    }),
  );
  if ([...endpoints].some((endpoint) => endpoint.startsWith("models/"))) return "google";
  if (
    endpoints.has("messages") &&
    !endpoints.has("chat/completions") &&
    !endpoints.has("responses")
  ) {
    return "messages";
  }
  return endpoints.has("responses") && !endpoints.has("chat/completions") ? "responses" : "chat";
}

function providerFactoryName(provider: Provider): string {
  if (provider.id === "chatgpt") return "chatGptProvider";
  if (provider.id === "claude") return "claudeProvider";
  if (provider.id === "copilot") return "copilotProvider";
  if (provider.id === "opencode-go") return "openCodeGoProvider";
  if (provider.id === "opencode-zen") return "openCodeZenProvider";
  return "grokProvider";
}

function snippets(
  provider: Provider,
  account: string,
  model: string,
  selectedModel?: ProviderModel,
): Snippet[] {
  const base = `${location.origin}/aisubs/${encodeURIComponent(provider.id)}/${encodeURIComponent(account)}/v1`;
  const anthropicSdkBase = base.slice(0, -3);
  const env = "AISUBS_API_KEY";
  const providerFactory = providerFactoryName(provider);
  if (provider.id === "claude") {
    return [
      {
        id: "app",
        label: "Any compatible app",
        code: `Provider type: Anthropic compatible
Base URL: ${base}
API key: <copy from the AISubs dashboard>
Model: ${model}
Endpoint: POST /messages`,
        note: "Paste these values into any app that supports a custom Anthropic API base URL. The app must support the Messages API.",
      },
      {
        id: "anthropic",
        label: "Anthropic SDK",
        install: "nub install @anthropic-ai/sdk",
        code: `import Anthropic from "@anthropic-ai/sdk";\n\nconst client = new Anthropic({ baseURL: "${anthropicSdkBase}", apiKey: process.env.${env} });\nconst message = await client.messages.create({\n  model: "${model}",\n  max_tokens: 1024,\n  messages: [{ role: "user", content: "Hello from AISubs" }],\n});\n\nconsole.log(message.content);`,
        note: "AISubs accepts the SDK's local x-api-key header, removes it, and adds your Claude OAuth credential only for Anthropic.",
      },
      {
        id: "vercel",
        label: "Vercel AI SDK",
        install: "nub install ai @ai-sdk/anthropic",
        code: `import { createAnthropic } from "@ai-sdk/anthropic";\nimport { generateText } from "ai";\n\nconst account = createAnthropic({ baseURL: "${base}", apiKey: process.env.${env} });\nconst { text } = await generateText({ model: account("${model}"), prompt: "Hello from AISubs" });\n\nconsole.log(text);`,
      },
      {
        id: "curl",
        label: "cURL",
        code: `curl "${base}/messages" \\\n  -H "x-api-key: $${env}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${model}","max_tokens":1024,"messages":[{"role":"user","content":"Hello from AISubs"}]}'`,
      },
      {
        id: "claude-code",
        label: "Claude Code",
        code: `claude -p \\\n  --model ${model} \\\n  --output-format stream-json \\\n  --verbose \\\n  "Hello from AISubs"`,
        note: "Optional: Claude Code remains available independently of AISubs.",
      },
    ];
  }
  const api = modelApi(provider, selectedModel);
  if (api === "messages") {
    return [
      {
        id: "app",
        label: "Any compatible app",
        code: `Provider type: Anthropic compatible
Base URL: ${base}
API key: <copy from the AISubs dashboard>
Model: ${model}
Endpoint: POST /messages`,
        note: "Paste these values into an app that supports a custom Anthropic API base URL and the Messages API.",
      },
      {
        id: "anthropic",
        label: "Anthropic SDK",
        install: "nub install @anthropic-ai/sdk",
        code: `import Anthropic from "@anthropic-ai/sdk";\n\nconst client = new Anthropic({ baseURL: "${anthropicSdkBase}", apiKey: process.env.${env} });\nconst message = await client.messages.create({\n  model: "${model}",\n  max_tokens: 1024,\n  messages: [{ role: "user", content: "Hello from AISubs" }],\n});\n\nconsole.log(message.content);`,
      },
      {
        id: "curl",
        label: "cURL",
        code: `curl "${base}/messages" \\\n  -H "x-api-key: $${env}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${model}","max_tokens":1024,"messages":[{"role":"user","content":"Hello from AISubs"}]}'`,
      },
    ];
  }
  if (api === "google") {
    return [
      {
        id: "app",
        label: "Any compatible app",
        code: `Provider type: Google Generative Language
Base URL: ${base}
API key: <copy from the AISubs dashboard>
Model: ${model}
Endpoint: POST /models/${model}:generateContent`,
        note: "Use these values only in an app that accepts a custom Google generateContent base URL.",
      },
      {
        id: "curl",
        label: "Google generateContent · cURL",
        code: `curl "${base}/models/${model}:generateContent" \\\n  -H "Authorization: Bearer $${env}" \\\n  -H "content-type: application/json" \\\n  -d '{"contents":[{"role":"user","parts":[{"text":"Hello from AISubs"}]}]}'`,
        note: "OpenCode exposes Gemini models through the native Google generateContent endpoint.",
      },
    ];
  }
  const responses = api === "responses";
  const chatGpt = provider.id === "chatgpt";
  const streaming = chatGpt || provider.id === "grok";
  const path = responses ? "responses" : "chat/completions";
  const body = responses
    ? chatGpt
      ? `{"model":"${model}","store":false,"stream":true,"instructions":"You are a helpful assistant.","input":[{"role":"user","content":[{"type":"input_text","text":"Hello from AISubs"}]}]}`
      : `{"model":"${model}","input":[{"role":"user","content":[{"type":"input_text","text":"Hello from AISubs"}]}]}`
    : `{"model":"${model}","messages":[{"role":"user","content":"Hello from AISubs"}]${streaming ? ',"stream":true' : ""}}`;
  const chatVercel = streaming
    ? `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";\nimport { streamText } from "ai";\n\nconst account = createOpenAICompatible({\n  name: "${provider.id}",\n  baseURL: "${base}",\n  apiKey: process.env.${env},\n});\n\nconst result = streamText({\n  model: account("${model}"),\n  prompt: "Hello from AISubs",\n});\n\nfor await (const text of result.textStream) process.stdout.write(text);`
    : `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";\nimport { generateText } from "ai";\n\nconst account = createOpenAICompatible({\n  name: "${provider.id}",\n  baseURL: "${base}",\n  apiKey: process.env.${env},\n});\n\nconst { text } = await generateText({\n  model: account("${model}"),\n  prompt: "Hello from AISubs",\n});\n\nconsole.log(text);`;
  return [
    {
      id: "app",
      label: "Any compatible app",
      code: `Provider type: ${responses ? "OpenAI Responses" : "OpenAI compatible"}
Base URL: ${base}
API key: <copy from the AISubs dashboard>
Model: ${model}
Endpoint: POST /${path}`,
      note: responses
        ? chatGpt
          ? "Use the Responses API natively. AISubs also adapts non-streaming, text-only Chat Completions for apps such as Handy."
          : "Paste these values into an app that supports a custom OpenAI base URL and the Responses API. Chat-Completions-only apps cannot use a Responses-only model."
        : "Paste these values into any app that supports a custom OpenAI-compatible base URL and Chat Completions.",
    },
    ...(chatGpt
      ? [
          {
            id: "handy",
            label: "Handy",
            code: `Provider: Custom
Base URL: ${base}
API key: <copy from the AISubs dashboard>
Model: ${model}`,
            note: "Handy sends non-streaming Chat Completions. AISubs converts its text and JSON-schema requests to Responses for this ChatGPT account.",
          },
        ]
      : []),
    {
      id: "aisubs",
      label: "AISubs SDK",
      install: "nub install aisubs",
      code: `import {
  createSubscriptionAuth,
  ${providerFactory},
} from "aisubs";

// AISubs uses ~/.aisubs/credentials.json by default.
const subscriptions = createSubscriptionAuth({
  providers: [${providerFactory}()],
});

const account = subscriptions.account("${provider.id}", "${account}");

if (!(await account.status()).authenticated) {
  const login = await account.signIn();
  console.log(login.prompt); // Open the URL or show the device code to the user.
  await login.wait();
}

const details = await account.details();
console.log({
  account: details.session.account,
  credential: details.credential,
  usage: details.usage,
  models: details.models,
});

// Later, remove this account and its locally stored credentials:
// await account.signOut();`,
      note: "Direct, in-process SDK: login, logout, safe account details, refreshes, host validation, and metadata caching. No local HTTP server or AISubs API key is needed.",
    },
    {
      id: "vercel",
      label: "Vercel AI SDK",
      install: responses
        ? "nub install ai @ai-sdk/openai"
        : "nub install ai @ai-sdk/openai-compatible",
      code: responses
        ? chatGpt
          ? `import { createOpenAI } from "@ai-sdk/openai";\nimport { streamText } from "ai";\n\nconst account = createOpenAI({\n  baseURL: "${base}",\n  apiKey: process.env.${env},\n});\n\nconst result = streamText({\n  model: account.responses("${model}"),\n  prompt: "Hello from AISubs",\n  providerOptions: { openai: { store: false } },\n});\n\nfor await (const text of result.textStream) process.stdout.write(text);`
          : `import { createOpenAI } from "@ai-sdk/openai";\nimport { generateText } from "ai";\n\nconst account = createOpenAI({\n  baseURL: "${base}",\n  apiKey: process.env.${env},\n});\n\nconst { text } = await generateText({\n  model: account.responses("${model}"),\n  prompt: "Hello from AISubs",\n});\n\nconsole.log(text);`
        : chatVercel,
    },
    ...(!responses
      ? [
          {
            id: "tanstack",
            label: "TanStack AI",
            install: "nub install @tanstack/ai @tanstack/ai-openai",
            code: `import { chat } from "@tanstack/ai";\nimport { openaiCompatible } from "@tanstack/ai-openai/compatible";\n\nconst account = openaiCompatible({\n  name: "${provider.id}",\n  baseURL: "${base}",\n  apiKey: process.env.${env}!,\n  models: ["${model}"],\n});\n\nconst stream = chat({\n  adapter: account("${model}"),\n  messages: [{ role: "user", content: "Hello from AISubs" }],\n});\n\nfor await (const event of stream) console.log(event);`,
          },
        ]
      : []),
    {
      id: "openai",
      label: responses ? "OpenAI SDK" : "OpenAI-compatible SDK",
      install: "nub install openai",
      code: `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${base}",\n  apiKey: process.env.${env},\n});\n\nconst result = await client.${responses ? "responses.create" : "chat.completions.create"}(${responses ? (chatGpt ? `{\n  model: "${model}",\n  store: false,\n  stream: true,\n  instructions: "You are a helpful assistant.",\n  input: [{\n    role: "user",\n    content: [{ type: "input_text", text: "Hello from AISubs" }],\n  }],\n}` : `{\n  model: "${model}",\n  input: [{\n    role: "user",\n    content: [{ type: "input_text", text: "Hello from AISubs" }],\n  }],\n}`) : `{\n  model: "${model}",\n  messages: [{ role: "user", content: "Hello from AISubs" }],${streaming ? "\n  stream: true," : ""}\n}`});\n\n${streaming ? "for await (const event of result) console.log(event);" : "console.log(result);"}`,
    },
    {
      id: "litellm",
      label: "Python · LiteLLM",
      install: "pip install litellm",
      code: responses
        ? `import os
from litellm import responses

response = responses(
    model="openai/${model}",
    api_base="${base}",
    api_key=os.environ["${env}"],
    messages=[{"role": "user", "content": "Hello from AISubs"}],${chatGpt ? '\n    instructions="You are a helpful assistant.",\n    store=False,\n    stream=True,' : ""}
)

${chatGpt ? "for event in response:\n    print(event)" : "print(response)"}`
        : `import os
from litellm import completion

response = completion(
    model="openai/${model}",
    api_base="${base}",
    api_key=os.environ["${env}"],
    messages=[{"role": "user", "content": "Hello from AISubs"}],${streaming ? "\n    stream=True," : ""}
)

${streaming ? "for event in response:\n    print(event)" : "print(response.choices[0].message.content)"}`,
      note: `LiteLLM sends the ${responses ? "Responses" : "chat-completions"} request to your local OpenAI-compatible AISubs URL.`,
    },
    {
      id: "curl",
      label: "cURL",
      code: `curl "${base}/${path}" \\\n  -H "Authorization: Bearer \$${env}" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`,
    },
  ];
}

function apiName(provider: Provider, model?: ProviderModel): string {
  if (provider.id === "claude") return "Anthropic Messages API";
  const api = modelApi(provider, model);
  if (api === "responses") return "OpenAI Responses API";
  if (api === "messages") return "Anthropic Messages API";
  if (api === "google") return "Google generateContent API";
  return "OpenAI-compatible Chat Completions API";
}

export function IntegrationPanel({
  provider,
  account,
  models,
}: {
  provider: Provider;
  account: string;
  models: ProviderModel[];
}) {
  const [model, setModel] = useState(
    models.find((item) => item.selectable !== false)?.id ?? models[0]?.id ?? "MODEL_ID",
  );
  // Free Copilot accounts can return only provider-managed routes, marked as
  // non-selectable. Keep the approved route usable instead of leaving the
  // native select with no options.
  const selectableModels = models.filter((item) => item.selectable !== false);
  const visibleModels = selectableModels.length ? selectableModels : models.slice(0, 1);
  const selectedModel = models.find((item) => item.id === model);
  const options = useMemo(
    () => snippets(provider, account, model, selectedModel),
    [provider, account, model, selectedModel],
  );
  const [active, setActive] = useState(options[0]?.id ?? "");
  const [packageManager, setPackageManager] = useState<PackageManager>("nub");
  const selected = options.find((item) => item.id === active) ?? options[0];
  const base = `${location.origin}/aisubs/${encodeURIComponent(provider.id)}/${encodeURIComponent(account)}/v1`;
  const direct = selected?.id === "aisubs";
  useEffect(() => {
    if (!options.some((item) => item.id === active)) setActive(options[0]?.id ?? "");
  }, [active, options]);
  if (!selected) return null;
  return (
    <section className={`${panel} mt-3`}>
      <div className="flex min-h-[60px] flex-col items-start justify-between gap-3 border-b border-zinc-200 p-4 sm:flex-row sm:items-center dark:border-zinc-800">
        <div className="flex items-start gap-2.5">
          <Terminal {...icon} />
          <span>
            <h2 className="m-0 text-[13px] tracking-tight">Use this account anywhere</h2>
            <p className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
              Choose a model, then copy setup for an existing app, SDK, Python, or cURL.
            </p>
          </span>
        </div>
        {models.length ? (
          <label className="flex w-full items-center gap-2 sm:w-auto">
            <span className="text-[11px] font-bold text-zinc-600 dark:text-zinc-300">Model</span>
            <span className="relative inline-flex min-w-0 flex-1 items-center sm:min-w-[190px]">
              <select
                className="h-[34px] w-full appearance-none rounded-lg border border-zinc-300 bg-zinc-50 py-0 pr-8 pl-3 text-[11px] text-zinc-900 outline-none transition hover:bg-zinc-100 focus:border-zinc-500 focus:ring-3 focus:ring-zinc-300/50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-800 dark:focus:border-zinc-500 dark:focus:ring-zinc-700"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {visibleModels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name ?? item.id}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-2.5 text-zinc-500 dark:text-zinc-400"
                size={15}
                aria-hidden="true"
              />
            </span>
          </label>
        ) : null}
      </div>
      <div className="grid gap-px border-b border-zinc-200 bg-zinc-200 sm:grid-cols-2 dark:border-zinc-800 dark:bg-zinc-800">
        <div className="min-w-0 bg-zinc-100 px-[18px] py-3.5 dark:bg-zinc-800/50">
          <strong className="text-[11px]">{direct ? "Direct lifecycle" : "Local base URL"}</strong>
          {direct ? (
            <p className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
              <code>signIn()</code> · <code>status()</code> · <code>details()</code> ·{" "}
              <code>signOut()</code>
            </p>
          ) : (
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <code className="min-w-0 truncate text-[11px] text-zinc-600 dark:text-zinc-300">
                {base}
              </code>
              <CopyButton value={base} />
            </div>
          )}
        </div>
        <div className="bg-zinc-100 px-[18px] py-3.5 dark:bg-zinc-800/50">
          <strong className="text-[11px]">{direct ? "Account details" : "Provider API"}</strong>
          <p className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
            {direct
              ? "Safe identity, credential status, usage, and models"
              : `${apiName(provider, selectedModel)}${model !== "MODEL_ID" ? ` · ${model}` : ""}`}
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2.5 border-b border-zinc-200 bg-zinc-100 px-[18px] py-3.5 dark:border-zinc-800 dark:bg-zinc-800/50">
        <KeyRound size={17} />
        <div>
          <strong className="text-[11px]">
            {direct ? "Your product owns its credential store" : "Optional local HTTP bridge"}
          </strong>
          <p className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
            {direct ? (
              "AISubs manages refreshes, safe metadata caching, and provider authorization in-process. The other tabs are for separate tools that use the optional localhost server."
            ) : (
              <>
                Reveal or regenerate the persistent key on the main dashboard, then set{" "}
                <code>AISUBS_API_KEY</code>. AISubs removes it before forwarding the request and
                adds the selected provider credential.
              </>
            )}
          </p>
        </div>
      </div>
      <div className="bg-zinc-900 text-zinc-100 dark:bg-zinc-950">
        <div className="flex overflow-x-auto border-b border-white/10 px-3" role="tablist">
          {options.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="min-h-[43px] shrink-0 border-b-2 border-transparent bg-transparent px-3 text-[11px] font-bold text-zinc-400 aria-selected:border-zinc-100 aria-selected:text-zinc-50"
              aria-selected={active === item.id}
              onClick={() => setActive(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {selected.install ? (
          <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <select
                className="rounded border border-white/20 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200"
                value={packageManager}
                onChange={(event) => setPackageManager(event.target.value as PackageManager)}
                aria-label="Package manager"
              >
                <option value="nub">Nub</option>
                <option value="npm">npm</option>
                <option value="pnpm">pnpm</option>
                <option value="bun">Bun</option>
              </select>
              <code className="truncate text-[11px] text-zinc-300">
                {installCommand(selected.install, packageManager)}
              </code>
            </div>
            <CopyButton
              className="border-white/20 bg-white/5 text-zinc-300 hover:border-white/30 hover:text-zinc-50 dark:border-white/20 dark:bg-white/5"
              value={installCommand(selected.install, packageManager)}
            />
          </div>
        ) : null}
        <div className="relative">
          <CopyButton
            className="absolute top-3 right-3 border-white/20 bg-white/5 text-zinc-300 hover:border-white/30 hover:text-zinc-50 dark:border-white/20 dark:bg-white/5"
            value={selected.code}
            label="Copy code"
          />
          <pre className="max-h-[510px] overflow-auto p-[22px] pr-[18px] pt-[62px] text-xs leading-[1.7] [tab-size:2] sm:pr-[116px] sm:pt-[22px]">
            <code data-language={snippetLanguage(selected)}>
              {highlightCode(selected.code, snippetLanguage(selected))}
            </code>
          </pre>
        </div>
        {selected.note ? (
          <p className="m-0 border-t border-white/10 px-[18px] py-3 text-[11px] text-zinc-300">
            {selected.note}
          </p>
        ) : null}
      </div>
    </section>
  );
}
