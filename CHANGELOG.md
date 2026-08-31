# Changelog

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
