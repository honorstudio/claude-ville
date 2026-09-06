# Sprite / PixelLab workflow

**Status:** `ready` · read-only review · Codex `sol low` · session `01a062b9-10a4-71b2-8593-e81f5091a311` · 137s · 2026-09-02

Slice 6 of the six-part agentic-DX review. Consolidated into `agents/plans/claudeville-agentic-dx-plan.md`.

## Findings

1. The end-to-end character workflow exists, but is split across documentation, manifest comments, and scripts.

   Reconstructed procedure:

   1. Add the proposed `agent.*` manifest entry first; the assembler rejects unmanifested IDs (`scripts/sprites/generate-character-mcp.mjs:51-53`, `scripts/sprites/generate-character-mcp.mjs:126-135`).
   2. Build the prompt from `style.anchor` plus the entry’s subject prompt (`claudeville/assets/sprites/manifest.yaml:1-3`, `scripts/sprites/generate.md:67-72`). `sprites:plan -- --ids=<id>` previews the anchored prompt, dimensions, tool, and output path (`scripts/sprites/plan.mjs:27-45`).
   3. Call PixelLab MCP `create_character` with `description`, `name`, generation `image_size`, eight directions, low top-down view, rendering parameters, and mode (`docs/pixellab-reference.md:80-86`, `docs/pixellab-reference.md:282-295`).
   4. Call `animate_character` twice with `walking-6-frames` and `breathing-idle` (`docs/pixellab-reference.md:195-211`, `docs/pixellab-reference.md:296-303`).
   5. Poll `get_character` every 60 seconds until both animations reach 100%, then download the ZIP (`docs/pixellab-reference.md:138-161`, `docs/pixellab-reference.md:304-307`). This remains manual and is explicitly listed as a TODO (`docs/pixellab-reference.md:333-335`).
   6. Run `generate-character-mcp.mjs`. It identifies animations by frame count, requires all eight directions, center-crops every source frame to 92px, packs 8 columns × 10 rows, and writes the manifest-implied `sheet.png` (`scripts/sprites/generate-character-mcp.mjs:74-118`, `scripts/sprites/generate-character-mcp.mjs:138-159`).
   7. Runtime resolution is `assets/sprites/characters/<id>/sheet.png` (`claudeville/src/presentation/character-mode/AssetManager.js:860-873`). The resulting sheet must be 736×920 because runtime cells are 92px (`claudeville/src/presentation/character-mode/SpriteSheet.js:1-13`).
   8. Select or add `palette_layer`; only modify both palette blocks when adding/changing shared colors. Exact mirror parity is enforced (`claudeville/assets/sprites/manifest.yaml:538-565`, `claudeville/assets/sprites/palettes.yaml:1-26`, `scripts/sprites/manifest-validator.mjs:325-345`).
   9. Add semantic material/emissive/occluder metadata and optional sidecars. Character sidecars use names such as `sheet.material.png`; missing optional channels have deterministic defaults (`docs/material-channel-contract.md:102-120`). The roster authoring script generates channels from reviewed material and exact RGB selections (`scripts/sprites/author-roster-channels.mjs:24-50`, `scripts/sprites/author-roster-channels.mjs:90-115`).
   10. Run `sprites:audit-refresh`, channel validation/contact sheets when applicable, then visual review (`package.json:47-53`, `scripts/sprites/generate.md:107-141`).
   11. Bump `style.assetVersion` only after PNG bytes change; AssetManager appends it to image URLs (`scripts/sprites/generate.md:72-75`, `claudeville/src/presentation/character-mode/AssetManager.js:965-968`).

