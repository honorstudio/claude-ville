# ClaudeVille outside design and architecture review

**Date:** 2026-09-01 · **Read-only second opinion**

## Verdict

ClaudeVille's best achievement is giving parallel local agents **place, identity, and peripheral presence** without making the operator read logs. World mode is memorable enough to leave open; its work-to-landmark mapping communicates activity at a distance. V0.36 then removed inconsistent statuses and invented social/completion meaning, while v0.37 measured and fixed severe server/rendering stalls (`CHANGELOG.md:5-48`). Charm plus increasing honesty is the moat.

Its main limit is **causal operator context**. It says “five working; one needs me” much better than “what exactly is blocked, what outcome is each pursuing, which files overlap, where is the plan, and why did this turn take 90 seconds?” The normalized model is mostly identity, latest tool/message, coarse turn state, one parent id, token totals, and inferred waits (`claudeville/adapters/index.js:137-187`). Dashboard renders cards with current tool, flat history, messages, tokens, and cost (`DashboardRenderer.js:526-580`). That is no longer September-2026 observability.

I inspected requested screenshots 02/03/10/12/18/30/42. The village and selection continuity are excellent. Screens 03/18 expose poor cross-agent density; 10/12 show routine nameplate stacks; 02/42 show the panel weighting portrait/mood/bonds/journey ahead of execution evidence.

