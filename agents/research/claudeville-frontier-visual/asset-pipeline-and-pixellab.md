## Territory and method

Read-only asset feasibility, not a renderer redesign. No PixelLab generation, animation, deletion, server lifecycle action, formatter, test, validation or gate was run. The only outputs are this note and its three JPEG captures.

Files read: `AGENTS.md`; `agents/README.md`; `claudeville/CLAUDE.md`; the character-mode, dashboard-mode and shared `README.md` files; `docs/visual-experience-crafting.md`; `docs/world-visual-qa-checklist.md`; `docs/rendering-baselines.md`; `docs/building-style-contract.md`; `docs/motion-budget.md`; `docs/material-channel-contract.md`; `docs/pixellab-reference.md`; `scripts/sprites/generate.md`; `.claude/skills/sprite-character/SKILL.md`; `claudeville/assets/sprites/{manifest,palettes}.yaml`; `claudeville/assets/sprites/atlases/world-pilot.json`; `AssetManager.js`, `MaterialRegistry.js`, `SpriteRenderer.js`, `SpriteSheet.js`, `RitualConductor.js`, `AgentEventStream.js`, selected `BuildingSprite.js` sections under `claudeville/src/presentation/character-mode/`; and `claudeville/src/domain/entities/Agent.js`. Prior asset decisions were located in `agents/claudeville-astra-refinement-plan.md` and `agents/plans/claudeville-fable-5.1-enhancement-implementation-plan.md`.

All `scripts/sprites/*.mjs` names and first seven lines were inventoried, without executing them: `atlas-{bake,layout,packing,plan}`, `author-roster-channels`, `bake-{manifest,terrain}`, `capture-{baseline,codex-equipment}`, `channel-{contact-sheet,registry,validate,validation}`, `contact-sheet`, `generate-{character-baseline,character-mcp,grok-procedural,pixellab-revamp}`, `heal-base-seams`, `key-out-{bg,dark-bg}`, `manifest-{id-audit,utils,validator}`, `pixellab-rest`, `plan`, `rehue-flowercart`, `sidecar-mask-fix`, `visual-diff` (all `.mjs`). PNG IHDRs and directory entries were inspected in a read-only Python cell; atlas JSON was counted, not baked.

Visually inspected captures, all at zoom 3, 1920×1080, 16-second requested settle:

- `agents/research/claudeville-frontier-visual/shots/asset-pipeline-and-pixellab-01.jpg`: `material-pilot`, requested clear 21:00, center 20,17; Mine rock/ore/material and shoreline close-up.
- `agents/research/claudeville-frontier-visual/shots/asset-pipeline-and-pixellab-02.jpg`: `multi-provider-showcase`, requested clear noon; selected Astra, Grok at the left edge, detailed Harbor and approval cue.
- `agents/research/claudeville-frontier-visual/shots/asset-pipeline-and-pixellab-03.jpg`: `material-pilot`, requested rainy noon; Terra and Rowan/Sonnet before Command, foliage and ground detail. The helper was passed `--select material-terra`; the visible selected panel is Terra, but that argument's ID was not independently verified.

Each capture returned `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)` and zero console errors. These were simulator pages on the maintained live server, not the operator feed. The helper version used returned `postFxLevel:null` and `hour:null`; therefore requested hours are not asserted as measured hours, and no FULL-ladder claim is made. Several explorers were capturing concurrently; FPS badges are not performance benchmarks.

Also visually inspected the full PNG sheets for `agent.codex.gpt6astra`, `agent.claude.sonnet`, and `agent.zai.glm` under `claudeville/assets/sprites/characters/<id>/sheet.png`.

PixelLab read-only calls: `get_balance({})`, `agent_help(...)`, and `list_characters({limit:50})` all returned **401 Missing Authorization header**. An initial list request of 100 was rejected by the actual maximum of 50. Balance and server-owned character inventory are therefore **unavailable**, not zero. No tokens were inspected or printed. Capability evidence comes from the mounted tool descriptions/schemas and the current official index, https://www.pixellab.ai/llms.txt, which independently confirms the expanded MCP catalog. The help question was sent but produced no capability answer.

## Current state

### Manifest-backed inventory

`manifest.yaml` below means `claudeville/assets/sprites/manifest.yaml`. Its version is **`2026-09-05-astra-v3`** at `manifest.yaml:2`. The current contract is eight direction columns and ten frame rows: six walk, four breathing-idle (`manifest.yaml:47-48`; `SpriteSheet.js:2-20`). There are **24 sheets, 1,920 populated frame cells**. Every on-disk sheet's IHDR is **736×920**. Reading, typing, thinking, sleeping, celebrating and carrying are **not baked animation sequences** in these sheets. Work gestures already exist procedurally and must not be sold as a new feature (`RitualConductor.js:20-36`).

Each row below has walk + breathing-idle. `M/E/O` means three individual material/emissive/occluder PNG companions, not three independently generated animations.

