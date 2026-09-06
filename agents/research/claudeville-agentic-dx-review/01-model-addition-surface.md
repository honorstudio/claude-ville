# Model-addition surface

**Status:** `ready` · read-only review · Codex `sol medium` · session `01a062b9-1074-74e0-afc8-fb4ace61da18` · 491s · 2026-09-02

Slice 1 of the six-part agentic-DX review. Consolidated into `agents/plans/claudeville-agentic-dx-plan.md`.

## Findings

1. The definitive current-state checklist is broader and more conditional than Track B describes.

   | Change type | Hard requirements | Conditional / polish | Existing guard |
   |---|---|---|---|
   | Existing provider, no new sprite | Verify the adapter preserves the observed model string; edit its parser only if it does not. Codex normally passes `payload.model` through (`claudeville/adapters/codex.js:179-198`), while its GPT‑5.6 child-name inference is a model-specific exception (`claudeville/adapters/codex.js:507-520`). Add explicit pricing to `model-pricing.json` and `TokenUsage.js` when fallback pricing is unacceptable (`claudeville/src/config/model-pricing.json:3-175`, `claudeville/src/domain/value-objects/TokenUsage.js:16-85`). Add browser identity in `getModelVisualIdentity` (`claudeville/src/presentation/shared/ModelVisualIdentity.js:183-487`) and, under the current API contract, server identity in `modelIdentity` (`claudeville/adapters/sessionPresentation.js:176-248`). Add the model to `LIVE_MODELS` (`scripts/tests/r2-02.pricing.test.mjs:25-33`). | Update provider context logic only when the provider does not report the limit or its fallback changes: Claude (`claudeville/adapters/claude.js:100-105,382-390`), Gemini (`claudeville/adapters/gemini.js:251-255`), Grok (`claudeville/adapters/grok.js:670-697`), OpenCode/DeepSeek (`claudeville/adapters/opencode.js:260-265`), and browser fallback (`ModelVisualIdentity.js:153-180`). Add temperament markers only for non-balanced behavior (`AgentMood.js:56-103`). Add `AvatarCanvas._drawModelInsignia` only for a distinct procedural fallback (`AvatarCanvas.js:453-598`). | Pricing parity is tested across every JSON rate and provider default (`r2-02.pricing.test.mjs:60-84`), but identity coverage is only one Gemini fallback (`ui-data-remediation.test.mjs:23-29`). Mood has hand-picked cases (`r2-06.model-behaviour.test.mjs:13-29`). |
   | With a new sprite | All preceding identity work, plus a `characters[]` manifest entry and `characters/<spriteId>/sheet.png`; manifest IDs determine runtime paths (`manifest.yaml:46-78`, `scripts/sprites/generate.md:40-52`). Bump `style.assetVersion` when the PNG changes (`manifest.yaml:1-3`, `scripts/sprites/generate.md:69-75`). | If `materialSidecar`/`emissiveSidecar`/`occluderSidecar` is declared, corresponding PNGs become mandatory (`manifest-validator.mjs:86-107`, `channel-validation.mjs:82-103`). Add `author-roster-channels.mjs:PROFILES` only when that script authors the sidecars (`author-roster-channels.mjs:24-50`). Edit `palettes.yaml` only for a new/changed palette; edit and rebake `atlases[].ids` only if enrolling the sprite in the reviewed atlas (`manifest.yaml:15-29,538-565`, `scripts/sprites/generate.md:102-125`). `AgentSprite.js` changes are required only for bespoke equipment, baked-weapon cleanup, or a new tier effect (`AgentSprite.js:251-259,2977-3075,3175-3179,4186-4193`). Dashboard insignia remains fallback polish because the generated sprite is attempted first (`AvatarCanvas.js:88-101,215-218`). | `sprites:audit-ids` catches code IDs missing from the manifest (`manifest-id-audit.mjs:28-51`). Full validation checks missing/orphan PNGs, palettes, sheets, sidecars, and atlases (`manifest-validator.mjs:86-164`). |
   | Pricing-only refresh | Update rates/defaults/revision in both pricing stores (`model-pricing.json:1-357`, `TokenUsage.js:16-85`). Update four hard-coded TopBar revision strings (`TopBar.js:792,854-856,905`) and the Claude adapter’s fallback revision (`claude.js:463-468`). Update the pricing rationale/source date in `docs/design-decisions.md:77-83` and model list in `docs/troubleshooting.md:247-249`. A shipped change also requires `CHANGELOG.md` and version files under the root policy. | Update price-specific assertions where applicable, such as Fable (`r2-02.pricing.test.mjs:86-105`); `claude-projection.test.mjs:54-59` also embeds the current revision and will fail after a revision bump. | Server/browser numerical parity is strong (`r2-02.pricing.test.mjs:60-84`), but TopBar copy and documentation have no guard. |

2. Pricing and identity have independent drift surfaces. Pricing is manually duplicated between JSON and six browser tables plus defaults/revision (`TokenUsage.js:16-85`). Identity is separately implemented by server and browser (`sessionPresentation.js:176-248`; `ModelVisualIdentity.js:183-487`). The stated reason—synchronous browser helpers in a zero-build app—is valid (`docs/design-decisions.md:77-83`), but it explains synchronous access, not hand-maintained duplication. This makes a routine model addition touch unrelated module systems and ordering-sensitive substring tables.

3. Most server identity maintenance currently has no browser benefit. The server adds `displayModel`, `modelColor`, and `spriteId` (`sessionPresentation.js:263-286`), but `AgentManager._sessionToAgentPayload` maps the raw model, effort, cost, and usage—not those identity fields (`AgentManager.js:515-552`). Browser labels and visuals are recomputed from `ModelVisualIdentity.js` (`AgentPresentation.js:132-139`). Agents can therefore update one identity implementation, see a correct UI, and silently leave `/api/sessions` inconsistent.

