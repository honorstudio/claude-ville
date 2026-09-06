# ClaudeVille agentic development experience plan — *The Scriptorium*

> **For agentic workers:** implement this plan item by item. Each item is one reviewable unit with owned paths, an explicit change, and observable acceptance. Re-check every `file:line` anchor before editing; line numbers move. Items inside a wave are disjoint by path and may run in parallel; waves are ordered because later waves consume contracts produced earlier. Subagents edit only; the coordinator runs gates once per wave.

**Status:** `implemented as v0.40.0` — all 23 items executed 2026-09-02 across three commits (`86fdc4c` waves 0/1.1/2.1/3.x, `256c6a6` 1.2–1.5/2.2–2.3/2.5/3.6, `15d10bc` 2.4/2.6/3.5) by ten parallel Codex agents per batch (Sol low/medium for design-bearing items, Luna max for mechanical sweeps) with the coordinator applying `package.json`, root-doc, and cross-item follow-ups. Verification: `npm run validate:full` green (737 unit + 2 integration tests, server smokes, world and sprite validators), `npm run verify:render` produces the three captures in ~3.5 s, `npm run models:resolve` for Mythos resolves to the Fable row on both sides, root parity and `check:artifacts` green. Deviations from the text: the render smoke selects in Dashboard and asserts the panel after returning to World (the product contract — `ActivityPanel` defers while `_viewMode === 'dashboard'`); `POLICY_SPRITE_IDS` is exported so the reverse manifest check accepts rendering-policy sprites (`agent.<provider>.base`, GPT-5.5 effort variants); `release:verify` (argument-less) joined `gate:release` instead of `release:check`. The Node 18 CI job has not yet been observed on a push (open decision 2 stands).

**Baseline:** `main` at `7c94666` (`v0.39.1` *Titan Tides*), clean tree, 2026-09-02. Node v24 locally; `package.json` promises `>=18`. Checkout at `/Users/ahirice/Documents/git/claude-ville`.

**Goal:** make ClaudeVille a repository where a fresh Claude Code or Codex agent can (1) add a model in one sitting from one source of truth, (2) verify a UI or server change without asking a human, (3) trust that the docs, skills, and CI describe the code that exists, and (4) ship a release without hand-editing version strings.

**Architecture:** no new subsystems and no runtime dependencies. New surfaces are a canonical model registry with a generated browser module, a handful of dependency-free scripts under `scripts/{models,release,agents,smoke/support,agent-hooks}/`, a `.claude/settings.json` hooks file, and a small skill portfolio that routes to those scripts instead of restating them.

**Tech stack:** unchanged. Zero build, vanilla ES modules, Node built-ins only at runtime, `node:test` for pure logic, Playwright (existing dev dependency) only for capture and smoke scripts.

**Spec / evidence:** this document plus the retained research under [`agents/research/claudeville-agentic-dx-review/`](../research/claudeville-agentic-dx-review/): six independent read-only reviews by Codex Sol agents (`sol medium` ×4, `sol low` ×2), each over a disjoint territory. Every claim in *The organizing finding* was re-verified by the coordinator in this checkout or against the live GitHub Actions history; item-level anchors cite the review that found them.

---

## Method

Six Sol explorers, read-only sandbox, all against `7c94666`:

| Explorer | Territory | Artifact |
| --- | --- | --- |
| Sol medium | the "add a model" workflow: every file/symbol touched, duplication, registry design, skill design | [`01-model-addition-surface.md`](../research/claudeville-agentic-dx-review/01-model-addition-surface.md) |
| Sol medium | agent-facing docs: every factual claim in `AGENTS.md`, `claudeville/CLAUDE.md`, READMEs vs the code | [`02-agent-docs-accuracy.md`](../research/claudeville-agentic-dx-review/02-agent-docs-accuracy.md) |
| Sol medium | skills, hooks, slash commands, Codex config, CI: what exists, what is stale, skill portfolio | [`03-skills-hooks-commands.md`](../research/claudeville-agentic-dx-review/03-skills-hooks-commands.md) |
| Sol medium | verification loops: every entry point, what is unverifiable, what to add | [`04-verification-tooling.md`](../research/claudeville-agentic-dx-review/04-verification-tooling.md) |
| Sol low | release procedure, changelog grammar, retained-artifact hygiene, git-hygiene deny list | [`05-release-and-artifacts.md`](../research/claudeville-agentic-dx-review/05-release-and-artifacts.md) |
| Sol low | sprite / PixelLab workflow: the tacit steps, docs overlap, consistency gaps | [`06-sprite-pixellab-workflow.md`](../research/claudeville-agentic-dx-review/06-sprite-pixellab-workflow.md) |

Coordinator cross-checks that matter: `gh run list --limit 40` (CI history), `git remote -v`, `git show --stat cf7ea89 8cc5a59 8d9757e` (model-addition touch surface), `rg mythos claudeville/src/presentation/shared/ModelVisualIdentity.js` (no match), `rg 'Access-Control-Allow-Origin' claudeville/server.js` (no match), existence of `Minimap.js` and `widget/` (both gone), `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` (parity holds today).

---

## The organizing finding

> **The agent tooling describes a repository that no longer exists, and the one automated gate that would have said so has been red on every push since 2026-08-25.**

Four verified facts:

