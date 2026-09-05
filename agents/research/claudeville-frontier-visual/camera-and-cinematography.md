## Territory and method

Read-only camera/shot-language exploration; no runtime implementation, assets, tests, gates, or server lifecycle actions. All retained writes are this note and its six JPEGs. Paths below are repository-relative; code anchors are from the inspected checkout, not historical plan line numbers.

Files read: `AGENTS.md`; `claudeville/CLAUDE.md`; the character-mode, dashboard-mode and shared presentation `README.md` files; `agents/README.md`; `docs/visual-experience-crafting.md`; `docs/world-visual-qa-checklist.md`; `docs/rendering-baselines.md`; `docs/motion-budget.md`; the building-style and material-channel contracts; relevant search matches in the Fable enhancement and Astra refinement plans; `agents/plans/open-followups.md:96-114`; `Camera.js`; `CameraDirector.js`; `VillageDirector.js`; camera/selection portions of `IsometricRenderer.js`; overlay/letterbox portions of `WorldFrameRenderer.js` and `VillageDirectorOverlay.js`; structural summaries and constants of `TrailRenderer.js` and `DebugOverlay.js`; `ModeManager.js`; `ChronicleLog.js`; waiting fixture metadata in `__simfixture__/WorldScenarios.js`; the research capture helper. Unless qualified, presentation filenames below are under `claudeville/src/presentation/character-mode/`.

Captures, all visually inspected at 1920×1080, DPR 1, on the maintained localhost server using the helper:

- `agents/research/claudeville-frontier-visual/shots/camera-and-cinematography-01.jpg`: waiting-on-user, helper wait 3 seconds; Bellkeep followed while moving toward Command.
- `agents/research/claudeville-frontier-visual/shots/camera-and-cinematography-02.jpg`: same fixture, independent load, 15-second wait; settled Command-side composition.
- `agents/research/claudeville-frontier-visual/shots/camera-and-cinematography-03.jpg`: same fixture, independent load, 40-second wait; essentially the same settled composition.
- `agents/research/claudeville-frontier-visual/shots/camera-and-cinematography-04.jpg`: real operator feed, 15-second wait; 17 agents, zoom 1, no selected detail panel.
- `agents/research/claudeville-frontier-visual/shots/camera-and-cinematography-05.jpg`: waiting fixture, renderer selection explicitly cleared before a 55-second wait; wide context is still not restored into a village overview, and the existing detail panel remains visible.
- `agents/research/claudeville-frontier-visual/shots/camera-and-cinematography-06.jpg`: waiting fixture in Dashboard, 3-second wait after switch; selected Bellkeep expanded.

Every helper run reported `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)` and no console/page errors. Runs 01–04 overlapped each other and other explorers; these are loaded-host visual evidence, not FPS benchmarks. Earlier helper diagnostics returned null PostFx level; null is not evidence that the GPU path failed. Updated helper 06 reported worldRendererMode webgl and qualityLevel 2/healthy-probe, but World was hidden: that is not an active Dashboard GPU benchmark. Waits occur after the helper's readiness/setup delay, not exactly 3/15/40 seconds after the fixture's first event; on-screen ages show this.

A separate read-only browser inspection exercised World → Dashboard → World through DOM button clicks: Dashboard had `display`-hidden World and `cv-mode-fade-in`; returning preserved `sim-user-bell`. Direct automation clicks timed out despite the observed button; DOM clicks succeeded. No judgment about continuous pan smoothness is claimed from stills.

## Current state

### The actual state machine

