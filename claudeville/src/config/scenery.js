// Authored scenery data for the ClaudeVille world.
// All tile coordinates are 0..MAP_SIZE-1 (40-tile grid).
// Polylines are arrays of [tileX, tileY] control points; rasterization is
// performed by SceneryEngine (Bresenham-thickened or quadratic-eased).

// Water polylines. `width` is the half-width in tiles around the centerline.
// `kind` controls visual depth: 'river' is shallow, 'moat' is deeper.
export const WATER_POLYLINES = [
    // Northwest jungle stream: breaks up the old conifer wall with bright
    // lagoon water and gives the upper-left forest a tropical focal point.
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        width: 1.35,
        points: [[2, 7], [6, 8], [10, 8], [14, 9], [17, 10]],
    },
    // Forest spring: a bright tropical cascade feeding the northern lagoon.
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        width: 1.05,
        points: [[18, 4], [18, 6], [17, 8], [17, 10]],
    },
    // Top-right sea inlet: a broad deep-water body that reads as open water
    // feeding the harbor instead of a defensive moat around the map edge.
    {
        kind: 'sea',
        region: 'sea',
        surface: 'surf',
        weatherProfile: 'openSea',
        width: 6.1,
        points: [[23, 0], [29, 1], [35, 3], [39, 6]],
    },
    {
        kind: 'sea',
        region: 'sea',
        surface: 'surf',
        weatherProfile: 'openSea',
        width: 6.3,
        points: [[39, 3], [36, 9], [35, 15], [35, 22], [37, 29], [39, 34]],
    },
    {
        kind: 'harbor',
        region: 'harbor',
        surface: 'harbor',
        weatherProfile: 'harbor',
        width: 2.6,
        points: [[31, 22], [34, 22], [37, 22], [39, 23]],
    },
    // Main river through City Center. The local narrows shortens the
    // footbridge span before the river drains into the harbor sea.
    {
        kind: 'river',
        region: 'river',
        surface: 'current',
        weatherProfile: 'river',
        width: 2.15,
        points: [[0, 25], [9, 25], [13, 25]],
    },
    {
        kind: 'river',
        region: 'river',
        surface: 'current',
        weatherProfile: 'river',
        width: 1.4,
        points: [[13, 25], [15, 24.5], [21, 24.5], [23, 25]],
    },
    {
        kind: 'river',
        region: 'river',
        surface: 'current',
        weatherProfile: 'river',
        width: 2.15,
        points: [[23, 25], [30, 24], [35, 23], [39, 22]],
    },
];

// Broad authored water masses. These supplement polylines for sea/bay shapes
// where a line stroke would look too rectangular.
export const WATER_BASINS = [
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        centerX: 7.6,
        centerY: 8.3,
        radiusX: 5.1,
        radiusY: 3.4,
        edgeNoise: 0.22,
    },
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        centerX: 12.4,
        centerY: 5.2,
        radiusX: 3.6,
        radiusY: 2.4,
        edgeNoise: 0.18,
    },
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        centerX: 17.4,
        centerY: 10.5,
        radiusX: 4.8,
        radiusY: 3.2,
        edgeNoise: 0.18,
    },
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        centerX: 24.8,
        centerY: 7.6,
        radiusX: 3.6,
        radiusY: 2.4,
        edgeNoise: 0.16,
    },
    {
        kind: 'river',
        region: 'river',
        surface: 'current',
        weatherProfile: 'river',
        centerX: 0.8,
        centerY: 25,
        radiusX: 4.2,
        radiusY: 3.3,
        edgeNoise: 0.06,
    },
    {
        kind: 'sea',
        region: 'sea',
        surface: 'surf',
        weatherProfile: 'openSea',
        centerX: 43,
        centerY: 19,
        radiusX: 13.6,
        radiusY: 25,
        edgeNoise: 0.11,
    },
    {
        kind: 'sea',
        region: 'sea',
        surface: 'surf',
        weatherProfile: 'openSea',
        centerX: 38,
        centerY: 3.5,
        radiusX: 13.5,
        radiusY: 9.5,
        edgeNoise: 0.14,
    },
    {
        kind: 'harbor',
        region: 'harbor',
        surface: 'harbor',
        weatherProfile: 'harbor',
        centerX: 37.3,
        centerY: 21.7,
        radiusX: 6.8,
        radiusY: 7.4,
        edgeNoise: 0.16,
    },
    {
        kind: 'harbor',
        region: 'harbor',
        surface: 'harbor',
        weatherProfile: 'harbor',
        centerX: 39.2,
        centerY: 16.2,
        radiusX: 4.8,
        radiusY: 6.4,
        edgeNoise: 0.12,
    },
    {
        kind: 'river',
        region: 'lagoon',
        surface: 'current',
        weatherProfile: 'lagoon',
        centerX: 17,
        centerY: 22,
        radiusX: 1.2,
        radiusY: 1.2,
        edgeNoise: 0.14,
    },
];

// Bridge hints: explicit tile positions where a deck must exist.
// SceneryEngine may auto-place extra crossings when no hints are present, but
// these authored hints intentionally define the visible river crossings.
// `orientation` is optional; when omitted the engine derives it from neighbor
// water tiles.
export const BRIDGE_HINTS = [
    // The deck is 3 tiles wide (17..19) x 3 long (23..25); only the center
    // column is walkable. deckRise is the visual arch height in px used for
    // the agent lift. nearRail is the span-space band (px) containing the
    // sprite's camera-near handrail used for occlusion.
    {
        id: 'central-river-bridge',
        tileX: 18,
        tileY: 24,
        orientation: 'NS',
        style: 'civic',
        widthRadius: 1,
        walkableRadius: 0,
        deckRise: 10,
        nearRail: { inner: 30, outer: 76, top: 44, bottom: 10 },
    },
];

