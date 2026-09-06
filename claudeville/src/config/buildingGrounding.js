export const BUILDING_GROUNDING_MODES = Object.freeze([
    'terrain-apron',
    'intentional-dais',
    'quay',
    'water-pilings',
]);

export const BUILDING_GROUNDING_MATERIALS = Object.freeze([
    'civic-cobble',
    'knowledge-terrace',
    'workshop-yard',
    'mine-yard',
    'arcane-court',
    'harbor-quay',
    'tidal-water',
]);

export const BUILDING_GROUNDING_EDGE_TREATMENTS = Object.freeze([
    'broken',
    'retained',
    'water-contact',
]);

export const BUILDING_GROUNDING_SHADOWS = Object.freeze([
    'structure-contact',
    'tower-cast',
    'none',
]);

// World-pixel contact geometry is measured at zoom 1. Foundations are baked
// into the static terrain cache; shadow/contact shapes are the only per-frame
// physical grounding marks.
export const BUILDING_GROUNDING_PROFILES = Object.freeze({
    command: Object.freeze({
        mode: 'terrain-apron',
        material: 'civic-cobble',
        edgeTreatment: 'broken',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: false, owner: 'sprite-reference', opacity: 0 }),
        contact: Object.freeze({ offsetX: 0, offsetY: -9, width: 190, depth: 34, opacity: 0.78 }),
    }),
    taskboard: Object.freeze({
        mode: 'terrain-apron',
        material: 'civic-cobble',
        edgeTreatment: 'broken',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.54, density: 0.44, thresholdReach: 0.58 }),
        contact: Object.freeze({ offsetX: 0, offsetY: -4, width: 148, depth: 20, opacity: 0.62 }),
    }),
    forge: Object.freeze({
        mode: 'terrain-apron',
        material: 'workshop-yard',
        edgeTreatment: 'broken',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.5, density: 0.5, thresholdReach: 0.56 }),
        contact: Object.freeze({ offsetX: -8, offsetY: -7, width: 152, depth: 32, opacity: 0.76 }),
    }),
    mine: Object.freeze({
        mode: 'terrain-apron',
        material: 'mine-yard',
        edgeTreatment: 'broken',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.56, density: 0.58, thresholdReach: 0.68 }),
        contact: Object.freeze({ offsetX: -8, offsetY: -5, width: 172, depth: 38, opacity: 0.82 }),
    }),
    archive: Object.freeze({
        mode: 'terrain-apron',
        material: 'knowledge-terrace',
        edgeTreatment: 'broken',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.52, density: 0.52, thresholdReach: 0.66 }),
        contact: Object.freeze({ offsetX: 0, offsetY: -7, width: 218, depth: 38, opacity: 0.8 }),
    }),
    observatory: Object.freeze({
        mode: 'terrain-apron',
        material: 'knowledge-terrace',
        edgeTreatment: 'broken',
        shadow: 'tower-cast',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.48, density: 0.48, thresholdReach: 0.62 }),
        contact: Object.freeze({ offsetX: -8, offsetY: -7, width: 108, depth: 28, opacity: 0.76, castLength: 52 }),
    }),
    portal: Object.freeze({
        mode: 'intentional-dais',
        material: 'arcane-court',
        edgeTreatment: 'retained',
        shadow: 'structure-contact',
        foundation: Object.freeze({ enabled: true, owner: 'terrain-cache', opacity: 0.3, density: 0.3, thresholdReach: 0.42 }),
        contact: Object.freeze({ offsetX: 0, offsetY: -2, width: 150, depth: 32, opacity: 0.72 }),
    }),
    watchtower: Object.freeze({
        mode: 'quay',
        material: 'harbor-quay',
        edgeTreatment: 'water-contact',
        shadow: 'tower-cast',
        foundation: Object.freeze({ enabled: false, owner: 'structural-sprite', opacity: 0 }),
        contact: Object.freeze({ offsetX: 0, offsetY: -4, width: 74, depth: 20, opacity: 0.76, castLength: 86 }),
    }),
    harbor: Object.freeze({
        mode: 'water-pilings',
        material: 'tidal-water',
        edgeTreatment: 'water-contact',
        shadow: 'none',
        foundation: Object.freeze({ enabled: false, owner: 'structural-sprite', opacity: 0 }),
        contact: Object.freeze({ offsetX: 0, offsetY: 0, width: 0, depth: 0, opacity: 0 }),
    }),
});
