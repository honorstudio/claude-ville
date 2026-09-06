# Definitive model-change tracks

Choose one track. The canonical data change is always a row or default in `claudeville/src/config/models.json`, followed by `npm run models:generate`; never edit generated output directly.

## Existing sprite

Required files:

- `claudeville/src/config/models.json` — add one ordered model row; put all aliases in that row's `match` array.
- `claudeville/src/config/models.generated.js` — regenerated output.
- `claudeville/src/config/models.generated.cjs` — regenerated output.
- `scripts/adapters/fixtures/<provider>/...` — add the smallest observed-model fixture when that provider has a fixture directory.
- `CHANGELOG.md` — for a shipped release, record identity, pricing source/revision, context, aliases, sprite reuse, and fallback behavior.

Conditional files:

- `claudeville/adapters/<provider>.js` — only if the adapter does not preserve the observed model string.
- Focused `scripts/tests/*.test.mjs` — only for behavior not covered by registry completeness and resolver parity.
- `claudeville/src/presentation/shared/ModelVisualIdentity.js` — only for a new `modelClass` needing bespoke effort policy; update `EFFORT_ACCESSORIES`, `EFFORT_FLOOR_RINGS`, or related class-keyed tables.
- `claudeville/src/presentation/dashboard-mode/AvatarCanvas.js` — only when the new class needs a distinct procedural fallback in `_drawModelInsignia`.
- `claudeville/src/presentation/character-mode/AgentSprite.js` — only for new Codex equipment/class mapping (`CODEX_EQUIPMENT_BY_CLASS`, `CODEX_WEAPON_ASSETS`, and `_runtimeCodexEquipment`), baked-weapon cleanup, or tier-specific effects.

## New sprite

All existing-sprite files above, plus:

- `claudeville/assets/sprites/manifest.yaml` — add the `characters` entry and bump `style.assetVersion` only when PNG bytes change.
- `claudeville/assets/sprites/characters/<spriteId>/sheet.png` — required 736x920 character sheet.
- Optional declared sidecars beside `sheet.png`, `claudeville/assets/sprites/palettes.yaml`, `scripts/sprites/author-roster-channels.mjs`, and atlas outputs/config — only as described in [sprites.md](sprites.md).

## Pricing-only refresh

Required files:

- `claudeville/src/config/models.json` — update affected model pricing or provider `defaults`, and the registry revision.
- `claudeville/src/config/models.generated.js` — regenerated output.
- `claudeville/src/config/models.generated.cjs` — regenerated output.
- `docs/design-decisions.md` — update pricing rationale, source, and verification date.
- `docs/troubleshooting.md` — update the documented model list when it changes.
- `CHANGELOG.md` — for a shipped release, record affected rates, source, revision, and fallback behavior.

Conditional files:

- Focused `scripts/tests/*.test.mjs` whose assertions intentionally pin a rate or revision.
- `package.json` and `claudeville/index.html` only while preparing the versioned push.