// Plank crossings: single-file walkable spans drawn per-tile from the
// bridge.ew/ns plank assets (kind 'plank' — no landmark span treatment).
// The west crossing meets the north-bank-promenade's river anchor (7, 23) so
// the archive/promenade side links to the portal-grove and mine approach
// without walking to the central landmark bridge. Walkability only ever
// *adds* connectivity here, so routing risk is limited to new scenery.
export const PLANK_BRIDGES = [
    {
        id: 'west-river-plank',
        tileX: 7,
        tileY: 25,
        orientation: 'NS',
    },
    {
        id: 'command-pond-plank',
        tileX: 17,
        tileY: 22,
        orientation: 'EW',
    },
];

// Small authored Harbor Master causeway. This is intentionally separate from
// the two landmark river bridges so agents can reach the harbor without
// creating extra town-wide crossings.
export const HARBOR_DOCK_TILES = [
    { tileX: 28, tileY: 19, orientation: 'EW', style: 'causeway' },
    { tileX: 29, tileY: 19, orientation: 'EW', style: 'causeway' },
    { tileX: 30, tileY: 19, orientation: 'EW', style: 'causeway' },
    { tileX: 31, tileY: 19, orientation: 'EW', style: 'causeway' },
    { tileX: 31, tileY: 20, orientation: 'NS', style: 'causeway' },
];

// Large authored forest-floor masses. These sit under the sprite trees and
// make the north map read as one old fantasy woodland instead of isolated
// random props.
export const FOREST_FLOOR_REGIONS = [
    { name: 'northwest-elderwood', centerX: 7.5, centerY: 7.5, radiusX: 9.8, radiusY: 7.2, base: '#2d5a2b', accent: '#5c8b3f', strength: 0.90 },
    { name: 'northern-canopy', centerX: 17.5, centerY: 6.2, radiusX: 13.2, radiusY: 6.4, base: '#28562e', accent: '#659644', strength: 1.00 },
    { name: 'clock-greenwood', centerX: 27.8, centerY: 8.2, radiusX: 9.8, radiusY: 6.6, base: '#2e5835', accent: '#6c9648', strength: 0.80 },
    { name: 'archive-grove', centerX: 8.2, centerY: 14.8, radiusX: 6.2, radiusY: 4.8, base: '#315f32', accent: '#729948', strength: 0.68 },
    { name: 'lighthouse-windbreak', centerX: 30.2, centerY: 10.8, radiusX: 5.8, radiusY: 6.2, base: '#315a36', accent: '#73924c', strength: 0.58 },
    { name: 'central-isle', centerX: 17, centerY: 22, radiusX: 7, radiusY: 6, base: '#2c5a32', accent: '#54753f', strength: 0.55 },
];

// Tree clusters: anchor tile + radius (tiles) + density (0..1).
// Density is multiplied against per-tile noise; trees only spawn on
// non-water, non-path, non-shore, non-building-footprint tiles.
// SceneryEngine MUST clamp iteration to [0, MAP_SIZE-1] — corner clusters
// (4,4) and (36,36) intentionally extend past map edges to thicken the
// fringe forest.
export const TREE_CLUSTERS = [
    // North crown: contiguous layered woodland with a few intentional glades.
    { centerX: 4, centerY: 5, radiusX: 8.4, radiusY: 6.2, density: 0.84, palmBias: 0.62 },
    { centerX: 14, centerY: 5, radiusX: 10.6, radiusY: 5.6, density: 0.80, palmBias: 0.54 },
    { centerX: 24, centerY: 5, radiusX: 8.8, radiusY: 5.4, density: 0.76, palmBias: 0.42 },
    { centerX: 28, centerY: 8, radiusX: 5.4, radiusY: 5.8, density: 0.58, palmBias: 0.42 },
    { centerX: 13, centerY: 12, radiusX: 6.8, radiusY: 4.6, density: 0.68, palmBias: 0.50 },
    { centerX: 22, centerY: 12, radiusX: 5.6, radiusY: 4.0, density: 0.56, palmBias: 0.54 },
    { centerX: 4, centerY: 35, radiusX: 7.6, radiusY: 5.6, density: 0.68, palmBias: 0.52 },
    { centerX: 35, centerY: 4, radiusX: 4.8, radiusY: 5.8, density: 0.52, palmBias: 0.44 },
    { centerX: 36, centerY: 36, radiusX: 7, radiusY: 5.8, density: 0.68, palmBias: 0.68 },
    // The settlement keeps a lighter canopy than the northern forest.
    { centerX: 7, centerY: 31, radiusX: 6.8, radiusY: 4.6, density: 0.40, palmBias: 0.50 },
    { centerX: 17, centerY: 32, radiusX: 5.8, radiusY: 3.6, density: 0.35, palmBias: 0.42 },
    { centerX: 28, centerY: 32, radiusX: 6.2, radiusY: 3.8, density: 0.35, palmBias: 0.48 },
    { centerX: 33, centerY: 22, radiusX: 3.0, radiusY: 4.4, density: 0.30, palmBias: 0.58 },
    { centerX: 6, centerY: 20, radiusX: 4.8, radiusY: 4.8, density: 0.39, palmBias: 0.44 },
    { centerX: 18, centerY: 23, radiusX: 7.2, radiusY: 3.2, density: 0.28, palmBias: 0.61 },
    { centerX: 26, centerY: 23, radiusX: 5.6, radiusY: 3.6, density: 0.25, palmBias: 0.57 },
    { centerX: 35, centerY: 15, radiusX: 4.8, radiusY: 5.2, density: 0.34, palmBias: 0.61 },
    { centerX: 14, centerY: 21, radiusX: 4.6, radiusY: 4.0, density: 0.28, palmBias: 0.55 },
    { centerX: 20, centerY: 22, radiusX: 4.4, radiusY: 4.0, density: 0.25, palmBias: 0.50 },
    { centerX: 17, centerY: 19, radiusX: 5.2, radiusY: 3.4, density: 0.30, palmBias: 0.48 },
];

