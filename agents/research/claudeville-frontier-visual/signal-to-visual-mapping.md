# Signal-to-visual mapping frontier

## Territory and method

Read-only investigation of the path from provider observation to embodied operator information. No source, configuration, provider store, or maintained-server lifecycle was changed. Only this note and its three JPEGs were written; no tests, validators, formatters, or gates were run.

Files read or searched: `AGENTS.md`; `agents/README.md`; `claudeville/CLAUDE.md`; the three presentation READMEs; `docs/visual-experience-crafting.md`, `world-visual-qa-checklist.md`, `rendering-baselines.md`, `motion-budget.md`, `building-style-contract.md`, `material-channel-contract.md`, `troubleshooting.md`; `agents/plans/claudeville-fable-5.1-enhancement-implementation-plan.md`; `claudeville/server.js`; `claudeville/adapters/{README.md,index.js,sessionPresentation.js,claude.js,codex.js,gemini.js,grok.js,kimi.js,omp.js,opencode.js,hooks.js}`; `claudeville/services/{workingSet.js,usageQuota.js}`; `claudeville/src/domain/entities/{Agent.js,World.js}`; `claudeville/src/domain/value-objects/TokenUsage.js`; `claudeville/src/application/{AgentManager.js,AttentionService.js,SessionWatcher.js,MoodService.js,AgentBiographyService.js,RelationshipAffinityService.js,ChronicleLog.js,MonumentRules.js,ModeManager.js}`; `claudeville/src/infrastructure/{WebSocketClient.js,ChronicleStore.js}`; `claudeville/src/presentation/App.js`; `claudeville/src/presentation/shared/{ActivityPanel.js,Sidebar.js,TopBar.js,AgentSelection.js,ChroniclePanel.js}`; `claudeville/src/presentation/character-mode/{AgentEventStream.js,RelationshipState.js,ChronicleEvents.js,VillageDirector.js,AgentSprite.js,IsometricRenderer.js,WorldFrameRenderer.js,TaskboardBoardModel.js,LandmarkActivity.js,VisitIntentManager.js,RitualConductor.js,BuildingSprite.js,TrailRenderer.js,CameraDirector.js,HarborTraffic.js,ChronicleMonuments.js,CouncilRing.js,WeatherRenderer.js,MarkGovernor.js}` and simulator fixtures.

The requested `src/application/VillageDirector.js` does not exist: its actual owner is `src/presentation/character-mode/VillageDirector.js` (class at line 87). `ChronicleEvents.js:1–18` is now a re-export boundary, not a large event reducer.

Visually inspected captures, all 1920×1080, zoom 1, 12-second requested wait, and real `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)`:

- `agents/research/claudeville-frontier-visual/shots/signal-to-visual-mapping-01.jpg`: `mixed-tools`, six agents, selected completed worker, active buildings and sparse conversational marks.
- `agents/research/claudeville-frontier-visual/shots/signal-to-visual-mapping-02.jpg`: `multi-provider-showcase`, seven providers, selected approval wait carrying HOOK / observed / stale detail.
- `agents/research/claudeville-frontier-visual/shots/signal-to-visual-mapping-03.jpg`: live feed, sixteen agents, a conspicuous research-worker crowd at the Mine and truthful live tool-intent bubbles.

The first version of the supplied helper reported `postFxLevel: null` and `hour: null`, despite requested hours 14/17/14 and clear weather. These are **not** evidence of a particular quality-ladder level or successful time override. All three helper reports had no console errors. Other explorers were capturing concurrently; FPS visible in stills is not a benchmark.

Read-only `curl` observations: `/api/sessions` returned the envelope `sessions, collisions, count, timestamp, scanning, staleAt, gitEventFields, gitEventStringTables, gitEventsById`. A later sampled roster contained 16 sessions, two Codex and fourteen OMP. One Codex session had an observed turn start, null last-turn duration, empty working set, observed billable usage, non-null estimated cost, and roughly 182k context tokens out of 258.4k capacity. Its `/api/session-detail?provider=codex&sessionId=<redacted>&project=<redacted>` returned 15 tool rows with keys `tool, detail, ts, durationMs, toolExitCode`, zero messages, fresh observation metadata, and token usage. This is direct evidence that command duration/outcome reaches the detail API today. Session IDs, absolute home/project paths, prompts, command text, and exact financial figures are intentionally omitted here. The live JPEG necessarily contains visible local project/agent labels: treat it as local review evidence, not a publication-ready asset.

## Current state

### Reading the village as an instrument

The island is beautiful because its places are legible: Archive's glowing book, Forge's bright mouth, Mine's cut cyan seams, and Harbor's projecting deck remain recognizable even while characters overlap them (shots 01–03). Tool destination already answers “what kind of work?” without requiring text; the hand props and building bubbles reinforce the answer (shot 01; `AgentSprite.js:6356–6361`, `RitualConductor.js:355–357`).

The informative gap is **not a lack of animation**. In shot 03, the Mine has a solid knot of nearly identical silver workers and multiple text bubbles. It is lively, but I cannot tell which of those workers shares a file, which observation is stale, or which one is burning expensive output rather than rereading cached context. In shot 02, the exact reason and stale provenance of Astra's approval are legible in the panel, while the body contributes a generic question mark. Ember is specifically stale in the fixture (`WorldScenarios.js:1034`), yet looks as physically present as the fresh workers. That equal-confidence embodiment is the largest truth gap.

Do not re-propose these shipped ideas: context pressure already draws a foot gauge and a selected percentage chip (`AgentSprite.js:3409–3470`); token classes already feed Mine activity (`LandmarkActivity.js:56–71,405–409`); token flow totals already exist on the character (`AgentSprite.js:6280–6286`); TodoWrite/plan phase groups already drive the actual Task Board (`TaskboardBoardModel.js:111–145`); parent and team membership already generate relationships (`RelationshipState.js:131–165`); quota incidents already belong to Mine (`VillageDirector.js:159–172`); errors and observed rate limits already trigger watchtower distress/recovery (`VillageDirector.js:502–547`). More rings, generic rain, todo chalk, and child tethers would mostly repeat existing language.

### Payload inventory and world-consumer matrix

Anchor abbreviations below are exact paths, not conceptual modules:

- **N** = `claudeville/adapters/index.js`; **P** = `claudeville/adapters/sessionPresentation.js`.
- **A** = `claudeville/src/domain/entities/Agent.js`; **M** = `claudeville/src/application/AgentManager.js`.
- **S** = `claudeville/src/presentation/character-mode/AgentSprite.js`; **D** = `claudeville/src/presentation/character-mode/VillageDirector.js`.
- **R** = `claudeville/src/presentation/character-mode/RelationshipState.js`; **L** = `claudeville/src/presentation/character-mode/LandmarkActivity.js`; **T** = `claudeville/src/presentation/character-mode/TaskboardBoardModel.js`.

Coverage abbreviations: C Claude, X Codex, G Gemini, K Kimi, Rk Grok, O OpenCode, Pm OMP. “All” means the seven adapter contracts, **not seven guaranteed non-null observations**. Unless overridden, freshness is provider scan freshness: list cache 2s, detail 5s, failed observations retained stale at most 60s (`adapters/README.md:23,128`; N:381–383,416,475–499). A new file observation is not necessarily a new observation of every semantic field.

This enumerates the normalized gate fields, presentation decoration, known optional adapter additions, and the browser Agent projection. The gates deliberately spread `...session` and `...value` (N:186,246), so arbitrary future provider additions are not a closed schema. Unknown passthrough keys cannot honestly be advertised as universally normalized fields.

