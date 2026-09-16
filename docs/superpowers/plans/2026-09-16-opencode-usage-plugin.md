# opencode-usage-report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opencode plugin that reports subscription quota windows (5h/weekly/monthly) for `kimi-for-coding` and `opencode-go` via a `/usage` command, with low-quota warnings.

**Architecture:** TypeScript opencode plugin shipped as TS source. Per-provider adapters fetch undocumented-but-verified usage APIs; results normalize into `UsageWindow[]`, get cached on disk (120s TTL), fall back to local SQLite estimates, render as a chat table, and feed a threshold warning checker.

**Tech Stack:** TypeScript (ESM, no build step), `@opencode-ai/plugin` (peer), vitest, Node 20+ / Bun.

**Spec:** `docs/superpowers/specs/2026-09-16-opencode-usage-plugin-design.md` — read it first; it defines the data model, endpoints, edge cases (numbered 1–20), and acceptance criteria.

## Global Constraints

- Project root: `/home/kaan/Projects/opencode-budget`. **Not a git repo — skip all commit steps.**
- Language: TypeScript, `"type": "module"`, no build step (opencode loads TS plugins directly).
- Tests: vitest, run with `npx vitest run`. **No network access in tests** — fixtures + mocked `fetch` only.
- Never write API keys to any file, log, cache, or output. Sanitize errors via `redact()`.
- Package name: `opencode-usage-report`.
- Kimi endpoint: `GET https://api.kimi.com/coding/v1/usages` (Bearer key).
- Go endpoint: `GET https://opencode.ai/zen/go/v1/usage` (Bearer key + custom `User-Agent: opencode-usage-report/<version>` + `x-opencode-session: <persisted uuid>`).
- Fetch timeout: 5s via `AbortSignal.timeout(5000)`; one retry on 5xx/network, none on 4xx.
- Every external boundary (auth.json, cache file, opencode.db, fetch responses) is parsed defensively: unknown fields ignored, missing blocks tolerated.

## File Map

| File | Responsibility | Task |
|---|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` | scaffold | 0 |
| `src/types.ts` | shared types + `AdapterError` | 1 |
| `src/normalize.ts` | tolerant parsing helpers | 1 |
| `src/paths.ts` | data-home / auth / state-dir / db paths | 1 |
| `src/auth.ts` | credential resolution + redaction | 1 |
| `src/providers/kimi.ts` + `fixtures/kimi-*.json` | Kimi adapter | 2 |
| `src/providers/opencode-go.ts` + `fixtures/go-*.json` | Go adapter | 3 |
| `src/providers/index.ts` | adapter registry | 2 (owned) |
| `src/cache.ts` | TTL disk cache, atomic writes, session id | 4 |
| `src/fallback.ts` | local estimate from opencode.db | 4 |
| `src/render.ts` | text table + JSON output | 5 |
| `src/warn.ts` | threshold warnings, once-per-crossing | 5 |
| `src/report.ts` | orchestration: adapter → cache → fallback → ProviderReport | 6 |
| `src/index.ts` | plugin entry: tool, config hook (command), event hook | 6 |
| `scripts/live-smoke.ts` | manual live check (`--yes-live` required) | 6 |
| `README.md` | usage, options, extension guide | 6 |

---

### Task 0: Scaffold (orchestrator does this inline — no subagent)

- [ ] Create `package.json`:

```json
{
  "name": "opencode-usage-report",
  "version": "0.1.0",
  "description": "opencode plugin: /usage command showing subscription quota windows for configured providers",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "README.md"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "smoke": "tsx scripts/live-smoke.ts"
  },
  "peerDependencies": { "@opencode-ai/plugin": "*" },
  "devDependencies": {
    "@opencode-ai/plugin": "^1.0.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  },
  "license": "MIT"
}
```

- [ ] `tsconfig.json`: `{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "strict": true, "noEmit": true, "skipLibCheck": true, "types": ["node"] }, "include": ["src", "test", "scripts"] }`
- [ ] `vitest.config.ts`: `import { defineConfig } from "vitest/config"; export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });`
- [ ] `.gitignore`: `node_modules/`, `dist/`
- [ ] `mkdir -p src/providers test fixtures scripts docs`
- [ ] `npm install`
- [ ] Verify: `npx vitest run` exits cleanly (no tests yet is fine), `npx tsc --noEmit` clean.

---

### Task 1: Foundation — types, normalize, paths, auth

**Files:**
- Create: `src/types.ts`, `src/normalize.ts`, `src/paths.ts`, `src/auth.ts`
- Test: `test/normalize.test.ts`, `test/auth.test.ts`

**Interfaces (every later task imports these EXACT names):**

```ts
// src/types.ts
export type WindowKind = "5h" | "daily" | "weekly" | "monthly" | "other";
export type WindowStatus = "ok" | "rate-limited" | "frozen" | "unknown";

