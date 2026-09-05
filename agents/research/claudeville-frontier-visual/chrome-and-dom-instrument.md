## Territory and method

Read-only exploration of the DOM frame, shared identity, Sidebar, Activity Panel, Dashboard, and their boundary with World. No runtime source, server, asset, test, or configuration changes. DESIGN.md and PRODUCT.md both exist. No validation, format, test, or server lifecycle commands were run.

Files read: `AGENTS.md`; `agents/README.md`; `claudeville/CLAUDE.md`; the character-mode, dashboard-mode, and shared READMEs; `DESIGN.md`; `PRODUCT.md`; `docs/visual-experience-crafting.md`; `docs/world-visual-qa-checklist.md`; `docs/rendering-baselines.md`; `docs/motion-budget.md`; `docs/building-style-contract.md`; `docs/material-channel-contract.md`; relevant sections/search results across every file in `claudeville/css/`; `claudeville/index.html`; `shared/{TopBar,Sidebar,ActivityPanel,AgentPresentation,ModelVisualIdentity,Formatters,ChroniclePanel}.js`; `dashboard-mode/{DashboardRenderer,AvatarCanvas}.js`; `application/ModeManager.js`; `domain/entities/Agent.js`; `character-mode/AtmosphereState.js`; `__simfixture__/WorldScenarios.js`; both prior refinement/enhancement plans; the supplied capture helper.

Captures, all under `agents/research/claudeville-frontier-visual/shots/`, originally at 1920×1080, DPR 1, 12-second settling wait. After full-frame inspection, shots 02/07 were cropped without rescaling to 320×700 panel views, 04 to a 240×950 Sidebar view, 05 to a 1200×900 live World detail, and 08 to a 1200×600 Dashboard detail. These retained crops permit native-resolution inspection; 01/03/06 retain the complete frame.

- `chrome-and-dom-instrument-01.jpg`: mixed-tools, Atlas (`sim1`) selected; large world body alongside existing small hero portrait.
- `chrome-and-dom-instrument-02.jpg`: building-inspection-replay initially selected Marshal instead of retaining building selection; useful night chrome reference, not evidence of building mode.
- `chrome-and-dom-instrument-03.jpg`: original helper's Dashboard option silently remained in World; Astra approval panel provides a useful cross-provider identity reference.
- `chrome-and-dom-instrument-04.jpg`: 100 agents; Sidebar's first project fills the viewport and later projects disappear below the fold.
- `chrome-and-dom-instrument-05.jpg`: live operator feed, 16 agents at capture; real work titles and many similar armored characters.
- `chrome-and-dom-instrument-06.jpg`: corrected Dashboard via actual mode button; seven CLI houses and expanded Astra approval row.
- `chrome-and-dom-instrument-07.jpg`: explicit delayed `BUILDING_EVENTS.SELECTED` for Command; building Signal, Status, Purpose, and Occupants visible.
- `chrome-and-dom-instrument-08.jpg`: Dashboard rerun using the coordinator's repaired helper.

All eight runs reported `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)` and no console errors. The old helper's null hour/quality diagnostics were not evidence of missing atmosphere or disabled GPU; its mode method was stale (the initially read `capture.mjs:61-63` used `setMode`, actual `ModeManager.js:19` is `switchMode`). I reported this and used the real button for capture 06. Repaired-helper capture 08 reported World renderer `webgl`, quality level 2, reason `healthy-probe`, seven agents, clear weather, and null hour. Captures were concurrent with this exploration round; neither this level nor screenshot FPS nor settling time is a benchmark. All listed images were visually inspected at full composition, then 02/04/05/07/08 were also inspected as unscaled pixel crops. The native views confirm a readable but tiny body face, orderly integer-size seals, and excessive weight on repeated gold section borders. The read-only browser follow-up confirmed Dashboard mode and was released. No numerical contrast measurement is claimed.

## Current state

