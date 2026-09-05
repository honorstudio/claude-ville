import {
    buildStableGpuBatches,
    clampGpuLights,
    createGpuTimingMetricsScratch,
    effectBudgetMode,
    shedEffectsForLevel,
    emissivePhaseForAmbientLight,
    estimateGpuWorldTextureBytes,
    gpuLightColorForShader,
    localLightPhaseForLighting,
    selectGpuTimingMetrics,
    WORLD_PHASE_GRADES,
} from './GpuWorldPolicy.js';
import {
    createPostFxLadder,
    POST_FX_LEVELS,
} from '../postfx/PostFxLadder.js';
import { glslMaterialWeatherFunctions } from '../MaterialRegistry.js';
import { growTypedArray } from '../AssetManager.js';

const MAX_LIGHTS = 32;
const VERTEX_FLOATS = 10;
const VERTEX_STRIDE = VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const BLOOM_SCALE = 0.375;
const OCCLUSION_SCALE = 0.375;
const EMA_ALPHA = 0.1;
const MAX_CACHED_TEXTURE_BYTES = 48 * 1024 * 1024;
const MAX_CACHED_TEXTURES = 512;
const LOCAL_LIGHT_VISIBILITY_FLOOR = 0.04;
const DEFAULT_LIGHT_COLOR = Object.freeze([1, 0.78, 0.42]);
const GPU_PASS_NAMES = ['upload', 'occlusion', 'scene', 'bloom', 'present'];
const PASS_RING_CAPACITY = 32;

function writeGpuVertex(vertices, offset, x, y, u, v, record) {
    vertices[offset++] = x;
    vertices[offset++] = y;
    vertices[offset++] = u;
    vertices[offset++] = v;
    vertices[offset++] = record.alpha;
    vertices[offset++] = record.material;
    vertices[offset++] = record.elevation;
    vertices[offset++] = record.emissive;
    vertices[offset++] = record.occluder;
    vertices[offset++] = record.emissiveGate ?? 1;
    return offset;
}

function writeGpuRecordVertices(vertices, offset, record) {
    const x0 = record.x;
    const y0 = record.y;
    const x1 = x0 + record.width;
    const y1 = y0 + record.height;
    const u0 = record.sx / record.sourceWidth;
    const v0 = record.sy / record.sourceHeight;
    const u1 = (record.sx + record.sw) / record.sourceWidth;
    const v1 = (record.sy + record.sh) / record.sourceHeight;
    offset = writeGpuVertex(vertices, offset, x0, y0, u0, v0, record);
    offset = writeGpuVertex(vertices, offset, x1, y0, u1, v0, record);
    offset = writeGpuVertex(vertices, offset, x0, y1, u0, v1, record);
    offset = writeGpuVertex(vertices, offset, x0, y1, u0, v1, record);
    offset = writeGpuVertex(vertices, offset, x1, y0, u1, v0, record);
    offset = writeGpuVertex(vertices, offset, x1, y1, u1, v1, record);
    return offset;
}