1. **CI is red and nobody is told.** `.github/workflows/ci.yml` runs `npm run validate:quick` with no `npm ci`; the last step, `sprites:audit-ids`, imports `js-yaml` from `scripts/sprites/manifest-utils.mjs:4`, which is a dev dependency. Every one of the last 30 pushes to `main` (all releases from `v0.34.0` through `v0.39.1`) ended in `ERR_MODULE_NOT_FOUND: js-yaml`. The only green runs are Dependabot branches that install first. `AGENTS.md:7` says "CI runs `npm run validate:quick` on pushes"; it does, and it fails.
2. **Adding a model is a twelve-file scavenger hunt through two duplicated tables, and the runbook lies about it.** Pricing lives in `claudeville/src/config/model-pricing.json` *and* six hand-mirrored tables in `claudeville/src/domain/value-objects/TokenUsage.js:16-85`. Identity lives in `claudeville/adapters/sessionPresentation.js:176-248` (server) *and* `claudeville/src/presentation/shared/ModelVisualIdentity.js:183-487` (browser); the browser never reads the server's `spriteId`/`displayModel`/`modelColor` (`AgentManager.js:515-552` maps raw `model`), so the server table can drift silently. Context windows are computed in `adapters/claude.js:100-105,382-390` (1M for Fable/Opus) and again in `ModelVisualIdentity.js:153-180` (200k fallback for the same models). Tier lists live in `AgentMood.js:56-75`. Today `mythos-5-1` has a price row and no identity row, so a Mythos session renders as Sonnet. `docs/agent-provider-addition.md` Track B says server presentation is optional, requires minimap verification four times (`Minimap.js` was deleted in `d0b9879c`), and the pricing revision string `2026-09-01` is hard-coded in four places in `TopBar.js:792,854-856,905` beside `TokenUsage.rateRevision`.
3. **Both skills assert things the server does not do, and there are no hooks.** `verify-server` requires `Access-Control-Allow-Origin: *` (`SKILL.md:74-81`); `server.js` has no such header and rejects cross-origin by design (`server.js:99-123`). It also instructs agents to start `npm run dev` on port 4000, which `AGENTS.md:47-49` says the operator already owns. `verify-architecture` lists three adapters (`SKILL.md:44-54`) against seven in `adapters/index.js:28-36`, uses `grep -rn` against the repo's `rg` rule, and fails every `position: fixed` outside modals although first-run and spend overlays use it intentionally. `.claude/settings.json`, `.claude/commands/`, `.claude/agents/` do not exist. `AGENTS.md:3` names `/home/ahirice/...` (checkout is `/Users/ahirice/...`), `AGENTS.md:79-80` documents an `upstream` remote that `git remote -v` does not have, `AGENTS.md:68` writes two npm scripts without `npm run`, and `claudeville/CLAUDE.md:86` links to a heading that does not exist.
4. **The verification surface is large and hidden.** `scripts/tests/` holds 103 `node:test` files; `AGENTS.md:7,63` and `claudeville/CLAUDE.md:12,78` describe `test:unit` as "status derivation, session residency, chronicle, spend ledger". `scripts/smoke/` holds 24 scripts; `scripts/smoke/README.md` lists 6 and says the project has "no test runner". A Playwright UI smoke that boots `?sim=1`, switches modes, selects agents, and records page errors already exists (`scripts/smoke/ui-remediation.mjs`) but is unreachable from `package.json`, while `AGENTS.md:73` tells agents browser verification is manual. `test:unit` includes `r1-18.pipeline-replay.test.mjs`, whose success path waits ≥20 s (`r1-18.e2e-replay.mjs:22`, test asserts `floorDelayMs >= 20_000`), and `gate:release` runs the same replay a second time via `test:e2e:replay`. Tests write fixtures to `os.tmpdir()` directly; in a read-only sandbox 15 of 613 cases fail with `EPERM`, which is what a Codex explorer sees.

The consequence for agents: they cannot trust the map, they cannot see the gate, and the most repeated task (a new model) has no single source of truth, no probe, and no test that catches a half-done addition.

---

## Guardrails (binding on every item)

- **Zero build is sacred.** No bundler, transpiler, TypeScript, framework, or runtime dependency. A *generated* ES module committed to the tree with a drift check is allowed; a build step that must run before `npm run dev` is not.
- **Never touch port 4000.** Every new script starts its own server on an ephemeral port with a temporary `HOME`, as `scripts/smoke/boot-contract.mjs` already does. Skills never instruct `npm run dev`, `lsof :4000`, or `kill`.
- **Deterministic and dependency-free by default.** Anything added to `validate:quick` or CI runs from a clean checkout after `npm ci` and needs no real `~/.claude`, no network, no port 4000. Playwright scripts are opt-in (`verify:*`, `sprites:*`), never in `validate:quick`.
- **Skills route; scripts decide.** No skill contains a check that a script could run. A skill is ≤100 lines, has `name` + trigger-rich `description` frontmatter, names its authoritative docs, its mutation boundary, and the exact commands.
- **Docs say what the code does.** Every doc edit in this plan is paired with the code path that proves it. Root `AGENTS.md`/`CLAUDE.md` parity holds after every wave.
- **Desktop-only, English-only, no emoji.** Unchanged.
- **Read-only against provider files; opt-in for anything that emits data.** The dogfood hook item (3.6) is off unless an env flag is set.

---

## Cross-item contracts

Fixed here so parallel items agree.

**C1 — Model registry row** (`claudeville/src/config/models.json`, consumed by 1.1–1.5, 3.4). One canonical file; ordered array; first match wins; matching is on `normalizeModel()` output (lowercase, `[._]`→`-`) with the existing Codex dotted/dashed dual candidates preserved.

```json
{
  "revision": "2026-09-01",
  "models": [
    {
      "id": "claude.fable-5-1",
      "provider": "claude",
      "match": ["fable-5-1", "mythos-5-1"],
      "sample": "claude-fable-5-1",
      "label": "Claude Fable", "shortLabel": "Fable",
      "modelClass": "fable", "modelTier": "mythic", "mood": "flagship",
      "spriteId": "agent.claude.fable", "paletteKey": "claude",
      "color": "#ffd6f0", "trim": ["#ffd6f0", "#ffe7a8", "#c8a3ff"], "accent": ["#fff0fa", "#fff4cf", "#d8bcff"],
      "contextWindow": 1000000,
      "pricing": { "input": 10, "output": 50, "cacheRead": 0.25, "cacheCreate": 12.5 }
    }
  ],
  "defaults": { "claude": { "...": "existing per-provider default rate + identity" } }
}
```

Fields: `id` unique; `match` ordered substrings (an alias shares a row, it does not get a second identity); `sample` one raw provider string used by the completeness test; `pricing` in USD per MTok with the four existing keys; `contextWindow` in tokens or `null`; `mood` one of the existing `AgentMood` tier names; effort/equipment/insignia rules **stay in code** keyed by `modelClass` and `effortTier` (they are rendering policy, not model data).

**C2 — Generated registry modules (data + resolver, both module systems).** `scripts/models/generate.mjs` emits two files from `models.json` and one resolver template: `claudeville/src/config/models.generated.js` (ESM, for the browser and `node:test`) and `claudeville/src/config/models.generated.cjs` (CJS, for `server.js`/adapters, which must stay `require()`-only for Node 18). Both carry the header `// GENERATED FROM models.json + scripts/models/resolver.template.js — DO NOT EDIT` and export the same surface: `MODEL_REVISION`, `MODEL_REGISTRY`, `MODEL_DEFAULTS`, `normalizeModel(model)`, `pricingModelCandidates(model)`, `findModelRow(model, provider) → { row, isDefault, match }`, `contextWindowForModel(model, provider)`, `ratesForModel(model, provider)`. The resolver source lives once in `scripts/models/resolver.template.js` (plain functions, no `import`/`export`/`require`); the generator concatenates data + template + an ESM or CJS export footer. Byte-stable output (sorted keys, 4-space indent, trailing newline). `npm run models:check` regenerates to memory and fails on any diff to either file; it is part of `validate:quick`. Nothing under `claudeville/vendor/` is imported by Node tooling.