| Field(s), type | Provider coverage / freshness | World embodiment today or NONE; evidence |
|---|---|---|
| `sessionId: string`; `agentId: string|null` | All; G agentId nullable; identity lifetime | Sprite identity, selection, membership. N:187–189; M:568,583–590; IsometricRenderer.js:1680–1700. |
| `provider: string`; optional `underlyingProvider: string` | All; underlying Pm explicitly, not guaranteed for O | Model/CLI identity; provider present in D snapshots. N:188; adapters/README.md:94; D:859–861. Underlying-provider distinction itself: NONE in Agent projection M:582–671. |
| `agentType: string`; `subagentKind: string|null` | All; explicit subagent kind C | Roles/summoning; AgentEventStream.js:267–276. N:190,206–208. |
| `agentName: string|null`; optional `name`, `nickname` | Names provider-dependent; X index, C team, Pm child names | World name tags, with fallback generated names. N:191; M:570; A:98–110. |
| `project: string|null` | All; G may be unresolved | Repository-colored grouping/Director routes; M:669; D:875–902 groups team/parent, not inferred project teams. Actual live project badges in shot 03. |
| `model: string`; `reasoningEffort: string|null`; optional `effort` | All model; X and Rk effort explicitly; others when recorded | Body/accessory identity, not throughput. N:193,211; P:230–254; adapters/grok.js:868. |
| `displayModel`, `modelColor`, `spriteId: string|null` | All decorated; unknown identity may have null sprite | Presentation hints from P:251–254; browser recomputes identity through A:179, not a separate operational signal. |
| `status: string` | Adapter typically active; client derives execution state | Status marks and incident posture. N:194; M:571,595; D:502–547. |
| `lastActivity: number`; optional `departedAt` | All timestamps; file/record recency, not progress | Presence/departure and selection priority; M:572–574; A:158–169. Exact activity age: NONE as distinct world age encoding. |
| `lastTool`, `lastToolInput: string|null` | All best effort; last observation can outlive active tool | Current destination, ritual, tool-intent bubble. N:196–197; M:574,615–618; AgentEventStream.js:320–327; S:6356–6361. |
| `lastMessage: string|null`; `lastPrompt: string|null` | Text broadly, prompt explicit C/X/Pm | Attributed dialogue only where provenance supports it; raw prompt is not a new arbitrary speech source. N:198–203; M:619–621,663–666; S:5807–5811. Prompt identity itself: NONE. |
| `dialogue: object|null` (`text/source-kind/time/truncation/redaction` contract); `observedSources: {toolIntent,planStep,thinkingPlaintext,assistantText}: boolean` | Provider-specific observed material, false/null when unsupported | Attributed speech and source tooltip; N:199–203; A:173–178; S:156–159,5807–5811. |
| `tokenUsage: object|null`; accepted raw `tokens`, `usage` aliases | All contract; Rk billable unavailable | Mine/resource activity and context pressure. N:204; L:56–71; S:3409–3430. |
| Usage numeric `input, output, total, totalInput, totalOutput, cacheRead, cacheCreate, cacheWrite` | C/X/G/K/O/Pm where recorded; Rk context-only | Total flow and cache class at Mine; S:6280–6286; L:65–71. These are cumulative quantities, not trustworthy instantaneous speed. TokenUsage.js:8–34,67–107. |
| Usage `availability: observed|partial|unavailable` | All normalized | L:70 gates token classes; no distinct “missing billable telemetry” world symbol. N/P defaults must not be read as observed zeros; adapters/README.md:171. |
| Usage `contextWindow, contextWindowMax: number` | C/X/G/K/Rk/O; inspect Pm model/source before promising occupancy coverage | Existing pressure ring, S:3412–3430. G uses largest observed message total (gemini.js:306–310), not identical semantics to X last-token occupancy (codex.js:1191–1194). |
| Usage `turnCount: number`, `reasoningTokens: number`, `reasoningInOutput: boolean` | Provider-dependent, X/O semantics differ | NONE as distinct world signals; TokenUsage.js:16–20,103–107; adapters/README.md:164–167. Reasoning flag prevents double pricing. |
| Optional usage `reportedCost: number` | O (`opencode.js:261`) | Prefer canonical `cost`; NONE separately. |
| `estimatedCost: number|null`; `cost: {usd, availability?, source, rateMatch, rateRevision, unknownModel}` | Estimate available for six billable providers; provider-reported C/O when present | NONE for price/provenance/burn-rate in world. P:230–250; A:116–118. Existing total-token glow S:3625–3627 is not money velocity. |
| `parentSessionId: string|null` | C/X/K-Code/Rk/O/Pm; G null | Existing child membership/summoning/handoffs, R:139–149; AgentEventStream.js:267–276; D:905–910. Deep lineage depth: NONE as a distinct encoding. |
| `workflowId`, `workflowName: string|null` | C workflow subagents | Stored A:105–106; grouping via parent remains. Exact workflow name/depth: NONE as distinct world vocabulary. N:212–213. |
| `taskProgress: {done,total,source}|null`; `tasks: [{subject,status}]` | C exact task store or inferred children; N normalizes all | Stored M:605–613. Separate execution progress: NONE on world Task Board, which specifically consumes `todos` (T:6–10). C producer: claude.js:213–218,242–250. |
| `todos: [{subject,status,phase}]` | C TodoWrite, X update_plan, Pm todo folding | Shipped chalk list/phase count. A:29–42; T:111–145; adapters/README.md:107. Snapshot persists until another plan operation. |
| `gitBranch: string|null` | C/X/Pm verified | Stored M:622–624; branch identity is carried through Harbor event state, not a universal per-character branch flag. NONE for independent character branch change. |
| `permissionMode: string|null` | C modes; X only full-auto variants mapped to bypass | Policy influences pending semantics; no specific world depiction of approval policy. N:214; codex.js:217–222. “Plan mode” vocabulary is already part of mixed-tools QA (`world-visual-qa-checklist.md:19`); do not conflate policy with an observed wait. |
| `turnState: working|tool_pending|awaiting_input|unknown` | C/X/K-Code/O/Pm rich; G/Rk narrower | Converted status / destinations / incidents. N:215; M:571,627; D:502–517; adapters/README.md:115. |
| `pendingTool: string|null`, `pendingSince: number|null` | Same lifecycle coverage, optional hooks | Work/question attention, but pending duration alone never approval. N:216–217; A:143; D:502–517. Exact pending age: NONE as distinct world clock. |
| `waitReason: question|approval|plan_review|null`, `awaitingSince: number|null` | Explicit tool evidence; opt-in hooks add exact approvals | Generic waiting incident already exists; subtype object/posture distinction missing in shot 02. N:218,236; A:144–145; D:502–517. |
| `turnStartedAt: number|null`, `lastTurnDurationMs: number|null` | Start C/X/K-Code/O/Pm; duration C explicitly | NONE as distinct world duration. Stored A:146–147; statusSince A:202–221; producers codex.js:948–1004, kimi.js:1084–1162, omp.js:373,456, opencode.js:449–493, claude.js:469–471,1752. |
| `signalObservedAt: number|null`, `signalCertainty: observed|inferred|unavailable`, `signalSource: hook|transcript`, `signalStale: boolean` | All normalized certainty; hooks opt-in | NONE for body-level certainty; provenance visible in panel shot 02. N:229–234; A:148–154. |
| `freshness: {state,observedAt,ageMs}` | All registry observations; fresh/stale/unavailable | NONE as body-level observation loss; shot 02 stale Ember and fresh bodies remain equivalent. N:381–383,416,490–499. |
| `promptDetail?: string` | Hook-only, capped/redacted | Carried into existing input/text slots by hooks.js:143–147; full hook banner shot 02. No separate raw input speech. N:232–234. |
| `workingSet: [{path,op,at,source}]` | C read/write, X FileChange writes, hook path overlay; not all-provider guaranteed | NONE as world file ownership. N:175–183,235; M:657; claude.js:492–499; codex.js:603–632. |
| Top-level `collisions: [{path,project,agents,kind}]` → agent `collisions` | Only observed working sets; read/read silent | NONE as world overlap. server.js:1489–1496; workingSet.js:59–96; M:674–685. Not proof of an actual merge conflict. |
| `resident: boolean` | Server-held unresolved snapshots, all providers | Presence survives, but no unique stale-resident body seal. N:237; A:138–157; adapters/README.md:120,128. |
| `sendMessages: [{recipient,messageType,summary,ts}]` | C explicit tool edges | Existing chat pairing/handoffs rather than invented conversation. N:238; adapters/README.md:121; AgentEventStream.js:433–453. |
| `gitEvents: array` | Seven adapters best effort plus synthetic git repository sessions | Harbor ships, failures, commit history; session transport compacts to references. N:239; M:625,688–705; HarborTraffic.js:2865–2920; ChronicleEvents.js:5–18. |
| Event fields `id,type,project,provider,sessionId,sourceId,ts,commandHash`; optional `command,targetRef,success,exitCode,completedAt` | Command parsing, completion confidence provider-dependent | Harbor outcome. adapters/README.md:122,134–144; M:500–506 emits only verified outcomes. No assumption every push invocation succeeded. |
| Optional `rateLimit: {enforced:boolean}`, `accountId` qualifiers | C rejection explicitly; generic hook/account contract narrower than quota presence | Status → watchtower distress, not pressure-as-enforcement. claude.js:1812; adapters/README.md:132; D:525–547. |
| Optional C `linesAdded,linesRemoved:number|null`; `hookErrors:number|null`; `modelHistory:[{model,effort,at}]`; `contextWindowMax` | C transcript projection; current scan carries latest accumulated values | NONE; not included in browser Agent projection M:582–671. Producers claude.js:429–478; returned projection claude.js:1721–1724. This is already parsed, not an adapter gap. |
| Detail `provider,sessionId,project,agentName,tokenUsage,gitEvents` | All detail gate; git synthetic detail special | Identity/tokens above; detail normally consumed by DOM, not world. N:243–255; shared/README.md:39–52. |
| Detail `toolHistory:[{tool,detail,ts,toolExitCode?,toolStderr?,durationMs?}]`; `messages:array` | All history shape; X/K-Code/O failure data, X durations verified live | NONE for command result beyond git-specific outcomes. N:250–251; adapters/README.md:74; codex.js:1322–1328. Tool invocation rituals must not be mistaken for successful validation. |

Additional browser fields are projections rather than new telemetry: `id/name/role/teamName/projectPath/currentTool/currentToolInput/lastSessionActivity/activityAgeMs`, derived `statusSince`, temporary `departedAt`, appearance, position, target position, and animation frame (`M:582–671`; `A:158–183,202–221`). Mood is a telemetry-derived projection, not a source field (`A:171–172`). Team names are explicit metadata, never inferred from common working directory (`M:576–580`). API envelope `scanning/staleAt/timestamp` and compact git dictionaries describe delivery, not agent execution (`server.js:406–414`; `M:688–705`). `/api/teams` and `/api/tasks` are C-only, with the latter not a product UI feed (`claudeville/CLAUDE.md:13`; adapters/README.md:80–85).

### Event-bus families

The bus is global without replay/persistence (`claudeville/CLAUDE.md:43–45`). Most derived presentation events timestamp observation, not the underlying CLI occurrence. Do not compute tool latency by subtracting their receipt times. Table covers emitted event families and additionally identifies integration aliases observed as subscriptions; an alias listener is not proof of a live producer.