export interface UsageWindow {
  kind: WindowKind;
  label: string;              // "5-hour", "Weekly", "Monthly"
  usedPercent: number | null; // 0-100
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetsAt: string | null;    // ISO-8601
  status: WindowStatus;
}

export type ReportSource = "api" | "cache" | "local-estimate" | "error";

export interface ProviderReport {
  provider: string;
  displayName: string;
  fetchedAt: string;
  source: ReportSource;
  stale: boolean;
  windows: UsageWindow[];
  extras: Record<string, string>;
  error: string | null;
}

export interface Credential { type: "api" | "oauth"; key: string }
export interface AdapterResult { windows: UsageWindow[]; extras?: Record<string, string> }
export interface FetchOptions { timeoutMs: number }
export interface ProviderAdapter {
  id: string;
  displayName: string;
  fetch(cred: Credential, opts: FetchOptions): Promise<AdapterResult>;
}
export interface PluginOptions {
  thresholdPercent: number;  // default 80
  cacheTtlSeconds: number;   // default 120
  providers: string[] | null; // null = all discovered
  fallback: boolean;          // default true
}

export type AdapterErrorKind = "auth" | "no-plan" | "rate-limited" | "network" | "bad-response";
export class AdapterError extends Error {
  constructor(public kind: AdapterErrorKind, message: string) { super(message); this.name = "AdapterError"; }
}
```

```ts
// src/normalize.ts
export function toNumber(v: unknown): number | null;      // accepts number | numeric string; else null
export function toISODate(v: unknown): string | null;     // accepts ISO string | epoch seconds | epoch ms; validates via Date
export function pick(obj: unknown, ...keys: string[]): unknown; // first non-null/undefined of obj[keys]; obj must be a plain object else undefined
export function ratioToPercent(ratio: number): number;    // 0-1 -> 0-100, clamped [0,100], rounded to 1 decimal
export function windowFromCounts(kind: WindowKind, label: string, detail: { limit?: unknown; used?: unknown; remaining?: unknown; reset?: unknown }): UsageWindow; // builds window with toNumber/toISODate, usedPercent = used/limit*100 when both known
```

```ts
// src/paths.ts
export function dataHome(env: NodeJS.ProcessEnv = process.env): string;      // $OPENCODE_DATA_HOME or ~/.local/share/opencode
export function authPath(env?): string;                                      // <dataHome>/auth.json
export function pluginStateDir(env?): string;                                // <dataHome>/usage-report
export function dbPath(env?): string;                                        // <dataHome>/opencode.db
```

```ts
// src/auth.ts
import type { Credential } from "./types.js";
export function envVarName(providerId: string): string;   // "kimi-for-coding" -> "OPENCODE_USAGE_KIMI_FOR_CODING_KEY"
export function resolveCredential(providerId: string, opts?: { env?: NodeJS.ProcessEnv; dataHomeDir?: string }): Credential | null;
// order: (1) env override (empty string = missing), (2) auth.json entry { type:"api" -> .key, type:"oauth" -> .access }
// malformed/missing auth.json -> null. Never throws.
export function redact(text: string, key: string | null): string; // replaces all occurrences of key (len>=8) with "<redacted>"
```

**Steps (TDD):**

- [ ] **Step 1: failing tests** — `test/normalize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toNumber, toISODate, pick, ratioToPercent, windowFromCounts } from "../src/normalize.js";

