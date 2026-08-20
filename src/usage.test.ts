import { describe, expect, test } from "vitest";
import { parseChatGptUsage, parseCopilotUsage, parseGrokUsage } from "./usage.js";

describe("normalized provider usage", () => {
  test("normalizes ChatGPT rate-limit windows and reset credits", () => {
    expect(
      parseChatGptUsage(
        {
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 25,
              limit_window_seconds: 18_000,
              reset_after_seconds: 60,
            },
          },
          rate_limit_reset_credits: { available_count: 2 },
        },
        {
          available_count: 2,
          credits: [
            {
              id: "reset-1",
              status: "available",
              granted_at: "2026-08-01T00:00:00Z",
              expires_at: "2026-09-01T00:00:00Z",
            },
          ],
        },
      ),
    ).toMatchObject({
      plan: "Plus",
      meters: [
        { id: "primary", unit: "percent", percentUsed: 25 },
        { id: "reset-credits", unit: "credits", remaining: 2 },
      ],
      resetCredits: {
        availableCount: 2,
        credits: [
          {
            id: "reset-1",
            status: "available",
            grantedAt: Date.parse("2026-08-01T00:00:00Z"),
            expiresAt: Date.parse("2026-09-01T00:00:00Z"),
          },
        ],
      },
    });
  });

  test("normalizes Copilot entitlement and remaining quota", () => {
    expect(
      parseCopilotUsage({
        login: "octocat",
        copilot_plan: "business",
        quota_reset_date: "2026-09-01T00:00:00Z",
        quota_snapshots: {
          premium_interactions: { entitlement: 300, remaining: 240 },
          completions: { unlimited: true },
        },
      }),
    ).toMatchObject({
      plan: "Business",
      account: { id: "octocat", label: "octocat", plan: "Business" },
      meters: [
        { id: "premium_interactions", used: 60, limit: 300, remaining: 240, percentUsed: 20 },
        { id: "completions", unlimited: true },
      ],
    });
  });

  test("distinguishes unavailable Copilot quotas and uses provider credit usage", () => {
    expect(
      parseCopilotUsage({
        login: "octocat",
        copilot_plan: "individual",
        access_type_sku: "free_limited_copilot",
        token_based_billing: true,
        quota_reset_date_utc: "2026-09-01T00:00:00Z",
        quota_snapshots: {
          chat: {
            entitlement: 200,
            quota_remaining: 198.7,
            credits_used: 1,
            percent_remaining: 99.3,
            has_quota: true,
          },
          premium_interactions: {
            entitlement: 0,
            remaining: 0,
            percent_remaining: 0,
            has_quota: false,
          },
        },
      }),
    ).toMatchObject({
      plan: "Free",
      meters: [
        { id: "chat", used: 1, limit: 200, remaining: 198.7, percentUsed: 0.7 },
        { id: "premium_interactions", included: false },
      ],
      facts: [{ label: "Usage accounting", value: "AI credits" }],
    });
  });

  test("normalizes the legacy Copilot free quota shape", () => {
    expect(
      parseCopilotUsage({
        access_type_sku: "free_limited_copilot",
        limited_user_reset_date: "2026-09-01",
        limited_user_quotas: { chat: 450, completions: 3800 },
        monthly_quotas: { chat: 500, completions: 4000 },
      }),
    ).toMatchObject({
      plan: "Free",
      meters: [
        { id: "chat", used: 50, limit: 500, remaining: 450, percentUsed: 10 },
        { id: "completions", used: 200, limit: 4000, remaining: 3800, percentUsed: 5 },
      ],
    });
  });

  test("normalizes Grok percentage, product, and currency meters", () => {
    expect(
      parseGrokUsage(
        {
          onDemandEnabled: false,
          config: {
            currentPeriod: { type: "WEEKLY", end: "2026-09-01T00:00:00Z" },
            creditUsagePercent: 40,
            productUsage: [{ product: "GROK_CODE", usagePercent: 30 }],
            onDemandCap: { val: 20 },
            onDemandUsed: { val: 5 },
          },
        },
        {
          userId: "user-1",
          firstName: "Ada",
          lastName: "Lovelace",
          subscriptionTier: "SUPER_GROK",
          hasGrokCodeAccess: true,
          teamName: "Research",
          codingDataRetentionOptOut: true,
        },
      ),
    ).toMatchObject({
      plan: "SuperGrok",
      meters: [
        { id: "period", percentUsed: 40 },
        { id: "grok_code", percentUsed: 30 },
        { id: "extra-usage", unit: "currency", used: 0.05, limit: 0.2, remaining: 0.15 },
      ],
      facts: [
        { label: "Grok Build access", value: "Included" },
        { label: "Team", value: "Research" },
        { label: "Coding data training", value: "Opted out" },
        { label: "Extra usage", value: "Not enabled" },
      ],
      account: { id: "user-1", label: "Ada Lovelace", plan: "SuperGrok" },
    });
  });

  test("uses Grok's live display tier and treats an omitted tier as Free", () => {
    expect(
      parseGrokUsage(
        { config: {} },
        { userId: "free-user", hasGrokCodeAccess: true },
        { subscription_tier_display: "Free", allow_access: true },
      ),
    ).toMatchObject({
      plan: "Free",
      account: { id: "free-user", plan: "Free" },
      facts: [{ label: "Grok Build access", value: "Included" }],
      note: "xAI provides only the reset time for this account, not current usage or remaining allowance. Access may stop before the reset if the included allowance is exhausted.",
    });

    expect(
      parseGrokUsage(
        { subscriptionTier: "XPremium", config: {} },
        { subscriptionTier: "XPremiumPlus" },
        { subscription_tier_display: "Free" },
      ),
    ).toMatchObject({
      plan: "X Premium+",
      note: "xAI provides only the reset time for this account, not current usage or remaining allowance. Access may stop before the reset if the included allowance is exhausted.",
    });

    expect(
      parseGrokUsage(
        { subscriptionTier: "SuperGrokPro", config: {} },
        { userId: "free-user" },
        { subscription_tier_display: "SuperGrok Heavy" },
      ),
    ).toMatchObject({ plan: "Free" });
  });
});