Current capability claims are limited to official docs: [Claude Code hooks](https://code.claude.com/docs/en/hooks) document permission, tool, task, session, and subagent events; [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage) documents opt-in OTel events/metrics/beta spans with correlation, durations, retries, usage/cost, permission decisions, and optional file paths; [Codex hooks](https://learn.chatgpt.com/docs/hooks) document permission/tool, compaction, prompt, session, and subagent lifecycle hooks. These should be optional sources; parsing remains the universal fallback.

## Disagreement with current direction

The council's truth diagnosis and its killed list were good, especially rejecting per-tool/camera audio and untriggered WebGPU/OffscreenCanvas (`claudeville-council-enchantment-plan.md:385-399`). Its marginal priorities were not. V0.36 spent on shadows, mist, wet materials, biography, bonds, a Chronicler errand, and audio (`CHANGELOG.md:84-101`), while pricing provenance, evidence-explaining search, and fabricated deputy behavior stayed deferred (`claudeville-council-enchantment-plan.md:401-410`). For the stated operator, “why, where, how long, what changed, what costs?” should outrank more narrative/material work.

Two-second polling is a sound backstop (`docs/design-decisions.md:51-57`), not a modern primary signal plane. Claude currently infers a wait from unanswered tool ids in a 60-line tail (`claude.js:1328-1401`). Keep it, but become **push-preferred, parse-backed**.

Static pricing is not good enough without uncertainty. Unmatched models silently use provider defaults (`sessionPresentation.js:109-126`) and become a bare number (`:262-273`). Promote the council's provenance proposal (`claudeville-council-enchantment-plan.md:408`).

Finally, canonical guidance says labels should be sparse/selected and loaded sets aggregate (`visual-experience-crafting.md:76-91,174-190`), but the renderer persists names at every LOD (`IsometricRenderer.js:4994-5010`). Screens 10/12 show the result.

Keep zero-build, vanilla modules, loopback-only, provider-read-only, English-only, desktop-only, Canvas 2D guarantee, optional WebGL2/PostFx, and the motion budget. Keep WebGPU/OffscreenCanvas behind measured triggers (`open-followups.md:73-83`).

## Highest-leverage improvements

### 1. Push-preferred observation plane — **L**

**Sees:** exact fields quietly show `HOOK · 0.4s`, `OTEL · 3s`, or `TRANSCRIPT · inferred`. **Why:** trust now depends on provenance/freshness. **Evidence:** normalized contracts have no event id, source, confidence, or per-field freshness (`adapters/index.js:137-187`); detail APIs are snapshots (`server.js:435-487`). **Work:** bounded `AgentEvent` envelope; loopback JSON/NDJSON hook ingest protected by a random boot token; per-field timestamp reconciliation; later a narrow documented Claude OTLP/HTTP-JSON subset, never gRPC; no auto-editing provider config. **Accept:** newer hook permission beats stale working; duplicates idempotent; malformed/oversized/non-loopback rejected; restart falls back; raw content never persists; integration-off matches today.

### 2. Exact transient permission inbox — **M**

**Sees:** `Claude / pharos-watch needs Bash approval · npm test · 28s`, with bounded command/path/description and exact/inferred source; no approval button. **Why:** the terminal is still required to learn why “one waiting.” **Evidence:** attention rows contain only status/agent/project (`DashboardRenderer.js:649-673`); Claude inference retains tool name, not request content (`claude.js:1373-1401`). **Work:** transient sanitized `attentionRequest` from documented hooks, falling back to current classifier. **Accept:** oldest first; secrets never reach DOM/log/storage; answered prompts disappear promptly; inference says details unavailable, never invents.

### 3. Exception-first comparison Dashboard — **M**

**Sees:** dense project rows with status, age, outcome/plan, phase/tool, blocker, files, token delta, cost provenance, child progress; one row expands. **Why:** screens 03/18 show illustrated cards defeating comparison. **Evidence:** every agent gets avatar/history/usage card (`DashboardRenderer.js:526-580`), grouped/status-sorted only (`:236-278`); sidebar already indexes tools/files (`Sidebar.js:210-252`). **Work:** compact rows, one expansion, shared search, filter chips/stable sorts, sticky headers. **Accept:** 24 agents/3 projects at 1920×1080 need at most one viewport movement; needs-you initially visible; focus/selection preserved; collapsed offscreen rows do not fetch.

### 4. Working set and collision risk — **M**

**Sees:** recent read/modified files and `OVERLAP: router.ts with Nova`. **Why:** parallel agents most dangerously succeed incompatibly. **Evidence:** detail has flat tools/messages/usage/git events, no working set (`adapters/index.js:175-187`). **Work:** normalized path/operation/timestamps/source from current tools and optional events; bounded per-project path index; write/write alarm, read/write advisory, read/read silent; no contents. **Accept:** canonical same-path writers produce one collision; traversal/symlinks cannot spoof projects; ended sessions age out; unavailable is not zero.

### 5. Execution tree and task progress — **L**

**Sees:** primary → subagents/workflows → tasks; `3/5 children done`, oldest blocked child, current objective/next step. **Why:** modern agent work is a graph. **Evidence:** model has one parent id/workflow metadata (`adapters/index.js:143-163`); parent chip only goes up or says ended (`DashboardRenderer.js:823-843`). Claude tasks are already read/served (`claude.js:2186-2210`; `server.js:424-432`) but UI does not consume them (`claudeville/CLAUDE.md:20`). **Work:** capability-aware execution/work-item projections; existing links/tasks plus hooks; bounded ended-parent retention; exact/inferred/unavailable progress. **Accept:** nested/ended/blocked fixture yields stable totals; no disappearance-as-completion; flat/tree preserves selection.

### 6. Causal waterfall — **M**

**Sees:** 20-minute turn/model/permission/tool/retry/compaction/child timeline; long gaps dominate; transcript-only evidence is point events. **Why:** flat history says what, not where time went. **Evidence:** panel reverses flat tool rows and only enriches non-zero exits (`ActivityPanel.js:1248-1301`); messages are another flat list (`:1304-1331`). **Work:** bounded span reducer using real correlation ids only; static DOM/CSS or small panel Canvas. **Accept:** 40s permission wait dominates 8s command; missing ends remain open, never guessed; late events stable; 500 events bounded; no continuous animation.

### 7. Cost provenance/freshness/burn — **S**

**Sees:** `~$4.28 · static match · rates 2026-08-20`, `$3.91 · provider event`, or unavailable; plus `+$0.42/5m`. **Why:** fallback pricing must not look authoritative. **Evidence:** silent defaults/bare number above; browser duplicates rates (`TokenUsage.js:16-73,175-211`). **Work:** structured value/currency/source/match/revision/observedAt; bounded monotonic delta ring; one pricing source. **Accept:** unknown aliases never show unbadged defaults; server/panel agree; resets cannot make negative burn; quota success age visible.

### 8. Attention-first World annotations — **S**

**Sees:** overview names only selected/actionable agents; routine agents use sprites or existing cluster standards/status pips; hover/zoom reveals detail. **Why:** World is strongest as a map. **Evidence:** guidance/source contradiction and screenshots above; v0.36 incident shapes already preserve urgency (`CHANGELOG.md:92-95`). **Work:** admission order selected → actionable → hovered/recent → cluster → routine by budget; no new effect. **Accept:** dense-24 has no routine overlap; dense-100 uses clusters; actionable/selected identity never disappears; no flicker; reduced-motion and Canvas/WebGL2 are semantically equivalent.

**Sequence:** observation/provenance → permission + compact Dashboard → working set + tree → waterfall → label subtraction. First slice: Claude/Codex hooks, permission rows, provenance, no auto-configuration; OTel later.

## Do not do

- No new landmark, weather, biome, relationship, biography, or sound system before operator context.
- No WebGPU/OffscreenCanvas/GI/framework/bundler/TypeScript/runtime dependency without a measured architectural trigger.
- Do not hand-write OTLP gRPC/protobuf, embed a generic collector, approve prompts, or auto-edit provider config.
- Do not persist prompts, permission payloads, secret-bearing commands, transcript prose, file contents, or raw tool details.
- Do not infer completion, success, cost authority, or identity from disappearance.
- Do not expand full histories in every row, use color alone, or resurrect per-tool/camera audio.

## Verified defects/inconsistencies

1. **README is seven releases and one provider behind:** v0.30.0/six providers (`README.md:3-8,21`) and no OMP (`:37-46`) versus package 0.37.0/UI v0.37 (`package.json:3`; `index.html:34`) and OMP in `claudeville/CLAUDE.md:31`.
2. **Live follow-up ledger is stale:** it says `agents/README.md` is absent (`open-followups.md:16-21`) though it exists; identifies synchronous Git calls at obsolete lines (`:25-31`) while actual calls are `adapters/index.js:210-215` and `gitEvents.js:1806-1815`; and calls itself current at v0.33.3 (`:3-5`).
3. **Policy says no CI while CI exists:** `AGENTS.md:7`/`CLAUDE.md:7` versus push/PR workflow `.github/workflows/ci.yml:1-21`. The council acknowledges but leaves it unresolved (`claudeville-council-enchantment-plan.md:350-360,396`).
4. **Label policy contradicts canonical guidance:** sparse/aggregate guidance versus all-names source, visibly defective in dense screenshots.

## Bottom line

Do not redesign ClaudeVille; **rebalance it**. Keep World as the compelling peripheral surface, but make its data plane and Dashboard earn “observability”: direct lifecycle events where documented, provenance where inferred, exact transient approvals, work/plan/subagent structure, collision awareness, causal timing, and honest cost. That would turn a beautiful visualization of activity into a genuine commander's map.
