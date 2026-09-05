# PixelLab Reference

## When to read this

- You are picking a PixelLab tool to bake or edit a sprite and the choice is not obvious.
- You hit a parameter enum (`outline`, `shading`, `detail`, `view`, `isometric_tile_shape`, `tile_type`) and need the valid values.
- You see an unfamiliar HTTP status (423, 429) or an unexpected ZIP layout and need to know what's normal.
- You need to know whether a capability lives in the MCP server or only in the REST API.

For the complete character workflow and tactical validation commands, use [`scripts/sprites/generate.md`](../scripts/sprites/generate.md). This document is only the PixelLab API, lifecycle, and pitfalls reference.

## Subscription budget

Verified 2026-09-05: **Tier 1 (Pixel Apprentice)**, **2,000 generations per month**, **1,403 remaining**, resetting September 9. This is a dated observation, not a standing allowance. Before **any** bake, check `GET https://api.pixellab.ai/v2/balance` (the sprite planner does this read-only) and price the intended direction jobs. Never assume credit fallback or a higher subscription tier.

Character production identity is recorded in optional manifest `provenance` (`characterId`, `animationGroupId`, `generationSize`, `generationMode`), never credentials. Named `animationGroups` map inclusive base-sheet row ranges (`walk` 0–5, `breathingIdle` 6–9); explicit exported animation IDs select assembly inputs, not their frame counts. Unknown historical provenance stays absent. New action strips remain separate assets with their own named groups and provenance; see the character runbook.

Approximate cost per asset family (so an agent can sanity-check before kicking off a bulk bake):

| Operation | Cost |
| --- | --- |
| `create_character` standard mode (8 directions) | ~1 generation + ~8 for the rotation rig |
| `create_character` pro mode | 20–40 generations |
| `animate_character` template mode (per animation, full 8-direction rig) | 1 generation per direction, 8 total |
| `animate_character` v3 mode | `ceil(width * height * frames / 65536)` per direction, at verified source dimensions |
| `animate_character` pro mode | 20–40 generations per direction |
| `create_isometric_tile` | 1–2 generations |
| `create_tiles_pro` | 20 (small/medium) or 25 (larger sizes) |
| `create_topdown_tileset` / `create_sidescroller_tileset` | 16 tiles or 23 with full transition |
| `create_map_object` | 1 generation |
| REST `create-image-pixflux` | 1 generation |

A full ClaudeVille character revamp (6 characters × create + 2 animations) lands around 100 generations. A full sprite refresh including buildings, overlays, and terrain is well under 500.

## Authoritative external references

When the local doc is silent or stale, fetch directly. The official files are LLM-friendly and small.

| URL | Size | Use it for |
| --- | --- | --- |
| `https://www.pixellab.ai/llms.txt` | ~200 lines | First orientation; index of every doc page and tool. Rechecked 2026-04-29. |
| `https://www.pixellab.ai/llms-full.txt` | ~3,700 lines | Full prose for every tool when you need behavioral nuance. |
| `https://api.pixellab.ai/v2/llms.txt` | ~2,000 lines | Endpoint signatures, parameter shapes, status codes. Rechecked 2026-04-29. |
| `https://api.pixellab.ai/v2/openapi.json` | ~250 KB JSON | Machine-readable schema. The llms.txt enums sometimes truncate with `...`; OpenAPI is the source of truth. |
| `https://www.pixellab.ai/create-character` (browser) | n/a | Live `template_animation_id` dropdown when the documented enum is incomplete. |

Re-fetch when an MCP call returns an error you do not recognize, when a parameter set seems wrong, or when a capability you remember is not visible.

## MCP vs REST boundary

The PixelLab MCP server (configured via `claude mcp add --transport http pixellab https://api.pixellab.ai/mcp --header "Authorization: Bearer YOUR_TOKEN"`) exposes a curated **asset-creation** subset. ClaudeVille uses both surfaces.

**Available via MCP (`mcp__pixellab__*`):**

