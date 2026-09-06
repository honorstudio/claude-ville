# World Mode Renderer

World mode is the resident WebGL2 isometric view that ClaudeVille shows by default, with Canvas 2D fallback. This directory owns the render loop, sprites, camera, and particles. It reads from the domain `World` and listens to the event bus; it never mutates domain state.

The directory is named `character-mode/` for historical reasons. In prose, the user-facing surface is "World mode" (paired with "Dashboard mode" under `../dashboard-mode/`).

## File ownership

| File | Responsibility |
| --- | --- |
| `IsometricRenderer.js` | Render loop (`requestAnimationFrame`), terrain/water/road generation, hit testing, click and hover handlers, event-bus subscriptions, and selection plumbing. |
| `Camera.js` | Pan, zoom, `centerOnMap`, `followAgent` / `stopFollow`, `screenToWorld` / `worldToScreen` projections. |
| `CanvasBudget.js` | Effective DPR selection and backing-store guardrails for large desktop canvases. |
| `AgentSprite.js` | Per-agent sprite state: tile position, smoothed motion, selection ring, chat animation toward a target sprite, hit testing in world coordinates. |
| `AgentBehaviorState.js` | Per-agent behavior and destination state used by movement/visit systems. |
| `VisitIntentManager.js`, `VisitTileAllocator.js` | Building capacity, visit reservations, and destination assignment. |
| `BuildingSprite.js` | Current building visuals, sprite blits, hover state, building-specific decoration/effects, occlusion split for hero buildings, and `hitTest` in world coordinates. |
| `TaskboardBoardModel.js` | Pure selected/pinned agent resolution plus phase-aware TodoWrite grouping, truthful full-list progress layouts for the inset slate chalk face at every zoom level. |
| `BuildingVisualRegistry.js` | Data-driven building visual profiles for labels, sprites, lights, emitter anchors, overlays, and split-pass rules. |
| `NightOccupancyGate.js` | Pure night-window phase, live working-status, and reduced-motion-aware transition policy shared by Canvas and GPU building light paths. |
| `AssetManager.js` | Loads `manifest.yaml` and `palettes.yaml`, maps manifest IDs to PNG paths, cache-busts with `style.assetVersion`, and supplies placeholder/checker fallbacks. Material companions and deterministic atlases are opt-in and never use the checker fallback. |
| `MaterialRegistry.js` | Stable material classes, authored upper-left key-light convention, safe channel defaults, companion-path rules, and semantic material normalization. |
| `SpriteRenderer.js` | Single entry point for PNG sprite blits; keeps pixel-art draws snapped and smoothing disabled. Also builds additive sprite-quad records and can draw optional companion channels for debugging. |
| `SpriteSheet.js` | Character sheet frame lookup and 8-direction velocity mapping. Character sheets are 8 columns × 10 rows of 92px cells. |
| `Compositor.js` | Palette-swap and accessory overlay composition. |
| `TerrainTileset.js` | Wang-tile neighbor masks and isometric tile transforms. |
| `SceneryEngine.js` | Water, shore, bridges, vegetation, boulders, and walkability data. |
| `Pathfinder.js` | Grid pathfinding over the walkability map. |
| `AtmosphereState.js`, `SkyRenderer.js`, `WeatherRenderer.js` | Time/weather snapshots, sky rendering, and foreground weather effects. |
| `LightSourceRegistry.js` | Shared light-source records consumed by world grading and effects. |
| `HarborTraffic.js` | Harbor/ship motion and git-event-aware harbor activity. |
| `BridgeLanterns.js` | Age-ordered pending-branch lantern plan, plank drawables, hover copy, and night light sources. |
| `LandmarkActivity.js` | Harbor/landmark event extraction and activity state updates tied to git-event streams. |
| `AgentEventStream.js` | Shared observer that derives tool, subagent, team, and chat semantic events from `agent:*` updates. |
| `RelationshipState.js` | Debounced relationship snapshot for parent/child, team, arrival/departure, and chat-pair consumers. |
| `ArrivalDeparture.js`, `TrailRenderer.js` | Relationship arrival/departure cues and movement trails. |
| `Chronicler.js`, `ChronicleEvents.js`, `ChronicleMonuments.js` | Chronicle event capture and monument rendering. |
| `CouncilRing.js` | Team/council ring visuals around related agents, plus the gather roll call: on a real `team:gather` one notch lands at each gathered member's feet on the council cue's successive bells (`shared/audio/CueScore`), and a static `team · N` mark states the whole membership on the final one. One ceremony at a time, held 8s, drawn in the upper overlay; reduced motion and a silent village draw every mark at once. |
| `PulsePolicy.js` | Shared pulse-priority parser and defaults. |
| `ObservationCertainty.js` | Pure resolver turning provider freshness/`signalStale`/residency into `{ state, observedAt, ageMs }`. Stale observation suppresses new ritual motion and earns the last-observed seal; it never becomes an execution status. |
| `DebugOverlay.js` | Shift-D debug overlay for renderer diagnostics; Shift-P pathfinding overlay (planned-path breadcrumbs and glowing destination tiles). Both off by default. |
| `RitualConductor.js` | Capped, reduced-motion-aware scheduler for tool ritual visuals: building rituals plus per-agent reading/typing/thinking pose records consumed by `AgentSprite`. |
| `ParticleSystem.js` | Particle emitters and ambient effects. Honors `prefers-reduced-motion`. |
| `postfx/PostFx.js` | WebGL2 post-processing stage: samples the finished 2D scene as a texture and applies the atmosphere grade, light glows, bloom, water displacement, god rays, heat haze, incident pulses, and grain. Owns context loss, timings, and diagnostics. |
| `postfx/PostFxLadder.js` | Pure hysteretic degradation ladder (FULL → REDUCED → MINIMAL → DISABLED). It sheds optional effects only; the direct GPU world holds a minimal resident scene at DISABLED so Canvas-only water/fauna layers cannot flicker through during recovery. Unit-tested in `scripts/tests/postfx-ladder.test.mjs`. |
| `postfx/PostFxFeed.js` | Allocation-light per-frame uniform feed: screen-space light list, quarter-res water mask (camera-pose cached, revision-counted), sun anchor, haze anchors, incident pulse envelope, motion state. |

