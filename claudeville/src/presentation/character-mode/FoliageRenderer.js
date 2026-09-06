import { SpriteRenderer } from './SpriteRenderer.js';
import { canvasMapPixelCount, releaseCanvasMap } from './CanvasBudget.js';

// Owns fantasy-tree caches and foliage drawing. The host supplies only the
// live atmosphere and motion values shared with the world frame.
export class FoliageRenderer {
    constructor(host) {
        this.host = host;
        this.cache = new Map();
    }

    clear() {
        this.releaseCache();
    }

    releaseCache() {
        releaseCanvasMap(this.cache);
    }

    getRetainedPixels() {
        return canvasMapPixelCount(this.cache);
    }

    get cacheSize() {
        return this.cache.size;
    }

    fantasyTreePropBounds(tree) {
        const cached = this._getFantasyForestTreeCache(tree);
        return {
            left: -cached.anchorX,
            right: cached.canvas.width - cached.anchorX,
            top: -cached.anchorY,
            bottom: cached.canvas.height - cached.anchorY,
            splitY: -cached.anchorY + Math.round(cached.canvas.height * 0.58),
        };
    }

    // Deterministic per-tree phase for wind sway. Mixes tile position and
    // variant into [0, 2π) so neighbouring trees don't pulse in lockstep.
    windSwaySeed(tree) {
        const tx = Number(tree?.tileX) || 0;
        const ty = Number(tree?.tileY) || 0;
        const variant = Number(tree?.variant) || 0;
        const n = Math.sin(tx * 12.9898 + ty * 78.233 + variant * 7.131) * 43758.5453;
        return (n - Math.floor(n)) * Math.PI * 2;
    }

    // Apply a small horizontal offset to a tree drawFn based on the current
    // atmosphere wind. Clamped to ±2 px so pixel-art sprites do not shimmer;
    // skipped under reduced motion (motionScale === 0).
    withTreeSway(ctx, seed, drawFn, tileX = 0) {
        if (typeof drawFn !== 'function') return;
        const motionScale = this.host.motionScale ?? 1;
        const windX = Number(this.host._lastAtmosphere?.motion?.windX) || 0;
        if (motionScale <= 0 || windX === 0) {
            drawFn();
            return;
        }
        const t = (this.host.motionTimeMs || 0) * 0.001;
        // Spatially-phased gust envelope: wind crosses the forest in slow
        // travelling waves (tileX phase offset) so neighbouring canopies crest a
        // beat apart instead of swaying in lockstep. The whole sprite still moves
        // as one unit — the closure-based drawFn can't be cleanly split into
        // canopy vs trunk without doubling per-tree draw cost — so this stays the
        // gust-modulated whole-sprite fallback the motion budget prefers.
        const gust = 0.4 + 0.6 * Math.sin(t * 0.13 + tileX * 0.05);
        let dx = Math.sin(t + seed) * windX * 1.5 * gust;
        if (dx > 2) dx = 2;
        else if (dx < -2) dx = -2;
        const offset = Math.round(dx);
        if (offset === 0) {
            drawFn();
            return;
        }
        ctx.save();
        ctx.translate(offset, 0);
        drawFn();
        ctx.restore();
    }

    drawFantasyForestTree(ctx, x, y, tree) {
        const cached = this._getFantasyForestTreeCache(tree);
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.drawImage(
            cached.canvas,
            Math.round(x - cached.anchorX),
            Math.round(y - cached.anchorY)
        );
        ctx.restore();
    }

    _getFantasyForestTreeCache(tree) {
        // Reuse the authored pixel trees. The lower rows are legacy site tiles;
        // crop those off so each trunk meets the terrain rather than a plinth.
        const species = ['oak', 'pine', 'willow', 'oak'][tree.variant ?? 1] || 'oak';
        const id = { oak: 'veg.tree.oak.large', pine: 'veg.tree.pine.large', willow: 'veg.tree.willow.large' }[species];
        const sourceHeight = { oak: 54, pine: 57, willow: 53 }[species];
        const scale = (tree.scale ?? 1) >= 0.85 ? 2 : 1;
        const key = `${id}:${scale}`;
        const existing = this.cache.get(key);
        if (existing) return existing;

        const canvas = document.createElement('canvas');
        canvas.width = 64 * scale;
        canvas.height = sourceHeight * scale;
        const ctx = canvas.getContext('2d');
        SpriteRenderer.disableSmoothing(ctx);
        const source = this.host.assets.get(id);
        if (source) ctx.drawImage(source, 0, 0, 64, sourceHeight, 0, 0, canvas.width, canvas.height);
        const cached = { canvas, anchorX: canvas.width / 2, anchorY: canvas.height - scale };
        if (source) this.cache.set(key, cached);
        return cached;
    }
}
