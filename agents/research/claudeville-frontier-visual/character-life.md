## Territory and method

Embodied agents: sheet poses, held tools, readable identity at three distances, lifecycle and family movement. Research only; no runtime/source/asset modifications, server lifecycle actions, gates, tests, or formatters. All cost figures below are engineering estimates, not measured performance claims.

Files read (paths relative to repository root):
- `AGENTS.md`, `claudeville/CLAUDE.md`, `agents/README.md`.
- `claudeville/src/presentation/character-mode/{README.md,AgentSprite.js,SpriteSheet.js,Compositor.js,RitualConductor.js,ArrivalDeparture.js,AgentBehaviorState.js,VisitIntentManager.js,Pathfinder.js,ActionVocabulary.js,AgentGpuOverlayRenderer.js}`; Pathfinder was structurally skimmed only.
- `claudeville/src/presentation/shared/{README.md,ModelVisualIdentity.js}` and `claudeville/src/presentation/dashboard-mode/README.md`.
- `claudeville/src/domain/value-objects/AgentMood.js`, `claudeville/src/domain/entities/Agent.js`, `claudeville/src/domain/services/VerifiedOutcome.js`, `claudeville/services/workingSet.js`.
- Character entries in `claudeville/assets/sprites/manifest.yaml` (not asset-pipeline internals).
- `docs/{visual-experience-crafting.md,motion-budget.md,building-style-contract.md,material-channel-contract.md,world-visual-qa-checklist.md,rendering-baselines.md}`.
- Character-related searches in `agents/plans/claudeville-fable-5.1-enhancement-implementation-plan.md` and `agents/claudeville-astra-refinement-plan.md`.
- `claudeville/src/presentation/character-mode/__simfixture__/WorldScenarios.js` and the supplied capture helper.

Captures, all visually inspected, 1920×1080 JPEG, real Chromium Apple Metal GPU:
1. `agents/research/claudeville-frontier-visual/shots/character-life-01.jpg` — one-working-agent, zoom 3, selected Solo beside Forge; first of two same-page moments.
2. `agents/research/claudeville-frontier-visual/shots/character-life-02.jpg` — same page after a 10,000 ms wait; Solo has travelled toward Mine. The screenshots show completion, not active tool work. An initial camera-method error delayed the first capture; the fixture itself completes at 4400 ms (`WorldScenarios.js:297–303`). This is useful evidence of post-turn embodiment, not a comparison of Read versus Edit frames.
3. `agents/research/claudeville-frontier-visual/shots/character-life-03.jpg` — mixed-tools, zoom 3, 12-second helper wait, center 17,23. Replaced the missed original composition after the coordinator fixed camera-pose application and explicitly requested recapture. Two chatting mages and an engineer now visibly occupy the bridge; their body silhouettes and large procedural talk squares are directly comparable.
4. `agents/research/claudeville-frontier-visual/shots/character-life-04.jpg` — waiting-on-user, zoom 3, selected `sim-user-bell`, 12-second wait. The attention beam and back-facing mage are clear.
5. `agents/research/claudeville-frontier-visual/shots/character-life-05.jpg` — parent-subagents, zoom 3, 12-second wait. Prime and Scout visible; one child already retired. Good direct comparison of related bodies.
6. `agents/research/claudeville-frontier-visual/shots/character-life-06.jpg` — dense-100-agents, zoom 1, 15-second wait. Exactly 100 domain agents reported; compact bodies and label clusters across civic areas.
7. `agents/research/claudeville-frontier-visual/shots/character-life-07.jpg` — supplemental mixed-tools, 5-second wait, seven agents. Requested zoom 3 but final diagnostics report zoom 1; retained as useful mid/far identity evidence, not mislabelled as detail evidence.
8. `agents/research/claudeville-frontier-visual/shots/character-life-08.jpg` — supplemental one-working-agent, zoom 3, 1.8-second helper wait after load/setup; fixture already completed. Shows the same upright travelling body overlapping Task Board.