| Character ID suffix after `agent.` | Manifest entry anchor | Generation size | Companion delivery |
| --- | ---: | ---: | --- |
| claude.fable | 60–82 | 76 | M/E/O |
| claude.opus | 84–104 | 76 | Atlas; no individual sidecars |
| claude.sonnet | 106–128 | 92* | M/E/O |
| claude.haiku | 130–149 | 92* | M/E/O |
| codex.gpt55 | 151–173 | 92* | M/E/O |
| codex.gpt55.high | 175–197 | 92* | M/E/O |
| codex.gpt55.xhigh | 199–221 | 92* | M/E/O |
| codex.gpt6astra | 223–236 | 76 | Metadata defaults; no declared sidecars or atlas membership |
| codex.gpt56sol | 241–261 | 76 | Atlas; no individual sidecars |
| codex.gpt56terra | 263–285 | 76 | M/E/O |
| codex.gpt56luna | 287–306 | 76 | M/E/O |
| codex.gpt54 | 308–327 | 92* | M/E/O |
| codex.gpt53spark | 329–348 | 92* | M/E/O |
| claude.base | 350–366 | 92* | M/E/O |
| codex.base | 368–390 | 92* | M/E/O |
| gemini.base | 392–414 | 92* | M/E/O |
| kimi.base | 416–435 | 92* | M/E/O |
| deepseek.reasoner | 439–461 | 76 | M/E/O |
| deepseek.pro | 463–485 | 76 | M/E/O |
| deepseek.flash | 487–509 | 76 | M/E/O |
| grok.base | 517–539 | 76 | M/E/O |
| grok.composer | 541–563 | 76 | M/E/O |
| zai.glm | 571–593 | 76 | M/E/O |
| zai.flash | 595–614 | 76 | M/E/O |

*The eleven 92px entries explicitly say their generation size is an unverified inherited default. Thirteen entries declare 76px. Do not bill a real historical character using its 92px engine-cell size without checking the PixelLab record (`generate.md:87-92`). All 21 declared triple-sidecar sets exist on disk; Opus, Sol and Astra directories contain only albedo. This is **63 individual character companion images**, plus pilot atlas material coverage for Opus/Sol. Astra's material metadata is not absent, but detailed authored pixel classification is.

| Building | Native base PNG | Manifest anchor | Individual companions | Procedural-only building? |
| --- | --- | ---: | --- | --- |
| command | 312×208 | 761–806 | material only | No |
| watchtower / Lighthouse | 288×384 | 812–849 | None; atlas defaults/semantic sources | No |
| harbor | 352×232 | 852–875 | None; atlas | No |
| observatory | 256×288 | 880–903 | None; atlas | No |
| portal | 312×208 | 906–942 | None; atlas | No |
| forge | 256×232 | 945–970 | M/E/O | No |
| mine | 256×232 | 973–998 | M/E/O | No |
| taskboard | 256×232 | 1001–1030 | M/E/O | No |
| archive | 336×224 | 1033–1060 | M/E/O | No |

All **nine building bases exist** at `claudeville/assets/sprites/buildings/<id>/base.png`; there are **13 individual building companions**. Command watchfire, watchtower beacon and portalGlow are three separate manifest layers (`manifest.yaml:782-794,829-841,922-934`). Clock hands remain procedural (`manifest.yaml:877-879`); that is not a missing Observatory sprite. Building enumeration uses manifest entries and sprite records rather than choosing a procedural exterior (`BuildingSprite.js:1727-1758`). A missing ordinary image uses the checker loader path (`AssetManager.js:682-711`), while absent optional channels deliberately do not (`docs/material-channel-contract.md:9-16`). Archive's `tool:isometric_tile` label at `manifest.yaml:1034` cannot be passed literally to today's 64px-capped tile tool for its 336×224 art: select the actual large-object/image route before rebaking.

The **one committed atlas**, `world-pilot`, has **18 reviewed parent IDs**, **209 frame records**, four identically laid-out **2048×2048 RGBA** PNGs, 2px gutters, and content height 1340. Membership is `manifest.yaml:15-44`; dimensions are `atlases/world-pilot.json:713,12174,12407-12410`. Raw storage arithmetic: 16 MiB/channel, 64 MiB for all four, excluding browser copies and transient uploads. A character sheet is 2.583 MiB decoded RGBA; 24 albedos are 61.992 MiB and the 63 individual companions total 162.729 MiB if all decoded simultaneously. Those are inventory arithmetic, **not measured live residency**; the loader supports character-specific loading and companion eviction (`AssetManager.js:22,270-274,510-612`).

Channels today are albedo, material, emissive, occluder (`MaterialRegistry.js:5-16`). Material R is class, G/B are reserved; occluder R is height, G is strength (`docs/material-channel-contract.md:109-124`). They are **not normal maps**. The key is upper-left with stepped response, not PBR (`MaterialRegistry.js:38-58`). The shipped pilot already separates Terra/Sonnet/Command material regions (`character-mode/README.md:70`); proposing that same three-asset pilot again would be duplication. Atlas paths and original albedo paths are distinct, and Canvas stays on albedo (`docs/material-channel-contract.md:9-16,95-107`).

### Art-director judgment