**This is already much further along than the example wishlist.** Sprite-composed portraits, an attention surface, working sets, Chronicle day ledger, two-font cleanup, district emblems, and clock-sensitive Dashboard ambience are not new proposals.

- The real hero portrait already uses `new AvatarCanvas(agent, 'hero')` (`ActivityPanel.js:1775-1788`). AvatarCanvas has 96×96 hero and 44×52 card sizes, smoothing disabled, a shared Compositor subscription, and south-facing frame extraction (`AvatarCanvas.js:69-104,221-240`). Identity is already centralized (`ModelVisualIdentity.js:125-140`; `shared/README.md:56-64`). In capture 01 the little full-body niche is charming but substantially less recognizable than the enormous selected world body. The discrepancy is presentation scale, not absence of sprite parity.
- Working-set rows and collision names already render (`ActivityPanel.js:2229-2266`); the shared formatter caps to 16 items (`Formatters.js:89-90`). This is a textual list today, not a spatial bench.
- Dashboard already has exact `EXCEPTIONS FIRST · n NEED ACTION`, status/provider filters (`DashboardRenderer.js:1074-1157`), inline selected detail, reused cards, and keyboard navigation (`dashboard-mode/README.md:24-54`). Capture 06 feels like a beautiful but horizontally overextended register: real blocker text truncates while repeated empty Working Set/Children columns consume width. Gold outlines around every row flatten the hierarchy. Astra's tiny character is a footnote in a large empty detail band.
- The 240px Sidebar and 320px panel form a decisive window frame (`DESIGN.md:235-238`; captures 01,05,07). Brass seams are handsome; the dark frame does not need to become daylight-colored. At 100 agents the Sidebar's ordinary names are orderly but the project hierarchy becomes a long inaccessible-looking scroll rather than an overview (capture 04). Live capture 05 is the strongest image: readable real tool/title fragments connect those moving knights to actual work. Some names are sharply truncated, so the panel must remain the exact-reading surface.
- Exactly two local faces ship: Press Start 2P and Departure Mono (`reset.css:8-22,73-81`). Display floor is 10px, data 12px, body 13px, line height 1.45; smoothing should be disabled for display only (`DESIGN.md:175-193`). The code still contains smaller data exceptions: TopBar meta is 11px (`topbar.css:122-127`), Dashboard project path uses 10px label token (`dashboard.css:100-103`), toast body is 10px (`layout.css:131-134`). These are focused craft seams, not justification for a third face. DESIGN.md itself contradicts the two-face rule at :268 and still says there are no inputs at :240-241 despite visible search in every capture.
- Chrome's dark warm gradients are explicitly intentional, not stepped scene materials (`DESIGN.md:117-134,197-209`; `reset.css:24-44,86-108`). Do not apply the building albedo ban indiscriminately to DOM timber. However, DOM-inserted character pixels must retain the authored sheet palette and nearest sampling (`AvatarCanvas.js:79,104`; material contract :13-16).
- Shared pixel SVGs already cover frequent tool and district classes (`AgentPresentation.js:220-242`). Several district aliases share the same silhouette: Command/Tasks, Observatory/Watchtower, and Portal/other (:231). This is a meaningful remaining distinction problem, not an unimplemented icon system.
- Chronicle already has a day-book/timeline and exact spending ledger (`ChroniclePanel.js:13-14,600-607`); prior plan's day ledger shipped (`claudeville-fable-5.1-enhancement-implementation-plan.md:5,446`). Dashboard clock-phase tint also exists (`DashboardRenderer.js:410-421,754-757`). Neither should be sold again as frontier work.
- Building capture 07 reveals repeated load, queue, and recent-work information in Signal and Status, while Occupants says none and Purpose capacity says 0/11 alongside Signal's 2/5. These are observed displayed values, not proof of a reducer bug. The panel currently juxtaposes different concepts without sufficient explanation. Building show/event seam is `ActivityPanel.js:1060-1064,1146-1148,1631-1638`.

