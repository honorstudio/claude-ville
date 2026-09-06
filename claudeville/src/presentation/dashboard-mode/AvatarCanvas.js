/**
 * Mini character avatar canvas for the dashboard
 * Static recreation of AgentSprite drawing logic
 */
import { getModelVisualIdentity, providerPaletteKey } from '../shared/ModelVisualIdentity.js';
import { getTeamColor } from '../shared/TeamColor.js';
import { Compositor } from '../character-mode/Compositor.js';

let SPRITE_METADATA_PROMISE = null;
let SPRITE_ASSET_VERSION = '2026-04-26-visual-revamp'; // overwritten asynchronously on first load
// Portrait entries resolved from the manifest: spriteId -> { crop, bust }.
let PORTRAIT_ENTRIES = new Map();
const AVATAR_CANVASES = new Set();

function normalizeCrop(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x);
    const y = Number(raw.y);
    const w = Number(raw.w);
    const h = Number(raw.h);
    if (![x, y, w, h].every(Number.isInteger)) return null;
    if (x < 0 || y < 0 || w <= 0 || h <= 0) return null;
    return { x, y, w, h };
}

async function yamlParser() {
    if (globalThis.jsyaml?.load) return globalThis.jsyaml;
    await import('../../../vendor/js-yaml.min.js');
    return globalThis.jsyaml?.load ? globalThis.jsyaml : null;
}

// One manifest read serves both the asset version (cache-busting) and the
// per-character portrait metadata (2.6). A parse failure still yields the
// asset version, so avatars never lose their cache key over portrait data.
function loadSpriteMetadata() {
    if (!SPRITE_METADATA_PROMISE) {
        SPRITE_METADATA_PROMISE = (async () => {
            let text = '';
            try {
                text = await fetch('assets/sprites/manifest.yaml').then(r => r.text());
            } catch {
                return { assetVersion: 'unknown', portraits: new Map() };
            }
            const portraits = new Map();
            let assetVersion = null;
            try {
                const manifest = (await yamlParser())?.load(text);
                assetVersion = manifest?.style?.assetVersion || null;
                for (const entry of manifest?.characters || []) {
                    if (!entry?.id) continue;
                    const crop = normalizeCrop(entry.portraitCrop);
                    const bust = typeof entry.portrait === 'string' && entry.portrait ? entry.portrait : null;
                    if (crop || bust) portraits.set(entry.id, { crop, bust });
                }
            } catch {
                // Manifest shape or parser unavailable: portraits stay empty
                // and every avatar keeps its full-body rendering.
            }
            if (!assetVersion) {
                const m = text.match(/^\s*assetVersion:\s*"([^"]+)"/m);
                assetVersion = m ? m[1] : 'unknown';
            }
            return { assetVersion, portraits };
        })();
    }
    return SPRITE_METADATA_PROMISE;
}

loadSpriteMetadata().then(({ assetVersion, portraits }) => {
    const previousVersion = SPRITE_ASSET_VERSION;
    SPRITE_ASSET_VERSION = assetVersion;
    PORTRAIT_ENTRIES = portraits;
    for (const avatar of AVATAR_CANVASES) {
        avatar._onSpriteMetadataLoaded(previousVersion !== assetVersion);
    }
});

// Portrait source for one sprite, from the manifest: a generated 64 px bust
// (`portrait`) wins over the authored head-and-shoulders crop
// (`portraitCrop`, cell-local pixels of the composed south idle frame).
// Neither present means this character has no portrait and keeps the
// full-body avatar.
function portraitSourceFor(spriteId) {
    const entry = PORTRAIT_ENTRIES.get(spriteId);
    return { crop: entry?.crop || null, bust: entry?.bust || null };
}

const SPRITE_IMAGE_CACHE = new Map();

function loadSpriteImage(spriteId) {
    const key = `${spriteId}|${SPRITE_ASSET_VERSION}`;
    const cached = SPRITE_IMAGE_CACHE.get(key);
    if (cached) return cached;

    const image = new Image();
    const record = {
        image,
        loaded: false,
        failed: false,
        promise: null,
    };
    record.promise = new Promise((resolve) => {
        image.onload = () => {
            record.loaded = true;
            resolve(record);
        };
        image.onerror = () => {
            record.failed = true;
            resolve(record);
        };
    });
    image.src = `assets/sprites/characters/${spriteId}/sheet.png?v=${SPRITE_ASSET_VERSION}`;
    SPRITE_IMAGE_CACHE.set(key, record);
    return record;
}

