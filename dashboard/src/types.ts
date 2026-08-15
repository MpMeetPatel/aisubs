export type Theme = "light" | "dark";

export interface Provider {
  id: string;
  name: string;
  loginModes: string[];
  description?: string;
  homepage?: string;
  allowedHosts?: string[];
  loginFields?: Array<{
    name: string;
    label: string;
    description?: string;
    placeholder?: string;
    type?: "text" | "url" | "password";
    required?: boolean;
  }>;
  supportsFetch: boolean;
  supportsProxy: boolean;
  supportsUsage: boolean;
  supportsModels: boolean;
}

export interface Identity {
  id?: string;
  label?: string;
  email?: string;
  plan?: string;
}

export interface Session {
  provider: string;
  accountKey: string;
  authenticated: boolean;
  expiresAt?: number;
  needsRefresh?: boolean;
  reauthRequired?: boolean;
  account?: Identity;
}

export interface CredentialSummary {
  provider: string;
  accountKey: string;
  accessCredentialStored: boolean;
  refreshCredentialStored: boolean;
  automaticRefresh: boolean;
  expiresAt: number;
  needsRefresh: boolean;
  externallyManaged: boolean;
  reauthRequired?: boolean;
  endpoint?: string;
  account?: Identity;
}

export interface ProviderModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: string[];
  inputModalities?: string[];
  endpoints?: string[];
  available?: boolean;
  selectable?: boolean;
}

export interface ProviderModels {
  asOf: number;
  models: ProviderModel[];
}

export interface UsageMeter {
  id: string;
  label: string;
  unit: string;
  used?: number;
  limit?: number;
  remaining?: number;
  percentUsed?: number;
  included?: boolean;
  unlimited?: boolean;
  resetAt?: number;
  window?: string;
}

export interface ProviderUsage {
  asOf: number;
  plan?: string;
  account?: Identity;
  meters?: UsageMeter[];
  facts?: Array<{ label: string; value: string }>;
  resetCredits?: {
    availableCount: number;
    credits?: Array<{ id?: string; status?: string; grantedAt?: number; expiresAt?: number }>;
  };
  note?: string;
}

export interface LoginFlow {
  id: string;
  provider: string;
  accountKey: string;
  state: "pending" | "complete" | "failed" | "cancelled";
  error?: string | null;
  prompt: {
    mode: string;
    verificationUri?: string;
    authorizationUri?: string;
    userCode?: string;
    expiresAt: number;
  };
}

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