- **Automatic policy is not the camera itself.** CameraDirector defaults autoMode on, listens to `village:camera-cue`, and can be disabled (`CameraDirector.js:229-259`). IsometricRenderer restores `cv-auto-camera` and subscribes to `camera:auto-camera` (`IsometricRenderer.js:1637-1638,1739-1740`). Camera separately owns follow, glide, wheel tween, momentum, idle drift and empty tour (`Camera.js:89-135`). Therefore “automatic camera off” should not be assumed to disable every motion family.
- **Establish:** live work plus associated buildings → hot buildings → any agents → buildings (`IsometricRenderer.js:2588-2624`). First frame holds wide for 1.2 seconds, then glides for 2.8 seconds; subsequent explicit reframes glide 700 ms (`Camera.js:336-351`; `IsometricRenderer.js:2630-2655`). Auto framing supplies maxZoom 1.5, not a resting 1.5× promise. Resting tiers remain integer backing-pixel aligned (`Camera.js:31-64,71-75`).
- **Follow:** selection captures the prior pose, follows the chosen sprite, and deselection restores the pose only if genuine-input timestamp is unchanged (`IsometricRenderer.js:4071-4091`). Follow enters through a 650-ms cubic glide and, if below detail tier, a 380-ms zoom toward tier 2, then smooth-follow at dt-adjusted 0.08 (`Camera.js:429-446,489-516`). Follow blocks automatic Director moves indefinitely (`CameraDirector.js:338-345`).
- **Manual:** drag/wheel records genuine input, aborts Director glide and idle drift; drag stops follow. Wheel steps tiers over 150 ms, cursor anchored; momentum decays after release (`Camera.js:542-642,880-894`). Merely leaving the controls alone does not preserve ownership forever: event reframing may resume after 30 seconds, ordinary reframing after 45 seconds for a user-owned pose (`CameraDirector.js:335-357`).
- **Idle focus:** every 3 seconds when eligible, score agents using spatial centrality, neighbor count and activity; sparse groups of up to three frame together. Focus retention has a 40-second dwell unless a substantial score/context gain occurs; ordinary moves require 30 seconds input-free for system-owned camera, 45 for user-owned, a 14-second move cooldown, and distance no greater than 720 world pixels (`CameraDirector.js:4-22,127-226,270-304,335-372`). Comfortable framing cancels the move; pan is preferred and automatic zoom-in disabled (`CameraDirector.js:288-300,362-396,414-445`). This is a conservative attention nudge, not a rotating tour.
- **Event scenes:** VillageDirector is actually in character-mode, not the task's application path. It consumes real lifecycle/tool/team/chat/quota/harbor events (`VillageDirector.js:117-135`). Incident points are combined, release targets Harbor, and freshest arrival gets a cue (`VillageDirector.js:370-418`). The incident cue signature is only incident-point count; scene snapshot incidents are capped at six (`VillageDirector.js:384,923-962`). A same-count change can therefore be missed by cue deduplication [INFERENCE]. Director's global event cooldown is 15 seconds; comfortable scenes do not move; event glides last 3.8–7 seconds (`CameraDirector.js:306-332,375-396`).
- **Letterbox:** already shipped, not a frontier proposal. Only cue:release and cue:incident own bars; height reaches min(72px, 8% viewport), multiplied by glide bell-curve weight. Bars disappear on arrival rather than holding a narrative shot (`WorldFrameRenderer.js:937-960`). Under reduced motion CameraDirector suppresses automatic moves entirely, despite a stale letterbox comment suggesting cuts (`CameraDirector.js:306-311`). Explicit Camera glides can snap (`Camera.js:303-312`).
- **Long idle:** an 8-world-pixel Lissajous drift starts after 45 seconds with no other camera owner; an empty-village tour uses 20 seconds empty plus 40 seconds user-idle, 9-second glides and 7-second dwells. Both are already shipped (`Camera.js:7-29,897-930,1010-1041`). Do not re-propose a generic Ken Burns circuit.
- **Replay:** R's documented last-minute replay is trails over the present, not time travel (`docs/world-visual-qa-checklist.md:38-41`; `VillageDirector.js:206-219,789-809`). Samples contain id/provider/status/team/tool/x/y, every 750 ms, capped at 72 agents and 60 seconds (`VillageDirector.js:10-22,789-839`). Persisted trail constants separately retain an hour and at most 12,000 total samples; routine historical trails are intentionally not visible (`TrailRenderer.js:5-19`; `docs/rendering-baselines.md:89-99`). Chronicle records actual event timestamps, kinds, identities and extra fields but not full historical world state (`claudeville/src/application/ChronicleLog.js:362-387`).
- **Orientation:** the minimap was deliberately removed, and four bounded offscreen cue markers live for eight seconds, clickable to glide (`VillageDirectorOverlay.js:629-699`). A new map must earn back its space rather than resurrect old chrome.
- **Mode transition:** outgoing container is hidden immediately and incoming container gets a 180-ms fade; reduced motion is an instant cut, not a wipe or morph (`claudeville/src/application/ModeManager.js:26-48`). World stops while Dashboard is active (`character-mode/README.md:158`). Selection continuity worked in the browser probe and appears in capture 06.

### Art-director judgment