## Proposals

All costs below are engineering estimates, not measurements. All proposals are vanilla DOM/Canvas 2D, dependency-free, desktop ≥1280px. Default pulse band is **static**; no world renderer fork, GPU texture readback, OffscreenCanvas, or new per-agent animation loops.

### P1 — The working-set bench

- **Pitch:** Turn the existing file list into a small, exact working bench where the operator can see which files are being handled together.
- **What the operator sees:** Four stepped paper/tool tiles immediately below Current Tool, each bearing a short relative filename and READ/WRITE label; a shared-file overlap joins two named agents beneath the affected tile, rather than painting the whole panel red.
- **Real data it renders:** `agent.workingSet` items `path`, `op`; existing `collisionsForAgent(agent)` results `path`, `kind`, `agents` (`ActivityPanel.js:2231-2263`). No fabricated file content or inferred dirty state.
- **Files touched:** `ActivityPanel.js:2229-2266`; `Formatters.js:89-90`; `AgentPresentation.js:220-242`; `activity-panel.css:82-123` for adjacent portrait/bench framing; Dashboard's existing working-set container (`DashboardRenderer.js:974,1056`).
- **Sketch:**
  1. Keep the existing working-set computation and render signature.
  2. Show at most four distinct file tiles in existing recency order.
  3. Use one generic file silhouette plus existing operation icon, not language logos.
  4. Render path text in 12px Departure Mono; preserve full disclosure.
  5. Place overflow as `+12 files`, opening the existing complete bounded list.
  6. Attach overlap text only to its actual path; say overlap, not conflict.
  7. Static palette/position changes; reduced-motion is identical.
  8. DOM SVG works unchanged with Canvas-2D World fallback.
- **Cost:** M; zero idle frame JS, estimated <1ms selected-panel update; <40 small DOM nodes plus existing data, tens of KB; no generated assets.
- **Risk:** A bench must not imply a filesystem explorer or reliable edit completion. At 100 agents instantiate only for selected/pinned details; no 100-row icon flood. No PostFx dependency.
- **Wow 1–5 / Informative 1–5:** Wow **4** — files become recognizable held objects without decorative scenery. Informative **5** — locality and observed overlapping work become visible together.

### P2 — The exception shelf across modes

- **Pitch:** Give World a named, bounded exception shelf without adding another independent triage model.
- **What the operator sees:** A narrow brass drawer attached to the Sidebar header: `2 NEED YOU · 1 ERROR`, with the oldest two names and elapsed times. Clicking a name selects the same character; expanding shows the full current exception set.
- **Real data it renders:** Existing status bucket counts and agents used by `DashboardRenderer._renderAttentionQueue` (:1074-1101); status and elapsed fields through shared presentation; selection through `AgentSelection.js` documented in shared README :28-35. Reuse the existing attention command (`TopBar.js:297-306`) instead of inventing urgency scores.
- **Files touched:** `Sidebar.js:86` class; `DashboardRenderer.js:1074-1157` controls seam; `TopBar.js:277-306`; `sidebar.css:41-56`; small new shared `AttentionShelf.js` only if extraction avoids duplicate state.
- **Sketch:**
  1. Derive the same buckets once per agent update, not per frame.
  2. Restrict named shelf to needs-user and errored, with explicit category counts.
  3. Use canonical attention ordering; never reorder a focused item.
  4. Cap closed shelf at two names, with a real remainder count.
  5. Preserve Sidebar scroll position when selecting an exception.
  6. Offer native button jump-to and a text-labeled full drawer.
  7. Hide the shelf entirely at zero; static reduced-motion behavior.
  8. Render outside World canvases, identical in fallback mode.
