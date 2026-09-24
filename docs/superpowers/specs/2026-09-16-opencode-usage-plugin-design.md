# opencode-usage-report — Design Spec

Date: 2026-09-16
Status: Approved (approach A, full pipeline authorized)

## 1. Purpose

The user is tired of manually checking usage limits for each inference subscription connected to opencode (Kimi Code, OpenCode Go today; Gemini, Claude, Codex etc. later). This plugin adds a `/usage` command (and a `usage_report` tool) that prints a normalized table of each enabled provider's quota windows (5h / weekly / monthly), plus background low-quota warnings.

## 2. Scope

**In scope (v1):**

- Providers: `kimi-for-coding`, `opencode-go` (exactly these two adapters; architecture must make adding more trivial).
- `/usage` command output in chat, with `--json`, `--refresh`, and per-provider filter args.
- Background low-quota warnings (default threshold: any window ≥ 80% used).
- API-first fetching with on-disk caching; local-estimate fallback when the API is unreachable.
- Publishable npm package layout; locally loadable via path in `opencode.jsonc` during development.

**Out of scope (v1):**

- TUI plugin (`tui.json`) integration, status-line widgets.
- Gemini/Claude/Codex/Copilot adapters (documented as extension points only).
- Historical usage graphs, cost analytics.
- Publishing to npm (structure is publish-ready; publishing is a later manual step).

## 3. Architecture

TypeScript opencode plugin, shipped as TS source (opencode loads TS plugins natively; no build step).

```
package.json            name: opencode-usage-report, type: module, peerDep @opencode-ai/plugin
tsconfig.json           for editor/typecheck only (noEmit)
src/index.ts            plugin entry — registers tool, config hook (command injection), event hook (warnings)
src/types.ts            UsageWindow, ProviderReport, ProviderAdapter, normalized types
src/auth.ts             credential resolution
src/providers/kimi.ts   Kimi Code adapter
src/providers/opencode-go.ts  OpenCode Go adapter
src/normalize.ts        tolerant parsing helpers (num(), str(), pickReset(), etc.)
src/cache.ts            on-disk TTL cache
src/fallback.ts         local estimate from opencode.db
src/render.ts           text table + JSON rendering
src/warn.ts             threshold detection + once-per-crossing state
src/paths.ts            platform paths (auth.json, cache dir, opencode.db)
test/                   vitest, fixture-driven
fixtures/               captured API responses (redacted) + variant shapes
scripts/live-smoke.ts   manual opt-in live check (never in CI)
```

### 3.1 Normalized data model

```ts
type WindowKind = "5h" | "daily" | "weekly" | "monthly" | "other";

interface UsageWindow {
  kind: WindowKind;
  label: string; // e.g. "5-hour", "Weekly"
  usedPercent: number | null; // 0–100; null when only absolutes are known
  used: number | null; // absolute units (requests/tokens) when known
  limit: number | null;
  remaining: number | null;
  resetsAt: string | null; // ISO-8601
  status: "ok" | "rate-limited" | "frozen" | "unknown";
}

interface ProviderReport {
  provider: string; // "kimi-for-coding"
  displayName: string; // "Kimi Code"
  fetchedAt: string; // ISO
  source: "api" | "cache" | "local-estimate" | "error";
  stale: boolean; // true when served from expired cache or fallback
  windows: UsageWindow[];
  extras: Record<string, string>; // e.g. { "Booster wallet": "$3.21" }
  error: string | null; // human-readable, sanitized (never contains keys)
}

interface AdapterResult {
  windows: UsageWindow[];
  extras?: Record<string, string>;
}

interface ProviderAdapter {
  id: string; // matches auth.json key
  displayName: string;
  fetch(cred: Credential, opts: { timeoutMs: number }): Promise<AdapterResult>;
  // cache/fallback orchestration lives outside adapters
}
```

### 3.2 Auth resolution (`src/auth.ts`)

Order per provider:

1. Env override: `OPENCODE_USAGE_<NORMALIZED_ID>_KEY` (e.g. `OPENCODE_USAGE_KIMI_FOR_CODING_KEY` — non-alphanumerics → `_`, uppercased).
2. `~/.local/share/opencode/auth.json` → entry keyed by provider id; accept `type: "api"` (`.key`) and `type: "oauth"` (`.access`) — defensive, oauth not needed today.
3. Missing → report `{ source: "error", error: "no credential found" }` for that provider only.

Path resolution honors `$OPENCODE_DATA_HOME` if set, else `~/.local/share/opencode`. Never log or include key material in any output; sanitize errors by replacing the key substring with `<redacted>` if it ever appears.

