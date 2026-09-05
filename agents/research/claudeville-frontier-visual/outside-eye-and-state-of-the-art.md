# Outside eye and state of the art

## Territory and method

Product direction, visual taste, and the useful boundary of contemporary browser rendering. My north star is **a place that becomes an instrument when you look closely**, not an instrument that becomes a game when you look away. Research only; no runtime code, assets, tests, gates, formatting, or maintained-server lifecycle operations were changed or run.

Read: `README.md:1-180`; `PRODUCT.md:1-50`; `DESIGN.md:1-160`; `CHANGELOG.md:1-200`; `AGENTS.md`; `claudeville/CLAUDE.md`; `agents/README.md`; `docs/design-decisions.md`; `docs/visual-experience-crafting.md`; `docs/world-visual-qa-checklist.md:1-86`; `docs/rendering-baselines.md:53-112`; `docs/building-style-contract.md:1-45`; `docs/material-channel-contract.md:7-47,109-132`; `docs/motion-budget.md`; the character-mode, dashboard-mode and shared presentation READMEs; `agents/plans/claudeville-fable-5.1-enhancement-implementation-plan.md:19-65,453-470`; `agents/claudeville-astra-refinement-plan.md:30-62,166-225`; `agents/plans/open-followups.md` OF-007/008 entries. Code evidence below comes from the three files in `character-mode/gpu/`, `postfx/PostFx.js`, `Agent.js`, `VillageDirector.js`, `WorldFrameRenderer.js`, `BuildingSprite.js`, `ActivityPanel.js`, `ModeManager.js`, and `services/workingSet.js`.

Captured the maintained server read-only, Chromium/ANGLE Metal on Apple M5 Pro, 1920×1080, device scale factor 1. Every capture returned the real Metal renderer string and no console errors. The host was shared with concurrent explorers; this is visual evidence, **not a clean-host performance benchmark**. Initial helper diagnostics returned null hour/quality through incorrect accessors, so I do not infer quality from those nulls. Explicit hour overrides produced visibly day/night frames. Reviewed the full images and their unresized source-image crops in a read-only browser, not only thumbnails.

| Capture path | Setup and observation |
|---|---|
| `agents/research/claudeville-frontier-visual/shots/outside-eye-and-state-of-the-art-01.jpg` | `dense-24-agents`, hour 21, clear, 15 s wait. Busy night district; warm Command and Lighthouse dominate blue roofs and water. |
| `agents/research/claudeville-frontier-visual/shots/outside-eye-and-state-of-the-art-02.jpg` | `no-agents`, hour 12, clear, 15 s. Beautiful unoccupied diorama; a product-version parade still appears on Harbor. |
| `agents/research/claudeville-frontier-visual/shots/outside-eye-and-state-of-the-art-03.jpg` | `release-parade`, hour 18, clear, 15 s. Selected Banneret beside the harbor, large three-times view, `PARADE V0.12.0`. |
| `agents/research/claudeville-frontier-visual/shots/outside-eye-and-state-of-the-art-04.jpg` | `--live`, 15 s. Sixteen actual agents, real research utterances, actual checklist chalk. The strongest product frame. |
| `agents/research/claudeville-frontier-visual/shots/outside-eye-and-state-of-the-art-05.jpg` | Initial `mixed-tools --mode dashboard`, 12 s. The original helper called nonexistent `setMode`; this is actually World and is retained as an explicitly invalid dashboard attempt. |
| `agents/research/claudeville-frontier-visual/shots/outside-eye-and-state-of-the-art-06.jpg` | Same setup plus actual `modeManager.switchMode('dashboard')`, 12 s. Valid dashboard; sparse six-row ledger. |
| `agents/research/claudeville-frontier-visual/shots/outside-eye-and-state-of-the-art-07.jpg` | Repeated with coordinator-corrected helper, `mixed-tools --mode dashboard`, 12 s. Confirmed Dashboard button/surface. Retained GPU diagnostic level 2, `healthy-probe`, is not a Dashboard frame-cost measurement. |

The mode mismatch was established against `ModeManager.js:19-23` and reported to the coordinator, who corrected the shared helper. Shots 06 and 07 satisfy the requested Dashboard surface; 05 does not.

Also inspected all eight supplied reference captures under `agents/research/claudeville-fable-5.1-review/shots/`: `30-empty-world.jpg` (duplicated empty cards), `03-live-dashboard.jpg` (old card layout), `02-live-agent-selected-panel.jpg` (Portal/Mine closeup), `20-sim24-canvas-night.jpg` (black canvas, unsuitable as an art baseline), `97-gpu-night-zoom3.jpg` (Command detail), `90-gpu-noon.jpg` (whole village), `80-gpu-metal-night.jpg` (warm forge), and `92-gpu-night.jpg` (cooler night overview). These are historical comparison images, not evidence of current defects.

## Current state

### The outside verdict

