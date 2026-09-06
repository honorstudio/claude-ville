import { createPostFxLadder, POST_FX_LEVELS } from './PostFxLadder.js';
import {
    canvasPixelCount,
    gpuResourceAccounting,
    unifiedRendererResourceAccounting,
} from '../CanvasBudget.js';
import { localLightPhaseForLighting, worldPhaseGrade } from '../gpu/GpuWorldPolicy.js';
import { sourceEnergyFor } from '../AtmosphereState.js';

const MAX_LIGHTS = 48;
const MAX_HAZE_ANCHORS = 8;
const EMA_ALPHA = 0.1;
const GOD_RAY_SCALE = 0.25;

const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[](
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0)
);
const vec2 UV[3] = vec2[](
    vec2(0.0, 0.0),
    vec2(2.0, 0.0),
    vec2(0.0, 2.0)
);
out vec2 v_uv;
void main() {
    gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
    v_uv = UV[gl_VertexID];
}`;

const MAIN_FRAGMENT = `#version 300 es
precision highp float;

in vec2 v_uv;
layout(location = 0) out vec4 outColor;

uniform sampler2D u_source;
uniform sampler2D u_waterMask;
uniform vec2 u_resolution;
uniform vec2 u_sourceTexel;
uniform vec2 u_maskTexel;
uniform vec2 u_rayTexel;
uniform vec2 u_flow;
uniform vec3 u_sun;
uniform vec4 u_pulse;
uniform vec3 u_gradeBase;
uniform vec3 u_gradeEdge;
uniform float u_edgeAlpha;
uniform vec3 u_tint;
uniform float u_tintAlpha;
uniform float u_lightGlowScale;
uniform float u_time;
uniform float u_motionScale;
uniform bool u_reducedMotion;
uniform bool u_waterEnabled;
uniform bool u_displacementEnabled;
uniform bool u_reflectionEnabled;
uniform bool u_godRaysEnabled;
uniform bool u_pulseEnabled;
uniform bool u_grainEnabled;
uniform int u_hazeCount;
uniform int u_lightCount;
uniform vec4 u_haze[8];
uniform vec4 u_lights[48];
uniform vec4 u_lightColors[48];

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

vec4 sourceAt(vec2 uv) {
    return texture(u_source, clamp(uv, vec2(0.0), vec2(1.0)));
}

vec2 quantizedPixels(vec2 px) {
    vec2 a = floor(abs(px) + 0.5);
    return sign(px) * a * u_sourceTexel;
}

float waterAt(vec2 uv) {
    return u_waterEnabled ? texture(u_waterMask, clamp(uv, vec2(0.0), vec2(1.0))).r : 0.0;
}

vec2 scenePixels() {
    // Feed coordinates are top-left; v_uv is the conventional bottom-left GL
    // coordinate, so this conversion keeps all masks and lights upright.
    return vec2(v_uv.x * u_resolution.x, (1.0 - v_uv.y) * u_resolution.y);
}

vec2 animatedPhase() {
    float phase = u_reducedMotion ? 0.37 : u_time * 0.001 * u_motionScale;
    return vec2(phase, phase * 1.6180339 + 0.7);
}

vec2 effectOffset(vec2 uv) {
    if (!u_displacementEnabled) return vec2(0.0);
    vec2 px = vec2(0.0);
    vec2 hazePx = vec2(0.0);
    vec2 phase = animatedPhase();
    float water = waterAt(uv);
    if (water > 0.001) {
        vec2 wave = vec2(
            sin(scenePixels().y * 0.065 + phase.x * 2.2),
            cos(scenePixels().x * 0.052 + phase.y * 1.7)
        );
        // Flow is capped to the contract's +/-2 texel displacement envelope.
        px += clamp(wave * u_flow * 2.0, vec2(-2.0), vec2(2.0)) * water;
    }
    for (int i = 0; i < 8; i++) {
        if (i >= u_hazeCount) break;
        vec4 anchor = u_haze[i];
        vec2 delta = scenePixels() - anchor.xy;
        float radius = max(1.0, anchor.z);
        float influence = (1.0 - smoothstep(0.0, radius, length(delta))) * anchor.w;
        float shimmer = sin(dot(delta, vec2(0.071, 0.053)) + phase.x * 3.0 + float(i));
        hazePx += vec2(shimmer, cos(shimmer + phase.y)) * influence;
    }
    // Heat haze owns a tighter +/-1 texel envelope than water's +/-2 budget.
    px += clamp(hazePx, vec2(-1.0), vec2(1.0));
    return quantizedPixels(clamp(px, vec2(-2.0), vec2(2.0)));
}

vec3 applyGrade(vec3 color) {
    vec2 p = scenePixels();
    vec2 centre = vec2(u_resolution.x * 0.5, u_resolution.y * (1.0 - 0.46));
    float inner = min(u_resolution.x, u_resolution.y) * 0.18;
    float outer = max(u_resolution.x, u_resolution.y) * 0.72;
    float t = clamp((distance(p, centre) - inner) / max(1.0, outer - inner), 0.0, 1.0);
    float vignetteAlpha = t <= 0.62
        ? mix(0.0, u_edgeAlpha * 0.4, t / 0.62)
        : mix(u_edgeAlpha * 0.4, u_edgeAlpha, (t - 0.62) / 0.38);
    color *= u_gradeBase;
    color *= mix(vec3(1.0), u_gradeEdge, vignetteAlpha);

    // A restrained three-band refinement follows the authored world tint. It
    // is intentionally tiny so E1 parity remains obvious at every phase.
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float shadows = (1.0 - smoothstep(0.0, 0.48, luminance)) * 0.020;
    float mids = (1.0 - abs(luminance - 0.5) * 2.0) * 0.012;
    float highlights = smoothstep(0.58, 1.0, luminance) * 0.008;
    float refine = (shadows + mids + highlights) * u_tintAlpha;
    color += (u_tint - vec3(0.5)) * refine;
    return max(color, vec3(0.0));
}