Every GPU diagnostic read `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)`. Helper shots reported no console errors. Shots 01/02 used read-only Playwright directly; the other shots used the supplied helper against maintained `http://localhost:4000`. No real operator session data was fetched deliberately; scenarios were simulator-backed. The original helper returned null PostFx/hour diagnostics, so no fixed noon or quality level is asserted for those captures. The replacement shot 03 reports resident `webgl`, `qualityLevel: 0`, `qualityReason: within-budget`, hour 12, clear weather, zoom 3. This is a single loaded-host diagnostic, not a benchmark. Original captures 03–06 ran concurrently, and other researchers were capturing on the same host; replacement 03 ran as one local capture with peer concurrency unmeasured. No Canvas fallback or reduced-motion capture was taken; fallback proposals below are requirements, not verified parity claims. Eight screenshot paths are retained; one was replaced at coordinator request after the helper fix.

## Current state

### Complete sheet and pose inventory

`claudeville/src/presentation/character-mode/SpriteSheet.js:1–25` is definitive: 92px square cells, eight columns S/SE/E/NE/N/NW/W/SW; rows **0,1,2,3,4,5 = walk frames 0–5**, rows **6,7,8,9 = idle frames 0–3**. There are no authored Read, Edit, Shell, Think, Wait, Error, Chat, or Celebration rows. Manifest examples explicitly request only `[walk, breathing-idle]` (`claudeville/assets/sprites/manifest.yaml:60–67,84–91,106–113,130–137,151–158`). A row index is not evidence that every model depicts the same facial expression: the code calls idle frame 3 eye-shut, but this review did not audit every authored cell.

| State | Actual body frame mapping | Additional vocabulary today |
|---|---|---|
| Walk / travel | Six walk rows; distance-driven gait, reduced motion idle frame | Terrain-specific footfall particles on stride contact (`AgentSprite.js:2290–2342`). |
| Idle | Four idle rows, seeded phase | Scenic held idle 3 for reading/rest; fidgets and stop/look; no dedicated sleep row (`AgentSprite.js:2346–2475`; `RitualConductor.js:60–73`). |
| Read/search | Idle while stopped, walk while travelling | Claude/Codex procedural book; Archive page-turn ritual (`ActionVocabulary.js:64–67`; `AgentSprite.js:6443–6445,6482–6494`). **No distinct body pose.** |
| Edit/write | Same idle/walk rule | Generic work glyph, Forge hammer ritual (`AgentSprite.js:6446–6447,6468–6478`). **No distinct body pose.** |
| Shell/test | Same idle/walk rule | Generic WORK, unless classified otherwise; no shell-specific body or sheet row (`ActionVocabulary.js:64–67`). **No distinct body pose; no distinct generic shell action.** |
| Think/plan | Same idle/walk rule | Thought blocks/dots, model-dependent cadence; plan glyph (`AgentSprite.js:6041–6064,6106–6127,6448–6449`). **No distinct body pose.** |
| Wait / needs user | Same idle/walk rule | WAITING maps to THINK; needs-user status question/beacon, long-wait distress (`ActionVocabulary.js:66`; `AgentSprite.js:6000–6030`; `AgentMood.js:200–214`). **No authored held-wait body.** |
| Error / rate limit | Same idle/walk rule | Downward whole-body posture offset 3/2 pixels, mood offsets, incident marks, recovery spark (`AgentSprite.js:1852–1910,6297–6308`). **No distinct error row.** |
| Chat | Idle loop, partners face each other and stop | Procedural waving hand dot, ellipsis, TALK prop (`AgentSprite.js:2150–2183,6147–6154,6450–6451`). **No distinct chat body row.** |
| Verified success | Same idle/walk rule | Five-second CELEBRATE action for verified commit/push/release/milestone; not generic completion (`ActionVocabulary.js:8–15,22–27,37–67`; `VerifiedOutcome.js:3–4`). **No celebration body row.** |
| Departed | Idle frame 0, motion/chat cleared | Static settled tableau (`AgentSprite.js:2121–2135`), separate departed treatment (`AgentGpuOverlayRenderer.js:59–61,81–84`). |

The final draw explicitly overwrites `animState` to only idle/walk (`AgentSprite.js:2725–2730`), so adding a semantic state alone cannot choose new rows.

### Richness already shipped—and its limits