// Generated portrait busts (manifest `portrait` path, relative to the sprite
// root), cached per path and asset version like the sheets above.
function loadPortraitImage(relativePath) {
    const key = `portrait|${relativePath}|${SPRITE_ASSET_VERSION}`;
    const cached = SPRITE_IMAGE_CACHE.get(key);
    if (cached) return cached;

    const image = new Image();
    const record = { image, loaded: false, failed: false, promise: null };
    record.promise = new Promise((resolve) => {
        image.onload = () => {
            record.loaded = true;
            resolve(record);
        };
        image.onerror = () => {
            record.failed = true;
            resolve(record);
        };
    });
    image.src = `assets/sprites/${relativePath}?v=${SPRITE_ASSET_VERSION}`;
    SPRITE_IMAGE_CACHE.set(key, record);
    return record;
}

// Idle, south-facing frame row: matches SpriteSheet.js layout.
const IDLE_SOUTH_ROW = 6;

export function fitAvatarFrame(width, height, maxWidth, maxHeight, integer = false) {
    const fit = Math.min(maxWidth / Math.max(1, width), maxHeight / Math.max(1, height));
    const scale = integer && fit >= 1 ? Math.min(4, Math.floor(fit)) : fit;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Canvas box and the frame area the sprite is fitted into, per size.
const AVATAR_SIZES = Object.freeze({
    hero: { w: 96, h: 96, bodyW: 88, bodyH: 82, portraitW: 92, portraitH: 92 },
    card: { w: 44, h: 52, bodyW: 40, bodyH: 46, portraitW: 44, portraitH: 48 },
    // 2.6 — the full-body identity witness that stays beside the name when the
    // hero niche shows a head-and-shoulders portrait, so held weapons and
    // effort crowns are not erased by the crop.
    witness: { w: 26, h: 32, bodyW: 24, bodyH: 29, portraitW: 0, portraitH: 0 },
});

export class AvatarCanvas {
    // size: 'card' (44x52 dashboard chip) | 'hero' (96x96 Activity Panel
    // portrait, #46) | 'witness' (26x32 full-body witness, always full body).
    constructor(agent, size = 'card') {
        this.agent = agent;
        this.size = AVATAR_SIZES[size] ? size : 'card';
        this.canvas = document.createElement('canvas');
        const dim = AVATAR_SIZES[this.size];
        this.canvas.width = dim.w;
        this.canvas.height = dim.h;
        this.canvas.style.width = `${dim.w}px`;
        this.canvas.style.height = `${dim.h}px`;
        this.canvas.style.imageRendering = 'pixelated';
        this.spriteImage = null;
        this.spriteId = null;
        this.spriteAssetVersion = null;
        this.spriteFailed = false;
        // 2.6 — last painted identity signature; repeated draw() calls from the
        // 1 Hz panel refresh repaint nothing while the signature holds.
        this._paintedKey = null;
        this._portrait = false;
        this._districtValue = null;
        AVATAR_CANVASES.add(this);
        // 1.7 — redraw once the world's shared Compositor registers (avatars
        // can be created before the world renderer boots); the composited
        // path replaces the raw-sheet fallback on the next draw.
        this._unsubscribeSharedCompositor = Compositor.onSharedAvailable(() => {
            if (AVATAR_CANVASES.has(this)) this.redraw();
        });
        this.draw();
    }

    // True when the last paint was a head-and-shoulders portrait (crop or
    // bust) rather than the full body. The Activity Panel mounts its witness
    // on this.
    isPortrait() {
        return this._portrait;
    }

    // Force the next draw to repaint even if the identity signature is
    // unchanged (asset arrival, asset version change).
    redraw() {
        this._paintedKey = null;
        this.draw();
    }

    draw() {
        const ctx = this.canvas.getContext('2d');
        const w = this.canvas.width;
        const h = this.canvas.height;
        const app = this.agent.appearance;
        const identity = getModelVisualIdentity(this.agent.model, this.agent.effort, this.agent.provider);
        const trim = identity.trim?.[0] || app.shirt;
        const accent = identity.accent?.[0] || app.skin;

        const key = this._renderKey(identity, app);
        if (this._paintedKey !== null && this._paintedKey === key) return;
        this._paintedKey = key;

        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = false;
        this._portrait = false;

        if (this._drawGeneratedSprite(ctx, identity, accent)) {
            return;
        }

        ctx.save();
        ctx.translate(w / 2, h / 2 + 4);

        // Scale up for visibility
        const scale = 1.3;
        ctx.scale(scale, scale);

        // Legs
        ctx.strokeStyle = app.pants;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-3, 8);
        ctx.lineTo(-4, 16);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(3, 8);
        ctx.lineTo(4, 16);
        ctx.stroke();

        // Body
        ctx.fillStyle = identity.family === 'codex' || identity.family === 'claude' || identity.family === 'kimi' || identity.family === 'deepseek' || identity.family === 'zai' ? trim : app.shirt;
        ctx.fillRect(-5, -2, 10, 12);
        this._drawModelInsignia(ctx, identity, accent, trim);

        // Arms
        ctx.strokeStyle = app.skin;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(-8, 7);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.lineTo(8, 7);
        ctx.stroke();

        // Head
        ctx.fillStyle = app.skin;
        ctx.beginPath();
        ctx.arc(0, -6, 5, 0, Math.PI * 2);
        ctx.fill();

        // Hair
        ctx.fillStyle = app.hair;
        switch (app.hairStyle) {
            case 'short':
                ctx.beginPath();
                ctx.arc(0, -8, 5, Math.PI, 0);
                ctx.fill();
                break;
            case 'long':
                ctx.beginPath();
                ctx.arc(0, -8, 5, Math.PI, 0);
                ctx.fill();
                ctx.fillRect(-5, -8, 2, 8);
                ctx.fillRect(3, -8, 2, 8);
                break;
            case 'spiky':
                ctx.beginPath();
                ctx.moveTo(-4, -8);
                ctx.lineTo(-2, -14);
                ctx.lineTo(0, -9);
                ctx.lineTo(2, -14);
                ctx.lineTo(4, -8);
                ctx.fill();
                break;
            case 'mohawk':
                ctx.fillRect(-1, -14, 2, 6);
                break;
        }

        // Eyes
        ctx.fillStyle = '#000';
        switch (app.eyeStyle) {
            case 'normal':
                ctx.fillRect(-3, -7, 2, 2);
                ctx.fillRect(1, -7, 2, 2);
                break;
            case 'happy':
                ctx.lineWidth = 0.8;
                ctx.strokeStyle = '#000';
                ctx.beginPath();
                ctx.arc(-2, -6, 1.5, 0, Math.PI);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(2, -6, 1.5, 0, Math.PI);
                ctx.stroke();
                break;
            case 'determined':
                ctx.fillRect(-3, -7, 2, 1.5);
                ctx.fillRect(1, -7, 2, 1.5);
                break;
            case 'sleepy':
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(-3, -6);
                ctx.lineTo(-1, -6);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(1, -6);
                ctx.lineTo(3, -6);
                ctx.stroke();
                break;
        }

        this._drawModelHeadgear(ctx, identity, accent, trim, app);

        ctx.restore();
    }

    _drawGeneratedSprite(ctx, identity, accent) {
        const spriteId = identity.spriteId;
        if (!spriteId || this.spriteFailed) return false;
        if (this._drawPortrait(ctx, identity, accent, spriteId)) {
            this._portrait = true;
            return true;
        }
        const source = this._avatarSheetSource(identity, spriteId);
        if (!source) return false;

        const sourceWidth = source.image.naturalWidth || source.image.width;
        const cellSize = Math.floor(sourceWidth / 8);
        if (!Number.isFinite(cellSize) || cellSize <= 0) return false;
        const bounds = this._spriteFrameBounds(source, cellSize, IDLE_SOUTH_ROW);
        const sourceW = bounds.maxX - bounds.minX + 1;
        const sourceH = bounds.maxY - bounds.minY + 1;
        const hero = this.size === 'hero';
        const box = AVATAR_SIZES[this.size];
        const { width: targetW, height: targetH } = fitAvatarFrame(
            sourceW, sourceH, box.bodyW, box.bodyH, hero,
        );
        const dx = Math.round((this.canvas.width - targetW) / 2);
        const groundPad = hero ? 8 : 3;
        const dy = Math.round(this.canvas.height - targetH - groundPad);

        ctx.save();
        // Warm-tinted ground shadow so the avatar sits in the parchment niche
        // behind it (village house style, #20) rather than on a cold black dab.
        const ellipseRx = hero ? 24 : Math.round(box.bodyW * 0.35);
        const ellipseRy = hero ? 6 : 4;
        const ellipseY = this.canvas.height - (hero ? 7 : 5);
        // 4.4 — district ground tint: the card stamps --cv-building-rgb (#30),
        // so the avatar stands on its district's color beneath the warm shadow.
        // Read once per draw by the render key; reused here.
        const districtRgb = this._districtValue;
        if (districtRgb) {
            ctx.fillStyle = `rgba(${districtRgb}, 0.22)`;
            ctx.beginPath();
            ctx.ellipse(this.canvas.width / 2, ellipseY, ellipseRx + 2.5, ellipseRy + 1.5, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.fillStyle = 'rgba(20, 12, 6, 0.34)';
        ctx.beginPath();
        ctx.ellipse(this.canvas.width / 2, ellipseY, ellipseRx, ellipseRy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.drawImage(
            source.image,
            bounds.minX,
            IDLE_SOUTH_ROW * cellSize + bounds.minY,
            sourceW,
            sourceH,
            dx,
            dy,
            targetW,
            targetH
        );
        if (this.size !== 'witness') this._drawEffortCrest(ctx, identity, accent);
        ctx.restore();
        return true;
    }

    // 2.6 — head-and-shoulders portrait: a generated 64 px bust when the
    // manifest carries one, else the authored crop of the composed south idle
    // frame at integer enlargement. The crop is taken from the accessory-free
    // composite so a runtime effort crown can never be sliced in half — the
    // crown stays on the full-body witness and the corner crest states the
    // tier. Returns false whenever no portrait metadata resolves, which
    // leaves the full-body avatar exactly as it was.
    _drawPortrait(ctx, identity, accent, spriteId) {
        const box = AVATAR_SIZES[this.size];
        if (!box.portraitW || !box.portraitH) return false;
        const { crop, bust } = portraitSourceFor(spriteId);

        const bustImage = bust ? this._bustImage(bust) : null;
        if (bustImage) {
            this._drawPortraitImage(ctx, bustImage, 0, 0, bustImage.naturalWidth, bustImage.naturalHeight, box);
            this._drawEffortCrest(ctx, identity, accent);
            return true;
        }
        if (!crop) return false;

        const source = this._avatarSheetSource(identity, spriteId, { accessory: false });
        if (!source) return false;
        const cellSize = Math.floor((source.image.naturalWidth || source.image.width) / 8);
        if (!Number.isFinite(cellSize) || cellSize <= 0) return false;
        // Crop metadata authored against a different cell size cannot be
        // trusted; fall back to the full body rather than blit garbage.
        if (crop.x + crop.w > cellSize || crop.y + crop.h > cellSize) return false;

        this._drawPortraitImage(
            ctx,
            source.image,
            crop.x,
            IDLE_SOUTH_ROW * cellSize + crop.y,
            crop.w,
            crop.h,
            box,
        );
        this._drawEffortCrest(ctx, identity, accent);
        return true;
    }

    _drawPortraitImage(ctx, image, sx, sy, sw, sh, box) {
        const { width: targetW, height: targetH } = fitAvatarFrame(sw, sh, box.portraitW, box.portraitH, true);
        const dx = Math.round((this.canvas.width - targetW) / 2);
        const dy = Math.round((this.canvas.height - targetH) / 2);
        ctx.save();
        ctx.drawImage(image, sx, sy, sw, sh, dx, dy, targetW, targetH);
        ctx.restore();
    }

    // Generated bust (manifest `portrait` path). Loaded once per path and
    // asset version through the shared image cache; the avatar repaints when
    // it arrives.
    _bustImage(path) {
        const record = loadPortraitImage(path);
        if (record.failed) return null;
        if (record.loaded || (record.image.complete && record.image.naturalWidth)) return record.image;
        record.promise.then(() => {
            if (AVATAR_CANVASES.has(this)) this.redraw();
        });
        return null;
    }

    // 1.7 — the avatar requests the exact composited bitmap the world draws
    // (palette variant + effort accessory + team trim) from the shared
    // Compositor, keyed identically, so World and Dashboard show the same
    // villager and share one cache. Falls back to the raw sheet image while
    // the compositor is unavailable (early boot) or missing the asset.
    _avatarSheetSource(identity, spriteId, { accessory: withAccessory = true } = {}) {
        const compositor = Compositor.shared();
        if (compositor) {
            const providerKey = providerPaletteKey(this.agent);
            const paletteKey = identity.paletteKey || providerKey;
            const accessory = withAccessory && identity.allowRuntimeEffortAccessory !== false
                ? (identity.effortAccessory || null)
                : null;
            const composited = compositor.spriteFor(
                spriteId,
                paletteKey,
                this._paletteVariant(providerKey),
                accessory,
                this._teamTrimAccent(),
            );
            if (composited) return { image: composited };
        }
        if (!this._ensureSpriteImage(spriteId)) return null;
        if (!this.spriteImage.complete || !this.spriteImage.naturalWidth) return null;
        return { image: this.spriteImage };
    }

    // Mirrors AgentSprite._hashVariant so the avatar lands on the same
    // Compositor cache entry the world uses.
    _paletteVariant(providerKey) {
        const text = `${this.agent?.id ?? ''}:${this.agent?.model || ''}:${providerKey}`;
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash) + text.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash) % 4;
    }

    // Mirrors AgentSprite._teamTrimAccent (team sash override, null solo).
    _teamTrimAccent() {
        const name = this.agent?.teamName;
        if (!name) return null;
        const accent = getTeamColor(name)?.accent;
        if (!accent || typeof accent !== 'string') return null;
        return /^#?[0-9a-fA-F]{6}$/.test(accent.trim()) ? accent.trim() : null;
    }

    // 4.4 — the dashboard card carries --cv-building-rgb (DashboardRenderer,
    // #30); read it at draw time so the niche ground wears the district hue.
    _districtRgb() {
        if (typeof getComputedStyle !== 'function' || !this.canvas.isConnected) return null;
        const value = getComputedStyle(this.canvas).getPropertyValue('--cv-building-rgb').trim();
        return /^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(value) ? value : null;
    }

    _ensureSpriteImage(spriteId) {
        if (this.spriteImage && this.spriteId === spriteId && this.spriteAssetVersion === SPRITE_ASSET_VERSION) return true;
        this.spriteId = spriteId;
        this.spriteAssetVersion = SPRITE_ASSET_VERSION;
        this.spriteFailed = false;
        const record = loadSpriteImage(spriteId);
        this.spriteImage = record.image;
        if (record.failed) {
            this.spriteFailed = true;
            return false;
        }
        if (record.loaded || (record.image.complete && record.image.naturalWidth)) return true;
        record.promise.then(() => this.redraw());
        return false;
    }

    // 2.6 — the manifest read supplies both the asset version and the portrait
    // metadata, so a resolved manifest always repaints: the portrait may have
    // just become available for this identity.
    _onSpriteMetadataLoaded(versionChanged) {
        if (versionChanged) {
            this.spriteImage = null;
            this.spriteFailed = false;
        }
        this.redraw();
    }

    // Everything the painted pixels depend on. Identical key means the canvas
    // already holds this exact avatar, so the 1 Hz panel refresh and the
    // dashboard's per-frame draw calls cost nothing.
    _renderKey(identity, appearance) {
        const app = appearance || {};
        const spriteId = identity.spriteId || '';
        const portrait = spriteId ? portraitSourceFor(spriteId) : { crop: null, bust: null };
        const crop = portrait.crop;
        // One style read per draw, shared with the ground-tint paint below.
        this._districtValue = this._districtRgb();
        return [
            this.size,
            SPRITE_ASSET_VERSION,
            spriteId,
            identity.paletteKey || '',
            identity.effortTier || '',
            identity.effortAccessory || '',
            identity.modelClass || '',
            this._paletteVariant(providerPaletteKey(this.agent)),
            this._teamTrimAccent() || '',
            this._districtValue || '',
            Compositor.shared() ? 'composited' : 'sheet',
            this.spriteFailed ? 'failed' : '',
            portrait.bust || '',
            crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : '',
            app.skin || '',
            app.shirt || '',
            app.pants || '',
            app.hair || '',
            app.hairStyle || '',
            app.eyeStyle || '',
            app.accessory || '',
        ].join('|');
    }

    // Content bounds of one sheet cell, cached on the source itself (the
    // Compositor's canvases and the raw Images are both long-lived, shared
    // objects — the Compositor uses the same __cv* stash convention).
    _spriteFrameBounds(source, cellSize, sourceRow) {
        const image = source.image;
        const cacheKey = `${cellSize}|${sourceRow}`;
        if (image.__cvAvatarBounds?.key === cacheKey) return image.__cvAvatarBounds.bounds;

        const scratch = document.createElement('canvas');
        scratch.width = cellSize;
        scratch.height = cellSize;
        const ctx = scratch.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, 0, sourceRow * cellSize, cellSize, cellSize, 0, 0, cellSize, cellSize);
        const data = ctx.getImageData(0, 0, cellSize, cellSize).data;
        let minX = cellSize;
        let minY = cellSize;
        let maxX = 0;
        let maxY = 0;
        for (let y = 0; y < cellSize; y++) {
            for (let x = 0; x < cellSize; x++) {
                const alpha = data[((cellSize * y + x) << 2) + 3];
                if (alpha <= 16) continue;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
        const bounds = (minX > maxX || minY > maxY)
            ? { minX: 0, minY: 0, maxX: cellSize - 1, maxY: cellSize - 1 }
            : {
                minX: Math.max(0, minX - 2),
                minY: Math.max(0, minY - 2),
                maxX: Math.min(cellSize - 1, maxX + 2),
                maxY: Math.min(cellSize - 1, maxY + 1),
            };
        image.__cvAvatarBounds = { key: cacheKey, bounds };
        return bounds;
    }

    _drawEffortCrest(ctx, identity, accent) {
        if (identity.showDashboardEffortCrest === false) return;
        if (!identity.effortTier || identity.effortTier === 'none') return;
        const cx = this.canvas.width - 9;
        const cy = 10;
        ctx.strokeStyle = '#120d09';
        ctx.fillStyle = accent;
        ctx.lineWidth = 2;
        if (identity.effortTier === 'xhigh' || identity.effortTier === 'max' || identity.effortTier === 'ultra') {
            ctx.beginPath();
            ctx.arc(cx, cy, 6, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1;
            ctx.strokeStyle = accent;
            ctx.stroke();
            if (identity.effortTier !== 'xhigh') {
                ctx.fillRect(cx - 1, cy - 1, 2, 2);
            }
            if (identity.effortTier === 'ultra') {
                ctx.beginPath();
                ctx.moveTo(cx, cy - 9);
                ctx.lineTo(cx, cy - 7);
                ctx.moveTo(cx - 9, cy);
                ctx.lineTo(cx - 7, cy);
                ctx.moveTo(cx + 7, cy);
                ctx.lineTo(cx + 9, cy);
                ctx.stroke();
            }
            return;
        }
        if (identity.effortTier === 'high') {
            ctx.beginPath();
            ctx.moveTo(cx - 5, cy + 4);
            ctx.lineTo(cx, cy - 6);
            ctx.lineTo(cx + 5, cy + 4);
            ctx.closePath();
            ctx.stroke();
            ctx.fill();
            return;
        }
        if (identity.effortTier === 'medium') {
            ctx.fillRect(cx - 5, cy - 1, 10, 3);
            return;
        }
        if (identity.effortTier === 'low') {
            ctx.fillRect(cx - 2, cy - 1, 4, 3);
        }
    }

    _drawModelInsignia(ctx, identity, accent, trim) {
        if (identity.modelClass === 'fable') {
            // four-point radiant star — mythic tier above the opus diamond
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, -3);
            ctx.lineTo(2, 2);
            ctx.lineTo(6, 3);
            ctx.lineTo(2, 4);
            ctx.lineTo(0, 9);
            ctx.lineTo(-2, 4);
            ctx.lineTo(-6, 3);
            ctx.lineTo(-2, 2);
            ctx.closePath();
            ctx.stroke();
            ctx.fillStyle = '#ffd6f0';
            ctx.fillRect(-1, 2, 2, 2);
            return;
        }

        if (identity.modelClass === 'opus') {
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, -2);
            ctx.lineTo(4, 3);
            ctx.lineTo(0, 9);
            ctx.lineTo(-4, 3);
            ctx.closePath();
            ctx.stroke();
            ctx.fillStyle = '#ffe7a8';
            ctx.fillRect(-1, 3, 2, 3);
            return;
        }

        if (identity.modelClass === 'sonnet') {
            ctx.fillStyle = accent;
            ctx.fillRect(-3, 0, 6, 2);
            ctx.strokeStyle = '#fff4cf';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-4, 7);
            ctx.lineTo(4, 1);
            ctx.stroke();
            return;
        }

        if (identity.modelClass === 'glm') {
            // filled hex sigil — GLM flagship
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(2.6, 1.5);
            ctx.lineTo(2.6, 4.5);
            ctx.lineTo(0, 6);
            ctx.lineTo(-2.6, 4.5);
            ctx.lineTo(-2.6, 1.5);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = trim;
            ctx.lineWidth = 1;
            ctx.stroke();
            return;
        }

        if (identity.modelClass === 'glm-flash') {
            // lightning bolt — flash tier
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(1, 0);
            ctx.lineTo(-2, 3);
            ctx.lineTo(0, 3);
            ctx.lineTo(-1, 6);
            ctx.lineTo(2, 3);
            ctx.lineTo(0, 3);
            ctx.closePath();
            ctx.fill();
            return;
        }

        if (identity.modelClass === 'haiku') {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(-3, 4);
            ctx.lineTo(3, 4);
            ctx.lineTo(0, 8);
            ctx.closePath();
            ctx.fill();
            return;
        }

        if (identity.modelClass === 'spark') {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(1, -1);
            ctx.lineTo(5, -1);
            ctx.lineTo(2, 3);
            ctx.lineTo(5, 3);
            ctx.lineTo(-1, 9);
            ctx.lineTo(1, 5);
            ctx.lineTo(-3, 5);
            ctx.closePath();
            ctx.fill();
            return;
        }

        if (identity.modelClass === 'gpt55') {
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(4, 4);
            ctx.lineTo(0, 8);
            ctx.lineTo(-4, 4);
            ctx.closePath();
            ctx.stroke();
            ctx.fillStyle = trim;
            ctx.fillRect(-1, 3, 2, 2);
            return;
        }

        if (identity.modelClass === 'gpt54') {
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(0, 4, 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = trim;
            ctx.fillRect(-1, 1, 2, 6);
            return;
        }

        if (identity.modelClass === 'gpt6astra') {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(0, -2);
            ctx.lineTo(2, 2);
            ctx.lineTo(6, 4);
            ctx.lineTo(2, 6);
            ctx.lineTo(0, 10);
            ctx.lineTo(-2, 6);
            ctx.lineTo(-6, 4);
            ctx.lineTo(-2, 2);
            ctx.closePath();
            ctx.fill();
            return;
        }

        if (identity.modelClass === 'gpt56sol') {
            // radiant sun disc — 5.6 flagship
            ctx.fillStyle = trim;
            ctx.beginPath();
            ctx.arc(0, 4, 2.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i < 8; i++) {
                const a = (Math.PI / 4) * i;
                ctx.moveTo(Math.cos(a) * 4, 4 + Math.sin(a) * 4);
                ctx.lineTo(Math.cos(a) * 6, 4 + Math.sin(a) * 6);
            }
            ctx.stroke();
            return;
        }

        if (identity.modelClass === 'gpt56terra') {
            // twin mountain peaks — earth sentinel
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-5, 8);
            ctx.lineTo(-2, 2);
            ctx.lineTo(0, 5);
            ctx.lineTo(2, 0);
            ctx.lineTo(5, 8);
            ctx.stroke();
            ctx.fillStyle = trim;
            ctx.fillRect(-1, 7, 2, 2);
            return;
        }

        if (identity.modelClass === 'gpt56luna') {
            // crescent moon — moonlit skirmisher
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.arc(0, 4, 4, Math.PI * 0.25, Math.PI * 1.75);
            ctx.arc(1.6, 4, 3, Math.PI * 1.75, Math.PI * 0.25, true);
            ctx.closePath();
            ctx.fill();
        }
    }

    _drawModelHeadgear(ctx, identity, accent, trim, app) {
        if (identity.effortTier === 'xhigh' || identity.effortTier === 'max' || identity.effortTier === 'ultra') {
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(0, -14, 6, 0, Math.PI * 2);
            ctx.stroke();
            if (identity.effortTier === 'ultra') {
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, -23);
                ctx.lineTo(0, -20);
                ctx.moveTo(-9, -14);
                ctx.lineTo(-6.5, -14);
                ctx.moveTo(6.5, -14);
                ctx.lineTo(9, -14);
                ctx.stroke();
            }
        } else if (identity.effortTier === 'high') {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(-5, -12);
            ctx.lineTo(0, -17);
            ctx.lineTo(5, -12);
            ctx.closePath();
            ctx.fill();
        } else if (identity.effortTier === 'medium') {
            ctx.fillStyle = trim;
            ctx.fillRect(-5, -13, 10, 2);
        } else if (identity.effortTier === 'low') {
            ctx.fillStyle = trim;
            ctx.fillRect(-2, -13, 4, 2);
        }

        if (identity.modelClass === 'haiku') {
            // small hooded cap, no brim — apprentice tier
            ctx.fillStyle = trim;
            ctx.beginPath();
            ctx.moveTo(-4, -10);
            ctx.lineTo(0, -13);
            ctx.lineTo(4, -10);
            ctx.lineTo(2, -7);
            ctx.lineTo(-2, -7);
            ctx.closePath();
            ctx.fill();
            return;
        }

        if (identity.family === 'claude') {
            ctx.fillStyle = trim;
            ctx.beginPath();
            ctx.moveTo(-6, -10);
            ctx.lineTo(0, -16);
            ctx.lineTo(6, -10);
            ctx.lineTo(3, -8);
            ctx.lineTo(-3, -8);
            ctx.closePath();
            ctx.fill();
            return;
        }

        if (identity.family === 'codex') {
            ctx.strokeStyle = '#182b31';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.rect(-4, -8, 3, 3);
            ctx.rect(1, -8, 3, 3);
            ctx.moveTo(-1, -6.5);
            ctx.lineTo(1, -6.5);
            ctx.stroke();
            return;
        }

        switch (app.accessory) {
            case 'crown':
                ctx.fillStyle = '#ffd700';
                ctx.fillRect(-4, -14, 8, 2);
                break;
            case 'hat':
                ctx.fillStyle = '#8b4513';
                ctx.fillRect(-6, -12, 12, 2);
                ctx.fillRect(-3, -16, 6, 4);
                break;
        }
    }

    /**
     * Effort-aura color for the hero portrait frame (#46): the agent's model
     * accent, escalating with reasoning effort tier. Falls back to gold.
     */
    auraColor() {
        const identity = getModelVisualIdentity(this.agent.model, this.agent.effort, this.agent.provider);
        const accent = identity.accent || [];
        const byTier = { low: 0, medium: 0, high: 1, xhigh: 2, max: 2, ultra: 2 };
        const idx = byTier[identity.effortTier] ?? 0;
        return accent[idx] || accent[0] || '#d6a951';
    }

    destroy() {
        this._unsubscribeSharedCompositor?.();
        this._unsubscribeSharedCompositor = null;
        AVATAR_CANVASES.delete(this);
    }
}