**C3 — Isolated server helper** `scripts/smoke/support/isolated-server.mjs`, factored out of `boot-contract.mjs`: `startIsolatedServer({ home, env }) → { baseUrl, port, stop() }`; temporary `HOME`, `PORT=0`-style ephemeral bind (server currently hard-codes 4000 — the helper must use the same override `boot-contract.mjs` already uses; if none exists, add `CLAUDEVILLE_PORT` honoured only when `CLAUDEVILLE_SMOKE=1`), captures stdout/stderr, kills the child tree on `stop()`. Used by 2.1, 2.2, 2.3, 2.6.

**C4 — Hook script contract** `scripts/agent-hooks/claude-hook.cjs <mode>`, reads Claude Code hook JSON on stdin, modes `session | guard | check-js | ingest`; exit `0` allow, exit `2` deny with a one-line reason on stderr; never exits non-zero for malformed input in `session`/`check-js`/`ingest` (fail open); total runtime <200 ms.

**C5 — Artifact status line.** First metadata line of every `agents/plans/*.md` and `agents/research/*/README.md` (or the single review file) is `` **Status:** `<status>` `` followed by free text. `agents/README.md` tables mirror the status verbatim; `scripts/agents/check-artifacts.mjs` enforces both directions.

**C6 — Skill conventions.** Directory `.claude/skills/<name>/SKILL.md` (+ `references/` for long checklists). Frontmatter `name`, `description` (what + when to trigger + what it never does). Body sections: *When to use*, *Inputs*, *Steps* (commands verbatim), *Verification*, *Never*. Codex parity: every skill's steps must be reachable from `AGENTS.md` links + scripts, since Codex does not load `.claude/skills`.

---

## Wave 0 — Stop the bleeding (hotfix release)

All items S. Disjoint paths; run in parallel. Ship as a hotfix (`v0.39.1.1`).

### 0.1 Make CI install dependencies and test the promised Node floor

- **Owned paths:** `.github/workflows/ci.yml`, `package.json` (`engines` only if the decision below requires it), `CHANGELOG.md`.
- **Change:** add `actions/setup-node` `cache: npm` and a `npm ci` step before `npm run validate:quick`. Matrix `node-version: ['18.x', '24.x']`. If the 18.x job fails for a reason other than a real bug (e.g. `node:sqlite` absent and no `sqlite3` CLI on the runner), raise `engines.node` to the lowest version that passes, say so in `CHANGELOG.md`, and update `AGENTS.md:67`'s Node note in 0.2.
- **Acceptance:** the workflow is green on `main` for a clean checkout; the run log shows `npm ci` and `sprites:audit-ids` completing; the matrix has no `continue-on-error`.
- **Evidence:** coordinator `gh run list`; slice 04 finding 2–3; slice 03 finding 3.

### 0.2 Repair every false statement in the root and nested agent docs

- **Owned paths:** `AGENTS.md`, `CLAUDE.md` (mirror), `claudeville/CLAUDE.md`, `docs/agent-provider-addition.md`, `claudeville/src/presentation/character-mode/README.md`, `claudeville/src/presentation/shared/README.md`, `.github/ISSUE_TEMPLATE/provider_support.yml`.
- **Change:**
  - `AGENTS.md:3` and `claudeville/CLAUDE.md:5`: replace the absolute path with "the repository root (the directory containing this file)".
  - `AGENTS.md:79-80`: describe `upstream` as optional maintainer setup, not a present remote.
  - `AGENTS.md:68`: `npm run sprites:capture-fresh` / `npm run sprites:visual-diff`.
  - `AGENTS.md:7,63` and `claudeville/CLAUDE.md:12,78`: describe `test:unit` as "every `scripts/tests/*.test.mjs` (103 files: adapters, pricing, renderer policy, DOM-stub UI, GPU resources, server replay…)"; keep the list of must-stay-green modules.
  - `claudeville/CLAUDE.md:86`: link to `AGENTS.md` `## Validation`.
  - `claudeville/CLAUDE.md:18`: add `GET /api/changelog`; `:20`: `/api/providers` is consumed by `App.js:633-646` at boot, not diagnostic-only; `:38`: Kimi reads `~/.kimi/` and `~/.kimi-code/` (`adapters/kimi.js:32-44`); `:88-90`: say the event list is partial and link the emitters.
  - `docs/agent-provider-addition.md`: remove all minimap steps; remove widget references; Track B: state that `sessionPresentation.js` **is** required today (until Wave 1 lands) and list `model-pricing.json`, `TokenUsage.js`, `AgentMood.js`, `contextWindowLimitForModel`, `r2-02.pricing.test.mjs`, `r2-06.model-behaviour.test.mjs`. (Wave 1.5 rewrites this file again; this item only removes falsehoods.)
  - Presentation READMEs: drop `Minimap.js` descriptions (`character-mode/README.md:3-11,40,60`; `shared/README.md:54-63`).
  - `provider_support.yml:10-20`: add Grok and OMP.
- **Acceptance:** `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` empty; `rg -n '/home/ahirice|upstream' AGENTS.md CLAUDE.md claudeville/CLAUDE.md` returns only the optional-remote sentence; `rg -n -i minimap docs claudeville/src/presentation/*/README.md` returns nothing; every `npm run` command in the validation tables exists in `package.json`.
- **Evidence:** slice 02 findings 1, 4, 5, 6, 10; slice 01 finding 5; slice 03 findings 7, 8.

### 0.3 Correct the two existing skills (facts only)

- **Owned paths:** `.claude/skills/verify-server/SKILL.md`, `.claude/skills/verify-architecture/SKILL.md`.
- **Change:** `verify-server`: delete the CORS check; replace "start `npm run dev`, `lsof :4000`" with "run `node scripts/smoke/boot-contract.mjs` and `node scripts/smoke/server-security.mjs` (isolated, ephemeral port); never touch 4000"; add the WebSocket check the description promises by pointing at `boot-contract.mjs`'s WS snapshot. `verify-architecture`: adapter list from `adapters/index.js` (seven), `rg` not `grep`, and an explicit allowlist for `position: fixed` (`css/character.css` first-run/grammar overlays, `css/topbar.css` spend/connection overlays, modals, toasts). Both stay prose in this wave; 2.2 turns them into script routers.
- **Acceptance:** no claim in either skill contradicts `server.js`, `adapters/index.js`, or the CSS allowlist; neither mentions port 4000 as something to start or kill.
- **Evidence:** slice 03 findings 1–2; coordinator `rg Access-Control-Allow-Origin` (no match).

### 0.4 One pricing revision constant