**Single strongest frame: shot 04, the live village.** A small research team is visibly doing this very review. Silver knights gather around the Mine; someone is reading the craft contract; the actual plan is chalked on a board. This is the gasp that no generic renderer demo can buy. At native scale, the waterfall, slate roof planes, willow clusters, and narrow torchlit gate give the scene real handmade dignity. Its weakness is also obvious: speech labels occupy nearly every interesting patch. The reader must decode a paragraph cloud before seeing the work distribution. Source: shot 04.

**Single weakest frame: shot 07, Dashboard.** This is not because it should be prettier than World. It is because six large, equally framed rows repeatedly announce empty BLOCKER, WORKING SET and CHILDREN slots while most of the screen is vacant; the only visible portrait is tiny. The World Controls hint is still above this non-world surface. The layout is now much more orderly than historical `03-live-dashboard.jpg`, but it loses the magical connection between a character and a job. Source: shots 06/07 and that historical capture. Among current World shots, 03 is weakest compositionally: the enormous selected villager reads almost as tall as the building, the sign is cropped toward the right panel, and `PARADE` is a label rather than a compelling account of what shipped. This is a frame judgment, not a claim that the complete animation is absent.

Shot 01 has the most theatrical light, but the large Lighthouse halo is the first thing noticed, ahead of twenty-four workers. Shot 02 reveals lovely structural art and a strangely busy empty village: luminous Forge, gulls, repeated waterside props, version parade. The vacant sea is useful negative space, yet the oblique outer edge reads like a cut-out board rather than a natural coast. I would preserve that honest diorama identity rather than hide it behind another distant skyline. Sources: shots 01/02; the prior distant-shore cut is recorded at `CHANGELOG.md:188-189`.

### What already exists — do not commission it again

- Working-night occupancy, cache ore, branch-age lanterns, phase-aware chalk and GPU landmark rituals shipped together (`CHANGELOG.md:9-14,24-34`). The material/foliage pilot and stable camera treatment are also shipped (`character-mode/README.md:68-72`), not frontier proposals.
- The world already has a last-minute replay and per-building signals: `VillageDirector.js:206-218,308-347`. The ground path already draws replay/director cues, council rings and family/advisor/ally tethers: `WorldFrameRenderer.js:764-805`. A generic “add relationships” or “add replay” pitch would be redundant.
- Exact work state is available: `Agent.js:123-156` carries current/last tool, git events, prompt, todos, branch, pending reason/times, signal provenance/freshness, working set and collisions. Status duration has existing state-specific precedence (`Agent.js:202-220`).
- The Activity Panel already derives a twenty-minute waterfall from tools, permissions and children, with exact/inferred duration labels and explicit stall intervals (`ActivityPanel.js:131-133,241-319,418-469`). The missing frontier is spatial comprehension, not another duration parser.
- Default World is resident WebGL2 with Canvas fallback (`character-mode/README.md:3`). The GPU scene shader has albedo/material/emissive/occluder inputs, 32 light slots, three occlusion samples per admitted light, authored-height handling, two restrained material-wide sun bands, world-anchored water courses and light reflections (`GpuWorldRenderer.js:107-128,134-151,176-202,233-291`). This is already a capable 2.5D lighting system, not a blank Canvas toy.
- Batching preserves consecutive compatible records (`GpuWorldPolicy.js:230-274`). Channels have frame-local/padded geometry and authored emission semantics (`material-channel-contract.md:109-131`); inferring emission from bright albedo is explicitly rejected in the scene shader (`GpuWorldRenderer.js:242-251`).
- PostFx already implements pixel-quantized displacement, water/haze limits, optional coarse god rays, incident channel offsets and grain (`PostFx.js:78-123,171-227`). PostFx is not synonymous with the resident GPU path; putting a feature only there does not deliver it to the default World.
- Current parity intentionally omits decorative cliff reflection/waterline and the directional Lighthouse beam from resident GPU (`rendering-baselines.md:81-87`). Do not claim those are already identical in both paths, and do not confuse optional ornament parity with lost operational state.

### 2025–2026 technique survey: shipped practice versus research frontier

Evidence dates matter. HD-2D releases, contemporary GLSL demos and a 2025 GI paper are genuinely current; normal maps, palette cycling, camera snapping and instancing are mature techniques still applicable in 2026, not inventions of the last year. The survey did **not** establish a new 2025–2026 shipping browser game for every technique. No recommendation below depends on pretending otherwise. Cost comparisons from other machines are not ClaudeVille measurements.

**1. HD-2D-style sprite lighting.** Dragon Quest I & II HD-2D is a concrete 2025 shipping reference: https://na.store.square-enix-games.com/dragon-quest-i-_-ii-hd2d-remake ; the May 2025 hands-on specifically describes lanterns, sunlight and restrained depth of field: https://www.rpgfan.com/2025/05/27/dragon-quest-i-ii-hd-2d-remake-hands-on/ . Transfer the separation of crisp subject, warm inhabited aperture and cool surrounding mass, not its 3D engine. ClaudeVille can achieve this additively with existing height/emission channels and selective light admission (`GpuWorldRenderer.js:233-286`). **Stepped-palette fit: conditional**—do not copy HDR glare, smooth relighting or blurred heroes. Strong art-direction fit, little justification for a new rendering architecture.

