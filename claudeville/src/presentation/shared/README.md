# Shared Presentation Components

This directory contains UI components used by both World and Dashboard mode. Components communicate through the global `eventBus` and should avoid importing renderer-specific modules.

Desktop-only constraint: shared UI only needs to support browser widths of 1280px or wider. Keep validation and layout decisions scoped to desktop; do not add mobile breakpoints or responsive shrinking here.

## File Map

| File | Responsibility |
| --- | --- |
| `TopBar.js` | Global stats, clock, account/quota usage display, and agent/usage event summaries. Mode button lookup and clicks belong to `application/ModeManager.js`. |
| `AmbientAudioController.js` | Opt-in sound facade: toggle button, AMBIENT/BGM mode button, volume slider, user-gesture unlock, tab-hidden suspend, localStorage persistence. Routes to the ambient `AudioDirector` or the continuous-music `BgmDirector` per the persisted mode. Debug helper: `window.__claudevilleAudio()`. |
| `audio/` | Two sound systems over one `AudioEngine` (context + mix chain + duck). Ambient: `AudioDirector` (1 Hz world→layer mapping, cue routing; listens to `atmosphere:updated`, `village:scene`, `distress:watchtower`, `team:gather`, `chronicle:aurora`, `weather:storm-flash`) driving `layers/` (wind, rain, birds, crickets, village hum, tonal bed, songbook music composer). BGM: `BgmDirector` + `bgm/BgmPlayer` playing `bgm/BgmSongbook` — five original town themes in seamless gap-free loops with a time-of-day playlist, no ambience layers. Shared: `cues/CueKit` + `CueGovernor` (rate-limited one-shots), `MusicalScale` (tonal center). Deliberate exception to the no-renderer-imports rule: both directors import the pure, dependency-free `character-mode/AtmosphereState` (and ambient also `SeasonalAmbience`) so sound keeps tracking time/weather while the World loop is stopped. |
| `Sidebar.js` | Project-grouped agent list, selection mirror/toggle, persisted collapsed state, and Harbor pending-commit ledger from `harbor:updated`. |
| `ActivityPanel.js` | Right-side 320px detail panel with selected-agent and selected-building modes. |
| `AgentSelection.js` | Shared selection event helpers and local selected-agent mirrors for presentation components. |
| `AgentPresentation.js` | Shared identity/status presentation, pixel SVG emblems, freshness/provenance labels, and reusable native text disclosures. |
| `EventShapes.js` | Authored 16×16 event/district silhouettes shared by Canvas stamps (`drawEventShape`) and DOM icons (`eventShapeSvgPath`). One silhouette per event family; no family shares a shape. |
| `DomSafe.js` | DOM construction/replacement helpers used by App, Dashboard, Sidebar, Activity Panel, and presentation helpers. |
| `Formatters.js` | Status, path, number, cost, hash, and truncation formatting helpers. |
| `GitEventIdentity.js` | Shared git event labeling and identity helpers for harbor/git flows. |
| `SessionDetailsService.js` | Shared `/api/session-detail` and `/api/session-details` fetch dedupe, cache, stale fallback, and timeout handling. |
| `ModelVisualIdentity.js` | Provider/model/effort labels, sprite IDs, palette keys, colors, and effort accessories. |
| `RepoColor.js` | Deterministic project/repository color assignment. |
| `TeamColor.js` | Deterministic team color assignment. |
| `Modal.js` | Shared modal primitive. |
| `Toast.js` | Shared toast primitive. |

## Event Ownership

- Emit `agent:selected` and `agent:deselected` through `AgentSelection.js` helpers so future event-shape changes stay centralized.
- `agent:selected` can be emitted by World mode, Dashboard cards, or Sidebar rows.
- In World mode, `ActivityPanel` opens on `agent:selected`, refreshes its selected agent on matching `agent:updated`, and hides when that agent is removed. Dashboard keeps this panel hidden and expands selected detail inline.
- `BUILDING_EVENTS.SELECTED` opens Activity Panel building mode, shows building purpose/status/occupants, polls occupants every 5 seconds, and emits `agent:deselected` when building selection overrides an agent selection.
- `BUILDING_EVENTS.DESELECTED` clears building mode when the currently shown building is deselected.
- `ActivityPanel.hide()` emits `agent:deselected`; `App.js` bridges that event back to World mode so camera follow stops.
- Empty world clicks clear renderer selection/follow but do not close the panel. The panel remains open until its close button or selected-agent removal.
- `usage:updated` feeds shared status surfaces such as `TopBar`. `TopBar` consumes App’s canonical `village:state`; it does not separately reduce WebSocket/watcher events. Simulator state reads `SIMULATED`. Null World FPS hides the renderer health value while genuine numeric zero remains visible as an error.

## Session Detail Fetching

Use `sessionDetailsService.fetchSessionDetail(agent)` for one-agent surfaces or `sessionDetailsService.fetchSessionDetailsBatch(agents)` for card grids that need tools/messages/tokens. Do not add direct `/api/session-detail` or `/api/session-details` fetches in components.

Activity Panel and Dashboard expose complete available message/tool text through native disclosures, preserve unchanged DOM across refresh, and show cache/server observation age when stale. Provider truncation flags remain visible. Empty successful activity sections collapse; loading and unavailable states remain explicit. Usage and cost distinguish unavailable, partial, and observed zero, and the spend headline discloses incomplete active-session coverage.

Service behavior:

- Cache key: `provider::project::sessionId`.
- Fresh cache TTL: 5000ms.
- Stale cache TTL: 15000ms while a background refresh is started.
- Max entries: 128.
- Fetch timeout: 4000ms.
- Failed fetches return stale cached data when possible, otherwise `null`.

The server adapter registry also has short detail caches. Keep client polling intervals longer than the cache windows unless there is a clear reason to increase backend load.

## Model Visual Identity

`ModelVisualIdentity.js` combines canonical registry identity with rendering policy to produce user-facing labels, colors, sprite IDs, palette keys, and effort accessories. World mode, Dashboard mode, and Activity Panel should all use this module instead of duplicating model parsing.

Model identity, pricing, context window, and mood live in `../../config/models.json`; run `npm run models:generate` and never edit `models.generated.js` or `models.generated.cjs`. Effort equipment and accessories remain here, keyed by `modelClass`. When adding a model-specific sprite, update the registry and sprite manifest, then verify:

1. Dashboard card label/color.
2. Activity panel label/color.
3. World mode sprite selection and palette/accessory composition.

## Validation

After shared component changes, run `npm run verify:render` for screenshot and console evidence, then judge both modes on the operator-maintained server because these components sit across mode boundaries:

1. Select an agent from World mode, Dashboard mode, and Sidebar if available.
2. Close the Activity Panel and confirm World mode follow clears.
3. Select a building in World mode and confirm the panel switches to building purpose/status/occupants, then returns cleanly to agent detail.
4. Switch modes while the panel is open.
5. Confirm `/api/session-detail` and `/api/session-details` requests are not duplicated aggressively in the browser network panel.