const QUAD_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_world;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_meta;
layout(location = 3) in float a_occluder;
layout(location = 4) in float a_gate;
uniform vec3 u_camera;
uniform vec2 u_resolution;
out vec2 v_uv;
out vec2 v_world;
out float v_alpha;
out float v_material;
out float v_elevation;
out float v_emissive;
out float v_occluder;
out float v_gate;
void main() {
    vec2 screen = (a_world + u_camera.xy) * u_camera.z;
    vec2 clip = vec2(
        screen.x / max(1.0, u_resolution.x) * 2.0 - 1.0,
        1.0 - screen.y / max(1.0, u_resolution.y) * 2.0
    );
    gl_Position = vec4(clip, 0.0, 1.0);
    v_uv = a_uv;
    v_world = a_world;
    v_alpha = a_meta.x;
    v_material = a_meta.y;
    v_elevation = a_meta.z;
    v_emissive = a_meta.w;
    v_occluder = a_occluder;
    v_gate = a_gate;
}`;

const SCENE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_world;
in float v_alpha;
in float v_material;
in float v_elevation;
in float v_emissive;
in float v_gate;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outEmission;
uniform sampler2D u_albedo;
uniform sampler2D u_materialMap;
uniform sampler2D u_emissiveMap;
uniform sampler2D u_occlusion;
uniform bool u_hasMaterialMap;
uniform sampler2D u_occluderMap;
uniform bool u_hasOccluderMap;
uniform bool u_hasEmissiveMap;
uniform vec2 u_resolution;
uniform vec2 u_occlusionResolution;
uniform vec3 u_gradeBase;
uniform vec3 u_gradeEdge;
uniform float u_edgeAlpha;
uniform vec3 u_fogColor;
uniform vec4 u_weather;
uniform vec4 u_sun;
uniform vec4 u_cloudShadow[3];
uniform float u_time;
uniform float u_motionScale;
uniform bool u_useOcclusion;
uniform int u_lightCount;
uniform vec4 u_lights[32];
uniform vec4 u_lightColors[32];

float materialNear(float value, float target) {
    return 1.0 - step(0.45, abs(value - target));
}

float occlusionBetween(vec2 fromPx, vec2 toPx, float elevation) {
    vec2 fromUv = fromPx / max(vec2(1.0), u_resolution);
    vec2 toUv = toPx / max(vec2(1.0), u_resolution);
    float blocked = 0.0;
    // Three samples keep the stepped pixel-art shadow read while avoiding the
    // previous five texture fetches for every admitted light and scene pixel.
    for (int stepIndex = 1; stepIndex <= 3; stepIndex++) {
        float t = float(stepIndex) / 4.0;
        vec2 uv = mix(fromUv, toUv, t);
        vec4 occluder = texture(u_occlusion, clamp(uv, vec2(0.0), vec2(1.0)));
        // Treat the light as ground-level and descend the receiver-to-light
        // ray through the existing three samples. A short occluder can then
        // block a low receiver without incorrectly shadowing a taller one.
        float rayHeight = mix(elevation, 0.0, t);
        float heightBlock = smoothstep(rayHeight + 0.03, rayHeight + 0.18, occluder.r);
        blocked = max(blocked, heightBlock * occluder.a);
    }
    return blocked;
}

${glslMaterialWeatherFunctions()}

float orderedDither4(vec2 px) {
    return mod(floor(px.x) + 2.0 * floor(px.y), 4.0) / 3.0;
}

vec3 applyMaterialWeather(vec3 color, float material, vec2 px) {
    float rain = u_weather.x;
    float wetness = materialWetness(material);
    float reflection = materialReflection(material);
    float foliage = materialNear(material, 4.0);
    float phase = u_motionScale <= 0.0 ? 0.37 : u_time * 0.001 * u_motionScale;
    float ordered = orderedDither4(px);
    float wet = rain * wetness;
    color *= mix(1.0, 0.80, wet);
    color = mix(color, color * vec3(0.82, 0.94, 1.08), wet * 0.24);
    float glint = step(0.86, fract((px.x + px.y * 0.5) * 0.031 + phase * 0.07 + ordered * 0.08));
    color += vec3(0.22, 0.30, 0.34) * glint * wet * reflection * 0.16;
    color = mix(color, color * vec3(0.86, 0.94, 0.82), rain * foliage * 0.12);
    return color;
}

vec3 applyWaterState(vec3 color, vec2 px) {
    float phase = u_motionScale <= 0.0 ? 0.0 : floor(u_time * 0.004 * u_motionScale);
    float storm = step(0.5, u_weather.z);
    vec2 calmCell = floor(px / 3.0);
    vec2 roughCell = floor(px / 2.0);
    float calmCourse = mod(calmCell.x + 2.0 * calmCell.y + phase, 4.0);
    float roughCourse = mod(3.0 * roughCell.x + roughCell.y + phase * 2.0, 4.0);
    float shimmer = step(2.0, mix(calmCourse, roughCourse, storm));
    float contrast = mix(0.07, 0.13, storm);
    vec3 phaseTint = mix(vec3(0.82, 0.94, 1.08), u_gradeBase, 0.22);
    return color * phaseTint * mix(1.0 - contrast, 1.0 + contrast, shimmer);
}

vec3 applyAuthoredSunBand(vec3 color, float material) {
    float response = 0.36;
    response = mix(response, 0.62, materialNear(material, 1.0));
    response = mix(response, 0.48, materialNear(material, 2.0));
    response = mix(response, 0.82, materialNear(material, 3.0));
    response = mix(response, 0.56, materialNear(material, 4.0));
    response = mix(response, 0.42, materialNear(material, 5.0));
    response = mix(response, 0.58, materialNear(material, 7.0));
    response = mix(response, 0.24, materialNear(material, 8.0));
    float keyFacing = clamp(0.5 + (-u_sun.x - u_sun.y) * 0.25, 0.0, 1.0);
    float rawBand = 0.84 + response * (0.12 + keyFacing * 0.12);
    // Two restrained material-wide bands preserve the baked upper-left key.
    float quantized = rawBand < 0.93 ? 0.86 : 1.0;
    return color * mix(1.0, quantized, clamp(u_sun.w, 0.0, 1.0));
}

vec3 applyGrade(vec3 color, vec2 topLeftPx, float material) {
    vec2 centre = vec2(u_resolution.x * 0.5, u_resolution.y * 0.46);
    float inner = min(u_resolution.x, u_resolution.y) * 0.18;
    float outer = max(u_resolution.x, u_resolution.y) * 0.72;
    float t = clamp((distance(topLeftPx, centre) - inner) / max(1.0, outer - inner), 0.0, 1.0);
    float edge = u_edgeAlpha * (
        step(0.62, t) * 0.4
        + step(0.84, t) * 0.6
    );
    color *= u_gradeBase;
    color *= mix(vec3(1.0), u_gradeEdge, edge);
    float cloudReceiver = max(
        materialNear(material, 4.0),
        max(materialNear(material, 6.0), materialNear(material, 7.0))
    );
    for (int i = 0; i < 3; i++) {
        vec4 shadow = u_cloudShadow[i];
        if (shadow.w <= 0.0) continue;
        vec2 delta = (topLeftPx - shadow.xy) / vec2(max(1.0, shadow.z), max(1.0, shadow.z * 0.5));
        float distanceSquared = dot(delta, delta);
        float course = step(distanceSquared, 1.0) * 0.34
            + step(distanceSquared, 0.49) * 0.33
            + step(distanceSquared, 0.16) * 0.33;
        color *= 1.0 - shadow.w * course * cloudReceiver;
    }
    return color;
}

void main() {
    vec4 albedo = texture(u_albedo, v_uv);
    float alpha = albedo.a * v_alpha;
    if (alpha < 0.01) discard;
    vec4 sidecar = u_hasMaterialMap ? texture(u_materialMap, v_uv) : vec4(0.0);
    vec4 authoredEmission = u_hasEmissiveMap ? texture(u_emissiveMap, v_uv) : vec4(0.0);
    float material = sidecar.a > 0.0 ? floor(sidecar.r * 255.0 + 0.5) : v_material;
    float emissive = max(v_emissive, sidecar.g * 2.0);
    vec3 emissionColor = albedo.rgb;
    if (u_hasEmissiveMap) {
        // The emissive channel owns both hue (RGB) and contribution (A). Do
        // not reconstruct authored emission from the albedo texture.
        emissionColor = authoredEmission.rgb;
        emissive = authoredEmission.a * 2.0 * clamp(v_gate, 0.0, 1.0);
    } else if (u_hasMaterialMap) {
        // A material map without an authored emissive channel is explicitly
        // non-emissive; never infer a glow from its albedo pixels.
        emissionColor = vec3(0.0);
        emissive = 0.0;
    }
    // Authored emitters remain identifiable in daylight without behaving like
    // night-time floodlights. Ambient light falls through dusk/night, smoothly
    // restoring their full energy when illumination is actually needed.
    float emissivePhase = mix(0.12, 1.0, 1.0 - clamp(u_sun.w, 0.0, 1.0));
    emissive *= emissivePhase;
    vec4 geometry = u_hasOccluderMap ? texture(u_occluderMap, v_uv) : vec4(0.0);
    float elevation = geometry.a > 0.0 ? geometry.r : v_elevation;
    vec2 px = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
    vec2 glPx = gl_FragCoord.xy;
    vec3 color = albedo.rgb;
    // Clear weather is the overwhelmingly common case. Avoid the ordered
    // glint/material classification work when every weather contribution is
    // mathematically zero; rainy output remains byte-for-byte equivalent.
    if (u_weather.x > 0.001) color = applyMaterialWeather(color, material, v_world);
    if (materialNear(material, 8.0) > 0.5) color = applyWaterState(color, v_world);
    color = applyAuthoredSunBand(color, material);
    color = applyGrade(color, px, material);

    for (int i = 0; i < 32; i++) {
        if (i >= u_lightCount) break;
        vec4 light = u_lights[i];
        float radius = max(1.0, light.z);
        float distanceToLight = distance(glPx, light.xy);
        if (distanceToLight >= radius) continue;
        float falloff = 1.0 - smoothstep(0.0, radius, distanceToLight);
        float blocked = u_useOcclusion ? occlusionBetween(glPx, light.xy, elevation) : 0.0;
        float amount = falloff * light.w * (1.0 - blocked * 0.88);
        color += u_lightColors[i].rgb * amount * u_lightColors[i].a * 0.34;
        float waterReceiver = materialNear(material, 8.0);
        float reflectionX = 1.0 - smoothstep(0.0, radius * 0.30, abs(glPx.x - light.x));
        float reflectionY = 1.0 - smoothstep(0.0, radius * 1.70, abs(glPx.y - light.y));
        float reflectionCourse = step(0.52, fract((floor(v_world.x) + floor(v_world.y) * 0.5) * 0.125));
        color += u_lightColors[i].rgb * waterReceiver * reflectionX * reflectionY
            * reflectionCourse * light.w * u_lightColors[i].a * 0.10;
    }

    float fog = clamp(u_weather.y, 0.0, 1.0);
    float groundFog = fog * (1.0 - elevation * 0.72) * smoothstep(0.18, 0.98, gl_FragCoord.y / max(1.0, u_resolution.y));
    color = mix(color, u_fogColor, groundFog * 0.48);
    vec3 emission = emissionColor * emissive;
    color += emission * 0.42;
    outColor = vec4(max(color, vec3(0.0)) * alpha, alpha);
    outEmission = vec4(emission * alpha, alpha > 0.0 ? 1.0 : 0.0);
}`;

const OCCLUSION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_alpha;
in float v_elevation;
uniform sampler2D u_albedo;
uniform sampler2D u_materialMap;
uniform bool u_hasMaterialMap;
uniform sampler2D u_occluderMap;
uniform bool u_hasOccluderMap;
in float v_occluder;
layout(location = 0) out vec4 outColor;
void main() {
    float alpha = texture(u_albedo, v_uv).a * v_alpha;
    if (alpha < 0.05) discard;
    vec4 sidecar = u_hasMaterialMap ? texture(u_materialMap, v_uv) : vec4(0.0);
    // Height and strength are independent: authored strength attenuates the
    // trace in the target alpha channel and never lowers the height itself.
    vec4 geometry = u_hasOccluderMap ? texture(u_occluderMap, v_uv) : vec4(0.0);
    float height = geometry.a > 0.0 ? geometry.r : v_elevation;
    float strength = geometry.a > 0.0 ? geometry.g : v_occluder;
    outColor = vec4(height * alpha, 0.0, 0.0, strength * alpha);
}`;

const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
const vec2 UV[3] = vec2[](vec2(0.0,0.0), vec2(2.0,0.0), vec2(0.0,2.0));
out vec2 v_uv;
void main() {
    gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
    v_uv = UV[gl_VertexID];
}`;