**2. Normal-mapped pixel lighting.** Shipping authoring tools already support it; SpriteIlluminator explains RGB normal directions and explicitly distinguishes WebGL from pure Canvas: https://www.codeandweb.com/spriteilluminator . It is technically feasible to add a normal sampler, but ClaudeVille's packed material and geometry channels contain classes/heights, not normals (`material-channel-contract.md:113-124`). Generated normals would inflate capes and masonry like rubber, and every animation frame/accessory would need coherent authoring. **Stepped-palette fit: no by default, conditional only after directional quantization and ramp lookup.** Reject full normal-map rollout; retain existing authored key. This is an art/asset liability, not a browser capability problem.

**3. Radiance cascades / 2D GI.** The actual 2025 frontier is https://arxiv.org/abs/2505.02041 : Holographic Radiance Cascades reports 1.85 ms at 512² and 7.67 ms at 1024² on an RTX 3080 Laptop. A practical contemporary explanation is https://mini.gmshaders.com/p/radiance-cascades . The paper is evidence of a method, not proof of ClaudeVille speed or a shipped browser product. GLSL ping-pong textures can implement it, but a planar sprite image is not a correct isometric light-transport scene: roof height, receiver depth and hidden walls matter. Existing three-sample blockers are not an SDF or radiance hierarchy (`GpuWorldRenderer.js:134-151`). **Palette fit: poor without quantized output; quantization sacrifices much of the expensive smooth result.** Reject for this plan, along with WebGPU/OffscreenCanvas migration: no OF-007/008 trigger was measured here.

**4. Ordered-dither shadow and fog.** This 2025 browser implementation is concrete: https://tympanus.net/codrops/2025/06/04/building-a-real-time-dithering-shader/ . Its shader math is portable, its React/Three wrapper is not needed. ClaudeVille already has a four-cell pattern for wetness/water (`GpuWorldRenderer.js:156-186`), while ground fog still mixes continuously (`:289-291`). **Palette fit: excellent if each texel chooses between approved ramp stops.** Use world-space anchored thresholds on local atmosphere/receiver masks, not a full-screen black-and-white retro filter. Canvas can use cached stipple stamps. New pattern motion would produce crawling noise; reduced motion holds the same static pattern.

**5. Palette cycling / palette-ramp relighting.** The mature technique remains one of the best fits. A usable color-replacement implementation and web demo are documented at https://github.com/NullTale/LutLight2D ; it chooses authored ramps from lighting intensity, rather than multiplying everything toward white. This is not evidence that the technique originated in 2025. Existing water courses already cycle four discrete states (`GpuWorldRenderer.js:176-186`). The frontier is an optional nearest-sampled lookup for reviewed material colors, not “add animated water.” **Palette fit: strongest of this survey**, provided interpolation is disabled and semantic colors are excluded. Canvas keeps authored albedo or a bounded reviewed variant cache. P7 makes this tangible.

**6. CRT/phosphor passes.** A real late-2025 GLSL port, released January 2026 with a Canvas demo, is documented by its author: https://blog.gingerbeardman.com/2026/01/04/webgl-crt-shader/ . Cheap to append to PostFx, but the product already uses restrained grain/bloom and explicitly separates ungraded UI (`PostFx.js:221-227`; `character-mode/README.md:64`). **Palette fit: mostly no**—chromatic separation, scanlines and phosphor bloom change authored colors and reduce text contrast. It would make an excellent social-video novelty and a worse eight-hour instrument. Reject as default and do not spend a core release on an optional filter menu.

**7. Pixel-perfect tilt-shift.** The 2025 HD-2D hands-on above verifies depth-of-field as a current shipping artistic device, not a pixel-perfect shader algorithm. Traditional blur cannot preserve one-to-one sprite pixels. ClaudeVille could instead select two or three stepped scene-grade levels by semantic focus, keeping all edges sharp; PostFx's scene grade seam exists at `PostFx.js:126-146`, and the resident equivalent at `GpuWorldRenderer.js:205-230`. **Palette fit: actual optical blur fails; a stepped focus treatment can pass.** Prefer subtraction of unrelated labels over simulated camera optics. A spatial focus band must never dim an unresolved approval outside the band.

**8. Wind-driven foliage shaders.** The foundational GPU approach remains https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-6-gpu-generated-procedural-wind-animations-trees : world wind plus instance-local phase, evaluated without a CPU simulation. Do not mislabel that older work as a 2025 invention. ClaudeVille already calls `withTreeSway` for its props (`IsometricRenderer.js:840-863`) and uses a shared visual clock (`character-mode/README.md:72`). Moving a four-corner billboard would shear trunks, and continuously offsetting UVs would shimmer. **Palette fit: only integer-stepped crown poses, rooted trunk and static reduced-motion pose.** Coherence between existing wind actors is more valuable than more leaves; no new foliage system is proposed.

