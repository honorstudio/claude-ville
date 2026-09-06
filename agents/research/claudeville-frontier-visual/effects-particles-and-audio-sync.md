## Territory and method

Read-only exploration of particles, transient semantic marks, council/trail motion, foreground weather and the audio/visual boundary. No implementation, server lifecycle operation, tests, formatters or validation commands were run. All rendering used the maintained localhost server through the provided capture helper. No audio listening claim is made: synthesis and timing were inspected in source, not auditioned.

Path shorthand below: `C/` = `claudeville/src/presentation/character-mode/`; `A/` = `claudeville/src/presentation/shared/audio/`; `S/` = `claudeville/src/presentation/shared/`. Anchors using those prefixes identify actual files, not proposed modules.

Files read: `AGENTS.md`, `agents/README.md`, `claudeville/CLAUDE.md`, all three presentation READMEs; `docs/motion-budget.md`, `docs/visual-experience-crafting.md`, `docs/world-visual-qa-checklist.md`, `docs/rendering-baselines.md`, `docs/building-style-contract.md`, `docs/material-channel-contract.md`; relevant effect sections of `agents/plans/claudeville-fable-5.1-enhancement-implementation-plan.md` and `agents/claudeville-astra-refinement-plan.md`; `C/ParticleSystem.js`, `PulsePolicy.js`, `MarkGovernor.js`, `CouncilRing.js`, `TrailRenderer.js`, `WeatherRenderer.js`, `RitualConductor.js`, `AgentSprite.js`, `IsometricRenderer.js`, `BuildingSprite.js`, `BuildingVisualRegistry.js`, `VillageDirector.js`, `VillageDirectorOverlay.js`, `ChronicleMonuments.js`, `SkyRenderer.js`, `AgentEventStream.js`, `ArrivalDeparture.js`, `postfx/PostFxFeed.js`, `__simfixture__/WorldScenarios.js`; `S/AmbientAudioController.js`, `Toast.js`; `A/AudioDirector.js`, `BgmDirector.js`, `CueGovernor.js`, `cues/CueKit.js`, `bgm/BgmPlayer.js`; `claudeville/src/application/AuroraGate.js`, `AgentManager.js`, `MonumentRules.js`, `claudeville/src/domain/entities/Agent.js`, and the capture helper. Some ancillary files were narrowly searched rather than read in full.

All capture paths are under `agents/research/claudeville-frontier-visual/shots/`:

| Capture | Scenario / requested setup | Visually inspected observation |
| --- | --- | --- |
| `effects-particles-and-audio-sync-01.jpg` | release-parade, 21h clear, zoom 2, 4s wait | Banneret is still traveling near Tasks; no obvious celebration in this frame. |
| `effects-particles-and-audio-sync-02.jpg` | same, 14s wait | Harbor is radiant, `PARADE V0.12.0` readable; very faint ribbons, no legible firework crown in this camera. |
| `effects-particles-and-audio-sync-03.jpg` | failed-push, 21h clear, zoom 2, 8s | WAITING is readable in chrome; world contains `PARADE V0.44`, undermining the failed-push story in the captured moment. |
| `effects-particles-and-audio-sync-04.jpg` | team-gather, 18h clear, zoom 2, 8s | Five bodies straddle bridge; chat bubbles clear, council geometry difficult to separate from ground and overlapping bodies. |
| `effects-particles-and-audio-sync-05.jpg` | storm-night-reduced-motion, 23h storm, zoom 2, 8s | Rain strokes are visible and fine; a conspicuous flock surrounds Harbor; neither a still image nor the helper's old diagnostics proves those birds are static. |
| `effects-particles-and-audio-sync-06.jpg` | mixed-tools, 14h clear, zoom 3, 14s | Close-up conversation and completed Atlas, not the requested work-gesture moment. Retained as honest negative evidence. |
| `effects-particles-and-audio-sync-07.jpg` | mixed-tools, zoom 3; attempted state-triggered capture | The function-expression eval did not establish the awaited state; crowded gate view is retained only as occlusion evidence, not proof of a playing ritual. |
| `effects-particles-and-audio-sync-08.jpg` | mixed-tools, zoom 3; await stationary, non-chatting playing ritual after 8s, then select | Taskboard ritual paper sheets are clearly visible beneath the board, with Cipher at its left. The papers have an identifiable silhouette unlike generic sparkle specks. |

Captures 01–07 each reported `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)` and no console errors. Their helper version reported null PostFX level/hour, so no FULL-ladder or exact-hour assertion follows from those diagnostics; requested settings are recorded above. Other explorers were capturing concurrently: displayed FPS is loaded-host evidence, not a benchmark. Scenario labels alone are not proof a transient is on screen. Capture 07 exposed an eval invocation mistake; capture 08 uses an invoked async expression instead.

Final capture08 used the updated helper and an invoked async state wait: WebGL world, ANGLE Metal Apple M5 Pro, qualityLevel0 / `within-budget`, zoom3, hour14, weather clear, seven agents, no console errors,10.31s total command duration. This is a loaded-host quality observation, not a calibrated GPU benchmark. Its small floating page shapes are the best close-up evidence here for the proposed event-shape grammar. Two discarded attempts to overwrite08 were capture-script mistakes (non-invoked function, then nonexistent camera centering method); the retained08 above is the clean retry, not an app-error claim.

## Current state

### Particle and emitter inventory

