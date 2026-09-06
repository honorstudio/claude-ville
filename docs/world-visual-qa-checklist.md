# World Visual QA Checklist

Use the maintained local server at `http://localhost:4000`.
World scenarios are deterministic fixtures for `?sim=1&scenario=<id>`.

## Frozen Renderer Baselines

- Read [`rendering-baselines.md`](rendering-baselines.md) before renderer, trail, PostFX, atmosphere, or material changes.
- Run `npm run world:capture-render-baselines -- --dry-run` after changing the capture matrix.
- Capture the affected manifest IDs in `webgl`, `postfx`, and `canvas` modes. Do not compare a forced-FULL PostFX source frame with an adaptive performance level without reporting both values.
- Every performance claim must include Chromium build, GPU/driver, OS, machine label, viewport, DPR, browser zoom, and power state from the capture metadata.
- Review and approve the clear-day, torchlit-night, and action-needed storm north-star frames before broad material or asset production.
- Use `npm run world:benchmark-trails` after trail, camera, or cache changes; manual pan, follow, and director glide must produce zero historical trail-cache repaints.

## Baseline

- `no-agents`: map loads with stable building labels, idle harbor, no empty-state errors, and no console errors.
- `one-working-agent`: selected worker has readable name, current tool, route/trail, and completion state.
- `mixed-tools`: read, edit, bash, web, plan-mode, chat, retry, and subagent cues remain distinct without visual noise.

## Crowd And Relationships

- `dense-24-agents`: at least 20 agents remain selectable; dense labels do not cover building labels or each other excessively.
- `dense-100-agents`: stress scenario for label, trail, drawable-culling, and terrain-cache readability at high agent counts.
- `team-gather`: team members cluster around intended Command/Task Board areas with readable chat pairing.
- `parent-subagents`: parent/child agents are visually distinguishable; completed child cleanup leaves no stale label or marker.
- `building-inspection-replay`: Command building opens selected, replay is active, and selected-building route lines are more prominent than hover previews.

## Harbor And Git

- `git-harbor`: commit, push, fetch, and pull fixture events are available for harbor reducer and ship checks.
- `failed-push`: failed/rejected push state is visible at the harbor/watchtower and does not look like a successful departure.
- `release-parade`: harbor release ribbons and parade label appear from scenario metadata without requiring a real tag push.
- Harbor labels, dock tiles, ships, wakes, and building labels remain readable at desktop viewport widths.

## Director Incidents And Signals

- `waiting-on-user`: Command-side amber wait state appears as an input/attention scene and remains inspectable in the Activity Panel.
- `quota-rate-limit`: mine-side quota/rate-limit pressure creates a Director incident, building Signal rows, and a subtle work-weather nudge.
- Building hover should show a light signal/route preview; clicking the building should promote that to the full selected-building route treatment and Signal panel.
- Press `R` in any World scenario to toggle the last-minute replay badge and trails; `building-inspection-replay` starts with replay already enabled.

## Occlusion And Selection

- `selected-behind-building`: selected agent remains discoverable when partially hidden by a split building sprite.
- Selection ring, label, route/trail, and detail panel state agree after select/deselect.
- World to Dashboard toggle preserves agent identity and does not leave stale selected-agent visuals.

## Building Ground Integration

- Run `npm run world:validate-buildings` and confirm all nine types have valid grounding profiles.
- Run `npm run sprites:capture-baseline` and `npm run sprites:capture-fresh`; every named day/night closeup must assert its target near frame center before `npm run sprites:visual-diff`.
- Press `Shift+D`: cyan is the logical footprint, white is the sprite anchor/world center, magenta is the sprite canvas, yellow is `horizonY`, red is structural contact/shadow extent, and green is the entrance-to-contact line.
- At zoom 1 and 2, no land building shows a continuous raised lawn/stone perimeter or a renderer pad outside its site.
- Roads meet the physical threshold, stairs, rails, or posts. Terrain texture remains visible between sparse apron marks and reaches structure footings.
- Shadows begin under structural mass, not at the footprint edge. Harbor uses piling/water contacts; Lighthouse keeps a supported quay; Portal keeps a stair-connected dais.
- Hover and active-state marks communicate state without creating a platform at rest. Check idle and `mixed-tools`/active scenarios.
- Verify a selected agent both behind and in front of each split sprite after any `structureMask`, anchor, or `horizonY` change.
- Review clear day, fixed night, and reduced motion at integer zoom 1, 2, and 3 on a desktop viewport at least 1280px wide.

## Atmosphere And Motion