**9. Reflections in 2D.** A clear shader implementation is https://injuly.in/blog/water-shader/index.html : reflect a nearby object about the water boundary, then apply quantized displacement. The article does not establish a 2025 release date. ClaudeVille already has local-light reflection courses in resident GPU (`GpuWorldRenderer.js:281-286`) and a simpler screen-reflection branch in hybrid PostFx (`PostFx.js:209-214`). A shoreline-local ship/lantern reflection record would be feasible; mirroring the entire finished frame is wrong for the isometric island. **Palette fit: yes with short stippled rows and nearest sampling.** Reflection must repeat its real emitter, not become a second alert. Lower priority than strengthening the actual ship/signal.

**10. Subpixel-stable camera.** Mature discussion of pixel alignment and the tradeoff with subpixel interpolation: https://handmade.network/forums/t/7883-pixel_art_fragment_shader ; an alternative deliberately anti-aliased aesthetic: https://www.shadertoy.com/view/ds2XWy . The latter is not ClaudeVille's contract. Shared snapped render/hit transforms already shipped (`character-mode/README.md:68`). **Palette fit: integer resting scales and shared backing-pixel translation pass; temporal AA or blended fat-pixel scrolling does not.** No new camera math proposal: protect the existing fix and make shot composition more intentional.

**11. WebGL2 instancing for crowds.** The browser primitive is ordinary and available: https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/drawArraysInstanced . The current scene writes six vertices per quad (`GpuWorldRenderer.js:19-23,44-60`) and batches only consecutive compatible records (`GpuWorldPolicy.js:230-274`). Instancing could reduce repeated vertex data but cannot magically combine sprites separated by building-front depth records or incompatible textures. **Palette fit: exact, since shading need not change.** This is a measured optimization opportunity, not visual direction. At 100 agents the first ceiling to solve is perception; extra quads are not a reason to render extra labels. No broad batch rewrite without a measured draw/setup bottleneck.

### Benchmarking the references as visual ideas

These are art-direction comparisons, not assertions that ClaudeVille should copy the games' assets, engines, quests or UI.

| Reference | Transferable visual idea | Honest-data translation and limit |
|---|---|---|
| Stardew Valley | Repeated, legible daily routines make a small place memorable. | Keep durable building meanings and a calm repeated visit grammar. Arrival/work/completion may shape rhythms; never invent leisure needs, friendship or fatigue. |
| Moonlighter | A shop threshold makes an abstract economy tangible. | Put current write/read/plan work inside a small authored doorway aperture; actual tool changes alter the visible bench. No shop inventory or gold economy fabricated from cost. |
| Octopath Traveler HD-2D | Foreground subject, warm aperture, cool distance; light gives the eye an itinerary. | Selective palette-safe light and deliberate negative space, not photographic blur or a 3D rebuild. Use an actual selected agent as the focus. |
| Eastward | Tiny domestic tableaux and confident material silhouettes reward close inspection. | A forge desk with a real active tool has more value than three new towers. Props must explain a tool or state; no imagined conversations. |
| Sea of Stars | Lighting can change the emotional reading without changing the underlying pixel craft. | Let occupancy and actual atmosphere change authored palette response. Official feature description: https://seaofstarsgame.co/ . Do not import arbitrary eclipse events or turn quota into weather without disclosure. |
| Tiny Glade | Delight comes from coherent consequences at the point of interaction, not a global effects storm. | A selection makes one threshold reveal its actual occupants; a tool completion settles one object. No procedural castle construction or invented village growth. |
| Dwarf Fortress Steam | A world is valuable because inspectable histories explain its seemingly incidental objects. | Spatial replay and shared-file traces lead directly to real history/paths. Preserve exact/inferred/unknown rather than presenting an omniscient simulation. |
| Frostpunk | A powerful visual center and a readable exception layer coexist with a populated city. | Give unresolved decisions an unambiguous count and a small quiet region. Never use the menace palette to exaggerate ordinary waiting or monetary spend. |

## Proposals

All costs below are **[INFERENCE] planning envelopes**, not measured results. CPU/GPU estimates mean incremental active-frame work at the 1920×1080 reference surface; inactive features should do effectively zero frame work. All proposals are additive at existing render seams, keep Canvas meaning, introduce no dependency/build requirement, and keep attention counts absolute. P1–P3 are cheap gasps (S); P4–P6 are big swings (L).

### P1 — Hold to read the village

- **Pitch:** Make one deliberate gesture translate the beautiful map into plain operational meaning, then return it untouched.
- **What the operator sees:** While holding an on-screen READ control or a nonconflicting keyboard gesture, `FORGE` becomes `WRITING · 8`, `ARCHIVE` becomes `READING · 3`, and normal nameplates yield to short tool verbs; selected/action-needed agents keep their names and reasons.
- **Real data it renders:** `agent.currentTool`, `agent.lastTool`, `agent.status`, `agent.pendingTool`, `agent.waitReason` (`Agent.js:123-144`) and the current building occupant/signal snapshot (`VillageDirector.js:318-343`). Unknown tools say `OTHER`, not a fabricated action.
- **Files touched:** `BuildingSprite.js:833` label policy; `WorldFrameRenderer.js:710-714` upper labels; `IsometricRenderer.js:1836-1843` keyboard routing; new small shared control alongside existing World controls, owned by the coordinator.
- **Sketch:**
  ```text
  Resolve existing tool-to-building semantics; do not add another classifier.
  Derive building counts on agent/state change, not during every label draw.
  Hold/read mode substitutes one short verb line for ordinary plaque text.
  Retain attention/selected names and exact wait reasons above all substitutions.
  Releasing the control restores identity labels without changing selection.
  Ignore shortcuts while typing; button is a complete equivalent interaction.
  Static band; reduced motion and Canvas use the identical text swap.
  No camera move, pulse, added sprite, or retained history.
  ```