const BLOOM_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 outColor;
uniform sampler2D u_input;
uniform vec2 u_texel;
uniform bool u_blur;
vec4 sampleAt(vec2 uv) { return texture(u_input, clamp(uv, vec2(0.0), vec2(1.0))); }
void main() {
    if (!u_blur) {
        vec4 sum = vec4(0.0);
        for (int x = -1; x <= 1; x++) {
            for (int y = -1; y <= 1; y++) {
                sum += sampleAt(v_uv + vec2(float(x), float(y)) * u_texel * 2.0);
            }
        }
        outColor = sum / 9.0;
        return;
    }
    vec4 sum = sampleAt(v_uv) * 0.20;
    sum += sampleAt(v_uv + vec2( 1.0, 1.0) * u_texel * 2.0) * 0.20;
    sum += sampleAt(v_uv + vec2(-1.0, 1.0) * u_texel * 2.0) * 0.20;
    sum += sampleAt(v_uv + vec2( 1.0,-1.0) * u_texel * 2.0) * 0.20;
    sum += sampleAt(v_uv + vec2(-1.0,-1.0) * u_texel * 2.0) * 0.20;
    outColor = sum;
}`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 outColor;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
void main() {
    vec4 scene = texture(u_scene, clamp(v_uv, vec2(0.0), vec2(1.0)));
    vec3 bloom = texture(u_bloom, clamp(v_uv, vec2(0.0), vec2(1.0))).rgb;
    vec3 color = scene.rgb + bloom * u_bloomStrength;
    outColor = vec4(color, scene.a);
}`;

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function ema(previous, sample) {
    const value = Math.max(0, finite(sample));
    return previous == null ? value : previous + (value - previous) * EMA_ALPHA;
}

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || 'unknown shader error';
        gl.deleteShader(shader);
        throw new Error(message);
    }
    return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const message = gl.getProgramInfoLog(program) || 'unknown program link error';
        gl.deleteProgram(program);
        throw new Error(message);
    }
    return program;
}

function uniformLocations(gl, program, names) {
    return names.reduce((out, name) => {
        out[name] = gl.getUniformLocation(program, name);
        return out;
    }, {});
}

function phaseGrade(feed = {}) {
    const phase = String(feed.phase || feed.atmosphere?.phase || 'day').toLowerCase();
    return WORLD_PHASE_GRADES[phase] || WORLD_PHASE_GRADES.day;
}

function weatherUniform(feed = {}) {
    const weather = feed.weather || feed.atmosphere?.weather || {};
    const type = String(weather.type || 'clear');
    const rainy = type === 'rain' || type === 'storm' || type === 'overcast';
    return [
        rainy ? clamp(finite(weather.precipitation, weather.intensity), 0, 1) : 0,
        clamp(finite(weather.fog, type === 'storm' ? 0.35 : 0), 0, 1),
        type === 'storm' ? 1 : 0,
        clamp(finite(weather.intensity), 0, 1),
    ];
}

function writeCloudShadowUniforms(target, ranked, feed, width, height) {
    target.fill(0);
    ranked.fill(null);
    const atmosphere = feed.atmosphere || {};
    const layers = atmosphere.sky?.cloudLayers;
    const cloudCover = clamp(finite(atmosphere.weather?.cloudCover), 0, 1);
    if (!Array.isArray(layers) || !layers.length || cloudCover <= 0.04) return target;

    for (let index = 0; index < layers.length; index++) {
        const layer = layers[index];
        const scale = finite(layer?.scale);
        for (let slot = 0; slot < ranked.length; slot++) {
            if (ranked[slot] && finite(ranked[slot].scale) >= scale) continue;
            for (let shift = ranked.length - 1; shift > slot; shift--) ranked[shift] = ranked[shift - 1];
            ranked[slot] = layer;
            break;
        }
    }

    const span = Math.max(1, width + height);
    const windX = finite(atmosphere.motion?.windX, 1);
    const driftTime = feed.reducedMotion || finite(feed.motionScale, 1) <= 0
        ? 0
        : finite(feed.timeMs) * 0.012;
    for (let slot = 0; slot < ranked.length; slot++) {
        const layer = ranked[slot];
        if (!layer) continue;
        const parallax = finite(layer.parallax, 0.5);
        const rawX = finite(layer.xFrac) * span + windX * driftTime * parallax;
        const wrappedX = ((rawX % span) + span) % span;
        const offset = slot * 4;
        target[offset] = wrappedX - height * 0.5;
        target[offset + 1] = finite(layer.yFrac, 0.3) * height;
        target[offset + 2] = Math.max(48, finite(layer.scale, 1) * width * 0.22);
        target[offset + 3] = 0.12 * cloudCover * (0.6 + finite(layer.alpha, 0.3));
    }
    return target;
}

export class GpuWorldRenderer {
    constructor(canvas, { enabled = true } = {}) {
        this.canvas = canvas || null;
        this.enabled = Boolean(enabled);
        this.supported = false;
        this.contextHealthy = false;
        this.disposed = false;
        this.suspended = false;
        this.width = Math.max(1, Math.floor(canvas?.width || 1));
        this.height = Math.max(1, Math.floor(canvas?.height || 1));
        this.frames = 0;
        this.records = 0;
        this.batches = 0;
        this.lightCount = 0;
        this.emissivePhase = 0.12;
        this.localLightPhase = 0;
        this.uploadMs = null;
        this.cpuMs = null;
        this.shaderCpuMs = null;
        this.gpuMs = null;
        this.timerExtension = null;
        this.pendingGpuQueries = [];
        this.passSamplingEnabled = false;
        this._passCursor = 0;
        this._sampledPass = null;
        this._activePassQuery = null;
        this.gpuDisjointDiscards = 0;
        this._passStarted = 0;
        this._passUploadBytes = 0;
        this._passResults = Object.fromEntries(GPU_PASS_NAMES.map(name => [name, {
            samples: new Array(PASS_RING_CAPACITY).fill(null),
            count: 0, next: 0, gpuSum: 0, gpuCount: 0, cpuSum: 0, latest: null,
        }]));
        this.qualityTimingSource = 'cpu-fallback';
        this._qualityTimingScratch = createGpuTimingMetricsScratch();
        this._qualityTimingInput = {
            uploadMs: 0,
            shaderCpuMs: 0,
            gpuMs: null,
            gpuTimerSupported: false,
            frameGapMs: 0,
        };
        this.gpuTimerErrors = 0;
        this.frameGapMs = null;
        this.uploads = 0;
        this.uploadBytes = 0;
        this.textureBytes = 0;
        this.textureEvictions = 0;
        this.qualityLadder = createPostFxLadder({
            budgetMs: 4,
            healthyMs: 2,
            overBudgetFrames: 12,
            probeMs: 1500,
        });
        // Shader compilation and first-use texture uploads happen together on
        // a fresh context. Begin with optional occlusion/bloom shed, then let
        // the normal healthy probes restore REDUCED and FULL within ~3 seconds.
        this.qualityLadder.reset(POST_FX_LEVELS.MINIMAL);
        this._frameUploadMs = 0;
        this._lastRenderAtMs = null;
        this._textureEntries = new Map();
        this._cachedTextureBytes = 0;
        this._textureCacheNeedsTrim = false;
        this._lastTextureTrimFrame = 0;
        this._vertexScratch = new Float32Array(64);
        this._vertexScratchUsed = 0;
        this.vertexBufferBytes = 0;
        this._batchScratch = [];
        this._normalizedRecordScratch = [];
        this._lightAdmissionCache = { source: null, sourceLength: 0, ranked: [], admitted: [], snapshots: [] };
        this._singleLightColorScratch = [0, 0, 0];
        this._lightScratch = new Float32Array(MAX_LIGHTS * 4);
        this._lightColorScratch = new Float32Array(MAX_LIGHTS * 4);
        this._cloudShadowScratch = new Float32Array(12);
        this._cloudShadowLayers = [null, null, null];
        this._occlusionRecords = [];
        this._occlusionBatch = {
            key: '',
            source: null,
            materialSource: null,
            emissiveSource: null,
            textureKey: '',
            sidecarKey: '',
            blend: 'normal',
            records: this._occlusionRecords,
        };
        this._sourceCensus = {
            atlasRecords: 0,
            individualRecords: 0,
            batchCount: 0,
            uploadBytes: 0,
        };
        this._renderErrorLogged = false;
        this._onContextLost = event => {
            event.preventDefault();
            this.contextHealthy = false;
            // A restored WebGL context has a new object namespace. Forget old
            // handles without deleting them; delete* on the restored context
            // produces INVALID_OPERATION warnings for every stale object.
            this._abandonGpuResources();
        };
        this._onContextRestored = () => {
            if (this.disposed) return;
            if (this.suspended) {
                this.contextHealthy = true;
                return;
            }
            try {
                this._initResources();
                this.resize(this.width, this.height);
                this.contextHealthy = true;
            } catch (error) {
                console.warn('[GpuWorldRenderer] context restore failed:', error);
                this.contextHealthy = false;
            }
        };

        if (!canvas?.getContext) return;
        canvas.addEventListener?.('webglcontextlost', this._onContextLost, false);
        canvas.addEventListener?.('webglcontextrestored', this._onContextRestored, false);
        try {
            this.gl = canvas.getContext('webgl2', {
                alpha: true,
                premultipliedAlpha: true,
                antialias: false,
                preserveDrawingBuffer: false,
            });
            if (!this.gl) return;
            this.supported = true;
            this.contextHealthy = true;
            this._initResources();
            this.resize(this.width, this.height);
        } catch (error) {
            console.warn('[GpuWorldRenderer] initialization failed:', error);
            this.contextHealthy = false;
        }
    }