describe("toNumber", () => {
  it("parses numbers and numeric strings", () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber("2900")).toBe(2900);
    expect(toNumber("nope")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
  });
});
describe("toISODate", () => {
  it("accepts ISO strings and epoch numbers", () => {
    expect(toISODate("2026-09-16T14:05:00Z")).toBe("2026-09-16T14:05:00.000Z");
    expect(toISODate("not a date")).toBeNull();
    expect(toISODate(null)).toBeNull();
  });
});
describe("pick", () => {
  it("returns first defined key", () => {
    expect(pick({ a: null, b: 2, c: 3 }, "a", "b", "c")).toBe(2);
    expect(pick({ x: 1 }, "a", "b")).toBeUndefined();
    expect(pick("nope", "a")).toBeUndefined();
  });
});
describe("ratioToPercent", () => {
  it("converts and clamps", () => {
    expect(ratioToPercent(0.421)).toBe(42.1);
    expect(ratioToPercent(1.5)).toBe(100);
    expect(ratioToPercent(-0.2)).toBe(0);
  });
});
describe("windowFromCounts", () => {
  it("computes percent from string counts", () => {
    const w = windowFromCounts("5h", "5-hour", { limit: "2900", used: "1218", remaining: "1682", reset: "2026-09-16T14:05:00Z" });
    expect(w.used).toBe(1218);
    expect(w.usedPercent).toBe(42);
    expect(w.resetsAt).toBe("2026-09-16T14:05:00.000Z");
    expect(w.status).toBe("ok");
  });
  it("leaves percent null when limit unknown", () => {
    const w = windowFromCounts("weekly", "Weekly", { used: 10 });
    expect(w.usedPercent).toBeNull();
  });
});
```

`test/auth.test.ts` — use `vi.stubEnv` / temp dirs (`fs.mkdtemp`) for auth.json fixtures:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envVarName, resolveCredential, redact } from "../src/auth.js";

describe("envVarName", () => {
  it("normalizes provider ids", () => {
    expect(envVarName("kimi-for-coding")).toBe("OPENCODE_USAGE_KIMI_FOR_CODING_KEY");
  });
});
describe("resolveCredential", () => {
  afterEach(() => { delete process.env.OPENCODE_USAGE_KIMI_FOR_CODING_KEY; });
  it("prefers env override", () => {
    process.env.OPENCODE_USAGE_KIMI_FOR_CODING_KEY = "sk-env";
    expect(resolveCredential("kimi-for-coding")?.key).toBe("sk-env");
  });
  it("reads api key from auth.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-"));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "sk-file" } }));
    expect(resolveCredential("kimi-for-coding", { dataHomeDir: dir })?.key).toBe("sk-file");
  });
  it("reads oauth access token", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-"));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ p: { type: "oauth", access: "tok" } }));
    expect(resolveCredential("p", { dataHomeDir: dir })).toEqual({ type: "oauth", key: "tok" });
  });
  it("returns null for missing entry / malformed json / empty env override", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-"));
    expect(resolveCredential("nope", { dataHomeDir: dir })).toBeNull();
    writeFileSync(join(dir, "auth.json"), "{bad json");
    expect(resolveCredential("kimi-for-coding", { dataHomeDir: dir })).toBeNull();
    process.env.OPENCODE_USAGE_KIMI_FOR_CODING_KEY = "";
    expect(resolveCredential("kimi-for-coding", { dataHomeDir: dir })).toBeNull();
  });
});
describe("redact", () => {
  it("replaces key material", () => {
    expect(redact("failed with sk-kimi-secret-123: unauthorized", "sk-kimi-secret-123")).toBe("failed with <redacted>: unauthorized");
  });
  it("ignores short/null keys", () => {
    expect(redact("abc", "ab")).toBe("abc");
    expect(redact("abc", null)).toBe("abc");
  });
});
```

- [ ] **Step 2:** run `npx vitest run` → FAIL (module not found).
- [ ] **Step 3:** implement the four files per signatures above.
- [ ] **Step 4:** `npx vitest run` → PASS; `npx tsc --noEmit` clean.

---

### Task 2: Kimi adapter

**Files:**
- Create: `src/providers/kimi.ts`, `src/providers/index.ts`
- Create: `fixtures/kimi-canonical.json`, `fixtures/kimi-strings.json`, `fixtures/kimi-minimal.json`
- Test: `test/kimi.test.ts`

**Consumes:** `types.ts` (`ProviderAdapter`, `AdapterResult`, `AdapterError`, `UsageWindow`), `normalize.ts` (`toNumber`, `pick`, `ratioToPercent`, `windowFromCounts`), `auth.ts` (`redact`).

**Produces:** `kimiAdapter: ProviderAdapter` (id `"kimi-for-coding"`, displayName `"Kimi Code"`); `src/providers/index.ts`:

```ts
import type { ProviderAdapter } from "../types.js";
import { kimiAdapter } from "./kimi.js";
import { opencodeGoAdapter } from "./opencode-go.js"; // NOTE: created in Task 3; if absent during Task 2, export registry with only kimi and let Task 3 add the import
export const adapters: ProviderAdapter[] = [kimiAdapter, opencodeGoAdapter];
export function getAdapter(id: string): ProviderAdapter | undefined { return adapters.find(a => a.id === id); }
```

**Endpoint:** `GET https://api.kimi.com/coding/v1/usages`, headers `{ Authorization: "Bearer " + cred.key, Accept: "application/json", "User-Agent": "opencode-usage-report/" + VERSION }` where `VERSION = "0.1.0"` (const at top of file). Timeout from `opts.timeoutMs` via `AbortSignal.timeout`. One retry on network error / 5xx; none on 4xx.

**Parsing precedence (spec §3.3):**
1. `usages.limit_5h` → `{ used_ratio, reset_time }` → window kind `"5h"`, label `"5-hour"`, `usedPercent = ratioToPercent(used_ratio)`, `resetsAt = toISODate(reset_time)`, absolutes null. Same for `usages.limit_7d` → kind `"weekly"`, label `"Weekly"`.
2. If `usages.limit_5h` absent: scan `limits[]` for `window.duration == 300 && window.timeUnit == "TIME_UNIT_MINUTE"` → `windowFromCounts("5h", "5-hour", { limit: detail.limit, used: detail.used, remaining: detail.remaining, reset: pick(detail, "resetTime", "reset_time", "resetAt") })`.
3. If `usages.limit_7d` absent: top-level `usage` → `windowFromCounts("weekly", "Weekly", ...)` with same reset pick.
4. Extras (all optional, never fail): `user.membership.level` → `extras["Plan"]`; `booster_wallet.balance` → `extras["Booster wallet"]`; `totalQuota` with `toNumber(used) > 0` → push monthly window `{ kind: "monthly", label: "Monthly", status: "frozen", usedPercent: null, ... }`.

