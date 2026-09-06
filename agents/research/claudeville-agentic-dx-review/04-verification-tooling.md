# Verification tooling

**Status:** `ready` · read-only review · Codex `sol medium` · session `01a062b9-105a-7590-a08e-060a5f25c259` · 225s · 2026-09-02

Slice 4 of the six-part agentic-DX review. Consolidated into `agents/plans/claudeville-agentic-dx-plan.md`.

## Findings

1. **The “quick, dependency-free unit suite” is neither purely unit-level nor quick.** `test:unit` runs every `*.test.mjs` (`package.json:42`), including a real server/WebSocket replay (`scripts/tests/r1-18.pipeline-replay.test.mjs:4-13`) whose success path deliberately waits at least 20 seconds (`scripts/smoke/r1-18.e2e-replay.mjs:799-815`). `gate:release` then runs the same replay again (`package.json:45`). This obscures the fastest feedback loop and adds at least ~40 seconds to a normal release gate.

2. **CI appears unable to run from a clean checkout.** CI executes `npm run validate:quick` without `npm ci`/`npm install` (`.github/workflows/ci.yml:14-21`), but that command ends with `sprites:audit-ids` (`package.json:44`), which imports `js-yaml` through `manifest-utils.mjs` (`scripts/sprites/manifest-utils.mjs:1-5`). `js-yaml` is only a dev dependency (`package.json:67-71`). An agent cannot trust CI parity from the documented “no install” workflow.

3. **The supported Node range is not tested.** The package promises Node `>=18` (`package.json:29-30`), while CI tests only 24 (`.github/workflows/ci.yml:10-12`). The replay needs either `node:sqlite` or an installed `sqlite3` CLI on Node 18 (`scripts/smoke/r1-18.e2e-replay.mjs:85-107`), so the release gate is machine-dependent on a supported runtime.

4. **Browser automation already exists, but agents are told browser verification is wholly manual.** `ui-remediation.mjs` launches Playwright, uses deterministic `?sim=1`, switches Dashboard, selects agents, and records page errors (`scripts/smoke/ui-remediation.mjs:3-10,27-76`). `capture-baseline.mjs` likewise freezes a deterministic scenario and fails on browser errors (`scripts/sprites/capture-baseline.mjs:36-75`). Neither is exposed through a package script or CI, and the smoke README lists only 6 of 25 smoke scripts (`scripts/smoke/README.md:9-45`). Agents are likely to miss valuable checks.

5. **There is no single self-contained frontend change check.** Existing Playwright scripts default to a separately maintained server at port 4000 (`scripts/smoke/ui-remediation.mjs:6-7`; `scripts/sprites/capture-baseline.mjs:21`). Conversely, server smokes already know how to launch an isolated production server with temporary HOME and an ephemeral port (`scripts/smoke/boot-contract.mjs:544-560,690-711`). These capabilities are not combined, leaving common DOM/world changes dependent on operator setup.

6. **Server fixtures exist, but not as a reusable fixture-server mode.** `boot-contract` injects a temporary HOME and verifies HTML, providers, sessions, usage, and WebSocket snapshots (`scripts/smoke/boot-contract.mjs:500-541,690-728`). The multi-provider replay similarly provides deterministic Claude/Codex/Gemini/OpenCode data (`scripts/smoke/r1-18.e2e-replay.mjs:741-769`). Production `server.js` has no fixture-root setting; it fixes the normal adapter-backed collection path (`claudeville/server.js:384-417,1514-1528`). New tests must duplicate bespoke bootstrap logic.

7. **`/api/sessions` contract coverage is shallow.** `boot-contract` checks the collection, count, timestamp, provider, and model only (`scripts/smoke/boot-contract.mjs:524-532`). Adapter parity checks a few common optional fields (`scripts/tests/r2-02.adapter-parity.test.mjs:208-228`), but there is no centralized assertion for the complete client-consumed session shape. Field drift can therefore pass server smoke yet break the frontend.

8. **Test documentation contradicts implementation.** The README says time is always injected and `Date.now()` is never used (`scripts/tests/README.md:27-31`), but many tests use wall-clock time; for example identity fixtures do so at `scripts/tests/claude-identity.test.mjs:36,55`. The smoke README says the project has “no test runner” (`scripts/smoke/README.md:3-7`) despite 613 `node:test` cases. Release-coded names such as `r1-18`, `r2-02`, `w4-d` hide intent unless an agent knows historical planning vocabulary.