export const TROPICAL_PALMS = [
    { tileX: 2.8, tileY: 8.6, scale: 1.34, seed: 0.62 },
    { tileX: 4.5, tileY: 4.8, scale: 1.26, seed: 0.23 },
    { tileX: 5.8, tileY: 11.8, scale: 1.30, seed: 0.77 },
    { tileX: 8.6, tileY: 5.7, scale: 1.38, seed: 0.36 },
    { tileX: 10.8, tileY: 10.6, scale: 1.24, seed: 0.92 },
    { tileX: 13.4, tileY: 3.8, scale: 1.32, seed: 0.51 },
    { tileX: 15.2, tileY: 8.9, scale: 1.20, seed: 0.69 },
    { tileX: 11.5, tileY: 22.3, scale: 1.22, seed: 0.18 },
    { tileX: 34.0, tileY: 14.8, scale: 1.18, seed: 0.44 },
    { tileX: 36.3, tileY: 17.8, scale: 1.14, seed: 0.66 },
    { tileX: 12.2, tileY: 30.1, scale: 1.20, seed: 0.78 },
    { tileX: 29.5, tileY: 31.0, scale: 1.18, seed: 0.58 },
    { tileX: 17.0, tileY: 10.0, scale: 1.28, seed: 0.14 },
    { tileX: 20.4, tileY: 11.7, scale: 1.22, seed: 0.88 },
    { tileX: 24.8, tileY: 9.6, scale: 1.18, seed: 0.48 },
    { tileX: 14.6, tileY: 23.4, scale: 1.22, seed: 0.34 },
    { tileX: 19.4, tileY: 23.6, scale: 1.18, seed: 0.61 },
    { tileX: 18.5, tileY: 24.6, scale: 1.20, seed: 0.27 },
    { tileX: 15.4, tileY: 20.2, scale: 1.16, seed: 0.82 },
    { tileX: 19.8, tileY: 20.6, scale: 1.24, seed: 0.45 },
];

export const TROPICAL_BROADLEAF_TREES = [
    { tileX: 3.8, tileY: 6.8, scale: 1.18, seed: 0.19 },
    { tileX: 6.4, tileY: 9.9, scale: 1.25, seed: 0.81 },
    { tileX: 9.4, tileY: 4.3, scale: 1.16, seed: 0.43 },
    { tileX: 12.1, tileY: 8.1, scale: 1.22, seed: 0.67 },
    { tileX: 16.0, tileY: 6.3, scale: 1.12, seed: 0.31 },
    { tileX: 18.6, tileY: 10.8, scale: 1.20, seed: 0.74 },
    { tileX: 13.8, tileY: 22.8, scale: 1.20, seed: 0.18 },
    { tileX: 20.6, tileY: 21.4, scale: 1.16, seed: 0.55 },
    { tileX: 17.6, tileY: 24.4, scale: 1.18, seed: 0.71 },
    { tileX: 22.5, tileY: 13.8, scale: 1.14, seed: 0.39 },
];

// Static large boulders. Drawn Y-sorted (occlude behind agents).
export const BOULDERS = [
    { tileX: 7.4, tileY: 14.2, scale: 1.1, variant: 'a' },
    { tileX: 31.6, tileY: 28.8, scale: 0.95, variant: 'b' },
    { tileX: 18.2, tileY: 31.4, scale: 1.05, variant: 'a' },
    { tileX: 20.4, tileY: 11.6, scale: 0.9, variant: 'b' },
    { tileX: 12.4, tileY: 24.2, scale: 0.85, variant: 'a' },
    { tileX: 33.4, tileY: 21.5, scale: 1.0, variant: 'b' },
    { tileX: 9.1, tileY: 11.5, scale: 0.85, variant: 'a' },
    { tileX: 30.3, tileY: 36.2, scale: 1.0, variant: 'b' },
    { tileX: 4.8, tileY: 27.4, scale: 0.95, variant: 'a' },
    { tileX: 6.2, tileY: 30.6, scale: 1.1, variant: 'b' },
    { tileX: 15.4, tileY: 34.3, scale: 0.9, variant: 'a' },
    { tileX: 29.2, tileY: 33.6, scale: 1.05, variant: 'b' },
    { tileX: 32.8, tileY: 6.5, scale: 0.9, variant: 'a' },
    { tileX: 22.0, tileY: 14.0, scale: 1.05, variant: 'b' },
    { tileX: 23.2, tileY: 13.2, scale: 0.95, variant: 'b' },
    { tileX: 14.6, tileY: 22.4, scale: 0.9, variant: 'b' },
    { tileX: 21.5, tileY: 26.4, scale: 0.85, variant: 'b' },
];