- **Owned paths:** `claudeville/src/presentation/shared/TopBar.js`.
- **Change:** replace the four literal `revision 2026-09-01` strings at `:792,854-856,905` with `TokenUsage.rateRevision` (already imported elsewhere in the shared layer; add the import if absent).
- **Acceptance:** `rg -n '2026-09-01' claudeville/src` returns only `TokenUsage.js`/`model-pricing.json`/`claude.js` fallback; tooltips still render the revision.
- **Evidence:** slice 01 finding 1 (pricing-only refresh column).

### 0.5 Split the fast loop from the replay

- **Owned paths:** `package.json` (`scripts` only), `scripts/tests/README.md` (one paragraph), `AGENTS.md`/`CLAUDE.md` validation row for `test:unit` (coordinate with 0.2: 0.5 owns only that one table row).
- **Change:** `test:unit` → `node --test "scripts/tests/*.test.mjs" --test-skip-pattern` is not available on 18; instead move `scripts/tests/r1-18.pipeline-replay.test.mjs` to `scripts/tests/integration/r1-18.pipeline-replay.test.mjs` and add `test:integration: node --test "scripts/tests/integration/*.test.mjs"`. `validate:quick` keeps `test:unit`. `gate:release` runs `test:integration` once and drops the separate `test:e2e:replay` invocation (keep the script for direct use).
- **Acceptance:** `time npm run test:unit` has no 20 s floor (expect <10 s on the reference machine); `npm run gate:release` executes the replay exactly once (log shows one `floorDelayMs`); the moved test still passes under `test:integration`.
- **Evidence:** slice 04 finding 1; coordinator `rg 20_000 scripts/smoke/r1-18.e2e-replay.mjs`.

**Wave 0 gate:** `npm run validate:quick` green locally, CI green on the pushed hotfix, parity diff empty.

---

## Wave 1 — One source of truth for models (the headline ask)

Produces C1/C2. 1.1 must land before 1.2–1.3 consume the registry; 1.4–1.5 can be drafted in parallel and finalised after 1.3. Ship with Wave 2 as a named release.

### 1.1 Canonical model registry + generated browser module (pricing, context window, mood)