9. **Writable-temp assumptions can block verification in agent sandboxes.** Numerous tests create fixtures directly under `os.tmpdir()` (`scripts/tests/claude-identity.test.mjs:15-16`; `scripts/tests/r2-02.adapter-parity.test.mjs:208-209`). In this read-only environment, `npm run test:unit` took 5.86 seconds but reported 598/613 passing, with all 15 failures caused by `EPERM` creating temporary directories. The successful path’s 20-second replay never began. This is environment coupling, not a product regression, but the output does not distinguish it cleanly.

### Verification inventory

“Modules” means installed dev dependencies; “server” means an already-running dashboard. Times are code-imposed minimums/defaults where available; only `test:unit` was timed.

| Entry point | What it proves | Requirements / runtime | Inclusion |
|---|---|---|---|
| `check:{server,adapters,services,frontend-syntax,scripts}` | JS parseability via `node --check` (`scripts/check-syntax.cjs:34-56`) | Node only; usually seconds | Quick, release, CI |
| `check:git-events` | Git command parsing, merging, browser normalization (`scripts/check-git-events.cjs:30-109,131-218`) | Node only | Quick, release, CI |
| `check:adapter-fixtures` | Normalization plus Codex/Kimi/OpenCode fixtures | Writable temp; OpenCode depth varies with `node:sqlite`/`sqlite3` (`scripts/adapters/validate-fixtures.cjs:1149-1165,1303-1311`) | Quick, release, CI |
| `check:theme-tokens` | CSS/theme token consistency | Node only | Quick, release, CI |
| `test:unit` | 613 pure-policy, DOM-stub, adapter, filesystem and server-replay cases | Writable temp; nominally ≥20s; observed 5.86s ending in 15 temp-permission failures | Quick, release, CI |
| `sprites:audit-ids` | Referenced IDs exist in manifest (`scripts/sprites/manifest-id-audit.mjs:28-54`) | `js-yaml`/node_modules | Quick, release, CI |
| `test:e2e:replay` | Deterministic multi-provider HTTP/WS delta/snapshot pipeline | Writable temp, sockets, SQLite; ≥20s | Release; also duplicated inside unit |
| `server-{security,fatal}`, `boot-contract` | Security, fatal cleanup, static/API/WS boot | Writable temp and ephemeral loopback sockets; ≤30s contract timeout (`scripts/smoke/boot-contract.mjs:19-22`) | Release |
| Pure direct smokes: `adapters`, `relationship`, `claude-transcript-aggregate`, `codex-warm-discovery`, `harbor-traffic-bounds`, `overlay-layout`, `scoped-invalidation`, `tail-cache`, `usage-history-bounds`, `watcher-topology`, `world-state-bounds` | Adapter, cache, relationship, bounded-state and watcher logic | Node; most need writable temp; no real HOME | Manual only |
| Runtime direct smokes: `watcher-runtime`, `watcher-footprint` | Live watcher behavior/count | First is isolated; footprint needs running server | Manual only |
| Browser smokes: `ui-remediation`, `browser-lifecycle`, `world-visit-paths` | DOM semantics, lifecycle, mode switching, selection, paths | Playwright + running server; deterministic `?sim=1` | Manual only |
| Performance smokes: `performance-soak`, `trail-camera-benchmark`, `world-fps-benchmark` | Resource stability, trail policy, FPS | Playwright + server; soak defaults 10/30 minutes (`scripts/smoke/performance-soak.mjs:6-10`) | Manual only |
| `sprites:validate` / channel/atlas checks | Manifest↔PNG, dimensions, channels, atlas contracts | `js-yaml`, `pngjs` | Manual |
| `sprites:capture-{baseline,fresh}` → `visual-diff` | Deterministic day/night captures; ≤0.5% pixel difference (`scripts/sprites/visual-diff.mjs:18-19,69-84`) | Playwright + server, then `pngjs`/`pixelmatch`; writes tracked baseline directory | Manual |
| `world:validate-{buildings,terrain}` | Static building, walkability and terrain/cache contracts | Node; no server | Manual |
| `world:capture-render-baselines [--dry-run]` | Manifest validity; otherwise screenshots, diagnostics and performance metadata (`scripts/world/capture-render-baselines.mjs:20-39,390-453`) | Dry run still imports Playwright; capture needs server/modules | Manual |
| `world:verify-dpr`, marketing/verify captures | DPR invariants or review screenshots | Playwright + server; writes `output/` | Manual |

