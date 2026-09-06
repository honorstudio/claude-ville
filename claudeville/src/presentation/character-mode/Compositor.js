import { clearDetachedCodexWrench } from './CodexEngineerGrips.js';
import { DEFAULT_CELL, DIRECTIONS, WALK_FRAMES, IDLE_FRAMES } from './SpriteSheet.js';

// Compositor produces per-agent character bitmaps by:
// 1. selecting a model/provider base sheet,
// 2. palette-swapping it using palettes.yaml,
// 3. compositing an allowed runtime effort/accessory overlay over the head pixels.
// Result is cached per (base sprite, paletteVariant, runtimeAccessory) tuple.

const CACHE_ENTRY_LIMIT = 24;
const CACHE_PIXEL_LIMIT = 12_500_000;

// Direction columns that show the back of the head — face-side accessory
// detail (goggle lenses, veil openings) must not appear here.
const BACK_DIRECTIONS = new Set(['n', 'ne', 'nw']);
// Small downward nudge so the stamp sits onto the crown, not hovering above it.
const ACCESSORY_TOP_INSET = 1;
const DEFAULT_BACK_CROP = 0.6;
// Per-accessory back-facing crop fraction: how much of the overlay's top rows
// to keep when drawing the back of the head. Face-side detail lives in the
// lower rows, so crop harder for lenses/veils. Empty today — the runtime set
// is effort crests only (plan 0.12 deleted the role hats); kept so future
// accessories can opt into a custom crop.
const ACCESSORY_BACK_CROP = {};

export class Compositor {
    // 1.7 — the world's compositor registers itself here so DOM-side consumers
    // (dashboard AvatarCanvas) can request the exact composited bitmap the
    // world draws (variant + accessory + team trim) and share its cache,
    // instead of re-loading raw sheet frames. Last-created wins; dispose()
    // releases the slot.
    static shared() {
        return Compositor._shared || null;
    }

    // Fires immediately when a shared compositor already exists, otherwise on
    // registration. Used by avatars created before the world renderer boots.
    static onSharedAvailable(cb) {
        if (typeof cb !== 'function') return () => {};
        if (Compositor._shared) {
            cb(Compositor._shared);
            return () => {};
        }
        Compositor._sharedListeners.push(cb);
        return () => {
            const index = Compositor._sharedListeners.indexOf(cb);
            if (index >= 0) Compositor._sharedListeners.splice(index, 1);
        };
    }

    constructor(assetManager) {
        this.assets = assetManager;
        this.cache = new Map();
        this.cachePixels = 0;
        Compositor._shared = this;
        for (const cb of Compositor._sharedListeners.splice(0)) cb(this);
    }

    spriteFor(baseSpriteId, paletteKey, paletteVariant, runtimeAccessory, teamTrim = null) {
        const baseId = baseSpriteId?.startsWith('agent.')
            ? baseSpriteId
            : `agent.${baseSpriteId || 'claude'}.base`;
        const palette = paletteKey || baseId.split('.')[1] || 'claude';
        // 4.14: include team trim accent in cache key so team-sashed sprites
        // cache independently from solo agents using the same palette variant.
        const teamHash = teamTrim ? String(teamTrim).toLowerCase() : '_';
        const variantKey = this._resolvedVariantKey(palette, paletteVariant, teamTrim);
        const key = `${baseId}|${palette}|${variantKey}|${runtimeAccessory ?? '_'}|${teamHash}`;
        if (this.cache.has(key)) {
            const cached = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, cached);
            return cached;
        }

        const baseImg = this.assets.get(baseId);
        if (!baseImg) return null;
        const dims = this.assets.getDims(baseId);
        // 0.5 — per-sheet sampled swap sources (manifest `paletteSource`) so
        // variants and team sashes recolor sheets whose generated garment hues
        // diverge from the palette family's first ramp color.
        const sheetSource = this.assets.getEntry?.(baseId)?.paletteSource || null;
        const canvas = document.createElement('canvas');
        canvas.width = dims.w;
        canvas.height = dims.h;
        // Composite-time pixel scans (palette swap, apex anchoring, contact
        // shadow) read this canvas back several times before caching.
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;