- Clear day: landmarks, terrain, roads, water edges, bridges, and docks have clear contrast.
- Night: building lights, lighthouse, water reflections, and labels stay legible without washing out agents.
- Fog/rain/storm: weather communicates state while preserving selected-agent, harbor, and building readability.
- `storm-night-reduced-motion`: reduced-motion metadata disables or freezes nonessential motion while keeping semantic state visible.

## Frontier Instruments

- Hold `B` (or the READ button): occupied-building plaques show work verbs from the canonical classifier (`FORGE` reads `WRITING · 8`); the verb counts must equal the working count in the top bar; release restores names without moving the camera or changing selection.
- Press `A`: every action-needed agent is framed or the overlay states the exact excluded count (`N waiting outside view`); no waiting agent is silently omitted. In `waiting-on-user` after `A`, speech rectangles for non-selected agents are absent and every primary mark is present.
- AMBIENT CAM: in `dense-24-agents` it produces at most one move per 20–30 s hold and returns to the same wide; a wheel event stops it and the control enters its resume state; Auto behaviour is unchanged. Reduced motion holds one static overview with the same counts.
- SCORE (Activity Panel, selected agent with recorded rows): nodes land at semantic building anchors, long approvals read as brackets, unknown time reads as gaps; scrubbing changes no domain state; at most 24 nodes with an exact overflow count; reduced motion offers no PLAY.
- Select Command at zoom 2 and 3: the interior aperture opens with the same identities and counts as the building panel; at zoom 1 it does not; closing restores the exterior immediately; `dense-100-agents` shows at most the seat count plus an exact overflow.
- Night (`midnight-oil`): the selected building lights exactly one room per working occupant and leaving work extinguishes only that room; `2 working · 1 waiting` states both facts.
- Mine (`cache-ore`): the assay bench states exact input and cache-read counts for the last 60 s — no percentage anywhere; a provenance flip resets coverage visibly.
- Forge (`mixed-tools`): billets scale with fixture edit calls (`N edit calls · last 60s`); the result shelf stamps intact `exit 0`, cracked non-zero exits, and nothing without a provider-reported outcome; a Codex fixture with `toolExitCode: 1` cracks, a Claude fixture (no exit data) shows none.
- Shared-file knot: two fixture agents writing one path show one thread, the double-pencil knot, and panel bench tiles naming the overlap; 100 agents draw no pairwise lines.
- Empty village (`no-agents` at noon): canonical `READY_EMPTY` shows the banked Forge ember and no work effects; degraded-provider fixtures keep the degraded treatment, not rest.
- Atmosphere: dusk/night frames must read cores-first (window cores before spill, halo never outgrowing the work); at hour 1, a full-moon and a new-moon date differ by one reviewed night course and both keep the waiting beacon as the brightest pool; rain shows source-coloured wet reflections under admitted lights only, contracting as rain stops.
- Shift-D on the resident GPU world: the shed list names each effect and mode, pass timings report for `upload`, `occlusion`, `scene`, `bloom`, `present` after `renderer.gpuWorld.setPassSamplingEnabled(true)`, and texture bytes split pinned/evictable.
- Top bar witness clock matches the forced hour and shows `FIXED`/`SIM` when overridden; the Sidebar exception shelf shows exact `N NEED YOU · N ERROR · N QUOTA` counts, the two oldest names, and hides at zero.

## Terrain Cache Scalability

- Run `npm run world:validate-terrain` and confirm the terrain cache plan reports chunk coverage for the current `MAP_SIZE`.
- Run `npm run world:validate-buildings` after building layout or visit-tile changes.
- In the debug overlay or console diagnostics, confirm terrain cache strategy is `single-surface` for the current 40x40 map. Console diagnostics are exposed at `window.__claudeVillePerf.canvasBudget().terrainCache`.
- Before increasing `MAP_SIZE`, confirm the single-surface estimate remains under the world cache budget or implement chunked terrain caches first.
- `MAP_SIZE` remains fixed at 40 for the semantic-diorama program. Package 0 measures a 6,560,000-pixel single-surface estimate against the 7,000,000-pixel reserve (440,000 pixels / about 6.3% remaining) with a 3x3 chunk plan; re-record the validator output when this changes.

## Sprite Refresh Audit

- Run `npm run sprites:audit-refresh` before any provider, building, ship, terrain, or atmosphere sprite refresh.
- Do not regenerate or replace sprite image assets until manifest ID audit and manifest validation are clean.
- Record contact-sheet or visual-diff evidence for any broad sprite refresh before merging asset changes.

## Regression Notes

- Check browser console after each scene.
- Keep viewport desktop-only, at least 1280px wide.
- Record any scene ID, viewport size, and observed failure with enough detail to reproduce.
