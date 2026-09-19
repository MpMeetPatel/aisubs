# Changelog

## Unreleased

- Breaking: `createSubscriptionAuth` now requires an explicit credential store.
- Breaking: provider factories use the `aisubs/providers/*` entrypoints so the core `aisubs` import stays runtime-portable.
- Add `aisubs/node` SQLite credential and API-key stores with shared-connection support and cross-process refresh ownership.
- Persist standalone AISubs records in `~/.aisubs/aisubs.db` without retaining the legacy file-store implementation.

## 0.3.7 - 2026-09-16

- Improve provider compatibility, proxy handling, and request normalization.
- Harden dashboard account flows, modal interactions, and stale-load handling.
- Add regression coverage for compatibility, proxy headers, authentication, and
  dashboard behavior.

## 0.3.6 - 2026-09-15

- Preserve provider cache controls and cache usage across OpenAI-compatible,
  Anthropic, Responses, and subscription transports.
- Keep ChatGPT cache routing state scoped to account, session, and turn.
- Normalize cache reads/writes and reasoning usage without losing native fields.

## 0.3.5 - 2026-09-14

- Move ChatGPT Responses instructions into the developer input prefix so
  stable subscription prompts participate in prompt caching.

## 0.3.4 - 2026-09-13

- Refresh account model catalogs on demand and update ChatGPT compatibility so
  newly available subscription models appear without stale cached listings.
- Preserve prompt-cache routing and cache read/write usage when translating
  between OpenAI, Anthropic, and Responses-compatible protocols.

## 0.3.3 - 2026-09-02

- Show remaining usage percentages in account meter values and progress bars,
  clamping exhausted meters to 0% remaining.

## 0.3.2 - 2026-08-31

- Normalize ChatGPT Responses requests by removing unsupported explicit
  prompt-cache controls while preserving prompt-cache routing.
- Apply provider request normalization before authorization for direct and
  proxied requests.

## 0.3.1 - 2026-08-20

- Add dashboard-managed Codex Desktop integration with callable model discovery,
  `provider/model` routing, and an option to restore the official Codex provider.
- Harden concurrent token refresh, reauthentication account selection, credential
  file validation, Realtime startup, and development-server shutdown behavior.
- Fix stale dashboard data, failed-action feedback, provider-specific examples,
  Codex configuration errors, model deduplication, and protocol compatibility
  edge cases.
- Remove redundant tests and unsafe internal type erasure while retaining focused
  regression coverage for the corrected behavior.

## 0.3.0 - 2026-08-16

- Add a universal OpenAI-compatible Chat Completions surface with translation
  to supported native Responses, Anthropic Messages, and Google
  `generateContent` endpoints.
- Add native OpenAI Realtime WebSocket tunnelling and account-scoped model
  discovery with capability metadata.
- Add Claude, OpenCode Go, and OpenCode Zen to the dashboard and examples;
  improve provider model metadata and usage reporting.
- Document desktop-client and SDK setup, local-key handling, compatibility
  behavior, and cross-protocol streaming limits.

## 0.2.0 - 2026-08-15

- Previous release.