**Error mapping:** 401 → `AdapterError("auth", "invalid Kimi API key")`; 429 → `AdapterError("rate-limited", ...)`; non-JSON / missing expected shape → `AdapterError("bad-response", ...)`; fetch throw / 5xx after retry → `AdapterError("network", ...)`. All messages passed through `redact(msg, cred.key)`.

**Fixtures (create with these exact shapes, synthetic values):**

`fixtures/kimi-canonical.json`:
```json
{
  "usage": { "limit": "2900", "used": "1769", "remaining": "1131", "resetTime": "2026-09-22T00:00:00Z" },
  "limits": [
    { "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
      "detail": { "limit": "2900", "used": "1218", "remaining": "1682", "resetTime": "2026-09-16T14:05:00Z" } }
  ],
  "usages": {
    "limit_5h": { "used_ratio": 0.42, "reset_time": "2026-09-16T14:05:00Z" },
    "limit_7d": { "used_ratio": 0.61, "reset_time": "2026-09-22T00:00:00Z" }
  },
  "booster_wallet": { "balance": "3.21" },
  "user": { "membership": { "level": "LEVEL_PRO" } }
}
```
`fixtures/kimi-strings.json`: canonical minus `usages` block (forces `limits[]`/top-level path), all counts strings, reset key spelled `resetAt`.
`fixtures/kimi-minimal.json`: `{ "usage": { "limit": "100", "used": "0", "remaining": "100", "resetTime": "2026-09-22T00:00:00Z" } }` only.

**Steps (TDD):**

- [ ] **Step 1: failing tests** — `test/kimi.test.ts`. Mock `globalThis.fetch` with `vi.stubGlobal`; helper `mockFetchOnce(status, body)`. Cases:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { kimiAdapter } from "../src/providers/kimi.js";
import { AdapterError } from "../src/types.js";

const cred = { type: "api" as const, key: "sk-test-key-123456" };
const opts = { timeoutMs: 1000 };
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8"));
function mockFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));
}
afterEach(() => vi.unstubAllGlobals());

describe("kimiAdapter", () => {
  it("parses canonical response preferring usages ratios", async () => {
    mockFetch(200, fixture("kimi-canonical.json"));
    const r = await kimiAdapter.fetch(cred, opts);
    const fiveH = r.windows.find(w => w.kind === "5h")!;
    expect(fiveH.usedPercent).toBe(42);
    const weekly = r.windows.find(w => w.kind === "weekly")!;
    expect(weekly.usedPercent).toBe(61);
    expect(r.extras?.["Plan"]).toBe("LEVEL_PRO");
    expect(r.extras?.["Booster wallet"]).toBe("3.21");
  });
  it("falls back to limits[] and top-level usage with string counts", async () => {
    mockFetch(200, fixture("kimi-strings.json"));
    const r = await kimiAdapter.fetch(cred, opts);
    const fiveH = r.windows.find(w => w.kind === "5h")!;
    expect(fiveH.used).toBe(1218);
    expect(fiveH.usedPercent).toBe(42);
    expect(fiveH.resetsAt).toBe("2026-09-16T14:05:00.000Z");
  });
  it("handles minimal response", async () => {
    mockFetch(200, fixture("kimi-minimal.json"));
    const r = await kimiAdapter.fetch(cred, opts);
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0].kind).toBe("weekly");
  });
  it("marks monthly frozen when totalQuota.used > 0", async () => {
    const body = { ...fixture("kimi-minimal.json"), totalQuota: { limit: "10", used: "3", remaining: "7" } };
    mockFetch(200, body);
    const r = await kimiAdapter.fetch(cred, opts);
    expect(r.windows.find(w => w.kind === "monthly")?.status).toBe("frozen");
  });
  it("sends Authorization and User-Agent headers", async () => {
    mockFetch(200, fixture("kimi-minimal.json"));
    await kimiAdapter.fetch(cred, opts);
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer sk-test-key-123456");
    expect(headers["User-Agent"]).toMatch(/^opencode-usage-report\//);
  });
  it("maps 401 to auth error without leaking key", async () => {
    mockFetch(401, { error: { message: "invalid token sk-test-key-123456" } });
    await expect(kimiAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "auth" });
    await expect(kimiAdapter.fetch(cred, opts)).rejects.toThrow(/<redacted>|invalid Kimi API key/);
  });
  it("throws network AdapterError after retry on 500", async () => {
    mockFetch(500, "oops");
    await expect(kimiAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "network" });
    expect((globalThis.fetch as any).mock.calls.length).toBe(2);
  });
});
```

- [ ] **Step 2:** `npx vitest run test/kimi.test.ts` → FAIL.
- [ ] **Step 3:** implement `src/providers/kimi.ts` + fixtures + `src/providers/index.ts`.
- [ ] **Step 4:** `npx vitest run` → PASS, `npx tsc --noEmit` clean.

---

### Task 3: OpenCode Go adapter

**Files:**
- Create: `src/providers/opencode-go.ts`
- Create: `fixtures/go-canonical.json`, `fixtures/go-minimal.json`
- Modify: `src/providers/index.ts` (add import if Task 2 left it out — coordinate: whoever implements second ensures both adapters are registered)
- Test: `test/opencode-go.test.ts`

**Consumes:** same foundation as Task 2, plus `cache.ts`'s `ensureSessionId` IF available — to avoid cross-task dependency, adapter takes `sessionId?: string` in `FetchOptions`-adjacent param: extend signature locally as `fetch(cred, opts)` where `opts` is `FetchOptions & { sessionId?: string }` (additive, safe).

**Produces:** `opencodeGoAdapter: ProviderAdapter` (id `"opencode-go"`, displayName `"OpenCode Go"`).

**Endpoint:** `GET https://opencode.ai/zen/go/v1/usage`, headers `{ Authorization: "Bearer " + cred.key, Accept: "application/json", "User-Agent": "opencode-usage-report/0.1.0", "x-opencode-session": opts.sessionId ?? "unknown" }`.

