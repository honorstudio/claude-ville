// Pixel-native primitives for the world layer.
//
// Canvas path fills antialias. That is fine for a glow or a soft contact
// shadow, where the softness is the point, and wrong for anything that reads
// as a solid object: a curved `ctx.ellipse` or a `quadraticCurveTo` flame lands
// as a smooth-edged blob among sprites made of hard pixel steps, and the eye
// picks it out immediately as "drawn by a different hand".
//
// These helpers rasterise the same shapes on whole pixels, so procedural
// details sit in the same visual language as the PixelLab art around them.
// Everything here works in the caller's current transform; the camera's integer
// zoom means a rect emitted at whole coordinates stays a crisp rect on screen.

/**
 * Filled ellipse rasterised as integer scanlines — a pixel-art ellipse rather
 * than an antialiased one.
 */
export function fillPixelEllipse(ctx, cx, cy, rx, ry, color) {
    if (!(rx > 0) || !(ry > 0)) return;
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    const rX = Math.max(1, Math.round(rx));
    const rY = Math.max(1, Math.round(ry));
    ctx.fillStyle = color;
    for (let dy = -rY; dy <= rY; dy++) {
        // Half-pixel sampling keeps the top and bottom rows from collapsing.
        const t = (dy + 0.5 * Math.sign(dy || 1)) / (rY + 0.5);
        const span = Math.floor(rX * Math.sqrt(Math.max(0, 1 - t * t)) + 0.5);
        if (span <= 0) continue;
        ctx.fillRect(x0 - span, y0 + dy, span * 2, 1);
    }
}

/**
 * Hollow ellipse one pixel thick, for rings that should read as drawn rather
 * than glowing (selection marks, contact rings).
 */
export function strokePixelEllipse(ctx, cx, cy, rx, ry, color) {
    if (!(rx > 0) || !(ry > 0)) return;
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    const rX = Math.max(1, Math.round(rx));
    const rY = Math.max(1, Math.round(ry));
    ctx.fillStyle = color;
    let previousSpan = -1;
    for (let dy = -rY; dy <= rY; dy++) {
        const t = (dy + 0.5 * Math.sign(dy || 1)) / (rY + 0.5);
        const span = Math.floor(rX * Math.sqrt(Math.max(0, 1 - t * t)) + 0.5);
        if (span <= 0) { previousSpan = span; continue; }
        if (previousSpan < 0 || Math.abs(span - previousSpan) > 1) {
            // Row where the curve turns: fill the whole span so the outline closes.
            ctx.fillRect(x0 - span, y0 + dy, span * 2, 1);
        } else {
            ctx.fillRect(x0 - span, y0 + dy, 1, 1);
            ctx.fillRect(x0 + span - 1, y0 + dy, 1, 1);
        }
        previousSpan = span;
    }
}

const DEFAULT_FLAME = Object.freeze({
    outer: 'rgba(255, 140, 36, 0.96)',
    inner: 'rgba(255, 224, 130, 0.96)',
    tip: 'rgba(255, 246, 214, 0.92)',
});

/**
 * A flame built from stacked rows.
 *
 * Every flame in the village used to be one or two filled triangles (or a pair
 * of quadratic curves), which reads as a paper cutout. A quadratic taper with a
 * lit core and a bright tip pixel gives the same silhouette in the same idiom
 * as the sprites.
 *
 * @param {number} baseX      centre of the flame base
 * @param {number} baseY      the base row; the flame grows upward from here
 * @param {number} height     flame height in pixels
 * @param {number} halfWidth  half-width at the base
 * @param {number} lean       horizontal drift at the tip, in pixels
 */
export function drawPixelFlame(ctx, baseX, baseY, height, halfWidth = 3, {
    outer = DEFAULT_FLAME.outer,
    inner = DEFAULT_FLAME.inner,
    tip = DEFAULT_FLAME.tip,
    lean = 0,
    coreRatio = 0.62,
} = {}) {
    const rows = Math.max(1, Math.round(height));
    const half = Math.max(1, Math.round(halfWidth));
    const x0 = Math.round(baseX);
    const y0 = Math.round(baseY);

    for (let k = 0; k < rows; k++) {
        const t = k / Math.max(1, rows - 1);        // 0 at the base, 1 at the tip
        const drift = Math.round(lean * t * t);
        const width = Math.max(0, Math.round(half * (1 - t * t)));
        if (width <= 0) continue;
        ctx.fillStyle = outer;
        ctx.fillRect(x0 - width + drift, y0 - k, width * 2, 1);
        if (t < coreRatio) {
            const core = width - 1;
            if (core > 0) {
                ctx.fillStyle = inner;
                ctx.fillRect(x0 - core + drift, y0 - k, core * 2, 1);
            }
        }
    }
    ctx.fillStyle = tip;
    ctx.fillRect(x0 + Math.round(lean), y0 - rows + 1, 1, 1);
}

/**
 * Fill one isometric tile diamond as integer scanlines.
 *
 * A path-filled diamond antialiases along its four diagonals. That is harmless
 * for an opaque fill, but translucent per-tile fills — depth tints, washes —
 * either leave a hairline where neighbours meet or, if you overscan to close
 * it, composite twice and draw a dark lattice. Neither is acceptable across a
 * whole body of water.
 *
 * The classic 2:1 iso scanline decomposition tiles exactly: row r of the top
 * half is (2r+1)*step pixels wide — 2, 6, 10 ... 62 for a 64x32 tile — and the
 * bottom half mirrors it. Total area is exactly w*h/2, and adjacent diamonds
 * interlock with no gap and no overlap. (Using 4*(r+1) instead overshoots by
 * 64px of area per tile and the diamonds overlap.)
 */
export function fillTileDiamond(ctx, centerX, centerY, tileWidth, tileHeight, color) {
    const halfH = tileHeight / 2;
    const step = tileWidth / tileHeight;   // 2 px of width per row for 64x32
    const cx = Math.round(centerX);
    const cy = Math.round(centerY);
    ctx.fillStyle = color;
    for (let row = 0; row < tileHeight; row++) {
        const fromTop = row < halfH ? row : tileHeight - 1 - row;
        const width = Math.round((fromTop * 2 + 1) * step);
        if (width <= 0) continue;
        ctx.fillRect(cx - width / 2, cy - halfH + row, width, 1);
    }
}