- Nine procedural gestures already exist: hammer/Forge, page/Archive, pick/Mine, scroll/Task Board, gaze/Observatory, conjure/Portal, signal/Command, haul/Harbor, scan/Watchtower. They are capped at six simultaneous rituals, spatially admitted at their building, and time-limited (`RitualConductor.js:4–6,27–50,380–456`). Do **not** pitch “add a scroll/hammer” as new. The meaningful delta is authored hand/body contact and parity. GPU annotations call the generic action overlay, not the nine-gesture overlay (`AgentGpuOverlayRenderer.js:53–57`; compare `AgentSprite.js:2932–2933,6356–6416`). This is a source-confirmed seam, not a visually isolated parity failure.
- Distress, anxiety, pride and fatigue already derive from telemetry, not a random mood pool (`AgentMood.js:172–247`). Context pressure is already a token-derived floor gauge and sweat/jitter, and tired mood can hold idle 3 (`AgentSprite.js:1857–1878,3412–3430,3503–3525`). `contextPressureRatio` is a **tuning threshold name**, not an Agent payload field (`AgentMood.js:217–221`); actual source is `tokens.contextWindow / tokens.contextWindowMax` (`AgentSprite.js:3413–3417`). A new fatigue system would duplicate existing work.
- Attributed speech is shipped. `agent.speech()` is the sole words source; full text, source, fidelity, redaction, held state and observation timestamp are carried through, with no substitute idle bark (`AgentSprite.js:5814–5856`). A speech bubble quoting the real last message is not a new frontier.
- Main arrivals already approach by transport; children dispatch as wisps and merge back; completion cues are capped at eight; three provider-shaped familiar motes are available (`ArrivalDeparture.js:113–204`; `AgentSprite.js:6740–6751`). New “children spawn and return” must preserve identity, not reimplement the existing effect.
- Deterministic identity exists: id/model/provider hash chooses four palette variants (`AgentSprite.js:5038–5056`), id seeds animation phases (`:786–792`), model class/effort selects sprites and weapons (`ModelVisualIdentity.js:31–86,201–275`), team trim participates in compositing (`Compositor.js:59–112,149–160`). Fidget timing still uses `Math.random()` (`AgentSprite.js:2456–2470`). This is not an unseeded clone army; it is a **low-resolution identity channel** whose distinctions are hard to retain in crowds.
- GPU crowd bodies preserve authored silhouettes at a 28-world-pixel cap while primary agents keep full bodies (`AgentSprite.js:2653–2656,2732–2738`). Canvas budget impostors collapse to provider diamonds (`:6616–6644`). The backend difference matters to any individuality promise.

Art direction: the mage is exceptionally readable as a character: huge hat, confident coat contour, staff/book, crisp back view (shots 01/02/04/05). It feels like a beautiful RPG paper figure placed in a village more than a worker whose hands actually do work. In 01/02 the impressive change is location and facing, not meaningful muscular action. In 04 the amber beam tells me “needs me” before the body does; the giant upright back says almost nothing about waiting. Prime and Scout in 05 share a family convincingly, but I need the names/panel to know who leads whom. Shot 07 separates mage and engineer families at overview; within the mage family, names do most of the individuating. At 100 agents in 06, tiny bodies are lively texture while clustered green name pills become the dominant individuals. The shot is readable as crowded workplaces, not as 100 memorable people. Near-view name tags are remarkably small beside their giant bodies (04/05), but increasing all labels would worsen 06: solve identity in the body, not more text.

The corrected mixed-tools close-up (shot 03) is especially instructive: facing partners and distinctive mage/engineer bodies create a convincing social scene, but the oversized square ellipsis marks are doing the talking. Their bodies remain upright and similar; several figures overlap on the narrow bridge. P1 should make hands and posture carry more meaning while replacing, not stacking on, those high-salience prop squares.

## Proposals

All proposals reuse zero-build vanilla JS, existing event/state ownership and pixel-snapped geometry; none needs WebGPU, workers, a framework, smooth character deformation, or new lighting. Optional body detail must degrade before primary status. “CPU/GPU cost” below means estimated incremental cost at admitted limits; requires later profiling.

### P1 — Hands that actually do the work