Captures 01–03 have a strong hero axis: Bellkeep, the bell and the waiting banner form an unmistakable vertical sentence. The bridge's diagonal gives depth and arrival direction. But the hero is a status effect more than a person: the pale stack visually consumes the body, and the close crop loses much of the village's semantic geography. 02 and 03 are almost the same shot, with only small animation changes. That is correct for a selected waiting agent, not proof of a broken Director: fixture metadata explicitly selects Bellkeep and asks for zoom 2.7 (`WorldScenarios.js:746-749`), applied before follow (`IsometricRenderer.js:2713-2730`). Its measured settled zoom 3 does not violate the automatic 1.5 cap.

Capture 04 is the better second-monitor picture: a recognizable group at Tasks, another at Command, and work happening between them. It is beautiful as a populated diorama, but not yet an edited story. Many equally weighted names/bubbles form a busy horizontal band, while Portal is quieter and the large Archive is clipped. The frame says “people here,” not “this is the dependency that just changed.” Capture 05 confirms clearing renderer selection alone is not a controlled test of ambient auto eligibility; a retained detail panel consumes the right side and zoom remains 3. Do not infer an automatic Director failure from it.

Capture 06 is a clean informational cut into rows; the matching identity is useful, but spatial continuity disappears. A World-controls onboarding tip also remains over Dashboard in that capture. A full world-to-table morph would be an excessive solution to the comparatively small continuity gap.

There is already shot vocabulary—establish, follow, gentle reframe, incident/release bars—but little **sequence grammar**. The frontier is choosing and preserving a meaningful sequence, not adding more camera motion.

## Proposals

All costs below are engineering estimates, not measurements. Universal proposed no-theft rule: explicit operator mode choice grants ambient ownership; any pointer-down/wheel/navigation key, text selection, modal opening, or agent/building selection revokes it immediately. Do not regain ownership on a timer after an explicit manual intervention: show a static Resume ambient control. Existing normal Auto behavior may remain separate. No new periodic pulse is required; shot glides are one-shot slow-band motion, static fallbacks use the static band. All proposals keep zero-build vanilla JS and the existing WebGL2/Canvas architecture.

### P1 — The working-village broadcast

- **Pitch:** Turn opt-in ambient viewing into a real sequence of work chapters, not a circuit of landmarks.
- **What the operator sees:** A wide shot of active districts, a patient lateral move toward the busiest current work group, then an earned incident or handoff shot, then a return to the wide; a small factual caption says “Forge · 4 working”.
- **Real data it renders:** VillageDirector agent snapshot `building`, `status`, `currentTool`, `parentSessionId`, `teamName`, `moving`, `x/y`; `buildingSignals`; current incident and handoff snapshots (`VillageDirector.js:852-902,905-920`).
- **Files touched:** `CameraDirector.js:270-304` for shot selection; `Camera.js:273-334` for execution; `VillageDirector.js:307-356` for existing snapshot; `WorldFrameRenderer.js:744-755` for the restrained caption.
- **Sketch:**
  1. Add explicit Ambient alongside existing Auto, not a silently timed takeover.
  2. Compute building cohorts once per snapshot, retaining only live work.
  3. Pick wide/context/detail roles; never visit an empty building just to fill time.
  4. Hold 18–30 seconds; require changed real context before replacing a comfortable shot.
  5. Return to the same wide composition after at most two detail chapters.
  6. Keep integer settled zoom and existing automatic cap; prefer long pans to repeated zooms.
  7. Revoke on universal no-theft inputs; no unbounded event backlog.
  8. Reduced motion holds one static overview plus current counts; Canvas uses identical camera math.
- **Cost:** M; snapshot selection O(agents + buildings), target <0.2 ms per decision at 100 agents; per-frame camera arithmetic negligible, but world redraw cost must be measured. <16 KB scheduler state. No generated assets.
- **Risk:** A schedule can become meaningless television; forbid forced rotation with unchanged data. On MINIMAL/DISABLED retain static shots, not extra render passes. Group 100 agents by current building, never one shot per agent.
- **Wow 1–5 / Informative 1–5:** Wow 5 — the village begins to edit itself like a patient documentary. Informative 4 — repeated context shots teach where work is concentrated.

### P2 — The complete attention frame

