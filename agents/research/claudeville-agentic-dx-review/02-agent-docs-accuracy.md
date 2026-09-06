# Agent docs accuracy

**Status:** `ready` · read-only review · Codex `sol medium` · session `01a062b9-1070-7393-8f07-8c6477792367` · 312s · 2026-09-02

Slice 2 of the six-part agentic-DX review. Consolidated into `agents/plans/claudeville-agentic-dx-plan.md`.

## Findings

1. **The required working directory is wrong, but nothing operational depends on it.** Both root context files require `/home/ahirice/Documents/git/claude-ville` (`AGENTS.md:3`, `CLAUDE.md:3`), as does the nested guide (`claudeville/CLAUDE.md:5`); the actual checkout is `/Users/ahirice/Documents/git/claude-ville`. Repository-wide search found the old literal only in those three docs. Other `/Users/...` occurrences are test fixtures/examples (`scripts/tests/formatters.test.mjs:7,44`), not configuration. This can make an agent’s first command fail, but changing it to another absolute path would remain machine-specific.

2. **Root parity currently holds, though its prescribed check is sandbox-fragile.** Comparing both files after line 2 with Node returned `PARITY_OK`. The documented command (`AGENTS.md:70`, `CLAUDE.md:70`) failed here with `/dev/fd/... Operation not permitted` because zsh process substitution needs accessible file descriptors. Agents in restricted shells cannot verify the contract using the canonical instruction.

3. **The validation contract substantially understates the test suite.** Root guidance describes `test:unit` as status/residency/chronicle/spend tests (`AGENTS.md:7,63`); the nested guide repeats that scope (`claudeville/CLAUDE.md:12,78`), and `README.md:75` does too. In reality, `test:unit` runs every `scripts/tests/*.test.mjs` (`package.json:42`): 103 files covering renderer policy, pricing, hooks, integrations, UI logic, GPU resources, routing, audio, and more. Even `scripts/tests/README.md:13-25` lists only eleven files and is far behind the directory. Agents cannot select the right regression tests or estimate validation cost.

4. **Two root validation commands are malformed, and one cross-reference is stale.** `AGENTS.md:68` says `sprites:capture-fresh` and `sprites:visual-diff`, but only npm scripts with those names exist (`package.json:56-58`); direct execution will produce “command not found.” `claudeville/CLAUDE.md:86` links to `AGENTS.md § Validation Checklist`, but the actual heading is `## Validation` (`AGENTS.md:55`).

5. **Server/API documentation is internally incomplete.** The authoritative route map includes eight GET routes and two POST routes (`claudeville/server.js:2687-2701`). The nested API inventory omits `GET /api/changelog` (`claudeville/CLAUDE.md:18` versus `claudeville/server.js:2696`), while the root README lists changelog but omits `POST /api/ingest/hook` (`README.md:178-189`). Also, `/api/providers` is characterized as diagnostic/external in `claudeville/CLAUDE.md:20`, yet application boot actively fetches it (`claudeville/src/presentation/App.js:633-646`; `claudeville/src/infrastructure/ClaudeDataSource.js:89-90`).

6. **Provider and event contracts have drifted.** The nested Kimi entry mentions only `~/.kimi/` (`claudeville/CLAUDE.md:38`), while the adapter supports both legacy `.kimi` and current `.kimi-code` stores (`claudeville/adapters/kimi.js:32-44`). The registered adapter list itself is otherwise accurate (`claudeville/adapters/index.js:28-36`). The event section presents “Events” as a catalog (`claudeville/CLAUDE.md:88-90`) but omits active contracts including `watcher:state` (`claudeville/src/application/SessionWatcher.js:58-69`), `ws:state` (`claudeville/src/infrastructure/WebSocketClient.js:427`), `chronicle:recorded` (`claudeville/src/application/ChronicleLog.js:385`), `affinity:changed` (`claudeville/src/application/RelationshipAffinityService.js:518`), and `village:scene` (`claudeville/src/presentation/character-mode/VillageDirector.js:736`). The source event header is also incomplete (`claudeville/src/domain/events/DomainEvent.js:3-13`), so agents have no authoritative catalog.