- **Cost:** S; <0.1 ms CPU, approximately zero extra GPU; <32 KiB derived strings/counts. Asset generation: no.
- **Risk:** A tool category is a metaphor, not proof of success; never label Bash as “testing” unless its actual mapped context supports it. At 100 agents this must reduce marks, not add a second overlay. Existing attention/selection governance remains authoritative. Do not claim the gesture key until the full key map is checked.
- **Wow 1–5 / Informative 1–5:** **4 / 5.** Wow: the same image changes from RPG town to instantly readable work map. Informative: first-time users learn the grammar without a tutorial tour or glossary panel.

### P2 — Let empty villages actually be quiet

- **Pitch:** Let a healthy empty town be an intentional held breath, not a launch party for the dashboard itself.
- **What the operator sees:** Shot 02's unoccupied village keeps its lovely noon light and compact ready banner, but no work-like parade announces ClaudeVille's own version; authentic future arrivals become the first meaningful event.
- **Real data it renders:** `world.agents` emptiness; app version versus actual release-event provenance. `VillageDirector.triggerReleaseParadeOnceForVersion` explicitly synthesizes a parade from the application version (`VillageDirector.js:221-235`), separate from actual release payloads (`:238-248`). This is a semantic correction, not suppression of a real repository release.
- **Files touched:** `VillageDirector.js:221-248`; `IsometricRenderer.js:1844` startup parade invocation; existing changelog/version affordance rather than a new celebration channel.
- **Sketch:**
  ```text
  Stop auto-translating the dashboard version into a harbor work release.
  Keep version discovery in the existing version/changelog UI.
  Retain explicit simulator release metadata and real release events.
  An empty roster alone never cancels a genuine pending repo release.
  Leave day/night scenery and existing healthy-empty banner intact.
  Static band; no new state machine, pulse, or event resource.
  Canvas and GPU consume the same reduced release-scene input.
  ```
- **Cost:** S; saves event/overlay work, no new per-frame GPU or memory. Asset generation: no.
- **Risk:** Removes an intentional celebratory brand moment, so maintainer taste approval matters. It must distinguish dashboard-release celebration from a real release made by the user's agents; no generic “hide parade when zero agents” condition. Crowd behavior is unchanged.
- **Wow 1–5 / Informative 1–5:** **3 / 4.** Wow: restraint makes the first real activity feel earned rather than routine. Informative: Harbor no longer suggests the user's repository shipped because the dashboard was updated.

### P3 — Make a quiet room around the next decision

- **Pitch:** When an operator explicitly chooses the next action, temporarily stop ordinary speech and duplicate labels from competing with that agent.
- **What the operator sees:** In a shot like 04, choosing the attention target leaves its body, name, reason and route intact while unrelated conversation rectangles disappear; other unresolved agents retain count/primary marks, not a wall of dialogue.
- **Real data it renders:** Selected agent id (`VillageDirector.js:334`), status/wait reason/provenance (`Agent.js:141-153`), and the existing global attention command described in `dashboard-mode/README.md:43`. This renders the operator's explicit focus, not an inferred importance score.
- **Files touched:** `WorldFrameRenderer.js:710-714` overlay assembly; existing agent annotation admission at the same upper pass; `VillageDirector.js:334` focus snapshot. Reuse existing governor priorities, not a second scene scheduler.
- **Sketch:**
  ```text
  Enter decision focus only on explicit attention navigation or inspect action.
  Admit selected-agent text and all unresolved primary status markers.
  Suppress ordinary speech labels and duplicate routine names in that view.
  Keep building emblems, real count totals, and route landmarks.
  Restore ordinary captions on leaving selection; preserve their source data.
  Do not dim the whole screen or hide unresolved offscreen counts.
  Static band; reduced motion is identical and creates no transition timer.
  Canvas upper overlay is already shared with resident GPU; no new pass.
  ```
- **Cost:** S; fewer text draws, <16 KiB policy state, no GPU attachment. Asset generation: no.
- **Risk:** Must not become a modal tunnel that hides a second urgent agent. At 100 agents, primary markers and DOM counts remain intact; ordinary speech is intentionally not all simultaneously visible. Global emergency auto-ducking is not part of this proposal. Avoid copying the existing per-agent governor under a new name.
- **Wow 1–5 / Informative 1–5:** **4 / 5.** Wow: a noisy scene suddenly composes itself without moving the camera. Informative: the next decision becomes readable immediately, while unresolved counts remain truthful.

