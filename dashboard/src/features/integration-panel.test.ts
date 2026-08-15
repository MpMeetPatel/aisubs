import { describe, expect, test } from "vitest";
import { modelApi } from "./integration-panel";
import type { Provider } from "../types";

const provider = (id: string): Provider => ({
  id,
  name: id,
  loginModes: [],
  supportsFetch: true,
  supportsProxy: true,
  supportsUsage: false,
  supportsModels: true,
});

describe("modelApi", () => {
  test("uses the endpoint advertised by the selected model", () => {
    expect(modelApi(provider("chatgpt"))).toBe("responses");
    expect(modelApi(provider("copilot"), { id: "reasoning", endpoints: ["responses"] })).toBe(
      "responses",
    );
    expect(modelApi(provider("grok"), { id: "chat", endpoints: ["chat"] })).toBe("chat");
    expect(modelApi(provider("opencode-go"), { id: "qwen", endpoints: ["v1/messages"] })).toBe(
      "messages",
    );
    expect(
      modelApi(provider("opencode-zen"), {
        id: "gemini",
        endpoints: ["models/gemini-3.6-flash"],
      }),
    ).toBe("google");
    expect(
      modelApi(provider("copilot"), {
        id: "both",
        endpoints: ["responses", "chat/completions"],
      }),
    ).toBe("chat");
  });
});
