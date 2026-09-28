# Design: Antigravity-style context visualization in `/usage`

- **Date:** 2026-09-28
- **Status:** approved
- **Supersedes:** nothing. Extends `2026-09-16-opencode-usage-plugin-design.md`.
- **Target:** `opencode-usage-report` v0.3.0
- **Verified against:** `opencode` / `@opencode-ai/plugin` **1.18.31** (the installed version). Release tag `v1.18.31` and `dev` are byte-identical for every file cited.

## 1. Goal

Add a context-usage visualization to `/usage`, in addition to everything `/usage`
shows today. The visual follows Antigravity's "Context Usage" panel: a model
header line with an exact token total and percentage, a grid of square cells
that fill by category, and a legend of per-category rows.

```
  Context
  Kimi K2 (High) · 42,318 / 200,000 tokens (21.2%)

  ██████████████████████  ████████████████████████████████  ████  ██████████████████████████████
  ██  ████████████████████  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

  ● User messages      8,204   4.1%      ● System & tools    8,144   4.1%
  ● Agent responses   11,650   5.8%      ● Free space     157,682  78.8%
  ● Reasoning          2,140   1.1%
  ● Tool calls        12,180   6.1%

  Auto-compacts at 180,000 · 137,682 headroom        $0.42 spent

  ──────────────────────────────────────────────────────────────────────────────────────

  Kimi Code (api)
    5h limit   ████████░░░░░░░░  63%   12,640 / 20,000 reqs   resets in 3h 33m
    …
```

## 2. Non-goals

- A real tokenizer. Kimi, DeepSeek and MiMo publish no tokenizer, so they would
  fall back to `chars/4` regardless; adding `gpt-tokenizer` would only help
  Anthropic/OpenAI models and would make our numbers disagree with opencode's own
  compaction math.
- Per-tool token tables, cache read/write as separate rows, prune warnings, and
  per-step context growth. All were considered and deferred; the six-row set and
  header/footer were chosen explicitly.
- Any change to the sidebar panel, the `usage.refresh` command, or its default
  `ctrl+shift+u` binding.
- Changing the `usage_report` tool's arguments or output format.

## 3. Locked decisions

| # | Decision |
|---|---|
| D1 | The TUI plugin owns `/usage` entirely. `cfg.command.usage` is deleted. |
| D2 | Stacked single scrollbox: context block on top, divider, existing quota output below. |
| D3 | Six rows: user messages, agent responses, reasoning, tool calls, system & tools, free space. |
| D4 | The system prompt is captured exactly in this release, with a mandatory residual fallback. |
| D5 | Header (model, total, percent), compaction headroom line, and session cost. |
| D6 | Grid is 6 rows, cells 2 columns wide, adapting to dialog width. |
| D7 | Empty state is Antigravity-literal: hollow grid, `0 (0.0%)`, "awaiting first response" caption. |

### D1 rationale and the one regression

Today `/usage` is a server-side prompt template (`src/index.ts:16-17,96-99`): the
user types it, the server expands the template, and the model calls the
`usage_report` tool. A TUI-registered `/usage` appears in the same slash
autocomplete, so keeping both would show two identical rows.

The TUI path is strictly better for the no-argument case: the host pushes keymap
mode `"autocomplete"` while the slash list is open
(`packages/tui/src/component/prompt/autocomplete.tsx:109-113`), where `return`
is bound to `prompt.autocomplete.select` rather than `input_submit`. Selecting
calls `keymap.dispatchCommand(...)` and never inserts text, so no tokens are
spent. Verified at `packages/tui/src/keymap.tsx:260-289` — a command needs
`namespace: "palette"` (`:265`), a non-empty `slashName` (`:272`), and
`hidden !== true` (`:49-51`).

**Accepted regression:** slash *arguments* go away. `/usage --json` and
`/usage <provider>` required a trailing space, which closes the autocomplete;
with no server command registered, the literal text would be sent to the model as
a prompt. The same capabilities move to dialog keys (§8) and remain available
through the `usage_report` tool for headless and agent use.

## 4. Architecture

```
opencode server                          opencode TUI
───────────────                          ───────────
src/index.ts                             src/tui.tsx
  └ experimental.chat.system.transform     └ registers slash command "usage"
      ↓                                        └ api.ui.dialog.setSize("xlarge")
  src/context/system.ts (write)                └ api.ui.dialog.replace(<UsageDialog/>)
      ↓                                        ├─ src/context/dialog.tsx   (context block)
  <data-home>/usage-report/context/            └─ src/quota-lines.ts        (existing output)
    <sessionID>.json  ─────────────────────►
                                        src/context/collect.ts  (pure)
                                          src/context/estimate.ts (pure)
                                          src/context/headroom.ts (pure)
                                          src/context/format.ts   (pure)
```