- **Owned paths:** `claudeville/src/config/models.json` (new), `claudeville/src/config/models.generated.js` + `models.generated.cjs` (new, generated), `scripts/models/generate.mjs` (new), `scripts/models/resolver.template.js` (new), `package.json` (`models:generate`, `models:check`; add `models:check` to `validate:quick`), `claudeville/src/domain/value-objects/TokenUsage.js`, `claudeville/src/domain/value-objects/AgentMood.js`, `claudeville/adapters/sessionPresentation.js` (pricing functions only), `claudeville/adapters/claude.js` (`CLAUDE_CONTEXT_WINDOW_TABLE`, `rateRevision`), `claudeville/adapters/opencode.js` (`rateRevision` source), `claudeville/src/presentation/shared/ModelVisualIdentity.js` (`CONTEXT_WINDOW_LIMITS` + `contextWindowLimitForModel` only), `docs/design-decisions.md` (pricing paragraph).
- **Change:** migrate every row of `model-pricing.json` and every table in `TokenUsage.js:16-85` into `models.json` per C1 (aliases folded into `match`; `mythos-*` become aliases of the Fable rows per the coordinator's decision in *Open decisions*). Delete `model-pricing.json` and its three `require` sites (`claude.js:19`, `opencode.js:14`, `sessionPresentation.js:1`) in favour of `models.generated.cjs`. `TokenUsage.js` imports `MODEL_REGISTRY`/`MODEL_DEFAULTS`/`MODEL_REVISION`/`ratesForModel` from `models.generated.js` and keeps its API (`pricingForModel`, `estimateCost`, `rateRevision`) unchanged. `AgentMood.js:56-75` tier lists become a lookup of `row.mood` via `findModelRow`. `contextWindowLimitForModel` and `claude.js:100-105,382-390` call `contextWindowForModel` with the existing provider fallbacks. `sessionPresentation.js` pricing path calls `ratesForModel` from `models.generated.cjs`. Rendering-policy tables (`EFFORT_*`, `CODEX_*`) stay where they are.
- **Acceptance:** `npm run models:generate` is idempotent (second run produces no diff); `npm run models:check` fails after editing `models.json` without regenerating and passes after; `scripts/tests/r2-02.pricing.test.mjs` and `r2-06.model-behaviour.test.mjs` pass unchanged except for import paths; `rg -n 'model-pricing.json' claudeville scripts docs` returns nothing; `npm run test:unit` green.
- **Risk:** ordering-sensitive substring matching. Mitigation: 1.3's completeness test asserts every `sample` resolves to its own row, and the pricing parity test already compares server vs browser numbers.
- **Evidence:** slice 01 findings 1–2, proposal 1; `docs/design-decisions.md:77-83` for the synchronous-helper constraint the generator preserves.

### 1.2 Identity from the registry on both sides

- **Owned paths:** `claudeville/src/presentation/shared/ModelVisualIdentity.js` (`getModelVisualIdentity`, `providerBaseSpriteId`, `formatModelLabel`), `claudeville/adapters/sessionPresentation.js` (`modelIdentity`, `formatModelLabel`), `claudeville/src/config/models.json` (identity fields per C1; coordinate with 1.1 — 1.1 lands first, 1.2 appends fields), `scripts/tests/ui-data-remediation.test.mjs` (identity cases), `scripts/tests/r2-02.adapter-parity.test.mjs` if it asserts `displayModel`.
- **Change:** `getModelVisualIdentity` becomes: `{ row, isDefault } = findModelRow(model, provider)` (imported from `models.generated.js`) → base identity from the row (`label`, `shortLabel`, `modelClass`, `modelTier`, `spriteId`, `paletteKey`, `trim`, `accent`) → apply the existing effort rendering (`EFFORT_ACCESSORIES`, `EFFORT_FLOOR_RINGS`, Codex equipment/`gpt55` sprite-by-effort, `codexHeavyGearBaked`) keyed by `modelClass` + `effortTier` → provider fallback rows from `MODEL_DEFAULTS`. `sessionPresentation.js:176-248` becomes the same `findModelRow` lookup from `models.generated.cjs` returning `{ shortLabel, effortTier, spriteId, color }`. `/api/sessions` keeps `displayModel`, `modelColor`, `spriteId` (cheap now, and an external contract for anyone who consumed the deleted KDE widget's shape).
- **Acceptance:** for every registry `sample` × provider, browser `getModelVisualIdentity().spriteId` equals server `modelIdentity().spriteId` and `formatModelLabel` outputs match (new assertions in 1.3); `mythos-5-1` resolves to the Fable sprite and label; existing `ui-data-remediation` identity expectations pass; `git diff --stat` on `ModelVisualIdentity.js` shows the ~300-line branch ladder replaced, not duplicated.
- **Evidence:** slice 01 findings 2–4.

### 1.3 Resolver probe + completeness test

- **Owned paths:** `scripts/models/resolve.mjs` (new), `scripts/tests/model-registry.test.mjs` (new), `package.json` (`models:resolve`), `scripts/smoke/README.md` (one row — coordinate with 2.4, which owns the rewrite; 1.3 adds its row after 2.4 or 2.4 includes it).
- **Change:** `node scripts/models/resolve.mjs <provider> <modelString> [--effort=high]` prints: raw → normalized candidates; matched registry row id (or `default:<provider>`); server pricing (`models.generated.cjs` via `createRequire`) vs browser pricing (`models.generated.js`) — numbers and match; context window from adapter vs browser; `displayModel` (server) vs label (browser); `spriteId`, `paletteKey`, `modelClass`, `mood`; manifest entry present (via `scripts/sprites/manifest-utils.mjs`, i.e. the declared `js-yaml` dev dependency after `npm ci` — never `claudeville/vendor/js-yaml.min.js`), `characters/<spriteId>/sheet.png` present and 736×920. Exit 1 on any server/browser disagreement or missing required asset. The test iterates every registry row: `sample` resolves to its own `id` in **both** generated modules; sprite exists in the manifest and on disk; ESM/CJS parity for pricing, label, sprite, context window; every manifest `agent.*` character is referenced by at least one row or a documented provider default (the reverse direction).
- **Acceptance:** `npm run models:resolve claude claude-mythos-5-1` exits 0 and prints the Fable row; `npm run models:resolve codex gpt-9` exits 0 with `default:codex` and no crash; temporarily deleting a `spriteId` from a row makes the test fail naming the row; the test is in `test:unit`.
- **Evidence:** slice 01 proposal 2; slice 04 proposal 5; slice 06 finding 5.

### 1.4 `add-model` skill (+ thin `add-provider`)

- **Owned paths:** `.claude/skills/add-model/SKILL.md`, `.claude/skills/add-model/references/checklist.md`, `.claude/skills/add-model/references/sprites.md`, `.claude/skills/add-provider/SKILL.md` (all new).
- **Change (per C6):** `add-model` *Inputs*: provider; every observed raw model string (aliases); official pricing + source URL + date; context window; label/shortLabel/class/tier/mood; reuse an existing sprite or new (→ `sprites.md` → 3.4's skill); effort/equipment rule if any; release tier. *Steps*: (1) `npm run models:resolve <provider> <model>` before — record the fallback; (2) confirm the adapter passes the string through (`rg` the adapter for model normalisation; Codex nickname mapping at `codex.js:507-520` is the known exception); (3) add one row to `models.json`; (4) `npm run models:generate`; (5) if new visual policy, edit only the `modelClass`-keyed code; (6) `npm run models:resolve` after — must exit 0; (7) add a fixture line to `scripts/adapters/fixtures/<provider>/` if the provider has fixtures; (8) `npm run test:unit`, `npm run validate:quick`; (9) CHANGELOG entry template (identity, pricing source/revision, context window, aliases, sprite reuse/new). *Never*: edit `models.generated.js`, edit `TokenUsage.js` tables, touch port 4000. `checklist.md` carries the three tracks (no sprite / new sprite / pricing-only) as the definitive file list. `add-provider` is a ≤60-line router to `docs/agent-provider-addition.md` Track A plus `node scripts/smoke/adapters.mjs` and `check:adapter-fixtures`.
- **Acceptance:** a fresh agent following only the skill adds an existing-sprite model touching `models.json` + generated file + fixture + CHANGELOG and nothing else; every command in the skill exists; no minimap/widget mention; `AGENTS.md` Project Map links the skill directory (0.2/3.5 own that table — 1.4 supplies the row text).
- **Evidence:** slice 01 proposal 3; slice 03 proposal 4.

### 1.5 Rewrite the model/provider runbook against the registry

- **Owned paths:** `docs/agent-provider-addition.md`, `docs/design-decisions.md` (pricing paragraph), `docs/troubleshooting.md:247-249` (model list), `claudeville/adapters/README.md` (pricing/reasoning note if it names `model-pricing.json`).
- **Change:** Track B becomes "one row in `models.json` + generate + resolve"; Track A/C unchanged in intent but every file/symbol re-verified; the validation matrix names `models:resolve`, `model-registry.test.mjs`, and 2.1's render smoke. `design-decisions.md` explains the registry + generated module and why (synchronous browser access, zero build, drift check).
- **Acceptance:** every path/symbol in the runbook exists (`rg` each); no reference to `model-pricing.json`, `TokenUsage` tables, minimap, or widget.
- **Evidence:** slice 01 finding 5; slice 02 finding 7.

**Wave 1 gate:** `npm run validate:quick` (now including `models:check` and `model-registry.test.mjs`) green; `npm run models:resolve` for one model per provider exits 0; manual browser pass on the maintained server: Dashboard cards, Activity Panel, World sprites show unchanged labels/sprites for live sessions.

---

## Wave 2 — Verification an agent can run

Produces C3. 2.1 lands the helper; 2.2, 2.3, 2.6 consume it (draft in parallel, integrate after 2.1). Ship with Wave 1.

### 2.1 Self-contained render smoke

- **Owned paths:** `scripts/smoke/support/isolated-server.mjs` (new, C3), `scripts/smoke/render-smoke.mjs` (new), `scripts/smoke/boot-contract.mjs` (refactor to use the helper; behaviour unchanged), `package.json` (`verify:render`), `AGENTS.md`/`CLAUDE.md` validation row "Anything under `src/`" (add `npm run verify:render`; coordinate with 3.5).
- **Change:** `verify:render` starts an isolated server, opens `?sim=1` (`App.js:232-240`) with Playwright at 1440×900, waits for the World canvas, switches to Dashboard, selects the first agent card, asserts the Activity Panel opens, deselects, switches back, and writes `world.png`, `dashboard.png`, `panel.png`, and `diagnostics.json` (console errors, page errors, `fps:updated` sample, mode timings) to an OS temp dir it prints. Non-zero exit on any console/page error or failed transition. Reuse `ui-remediation.mjs`'s selectors; leave that script in place.
- **Acceptance:** runs with no real CLI data and port 4000 occupied; prints the artifact directory; introducing a thrown error in `DashboardRenderer` makes it exit 1 with the error text; runtime <60 s.
- **Evidence:** slice 04 findings 4–6, proposal 1.

### 2.2 Executable architecture/server checks; skills become routers

- **Owned paths:** `scripts/smoke/architecture.mjs` (new), `package.json` (`verify:architecture`, `verify:server`), `.claude/skills/verify-architecture/SKILL.md`, `.claude/skills/verify-server/SKILL.md`, `.claude/skills/verify-ui/SKILL.md` (new).
- **Change:** `architecture.mjs` checks: layer directories exist; `package.json` has no `dependencies`; every adapter file in `claudeville/adapters/` (except `index.js`, `README.md`, helpers named in an allowlist) is registered in `index.js`; `server.js` binds `127.0.0.1` and port `4000`; `position: fixed` only in the allowlisted CSS files/selectors; root parity (`CLAUDE.md` vs `AGENTS.md` after line 2, done in Node — no process substitution). `verify:server` = `boot-contract.mjs && server-security.mjs && server-fatal.mjs`. Both skills shrink to ≤40 lines: when to run, the command, how to read a failure. `verify-ui` routes to `verify:render` for evidence and to the maintained server on 4000 for judgment-heavy review (read-only: open the URL, never start/kill).
- **Acceptance:** unregistering an adapter or changing the port fails `verify:architecture` naming the file; both `verify:*` pass from a clean checkout; the two skills contain no check that the scripts perform; `verify:architecture` is added to `validate:quick`.
- **Evidence:** slice 03 proposal 1; slice 02 finding 2 (process-substitution fragility).

### 2.3 Session payload contract test

- **Owned paths:** `scripts/tests/session-payload-contract.test.mjs` (new), `scripts/tests/support/session-contract.mjs` (new: required/nullable/optional key table).
- **Change:** one table of every client-consumed field (`AgentManager.js:515-552` is the consumer list) with type and nullability; the test runs the isolated server against the replay fixtures (reuse `r1-18.e2e-replay.mjs` fixture builders) and asserts `/api/sessions` and the WS `init` payload agree and conform. Bounded arrays (`tasks` ≤12, `gitEvents`) asserted.
- **Acceptance:** renaming or dropping a consumed field in `sessionPresentation.js` fails with the field name; the test is in `test:integration` (it boots a server) and runs in <15 s.
- **Evidence:** slice 04 finding 7, proposal 3.

### 2.4 Verification catalog and fixture docs

- **Owned paths:** `scripts/tests/README.md`, `scripts/smoke/README.md`, `scripts/adapters/fixtures/README.md` (new), `scripts/tests/support/catalog-check.test.mjs` (new).
- **Change:** `tests/README.md`: suite categories by directory/prefix, how to run one file (`node --test scripts/tests/foo.test.mjs`) and one case (`--test-name-pattern`), the temp-dir requirement (2.5), correct the "time is always injected" claim. `smoke/README.md`: every script in `scripts/smoke/` with requirements (node_modules / Playwright / server / temp / sockets), expected runtime, and a change-type → check matrix; fix "no test runner". `fixtures/README.md`: what each provider fixture is, redaction rule, consumers. `catalog-check.test.mjs`: every `scripts/smoke/*.mjs` and every `package.json` `check:*|test:*|verify:*` script appears in a README exactly once.
- **Acceptance:** the catalog test passes and fails when a smoke script is added without a README row.
- **Evidence:** slice 04 findings 8, proposal 4; slice 02 finding 3, 8, 9.

### 2.5 Explicit temp directory for tests and smokes

- **Owned paths:** `scripts/tests/support/tmp.mjs` (new), every `scripts/tests/*.test.mjs` and `scripts/smoke/*.mjs` that calls `os.tmpdir()` / `fs.mkdtempSync(os.tmpdir()…)` (mechanical; `rg -l 'tmpdir\(' scripts` is the list), `scripts/adapters/validate-fixtures.cjs`.
- **Change:** `makeTempDir(prefix)` honours `CLAUDEVILLE_TEST_TMPDIR`, falls back to `os.tmpdir()`, and on `EPERM`/`EACCES` throws one message naming the env var. Replace call sites.
- **Acceptance:** `CLAUDEVILLE_TEST_TMPDIR=$(mktemp -d) npm run test:unit` green; with an unwritable dir the first failure names `CLAUDEVILLE_TEST_TMPDIR`; `rg -n 'tmpdir\(' scripts/tests scripts/smoke` returns only `support/tmp.mjs`.
- **Evidence:** slice 04 finding 9 (15/613 failing in a read-only sandbox).

### 2.6 CI floor matches the release contract

- **Owned paths:** `.github/workflows/ci.yml`, `package.json` (`validate:full` = `validate:quick` + `test:integration` + `verify:server` + `world:validate-buildings` + `world:validate-terrain` + `sprites:validate`).
- **Change:** CI job `validate` runs `validate:full` on the matrix from 0.1. Playwright-based scripts stay out.
- **Acceptance:** CI green; the job log lists each command; a deliberate parity break in a branch fails CI.
- **Evidence:** slice 03 finding 3, proposal 2; slice 06 finding 5.

**Wave 2 gate:** `npm run validate:full` green locally and in CI; `npm run verify:render` produces three screenshots reviewed by the coordinator; `verify-*` skills read as routers.

---

## Wave 3 — Skills, hooks, release, artifacts

Independent items; parallel. Ship as the next named release or fold into Wave 1+2's release if ready.

### 3.1 Claude Code hooks: guard, syntax check, session banner

- **Owned paths:** `.claude/settings.json` (new), `scripts/agent-hooks/claude-hook.cjs` (new, C4), `scripts/tests/agent-hooks.test.mjs` (new), `AGENTS.md`/`CLAUDE.md` Git Hygiene section (one sentence: "enforced by `.claude/settings.json` for Claude Code; Codex relies on its sandbox").
- **Change:** settings per slice 03 proposal 3 (`SessionStart` → `session`; `PreToolUse` matcher `Bash` → `guard`; `PostToolUse` matcher `Edit|Write|MultiEdit` → `check-js`), each `timeout: 1`. `guard` tokenises `tool_input.command` (split on `&&`, `||`, `;`, `|`, then whitespace; strip quotes) and denies: `git reset --hard|--merge|--keep`; `git checkout --` or `git checkout <ref> -- <path>`; `git restore` unless every path flag is `--staged` and `--worktree` is absent; `git clean` with any of `-f -d -x -X` (allow `-n`/`--dry-run`); `git stash drop|clear`; `rm` whose option cluster contains both `r/R` and `f`; executables `kill`, `pkill`, `killall`; a pipeline containing `lsof -t*i :<port>` or `fuser` feeding `kill`. Deny → exit 2 + reason. `check-js` runs `node --check` on `tool_input.file_path` if it ends in `.js/.cjs/.mjs`; on failure prints the error (exit 0 — advisory, the agent sees it). `session` prints `git status --short` + `package.json` version + "maintained server: http://localhost:4000 (do not start/stop)".
- **Acceptance:** fixture tests cover each deny rule, `git restore --staged x` allowed, `git clean -n` allowed, `rm -rf node_modules/.cache` denied (documented false positive; the agent asks), commands with quoted spaces, malformed stdin (allow); each mode <200 ms over ten runs; `claude` session in this repo prints the banner.
- **Evidence:** slice 03 finding 5, proposal 3; slice 05 finding 11, proposal 6.

### 3.2 Release toolchain + `release` skill

- **Owned paths:** `scripts/release/changelog.mjs` (new), `scripts/release/prepare.mjs` (new), `scripts/tests/release-changelog.test.mjs` (new), `package.json` (`release:check`, `release:prepare`), `.claude/skills/release/SKILL.md` (new, `disable-model-invocation: true`), `AGENTS.md`/`CLAUDE.md` Changelog section (shrink to the format table + "run `npm run release:check <version>`").
- **Change:** `changelog.mjs` exports `parseReleaseHeader(line)`, `extractReleaseSection(text, version)`; strict grammar for the *top* entry only (`## v0.X.Y — *Name* · Mon DD, YYYY` or `## v0.X.Y.Z · Mon DD, YYYY — Hotfix`), tolerant for older entries. `prepare.mjs <version> [--write] [--tag]`: dry-run by default; validates the top entry matches `<version>`; computes UI version as `v<major>.<minor>` (documented rule, matches `v0.39` today); shows diffs for `package.json` and `claudeville/index.html` `.topbar__version`; prints extracted notes and the exact `gh release create v… --title … --notes-file …` command. `--write` applies; `--tag` creates a local annotated tag at HEAD only when the tree is clean; never pushes, never calls `gh`. Skill: ordered steps (status → choose tier → write entry → `release:check` → `release:prepare --write` → `gate:release` → commit → push on request → tag → `gh release` from the printed command → verify → status), with the `--latest=false` backfill rule.
- **Acceptance:** parser tests for named, hotfix, section boundary, mismatch, malformed top header, historical date-range entries; dry-run changes no files; `--write` yields matching versions in both files; notes equal the CHANGELOG section verbatim; `release:check` is in `gate:release`.
- **Evidence:** slice 05 findings 1–5, proposals 1–2.

### 3.3 Retained-artifact check and hygiene

- **Owned paths:** `scripts/agents/check-artifacts.mjs` (new), `package.json` (`check:artifacts` in `validate:quick`), `agents/README.md`, `agents/NFS-5.md` → `agents/plans/nfs-5.md`, `agents/plans/open-followups.md` (header + item fields), every `agents/plans/*.md` first status line (normalise to C5 — content unchanged).
- **Change:** the check parses `agents/README.md` tables and asserts every `plans/*.md`, `research/*/`, `handover/*.md` is indexed exactly once with a status equal to the artifact's C5 line; `open-followups.md` items get `ID`, `Added`, `Last reviewed`, `Trigger` fields and the "as of" header is updated at each release (3.2's `prepare.mjs` prints a reminder). Index `research/nfs-5/` and this review's research directory.
- **Acceptance:** `npm run check:artifacts` passes on the tree after this item and fails when a plan is added without an index row or its status drifts; `agents/NFS-5.md` no longer exists at the root.
- **Evidence:** slice 05 findings 6–8, proposals 3–4.

### 3.4 Sprite workflow: manifest-driven generation, `sprite-character` skill, consistency checks

- **Owned paths:** `claudeville/assets/sprites/manifest.yaml` (add `generationSize`/`generationMode` to `characters[]`; migrate the existing `# NOTE` comments), `scripts/sprites/plan.mjs`, `scripts/sprites/manifest-validator.mjs`, `scripts/sprites/generate-character-mcp.mjs`, `scripts/sprites/author-roster-channels.mjs` (`--check` mode: every character with a required sidecar geometry has a profile), `scripts/sprites/generate.md` (single canonical "Add one character" section), `docs/pixellab-reference.md` (reduce to API parameters/lifecycle/pitfalls; link the runbook; fix the 92-vs-76 contradiction at `:124-129,282-294`), `claudeville/CLAUDE.md` Sprite Generation paragraph (shrink to the invariant + link), `.claude/skills/sprite-character/SKILL.md` (new), `package.json` (`sprites:audit-refresh` also runs `author-roster-channels --check` and `sprites:channels-validate`).
- **Change:** as slice 06 proposals 1, 2, 4. The skill's inputs: sprite id, provider, prompt fragments, palette key, optional generation size/mode/seed, material class, emissive colours; steps: manifest entry → `sprites:plan -- --ids=<id>` → `create_character` → two `animate_character` → poll `get_character` → download → `generate-character-mcp.mjs` → channels → `sprites:audit-refresh` → capture → `assetVersion` bump. Codex reaches the same via `AGENTS.md` → `generate.md` and the project-scoped PixelLab MCP in `.codex/config.toml`.
- **Acceptance:** `npm run sprites:plan -- --ids=agent.claude.fable` prints generation 76 / engine cell 92 / sheet 736×920; a character entry without `generationSize` fails validation with its id; deleting the Sol profile fails `author-roster-channels --check` naming `agent.codex.gpt56sol`; `rg -n 'size=92' docs/pixellab-reference.md` returns nothing in the character recipe; the skill is ≤100 lines.
- **Evidence:** slice 06 findings 1–3, 5–6.

### 3.5 Root context restructure (progressive disclosure)

- **Owned paths:** `AGENTS.md`, `CLAUDE.md` (mirror), `claudeville/CLAUDE.md`, `docs/README.md`, `CONTRIBUTING.md` (new), `claudeville/adapters/README.md` (receives adapter detail), presentation READMEs (receive UI detail).
- **Change:** target 550–700 words for `AGENTS.md`. Keep inline: scope/desktop/zero-build, shared-checkout safety, `npm run dev`, Project Map (+ rows for `.claude/skills/`, `.claude/settings.json`, `.codex/config.toml`, `scripts/tests/`, `scripts/smoke/`, `.github/workflows/ci.yml`, `scripts/models/`), the change-type → command table (now including `models:resolve`, `verify:render`, `verify:architecture`, `verify:server`), Git Hygiene, English policy. Move to `CONTRIBUTING.md`: remotes, changelog grammar detail, tag/GitHub release flow (3.2's skill links it). Move from `claudeville/CLAUDE.md` to nearest owners: per-adapter detail → `adapters/README.md`; sprite procedure → `generate.md`; Dashboard/Panel behaviour → the presentation READMEs; keep server invariants, cadence constants, event-bus ownership. `docs/README.md` gains `Status`/`Purpose` columns for every `docs/*.md` (add `building-style-contract.md`, hook ingestion row, screenshot-capture row).
- **Acceptance:** parity diff empty; every moved section reachable by a working link from its old location; no factual contract stated in two authoritative places; `wc -w AGENTS.md` within target; `docs/README.md` lists every `docs/*.md` exactly once (add a check to 2.4's catalog test).
- **Evidence:** slice 02 findings 8, 11, 12, proposal 6; slice 03 finding 8.

### 3.6 Dogfood: opt-in Claude Code → `/api/ingest/hook`

- **Owned paths:** `scripts/agent-hooks/claude-hook.cjs` (`ingest` mode; coordinate with 3.1 — 3.1 lands first), `.claude/settings.json` (`PreToolUse`/`PostToolUse`/`Stop` matchers calling `ingest`), `scripts/tests/agent-hooks.test.mjs` (mapping fixture), `claudeville/CLAUDE.md` + `docs/troubleshooting.md:37-41` (payload schema in one place, linked from the other).
- **Change:** when `CLAUDEVILLE_DOGFOOD_HOOKS=1`, map `{ session_id, hook_event_name, tool_name, tool_input, cwd }` to `adapters/hooks.js`'s accepted `{ provider:'claude', sessionId, kind, tool, input, cwd, ts }` (`hooks.js:147-181`), POST to `http://127.0.0.1:4000/api/ingest/hook` with a 150 ms timeout and the optional `X-ClaudeVille-Ingest-Token`; never forward prompts or transcript text; fail open.
- **Acceptance:** with the flag set and the maintained server running, a tool call in this repo appears as a `tool_pending` overlay on the live agent within one poll; with the flag unset the hook adds <5 ms; with the server down the tool proceeds.
- **Evidence:** slice 03 finding 6, proposal 5; `server.js:497-545`.

### 3.7 PR and issue templates ask for the evidence `AGENTS.md` requires

- **Owned paths:** `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/world_visual_issue.yml`.
- **Change:** PR: *Changed paths*, *Commands run and results* (verbatim), *Browser evidence or "N/A — reason"*, *Pre-existing failures*, *Release: version trio + tag + GitHub release checked*. Bug: environment required. Visual: viewport + capture required-or-explained.
- **Acceptance:** templates render on GitHub; each required field maps to a row of the validation table.
- **Evidence:** slice 05 findings 9–10, proposal 5.

**Wave 3 gate:** `npm run validate:full` green; `claude` in this repo shows the session banner and denies `git reset --hard` in a scratch test; `npm run release:prepare 0.40.0` dry-run prints the correct diffs and notes; `npm run check:artifacts` green.

---

## Skill portfolio (decisions)

| Skill | Decision | Why | Item |
| --- | --- | --- | --- |
| `add-model` | **build** | most repeated task (16 model + 3 pricing commits since March, each 7–25 files); becomes one row + generate + resolve | 1.4 |
| `add-provider` | **build, thin** | different scope (new source dir, watch paths, fixtures); routes to Track A + adapter smokes | 1.4 |
| `sprite-character` | **build** | 197 sprite/asset commits; most tacit knowledge in the repo; PixelLab MCP is project-scoped for both CLIs | 3.4 |
| `release` | **build, manual-invocation only** | externally mutating; wraps `scripts/release/*` so version strings are never hand-edited | 3.2 |
| `verify-architecture`, `verify-server` | **rewrite as routers** | prose checks are stale; scripts decide | 0.3 → 2.2 |
| `verify-ui` | **build, thin** | routes to `verify:render` for evidence and the maintained server for judgment | 2.2 |
| `pricing-refresh` | **reject** | prices change rarely; it is a one-row edit + `models:generate` inside `add-model` | — |
| `plan-execute` | **reject** | `agents/README.md` + C5 + `check:artifacts` cover it; execution varies per plan | — |
| `docs-parity` | **reject as skill** | deterministic → `verify:architecture` | 2.2 |
| slash commands | **none** | every candidate is either a skill (judgment) or an npm script (deterministic) | — |

Codex parity: Codex loads `AGENTS.md` and the project MCP but not `.claude/skills`. Every skill therefore routes to a script or doc that `AGENTS.md` links; a Codex agent gets the same procedure one hop later.

---

## Open decisions (coordinator defaults; override in the executing conversation)

1. **Mythos identity.** Default: alias of Fable (`match: ["fable-5-1","mythos-5-1"]`). Distinct sprite → a separate row later via `add-model`.
2. **Node floor.** Default: keep `>=18` and test it in CI (0.1). If 18 cannot run `test:integration` on the runner, raise `engines` and say so in the changelog rather than skipping the job.
3. **`/api/sessions` identity fields** (`displayModel`, `modelColor`, `spriteId`). Default: keep; they cost nothing once derived from the registry and may have external consumers.
4. **Dogfood hooks.** Default: committed in `.claude/settings.json` but inert without `CLAUDEVILLE_DOGFOOD_HOOKS=1`.
5. **Screenshots from `verify:render`.** Default: ephemeral (OS temp). Retain under `agents/research/<slug>/shots/` only when a plan cites them.

---

## Execution order and sizing

| Wave | Items | Parallel units | Size | Ships as |
| --- | --- | --- | --- | --- |
| 0 | 0.1–0.5 | 5 | 5×S | hotfix `v0.39.1.1` |
| 1 | 1.1 → {1.2, 1.3} → {1.4, 1.5} | 1, then 2, then 2 | M, M, M, S, S | named release with Wave 2 |
| 2 | 2.1 → {2.2, 2.3, 2.6}; 2.4, 2.5 anytime | 1, then 3 (+2) | M, M, S, S, S, S | named release with Wave 1 |
| 3 | 3.1 → 3.6; 3.2, 3.3, 3.4, 3.5, 3.7 independent | 5 (+1) | M, M, S/M, M, M, M, S | next named release |

Per-wave gate is run once by the coordinator over the union of changed files: `npm run validate:quick` (Wave 0), `validate:full` (Waves 1–3), plus the wave-specific checks above. No wave is declared done with a red CI run on the pushed commit.

## Definition of done

- CI green on `main` for a clean checkout on every promised Node version.
- Adding a model = one row in `models.json` + `npm run models:generate` + a fixture line + CHANGELOG, verified by `npm run models:resolve` exiting 0 and `model-registry.test.mjs` passing.
- `AGENTS.md`, `CLAUDE.md`, `claudeville/CLAUDE.md`, the skills, and the READMEs contain no statement contradicted by the code; parity holds; `check:artifacts` and the catalog test are green.
- An agent can produce screenshot + console evidence for a UI change (`verify:render`) and server evidence (`verify:server`) without a human and without port 4000.
- A release is prepared by `scripts/release/prepare.mjs`, never by hand-editing three version strings.
