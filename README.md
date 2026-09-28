# opencode-usage-report

[![npm version](https://img.shields.io/npm/v/opencode-usage-report)](https://www.npmjs.com/package/opencode-usage-report)
[![CI](https://github.com/kaanchinar/opencode-usage-report/actions/workflows/ci.yml/badge.svg)](https://github.com/kaanchinar/opencode-usage-report/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/opencode-usage-report)](./LICENSE)

An [opencode](https://opencode.ai) plugin that adds a `/usage` command (and a
`usage_report` tool) showing both the **context usage** of the current session and
the **quota windows** (5-hour, weekly, monthly) of your inference subscriptions —
currently **Kimi Code** (both regional plans: `kimi-code-plan-global` on kimi.ai
and `kimi-code-plan-cn` on kimi.com),
**OpenCode Go** (`opencode-go`), **GitHub Copilot** (`github-copilot`) and
**ChatGPT** (`openai`). It fetches from each provider's API, caches
results on disk, and can fall back to a local estimate when the API is
unreachable. It also emits background low-quota warnings in the TUI.

## Features

- `/usage` command and `usage_report` tool for on-demand quota reports, with
  JSON and single-provider filtering.
- **Context usage panel** (new in 0.4.0): the exact prompt-token total against
  the model's context window, a cell grid that fills by category, the
  auto-compaction threshold with live headroom, and session cost.
- TUI sidebar panel with live progress bars, `NN%` usage, and reset countdowns
  for each quota window.
- On-disk caching with a configurable TTL, plus `--refresh` to bypass it.
- Local fallback estimate when the provider API is unreachable and no cache
  exists.
- Background low-quota TUI warnings on startup and `session.idle`.
- Privacy-first: API keys are never logged, cached, or rendered.

## Install

Both entrypoints are needed for the full experience: the server plugin supplies
the `usage_report` tool, the low-quota warnings and the system-prompt capture;
the TUI plugin supplies `/usage` itself and the sidebar panel.

### Server plugin (`usage_report` tool + warnings + capture)

Add the plugin to `opencode.json` / `opencode.jsonc` and restart opencode:

```jsonc
{
  "plugin": ["opencode-usage-report"],
}
```

Credentials are read from the same places your other opencode providers already
use (see [Data sources & privacy](#data-sources--privacy)). Optionally pass
options in the tuple form:

```jsonc
{
  "plugin": [["opencode-usage-report", { "thresholdPercent": 75 }]],
}
```

### TUI plugin (`/usage` command + sidebar panel)

Add the plugin to `tui.json` and restart opencode:

```jsonc
{
  "plugin": ["opencode-usage-report"],
}
```

Use the bare package name — opencode resolves the `./tui` entrypoint from the
package `exports` on its own. (`opencode-usage-report/tui` is **not** a valid
spec and will silently not load.)

For local development, point the configs at the source instead:

```jsonc
// opencode.json
{ "plugin": ["file:///abs/path/to/opencode-usage-report/src/index.ts"] }
// tui.json
{ "plugin": ["file:///abs/path/to/opencode-usage-report/src/tui.tsx"] }
```

The sidebar panel renders under opencode's native Context block (order 150) and
shows a colored progress bar per quota window, `NN%`, and a live reset countdown
— refreshed every 60s, on `session.idle`, and on demand via the
`Usage: refresh now` command (default binding `ctrl+shift+u`). It reuses the same
cache/fallback pipeline as the command; stale results are marked `(stale)` and
local estimates `(est)`.

TUI options (tuple form): `providers`, `cacheTtlSeconds`, `thresholdPercent`,
`refreshIntervalSeconds` (default `60`), `barWidth` (default `14`).

## Commands

- `/usage` — open the report dialog: the context usage panel for the current
  session on top, every configured provider's quota windows below. This is a
  local TUI command, so it costs no model tokens. Requires the TUI plugin.
  Providers without a resolved credential are skipped in this view.
- `/usage` dialog keys: `esc` close, `r` refresh, `tab` cycle provider scope
  (all → each provider), `j` toggle the raw JSON view.
- `usage_report` tool — the same report for agents and headless runs. Takes
  `provider` (exact id: `kimi-code-plan-global`, `kimi-code-plan-cn`,
  `opencode-go`, `github-copilot` or `openai`; an unknown id returns a helpful
  error listing the known ids), `json` (raw `ProviderReport[]`) and `refresh`
  (bypass the on-disk cache).

> **Changed in 0.4.0.** `/usage` was previously an LLM-mediated prompt template
> that routed through the model, and it accepted `--json` / `--refresh` /
> a provider id as slash arguments. The TUI command now owns the name and those
> capabilities are dialog keys or tool arguments. Running `/usage` with an
> argument (`/usage --json`) is no longer supported — use the `usage_report`
> tool for scripted access.

## Context usage panel

The top of the `/usage` dialog reports how full the model's context window is
for the current session:

```
  Context
  Kimi K2 (High) · 42,318 / 200,000 tokens (21.2%)

  ██████████████████████  ████████████████████████████████  ████  ██████████████████████████████
  ██  ████████████████████  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  …

  ● User messages      8,204   4.1%      ● System & tools    8,144   4.1%
  ● Agent responses   11,650   5.8%      ● Free space     157,682  78.8%
  ● Reasoning          2,140   1.1%
  ● Tool calls        12,180   6.1%

  Auto-compacts at 180,000 · 137,682 headroom        $0.42 spent
```

**What is exact.** The headline total, the percentage, free space, the
compaction threshold, the cost, and the number of pruned tool outputs all come
straight from numbers the provider and opencode report. The total is the prompt
size — `input + cache.read + cache.write` — which is what actually occupies the
context window. opencode's own sidebar Context block sums five fields including
the completion, so it reads slightly higher than this panel by design.

**What is estimated.** The per-category rows. opencode does not record a token
count per message or per part, so each category is estimated with the same
`characters / 4` heuristic opencode itself uses, then normalized so the rows
agree with the exact total.

**System & tools.** opencode assembles the system prompt and tool definitions on
every request and never persists them. The server plugin measures the real
system string through the `experimental.chat.system.transform` hook and stores
only its size, so the row can be split into `system prompt` and
`tools & framing`. This hook is undocumented, so it is treated as best-effort:
if it stops firing, the sidecar goes stale, or anything fails to validate, the
panel falls back to the derived residual and labels the row `(derived)`. The
plugin never breaks a request over it.

**Compaction headroom.** `Auto-compacts at N` mirrors opencode's own overflow
check, including the configured `compaction.reserved` buffer. This is the point
at which opencode automatically summarizes the session, and opencode exposes it
nowhere else.

## Options

| Option             | Type               | Default | Meaning                                                      |
| ------------------ | ------------------ | ------- | ------------------------------------------------------------ |
| `thresholdPercent` | `number`           | `80`    | Warn when a window is at/above this percent used.            |
| `cacheTtlSeconds`  | `number`           | `120`   | How long a cached API result is considered fresh.            |
| `providers`        | `string[] \| null` | `null`  | Providers to report; `null` = every registered adapter.      |
| `fallback`         | `boolean`          | `true`  | Use a local estimate when the API fails and no cache exists. |

Malformed option values are ignored and the defaults are kept.

## Warnings

On startup and again on `session.idle` (both throttled to at most once every 10
minutes, sharing the same timer), the plugin checks the cached reports. Any
window at or above `thresholdPercent`, or whose
status is `rate-limited` / `frozen`, produces a TUI toast. A warning fires once
per window until that window resets; it re-arms after usage drops below
`thresholdPercent - 10`. Toast failures (headless/server mode) are swallowed.

## Data sources & privacy

- Credential resolution order: `OPENCODE_USAGE_<ID>_KEY` env override (optionally
  paired with `OPENCODE_USAGE_<ID>_ACCOUNT_ID`, e.g.
  `OPENCODE_USAGE_OPENAI_ACCOUNT_ID`, to supply the ChatGPT account id), then
  `~/.local/share/opencode/auth.json` (`type: "api"` `.key`, or `type: "oauth"`
  `.access`, falling back to `.refresh` for GitHub Copilot). For ChatGPT the
  oauth entry's `.accountId` is read automatically. `$OPENCODE_DATA_HOME`
  overrides the data directory.
- APIs: `https://api.kimi.ai/coding/v1/usages` (global plan),
  `https://api.kimi.com/coding/v1/usages` (China plan),
  `https://opencode.ai/zen/go/v1/usage` (custom `User-Agent` is required by the
  latter), `https://api.github.com/copilot_internal/user` (GitHub Copilot) and
  `https://chatgpt.com/backend-api/wham/usage` (ChatGPT).
- Auth: run `opencode auth login` and pick **GitHub Copilot** or **OpenAI
  ChatGPT**. ChatGPT additionally needs the account id that login writes to
  `auth.json`; the plugin reads it automatically.
- Cache and state live in `<data-home>/usage-report/` (TTL cache, session id,
  warn state, and `context/<sessionID>.json` — the system-prompt size sidecar,
  which holds counts only, never prompt text).
- Local fallback reads `opencode.db` read-only.
- **API keys are never logged, cached, or rendered.** Adapter errors are
  sanitized (key substrings replaced with `<redacted>`) before they reach any
  output, and the live smoke script never prints credentials.

## Extending

New providers are trivial:

1. Implement `ProviderAdapter` (`src/types.ts`) — an `id`, `displayName`, and
   `fetch(cred, opts)` returning `{ windows, extras? }`.
2. Register it in `src/providers/index.ts` (`adapters` array).
3. Add fixture-driven tests under `test/`.

Reference endpoints for future adapters (not built in v1):

- **Gemini**: `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`
  (requires Google OAuth).
- **Claude**: `api.anthropic.com/api/oauth/usage` (requires
  `anthropic-beta: oauth-2025-04-20`, the claude-code User-Agent, and
  `~/.claude/.credentials.json`).

## Development

```sh
npm run lint                      # oxlint
npm run lint:fix                  # oxlint --fix
npm run format                    # oxfmt (write in place)
npm run format:check              # oxfmt --check
npm test                          # vitest, no network
npm run typecheck                 # tsc --noEmit
npm run check                     # lint + format:check + typecheck + test
npm run smoke -- --yes-live       # manual live check (real keys; opt-in)
```

## License

MIT © [Kaan Chinar](https://github.com/kaanchinar)