- **Cost:** M; O(n) on updates for 100 agents, estimated <1ms, no idle CPU; bounded closed DOM and <100KB state; no assets.
- **Risk:** Existing Dashboard filters and A command already solve part of this. The new value is named visibility while remaining in World. Avoid double announcements and moving the entire layout when counts change. No new pulse.
- **Wow 1–5 / Informative 1–5:** Wow **3** — a convincing instrument drawer rather than a warning banner. Informative **5** — the first screen remains actionable when project one contains 25 routine agents.

### P3 — A true portrait crop, not another avatar implementation

- **Pitch:** Make the existing shared full-body avatar switch to a deliberate shoulder-and-head portrait in selected detail while retaining a miniature full-body identity witness.
- **What the operator sees:** The same wizard hat, armor, palette, and effort adornment from World fills the 96px niche; a small full-body silhouette remains beside the name so broad weapons and floor rings are not silently erased.
- **Real data it renders:** Existing `model`, `effort`, `provider`, `appearance` and composed idle sheet (`AvatarCanvas.js:94-106,221-240`; `ModelVisualIdentity.js:125-140`). No new emotional expressions.
- **Files touched:** `AvatarCanvas.js:69-79,221-240`; `ActivityPanel.js:1775-1792`; `DashboardRenderer.js:990-995,1324-1341`; `activity-panel.css:82-123`; optional per-sprite portrait crop metadata beside existing asset metadata, not a second registry.
- **Sketch:**
  1. Extend the current hero sizing policy, not sprite loading/composition.
  2. Resolve an authored head/shoulder crop for eligible sheets.
  3. Use the exact composed south idle frame and integer enlargement.
  4. Preserve full-body fit for missing crop metadata and tall ambiguous gear.
  5. Cache by the existing identity signature and asset version.
  6. Do not encode animated canvas to a fresh img on each update.
  7. Static portrait, no blink/mood loop; reduced-motion identical.
  8. Canvas 2D is the native implementation regardless of World backend.
- **Cost:** M; one small blit per identity change, estimated <0.3ms; existing 96×96 canvas is ~36KB per selected hero; crop metadata tiny; no generated sprite sheets, manual metadata review required.
- **Risk:** Cropping can misrepresent effort rings or weapon identity; retain full-body witness. At 100 agents only selected detail gets the enlarged crop. A pure canvas→img conversion has no operator benefit and is rejected.
- **Wow 1–5 / Informative 1–5:** Wow **5** — the character finally meets the operator at portrait scale. Informative **3** — strong identity continuity, not new operational data.

### P4 — The observation tape

- **Pitch:** Add a tiny stepped token/cost history tape only where exact selected-agent totals already appear.
- **What the operator sees:** Thirty narrow columns describe the last observed minute buckets, with a blank break when data was unavailable; beside it, `+8.2k tokens / 10m` and an exact cost delta with its source label.
- **Real data it renders:** `agent.tokens`, `agent.cost.usd` and cost provenance (`Agent.js:115-118,250-275`), sampled on observed updates. This creates browser-local observation history, not reconstructed provider history.
- **Files touched:** `ActivityPanel.js:112-129` section ordering; `DashboardRenderer.js:1059` existing usage seam; `Agent.js:250-275` read-only source contract; new bounded shared `ObservedUsageTape.js`; related panel/dashboard CSS.
- **Sketch:**
  1. Maintain 30 timestamped samples per live session identity in memory only.
  2. Record observed cumulative values plus availability and provenance.
  3. Derive positive deltas only between compatible consecutive observations.
  4. Counter reset, provenance change, missing observation => a visible gap.
  5. Quantize bar heights to integer pixels in a small Canvas 2D surface.
  6. Label time window and numeric range; no unlabeled autoscale competition.
  7. Render only selected or pinned surfaces, once on bucket change.
  8. Static reduced-motion; no traveling scan head or pulse; Canvas fallback identical.