**Parsing:** `body.usage.rolling` → `{ kind: "5h", label: "5-hour" }`, `.weekly` → weekly, `.monthly` → monthly. Each source object `{ status: "ok"|"rate-limited", percent: number, resetsAt: string }` → `usedPercent = toNumber(percent)`, `resetsAt = toISODate(resetsAt)`, `status` mapped ("ok"→"ok", "rate-limited"→"rate-limited", else "unknown"). Absolutes null.

**Error mapping:** 401 → `auth`; 403 with body `error.type == "EntitlementError"` → `no-plan` ("OpenCode Go subscription not active on this key"); other 403 (e.g. Cloudflare 1010 HTML) → `network` with hint "blocked (check User-Agent)"; 429 → `rate-limited`; 5xx/network → `network` (retry once). Redact all.

**Fixtures:**

`fixtures/go-canonical.json`:
```json
{ "usage": {
  "rolling": { "status": "ok", "percent": 12, "resetsAt": "2026-09-16T13:40:00Z" },
  "weekly":  { "status": "ok", "percent": 57, "resetsAt": "2026-09-18T00:00:00Z" },
  "monthly": { "status": "ok", "percent": 3,  "resetsAt": "2026-10-01T00:00:00Z" } } }
```
`fixtures/go-minimal.json`: `{ "usage": { "rolling": { "status": "ok", "percent": 0, "resetsAt": "2026-09-16T13:40:00Z" } } }`

**Steps (TDD):**

- [ ] **Step 1: failing tests** — `test/opencode-go.test.ts`, same mocking pattern as kimi:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { opencodeGoAdapter } from "../src/providers/opencode-go.js";

const cred = { type: "api" as const, key: "sk-go-key-123456" };
const opts = { timeoutMs: 1000, sessionId: "sess-1" };
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8"));
function mockFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));
}
afterEach(() => vi.unstubAllGlobals());

