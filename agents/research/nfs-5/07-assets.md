# ClaudeVille asset-pipeline performance investigation

## Executive summary

- Default World boot gates first paint on **242 logical loads / 241 unique URLs / 8,138,425 unique bytes (7.76 MiB)**: 154 base image loads (153 URLs), 81 sidecars, 4 atlas PNGs, one atlas JSON, and two YAML files.
- `AssetManager.load()` eagerly loads all 21 character sheets, independent of the 2–3 agents present; base character albedo alone is **4,095,314 bytes (3.91 MiB)**.
- Loads are broadly parallel (`Promise.all`), not 239 sequential requests. Only layers within a single building entry are sequential (three small overlays total).
- Cache busting is correct for every PNG and atlas JSON: `?v=2026-08-25-native-landmarks-v3` is appended. The manifest and palette YAML requests are unversioned and therefore do not receive the server's immutable policy.
- There is no `img.decode()` or `createImageBitmap`; `Image.onload` gates boot. Browser image decode is therefore part of the awaited load, with synchronous YAML parsing and building mask/outline work on the main thread.
- The checked-in validator reports **0 orphan PNGs, 0 duplicate art groups, 0 warnings**. Raw hashing finds only intentional identical material masks.
- Highest-value change: reveal terrain/buildings plus only active character profiles, then fetch a new profile on demand. Estimated Canvas boot falls from 5.22 MiB to roughly **1.55–2.14 MiB** for 2–3 agents.
- The 1.17 MiB world atlas is additive today: sources are loaded first and the atlas is loaded later for the GPU path, so atlasing currently increases boot bytes while reducing GPU draw texture switching.

## Measured asset inventory

Measurements use current checkout bytes (`stat`/`find`), not rounded `du` output. The sprite directory contains 239 PNG, 2 YAML, and 1 JSON: **242 files / 8,138,783 bytes (7.76 MiB)**. This differs from the supplied broader 8.4 MB inventory (which mentioned fonts/text); no WOFF2 or TXT exists under the scoped `claudeville/assets/sprites/` tree.

| Manifest group / boot phase | Entries | Requests | Bytes | MiB |
|---|---:|---:|---:|---:|
| Characters (base albedo) | 21 | 21 | 4,095,314 | 3.91 |
| Equipment | 7 | 7 | 36,612 | 0.03 |
| Accessories | 3 | 3 | 3,658 | <0.01 |
| Status overlays | 4 | 4 | 14,898 | 0.01 |
| Buildings, including 3 layers | 9 | 12 | 626,910 | 0.60 |
| Props | 52 | 52 (51 URLs) | 252,637 unique | 0.24 |
| Vegetation | 26 | 26 | 56,938 | 0.05 |
| Terrain | 6 | 6 | 177,109 | 0.17 |
| Bridges/docks | 4 | 4 | 93,057 | 0.09 |
| Atmosphere | 19 | 19 | 24,331 | 0.02 |
| **`load()` base PNG total** | **151 top-level entries** | **154 (153 URLs)** | **5,381,464 unique** | **5.13** |
| Manifest + palettes YAML | — | 2 | 92,911 | 0.09 |
| Material sidecars: characters | — | 57 | 849,497 | 0.81 |
| Material sidecars: buildings + terrain | — | 24 | 62,565 | 0.06 |
| World atlas (4 PNG channels) | 1 | 4 | 1,478,945 | 1.41 |
| Atlas JSON metadata | 1 | 1 | 273,064 | 0.26 |
| **Default World gated total** | — | **242 logical / 241 URLs** | **8,138,425 unique** | **7.76** |

The one 358-byte difference between the complete directory and the default unique-byte total is `_placeholder/checker-64.png`: it is requested only on an image failure. Two manifest IDs (`prop.gullFlight` and `prop.gullFlight.level`) deliberately load the same 695-byte URL, so logical load/byte sums double-count it while the browser can coalesce/cache the URL. Default World requests materials because `App.js:250-254` treats every URL except `?renderer=canvas` or `?postfx=0` as material-enabled. The supplied count of 268 KB for atlas JSON is confirmed as 273,064 bytes.

Sample compression check (`file` reports 8-bit RGBA, non-interlaced throughout):