| Family / concrete members | Producer anchor; payload | Existing world consumer or NONE |
|---|---|---|
| `agent:added/updated/removed` | domain/entities/World.js:15,22,30; Agent | IsometricRenderer.js:1680–1700, all body lifecycle. |
| `agent:selected/deselected`; `agents:pins-changed` | shared/AgentSelection.js:7,11; ActivityPanel.js:966,1424; Agent or IDs | TrailRenderer.js:213–214; selected/pinned Task Board selection T:29–44. |
| `tool:invoked/retried` | AgentEventStream.js:320–327; AgentBehaviorState.js:389; agent/tool/input/timestamp or retry count | RitualConductor.js:356; D:121. Invocation is not completion. |
| `subagent:dispatched/completed` | AgentEventStream.js:267–314; parent/child IDs, type, lastTile | IsometricRenderer.js:1712–1714; D:122–123. “Completed” here follows removal, not verified exit success. |
| `team:joined/gather`; `chat:started/ended` | AgentEventStream.js:278–300,433–453; CouncilRing.js:171; membership/pair IDs | D:124–125; R:169–181 and existing council ring. |
| `building:congestion/active-agents/read-intensity`; building selected/deselected constants | World.js:55; L:671–674; IsometricRenderer.js:2738,3519–3521 | BuildingSprite.js:310–317; D:133–135; occupancy lights/labels. |
| `village:director/building-signal/scene/replay/camera-cue` | D:210,352–353,418,736; bounded scene/snapshot/target records | Existing route/handoff/replay overlays (character-mode/README.md:160); CameraDirector.js:244. |
| `village:population/state` | BuildingSprite.js:543; App.js:462–473; count or canonical app state | Population is existing scene/chrome state; operational link phase chiefly shared surfaces (shared/README.md:37), no provider-specific embodiment. |
| `usage:updated`, `quota:throttled`, `agent:throttle-tint` | SessionWatcher.js:117; WebSocketClient.js:257,265,360; App.js:1462; VisitIntentManager.js:757–766 | Existing Mine quota incident D:126,159–172. A pressure event is not an enforced rejection. |
| `distress:watchtower` | D:533–547; affected agent, status/recovery | BuildingSprite.js:343; character recovery S:6297–6307. |
| `harbor:updated/release-burst/milestone-lock/repo-christened` | WorldFrameRenderer.js:556; ChronicleMonuments.js:590,686; HarborTraffic.js:4439 | D:127–128; ChronicleMonuments.js:154. `harbor:push-success` / `git:pushed` have listeners IsometricRenderer.js:1731–1737; do not assume those aliases fire from every adapter. |
| `chronicle:log-ready/log-stopped/recorded/status/milestone/aurora/milestone-banner` | ChronicleLog.js:147,193,385; ChronicleStore.js:267; MonumentRules.js:280; App.js:1452,1466; ChronicleMonuments.js:697,730 | Monuments/parade D:129–130; log storage state itself NONE. |
| Verified outcome constant | AgentManager.js:500–529; ChronicleEvents.js:10–18 re-exports domain contract | Existing git/milestone reward channel, not generic test verdict. |
| `biography:updated`, `affinity:ready/changed`, `mood:changed` | AgentBiographyService.js:342; RelationshipAffinityService.js:191,200,519,552; MoodService.js:287 | Biography tags IsometricRenderer.js:1742; D:132; relationships/mood are derived state, not permission or failure proof. |
| `attention:raised/cleared`, unattended digest constant | AttentionService.js:268–279,351; agent/status/label/digest | Selection bridge AttentionService.js:296; otherwise NONE distinct from existing status cues. |
| `mode:changed`, `camera:auto-camera` | ModeManager.js:23; TopBar.js:267,393,455 | IsometricRenderer.js:1740,1843; world lifecycle/camera. |
| `ws:connected/disconnected/init/update/message/state`, `watcher:state` | WebSocketClient.js:170,201,256–275,359,434; SessionWatcher.js:58–124 | App/shared connection state; NONE for individual-provider observation loss. |
| `fps:updated`, `world:frame-error` | IsometricRenderer.js:2002,3820,3858 | Diagnostic/chrome, not workload; NONE semantic world telemetry. |
| `atmosphere:updated`, `weather:storm-flash`, `audio:cue-played` | IsometricRenderer.js:3862; WeatherRenderer.js:941; shared/audio/cues/CueKit.js:247 | Atmosphere/sound synchronization; these describe presentation output, not provider events. |
| Dashboard filter/request constants, ChroniclePanel dynamic notification event | Sidebar.js:663; DashboardRenderer.js:534; ChroniclePanel.js:507 | NONE independent world embodiment; do not turn interface plumbing into weather. |

### Raw data not yet normalized, and what actually shipped

| Raw source / field | Current evidence and verdict |
|---|---|
| C `cost-state.totalCostUSD`, `hasUnknownModelCost`, `totalLinesAdded/Removed`; system `turn_duration.durationMs`; `last-prompt`; TodoWrite; branch; `hookErrors`; model/effort transitions | **Shipped parsing**, claude.js:429–499. Cost retained by P:237–250; durations/working set reach A:146–155. Lines/hook errors/modelHistory do not survive M:582–671 into Agent. This is a client projection gap, not justification to rebuild ingestion. |
| C `cost-state.modelUsage`, `totalAPIDuration`, `totalToolDuration`; stop-hook `hookCount`, `preventedContinuation` | Historical on-disk evidence is the Fable plan:240. No matching consumption in the current C/X adapters searched; current projection claude.js:448–499 omits them. Candidate timing/coverage fields, **not freshly verified local raw-store availability** in this round. Need fixtures before implementation. |
| X `item_completed.CommandExecution` exit/duration/start/end; FileChange paths | **Shipped**: codex.js:1296–1328 projects duration and exit; :603–632 projects writes. Live detail confirms both `durationMs` and `toolExitCode`. No world result shelf yet. |
| X `approval_policy` | **Partly normalized intentionally**: codex.js:217–222 maps only full-auto / never-ask / never to bypass. The rest of policy identity is discarded; it is not an exact approval event. |
| X `sandbox_policy`, `permission_profile`, `workspace_roots` | Historical raw evidence Fable plan:251; no references in the searched current adapter. Leave absent until current provider fixtures establish shape. These could describe sandbox boundaries, but a village fence would imply stronger isolation guarantees than this data proves. |
| O `session.cost`, token reasoning/cache split, step tokens; tool `state.metadata.exit/stderr` | **Shipped**: opencode.js:236–261,497–502,644–647,737. Do not propose provider cost or exit ingestion again. |
| Pm user turn boundary, child paths, todos phases, branch, underlying provider | **Shipped**: omp.js:373,449–456,560–561; no `workingSet` producer found in this adapter. Its raw tool argument/result structures are a promising coverage expansion, but exact path extraction must be verified before claiming file overlap for OMP. |
| G token totals; Rk ACP `totalTokens`; K Code turn/tool-result markers | **Shipped but unequal semantics**: gemini.js:306–310; grok.js:707–736; kimi.js:1083–1192. Rk total is context-only and cannot support a spend meter. K legacy parent/turn coverage differs from Code. |
| Hook `{provider,sessionId,cwd,ts,kind,tool,input,decision?}` | **Shipped opt-in overlay** with redaction, bounds and expiry; docs/troubleshooting.md:39,151–153; hooks.js:143–147. Exact pending approval remains last-observed after ten seconds, bounded at thirty minutes. Do not silently demote such a wait to “working” because it is old. |

