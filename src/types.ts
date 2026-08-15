export type ProviderId = "chatgpt" | "claude" | "copilot" | "grok" | (string & {});
export type LoginMode = "browser" | "device" | "external-token" | "external-cli" | "api-key";

export interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  account?: {
    id?: string;
    label?: string;
    email?: string;
    plan?: string;
  };
  metadata?: Record<string, string | number | boolean | null>;
}

export interface CredentialStore {
  read(provider: ProviderId): Promise<OAuthCredential | null>;
  listKeys?(): Promise<string[]>;
  modify(
    provider: ProviderId,
    update: (
      current: OAuthCredential | null,
    ) => OAuthCredential | null | Promise<OAuthCredential | null>,
  ): Promise<OAuthCredential | null>;
  delete(provider: ProviderId): Promise<void>;
}

export interface UsageMeter {
  id: string;
  label: string;
  unit: "requests" | "tokens" | "credits" | "currency" | "percent" | (string & {});
  used?: number;
  limit?: number;
  remaining?: number;
  percentUsed?: number;
  included?: boolean;
  unlimited?: boolean;
  resetAt?: number;
  window?: string;
}

export interface UsageFact {
  label: string;
  value: string;
}

export interface UsageResetCredit {
  id?: string;
  status?: string;
  grantedAt?: number;
  expiresAt?: number;
}

export interface UsageResetCredits {
  availableCount: number;
  credits?: UsageResetCredit[];
}

export interface ProviderUsageData {
  plan?: string;
  account?: OAuthCredential["account"];
  meters?: UsageMeter[];
  facts?: UsageFact[];
  resetCredits?: UsageResetCredits;
  note?: string;
  extensions?: Record<string, unknown>;
}

export interface ProviderUsage extends ProviderUsageData {
  provider: ProviderId;
  accountKey: string;
  asOf: number;
}

export interface ProviderUsageContext {
  credential: OAuthCredential;
  signal: AbortSignal;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
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
  supportsToolCall?: boolean;
  available?: boolean;
  selectable?: boolean;
}

export interface ProviderModels {
  provider: ProviderId;
  accountKey: string;
  asOf: number;
  models: ProviderModel[];
}

export interface CredentialSummary {
  provider: ProviderId;
  accountKey: string;
  accessCredentialStored: boolean;
  refreshCredentialStored: boolean;
  automaticRefresh: boolean;
  expiresAt: number;
  needsRefresh: boolean;
  externallyManaged: boolean;
  reauthRequired?: boolean;
  endpoint?: string;
  account?: OAuthCredential["account"];
}

/** Safe, account-scoped data for product settings and account views. */
export interface SubscriptionAccountDetails {
  session: Session;
  credential: CredentialSummary;
  usage: ProviderUsage | null;
  models: ProviderModels | null;
}

export interface DeviceLoginPrompt {
  mode: "device";
  verificationUri: string;
  userCode: string;
  expiresAt: number;
}

export interface BrowserLoginPrompt {
  mode: "browser";
  authorizationUri: string;
  expiresAt: number;
}

export interface ImmediateLoginPrompt {
  mode: "external-token" | "external-cli" | "api-key";
  expiresAt: number;
}

export type LoginPrompt = DeviceLoginPrompt | BrowserLoginPrompt | ImmediateLoginPrompt;

export interface ProviderLogin {
  prompt: LoginPrompt;
  complete: Promise<OAuthCredential>;
}

export interface ProviderLoginField {
  name: string;
  label: string;
  description?: string;
  placeholder?: string;
  type?: "text" | "url" | "password";
  required?: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly name: string;
  readonly loginModes: readonly LoginMode[];
  readonly description?: string;
  readonly homepage?: string;
  readonly allowedHosts?: readonly string[];
  readonly loginFields?: readonly ProviderLoginField[];
  readonly supportsFetch?: boolean;
  readonly proxyBaseUrl?: string | ((credential: OAuthCredential) => string | undefined);
  /** Optional local OpenAI-compatible bridge for providers without a pass-through API. */
  proxy?(request: Request, credential: OAuthCredential): Promise<Response>;
  normalizeResponse?(request: Request, response: Response): Response | Promise<Response>;
  startLogin(signal: AbortSignal, options?: Record<string, unknown>): Promise<ProviderLogin>;
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
  authorize(request: Request, credential: OAuthCredential): Request | Promise<Request>;
  getUsage?(context: ProviderUsageContext): Promise<ProviderUsageData | null>;
  getModels?(context: ProviderUsageContext): Promise<ProviderModel[]>;
  isPermanentRefreshError?(error: unknown): boolean;
}

export interface ProviderSummary {
  id: ProviderId;
  name: string;
  loginModes: readonly LoginMode[];
  description?: string;
  homepage?: string;
  allowedHosts?: readonly string[];
  loginFields?: readonly ProviderLoginField[];
  supportsFetch: boolean;
  supportsProxy: boolean;
  supportsUsage: boolean;
  supportsModels: boolean;
}

export interface Session {
  provider: ProviderId;
  accountKey: string;
  authenticated: boolean;
  expiresAt?: number;
  needsRefresh?: boolean;
  reauthRequired?: boolean;
  account?: OAuthCredential["account"];
}

export type LoginState = "pending" | "complete" | "failed" | "cancelled";

export interface LoginAttempt {
  id: string;
  provider: ProviderId;
  accountKey: string;
  prompt: LoginPrompt;
  get state(): LoginState;
  get error(): string | null;
  wait(): Promise<Session>;
  cancel(): void;
}