- **Beautiful:** Harbor in capture 02 has a convincing architectural hierarchy, fine timber rhythm, structural pilings and a crane silhouette that is recognizably a work place. Astra's silver/violet body has exceptionally economical color grouping. Sonnet's sheet has a legible hat, clear robe/cape distinction and stable identity across directions; GLM's vermilion silhouette is refreshingly unlike another robed wizard. Sources: capture 02 and the three inspected sheet paths.
- **Flat:** The Mine's great grey face in capture 01 has far larger uninterrupted clusters than Harbor. This is a material-scale mismatch, not evidence that a new shader is required. A few deliberate planar seams would be more useful than adding an entire texture frequency everywhere. Sonnet's long robe versus Astra/GLM's shorter silhouette shows meaningful height variety, but also makes “one 92px box” an inadequate guide to future pose margins. Sources: capture 01 and inspected sheets.
- **Noise:** Repeated runestone/plinth props and high-contrast grass/cobble compete with the two bodies in capture 03. New props need to replace a procedural cue or fill an actual inspection aperture, not populate another ground ring. At zoom 3 Astra dominates the nearby Harbor in capture 02; generating larger/more ornate characters would amplify that scale imbalance rather than solve it.
- **Consistency debt:** The inspected sheets look like the same broad RPG family, but Sonnet is slimmer and taller, while GLM has a larger readable face relative to his torso; Astra is a compact armored toy. Preserve these identity differences while standardizing feet, hand sockets, margins and palette segmentation. The raw sheet previews expose dark translucent-looking pixels around some edges; the preview alone does not prove bad production alpha, so this is a review question, not a claimed defect. Sources: the three inspected PNG paths.

### PixelLab capability and economics table

**Authority:** current mounted tool schemas supersede the older local catalog where they conflict. USD price is **unknown unless explicitly stated below**. Subscription generations are not automatically equivalent to a verified current USD price. No live quote or balance could be obtained because authentication failed. Prices below are first-pass production costs without retries; ranges remain ranges.

| Capability | Current output / constraints | Generation cost | Typical tool-reported time | Integration verdict |
| --- | --- | --- | --- | --- |
| Character standard | 4 or 8 directions, max128px; standard may expand canvas | 1 per mounted schema; old local estimate ~9 conflicts | 2–5 min | App requires eight; inspect final dimensions |
| Character pro | Always8, max128px, style-character reference; ignores most style parameters | 20–40 | Creation async; no exact pro duration promised | Matches current manifest mode; not a guarantee of style by prompt alone |
| Character v3 | Always8, max256px; can rotate an exact source PNG | 2–9 | Not specified separately | Possible recovery for lost rigs, but identity matching must be reviewed |
| Template animation | Existing rig, fixed template frame count, explicitly request all8 directions | **1/direction =8/sequence** | 2–4 min | One animation is several frame rows, not one row |
| v3 custom animation | Even4–16 frames; custom defaults to south only; exact start/end frames only single-direction | **ceil(width×height×frames/65536) per direction** | 2–4 min | Cheap feasible read/hold gestures; specify all8 |
| Pro animation | Sequential cross-direction references; at >64px always4 frames, ignores frame_count | **20–40/direction =160–320/sequence** | Tool overview2–4 min; eight sequential directions can take longer, not verified | Mandatory quote then explicit spend confirmation; not a default roster strategy |
| Character state | New character_id, same identity, all4/8 rotations; palette lock optional; can enlarge canvas | **20–40/state** | 1–5 min | Rain-soaked/lantern-holding/sitting are valid edits; existing-animation transfer is **not promised** |
| Map object | Transparent intended,32–400px; repo warns matte removal needed | ~1 (local `pixellab-reference.md:28,100-104`) | ~30–90s catalog; local poll10–15s | Suitable desks, ledgers, building exteriors; inspect/key edges |
| One-direction object |16–256px;≤42 gives64 candidates,≤85 gives16,≤170 gives4 |20–40 per job, not per candidate |30–90s | Candidate review required; top-down/sidescroller view differs from map-object angle |
| Directional objects | Official current index lists create_8_direction_object; mounted inventory does not expose that creation tool here | Unknown | Unknown | Do not promise a one-call eight-view equipment batch with this client |
| Isometric tile |16–64px, thin tile for overlays |1–2 local estimate | Often<30s local recipe | Small status/prop source only; not hero buildings |
| Top-down / sidescroller tileset |16/32px,16 Wang tiles or23 with full transition |16/23 local estimate | No verified whole-set duration | Existing terrain driver stitches/masks32px cells (`pixellab-reference.md:106-111`) |
| Pro tiles |16–256px, multiple shapes; current catalog also has path and building tools |20–25 local estimate | Not verified | No justification to replace current Wang terrain wholesale |
| Building kit |Floor, walls, doorway, pillar, stairs; iso32–96px; walls1–3 tiles high; other projections16–96 | **Unknown**, not stated by mounted tool | Async, not stated | Feasible interior vocabulary; must not assume a whole kit costs20 |
| Portrait conversion |Character→bust;16/32/48/64px or128/160px |**20** small; **25** large |30–80s | Exact24-character64px batch=480 generations |
| Pixel font |TTF plus glyph atlas; upper/lower/digits/common punctuation;8/16/32/64 native glyph px |**25**, or **at least $0.125** credits |30–80s | Unicode and metrics not guaranteed; existing data face should stay |
| UI panel |Aspect-gated192–688px; square≤512²;16:9≤688×384; named pieces/elements and style reference |20–40 |30–90s | Decorative frame only; never bake real text/counts into image |
| Semantic sidecars / normal-like geometry |No mounted tool promises exact palette-indexed material/height/normal companions aligned to production albedo |0 external generations for manual/deterministic authoring | Human review, not an API-time estimate | Existing authoring scripts are the correct material source |