7. **Model-addition Track B misses real touch points and executable validation.** It points mainly to `ModelVisualIdentity.js` and vaguely to “server session presentation” (`docs/agent-provider-addition.md:37-43`). A model can also require:

   - pricing in `claudeville/src/config/model-pricing.json` (`model-pricing.json:1-16`);
   - browser/server pricing parity, explicitly asserted in `scripts/tests/r2-02.pricing.test.mjs:42-80`;
   - context-window mapping in `ModelVisualIdentity.js` (`claudeville/src/presentation/shared/ModelVisualIdentity.js:153-180`);
   - movement temperament in `AgentMood.js` (`claudeville/src/domain/value-objects/AgentMood.js:70-103`);
   - corresponding pricing and behavior tests (`scripts/tests/r2-02.pricing.test.mjs:25-49`; `scripts/tests/r2-06.model-behaviour.test.mjs:13-29`).

   Track B provides only manual UI smoke, not targeted tests (`docs/agent-provider-addition.md:39-43`).

8. **The “first five minutes” path omits important agent workflows.**

   - No documentation shows how to run one test or use `--test-name-pattern`; only the all-tests npm command is given (`scripts/tests/README.md:3-5`).
   - Fixtures under `scripts/adapters/fixtures/` have no README. Their consumers are discoverable only in code, e.g. Claude projection (`scripts/tests/claude-projection.test.mjs:9,35-36`) and Codex turn-state tests (`scripts/tests/turn-state.test.mjs:30,50-51`).
   - Hook ingestion is well documented, but buried under “Permission prompts are inferred or arrive late” (`docs/troubleshooting.md:37-41`) rather than indexed as an integration/runbook. The main README does not expose the route.
   - Root browser verification says only to open the site manually (`AGENTS.md:47-49,65-66`). A deterministic capture command exists (`package.json:61`) and a detailed renderer workflow exists (`docs/rendering-baselines.md:25-51`), but agents are not told which screenshot workflow to use for ordinary UI review.
   - The Project Map omits agent tooling and validation surfaces: `.claude/skills/`, `.codex/config.toml`, `scripts/tests/`, `scripts/smoke/`, and `.github/workflows/ci.yml`. This is especially harmful because a bundled skill is stale: it expects permissive CORS (`.claude/skills/verify-server/SKILL.md:74-81`), while the product explicitly has no CORS (`README.md:191`) and validates same-origin requests (`claudeville/server.js:108-123`).

9. **The smoke documentation is obsolete.** It says the project “has no test runner” (`scripts/smoke/README.md:3-7`), contradicting the Node test script (`package.json:42`). It documents six smoke programs (`scripts/smoke/README.md:9-45`), while the directory contains many additional checks and several are release-gate requirements (`package.json:43-45`). Agents lack a change-to-smoke mapping.

10. **The root remote contract is false in this checkout.** `AGENTS.md:79-80` claims both `origin` and fetch-only `upstream`; `git remote -v` reports only `origin`. An agent following the documented fork workflow will fail at the first upstream operation.

11. **`docs/README.md` is almost complete but not a true status index.** `docs/building-style-contract.md` is orphaned: it appears in the directory but not the task map (`docs/README.md:14-26`) or related-doc table (`docs/README.md:36-51`). No per-document status is recorded; the introduction merely labels the entire directory “current” (`docs/README.md:3`). Thus agents cannot distinguish load-bearing contracts from reference material. Retained artifacts handle this better with explicit status and purpose columns (`agents/README.md:11-25`).

12. **The root context is moderate in size but poorly allocated.** `AGENTS.md` is 991 words/115 lines. High-frequency constraints and routing are useful, but 27 lines cover release mechanics (`AGENTS.md:89-115`) while agent tooling and focused-test discovery are absent. The nested guide similarly duplicates adapter, sprite, and validation details already owned by nearer READMEs (`claudeville/CLAUDE.md:30-46,62-86`).