## Data sources and draw order

World mode is driven by four source layers:

- Domain state from `World` (`agents` and `buildings`).
- Static config from `src/config/constants.js`, `buildings.js`, `townPlan.js`, `scenery.js`, and `theme.js`.
- Sprite metadata from `claudeville/assets/sprites/manifest.yaml` and `palettes.yaml`.
- Runtime provider state already normalized into `Agent` objects, including `gitEvents` for harbor activity.

The render loop keeps the scene readable by drawing in broad layers:

1. Background washes, water, terrain cache, roads, shore, bridges, and flat features.
2. Static props and scenery sorted by world Y where they can overlap agents.
3. Building bases and occlusion-aware hero building pieces.
4. Agents, selection/status overlays, chat motion, and current-tool effects.
5. Building labels/bubbles, particles, and atmospheric overlays.

World mode renders through a three-canvas stack inside `#characterMode`: `#worldCanvas` (the 2D scene, source of truth and mouse target), `#worldFxCanvas` (WebGL2 post-process output, hidden whenever inactive), and `#worldOverlayCanvas` (2D UI: weather foreground, primary marks, labels, bubbles, screen particles, letterbox, debug — never graded or distorted). Grading ownership is exclusive: when the post stage is active the 2D multiply grade and glow/lantern stamps are skipped and the GPU reproduces them from the same `atmosphere.grade` inputs; when inactive (`?postfx=0`, no WebGL2, context loss, or ladder level 3) the 2D path draws exactly as before. Shift-D shows post-FX level and timings. Resident WebGL replays only functional building marks and occupancy pennants on the upper Canvas in drawable depth order; authored manifest layers and atmospheric building reactions remain owned by the GPU path.

Ground semantic cues (Director routes/replay/halos, relationship rings/tethers, crowd auras, and short selected/action routes) share a ground draw function. In resident WebGL they enter the terrain-first GPU record stream through one retained Canvas texture capped at 1024 pixels on its longest edge. It is absent without cues, invalidated by camera/semantic/position changes, and reuses static reduced-motion frames; ornament-only changes advance at 8 Hz. Buildings and bodies occlude this texture. Talk arcs, counts, handoffs, lifecycle annotations, and selected x-ray silhouettes draw once on the upper Canvas in all backends. Primary beacons remain readable above the atmosphere; the resident selection footprint stays on the ground.