One shared pool defaults to **240 particles**, with oldest-first eviction on overflow; presets do not have independent caps (`C/ParticleSystem.js:9-10,486-491,525-531`). Lifetimes below are virtual 16ms frames, decremented by clamped `dt/16` (`:114-122`), not frame-count-dependent real FPS. All pool spawning stops and the pool clears when motion is disabled (`:493-506`). Admission defaults to AMBIENT even for presets classified as semantic (`:520-524`): **semantic preset classification does not automatically confer semantic salience**.

The independent mark-pressure ladder is P0 FULL, P1 WEATHER_FAUNA, P2 PARTICLES, P3 GLYPHS. P1 sheds weather embellishment/fauna, P2 additionally ambient particles, P3 tightens secondary marks; primary remains protected (`C/MarkGovernor.js:6-27,77-123`). Particle classification explicitly calls only butterfly/dragonfly/firefly fauna and sparkle/leaf ambient; everything else is semantic (`C/ParticleSystem.js:12-36`). Therefore smoke, snow and rainSplash can survive the particle-role filter, though their default AMBIENT admission may subsequently suppress them. Do not confuse this ladder with PostFX FULL/REDUCED/MINIMAL/DISABLED (`C/README.md:43-45`).

| Emitter/preset | Trigger or meaning; count/cadence | Lifetime / anchor |
| --- | --- | --- |
| footstep, cobbleScuff, grassMote, shallowSplash | Locomotion footfall resolved by terrain; 1 per stride. Real position motion, not work completion. | 10–20, 8–16, 14–28, 8–16; `C/ParticleSystem.js:179-216`, `AgentSprite.js:2341-2342`. |
| mining | Mine fallback emitter, chance .026 per nominal frame, one; building activity/presence modulation, not one particle per token. | 20–40; `ParticleSystem.js:217-224`, `BuildingVisualRegistry.js:292-295`. |
| sparkle | Portal/Harbor ambient fallback (.025/.014), Observatory gesture (1/1400ms), proud mood (1/3400ms), population burst path. Several unrelated meanings share it. | 15–30; `ParticleSystem.js:225-232`, `BuildingVisualRegistry.js:296-305`, `AgentSprite.js:65-74,6201-6202`, `BuildingSprite.js:536-570`. |
| torch / buoyTorch | Manifest emitter torches; buoy flame is drawn inline by Harbor rather than owning a pool. Environmental presence, not discrete work. | 15–30 / 12–24; `ParticleSystem.js:233-252`, `BuildingSprite.js:3987-3997`. |
| smoke | Forge .035, Harbor .026 chance; presence/Forge heat/wind modulate column. Static wisp in reduced motion. | 50–100; `ParticleSystem.js:258-265`, `BuildingVisualRegistry.js:287-305`, `BuildingSprite.js:2153-2157,2255-2258,3998-4035`. |
| firefly, butterfly, dragonfly | Fauna/time/season, no operational event; ambient sampler permits at most one ordinary spawn/frame and stops near pool cap. Firefly only dusk/night, night chance ×3. | 34–72 / 120–240 / 90–180; `ParticleSystem.js:266-295`, `IsometricRenderer.js:4770-4812`. P1 sheds. |
| snow, leaf | Seasonal ambience; not an operator event. Screen-layer seasonal emission. | 60–120 / 30–58; `ParticleSystem.js:296-311`, `SeasonalAmbience.js:166-167,194-197`. Leaf P2, snow lacks that role classification. |
| portalRune | Portal fallback .05; conjure 2/760ms; arrival landing burst 6, plus 5 dust. | 22–44; `ParticleSystem.js:312-319`, `BuildingVisualRegistry.js:296-299`, `AgentSprite.js:65-74,6311-6321`, `RitualConductor.js:41-50`. |
| forgeEmber / forgeSpark | Forge fallback .06/.032; hammer 3/460ms during actual admitted ritual. | 18–38 / 10–22; `ParticleSystem.js:320-335`, `BuildingVisualRegistry.js:287-291`, `AgentSprite.js:65-68`. |
| mineDust | Mine fallback .035, pick gesture 3/540ms; follows weather wind. | 28–60; `ParticleSystem.js:336-343`, `BuildingVisualRegistry.js:292-295`, `BuildingSprite.js:4028-4035`. |
| archiveMote | Three Archive emitters (.034/.018/.018); page gesture 2/900ms; token-flow and monument freshness also use it. | 34–74; `ParticleSystem.js:344-351`, `BuildingVisualRegistry.js:310-314`, `AgentSprite.js:65-74,6250-6277`, `ChronicleMonuments.js:220-224`. |
| beaconMote | Watchtower .038; signal/scan one per 820/1300ms; token-flow at command/observatory/portal/watchtower. | 24–52; `ParticleSystem.js:352-359`, `BuildingVisualRegistry.js:300-302`, `AgentSprite.js:65-74,6250-6252`. |
| questPing | Taskboard .024; scroll gesture 2/1100ms. | 18–34; `ParticleSystem.js:360-367`, `BuildingVisualRegistry.js:307-309`, `AgentSprite.js:69`. |
| crowdBump | Collision response, two particles; not tool activity. | 10–18; `ParticleSystem.js:368-375`, `IsometricRenderer.js:4762-4763`. |
| fretMote | Derived distressed mood intensity >0, stationary/non-chatting, no competing ritual; 1/2200ms, staggered. | 22–40; `ParticleSystem.js:376-386`, `AgentSprite.js:6184-6210`. |
| rainSplash | Rain/storm at agent feet; effective population capped at 16, at most 3 spawns/frame, stops with fewer than 60 pool slots free. | 8–16; `ParticleSystem.js:387-394`, `IsometricRenderer.js:4815-4850`. |
| sweatDrop | Context pressure >=.85, one bead; static context arc/chip remains under reduced motion. | 16–30; `ParticleSystem.js:395-405`, `AgentSprite.js:3527-3528`. |
| wakeFoam | Force-push hull sinking spray, not successful release; widening ring is separately procedural. | 10–22; `ParticleSystem.js:407-418`. |
| distressRelief | Leaving error/rate-limit storm state, one burst of seven. | 16–34; `ParticleSystem.js:420-431`, `AgentSprite.js:6297-6308`. |