| Tool | Purpose | Canvas range |
| --- | --- | --- |
| `create_character` | 4- or 8-direction character | 16-128 px (`size`; pro mode returns frames at exactly that size) |
| `animate_character` | Animate an existing character (template / v3 / pro) | inherits character size |
| `create_isometric_tile` | Single isometric tile | 16-64 px (24+ recommended) |
| `create_map_object` | Transparent-BG prop | 32-400 px |
| `create_topdown_tileset` | Wang tileset for top-down terrain | 16 or 32 px tiles |
| `create_sidescroller_tileset` | Sidescroller platform tileset | 16 or 32 px tiles |
| `create_tiles_pro` | Multi-shape tile grid (hex / hex_pointy / isometric / octagon / square_topdown) | 16-256 px tiles |
| `get_*` / `list_*` / `delete_*` | One per asset family above | n/a |

**Only via REST (`https://api.pixellab.ai/v2/*`):**

- General image generation: `create-image-pixflux`, `create-image-pixen`, `create-image-bitforge`, `generate-image-v2`, `generate-with-style-v2`, `generate-ui-v2`
- Edit / inpaint: `inpaint-v3`, `inpaint`, `edit-image`, `edit-images-v2`, `edit-animation-v2`
- Rotate: `rotate`, `generate-8-rotations-v2`, `generate-8-rotations-v3`
- Animate (non-character): `animate-with-text`, `animate-with-text-v2`, `animate-with-text-v3`, `animate-with-skeleton`, `interpolation-v2`, `estimate-skeleton`
- Outfit / pose / image ops: `transfer-outfit-v2`, `try-on`, `multi-image`, `pose-to-image`, `re-pose`, `reshape`, `resize`, `remove-background`, `image-to-pixelart`, `image-to-image-depth`, `unzoom-pixelart`, `reduce-colors`
- Maps: `create-map`, `create-map-new`, `extend-map`, `extend-map-v2`, `create-large-image`, `create-texture`
- Other: `create-instant-character`, `create-ui-elements`, `create-ui-elements-pro`, `create-sl-image-pro`, `create-character-with-4-directions`, `create-character-with-8-directions` (the MCP `create_character` wraps these last two)

**Why ClaudeVille uses both:** MCP `create_isometric_tile` caps at 64 px. Hero buildings such as `building.watchtower` (400×300) need REST `create-image-pixflux`. Equipment and props that need transparent backgrounds up to 400 px should prefer MCP `create_map_object`. `scripts/sprites/generate-pixellab-revamp.mjs` calls REST directly and reads `PIXELLAB_API_TOKEN` or `PIXELLAB_AUTHORIZATION` from `.dev.vars`, but its bake list is still code-defined and only checked against the manifest. Run it only with an explicit, reviewed `--ids` list until it is fully manifest-driven.

## Tool catalog

Per-tool quick reference. Inputs list the most-used parameters, not every option. See `https://api.pixellab.ai/v2/llms.txt` for full parameter shapes.

### `create_character`

- Inputs: `description`, `name`, `size` (16-128; replaces the former `image_size` object, which the tool rejects since 2026-09), `n_directions` (4 or 8; pro is always 8), `view`, `outline`, `shading`, `detail`, `mode` (`standard` / `pro` / `v3`), `proportions`, `body_type` + `template` (`bear`/`cat`/`dog`/`horse`/`lion` for quadrupeds), `style_character_id` (pro only), `seed`.
- Output: `character_id` + URLs for the 4 or 8 rotation images. **Async.**
- Older exports padded the canvas ~40% around the requested size; pro mode (verified 2026-09-02) returns frames at exactly `generationSize`. `generate-character-mcp.mjs` centres either shape in the 92px cell.
- Generation size vs engine cell size: character manifest `generationSize` supplies `size` to `create_character`; `size: 92` in the manifest is the separate engine-cell contract read by `SpriteSheet.js`. A generation size below 92 leaves margin inside the cell for animation overshoot.
- Repo usage: ClaudeVille agent characters in `claudeville/assets/sprites/characters/agent.*/sheet.png`.

### `animate_character`