describe("opencodeGoAdapter", () => {
  it("parses canonical windows", async () => {
    mockFetch(200, fixture("go-canonical.json"));
    const r = await opencodeGoAdapter.fetch(cred, opts);
    expect(r.windows.map(w => w.kind)).toEqual(["5h", "weekly", "monthly"]);
    expect(r.windows[1].usedPercent).toBe(57);
    expect(r.windows[2].resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });
  it("maps rate-limited status", async () => {
    mockFetch(200, { usage: { rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-09-16T13:40:00Z" } } });
    const r = await opencodeGoAdapter.fetch(cred, opts);
    expect(r.windows[0].status).toBe("rate-limited");
  });
  it("sends custom UA and session header", async () => {
    mockFetch(200, fixture("go-minimal.json"));
    await opencodeGoAdapter.fetch(cred, opts);
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(headers["User-Agent"]).toMatch(/^opencode-usage-report\//);
    expect(headers["x-opencode-session"]).toBe("sess-1");
  });
  it("maps 403 EntitlementError to no-plan", async () => {
    mockFetch(403, { type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } });
    await expect(opencodeGoAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "no-plan" });
  });
  it("maps 401 to auth", async () => {
    mockFetch(401, { type: "error", error: { type: "AuthError" } });
    await expect(opencodeGoAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "auth" });
  });
});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npx vitest run` PASS + `tsc --noEmit` clean.

---

### Task 4: Cache + local fallback

**Files:**
- Create: `src/cache.ts`, `src/fallback.ts`
- Test: `test/cache.test.ts`, `test/fallback.test.ts`

**Consumes:** `types.ts`, `paths.ts` (`pluginStateDir`, `dbPath`).

**Produces:**

```ts
// src/cache.ts
import type { AdapterResult } from "./types.js";
export interface CacheEntry { fetchedAt: string; result: AdapterResult }
export async function readCache(providerId: string, ttlSeconds: number, env?: NodeJS.ProcessEnv): Promise<{ entry: CacheEntry; fresh: boolean } | null>;
  // file <pluginStateDir>/cache-<providerId>.json; fresh = age <= ttl; corrupt/missing -> null
export async function writeCache(providerId: string, result: AdapterResult, env?: NodeJS.ProcessEnv): Promise<void>;
  // atomic: write tmp + rename; mkdir -p state dir
export async function ensureSessionId(env?: NodeJS.ProcessEnv): Promise<string>;
  // <pluginStateDir>/session-id; crypto.randomUUID() once, persisted
```

```ts
// src/fallback.ts
import type { AdapterResult } from "./types.js";
export async function localEstimate(providerId: string, env?: NodeJS.ProcessEnv): Promise<AdapterResult | null>;
  // opens dbPath(env) SQLite READ-ONLY (node:sqlite DatabaseSync with { readOnly: true } — Node 22.5+; if unavailable, dynamic import fails -> return null)
  // introspect tables; expected: message/part tables with token counts & provider/model info
  // aggregate per rolling 5h and weekly windows -> UsageWindow[] with absolutes only (usedPercent null), kind "5h"/"weekly", status "ok", resetsAt null
  // ANY error (missing db, schema drift, no rows) -> null. Never throws.
```

Note for implementer: inspect the real DB schema first with `sqlite3 ~/.local/share/opencode/opencode.db ".schema message"` and `.schema part` (read-only) and code defensively (`SELECT name FROM sqlite_master WHERE type='table'` guard). If token columns aren't found, aggregate message counts instead. All queries wrapped in try/catch → null.

**Steps (TDD):**

- [ ] **Step 1: failing tests** — `test/cache.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache, ensureSessionId } from "../src/cache.js";

const env = (dir: string) => ({ OPENCODE_DATA_HOME: dir }) as unknown as NodeJS.ProcessEnv;
const result = { windows: [{ kind: "5h", label: "5-hour", usedPercent: 10, used: null, limit: null, remaining: null, resetsAt: null, status: "ok" as const }] };

describe("cache", () => {
  it("round-trips fresh entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-"));
    await writeCache("p1", result, env(dir));
    const r = await readCache("p1", 120, env(dir));
    expect(r?.fresh).toBe(true);
    expect(r?.entry.result.windows[0].usedPercent).toBe(10);
  });
  it("marks stale past TTL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-"));
    await writeCache("p1", result, env(dir));
    const r = await readCache("p1", -1, env(dir));
    expect(r?.fresh).toBe(false);
  });
  it("returns null on corrupt cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-"));
    const stateDir = join(dir, "usage-report");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "cache-p1.json"), "{corrupt");
    expect(await readCache("p1", 120, env(dir))).toBeNull();
  });
  it("ensureSessionId persists one uuid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-"));
    const a = await ensureSessionId(env(dir));
    const b = await ensureSessionId(env(dir));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

`test/fallback.test.ts`: create a temp SQLite db (node:sqlite `DatabaseSync`) with a plausible minimal schema, verify `localEstimate` returns windows; verify missing db file → null.

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npx vitest run` PASS + `tsc --noEmit` clean.

---

### Task 5: Render + warnings

**Files:**
- Create: `src/render.ts`, `src/warn.ts`
- Test: `test/render.test.ts`, `test/warn.test.ts`

**Consumes:** `types.ts`, `paths.ts`.

**Produces:**

```ts
// src/render.ts
import type { ProviderReport } from "./types.js";
export function renderText(reports: ProviderReport[], opts?: { now?: Date }): string;
export function renderJson(reports: ProviderReport[]): string; // JSON.stringify(reports, null, 2)
```

Text format per provider (see spec §3.8):
- Header: `DisplayName (source[, stale Xm old])`
- Window line: two-space indent, kind label padded to 8, `NN% used` or `~` when local-estimate or `—` when percent null, optional `used / limit reqs`, `resets <relative-or-short-date>`.
- Error: `⚠ DisplayName: error`.
- extras lines: `  Key: value`.

```ts
// src/warn.ts
import type { ProviderReport, UsageWindow } from "./types.js";
export interface WarnHit { provider: string; displayName: string; window: UsageWindow; message: string }
export async function checkWarnings(reports: ProviderReport[], thresholdPercent: number, env?: NodeJS.ProcessEnv): Promise<WarnHit[]>;
// crossing: usedPercent >= threshold OR status in {"rate-limited","frozen"}
// state file <pluginStateDir>/warn-state.json: { "<provider>/<kind>": { firedAtReset: string|null } }
// fire only if not already fired for current resetsAt; re-arm when usedPercent < threshold - 10
// message: "Kimi Code 5-hour window at 83% (resets 14:05)" / "... is rate-limited"
```

**Steps (TDD):**

- [ ] **Step 1: failing tests** — `test/warn.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWarnings } from "../src/warn.js";
import type { ProviderReport } from "../src/types.js";