Token flow already exists: totals sum input/output/cacheRead/cacheCreate, positive deltas charge an accumulator by delta/6000, decay ~3s, produce 1–2 Archive/Beacon motes every ~620–1500ms, and yield to movement/chat/ritual (`C/AgentSprite.js:6213-6286`). This is not a measured tokens-per-second rate and is not new frontier by itself. Active-building ambient emitters separately emit one per interval, minimum120/default600ms, only occupied/busy (`C/IsometricRenderer.js:4778-4792`).

### Non-pool transient inventory

- **Tool rituals:** `tool:invoked`; max6, same-building/kind/tool/target coalescence250ms, oldest evicted. Forge/Mine1.5s, Archive1.8s, Observatory1.9s, Portal/Taskboard/Command2.6s, Harbor30s, Watchtower1.8s. Pending180ms, fading last280ms; reduced motion retains logical lifecycle with `motionEnabled:false`, static pose, no gesture particles (`C/RitualConductor.js:4-18,345-357,380-471`; gesture periods `:41-50`).
- **Council:** team membership outline is already static; at least two visible sprites, SECONDARY regional admission, no explicit global ring count. Gather event requires >=2 nearby idle teammates, none waiting-on-user, pairwise distance<=12 tiles, five-minute per-team cooldown. Eight prioritized chat arcs max; moving dot traverses1.8s, reduced motion dashed stationary arc (`C/CouncilRing.js:11-16,113-243,486-548`). Family/advisor/ally tethers are separate relationship draw functions (`:245-434`); they should not be mistaken for messages.
- **Familiars:** real child relationships, max3 visible children per parent with overflow count; provider-shaped and identity-seeded orbits, frozen under reduced motion. No world-wide familiar cap is established here (`C/AgentSprite.js:91,6740-6745,6828-6871`).
- **Trails:** real position samples every1s, retain1h, max720/agent and12000 overall; draw budgets240/agent,4000 overall,24 selected/12 actionable recent. Half-resolution history cache; no decorative particles. Motion preference setter does not stop logical historical capture (`C/TrailRenderer.js:5-24,218-220,252-276`).
- **Director incidents/recovery/handoffs/release:** shared max8 scenes, incidents18s, recovery2.4s, social14s, release26s, lifecycle12s. Incident primary ellipse + ring uses alert band; recovery secondary lifted diamond freezes under reduced motion; handoff scroll travels1.1s and lands as a diamond, snapped at terminus under reduced motion; parade two secondary ribbon curves, not fireworks (`C/VillageDirector.js:7-21,722-728`; `VillageDirectorOverlay.js:279-301,348-378,383-418,469-498`).
- **Arrival/departure secondary effects:** max6 departure sigils,8 completion cues,6 orphan returns; reduced completion hold3.6s (`C/ArrivalDeparture.js:10-13,200-202,228-252`). Distinguish these from the pool landing burst above.
- **Release fireworks already ship:** planting a release monument schedules `harbor:release-burst` and max8 fireworks at tile38.2,6.6; three circles,100ms stagger,5s expansion,6s record lifetime. Reduced motion shows three fixed circles (`C/ChronicleMonuments.js:45-53,195-196,587-610,743-775`). The invisible-in-shot crown is a framing/readability opportunity, not a missing feature.
- **Aurora already ships, with two routes:** daily persisted `AuroraGate` responds to release, major verified milestone, or large quota rollover; App emits `chronicle:aurora {ts,reason}` and triggers sky (`claudeville/src/application/AuroraGate.js:44-78`; `claudeville/src/presentation/App.js:1445-1473`). Separately successful-push sky routing can trigger a night aurora or daytime flare plus warm grade pulse, without this chronicle cue route (`C/SkyRenderer.js:163-177,286-296`). The optional 1000th-commit gate injection is explicitly absent in current renderer wiring (`C/ChronicleMonuments.js:139-144,689-690`). Do not promise that tier currently emits `chronicle:aurora`.
- **Foreground weather:** rain max180, snow420, fog9 bands, splash stamps6–18/static12, ripple throttle2s/tile with256 tracked tiles (`C/WeatherRenderer.js:30-51,525-529,644-648,728-729,780-782,815-816`). Continuous deterministic weather, not per-agent events. Reduced motion freezes phase and forbids storm flash; P1 removes embellishment (`:143-154,184-203`). Storm candidate cycles7.2s; primary110ms and echo70ms after170ms; one primary event `weather:storm-flash {intensity}`; bolt2–3 branches (`:919-959,997-1004`).

### Complete one-shot audio inventory and existing visual companions