vec3 applyGlows(vec3 color) {
    vec2 p = scenePixels();
    for (int i = 0; i < 48; i++) {
        if (i >= u_lightCount) break;
        vec4 light = u_lights[i];
        float radius = max(1.0, light.z);
        float t = distance(p, light.xy) / radius;
        if (t >= 1.0) continue;
        // 2D parity: _getLightGlowStamp's radial gradient — alpha 0.5 at the
        // core, 0.25 at t=0.35, fading to 0 at the rim, with the core hue
        // mixed 60% toward white so lanterns read incandescent.
        float a = mix(mix(0.5, 0.25, t / 0.35), mix(0.25, 0.0, (t - 0.35) / 0.65), step(0.35, t));
        vec3 base = u_lightColors[i].rgb;
        vec3 hue = mix(mix(base, vec3(1.0), 0.6), base, smoothstep(0.0, 0.35, t));
        // u_lightColors[i].a carries the per-light scale: 1 for ambient
        // sources (day-visible, 2D parity), lantern night factor for baked
        // prop halos.
        color += hue * a * light.w * u_lightGlowScale * u_lightColors[i].a;
    }
    return color;
}

vec3 applyGodRays(vec3 color, vec2 uv) {
    if (!u_godRaysEnabled || u_sun.z <= 0.001) return color;
    vec2 sunUv = vec2(u_sun.x / u_resolution.x, 1.0 - u_sun.y / u_resolution.y);
    vec2 towardSun = sunUv - uv;
    vec3 ray = vec3(0.0);
    float weight = 0.0;
    for (int i = 1; i <= 8; i++) {
        float f = float(i) / 8.0;
        // Coarse quarter-resolution taps provide the low-res ray buffer's
        // soft character without spending a fifth fullscreen draw.
        vec2 rayUv = uv + towardSun * f * 0.18;
        rayUv = floor(rayUv / u_rayTexel + 0.5) * u_rayTexel;
        vec3 sampleColor = sourceAt(rayUv).rgb;
        float luminance = dot(sampleColor, vec3(0.2126, 0.7152, 0.0722));
        ray += sampleColor * luminance * (1.0 - f);
        weight += 1.0 - f;
    }
    return color + (ray / max(weight, 0.001)) * u_sun.z * 0.13;
}