- **Pitch:** Frame every current action-needed cohort deliberately, rather than the six incidents that happen to survive a visual snapshot cap.
- **What the operator sees:** A quiet wide composition with the oldest waiting cohort on one third and remaining waiting cohorts included; if the geometry cannot fit, a count says “3 waiting outside view” with a direction, not an invisible omission.
- **Real data it renders:** Full live agent `status`, `awaitingSince`, id and sprite x/y; awaitingSince is used by Chronicle status handling (`ChronicleLog.js:300-303`); current framing has full-agent collection (`CameraDirector.js:106-124`).
- **Files touched:** `CameraDirector.js:106-124,209-226,335-445`; `Camera.js:799-838`; `VillageDirector.js:374-388`; `VillageDirectorOverlay.js:717-727`.
- **Sketch:**
  1. Build complete action-needed set before visual scene caps.
  2. Rank waiting by real awaitingSince; unknown age remains unknown, not zero.
  3. Fit padded sprite/bubble bounds against usable viewport, not just center points.
  4. Test one-third and centered anchors; choose only a bias that retains inclusion.
  5. At minimum zoom, report offscreen counts instead of claiming full inclusion.
  6. Deduplicate on cohort identities/status transitions, not incident count alone.
  7. Only move in explicit Ambient or on operator Frame attention command; normal interaction wins.
  8. Reduced motion uses static counts and an explicit snap command; Canvas parity is mathematical.
- **Cost:** M; O(n) bounds and a constant number of candidate poses, <0.3 ms per 650-ms snapshot target; <32 KB. No assets or new GPU work.
- **Risk:** One distant outlier may dilute the shot; counts preserve honesty when fitting is impossible. Must not let error visual caps hide waiting agents at 100 residents. Thirds are a preference, not a correctness constraint.
- **Wow 1–5 / Informative 1–5:** Wow 4 — a crowd suddenly resolves into an intentional composition. Informative 5 — no omitted waiting cohort masquerades as “all clear”.

### P3 — A truthful incident shot and return

- **Pitch:** Replace generic travel-time cinema with a short, factual incident chapter that has an arrival, a readable hold, and a return address.
- **What the operator sees:** In Ambient, a rejected push earns a single Harbor/Watchtower-context shot, a held “Push failed” caption and affected project, then a return to the prior wide; active operators see only the existing edge cue.
- **Real data it renders:** Existing failed-push scene from harbor state, scene `kind`, `building`, `startedAt`, `expiresAt`; incident/release cue boxes (`VillageDirector.js:180-188,374-418`). Project association must be carried from real harbor payload, not guessed from camera proximity.
- **Files touched:** `VillageDirector.js:370-418` cue payload; `CameraDirector.js:306-332`; `Camera.js:456-471` saved pose; `WorldFrameRenderer.js:937-960` letterbox hold.
- **Sketch:**
  1. Give eligible cue a stable incident identity and factual caption.
  2. Save pose plus input epoch once, only while Ambient owns the frame.
  3. Use short glide for nearby incident; allow a discrete cut only in explicitly enabled broadcast editing.
  4. Hold caption for 3 seconds after settling, rather than bars vanishing at arrival.
  5. Return only if input epoch and camera owner still match the shot.
  6. Coalesce concurrent incident cohorts; never queue a parade over unresolved waiting.
  7. Reduced motion suppresses auto shot and bars; retain static edge cue and explicit jump.
  8. Canvas draws identical chrome; no new effect or camera shake.
- **Cost:** M; constant scheduler state, <8 KB, near-zero extra CPU/GPU beyond current glides and four rectangles. No assets.
- **Risk:** Existing letterbox is already shipped; the delta is hold/return/identity, not “add cinema”. Bars must reserve safe subject space. At 100 agents retain at most one active chapter and an exact coalesced count.
- **Wow 1–5 / Informative 1–5:** Wow 4 — the dramatic moment gains readable punctuation. Informative 4 — operator sees cause, location and return context instead of unexplained travel.

### P4 — Wide shot with a pinned witness

