const SUPPORTED_KINDS = new Set(['point', 'beam', 'spark', 'arc', 'orbit']);

export function normalizeLightSource(source = {}, defaults = {}) {
    const kind = SUPPORTED_KINDS.has(source.kind) ? source.kind : 'point';
    const origin = source.origin || (
        Number.isFinite(source.x) && Number.isFinite(source.y)
            ? { x: source.x, y: source.y }
            : null
    );
    const priority = Number(source.priority);
    const defaultPriority = Number(defaults.priority);
    return {
        id: source.id || defaults.id || `${defaults.buildingType || 'light'}:${kind}:${Math.round(origin?.x || 0)},${Math.round(origin?.y || 0)}`,
        kind,
        origin,
        x: origin?.x ?? source.x,
        y: origin?.y ?? source.y,
        endpoints: Array.isArray(source.endpoints) ? source.endpoints : undefined,
        controlPoint: source.controlPoint,
        parent: source.parent,
        color: source.color || defaults.color || '#ffcc66',
        radius: Number.isFinite(source.radius) ? source.radius : defaults.radius || 64,
        length: source.length,
        width: source.width,
        alpha: Number.isFinite(source.alpha) ? source.alpha : defaults.alpha,
        priority: Number.isFinite(priority)
            ? priority
            : Number.isFinite(defaultPriority) ? defaultPriority : 0,
        ttl: source.ttl ?? null,
        createdAt: source.createdAt,
        buildingType: source.buildingType || defaults.buildingType || null,
        building: source.building || defaults.building || null,
        intensity: Number.isFinite(source.intensity) ? source.intensity : defaults.intensity ?? 1,
        overlay: source.overlay || defaults.overlay || null,
    };
}

export function lightSourceCacheKey(source, phaseBucket = 'fallback') {
    return [
        source.id || '',
        source.kind || 'point',
        Math.round(source.x ?? source.origin?.x ?? 0),
        Math.round(source.y ?? source.origin?.y ?? 0),
        Math.round(source.radius || 0),
        source.color || '',
        phaseBucket,
    ].join('|');
}