4. Current data already demonstrates missing cross-layer checks. `mythos-5-1` has an explicit price (`model-pricing.json:18-37`) but no identity or mood marker, so it resolves as Claude Sonnet/balanced through the provider fallback (`ModelVisualIdentity.js:247-263`; `AgentMood.js:56-75`). Browser context fallback also returns 200k for Fable/Opus while the Claude adapter returns 1M (`ModelVisualIdentity.js:153-180`; `claude.js:100-105,382-390`). Normal live sessions conceal the latter because adapter token usage supplies `contextWindowMax`.

5. The runbook is materially stale. It says server presentation changes are needed only if pricing/status copy changes (`docs/agent-provider-addition.md:37-43`), despite the duplicate API identity. It repeatedly requires minimap verification (`docs/agent-provider-addition.md:33-34,40-50`), but `Minimap.js` was deleted in `d0b9879c`. Related README files still describe it (`character-mode/README.md:3-11,40,60`; `shared/README.md:54-63`). The widget no longer exists; it and its pricing checks were deleted in `3af691eb`.

## Proposals

1. **Generate synchronous model data from one canonical registry** — Effort: M; impact: highest, every model/pricing change.

   Add `claudeville/src/config/models.json` containing ordered match strings, provider, sample raw ID, pricing, context limit, identity fields, behavior tier, and optional sprite/equipment metadata. Add `scripts/models/generate.mjs` producing an ESM `models.generated.js` for the browser and CJS/JSON output for adapters. Edit `TokenUsage.js`, `ModelVisualIdentity.js`, `AgentMood.js`, `sessionPresentation.js`, and applicable adapter context helpers to consume generated data; retain special renderer code only for genuinely bespoke visuals. Add `models:generate` and `models:check` to `package.json`, with `models:check` in `validate:quick`.

   Acceptance: generated outputs are byte-stable; `models:check` fails after editing canonical data without regeneration; adding an ordinary existing-sprite model changes one source row plus generated files/tests; server/browser resolve identical pricing, labels, sprite IDs, and context limits.

   Tradeoffs: unlike API/WS configuration, this preserves synchronous offline startup. Unlike JSON import attributes, it supports the declared Node ≥18/browser range without relying on uneven JSON-module syntax. Unlike a hand-written dual CJS/ESM module, it keeps module-system concerns out of runtime source. Risk: generated files add review noise; clear “DO NOT EDIT” headers and a drift check are essential.

2. **Add a dependency-free model resolver probe and completeness test** — Effort: M; impact: high, every model addition.

   Add `scripts/models/resolve.mjs <provider> <modelString> [--effort=…]`. It should print raw/normalized IDs; server and browser price match/default status; server `displayModel` versus browser label; context-window sources; sprite ID, palette, tier, temperament; manifest entry and PNG presence; and exit nonzero on disagreement or missing required assets. Export narrowly scoped pure resolver helpers where necessary.

   Add `scripts/tests/model-registry.test.mjs`. Iterate every canonical rate/sample and assert concrete identity, context policy, manifest presence, and server/browser parity; iterate every priced identity back to a non-default rate. Explicit aliases may share an identity but must declare that relationship.

   Acceptance: Mythos currently fails as Sonnet until intentionally mapped; an unknown model reports defaults without crashing; every registry row passes under `npm run test:unit`.

   Risk: “identity” must mean an explicit registry row, not merely a provider fallback, or the test becomes vacuous.

3. **Create the progressive-disclosure Claude Code skill** — Effort: S; impact: high for Claude Code contributors.

   Add:

   - `.claude/skills/add-model/SKILL.md`
   - `.claude/skills/add-model/references/checklist.md`
   - `.claude/skills/add-model/references/sprites.md`

   `SKILL.md` should ask for: provider; exact observed model strings/aliases; official pricing and verification date; context window; label/class/tier/behavior; reuse/new sprite; effort/equipment rules; and intended release tier. Its ordered workflow should run the probe before and after, verify adapter passthrough, update canonical model data, handle sprite work only when requested, add fixture/test coverage, run `node --check` on changed adapters, `npm run test:unit`, `npm run validate:quick`, and sprite checks when applicable.

   `checklist.md` should contain the three definitive tracks above. `sprites.md` should link to `scripts/sprites/generate.md` and explain manifest entry, PNG, asset version, optional sidecars/palette/atlas. Changelog guidance: describe user-visible model identity, pricing source/revision, context window, aliases, reused/new sprite, and fallback behavior; version edits occur only when preparing a push.

   Acceptance: a fresh agent can complete an existing-sprite addition without opening unrelated renderer files; all commands and paths exist; no minimap/widget instruction remains.

   Risk: the skill and runbook can drift; make the skill link to the checklist rather than copying it.

4. **Repair current guidance and revision copy immediately** — Effort: S; impact: medium-high.

   Update `docs/agent-provider-addition.md`, `shared/README.md`, `character-mode/README.md`, `claudeville/CLAUDE.md`, and stale README minimap wording. Replace TopBar’s literal revision with `TokenUsage.rateRevision`.

   Acceptance: `rg -n -i 'minimap|widget'` returns only historical or intentionally retained discussion; one pricing revision constant drives all live UI text.

   Risk: none beyond accurately distinguishing historical changelog entries.

## Open questions

1. Are `displayModel`, `modelColor`, and `spriteId` in `/api/sessions` a supported external contract? The in-repo browser ignores them, but removing them could affect integrations.
2. Should Mythos intentionally reuse Fable’s identity and temperament, or receive a distinct visual identity?
3. Is atlas membership expected for every flagship model sprite, or only selected performance representatives as the current atlas documentation states?