- **Cost:** M; estimated <0.5ms per visible tape update and zero idle frame JS; 100×30 packed samples roughly 100–200KB plus small visible canvases; no assets.
- **Risk:** Poll-derived deltas are not instantaneous generation rate. Explicit `observed while open` copy is mandatory. Do not store transcript data or convert unknown to zero. Avoid turning every row into an analytics chart grid.
- **Wow 1–5 / Informative 1–5:** Wow **4** — an actual little registering instrument fits the keep better than a smooth graph. Informative **5** — distinguishes old accumulated spend from work happening now.

### P5 — The atmosphere witness clock

- **Pitch:** Show the time the village is actually depicting in one small clock-and-weather plaque.
- **What the operator sees:** `22:14 NIGHT` beside a stepped rain glyph; an override explicitly adds `SIM` or `FIXED`, while uptime stays in its own clearly labeled health disclosure.
- **Real data it renders:** Atmosphere snapshot `clock.label`, `clock.hours`, `clock.minutes`, `phase`, `weather.type`, `weather.intensity`, and timeline override state (`AtmosphereState.js:1185-1204,1207-1228`). This weather is the app's local modeled weather, not a forecast or live meteorological feed (:3-5).
- **Files touched:** `TopBar.js:135-153` element bindings; `index.html:72-103` topbar controls; `topbar.css:122-127`; existing atmosphere event/snapshot bridge, with `AtmosphereState.js:1185-1204` as source contract.
- **Sketch:**
  1. Subscribe to the existing published atmosphere snapshot, not a new Date clock.
  2. Retain only minute label, phase, weather class, and override identity.
  3. Update DOM only when this signature changes.
  4. Draw a static 16px glyph with exact block pixels.
  5. Tooltip says modeled village weather; fixed simulator time remains explicit.
  6. Departure Mono for time, display face for a short phase label.
  7. No rotating hands or falling DOM rain; static reduced-motion.
  8. Bridge semantic snapshot independent of GPU quality or Canvas fallback.
- **Cost:** S/M; <0.1ms per minute/class update, a few nodes and <5KB state; no assets.
- **Risk:** Must not be falsely sold as real outdoor weather. Do not independently compute the Dashboard clock while World is paused. Topbar is width-constrained at 1280px; replace redundant secondary health content rather than append another row.
- **Wow 1–5 / Informative 1–5:** Wow **3** — a tiny clock lends credibility to the light beyond the window. Informative **4** — explains why the world looks like this, especially in simulations and fixed-time captures.

### P6 — One building instrument, not four competing summaries

- **Pitch:** Give selected buildings a compact shared instrument face where occupancy, queue, and capacity meanings are visually separated.
- **What the operator sees:** `VISITING 0 / 11` in a static row of seats and `WORK SIGNAL 2 / 5` in a separate labeled meter, followed by one queue name list; no repeated Signal/Status tables.
- **Real data it renders:** Existing building selection payload and `village:building-signal` / building presence events (`ActivityPanel.js:1060-1064,1146-1149`). Capture 07 demonstrates the distinct currently displayed values; their precise semantic denominators must be verified before final copy.
- **Files touched:** `ActivityPanel.js:1631-1638` building mode and existing building signal section; `AgentPresentation.js:201-208` building identity; `activity-panel.css` existing section treatments.
- **Sketch:**
  1. Inventory displayed fields and assign each to presence, signal, queue, or purpose.
  2. Preserve separate measured concepts rather than forcing agreement.
  3. Render each fact once; purpose becomes short static explanation.
  4. Seat ticks are counts, with text numerator and denominator always present.
  5. Unknown denominators become text-only unavailable, never an empty gauge.
  6. Queue and inbound names are selectable through existing selection helpers.
  7. Static ticks under reduced motion and ordinary motion.
  8. DOM-only instrument works unchanged with Canvas fallback.