        ctx.drawImage(baseImg, 0, 0);
        // The detached tool must not become the head apex for effort crests.
        if (baseId === 'agent.codex.gpt54') clearDetachedCodexWrench(ctx, canvas.width, canvas.height);
        this._applyPaletteSwap(ctx, canvas.width, canvas.height, palette, paletteVariant, teamTrim, sheetSource);
        if (runtimeAccessory) this._compositeAccessory(ctx, baseId, runtimeAccessory, palette);

        this.cache.set(key, canvas);
        this.cachePixels += canvas.width * canvas.height;
        this._trimCache();
        return canvas;
    }

    // C2 action strips are authored in the character's base colours, so they
    // must pass through the same palette swap and head accessory as the base
    // sheet: an agent that starts reading keeps its robe, its team sash, and
    // its effort crest. Cached beside the base sheets under the same limits.
    stripFor(stripKey, stripImage, {
        baseSpriteId,
        paletteKey,
        paletteVariant,
        runtimeAccessory = null,
        teamTrim = null,
        cellSize = DEFAULT_CELL,
    } = {}) {
        if (!stripImage) return null;
        const baseId = baseSpriteId?.startsWith('agent.') ? baseSpriteId : `agent.${baseSpriteId || 'claude'}.base`;
        const palette = paletteKey || baseId.split('.')[1] || 'claude';
        const teamHash = teamTrim ? String(teamTrim).toLowerCase() : '_';
        const variantKey = this._resolvedVariantKey(palette, paletteVariant, teamTrim);
        const key = `strip|${stripKey}|${palette}|${variantKey}|${runtimeAccessory ?? '_'}|${teamHash}`;
        if (this.cache.has(key)) {
            const cached = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, cached);
            return cached;
        }
        const width = stripImage.naturalWidth || stripImage.width || 0;
        const height = stripImage.naturalHeight || stripImage.height || 0;
        if (!width || !height) return null;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(stripImage, 0, 0);
        const sheetSource = this.assets.getEntry?.(baseId)?.paletteSource || null;
        this._applyPaletteSwap(ctx, width, height, palette, paletteVariant, teamTrim, sheetSource);
        if (runtimeAccessory) {
            this._compositeAccessory(ctx, baseId, runtimeAccessory, palette, {
                dims: { w: width, h: height },
                rows: Math.floor(height / (cellSize || DEFAULT_CELL)),
                cellSize: cellSize || DEFAULT_CELL,
            });
        }
        this.cache.set(key, canvas);
        this.cachePixels += width * height;
        this._trimCache();
        return canvas;
    }

    _resolvedVariantKey(paletteKey, variant, teamTrim) {
        const palette = this.assets.palettes?.[paletteKey];
        if (!palette) return String(variant);
        const index = Math.max(0, Number(variant) || 0);
        const robe = palette.robe?.[index % Math.max(1, palette.robe.length)] || '_';
        const pants = palette.pants?.[index % Math.max(1, palette.pants.length)] || '_';
        const trim = parseTrimColor(teamTrim)
            ? String(teamTrim).toLowerCase()
            : (palette.trim?.[index % Math.max(1, palette.trim.length)] || '_');
        return `${robe},${pants},${trim}`;
    }

    _trimCache() {
        while (this.cache.size > CACHE_ENTRY_LIMIT || this.cachePixels > CACHE_PIXEL_LIMIT) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey == null) break;
            const oldest = this.cache.get(oldestKey);
            this.cache.delete(oldestKey);
            this.cachePixels -= (oldest?.width || 0) * (oldest?.height || 0);
        }
        this.cachePixels = Math.max(0, this.cachePixels);
    }

    cacheStats() {
        return {
            entries: this.cache.size,
            pixels: this.cachePixels,
            entryLimit: CACHE_ENTRY_LIMIT,
            pixelLimit: CACHE_PIXEL_LIMIT,
        };
    }

    releaseCache() {
        for (const canvas of this.cache.values()) {
            canvas.width = 0;
            canvas.height = 0;
        }
        this.cache.clear();
        this.cachePixels = 0;
    }

    dispose() {
        this.releaseCache();
        if (Compositor._shared === this) Compositor._shared = null;
    }

    _applyPaletteSwap(ctx, w, h, provider, variant, teamTrim = null, sheetSource = null) {
        const palette = this.assets.palettes[provider];
        if (!palette) return;
        const targetRobe = palette.robe[variant % palette.robe.length];
        const targetPants = palette.pants[variant % palette.pants.length];
        // 4.14: when teamTrim is supplied (rgb hex), override the variant-derived
        // trim color so the sash band reads as a team marker. Skip cleanly when
        // teamTrim is null/invalid — the >50% of solo agents see no change.
        const trimOverride = parseTrimColor(teamTrim);
        const targetTrim = trimOverride
            ? rgbToHex(trimOverride)
            : palette.trim[variant % palette.trim.length];
        // 0.5: sheet-sampled sources win over the palette family's first ramp
        // color (which only matches a handful of the generated sheets). Each
        // role may list up to two sampled garment families — painterly sheets
        // spread one garment across several hue buckets that ±12 misses.
        const sourceRobe = sourceList(sheetSource?.robe, palette.robe[0]);
        const sourcePants = sourceList(sheetSource?.pants, palette.pants[0]);
        const sourceTrim = sourceList(sheetSource?.trim, palette.trim[0]);

        const img = ctx.getImageData(0, 0, w, h);
        const data = img.data;
        const swap = [
            ...sourceRobe.map((src) => [hexToRgb(src), hexToRgb(targetRobe)]),
            ...sourcePants.map((src) => [hexToRgb(src), hexToRgb(targetPants)]),
            ...sourceTrim.map((src) => [hexToRgb(src), hexToRgb(targetTrim)]),
        ];
        // ΔE bucket: tolerate ±12 per channel so painterly anti-aliased pixels
        // also recolor. Without this tolerance, only fully-saturated marker
        // pixels swap and the result looks half-painted.
        const TOL = 12;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
            if (a < 16) continue;
            for (const [src, dst] of swap) {
                if (Math.abs(r - src[0]) <= TOL && Math.abs(g - src[1]) <= TOL && Math.abs(b - src[2]) <= TOL) {
                    data[i]   = Math.max(0, Math.min(255, dst[0] + (r - src[0])));
                    data[i+1] = Math.max(0, Math.min(255, dst[1] + (g - src[1])));
                    data[i+2] = Math.max(0, Math.min(255, dst[2] + (b - src[2])));
                    break;
                }
            }
        }
        ctx.putImageData(img, 0, 0);
    }

    // `grid` lets an action strip reuse the same head-apex anchoring on its own
    // row count; the base sheet passes nothing and keeps the 10-row layout.
    _compositeAccessory(ctx, baseId, accessory, paletteKey, grid = null) {
        const overlayId = accessory.startsWith?.('overlay.')
            ? accessory
            : `overlay.accessory.${accessory}`;
        const overlayImg = this.assets.get(overlayId);
        if (!overlayImg) return;
        const dims = grid?.dims || this.assets.getDims(baseId);
        const cellSize = grid?.cellSize || (dims.w / DIRECTIONS.length || DEFAULT_CELL);
        const rows = grid?.rows ?? (WALK_FRAMES + IDLE_FRAMES);
        const cols = DIRECTIONS.length;
        if (!Number.isInteger(cellSize) || !Number.isInteger(rows) || rows <= 0 || dims.h < rows * cellSize) return;

        const overlayDims = this.assets.getDims(overlayId);
        const [ax, ay] = this.assets.getAnchor(overlayId);
        const palette = this.assets.palettes?.[paletteKey];
        const { front, back, colBottom } = this._harmonizeOverlay(overlayImg, overlayDims, palette);
        const cropFrac = ACCESSORY_BACK_CROP[accessory] ?? DEFAULT_BACK_CROP;

        // Single composite-time read of the palette-swapped, accessory-free
        // sheet: locates each cell's head apex (D1), records accessory-free
        // content bounds for body draw-scale (D3), and paints the contact
        // shadow (D4) before the overlay is stamped on top.
        const sheet = ctx.getImageData(0, 0, dims.w, dims.h);
        const sdata = sheet.data;
        const width = dims.w;
        const baseBounds = new Map();
        const stamps = [];

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cellX = c * cellSize;
                const cellY = r * cellSize;
                const isBack = BACK_DIRECTIONS.has(DIRECTIONS[c]);
                const apex = this._cellHeadApex(sdata, width, cellX, cellY, cellSize);
                baseBounds.set(`${cellX},${cellY},${cellSize},${cellSize}`, apex.bounds);

                const anchorX = apex.found ? apex.centroidX : cellX + Math.floor(cellSize / 2);
                const anchorY = apex.found ? apex.topY + ACCESSORY_TOP_INSET : cellY + Math.floor(cellSize * 0.22);
                const stampX = Math.round(anchorX - ax);
                const stampY = Math.round(anchorY - ay);
                const cropH = isBack ? Math.max(1, Math.round(overlayDims.h * cropFrac)) : overlayDims.h;
                stamps.push({ cellX, cellY, stampX, stampY, isBack, cropH });

                // Contact shadow: multiply the ~2 body pixels beneath the
                // overlay's opaque bottom edge (per column) so the hat reads as
                // seated on the crown, not a floating sticker.
                const shadowShift = isBack ? 1 : 0;
                for (let ox = 0; ox < overlayDims.w; ox++) {
                    let bottom = colBottom[ox];
                    if (bottom < 0) continue;
                    if (isBack) bottom = Math.min(bottom, cropH - 1);
                    const px = stampX + ox;
                    if (px < cellX || px >= cellX + cellSize) continue;
                    const edgeY = stampY + bottom + shadowShift;
                    for (let k = 1; k <= 2; k++) {
                        const py = edgeY + k;
                        if (py < cellY || py >= cellY + cellSize) continue;
                        const idx = (py * width + px) * 4;
                        if (sdata[idx + 3] < 16) continue;
                        sdata[idx] = Math.round(sdata[idx] * 0.78);
                        sdata[idx + 1] = Math.round(sdata[idx + 1] * 0.78);
                        sdata[idx + 2] = Math.round(sdata[idx + 2] * 0.78);
                    }
                }
            }
        }
        ctx.putImageData(sheet, 0, 0);

        for (const s of stamps) {
            // Accessories may extend above their owner's cell. Clip each stamp
            // so those pixels cannot become the preceding frame's false feet.
            ctx.save();
            ctx.beginPath();
            ctx.rect(s.cellX, s.cellY, cellSize, cellSize);
            ctx.clip();
            if (s.isBack) {
                // Back of the head: top slice only, nudged +1px down and using
                // the darkened overlay so face-side detail stops showing (D5).
                ctx.drawImage(back, 0, 0, overlayDims.w, s.cropH, s.stampX, s.stampY + 1, overlayDims.w, s.cropH);
            } else {
                ctx.drawImage(front, s.stampX, s.stampY, overlayDims.w, overlayDims.h);
            }
            ctx.restore();
        }

        // Expose accessory-free per-cell content bounds so AgentSprite can scale
        // the body from hat-free measurements (D3). Cached on the canvas, which
        // is itself cached per (base, palette, accessory) tuple.
        ctx.canvas.__cvBaseBounds = baseBounds;
    }

    // Scans one cell of the accessory-free sheet: topmost opaque row, the
    // alpha-weighted centroid X of the top ~6 opaque rows (the head apex the
    // overlay anchors to), and the cell-local content bounds.
    _cellHeadApex(data, width, cellX, cellY, cellSize) {
        let topY = -1;
        let minX = cellSize;
        let minY = cellSize;
        let maxX = 0;
        let maxY = 0;
        let found = false;
        for (let y = 0; y < cellSize; y++) {
            let rowHas = false;
            const base = ((cellY + y) * width + cellX) * 4;
            for (let x = 0; x < cellSize; x++) {
                if (data[base + x * 4 + 3] < 16) continue;
                rowHas = true;
                found = true;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            if (rowHas && topY < 0) topY = y;
        }
        if (!found) {
            return { found: false, bounds: { minX: 24, minY: 12, maxX: cellSize - 24, maxY: cellSize - 18 } };
        }
        let sumA = 0;
        let sumAX = 0;
        const bandEnd = Math.min(cellSize, topY + 6);
        for (let y = topY; y < bandEnd; y++) {
            const base = ((cellY + y) * width + cellX) * 4;
            for (let x = 0; x < cellSize; x++) {
                const a = data[base + x * 4 + 3];
                if (a < 16) continue;
                sumA += a;
                sumAX += a * x;
            }
        }
        const localCx = sumA > 0 ? sumAX / sumA : (minX + maxX) / 2;
        return {
            found: true,
            topY: cellY + topY,
            centroidX: cellX + localCx,
            bounds: { minX, minY, maxX, maxY },
        };
    }

    // Builds the front and back (darkened) overlay canvases once per palette:
    // pre-tints the overlay ~0.25 toward the palette trim so hats harmonize
    // with the body (D4), and returns each column's opaque bottom row so the
    // caller can seat the contact shadow.
    _harmonizeOverlay(overlayImg, dims, palette) {
        const front = document.createElement('canvas');
        front.width = dims.w;
        front.height = dims.h;
        const fctx = front.getContext('2d', { willReadFrequently: true });
        fctx.imageSmoothingEnabled = false;
        fctx.drawImage(overlayImg, 0, 0);
        const trim = palette?.trim?.[0];
        if (trim) {
            fctx.globalCompositeOperation = 'color';
            fctx.globalAlpha = 0.25;
            fctx.fillStyle = trim;
            fctx.fillRect(0, 0, dims.w, dims.h);
            fctx.globalAlpha = 1;
            fctx.globalCompositeOperation = 'destination-in';
            fctx.drawImage(overlayImg, 0, 0);
            fctx.globalCompositeOperation = 'source-over';
        }

        const back = document.createElement('canvas');
        back.width = dims.w;
        back.height = dims.h;
        const bctx = back.getContext('2d');
        bctx.imageSmoothingEnabled = false;
        bctx.drawImage(front, 0, 0);
        bctx.globalCompositeOperation = 'source-atop';
        bctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
        bctx.fillRect(0, 0, dims.w, dims.h);
        bctx.globalCompositeOperation = 'source-over';

        const fdata = fctx.getImageData(0, 0, dims.w, dims.h).data;
        const colBottom = new Int16Array(dims.w).fill(-1);
        for (let x = 0; x < dims.w; x++) {
            for (let y = dims.h - 1; y >= 0; y--) {
                if (fdata[(y * dims.w + x) * 4 + 3] >= 16) {
                    colBottom[x] = y;
                    break;
                }
            }
        }
        return { front, back, colBottom };
    }
}

Compositor._shared = null;
Compositor._sharedListeners = [];

// 0.5 — normalize a manifest paletteSource role (string or short string list)
// to a source color list, falling back to the palette family's first color.
function sourceList(value, fallback) {
    const list = Array.isArray(value) ? value : [value];
    const valid = list.filter((v) => /^#[0-9a-fA-F]{6}$/.test(String(v || '')));
    return valid.length ? valid.slice(0, 3) : [fallback];
}

function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// 4.14: accept "#rrggbb" only (TeamColor accents are 7-char hex strings).
// Returns [r, g, b] or null if not recognized — callers then skip the override.
function parseTrimColor(value) {
    if (!value || typeof value !== 'string') return null;
    const text = value.trim().replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
    return [parseInt(text.slice(0, 2), 16), parseInt(text.slice(2, 4), 16), parseInt(text.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]) {
    const clamp = (v) => Math.max(0, Math.min(255, v | 0));
    return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b).toString(16).padStart(2, '0')}`;
}
