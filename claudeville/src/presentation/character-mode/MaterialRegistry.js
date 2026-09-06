// Semantic material vocabulary shared by manifest metadata, drawable records,
// optional companion images, and the future GPU-resident renderer. Nothing in
// this module changes Canvas-2D output: it only normalizes additive metadata.

export const MATERIAL_CHANNELS = Object.freeze([
    'albedo',
    'material',
    'emissive',
    'occluder',
]);

export const MATERIAL_SIDECAR_FIELDS = Object.freeze({
    material: 'materialSidecar',
    emissive: 'emissiveSidecar',
    occluder: 'occluderSidecar',
});

export const MATERIAL_CLASS_NAMES = Object.freeze([
    'unlit',
    'stone',
    'timber',
    'metal',
    'foliage',
    'fabric',
    'earth',
    'cobble',
    'water',
    'glass-rune',
    'fire',
]);

// Stable numeric IDs are written into the red channel of generated material
// atlases. Append new classes; never reorder existing entries.
export const MATERIAL_CLASS_IDS = Object.freeze(Object.fromEntries(
    MATERIAL_CLASS_NAMES.map((name, index) => [name, index]),
));

export const AUTHORED_KEY_LIGHT = Object.freeze({
    convention: 'warm-upper-left',
    screenDirection: Object.freeze([-0.7071, -0.7071]),
    color: '#ffe0a0',
    // Palette-stepped multipliers. A material pass chooses one band; it must
    // not interpolate smooth PBR gradients across authored pixel ramps.
    responseBands: Object.freeze([0.72, 0.86, 1, 1.12]),
});

const MATERIAL_PROFILES = Object.freeze({
    unlit: profile('unlit', { keyResponse: 0, wetness: 0, reflection: 0 }),
    stone: profile('stone', { keyResponse: 0.62, wetness: 0.28, reflection: 0.08 }),
    timber: profile('timber', { keyResponse: 0.48, wetness: 0.34, reflection: 0.04 }),
    metal: profile('metal', { keyResponse: 0.82, wetness: 0.58, reflection: 0.36 }),
    foliage: profile('foliage', { keyResponse: 0.56, wetness: 0.62, reflection: 0.08 }),
    fabric: profile('fabric', { keyResponse: 0.42, wetness: 0.18, reflection: 0.02 }),
    earth: profile('earth', { keyResponse: 0.36, wetness: 0.46, reflection: 0.02 }),
    cobble: profile('cobble', { keyResponse: 0.58, wetness: 0.68, reflection: 0.14 }),
    water: profile('water', { keyResponse: 0.24, wetness: 1, reflection: 0.82 }),
    'glass-rune': profile('glass-rune', { keyResponse: 0.72, wetness: 0.26, reflection: 0.48 }),
    fire: profile('fire', { keyResponse: 0, wetness: 0, reflection: 0, emissive: 1 }),
});

export const DEFAULT_MATERIAL_METADATA = Object.freeze({
    materialId: 'material.default',
    materialClass: 'unlit',
    elevation: Object.freeze({ base: 0, top: 0, unit: 'sprite-px' }),
    emissive: Object.freeze({ strength: 0, sources: Object.freeze([]) }),
    occluder: Object.freeze({ mode: 'alpha-silhouette', strength: 1 }),
    atlasFrame: null,
});

export function isKnownMaterialClass(value) {
    return Object.hasOwn(MATERIAL_CLASS_IDS, String(value || ''));
}

export function normalizeMaterialClass(value, fallback = 'unlit') {
    const requested = String(value || '').trim().toLowerCase();
    const normalized = requested === 'default'
        ? 'unlit'
        : requested === 'rune'
            ? 'glass-rune'
            : requested;
    return isKnownMaterialClass(normalized) ? normalized : fallback;
}

export function materialClassId(value) {
    return MATERIAL_CLASS_IDS[normalizeMaterialClass(value)];
}

export function getMaterialProfile(value) {
    return MATERIAL_PROFILES[normalizeMaterialClass(value)];
}

export function normalizeMaterialMetadata(source = {}, overrides = {}) {
    const combined = { ...(source || {}), ...(overrides || {}) };
    const materialClass = normalizeMaterialClass(combined.materialClass);
    return {
        materialId: String(combined.materialId || combined.id || DEFAULT_MATERIAL_METADATA.materialId),
        materialClass,
        materialProfile: getMaterialProfile(materialClass),
        elevation: normalizeElevation(combined.elevation),
        emissive: normalizeEmissive(combined.emissive),
        occluder: normalizeOccluder(combined.occluder),
        atlasFrame: normalizeAtlasFrame(combined.atlasFrame),
    };
}

export function normalizeElevation(value) {
    if (Number.isFinite(Number(value))) {
        return { base: 0, top: Math.max(0, Number(value)), unit: 'sprite-px' };
    }
    if (!value || typeof value !== 'object') return { ...DEFAULT_MATERIAL_METADATA.elevation };
    const base = Number.isFinite(Number(value.base)) ? Number(value.base) : 0;
    const top = Number.isFinite(Number(value.top)) ? Math.max(base, Number(value.top)) : base;
    const unit = value.unit === 'world-px' ? 'world-px' : 'sprite-px';
    return { base, top, unit };
}