Canvas, GPU, and camera hit projections share backing-pixel-snapped translation while logical pan and zoom stay continuous. Building plaques use the sprite's manifest anchor with screen-space gap and bounded collision displacement; their leaders terminate at the owning sprite top. Under crowd pressure ordinary GPU bodies are capped at 28 world pixels; selected, hovered, waiting, errored, and rate-limited agents retain full silhouettes. Dense groups reuse the existing crowd count badges, retaining one routine name per group plus all primary names. Automatic establishing and idle focus zoom is capped at 1.5; explicit detail zoom remains available. Mass arrivals of 24 or more bypass newcomer name protection; selection through the existing Sidebar, Dashboard, or keyboard agent cycling reveals an individual immediately.

The foliage pilot reuses existing oak, pine, and willow pixel sprites at cached 1× and 2× sizes, cropping their lower plinth rows. At most six sprite caches are retained. Civic foliage accents are reduced to leave quieter ground around work areas. The material pilot uses exact palette overrides only for Terra, Sonnet, and Command; albedo and emission stay unchanged. Command separates stone roof, crimson fabric, and foliage, while shared door/masonry colors stay stone. This is a small authored pilot, not a roster rollout.

Agent atlas slots normally refresh at 125 ms. A measured fast-turn sequence exposed a stale selected Codex body while attachments advanced; selected, hovered, action-needed, direction-changing, and tool-changing slots now refresh immediately. Other dirty animation slots retain the ambient cadence. GPU surface animation and foliage consume the public `motionTimeMs` visual clock. Existing zero-height character geometry masks remain flat; the renderer now honors their authored value instead of manufacturing anatomical height from a default floor.

When adding a visual feature, place it in the lowest layer that still communicates the state. Avoid adding per-frame work when it can be cached into terrain or static scenery.

## Depth drawable contract

World mode overlap rendering goes through `DrawablePass.js`. New overlap-aware visual systems should adapt their items to this shape before entering the shared sorted pass:

```js
{
  kind: '<stable-category>',
  sortY: <finite-world-y>,
  sortBand: <optional-order-band>,
  stableKey: '<optional-deterministic-key>',
  salience: 'primary' | 'recent' | 'working' | 'ambient',
  materialId: '<stable-material-source>',
  materialClass: '<known-class>',
  elevation: { base: 0, top: 0, unit: 'sprite-px' },
  emissive: { strength: 0, sources: [] },
  occluder: { mode: 'alpha-silhouette', strength: 1 },
  atlasFrame: null,
  drawFallback(ctx, zoom, context) {},
  buildGpuRecord(context) {},
  hitArea: null, // optional future hit-test metadata
  payload: <source-object>
}
```

`kind` should be stable enough for diagnostics and narrow special cases such as the selected-agent x-ray pass. Ordering is `sortY`, then `sortBand`, then `kind`, then `stableKey`, then insertion sequence. `createDepthDrawable()` assigns default bands for building backs, props, harbor traffic, agents, landmark activity, chronicle visuals, familiar motes, and building fronts; set `sortBand` only when a new category needs deterministic interleaving. Normalize missing or non-finite `sortY` before sorting. The legacy `draw()` property remains an alias of `drawFallback()`, so Canvas output is unchanged. `buildGpuRecordsFromDrawables()` converts the already-sorted stream and adds `drawOrder`; consumers may batch only consecutive compatible records. Avoid adding new manual draw switches in `WorldFrameRenderer.js` when an adapter in `DrawablePass.js` can preserve the existing behavior. Use `cullDepthSortedDrawables()` for large drawable sets that can be skipped outside the camera viewport.

Material metadata is optional. Missing values normalize to unlit albedo, zero emissive contribution, a flat alpha-silhouette occluder, and no atlas frame. See [`../../../../docs/material-channel-contract.md`](../../../../docs/material-channel-contract.md) for manifest fields, stable material indices, atlas frame tags, channel encoding, and tooling.