### 3.3 Provider adapters

**Kimi Code (`src/providers/kimi.ts`)**

- `GET https://api.kimi.com/coding/v1/usages`, headers: `Authorization: Bearer <key>`, `Accept: application/json`. Custom `User-Agent: opencode-usage-report/<version>`.
- Parse precedence:
  1. `usages.limit_5h` / `usages.limit_7d` → `{ used_ratio (0–1 number), reset_time }` → usedPercent = ratio×100.
  2. `limits[]` → find `window.duration == 300 && window.timeUnit == "TIME_UNIT_MINUTE"` → 5h window from `detail` (strings → numbers).
  3. Top-level `usage` → weekly window (strings → numbers).
- Optional blocks (render into `extras` when present, never fail when absent):
  - `totalQuota` → monthly membership cap; if `used > 0` → add monthly window with `status: "frozen"` (whole Code quota frozen).
  - `booster_wallet` → `extras["Booster wallet"] = balance` (format string).
  - `user.membership.level` → `extras["Plan"]`.
- Tolerate: numbers as strings or ints; `resetTime` | `reset_time` | `resetAt`; missing blocks; unknown fields ignored.

**OpenCode Go (`src/providers/opencode-go.ts`)**

- `GET https://opencode.ai/zen/go/v1/usage`, headers: `Authorization: Bearer <key>`, `Accept: application/json`, **custom `User-Agent: opencode-usage-report/<version>`** (Cloudflare 1010-blocks default Node/Bun UAs), `x-opencode-session: <stable per-install UUID>` (generated once, persisted in cache dir).
- Parse `usage.rolling` → 5h, `usage.weekly` → weekly, `usage.monthly` → monthly. Each: `{ status, percent (used, 0–100), resetsAt }`.
- Error mapping: 401 → "invalid API key"; 403 (`EntitlementError`) → "OpenCode Go subscription not active on this key"; 429 → rate-limited, use cache/fallback; network/5xx → cache/fallback.

### 3.4 Caching (`src/cache.ts`)

- Location: `<data-home>/usage-report/cache.json` (same dir holds `session-id`, `warn-state.json`).
- Per-provider entry: `{ fetchedAt, windows, extras }`. TTL default 120s (configurable).
- `/usage --refresh` bypasses TTL. On API failure: serve expired cache with `stale: true`; only if no cache exists, use local fallback.
- Writes are atomic (tmp file + rename) to survive concurrent opencode sessions.

### 3.5 Local fallback (`src/fallback.ts`)