`A/cues/CueKit.js:11-21,160-228` defines exactly nine cue kinds. All emit `audio:cue-played {kind,agentId,label,at}` even without synthesis (`:119-146,244-252`); `S/Toast.js:145-148` already supplies visible captions. Muted audio retains a signal-only ambient route (`S/AmbientAudioController.js:236-238,331-337`). Thus “add captions when muted” would duplicate shipped functionality.

| Cue | Source and current visual companion | Musical accents / cooldown |
| --- | --- | --- |
| arrival | village:scene arrival; arrival ceremony/sigil system | root then fifth +220ms /20s |
| departure | village:scene departure; departure sigil | fifth then root +240ms /20s |
| distress | distress:watchtower errored/rate_limited; incident/agent storm | low bell /30s |
| recovery | distress:watchtower recovered; green diamond/relief particles | third then octave +200ms /30s |
| council | team:gather members.length; council/team scene | 2–5 bells at280ms intervals /60s |
| hourBell | atmosphere clock minute0,08–20h; caption, no dedicated world beat verified |220Hz bell /55min |
| aurora | chronicle:aurora; sky trigger | four notes at160ms intervals /120s |
| summons | attention:raised; existing attention marks and caption | rising pair,145–180ms gap based on wait/count /45s |
| thunder | weather:storm-flash; actual flash/bolt already precedes sound | brown-noise roll,2.4–4.5s /8s |

Routing anchors: `A/AudioDirector.js:227-280,595-606`; `A/BgmDirector.js:86-108,145-155`. Thunder already follows lightning by a random300–1200ms delay; BGM subscriptions do **not** include storm flash. Hour/thunder exempt global chatter budget; routine governor6/min,4s spacing,180ms aggregation; urgent per-agent cooldown bypasses routine budget and cancels queued routine sounds (`A/CueGovernor.js:128-221`). These are not sample-exact shared visual envelopes: synthesis starts engine.now()+30ms (+prepared delay), while announcement uses Date.now and does not expose note offsets (`A/cues/CueKit.js:158,235-252`).

Ambient layers already follow weather/day/season and working counts: hum saturates at6 workers, song rest shortens with working/8; storm lowers music. Pressure reduces wildlife/music and resting mode removes almost all sound (`A/AudioDirector.js:503-592`). BGM is currently phase-playlist driven, not work-section driven (`A/BgmDirector.js:145-149`). BgmPlayer already compiles note events, schedules4-bar chunks on the audio clock, and exposes coarse bar/loop metadata (`A/bgm/BgmPlayer.js:99-207`).

Art direction: the strongest captured effect is **Harbor's release becoming a readable place** (02), not quantity of sparks. The most problematic effect is success vocabulary intruding into failure and storm frames (03,05): a correct release-version celebration can still be contextually misleading. Tiny generic points lose against the gorgeous detailed terrain; chat's rectangular bubbles remain legible because they have a silhouette (04,06). Rings and ribbons often read as faint wiring, and bodies hide the very event they decorate (04,07). More particles would increase texture without fixing identification.

## Proposals

All costs below are estimates, not measurements. P0–P3 mean MarkGovernor pressure; FX FULL/REDUCED/MINIMAL/DISABLED mean the separate PostFX ladder. Every design stays zero-build, dependency-free, Canvas-compatible and count-based. No new global renderer or unbounded effect pool.

### P1 — One event, one visible instrument

- **Pitch:** Replace overloaded square sparkles with a learned shape grammar shared by animated accents and static event marks.
- **What the operator sees:** A hammer's three short slashes, a Mine's stair-step chip, a message's scroll, and an incident's broken bracket cannot be confused even in monochrome.
- **Real data it renders:** `tool:invoked {building,tool,agentId}`, `distress:watchtower.kind`, `subagent:completed`, `harbor:release-burst`, existing relationship chat pairs.
- **Files touched:** `C/ParticleSystem.js:128-171,500-545`; `C/AgentSprite.js:65-74`; `C/VillageDirectorOverlay.js:305-378`; `C/RitualConductor.js:434-455`.
- **Sketch:**
  1. Shape identifies family; palette remains existing material/status palette.
  2. Grammar table: edit→three slash pixels; read→open page; token delta→stepped ore chip.
  3. Message→scroll baton; spawn/return→portal corner rune; recovery→closed diamond.
  4. Incident→broken bracket; release→eight-spoke crown; locomotion/weather→unshaped speck.
  5. Stop using recovery diamond for ordinary handoff; the baton landing keeps its scroll.
  6. Reuse a tiny integer-pixel procedural shape table, no smooth curves/gradients.
  7. Pool cap remains240; semantic reservation64, rest176, still regional admission.
  8. P2 removes ornamental specks; P3 holds one recent semantic mark per occupied region plus count.
  9. Reduced motion allocates no particles: a fixed family glyph held2s uses existing event state.
  10. Canvas draws the same rect patterns; GPU composites existing overlay-safe category.
- **Cost:** M; ~0.03–0.15ms CPU and <0.05ms GPU target at64 semantic particles; <16KB shape/state data; assets no.
- **Risk:** Must reserve grammar across child/provider identity shapes, not erase provider familiar silhouettes. At100 agents coalesce by event family/region, never one glyph per tool call. Fast band only for one-shot accent, no continuous sparkle.
- **Wow 1–5 / Informative 1–5:** Wow4 — tiny marks suddenly look authored rather than sprayed. Informative5 — shape survives dim scenes and color collisions.

### P2 — Shared cue score, not approximate coincidence