- **Pitch:** Replace floating generic tool symbols with a small authored action-sheet vocabulary whose hands, prop and torso form one convincing pose.
- **What the operator sees:** A reader opens a book between both hands; an editor braces a tool and strikes; a shell runner holds a command slate instead of making the exact same work gesture; a thinker holds a still, closed stance. At a glance the selected figure changes occupation, not merely its badge.
- **Real data it renders:** `agent.currentTool`, `currentToolInput`, `status`, `isToolFresh`; existing `resolveAgentAction` and ritual records (`ActionVocabulary.js:45–68`; `RitualConductor.js:434–455`). Testing is a semantic phase only when supported by tool classification (`VisitIntentManager.js:93–107`), not a fabricated “tests passed” event.
- **Files touched:** `ActionVocabulary.js:45`, `AgentSprite.js:2725–2821,6422`, `SpriteSheet.js:16`, `RitualConductor.js:27`, `AgentGpuOverlayRenderer.js:53`; optional manifest-backed action-sheet entries adjacent to `manifest.yaml:106`. Extend existing composition/lookup rather than another pose renderer.
- **Sketch:**
  1. Keep the canonical 8×10 locomotion sheet unchanged.
  2. Add optional 8-direction action companion: rows 0–1 read-open/page, 2–3 edit-brace/strike, 4–5 shell-slate/enter, 6–7 think-rest/consider.
  3. One resolved visual pose selects either companion or existing body frame; held props belong to that pose, not an additional symbol layer.
  4. Metadata defines hand anchor and occupied grip; sheathe a runtime weapon when that hand holds the work prop, retaining the effort cue elsewhere.
  5. Do not paint over a baked weapon: profiles without a clean grip retain existing action overlay until authored support exists.
  6. On tool transition, choose the rest pose immediately; optional two-frame medium-band beat replaces working pulse, never stacks with it.
  7. Stop gesture on travel or stale tool; moving bodies retain the established walk rows.
  8. Reduced motion selects one informative rest frame with no cadence allocation.
  9. GPU adds the selected frame to the existing record/atlas path; Canvas blits the same cell. Unsupported profiles use the existing static prop, explicitly not a fake authored pose.
- **Cost:** L. Pilot one mage and one engineer; approximately 2.17 MiB raw RGBA per 736×736 eight-row companion, plus optional material channels and bounded derived copies. One frame choice per sprite; target <0.15 ms CPU and <0.1 ms GPU incremental for twelve detailed bodies after cache warmup. Assets: yes, carefully reviewed action companions, not roster regeneration.
- **Risk:** Baked equipment and eight-direction grips are the hard problem. New pose atlases must fit existing budgets; never precompose id×pose×accessory sheets. At 100 agents compact bodies remain static or use only one action silhouette; selection promotes detail. Shell recognition must reuse canonical classifier rather than expanding regex folklore. Medium animation must replace existing work glow/ritual emissions.
- **Wow 1–5 / Informative 1–5:** **5 / 5**.
  - Wow: physical hand contact is a qualitative jump from moving cutouts to miniature craftspeople.
  - Informative: Read/Edit/Shell become different silhouettes without opening details.

### P2 — The working set becomes carried folios

- **Pitch:** Let the character carry a small, truthful bundle representing the files it has actually touched.
- **What the operator sees:** A thin pale folio for reads, a tied darker folio for writes, and one compact `3 read · 2 write` count on selected detail; the bundle stays with the person as it moves from Archive to Forge. It is a visible working set, not floating cargo confetti.
- **Real data it renders:** `agent.workingSet`, capped at 16 by `Agent.js:155`; entries `path` and `op: read|write`, with writes dominating duplicate reads (`services/workingSet.js:37–47`). Counts describe **observed working-set entries**, not all project files or total diff lines.
- **Files touched:** `AgentSprite.js:2671–2685,2821,6422`, `Compositor.js:59`, `AgentGpuOverlayRenderer.js:53`; working-set snapshots consumed from existing Agent updates, no adapter expansion.
- **Sketch:**
  1. Compute distinct read/write counts only when the working-set snapshot changes.
  2. Store two small integers and a three-level bundle silhouette on the sprite.
  3. Put the bundle on the belt/back anchor so it does not compete with P1's active grip.
  4. One/two/three visible folio edges mean a small/medium/large observed set; never imply one edge equals an exact file when capped.
  5. Selected/hovered detail carries exact observed counts; reuse the current name/status annotation budget, not a new permanent label.
  6. Unknown or empty working set means no bundle, not a zero-work judgment.
  7. Static band; no page shedding or idle pulse. Reduced motion is identical.
  8. GPU/Canvas both draw the same tiny bounded attachment, omitted for compact crowds except selected/hovered agents.