## Proposals

All estimates below are engineering targets, not measurements. All designs use existing zero-build JS and retained Canvas/GPU overlay seams; no dependency, framework, new full-screen pass, or extra atmosphere layer. Counts are counts, not percentages. `NONE` in the matrix means no distinct embodiment found in this scoped current code search, not a claim that the signal lacks DOM presentation.

### P1 — The last-observed seal

- **Pitch:** Make the difference between a live worker and a remembered worker visible on the worker itself.
- **What the operator sees:** A stale worker keeps its identity and required attention mark, but loses active hand motion and carries a tiny split-corner slate seal; a selected one reads `Last observed 25s ago`, never `Idle 25s`. On recovery the seal simply clears. In shot 02 this would immediately distinguish Ember from nearby active workers without opening its panel.
- **Real data it renders:** `freshness.state/observedAt/ageMs`, `signalStale`, `signalObservedAt`, `signalCertainty`, `resident`; use observation age separately from execution-state age.
- **Files touched:** `Agent.js:148–157` already stores inputs; `AgentSprite.js:6356–6364` gates tool gesture; `IsometricRenderer.js:1697–1700` update boundary; existing `MarkGovernor.js:55–67` admission; optional small pure resolver beside AgentSprite.
- **Sketch:**
  ```text
  On agent update, resolve fresh / stale observation / unavailable evidence.
  Never convert freshness to execution status or invent a provider outage.
  Keep exact unresolved approval as the primary mark even when stale.
  Stop claiming newly active work through ritual motion for stale snapshots.
  Add one secondary static cut-corner seal, only when it earns admission.
  Selected text uses observation timestamp, never last file mtime as progress.
  Group routine stale residents into a building count at dense load.
  Reduced motion is the same static seal; allocate no pulse state.
  Canvas and GPU upper overlays use the same snapped draw callback.
  ```
- **Cost:** S/M; target <0.03ms CPU and <0.02ms GPU/frame for admitted seals; O(agents) update-time resolution, <16KB state for 100 agents; no generated assets.
- **Risk:** Stale does not mean idle, dead, or provider down. Do not grey out a primary approval until unreadable. At 100 agents show selected/action-needed seals plus grouped `6 stale` count, not 100 extra icons. Static band; independent of optional PostFx quality.
- **Wow 1–5 / Informative 1–5:** Wow **3** — a quiet but striking change from equal-confidence puppets to a truthful living map. Informative **5** — prevents mistaken action on stale evidence across all seven provider contracts.

### P2 — Turn sand, not a progress bar

- **Pitch:** Give ongoing turns a visible clock that measures elapsed work without pretending to know how much remains.
- **What the operator sees:** Beside the selected worker's existing tool prop stands a small three-notch sand timer; its base reads `2m 18s`. Other unusually long current turns receive one static elapsed notch, never a filling completion arc. A completed turn can leave `Last turn 38s` briefly before disappearing.
- **Real data it renders:** `turnStartedAt`, `turnState`, `lastTurnDurationMs`, `pendingSince`, freshness. The five rich-lifecycle adapters provide starts; only explicitly reported completed durations earn “last turn” text.
- **Files touched:** `Agent.js:202–221` already resolves statusSince; `AgentSprite.js:6356–6364` local prop seam; `VillageDirector.js:852–870` snapshot optionally adds age cohort; `AgentManager.js:640–649` supplies fields.
- **Sketch:**
  ```text
  Use epoch now minus observed turnStartedAt, clamped nonnegative.
  Freeze displayed evidence and add stale seal when observation is stale.
  Bucket visual notches into elapsed durations, not model-relative speed.
  Explicitly label active turn versus pending tool; never sum both clocks.
  No expected finish time and no elapsed-to-approval heuristic.
  Admit precise time only on selected agent; group other long turns.
  Update text on shared one-second cadence rather than render frames.
  Static pulse band; reduced motion uses identical timer silhouette.
  Render the same snapped upper-overlay prop in Canvas and WebGL.
  ```
- **Cost:** S/M; target <0.03ms CPU / <0.02ms GPU per frame; shared 1Hz string changes, <8KB state; procedural timer, no asset generation.
- **Risk:** Missing turn start means no clock, not zero seconds. Long work is not failed work. Never time a turn from global eventBus receipt. At 100 agents only selected plus a few largest-age marks; no blinking countdown. Optional ladder may remove ornament but not the selected elapsed fact.
- **Wow 1–5 / Informative 1–5:** Wow **3** — time becomes a visible material at the work site. Informative **5** — immediately answers whether the selected worker has just begun or has been there for minutes, without inventing completion estimates.

### P3 — The Mine assay ledger