- **Cost:** M; replaces duplicate DOM, estimated lower update cost; <1ms per existing five-second refresh and tens of KB; no assets.
- **Risk:** Highest risk is misnaming synthetic capacity as physical occupancy. Resolve semantics before design. At 100 agents cap names with exact overflow counts and a disclosure. GPU ladder has no effect.
- **Wow 1–5 / Informative 1–5:** Wow **4** — the building acquires a convincing control plate. Informative **5** — removes the visible ambiguity of apparently conflicting fractions.

### P7 — The indexed village ledger

- **Pitch:** Extend the shipped Chronicle day ledger with an event-kind margin index, not another parchment skin.
- **What the operator sees:** A dark ruled page with a left margin of exact time notches and small event emblems; selecting `3 ERRORS` jumps to the three real entries, while quieter arrival groups fold to one counted entry.
- **Real data it renders:** Existing Chronicle day timeline and `ChronicleEventKind` values (`ChroniclePanel.js:13-26`) and existing daily spending totals (:600-607). No new story prose or invented outcomes.
- **Files touched:** `ChroniclePanel.js:600-607` ledger/timeline adjacency; `modal.css:78-89` body and reduced-motion treatment; `AgentPresentation.js:220-242` pixel vocabulary.
- **Sketch:**
  1. Reuse existing day navigation and folded timeline data.
  2. Count kinds over that exact visible day dataset.
  3. Add a narrow index of kinds with real nonzero counts.
  4. Make index buttons move focus to existing entries, not fetch new data.
  5. Draw ruled separators only where timestamps or groups exist.
  6. Keep daily totals and their coverage note beside the index.
  7. Instant scroll/focus in reduced motion; ordinary scroll also nonanimated by default.
  8. Entirely DOM; no World backend coupling.
- **Cost:** M; O(events) on day change, no per-frame CPU; small index nodes with existing records; no generated paper texture.
- **Risk:** This must be sold as navigation and chronology, not the already-shipped ledger. Large event counts must use existing folds, not one DOM notch per raw event. Bright parchment would violate the keep's dark-frame premise.
- **Wow 1–5 / Informative 1–5:** Wow **4** — time becomes the book's visible structure. Informative **4** — operator can recover consequential moments without reading every line.

### P8 — Distinct district seals and a disciplined type baseline

- **Pitch:** Finish the shared icon grammar with unique building seals and put operational values back on a consistent readable data baseline.
- **What the operator sees:** Command's pennant is never Tasks' clipboard; Observatory's telescope is never Watchtower's alarm; the same 16px stepped seal accompanies the related building/panel/card label. Tiny uptime, path, and toast data stop looking like annotation dust.
- **Real data it renders:** Existing `buildingClassForAgent`, building class, tool category, provider/model label and status (`AgentPresentation.js:184-208,230-242`). Type carries existing information only.
- **Files touched:** `AgentPresentation.js:220-242`; `index.html:73-102` icon controls; `topbar.css:122-127`; `dashboard.css:100-103`; `layout.css:131-134`; `DESIGN.md:175-193,268` policy reconciliation.
- **Sketch:**
  1. Extend the existing pixelIcon path dictionary, not introduce an icon library.
  2. Give each durable district one unique silhouette at 16×16.
  3. Keep tool glyphs simpler than district seals; do not conflate them.
  4. Align SVG boxes and textual baselines at integer CSS pixels.
  5. Promote operational 10/11px body exceptions to 12px data token.
  6. Reclaim space from repeated labels before narrowing useful text.
  7. Keep Press Start for short labels only and exactly two font faces.
  8. All static, reduced-motion identical, Canvas fallback unaffected.
- **Cost:** S/M; no frame CPU, negligible SVG geometry memory; no external assets, hand-authored SVG path work only.
- **Risk:** Most icons already ship; indiscriminate replacement would be churn. Limit to verified collisions and small-data exceptions. At 100 agents SVGs should remain absent from routine Sidebar rows unless they replace another mark.
- **Wow 1–5 / Informative 1–5:** Wow **3** — consistency makes the entire artifact feel authored rather than assembled. Informative **4** — stable unique silhouettes and readable values reduce decoding effort.