The server side gains exactly one responsibility: writing the system-prompt
sidecar. All arithmetic lives in pure modules with no OpenTUI import, so it is
unit-testable under the existing `npm test` (vitest, no network).

### 4.1 Files

| File | Kind | Purpose |
|---|---|---|
| `src/context/types.ts` | types | `ContextBreakdown`, `ContextRow`, `GridCell`, `SystemCapture` |
| `src/context/estimate.ts` | pure | `estimateTokens(text)` — mirrors `packages/core/src/util/token.ts` |
| `src/context/headroom.ts` | pure | compaction headroom + band |
| `src/context/collect.ts` | pure | `(input) => ContextBreakdown` |
| `src/context/grid.ts` | pure | cell layout from a breakdown |
| `src/context/format.ts` | pure | breakdown → `Line[]` (pre-colored segments), like `tui-format.ts` |
| `src/context/system.ts` | io | sidecar read/write, atomic, defensive |
| `src/context/dialog.tsx` | jsx | renders the context block |
| `src/quota-lines.ts` | pure | `buildLines` extracted verbatim from `src/tui.tsx` |
| `src/tui.tsx` | jsx | + `/usage` command; existing panel unchanged |
| `src/index.ts` | plugin | − `cfg.command.usage`, + system-prompt hook |

## 5. Data model

```ts
type RowKey = "user" | "agent" | "reasoning" | "tools" | "system" | "free";

interface ContextRow {
  key: RowKey;
  label: string;
  tokens: number | null;
  percent: number | null;   // 0-100, null when the limit is unknown
  exact: boolean;           // true for rows derived from provider-reported numbers
}

interface GridCell {
  rowKey: RowKey | null;    // null = free space
  fill: number;             // 0..1
}

interface ContextBreakdown {
  ready: boolean;           // false until an assistant message reports usage
  modelName: string | null;
  total: number | null;     // exact prompt tokens
  limit: number | null;
  cost: number;
  rows: ContextRow[];       // always 6, in the order above
  grid: { cols: number; rows: number; cells: GridCell[] };
  headroom: { usable: number | null; free: number | null; band: "ok" | "warning" | "error" };
  systemDerived: boolean;   // true when the capture was unusable
  prunedToolOutputs: number;
}

interface SystemCapture {
  version: 1;
  sessionID: string;
  providerID: string;
  modelID: string;
  systemChars: number;
  systemTokens: number;
  capturedAt: number;       // epoch ms
}
```

## 6. `collect()` algorithm

### 6.1 Totals (exact)

The last assistant message that actually reported output is the reference point —
the same rule opencode's own Context block uses
(`packages/tui/src/feature-plugins/sidebar/context.tsx:28-35`):

```
last   = messages.findLast(m => m.role === "assistant" && m.tokens.output > 0)
total  = last.tokens.input + last.tokens.cache.read + last.tokens.cache.write
limit  = model.limit.context
free   = max(0, limit - total)
```

`tokens.input` is **exclusive** of cache — opencode normalizes
`adjustedInput = inputTokens - cacheRead - cacheWrite`
(`packages/opencode/src/session/session.ts:361-364`). `tokens.total` is not used:
it is passed through from the provider and may include completion tokens.

> **Deliberate difference from the sidebar.** opencode's native block sums five
> fields including `output` and `reasoning`, so it reads slightly higher than this
> panel. The prompt-only figure is the correct one for "context usage" — it is
> what occupies the window and what drives compaction. The README documents the
> delta so the discrepancy does not read as a bug.

If there is no such message, `ready` is `false` and the dialog renders D7's empty
state.

### 6.2 Which parts count

Walk only the messages that are still in context, mirroring
`MessageV2.filterCompacted` (`packages/opencode/src/session/message-v2.ts:525`):
start after the most recent assistant message with `summary === true`. Part
classification:

| Part | Category | Text measured |
|---|---|---|
| user `text` | user | part text |
| user `file` | user | filename + mime (binary content is not measured) |
| assistant `text` | agent | part text |
| assistant `reasoning` | reasoning | part text |
| `tool` with `state.time.compacted` set | — | **skipped**, counted in `prunedToolOutputs` |
| `tool` otherwise | tools | `JSON.stringify(state.input)` + `state.output` |
| `step-start`, `step-finish`, `snapshot` | — | skipped (accounting, not context) |

Tool call arguments and tool outputs share the single "Tool calls" row; they are
not split. Tool outputs are usually the larger half, which is the useful signal.

### 6.3 Estimation

`estimateTokens(text) = Math.max(0, Math.round(text.length / 4))`, identical to
opencode's `packages/core/src/util/token.ts:3-5`. No tokenizer exists anywhere in
opencode, so this keeps our estimates consistent with its own compaction
decisions. Every estimate function is total: no throws, no `NaN`, no unbounded
allocation — the same defensive contract as `coerceTuiOptions`.