- Inputs: `character_id`, `template_animation_id` (template mode), `action_description` + `frame_count` (v3 mode), `mode` (`template` / `v3` / `pro`), `directions` (defaults to all character directions in template mode, south only in custom).
- Output: per-direction frame URLs attached to the character record. **Async.**
- Repo usage: walking + idle animations applied to each character; assembly handled by `scripts/sprites/generate-character-mcp.mjs`.

### `create_isometric_tile`

- Inputs: `description`, `image_size` (16-64 px), `isometric_tile_shape` (`thin tile` / `thick tile` / `block`, default `block`), `outline`, `shading`, `detail`, `init_image`, `init_image_strength`, `seed`.
- Output: tile image. **Async.**
- Repo usage: floor rings, status overlays, head accessories. Pass `thin tile` for icons; `block` clips small assets.

### `create_map_object`

- Inputs: `description`, `image_size` (32-400 px, max area 400×400 basic / 192×192 with inpainting), `view` (default `high top-down`), `outline`, `shading`, `detail`, `init_image`, `background_image` (style match), `inpainting`.
- Output: object image with transparent background. **Async.**
- Repo usage: runtime equipment under `claudeville/assets/sprites/equipment/` and any prop that exceeds 64 px and needs transparency.

### `create_topdown_tileset`

- Inputs: `lower_description`, `upper_description`, `transition_description`, `tile_size` (16 or 32), `transition_size` (0.0 / 0.25 / 0.5 / 0.75 / 1.0), `view` (`low top-down` / `high top-down`), `outline`, `shading`, `detail`, references for `lower`/`upper`/`transition`/`color`.
- Output: 16 tiles (no transition) or 23 tiles (full transition) as a Wang set. **Async.**
- Repo usage: terrain tilesets in `claudeville/assets/sprites/terrain/`.
- **Confirmed REST shape (2026-07-17, `scripts/sprites/pixellab-rest.mjs` `createTopdownTileset()`):** `POST /v2/create-tileset` → 202 `{tileset_id, background_job_id}`; poll `GET /tilesets/{tileset_id}` until 200. Response carries **16 individual 32×32 tiles** (`wang_0..15` with `corners` metadata, bit packing SE=1/SW=2/NE=4/NW=8) — no assembled sheet; stitch client-side (app cells are edge-mask indexed N=1/E=2/S=4/W=8; corner = OR of adjacent edges). `lower_reference_image`/`upper_reference_image` (`{type:'base64',...}`) strongly steers texture+hue and was the winning lever against off-family results (brick/mosaic motifs); water sets want detailed shading + "smooth continuous water surface" language. Driver: `scripts/sprites/bake-terrain.mjs` (cache-aware, `--force/--dry-run/--ids/--seed-offset`).

### `create_sidescroller_tileset`

- Same shape as topdown, plus `transition_description` describes a top decorative layer (moss, snow). No `upper_description`.
- Repo usage: not currently active.

### `create_tiles_pro`

- Inputs: `description`, `tile_type` (`hex` / `hex_pointy` / `isometric` / `octagon` / `square_topdown`), `tile_size` (16-256, default 32), `tile_height` (non-square), `tile_view` (or `tile_view_angle` 0-90 + `tile_depth_ratio` 0.0-1.0), `style_images` (1-4 reference tiles).
- Output: tile grid. **Async.** Cost 20-25 generations.
- Repo usage: not currently active. Use when terrain needs hex / octagon variants.

## Decision tree

You need to bake or edit X. Use this branching:

- **New character with directional walk + idle:** follow the canonical [Add One Character](../scripts/sprites/generate.md#add-one-character) procedure. Its manifest `generationSize` and optional `generationMode` are the request source of truth.
- **Building (single-image, ≤400 px):** MCP `create_map_object` (`view: low top-down`, `outline: selective outline`, `shading: detailed shading`, `detail: high detail`) per the building style contract (`docs/building-style-contract.md`); or REST `create-image-pixflux` via `scripts/sprites/generate-pixellab-revamp.mjs`. `create_map_object` downloads arrive flattened on grey — run `node scripts/sprites/key-out-bg.mjs <base.png>` to key out the background. `composeGrid` tile-slicing is retired; every building is one `base.png`.
- **Floor ring / status overlay (small isometric icon, transparent BG):** MCP `create_isometric_tile` size 32-64, `isometric_tile_shape: thin tile`. Use shape language in the description ("single-band ring", "triple-band").
- **Head accessory overlay (32 px, on top of head):** MCP `create_isometric_tile` size 32, `isometric_tile_shape: thin tile`. Differentiate with explicit shape words ("vertical pillar", "wreath", "halo") so overlays read distinctly at small size.
- **Terrain transition (Wang):** MCP `create_topdown_tileset` with `lower_description` + `upper_description` + optional `transition_description`. Pick `tile_size: 32` for 24+px legibility.
- **Multi-shape terrain set (hex, octagon, square at angle):** MCP `create_tiles_pro`. Use `tile_view_angle` for fine control.
- **Map concept image / freeform scene:** REST `create-image-pixflux` with `isometric: true`, `view: 'low top-down'`. Used in `generate-pixellab-revamp.mjs` for the town concept.
- **Equipment or prop with transparent BG, larger than 64 px:** MCP `create_map_object`.
- **Edit/inpaint an existing PNG:** REST only. Decide whether the cost of a one-off REST call is worth it vs. regenerating from scratch.

## Async / job lifecycle

Most MCP creation tools and several REST `v2/*` endpoints are asynchronous, but response status and wrapper shape vary by endpoint. Treat the official endpoint docs as the source of truth: some async endpoints return `202 Accepted`, others return `200` with a queued job ID, and some image endpoints return `200` with image data inline.

Common patterns:

- REST `create-image-pixflux` / `pixen` / `bitforge`: usually `200` with image data inline.
- Character creation and animation: persistent character or animation records; poll `get_character`, and use the ZIP export when all required animations are complete.
- MCP isometric tiles, map objects, tilesets, and tiles-pro: usually return an ID or job handle; poll the matching `get_*` tool until the image payload is ready.

Status codes:

- **200** — ready, payload available
- **202** — accepted, processing; poll the returned ID/job
- **423** — locked, still processing → poll again
- **429** — too many concurrent jobs → back off and retry
- **402** — insufficient subscription generations or credits for this operation; check `/v2/balance` and the operation's mode/cost before retrying. Do not assume credit fallback is funded.
- **422** — validation error (parameter shape wrong)
- **529** — rate limit exceeded (long-window cap, back off longer)

Poll cadence:

- Characters and full animation rigs: every 60s; full bake takes 5–10 min.
- Isometric tiles, map objects, single-image jobs: every 10–15s.

Character ZIP layout (verified 2026-04-27 in `scripts/sprites/generate-character-mcp.mjs`):

```
metadata.json
rotations/<dir>.png                                         (S × S, S = source canvas)
animations/animating-<uuid>/<dir>/frame_NNN.png             (S × S each)
```

`metadata.json` has a `frames.animations[<anim_id>][<dir>]` map of frame paths. Identify walk vs idle by frame count (6 frames = walk, 4 frames = idle in the current ClaudeVille rig).

## Parameter reference

Exact enums and ranges. Source: `https://api.pixellab.ai/v2/llms.txt` and the `docs/options/*` pages, verified 2026-04-27.

| Parameter | Values / range | Notes |
| --- | --- | --- |
| `outline` | `single color black outline` \| `single color outline` \| `selective outline` \| `lineless` | Strong as param; weak in description. |
| `shading` | `flat shading` \| `basic shading` \| `medium shading` \| `detailed shading` \| `highly detailed shading` | More shading = more colors used. |
| `detail` | `low detail` \| `medium detail` \| `high detail` (MCP tools) / `low detail` \| `medium detail` \| `highly detailed` (REST pixflux) | Enum split 422-verified 2026-07-17: REST `create-image-pixflux` **requires** `'highly detailed'`; the MCP tools take `'high detail'`. |
| `view` | `side` \| `low top-down` \| `high top-down` | ClaudeVille uses `low top-down`. |
| `tile_view` (tiles_pro) | `top-down` \| `high top-down` \| `low top-down` \| `side` | `top-down` = no depth, `low top-down` ≈ 30%. |
| `isometric_tile_shape` | `thin tile` (~15%) \| `thick tile` (~25%) \| `block` (~50%, default) | Floor rings and overlays need `thin tile`. |
| `tile_type` (tiles_pro) | `hex` \| `hex_pointy` \| `isometric` \| `octagon` \| `square_topdown` | Default `isometric`. |
| `transition_size` (tilesets) | 0.0 \| 0.25 \| 0.5 \| 0.75 \| 1.0 | 0.0 = no transition (16 tiles), 1.0 = full transition (23 tiles). |
| `text_guidance_scale` | 1.0 – 20.0, default 8.0 | Higher = more literal; over-saturation past ~12. |
| `init_image_strength` | 1 – 999 | 0–300 rough color, 300–400 rough shape, 400–600 medium, 600–900 detailed (use when refining nearly-finished art). |
| `seed` | integer; 0 = random | Reuse a seed to get a near-identical regeneration. |
| `no_background` | bool | Transparent output. Saying "transparent background" in the prompt is redundant. |
| `mode` (`create_character` 8-dir) | `standard` (1 gen) \| `pro` (20–40 gens) | Pro ignores outline/shading/detail/proportions/text_guidance_scale. |
| `mode` (`animate_character`) | `template` (1 gen/dir) \| `v3` (custom from `action_description`, `frame_count` 4–16) \| `pro` (20–40 gen/dir) | Auto-detected: template if `template_animation_id` provided, else v3. |
| `direction` (camera) | `north` \| `north-east` \| `east` \| `south-east` \| `south` \| `south-west` \| `west` \| `north-west` | Weak guidance; pair with init image for reliability. |

## Animation templates

Known `template_animation_id` values, confirmed across docs and repo as of 2026-04-27. The API documentation truncates the enum with `...`; for the complete current list, open `https://www.pixellab.ai/create-character` and read the animation dropdown.

| Group | Templates | ClaudeVille usage |
| --- | --- | --- |
| Idle | `breathing-idle` | active (rows 6–9 in character sheet) |
| Walk / run | `walking-4-frames`, `walking-6-frames`, `crouched-walking` | `walking-6-frames` active (rows 0–5) |
| Attack | `attack`, `attack-back`, `attack-left`, `attack-right`, `cross-punch` | unused |
| Reaction | `angry`, `bark` | unused |
| Acrobatic | `backflip` | unused |

`animate_character` modes:

- `template` — skeleton-based from `template_animation_id`, 1 generation per direction, fastest path. **Default for ClaudeVille.**
- `v3` — custom animation from `action_description` text + `frame_count` (4–16, even).
- `pro` — generates directions sequentially using completed sides as reference, 20–40 generations per direction, highest quality.

## Style anchor and prompt building

The `manifest.yaml` `style.anchor` field is the intended source of truth for generation prompt tone. Use it when making MCP calls manually or writing new generators, and do not duplicate its content into per-asset prompts.

`scripts/sprites/generate-pixellab-revamp.mjs` now reads `style.anchor` (and per-building subject-only prompts) directly from `manifest.yaml` — there is no longer a divergent hardcoded `STYLE` constant. Building specs are built from the manifest with target dims taken from the current on-disk `base.png`; all buildings are single-image (`composeGrid` is retired).

**Encode in the prompt (description):**

- Subject identity: who or what this is.
- Distinctive accessories or props.
- Color cues that must override the palette ("amber robe", not just "robe").
- Silhouette intent: "tall reads from far zoom", "square stocky stance".
- Negative cues only when the model has a known failure mode for that asset.

**Encode as parameters (do not also put in the description):**

- `outline`, `shading`, `detail` — strong when set as params, weak when in description.
- `view`, `direction`, `isometric` — same.
- `no_background` — sets transparency. Saying "transparent background" in the description is redundant.

Watch for redundancy: passing `view: 'low top-down'` together with `'low top-down isometric view'` in the description over-weights the cue and can saturate the result. Pick one channel for each concept.

Keep negative descriptions short and concrete: `"no text, no logo, no UI"` works; long lists of forbidden things can pull the model in unexpected directions.

## Pitfalls

1. **Character frames are not always padded.** Older `create_character` exports padded ~40% (a 64 px request returned ~90×90); pro mode now returns exactly the requested `size`. `generate-character-mcp.mjs` crops or pads to 92×92 accordingly. Do not substitute engine `size` for manifest `generationSize`; the fields have different contracts.
2. **Isometric tiles cap at 64 px.** Above 64 px you must use REST `create-image-pixflux` or MCP `create_map_object` (32–400 px, but not the isometric tile model).
3. **Tile sizes <24 px give weaker results** even though 16 is allowed. Prefer 32+ for production assets.
4. **`'highly detailed'` is mandatory for REST pixflux `detail`.** The pixflux endpoint 422s on `'high detail'` (verified 2026-07-17); the MCP tools use the shorter enum. `scripts/sprites/pixellab-rest.mjs` passes the pixflux-canonical string.
5. **Background bleed.** REST `create-image-pixflux` with `no_background: true` can return near-transparent gray pixels at edges. `generate-pixellab-revamp.mjs` handles this with `keyOutEdgeBackground` + `trimAlphaFringe`. Re-use that logic when writing new REST callers.
6. **MCP returns a job; REST `pixflux` returns the image.** Plan async polling for MCP and synchronous handling for REST. Don't mix patterns.
7. **`isometric_tile_shape` defaults to `block`.** That gives ~50% canvas height of "depth" and clips small icons. For overlays and floor rings, pass `thin tile` explicitly.
8. **Direction set must match across `create_character` and `animate_character`.** If create was 8-directional, animate must request the same 8 directions, or the sheet is incomplete.
9. **Cache busting / `assetVersion` policy.** Bump `style.assetVersion` in `manifest.yaml` only when PNGs on disk actually change. Manifest-only edits (prompts, `# NOTE:` comments, anchors, palette tweaks that don't touch images) must not bump it — every bump invalidates the browser cache for all sprites. Browsers cache aggressively; agents should never claim "the change is live" without confirming the version bump.
10. **Response wrapper shape varies.** The API standard wrapper is `{ success, data, error, usage }`, but some endpoints return image data at top level while others put it under `data`. `generate-pixellab-revamp.mjs` handles common variants in `pixflux()` with the fallback chain `json?.image || json?.data?.image || json?.images?.[0] || json?.data?.images?.[0]`. Re-use that pattern for new REST callers.

## Existing repo scripts

| Script | Path used | Authentication | When to invoke |
| --- | --- | --- | --- |
| `scripts/sprites/generate-pixellab-revamp.mjs` | REST `/v2/create-image-pixflux` | `.dev.vars` → `PIXELLAB_API_TOKEN` or `PIXELLAB_AUTHORIZATION` | Legacy/code-defined bake helper. It asserts selected IDs exist in `manifest.yaml`, but it does not read per-entry prompts, sizes, anchors, or tool fields. Use only with explicit reviewed `--ids`; do not run broadly until it becomes fully manifest-driven. |
| `scripts/sprites/bake-manifest.mjs` | REST `/v2/create-image-pixflux` | same | Manifest-driven bulk bake (prompt/dims/path from `manifest.yaml`, building-layer addressing via `building.<id>.<layer>`, raw cache in `output/pixellab-cache/bake/`). The supported rebake path for props/veg/overlays/layers/atmosphere. |
| `scripts/sprites/pixellab-rest.mjs` | shared module | same | Shared pixflux call + edge-background key-out + token read for bake scripts; do not copy/paste these into new scripts. |
| `scripts/sprites/contact-sheet.mjs` | None (filesystem) | n/a | One montage PNG per sprite family in `output/sprite-contact-sheets/` for bake-review evidence. |
| `scripts/sprites/rehue-flowercart.mjs` | None (filesystem) | n/a | Single-purpose hue-mask re-hue (plan 6.5 flowerCart body magenta → weathered oak). |
| `scripts/sprites/generate-character-mcp.mjs` | MCP ZIP assembly only (you call MCP first) | Inherits from MCP server (token in MCP config) | After `mcp__pixellab__create_character` + `animate_character` complete, to assemble into the 736×920 sheet. |
| `scripts/sprites/manifest-validator.mjs` | None (filesystem) | n/a | After any sprite change. `npm run sprites:validate`. Also warns on dimension drift, block-cube fill heuristics, and unreferenced ids. |

## Smoke recipes

### MCP isometric tile

```text
1. mcp__pixellab__create_isometric_tile(
     description="<style anchor>, <subject>",
     image_size={"width": 32, "height": 32},
     isometric_tile_shape="thin tile",
     outline="single color black outline",
     shading="medium shading",
     detail="high detail",
   )
   → returns tile_id
2. Poll mcp__pixellab__get_isometric_tile(tile_id) until ready (typically <30s)
3. curl --fail -o claudeville/assets/sprites/.../<id>.png "<image_url_from_response>"
4. file <path>   # confirm PNG dimensions
5. npm run sprites:validate
```

### MCP character bake

The copyable character recipe is maintained once in [Add One Character](../scripts/sprites/generate.md#add-one-character). This reference retains the parameter enums above and the async lifecycle details needed to diagnose MCP calls.

### REST pixflux

```bash
curl --fail -X POST https://api.pixellab.ai/v2/create-image-pixflux \
  -H "Authorization: Bearer $PIXELLAB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "<style anchor>, <subject>",
    "image_size": {"width": 96, "height": 96},
    "no_background": true,
    "isometric": true,
    "view": "low top-down",
    "outline": "single color black outline",
    "shading": "medium shading",
    "detail": "high detail",
    "seed": 12345
  }' | jq -r '.image.base64 // .data.image.base64' | base64 -d > out.png
```

For the full revamp script that handles edge-color cleanup and grid composition, see `scripts/sprites/generate-pixellab-revamp.mjs`.

## Known issues / TODO

- MCP `create_character` + `animate_character` polling is currently manual (call `get_character` every 60s). A small helper that polls and writes the ZIP path on completion would remove a tedious step from every character bake.
- ~~`generate-pixellab-revamp.mjs` and the MCP character path duplicate the style-anchor logic.~~ New bake scripts import the shared helpers in `scripts/sprites/pixellab-rest.mjs` (pixflux call, key-out, token read, anchor-prepend lives in `bake-manifest.mjs`). The legacy revamp script keeps its own copies intentionally.
- The `detail` enum for REST pixflux is 422-verified (2026-07-17): `low detail` / `medium detail` / **`highly detailed`** — the generic MCP docs' `high detail` is rejected by `create-image-pixflux`. `scripts/sprites/pixellab-rest.mjs` passes the canonical string.
- ~~No automated check that on-disk PNG dimensions match the manifest `size` field.~~ `manifest-validator.mjs` now warns on dimension drift, block-cube fill ratios, and unreferenced ids.

## Glossary

- **PixFlux** — primary text-to-image model, larger canvases up to 400×400, weak text-guidance.
- **BitForge** — small-medium image model (max 200 px) with style-transfer support.
- **Pixen** — newer image model, default `highly detailed` detail level (the only place that string is canonical).
- **Wang tileset** — 16- or 23-tile arrangement that connects in any direction. Output of `create_topdown_tileset` and `create_sidescroller_tileset`.
- **Dual-grid 15-tileset** — alternative tileset packing exposed by `create-tileset`.
- **Oblique projection** — non-isometric angled projection (Tibia-style); not used in ClaudeVille.
- **Isometric (PixelLab semantics)** — true isometric (120° axes); set `view: 'low top-down', isometric: true` for the ClaudeVille look.
- **Tier 1 / Pixel Apprentice** — verified 2026-09-05: 2,000 monthly generations, 1,403 remaining, resets September 9. Check `/v2/balance` before any bake.