const env = (d: string) => ({ OPENCODE_DATA_HOME: d }) as unknown as NodeJS.ProcessEnv;
const report = (pct: number, resetsAt: string | null = "2026-09-16T14:05:00Z"): ProviderReport[] => [{
  provider: "p", displayName: "P", fetchedAt: "2026-09-16T12:00:00Z", source: "api", stale: false,
  windows: [{ kind: "5h", label: "5-hour", usedPercent: pct, used: null, limit: null, remaining: null, resetsAt, status: "ok" }],
  extras: {}, error: null,
}];

describe("checkWarnings", () => {
  it("fires once per crossing until reset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "warn-"));
    expect(await checkWarnings(report(85), 80, env(dir))).toHaveLength(1);
    expect(await checkWarnings(report(90), 80, env(dir))).toHaveLength(0); // same window, already fired
    expect(await checkWarnings(report(10), 80, env(dir))).toHaveLength(0); // below threshold
    expect(await checkWarnings(report(95, "2026-09-16T19:05:00Z"), 80, env(dir))).toHaveLength(1); // new reset -> refire
  });
  it("fires on rate-limited status regardless of percent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "warn-"));
    const r = report(50);
    r[0].windows[0].status = "rate-limited";
    expect(await checkWarnings(r, 80, env(dir))).toHaveLength(1);
  });
  it("respects threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "warn-"));
    expect(await checkWarnings(report(79), 80, env(dir))).toHaveLength(0);
  });
});
```

`test/render.test.ts` — construct ProviderReports covering: fresh api report with percent + absolutes + extras; local-estimate report (`~` marker); error report (`⚠`); stale report (`stale`). Assert key substrings (not full snapshots):

```ts
import { describe, it, expect } from "vitest";
import { renderText, renderJson } from "../src/render.js";
import type { ProviderReport } from "../src/types.js";

const base: ProviderReport = {
  provider: "kimi-for-coding", displayName: "Kimi Code", fetchedAt: new Date(Date.now() - 5 * 60000).toISOString(),
  source: "api", stale: false,
  windows: [{ kind: "5h", label: "5-hour", usedPercent: 42, used: 1218, limit: 2900, remaining: 1682, resetsAt: "2026-09-16T14:05:00Z", status: "ok" }],
  extras: { "Booster wallet": "3.21" }, error: null,
};

describe("renderText", () => {
  it("renders windows, extras, and percent", () => {
    const out = renderText([base]);
    expect(out).toContain("Kimi Code");
    expect(out).toContain("42% used");
    expect(out).toContain("1,218 / 2,900");
    expect(out).toContain("Booster wallet: 3.21");
  });
  it("marks stale and local estimates", () => {
    const out = renderText([{ ...base, stale: true, source: "cache" }]);
    expect(out).toMatch(/stale/i);
    const est = renderText([{ ...base, source: "local-estimate" }]);
    expect(est).toContain("~");
  });
  it("renders errors", () => {
    const out = renderText([{ ...base, source: "error", error: "no credential found", windows: [] }]);
    expect(out).toContain("⚠ Kimi Code: no credential found");
  });
});
describe("renderJson", () => {
  it("emits parseable JSON", () => {
    expect(JSON.parse(renderJson([base]))[0].provider).toBe("kimi-for-coding");
  });
});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npx vitest run` PASS + `tsc --noEmit` clean.

---

### Task 6: Orchestration + plugin wiring + smoke + README (after 1–5 merge)

**Files:**
- Create: `src/report.ts`, `src/index.ts`, `scripts/live-smoke.ts`, `README.md`
- Test: `test/report.test.ts`

**Consumes:** everything above.

**Produces:**

```ts
// src/report.ts
import type { ProviderReport, PluginOptions } from "./types.js";
export const DEFAULT_OPTIONS: PluginOptions = { thresholdPercent: 80, cacheTtlSeconds: 120, providers: null, fallback: true };
export async function collectReports(opts: { providers?: string[]; refresh?: boolean; options?: Partial<PluginOptions>; env?: NodeJS.ProcessEnv }): Promise<ProviderReport[]>;
```

Per adapter (filtered by `opts.providers` / `options.providers`; unknown id → error report `"unknown provider '<id>' (known: kimi-for-coding, opencode-go)"`):
1. `resolveCredential` → null → error report "no credential found".
2. If `!refresh`: `readCache` fresh → report `source: "cache"`.
3. `adapter.fetch(cred, { timeoutMs: 5000, sessionId: await ensureSessionId() })` → success → `writeCache`, report `source: "api"`.
4. On `AdapterError` → stale cache if exists (`source: "cache", stale: true`, error set); else if `options.fallback` → `localEstimate` → `source: "local-estimate", stale: true`; else error report with sanitized message.

```ts
// src/index.ts
import type { Plugin } from "@opencode-ai/plugin";
import { collectReports, DEFAULT_OPTIONS } from "./report.js";
import { renderText, renderJson } from "./render.js";
import { checkWarnings } from "./warn.js";