- **Cost:** M. <0.1 ms CPU/frame and <0.05 ms GPU for twelve admitted bundles; <64 KiB procedural attachment cache, two counters per sprite. Assets: no; existing parchment palette and snapped rectangles suffice.
- **Risk:** Working-set cap can be misread as total volume; always say observed entries. Different files do not imply a diff-size estimate. Do not encode collision severity into the same prop color; leave actual collisions to primary incident ownership. At 100 agents, no hundred count labels.
- **Wow 1–5 / Informative 1–5:** **4 / 5**.
  - Wow: a worker visibly carries the residue of its actual activity between places.
  - Informative: makes read-heavy versus write-heavy work and scope tangible without invented metrics.

### P3 — A hundred stable signatures, not a hundred new sheets

- **Pitch:** Preserve a small deterministic personal signature across hero body, compact body, fallback impostor and selection.
- **What the operator sees:** The engineer with a square shoulder tab remains that same square-tab engineer after zooming out; a mage's two-notch hem and small clasp survive as a two-notch token in crowded mode. Selection enlarges the same individual rather than revealing an unrelated generic diamond.
- **Real data it renders:** Stable `agent.id`, canonical provider/model identity; extend existing hash and four palette variants (`AgentSprite.js:5038–5056`) instead of inventing random personality. The signature answers “which entity is this?”, as allowed by `docs/visual-experience-crafting.md:93–112`.
- **Files touched:** `AgentSprite.js:786–792,2671–2685,2732–2738,5038–5056,6584,6616`, `ModelVisualIdentity.js:201`, `Compositor.js:59–112`; existing compact name glyph slot must reuse the same identity mark.
- **Sketch:**
  1. Preserve current palette seed for continuity; derive an independent bounded signature index from stable id plus canonical family.
  2. Choose four small silhouette trims and eight two-tone clasp patterns, all subordinate to model silhouette and team trim.
  3. Do not claim 32 variants uniquely identify 100 agents; they help visual tracking while exact names remain authoritative.
  4. Apply geometric signature stamps at draw time or shared variant atlas level, never unique full sheets per id.
  5. Include the same 3×3 or 4×4 mark in the Canvas diamond; in GPU compact mode retain one strong notch/shoulder cue.
  6. At very small footprints collapse to a static signature token, not a new animation.
  7. On hover, show the normal full body and existing name, with no identity-changing recolor.
  8. Seed fidget choices if repeatable movement is desired, but do not assign moods, gait urgency or rank from random bits.
  9. Reduced motion identical; no pulse band beyond static. Respect primary incident shape slots.
- **Cost:** M. Target <0.25 ms CPU and <0.1 ms GPU for 100 small stamps; <128 KiB shared stamp atlas and a few bytes per sprite. Assets: no generation; deliberate pixel masks reviewed per family.
- **Risk:** Too many colors destroys family identity. Marks need contrast without impersonating incident badges or effort crests. Signatures collide and must never replace names/selection IDs. Cache cardinality must be bounded independently from agent count. This is an extension of shipped deterministic identity, not its reinvention.
- **Wow 1–5 / Informative 1–5:** **4 / 5**.
  - Wow: zooming feels like inspecting the same living cast, not exchanging people for dots.
  - Informative: operators can follow an individual through crowd pressure and camera changes.

### P4 — A blocked worker holds the question

- **Pitch:** Give waiting-on-user a persistent, physically readable hold pose rather than another moving worker under an amber beam.
- **What the operator sees:** Bellkeep stops the productive gesture, holds a closed work slate at chest height with one palm open, and remains visibly paused. The current attributed question stays available through existing speech/provenance; the pose does not invent words.
- **Real data it renders:** `status === WAITING_ON_USER`, `awaitingSince`/`pendingSince` and existing `statusSince` (`Agent.js:202–213`), plus `agent.speech()` only for wording (`AgentSprite.js:5821–5850`). Never infer approval from merely old activity.
- **Files touched:** `AgentSprite.js:2121–2195,2725–2821,6000–6030`, `ActionVocabulary.js:45`, `AgentGpuOverlayRenderer.js:53`; optional action-companion row 8 beside P1's rows 0–7. Arrival/route semantics stay with existing owners.
- **Sketch:**
  1. Resolve a held-needs-user pose before generic WORK/THINK while retaining the independent primary incident mark.
  2. Author one eight-direction hold row, not another four-frame loop.
  3. Allow current legitimate approach to finish; then hold instead of repeatedly starting work gestures.
  4. No body rotation toward the camera: preserve spatial facing and eight-direction pose readability.
  5. On real status resolution, release directly to the current tool's rest pose; do not celebrate approval as task success.
  6. Static band, including normal motion mode; reduced motion shows exactly the same hold.
  7. Missing authored support uses idle row 9 plus an open-palm/slate static overlay; label semantics remain unchanged.
  8. GPU and Canvas share pose selection; at 100 agents retain the existing primary-agent full silhouette exception.