Mounted humanoid template list contains breathing-idle; walking variants including4/6/8 frames; running4/6/8; crouching/crouched-walking; drinking; picking-up; pushing/pull-heavy-object; throw-object; getting-up; jumps/flips; combat/cast/reaction templates. **Celebrate, sleep, wave, carry-loop, sit-loop, read, type and think are not advertised template IDs in the mounted enum.** Use v3 custom text or state edits; do not invent template names. The old local list includes `angry`/`bark` (`pixellab-reference.md:195-211`), absent from the mounted humanoid list; per-character availability remains unverified because `get_character` could not be reached through an authenticated inventory.

**One new animation sequence across ALL24 sheets:**

- Template:24 calls,192 direction jobs, **192 generations**, irrespective of the template's number of frames.
- v3 four-frame at declared generation sizes:24 calls,192 direction jobs, **192 generations**;768 generated frame cells. Set `keep_first_frame:false` to avoid a fifth stored frame. Appending produces736×1288 sheets, an incremental **24.797 MiB albedo /99.188 MiB for four channels** over the full roster. Lazy supplemental strips are preferable to widening every resident base sheet.
- v3 eight-frame:13×8×ceil(76²×8/65536) +11×8×ceil(92²×8/65536) =104+176 = **280 generations**. Actual historical rig dimensions may change the quote.
- Pro four-frame:24×8×[20,40] = **3,840–7,680 generations**, before retries.
- Three v3 four-frame work sequences per character:72 calls,576 direction jobs, **576 generations**,2,304 frames; **74.391 MiB incremental albedo** if all decoded. Three actions are a memory decision even when generation is cheap.
- All-roster outfit state:24×[20,40] = **480–960 generations for rotations alone**. Conservatively budget new walk+idle separately:384 more template generations; **864–1,344 total**, unless authenticated records prove reusable animations.
- At2–4min per sequence,24 fully serial animation calls suggest48–96min of generation wall time, excluding downloads/review; this is arithmetic, not a service SLA. Concurrency limits and retries were not verified. Do not multiply eight directions again into template billing or assume unlimited parallelism.

The old local statement “full character revamp6 characters around100 generations” is not a quote for today's24-character pro roster (`pixellab-reference.md:31`). The current MCP index also makes the local “edit/inpaint REST only” advice stale (`pixellab-reference.md:64-72,136`). Neither doc was modified in this research.

## Proposals

Cost estimates below distinguish API arithmetic from engineering forecasts. CPU/GPU numbers are **unmeasured design estimates**, with no claim that a loaded capture benchmarks the change. Named validation commands are recommendations for the eventual implementation and were **not run**.

### P1 — Real reading hands, not another floating book

- **Pitch:** Replace the admitted Archive gesture's procedural body approximation with an authored four-frame read/page-turn strip that actually bends the character's hands and head.
- **What the operator sees:** Sonnet brings a book into her silhouette, glances down, turns one page, then holds it; Astra's gauntlets perform the same action without becoming Sonnet's hands.
- **Real data it renders:** Existing ritual `tool`, `building`, `pose:'page'`, `agentId`, `createdAt` from `RitualConductor.js:27-36,404-450`, sourced from `Agent.currentTool/currentToolInput` (`Agent.js:123-126`; `AgentEventStream.js:17-22`). This improves an existing signal, not a new assertion of comprehension.
- **Files touched:** `manifest.yaml:47-48,60-614` adds named supplemental animation metadata; `scripts/sprites/generate-character-mcp.mjs:2` assembly contract and `scripts/sprites/plan.mjs` header-level seam; `SpriteSheet.js:16-20` lookup contract; `AssetManager.js:510-612,860-873` optional strip loading; existing `RitualConductor.js:478-486` pose admission. Material generation via existing `author-roster-channels.mjs:3-5`.
- **Sketch:**
  1. Pilot Sonnet and Astra, not24 blind requests:2 calls,16 direction jobs,16 generations.
  2. Request v3 four frames, all8 directions, `keep_first_frame:false`.
  3. Identify animation groups by explicit name/ID, not four-frame count; idle is also four frames.
  4. Keep base sheet unchanged; manifest an optional736×368 action strip with32 cells.
  5. Author body/hand anchors and companion masks for the new frames; do not copy idle masks across changed silhouettes.
  6. Use the existing maximum-six ritual admission; replace the procedural gesture while the strip is resident.
  7. Reduced motion holds the most legible read frame, band static; animation reuses the existing medium work claim, never a second pulse.
  8. Canvas draws the same albedo cells; missing strip retains the current working gesture.
  9. Proposed checks: `npm run sprites:audit-refresh`, character contact sheet, `npm run sprites:channels-validate`, affected World captures in both backends.