`WorldFrameRenderer.js` still reaches into renderer private helpers for terrain, atmosphere, debug, labels, and post-processing. Treat that as a follow-up for layer extraction, not a reason to broaden a drawable-only change.

## Selection lifecycle

```
canvas click (IsometricRenderer._onClick)
  → camera.screenToWorld(x, y)
  → IsometricRenderer._handleClick(worldX, worldY)
      hit-test agentSprites
      ├── hit  → sprite.selected = true
      │         camera.followAgent(sprite)
      │         onAgentSelect(agent) → App.js emits 'agent:selected'
      │
      └── miss → camera.stopFollow()
                 onAgentSelect(null)
                 App.js does not emit 'agent:deselected' for this path,
                 so the ActivityPanel stays open until its close button
                 or the selected agent is removed.

eventBus 'agent:selected' (also emitted from Sidebar / DashboardRenderer)
  → App.js _bindAgentFollow → renderer.selectAgentById(agent.id)
  → ActivityPanel.show(agent), starts 2s detail polling

ActivityPanel close button or eventBus 'agent:removed' for current agent
  → ActivityPanel.hide() → eventBus.emit('agent:deselected')
  → App.js → renderer.selectAgentById(null) → camera.stopFollow()
```

`onAgentSelect` is wired in `App.js` after the renderer is created. The renderer keeps a single `selectedAgent` reference; clearing it deselects every sprite and stops camera follow.

## Map constants

From `src/config/constants.js`:

| Constant | Value | Used by |
| --- | --- | --- |
| `TILE_WIDTH` | `64` | iso projection in `Camera.js`, every tile draw. |
| `TILE_HEIGHT` | `32` | iso projection (half of width — standard 2:1 iso). |
| `MAP_SIZE` | `40` | square tile grid; terrain seed is `MAP_SIZE * MAP_SIZE`. |

The grid is `40 × 40` tiles. World-space origin is `(0, 0)` at the top corner of the diamond; tile `(x, y)` projects to screen `((x − y) · 32, (x + y) · 16)` before camera offset and zoom.

## Event-bus integration

`IsometricRenderer.show()` subscribes to domain events and stashes the unsubscribe functions in `_unsubscribers` for teardown:

| Event | Effect on the renderer |
| --- | --- |
| `agent:added` | `_addAgentSprite(agent)` creates an `AgentSprite` and inserts it into `agentSprites`. |
| `agent:removed` | Drops the entry from `agentSprites`. |
| `agent:updated` | Replaces `sprite.agent` so the sprite reads the latest status, tool, model. |

Selection events (`agent:selected`, `agent:deselected`) are bridged in `App.js`, not subscribed here directly. The renderer exposes `selectAgentById(id)` for that bridge to call.

`mode:changed` is consumed by `IsometricRenderer` to call `setWorldModeActive(mode !== 'dashboard')`. When Dashboard mode is active, the World render loop stops and volatile renderer caches are released; when World mode becomes active again, dirty sprite state is reconciled and the loop restarts. Browser visibility and canvas context loss/restoration also pause, resume, and rebuild canvas-owned caches.

`VillageDirector` emits `village:director`, `village:building-signal`, `village:scene`, and `village:replay` as read-only presentation signals. Canvas overlays use the snapshot for huddles, handoffs, incidents, replay trails, release parades, building hover previews, and selected-building route lines; DOM surfaces such as Activity Panel may consume the same events defensively.

Deterministic QA scenarios for these states are available at `?sim=1&scenario=<id>`; the most relevant Director fixtures are `waiting-on-user`, `quota-rate-limit`, `failed-push`, `release-parade`, and `building-inspection-replay`.

## Adding a building