- **Cost:** M after P1, L independently. One 736×92 RGBA row about 265 KiB/profile; no per-frame state beyond current enum, estimated <0.03 ms incremental CPU/GPU. Assets: yes, one authored hold row per pilot profile.
- **Risk:** A still body must not look disconnected or dead; the existing beam/age/status remains primary. Never suppress urgent attention to make the scene prettier. No generic sleeping pose for blocked agents, and no guessed quote from a tool argument.
- **Wow 1–5 / Informative 1–5:** **4 / 5**.
  - Wow: the village visibly waits for its operator instead of carrying on theatrically.
  - Informative: body language agrees with the exact action-required state even without reading a label.

### P5 — The child returns as itself

- **Pitch:** Upgrade existing dispatch/merge wisps to carry the child's recognisable identity and make the parent visibly receive the completion.
- **What the operator sees:** Scout's tiny hat/shoulder signature detaches into the existing dispatch path; on actual completion the same miniature returns, lands beside Prime's held ledger, then becomes the normal completion mark. Parent and child no longer dissolve into anonymous light dots.
- **Real data it renders:** Existing parentSprite/childSprite identity in `beginSubagentDispatch`, childAgent and parentSprite in `recordSubagentCompletion` (`ArrivalDeparture.js:140–204`), `parentSessionId` relationship intents (`VisitIntentManager.js:622–645`). This is lifecycle completion, not proof of task success.
- **Files touched:** `ArrivalDeparture.js:140–204,279–286`, `AgentSprite.js:6740–6751`, `Compositor.js:32,59`, `AgentGpuOverlayRenderer.js:53`; integrate P3 signature if accepted. No parallel relationship controller.
- **Sketch:**
  1. Reuse existing dispatch and completion records, durations and caps.
  2. Replace each wisp core with a 12–16px cached crop of child's idle row 6 and its stable signature.
  3. At completion, use the existing return path and one parent receive pose; never move the domain child or pretend an absent child is still active.
  4. Parent receive is one static open-ledger beat, bounded to the lifecycle cue window; optional companion row 9 after P4.
  5. No extra orbiters or particles; replace the existing mote core and completion flash budget.
  6. Burst completion folds overflow to an exact child count, using existing max-eight admission rather than eight overlapping portraits on one parent.
  7. Reduced motion paints child's static signature next to parent for existing reduced completion duration, no path/timer animation resources.
  8. Canvas upper annotation remains shared across GPU/Canvas; depth-sensitive full bodies retain normal sorting.
- **Cost:** M. <0.15 ms CPU and <0.1 ms GPU at eight cues; <=64 KiB mini-crop cache if tightly bounded. Assets: optional one receive row; child miniatures use existing sheet pixels.
- **Risk:** “Returned” does not mean “succeeded”; retain neutral completion vocabulary unless `outcome:verified` separately supports success. Use snapshot pixels so disposed child sprite resources do not become dangling references. At 100 agents only selected family gets miniatures; other families keep current bounded cues.
- **Wow 1–5 / Informative 1–5:** **5 / 4**.
  - Wow: the familiar is recognisably the person who left, making an execution tree emotionally legible without fictional feelings.
  - Informative: immediately answers whose child completed and which parent received it.

### P6 — Context pressure as a compressed memory ledger

- **Pitch:** Replace ambiguous stress ornament on the selected worker with a physical memory ledger that visibly fills from real context usage.
- **What the operator sees:** A compact ledger at the belt gains stepped page blocks as known context grows; near capacity its clasp is visibly tight. Selected detail says `156k / 200k tokens`, not an attention percentage or a fabricated emotional adjective.
- **Real data it renders:** `tokens.contextWindow`, `tokens.contextWindowMax` (`AgentSprite.js:3412–3417`). Existing anxious/tired mood remains telemetry-derived, but neither is treated as a direct claim about the model's subjective fatigue (`AgentMood.js:216–244`).
- **Files touched:** `AgentSprite.js:3412–3430,3503–3525,1857`, `AgentGpuOverlayRenderer.js:53`, `Compositor.js:59`; share attachment slot with P2 rather than simultaneously drawing two books.
- **Sketch:**
  1. Read and quantise known context only on Agent update; unknown capacity produces no ledger gauge.
  2. Use three stepped fill stages at existing pressure bands; static page blocks, no smooth bar.
  3. Selected/hovered detail shows counts in the existing contextual annotation slot.
  4. If P2 exists, one ledger attachment changes inspection mode rather than adding a second stack at the same belt.
  5. Retire selected-agent sweat/jitter when this ledger owns the pressure cue; do not make stress progressively more frantic.
  6. Preserve error/wait primary marks and any existing context disclosure outside the character layer.
  7. Static band, no new cadence; reduced motion identical.
  8. At crowd LOD suppress routine ledgers; retain only the existing primary pressure treatment selected by salience policy. Canvas and GPU use the same attachment geometry.