- **Pitch:** Make the Mine distinguish money being spent now from a large lifetime token pile.
- **What the operator sees:** The Mine's existing ore activity gains a small assay rack: a solid coin stamp for provider-reported cost and a hollow stamp for an estimate, with a selected project's `~$0.42 / last min` chip. A big cache-read burst no longer necessarily looks like an expensive output burst. The rack stays physically small; it does not turn the building into a financial graph.
- **Real data it renders:** Deltas of `cost.usd` over fresh observations, `cost.source/availability/rateMatch/rateRevision/unknownModel`, and stable session/project IDs. Optional exact output/cache counts explain the spend, not replace it. No billing inference for Rk unavailable usage.
- **Files touched:** `sessionPresentation.js:230–250` current provenance producer; `Agent.js:116–118` storage; `LandmarkActivity.js:56–71,405–409` Mine reducer seam; `BuildingSprite.js:310–317` building data seam. Small bounded cost-window reducer next to LandmarkActivity if needed.
- **Sketch:**
  ```text
  Collect two or more fresh cost observations per stable session.
  Treat initial cumulative value as baseline, never a new spend event.
  Retain a bounded 60-second sample window, measured on observations.
  Reset the interval on provider/estimate or pricing-revision changes.
  Reject negative deltas and discontinuities; show insufficient coverage.
  Aggregate only covered intervals, disclose missing-session count.
  Reuse Mine activity: no second medium pulse on the same entity.
  Coin stamp shape encodes provenance; exact recent amount is on selection.
  Reduced motion and Canvas show static assay rack and observed counts.
  ```
- **Cost:** M; target <0.04ms CPU / <0.03ms GPU/frame; <=3,100 small samples at 2s cadence for 100 agents, aim <150KB; procedural stamps, no generation.
- **Risk:** Subscription/API estimate is not an invoice. Cost snapshots may arrive in bursts, so label a measured window rather than `$ per second` precision. Source changes can create false spikes unless segmented. Coverage at 100 agents must be partial-aware, not silently totalled. No new shader or quality-ladder dependence.
- **Wow 1–5 / Informative 1–5:** Wow **4** — the Mine finally visibly assays what is being consumed rather than just glittering harder. Informative **5** — offers actionable current spend while making estimation and missing data explicit.

### P4 — The shared-file knot

- **Pitch:** Show a potentially incompatible pair of successful workers as a single grounded overlap knot, not as two unrelated healthy bodies.
- **What the operator sees:** Selecting a writer reveals a short angular thread to one other writer and a small double-pencil knot labelled `2 writers · router.js`. Read/write overlap is a quiet single-pencil mark; read/read stays silent. A dense project's Forge can show `3 shared files` instead of a web of lines.
- **Real data it renders:** Existing envelope `collisions[{path,project,agents,kind}]`, per-agent `workingSet[{path,op,at,source}]`, observation freshness. This is overlap evidence, not proof of a conflict or simultaneous edits.
- **Files touched:** `services/workingSet.js:59–96` already produces it; `AgentManager.js:674–685` already distributes it; `RelationshipState.js:131–165` add separately named overlap relationship snapshot; `VillageDirector.js:852–870` selected scene seam; existing ground-cue path described in character-mode/README.md:66.
- **Sketch:**
  ```text
  Reuse collision IDs derived from project plus canonical path.
  Do not reconstruct paths from shortened tool summaries or basenames.
  Attach per-agent observation times to display eligibility and copy.
  Preserve distinction between recent write/write and read/write advisory.
  Selected writer gets at most one peer edge; cycle by explicit selection.
  Aggregate remaining affected files as exact bounded counts.
  Label stale evidence as recent overlap, never currently editing together.
  Static band, no tension vibration; reduced motion identical.
  Ground line shares retained Canvas/GPU cue plane; knot above occluders.
  ```
- **Cost:** M; target <0.05ms CPU / <0.03ms GPU/frame; bounded existing collision arrays plus <20KB view state; no generated art.
- **Risk:** Backend collision detection does not use each item's `at` to establish simultaneity (`workingSet.js:37–47`); stale recent sets can overstate current overlap. Surface “recent shared file” unless explicit time overlap is established. OMP is heavily present live but lacks this producer: coverage expansion is a prerequisite to making this the headline frontier on this machine. At 100 agents never draw all pairwise lines.
- **Wow 1–5 / Informative 1–5:** Wow **5** — the map reveals an invisible coupling between distant workers. Informative **5** — catches a high-cost operator blind spot, but only on the currently observed working-set slice.

### P5 — Forge result shelf

- **Pitch:** Separate “a command was invoked” from “the command actually finished successfully.”
- **What the operator sees:** A command's existing Forge ritual ends by placing a small stamped tile on a result shelf: intact stamp `exit 0`, cracked stamp `exit 1`, blank while outcome is unavailable. Select the tile to inspect the existing detail record. A test command can say `Test command exited 0`; it must not claim the whole project is tested.
- **Real data it renders:** Detail `toolHistory.tool/toolExitCode/durationMs/ts/detail`, ideally a newly normalized stable command-result ID and completedAt from existing X completion parsing. K-Code/O exit data supported; C/Pm/G must remain unknown until verified producers exist. Git verified outcomes stay in their existing Harbor channel.
- **Files touched:** `codex.js:1296–1328`, `kimi.js:1189–1192`, `opencode.js:644–647`; `index.js:243–255`; `AgentEventStream.js:320–327` add distinct result family, not change invocation meaning; `VillageDirector.js:117–136` bounded result scenes; `BuildingSprite.js:310` Forge seam.
- **Sketch:**
  ```text
  Normalize a bounded last-result summary into list snapshots upstream.
  Stable provider/session/call identity deduplicates results across polls.
  Carry completedAt and exit value; unknown remains explicitly unknown.
  Do not poll details for every world agent just to create shelf tiles.
  Trigger no success stamp at invocation or disappearance of a tool.
  Distinguish process exit from assertions and whole-project validation.
  Keep selected/latest results; aggregate older exits into small counts.
  Fast one-shot settle only; static final stamp under reduced motion.
  Canvas and GPU share existing overlay draw, without bloom dependency.
  ```
- **Cost:** M/L because list-result normalization is required; target <0.05ms CPU / <0.03ms GPU/frame, <50KB bounded recent results; procedural stamped tiles, no generation.
- **Risk:** Result IDs and command classification are load-bearing. Never regex assistant prose into a pass/fail. At 100 agents coalesce completed commands by building, not a rain of hundreds of stamps. Missing records must not produce false successes. Success effects compete with existing verified git rewards; use the same scene cap.
- **Wow 1–5 / Informative 1–5:** Wow **4** — a satisfying visible artifact emerges from real completed work. Informative **5** — restores the essential distinction between activity and outcome.