- **Pitch:** Let sound and visual accents consume the same admitted event score and scheduled note times.
- **What the operator sees:** A recovery bracket closes on the first bell and its diamond appears on the octave; the second arrival note lands the existing foot rune, rather than another arbitrary pulse.
- **Real data it renders:** Existing accepted CueKit cue kind/agentId and its actual scheduled times; source event identity retained through governor aggregation.
- **Files touched:** `A/cues/CueKit.js:121-158,160-228,244-252`; `A/CueGovernor.js:180-221`; `C/ArrivalDeparture.js:200-202`; `C/VillageDirectorOverlay.js:353-378`; new `S/audio/CueScore.js` only if score table cannot remain in CueKit.
- **Sketch:**
  1. Define fixed cue note offsets once, including urgency-dependent summons interval.
  2. Publish accepted score with monotonic visual start, audio context start, offsets and event key.
  3. Preserve cancellation for prepared routine voices; canceled cue must not leave visual accents queued.
  4. Reconcile audio clock to performance clock on resume, not via repeated Date.now subtraction.
  5. World consumes only accents for already-existing semantic marks; no new ring layer.
  6. Muted route uses the same score at monotonic now; never waits for audio permission.
  7. Urgent state renders immediately; sound scheduling never delays the actual attention state.
  8. Cap8 admitted scores/40 note accents globally; expired beats are dropped, not replayed after hidden tabs.
  9. Reduced motion draws one fixed composite glyph; Canvas uses identical geometry.
  10. P2 drops secondary extra beats, P3 holds only final glyph; urgent static mark survives all FX levels.
- **Cost:** M; <0.05ms CPU/frame for40 offsets, negligible GPU beyond existing marks; <16KB state; assets no.
- **Risk:** Governor announcement can represent a collapsed burst while synthesis was prepared earlier. Preserve representative identity explicitly. No claim that every visible event must sound:6/min routine budget stays.
- **Wow 1–5 / Informative 1–5:** Wow5 — perceptual synchrony makes tiny actions feel physically intentional. Informative4 — operator learns the same event through two channels.

### P3 — The score has a working section

- **Pitch:** Make BGM arrangement state an audible count-based status summary without changing tempo on every poll.
- **What the operator sees:** Beside the existing music control, a static `Working 7 · Waiting 2` section label; the next four-bar boundary thins the music when the village rests and adds the existing counter-line when work resumes.
- **Real data it renders:** `SignalLedger.bucketCounts(world).working`, actionable agent counts already used by `AudioDirector._tick`; BgmPlayer actual piece/bar boundary, not invented moods.
- **Files touched:** `A/BgmDirector.js:32-47,145-149`; `A/AudioDirector.js:510-520`; `A/bgm/BgmPlayer.js:119-207`; `S/AmbientAudioController.js:134-136,551-562`; shared chrome owner to integrate label.
- **Sketch:**
  1. Pass existing World/read-only count source into BgmDirector.
  2. Four count bands:0 working;1–3;4–11;12+; label shows exact counts, never percentages.
  3. Preserve30s quiet-enter/4s leave hysteresis pattern rather than poll-to-poll flutter.
  4. At four-bar boundaries enable existing bass/counter/percussion voices by band.
  5. Do not transpose or switch BPM mid-piece; no extra oscillators beyond currently compiled voices.
  6. Any actionable count ducks nonessential voices immediately; existing urgent cue remains dominant.
  7. Expose actual applied section plus pending next section, not a fictional current state.
  8. Static label is identical under reduced motion; optional single fast boundary tick only atP0/P1.
  9. AtP2/P3 reduce voice density but retain section identity through lead/register choice.
  10. Canvas world needs no change; same shared UI supports Dashboard and muted audio.
- **Cost:** M; less synthesis than current full arrangements in low bands, <0.03ms/frame UI amortized; <4KB section state; assets no, composition review yes.
- **Risk:** A musical arrangement cannot encode an exact roster count alone. Never replace visible counts with music, and never hide a real wait behind a triumphant busy section. 100 agents is one section, not100 voices.
- **Wow 1–5 / Informative 1–5:** Wow5 — the village feels like a composed instrument. Informative4 — status can be monitored while looking elsewhere.

### P4 — Counted work, not emitter density

- **Pitch:** Convert Forge sparks, Mine dust and Harbor spray into bounded event bundles carrying exact coalesced counts.
- **What the operator sees:** One Forge strike throws three readable slashes and leaves `7 edits`; one Mine chip lands with `+1,240 tokens`; one Harbor departure sprays two white chevrons and says `3 pushes`.
- **Real data it renders:** Ritual `count` from250ms coalescing; `__token_delta` input/cargo; successful git events with identity and exit status, not command-string intention.
- **Files touched:** `C/RitualConductor.js:255-261,412-455`; `C/AgentSprite.js:6342-6353`; `C/BuildingSprite.js:3987-4020`; `C/ParticleSystem.js:320-343,412-418`; `C/ChronicleMonuments.js:590-595` for release distinction only.
- **Sketch:**
  1. Coalesce successful work by building and250ms window; retain exact count separately from particle count.
  2. Burst size=min(6,2+floor(log2(count))); never imply each fleck is one event.
  3. Selected/hovered region gets exact count label held1.5s; others get shape only.
  4. Mine sums measured token delta; no fake dust for absent usage coverage.
  5. Harbor successful push spray is an upward chevron; failure keeps broken bracket and no success spray.
  6. Max3 simultaneous district bundles,18 particles,6 source records per district,2 bursts/s globally.
  7. Replace coincident fallback event-like emitter burst, do not layer onto it.
  8. P2 removes loose fallout; P3 fixed count plate only for selected/recent district.
  9. Reduced motion uses count plate and final chip, no spawn; Canvas same shapes.
