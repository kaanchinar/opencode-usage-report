# Contributing

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

### Running from source

Point the configs at the source instead of the published package. Config is read once at startup and is not hot-reloaded, so restart opencode after every edit:

```jsonc
// opencode.json
{ "plugin": ["file:///abs/path/to/opencode-usage-report/src/index.ts"] }
// tui.json
{ "plugin": ["file:///abs/path/to/opencode-usage-report/src/tui.tsx"] }
```

## Adding a provider

1. Implement `ProviderAdapter` (`src/types.ts`): an `id`, `displayName`, and `fetch(cred, opts)` returning `{ windows, extras? }`.
2. Register it in the `adapters` array in `src/providers/index.ts`.
3. Add fixture-driven tests under `test/`.

Existing adapters use these endpoints:

- Kimi Code (global): `https://api.kimi.ai/coding/v1/usages`
- Kimi Code (China): `https://api.kimi.com/coding/v1/usages`
- OpenCode Go: `https://opencode.ai/zen/go/v1/usage` (requires a custom `User-Agent`)
- GitHub Copilot: `https://api.github.com/copilot_internal/user`
- ChatGPT: `https://chatgpt.com/backend-api/wham/usage`

Candidate endpoints for future adapters:

- Gemini: `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` (requires Google OAuth)
- Claude: `api.anthropic.com/api/oauth/usage` (requires `anthropic-beta: oauth-2025-04-20`, the claude-code User-Agent, and `~/.claude/.credentials.json`)

## Internals

**Warnings.** On startup and on `session.idle`, throttled to once every 10 minutes on a shared timer, the plugin checks the cached reports. A window at or above `thresholdPercent`, or with status `rate-limited` or `frozen`, produces a TUI toast. A warning fires once per window until that window resets, and re-arms after usage drops below `thresholdPercent - 10`. Toast failures in headless or server mode are swallowed.

**System prompt size.** opencode assembles the system prompt and tool definitions on every request and never persists them. The server plugin measures the system string through the undocumented `experimental.chat.system.transform` hook and stores only its size in `<data-home>/usage-report/context/<sessionID>.json`. If the hook stops firing, the sidecar goes stale, or validation fails, the panel falls back to the derived residual and labels the row `(derived)`. The plugin never breaks a request over it.

**Compaction headroom.** `Auto-compacts at N` mirrors opencode's own overflow check, including the configured `compaction.reserved` buffer.

**OpenCode 2.x.** The server entrypoint exports `{ id, setup, server }` and the TUI entrypoint exports `{ id, setup, tui }`. V2 calls `setup` and V1 calls `server` or `tui`. On V2 the TUI's `keymap.layer` runs from a headless `app`-slot component.

## Releasing

Releases are staged, not published directly. Pushing a `v*` tag triggers `.github/workflows/publish.yml`, which verifies that the tag matches `package.json`, runs `npm ci`, and uploads the tarball with `npm stage publish --provenance --access public` using npm Trusted Publishing (OIDC, no `NPM_TOKEN` secret). Nothing goes live until a maintainer approves the staged release with 2FA:

```sh
git tag v0.4.1 && git push origin main v0.4.1
npm stage list                    # find the stage id
npm stage approve <stage-id>      # 2FA prompt; or approve in the npm UI
```

`prepublishOnly` runs lint, format check, typecheck and tests before the upload, so a failing check blocks the stage.