- Trigger: API fetch failed AND no cache entry exists for the provider.
- Source: `~/.local/share/opencode/opencode.db` (SQLite, read-only, immutable=1 flag) — aggregate token/request usage per provider over the relevant windows (schema reference: `message` / `part` / `session` tables; executor must introspect actual schema at implementation time and defensively handle drift — if the query fails, return `windows: []` with `error: "local estimate unavailable"`).
- Output windows carry `source: "local-estimate"` (report-level), labeled in render as `~` estimate; usedPercent computed against configurable nominal limits (defaults from user's routing knowledge: e.g. Go deepseek ~26k req/5h — per-model limits are out of scope; fallback reports absolutes + percent only when a configured limit exists, else absolutes only).

### 3.6 Plugin wiring (`src/index.ts`)

- `tool`: registers `usage_report` tool. Args: `{ provider?: string, json?: boolean, refresh?: boolean }`. Returns rendered text (or JSON string). This is what the `/usage` command invokes.
- `config` hook: injects `command.usage` = `{ description: "Show subscription usage/quota windows for configured providers", template: "Call the usage_report tool with these arguments: $ARGUMENTS and present the result verbatim." }`. Only injects if the user hasn't already defined a `usage` command.
- `event` hook: on `session.idle` (and once at startup), run `warn.check()` — throttled to ≥10 min between checks.
- Options (plugin tuple form): `{ thresholdPercent?: number, cacheTtlSeconds?: number, providers?: string[], fallback?: boolean }`. Defaults: 80, 120, all discovered, true.

### 3.7 Warnings (`src/warn.ts`)

- Fetches (through cache) all providers; any window with `usedPercent >= threshold` or `status == "rate-limited" | "frozen"` → warning.
- Fire once per (provider, window-kind, threshold-crossing) until the window resets (track `warn-state.json`: last-fired reset timestamp per window; re-fire only when `resetsAt` changes or usage drops below threshold−10 hysteresis).
- Delivery: `client.tui.showToast({ title, message, variant: "warning" })` wrapped in try/catch (works in TUI; no-op in headless). Never throws into the event bus.

### 3.8 Rendering (`src/render.ts`)

Default text table per provider:

```
Kimi Code (api, fresh, resets shown in local time)
  5-hour    42% used   1,234 / 2,900 reqs   resets 14:05
  Weekly    61% used   …                    resets Mon 00:00
  Booster wallet: $3.21

OpenCode Go (api)
  5-hour    12% used   resets 13:40
  Weekly    57% used   resets Thu
  Monthly    3% used   resets Oct 1
```

Error rows: `⚠ Kimi Code: no credential found` / `(stale cache, 14 min old)` / `(local estimate)`.

## 4. Error handling

- Per-provider isolation: one failure never affects the other's report.
- Fetch timeout 5s (`AbortSignal.timeout`), one retry on 5xx/network (not on 4xx).
- All errors sanitized (no key material), human-readable, rendered inline.
- Plugin must never crash opencode: every hook body wrapped in try/catch; failures surface as error rows or silent no-op (event hook).

## 5. Edge cases (must be handled/tested)

1. Kimi numeric fields as strings **or** numbers; ratios 0–1 vs percents 0–100.
2. Reset field name variants: `resetTime`, `reset_time`, `resetAt`, `resetsAt`.
3. Missing optional blocks (`totalQuota`, `booster_wallet`, `user.membership`) — no crash, no row.
4. Kimi `totalQuota.used > 0` → monthly window `frozen`.
5. Kimi `limits[]` window matching: `duration==300 && timeUnit=="TIME_UNIT_MINUTE"`; absent → fall back to `usages.limit_5h` only or omit 5h row.
6. Go response without custom UA → 403/1010 → adapter must always send UA (test asserts header).
7. Go 403 EntitlementError → distinct message from 401.
8. `auth.json` missing / malformed JSON / provider entry absent / `type: "oauth"` shape.
9. Env override present but empty string → treated as missing.
10. Offline / DNS failure / timeout → stale cache → local estimate → error row (in that order).
11. Cache file corrupted → treated as absent; rewritten on next success.
12. Concurrent opencode sessions → atomic cache writes; worst case both fetch.
13. Warning spam: same crossing must not re-fire; fires again only after reset or after dropping below hysteresis.
14. Headless/server mode: toast fails → swallow.
15. User already defined their own `usage` command → do not overwrite.
16. `opencode.db` missing or schema drift → fallback returns "local estimate unavailable", report continues.
17. Windows with unknown percent (absolutes only) render without a % column value, not "NaN%".
18. `/usage` with an unknown provider arg → helpful error listing known ids.
19. Keys must never appear in tool output, logs, cache files, or warn state.
20. Multi-device usage: local estimate may under-report; labeled `~` and `local estimate`.

## 6. Testing

- vitest, `npm test`. No network in tests: all adapter tests use `fixtures/*.json` (captured live shapes, redacted) + mocked `fetch` for error paths (401/403/429/500/timeout).
- Fixture matrix per provider: canonical response, string-vs-number variant, missing-optional-blocks variant, minimal response.
- normalize.ts: unit tests for every parsing helper and field-name variant.
- cache.ts: TTL expiry, corruption recovery, atomic write.
- warn.ts: threshold crossing, once-only, hysteresis re-arm, reset re-fire.
- render.ts: snapshot-ish assertions for table, JSON mode, stale/error labeling.
- auth.ts: env override precedence, missing entry, redaction.
- `scripts/live-smoke.ts`: manual `npm run smoke` — hits real endpoints with real keys, prints reports; never runs in CI; requires `--yes-live` flag.

## 7. Acceptance criteria

1. `npm test` green.
2. `bunx tsc --noEmit` (or `tsc --noEmit`) clean.
3. `/usage` inside opencode prints both providers' windows from the live APIs.
4. `/usage --json` emits valid JSON matching the ProviderReport schema.
5. Disconnect network → `/usage` serves stale cache, then local estimate with `~` labels.
6. Warn state fires a toast when a fixture-driven window ≥ threshold (unit test), once only.
7. No key material anywhere in outputs (`grep` test over rendered output + cache files in tests).

## 8. Extension points (documented in README, not built)

- New adapter: implement `ProviderAdapter`, register in `src/providers/index.ts`. Notes for Gemini (`cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`, needs Google OAuth), Claude (`api.anthropic.com/api/oauth/usage`, needs `anthropic-beta: oauth-2025-04-20` + claude-code UA + `~/.claude/.credentials.json`), Codex (ChatGPT backend usage endpoint).
- TUI widget, custom thresholds per provider, prometheus export.