// District biases make the authored map read in larger masses instead of
// uniformly sprinkling props. Radius is radial falloff in tiles; the engine
// clamps blocked/path/water/building tiles after applying these weights.
export const VEGETATION_DISTRICTS = [
    { name: 'northern-elderwood', centerX: 17, centerY: 8, radius: 15.0, bushBoost: 0.044, grassBoost: 0.060, treeBoost: 0.120, flowerBoost: 0.050 },
    { name: 'scholars-ridge', centerX: 17, centerY: 18, radius: 10.0, bushBoost: 0.022, grassBoost: 0.048, treeBoost: 0.040, flowerBoost: 0.110 },
    { name: 'west-river-frame', centerX: 7, centerY: 22, radius: 7.0, bushBoost: 0.04, grassBoost: 0.045, treeBoost: 0.065, flowerBoost: 0.085 },
    { name: 'portal-grove', centerX: 7.5, centerY: 28.5, radius: 5.0, bushBoost: 0.032, grassBoost: 0.023, treeBoost: 0.018, flowerBoost: 0.045 },
    { name: 'south-wildwood', centerX: 22, centerY: 35, radius: 12, bushBoost: 0.04, grassBoost: 0.05, treeBoost: 0.08, flowerBoost: 0.080 },
    { name: 'harbor-windbreak', centerX: 35, centerY: 22, radius: 5.2, bushBoost: 0.020, grassBoost: 0.014, treeBoost: 0.008, flowerBoost: 0.040 },
    // Keep the inhabited belt quiet so agents, paths and thresholds remain legible.
    { name: 'civic-meadow', centerX: 17, centerY: 22, radius: 9.0, bushBoost: -0.035, grassBoost: -0.035, treeBoost: 0.0, flowerBoost: -0.025 },
];

// Shoreline accents are deterministic bands near water. They add readable
// riverbanks without turning the whole shore into dense trees.
export const SHORELINE_VEGETATION = {
    bushBoost: 0.04,
    grassBoost: 0.09,
    treeBoost: 0.015,
    flowerBoost: 0.060,
    maxWaterDistance: 1,
};

// Negative-space pockets keep key silhouettes and crossings readable after
// district density boosts. Strength is subtracted from generated scenery
// density with radial falloff.
export const SCENERY_CLEARINGS = [
    { name: 'elderwood-glade', centerX: 16.8, centerY: 10.5, radius: 3.6, strength: 0.18 },
    { name: 'clock-skybreak', centerX: 27.2, centerY: 14.0, radius: 5.8, strength: 0.95 },
    { name: 'archive-approach', centerX: 9.0, centerY: 17.0, radius: 4.2, strength: 0.36 },
    { name: 'command-skyline', centerX: 20.4, centerY: 16.0, radius: 2.8, strength: 0.15 },
    { name: 'lighthouse-beacon-skybreak', centerX: 31.0, centerY: 12.6, radius: 3.8, strength: 0.24 },
    { name: 'archive-terrace', centerX: 8, centerY: 19, radius: 4.8, strength: 0.26 },
    { name: 'clock-terrace', centerX: 27, centerY: 18, radius: 5.2, strength: 0.32 },
    { name: 'production-row', centerX: 22, centerY: 29.5, radius: 12.0, strength: 0.21 },
    { name: 'harbor-stage', centerX: 37, centerY: 20.5, radius: 7.5, strength: 0.28 },
    { name: 'central-river-bridge', centerX: 18, centerY: 23, radius: 5.4, strength: 0.30 },
    { name: 'harbor-mouth', centerX: 32, centerY: 21, radius: 4.0, strength: 0.24 },
    { name: 'isle-promenade-bend', centerX: 14, centerY: 21, radius: 1.6, strength: 0.5 },
    { name: 'isle-bridge-bend', centerX: 19.5, centerY: 22.0, radius: 1.6, strength: 0.5 },
];

export const TROPICAL_WATERFALLS = [
    { tileX: 9.0, tileY: 5.2, height: 40, width: 42, poolTileX: 7.6, poolTileY: 8.3, scale: 1.18, phase: 2.7 },
    { tileX: 18.0, tileY: 6.1, height: 46, width: 38, poolTileX: 17.4, poolTileY: 10.4, scale: 1.05, phase: 0.1 },
    { tileX: 24.6, tileY: 6.2, height: 30, width: 28, poolTileX: 24.8, poolTileY: 7.8, scale: 0.78, phase: 1.9 },
];

export const DISTRICT_WASHES = [
    { x: 16, y: 22, radiusX: 10, radiusY: 6, color: '#8b5526', alpha: 0.13 },
    { x: 36, y: 20, radiusX: 10, radiusY: 8, color: '#167178', alpha: 0.14 },
    { x: 7, y: 28, radiusX: 7, radiusY: 5, color: '#7d4b25', alpha: 0.10 },
    { x: 14, y: 16, radiusX: 12, radiusY: 6, color: '#476b2c', alpha: 0.11 },
    { x: 20, y: 28, radiusX: 15, radiusY: 6, color: '#5b5228', alpha: 0.11 },
];

export const ANCIENT_RUINS = [
    { tileX: 37, tileY: 3, scale: 1.05 },
    { tileX: 2, tileY: 16, scale: 0.82 },
    { tileX: 36, tileY: 34, scale: 0.95 },
];

