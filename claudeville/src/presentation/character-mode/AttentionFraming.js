// The padded body-and-caption footprint an attention frame promises to show:
// the sprite plus its name/reason plate, with the same numbers the overlay uses
// when it has to admit an agent stayed outside the frame.
export function attentionCandidateBounds(candidate) {
    if (candidate.bounds) return candidate.bounds;
    return {
        minX: candidate.x - 44, maxX: candidate.x + 44,
        minY: candidate.y - 96, maxY: candidate.y + 12,
    };
}

// Pure world-space framing. Unknown wait ages stay unknown and sort last.
export function fitAttentionFrame(candidates, viewport, { padding = 16 } = {}) {
    const ranked = [...candidates].sort((a, b) => {
        const age = value => Number.isFinite(value) && value > 0 ? value : Infinity;
        return age(a.awaitingSince) - age(b.awaitingSince) || String(a.id).localeCompare(String(b.id));
    });
    const width = Math.max(0, viewport.width - padding * 2);
    const height = Math.max(0, viewport.height - padding * 2);
    const bounds = attentionCandidateBounds;
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const candidate of ranked) {
        const b = bounds(candidate);
        box.minX = Math.min(box.minX, b.minX);
        box.minY = Math.min(box.minY, b.minY);
        box.maxX = Math.max(box.maxX, b.maxX);
        box.maxY = Math.max(box.maxY, b.maxY);
    }
    const midpoint = b => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    const center = ranked.length ? midpoint(box) : { x: 0, y: 0 };
    const result = (pose, zoom, bias) => {
        const included = [], excluded = [];
        for (const candidate of ranked) {
            const b = bounds(candidate);
            const fits = b.minX >= pose.x - width / (2 * zoom)
                && b.maxX <= pose.x + width / (2 * zoom)
                && b.minY >= pose.y - height / (2 * zoom)
                && b.maxY <= pose.y + height / (2 * zoom);
            (fits ? included : excluded).push(candidate.id);
        }
        return { center: pose, zoom, included, excluded, bias };
    };
    for (const zoom of [3, 2, 1]) {
        const centered = result(center, zoom, 'center');
        if (centered.excluded.length) continue;
        if (!ranked.length) return centered;
        const oldest = midpoint(bounds(ranked[0]));
        const third = result({ x: oldest.x + width / (6 * zoom), y: center.y }, zoom, 'third');
        return third.excluded.length ? centered : third;
    }
    // No complete fit: keep the oldest decision in a centered minimum-tier shot.
    return result(ranked.length ? midpoint(bounds(ranked[0])) : center, 1, 'center');
}
