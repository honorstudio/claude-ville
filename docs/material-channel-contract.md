# Semantic Drawable, Material, and Atlas Contract

This contract prepares World mode for a GPU-resident renderer without changing
the current Canvas-2D result. Albedo PNGs remain authoritative. Material data,
sidecars, atlases, and GPU records are optional and use deterministic defaults.

## Runtime Invariants

- Canvas mode loads and draws the original albedo paths exactly as before.
- `AssetManager` only loads atlases and companion channels after an explicit
  `loadMaterialAssets()` call or `new AssetManager(path, { materialAssets: true })`.
- A missing optional sidecar or atlas never loads the checker placeholder.
- Albedo and every channel use nearest sampling. One authored albedo pixel stays
  one sampled renderer pixel at integer zoom tiers.
- Labels, bubbles, primary marks, and debug UI remain outside material grading.
- Material response is palette-stepped, not smooth PBR shading.

## Semantic Drawable Record

`DrawablePass.createDepthDrawable()` preserves the legacy `draw()` method and
adds the following fields:

```js
{
  kind,
  sortY,
  sortBand,
  stableKey,
  salience,       // primary | recent | working | ambient
  materialId,
  materialClass,
  elevation,
  emissive,
  occluder,
  atlasFrame,
  drawFallback(ctx, zoom, context),
  buildGpuRecord(context),
}
```

`draw` remains an alias of `drawFallback`; existing Canvas call sites do not
change. `buildGpuRecordsFromDrawables()` walks the already-sorted stream and
adds `drawOrder` without reordering painter semantics. Future batching may only
combine consecutive compatible records.

`summarizeDrawableLayers()` exposes counts by material plus GPU-ready,
emissive, and occluder counts for Shift-D integration. `AssetManager` exposes a
more detailed `materialDebugSnapshot()`; neither seam draws UI by itself.

## Material Vocabulary

Stable material classes, in numeric encoding order, are:

| Index | Class | Intended response |
| ---: | --- | --- |
| 0 | `unlit` | Safe default; albedo only |
| 1 | `stone` | Restrained key light, modest wetness |
| 2 | `timber` | Warm, low reflection |
| 3 | `metal` | Strong stepped key response |
| 4 | `foliage` | Wet receiving surface, low reflection |
| 5 | `fabric` | Soft response |
| 6 | `earth` | Matte, darkens when wet |
| 7 | `cobble` | Wet receiving surface |
| 8 | `water` | Reflection-eligible, non-occluding |
| 9 | `glass-rune` | Reflective and optionally emissive |
| 10 | `fire` | Semantic emission, no key-light response |

Append new classes; never reorder these indices. The authored key convention is
warm light from screen upper-left. The direct GPU renderer currently reaches two restrained material-wide response bands, `0.86 / 1.00`; it does not infer roof or wall normals.

## Manifest Fields

All fields are optional for ordinary assets:

```yaml
materialClass: stone
atlasFrame: { atlas: world-pilot, key: building.command }
elevation: { base: 0, top: 208, unit: sprite-px }
emissive:
  strength: 1
  sources:
    - { id: emissive.command.windows, kind: windows, geometry: registry.windowRects, strength: 0.72 }
occluder: { mode: alpha-silhouette, strength: 1, horizonY: 130 }

# Only add these after the companion PNG exists and was reviewed:
materialSidecar: true
emissiveSidecar: true
occluderSidecar: true
```

Every emissive source needs a stable semantic `id`. `BuildingVisualRegistry`
owns landmark geometry such as windows and effect anchors; light placement
remains under `LightSourceRegistry`/building light records.

### Companion Paths

`true` derives a companion path beside albedo:

| Albedo | Channel | Derived path |
| --- | --- | --- |
| `buildings/building.command/base.png` | emissive | `base.emissive.png` |
| `characters/agent.claude.opus/sheet.png` | material | `sheet.material.png` |
| `terrain/terrain.shore-shallow/sheet.png` | occluder | `sheet.occluder.png` |

A string value is an explicit path. Absent/false means “use generated defaults,”
not “load a missing file.” Sidecars must exactly match albedo dimensions and may
not extend alpha beyond albedo.

## Channel Encoding

The committed pilot atlas has identical rectangles and padding in every channel:

- `albedo`: original RGBA pixels.
- `material`: R = stable material-class index; G/B reserved; A = albedo alpha.
- `emissive`: authored RGB with A as contribution; transparent black by default.
- `occluder`: R = authored height (zero in the flat default), G = occlusion
  strength, B reserved, A = albedo alpha. `mode: none` is transparent.

The direct GPU renderer samples the occluder companion separately from the raw
material map. Material alpha also marks presence: opaque class zero is authored unlit, not the provider fallback. Nonzero occluder companion alpha explicitly marks authored geometry:
R (including zero) overrides default elevation; G overrides default occlusion
strength. Uncovered pixels use record defaults. Default strength is per vertex,
never a batch-wide height floor. Agent geometry follows the same atlas slots and
update cadence as albedo, including padded equipped Codex frames.

