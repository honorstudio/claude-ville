// SpriteRenderer is the sole entry point for blitting pixel-art sprites.
// Enforces image-smoothing-off and integer-snapped destinations.

import {
    materialClassId,
    materialDebugDescriptor,
    normalizeMaterialMetadata,
} from './MaterialRegistry.js';

export class SpriteRenderer {
    constructor(assets) {
        this.assets = assets;
    }

    static disableSmoothing(ctx) {
        ctx.imageSmoothingEnabled = false;
        ctx.mozImageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
    }

    // Draw a sprite anchored at bottom-center of its footprint at world (wx, wy).
    drawSprite(ctx, id, wx, wy, opts = {}) {
        const img = opts.image || this.assets.get(id);
        if (!img) return;
        const dims = opts.dims || this.assets.getDims(id);
        const [ax, ay] = opts.anchor || this.assets.getAnchor(id);
        const dx = Math.round(wx - ax);
        const dy = Math.round(wy - ay);
        if (opts.alpha != null) {
            const prev = ctx.globalAlpha;
            ctx.globalAlpha = prev * opts.alpha;
            ctx.drawImage(img, dx, dy);
            ctx.globalAlpha = prev;
        } else {
            ctx.drawImage(img, dx, dy);
        }
        if (dims) {
            return { dx, dy, w: dims.w, h: dims.h };
        }
    }

    // Per-pixel hit test against a cached alpha mask.
    hitTest(id, mx, my, dx, dy) {
        const mask = this.assets.getMask(id);
        if (!mask) return false;
        const dims = this.assets.getDims(id);
        const lx = Math.floor(mx - dx);
        const ly = Math.floor(my - dy);
        if (lx < 0 || ly < 0 || lx >= dims.w || ly >= dims.h) return false;
        return mask[ly * dims.w + lx] === 1;
    }

    // Draw a 1-px outline using the pre-baked outline canvas from AssetManager.
    // Per Phase 2.5.3: edge detection moved to load time, this is now O(1) per call.
    drawOutline(ctx, id, wx, wy) {
        const outline = this.assets.getOutline(id);
        if (!outline) return;
        const [ax, ay] = this.assets.getAnchor(id);
        const dx = Math.round(wx - ax);
        const dy = Math.round(wy - ay);
        ctx.drawImage(outline, dx, dy);
    }

    // Optional debug/authoring helper. Missing sidecars are a normal state and
    // return false without drawing a placeholder checker.
    drawCompanion(ctx, id, channel, wx, wy, opts = {}) {
        const img = opts.image || this.assets.getCompanion?.(id, channel);
        if (!img) return false;
        const [ax, ay] = opts.anchor || this.assets.getAnchor(id);
        const dx = Math.round(wx - ax);
        const dy = Math.round(wy - ay);
        const source = normalizeRect(opts.sourceRect, img.width, img.height);
        SpriteRenderer.disableSmoothing(ctx);
        ctx.drawImage(
            img,
            source.x,
            source.y,
            source.w,
            source.h,
            dx + (opts.offsetX || 0),
            dy + (opts.offsetY || 0),
            source.w,
            source.h,
        );
        return true;
    }