2. Generation size remains tacit per character and the docs contradict themselves.

   The authoritative explanation says manifest `size: 92` is the engine cell, while tall characters should be generated at 76px before PixelLab’s auto-padding and the 92px center crop (`docs/pixellab-reference.md:80-86`). Fable and GPT-5.6 encode that crucial history only in comments (`claudeville/assets/sprites/manifest.yaml:57-61`, `claudeville/assets/sprites/manifest.yaml:221-224`). Yet the decision tree and copyable MCP recipe instruct agents to generate at 92px (`docs/pixellab-reference.md:124-129`, `docs/pixellab-reference.md:282-294`). This makes clipping likely for the exact high-value sprites agents commonly add.

3. Post-processing is mostly scripted, but important artistic metadata is still manual.

   Crop/pad and sheet assembly are already deterministic through `pngjs` (`scripts/sprites/generate-character-mcp.mjs:86-118`, `scripts/sprites/generate-character-mcp.mjs:138-175`). Sidecar dimensions and material defaults can also be generated with `pngjs` (`scripts/sprites/author-roster-channels.mjs:90-119`). However, `paletteSource` colors are manually sampled and preserved in per-entry comments (`claudeville/assets/sprites/manifest.yaml:69-71`, `claudeville/assets/sprites/manifest.yaml:232-234`), while emissive RGB selections are manually duplicated in `PROFILES` (`scripts/sprites/author-roster-channels.mjs:24-50`). `pngjs` can automate color inventories and alpha-silhouette material/occluder output, but semantic choices—garment roles and genuinely glowing pixels—still require review.

4. Existing “visual diff” does not test character sprites.

   `capture-baseline.mjs` explicitly loads the `no-agents` scenario and captures only overview/building poses (`scripts/sprites/capture-baseline.mjs:26-38`, `scripts/sprites/capture-baseline.mjs:66-77`). `visual-diff.mjs` likewise constructs its matrix solely from buildings (`scripts/sprites/visual-diff.mjs:9-18`). Therefore the documented recommendation to run sprite visual diffs after character changes (`scripts/sprites/generate.md:182-191`) can pass without displaying the changed character.

5. Consistency coverage is uneven.

   - Manifest ↔ PNG bidirectional coverage exists: missing files and orphan PNGs are fatal (`scripts/sprites/manifest-validator.mjs:120-132`, `scripts/sprites/manifest-validator.mjs:163-164`).
   - Manifest ↔ palettes parity exists and is fatal (`scripts/sprites/manifest-validator.mjs:151-164`, `scripts/sprites/manifest-validator.mjs:325-330`).
   - Source sprite references ↔ manifest exists: the ID audit scans JS literals and approved dynamic patterns (`scripts/sprites/manifest-id-audit.mjs:7-26`, `scripts/sprites/manifest-id-audit.mjs:28-54`). This includes literal `ModelVisualIdentity.spriteId` values such as Fable and GPT-5.6 Sol (`claudeville/src/presentation/shared/ModelVisualIdentity.js:201`, `claudeville/src/presentation/shared/ModelVisualIdentity.js:326`).
   - `author-roster-channels` only checks that each hardcoded profile has a manifest entry; it does not enforce the reverse relationship (`scripts/sprites/author-roster-channels.mjs:52-80`). For example, its profile list includes Terra and Luna but not GPT-5.6 Sol (`scripts/sprites/author-roster-channels.mjs:26-45`), despite Sol declaring a required emissive geometry (`claudeville/assets/sprites/manifest.yaml:225-244`).
   - CI’s `validate:quick` runs only `sprites:audit-ids`, not the PNG/palette/sidecar validator (`package.json:44-49`). Asset drift can therefore merge unless a contributor independently runs the asset-specific command.

6. Canonicality is stated but diluted by overlap.

   `generate.md` declares itself the current manifest-first runbook and points to PixelLab reference material only for tool details (`scripts/sprites/generate.md:1-18`). `pixellab-reference.md` reciprocally directs tactical validation questions back to the runbook (`docs/pixellab-reference.md:3-10`), but then duplicates the complete character recipe (`docs/pixellab-reference.md:282-310`). `claudeville/CLAUDE.md` provides a useful short contract, though its generic “run `sprites:validate`” guidance omits ID auditing and character-specific visual limitations (`claudeville/CLAUDE.md:71-73`, `claudeville/CLAUDE.md:92-94`).

