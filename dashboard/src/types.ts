import type { LoginAttempt } from "../../src/types.js";

export type {
  CredentialSummary,
  ProviderSummary as Provider,
  ProviderModel,
  ProviderModels,
  ProviderUsage,
  Session,
  UsageMeter,
} from "../../src/types.js";

export type Theme = "light" | "dark";
export type LoginFlow = Pick<
  LoginAttempt,
  "id" | "provider" | "accountKey" | "state" | "prompt"
> & {
  error?: string | null;
};

export interface AccountRoute {
  provider: string;
  account: string;
}

export interface Snippet {
  id: string;
  label: string;
  install?: string;
  code: string;
  note?: string;
}