- **Cost:** M; <0.1ms CPU/<0.05ms GPU target, <8KB aggregation state; assets no.
- **Risk:** Invocation counts are not successful edits unless completion result is known. Label `edit calls` where only invocation is available. At100 agents aggregation remains fixed; do not truncate counted truth when visuals overflow.
- **Wow 1–5 / Informative 1–5:** Wow4 — bursts become heavy, purposeful strokes. Informative5 — volume of actual work is visible without confetti arithmetic.

### P5 — A milestone sky with a provenance seal

- **Pitch:** Make the existing aurora a rare identifiable milestone sentence rather than a second generic push reward.
- **What the operator sees:** A bounded, stepped four-segment sky ribbon appears with `Release v0.44.1 · repo`; its four segment accents align with the aurora notes, then it settles into one static seal.
- **Real data it renders:** Existing `chronicle:aurora {ts,reason}` augmented from the triggering monument's project/label/dedupKey; quota rollover keeps its distinct reason.
- **Files touched:** `claudeville/src/presentation/App.js:1445-1473`; `claudeville/src/application/AuroraGate.js:64-78`; `C/SkyRenderer.js:163-177,286-296`; `A/cues/CueKit.js:197-202`.
- **Sketch:**
  1. Keep the persisted daily gate; never turn a tool completion into a milestone.
  2. Carry sanitized existing project/release label through the accepted milestone event.
  3. Reserve aurora grammar for chronicle milestones; ordinary successful push retains its smaller existing cue.
  4. One active ribbon, at most4 segmented shapes and one provenance seal for8s.
  5. Clip to upper12% of world viewport, never shared chrome or selected-agent label zone.
  6. Match four audio offsets through P2's score contract, not another sine loop.
  7. P1 removes moving segments; P2/P3 retain static seal only.
  8. Reduced motion immediately shows seal and fixed stepped ribbon; no path state.
  9. Canvas rect strips implement identical bounded form; FX MINIMAL/DISABLED keeps the seal.
- **Cost:** M; <0.08ms CPU/<0.1ms GPU target, <8KB state; procedural assets no.
- **Risk:** Current quota-drop inference is not proof of a purchased quota reset; label `quota rollover observed`, not achievement. Sky owner must approve reducing ordinary-push aurora, a deliberate semantic cutover rather than more decoration.
- **Wow 1–5 / Informative 1–5:** Wow5 — rarity and a named cause make the whole village feel consequential. Informative4 — the sky finally answers what happened.

### P6 — Release crown, in the release's actual place

- **Pitch:** Refine shipped release fireworks from remote expanding circles into one screen-readable pixel crown tied to the released repository.
- **What the operator sees:** Above the visible release plaque, eight stepped spokes open once; the tag sits beneath the crown, while failure interrupts celebration admission.
- **Real data it renders:** Planted release record project/label; `harbor:release-burst {project,label,ts,color}`; successful tag/push recognition in MonumentRules.
- **Files touched:** `C/ChronicleMonuments.js:45-53,587-610,743-775`; `C/VillageDirectorOverlay.js:469-498`; `claudeville/src/application/MonumentRules.js:128-146`; `A/cues/CueKit.js:197-202` only for reuse of accepted milestone score.
- **Sketch:**
  1. Reuse one existing firework record; replace three expanding circles, do not add a second firework system.
  2. Anchor above the repository's visible harbor signal, with offscreen event indicated by existing caption.
  3. Never auto-pan or teleport the camera to the firework.
  4. Eight integer stepped spokes, max24 bright pixels per crown, lifetime1.2s; seal/tag persists6s.
  5. Max1 active crown globally, aggregate other releases into `3 releases` caption with inspectable entries.
  6. During active failure, retain release history but defer/drop ornamental crown, not the failure state.
  7. P1 removes trailing pixels, P2 fixed crown, P3 caption/seal only.
  8. Reduced motion immediately fixed crown, no particle allocation; Canvas uses rects.
  9. Real release may reuse aurora cue when gate fires; do not introduce a jingle for every ordinary push.
- **Cost:** S/M; <0.05ms CPU/GPU target, <4KB state; assets no.
- **Risk:** Repository anchor availability needs coordination with Harbor owner. Keep release metadata celebration distinct from actual tag success; captured `PARADE V0.44` during failure is not evidence of a failed push being classified successful.
- **Wow 1–5 / Informative 1–5:** Wow4 — a single readable crown beats invisible rings. Informative4 — clear release identity without claiming all work succeeded.

### P7 — One storm strike contract