void main() {
    vec2 displacement = effectOffset(v_uv);
    vec2 sceneUv = clamp(v_uv + displacement, vec2(0.0), vec2(1.0));
    vec4 scene = sourceAt(sceneUv);

    if (u_pulseEnabled) {
        // The pulse is a channel-separated sample, limited to two source texels.
        float pulseStrength = clamp(u_pulse.a, 0.0, 1.0);
        vec2 pulsePx = quantizedPixels(vec2(2.0, -1.0) * pulseStrength);
        vec3 pulseColor = vec3(
            sourceAt(sceneUv + pulsePx).r,
            sourceAt(sceneUv).g,
            sourceAt(sceneUv - pulsePx).b
        );
        scene.rgb = mix(scene.rgb, pulseColor, pulseStrength * 0.78);
        scene.rgb += u_pulse.rgb * pulseStrength * 0.012;
    }

    if (u_reflectionEnabled) {
        float water = waterAt(v_uv);
        float below = waterAt(v_uv + vec2(0.0, 3.0 * u_maskTexel.y));
        float upperEdge = water * (1.0 - below);
        vec3 reflection = sourceAt(vec2(sceneUv.x, 1.0 - sceneUv.y)).rgb;
        scene.rgb += reflection * upperEdge * 0.08;
    }

    scene.rgb = applyGrade(scene.rgb);
    scene.rgb = applyGlows(scene.rgb);
    scene.rgb = applyGodRays(scene.rgb, sceneUv);

    // Static phase under reduced motion; otherwise the grain term advances only
    // through motionScale, matching the renderer's motion policy.
    if (u_grainEnabled) {
        float grainPhase = u_reducedMotion ? 0.37 : u_time * 0.00013 * u_motionScale;
        float grain = hash21(gl_FragCoord.xy + vec2(grainPhase * 37.0, grainPhase * 19.0)) - 0.5;
        float ordered = (mod(floor(gl_FragCoord.x) + 2.0 * floor(gl_FragCoord.y), 4.0) - 1.5) / 255.0;
        scene.rgb += grain * 0.006 + ordered * 0.35;
    }
    outColor = vec4(max(scene.rgb, vec3(0.0)), 1.0);
}`;

const BLOOM_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 outColor;
uniform sampler2D u_input;
uniform vec2 u_texel;
uniform bool u_extract;

vec3 sampleAt(vec2 uv) { return texture(u_input, clamp(uv, vec2(0.0), vec2(1.0))).rgb; }

void main() {
    vec3 sum = vec3(0.0);
    if (u_extract) {
        // Bright extraction plus the first Kawase taps in one pass keeps the
        // full chain at four draws and the reduced chain at three.
        for (int x = -1; x <= 1; x++) {
            for (int y = -1; y <= 1; y++) {
                vec3 c = sampleAt(v_uv + vec2(float(x), float(y)) * u_texel * 2.0);
                sum += max(c - vec3(0.62), vec3(0.0));
            }
        }
        sum = sum / 9.0 * 1.35;
    } else {
        sum = sampleAt(v_uv) * 0.20;
        sum += sampleAt(v_uv + vec2( 1.0,  1.0) * u_texel * 2.0) * 0.16;
        sum += sampleAt(v_uv + vec2(-1.0,  1.0) * u_texel * 2.0) * 0.16;
        sum += sampleAt(v_uv + vec2( 1.0, -1.0) * u_texel * 2.0) * 0.16;
        sum += sampleAt(v_uv + vec2(-1.0, -1.0) * u_texel * 2.0) * 0.16;
        sum += sampleAt(v_uv + vec2( 2.0,  0.0) * u_texel * 2.0) * 0.08;
        sum += sampleAt(v_uv + vec2(-2.0,  0.0) * u_texel * 2.0) * 0.08;
    }
    outColor = vec4(sum, 1.0);
}`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 outColor;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
void main() {
    vec3 scene = texture(u_scene, clamp(v_uv, vec2(0.0), vec2(1.0))).rgb;
    vec3 bloom = texture(u_bloom, clamp(v_uv, vec2(0.0), vec2(1.0))).rgb;
    outColor = vec4(scene + bloom * u_bloomStrength, 1.0);
}`;

function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function parseColor(value, fallback = [1, 1, 1]) {
    if (Array.isArray(value) && value.length >= 3) {
        return value.slice(0, 3).map(channel => clamp(finite(channel, 255) / 255, 0, 1));
    }
    const text = String(value || '');
    const rgb = text.match(/rgba?\(([^)]+)\)/i);
    if (rgb) {
        const parts = rgb[1].split(',').map(Number);
        return parts.slice(0, 3).map(channel => clamp(finite(channel, 255) / 255, 0, 1));
    }
    const hex = text.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
        return [0, 1, 2].map(index => parseInt(hex[1].slice(index * 2, index * 2 + 2), 16) / 255);
    }
    return fallback.slice();
}

function parseColorAlpha(value) {
    const match = String(value || '').match(/rgba?\(([^)]+)\)/i);
    if (!match) return 1;
    const parts = match[1].split(',').map(Number);
    return clamp(finite(parts[3], 1), 0, 1);
}

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader) || 'unknown shader error';
        gl.deleteShader(shader);
        throw new Error(info);
    }
    return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    let fragment;
    try {
        fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    } catch (error) {
        gl.deleteShader(vertex);
        throw error;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program) || 'unknown program error';
        gl.deleteProgram(program);
        throw new Error(info);
    }
    return program;
}

function setEma(previous, sample) {
    const value = Math.max(0, finite(sample));
    return previous === null ? value : previous + (value - previous) * EMA_ALPHA;
}

function timingNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

class PostFxInstance {
    constructor(canvas, enabled) {
        this.canvas = canvas;
        this.enabled = enabled !== false;
        this.supported = false;
        this.contextHealthy = false;
        this.disposed = false;
        this.suspended = false;
        this.width = Math.max(1, Math.floor(canvas?.width || 1));
        this.height = Math.max(1, Math.floor(canvas?.height || 1));
        this.frames = 0;
        this.lightCount = 0;
        this.uploadMs = null;
        this.maskUploadMs = null;
        this.setupCpuMs = null;
        this.shaderCpuMs = null;
        // Backward-compatible alias for diagnostics consumers. It now means
        // shader-command CPU only; setup and full-frame upload stay separate.
        this.cpuMs = null;
        this.gpuMs = null;
        this.frameGapMs = 0;
        this.renderTotalCpuMs = null;
        this.textureBytes = 0;
        this.resourceBytes = gpuResourceAccounting();
        this.sourceCanvasPixels = 0;
        this.unifiedResources = unifiedRendererResourceAccounting();
        this._frameMaskUploadMs = 0;
        this.pendingGpuQueries = [];
        this.timerExtension = null;
        this.ladder = createPostFxLadder();
        this.sourceTexture = null;
        this.waterMaskTexture = null;
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
        this.maskCanvas = null;
        this.maskWidth = 1;
        this.maskHeight = 1;
        this.maskRevision = null;
        // Reused per-frame uniform staging; sized to the shader array bounds.
        this.hazeValues = new Float32Array(MAX_HAZE_ANCHORS * 4);
        this.lightValues = new Float32Array(MAX_LIGHTS * 4);
        this.lightColors = new Float32Array(MAX_LIGHTS * 4);
        this._onContextLost = event => {
            event.preventDefault();
            this.contextHealthy = false;
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
                this.contextHealthy = true;
                this.resize(this.width, this.height);
            } catch {
                this.contextHealthy = false;
            }
        };

        if (!canvas || typeof canvas.getContext !== 'function') return;
        canvas.addEventListener?.('webglcontextlost', this._onContextLost, false);
        canvas.addEventListener?.('webglcontextrestored', this._onContextRestored, false);
        try {
            this.gl = canvas.getContext('webgl2', {
                alpha: true,
                premultipliedAlpha: true,
                antialias: false,
                depth: false,
                stencil: false,
                preserveDrawingBuffer: false,
            });
            if (!this.gl) {
                canvas.removeEventListener?.('webglcontextlost', this._onContextLost, false);
                canvas.removeEventListener?.('webglcontextrestored', this._onContextRestored, false);
                return;
            }
            this.supported = true;
            this.contextHealthy = true;
            this._initResources();
            this.resize(this.width, this.height);
        } catch (error) {
            console.warn('[PostFx] init failed, staying on Canvas 2D grade:', error);
            this.contextHealthy = false;
            if (!this.supported) {
                canvas.removeEventListener?.('webglcontextlost', this._onContextLost, false);
                canvas.removeEventListener?.('webglcontextrestored', this._onContextRestored, false);
            }
        }
    }

    _initResources() {
        const gl = this.gl;
        this._releaseGpuResources();
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.BLEND);
        this.mainProgram = createProgram(gl, FULLSCREEN_VERTEX, MAIN_FRAGMENT);
        this.bloomProgram = createProgram(gl, FULLSCREEN_VERTEX, BLOOM_FRAGMENT);
        this.compositeProgram = createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
        this.timerExtension = gl.getExtension?.('EXT_disjoint_timer_query_webgl2') || null;
        this.sourceTexture = this._createTexture(1, 1);
        this.waterMaskTexture = this._createTexture(1, 1);
        this.maskCanvas = null;
        this.maskWidth = 1;
        this.maskHeight = 1;
        this.maskRevision = null;
        this._cacheUniformLocations();
        gl.bindVertexArray(null);
    }

    _cacheUniformLocations() {
        const gl = this.gl;
        const locations = (program, names) => names.reduce((out, name) => {
            out[name] = gl.getUniformLocation(program, name);
            return out;
        }, {});
        this.mainUniforms = locations(this.mainProgram, [
            'u_source', 'u_waterMask', 'u_resolution', 'u_sourceTexel', 'u_maskTexel', 'u_rayTexel',
            'u_flow', 'u_sun', 'u_pulse', 'u_gradeBase', 'u_gradeEdge', 'u_edgeAlpha',
            'u_tint', 'u_tintAlpha', 'u_lightGlowScale', 'u_time', 'u_motionScale',
            'u_reducedMotion', 'u_waterEnabled', 'u_displacementEnabled',
            'u_reflectionEnabled', 'u_godRaysEnabled', 'u_pulseEnabled',
            'u_grainEnabled', 'u_hazeCount', 'u_lightCount',
            'u_haze[0]', 'u_lights[0]', 'u_lightColors[0]',
        ]);
        this.bloomUniforms = locations(this.bloomProgram, ['u_input', 'u_texel', 'u_extract']);
        this.compositeUniforms = locations(this.compositeProgram, ['u_scene', 'u_bloom', 'u_bloomStrength']);
    }

    _createTexture(width, height) {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return texture;
    }

    _createTarget(width, height) {
        const gl = this.gl;
        const texture = this._createTexture(width, height);
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(framebuffer);
            gl.deleteTexture(texture);
            throw new Error('PostFX framebuffer is incomplete');
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { framebuffer, texture, width, height };
    }

    _releaseTarget(target) {
        if (!target || !this.gl) return;
        this.gl.deleteFramebuffer(target.framebuffer);
        this.gl.deleteTexture(target.texture);
    }

    _releaseGpuResources() {
        const gl = this.gl;
        if (!gl) return;
        if (gl.isContextLost?.()) {
            this._abandonGpuResources();
            return;
        }
        this._releaseTarget(this.sceneTarget);
        this._releaseTarget(this.bloomA);
        this._releaseTarget(this.bloomB);
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
        if (this.sourceTexture) gl.deleteTexture(this.sourceTexture);
        if (this.waterMaskTexture) gl.deleteTexture(this.waterMaskTexture);
        this.sourceTexture = null;
        this.waterMaskTexture = null;
        if (this.mainProgram) gl.deleteProgram(this.mainProgram);
        if (this.bloomProgram) gl.deleteProgram(this.bloomProgram);
        if (this.compositeProgram) gl.deleteProgram(this.compositeProgram);
        this.mainProgram = null;
        this.bloomProgram = null;
        this.compositeProgram = null;
        if (this.vao) gl.deleteVertexArray(this.vao);
        this.vao = null;
    }

    _abandonGpuResources() {
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
        this.sourceTexture = null;
        this.waterMaskTexture = null;
        this.mainProgram = null;
        this.bloomProgram = null;
        this.compositeProgram = null;
        this.vao = null;
        this.pendingGpuQueries.length = 0;
        this.timerExtension = null;
        this.textureBytes = 0;
        this.resourceBytes = gpuResourceAccounting();
        this.unifiedResources = unifiedRendererResourceAccounting({
            visibleCanvasPixels: this.sourceCanvasPixels,
            gpu: this.resourceBytes,
        });
    }

    _updateTextureBytes() {
        const targetBytes = target => target ? target.width * target.height * 4 : 0;
        this.resourceBytes = gpuResourceAccounting({
            textures: {
                source: this.sourceTexture ? this.width * this.height * 4 : 0,
                waterMask: this.waterMaskTexture ? this.maskWidth * this.maskHeight * 4 : 0,
            },
            attachments: {
                presentation: this.gl ? this.width * this.height * 4 : 0,
                sceneColor: targetBytes(this.sceneTarget),
                bloomA: targetBytes(this.bloomA),
                bloomB: targetBytes(this.bloomB),
            },
        });
        this.textureBytes = this.resourceBytes.totalBytes;
        this.unifiedResources = unifiedRendererResourceAccounting({
            visibleCanvasPixels: this.sourceCanvasPixels,
            gpu: this.resourceBytes,
        });
    }

    _ensureTargets(level) {
        if (level >= POST_FX_LEVELS.MINIMAL) {
            this._releaseTarget(this.sceneTarget);
            this._releaseTarget(this.bloomA);
            this._releaseTarget(this.bloomB);
            this.sceneTarget = null;
            this.bloomA = null;
            this.bloomB = null;
            this._updateTextureBytes();
            return;
        }

        const bloomScale = level === POST_FX_LEVELS.REDUCED ? 0.25 : 0.5;
        const bloomWidth = Math.max(1, Math.floor(this.width * bloomScale));
        const bloomHeight = Math.max(1, Math.floor(this.height * bloomScale));
        const needsSecondBloom = level === POST_FX_LEVELS.FULL;
        const targetsMatch = this.sceneTarget?.width === this.width
            && this.sceneTarget?.height === this.height
            && this.bloomA?.width === bloomWidth
            && this.bloomA?.height === bloomHeight
            && (needsSecondBloom
                ? this.bloomB?.width === bloomWidth && this.bloomB?.height === bloomHeight
                : !this.bloomB);
        if (targetsMatch) return;

        this._releaseTarget(this.sceneTarget);
        this._releaseTarget(this.bloomA);
        this._releaseTarget(this.bloomB);
        this.sceneTarget = this._createTarget(this.width, this.height);
        this.bloomA = this._createTarget(bloomWidth, bloomHeight);
        this.bloomB = needsSecondBloom ? this._createTarget(bloomWidth, bloomHeight) : null;
        this._updateTextureBytes();
    }

    resize(backingWidth, backingHeight) {
        const width = Math.max(1, Math.floor(finite(backingWidth, this.width)));
        const height = Math.max(1, Math.floor(finite(backingHeight, this.height)));
        this.width = width;
        this.height = height;
        if (this.canvas) {
            if (this.canvas.width !== width) this.canvas.width = width;
            if (this.canvas.height !== height) this.canvas.height = height;
            if (this.canvas.style) {
                this.canvas.style.pointerEvents = 'none';
                this.canvas.style.imageRendering = 'pixelated';
            }
        }
        if (!this.gl || !this.contextHealthy || this.suspended) return;
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this._ensureTargets(this.ladder.getLevel());
    }

    isActive() {
        return Boolean(this.enabled && this.supported && this.contextHealthy && !this.disposed
            && !this.suspended
            && this.ladder.getLevel() < 3);
    }

    suspend() {
        if (this.disposed || this.suspended) return;
        this.suspended = true;
        if (this.gl && !this.gl.isContextLost?.()) {
            for (const query of this.pendingGpuQueries) this.gl.deleteQuery(query);
        }
        this.pendingGpuQueries.length = 0;
        this._releaseGpuResources();
        this.textureBytes = 0;
        this.sourceCanvasPixels = 0;
        this.resourceBytes = gpuResourceAccounting();
        this.unifiedResources = unifiedRendererResourceAccounting({
            visibleCanvasPixels: this.sourceCanvasPixels,
            gpu: this.resourceBytes,
        });
    }

    resume() {
        if (this.disposed || !this.suspended || !this.gl) return this.isActive();
        try {
            this.suspended = false;
            this._initResources();
            this.contextHealthy = true;
            this.resize(this.width, this.height);
            return true;
        } catch (error) {
            this.suspended = true;
            this.contextHealthy = false;
            console.warn('[PostFx] resume failed; Canvas grade remains active:', error);
            return false;
        }
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
    }

    setLevelOverride(levelOrNull) {
        const level = this.ladder.setOverride(levelOrNull);
        if (this.gl && this.contextHealthy) this.resize(this.width, this.height);
        return level;
    }

    _uploadSource(sourceCanvas) {
        const gl = this.gl;
        if (!sourceCanvas || !this.sourceTexture) return false;
        const started = timingNow();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
        gl.bindTexture(gl.TEXTURE_2D, null);
        const ended = timingNow();
        this.uploadMs = setEma(this.uploadMs, ended - started);
        return true;
    }

    _uploadMask(maskCanvas, revision = null) {
        const gl = this.gl;
        if (!maskCanvas || !this.waterMaskTexture) return false;
        const width = Math.max(1, Math.floor(maskCanvas.width || 1));
        const height = Math.max(1, Math.floor(maskCanvas.height || 1));
        const storageChanged = this.maskCanvas !== maskCanvas
            || this.maskWidth !== width
            || this.maskHeight !== height;
        // The feed reuses one mask canvas and redraws it in place on camera
        // moves, so identity alone would freeze the GPU copy at its first
        // pose; the revision counter marks in-place repaints.
        const contentChanged = revision !== null && revision !== this.maskRevision;
        if (!storageChanged && !contentChanged) return true;
        const started = timingNow();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.waterMaskTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        if (storageChanged) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
            this.maskCanvas = maskCanvas;
            this.maskWidth = width;
            this.maskHeight = height;
            this._updateTextureBytes();
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
        }
        this.maskRevision = revision;
        gl.bindTexture(gl.TEXTURE_2D, null);
        this._frameMaskUploadMs += Math.max(0, timingNow() - started);
        return true;
    }

    _beginTimer() {
        if (!this.timerExtension) return null;
        const gl = this.gl;
        const query = gl.createQuery();
        gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query);
        return query;
    }

    _endTimer(query) {
        if (!query || !this.timerExtension) return;
        const gl = this.gl;
        gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
        this.pendingGpuQueries.push(query);
        if (this.pendingGpuQueries.length > 4) {
            const stale = this.pendingGpuQueries.shift();
            gl.deleteQuery(stale);
        }
    }

    _pollGpuQueries() {
        if (!this.timerExtension) return;
        const gl = this.gl;
        const disjoint = gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT);
        for (let i = this.pendingGpuQueries.length - 1; i >= 0; i--) {
            const query = this.pendingGpuQueries[i];
            if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
            this.pendingGpuQueries.splice(i, 1);
            if (!disjoint) this.gpuMs = setEma(this.gpuMs, gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
            gl.deleteQuery(query);
        }
    }

    _setMainUniforms(feed, level) {
        const gl = this.gl;
        const uniforms = this.mainUniforms;
        const reducedMotion = Boolean(feed?.reducedMotion);
        const motionScale = reducedMotion ? 0 : clamp(finite(feed?.motionScale, 1), 0, 2);
        const phase = typeof feed?.phase === 'string' ? feed.phase : 'day';
        // 3.4 — the hybrid path selects the same reviewed night moon course.
        const lighting = feed?.lighting || {};
        const phaseGrade = worldPhaseGrade(phase, lighting.moonFill);
        const grade = feed?.grade || {};
        const worldTint = parseColor(grade.worldTint, [0.5, 0.5, 0.5]);
        const edge = phaseGrade.edge;
        const base = phaseGrade.base;
        const flow = feed?.water
            ? [clamp(finite(feed.water.flowX), -1, 1), clamp(finite(feed.water.flowY), -1, 1)]
            : [0, 0];
        const pulse = feed?.pulse || null;
        const sun = feed?.sun || null;
        const pulseValues = [
            clamp(finite(pulse?.r, 0) / 255, 0, 1),
            clamp(finite(pulse?.g, 0) / 255, 0, 1),
            clamp(finite(pulse?.b, 0) / 255, 0, 1),
        ];
        const effectRich = level <= POST_FX_LEVELS.REDUCED;
        const fullEffects = level === POST_FX_LEVELS.FULL;
        const pulseStrength = effectRich ? clamp(finite(pulse?.strength, 0), 0, 1) : 0;
        const sunValues = fullEffects && sun ? [
            finite(sun.x), finite(sun.y), clamp(finite(sun.intensity, 0), 0, 1),
        ] : [0, 0, 0];

        gl.uniform1i(uniforms.u_source, 0);
        gl.uniform1i(uniforms.u_waterMask, 1);
        // The source, scene target, and presentation coordinates always match
        // backing pixels; only auxiliary bloom buffers are sub-resolution.
        gl.uniform2f(uniforms.u_resolution, this.width, this.height);
        gl.uniform2f(uniforms.u_sourceTexel, 1 / this.width, 1 / this.height);
        gl.uniform2f(uniforms.u_maskTexel, 1 / this.maskWidth, 1 / this.maskHeight);
        gl.uniform2f(uniforms.u_rayTexel, 1 / (this.width * GOD_RAY_SCALE), 1 / (this.height * GOD_RAY_SCALE));
        gl.uniform2f(uniforms.u_flow, flow[0], flow[1]);
        gl.uniform3f(uniforms.u_sun, sunValues[0], sunValues[1], sunValues[2]);
        gl.uniform4f(uniforms.u_pulse, pulseValues[0], pulseValues[1], pulseValues[2], pulseStrength);
        gl.uniform3f(uniforms.u_gradeBase, base[0], base[1], base[2]);
        gl.uniform3f(uniforms.u_gradeEdge, edge[0], edge[1], edge[2]);
        gl.uniform1f(uniforms.u_edgeAlpha, clamp(finite(phaseGrade.edgeAlpha), 0, 1));
        gl.uniform3f(uniforms.u_tint, worldTint[0], worldTint[1], worldTint[2]);
        gl.uniform1f(uniforms.u_tintAlpha, parseColorAlpha(grade.worldTint));
        // 3.1 — one exposure envelope: the hybrid glow spends the same core
        // share as the Canvas stamps it must match, and nothing multiplies
        // lightBoost, the beacon factor, and the glow scale together any more.
        const core = clamp(finite(sourceEnergyFor(lighting).core, 1), 0, 2);
        const beacon = Number(lighting.beaconIntensity);
        const ambient = Number(lighting.ambientLight);
        const nightFactor = clamp(Number.isFinite(beacon) ? beacon
            : (Number.isFinite(ambient) ? 1 - ambient : 0), 0, 1);
        this._glowNightFactor = nightFactor;
        this._localLightPhase = localLightPhaseForLighting(lighting);
        // 2D parity: `_drawLightGlowStamps` composites at 0.14 * core over a
        // stamp whose stop alphas already carry the same core — hence squared.
        const glowScale = 0.14 * core * core;
        this._glowScale = glowScale;
        gl.uniform1f(uniforms.u_lightGlowScale, glowScale);
        gl.uniform1f(uniforms.u_time, finite(feed?.timeMs));
        gl.uniform1f(uniforms.u_motionScale, motionScale);
        gl.uniform1i(uniforms.u_reducedMotion, reducedMotion ? 1 : 0);
        const waterEnabled = effectRich && Boolean(feed?.water?.mask);
        gl.uniform1i(uniforms.u_waterEnabled, waterEnabled ? 1 : 0);
        gl.uniform1i(uniforms.u_displacementEnabled, effectRich ? 1 : 0);
        gl.uniform1i(uniforms.u_reflectionEnabled, fullEffects && waterEnabled ? 1 : 0);
        gl.uniform1i(uniforms.u_godRaysEnabled, fullEffects ? 1 : 0);
        gl.uniform1i(uniforms.u_pulseEnabled, effectRich ? 1 : 0);
        gl.uniform1i(uniforms.u_grainEnabled, effectRich ? 1 : 0);

        this.hazeValues.fill(0);
        const haze = Array.isArray(feed?.haze) ? feed.haze : [];
        const hazeCount = effectRich ? Math.min(MAX_HAZE_ANCHORS, haze.length) : 0;
        for (let i = 0; i < hazeCount; i++) {
            const anchor = haze[i] || {};
            this.hazeValues[i * 4] = finite(anchor.x);
            this.hazeValues[i * 4 + 1] = finite(anchor.y);
            this.hazeValues[i * 4 + 2] = Math.max(1, finite(anchor.radius, 1));
            this.hazeValues[i * 4 + 3] = clamp(finite(anchor.strength), 0, 1);
        }
        gl.uniform1i(uniforms.u_hazeCount, hazeCount);
        gl.uniform4fv(uniforms['u_haze[0]'], this.hazeValues);

        this.lightValues.fill(0);
        this.lightColors.fill(0);
        const lights = Array.isArray(feed?.lights) ? feed.lights : [];
        let lightCount = 0;
        // Lantern-prop halos replicate _drawLanternGlows: globalAlpha
        // 0.42 * nightFactor over a near-unity stamp. Cancel the ambient
        // glow scale and substitute the lantern envelope in the alpha slot.
        const lanternScale = (0.42 * (this._glowNightFactor ?? 0)) / Math.max(0.02, this._glowScale ?? 0.14);
        const lanternsVisible = (this._glowNightFactor ?? 0) > 0.05;
        for (let i = 0; i < lights.length && lightCount < MAX_LIGHTS; i++) {
            const light = lights[i] || {};
            if (light.kind === 'beam') continue; // beam wedges are not radial stamps in the 2D path
            if (light.night && !lanternsVisible) continue; // 2D gate: prop halos only after dusk
            if (!light.night && this._localLightPhase <= 0.04) continue;
            if (!Number.isFinite(Number(light.x)) || !Number.isFinite(Number(light.y))) continue;
            const offset = lightCount * 4;
            this.lightValues[offset] = finite(light.x);
            this.lightValues[offset + 1] = finite(light.y);
            this.lightValues[offset + 2] = Math.max(1, finite(light.radius, 1));
            this.lightValues[offset + 3] = Math.max(0, finite(light.intensity, 1));
            this.lightColors[offset] = clamp(finite(light.r, 255) / 255, 0, 1);
            this.lightColors[offset + 1] = clamp(finite(light.g, 255) / 255, 0, 1);
            this.lightColors[offset + 2] = clamp(finite(light.b, 255) / 255, 0, 1);
            this.lightColors[offset + 3] = light.night ? lanternScale : this._localLightPhase;
            lightCount++;
        }
        this.lightCount = lightCount;
        gl.uniform1i(uniforms.u_lightCount, lightCount);
        gl.uniform4fv(uniforms['u_lights[0]'], this.lightValues);
        gl.uniform4fv(uniforms['u_lightColors[0]'], this.lightColors);
    }

    render(sourceCanvas, feed = {}) {
        if (!this.isActive() || !this.gl || !sourceCanvas) return false;
        const gl = this.gl;
        try {
            const frameStart = timingNow();
            const sourcePixels = canvasPixelCount(sourceCanvas);
            if (sourcePixels !== this.sourceCanvasPixels) {
                this.sourceCanvasPixels = sourcePixels;
                this._updateTextureBytes();
            }
            this._frameMaskUploadMs = 0;
            this._pollGpuQueries();
            const level = this.ladder.getLevel();
            if (!this._uploadSource(sourceCanvas)) return false;
            const setupStart = timingNow();
            this._ensureTargets(level);
            if (level <= POST_FX_LEVELS.REDUCED && feed?.water?.mask) {
                this._uploadMask(feed.water.mask, feed.water.maskRevision ?? null);
            }
            const setupSample = Math.max(0, timingNow() - setupStart - this._frameMaskUploadMs);
            this.setupCpuMs = setEma(this.setupCpuMs, setupSample);
            this.maskUploadMs = setEma(this.maskUploadMs, this._frameMaskUploadMs);

            const shaderStart = timingNow();
            gl.bindVertexArray(this.vao);
            const timer = this._beginTimer();
            const minimal = level === POST_FX_LEVELS.MINIMAL;
            gl.bindFramebuffer(gl.FRAMEBUFFER, minimal ? null : this.sceneTarget.framebuffer);
            gl.viewport(0, 0, this.width, this.height);
            gl.useProgram(this.mainProgram);
            this._setMainUniforms(feed, level);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
            if (!minimal) {
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, this.waterMaskTexture);
            }
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            if (!minimal) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.framebuffer);
                gl.viewport(0, 0, this.bloomA.width, this.bloomA.height);
                gl.useProgram(this.bloomProgram);
                gl.uniform1i(this.bloomUniforms.u_input, 0);
                gl.uniform2f(this.bloomUniforms.u_texel, 1 / this.width, 1 / this.height);
                gl.uniform1i(this.bloomUniforms.u_extract, 1);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.texture);
                gl.drawArrays(gl.TRIANGLES, 0, 3);

                let bloomTexture = this.bloomA.texture;
                if (level === POST_FX_LEVELS.FULL) {
                    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.framebuffer);
                    gl.viewport(0, 0, this.bloomB.width, this.bloomB.height);
                    gl.uniform1i(this.bloomUniforms.u_extract, 0);
                    gl.uniform2f(this.bloomUniforms.u_texel, 1 / this.bloomA.width, 1 / this.bloomA.height);
                    gl.bindTexture(gl.TEXTURE_2D, this.bloomA.texture);
                    gl.drawArrays(gl.TRIANGLES, 0, 3);
                    bloomTexture = this.bloomB.texture;
                }

                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.viewport(0, 0, this.width, this.height);
                gl.useProgram(this.compositeProgram);
                gl.uniform1i(this.compositeUniforms.u_scene, 0);
                gl.uniform1i(this.compositeUniforms.u_bloom, 1);
                // No light records means no emissive source: keep the contract's
                // safe "grade only" fallback instead of blooming bright terrain.
                gl.uniform1f(
                    this.compositeUniforms.u_bloomStrength,
                    this.lightCount > 0 ? 0.72 : 0,
                );
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.texture);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, bloomTexture);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            }
            this._endTimer(timer);

            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindVertexArray(null);
            const frameEnd = timingNow();
            this.shaderCpuMs = setEma(this.shaderCpuMs, frameEnd - shaderStart);
            this.cpuMs = this.shaderCpuMs;
            this.renderTotalCpuMs = setEma(this.renderTotalCpuMs, frameEnd - frameStart);
            // Gap between consecutive renders catches driver stalls that the
            // instrumented upload/cpu/gpu windows cannot see.
            const frameGapMs = this._lastRenderEndMs != null ? frameEnd - this._lastRenderEndMs : 0;
            this.frameGapMs = frameGapMs;
            this._lastRenderEndMs = frameEnd;
            this.ladder.update({
                uploadMs: this.uploadMs || 0,
                auxUploadMs: this.maskUploadMs || 0,
                setupCpuMs: this.setupCpuMs || 0,
                shaderCpuMs: this.shaderCpuMs || 0,
                gpuMs: this.gpuMs,
                frameGapMs,
            }, frameEnd);
            this.frames++;
            return true;
        } catch (error) {
            // A poisoned context flag with no trace makes shader bugs
            // undiagnosable; warn once, then fall back silently.
            if (!this._renderErrorLogged) {
                this._renderErrorLogged = true;
                console.warn('[PostFx] render failed, falling back to Canvas 2D grade:', error);
            }
            this.contextHealthy = false;
            return false;
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.canvas?.removeEventListener?.('webglcontextlost', this._onContextLost, false);
        this.canvas?.removeEventListener?.('webglcontextrestored', this._onContextRestored, false);
        if (this.gl && !this.gl.isContextLost?.()) {
            for (const query of this.pendingGpuQueries) this.gl.deleteQuery(query);
        }
        this._releaseGpuResources();
        this.pendingGpuQueries.length = 0;
        this.textureBytes = 0;
        this.resourceBytes = gpuResourceAccounting();
        this.sourceCanvasPixels = 0;
        this.unifiedResources = unifiedRendererResourceAccounting();
        this.contextHealthy = false;
    }

    getResourceAccounting() {
        return {
            textures: { ...(this.resourceBytes?.textures || {}) },
            attachments: { ...(this.resourceBytes?.attachments || {}) },
            buffers: { ...(this.resourceBytes?.buffers || {}) },
            groupTotals: { ...(this.resourceBytes?.groupTotals || {}) },
            totalBytes: Number(this.resourceBytes?.totalBytes) || 0,
        };
    }

    getDiagnostics() {
        const ladder = this.ladder.getState();
        return {
            supported: this.supported,
            active: this.isActive(),
            suspended: this.suspended,
            level: this.ladder.getLevel(),
            uploadMs: this.uploadMs ?? 0,
            maskUploadMs: this.maskUploadMs ?? 0,
            setupCpuMs: this.setupCpuMs ?? 0,
            shaderCpuMs: this.shaderCpuMs ?? 0,
            gpuMs: this.timerExtension ? (this.gpuMs ?? 0) : null,
            // Compatibility for existing diagnostics readers.
            cpuMs: this.cpuMs ?? 0,
            renderTotalCpuMs: this.renderTotalCpuMs ?? 0,
            frameGapMs: this.frameGapMs,
            textureBytes: this.textureBytes,
            resources: this.getResourceAccounting(),
            unifiedResources: {
                canvas: { ...(this.unifiedResources?.canvas || {}) },
                canvasBytes: this.unifiedResources?.canvasBytes || 0,
                gpuBytes: this.unifiedResources?.gpuBytes || 0,
                totalBytes: this.unifiedResources?.totalBytes || 0,
                budgetBytes: this.unifiedResources?.budgetBytes || 0,
            },
            ladder: {
                effectiveLevel: ladder.effectiveLevel,
                lastScore: ladder.lastScore,
                lastDriver: ladder.lastDriver,
                lastDecisionReason: ladder.lastDecisionReason,
                lastDegradationReason: ladder.lastDegradationReason,
                lastTransitionAtMs: ladder.lastTransitionAtMs,
                lastTransitionMetrics: ladder.lastTransitionMetrics
                    ? { ...ladder.lastTransitionMetrics }
                    : null,
                overBudgetFrames: ladder.overBudgetFrames,
                healthySinceMs: ladder.healthySinceMs,
                override: ladder.override,
                budgetMs: ladder.options?.budgetMs ?? null,
                healthyMs: ladder.options?.healthyMs ?? null,
            },
            frames: this.frames,
        };
    }
}

export function createPostFx({ canvas, enabled = true } = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    const instance = new PostFxInstance(canvas, enabled);
    return instance.supported ? instance : null;
}
