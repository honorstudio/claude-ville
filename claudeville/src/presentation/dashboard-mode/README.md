# Dashboard Mode

Dashboard mode is the compact DOM row view for scanning active sessions without the Canvas world. It is owned by `DashboardRenderer.js` and uses the same domain `World` data as World mode.

Desktop-only constraint: validate at browser widths of 1280px or wider. Do not add narrow-viewport behavior, mobile breakpoints, or responsive shrinking in this area.

## Responsibilities

| File | Responsibility |
| --- | --- |
| `DashboardRenderer.js` | Project grouping, card creation/reuse, active-mode detail polling, card click selection, and tool-history rendering. |
| `AvatarCanvas.js` | Small per-agent canvas avatar used inside dashboard cards, plus the Activity Panel's larger hero niche. Characters whose manifest entry carries `portraitCrop` (an authored head-and-shoulders crop of the composed south idle frame) or a generated `portrait` bust render as that portrait; every character without portrait metadata keeps the full-body avatar, and a 26×32 full-body witness stays beside the name whenever a portrait is shown so held weapons and effort crowns are not erased by the crop. Avatars can request the exact composited bitmap the World draws from `character-mode/Compositor.shared()` instead of re-loading raw sheet frames. |

## Lifecycle

- `App.js` constructs `DashboardRenderer` after World mode is initialized.
- `ModeManager` emits `mode:changed`.
- `DashboardRenderer` sets `active = true` only for `dashboard`.
- Detail polling starts when Dashboard mode becomes active and stops when leaving Dashboard mode.
- `agent:added`, `agent:updated`, and `agent:removed` trigger re-render only while Dashboard mode is active.

## Rendering Contract

The renderer groups agents by `agent.projectPath || '_unknown'`, creates one section per project, and reuses existing section/card DOM nodes across updates. After each render it removes cards and sections no longer represented in `world.agents`.

Rows show status and elapsed time, agent and CLI/model identity, tool context, blockers, working files, usage, and child progress. Status has its own complete line; empty secondary values use a quiet dash. Only the selected row expands its detail.

Expanded detail shows:

- Agent avatar, name, role, provider badge, and model label.
- Normalized status (`active` becomes `working`).
- Current tool name/input, recent message, and fetched tool history.
- Model visual identity from `shared/ModelVisualIdentity.js`.
- Detail-fetch lifecycle states: a `data-loading` skeleton until the first detail result, an explicit "Session details unavailable" error when a fetch pass returns nothing and no history is cached, and a STALE badge when rendered detail data is older than the `SessionDetailsService` cache TTL.
- A hover-revealed copy button in the header copies the agent/session id to the clipboard and confirms via the shared `Toast` service (passed in by `App.js`).

Clicking a row emits `agent:selected`, the same event used by the sidebar and World mode. Dashboard expands detail inline and keeps the right Activity Panel hidden. Escape deselects the row.

## Keyboard Navigation

- Dashboard cards use roving focus: `Tab` enters the card collection once, and arrow keys move through cards in their current visual order.
- `Enter` or `Space` activates the focused card through its native button behavior. `Escape` emits `agent:deselected`, matching World mode.
- `A` uses the application-wide attention command and moves focus to the selected card. A standalone renderer falls back to the same longest-waiting, rotating order.
- Card focus and agent selection are separate. Cross-mode `agent:selected` events update the next Tab target without stealing focus; only an explicit Dashboard keyboard command moves focus.
- DOM card reuse preserves focus across status reordering. If the focused agent disappears, focus moves to the next card at that position, or the previous final card.
- The primary card button's gold `:focus-visible` outline in `dashboard.css` is the visible pixel/RPG focus treatment.

## Session Details

Dashboard detail fetches flow through `shared/SessionDetailsService.js`, not direct `fetch()` calls. Dashboard uses `fetchSessionDetailsBatch()` and the server's `POST /api/session-details` route for its active-card refresh path; singular detail fetches remain available for one-agent surfaces such as the Activity Panel. The service dedupes in-flight requests, caches fresh responses briefly, serves stale data while a background refresh is running, and times out slow fetches.

Tool inputs and messages use native keyboard-accessible disclosures. Unchanged disclosure nodes are reused across refreshes to preserve expansion, focus, and text selection. Cached detail displays its observation age; unavailable and partial usage stay distinct from observed zero. The DOM tool and district emblems use shared pixel SVGs, and avatar fitting preserves aspect ratio.

Use `SESSION_DETAIL_REFRESH_INTERVAL` from `src/config/constants.js` for Dashboard polling cadence. The candidate policy fetches only the selected agent; unselected rows use the live session payload. There is no card-visibility observer or layout scan. Do not add another independent timer without considering the Activity Panel and adapter-registry caches.

## Validation

After Dashboard changes:

1. Run `npm run verify:render` and retain its screenshots and console diagnostics.
2. On the operator-maintained `http://localhost:4000`, switch to Dashboard mode.
3. Confirm project sections, card click selection, and tool history render correctly.
4. Switch back to World mode and confirm detail polling stops causing visible updates or console noise.
