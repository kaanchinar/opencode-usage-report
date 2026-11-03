# Changelog

## 0.6.4

- `/usage` dialog keys (`tab`, `r`, `j`) work on OpenCode 2.2.x again. The commands fired, but the dialog never re-rendered: OpenCode loads the plugin's modules on separate Solid runtimes, so panel signals did not track across them. The panel now notifies the dialog, which asks the host to re-render with fresh state; closing the dialog unsubscribes.

## 0.6.3

- Kimi Code CN (`kimi-code-plan-cn`): the 5-hour window falls back to the `usages.limit_5h` ratio when the `limits[]` row carries no counts, instead of rendering an empty `—` bar.
- A monthly window is also read from a counted 30-day `limits[]` entry when the endpoint reports it there.
- Includes the outstanding Dependabot dev-dependency bumps.

## 0.6.2

OpenCode 2 context panel fixes:

- The V2 adapter now reads the model id from the store's `model.id`, so the model lookup succeeds and the cell grid, per-category percentages and compaction-headroom line render again instead of `—`.
- The translated messages also carry the session id.
- The system-prompt capture anchors its freshness check to the turn's user message. OpenCode 2 fires the capture hook just before the assistant message is stamped, which previously marked every capture `(derived)`.

## 0.6.1

Kimi Code adapter tracks the 2026-09 quota-model API change:

- Usage windows now come from the `usages.limit_5h` / `limit_7d` / `limit_month_total` ratios, with a `limit_month_code` breakdown.
- Extra Usage is read from the camelCase `boosterWallet` (fixed-point `BOOSTER` balance).
- The pre-2026-09 `usage` / `limits[]` / `totalQuota` / `booster_wallet` shapes remain as fallbacks.

## 0.6.0

OpenCode 2.x support. Both entrypoints now default-export a dual definition. OpenCode 2's TUI loader rejects a default export without a `setup` function (`Invalid V2 TUI plugin module`). Before 0.6.0 the TUI module exported only the V1 `tui` shape and failed to load on 2.x.

## 0.4.1

Internal:

- Shared provider HTTP plumbing (`src/providers/http.ts`) replaces the copy-pasted fetch, retry and error code.
- Context estimates simplified.
- Reset times render as `Wed, Sep 16`.

## 0.4.0

- Context usage panel: `/usage` now shows context breakdown, grid, compaction headroom and cost.
- Sidebar rendering extracted to `src/quota-lines.ts`.

**Breaking:** `/usage` was an LLM-mediated prompt template that routed through the model and accepted `--json`, `--refresh` or a provider id as slash arguments. It is now a local TUI command that costs no model tokens. Those capabilities moved to the dialog keys and the `usage_report` tool arguments. `/usage --json` is no longer supported.

## 0.3.0

GitHub Copilot and ChatGPT (OpenAI) adapters.

## 0.2.0

Kimi Code split into the kimi.ai (`kimi-code-plan-global`) and kimi.com (`kimi-code-plan-cn`) plans.