## Proposals

1. **Repair factual contract breaks — S / highest impact.** Edit `AGENTS.md` and mirrored `CLAUDE.md`: use “repo root containing this file,” fix both sprite commands to `npm run ...`, rename the parity reference, and remove or conditionalize `upstream`. Edit `claudeville/CLAUDE.md`: add changelog, correct Kimi paths, describe `/api/providers` as UI-consumed, and link rather than claim an exhaustive event list. Acceptance: Node parity check passes; every documented npm command exists; API table matches `API_ROUTES`; no obsolete absolute path remains. Risk: remote policy may intentionally describe maintainer setup.

2. **Make validation discoverable by change type — S.** Update `scripts/tests/README.md` with suite categories, one-file and `--test-name-pattern` examples; update `scripts/smoke/README.md` with all maintained scripts and a change-to-check matrix. Add `scripts/adapters/fixtures/README.md` documenting redaction, consumers, and how `npm run check:adapter-fixtures` differs from unit fixtures. Acceptance: an executor can run one file, one named test, and choose a smoke check without reading implementation code. Risk: inventories drift; generate/check lists from filenames where practical.

3. **Complete the model runbook — S.** Expand Track B in `docs/agent-provider-addition.md` with exact symbols/files: `getModelVisualIdentity`, `contextWindowLimitForModel`, `model-pricing.json`, `modelBehaviorProfile`, `r2-02.pricing.test.mjs`, and `r2-06.model-behaviour.test.mjs`. Acceptance: adding a fixture model produces non-default pricing, expected identity/context/behavior, and both targeted tests pass. Risk: not every model needs every touch point; label steps conditional.

4. **Fix agent tooling itself — S.** Update `.claude/skills/verify-server/SKILL.md` to assert absence of wildcard CORS and same-origin rejection; update `verify-architecture/SKILL.md:48-50` to cover all seven registered adapters. Add both skills and `.codex/config.toml` to the root Project Map. Acceptance: skill expectations agree with `server-security.mjs` and `adapters/index.js`. Risk: skills may be user-machine-specific; keep project-local claims only.

5. **Turn `docs/README.md` into an explicit contract index — S.** Add `Status` and `Purpose` columns for every `docs/*.md`; add `building-style-contract.md`; classify each as contract, runbook, checklist, or reference. Add direct rows for hook ingestion and screenshot capture. Acceptance: a script or manual comparison finds every Markdown file exactly once in the index. Risk: status metadata needs upkeep.

6. **Restructure root context for progressive disclosure — M.** Target roughly 500–650 words:

   - **Keep:** scope/desktop/no-build constraints, shared-checkout safety, start command, compact Project Map, high-level validation routing, English policy.
   - **Trim:** Agent Artifacts to one rule plus `agents/README.md`; Browser Verification to one sentence; consolidate Workflow and Git Hygiene.
   - **Move to `CONTRIBUTING.md`:** GitHub/remotes, changelog/versioning, tag/release flow (`AGENTS.md:77-115`).
   - **Move to `scripts/tests/README.md` and `scripts/smoke/README.md`:** detailed validation commands; retain only a change-category routing table in root.
   - **Move from `claudeville/CLAUDE.md` to nearest owners:** adapter detail → `claudeville/adapters/README.md`; sprite procedure → `scripts/sprites/generate.md`; UI-specific behavior → the three presentation READMEs. Keep server invariants, layer boundaries, and event-ownership guidance.

   Acceptance: parity remains exact; every moved section has a working link; no factual contract is duplicated in more than one authoritative location. Risk: excessive trimming can hide safety rules, so destructive/shared-checkout constraints must remain inline.

## Open questions

- Is `upstream` intentionally required only in the maintainer’s normal checkout, or should documentation describe it as optional setup?
- Are the Claude/Codex/Gemini hook payload examples in `docs/troubleshooting.md:39-192` periodically revalidated against current CLI releases? The repository records no verification date or automated external-contract check.