- **Cost:** S/M. <0.05 ms CPU/GPU for selected/hovered bodies; <16 KiB geometry cache. Assets: no, pixel-snapped parchment/clasp shapes.
- **Risk:** A ledger can be confused with P2's file count; these are alternatives in one attachment slot, clearly disclosed on selection, not two simultaneous undocumented metaphors. This is a replacement/refinement of shipped context visualization, not a new fatigue feature. Counts must retain unknown/partial semantics.
- **Wow 1–5 / Informative 1–5:** **3 / 4**.
  - Wow: a constrained, physical capacity metaphor is more crafted than another ring.
  - Informative: gives a verifiable reason for the posture without asserting sentience or emotion.

### P7 — Shared-route formations, only when the team really gathers

- **Pitch:** Make a real team-gather event briefly travel as a loose file whose members keep their individual identity and destination.
- **What the operator sees:** Three related agents converge into a staggered walking file along a shared road, separate at a junction, then occupy their already-assigned meeting slots. It reads as coordination rather than synchronised marching for entertainment.
- **Real data it renders:** `team:gather` payload `members`, `plazaTile`, `centroidArc`, `teamName`, `ts`; existing target-slot derivation (`VisitIntentManager.js:775–815`) and per-agent behavior intent/currentPhase (`AgentBehaviorState.js:169–208`). Team membership alone is insufficient.
- **Files touched:** `VisitIntentManager.js:775`, `AgentBehaviorState.js:169`, `AgentSprite.js:1058,2305`; reuse existing pathfinder weight vocabulary (`Pathfinder.js:3–13`) and allocated destinations. No building changes.
- **Sketch:**
  1. While a gather intent is live, identify members sharing the next route segment.
  2. Rank those members by stable id, not guessed hierarchy; keep existing slot indices for the final meeting.
  3. Apply small bounded progress offsets along the shared segment, never geometric side offsets into blocked terrain.
  4. Let local avoidance and incident priority break formation immediately; never wait for a missing/offscreen teammate.
  5. Keep individual seeded gait phase; do not synchronise footfalls.
  6. Dissolve on route divergence, new tool/alert intent, or gather expiry.
  7. This is event-driven travel, not a repeating pulse; reduced motion uses existing snapped destinations/static team relation, with no formation path allocation.
  8. GPU/Canvas share world positions and existing walk rows 0–5. At 100 agents allow only one selected team and at most six walkers in formation.
- **Cost:** M/L. Update shared-route membership on intent/path changes, not all-pairs each frame. Target <0.2 ms CPU/frame for six members, no added GPU passes, <8 KiB formation state. Assets: no.
- **Risk:** Existing gather is itself presentation inference (confidence 0.8, `VisitIntentManager.js:802`); do not imply command dependencies or leader/follower roles. Movement must not delay real status response or route through water. Less robust than the top three: defer if local avoidance cannot retain truthful paths cheaply.
- **Wow 1–5 / Informative 1–5:** **4 / 3**.
  - Wow: small purposeful convoys create a real sense of social coordination.
  - Informative: reveals a live gather relationship, but is less exact than a visible held tool or observed-file count.

## Top three

1. **Hands that actually do the work.** The most consequential frontier is not more effects: it is authored body action. Existing implementation already has almost every suggested prop, but idle/walk source rows prevent an actual reading, typing or testing body. A tightly bounded mage/engineer action companion establishes whether physical hand contact can transform the experience before committing to roster-wide art. Keep the body and grip one visual unit; do not add another generic icon beside a hand.