- **Pitch:** Offer a deliberately bounded selected-agent inset without abandoning the wide operational view.
- **What the operator sees:** A 240×160 pixel-framed witness window shows the selected agent and immediate destination context; main World continues its wide shot, with matching identity on both surfaces.
- **Real data it renders:** Selected id, sprite x/y and currentTool/status (`IsometricRenderer.js:4071-4084`; `CameraDirector.js:115-122`).
- **Files touched:** `IsometricRenderer.js:4071-4091` optional inspect-without-follow path; `WorldFrameRenderer.js:744-755` inset compositing seam; new `AgentWitnessInset.js` under character-mode.
- **Sketch:**
  1. Make “Pin witness” explicit; ordinary click still follows normally.
  2. Render a bounded local view, not a crop of the wide framebuffer that may omit the agent.
  3. Reuse resident sprite/scene data, one viewport/scissor, never a second world update.
  4. Do not duplicate detail polling or user interaction inside the inset.
  5. Cap refresh at 8 Hz; reserve one witness only and a 240×160 backing budget.
  6. Under ladder pressure replace scenery with the existing avatar plus factual status.
  7. Reduced motion uses fixed pose, refreshed only on meaningful state changes.
  8. Canvas fallback uses existing sprite draw plus small local landmarks, never a second full render.
  9. Any manual main-camera input suspends ambient; inset remains pinned until dismissed.
- **Cost:** L; <0.5 ms per 8-Hz refresh target, up to two RGBA 240×160 buffers ≈300 KiB plus metadata; no new decoded sprite copies or generated assets.
- **Risk:** A second surface threatens native-resource accounting and duplication; treat as conditional until measured. At 100 agents still one inset. Prefer P2 before funding this. The OF-003 ownership seam becomes relevant; no WebGPU/OffscreenCanvas claim.
- **Wow 1–5 / Informative 1–5:** Wow 5 — overview and character intimacy coexist. Informative 4 — selected work remains legible without sacrificing other incidents.

### P5 — The Chronicle's honest contact sheet

- **Pitch:** Make “a day in the village” an event-based visual recap rather than pretending to have recorded a continuous day of world motion.
- **What the operator sees:** A strip of timestamped chapters—arrival, waiting, resolved, commit, push—opens static semantic-place compositions with the actual agent identity and recorded facts; Play advances between chapters, with “recorded events, not video” always clear.
- **Real data it renders:** Chronicle `ts`, `kind`, `agentId`, `agentName`, `provider`, `project`, `reason`, `tool`, `waitedMs`, `sha`, `label` (`ChronicleLog.js:279-303,323-343,362-387`).
- **Files touched:** `claudeville/src/application/ChronicleLog.js:362-387` record contract intentionally unchanged; `CameraDirector.js:229-246` explicit replay owner integration; `VillageDirector.js:206-219` distinguish trail replay; new `ChronicleShotPlayer.js`.
- **Sketch:**
  1. Read a bounded Chronicle interval through existing store ownership.
  2. Group related events by identity and time; never manufacture intermediate positions.
  3. Map event kind to stable semantic building only when the mapping is truthful.
  4. Mark unknown historical destination as a neutral identity card, not invented geography.
  5. Present contact-sheet chapters; optional playback advances discrete shots.
  6. Keep current-live data separate and a visible Return live command.
  7. Operator steering pauses playback immediately; exiting restores pose only if unchanged.
  8. Reduced motion is manual chapter selection; Canvas renders the same static chapters.
- **Cost:** L; O(events) preprocessing outside frame, cap 256 loaded chapters and page older intervals; estimated <256 KB metadata plus one bounded thumbnail cache, not screenshots of a whole day. No generated assets.
- **Risk:** Historical state cannot be reconstructed from today's Chronicle; exact event captions are essential. At 100 agents group by project/incident episode rather than replaying 100 arrivals. Do not market this as a true time lapse.
- **Wow 1–5 / Informative 1–5:** Wow 4 — the village becomes a readable illustrated memory. Informative 5 — answers “what happened while I was away?” without fake history.

### P6 — A survey map, only when asked

- **Pitch:** Reintroduce spatial orientation as a momentary functional survey, not a permanent parchment decoration.
- **What the operator sees:** Holding an explicit Map control opens a crisp 220×150 schematic with recognizable building glyphs, current viewport polygon, agent dots and waiting counts; releasing closes it without moving the world.
- **Real data it renders:** World buildings, sprite x/y/status, camera projection and viewport bounds (`Camera.js:645-682`; `VillageDirector.js:852-872`).
- **Files touched:** `VillageDirectorOverlay.js:629-699` coexist with—not replace—event edges; `WorldFrameRenderer.js:744-755`; `Camera.js:665-682`; new `WorldSurveyOverlay.js`.
- **Sketch:**
  1. Generate schematic island/roads from world geometry once, using existing palette.
  2. Do not generate parchment art; a small pixel border is enough.
  3. Aggregate colliding routine dots into counts; retain distinct waiting markers.
  4. Draw live viewport polygon from screen-to-world corners.
  5. Update dots at 2 Hz only while open, no continuous animation.
  6. Clicking is an explicit frame command and revokes ambient ownership.
  7. Keyboard exposes building choices and counts in DOM; pointer-free access is required.
  8. Reduced motion and Canvas use exactly this static view, no radar sweep.