### P6 — Three things a waiting hand can hold

- **Pitch:** Replace one generic needs-you mark with a truthful prop for question, approval, or plan review.
- **What the operator sees:** The waiting worker holds an open letter for a question, a closed command slip awaiting a seal for approval, or an unrolled plan for review. Its silhouette stays calm and upright; there is no invented pleading expression. Shot 02's approval would be understandable before the operator reads the side panel.
- **Real data it renders:** `waitReason`, `pendingTool`, `signalCertainty`, `signalSource`, `signalStale`, `awaitingSince`; existing sanitized `promptDetail` remains inspectable detail.
- **Files touched:** `Agent.js:141–154`; `AgentSprite.js:6356–6373` existing hand-prop geometry; `VillageDirector.js:502–517` incident typing; preserve primary mark admission in renderer.
- **Sketch:**
  ```text
  Resolve prop only from explicit waitReason, never elapsed tool duration.
  Unknown reason retains current generic mark.
  Approval slip is sealed only after observed resolving lifecycle event.
  Do not invent an approve button or imply world interaction grants rights.
  Keep generic primary attention mark; prop supplies subtype at close view.
  Selected stale approval also retains last-observed seal from P1.
  Static band with no extra pleading/bobbing loop.
  Reduced motion and Canvas use exactly the static hand-prop image.
  ```
- **Cost:** S/M; target <0.03ms CPU / <0.02ms GPU/frame; <8KB resolved prop state; no generation if procedural, otherwise three tiny manifest-backed props only.
- **Risk:** Exact hook approval coverage is opt-in, not seven-provider guaranteed. Plan permission mode does not prove plan-review wait. At 100 agents props are detail-scale only; attention count and selected body retain priority. All meaning must survive minimal graphics mode.
- **Wow 1–5 / Informative 1–5:** Wow **3** — human-readable silhouette rather than another badge. Informative **5** — tells the operator what kind of intervention is needed, with no fabricated emotion.

### P7 — Foldable lineage pennants

- **Pitch:** Make multi-level delegation visible without adding a permanent spaghetti graph.
- **What the operator sees:** Selecting a grandchild lifts a stepped three-piece pennant: root, parent, this worker. Only that ancestry path appears on the ground; unselected descendants collapse into `6 children` at their known parent's existing relationship ring. Missing ancestors leave a broken notch rather than an invented root.
- **Real data it renders:** `parentSessionId`, `agentType`, existing world ID membership; optional `workflowId/workflowName` for C labels. Depth is computed from actual edges, not role labels or directory proximity.
- **Files touched:** `RelationshipState.js:131–165` existing graph; `AgentEventStream.js:267–314` existing lifecycle events; `VillageDirector.js:875–902` clusters and :905–910 handoff seam; `AgentSprite.js` existing name-tag attachment.
- **Sketch:**
  ```text
  Resolve depth and ancestor chain on membership changes only.
  Detect cycles and absent ancestors; mark incomplete lineage explicitly.
  Never promote removal-derived subagent:completed to success.
  Selection reveals only this ancestor chain, capped at readable depth.
  Group siblings as a count, retaining all IDs for existing selection.
  Parent's existing ring is reused, not layered with another ring.
  Static band; no marching lineage particles.
  Reduced motion identical; shared ground plane provides Canvas/GPU parity.
  ```
- **Cost:** M; O(nodes+edges) membership reduction, target <0.03ms CPU / <0.03ms GPU/frame; <20KB for 100 nodes; procedural pennant, no generation.
- **Risk:** Six adapters can expose parentage but actual nested-session frequency is workload-dependent. Not all parents remain in live roster; missing must be visible. At 100 agents selection-only ancestry is essential. No camera takeover; this is an information layer, not a new social story.
- **Wow 1–5 / Informative 1–5:** Wow **4** — the apparent crowd suddenly reveals a readable structure of delegation. Informative **4** — answers whose work this is and where to inspect upstream, while building on shipped relationships rather than replacing them.

### P8 — The changed-engine stitch

- **Pitch:** Give a model switch a small truthful transition mark so one body changing identity does not look like one agent being replaced by another.
- **What the operator sees:** When a known agent changes model, its existing silhouette updates and a tiny two-tone stitch remains on its selected name pennant: `Sonnet → Fable`, timestamp available on inspection. The world makes the continuity of the worker clear rather than staging a new arrival.
- **Real data it renders:** C's already parsed `modelHistory[{model,effort,at}]`, current model/effort, stable session ID. For other providers use only two genuinely observed consecutive model values, clearly tagged as observer-detected rather than complete provider history.
- **Files touched:** `claude.js:429–445`; `AgentManager.js:582–671` currently drops history; `Agent.js:111–112,179` identity refresh; `AgentSprite.js` selected tag; existing biography arrival logic must remain untouched.
- **Sketch:**
  ```text
  Carry bounded modelHistory through Agent without persisting prompts.
  Diff stable session identity's previous and next known model values.
  Ignore initial baseline and missing-to-known transitions as switches.
  Timestamp from provider record when supplied; otherwise observation time.
  Reuse identity refresh, do not remove and re-add the worker.
  Show only latest transition on selected body and expire visual stitching.
  Fast one-shot reveal optional; reduced motion static final stitch.
  Existing Canvas/GPU annotation path carries the same text and swatches.
  ```
- **Cost:** S/M; event-time comparison, target <0.01ms CPU / <0.02ms GPU/frame; <50KB capped histories; no asset generation.
- **Risk:** Model string aliases can manufacture switches; canonicalize identities before comparison and separately retain effort change. Full history currently has one-provider coverage. At 100 agents show only selected transition, no simultaneous transformation bursts. Optional reveal can shed at reduced quality; identity continuity cannot.
- **Wow 1–5 / Informative 1–5:** Wow **3** — a subtle in-world record of changing capability. Informative **3** — useful for interpreting changes in cost and behavior, but less frequent and less broadly recorded than clocks or freshness.

### Signal-value × availability ranking

This is an explicit prioritization model, not a claimed statistical provider survey. `Value` is operator value 1–5. `Reach` is the number of the seven providers whose current code can supply the essential signal, with conditional coverage disclosed. A supported field is not necessarily populated in a particular session; multiplying by provider count is only a ceiling on real usefulness. The live sample is biased to this research session (14 Pm / 2 X), so do not extrapolate its workload mix to all users.