Generated emissive defaults come only from named semantic sources and existing
window/light anchors. The tooling does not infer emission from luminance.

Each frame has a two-pixel extruded gutter to prevent atlas bleeding. Runtime
sampling is still nearest; gutters protect edge texels when future passes sample
near frame boundaries.

## Frame Contracts

- Characters retain 8 directions (`s,se,e,ne,n,nw,w,sw`) and 10 rows: six
  `walk` frames followed by four `idle` frames. Atlas keys are
  `<id>/<animation>/<direction>/<frame>`.
- Terrain retains the 4x4 Wang layout. Keys are `<id>/wang/<mask>`.
- Building overlay layers use `<building-id>.<layer-name>`.
- Single sprites keep their stable manifest ID as the frame key.
- Metadata preserves source path/dimensions/hash, anchor, structure mask,
  material class, semantic tags, and deterministic pack order. It contains no
  timestamp, so unchanged inputs produce byte-stable JSON and PNGs.

## Action Strips (contract C2)

A character entry may declare one optional *action strip*: a separate PNG of
8 direction columns × N rows of the **same engine cell as the base sheet**
(92 px, same anchor and feet), holding authored poses the base sheet has no rows
for. The base sheet is never widened and never repurposed.

```yaml
actionStrip:
  path: characters/agent.claude.sonnet/actions.png   # sprites-root relative
  cell: 92
  groups:                                            # named, never identified by frame count
    read: { rows: [0, 3], hold: 3 }                  # hold = most legible static row
    wait: { rows: [4, 4], hold: 4 }                  # single held row
  grip: { hand: both, sheathe: true }                # right | left | both
  provenance: { characterId: <pixellab id>, animationGroupId: <id>, generationSize: 144 }
```

- Row ranges are inclusive, may not overlap, and must fall inside the PNG's real
  row count; `hold` must be a row of its own group. `provenance.generationSize`
  is the source rig's export canvas (16–256 px), which is what v3 animation is
  billed and assembled at — not the character entry's `generationSize` request.
- `SpriteSheet.resolveActionFrame(sheetMeta, group, direction, frame)` returns
  `{sx, sy, sw, sh}` or **null**; `frame` is group-relative and wraps, or the
  literal `'hold'`. `AssetManager.getActionStrip(id)` returns
  `{ image, meta, path, channels }` or **null**. Null on either seam means the
  caller keeps its existing procedural overlay, so a strip-less character renders
  byte-identically.
- Strips load lazily per demanded character through the existing character-demand
  path, after the base sheet is already drawable, and are priced in
  `cacheStats()` (`actionStrips`, `actionStripPixels`) like every other decoded
  image. A malformed or mis-sized strip is recorded as an optional load miss and
  left unloaded.
- Companion channels are optional and follow the ordinary sidecar rules against
  the *strip* path (`actions.material.png` …), driven by the character entry's
  existing `materialSidecar`/`emissiveSidecar`/`occluderSidecar` declarations.
  `node scripts/sprites/author-roster-channels.mjs` authors sheet and strip
  companions from the same reviewed colour classification; a companion whose
  dimensions disagree with the strip is refused.
- Production: `node scripts/sprites/generate-action-strip.mjs --ids=<id> --plan`
  quotes the live balance and per-direction generations; without `--plan` it
  requests one named v3 group at a time (Tier 1 allows 8 concurrent background
  jobs, and one 8-direction group fills them), assembles the strip, and records
  the manifest `actionStrip` block.

## Pilot

`world-pilot` covers 18 reviewed IDs: all nine landmarks; lantern, rune brazier,
and three light overlays; shallow/deep water transitions; one Claude class; and
one Codex class. Building overlay layers are included with their parent. No
individual sidecar PNG is required for the pilot.

## Tooling

```bash
# Review deterministic layout; writes nothing.
npm run sprites:atlas-plan -- --atlas=world-pilot

# Rebuild committed atlas channels and metadata from existing source PNGs.
npm run sprites:atlas-bake -- --atlas=world-pilot

# Validate schema, dimensions, anchors, hashes, alpha bounds, frame tags,
# matching rectangles, nearest gutters, and orphan/missing channels.
npm run sprites:channels-validate
npm run sprites:validate

# Produce output-only channel review sheets.
npm run sprites:channels-contact-sheet -- --atlas=world-pilot
```

Broad atlas membership is opt-in through the reviewed `atlases[].ids` list in
`manifest.yaml`. `atlas-bake` deliberately rejects an ad-hoc `--ids` override.

For a precise manual correction, paint explicit pixels or rectangles rather
than auto-thresholding luminance:

```bash
npm run sprites:sidecar-mask-fix -- \
  --id=building.command \
  --channel=emissive \
  --paint=rect:80:127:7:10:#ffd98aff \
  --dry-run
```

Remove `--dry-run` only after reviewing the target and then add the matching
`<channel>Sidecar: true` manifest opt-in. Re-bake, validate, and inspect the
channel contact sheet before committing a sidecar.
