# ClaudeVille

[![Version](https://img.shields.io/badge/version-v0.37.0-8a6f2a)](./CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.7-3c873a)](./package.json)
[![Runtime](https://img.shields.io/badge/runtime-zero--build-7c3aed)](#quick-start)
[![Local first](https://img.shields.io/badge/local--first-read--only-0f766e)](#local-and-read-only)
[![Providers](https://img.shields.io/badge/providers-7-f97316)](#supported-providers)

Watch your local AI coding CLIs work in a living pixel village.

ClaudeVille is a local-first dashboard for Claude Code, OpenAI Codex CLI, Google Gemini CLI, xAI Grok CLI, Kimi, OpenCode, and OMP (Oh My Pi) sessions. It reads provider logs read-only, normalizes them into one session model, and renders active agents as either an isometric RPG village or a dense monitoring dashboard.

![ClaudeVille World mode showing simulated AI coding agents in an isometric pixel village](./docs/assets/github/world-day.png)

- **Local and read-only:** no hosted service, no telemetry, no provider-file writes.
- **Multi-provider:** Claude Code, Codex CLI, Gemini CLI, Grok CLI, Kimi, OpenCode, and OMP.
- **Glanceable:** World mode for second-monitor awareness; Dashboard mode for exact state.
- **Zero-build runtime:** Node HTTP/WebSocket server plus static browser assets.

Current version: **v0.37.0**. See [CHANGELOG.md](./CHANGELOG.md) for named releases and user-facing changes.

Active development lives in this repository. It is currently a public fork of `honorstudio/claude-ville`, but `TokenBrice/claude-ville` is the maintained branch for the current multi-provider ClaudeVille work.

## Why ClaudeVille

ClaudeVille is a Claude Code dashboard, Codex CLI dashboard, and local AI agent observability tool built for the corner of your eye. It turns invisible local agent activity into a place you can leave open: agents move around the village by what they are doing, while Dashboard mode keeps token usage, cost, tools, status, and session detail available when you need exact state.

The app is intentionally small: a zero-dependency Node.js HTTP/WebSocket server, static browser assets, vanilla ES modules, and Canvas 2D rendering.

## Local And Read-Only

ClaudeVille binds only to the IPv4 loopback interface at `localhost:4000` and reads supported CLI session stores from your machine. It does not write provider session files, does not proxy requests to a hosted service, and does not need a build step to run.

Desktop browser viewports 1280px wide and larger are the supported target. Empty provider lists are normal on machines where no supported CLI has local session files yet.

## Supported Providers

| Provider | Local source |
| --- | --- |
| Claude Code | `~/.claude/` |
| Codex CLI | `~/.codex/sessions/` |
| Gemini CLI | `~/.gemini/tmp/` |
| Grok CLI | `~/.grok/sessions/` |
| Kimi | `~/.kimi/` and `~/.kimi-code/` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| OMP (Oh My Pi) | `~/.omp/agent/sessions/` |

## Screenshots

| World mode at night | Dashboard mode |
| --- | --- |
| ![ClaudeVille World mode at night with weather, lit buildings, and fixture agents](./docs/assets/github/world-night.png) | ![ClaudeVille Dashboard mode grouping simulated AI coding sessions by project](./docs/assets/github/dashboard.png) |

| Activity panel |
| --- |
| ![ClaudeVille activity panel showing selected fixture agent state, tool usage, and session detail](./docs/assets/github/activity-panel.png) |

## Quick Start

```bash
npm run dev
```

Open `http://localhost:4000`.

Runtime is dependency-free: `npm run dev` uses only Node built-ins and static browser files. The repo also has a `package-lock.json` and dev dependencies for sprite validation, visual diffs, and Playwright-based capture scripts; run `npm install` only when those development scripts are needed.

Common `package.json` scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start `claudeville/server.js` on port `4000`. |
| `npm run validate:quick` | Run the no-runtime syntax, adapter-fixture, git-event, unit-test, and sprite-ID checks. |
| `npm run test:unit` | Run the `node:test` cases in `scripts/tests/` (status derivation, session residency, chronicle, spend ledger). |
| `npm run check:server` / `check:adapters` / `check:services` / `check:frontend-syntax` / `check:scripts` | Targeted JavaScript syntax checks. |
| `npm run check:git-events` | Validate git-event parsing fixtures. |
| `npm run check:adapter-fixtures` | Validate adapter fixture behavior. |
| `npm run sprites:audit-ids` | Check renderer sprite references against the manifest. |
| `npm run sprites:audit-refresh` | Run sprite ID audit and full manifest validation together. |
| `npm run sprites:validate` | Validate `assets/sprites/manifest.yaml` against PNG files and character-sheet shape. Requires dev dependencies. |
| `npm run sprites:capture-baseline` | Capture baseline world screenshots for sprite visual diffing. Requires the dev server and Playwright. |
| `npm run sprites:capture-fresh` | Capture fresh screenshots next to the baseline set. Requires the dev server and Playwright. |
| `npm run sprites:visual-diff` | Compare baseline and fresh sprite screenshots with `pixelmatch`. Requires dev dependencies. |
| `npm run world:validate-buildings` | Validate building definitions, entrances, visit tiles, walk exclusions, and manifest references. |
| `npm run world:validate-terrain` | Validate terrain chunk/cache sizing guardrails. |

## Fast Onboarding Path

For an unfamiliar agent, read these first:

1. `README.md` for the app shape, commands, API surface, and docs map.
2. `AGENTS.md` or `CLAUDE.md` for repo workflow, shared-checkout rules, validation, and known pitfalls.
3. `claudeville/CLAUDE.md` for implementation-level architecture inside the app.
4. `docs/README.md` for the current task-oriented documentation map.
5. `agents/README.md` before using or adding retained agent artifacts.
6. The area README for the slice you are editing:
   - `claudeville/adapters/README.md` for provider parsing and normalized session contracts.
   - `claudeville/src/presentation/character-mode/README.md` for World mode.
   - `claudeville/src/presentation/dashboard-mode/README.md` for Dashboard mode.
   - `claudeville/src/presentation/shared/README.md` for shared UI and detail fetches.
   - `scripts/sprites/generate.md` for sprite generation and validation.

## Requirements

- Desktop browser at 1280px wide or larger. Mobile and narrow viewports are out of scope.
- Node.js 22.7 or newer (the browser modules are `.js` ES modules; Node needs unflagged module-syntax detection to run the checks and tests).
- `npm install` only for dev scripts that import packages (`js-yaml`, `pngjs`, `pixelmatch`, `playwright`). The server itself does not need installed packages.
- At least one local provider home directory:
  - Claude Code: `~/.claude/`
  - Codex CLI: `~/.codex/` (sessions are read from `~/.codex/sessions/`)
  - Gemini CLI: `~/.gemini/` (sessions are read from `~/.gemini/tmp/`)
  - Grok CLI: `~/.grok/` (sessions are read from `~/.grok/sessions/`)
  - Kimi: `~/.kimi/` or `~/.kimi-code/` (legacy sessions are read from `~/.kimi/sessions/`; Kimi Code sessions from `~/.kimi-code/sessions/`)
  - OpenCode: `~/.local/share/opencode/opencode.db` with Node `node:sqlite` support or the `sqlite3` CLI available for read-only access.
  - OMP (Oh My Pi): `~/.omp/` (sessions are read from `~/.omp/agent/sessions/`)

Empty provider lists are normal on machines where no supported CLI has local session files yet.

## Project Layout

```text
claude-ville/
|-- claudeville/
|   |-- server.js                  # Node HTTP server and hand-written WebSocket support
|   |-- index.html                 # Browser entrypoint
|   |-- adapters/                  # Provider-specific local session parsers
|   |   |-- claude.js
|   |   |-- codex.js
|   |   |-- gemini.js
|   |   |-- grok.js
|   |   |-- kimi.js
|   |   |-- opencode.js
|   |   |-- omp.js
|   |   |-- gitEvents.js            # Git commit/push extraction from tool commands
|   |   |-- turnState.js            # Transcript-derived turn state and pending-tool classification
|   |   |-- toolResults.js          # Bounded provider-reported command results (exit codes) for result shelves
|   |   `-- index.js               # Adapter registry
|   |-- assets/sprites/            # Pixel-art manifest and generated PNG assets
|   |-- services/
|   |   |-- usageQuota.js          # Usage, quota, and account metadata
|   |   `-- sessionResidency.js    # Holds finished/blocked sessions past the active window
|   |-- css/                       # Static CSS loaded directly by index.html
|   |-- vendor/                    # Browser-vendored helper libraries
|   `-- src/
|       |-- config/                # Constants, theme, i18n strings, building definitions
|       |-- domain/                # World, agents, buildings, tasks, events, value objects
|       |-- application/           # Agent, mode, session watcher, attention, chronicle, spend
|       |-- infrastructure/        # REST data source and WebSocket client
|       `-- presentation/          # Shared UI plus world and dashboard renderers
|-- scripts/sprites/               # Manifest validation, sprite generation docs, visual diff helpers
|-- scripts/tests/                 # node:test cases for the signal layer (npm run test:unit)
`-- package.json
```

## Runtime Architecture

`claudeville/server.js` binds to `127.0.0.1`, serves static files from `claudeville/`, exposes same-origin JSON API endpoints, upgrades WebSocket clients at `ws://localhost:4000/ws`, watches provider data paths, and broadcasts updates while clients are connected. Updates are debounced on filesystem events; a 2-second interval also runs unconditionally, with broadcasts becoming no-ops when no WebSocket clients are connected.

The frontend boot path is `claudeville/src/presentation/App.js`:

1. Domain: create `World` and add `BUILDING_DEFS` buildings.
2. Infrastructure: `ClaudeDataSource` and `WebSocketClient`.
3. Shared UI: `Toast`, `Modal`, `TopBar`, `Sidebar`.
4. Application services: `AgentManager`, `ModeManager`, `NotificationService`.
5. Load initial sessions and usage.
6. Start `SessionWatcher`.
7. Bind canvas `ResizeObserver`.
8. Dynamically load `IsometricRenderer` (World mode), then `DashboardRenderer`.
9. Create the right-side `ActivityPanel` and bind agent-follow.
10. Apply English UI strings.

The layout is a full-height flex shell: fixed-height top bar, left sidebar, central content area, and an optional 320px right activity panel. World mode fills the content area with a canvas. Dashboard mode scrolls vertically.

## Local Server API

The server is hardcoded to port `4000` and the IPv4 loopback interface. Requests with a non-local `Host` or a cross-origin browser `Origin` are rejected; origin-less local CLI requests remain supported.

| Endpoint | Description |
| --- | --- |
| `GET /api/sessions` | Active sessions from all available providers. Accepts `force=1`, `force=true`, or `force=yes` to bypass the session-list cache. |
| `GET /api/session-detail?sessionId=&project=&provider=` | Tool history, recent messages, token usage where available. |
| `POST /api/session-details` | Batch detail fetch for visible or selected sessions. Body shape: `{ "items": [{ "key", "sessionId", "project", "provider" }] }`; request body max is 256 KiB, the server reads up to 100 items, skips invalid providers, and returns `count` as the number of returned detail payloads. |
| `GET /api/teams` | Claude Code team metadata from `~/.claude/teams/`. |
| `GET /api/tasks` | Claude Code task groups from `~/.claude/tasks/`. |
| `GET /api/providers` | Detected provider list and home directories. |
| `GET /api/usage` | Usage, subscription, activity, and quota metadata. |
| `GET /api/perf` | Lightweight runtime counters for manual performance checks. |
| `GET /api/changelog` | Raw `CHANGELOG.md` text; rendered by the in-app version-chip modal. |
| `ws://localhost:4000/ws` | Same-origin initial session payload, update broadcasts, and ping/pong. |

The server does not enable CORS or accept preflight requests. Missing or invalid routes receive JSON error responses.

## Provider Adapters

Adapters live in `claudeville/adapters/` and are registered in `adapters/index.js`. Each adapter reports whether its local provider directory exists, returns active sessions, returns detail for one session, and provides watch paths for live updates.

| Provider | Directory | Session source | Notes |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/` | `history.jsonl`, `projects/*/*.jsonl`, subagent files, teams, tasks | Supports main sessions, subagents, orphan/team-member sessions, token usage, teams, tasks, and git commit/push extraction. |
| Codex CLI | `~/.codex/sessions/` | Recent `rollout-*.jsonl` files under date folders | Reads recent rollouts, session metadata, tools, messages, token count events, reasoning effort, and git commit/push extraction. |
| Gemini CLI | `~/.gemini/tmp/` | `tmp/<project_hash>/chats/session-*.json` | Reads recent chat JSON files, attempts to reverse-map project hashes to local paths, and extracts git commit/push events where commands are present. |
| Grok CLI | `~/.grok/sessions/` | `<url-encoded-cwd>/<session-id>/{summary.json,updates.jsonl,chat_history.jsonl}` | Reads summary metadata (model, title, effort, activity), ACP update streams for tools/messages/context occupancy, chat history fallback, and git commit/push events from shell tools. Session ids are prefixed `grok-`. |
| Kimi | `~/.kimi/`, `~/.kimi-code/` | Legacy `sessions/<project_hash>/<session_uuid>/wire.jsonl`; Kimi Code `sessions/<workspace>/<session_uuid>/agents/<agent>/wire.jsonl` plus `session_index.jsonl` | Reads tool/message/status events, resolves projects from legacy hashes or the Kimi Code index, extracts token usage, surfaces Kimi Code child agents, and extracts git commit/push events. |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite session/message/part rows | Opens the database read-only via `node:sqlite` or `sqlite3 -readonly`, preserves OpenCode as the provider, exposes model families such as DeepSeek through `model`, and extracts git commit/push events from shell tools. |
| OMP (Oh My Pi) | `~/.omp/agent/sessions/` | `<project>/<session>.jsonl` plus nested agent JSONL files | Reads parent and nested agent transcripts, model/provider metadata, tool history, messages, and aggregated response usage, surfacing underlying model families such as z.AI GLM through `model` and `underlyingProvider`. |

Only active adapters are used. Claude-only concepts such as teams and tasks are optional and return empty arrays when unavailable.

`claudeville/adapters/index.js` owns aggregation and short-lived caches: session lists are cached for 2000 ms and detail payloads for 5000 ms to protect the 2-second scheduler, detail payloads have an LRU-style trim, and adapter failures degrade to an empty or stale cached detail response instead of breaking the app.

## UI Modes

### World Mode

World mode is the current RPG visual direction. It renders an isometric pixel village on Canvas 2D with terrain, roads, a small pond, buildings, particles, a minimap, and agent sprites. Current buildings (source of truth: `claudeville/src/config/buildings.js`):

- Command Center: team status.
- Task Board: task status.
- Code Forge: code work.
- Token Mine: token usage.
- Grand Lore Archive: reading and search.
- Research Observatory: external research.
- Portal Gate: browser and remote tools.
- Pharos Lighthouse: GitHub and deploy sea watch.
- Harbor Master: commit ships and push departures.

Agents can be selected on the canvas. Selection opens the activity panel and makes the camera follow the selected sprite until the selection clears or the user drags the camera. Agents using `SendMessage` can move toward a matched recipient and show chat animation state.

The village also carries explicit operator instruments: hold **B** (or the READ button) to swap routine nameplates for work verbs; press **A** to frame every agent needing attention (with an exact count when some fall outside the frame); AMBIENT CAM hands the frame to a patient, factual broadcast that any input revokes until asked for again; and selecting a building at close zoom opens its interior as a truthful seat list whose identities and counts match the panel. Beside the Mine, an assay bench states exact input and cache-read token counts for the last minute — counts, never percentages — and the Forge keeps workload billets and a result shelf that stamps only provider-reported command outcomes.

Rendering is sprite-first. `IsometricRenderer.js` orchestrates the draw loop and data flow; `SceneryEngine.js`, `TerrainTileset.js`, `BuildingSprite.js`, `HarborTraffic.js`, `AgentSprite.js`, `SpriteRenderer.js`, `Compositor.js`, `SpriteSheet.js`, and `AssetManager.js` do the specialized work.

### Dashboard Mode

Dashboard mode renders DOM cards grouped by project. Cards show provider badge, model, role, status, current tool, recent message, and fetched tool history. Dashboard mode is designed for scanning active sessions without the RPG world.

`DashboardRenderer.js` fetches session details only while Dashboard mode is active, reuses project sections/cards across updates, and emits the same selection events as the sidebar/canvas. It shares `SessionDetailsService.js` with the activity panel so duplicate detail requests can be coalesced and briefly cached.

## Validation

Default non-runtime validation:

```bash
npm run validate:quick
```

Targeted syntax smoke:

```bash
npm run check:server
npm run check:adapters
npm run check:services
npm run check:frontend-syntax
npm run check:scripts
```

`scripts/smoke/` also has hand-run fixture checks for specific high-risk paths:

```bash
node scripts/smoke/adapters.mjs
NODE_NO_WARNINGS=1 node scripts/smoke/relationship.mjs
```

These smoke scripts are not part of `npm run validate:quick`.

Runtime smoke:

```bash
npm run dev
curl http://localhost:4000/api/providers
curl http://localhost:4000/api/sessions
```

For rendering changes, open `http://localhost:4000`, test both World and Dashboard modes, resize the browser, and verify the activity panel opens and closes when an agent can be selected.

Asset validation, when dev dependencies are installed:

```bash
npm run sprites:validate
npm run sprites:capture-fresh
npm run sprites:visual-diff
```

If dependencies are not installed and installing them is out of scope, fall back to manifest/code inspection plus `file claudeville/assets/sprites/**/*.png` checks for touched assets.

## Development Notes

- Keep provider session files read-only. ClaudeVille observes local CLI logs; it should not mutate them.
- Keep port `4000` unless all dependent docs and local workflows are updated together.
- `DEBUG_STATIC=1` logs static file requests; `DEBUG_WATCH=1` logs watch-path refresh details.
- Keep small changes within the current vanilla JavaScript and CSS architecture. There is no framework, bundler, transpiler, or app test runner today.
- Do not edit generated sprite PNGs without also checking `claudeville/assets/sprites/manifest.yaml` and the sprite validation rules.
- This repo is often edited by multiple agents. Check `git status --short` before changes and preserve unrelated local edits.
- See `docs/visual-experience-crafting.md` for the transferable design method behind the RPG world model.

## Contributing And Support

Good public contribution lanes are provider adapter fixes, redacted fixtures, docs fixes, and focused UI or visual quality improvements. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

For setup and troubleshooting, start with [SUPPORT.md](./SUPPORT.md) and [docs/troubleshooting.md](./docs/troubleshooting.md). Please do not report vulnerabilities or exposed private data in public issues; use [SECURITY.md](./SECURITY.md).

## Docs Map

| File | Audience | Purpose |
| --- | --- | --- |
| `README.md` | Everyone | Project overview, quick start, runtime architecture. |
| `PRODUCT.md` | Product/design work | Product purpose, users, positioning, brand personality, and design principles. |
| `DESIGN.md` | Visual/UI work | DOM chrome design system, palette, typography, components, and anti-references. |
| `CHANGELOG.md` | Everyone | Named release history shown in-app from the version chip. |
| `CONTRIBUTING.md` | Contributors | Contribution lanes, setup, validation, and pull request expectations. |
| `SECURITY.md` | Security reporters | Private vulnerability reporting policy and scope. |
| `SUPPORT.md` | Users and contributors | Where to start for setup, provider, and visual support. |
| `CODE_OF_CONDUCT.md` | Contributors | Collaboration expectations and enforcement scope. |
| `AGENTS.md` | Codex CLI and any generic agent harness | Canonical agent-context file: harness map, `/agents/` artifact convention, project shape, conventions, validation, git hygiene. |
| `CLAUDE.md` | Claude Code | Byte-for-byte mirror of `AGENTS.md` (after the heading) so Claude Code's auto-loader sees the same content. `AGENTS.md` is canonical — when changing one, change both and run the parity diff in either file's Validation Checklist. |
| `docs/README.md` | Everyone | Current documentation index and task routing. |
| `claudeville/CLAUDE.md` | Agents working inside `claudeville/` | Implementation context: server, adapters, layout, event flow. |
| `claudeville/adapters/README.md` | Adapter work | Provider contract, normalized session fields, token and git-event extraction. |
| `claudeville/src/presentation/character-mode/README.md` | World mode work | Canvas renderer pipeline, selection lifecycle, sprite/world contracts. |
| `claudeville/src/presentation/dashboard-mode/README.md` | Dashboard work | DOM renderer lifecycle, detail polling, selection contract. |
| `claudeville/src/presentation/shared/README.md` | Shared UI work | Top bar/sidebar/activity panel, model identity, session-detail cache. |
| `docs/agent-provider-addition.md` | Provider/model work | End-to-end runbook for adding providers, models, and agent visual identities. |
| `docs/design-decisions.md` | Maintainers | Load-bearing constraints and what to update if one changes. |
| `docs/troubleshooting.md` | Operators and agents | Common first-hour failures and diagnosis paths. |
| `docs/motion-budget.md` | World mode work | Motion, pulse-band, and reduced-motion policy. |
| `docs/world-visual-qa-checklist.md` | World mode work | Deterministic scene and asset-refresh QA checklist. |
| `docs/visual-experience-crafting.md` | Visual/UX work | Transferable design method behind the RPG world model. |
| `agents/README.md` | Agents | Current artifact policy and retained artifact index. |
| `scripts/sprites/generate.md` | Sprite work | Manifest-first PixelLab generation and asset validation runbook. |
| `docs/pixellab-reference.md` | Sprite work | PixelLab tool catalog, parameter enums, animation templates, async lifecycle, and pitfalls. |

## License

[MIT](./LICENSE)