    _initResources() {
        const gl = this.gl;
        this._releaseGpuResources();
        this.sceneProgram = createProgram(gl, QUAD_VERTEX, SCENE_FRAGMENT);
        this.occlusionProgram = createProgram(gl, QUAD_VERTEX, OCCLUSION_FRAGMENT);
        this.bloomProgram = createProgram(gl, FULLSCREEN_VERTEX, BLOOM_FRAGMENT);
        this.compositeProgram = createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
        this.timerExtension = gl.getExtension?.('EXT_disjoint_timer_query_webgl2') || null;
        this.sceneUniforms = uniformLocations(gl, this.sceneProgram, [
            'u_camera', 'u_resolution', 'u_albedo', 'u_materialMap', 'u_emissiveMap', 'u_occlusion',
            'u_hasMaterialMap', 'u_occluderMap', 'u_hasOccluderMap', 'u_hasEmissiveMap', 'u_occlusionResolution', 'u_gradeBase', 'u_gradeEdge',
            'u_edgeAlpha', 'u_fogColor', 'u_weather', 'u_time', 'u_motionScale',
            'u_sun', 'u_cloudShadow[0]',
            'u_lightCount', 'u_lights[0]', 'u_lightColors[0]',
            'u_useOcclusion',
        ]);
        this.occlusionUniforms = uniformLocations(gl, this.occlusionProgram, [
            'u_camera', 'u_resolution', 'u_albedo', 'u_materialMap',
            'u_hasMaterialMap', 'u_occluderMap', 'u_hasOccluderMap',
        ]);
        this.bloomUniforms = uniformLocations(gl, this.bloomProgram, ['u_input', 'u_texel', 'u_blur']);
        this.compositeUniforms = uniformLocations(gl, this.compositeProgram, [
            'u_scene', 'u_bloom', 'u_bloomStrength',
        ]);
        this.vao = gl.createVertexArray();
        this.vertexBuffer = gl.createBuffer();
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, VERTEX_STRIDE, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, VERTEX_STRIDE, 2 * Float32Array.BYTES_PER_ELEMENT);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, VERTEX_STRIDE, 4 * Float32Array.BYTES_PER_ELEMENT);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 1, gl.FLOAT, false, VERTEX_STRIDE, 8 * Float32Array.BYTES_PER_ELEMENT);
        gl.enableVertexAttribArray(4);
        gl.vertexAttribPointer(4, 1, gl.FLOAT, false, VERTEX_STRIDE, 9 * Float32Array.BYTES_PER_ELEMENT);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        this.emptyMaterialTexture = this._createTexture(1, 1, {
            data: new Uint8Array([0, 0, 0, 0]),
            filter: gl.NEAREST,
        });
        this._textureEntries.clear();
    }

    _createTexture(width, height, { data = null, filter = null } = {}) {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const sampling = filter ?? gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sampling);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampling);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return texture;
    }

    _createTarget(width, height, { attachments = 1, filter = null } = {}) {
        const gl = this.gl;
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        const textures = [];
        const drawBuffers = [];
        for (let index = 0; index < attachments; index++) {
            const texture = this._createTexture(width, height, { filter });
            textures.push(texture);
            const attachment = gl.COLOR_ATTACHMENT0 + index;
            gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, texture, 0);
            drawBuffers.push(attachment);
        }
        gl.drawBuffers(drawBuffers);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            for (const texture of textures) gl.deleteTexture(texture);
            gl.deleteFramebuffer(framebuffer);
            throw new Error('GPU world framebuffer is incomplete');
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { framebuffer, textures, width, height, attachments };
    }

    _releaseTarget(target) {
        if (!target || !this.gl) return;
        this.gl.deleteFramebuffer(target.framebuffer);
        for (const texture of target.textures || []) this.gl.deleteTexture(texture);
    }

    _releaseGpuResources() {
        const gl = this.gl;
        if (!gl) return;
        if (gl.isContextLost?.()) {
            this._abandonGpuResources();
            return;
        }
        for (const sample of this.pendingGpuQueries) gl.deleteQuery?.(sample.query);
        this.pendingGpuQueries.length = 0;
        this.timerExtension = null;
        this._releaseTarget(this.sceneTarget);
        this._releaseTarget(this.bloomA);
        this._releaseTarget(this.bloomB);
        this._releaseTarget(this.occlusionTarget);
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
        this.occlusionTarget = null;
        for (const entry of this._textureEntries?.values?.() || []) {
            if (entry.texture) gl.deleteTexture(entry.texture);
        }
        this._textureEntries?.clear?.();
        this._cachedTextureBytes = 0;
        this._textureCacheNeedsTrim = false;
        if (this.emptyMaterialTexture) gl.deleteTexture(this.emptyMaterialTexture);
        if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
        if (this.vao) gl.deleteVertexArray(this.vao);
        for (const program of [this.sceneProgram, this.occlusionProgram, this.bloomProgram, this.compositeProgram]) {
            if (program) gl.deleteProgram(program);
        }
        this.emptyMaterialTexture = null;
        this.vertexBuffer = null;
        this.vao = null;
        this.sceneProgram = null;
        this.occlusionProgram = null;
        this.bloomProgram = null;
        this.compositeProgram = null;
        // The next _initResources creates a zero-size VBO; a stale capacity
        // here would make _uploadVertices skip its bufferData allocation and
        // leave every draw without geometry after suspend/resume.
        this.vertexBufferBytes = 0;
    }

    _abandonGpuResources() {
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
        this.occlusionTarget = null;
        this._textureEntries?.clear?.();
        this.emptyMaterialTexture = null;
        this.vertexBuffer = null;
        this.vao = null;
        this.sceneProgram = null;
        this.occlusionProgram = null;
        this.bloomProgram = null;
        this.compositeProgram = null;
        this.textureBytes = 0;
        this._cachedTextureBytes = 0;
        this._textureCacheNeedsTrim = false;
        this.vertexBufferBytes = 0;
        this.pendingGpuQueries.length = 0;
        this.timerExtension = null;
        this.gpuMs = null;
        this.qualityTimingSource = 'cpu-fallback';
    }

    _ensureTargets() {
        const gl = this.gl;
        const bloomWidth = Math.max(1, Math.floor(this.width * BLOOM_SCALE));
        const bloomHeight = Math.max(1, Math.floor(this.height * BLOOM_SCALE));
        const occWidth = Math.max(1, Math.floor(this.width * OCCLUSION_SCALE));
        const occHeight = Math.max(1, Math.floor(this.height * OCCLUSION_SCALE));
        const matches = this.sceneTarget?.width === this.width
            && this.sceneTarget?.height === this.height
            && this.bloomA?.width === bloomWidth
            && this.bloomA?.height === bloomHeight
            && this.bloomB?.width === bloomWidth
            && this.bloomB?.height === bloomHeight
            && this.occlusionTarget?.width === occWidth
            && this.occlusionTarget?.height === occHeight;
        if (matches) return;
        this._releaseTarget(this.sceneTarget);
        this._releaseTarget(this.bloomA);
        this._releaseTarget(this.bloomB);
        this._releaseTarget(this.occlusionTarget);
        this.sceneTarget = this._createTarget(this.width, this.height, { attachments: 2, filter: gl.NEAREST });
        this.bloomA = this._createTarget(bloomWidth, bloomHeight, { filter: gl.LINEAR });
        this.bloomB = this._createTarget(bloomWidth, bloomHeight, { filter: gl.LINEAR });
        this.occlusionTarget = this._createTarget(occWidth, occHeight, { filter: gl.NEAREST });
        this._updateTextureBytes();
    }

    _updateTextureBytes() {
        const estimate = estimateGpuWorldTextureBytes({
            width: this.width,
            height: this.height,
            bloomScale: BLOOM_SCALE,
            occlusionScale: OCCLUSION_SCALE,
        });
        // The scene target has two full-resolution attachments rather than the
        // policy helper's one, so add the emissive attachment explicitly.
        this.textureBytes = estimate.total + this.width * this.height * 4 + this._cachedTextureBytes;
    }

    resize(width, height) {
        this.width = Math.max(1, Math.floor(finite(width, this.width)));
        this.height = Math.max(1, Math.floor(finite(height, this.height)));
        if (this.canvas) {
            if (this.canvas.width !== this.width) this.canvas.width = this.width;
            if (this.canvas.height !== this.height) this.canvas.height = this.height;
            this.canvas.style.pointerEvents = 'none';
            this.canvas.style.imageRendering = 'pixelated';
        }
        if (this.gl && this.contextHealthy && !this.suspended) this._ensureTargets();
    }

    isActive() {
        return Boolean(this.enabled && this.supported && this.contextHealthy && !this.disposed && !this.suspended);
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
    }

    suspend() {
        if (this.disposed || this.suspended) return;
        this.suspended = true;
        this._releaseGpuResources();
        this.textureBytes = 0;
    }

    resume() {
        if (this.disposed || !this.suspended || !this.gl) return this.isActive();
        try {
            this.suspended = false;
            this._initResources();
            this.resize(this.width, this.height);
            this.qualityLadder.reset(POST_FX_LEVELS.MINIMAL);
            this.contextHealthy = true;
            return true;
        } catch (error) {
            this.suspended = true;
            this.contextHealthy = false;
            console.warn('[GpuWorldRenderer] resume failed; Canvas fallback remains active:', error);
            return false;
        }
    }

    _textureFor(key, source, revision = null, updates = null) {
        const gl = this.gl;
        if (!source || source.width === 0 || source.height === 0) return null;
        const width = Math.max(1, Math.floor(source.width || source.videoWidth || 1));
        const height = Math.max(1, Math.floor(source.height || source.videoHeight || 1));
        let entry = this._textureEntries.get(key);
        const storageChanged = !entry
            || entry.source !== source
            || entry.width !== width
            || entry.height !== height;
        const revisionChanged = !entry || entry.revision !== revision;
        if (!entry) {
            entry = { texture: gl.createTexture(), source: null, revision: null, width: 0, height: 0 };
            this._textureEntries.set(key, entry);
            this._textureCacheNeedsTrim = true;
        }
        if (storageChanged || revisionChanged) {
            const started = performance.now();
            gl.bindTexture(gl.TEXTURE_2D, entry.texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            const canPatch = !storageChanged
                && Array.isArray(updates)
                && updates.length > 0
                && updates.every((update) => {
                    const updateWidth = Math.floor(update?.width || update?.source?.width || 0);
                    const updateHeight = Math.floor(update?.height || update?.source?.height || 0);
                    const updateX = Math.floor(update?.x || 0);
                    const updateY = Math.floor(update?.y || 0);
                    return Boolean(
                        update?.source
                        && updateWidth > 0
                        && updateHeight > 0
                        && update?.source?.width === updateWidth
                        && update?.source?.height === updateHeight
                        && updateX >= 0
                        && updateY >= 0
                        && updateX + updateWidth <= width
                        && updateY + updateHeight <= height
                    );
                });
            let uploadedBytes = 0;
            if (canPatch) {
                for (const update of updates) {
                    if (!update?.source) continue;
                    gl.texSubImage2D(
                        gl.TEXTURE_2D,
                        0,
                        Math.max(0, Math.floor(update.x || 0)),
                        Math.max(0, Math.floor(update.y || 0)),
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        update.source,
                    );
                    uploadedBytes += Math.max(0, Math.floor(update.width || update.source.width || 0))
                        * Math.max(0, Math.floor(update.height || update.source.height || 0)) * 4;
                }
            } else {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
                uploadedBytes = width * height * 4;
            }
            gl.bindTexture(gl.TEXTURE_2D, null);
            const previousBytes = entry.width * entry.height * 4;
            entry.source = source;
            entry.revision = revision;
            entry.width = width;
            entry.height = height;
            this._cachedTextureBytes += width * height * 4 - previousBytes;
            this.uploads++;
            this.uploadBytes += uploadedBytes;
            this._frameUploadMs += performance.now() - started;
            if (storageChanged) {
                this._textureCacheNeedsTrim = true;
                this._updateTextureBytes();
            }
        }
        entry.lastUsedFrame = this.frames + 1;
        return entry.texture;
    }

    _trimTextureCache() {
        const overCap = this._cachedTextureBytes > MAX_CACHED_TEXTURE_BYTES
            || this._textureEntries.size > MAX_CACHED_TEXTURES;
        if (!overCap) {
            this._textureCacheNeedsTrim = false;
            return;
        }
        if (!this._textureCacheNeedsTrim && this.frames - this._lastTextureTrimFrame < 120) return;
        this._lastTextureTrimFrame = this.frames;
        this._textureCacheNeedsTrim = false;
        const candidates = [...this._textureEntries.entries()]
            .filter(([, entry]) => entry.lastUsedFrame !== this.frames + 1)
            .sort((a, b) => finite(a[1].lastUsedFrame) - finite(b[1].lastUsedFrame));
        for (const [key, entry] of candidates) {
            if (this._cachedTextureBytes <= MAX_CACHED_TEXTURE_BYTES
                && this._textureEntries.size <= MAX_CACHED_TEXTURES) break;
            this.gl.deleteTexture(entry.texture);
            this._textureEntries.delete(key);
            this._cachedTextureBytes -= entry.width * entry.height * 4;
            this.textureEvictions++;
        }
        this._updateTextureBytes();
    }

    setPassSamplingEnabled(enabled) {
        this.passSamplingEnabled = Boolean(enabled);
    }

    _beginPass(name) {
        if (this._sampledPass !== name) return;
        this._passStarted = performance.now();
        this._passUploadBytes = this.uploadBytes;
        this._activePassQuery = this._beginGpuTimer();
    }

    _endPass(name, draws, bytes) {
        if (this._sampledPass !== name) return;
        const cpuMs = performance.now() - this._passStarted;
        const sample = { pass: name, draws, bytes: bytes + this.uploadBytes - this._passUploadBytes, cpuMs };
        if (this._activePassQuery) this._endGpuTimer(this._activePassQuery, sample);
        else this._recordPass({ ...sample, gpuMs: null });
        this._activePassQuery = null;
    }

    // The ring is fixed capacity and its aggregates are maintained on write:
    // getDiagnostics() runs every frame from the render-stats builder and must
    // never walk the samples.
    _recordPass(sample) {
        const ring = this._passResults[sample.pass];
        const evicted = ring.samples[ring.next];
        if (evicted) {
            ring.cpuSum -= evicted.cpuMs;
            if (evicted.gpuMs != null) {
                ring.gpuSum -= evicted.gpuMs;
                ring.gpuCount -= 1;
            }
        }
        ring.samples[ring.next] = sample;
        ring.next = (ring.next + 1) % PASS_RING_CAPACITY;
        ring.count = Math.min(PASS_RING_CAPACITY, ring.count + 1);
        ring.cpuSum += sample.cpuMs;
        if (sample.gpuMs != null) {
            ring.gpuSum += sample.gpuMs;
            ring.gpuCount += 1;
        }
        ring.latest = sample;
    }

    _beginGpuTimer() {
        if (!this.timerExtension || !this.gl?.createQuery) return null;
        let query = null;
        try {
            query = this.gl.createQuery();
            if (!query) return null;
            this.gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query);
            return query;
        } catch {
            this.gl.deleteQuery?.(query);
            this.gpuTimerErrors++;
            return null;
        }
    }

    _endGpuTimer(query, metadata = null) {
        if (!query || !this.timerExtension) return;
        try {
            const gl = this.gl;
            gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
            this.pendingGpuQueries.push({ query, ...metadata });
            if (this.pendingGpuQueries.length > 8) {
                gl.deleteQuery?.(this.pendingGpuQueries.shift().query);
            }
        } catch {
            this.gpuTimerErrors++;
            if (!metadata) this.gpuMs = null;
            this.gl.deleteQuery?.(query);
        }
    }

    _pollGpuQueries() {
        if (!this.timerExtension || !this.pendingGpuQueries.length) return;
        const gl = this.gl;
        if (gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT)) {
            // Even not-yet-available queries intersect this invalid interval.
            this.gpuDisjointDiscards += this.pendingGpuQueries.length;
            for (const sample of this.pendingGpuQueries) gl.deleteQuery?.(sample.query);
            this.pendingGpuQueries.length = 0;
            this.gpuMs = null;
            return;
        }
        for (let index = 0; index < this.pendingGpuQueries.length;) {
            const sample = this.pendingGpuQueries[index];
            try {
                if (!gl.getQueryParameter(sample.query, gl.QUERY_RESULT_AVAILABLE)) {
                    index++;
                    continue;
                }
                const gpuMs = Number(gl.getQueryParameter(sample.query, gl.QUERY_RESULT)) / 1e6;
                if (Number.isFinite(gpuMs) && gpuMs >= 0) {
                    if (sample.pass) this._recordPass({ ...sample, query: undefined, gpuMs });
                    else this.gpuMs = ema(this.gpuMs, gpuMs);
                }
            } catch {
                this.gpuTimerErrors++;
                if (!sample.pass) this.gpuMs = null;
            }
            this.pendingGpuQueries.splice(index, 1);
            gl.deleteQuery?.(sample.query);
        }
    }

    _stageFrameVertices(batches) {
        let sceneRecordCount = 0;
        let occlusionRecordCount = 0;
        for (let index = 0; index < batches.length; index++) {
            const records = batches[index].records;
            sceneRecordCount += records.length;
            for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
                const record = records[recordIndex];
                if (record.occluder > 0 || record.elevation > 0.05) occlusionRecordCount++;
            }
        }
        const needed = (sceneRecordCount + occlusionRecordCount) * 6 * VERTEX_FLOATS;
        this._vertexScratch = growTypedArray(Float32Array, this._vertexScratch, needed, 64);
        const vertices = this._vertexScratch;
        let offset = 0;
        let first = 0;
        for (let index = 0; index < batches.length; index++) {
            const batch = batches[index];
            batch.first = first;
            batch.count = batch.records.length * 6;
            for (let recordIndex = 0; recordIndex < batch.records.length; recordIndex++) {
                offset = writeGpuRecordVertices(vertices, offset, batch.records[recordIndex]);
            }
            first += batch.count;
        }
        for (let index = 0; index < batches.length; index++) {
            const batch = batches[index];
            batch.occlusionFirst = first;
            batch.occlusionCount = 0;
            for (let recordIndex = 0; recordIndex < batch.records.length; recordIndex++) {
                const record = batch.records[recordIndex];
                if (!record.occluderSource && record.occluder <= 0 && record.elevation <= 0.05) continue;
                offset = writeGpuRecordVertices(vertices, offset, record);
                batch.occlusionCount += 6;
            }
            first += batch.occlusionCount;
        }
        this._vertexScratchUsed = needed;
        const byteLength = needed * Float32Array.BYTES_PER_ELEMENT;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        const allocatedBytes = this.vertexBufferBytes || 0;
        if (byteLength > allocatedBytes) {
            gl.bufferData(gl.ARRAY_BUFFER, byteLength, gl.DYNAMIC_DRAW);
            this.vertexBufferBytes = byteLength;
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices, 0, needed);
    }

    _setCameraUniforms(uniforms, camera, scale = 1) {
        const gl = this.gl;
        const dpr = Math.max(0.25, finite(camera?._dpr?.(), 1));
        const zoom = Math.max(0.01, finite(camera?.zoom, 1));
        gl.uniform3f(
            uniforms.u_camera,
            finite(camera?.renderOffsetX, Math.round(finite(camera?.x) * zoom * dpr) / dpr) / zoom,
            finite(camera?.renderOffsetY, Math.round(finite(camera?.y) * zoom * dpr) / dpr) / zoom,
            zoom * dpr * scale,
        );
    }

    // Resolve (and, when a revision moved, upload) every channel texture for
    // the frame once. Both draw passes then only bind: the sidecar key strings
    // are built once per frame instead of once per batch per pass, and every
    // texSubImage/texImage cost is attributed to the upload phase rather than
    // appearing inside whichever pass happened to bind the batch first.
    _uploadBatchTextures(batches) {
        for (let index = 0; index < batches.length; index++) {
            const batch = batches[index];
            const first = batch.records[0];
            const sidecar = batch.sidecarKey || batch.textureKey;
            batch.albedoTexture = this._textureFor(
                batch.textureKey,
                batch.source,
                first?.textureRevision,
                first?.textureUpdates,
            );
            batch.materialTexture = batch.materialSource
                ? this._textureFor(`material:${sidecar}`, batch.materialSource,
                    first?.sidecarRevision, first?.materialTextureUpdates)
                : null;
            batch.emissiveTexture = batch.emissiveSource
                ? this._textureFor(`emissive:${sidecar}`, batch.emissiveSource,
                    first?.sidecarRevision, first?.emissiveTextureUpdates)
                : null;
            batch.occluderTexture = batch.occluderSource
                ? this._textureFor(`occluder:${sidecar}`, batch.occluderSource,
                    first?.sidecarRevision, first?.occluderTextureUpdates)
                : null;
        }
    }

    _bindBatch(program, uniforms, batch, { occlusion = false } = {}) {
        const gl = this.gl;
        const albedo = batch.albedoTexture;
        if (!albedo) return 0;
        const material = batch.materialTexture;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, albedo);
        gl.uniform1i(uniforms.u_albedo, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, material || this.emptyMaterialTexture);
        gl.uniform1i(uniforms.u_materialMap, 1);
        gl.uniform1i(uniforms.u_hasMaterialMap, material ? 1 : 0);
        if (uniforms.u_emissiveMap) {
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, batch.emissiveTexture || this.emptyMaterialTexture);
            gl.uniform1i(uniforms.u_emissiveMap, 3);
            gl.uniform1i(uniforms.u_hasEmissiveMap, batch.emissiveTexture ? 1 : 0);
        }
        if (uniforms.u_occluderMap) {
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_2D, batch.occluderTexture || this.emptyMaterialTexture);
            gl.uniform1i(uniforms.u_occluderMap, 4);
            gl.uniform1i(uniforms.u_hasOccluderMap, batch.occluderTexture ? 1 : 0);
        }
        gl.drawArrays(
            gl.TRIANGLES,
            occlusion ? batch.occlusionFirst : batch.first,
            occlusion ? batch.occlusionCount : batch.count,
        );
        return batch.records.length;
    }

    _renderOcclusion(batches, camera) {
        const gl = this.gl;
        const target = this.occlusionTarget;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, target.width, target.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.occlusionProgram);
        this._setCameraUniforms(this.occlusionUniforms, camera, OCCLUSION_SCALE);
        gl.uniform2f(this.occlusionUniforms.u_resolution, target.width, target.height);
        for (const batch of batches) {
            if (!batch.occlusionCount) continue;
            this._bindBatch(this.occlusionProgram, this.occlusionUniforms, batch, { occlusion: true });
        }
    }

    _setSceneUniforms(feed, camera, qualityLevel = POST_FX_LEVELS.FULL) {
        const gl = this.gl;
        const uniforms = this.sceneUniforms;
        const grade = phaseGrade(feed);
        const weather = weatherUniform(feed);
        const weatherMode = effectBudgetMode('weather-amplitude', qualityLevel);
        if (weatherMode === 'reduced') {
            weather[0] *= 0.72;
            weather[3] *= 0.72;
        } else if (weatherMode === 'off') {
            weather[0] = 0;
            weather[2] = 0;
            weather[3] = 0;
        }
        gl.uniform1i(uniforms.u_useOcclusion, effectBudgetMode('occlusion', qualityLevel) !== 'off');
        this._setCameraUniforms(uniforms, camera, 1);
        gl.uniform2f(uniforms.u_resolution, this.width, this.height);
        gl.uniform2f(uniforms.u_occlusionResolution, this.occlusionTarget.width, this.occlusionTarget.height);
        gl.uniform3fv(uniforms.u_gradeBase, grade.base);
        gl.uniform3fv(uniforms.u_gradeEdge, grade.edge);
        gl.uniform1f(uniforms.u_edgeAlpha, grade.edgeAlpha);
        gl.uniform3fv(uniforms.u_fogColor, grade.fog);
        gl.uniform4fv(uniforms.u_weather, weather);
        const sun = feed.lighting?.sunDirIso || {};
        gl.uniform4f(
            uniforms.u_sun,
            finite(sun.x, -0.7071),
            finite(sun.y, -0.7071),
            clamp(finite(feed.lighting?.sunWarmth), 0, 1),
            clamp(finite(feed.lighting?.ambientLight, 1), 0, 1),
        );
        gl.uniform4fv(
            uniforms['u_cloudShadow[0]'],
            effectBudgetMode('cloud-courses', qualityLevel) === 'off'
                ? this._cloudShadowScratch.fill(0)
                : writeCloudShadowUniforms(
                    this._cloudShadowScratch,
                    this._cloudShadowLayers,
                    feed,
                    this.width,
                    this.height,
                ),
        );
        this.emissivePhase = emissivePhaseForAmbientLight(feed.lighting?.ambientLight);
        // Keep the existing time channel inside float32's precise range. The
        // one-million-ms period closes on both shader phase multipliers.
        const shaderTimeMs = ((finite(feed.timeMs, Date.now()) % 1000000) + 1000000) % 1000000;
        gl.uniform1f(uniforms.u_time, shaderTimeMs);
        gl.uniform1f(uniforms.u_motionScale, feed.reducedMotion ? 0 : clamp(finite(feed.motionScale, 1), 0, 2));
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.occlusionTarget.textures[0]);
        gl.uniform1i(uniforms.u_occlusion, 2);

        this.localLightPhase = localLightPhaseForLighting(feed.lighting);
        const daylightSuppressesLights = this.localLightPhase <= LOCAL_LIGHT_VISIBILITY_FLOOR;
        const lightLimit = daylightSuppressesLights
            ? 0
            : qualityLevel >= POST_FX_LEVELS.MINIMAL
            ? 4
            : qualityLevel >= POST_FX_LEVELS.REDUCED
                ? 10
                : MAX_LIGHTS;
        const lights = clampGpuLights(
            feed.lights,
            lightLimit,
            daylightSuppressesLights ? 0 : MAX_LIGHTS,
            this._lightAdmissionCache,
        );
        const lightValues = this._lightScratch;
        const lightColors = this._lightColorScratch;
        lightValues.fill(0);
        lightColors.fill(0);
        for (let index = 0; index < lights.length; index++) {
            const light = lights[index];
            const color = gpuLightColorForShader(light, DEFAULT_LIGHT_COLOR, this._singleLightColorScratch);
            const offset = index * 4;
            lightValues[offset] = finite(light.x);
            lightValues[offset + 1] = this.height - finite(light.y);
            lightValues[offset + 2] = Math.max(1, finite(light.radius, 64));
            lightValues[offset + 3] = clamp(finite(light.intensity, 1), 0, 3)
                * this.localLightPhase;
            lightColors[offset] = color[0];
            lightColors[offset + 1] = color[1];
            lightColors[offset + 2] = color[2];
            lightColors[offset + 3] = light.night
                ? clamp(finite(feed.lighting?.beaconIntensity, 0), 0, 1)
                : 1;
        }
        this.lightCount = lights.length;
        gl.uniform1i(uniforms.u_lightCount, lights.length);
        gl.uniform4fv(uniforms['u_lights[0]'], lightValues);
        gl.uniform4fv(uniforms['u_lightColors[0]'], lightColors);
    }

    _renderScene(batches, camera, feed, qualityLevel = POST_FX_LEVELS.FULL) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.framebuffer);
        const bloomEnabled = effectBudgetMode('bloom', qualityLevel) !== 'off'
            && localLightPhaseForLighting(feed.lighting) > LOCAL_LIGHT_VISIBILITY_FLOOR;
        gl.drawBuffers(bloomEnabled
            ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]
            : [gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.sceneProgram);
        this._setSceneUniforms(feed, camera, qualityLevel);
        for (const batch of batches) {
            if (batch.blend === 'add') gl.blendFunc(gl.ONE, gl.ONE);
            else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            this._bindBatch(this.sceneProgram, this.sceneUniforms, batch);
        }
        return bloomEnabled;
    }

    _renderBloom() {
        const gl = this.gl;
        gl.useProgram(this.bloomProgram);
        gl.uniform1i(this.bloomUniforms.u_input, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.framebuffer);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, this.bloomA.width, this.bloomA.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.textures[1]);
        gl.uniform2f(this.bloomUniforms.u_texel, 1 / this.width, 1 / this.height);
        gl.uniform1i(this.bloomUniforms.u_blur, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.framebuffer);
        gl.viewport(0, 0, this.bloomB.width, this.bloomB.height);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomA.textures[0]);
        gl.uniform2f(this.bloomUniforms.u_texel, 1 / this.bloomA.width, 1 / this.bloomA.height);
        gl.uniform1i(this.bloomUniforms.u_blur, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    _present(qualityLevel = POST_FX_LEVELS.FULL) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.drawBuffers([gl.BACK]);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.compositeProgram);
        gl.uniform1i(this.compositeUniforms.u_scene, 0);
        gl.uniform1i(this.compositeUniforms.u_bloom, 1);
        const bloomMode = effectBudgetMode('bloom', qualityLevel);
        const bloomStrength = bloomMode === 'off' ? 0 : bloomMode === 'reduced' ? 0.42 : 0.72;
        gl.uniform1f(
            this.compositeUniforms.u_bloomStrength,
            this.lightCount > 0 ? bloomStrength * this.emissivePhase : 0,
        );
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.textures[0]);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomB.textures[0]);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    render({ records = [], camera = null, feed = {} } = {}) {
        if (!this.isActive() || !camera || !records.length) return false;
        const gl = this.gl;
        const started = performance.now();
        const frameGapMs = this._lastRenderAtMs == null ? 0 : started - this._lastRenderAtMs;
        this._lastRenderAtMs = started;
        this._frameUploadMs = 0;
        let qualityLevel = this.qualityLadder.getLevel();
        let gpuTimer = null;
        // DISABLED means optional GPU effects are exhausted, not that the
        // renderer may swap composition paths mid-scene. Canvas-only fauna and
        // water details sit beneath this surface; toggling to Canvas and back
        // makes boats/waterfalls blink. Keep the minimal resident scene while
        // cheap probes allow recovery after warm-up.
        if (qualityLevel >= POST_FX_LEVELS.DISABLED) {
            const recovery = this.qualityLadder.update({ totalMs: 0 }, started);
            qualityLevel = Math.min(recovery.effectiveLevel, POST_FX_LEVELS.MINIMAL);
        }
        try {
            // Timer results are asynchronous. Polling only availability keeps
            // this path non-blocking; until the first clean result arrives the
            // existing CPU submission measurement remains the ladder fallback.
            this._pollGpuQueries();
            this._ensureTargets();
            const batches = buildStableGpuBatches(records, this._batchScratch, this._normalizedRecordScratch);
            if (!batches.length) return false;
            // One pass replaces (never nests inside) the whole-frame query on
            // one frame in twelve. Only whole-frame results feed the ladder.
            this._sampledPass = this.passSamplingEnabled && this.frames % 12 === 0
                ? GPU_PASS_NAMES[this._passCursor++ % GPU_PASS_NAMES.length] : null;
            this._beginPass('upload');
            this._stageFrameVertices(batches);
            this._uploadBatchTextures(batches);
            this._endPass('upload', 0, this._vertexScratchUsed * 4);
            let atlasRecords = 0;
            let individualRecords = 0;
            for (let index = 0; index < records.length; index++) {
                if (records[index]?.sourceKind === 'atlas') atlasRecords += 1;
                else individualRecords += 1;
            }
            this._sourceCensus = {
                atlasRecords,
                individualRecords,
                batchCount: batches.length,
                uploadBytes: this.uploadBytes,
            };
            gl.bindVertexArray(this.vao);
            gl.enable(gl.BLEND);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);
            gpuTimer = this._sampledPass ? null : this._beginGpuTimer();
            const localLightsVisible = localLightPhaseForLighting(feed.lighting)
                > LOCAL_LIGHT_VISIBILITY_FLOOR;
            this._beginPass('occlusion');
            if (effectBudgetMode('occlusion', qualityLevel) !== 'off' && localLightsVisible) {
                this._renderOcclusion(batches, camera);
            } else {
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.occlusionTarget.framebuffer);
                gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                gl.viewport(0, 0, this.occlusionTarget.width, this.occlusionTarget.height);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
            this._endPass('occlusion', this._sampledPass === 'occlusion'
                && effectBudgetMode('occlusion', qualityLevel) !== 'off' && localLightsVisible
                ? batches.reduce((count, batch) => count + Boolean(batch.occlusionCount), 0) : 0,
                this.occlusionTarget.width * this.occlusionTarget.height * 4);
            this._beginPass('scene');
            const bloomEnabled = this._renderScene(batches, camera, feed, qualityLevel);
            this._endPass('scene', batches.length, this.width * this.height * 4 * (bloomEnabled ? 2 : 1));
            gl.disable(gl.BLEND);
            this._beginPass('bloom');
            if (bloomEnabled && this.lightCount > 0) this._renderBloom();
            this._endPass('bloom', bloomEnabled && this.lightCount > 0 ? 2 : 0,
                bloomEnabled && this.lightCount > 0 ? this.bloomA.width * this.bloomA.height * 8 : 0);
            gl.enable(gl.BLEND);
            this._beginPass('present');
            this._present(qualityLevel);
            this._endPass('present', 1, this.width * this.height * 4);
            this._endGpuTimer(gpuTimer);
            gpuTimer = null;
            this._trimTextureCache();
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            gl.bindVertexArray(null);
            let renderedRecords = 0;
            for (let index = 0; index < batches.length; index++) {
                renderedRecords += batches[index].records.length;
            }
            this.records = renderedRecords;
            this.batches = batches.length;
            this.frames++;
            const totalMs = performance.now() - started;
            const shaderCpuMs = Math.max(0, totalMs - this._frameUploadMs);
            this.uploadMs = ema(this.uploadMs, this._frameUploadMs);
            this.shaderCpuMs = ema(this.shaderCpuMs, shaderCpuMs);
            this.cpuMs = ema(this.cpuMs, totalMs);
            this.frameGapMs = ema(this.frameGapMs, frameGapMs);
            const timingInput = this._qualityTimingInput;
            timingInput.uploadMs = this._frameUploadMs;
            timingInput.shaderCpuMs = shaderCpuMs;
            timingInput.gpuMs = this.gpuMs;
            timingInput.gpuTimerSupported = Boolean(this.timerExtension);
            timingInput.frameGapMs = frameGapMs;
            const timing = selectGpuTimingMetrics(timingInput, this._qualityTimingScratch);
            this.qualityTimingSource = timing.source;
            this.qualityLadder.update(timing.metrics, started);
            return true;
        } catch (error) {
            gpuTimer ||= this._activePassQuery;
            this._activePassQuery = null;
            if (gpuTimer) {
                try {
                    gl.endQuery(this.timerExtension?.TIME_ELAPSED_EXT);
                } catch {
                    // Context loss or a driver error may already have ended it.
                }
                gl.deleteQuery?.(gpuTimer);
            }
            if (!this._renderErrorLogged) {
                this._renderErrorLogged = true;
                console.warn('[GpuWorldRenderer] render failed; Canvas fallback remains active:', error);
            }
            this.contextHealthy = false;
            return false;
        }
    }

    getDiagnostics() {
        const quality = this.qualityLadder.getState();
        return {
            supported: this.supported,
            active: this.isActive(),
            contextHealthy: this.contextHealthy,
            suspended: this.suspended,
            width: this.width,
            height: this.height,
            frames: this.frames,
            records: this.records,
            batches: this.batches,
            lights: this.lightCount,
            localLightPhase: this.localLightPhase,
            uploads: this.uploads,
            uploadBytes: this.uploadBytes,
            uploadMs: this.uploadMs ?? 0,
            cpuMs: this.cpuMs ?? 0,
            shaderCpuMs: this.shaderCpuMs ?? 0,
            gpuMs: this.gpuMs,
            gpuTimerSupported: Boolean(this.timerExtension),
            gpuTimerExtension: this.timerExtension ? 'EXT_disjoint_timer_query_webgl2' : null,
            gpuTimerPendingQueries: this.pendingGpuQueries.length,
            gpuTimerErrors: this.gpuTimerErrors,
            gpuDisjointDiscards: this.gpuDisjointDiscards,
            passSamplingEnabled: this.passSamplingEnabled,
            passes: Object.fromEntries(GPU_PASS_NAMES.map(name => {
                const ring = this._passResults[name];
                return [name, {
                    gpuMs: ring.gpuCount ? ring.gpuSum / ring.gpuCount : null,
                    cpuMs: ring.count ? ring.cpuSum / ring.count : null,
                    draws: ring.latest?.draws ?? null,
                    bytes: ring.latest?.bytes ?? null,
                    samples: ring.count,
                }];
            })),
            qualityTimingSource: this.qualityTimingSource,
            frameGapMs: this.frameGapMs ?? 0,
            textureBytes: this.textureBytes,
            residentTextureBytes: this.textureBytes,
            cachedTextureBytes: this._cachedTextureBytes,
            cachedTextureCapBytes: MAX_CACHED_TEXTURE_BYTES,
            cachedTextureCapExceeded: this._cachedTextureBytes > MAX_CACHED_TEXTURE_BYTES,
            cachedTextures: this._textureEntries.size,
            textureEvictions: this.textureEvictions,
            maxCachedTextureBytes: MAX_CACHED_TEXTURE_BYTES,
            maxCachedTextures: MAX_CACHED_TEXTURES,
            materialAttachments: 2,
            occlusionScale: OCCLUSION_SCALE,
            bloomScale: BLOOM_SCALE,
            qualityLevel: quality.effectiveLevel,
            qualityReason: quality.lastDecisionReason.replace(/^disabled(?=:|$)/, 'minimal-resident'),
            shedEffects: shedEffectsForLevel(quality.effectiveLevel),
            shedReason: quality.lastDecisionReason,
            qualityDegradationReason: quality.lastDegradationReason,
            qualityTransitionAtMs: quality.lastTransitionAtMs,
            qualityTransitionMetrics: quality.lastTransitionMetrics,
            resources: this.getResourceAccounting(),
            atlasRecords: this._sourceCensus?.atlasRecords || 0,
            individualRecords: this._sourceCensus?.individualRecords || 0,
            sourceBatchCount: this._sourceCensus?.batchCount || this.batches,
            sourceUploadBytes: this._sourceCensus?.uploadBytes || this.uploadBytes,
        };
    }

    getResourceAccounting() {
        if (this.suspended || !this.contextHealthy) {
            return { textures: {}, attachments: {}, buffers: {} };
        }
        let pinnedSourceBytes = 0;
        let evictableSourceBytes = 0;
        const atlasPages = [];
        for (const [name, entry] of this._textureEntries) {
            const bytes = entry.width * entry.height * 4;
            const pinned = entry.lastUsedFrame === this.frames;
            if (pinned) pinnedSourceBytes += bytes;
            else evictableSourceBytes += bytes;
            if (name.includes('world-pilot') || name.includes('agent-frame-atlas')) {
                atlasPages.push({ name, width: entry.width, height: entry.height, bytes, pinned });
            }
        }
        const targetBytes = target => target ? target.width * target.height * 4 : 0;
        const attachmentBytes = targetBytes(this.sceneTarget) * 2
            + targetBytes(this.bloomA) + targetBytes(this.bloomB) + targetBytes(this.occlusionTarget);
        const pinnedBytes = pinnedSourceBytes + attachmentBytes + (this.vertexBufferBytes || 0);
        return {
            textures: { pinnedSources: pinnedSourceBytes, evictableSources: evictableSourceBytes },
            pinnedBytes,
            evictableBytes: evictableSourceBytes,
            totalBytes: pinnedBytes + evictableSourceBytes,
            atlasPages,
            liveBodyAtlas: atlasPages.find(page => page.name === 'agent-frame-atlas') || null,
            cachedSourceOverageBytes: Math.max(0, pinnedSourceBytes + evictableSourceBytes - MAX_CACHED_TEXTURE_BYTES),
            attachments: {
                sceneColor: targetBytes(this.sceneTarget),
                sceneEmission: targetBytes(this.sceneTarget),
                bloomA: targetBytes(this.bloomA),
                bloomB: targetBytes(this.bloomB),
                occlusion: targetBytes(this.occlusionTarget),
            },
            buffers: { vertices: this.vertexBufferBytes || 0 },
        };
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.canvas?.removeEventListener?.('webglcontextlost', this._onContextLost, false);
        this.canvas?.removeEventListener?.('webglcontextrestored', this._onContextRestored, false);
        this._releaseGpuResources();
        this.contextHealthy = false;
        this.textureBytes = 0;
    }
}

export function createGpuWorldRenderer({ canvas, enabled = true } = {}) {
    if (!canvas?.getContext) return null;
    const renderer = new GpuWorldRenderer(canvas, { enabled });
    return renderer.supported ? renderer : null;
}