| Rank | Proposal | Value × reach ceiling | Real presence qualification |
|---|---|---:|---|
| 1 | P1 last-observed seal | 5 × 7 = 35 | Registry always adds observation metadata; stale state is exceptional but reliable when present. |
| 2 | P3 Mine assay ledger | 5 × 6 = 30 | Six potentially billable providers; requires consecutive fresh, same-provenance observations; Rk excluded. Live X/Pm supplied costs, but no rate was measured here. |
| 3 | P2 Turn sand | 5 × 5 = 25 | Explicit start coverage C/X/K-Code/O/Pm; completed duration narrower. Live X start was populated. |
| 4 | P7 lineage pennants | 4 × 6 = 24 | All except G have parent producers; only subagent workloads populate them, legacy K narrower. |
| 5 | P5 Forge result shelf | 5 × 3 = 15 | X/K-Code/O verified exit producers; live X confirms. Stable compact result normalization still needed. |
| 6 | P4 shared-file knot | 5 × 2 = 10 | C and X transcript working sets; hooks can widen only when configured. Live X sample had empty set; Pm currently lacks producer. High wow, low default availability today. |
| 7 | P6 waiting-hand props | 5 × conditional | Seven contracts accept waitReason, but no honest non-null cross-provider frequency available. Exact approval hooks and recognized question/review tools, not all pending tools. Keep ahead of P4 only if operator wait telemetry is routinely present. |
| 8 | P8 changed-engine stitch | 3 × 1 = 3 for recorded history | C complete bounded history producer; seven-provider observer-detected transitions would be a weaker, new derived signal. |

## Top three

1. **The last-observed seal.** The strongest frontier is epistemic rather than ornamental: make observation confidence physically legible. The registry already does the hard work of preserving stale evidence without claiming it is current; the world should stop presenting that preserved evidence with fresh-worker certainty. It has seven-provider reach, almost no animation expense, and improves the truthfulness of every subsequent metaphor.

2. **The Mine assay ledger.** The Mine is already an expressive resource landmark, but money velocity and cumulative token activity answer different questions. A tiny provenance-aware assay rack makes this existing place more meaningful rather than creating scenery. The hard requirement is honest interval coverage and source discontinuity handling; with those, it tells the operator something no extra spark or generic quota cloud can.

3. **Turn sand, not a progress bar.** Time-in-state is one of the most useful fields already in the Agent and most absent from the world body. A quiet clock gives the operator scale without claiming completion, failure, or emotional exhaustion. It reaches the five rich-lifecycle providers, including the live X/Pm population, and shares the motion/occlusion budget much more gracefully than another progress ring.

The **shared-file knot** is the highest-wow concept and the strongest follow-on once Pm working-set coverage is real. Its low default population on this machine is why it is not dishonestly ranked first.

## Rejected

- Context-window backpack / new fill ring: pressure already has a foot gauge (`S:3409–3470`); a second pressure encoding competes rather than adds information. Existing selected percentage chip is also a guardrail tension, not permission to introduce more percentages.
- Token throughput sets walking speed: cumulative snapshot deltas include cache reads, polling bursts, and observer timing (`S:6280–6286`); speed would look like measured model performance when it is not.
- Idle-since creates personal dusk: file inactivity, completed turn, and failed observation are different facts (`A:158–169`; N:381–383). Darkening characters would obscure action-needed state and confuse global time-of-day language.
- Provider outage creates local rain: registry read failure is not API outage, and providers do not own stable exclusive houses. Existing quota/distress scenes already use Mine/watchtower (`D:159–172,525–547`). Use observation-loss seals instead of mislabelled weather.
- Giant red tension beam for every overlapping file: collision is recent path overlap, not a proven merge conflict; unbounded graph visuals are unreadable. Keep P4 selected and explicit.
- Forge cheers whenever a tool disappears: `subagent:completed` is removal-derived (`AgentEventStream.js:304–314`), not success, and invocation rituals lack generic result data. Only explicit result records earn P5 stamps.
- LOC piles as “productivity”: parsed `linesAdded/Removed` are code churn, not quality or progress (`claude.js:463–466`), and do not reach Agent. Could be an optional inspected churn counter, not a world reward.
- Sandbox fences: policy strings are not proof of real isolation boundaries; current X normalization collapses only bypass variants (`codex.js:217–222`). A fence would be a dangerous metaphor without filesystem-boundary guarantees.
- New todo progress wall: Task Board already renders real plans and phases (`T:111–145`), visible in shot 03. Improve truthful source choice rather than duplicate it.
- Generated distant horizon, decorative courier speech, celebratory generic moods: no newly observed signal; fails the territory's reason for existing.

## Open questions for the coordinator

- The public field gate is intentionally open (`N:186,246`), while AgentManager explicitly projects fields. Should the frontier maintain a single field-consumer ledger so already parsed C line counts/model history/hook errors stop being mistaken for missing adapter work?
- The current Task Board uses `todos`, not the separate C `tasks/taskProgress` contract (`T:6–10`; M:605–614). A product decision is needed on whether an execution-task board should be a selectable source of the same slate; do not silently label inferred child progress as declared plan progress.
- The live sample and inspected capture are dominated by OMP, yet its adapter has no workingSet producer in this scan. For this maintainer, honest Pm file-path/result normalization may be more valuable than the P4 visual itself. Verify actual raw OMP fixtures before promising it.
- Current collision records lack per-edge observation timestamps and item-age admission (`workingSet.js:37–47,88–93`). Either extend that certainty contract or phrase P4 as recent overlap. “Two agents are editing this now” is not supported by the existing reducer alone.
- Exact hook installation frequency across the seven providers was not measured; do not use contract acceptance as evidence that P6 approval props will commonly appear.
- Historical raw candidates in the Fable plan (`modelUsage`, API/tool durations, workspace roots) were not re-read from provider stores; current fixtures are the prerequisite for implementing them, not the old plan's status label.
- The supplied helper's first-version diagnostics did not expose quality level or confirm time override. These are real-GPU semantic stills only, not PostFx parity, reduced-motion proof, or performance evidence. No claims about the additive GPU follow-up triggers are made.
- The requested application-layer Director path is stale. The actual Director remains a presentation owner; keep proposed signal reducers pure and do not let it parse raw provider records.