## Top three

1. **The working-set bench.** Highest combined utility and visual novelty. It adds a legible physical arrangement to real file locality without adding data ingestion or pretending to know file contents. The foundation is already there, including overlaps; most of the work is designing the right four-tile grammar rather than building a new subsystem.

2. **A true portrait crop, not another avatar implementation.** Most immediately arresting boundary improvement. Current portraits already prove correct shared identity but leave the face too small to carry character. A conservative authored crop lets the world inhabit the frame while the full-body witness protects effort/accessory truth. This is a visual refinement with clear acceptance, not a second sprite system.

3. **The observation tape.** Best new operational question: is this accumulated usage old, or is the agent consuming resources now? Its strength depends on honest gaps, sources, and observation-window labels. Keep it confined to selected detail so the keep does not turn into a grid of charts.

## Rejected

- “Add sprite-composed portraits”: already shipped (`ActivityPanel.js:1775-1788`; `AvatarCanvas.js:85-104`). Canvas→img encoding by itself adds allocation, not meaning.
- “Add the working set”: already shipped (`ActivityPanel.js:2229-2266`). Only the bench representation is new.
- “Add an attention rail”: counts/filter controls and A navigation already ship (`DashboardRenderer.js:1074-1157`; `TopBar.js:297-306`). P2 is specifically a bounded named World shelf.
- “Make Chronicle a day ledger”: already shipped (`ChroniclePanel.js:600-607`; prior plan :446). New index must earn its space through navigation.
- Tint all chrome blue by day and orange by night: deliberately violates the permanently-dark keep/window contrast (`DESIGN.md:117-119`); Dashboard phase tint already exists (`DashboardRenderer.js:410-421`).
- A generic World hover card cloned from the full Dashboard card: too much detail for hover and two detail surfaces competing. Shared view-model primitives are valuable, cloning a whole row is not. Non-goal World hit-testing would also broaden this assignment.
- World-to-Dashboard flying shared-element portrait: dynamic World coordinates plus fractional transforms threaten pixel integrity and focus continuity; simple mode fade already exists (`ModeManager.js:41`). A future experiment should first prove operator continuity problems beyond the existing selection mirror.
- Animated portrait moods, blink cycles, fake scribbling, imaginary file contents: not grounded in provider state and unnecessary motion pressure.
- Literal bright parchment and procedural paper noise: the maintainers rejected meaningless decoration; dark ledger ruling can instead encode event groups.
- Third font or shrinking text to fit more columns: violates the two-face rule and worsens exact-state reading (`DESIGN.md:175-193`).
- Blanket elimination of every DOM gradient: confuses the authored stepped World contract with the intentional chrome material system (`DESIGN.md:197-209`).

## Open questions for the coordinator

- Before P6, establish exact semantics of Signal's 2/5 and Purpose's 0/11 in capture 07; the picture alone cannot distinguish reservations, modeled load, and physically present occupants. Do not fix this by suppressing one value blindly.
- The initial helper did not actually apply hour/quality lookups as intended; do not use captures 01–07 as deterministic atmosphere baselines. They remain valid inspected DOM-surface evidence on Metal.
- Which sprite heads can support portrait crops without losing authored equipment? Review a crop contact sheet before committing metadata; existing full-body fitting remains fallback.
- For P4, verify token normalization availability flags and cost provenance boundaries in TokenUsage before coding deltas. Browser observation history is intentionally not provider retrospective history.
- Chronicle modal and toast were inspected in source, not exercised as retained real-GPU modal screenshots within this eight-shot allocation. Their proposals need a focused visual pass before implementation acceptance.
- DESIGN.md :268 and :240-241 are demonstrably stale relative to its own type policy and visible search. Correct in a documentation reconciliation, not a redesign of the product rules.