| File | Dimensions | Disk bytes | Raw RGBA bytes | Disk/raw |
|---|---:|---:|---:|---:|
| `world-pilot.albedo.png` | 2048×2048 | 1,231,229 | 16,777,216 | 7.34% |
| `agent.codex.gpt56sol/sheet.png` | 736×920 | 283,775 | 2,708,480 | 10.48% |
| `agent.codex.base/sheet.png` | 736×920 | 121,301 | 2,708,480 | 4.48% |
| `building.archive/base.png` | 336×224 | 125,497 | 301,056 | 41.68% |
| `prop.duck.png` | 32×32 | 848 | 4,096 | 20.70% |

The large transparent pixel-art sheets compress to 4–10% of raw RGBA. Archive is less compressible but only 125 KB. There is no obvious multi-megabyte uncompressed PNG accident.

## Eager versus lazy findings

`AssetManager._flattenManifest()` concatenates every manifest category (`AssetManager.js:458-471`). `_decodeAssets()` then maps every cached entry into `_loadEntry()` (`AssetManager.js:383-391`). There is no world/session/profile argument and no filtering against active agents. Consequently **all 21 character sheets load on every World boot**, including profiles absent from the current village.

The structure permits lazy characters without a build system: `_entryById` already indexes the complete manifest (`AssetManager.js:383-385`), `_pathFor()` deterministically maps agent IDs (`AssetManager.js:668-681`), and `_loadEntry()` loads one entry (`AssetManager.js:499-537`). A public deduplicated `ensureEntry(id)` plus an initial required-ID set would fit the existing architecture. It must also load that character's optional companions when material mode is enabled and handle arrivals/profile changes before constructing or redrawing the agent.

Measured 2–3-agent estimates:

| Scenario | Gated bytes | Reduction vs current phase | Basis |
|---|---:|---:|---|
| Current Canvas/base boot | 5,474,375 unique bytes (5.22 MiB) | — | YAML + all base PNG URLs |
| Lazy characters, 2 present | about 1.55–1.78 MiB | about 3.44–3.67 MiB | non-character base + YAML + two sheets; observed sheets range 121–284 KB each |
| Lazy characters, 3 present | about 1.67–2.05 MiB | about 3.17–3.55 MiB | same, three sheets |
| Current default/material boot | 8,138,425 unique bytes (7.76 MiB) | — | all rows above |
| Lazy characters, default materials, 2–3 present | roughly 3.5–4.1 MiB | roughly 3.7–4.3 MiB | retains fixed atlas/non-character material cost; loads only present character albedo/sidecars |

The material estimate is necessarily profile-dependent: 19 characters have three individual sidecars, while the two atlas pilot characters use atlas channels. Mean base sheet size is 195,015 bytes; all 21 base sheets total 4,095,314 bytes and the 57 character sidecars add 849,497 bytes.

### Serialization and decode

- Manifest and palettes fetch together via `Promise.all` (`AssetManager.js:369-374`). YAML parsing is synchronous `jsyaml.load()` immediately afterward (`:376-380`). The 43,549-byte parser is a classic synchronous `<head>` script (`index.html:19`), and the two YAML inputs total 92,911 bytes.
- All 151 top-level manifest entries start concurrently via `Promise.all(entries.map(...))` (`AssetManager.js:388-392`). This is not a sequential loop.
- A building's non-base layers use `await` inside its own loop (`AssetManager.js:523-535`), so those layers are serial after that building base. Only command/watchtower/portal add one 64×64 overlay each; this is not a material bottleneck.
- Material sidecars and atlases start together and await `Promise.all` (`AssetManager.js:579-592`); the four channels inside an atlas also use `Promise.all` (`:643-665`). Atlas metadata must complete before its channel images begin (`:625-643`), one small serialization boundary.
- Both required and optional PNG loaders use `new Image()`, set `onload`, then assign a versioned `src` (`AssetManager.js:684-709`, `:714-754`). Repository-wide search finds no `img.decode()` or `createImageBitmap` in this pipeline. `onload` generally means the browser has decoded enough to expose dimensions/draw the image, so this is not “defer all decode until first draw”; however decode scheduling is browser-controlled rather than explicitly off-main-thread. Boot awaits it all. Main-thread synchronous post-load work includes building normalization/masking, alpha masks and outline baking (`:508-553`, `:783-817`, `:874-900`).

## Cache-busting verdict