- **Cost:** M; 33,000 RGBA pixels ≈129 KiB, O(n) at 2 Hz, <0.2 ms update target. No generated assets.
- **Risk:** A removed feature must earn its return; measure whether existing edge cues plus Frame content already suffice. At 100 agents use counts, not unreadable dots. No idle display acreage tax.
- **Wow 1–5 / Informative 1–5:** Wow 3 — restraint makes the world feel like an operable map. Informative 4 — orientation remains available without moving a carefully composed camera.

### P7 — The identity match-cut

- **Pitch:** Carry one selected identity across World and Dashboard rather than morphing the whole village into rows.
- **What the operator sees:** A small fixed identity lozenge remains in place for the 180-ms switch, then the matching Dashboard row receives a static outline; returning World retains the same identity and prior composition.
- **Real data it renders:** Existing selected agent id and mode:changed (`ModeManager.js:19-24`; `IsometricRenderer.js:4071-4091`; dashboard README:37-45).
- **Files touched:** `claudeville/src/application/ModeManager.js:26-48`; `claudeville/src/presentation/shared/AgentSelection.js` existing selection seam documented in shared README:16,30-35; `WorldFrameRenderer.js:744-755` identity location publication if needed.
- **Sketch:**
  1. Capture selected id, not a screenshot or a copied agent record.
  2. Keep a tiny DOM identity chip across the existing incoming fade.
  3. Mark the matching destination row without stealing keyboard focus.
  4. Do not animate the entire scene or keep World rendering behind Dashboard.
  5. Cancel transient chip on a second mode change; latest mode always wins.
  6. No selection means plain existing transition, no fabricated hero.
  7. Reduced motion uses an immediate switch and static destination outline.
  8. No camera ownership change beyond the explicit switch; Canvas parity is automatic.
- **Cost:** S/M; one DOM node and one bounded layout lookup per switch, zero per-frame world work, negligible memory. No assets.
- **Risk:** Duplicating name badges can add noise; keep chip short-lived and omit if row is already obvious. 100 agents may place row offscreen: indicate selected identity without forced scroll unless the operator requested focus.
- **Wow 1–5 / Informative 1–5:** Wow 3 — a precise match-cut feels crafted rather than spectacular. Informative 4 — orientation survives the change of representation.

### P8 — Chaptered last-minute replay

- **Pitch:** Turn the existing trail replay into a bounded, operator-scrubbable causal view of the last minute.
- **What the operator sees:** A clearly marked past-time cursor shows recorded agent positions and tools; chapters mark status changes and handoffs, while a small static Live count remains distinct from replay counts.
- **Real data it renders:** Existing VillageDirector samples `ts`, points `id/provider/status/teamName/tool/x/y` (`VillageDirector.js:789-809`), plus current real scene events where timestamps overlap. No historical buildings, lighting or git state is inferred.
- **Files touched:** `VillageDirector.js:206-219,789-839`; `TrailRenderer.js:129-160` shared trail vocabulary; `WorldFrameRenderer.js:744-755` replay badge; `CameraDirector.js:335-345` explicit replay ownership.
- **Sketch:**
  1. Freeze a bounded copy of the retained minute when entering replay.
  2. Show “recorded 72 of 100” when the existing sample cap excludes residents.
  3. Use a distinct cursor and ghost/status-only marks, not simulated live agents.
  4. Scrub recorded points; do not infer missing tool transitions between samples.
  5. Reframe only on explicit chapter click; playback does not seize manual camera.
  6. Keep live counters separately labeled and do not mutate World or simulator.
  7. Reduced motion is manual discrete sample stepping, no trail walkers.
  8. Canvas uses the same bounded ground/overlay cues; release the snapshot on exit.
- **Cost:** M/L; up to roughly 80×72 points retained, estimated 0.5–1.5 MB JS snapshot depending representation; target <0.3 ms cursor lookup, redraw cost existing cue budget. No assets.
- **Risk:** “Replay” must not imply full historical simulation. Recorded cap and sampling gaps must be prominent at 100 agents. GPU cue texture invalidation can become the bottleneck; do not restore ambient history caches.
- **Wow 1–5 / Informative 1–5:** Wow 4 — seeing where a handoff happened gives the recent minute spatial memory. Informative 5 — separates what changed from what merely looks busy now.