### Unverifiable surface

| Common change | Agent can run today | Still needs human |
|---|---|---|
| Identity/model/sprite | Identity/pricing unit cases, ID audit, manifest validation, captures/diff | Judge recognizability, animation quality, false-positive pixel diffs |
| Panel DOM | Pure DOM-stub tests; undiscoverable `ui-remediation` | Layout/readability unless agent manually arranges server + Playwright |
| World rendering | Policy units, building/terrain validators, baseline capture/diff | Artistic quality, occlusion/readability and approved north-star frames (`docs/world-visual-qa-checklist.md:45-66`) |
| Adapter parsing | Fixture validator, adapter parity, replay | Validate genuinely new upstream transcript shapes not represented by fixtures |
| Server API | Boot/security/replay smokes | Complete payload compatibility because no exhaustive schema assertion exists |
| Pricing | Server/browser agreement and known-model tests (`scripts/tests/r2-02.pricing.test.mjs:42-83`) | Confirm external prices and effective dates are actually current |

## Proposals

1. **Self-contained `verify:render-smoke` — M, highest impact.** Add `scripts/smoke/render-smoke.mjs`, factor isolated-server startup from `boot-contract.mjs` into `scripts/smoke/support/isolated-server.mjs`, add a package script, and document it in both validation tables. Reuse `?sim=1` from `App.js:232-240`; switch World/Dashboard, select/deselect a fixture agent, open the panel, capture both modes and collect console/page errors into an OS temp directory. Acceptance: succeeds with no real CLI data or port 4000, prints artifact path, produces two screenshots plus JSON diagnostics, and fails on console errors/missing cards/panel/mode transition. Risk: Chromium-version screenshot variance; screenshots should be review evidence, not a CI pixel gate.

2. **Repair and split the gates — S.** Add `npm ci` to CI; split `test:pure`, `test:integration`, `validate:quick`, and `validate:full`; move `r1-18.pipeline-replay.test.mjs` out of the pure glob and run the replay once. Test Node 18 plus current LTS/24, installing `sqlite3` CLI for Node 18 or excluding OpenCode with an explicit reported skip. Acceptance: clean-checkout CI passes on every promised Node version; `validate:quick` has no 20-second wait; release replay executes exactly once. Risk: slightly more CI time.

3. **Central session contract assertion — S.** Add `scripts/tests/session-payload-contract.test.mjs` and a reusable fixture/assertion module covering required types, bounded arrays, optional fields and HTTP/WS parity. Reuse replay fixtures and normalization. Acceptance: deleting or mistyping any client-consumed field fails with a field-specific message. Risk: over-constraining intentionally provider-specific fields; distinguish required, nullable, and optional keys.

4. **Create a verification catalog organized by intent — S.** Rewrite `scripts/tests/README.md` and `scripts/smoke/README.md`; document every command with requirements, expected duration and change-type mapping. New files should use semantic names (`session-payload-contract.test.mjs`, `render-smoke.mjs`); retain historical filenames but add aliases/index entries. Acceptance: every package verification script and every smoke file appears exactly once in the catalog. Risk: documentation drift; add a tiny catalog-coverage check.

5. **Add a table-driven model visual resolver contract — S.** Extend or split `ui-data-remediation.test.mjs` around `ModelVisualIdentity.js:183`, checking every maintained provider/model/effort resolves to the expected sprite ID and that each ID exists in the manifest. This fits existing deterministic smoke conventions but belongs in `node:test`, not another historical `rN-NN` smoke. Acceptance: a newly supported model cannot silently fall back while pricing tests pass. Risk: expected mappings require intentional updates when art policy changes.

6. **Make temp requirements explicit — S.** Add a shared temp helper honoring `CLAUDEVILLE_TEST_TMPDIR` and emitting a preflight diagnostic; use it in filesystem tests and smokes. Acceptance: an unwritable default temp directory yields one actionable failure, and setting the override runs fixtures elsewhere. Risk: mechanical migration across many files.

## Open questions

- Is CI currently passing because a hidden workflow step or cached workspace supplies `node_modules`? Nothing in `.github/workflows/ci.yml` does.
- Should visual artifacts remain ephemeral, or may selected render-smoke screenshots be retained under `agents/research/` for review?
- Is Node 18 support still intentional, given the OpenCode replay’s SQLite requirement?