### P4 — Work as a spatial score

- **Pitch:** Turn the existing time history into an explicit, scrubbable explanation of where a selected run spent its time.
- **What the operator sees:** On request, the live village becomes a clearly badged historical diagram: small tool glyphs sit at their semantic buildings, a time cursor walks the sequence, long approval intervals remain long empty brackets, and child intervals appear alongside their real parent.
- **Real data it renders:** Existing waterfall rows from `ActivityPanel.js:418-469`, tool `ts/timestamp/startedAt`, `durationMs/duration_ms`, `completedAt`, `toolExitCode` (`:297-319`), permission timestamps (`:276-291`), and child timestamps/id (`:370-390`). Position history is only used when actual replay samples exist (`VillageDirector.js:323-333`); otherwise the display says semantic location, never historical physical position.
- **Files touched:** Extract the existing pure waterfall builder from `shared/ActivityPanel.js:418` into an appropriate shared pure model and migrate its consumer; `VillageDirector.js:206-218,323-343` replay ownership; `WorldFrameRenderer.js:764-770` ground cue seam; new `character-mode/SpatialWorkScore.js` plus a small DOM timeline control.
- **Sketch:**
  ```text
  Reuse the existing bounded selected-agent detail fetch and waterfall semantics.
  Normalize a maximum 20-minute interval; retain exact/inferred labels.
  Map known tool classes to durable building anchors, not invented walking paths.
  Draw a static sequence of capped glyphs; selected interval shows duration text.
  Show unknown time as a gap, never as continuous work or successful completion.
  Scrubbing changes only replay presentation, never world/domain agent status.
  LIVE remains visible and one action restores current selection immediately.
  Reduced motion has manual scrub only; optional playback claims slow band.
  Reuse cached ground cues and shared upper annotations for Canvas/GPU parity.
  Cap visible score nodes at 24; summarize overflow with a count and DOM list.
  ```
- **Cost:** L; target <0.5 ms CPU and <0.2 ms incremental GPU when active, <256 KiB model plus reuse of existing ground cue cache; no new full-resolution attachment. Asset generation: no; reuse tool emblems.
- **Risk:** **Big swing:** cinematic causality can lie more convincingly than a table. Timestamp order is not proof of a dependency, inferred retry is not a known retry, and semantic buildings are not actual execution locations. Strong LIVE/REPLAY separation is mandatory. At 100 agents, only the selected run plus bounded real children participates. Quality shedding may remove animated cursor interpolation, never history labels or unknown gaps.
- **Wow 1–5 / Informative 1–5:** **5 / 5.** Wow: the town becomes a readable score of an actual run, rather than simply replaying footsteps. Informative: “where did ninety seconds go?” becomes spatially memorable while retaining exact provenance.

### P5 — The shared-file loom

- **Pitch:** Let a selected file reveal the actual agents touching it as a small, local weave rather than another red warning chip.
- **What the operator sees:** Selecting an overlap in the DOM draws one file token near its relevant work district and up to six short threads to participating agents; double-write joins have two notches, read/write joins one, and the token shows the actual basename with an exact participant count.
- **Real data it renders:** `agent.workingSet` and `agent.collisions` (`Agent.js:155-156`). Collision records are `{path, project, agents, kind}` with `write-write` and `read-write`; read/read is silent (`workingSet.js:79-93`). No inference from branch proximity or similarly named files.
- **Files touched:** `WorldFrameRenderer.js:764-805` existing relationship ground seam; `shared/ActivityPanel.js:1033` working-set update/selection seam; new `character-mode/WorkingFileOverlay.js`; shared selection event for the existing collision record, not a new server route.
- **Sketch:**
  ```text
  Activate only from an explicit working-set/collision selection.
  Reuse the canonical project/path identity from the server record.
  Resolve real participating agent ids against current world sprites.
  Place one transient file token; it is a diagram node, not a new building.
  Use shape/notches for write-write versus advisory read-write.
  Render at most six visible links; preserve the exact total and DOM member list.
  Hidden/departed participants remain labelled unavailable, never silently safe.
  Static band and static reduced-motion rendering; no packet animation.
  Draw via the existing cached ground layer and shared upper token label.
  Clear on deselection and discard raw path display state; no new persistence.
  ```
- **Cost:** L for truthful interaction/identity/occlusion integration; target <0.3 ms CPU and <0.2 ms GPU, <128 KiB state, no new atlas required. Asset generation: no.
- **Risk:** **Big swing:** risks turning a town into a node editor and treating overlapping writes as confirmed corruption. It is advisory, explicitly selected, and must remain visually distinct from actual error. At 100 agents, links do not grow quadratically; overflow is a count/list. Existing relationship rings must be suppressed for the same selected entities rather than stacked underneath.
- **Wow 1–5 / Informative 1–5:** **4 / 5.** Wow: one real file briefly reveals the otherwise invisible coordination structure. Informative: exact path membership answers a question that bodies clustered at Forge cannot answer.

### P6 — Threshold theatre