1. Add an entry to `BUILDING_DEFS` in `claudeville/src/config/buildings.js`. Copy a neighboring entry for the validated field shape:

   ```js
   {
     type: '<id>',
     x: <tileX>,
     y: <tileY>,
     width: <w>,
     height: <h>,
     label: '<UPPER CASE>',
     shortLabel: '<SHORT>',
     icon: '<glyph>',
     description: '<short>',
     district: '<district>',
     capacity: { work: <n>, ambient: <n>, overflow: <n> },
     visualTier: 'hero' | 'major' | 'minor',
     labelPriority: 'landmark' | 'standard' | 'low',
     entrance: { tileX: <tileX>, tileY: <tileY> },
     visitTiles: [workSlot(...), queueSlot(...), scenicSlot(...)],
     walkExclusion: [{ dx: <n>, dy: <n>, width: <n>, height: <n> }],
   }
   ```

   The local `workSlot`, `queueSlot`, and `scenicSlot` helpers create the visit-tile metadata expected by movement and occupancy systems. Tile coordinates must keep the footprint `(x..x+width-1, y..y+height-1)`, entrance, visit tiles, and walk exclusions within `0..MAP_SIZE-1` and not overlap water or another building footprint.

2. Add or reuse a `BuildingVisualRegistry.js` profile for label treatment, sprite IDs, decoration, emitters, lights, overlay anchors, and split-pass behavior. Keep procedural fallbacks in `BuildingSprite.js` narrow.

3. (Optional) If the building needs hover/click behavior beyond the default tooltip, subscribe in `IsometricRenderer.js` near the existing `_onMouseMoveMain` / `_onClick` handlers, or extend `BuildingSprite.hitTest`.

4. Run `npm run world:validate-buildings` and `npm run world:validate-terrain`, then reload the page. There is no build step; `App.js` adds buildings from `BUILDING_DEFS` on every boot.

Future building visual cleanup should expand the existing `BuildingVisualRegistry.js` coverage before adding custom procedural drawing. Good candidates are label accents/emblems, light sources, emitter specs, overlay anchors, and split-pass rules. Keep custom renderers behind named functions so adding a building usually changes config data rather than several distant `type` branches.

## Performance baselines and trail policy

Renderer comparisons use the manifest and runbook in [`../../../../docs/rendering-baselines.md`](../../../../docs/rendering-baselines.md). The matrix records WebGL, flattened PostFX, and allocation-free Canvas outputs from the same deterministic scene declaration, along with hardware, frame, upload/shader, resource-byte, and overlay-census evidence.

Persisted movement history is retained for diagnostics and replay but routine historical trails are not painted over the village. The selected agent and action-needed agents may draw only a short, bounded recent route. `TrailRenderer.getDiagnostics()` reports the active policy, confirms zero ambient cache ownership, and retains stationary/manual-pan/follow/director-glide timing buckets. Run `npm run world:benchmark-trails` after changing trails or camera invalidation.

Shift-D reports PostFX source upload, mask upload, setup CPU, shader CPU/GPU, ladder decision/degradation reason, named GPU resource bytes, mask rebuild causes, and trail camera-mode timing.

For World presentation changes, run `npm run verify:render` to capture deterministic screenshots and console evidence, then review the changed behavior on the operator-maintained server. Browser judgment remains manual; evidence capture does not.

## Frame and update notes

- The render loop is plain `requestAnimationFrame`; one update tick per frame, no fixed timestep.
- Water shimmer advances from the shared visual elapsed clock and freezes when reduced motion is preferred. GPU water and wet-surface patterns use world coordinates, so camera movement does not drag the pattern across the surface.
- The terrain is precomputed into `terrainSeed` and a `terrainCache` canvas; only water/agents/effects redraw per frame. Adding terrain variation should extend the cache, not the per-frame path.
- Event-bus subscriptions (`agent:added`, `agent:updated`, `agent:removed`) are stored in `_unsubscribers` and torn down in `hide()`. New subscriptions in this directory should follow the same pattern to avoid leaks across mode toggles.
- `ParticleSystem.setMotionEnabled(false)` is set when `(prefers-reduced-motion: reduce)` matches; respect this when adding new effects.
- New motion-bearing features must follow [`../../../../docs/motion-budget.md`](../../../../docs/motion-budget.md): check `motionScale` before allocating animation resources, declare a pulse band, and ship a static reduced-motion fallback.
- Use `PulsePolicy.js` helpers such as `pulseValue()` and `pulseAlpha()` before adding another repeating sine cadence. Local pulse math should be justified by a feature-specific need and still honor reduced-motion fallback values.
