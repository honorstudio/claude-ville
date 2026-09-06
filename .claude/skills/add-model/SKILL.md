---
name: add-model
description: Add or refresh a ClaudeVille model, its canonical pricing and identity, and optional sprite. Use for a model alias, pricing-only update, or model visual addition; never use it to add a new provider or hand-edit generated registry modules.
---

# Add a model

## When to use

Use this skill for a model on an already supported provider. Read [references/checklist.md](references/checklist.md) and choose exactly one track. For a new provider, use `add-provider` instead.

## Inputs

- Provider and every exact observed raw model string or alias.
- Official pricing, source URL, and verification date.
- Context window; label and short label; `modelClass`, `modelTier`, and mood.
- Existing `spriteId` to reuse, or approval for a new sprite via [references/sprites.md](references/sprites.md).
- Any genuinely new effort, equipment, or insignia rule.
- Intended release tier: named release or hotfix.

## Steps

1. Run `node scripts/models/resolve.mjs <provider> <model>` for each observed string and record the current fallback.
2. Inspect `claudeville/adapters/<provider>.js` and use `rg -n 'model|normalize' claudeville/adapters/<provider>.js` to confirm the raw model is preserved. Change parsing only when evidence shows it is not. Codex child-name inference is the known exception.
3. Add one ordered row (aliases share its `match` array) to `claudeville/src/config/models.json`. Preserve first-match-wins ordering.
4. Run `npm run models:generate`.
5. Only for a new `modelClass` with bespoke rendering policy, update the exact identity/effort/equipment symbols listed in the checklist.
6. For a new sprite, follow [references/sprites.md](references/sprites.md). Otherwise reuse a manifest-backed `spriteId`.
7. Run `node scripts/models/resolve.mjs <provider> <model>` for every alias; each must exit zero and resolve to the intended row.
8. If `scripts/adapters/fixtures/<provider>/` exists, add the smallest fixture record proving the observed model string.
9. Add or adjust focused tests only when the registry completeness checks cannot express the new behavior. Run `node --check claudeville/adapters/<provider>.js` if the adapter changed.
10. Run `npm run test:unit` and `npm run validate:quick`. Run the sprite verification from `references/sprites.md` when applicable.
11. For a shipped change, describe identity, pricing source and revision, context window, aliases, reused/new sprite, and fallback behavior in `CHANGELOG.md`. Update version files only while preparing a push.

## Verification

- `npm run models:check`
- `node scripts/models/resolve.mjs <provider> <model>` for every alias
- `npm run test:unit`
- `npm run validate:quick`
- `git diff --check`

## Never

- Never edit `models.generated.js` or `models.generated.cjs` by hand, or recreate pricing tables in `TokenUsage.js`.
- Never open unrelated renderer files for an existing-sprite registry row.
- Never touch port 4000, start the maintained server, add a build step, or import `claudeville/vendor/*`.
