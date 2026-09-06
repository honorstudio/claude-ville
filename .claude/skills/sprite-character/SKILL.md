---
name: sprite-character
description: Add or regenerate one manifest-backed ClaudeVille character through PixelLab MCP and the sprite scripts. Use for agent character sheets; never bulk-regenerates assets, invents emissive colors, or changes runtime rendering.
---

# Sprite Character

## When to use

Use for one new or regenerated `agent.*` sprite. Read the canonical [character runbook](../../../scripts/sprites/generate.md#add-one-character) and use [PixelLab reference](../../../docs/pixellab-reference.md) only for API enums, lifecycle, and pitfalls.

Mutation boundary: the selected character entry and PNGs, reviewed palette/channel metadata, and its `PROFILES` entry. PixelLab calls spend credits; confirm the requested character before calling them.

## Inputs

- Required: `sprite_id`, provider, subject/prompt fragments, `palette_key`.
- Optional: `generation_size`, `mode`, seed, material class, reviewed emissive colors.

## Steps

1. Add or verify the manifest entry, including engine `size: 92`, `generationSize`, optional `generationMode`, prompt, eight directions, animations, palette, anchor, and material metadata.
2. Run `node scripts/sprites/plan.mjs --ids=<sprite_id>` and stop if the prompt, generation size/mode, engine cell, sheet dimensions, or output path is wrong.
3. Call `mcp__pixellab__create_character` with `description`, `name`, `size` (not the retired `image_size` object), `n_directions`, `view`, `outline`, `shading`, `detail`, `mode`, and optional `seed`, using the values specified by the runbook.
4. Call `mcp__pixellab__animate_character` twice with `character_id`, `mode="template"`, `directions`, and `template_animation_id`: first `walking-6-frames`, then `breathing-idle`.
5. Poll `mcp__pixellab__get_character` with `character_id` every 60 seconds until both animations reach 100%; download the completed ZIP with `curl --fail`.
6. Run `node scripts/sprites/generate-character-mcp.mjs --id=<sprite_id> --zip=<path>`.
7. Add the reviewed channel profile when required, then run `node scripts/sprites/author-roster-channels.mjs` and `node scripts/sprites/author-roster-channels.mjs --check`.
8. Run `npm run sprites:audit-refresh` and `node scripts/sprites/contact-sheet.mjs --groups=characters`.
9. Inspect every direction and representative walk/idle frames. Bump `style.assetVersion` only if PNG bytes changed, then rerun `NODE_NO_WARNINGS=1 node scripts/sprites/manifest-validator.mjs`.

## Verification

- `file claudeville/assets/sprites/characters/<sprite_id>/sheet.png` reports 736x920.
- The plan reports the manifest generation size, 92px engine cell, and 736x920 expected sheet.
- Roster/channel checks pass and the character contact sheet has been reviewed.

## Never

- Never use engine `size` as a substitute for `generationSize`.
- Never create an unmanifested production ID, derive emissive colors from luminance, or run a broad bake.
- Never bump `assetVersion` for metadata-only changes.