const plugin: Plugin = async ({ client }, options) => {
  const opts = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  let lastWarnCheck = 0;
  return {
    tool: {
      usage_report: {
        description: "Show subscription usage/quota windows (5h, weekly, monthly) for configured inference providers (kimi-for-coding, opencode-go)",
        args: {
          provider: { type: "string", description: "optional provider id filter", optional: true },
          json: { type: "boolean", description: "emit JSON", optional: true },
          refresh: { type: "boolean", description: "bypass cache", optional: true },
        },
        async execute(args: { provider?: string; json?: boolean; refresh?: boolean }) {
          const reports = await collectReports({ providers: args.provider ? [args.provider] : undefined, refresh: args.refresh, options: opts });
          return args.json ? renderJson(reports) : renderText(reports);
        },
      },
    },
    config(cfg) {
      cfg.command ??= {};
      cfg.command.usage ??= {
        description: "Show subscription usage/quota windows for configured providers",
        template: "Call the usage_report tool with these arguments: $ARGUMENTS and present the result verbatim.",
      };
    },
    async event({ event }) {
      try {
        if (event.type !== "session.idle") return;
        if (Date.now() - lastWarnCheck < 10 * 60 * 1000) return;
        lastWarnCheck = Date.now();
        const reports = await collectReports({ options: opts });
        const hits = await checkWarnings(reports, opts.thresholdPercent);
        for (const hit of hits) {
          await client.tui.showToast({ body: { title: "Usage warning", message: hit.message, variant: "warning" } }).catch(() => {});
        }
      } catch { /* never throw into the event bus */ }
    },
  };
};
export default plugin;
```

Note for implementer: verify the exact `tool` registration shape and `client.tui.showToast` signature against the installed `@opencode-ai/plugin` version (`node_modules/@opencode-ai/plugin/dist/*.d.ts`) and adjust; wrap both in defensive try/catch. The `PluginOptions` tuple form in user config passes options as the 2nd arg.

`scripts/live-smoke.ts`: refuses to run without `--yes-live` arg; calls `collectReports({ refresh: true })`, prints `renderText`, exits non-zero if any report has `source: "error"`.

`test/report.test.ts`: mock adapters via `vi.mock("../src/providers/index.js")` — unknown provider error row; credential-missing error row (env with empty data home); cache-hit path; adapter-failure → local-estimate path (mock fallback too).

**README.md sections:** What it does; install (`plugin: ["./path/or/npm-spec"]` in opencode.json, restart opencode); `/usage`, `/usage kimi`, `/usage --json`, `/usage --refresh`; options table; how warnings work; data sources & privacy note (keys never logged); extending (new adapter recipe with Gemini/Claude pointers from spec §8); development (`npm test`, `npm run typecheck`, `npm run smoke -- --yes-live`).

**Steps:**
- [ ] **Step 1:** failing `test/report.test.ts`. **Step 2:** run → FAIL. **Step 3:** implement report.ts. **Step 4:** PASS.
- [ ] **Step 5:** implement index.ts + smoke + README.
- [ ] **Step 6:** full `npx vitest run` PASS + `npx tsc --noEmit` clean.
- [ ] **Step 7:** manual: `npm run smoke -- --yes-live` (orchestrator runs this, real keys) → both providers `source: "api"`.

---

## Self-Review Notes (completed by plan author)

- Spec coverage: §3.1 types → T1; §3.2 auth → T1; §3.3 adapters → T2/T3; §3.4 cache → T4; §3.5 fallback → T4; §3.6 wiring → T6; §3.7 warn → T5; §3.8 render → T5; §4 errors → all; §5 edge cases 1–20 → mapped to adapter/cache/warn/render/auth tests; §6 testing → every task; §7 acceptance → T6 step 7 + final integration.
- Known cross-task coordination point: `src/providers/index.ts` (Tasks 2 & 3) — orchestrator merges after both complete.
- `report.ts` was added to the file map beyond the spec's listed files (spec says orchestration "lives outside adapters") — spec §3 architecture list should be read as including `src/report.ts`.