export const DISTRICT_PROPS = [
    { tileX: 11.9, tileY: 21.0, id: 'prop.runeBrazier', layer: 'cache', district: 'command' },
    { tileX: 19.2, tileY: 21.1, id: 'prop.runeBrazier', layer: 'cache', district: 'command' },
    { tileX: 15.4, tileY: 21.6, id: 'prop.runeFountain', layer: 'cache', district: 'civic' },
    { tileX: 2.2, tileY: 14.4, id: 'veg.root.arch', layer: 'sorted', district: 'elderwood' },
    { tileX: 6.2, tileY: 26.5, id: 'veg.standingStone.mossy', layer: 'cache', district: 'elderwood' },
    { tileX: 6.9, tileY: 27.3, id: 'prop.lakeShrine', layer: 'cache', district: 'elderwood' },
    { tileX: 32.3, tileY: 19.6, id: 'prop.netRack', layer: 'cache', district: 'harbor' },
    { tileX: 31.4, tileY: 20.6, id: 'prop.harborCrane', layer: 'cache', district: 'harbor' },
    { tileX: 33.2, tileY: 22.2, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'harbor' },
    { tileX: 37.1, tileY: 22.0, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'harbor' },
    { tileX: 6.0, tileY: 8.0, id: 'prop.netRack', layer: 'cache', district: 'lagoon' },
    { tileX: 14.0, tileY: 5.5, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'lagoon' },
    { tileX: 20.0, tileY: 11.0, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'lagoon' },
    // Lagoon lilypad drifts: tight 2-3 pad clusters on calm interior water
    // instead of isolated singles.
    { tileX: 13.4, tileY: 7.6, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 12.6, tileY: 8.2, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 13.2, tileY: 8.7, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 15.2, tileY: 8.4, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 14.0, tileY: 9.2, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 15.6, tileY: 9.3, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    // Waterfall-pool pair on the east lagoon basin.
    { tileX: 24.2, tileY: 7.4, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    { tileX: 25.0, tileY: 7.9, id: 'veg.lilypad', layer: 'cache', district: 'lagoon' },
    // Mangrove roots: west shore shallow water.
    { tileX: 6.6, tileY: 7.8, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'lagoon' },
    { tileX: 7.4, tileY: 9.6, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'lagoon' },
    { tileX: 6.2, tileY: 8.8, id: 'prop.mangroveRoot.arch', layer: 'sorted', district: 'lagoon' },
    // Driftwood logs: west shore shallows.
    { tileX: 7.2, tileY: 10.4, id: 'prop.driftwood.log', layer: 'cache', district: 'lagoon' },
    { tileX: 8.6, tileY: 9.4, id: 'prop.driftwood.log', layer: 'cache', district: 'lagoon' },
    // Central island shrine and restored lily pool composition. Pads and the
    // buoy sit within the four pond tiles; roots and shrine props ring the dry
    // west and south banks, clear of the avenue and bridge.
    { tileX: 15.3, tileY: 22.5, id: 'veg.standingStone.mossy', layer: 'sorted', district: 'civic' },
    { tileX: 15.4, tileY: 22.7, id: 'veg.standingStone.mossy', layer: 'sorted', district: 'civic' },
    { tileX: 14.8, tileY: 22.3, id: 'prop.runeBrazier', layer: 'cache', district: 'civic' },
    { tileX: 16.4, tileY: 21.5, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 17.3, tileY: 21.4, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 16.6, tileY: 22.4, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 17.4, tileY: 22.6, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 16.2, tileY: 21.2, id: 'veg.lilypad', layer: 'cache', district: 'civic' },
    { tileX: 17.6, tileY: 22.2, id: 'prop.harborBeaconBuoy', layer: 'cache', district: 'civic' },
    { tileX: 15.2, tileY: 22.1, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'civic' },
    { tileX: 14.6, tileY: 22.8, id: 'prop.mangroveRoot.arch', layer: 'sorted', district: 'civic' },
    { tileX: 20.4, tileY: 22.7, id: 'prop.mangroveRoot.twisted', layer: 'sorted', district: 'civic' },
    { tileX: 15.8, tileY: 22.8, id: 'prop.driftwood.log', layer: 'cache', district: 'civic' },
    { tileX: 20.6, tileY: 22.2, id: 'prop.signpost', layer: 'sorted', district: 'civic' },
    // Footbridge abutments. The north-west corner stands in the lily pond, so
    // only the dry south-east corner carries a lantern post; the sprite's own
    // post lanterns light the other three.
    { tileX: 19.4, tileY: 26.6, id: 'prop.bridgeLanternPost', layer: 'sorted', district: 'civic' },
    { tileX: 16.4, tileY: 26.9, id: 'veg.standingStone.mossy', layer: 'sorted', district: 'civic' },
    { tileX: 19.6, tileY: 22.3, id: 'veg.boulder.mossy.small', layer: 'sorted', district: 'civic' },
    { tileX: 16.3, tileY: 22.6, id: 'veg.flower.a', layer: 'cache', district: 'civic' },
    { tileX: 19.8, tileY: 22.5, id: 'veg.flower.b', layer: 'cache', district: 'civic' },
    { tileX: 16.4, tileY: 26.6, id: 'veg.flower.c', layer: 'cache', district: 'civic' },
    { tileX: 19.7, tileY: 26.7, id: 'veg.flowerBed', layer: 'cache', district: 'civic' },
    { tileX: 19.7, tileY: 26.1, id: 'prop.bridgeBannerRune', layer: 'sorted', district: 'civic' },
    // Workshop district: Code Forge approach and Forge → Task Board handoff.
    { tileX: 27.0, tileY: 30.2, id: 'prop.scrollCrates', layer: 'cache', district: 'workshop' },
    { tileX: 30.2, tileY: 28.4, id: 'prop.runestone', layer: 'sorted', district: 'workshop' },
    { tileX: 26.2, tileY: 31.5, id: 'prop.runeBrazier', layer: 'cache', district: 'workshop' },
    // Civic north promenade: Command Center → Observatory corridor.
    { tileX: 18.5, tileY: 17.5, id: 'prop.well', layer: 'cache', district: 'civic' },
    { tileX: 19.0, tileY: 18.0, id: 'prop.flowerCart', layer: 'cache', district: 'civic' },
    // Gate-avenue spine between river bridge and village gate.
    { tileX: 17.5, tileY: 30.0, id: 'prop.marketStall', layer: 'sorted', district: 'gate' },
    { tileX: 20.0, tileY: 27.5, id: 'prop.noticePillar', layer: 'sorted', district: 'gate' },
    // Mine ↔ Portal corridor along west-production-road.
    { tileX: 9.0, tileY: 31.3, id: 'prop.runestone', layer: 'sorted', district: 'arcane' },
    { tileX: 10.0, tileY: 32.0, id: 'prop.lantern', layer: 'sorted', district: 'arcane' },
    // Birdsong & Bloom (v0.16): cultivated garden plants in the lived-in
    // districts. layer 'sorted' so any that land on a footprint/path/sightline
    // are auto-culled by _buildDistrictPropSprites rather than drawn wrongly.
    { tileX: 17.0, tileY: 28.8, id: 'veg.flowerBed', layer: 'sorted', district: 'gate' },
    { tileX: 20.6, tileY: 28.2, id: 'veg.planter', layer: 'sorted', district: 'gate' },
    { tileX: 18.8, tileY: 33.2, id: 'veg.hedge', layer: 'sorted', district: 'gate' },
    { tileX: 8.4, tileY: 23.6, id: 'veg.flowerBed', layer: 'sorted', district: 'civic' },
    { tileX: 7.2, tileY: 21.4, id: 'veg.planter', layer: 'sorted', district: 'civic' },
    { tileX: 19.4, tileY: 19.8, id: 'veg.planter', layer: 'sorted', district: 'civic' },
    { tileX: 26.4, tileY: 31.2, id: 'veg.flowerBed', layer: 'sorted', district: 'workshop' },
    { tileX: 28.8, tileY: 30.2, id: 'veg.hedge', layer: 'sorted', district: 'workshop' },
];

export const AMBIENT_GROUND_PROPS = [
    // Forge/mine work yards: ore carts and lanterns clarify production/resource landmarks.
    { tileX: 24.4, tileY: 29.7, type: 'oreCart' },
    { tileX: 25.4, tileY: 29.6, type: 'lantern' },
    { tileX: 13.3, tileY: 34.7, type: 'oreCart' },
    { tileX: 9.0, tileY: 33.8, type: 'lantern' },
    { tileX: 15.5, tileY: 34.4, type: 'runestone' },
    { tileX: 21.4, tileY: 33.6, type: 'noticePillar' },

    // Civic core: utility props around the square, not scattered through the woods.
    { tileX: 15.3, tileY: 20.4, type: 'well' },
    { tileX: 12.1, tileY: 20.0, type: 'marketStall' },
    { tileX: 17.8, tileY: 19.4, type: 'signpost' },
    { tileX: 19.2, tileY: 16.0, type: 'scrollCrates' },
    { tileX: 24.8, tileY: 18.6, type: 'noticePillar' },

    // Research edges: fewer, quieter accents near knowledge landmarks.
    { tileX: 5.8, tileY: 18.9, type: 'lantern' },
    { tileX: 8.9, tileY: 16.1, type: 'scrollCrates' },
    { tileX: 9.3, tileY: 18.5, type: 'noticePillar' },
    { tileX: 22.5, tileY: 18.5, type: 'runestone' },
    { tileX: 24.5, tileY: 18.9, type: 'lantern' },
    { tileX: 26.4, tileY: 15.2, type: 'runestone' },
    { tileX: 5.6, tileY: 25.8, type: 'runestone' },
    { tileX: 15.0, tileY: 22.2, type: 'runestone' },
];

export const AMBIENT_SCENIC_POINTS = Object.freeze([
    { id: 'bridge-west', tileX: 17, tileY: 26, district: 'civic', reason: 'bridge-pause', tags: ['bridge'] },
    { id: 'bridge-east', tileX: 19, tileY: 22, district: 'civic', reason: 'bridge-pause', tags: ['bridge'] },
    { id: 'harbor-rail', tileX: 31, tileY: 23, district: 'harbor', reason: 'harbor-watch', tags: ['water'] },
    { id: 'harbor-ledger', tileX: 33, tileY: 24, district: 'harbor', reason: 'dock-ledger', tags: ['harbor'] },
    { id: 'portal-ruins', tileX: 4, tileY: 36, district: 'arcane', reason: 'portal-observe', tags: ['portal'] },
    { id: 'mine-cart', tileX: 15, tileY: 37, district: 'resource', reason: 'cart-path', tags: ['mine'] },
    { id: 'forest-edge', tileX: 25, tileY: 11, district: 'knowledge', reason: 'forest-edge', tags: ['quiet'] },
    { id: 'archive-alcove', tileX: 10, tileY: 18, district: 'knowledge', reason: 'reading-alcove', tags: ['archive'] },
    { id: 'observatory-view', tileX: 25, tileY: 19, district: 'knowledge', reason: 'skywatch', tags: ['observatory'] },
    { id: 'lighthouse-shore', tileX: 30, tileY: 15, district: 'harbor', reason: 'shore-watch', tags: ['watchtower'] },
    { id: 'plaza-corner', tileX: 20, tileY: 22, district: 'civic', reason: 'plaza-pause', tags: ['command'] },
    { id: 'forge-handoff', tileX: 27, tileY: 31, district: 'workshop', reason: 'handoff-path', tags: ['forge', 'taskboard'] },
]);

// #41 — Scenic-point storytelling props. Authored detail baked at the
// AMBIENT_SCENIC_POINTS so each loiter spot reads as an inhabited place: a
// coiled net at the harbor rail, scroll-bundles in the reading alcove, a mossy
// resting stone at the forest edge. All `layer: 'cache'` so they fold into the
// terrain bake with zero per-frame cost. `scenicPoint` links each prop to its
// point id; `tileX/tileY` are offset slightly off the loiter tile so the
// standing villager and the prop compose rather than overlap. Existing,
// manifest-validated sprite ids only — no new PNGs, so no assetVersion bump.
export const SCENIC_POINT_PROPS = [
    { scenicPoint: 'bridge-west', tileX: 16.5, tileY: 26.4, id: 'prop.lantern', layer: 'cache' },
    { scenicPoint: 'bridge-east', tileX: 19.6, tileY: 21.6, id: 'prop.lantern', layer: 'cache' },
    { scenicPoint: 'harbor-rail', tileX: 31.5, tileY: 23.4, id: 'prop.netRack', layer: 'cache' },
    { scenicPoint: 'harbor-ledger', tileX: 33.5, tileY: 24.3, id: 'prop.scrollCrates', layer: 'cache' },
    { scenicPoint: 'portal-ruins', tileX: 4.5, tileY: 35.5, id: 'prop.runestone', layer: 'cache' },
    { scenicPoint: 'mine-cart', tileX: 15.4, tileY: 36.5, id: 'prop.oreCart', layer: 'cache' },
    { scenicPoint: 'forest-edge', tileX: 25.5, tileY: 11.4, id: 'veg.standingStone.mossy', layer: 'cache' },
    { scenicPoint: 'archive-alcove', tileX: 10.4, tileY: 17.6, id: 'prop.scrollCrates', layer: 'cache' },
    { scenicPoint: 'observatory-view', tileX: 25.4, tileY: 18.5, id: 'prop.runestone', layer: 'cache' },
    { scenicPoint: 'lighthouse-shore', tileX: 29.6, tileY: 15.4, id: 'prop.driftwood.log', layer: 'cache' },
    { scenicPoint: 'plaza-corner', tileX: 20.6, tileY: 21.4, id: 'prop.flowerCart', layer: 'cache' },
    { scenicPoint: 'forge-handoff', tileX: 27.4, tileY: 32.4, id: 'prop.scrollCrates', layer: 'cache' },
];

export const GULL_FLIGHT_FRAMES = [
    'prop.gullFlight.up',
    'prop.gullFlight.level',
    'prop.gullFlight.down',
    'prop.gullFlight.level',
];
export const GULL_BANK_FRAME = 'prop.gullFlight.bank';
export const GULL_ROUTE_SPEED_SCALE = 0.52;
export const GULL_LIGHTHOUSE_HOTSPOT = { tileX: 31.4, tileY: 12.2 };
// Watchtower gull orbit: single-bird 30s loop pegged just north of the
// Pharos Lighthouse lantern (watchtower footprint sits at tile (27,8) sized
// 3x5), with the orbit centre on the sea side so the bird reads as guarding
// the beacon. Buoys flank the beacon on adjacent open-water tiles.
export const WATCHTOWER_GULL_ORBIT = Object.freeze({
    centerTileX: 28,
    centerTileY: 12,
    radiusTileX: 2.2,
    radiusTileY: 1.6,
    periodMs: 30000,
    altitudePx: 38,
});
export const WATCHTOWER_GULL_FALLBACK_TILE = Object.freeze({
    tileX: WATCHTOWER_GULL_ORBIT.centerTileX + WATCHTOWER_GULL_ORBIT.radiusTileX,
    tileY: WATCHTOWER_GULL_ORBIT.centerTileY,
});
export const WATCHTOWER_BEACON_BUOY_TILES = Object.freeze([
    { tileX: 29, tileY: 9 },
    { tileX: 30, tileY: 11 },
]);
export const GULL_OFFMAP_GATEWAYS = [
    { tileX: -4.8, tileY: 24.8 },
    { tileX: 7.2, tileY: -4.6 },
    { tileX: 22.8, tileY: -5.2 },
    { tileX: 43.8, tileY: 4.8 },
    { tileX: 45.2, tileY: 17.6 },
    { tileX: 43.6, tileY: 34.4 },
    { tileX: 28.2, tileY: 44.6 },
    { tileX: 3.8, tileY: 43.8 },
];
export const GULL_STAGING_WAYPOINTS = [
    { tileX: 10.8, tileY: 7.8 },
    { tileX: 19.8, tileY: 9.8 },
    { tileX: 27.4, tileY: 8.2 },
    { tileX: 36.0, tileY: 10.4 },
    { tileX: 35.8, tileY: 23.8 },
    { tileX: 23.4, tileY: 24.8 },
    { tileX: 9.8, tileY: 24.8 },
    { tileX: 34.0, tileY: 29.4 },
    { tileX: 7.4, tileY: 8.6 },
    { tileX: 14.0, tileY: 9.6 },
];
export const OPEN_SEA_FLOCK_FORMATION = [
    { side: 0.00, trail: 0.00 },
    { side: -0.42, trail: 0.36 },
    { side: 0.42, trail: 0.36 },
    { side: -0.82, trail: 0.78 },
    { side: 0.82, trail: 0.78 },
    { side: -1.18, trail: 1.22 },
    { side: 1.18, trail: 1.22 },
    { side: -0.30, trail: 1.58 },
    { side: 0.30, trail: 1.58 },
    { side: 0.00, trail: 1.92 },
];
export const OPEN_SEA_FLOCK_ROUTES = [
    {
        size: 8,
        altitude: 38,
        phase: 0.02,
        speed: 0.032,
        wingRate: 3.6,
        route: [
            { tileX: 37.2, tileY: 5.4 },
            { tileX: 33.2, tileY: 2.8 },
            { tileX: 28.7, tileY: 4.8 },
            { tileX: 31.8, tileY: 8.8 },
            { tileX: 37.6, tileY: 9.4 },
        ],
    },
    {
        size: 9,
        altitude: 31,
        phase: 0.24,
        speed: 0.026,
        wingRate: 3.1,
        route: [
            { tileX: 38.4, tileY: 6.2 },
            { tileX: 35.6, tileY: 12.6 },
            { tileX: 37.6, tileY: 17.4 },
            { tileX: 35.2, tileY: 24.8 },
            { tileX: 37.5, tileY: 31.4 },
            { tileX: 39.1, tileY: 20.8 },
        ],
    },
    {
        size: 7,
        altitude: 27,
        phase: 0.47,
        speed: 0.038,
        wingRate: 4.0,
        route: [
            { tileX: 31.6, tileY: 24.7 },
            { tileX: 35.6, tileY: 25.6 },
            { tileX: 38.2, tileY: 28.6 },
            { tileX: 36.0, tileY: 32.6 },
            { tileX: 33.0, tileY: 27.4 },
        ],
    },
    {
        size: 8,
        altitude: 24,
        phase: 0.69,
        speed: 0.021,
        wingRate: 2.9,
        route: [
            { tileX: 2.4, tileY: 25.0 },
            { tileX: 9.0, tileY: 24.8 },
            { tileX: 17.2, tileY: 25.2 },
            { tileX: 25.8, tileY: 24.4 },
            { tileX: 32.8, tileY: 24.4 },
            { tileX: 37.8, tileY: 25.8 },
        ],
    },
    {
        size: 6,
        altitude: 34,
        phase: 0.86,
        speed: 0.024,
        wingRate: 3.4,
        route: [
            { tileX: 7.6, tileY: 8.4 },
            { tileX: 12.3, tileY: 5.4 },
            { tileX: 17.4, tileY: 9.8 },
            { tileX: 24.8, tileY: 7.5 },
            { tileX: 31.0, tileY: 5.0 },
            { tileX: 36.8, tileY: 8.2 },
        ],
    },
    {
        size: 5,
        altitude: 22,
        phase: 0.13,
        speed: 0.024,
        wingRate: 3.4,
        route: [
            { tileX: 6.4, tileY: 9.6 },
            { tileX: 11.2, tileY: 7.2 },
            { tileX: 16.4, tileY: 9.0 },
            { tileX: 13.0, tileY: 11.4 },
            { tileX: 8.0, tileY: 11.2 },
        ],
    },
];

export const MARINE_FISH_SCHOOLS = [
    { tileX: 30.8, tileY: 23.1, id: 'prop.fishSchoolTeal', radius: 0.34, phase: 0.1 },
    { tileX: 35.4, tileY: 14.5, id: 'prop.fishSchoolTeal', radius: 0.32, phase: 2.1 },
    { tileX: 18.2, tileY: 10.4, id: 'prop.fishSchoolTeal', radius: 0.22, phase: 3.6 },
    { tileX: 36.6, tileY: 24.0, id: 'prop.fishSchoolTeal', radius: 0.26, phase: 5.2 },
    { tileX: 17.0, tileY: 22.0, id: 'prop.fishSchoolKoi', radius: 0.20, phase: 1.4 },
];

// Birdsong & Bloom (v0.16): land + water fauna.
// Songbirds flit on small looping flight paths between the trees of the
// inhabited belt. `points` are tile waypoints; the loop closes automatically.
export const LAND_BIRD_ROUTES = [
    { speed: 0.020, altitude: 28, phase: 0.00, wingRate: 6, points: [
        { tileX: 14, tileY: 19 }, { tileX: 17, tileY: 17.5 }, { tileX: 19.5, tileY: 19.5 }, { tileX: 16, tileY: 22 } ] },
    { speed: 0.016, altitude: 24, phase: 0.40, wingRate: 5, points: [
        { tileX: 8, tileY: 20 }, { tileX: 10.5, tileY: 22 }, { tileX: 7, tileY: 24 }, { tileX: 5.5, tileY: 21 } ] },
    { speed: 0.023, altitude: 30, phase: 0.72, wingRate: 7, points: [
        { tileX: 25, tileY: 30 }, { tileX: 28.5, tileY: 28.5 }, { tileX: 27, tileY: 32 }, { tileX: 24, tileY: 31 } ] },
];

// Ducks drifting on calm lagoon water (central lily basin + NW lagoon).
export const CALM_WATER_FAUNA = [
    { tileX: 16.6, tileY: 22.2, id: 'prop.duck', radius: 0.16, phase: 0.3 },
    { tileX: 17.6, tileY: 21.6, id: 'prop.duck', radius: 0.14, phase: 2.1 },
    { tileX: 13.2, tileY: 8.2, id: 'prop.duck', radius: 0.18, phase: 4.0 },
    { tileX: 14.8, tileY: 9.0, id: 'prop.duck', radius: 0.13, phase: 1.2 },
];

// Herons wading at the shoreline (mostly still, gentle bob).
export const SHORE_FAUNA = [
    { tileX: 11.4, tileY: 10.6, id: 'prop.heron' },
    { tileX: 6.4, tileY: 9.0, id: 'prop.heron' },
];

// Density thresholds for noise-driven flat features.
// `BUSH_DENSITY` and `GRASS_TUFT_DENSITY` are noise thresholds in [0, 1] —
// a tile becomes a bush/tuft when its noise value falls in the band.
// Tuned to roughly match the existing 'flowers'/'mushrooms' densities.
export const BUSH_DENSITY = { min: 0.05, max: 0.13 };
export const GRASS_TUFT_DENSITY = { min: 0.18, max: 0.30 };
// Flower-clump scatter. Sparse base everywhere (a light meadow dusting), much
// denser where VEGETATION_DISTRICTS set a `flowerBoost`. Flowers are flat and
// never block building sightlines, so they fill the lived-in zone safely.
export const FLOWER_DENSITY = { min: 0.02, max: 0.075 };