    // Additive record builder for the future GPU-resident path. Canvas callers
    // do not pass through this method, so absent atlases/sidecars cannot change
    // current output or destination rounding.
    buildGpuRecord(id, wx, wy, opts = {}) {
        const dims = opts.dims || this.assets.getDims(id);
        if (!dims) return null;
        const [ax, ay] = opts.anchor || this.assets.getAnchor(id);
        const source = normalizeRect(opts.sourceRect, dims.w, dims.h);
        const destination = {
            x: Math.round(wx - ax) + (opts.offsetX || 0),
            y: Math.round(wy - ay) + (opts.offsetY || 0),
            w: source.w,
            h: source.h,
        };
        const entry = this.assets.getEntry?.(id) || { id };
        const material = normalizeMaterialMetadata(entry, opts.material || {});
        const atlasFrame = opts.atlasFrame
            || this.assets.getAtlasFrame?.(id, opts.frameKey)
            || material.atlasFrame;
        const channels = this.assets.getMaterialChannels?.(id) || {};
        const atlasSource = atlasFrame?.atlas
            ? this.assets.getAtlas?.(atlasFrame.atlas, 'albedo')
            : null;
        const image = atlasSource || opts.image || this.assets.get(id);
        if (!image) return null;
        const atlasRect = atlasSource && atlasFrame?.rect ? atlasFrame.rect : null;
        const atlasLocalSource = atlasRect && opts.frameKey
            ? { x: 0, y: 0, w: Math.min(source.w, atlasRect.w), h: Math.min(source.h, atlasRect.h) }
            : source;
        const sx = (atlasRect?.x || 0) + atlasLocalSource.x;
        const sy = (atlasRect?.y || 0) + atlasLocalSource.y;
        const materialSource = atlasSource
            ? this.assets.getAtlas?.(atlasFrame.atlas, 'material')
            : channels.material || null;
        return {
            type: 'sprite-quad',
            assetId: id,
            source: image,
            sourceRect: source,
            sourceWidth: image.width,
            sourceHeight: image.height,
            sx,
            sy,
            sw: atlasLocalSource.w,
            sh: atlasLocalSource.h,
            destination,
            x: destination.x,
            y: destination.y,
            width: destination.w,
            height: destination.h,
            anchor: [ax, ay],
            alpha: opts.alpha == null ? 1 : Number(opts.alpha),
            blendMode: opts.blendMode || 'source-over',
            blend: opts.blendMode === 'lighter' ? 'add' : 'normal',
            sampling: 'nearest',
            atlasFrame,
            materialId: material.materialId,
            materialClass: material.materialClass,
            material: materialClassId(material.materialClass),
            materialSource,
            textureKey: atlasFrame?.atlas || id,
            sidecarKey: materialSource ? `${atlasFrame?.atlas || id}:material` : '',
            elevation: opts.gpuElevation ?? (material.elevation.top > material.elevation.base ? 1 : 0),
            elevationRange: material.elevation,
            emissive: material.emissive.strength,
            emissiveMetadata: material.emissive,
            occluder: material.occluder.strength,
            occluderMetadata: material.occluder,
            channels,
            frameTag: opts.frameTag || null,
            textureRevision: this.assets.assetVersion || null,
            sidecarRevision: this.assets.assetVersion || null,
        };
    }

    buildGpuRecordForDrawable(drawable, context = {}) {
        const payload = drawable?.payload || {};
        const entry = payload.entry;
        if (entry?.id && Number.isFinite(payload.wx) && Number.isFinite(payload.wy)) {
            const dims = this.assets.getDims(entry.id);
            if (!dims) return null;
            let sourceRect = null;
            let offsetY = 0;
            if (drawable.kind === 'building-back') {
                sourceRect = { x: 0, y: 0, w: dims.w, h: payload.horizonY };
            } else if (drawable.kind === 'building-front') {
                sourceRect = {
                    x: 0,
                    y: payload.horizonY,
                    w: dims.w,
                    h: dims.h - payload.horizonY,
                };
                offsetY = payload.horizonY;
            }
            return this.buildGpuRecord(entry.id, payload.wx, payload.wy, {
                sourceRect,
                offsetY,
                material: drawable,
                frameKey: context.frameKey,
            });
        }

        const sprite = payload.sprite;
        if (sprite?.id && Number.isFinite(sprite.x) && Number.isFinite(sprite.y)) {
            return this.buildGpuRecord(sprite.id, sprite.x, sprite.y, {
                material: drawable,
                frameKey: context.frameKey,
            });
        }
        return null;
    }

    materialDebugRecord(id) {
        const entry = this.assets.getEntry?.(id) || { id };
        return materialDebugDescriptor(
            entry,
            this.assets.getMaterialChannels?.(id) || {},
        );
    }

}

function normalizeRect(value, width, height) {
    if (Array.isArray(value) && value.length === 4) {
        return rect(value[0], value[1], value[2], value[3], width, height);
    }
    if (value && typeof value === 'object') {
        return rect(value.x, value.y, value.w, value.h, width, height);
    }
    return { x: 0, y: 0, w: width, h: height };
}

function rect(x, y, w, h, width, height) {
    const rx = Math.max(0, Math.min(width, Math.floor(Number(x) || 0)));
    const ry = Math.max(0, Math.min(height, Math.floor(Number(y) || 0)));
    const rw = Math.max(0, Math.min(width - rx, Math.floor(Number(w) || 0)));
    const rh = Math.max(0, Math.min(height - ry, Math.floor(Number(h) || 0)));
    return { x: rx, y: ry, w: rw, h: rh };
}