**PNG/atlas caching is live and correct.** After parsing the manifest, `assetVersion` becomes `2026-08-25-native-landmarks-v3` (`manifest.yaml:1-2`; `AssetManager.js:382`). Required images assign `img.src = this._versionedPath(path)` at `AssetManager.js:753`; optional/material images do the same at `:708`; atlas JSON is versioned at `:629`. `_versionedPath()` appends `?v=<encoded version>` or `&v=` at `:757-760`. Paths themselves are constructed at `:668-681` (characters: `:671`, buildings: `:675`, etc.). Thus a character request is, for example, `assets/sprites/characters/agent.codex.gpt56sol/sheet.png?v=2026-08-25-native-landmarks-v3`, activating the stated immutable server policy.

Two exceptions are exact and limited: the initial manifest and palette calls use raw paths at `AssetManager.js:371-374`, before the version is known. They are not sprite/font image requests and total 92,911 bytes, but they do miss the query-dependent immutable caching policy. The synchronous `vendor/js-yaml.min.js` URL in `index.html:19` is also unversioned, but general module/static caching is outside this report's scope.

## Unused and duplicate asset list

### Unused/orphan assets

**None found.** `npm run sprites:validate` reports: `expected: 238`, `missing: 0`, `orphan PNGs: 0`, `allowlisted orphan PNGs: 0`, and `warnings: 0`. The expected count excludes `_placeholder/checker-64.png`, which is a live error fallback (`AssetManager.js:751`). The validator cross-references prop/vegetation/bridge/atmosphere IDs against literal and known generated references in `claudeville/src/**` (`manifest-validator.mjs:567-609`); it found no dead inventory. Direct filename-only `rg` would create false positives because runtime paths are deterministically generated from IDs.

### Exact duplicates

The validator reports **0 duplicate PNG art groups** and **0 allowlisted duplicate groups**. A raw SHA-256 pass over all PNGs found these exact duplicate semantic masks:

- Six identical empty emissive sheets: `agent.claude.base`, `agent.claude.haiku`, `agent.codex.gpt53spark`, `agent.codex.gpt54`, `agent.codex.gpt56luna`, `agent.kimi.base`.
- Two identical terrain material sheets: `terrain.cobble-square` and `terrain.grass-cobble`.
- Eight identical empty emissive/flat occluder sheets across `terrain.cobble-square`, `terrain.grass-cobble`, `terrain.grass-dirt`, and `terrain.grass-shore`.

These are intentional semantic defaults, not copied visible art. `manifest-validator.mjs:170-180` explicitly excludes material-channel PNGs because empty emissive and flat occluder data are expected. They are tiny in aggregate compared with character albedo/atlas costs; consolidating URLs would complicate the manifest convention for negligible gain.

## Atlas usage

The sole `world-pilot` atlas declares 18 reviewed IDs: two characters, nine buildings, two props, two terrain assets, and three atmosphere assets (`manifest.yaml:15-44`). It is therefore not only a world-tile atlas, but it is a **partial GPU pilot**, not a character-catalogue atlas. The remaining 19 character sheets stay separate.

More importantly, atlasing does not replace source loads at boot. `load()` first fetches every individual albedo; default boot then calls `loadMaterialAssets()` (`App.js:248-254`), which fetches the 1,231,229-byte atlas albedo plus its channels and JSON. The pilot improves GPU batching/texture selection but is additive in network bytes and decoded residency during boot.

Atlasing all characters could reduce 21 albedo requests to one or a few, and the existing deterministic `sprites:atlas-plan` / `sprites:atlas-bake` tooling supports hand-run committed atlases under the zero-build constraint. It would not reduce compressed bytes reliably, would create a very large decoded texture, and conflicts with the higher-value goal of fetching only 2–3 present profiles. Prefer per-profile lazy sheets; consider a character atlas only if measured request overhead remains material after lazy loading.

## Ranked remediations