- **Pitch:** Make one working building reveal a tiny authored interior that explains what its real occupants are doing, without fading its roof or rebuilding the village.
- **What the operator sees:** Selecting Forge at detail zoom opens a fixed front-wall aperture: the selected real villager is visible at a workbench, a write tool puts a document under the lamp, a pending command leaves the same scene still, and completion settles the document. The exterior remains a strong silhouette.
- **Real data it renders:** Current/last tool and pending state (`Agent.js:123-144`), actual building occupancy from the existing building sprite/visit model (`BuildingSprite.js:1412-1415`), and existing `RitualConductor` tool pose semantics (`character-mode/README.md:41`). No new NPCs, invented items completed, rooms “levelled up,” or fake percentage progress.
- **Files touched:** `BuildingSprite.js:1727-1785` split drawables and authored overlay seam; `BuildingVisualRegistry.js` profile for Forge; `gpu/GpuSceneBuilder.js:484-590` building record seam; manifest plus new Forge aperture/interior/foreground PNG layers. Do not resurrect roof fading: `BuildingSprite.js:7` explicitly records its removal.
- **Sketch:**
  ```text
  Author a single Forge aperture and interior at the existing sprite pixel scale.
  Keep exterior footprint, roof silhouette, door anchor and pathfinding unchanged.
  Enter only for explicit building inspection at a readable detail zoom.
  Project actual occupants into bounded presentation slots inside the aperture.
  Do not draw a duplicate exterior actor for the same presented occupant.
  Use existing tool pose/ritual state, never an independent simulated work cycle.
  Foreground frame occludes the actor using current split drawable ordering.
  Label overflow as N more and retain every occupant in the existing panel.
  Reduced motion uses a static tool pose; reuse medium band only in lieu of glow.
  Canvas draws the same layers; GPU uses ordinary added quads, not a new pass.
  Close instantly restores exterior presentation without changing domain position.
  ```
- **Cost:** L; target <0.4 ms CPU, <0.3 ms GPU, ≤2 MiB incremental decoded layers for one pilot; actor textures reused. Asset generation: yes, three carefully reviewed Forge layers and masks, not nine building regenerations.
- **Risk:** **Big swing:** this can easily become fake interior gameplay, break selected hit targets, or make the actor teleport. Explicit inspection, small transition-free diorama framing and clear occupant identity are required. At 100 agents, only selected inspection participates, maximum three portrayed occupants and exact overflow. If three-times framing is required to see the idea, it may be a beautiful novelty rather than daily value; reject after the one-building pilot if so.
- **Wow 1–5 / Informative 1–5:** **5 / 4.** Wow: a landmark becomes a tiny working place with an actual named inhabitant, the strongest Moonlighter/Eastward transfer. Informative: conveys what kind of work is occurring, but exact commands still belong in the panel.

### P7 — Light that stays inside its palette

- **Pitch:** Replace one pilot material's washed-out light response with authored nearest-sampled color ramps, making torchlight sculpt the sprite instead of bleaching it.
- **What the operator sees:** In shot 01's warm Command pool, slate stays slate, gold reaches a warm authored highlight, and stone retains its plane breaks; an illuminated door feels incandescent without a larger halo.
- **Real data it renders:** Existing authored material class, light color/intensity, emissive gate and time/weather state (`GpuWorldRenderer.js:233-286`). No new emitters and no mapping of cost to brightness. This is faithful rendering of existing visual state, not an added operational claim.
- **Files touched:** `gpu/GpuWorldRenderer.js:189-202,271-286` optional pilot response; `gpu/GpuSceneBuilder.js:113-143` pilot channel loading seam; `MaterialRegistry.js`/manifest contract for optional lookup metadata; a small authored ramp PNG. Hybrid PostFx is not allowed to globally recolor already-graded sprites.
- **Sketch:**
  ```text
  Select Command stone/slate/gold pixels from the existing reviewed pilot masks.
  Author a small finite dark/mid/light ramp for each participating base color.
  Load an optional nearest-sampled ramp alongside current material companions.
  Quantize admitted local-light contribution to the reviewed ramp levels.
  Keep authored albedo untouched when no table exists or effect is shed.
  Preserve authored emission hue/alpha independently; no brightness inference.
  Do not apply lookup to labels, provider identity or attention marks.
  Static light response: reduced motion needs no special allocation or pulse.
  Canvas retains original authored albedo/light contract; optional cached still
  variants are allowed only if the pilot visibly needs parity, with a hard cap.
  ```
- **Cost:** M pilot, not a global material rewrite; target <0.1 ms CPU and <0.4 ms GPU, <64 KiB LUT plus a reviewed ≤1 MiB optional pilot index mask. Asset generation: yes, hand-authored ramps/index mask only; no regenerated albedo.
- **Risk:** Arbitrary palette lookup can crush details or require per-pixel indexing that exceeds its visual gain. Do not repurpose packed channel bytes without an explicit contract. Must be an additive optional pilot; no normal maps, extra scene pass or changed global color space. At 100 agents it affects one landmark, not the whole crowd. If shader cost causes ladder shedding, retain the original look instead of raising budgets.
- **Wow 1–5 / Informative 1–5:** **4 / 3.** Wow: modern light with actual pixel-art color judgement rather than a white glow filter. Informative: separates structural planes and occupied apertures, but does not answer a new data question; subordinate it to P1/P4/P6.