export function normalizeEmissive(value) {
    if (!value || typeof value !== 'object') {
        return { strength: 0, sources: [] };
    }
    const sources = Array.isArray(value.sources)
        ? value.sources
            .filter((source) => source && source.id)
            .map((source) => ({
                ...source,
                id: String(source.id),
                kind: String(source.kind || 'authored'),
                strength: clamp01(source.strength ?? 1),
            }))
        : [];
    const fallbackStrength = sources.length ? 1 : 0;
    return {
        strength: clamp01(value.strength ?? fallbackStrength),
        sources,
    };
}

export function normalizeOccluder(value) {
    if (value === false || value?.mode === 'none') return { mode: 'none', strength: 0 };
    if (!value || typeof value !== 'object') return { ...DEFAULT_MATERIAL_METADATA.occluder };
    const mode = value.mode === 'authored-height' ? 'authored-height' : 'alpha-silhouette';
    return {
        ...value,
        mode,
        strength: clamp01(value.strength ?? 1),
    };
}

export function normalizeAtlasFrame(value) {
    if (!value) return null;
    if (typeof value === 'string') return { atlas: null, key: value };
    if (typeof value !== 'object') return null;
    const atlas = value.atlas ? String(value.atlas) : null;
    const key = value.key ? String(value.key) : null;
    const keyPrefix = value.keyPrefix ? String(value.keyPrefix) : null;
    if (!atlas || (!key && !keyPrefix)) return null;
    return { atlas, key, keyPrefix };
}

export function sidecarDeclaration(entry, channel) {
    const field = MATERIAL_SIDECAR_FIELDS[channel];
    if (!field) return null;
    return entry?.[field] ?? entry?.sidecars?.[channel] ?? null;
}

// `true` opts into the deterministic companion path beside the albedo:
//   base.png -> base.emissive.png, sheet.png -> sheet.material.png, etc.
// A string remains an explicit manifest path. Absent/false means generated GPU
// defaults and must not trigger a network request or checkerboard fallback.
export function companionPathFor(entry, channel, albedoPath) {
    const declaration = sidecarDeclaration(entry, channel);
    if (!declaration) return null;
    if (typeof declaration === 'string') return declaration;
    if (declaration !== true || !albedoPath) return null;
    return String(albedoPath).replace(/\.png(?=($|\?))/, `.${channel}.png`);
}

export function defaultChannelPixel(channel, materialClass = 'unlit', alpha = 255) {
    const a = Math.max(0, Math.min(255, Math.round(Number(alpha) || 0)));
    if (channel === 'material') return [materialClassId(materialClass), 0, 0, a];
    if (channel === 'occluder') return [0, a, 0, a];
    if (channel === 'emissive') return [0, 0, 0, 0];
    return [0, 0, 0, a];
}

export function materialDebugDescriptor(metadata, availableChannels = {}) {
    const normalized = normalizeMaterialMetadata(metadata);
    return {
        materialId: normalized.materialId,
        materialClass: normalized.materialClass,
        materialClassId: materialClassId(normalized.materialClass),
        elevation: normalized.elevation,
        emissiveStrength: normalized.emissive.strength,
        emissiveSources: normalized.emissive.sources.map((source) => source.id),
        occluderMode: normalized.occluder.mode,
        atlasFrame: normalized.atlasFrame,
        channels: Object.fromEntries(MATERIAL_CHANNELS.map((channel) => [
            channel,
            channel === 'albedo' || Boolean(availableChannels[channel]),
        ])),
    };
}

// Authored wetness/reflection, fire forced to zero. GPU weather reads this
// table so timber and earth darken in rain without a plastic universal shine.
export const MATERIAL_WEATHER_RESPONSE = Object.freeze(Object.fromEntries(
    MATERIAL_CLASS_NAMES.map((name) => {
        const authored = MATERIAL_PROFILES[name] || MATERIAL_PROFILES.unlit;
        const fire = name === 'fire';
        return [name, Object.freeze({
            name,
            id: MATERIAL_CLASS_IDS[name],
            wetness: fire ? 0 : clamp01(authored.wetness),
            reflection: fire ? 0 : clamp01(authored.reflection),
        })];
    }),
));

export function materialWeatherResponseFor(value) {
    return MATERIAL_WEATHER_RESPONSE[normalizeMaterialClass(value)];
}

export function glslMaterialWeatherFunctions() {
    const wetnessMixes = [];
    const reflectionMixes = [];
    for (const row of Object.values(MATERIAL_WEATHER_RESPONSE)) {
        if (row.wetness > 0) {
            wetnessMixes.push(
                `    value = mix(value, ${row.wetness.toFixed(4)}, materialNear(material, ${row.id}.0));`,
            );
        }
        if (row.reflection > 0) {
            reflectionMixes.push(
                `    value = mix(value, ${row.reflection.toFixed(4)}, materialNear(material, ${row.id}.0));`,
            );
        }
    }
    return `float materialWetness(float material) {
    float value = 0.0;
${wetnessMixes.join('\n')}
    return value;
}

float materialReflection(float material) {
    float value = 0.0;
${reflectionMixes.join('\n')}
    return value;
}`;
}

function profile(name, values) {
    return Object.freeze({
        name,
        index: MATERIAL_CLASS_IDS?.[name] ?? 0,
        emissive: 0,
        ...values,
    });
}

function clamp01(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, number));
}