- **Cost:** M; full rollout24 calls/**192 generations**,768 frames,24 strips plus72 channels if each receives all companions.1.033 MiB/strip albedo,4.133 MiB including channels; full decoded increment99.188 MiB must not be eagerly resident. Estimated no extra body draw, negligible lookup CPU, ordinary sprite bandwidth; API duration2–4min/sequence. Asset generation yes.
- **Risk:** The major risk is equipment clipping and shared four-frame group ambiguity. Do not bypass the existing selected/action upload policy. At100 agents only admitted gestures load/play; strip memory is bounded by active models, not agent count.
- **Wow 1–5 / Informative 1–5:** **4 /4**. Wow: a tiny embodied act reads like animation rather than a sticker. Informative: preserves the existing accurate Read mapping while making it readable without a label.

### P2 — An unmistakable held approval pose

- **Pitch:** Author a restrained open-palm/held-command pose for actual unanswered input, not a fake idle or sleep state.
- **What the operator sees:** The selected agent stops its work gesture, faces with one empty palm held out, and remains still beneath the existing approval mark until the real prompt resolves.
- **Real data it renders:** `Agent.turnState`, `pendingTool`, `waitReason`, `awaitingSince` (`Agent.js:138-145`), with existing status/attention priority retained; not elapsed time alone.
- **Files touched:** Same optional action-strip seam as P1 at `manifest.yaml:47-48`, `SpriteSheet.js:16-20`, `AssetManager.js:510-612`; existing approval consumer in `AgentSprite.js` must be located before implementation. No adapter changes required by this asset proposal.
- **Sketch:**
  1. Commission a four-frame v3 transition to a still palm; inspect all8 directions.
  2. Do not label the asset sleep, fear, frustration or exhaustion.
  3. Require the hand to be visible inside the current92px cell; weapons park using the existing equipment policy.
  4. Store hold-frame index and hand sockets with animation metadata.
  5. During actual awaiting-input choose the held frame; preserve exact prompt text in DOM.
  6. Reduced motion jumps directly to hold; static band, no new pulse.
  7. Canvas and GPU consume the same hold cell; absence leaves current approval treatment intact.
  8. Proposed checks: sprite audit/contact sheet, waiting-on-user and100-agent captures, selected-behind-building capture.
- **Cost:** M;24 calls/**192 generations** for a four-frame whole-roster sequence; retain only one approved held frame if transition is not needed:736×92 per character,0.258 MiB albedo each,6.199 MiB for24 albedos,24.797 MiB for four channels. Estimated no extra body draw or recurring CPU beyond state selection. Asset generation yes;2–4min/sequence.
- **Risk:** A palm can disappear from northern directions; silhouette testing outranks facial expression. Preserve action-needed full silhouettes in crowds; do not put100 waving hands on screen. PostFx may grade body art, so primary approval marks remain authoritative.
- **Wow 1–5 / Informative 1–5:** **4 /5**. Wow: the village visibly pauses to address the operator. Informative: a static posture distinguishes “needs you” from “quietly idle” without claiming emotion.

### P3 — Portraits that look like the same person

- **Pitch:** Create identity-preserving64px busts for selected detail surfaces rather than repeatedly shrinking full bodies into portrait boxes.
- **What the operator sees:** Selecting Astra reveals her silver star-helm and violet collar clearly; selecting GLM yields the same bald head, vermilion robe and jade beads seen in the world, not a generic provider logo.
- **Real data it renders:** `Agent.model/provider/effort` (`Agent.js:111-122`) through existing shared ModelVisualIdentity ownership (`shared/README.md:56-64`); no mood or affinity fields.
- **Files touched:** `manifest.yaml:60-614` optional portrait path per identity; `AssetManager.js:860-873` path handling or a separate DOM image consumer; `shared/ModelVisualIdentity.js` ownership seam documented at `shared/README.md:22,56-64`; `dashboard-mode/AvatarCanvas.js` responsibility at its README:12. New `portraits/<sprite-id>.png` paths need an explicit manifest path convention, not unregistered files.
- **Sketch:**
  1. Start from the reviewed south-facing production frame, not the text prompt.
  2. Call character_to_portrait at64px; request neutral identity, never an invented emotional state.
  3. Pilot Astra, Sonnet and GLM:3 calls,60 generations.
  4. Inspect helmet/hat/hair/clothing fidelity against the world sheet and discard look-alikes.
  5. Add optional manifest `portrait` metadata and generate no material companions for DOM busts.
  6. Render static nearest-neighbor image with the existing full-body avatar as missing-asset fallback.
  7. Reduced motion and Canvas-world fallback are identical; no new world rendering path.
  8. Proposed checks: sprite audit adapted to portrait paths; World→Dashboard identity review, all24 portrait contact sheet.
- **Cost:** M;24 jobs/**480 generations** at64px;30–80s/job.24×64²×4 = **0.375 MiB decoded**. Estimated zero per-frame GPU work in world and no animation CPU. Asset generation yes; do not choose128px for a64px box (that would cost600 generations).
- **Risk:** Generated faces can drift even when described as identity-preserving. Portraits supplement model text, never replace it. At100 agents keep busts in selected details, not100 new large cards. No ladder dependency.
- **Wow 1–5 / Informative 1–5:** **4 /4**. Wow: finally see the person that tiny world sprite implies. Informative: stronger identity continuity across selection and modes, not additional telemetry.

### P4 — Finish semantic material art, not a blanket rebake

- **Pitch:** Extend the reviewed material-pixel method to the roster and mixed-material landmarks, starting with Astra's missing detailed classification.
- **What the operator sees:** Astra's plate, violet fabric and unlit markings keep different restrained surface responses; Harbor's timber does not behave like its metal crane; the art remains recognizable when the light or rain changes.
- **Real data it renders:** Authored `materialClass`, `materialSidecar`, semantic emissive source IDs and existing material weather response (`manifest.yaml:223-236,852-875`; `MaterialRegistry.js:47-58`). These are real asset properties, not synthetic agent state; weather interpretation remains owned by the existing atmosphere.
- **Files touched:** `manifest.yaml:223-236` and selected building entries; `scripts/sprites/author-roster-channels.mjs:3-5`; existing `sidecar-mask-fix.mjs` header seam; `MaterialRegistry.js:5-16` remains unchanged unless schema truly changes. No renderer algorithm proposal.
- **Sketch:**
  1. Add Astra's reviewed material-only segmentation; do not invent an emissive visor because it is bright.
  2. Keep the already shipped Terra/Sonnet/Command pilot unchanged as reference.
  3. Review remaining20 individual-sheet classifications and Opus/Sol atlas inputs before counting them as missing art.
  4. Paint exact color families plus spatial masks for ambiguous shared colors.
  5. For Harbor/Observatory/watchtower/Portal author material-only overrides where visibly mixed surfaces warrant them.
  6. Reuse default emission/occlusion unless a semantic source or measured geometry justifies a change.
  7. Static band and reduced motion unchanged; Canvas remains original albedo by contract.
  8. Proposed checks: `node scripts/sprites/author-roster-channels.mjs --check`, channels validate/contact sheet, pilot atlas bake and World paired capture.
- **Cost:** M; **0 PixelLab generations**. First batch:1 character material PNG plus4 building material PNGs; at listed dimensions approximately3.845 MiB decoded additional material art (Astra2.583 MiB plus4 building surfaces1.262 MiB). Full remaining-roster review is artist labor, not63 new automatic outputs. Estimated no additional sampling or per-frame CPU because the channel already exists. Asset generation no; explicit authoring yes.
- **Risk:** Palette equality can confuse skin, cloth and gold; no luminance thresholds. Broad classifications can make everything glossy, so review under clear/rain/night. At100 agents classification is shared per sheet; existing memory admission still applies. Canvas will not gain the same material distinction, but retains exact semantic identity.
- **Wow 1–5 / Informative 1–5:** **3 /3**. Wow: coherence is quieter than a new effect but makes the whole world look authored. Informative: surface distinction improves readable identities and structures; it is not new operational data.

### P5 — A six-piece inspection interior kit

- **Pitch:** Produce a tiny matched vocabulary of desks and work props for selected-building inspection, not nine speculative full interiors.
- **What the operator sees:** In an approved inspection aperture, an occupied Archive desk has a ledger and the selected reader; empty slots stay empty. Forge uses an anvil bench rather than the same desk recolored.
- **Real data it renders:** Existing selected-building occupants (`shared/README.md:33`) and admitted ritual `building/agentId/pose` (`RitualConductor.js:434-450`). A prop does not assert occupancy; the actual visitor record does.
- **Files touched:** New manifest `prop.interior.*` entries alongside `manifest.yaml:1065`; existing path seam `AssetManager.js:868`; `BuildingSprite.js:1778-1785` inspection integration would be owned by the building explorer, not designed here; `bake-manifest.mjs:2-5` generation seam.
- **Sketch:**
  1. Agree one selected-building aperture with the building owner before making art.
  2. Generate six32–64px map objects: reading desk, anvil bench, planning table, archive shelf, instrument stand, cargo bench.
  3. Use Command/Harbor crops as style references; true2:1 silhouette and selective outline.
  4. No baked occupants, text, count, glow, floor diamond or fake room activity.
  5. Reuse existing character art in actual occupied slots; do not commission24 seated sets up front.
  6. Keep props static; reduced motion identical and no pulse claim.
  7. Canvas receives the same prop albedo; if the aperture feature is declined, commission nothing.
  8. Proposed checks: sprites plan/audit, props contact sheet, building grounding and selected-building paired capture.
- **Cost:** M for asset production/integration; **6 map-object jobs ≈6 generations** by local pricing, exact authenticated quote unavailable; ~30–90s each. Six64² RGBA sprites = **0.094 MiB albedo**,0.375 MiB with all four channels. Estimated≤6 additional small draws only during inspection, negligible upload after initial residency. Asset generation yes. A generated building kit is an alternative only after its currently unknown price/angle output is inspected.
- **Risk:** Cutaways are outside this asset note's ownership and must be approved before production. Whole-building kits can violate the single-image exterior/grounding contract. Never show one prop per invisible agent;100-agent case still has one bounded inspected aperture with count text outside it.
- **Wow 1–5 / Informative 1–5:** **5 /4**. Wow: the village becomes a place with a purposeful interior. Informative: actual occupancy becomes spatially inspectable, provided the building owner supplies truthful slots.

### P6 — A shared cargo vocabulary instead of24 carrying costumes

- **Pitch:** Author three small shared cargo silhouettes for existing read/plan/harbor actions before buying an all-roster carrying animation.
- **What the operator sees:** A legible ledger, rolled plan, or sealed crate replaces a generic procedural blob at a current work gesture; the item's shape survives zoom1 without introducing another label.
- **Real data it renders:** Existing ritual `pose` and `cargo` fields (`RitualConductor.js:27-36,434-447`); never infer a commit from mere Bash activity. Cargo appears only when the current ritual already provides that semantic category.
- **Files touched:** `manifest.yaml:1065-1124` prop convention; `AssetManager.js:868`; existing `AgentSprite._drawToolRitualOverlay` seam documented at `RitualConductor.js:20-26`; script `bake-manifest.mjs:2-5`. Existing `prop.scrollCrates` and `prop.oreCart` at `manifest.yaml:1120-1130` are references, not new inventory to duplicate.
- **Sketch:**
  1. Pilot a book silhouette, plan roll and crate; reject any already suitable existing prop duplication.
  2. Commission32px map objects with isolated transparent bounds and no letters.
  3. Paint eight orientation crops/variants only where required by the hand socket; do not mirror asymmetric text.
  4. Store asset-level anchor and front/back placement with manifest metadata.
  5. Let the existing procedural gesture carry the item until P1 proves true body animation worthwhile.
  6. No new lifecycle or particle system; same ritual admission and pulse ownership.
  7. Reduced motion holds cargo at the static socket; Canvas draws the same PNG.
  8. Proposed checks: equipment/character contact review, sprite audit, mixed-tools and dense100 paired captures.
- **Cost:** S/M; **3 map-object jobs ≈3 generations** for sources, plus hand-authored orientation work;24 final32² crops = **0.094 MiB RGBA**. If all8 directions are independently generated via map-object calls instead,24 jobs≈24 generations; not assumed necessary. Estimated≤6 added tiny blits under ritual cap, no per-agent image copy. Asset generation yes, only if existing props cannot be cropped cleanly.
- **Risk:** A floating item not touching hands is worse than no item. Keep actual identity weapons' grip policy authoritative. Do not show fake documents for unknown tools. No new100-agent cargo carpet, no dependence on full PostFx.
- **Wow 1–5 / Informative 1–5:** **3 /4**. Wow: small tactile specificity, not spectacle. Informative: work categories gain distinct silhouettes without24 duplicate outfits.

### P7 — A production identity ledger before the next broad pose batch

- **Pitch:** Make every future animation request reproducible from a reviewed source rig, frame group and palette instead of guessing from the sheet dimensions.
- **What the operator sees:** No new decoration; when their familiar character reads, waits or returns after an asset refresh, it is recognizably the same character with feet and equipment in the same place.
- **Real data it renders:** Asset provenance: generation mode/size, PixelLab character_id, animation_group_id and source frame dimensions. Current manifest stores only some character IDs in comments (`manifest.yaml:513-515,568-570`) and marks11 generation sizes unverified; `generate.md:92` currently identifies animations by frame count.
- **Files touched:** `manifest.yaml:60-614` optional provenance/animation group metadata; `scripts/sprites/generate-character-mcp.mjs:2-7` input/assembly contract; `plan.mjs` preview seam; existing `manifest-validator.mjs:2-3`; `generate.md:83-97` production instructions. No new runtime framework or registry generator.
- **Sketch:**
  1. After authentication is repaired, inventory the24 source character records read-only.
  2. Record known rig IDs and actual source canvas sizes; leave genuinely unknown provenance explicit.
  3. Add named animation-group mapping before a second four-frame animation can collide with idle.
  4. Emit a proposed production plan containing24 IDs,192 direction jobs and the computed dimensions/cost bounds.
  5. Preserve original sheets and use pilot approval before rollout; never rebuild all characters for metadata alone.
  6. Include per-direction foot/hand/margin review in contact evidence, not just overall dimensions.
  7. No motion, Canvas/GPU changes or assetVersion bump for provenance-only work.
  8. Proposed checks: `node scripts/sprites/plan.mjs --ids=<id>`, manifest validator and sprite audit, plus manual source-to-sheet comparison.
- **Cost:** S/M; **0 generations**,24 read-only record lookups once IDs are resolved. Negligible manifest memory, zero per-frame cost. Asset generation no. If rigs are lost, separately quote24 v3 reference rotations at2–9 generations each (**48–216**) and review before using; never silently recreate them.
- **Risk:** This is enabling production work, not a visual headline. Persistent external IDs must not carry credentials. Old rigs may be inaccessible; do not promise inherited animations or original source sizes without evidence.100-agent behavior and ladder unchanged.
- **Wow 1–5 / Informative 1–5:** **1 /3**. Wow: invisible prerequisite. Informative: prevents misleading art changes and makes the attractive proposals safely reproducible.

### P8 — Optical glyph audit, not a third typeface

- **Pitch:** Prove the actual small status/count glyphs are distinct before commissioning a new PixelLab font.
- **What the operator sees:** Existing labels keep their familiar face, but selected prompts, provider names and counts avoid ambiguous0/O,1/I/l and clipped punctuation at the exact native sizes.
- **Real data it renders:** Real DOM status/model/tool text and counts, already present in captures02/03; typography is a legibility layer, not generated text. The shipped two-face policy is explicit in `agents/plans/claudeville-fable-5.1-enhancement-implementation-plan.md:69`.
- **Files touched:** Existing font assets and style rules must be located by the chrome owner before editing; scoped asset review of labels at `BuildingSprite.js:1324-1329` and path/copy surfaces owned by `shared/README.md:15-19`. No manifest PNG change unless an actual bitmap fallback is approved.
- **Sketch:**
  1. Review exact displayed strings from approval, cost, model and tool surfaces at100% browser zoom.
  2. Check0/O,1/I/l,colon,slash,ellipsis,minus and mixed-case model IDs across native font sizes.
  3. Prefer existing data face for dense facts; preserve display face for short titles.
  4. Do not generate numbers or status words as images; native text remains selectable and accessible.
  5. If a true font defect survives CSS sizing fixes, request one native16px font pilot,25 generations, not a whole UI skin.
  6. Reject the pilot unless metrics, glyph completeness and density beat the shipped face.
  7. Static motion behavior, no world GPU or Canvas changes.
  8. Proposed checks: exact-size DOM screenshots on both modes and current visual review commands, not source-text tests.
- **Cost:** S; recommended audit **0 generations**,0 new asset memory. Conditional font experiment **1 job/25 generations or at least$0.125**,30–80s; TTF/atlas byte size unavailable before output. Estimated no per-frame cost after text layout. Asset generation no by default.
- **Risk:** A third decorative font conflicts with shipped two-face policy and would worsen density. Generated punctuation/Unicode coverage is not guaranteed.100-agent count labels must remain native and compact; no PostFx dependence.
- **Wow 1–5 / Informative 1–5:** **1 /4**. Wow: intentionally not spectacle. Informative: the most precise information is useless if glyphs cannot be distinguished.

## Top three

1. **Real reading hands, not another floating book.** This is the strongest low-risk visual frontier because it spends a small, known192-generation roster budget on an already truthful data mapping. The pipeline work is substantial but finite: named animation groups, optional strips, material companions, sockets. Pilot two contrasting body types for16 generations first. It replaces an existing gesture rather than adding yet another mark to the scene.

2. **An unmistakable held approval pose.** A static full-body question is both more accessible and more informative than another pulse. It answers the operator's most urgent question while fitting reduced motion naturally. A retained one-frame-per-direction strip costs much less memory than a permanently larger character sheet, and the existing approval UI remains the fallback source of truth.

3. **A six-piece inspection interior kit.** This has the highest artistic upside, but only behind the building explorer's approved selected-inspection seam. Six meaningful, grounded props are a better bet than nine complete rooms or24 seated costumes. The art production is cheap; the difficult work is mapping real occupants into a legible, bounded aperture without pretending an empty room is busy.

## Rejected

- **New animation template names guessed from verbs:** sleep/celebrate/read/type/sit/carry are not advertised by the mounted enum; use custom generation, not invalid template IDs.
- **Sleep because an agent is idle:** inactivity does not imply sleep, exhaustion or a break; violates no invented flavour.
- **Celebrate every stopped tool:** tool cessation is not verified success. Existing release parade is already visible in capture02; do not sell it again.
- **Full rain-soaked or lantern-holding outfit roster:**480–960 generations for rotations, potentially864–1,344 including walk/idle, and a second full asset residency family, for weak operational meaning. Existing weather/material response already carries weather (`MaterialRegistry.js:47-58`).
- **Umbrellas for all24:** hides the very identity silhouettes the operator needs, adds hand/hat occlusion problems, and is weather decoration rather than new session truth.
- **AI-inferred normal maps or automatic bright-pixel emission:** exact channel geometry is not guaranteed by PixelLab, albedo already contains upper-left baked shading, and previous plan explicitly excluded normals (`claudeville-fable-5.1-enhancement-implementation-plan.md:58`). Existing occluder height is not a normal map. If a future lighting owner earns a directional-plane experiment, author reviewed categorical masks on one unchanged building first; do not buy a fake PBR asset pipeline now.
- **Seasonal terrain rebake:** a calendar-driven season supplies little operational information, multiplies seam/palette review, and cannot justify replacing six existing Wang sets solely for decoration (`bake-terrain.mjs:2-7`).
- **Whole building-kit replacement of the nine exteriors:** nine native structure-only buildings already exist; assembled walls would undo the silhouette/grounding contract and add new rendering scope (`docs/building-style-contract.md:45,65-67`).
- **Generated distant shore or generic scenic variety:** maintainer already cut the shore as meaningless decoration (`agents/plans/claudeville-fable-5.1-enhancement-implementation-plan.md:5`).
- **All-roster pro animation by default:**3,840–7,680 generations for a single sequence before retries, versus192 for four-frame v3; only promote an individually failing high-value character after review.
- **A new wooden UI panel pack or third display font:** current copper/gold chrome is already coherent in all three captures; richer borders spend contrast without supplying information. PixelLab capability is not product justification.
- **An all-character mega-atlas:** adding more packed inventory is not automatically a residency win; the existing loader explicitly tracks character demand and a192MiB optional-sidecar high-water estimate (`AssetManager.js:22,270-274,510-612`).

## Open questions for the coordinator

- Repair MCP Authorization outside this research before any paid call. Balance, subscription tier, character inventory, original rig sizes, per-character template availability and currency quotes remain unavailable; old Tier3/10,000-generation prose is not current account evidence (`pixellab-reference.md:12-14`).
- Can all24 original PixelLab rig IDs be recovered? The manifest records only selected IDs in comments. This determines whether new poses can preserve original identity directly or need an explicitly reviewed reference-rotation recovery.
- The mounted character-state tool promises identity across rotations but not animation inheritance. Budget separate animation jobs until authenticated record evidence proves otherwise.
- Building-kit billing and complete processing duration are not published in the mounted schema; do not consolidate an invented20-generation quote. The proposed six-map-object kit is the costable alternative.
- What is the approved deployment memory cap for optional pose strips? All-roster four-channel four-frame strips add99.188MiB if simultaneously decoded; this needs admission policy, not a larger canvas by default.
- P1/P2 need the character owner to decide how authored hand/weapon sockets integrate with current equipment logic; this note deliberately did not propose a second equipment renderer.
- P5 must wait for the building owner's chosen aperture and exact occupant contract. No interior art should be generated until those dimensions and occlusion rules are agreed.
- Current helper diagnostics were corrected after these captures; mine prove Metal and visible art, not ladder FULL or exact atmospheric hour. Re-capture only if the coordinator needs a controlled material comparison rather than asset feasibility evidence.