2. **A hundred stable signatures, not a hundred new sheets.** This directly attacks what shot 06 cannot deliver: tracking a familiar individual when bodies shrink. Existing deterministic colors and phase offsets are valuable and should survive; small shared signature stamps make that identity persist through backend and LOD changes. The test is not “100 unique skins.” It is whether an operator can follow the same marked person across zoom without depending on an ocean of nameplates.

3. **The working set becomes carried folios.** This has the best signal-to-effort ratio: exact bounded data already exists, it explains what a person is carrying between semantic places, and it does not require an animation loop. It makes a real operational distinction—observed reads versus writes—visible in the world. Keep it modest and count-honest; never inflate the bundle into an unsupported diff-size or productivity claim.

## Rejected

- “Add read books, Forge hammers, thought glyphs, or verified celebration”: already exists as procedural vocabulary (`AgentSprite.js:6356–6575`; `ActionVocabulary.js:45–68`). Only contact/body/parity refinements are new.
- “Make id-hash variations so 100 agents stop being clones”: already implemented with four palette variants and seeded animation (`AgentSprite.js:786–792,5038–5041`). Preserve and extend, do not reset identity.
- Random moods, sleepiness or barks: violates no-invented-flavour; real mood derivation and attributed speech already exist (`AgentMood.js:187–247`; `AgentSprite.js:5821–5856`).
- Sleeping merely because a session is old: waiting, working, completed and stale observation are different; an elapsed threshold alone would imply a state not established by the source.
- More context sweat, frantic fidget or a second pressure ring: existing strain and mood mechanisms already cover it; more animation reduces diagnostic clarity (`AgentSprite.js:1857–1878,3412–3430,3503–3525`).
- Test-pass dance triggered by command name or completed status: no proof of outcome. Verified outcome kinds currently exclude a generic test event (`VerifiedOutcome.js:3–4`); authoritative adapter result coverage must precede that proposal.
- Generic subagent spawn/return sparkle: existing dispatch, merge and completion controller already owns this (`ArrivalDeparture.js:140–204`). P5 upgrades identity continuity instead.
- Hero portrait card as a new headline feature: shared compositor and existing panel/avatar already provide the obvious first version (`Compositor.js:26–33`; shots 04/05); DOM chrome is outside this territory.
- Umbrellas and night lanterns on every agent: weather/time can be real inputs, but the prop mainly repeats atmosphere, occludes defining headgear and competes with a tool hand. No operator question strong enough to justify the silhouette cost here.
- More footsteps/dust: terrain-aware stride particles are already present (`AgentSprite.js:2290–2342`). Adding them again is noise.
- Full 100-agent hero bodies or unique per-id composed sheets: destroys the crowd/readability and cache budgets already visible in the compact GPU policy (`AgentSprite.js:2732–2738`; `Compositor.js:10–11`).
- Smooth skeletal squash/stretch or cloth shaders: incompatible with the stepped pixel silhouette and additive-only engineering intent; authored frames are the better boundary.

## Open questions for the coordinator

- Most helper captures predate improved quality diagnostics; do not use null PostFx fields as evidence that FULL failed. Replacement shot 03 reports level 0 within-budget after 12 seconds on the shared host; this alone supports no ladder-performance conclusion.
- Corrected mixed-tools shot 03 now provides a zoom-3 chat/body comparison; shot 07 adds a cast overview at final zoom 1. A controlled near Read/Edit/Shell pose cut is still needed before selecting an art brief; the current sheet limitation itself is established directly in code.
- Source confirms generic action overlays but no nine-gesture call in `AgentGpuOverlayRenderer.js:53–57`. Is another GPU atlas-preparation path intentionally baking rituals, or is that parity genuinely absent? Do not call it a reproduced rendering bug without a controlled live ritual cut in both backends.
- Which model profiles have hand/weapon pixels safely separable for P1? Manifest prompts show both baked gear and empty-handed profiles (`manifest.yaml:108,153`); do not assume one attachment rule fits the roster.
- Can the current mark governor lend a selected count slot to P2/P6 without more visual chrome? These proposals should trade one cue for another rather than merely increase the census.
- Are collision/working-set snapshots sufficiently fresh and explicitly bounded in all providers to label “observed files” identically? The domain cap and op schema are verified; no new provider audit was performed.
- P7 is intentionally lower-confidence: shared-road formation must earn its place with stable local avoidance and genuine gather provenance, not evolve into decorative military choreography.