- **Pitch:** Preserve existing lightning-first thunder while making its identity and reduced-motion meaning consistent across ambient and BGM modes.
- **What the operator sees:** Normal motion gets one bounded pixel bolt; reduced motion gets a small static storm notch near the weather indicator, and an optional thunder caption, not a full-screen flash.
- **Real data it renders:** `weather:storm-flash.intensity`, atmosphere weather.type/cause; proposed strikeId/visualAt/delayMs derived once by WeatherRenderer.
- **Files touched:** `C/WeatherRenderer.js:919-959`; `A/AudioDirector.js:271-280`; `A/BgmDirector.js:76-109`; `A/cues/CueKit.js:325-353`.
- **Sketch:**
  1. Keep physical delay; literal simultaneous thunder is not an improvement.
  2. Emit one strike descriptor with deterministic seed/cycle identity and chosen delay300–1200ms.
  3. Ambient and opted-in BGM consume that descriptor, never independently roll another strike.
  4. Max1 pending thunder timer,8s cooldown; replace obsolete pending weather rather than queue it.
  5. P1 removes decorative branches, P2 removes full-screen wash; semantic weather mark remains.
  6. Reduced motion schedules no visual strike loop: static storm notch represents current weather only.
  7. Do not synthesize fake strike occurrences merely to keep reduced-motion audio dramatic.
  8. Respect user music-only preference: thunder-over-BGM separately opt-in or leave it absent.
  9. Canvas bolt uses snapped stepped segments; no new shader/fullscreen pass.
- **Cost:** S; lower allocation than current branches, <0.05ms CPU for bounded geometry, <4KB state; assets no.
- **Risk:** BGM intentionally excludes ambience; default thunder in BGM would change product intent. Timeline storm is scenery, fleet storm has operational cause; captions must not equate every bolt with a new error.
- **Wow 1–5 / Informative 1–5:** Wow3 — physical timing is already good, consistency is the gain. Informative3 — exposes storm cause without fake incidents.

### P8 — Token heat is a measured plume

- **Pitch:** A high-rate agent receives one tiny stepped thermal plume driven by measured token rate, replacing its generic token motes.
- **What the operator sees:** Two narrow air bars lift above an agent's shoulder when output is arriving fast; selected detail says `1,240 output tokens / 5s`, not “working hard.”
- **Real data it renders:** Positive deltas of `agent.tokens.output` over observed time; input/cache totals remain separate, with unavailable samples rendered unavailable.
- **Files touched:** `C/AgentSprite.js:6222-6286`; `C/IsometricRenderer.js:4150-4152`; `C/postfx/PostFxFeed.js:10-11,314-325`; existing PostFX haze path only if pixel-safe variant is approved.
- **Sketch:**
  1. Sample output counter at data updates, retain two timestamps plus bounded5s rate window.
  2. Do not treat huge cacheRead jumps as generation speed or lower counter resets as negative heat.
  3. Choose top2 visible hot agents, selected first; require at least two observations.
  4. Replace token motes while plume active; no extra medium pulse on working glow.
  5. Draw two one-pixel stepped displacement bars only in shoulder background, not text/face.
  6. Prefer procedural nondistorting plume first; shader shimmer only inside existing haze pass at FX FULL.
  7. P1 or FX REDUCED sheds shimmer; P2 sheds plume; selected numeric rate stays.
  8. Reduced motion and Canvas fallback use two static heat bars plus observed count window.
  9. Max2 sources globally, no new render target; at100 agents ranking at data cadence, not frame sort.
- **Cost:** M; CPU <0.05ms/frame after data-cadence rank; shader variant budget<0.1ms GPU; <16KB samples; assets no.
- **Risk:** Adapter token totals can update in lumps; title must say observed throughput window, not true instantaneous model speed. Smooth refraction would violate pixel integrity, so kill shader variant if it softens neighboring pixels.
- **Wow 1–5 / Informative 1–5:** Wow4 — unusually physical view of computation. Informative4 — distinguishes real data arrival from idle working status.

### P9 — Completion heartbeat without a flashing village

- **Pitch:** Every confirmed turn completion contributes to one global counted completion beat, not100 screen flashes.
- **What the operator sees:** A narrow completion mark at the world edge steps once and settles to `7 turns finished`; the just-finished agent gets the grammar's closed end mark, with no map-wide brightness pulse.
- **Real data it renders:** Proposed canonical completion event derived only from confirmed completed state plus turn identity/time; existing `Agent.turnStartedAt`, `lastTurnDurationMs`, `signalSource`, `signalObservedAt` are available but are not alone a universal completion ID.
- **Files touched:** `claudeville/src/application/AgentManager.js:63-67,645-650`; `claudeville/src/domain/entities/Agent.js:146-150`; `C/AgentEventStream.js:314` for distinction from child removal; `C/PulsePolicy.js:60-79`; `C/VillageDirectorOverlay.js:512-518`.
- **Sketch:**
  1. Coordinator must establish confirmed turn identity across adapters before drawing completion beats.
  2. Never equate idle/waiting, tool finish, subagent removal or positive token delta with turn completion.
  3. Deduplicate by agent+turn identity, not by duration alone; identical durations can recur.
  4. Aggregate accepted completions into250ms windows, count every event exactly once.
  5. One 180ms fast-band step, maximum1/s; further completions update count without restarting motion.
  6. Hold exact recent count for5s; no full-world color/brightness pulse.
  7. Max1 global beat and4 recent local end marks;100 simultaneous completions reads `100 turns finished`.
  8. P1 removes local beats; P2/P3 static count only; urgent incident always wins placement.
  9. Reduced motion and Canvas use fixed end mark/count; no animation state allocated.
- **Cost:** M, dependent on trustworthy data contract; <0.03ms CPU/frame, negligible GPU, bounded128 identities/<24KB; assets no.
- **Risk:** This is the one proposal with a prerequisite not established by the current inspected schema. Do not ship inferred success. Across-room signal must not become a distracting flashing border or another audible beep budget.
- **Wow 1–5 / Informative 1–5:** Wow4 — work has a legible collective cadence. Informative5 — distinguishes completed work from mere busy motion.