## Proposals

1. **Make character generation manifest-driven** — Impact high, effort M.

   Edit `manifest.yaml` character entries to add `generationSize` and, where needed, `generationMode`; update `plan.mjs`, `manifest-validator.mjs`, and `generate-character-mcp.mjs` to consume/validate them. Remove generation-size `NOTE` comments after migration.

   Acceptance: `sprites:plan -- --ids=agent.claude.fable` reports generation 76, engine cell 92, and sheet 736×920; malformed or absent character generation fields produce actionable validation errors. Risk: choosing defaults for older sprites may require reconstructing history.

2. **Create one canonical character runbook and skill** — Impact high, effort M.

   Keep the full procedure in `scripts/sprites/generate.md`, under a dedicated “Add one character” section. Reduce `docs/pixellab-reference.md` to API parameters/enums, lifecycle, and pitfalls; replace its copied recipe with a link. Keep `claudeville/CLAUDE.md` to the short invariant/checklist.

   Add `.claude/skills/sprite-character/SKILL.md` with inputs:

   - `sprite_id`, `provider`, subject/prompt fragments, `palette_key`
   - optional `generation_size`, `mode`, seed, material class, emissive colors

   The skill should:

   - add/verify the manifest entry and run `sprites:plan`;
   - call `create_character`, two `animate_character` calls, and `get_character` using the parameters documented at `docs/pixellab-reference.md:80-92`;
   - download the completed ZIP and call `generate-character-mcp.mjs`;
   - call a new channel/profile helper, then audits and character visual capture;
   - require an assetVersion bump after changed PNGs.

   Codex gets the same procedure through a short AGENTS.md pointer to the canonical runbook; PixelLab is already project-scoped in `.codex/config.toml:1-6`.

   Acceptance: a fresh agent can produce one 736×920 sheet using only the skill/runbook; all commands and expected outputs are explicit. Risk: MCP response wrappers may evolve.

3. **Add character-specific visual evidence** — Impact high, effort M.

   Add `scripts/sprites/capture-character-baseline.mjs` and `visual-diff-character.mjs`, or extend existing scripts with `--character=<id>`. Capture a deterministic simulated agent at all eight directions plus representative walk/idle frames.

   Acceptance: changing one character cell causes its character diff to fail; captures visibly include the requested ID. Risk: animation timing must be frozen deterministically.

4. **Close roster/channel consistency gaps** — Impact medium-high, effort S–M.

   Move reviewed channel profiles from the script into manifest entries, or add a validator that requires every character with `*Sidecar: true` or `sidecar-required` geometry to have a profile and current sidecars. Add `author-roster-channels --check` and `sprites:channels-validate` to `sprites:audit-refresh`.

   Acceptance: deleting Sol’s profile or sidecar fails with its manifest ID named. Risk: semantic emissive colors should remain human-reviewed, not luminance-derived.

5. **Strengthen CI asset validation** — Impact medium, effort S.

   Add `sprites:validate` to `validate:quick`, or create a dependency-aware CI sprite job. Preserve `sprites:audit-ids`.

   Acceptance: palette divergence, missing manifest PNG, or orphan PNG fails CI. Risk: CI must install existing dev dependencies (`pngjs`, `js-yaml`); no runtime dependencies are needed.

## Open questions

- Whether PixelLab MCP exposes a stable direct ZIP-download tool/URL suitable for fully automating the currently manual download step; the repo documents the returned URL but contains no MCP polling/downloader implementation (`docs/pixellab-reference.md:304-307`, `docs/pixellab-reference.md:333-335`).
- Whether all existing characters’ original generation sizes and seeds can be recovered; only selected entries retain generation history in manifest comments.
