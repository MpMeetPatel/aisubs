import type { ProviderUsageData, UsageFact, UsageMeter, UsageResetCredits } from "./types.js";
import { isRecord, numberValue, stringValue } from "./utils.js";

function numeric(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return numberValue(value);
}

function timestamp(value: unknown): number | undefined {
  const number = numeric(value);
  if (number != null) return number > 1_000_000_000_000 ? number : number * 1000;
  const text = stringValue(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function rounded(value: number | undefined): number | undefined {
  return value == null ? undefined : Math.round(value * 10_000) / 10_000;
}

function title(value: string): string {
  return value
    .replace(/^USAGE_PRODUCT_TYPE_/, "")
    .replace(/^PRODUCT_/, "")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function grokPlan(value: string): string {
  const plan = value.trim();
  const known: Record<string, string> = {
    free: "Free",
    grokpro: "SuperGrok",
    supergrok: "SuperGrok",
    supergrokpro: "SuperGrok Heavy",
    supergrokheavy: "SuperGrok Heavy",
    supergroklite: "SuperGrok Lite",
    supergrokplus: "SuperGrok Plus",
    xbasic: "X Basic",
    xpremium: "X Premium",
    xpremiumplus: "X Premium+",
  };
  return (
    known[
      plan
        .replace(/\+/g, "plus")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase()
    ] ?? title(plan.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
  );
}

function windowLabel(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "Limit";
  if (seconds % 604_800 === 0) {
    const weeks = seconds / 604_800;
    return weeks === 1 ? "Weekly" : `${weeks}-week limit`;
  }
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}-day limit`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}-hour limit`;
  return `${Math.round(seconds / 60)}-min limit`;
}

function parseChatGptResetCredits(raw: unknown): UsageResetCredits | undefined {
  if (!isRecord(raw)) return undefined;
  const container = isRecord(raw.rate_limit_reset_credits)
    ? raw.rate_limit_reset_credits
    : isRecord(raw.rateLimitResetCredits)
      ? raw.rateLimitResetCredits
      : raw;
  const availableCount =
    numeric(container.available_count) ??
    numeric(container.availableCount) ??
    numeric(container.count);
  if (availableCount == null) return undefined;
  const credits = (Array.isArray(container.credits) ? container.credits : []).flatMap((item) => {
    if (!isRecord(item)) return [];
    return [
      {
        id: stringValue(item.id),
        status: stringValue(item.status),
        grantedAt: timestamp(item.granted_at ?? item.grantedAt),
        expiresAt: timestamp(item.expires_at ?? item.expiresAt ?? item.expiry_at ?? item.expiryAt),
      },
    ];
  });
  return {
    availableCount: Math.max(0, Math.floor(availableCount)),
    credits: credits.length ? credits : undefined,
  };
}

export function parseChatGptUsage(
  raw: unknown,
  detailedResetCredits?: unknown,
): ProviderUsageData | null {
  if (!isRecord(raw)) return null;
  const rateLimit = isRecord(raw.rate_limit) ? raw.rate_limit : null;
  const meters: UsageMeter[] = [];
  if (rateLimit) {
    for (const [id, value] of [
      ["primary", rateLimit.primary_window],
      ["secondary", rateLimit.secondary_window],
    ] as const) {
      if (!isRecord(value)) continue;
      const percentUsed = numeric(value.used_percent);
      if (percentUsed == null) continue;
      const resetAt = timestamp(value.reset_at);
      const resetAfter = numeric(value.reset_after_seconds);
      meters.push({
        id,
        label: windowLabel(numeric(value.limit_window_seconds)),
        unit: "percent",
        percentUsed,
        resetAt: resetAt ?? (resetAfter ? Date.now() + resetAfter * 1000 : undefined),
      });
    }
  }
  const additional = Array.isArray(raw.additional_rate_limits) ? raw.additional_rate_limits : [];
  for (const item of additional) {
    if (!isRecord(item) || !isRecord(item.rate_limit)) continue;
    const group = stringValue(item.limit_name) ?? stringValue(item.metered_feature) ?? "Additional";
    for (const [windowId, value] of [
      ["primary", item.rate_limit.primary_window],
      ["secondary", item.rate_limit.secondary_window],
    ] as const) {
      if (!isRecord(value)) continue;
      const percentUsed = numeric(value.used_percent);
      if (percentUsed == null) continue;
      const resetAt = timestamp(value.reset_at);
      const resetAfter = numeric(value.reset_after_seconds);
      meters.push({
        id: `${stringValue(item.metered_feature) ?? group}:${windowId}`,
        label: `${title(group)} / ${windowLabel(numeric(value.limit_window_seconds))}`,
        unit: "percent",
        percentUsed,
        resetAt: resetAt ?? (resetAfter ? Date.now() + resetAfter * 1000 : undefined),
      });
    }
  }
  const resetCredits =
    parseChatGptResetCredits(detailedResetCredits) ??
    parseChatGptResetCredits(raw.rate_limit_reset_credits ?? raw.rateLimitResetCredits);
  if (resetCredits) {
    meters.push({
      id: "reset-credits",
      label: "Reset credits",
      unit: "credits",
      remaining: resetCredits.availableCount,
    });
  }
  const plan = stringValue(raw.plan_type);
  const accountId = stringValue(raw.account_id) ?? stringValue(raw.user_id);
  const email = stringValue(raw.email);
  const creditStatus = isRecord(raw.credits) ? raw.credits : null;
  const facts: UsageFact[] = [];
  if (creditStatus?.unlimited === true)
    facts.push({ label: "Additional credits", value: "Unlimited" });
  else if (creditStatus?.has_credits === true) {
    const balance = stringValue(creditStatus.balance);
    if (balance) facts.push({ label: "Credit balance", value: balance });
  }
  if (!meters.length && !facts.length) return null;
  const displayPlan = plan ? title(plan) : undefined;
  return {
    plan: displayPlan,
    account:
      accountId || email || displayPlan
        ? { id: accountId, label: email, email, plan: displayPlan }
        : undefined,
    meters: meters.length ? meters : undefined,
    facts: facts.length ? facts : undefined,
    resetCredits,
  };
}

const COPILOT_LABELS: Record<string, string> = {
  premium_interactions: "Premium requests",
  chat: "Chat credits",
  completions: "Inline suggestions",
};

export function copilotPlanName(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const sku = stringValue(raw.access_type_sku)?.toLowerCase() ?? "";
  const plan = stringValue(raw.copilot_plan)?.toLowerCase() ?? "";
  if (sku === "free_limited_copilot") return "Free";
  if (sku === "free_educational_quota" || plan === "individual_edu") return "Student";
  if (sku.includes("enterprise") || plan === "enterprise") return "Enterprise";
  if (sku.includes("business") || sku.includes("standalone_seat") || plan === "business") {
    return "Business";
  }
  if (sku.includes("max") || plan === "individual_max") return "Max";
  if (sku.includes("plus") || plan === "individual_pro") return "Pro+";
  if (sku.includes("subscriber") || sku.includes("individual") || plan === "individual") {
    return "Pro";
  }
  return plan ? title(plan) : sku ? title(sku) : undefined;
}

function copilotMeter(id: string, snapshot: Record<string, unknown>, resetAt?: number): UsageMeter {
  const label = COPILOT_LABELS[id] ?? title(id);
  const limit = numeric(snapshot.entitlement);
  const unlimited = snapshot.unlimited === true || limit === -1;
  const included = unlimited || (snapshot.has_quota !== false && (limit == null || limit > 0));
  if (!included) return { id, label, unit: "requests", included: false, resetAt };
  if (unlimited) {
    return { id, label, unit: "requests", included: true, unlimited: true, resetAt };
  }
  const remaining = numeric(snapshot.quota_remaining) ?? numeric(snapshot.remaining);
  const providerUsed = numeric(snapshot.credits_used);
  const used =
    providerUsed ??
    (limit != null && remaining != null ? Math.max(0, limit - remaining) : undefined);
  const percentRemaining = numeric(snapshot.percent_remaining);
  const percentUsed =
    percentRemaining != null
      ? 100 - percentRemaining
      : limit != null && limit > 0 && used != null
        ? (used / limit) * 100
        : undefined;
  return {
    id,
    label,
    unit: id === "chat" ? "credits" : "requests",
    used: rounded(used),
    limit,
    remaining: rounded(remaining),
    percentUsed: rounded(percentUsed),
    included: true,
    resetAt,
  };
}

export function parseCopilotUsage(raw: unknown): ProviderUsageData | null {
  if (!isRecord(raw)) return null;
  const resetAt =
    timestamp(raw.quota_reset_date_utc) ??
    timestamp(raw.quota_reset_date) ??
    timestamp(raw.limited_user_reset_date);
  const meters: UsageMeter[] = [];
  if (isRecord(raw.quota_snapshots)) {
    for (const [id, snapshot] of Object.entries(raw.quota_snapshots)) {
      if (isRecord(snapshot)) meters.push(copilotMeter(id, snapshot, resetAt));
    }
  } else if (isRecord(raw.limited_user_quotas) && isRecord(raw.monthly_quotas)) {
    for (const [id, remaining] of Object.entries(raw.limited_user_quotas)) {
      const limit = numeric(raw.monthly_quotas[id]);
      const quotaRemaining = numeric(remaining);
      if (limit == null || quotaRemaining == null) continue;
      meters.push(
        copilotMeter(id, { entitlement: limit, quota_remaining: quotaRemaining }, resetAt),
      );
    }
  }
  const plan = copilotPlanName(raw);
  const login = stringValue(raw.login);
  const hasOverage = isRecord(raw.quota_snapshots)
    ? Object.values(raw.quota_snapshots).some(
        (snapshot) => isRecord(snapshot) && snapshot.overage_permitted === true,
      )
    : false;
  const facts: UsageFact[] = [
    ...(raw.token_based_billing === true
      ? [{ label: "Usage accounting", value: "AI credits" }]
      : []),
    ...(hasOverage ? [{ label: "Extra usage", value: "Enabled" }] : []),
  ];
  return {
    plan,
    account: login || plan ? { id: login, label: login, plan } : undefined,
    meters: meters.length ? meters : undefined,
    facts: facts.length ? facts : undefined,
    note: meters.length ? undefined : "No quota details were returned for this plan.",
  };
}

function wrappedNumeric(value: unknown): number | undefined {
  return isRecord(value) ? numeric(value.val) : numeric(value);
}

export function parseGrokUsage(
  raw: unknown,
  userRaw?: unknown,
  settingsRaw?: unknown,
): ProviderUsageData | null {
  if (!isRecord(raw) || !isRecord(raw.config)) return null;
  const config = raw.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : null;
  const resetAt = timestamp(period?.end) ?? timestamp(config.billingPeriodEnd);
  const periodType = stringValue(period?.type);
  const percentUsed = numeric(config.creditUsagePercent);
  const meters: UsageMeter[] = [];
  if (period || percentUsed != null) {
    meters.push({
      id: "period",
      label: periodType?.includes("WEEKLY") ? "Weekly" : "Usage period",
      unit: "percent",
      percentUsed,
      resetAt,
      window: periodType,
    });
  } else {
    const legacyLimit = wrappedNumeric(config.monthlyLimit);
    const legacyUsed = wrappedNumeric(config.used);
    if (legacyLimit != null && legacyLimit > 0) {
      meters.push({
        id: "period",
        label: "Monthly",
        unit: "currency",
        used: Math.max(0, legacyUsed ?? 0) / 100,
        limit: legacyLimit / 100,
        remaining: Math.max(0, legacyLimit - (legacyUsed ?? 0)) / 100,
        percentUsed: rounded(((legacyUsed ?? 0) / legacyLimit) * 100),
        resetAt,
      });
    }
  }
  const products = Array.isArray(config.productUsage) ? config.productUsage : [];
  for (const product of products) {
    if (!isRecord(product)) continue;
    const id =
      stringValue(product.product) ??
      stringValue(product.productType) ??
      stringValue(product.name) ??
      stringValue(product.type);
    const productPercent =
      numeric(product.creditUsagePercent) ??
      numeric(product.usagePercent) ??
      numeric(product.usedPercent) ??
      numeric(product.percent);
    if (id && productPercent != null) {
      meters.push({
        id: id.toLowerCase(),
        label: title(id),
        unit: "percent",
        percentUsed: productPercent,
        resetAt,
      });
    }
  }
  const extraLimit = wrappedNumeric(config.onDemandCap);
  const extraUsed = wrappedNumeric(config.onDemandUsed);
  if (extraLimit != null && extraLimit > 0) {
    meters.push({
      id: "extra-usage",
      label: "Extra usage",
      unit: "currency",
      used: Math.max(0, extraUsed ?? 0) / 100,
      limit: extraLimit / 100,
      remaining: Math.max(0, extraLimit - (extraUsed ?? 0)) / 100,
      resetAt,
    });
  }
  const user = isRecord(userRaw) ? userRaw : null;
  const settings = isRecord(settingsRaw) ? settingsRaw : null;
  const liveTier = stringValue(user?.subscriptionTier) ?? stringValue(user?.subscription_tier);
  const fallbackTier =
    stringValue(settings?.subscription_tier_display) ??
    stringValue(settings?.subscriptionTierDisplay) ??
    stringValue(raw.subscriptionTier) ??
    stringValue(raw.subscription_tier) ??
    stringValue(settings?.subscription_tier) ??
    stringValue(settings?.subscriptionTier) ??
    stringValue(config.subscriptionTier);
  const prepaid = wrappedNumeric(config.prepaidBalance);
  const unified = config.isUnifiedBillingUser === true || config.is_unified_billing_user === true;
  const onDemandEnabled =
    typeof raw.onDemandEnabled === "boolean"
      ? raw.onDemandEnabled
      : typeof raw.on_demand_enabled === "boolean"
        ? raw.on_demand_enabled
        : undefined;
  const userId = stringValue(user?.id) ?? stringValue(user?.userId) ?? stringValue(user?.user_id);
  const email = stringValue(user?.email);
  const fullName = [stringValue(user?.firstName), stringValue(user?.lastName)]
    .filter(Boolean)
    .join(" ");
  const label = stringValue(user?.name) ?? stringValue(user?.username) ?? (fullName || email);
  const plan = liveTier ? grokPlan(liveTier) : user ? "Free" : grokPlan(fallbackTier ?? "Free");
  const buildAccess =
    typeof user?.hasGrokCodeAccess === "boolean"
      ? user.hasGrokCodeAccess
      : typeof settings?.allow_access === "boolean"
        ? settings.allow_access
        : typeof settings?.allowAccess === "boolean"
          ? settings.allowAccess
          : undefined;
  const team = stringValue(user?.teamName);
  const organization = stringValue(user?.organizationName);
  const retentionOptOut =
    typeof user?.codingDataRetentionOptOut === "boolean"
      ? user.codingDataRetentionOptOut
      : undefined;
  return {
    plan,
    account: userId || label || email || plan ? { id: userId, label, email, plan } : undefined,
    meters: meters.length ? meters : undefined,
    facts: [
      ...(buildAccess == null
        ? []
        : [{ label: "Grok Build access", value: buildAccess ? "Included" : "Not included" }]),
      ...(team ? [{ label: "Team", value: team }] : []),
      ...(organization ? [{ label: "Organization", value: organization }] : []),
      ...(retentionOptOut == null
        ? []
        : [
            {
              label: "Coding data training",
              value: retentionOptOut ? "Opted out" : "Allowed",
            },
          ]),
      ...(prepaid == null
        ? []
        : [{ label: "Extra credits balance", value: `$${(prepaid / 100).toFixed(2)}` }]),
      ...(onDemandEnabled == null
        ? []
        : [{ label: "Extra usage", value: onDemandEnabled ? "Enabled" : "Not enabled" }]),
      ...(unified ? [{ label: "Usage pool", value: "Shared across Grok products" }] : []),
    ],
    note:
      percentUsed == null
        ? "xAI provides only the reset time for this account, not current usage or remaining allowance. Access may stop before the reset if the included allowance is exhausted."
        : undefined,
  };
}