### 6.4 The system row

```
estimatedSum = user + agent + reasoning + tools
residual     = max(0, total - estimatedSum)      // system prompt + tool schemas + framing
systemRow    = residual
```

The capture (D4) does not change the row value; it splits the residual into a
sub-breakdown shown beneath the legend when valid:

```
    ↳ 6,102 system prompt + 2,042 tools & framing
```

Without a valid capture the sub-line is omitted and the row is labelled
`derived`. The residual is clamped at 0: if our estimates overshoot `total`
(`chars/4` over-counts on some inputs, e.g. dense CJK or base64 blobs), the row
shows `0` rather than a negative number.

### 6.5 Normalization

`chars/4` is an estimate in both directions, so the five measured rows can sum to
slightly more or less than `total`. Raw estimates would make the legend
percentages disagree with the header and fill the grid past its true level. When
`estimatedSum > total`, the five measured rows are scaled by
`total / estimatedSum` and rounded so they sum to at most `total`; the system row
stays at its clamped value of `0`. When `estimatedSum <= total` no scaling
happens and the residual absorbs the difference, as above.

After normalization, and with `free` computed from `total`, the legend and the
header always agree, and the grid is filled from the normalized row values so it
can never show more than `total`. Rounding is distributed largest-remainder so
the scaled rows still sum to exactly the intended value.

## 7. Grid

```
rows        = 6                                   (constant, D6)
cols        = clamp(8, floor(innerWidth / 2), 60) (2 columns per cell, adapts to width)
cellCount   = cols * rows
tokensPerCell = limit / cellCount
```

Cells fill left-to-right, then top-to-bottom, in category order
`user → agent → reasoning → tools → system`. Each cell's `fill` is
`clamp(0, 1, remaining / tokensPerCell)`, so the cell straddling the exact total
renders partially rather than rounding up, and cumulative fill is additionally
clamped so it never exceeds `total` (see §6.5). `free` is never materialised as
cells — unfilled cells *are* free space, which is what makes the block read as a
fill-level meter.

Glyphs, chosen to match the `█`/`░` already used by `bar()` in
`src/tui-format.ts:28`:

| fill | glyph | color token |
|---|---|---|
| `0` | `░░` | `theme.borderSubtle` |
| `(0, 0.25]` | `▒▒` | category color |
| `(0.25, 0.75]` | `▓▓` | category color |
| `(0.75, 1]` | `██` | category color |

Category colors: user `info`, agent `success`, reasoning `secondary`, tools
`warning`, system `textMuted`.

When `limit` is unknown the grid is not rendered; counts and rows still are,
without percentages.

## 8. Headroom, cost, and keys

Headroom mirrors `packages/opencode/src/session/overflow.ts` exactly. Both
`limit.context` and `limit.output` are always present on the SDK model type; only
`limit.input` is optional.

```
maxOutput = model.limit.output
reserved  = config.compaction?.reserved ?? min(20000, maxOutput)
usable    = model.limit.input
              ? max(0, model.limit.input  - reserved)
              : max(0, model.limit.context - maxOutput)
free      = usable - total
band      = free <= usable * 0.05 ? "error"
         : free <= usable * 0.15 ? "warning"
         : "ok"
```

This is the trigger point for automatic compaction
(`packages/opencode/src/session/prompt.ts:1160-1167`) and is the number this
panel exists to surface: opencode has no UI for it anywhere.

Dialog keys, registered as a keymap layer scoped to `mode: "modal"` so they only
fire while the dialog is open:

| Key | Action |
|---|---|
| `esc` | close (host-bound; also clears on backdrop click) |
| `r` | `usage.refresh` — refetch quota data, existing command |
| `tab` | cycle provider scope: all → each provider in turn |
| `j` | toggle the raw JSON view of both sections |

The `usage_report` tool keeps its `provider` / `json` / `refresh` arguments
unchanged.

## 9. System-prompt capture

### 9.1 Write (server plugin)

`experimental.chat.system.transform` fires once per request with the fully joined
system string (`packages/opencode/src/session/llm/request.ts:58-73`): agent or
provider base prompt, environment block, instruction files, MCP instructions,
skills listing, and any per-message `user.system`.

The hook measures `system.length` and `estimateTokens(system)` and writes

```
<data-home>/usage-report/context/<sessionID>.json
```

Throttled to at most one write per 60 s per session, and forced on
`providerID`/`modelID` change. Writes are atomic (temp file + `rename`) and every
failure is swallowed — the hook must never be able to break a request.

### 9.2 Read and validate (TUI plugin)

A capture is used only when **all** hold; otherwise the residual path in §6.4
applies and `systemDerived` is `true`:

- file parses as JSON and `version === 1`
- `sessionID` matches
- `providerID` and `modelID` match the reference assistant message
- `capturedAt >= ` the reference assistant message's `time.created`
- `systemTokens` is a finite non-negative number

### 9.3 Degradation is mandatory

`experimental.*` hooks are undocumented and can change without notice. The capture
path is therefore never load-bearing: if the hook stops firing, the sidecar goes
stale, the schema drifts, or the file is corrupt, the panel still renders with
`derived` in place of the sub-breakdown. A test asserts the fallback with a
sidecar that is valid JSON but wrong-version, wrong-model, and corrupt.

## 10. Error handling

| Condition | Behavior |
|---|---|
| No assistant message with usage | `ready: false`; hollow grid, `0 (0.0%)`, "awaiting first response" |
| `model.limit.context` missing | grid omitted; rows show counts, percentages `null` |
| No model resolved for the message | header shows the raw `providerID/modelID` |
| Sidecar unusable | residual path, row labelled `derived` (D7) |
| `messages` / `part` return malformed entries | skipped; never throws |
| `state.output` is a non-string | coerced with `String(...)`, then estimated |
| Quota API failure | unchanged — existing `error` row in the quota block |

`api.ui.dialog.setSize("xlarge")` must be called **before** `replace()`, because
`replace()` resets the size to `medium` and collapses the stack to depth 1.

## 11. Testing

`npm test` (vitest, no network). All new logic is in pure modules, so no OpenTUI
or renderer mocking is required. The dialog JSX itself is untested, matching
`src/tui.tsx` today; all formatting is pushed into `format.ts` precisely so that
the rendered output stays testable.

`collect.ts`
- empty session; session with no assistant message; `ready` transitions correctly
- six-row split sums to `total`; percentages never exceed 100
- `tokens.input` treated as cache-exclusive (cache tokens counted once)
- parts before the last `summary` assistant message are excluded
- tool parts with `state.time.compacted` excluded and counted in `prunedToolOutputs`
- `step-start` / `step-finish` / `snapshot` ignored
- residual clamped at 0 when estimates overshoot
- proportional normalization when `estimatedSum > total`; rows sum to at most
  `total` and largest-remainder rounding holds
- normalization is a no-op when `estimatedSum <= total`
- missing `limit.context` → percentages `null`, `grid` empty
- non-string `state.output`, missing `state`, `null` entries → no throw, no `NaN`

`headroom.ts`
- `limit.input` present vs absent branches
- `compaction.reserved` override beats the `min(20000, maxOutput)` default
- band thresholds at exactly 5% and 15%
- `usable` clamped at 0

`grid.ts`
- cell count equals `cols * rows`; fill values within `[0, 1]`
- fill order matches category order; a partial cell appears at the total boundary
- cumulative fill never exceeds `total` even with inflated row values
- `cols` clamped at both ends; zero/negative width falls back to the minimum

`system.ts`
- write→read round trip
- atomic write leaves no partial file
- invalid JSON, wrong version, wrong session, wrong model, stale `capturedAt`,
  non-finite `systemTokens` → all rejected
- `OPENCODE_DATA_HOME` override honoured

`format.ts`
- header line format for populated and empty states
- legend rows in fixed order with correct labels and percentages
- `derived` marker present only when `systemDerived`

`quota-lines.ts`
- existing `buildLines` cases ported unchanged from the current coverage

## 12. Tasks

1. `context/types.ts`, `context/estimate.ts` + tests
2. `context/headroom.ts` + tests
3. `context/grid.ts` + tests
4. `context/collect.ts` + tests
5. `context/format.ts` + tests
6. `context/system.ts` (sidecar io) + tests
7. `quota-lines.ts` extraction (pure, no behavior change)
8. `context/dialog.tsx` + `tui.tsx` wiring (`/usage` command, modal keymap layer)
9. `index.ts`: delete `cfg.command.usage`, add the capture hook
10. README + version bump; `npm test` and `npm run typecheck` green

## 13. References

- `packages/tui/src/keymap.tsx:49-51,260-289` — slash command registration
- `packages/tui/src/component/prompt/autocomplete.tsx:109-113` — modal key handling
- `packages/tui/src/component/prompt/index.tsx:264-282,1665-1671` — native usage line
- `packages/tui/src/feature-plugins/sidebar/context.tsx:28-35` — native Context block
- `packages/opencode/src/session/session.ts:338-377` — token normalization
- `packages/opencode/src/session/overflow.ts:8-33` — compaction headroom
- `packages/opencode/src/session/llm/request.ts:58-73` — system prompt assembly
- `packages/opencode/src/session/message-v2.ts:525` — `filterCompacted`
- `packages/core/src/util/token.ts:3-5` — the `chars/4` estimator