| Rank | Remediation | Expected impact | Effort / risk | VISUAL CONSEQUENCE | Verification |
|---:|---|---|---|---|---|
| 1 | Load non-character essentials plus only active character IDs; add deduplicated on-demand profile loading for arrivals/changes. Include per-profile material sidecars. | Saves ~3.2–3.7 MiB base for 2–3 agents, plus most of 0.81 MiB character sidecars; removes 18–19 image requests from critical path. | Medium; race/error handling and renderer readiness are the main risks. | **No visual change after each profile is ready.** During a late arrival, either delay that agent briefly or show the existing checker/procedural placeholder; delaying is visually cleaner. | Cold-cache Network trace; assert absent profiles have no request; add/retarget an agent and confirm exactly one sheet (+ sidecars) loads before the correct animation appears; compare pixel captures after settled load. |
| 2 | Progressive reveal: paint terrain/buildings/props once essentials resolve, then add present agents as their sheets resolve; do not await optional catalogue/material work before creating renderer. | Converts dark-screen wait into an early inhabited-world scaffold; perceived improvement can be large even where total bytes remain. | Medium/high because current `App.js` loads renderer only after assets. | **Temporary visual change:** village appears empty or partially populated for a short interval; material lighting may “upgrade” after reveal unless kept behind an atomic readiness switch. Avoid checker flashes and geometry popping by reserving agents until ready. | Filmstrip with cache disabled and throttling; record first terrain paint, first correct agent, final visual; assert no checker frame and stable terrain/building positions. |
| 3 | Stop double-owning pilot source albedos and atlas albedo on critical path: either use atlas as the source for reviewed IDs when material/GPU mode is known, or defer atlas load until renderer capability/need is confirmed. | Up to 1.17 MiB atlas albedo plus overlapping individual-source bytes/residency; exact savings depend on chosen ownership. | Medium/high; atlas fallback, frame addressing, and Canvas/GPU parity are sensitive. | **Intended no visual change**, but wrong padding/frame/anchor selection can cause seams, bleeding, or shifted pixel art. Nearest sampling and current 2px padding must remain. | Run `sprites:atlas-plan`, `sprites:validate`, channel validation, then day/night visual diffs and per-direction character animation checks in Canvas and GPU modes. |
| 4 | Make manifest/palette cache keys immutable without a chicken-and-egg dependency (for example version the URLs from app version, or serve these specific files with validated caching). | At most 92,911 bytes/reload; low compared with PNG work. | Low/medium; stale-manifest mismatch risk if version discipline fails. | **No visual consequence** when correct; stale metadata could route to missing/wrong assets. | Reload twice, inspect request URLs/cache status, then bump test version and confirm both YAML files revalidate. |
| 5 | Measure explicit `img.decode()` and/or `createImageBitmap` in a prototype after critical-set reduction; do not assume it wins. | Potentially smoother/clearer decode scheduling; does not reduce transfer bytes. | Medium/high compatibility and lifetime changes; `ImageBitmap.close()` ownership required. | **No intended visual change**; bitmap/canvas color or alpha differences and premature close could blank sprites. | Performance trace decode tasks and first paint on supported browsers; pixel-diff representative sheets; verify suspend/dispose closes resources. |
| 6 | Only after profiling, losslessly optimize the few poorly compressing PNGs with a pinned hand-run tool and byte-for-byte pixel validation. | Likely modest; current big sheets already compress strongly. | Low/medium pipeline reproducibility risk. | **No visual consequence permitted.** Palette conversion, quantization, alpha changes, resampling, or lossy tools are unacceptable for this pixel art. | Decode old/new to RGBA and require identical dimensions and every pixel; run full sprite validator and visual diff. |

## Ruled out

- **“All 239 PNGs are sequential.”** False: top-level base and material loads are parallel. Three tiny building overlays are the only per-entry sequential image loads.
- **“Immutable sprite caching is dead code.”** False: all PNG and atlas JSON assignments go through `_versionedPath()`. Only the two YAML boot fetches are unversioned.
- **“Decode is postponed entirely until first draw.”** Not supported: boot awaits `Image.onload`, which normally follows image decode availability; there is simply no explicit decode API/off-thread bitmap conversion.
- **“Delete unused AI leftovers.”** No current evidence: the manifest validator reports no orphan files or unreferenced checked families.
- **“Deduplicate visible sprite copies.”** No exact visible-art duplicates exist. Identical hashes are deliberate blank/flat semantic channel masks.
- **“Re-encode everything for the obvious win.”** Ruled out as first-line work: representative character/atlas PNGs are 4–10% of raw RGBA, and re-encoding carries pixel/alpha risk for less benefit than lazy selection.
- **“Atlas all characters to solve boot.”** Request count would fall, but it would force transfer/decode of absent profiles and undermine the strongest optimization. The existing partial atlas is already additive at boot.
