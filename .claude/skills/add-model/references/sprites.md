# Adding a model sprite

Follow the canonical [Add One Character](../../../../scripts/sprites/generate.md#add-one-character) procedure. This page is only the model-specific routing checklist.

1. Add an `agent.*` entry under `characters` in `claudeville/assets/sprites/manifest.yaml` before generation.
2. Set integer `generationSize` from 32 through 128; keep engine `size: 92`. Use the documented unverified default comment only when generation history is unknown.
3. Write the 736x920 PNG to `claudeville/assets/sprites/characters/<spriteId>/sheet.png`.
4. Set the registry row's `spriteId` to that exact manifest ID.
5. Bump manifest `style.assetVersion` only after PNG bytes change.
6. If `materialSidecar`, `emissiveSidecar`, or `occluderSidecar` is declared, add its required PNG. Add a profile in `scripts/sprites/author-roster-channels.mjs` only when that script authors the sidecars.
7. Edit both the manifest palette block and `claudeville/assets/sprites/palettes.yaml` only for a new or changed palette.
8. Change `atlases[].ids` and rebake atlas outputs only when intentionally enrolling the sprite in a reviewed atlas.

Verify with:

```bash
node scripts/sprites/plan.mjs --ids=<spriteId>
file claudeville/assets/sprites/characters/<spriteId>/sheet.png
npm run sprites:audit-refresh
node scripts/sprites/contact-sheet.mjs --groups=characters
```

Inspect every direction and representative walk/idle frames as required by the runbook.