## Top three

1. **Work as a spatial score.** This is the most defensible frontier: a capability only ClaudeVille's combination of real agent data, history and physical metaphor can provide. Ordinary replay has already shipped; this adds an explicit time coordinate, exact/inferred distinction and memorable work geography. The critical design restraint is to show a diagram of known events, not stage a fictional movie of execution. It could earn daily use rather than a single screenshot.

2. **Threshold theatre.** The strongest pure visual bet is not another atmospheric pass. It is the moment a familiar building reveals a small world within it, occupied by your actual agent doing an attributable task. The single-Forge pilot keeps the asset risk bounded and respects the deliberate no-roof-fade decision. It should only survive if the real detail view improves both charm and tool comprehension without inventing a second simulation.

3. **Hold to read the village.** This is the best return on a small change. A first-time viewer gets an immediate decoder ring, and a daily operator gets a map of current work with less annotation competition. It makes existing craft more valuable without changing lighting, layout, camera, sprites or provider ingestion. I would build this before buying another rendering system.

## Rejected

- Full normal-mapped roster: eighty authored poses per character plus accessories is an art-maintenance burden; automated inflation gives the wrong material form.
- Radiance cascades, WebGPU, OffscreenCanvas migration: interesting research, no measured reopen trigger, and no trustworthy isometric transport representation to feed it.
- Global CRT/phosphor aesthetic: gives a demo instant nostalgia and costs an operator text clarity all day.
- Optical tilt-shift/DOF on the live instrument: removes crisp information exactly where an outlying problem may sit.
- Another distant shore, skyline or larger island: the previous cut was correct; decoration does not explain work, and enlarged space defers crowd handling.
- More provider glows, constellation links or colored particle identities: existing colors already identify state/family; more colors do not add comprehension.
- Grow a town as tokens are spent, earn levels from commits, celebrate arbitrary streaks: corporate gamification and a perverse reward for expense rather than useful outcomes.
- Pretend every tool is a minigame with a success animation: an invoked tool is not a known success, and a pending command is not a hammer strike every 600 ms.
- Constant cinematic camera tours: second-monitor monitoring cannot require chasing a wandering viewport; explicit inspection earns spectacle.
- Add more permanent labels to teach semantics: the teaching surface should be transient and intentional; shot 04 already demonstrates annotation saturation.
- A generic “add replay,” “add relationships,” “light occupied windows,” “draw pending branches,” or “fix smooth foliage” task: these are already delivered in the current code/docs cited above.

## Open questions for the coordinator

- Can P1's READ vocabulary be derived wholly from the existing canonical tool-to-building classifier, including provider aliases and ambiguous Bash commands? That owner must approve the exact plain-language terms; no new heuristic should be authored in a label renderer.
- Does decision-focus annotation subtraction already have a product-level toggle elsewhere beyond the read set? I verified shared per-agent priorities and the crowded live frame, not every settings branch. If it exists, P3 is tuning and exposure, not a new feature.
- P4 must reuse the existing waterfall's exact/inferred semantics after extraction, and must not smuggle presentation imports into domain/application. The existing public builder in ActivityPanel is the seam, not the desirable permanent home.
- P6 needs art approval at the actual 1×/2×/3× pixel sizes before any new layer production. Is the aperture read useful at 2×, or does the current giant-actor presentation make it unconvincing? Shot 03 makes this risk concrete.
- P7 needs a side-by-side still demonstrating improved shape at unchanged emitter intensity. The source already distinguishes authored zero height and two sun bands; do not reopen those shipped fixes under this pitch.
- The capture helper initially gave null hour/quality and misrouted Dashboard. The coordinator fixed it; shot 07 is the repeat. Earlier shots remain reliable image/GPU evidence but are not quality-ladder measurements. Do not compare their top-bar FPS as a benchmark across concurrent browser loads.
- First-run World Controls remains visible over the actual Dashboard in shot 07. This is a small concrete integration issue for the chrome owner, separate from the frontier proposals.
- Whether application-version parades are deliberate enough to retain despite P2 is a maintainer taste decision. The real-data distinction is source-confirmed at `VillageDirector.js:221-248`; do not silently relabel a product launch as a repository release.

## What not to do

Do not confuse more simultaneous motion with life. Life comes from understandable change surrounded by rest. Do not confuse technical novelty with visual progress: a 2025 GI paper does not make the operator's next unanswered prompt easier to see. Do not put every explanation permanently in the world; the reveal is more powerful when the calm image remains available. Do not smooth away the pixel craft, recolor semantic identity, make urgency depend on bloom quality, or turn unexplained data gaps into invented stories. Most importantly, do not lose the instrument: each spectacle must leave the operator better able to say **who is doing what, what changed, what is uncertain, and who needs me**.
