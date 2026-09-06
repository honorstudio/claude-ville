# ClaudeVille Building Style Contract

The visual and runtime contract for every World-mode building. Command Center is the land-material reference, Harbor is the water-contact reference, and Portal/Lighthouse are named structural-platform exceptions. Use this when writing generation prompts, defining grounding metadata, and reviewing a regenerated sprite.

## Craft rules (every building)

- **Projection:** true 2:1 dimetric isometric (~26.57°, 2px run : 1px rise). No flat/near-front elevations.
- **Outline:** 1px **selective** outline in warm near-black (`#060402`–`#040404`). Not pure black, not colored. External silhouette + major internal plane breaks only. No anti-aliasing.
- **Shading:** painterly, 3–4 tone steps per material, crisp cel transitions on edges. **Minimum ~35% lightness contrast** dark→light per material (no washed-out pastels).
- **Lighting:** single warm key from **upper-left**; cool shadow toward lower-right; faint magical rim-glow on landmarks.
- **Roof signature:** slate-blue tiled roof is the family motif. No terracotta-red, no sky-blue cartoon roofs.
- **Grounding (required):** land sprites contain structure, attached stairs, and true footings only. The static terrain cache owns grass, dirt, cobble aprons, district wear, and the road-to-threshold transition. A land sprite must not contain a complete ground tile, raised slab, plinth, retaining lip, closed dark perimeter, baked cast shadow, or generic square diamond.
- **Exceptions:** `intentional-dais`, `quay`, and `water-pilings` may remain structural parts of the sprite. They must have visible support, stairs/thresholds where applicable, and a localized terrain or water contact rather than a second generic platform.
- **Contact shadow:** structure-aware and tight to walls, posts, rock mass, towers, or pilings. Never size a shadow from the whole sprite canvas or flat apron.

## Palette ramps (sampled from gold trio + Portal/Mine)

| Ramp | Stops (dark → light) | Use |
|---|---|---|
| Cool grey stone | `#4C3A4C` · `#5C5A70` · `#837F86` · `#A9A6AC` | default walls |
| Slate-blue roof | `#215B7F` · `#3782B5` · `#3A86BA` | all roofs |
| Crimson banner | `#782331` · `#96201A` · `#A32B21` | banners / cloth |
| Gold trim | `#BA9668` · `#D79613` · `#E0A311` · `#EFC819` | trim / metal |
| Warm torch glow | `#D79613` · `#F89206` · `#FDE2AD` | fire / window light |
| Arcane violet | `#8149B2` · `#B241F0` · `#E39AFC` | Portal / arcane only |
| Cyan ore glow | `#1E6F86` · `#45DCA8` · `#C8FFF0` | Mine ore only |
| Terrain grass | `#355408` · `#456F03` · `#567A16` | terrain-owned edge intrusion |
| Terrain cobble | `#99776A` · `#A1795E` · `#E0A665` | terrain-owned path / apron |

Thematic palettes (Portal violet, Mine cyan ore, Harbor warm wood) are **allowed deviations** layered on the same craft rules — not separate art styles.

## Grounding profiles

Every type has one profile in `claudeville/src/config/buildingGrounding.js`, linked through `BuildingVisualRegistry`:

```js
grounding: {
    mode: 'terrain-apron' | 'intentional-dais' | 'quay' | 'water-pilings',
    material: 'civic-cobble' | 'knowledge-terrace' | 'workshop-yard' | 'mine-yard' | 'arcane-court',
    edgeTreatment: 'broken' | 'retained' | 'water-contact',
    shadow: 'structure-contact' | 'tower-cast' | 'none',
}
```

The logical footprint always comes from `BUILDING_DEFS`. Do not duplicate it in the manifest. Every manifest building entry must declare native `width`, `height`, and `anchor`; split sprites also declare `horizonY`. A `structureMask` is reserved as a migration tool for preserving legacy upper pixels while removing an old baked site slab at load time. The nine current landmark sprites are native structure-only art and do not use one.

## Size tiers (footprint-driven; all ≤400px → single-image generation)

Rule of thumb: **sprite width ≈ 1.2 × iso-diamond width** = `1.2 · (w+h) · 32` (TILE_WIDTH=64), height by archetype.

| Tier | Buildings | Target W × H |
|---|---|---|
| Hero hall | command, archive, harbor, observatory, portal | ~310–346 × ~210–230 |
| Standard structure (4×3) | forge, mine, taskboard | ~256–268 × ~220–240 |
| Tower (narrow, tall) | watchtower | ~280 × ~370 |

## Generation recipe

- Tool: REST `create-image-pixflux` or MCP `create_map_object` (≤400px, transparent BG). Smoke-test the tool per building; prefer whichever yields true iso + painterly (pixflux produced Archive/Harbor).
- Params (not in the description): `view: low top-down`, `outline: selective outline`, `shading: detailed shading`, `detail: high detail`, transparent background.
- Description for `terrain-apron`: prepend the manifest `style.anchor`; add subject identity, palette cues, silhouette intent, "true wall/post/rock footings and attached steps only", and "transparent ground around the structure". Explicitly forbid ground tile, lawn, slab, plinth, retaining lip, complete perimeter, and baked shadow.
- Description for a structural exception: name the physical platform (`dais`, `quay`, `deck/pilings`), its support, and its terrain/water transition. Still forbid a larger generic ground tile.
- After generation: place at `assets/sprites/buildings/<id>/base.png`; declare native dimensions and an explicit anchor; recalibrate `horizonY`, emitters, lights, overlays, windows, pennants, and ritual anchors; bump `style.assetVersion`.

## Reference order

Harbor (`water-pilings`) · Command (`terrain-apron`) · Portal (`intentional-dais`) · Lighthouse (`quay`). Archive, Task Board, Forge, Mine, and Observatory were regenerated as native structure-only sprites in the 2026-08-25 landmark pass; preserve their recognizable silhouettes and authored material channels in future revisions.