## Top three

1. **The complete attention frame.** Most immediate operator value and strongest correctness boundary. It improves the real camera without buying another graphics system: complete input membership, usable-viewport geometry, and truthful offscreen counts. It also supplies the framing primitive needed by the larger broadcast idea. The frontier is not thirds by itself; it is a composition that can honestly say what it includes.

2. **The working-village broadcast.** Best second-monitor leap. Existing glides are competent, but an event-paced sequence would make the world a readable program rather than a moving desktop background. Explicit ownership and real activity prevent ambient viewing from becoming camera theft or purposeless touring. This is where a glance can tell a story with no click.

3. **The Chronicle's honest contact sheet.** Most valuable longer-range extension: visual memory without pretending that a live renderer is a video recorder. It is distinct from the shipped replay trails and requires disciplined uncertainty presentation. I prefer this to a literal day-long time lapse because the existing event record supports it honestly and its cost is bounded.

## Rejected

- **Generic ambient building tour:** already present for an empty village (`Camera.js:14-29`); activity-free movement repeats shipped work and violates the meaning-first direction.
- **Automatic smash cuts on every error:** camera theft, spatial disorientation, and incident storms; P3 permits a bounded edited chapter only in explicitly chosen broadcast viewing.
- **Camera shake for real errors:** the real event does not justify displacing every unrelated entity; it impairs reading and click accuracy. A zero-camera-shake budget is the right budget.
- **Smooth tilt-shift depth of field:** breaks nearest-sampled art and can blur the very offscreen/foreground evidence the operator needs (`material-channel-contract.md:13-16`).
- **Stepped blur as a loophole:** nearest-sampled low-resolution strips still erase sprite/text information and manufacture a photographic lens on a semantic map. Not acceptable by default; no demonstrated informational gain outweighs the added pass. Static composition/mark hierarchy is preferable.
- **Parallax far shore or sky:** no real data source in this territory; generated distant shore was explicitly built and cut (`agents/README.md:24`). Moving it does not give it meaning.
- **Whole-world-to-Dashboard morph:** requires fabricated spatial correspondences between buildings and project-grouped rows, holds expensive resources across mode suspension, and delays an operational switch. P7 carries only the truthful invariant: identity.
- **Permanent parchment minimap:** removed map already has bounded edge-cue replacement (`VillageDirectorOverlay.js:629-639`); P6 is explicit-demand only and must beat that baseline.
- **True whole-day time lapse from Chronicle:** impossible to promise from event rows without historical positions/environment; label event chapters honestly instead (`ChronicleLog.js:362-387`).
- **WebGPU or OffscreenCanvas to fund cinematic features:** no numeric trigger established here for OF-007/OF-008 (`open-followups.md:96-114`). A loaded-host screenshot FPS is not that evidence.

## Open questions for the coordinator

- Decide whether explicit manual steering should suspend Ambient until Resume, while preserving today's timed Auto behavior separately. I strongly recommend separate modes rather than subtly changing ordinary Auto.
- The required waiting fixture starts selected and zoom-overridden; it tests follow, not free Director behavior. Captures 01–03 should never be presented as evidence that the Director chose a zoom-3 waiting closeup. Capture 05 cleared renderer selection but did not fully reconcile DOM selection or record auto eligibility, so the exact idle-director outcome remains unverified.
- No continuous-video evidence was retained. Source gives easing/duration; stills cannot establish micro-jitter or the feel of an actual incident cut. A later implementation review should record owner/input epoch/pose alongside a controlled pan sequence, without interpreting sampled FPS as smoothness proof.
- Verify complete action-needed source membership before implementing P2: current incidents are capped and incident cue signatures count points. The live agent status collection is the safer source; awaiting age must preserve unknowns.
- P4 creates an additional render surface and touches the conditional ownership question in OF-003. Fund only after a one-inset measurement demonstrates bounded resident resources and no duplicated full-world work.
- Chronicle chapters require inspecting existing store paging/retention APIs before final implementation design. This exploration verified record fields, not whole-day reconstruction or historical building ownership.
- Capture 06 shows a World-controls tip on Dashboard; shared-chrome owner should decide whether to dismiss it on mode switch. It does not warrant a cinematic morph.