### P10 — Council notes mark participants, not the ring

- **Pitch:** On an actual gather, each council note places a brief static participant notch while the council outline remains static.
- **What the operator sees:** Two to five small square notches appear successively at actual gathered members' feet; after the final note the team count sits on the quiet outline, making membership legible through a crowded bridge.
- **Real data it renders:** `team:gather.members`, `centroidArc`, `teamName`; actual CueKit council note count/offsets.
- **Files touched:** `C/CouncilRing.js:170-175,194-241`; `A/cues/CueKit.js:180-190`; `C/AgentSprite.js:6828-6871` only to avoid familiar overlap; shared score contract from P2.
- **Sketch:**
  1. Never restore the removed council-ring shimmer.
  2. Bind notches to accepted gather member IDs and current sprite feet; no new fake conversational edge.
  3. Up to5 note accents, but notch count label states full members.length.
  4. One team ceremony active globally, same5min team cooldown and60s audio council limit.
  5. Use fast one-shot appearance, not medium repeating orbit.
  6. Where bodies occlude feet, place static notch on existing visible team label instead of screen-space orbit.
  7. P1 reduces to team centroid count; P2/P3 ordinary static council outline/count only.
  8. Reduced motion instantly displays final notches and count, no note timers.
  9. Canvas integer rectangles in existing relationship pass; no extra textures or lights.
- **Cost:** S/M; <0.04ms CPU/GPU target; <4KB state; assets no.
- **Risk:** Global audio governor may suppress the sound; visual gather still gets final static membership mark. At100 agents do not create20 five-note ceremonies or expand all familiar orbits.
- **Wow 1–5 / Informative 1–5:** Wow4 — a quiet musical roll call is more intentional than more rings. Informative4 — turns a social blob into identifiable participants.

## Top three

1. **Shared cue score, not approximate coincidence (P2).** This is the best craft multiplier: the existing village already owns instruments, gestures and rich semantics, but not a single admitted time contract. Tightening phase and identity makes fewer pixels feel more physical. Crucially, it retains immediate attention and silent accessibility instead of making rendering subordinate to sound.

2. **One event, one visible instrument (P1).** Current texture is rich enough; the next frontier is distinguishing causes. A small, consistent shape alphabet works in daylight, storm, reduced motion and monochrome, and creates a reusable standard for every other proposal. It is subtractive work: remove overloaded sparkles before adding more effects.

3. **The score has a working section (P3).** The existing BGM compiler is a unusually favorable seam for an expressive feature without new dependencies or renderer work. Count-driven arrangements make the product useful while the operator's eyes are elsewhere. Section changes must be musically paced and actual actionable counts must remain explicit.

## Rejected

- “Add fireworks for releases”: already implemented; refine placement/shape instead (`C/ChronicleMonuments.js:587-610,743-775`).
- “Sync thunder to lightning”: already implemented with a sensible physical delay (`A/AudioDirector.js:271-280`); zero-delay synchronization would be worse.
- “Add visible captions for muted users”: already implemented via signal-only routing and Toast (`S/AmbientAudioController.js:236-238`; `S/Toast.js:145-148`).
- Every completion flashes the entire island:100 agents turns this into an unreadable strobe and competes with incidents; one counted edge mark is safer.
- Continuous council-ring pulse: explicitly static contract, already deliberately removed (`C/CouncilRing.js:194-197`).
- More familiar motes for every child: three-per-parent cap already exists; extra orbits do not reveal child state (`C/AgentSprite.js:91,6828-6871`).
- Unbounded particle volume proportional to token count: poll bursts and cache reads would turn instrumentation into confetti; bounded shapes plus exact count win.
- Generic aurora every busy minute: no real milestone, erodes the existing daily Chronicle gate (`AuroraGate.js:64-78`).
- BGM BPM follows every work-count change: semantically twitchy and musically unpleasant; section boundaries and hysteresis are the appropriate timescale.
- Audio waveform visualizer over village: renders the mixer, not coding work; it competes with the useful world without answering a new operator question.
- Smooth heat-refraction over sprites: destroys authored pixel edges and risks distorting attention text; bounded stepped plume first.
- New WebGPU/OffscreenCanvas effects renderer: no measured trigger established, and existing overlays/score seams suffice.

## Open questions for the coordinator

- No audio audition or calibrated audio/visual latency measurement was performed; P2 remains a design, not a proven synchronization result.
- The early helper reported null ladder/hour; do not present requested21h or FPS readings as calibrated atmospheric/performance evidence. All captures were concurrent-host observations.
- Actual release crown framing and the unrelated `PARADE V0.44` seen during failed-push/storm need product arbitration. Is startup version celebration desirable during an active incident? The captures establish visual coexistence, not the source of every parade.
- Canonical cross-provider **turn completion identity** is necessary for P9. Inspected turn timing fields do not prove a universal completed-turn event. This must not be filled with “working→idle means done.”
- Decide whether an ordinary successful push should still own aurora grammar, or whether only Chronicle milestones should. There are currently two trigger routes and only the chronicle route requests the aurora cue.
- A single frame cannot verify the absence of continuous motion. Scenario metadata and source gating support reduced-motion intent, but the conspicuous Harbor flock in05 deserves a focused time-pair capture by the fauna owner.
- Inventory scope follows the assigned effect owners and their immediate emitters; ancillary harbor/sky/arrival details were anchored where they intersect this territory, not a full independent audit of all sky and ship internals.
