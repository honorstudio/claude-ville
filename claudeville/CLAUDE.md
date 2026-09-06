# ClaudeVille Agent Notes

## Scope and Shape

Work from the repository root. This shared checkout may be edited by multiple agents: run `git status --short` before changes, preserve unrelated edits, and follow the root [`AGENTS.md`](../AGENTS.md).

ClaudeVille is static HTML/CSS with vanilla ES modules. `server.js` uses Node built-ins only; there is no build step, bundler, transpiler, framework, or runtime dependency. The desktop-only UI targets viewports at least 1280px wide. Start the maintained server with `npm run dev`; do not change its port casually.

## Server

`server.js` binds `127.0.0.1:4000`. Local Host and same-origin checks guard HTTP and WebSocket access. Static files come from `claudeville/`; watch paths come from active provider adapters. Filesystem updates debounce alongside a two-second poll, and broadcasts no-op when there are no WebSocket clients.

Main surfaces are `/api/sessions`, `/api/session-detail`, `POST /api/session-details`, `POST /api/ingest/hook`, `/api/teams`, `/api/tasks`, `/api/providers`, `/api/usage`, `/api/perf`, `/api/changelog`, and `/ws`. The app fetches `/api/providers` during boot. `/api/tasks` and `/api/perf` are diagnostic/external-integration surfaces; the product UI does not consume `/api/tasks`.

Client session collection runs through `collectSessionsForClients()`, which folds unresolved `tool_pending` residents from `services/sessionResidency.js` into the live list. Completed turns use the shorter departed-villager grace. Discovery, canonical active projects, and watch topology remain on the raw `ACTIVE_THRESHOLD_MS` window so residency never widens the watcher footprint.

Cadence constants live in `src/config/constants.js`, `server.js`, `adapters/index.js`, and `adapters/gitEvents.js`. The client fallback poll is two seconds, server session-list cache TTL is 2000 ms, and WebSocket heartbeat is 30 seconds. Never lower the client poll below half the server cache TTL.

Hook ingestion payload schema and opt-in Claude Code dogfood instructions: see [`docs/troubleshooting.md#permission-prompts-are-inferred-or-arrive-late`](../docs/troubleshooting.md#permission-prompts-are-inferred-or-arrive-late).

## Provider Adapters

Adapters are read-only inputs registered by `adapters/index.js`. Availability is automatic, empty output is not necessarily an error, and adapter failures may use short stale caches. The normalized contract, provider source paths, watch behavior, token semantics, and per-provider fixtures live in [`adapters/README.md`](adapters/README.md).

## Model Registry

`src/config/models.json` is the source of truth for model identity, pricing, context window, and mood. `npm run models:generate` emits `models.generated.js` and `models.generated.cjs`; never edit either generated file. Rendering policy stays in `src/presentation/shared/ModelVisualIdentity.js`, keyed by `modelClass`. Use `npm run models:resolve -- <provider> <model>` to inspect a match and [`.claude/skills/add-model/SKILL.md`](../.claude/skills/add-model/SKILL.md) for the contributor workflow.

## Frontend Ownership

`src/presentation/App.js` owns startup. UI and documentation copy are English-only. Mode-specific behavior belongs with its nearest owner:

- [World renderer and selection lifecycle](src/presentation/character-mode/README.md)
- [Dashboard cards, lifecycle, and detail polling](src/presentation/dashboard-mode/README.md)
- [Shared chrome, Activity Panel, selection, and detail cache](src/presentation/shared/README.md)

The World canvas is pixel-art Canvas 2D. `Camera.js` uses integer zoom steps `{1,2,3}`; `SpriteRenderer.js` is the only sprite-blit entry point and disables smoothing. Motion-bearing changes must follow [`docs/motion-budget.md`](../docs/motion-budget.md).

The World's explicit operator instruments — READ (hold `B`), the `A` attention frame, AMBIENT CAM, and the panel's SCORE control — plus the frontier contracts (observation certainty, action strips, effect receipts, the inspection aperture, the shape grammar, Ambient ownership) are documented in [the World mode README](src/presentation/character-mode/README.md). Their pure models (`ObservationCertainty`, `BuildingApertureModel`, `BuildingInstrumentModel`, `WorkWaterfallModel`, `AttentionFraming`) are the single derivation of each fact; do not re-derive those fields inside components.

## Sprite Generation

`assets/sprites/manifest.yaml` is the sprite source of truth: every runtime sprite must have a manifest entry, every PNG must live at its manifest-implied path, character `generationSize` is distinct from the 92px engine cell, palette mirrors must remain identical, and `style.assetVersion` changes only when PNG bytes change. Optional per-character action strips are separate PNGs beside the sheet with named groups (`read`), generated through `scripts/sprites/generate-action-strip.mjs`; the base sheet is never widened and characters without a strip keep the procedural overlay. Follow [`scripts/sprites/generate.md`](../scripts/sprites/generate.md), including its canonical “Add One Character” procedure and validation commands.

## Event Bus

The singleton `src/domain/events/DomainEvent.js` exports `eventBus`; subscriptions are global with no replay or persistence. Major families include agent lifecycle/selection, attention, mode, usage/FPS, WebSocket state/messages, and village/director presentation signals. This list is intentionally partial: search emitters in `src/application/`, `src/presentation/`, and `src/infrastructure/WebSocketClient.js` before changing an event contract.

## Validation and Constraints

Use the canonical change-to-command table in [`AGENTS.md#validation`](../AGENTS.md#validation). For presentation work, automated screenshot and console evidence comes from `npm run verify:render`; visual judgment on the operator-maintained server remains manual.

Keep changes narrow. Do not mutate local CLI session files, introduce a frontend framework, or delete generated app artifacts unless explicitly asked. Re-run `git status --short` before handoff.
