// AssetManager loads sprites declared in manifest.yaml, decodes them into
// HTMLImageElements plus interaction-only alpha masks/outlines, and exposes lookup by id.

import {
    MATERIAL_CHANNELS,
    companionPathFor,
    defaultChannelPixel,
    materialDebugDescriptor,
    normalizeAtlasFrame,
    normalizeMaterialMetadata,
} from './MaterialRegistry.js';
import {
    RESOURCE_OWNERSHIP,
    registerRendererResourceEstimateProvider,
    shouldEvictAtHighWater,
    unpinnedCacheKeys,
} from './CanvasBudget.js';

const PLACEHOLDER_PATH = 'assets/sprites/_placeholder/checker-64.png';
const OUTLINE_COLOR = '#f2d36b';
const ALPHA_THRESHOLD = 16;
const OPTIONAL_SIDECAR_HIGH_WATER_ESTIMATE_BYTES = 192 * 1024 * 1024;
const DERIVED_ART_SLICE_MS = 2;
const AGENT_CELL_DIRECTIONS = Object.freeze(['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw']);
const WALK_ROWS = 6;
const CHARACTER_RETRY_BASE_MS = 5_000;
const CHARACTER_RETRY_MAX_MS = 60_000;
let assetManagerResourceSequence = 0;
let derivedArtJobSequence = 0;

export const DERIVED_ART_PRIORITY = Object.freeze({
    SELECTED_WAITING_ERROR: 0,
    ONSCREEN_LANDMARK: 1,
    BACKGROUND_PROFILE: 2,
});

export function materialChannelCacheKey(assetVersion, atlasKey, frameKey) {
    return `${String(assetVersion || '')}::${String(atlasKey || '')}::${String(frameKey || '')}`;
}

export function resolveMaterialChannelSources({ sidecar = {}, atlas = {} } = {}) {
    const pick = (channel) => {
        if (sidecar?.[channel]) return { source: sidecar[channel], origin: 'sidecar' };
        if (atlas?.[channel]) return { source: atlas[channel], origin: 'atlas' };
        return {
            source: null,
            origin: 'fallback',
            pixel: defaultChannelPixel(channel),
        };
    };
    const material = pick('material');
    const emissive = pick('emissive');
    const occluder = pick('occluder');
    const origin = [material, emissive, occluder].some((entry) => entry.origin === 'sidecar')
        ? 'sidecar'
        : [material, emissive, occluder].some((entry) => entry.origin === 'atlas')
            ? 'atlas'
            : 'fallback';
    return {
        origin,
        material: material.source,
        emissive: emissive.source,
        occluder: occluder.source,
        channels: Object.freeze({ material, emissive, occluder }),
        pixels: Object.freeze({
            material: material.pixel || defaultChannelPixel('material'),
            emissive: emissive.pixel || defaultChannelPixel('emissive'),
            occluder: occluder.pixel || defaultChannelPixel('occluder'),
        }),
    };
}

export function agentFrameKeyFromCell(cell = {}, cellSize = 92) {
    const size = Math.max(1, Number(cell.sw) || Number(cellSize) || 92);
    const col = Math.floor((Number(cell.sx) || 0) / size);
    const row = Math.floor((Number(cell.sy) || 0) / size);
    const idle = row >= WALK_ROWS;
    const frame = idle ? row - WALK_ROWS : row;
    const dir = AGENT_CELL_DIRECTIONS[((col % 8) + 8) % 8] || 's';
    return `${idle ? 'idle' : 'walk'}/${dir}/${Math.max(0, frame)}`;
}

// C2 action strips live beside the base sheet and are addressed by the manifest
// `actionStrip.path`, which is sprites-root relative like every other
// manifest-implied path.
export function actionStripPathFor(meta) {
    const raw = typeof meta?.path === 'string' ? meta.path.trim() : '';
    if (!raw) return null;
    return `assets/sprites/${raw.replace(/^\/+/, '').replace(/^assets\/sprites\//, '')}`;
}

// Returns a reason string when the loaded strip cannot serve its declared
// groups, so the character stays strip-less instead of drawing wrong cells.
export function actionStripMismatch(meta, image) {
    const cell = Number(meta?.cell);
    if (!Number.isInteger(cell) || cell <= 0) return 'actionStrip.cell must be a positive integer';
    const columns = AGENT_CELL_DIRECTIONS.length;
    const width = Number(image?.width) || 0;
    const height = Number(image?.height) || 0;
    if (width !== columns * cell) return `width ${width} != ${columns * cell}`;
    if (height < cell || height % cell !== 0) return `height ${height} is not whole ${cell}px rows`;
    const rows = height / cell;
    const groups = meta?.groups;
    if (!groups || typeof groups !== 'object' || !Object.keys(groups).length) return 'actionStrip.groups is empty';
    for (const [name, group] of Object.entries(groups)) {
        const range = group?.rows;
        if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger)
            || range[0] < 0 || range[1] < range[0] || range[1] >= rows) {
            return `groups.${name} rows must be an inclusive range inside 0–${rows - 1}`;
        }
    }
    return null;
}

export function atlasSourceRect(rect = {}, {
    split = false,
    front = false,
    horizonY = null,
} = {}) {
    const x = Math.max(0, Math.round(Number(rect.x) || 0));
    const y = Math.max(0, Math.round(Number(rect.y) || 0));
    const w = Math.max(1, Math.round(Number(rect.w ?? rect.width) || 1));
    const h = Math.max(1, Math.round(Number(rect.h ?? rect.height) || 1));
    if (!split) return { sx: x, sy: y, sw: w, sh: h };
    const horizon = Math.max(1, Math.min(Math.round(Number(horizonY)), h - 1));
    if (!Number.isFinite(horizon) || horizon <= 0) return { sx: x, sy: y, sw: w, sh: h };
    if (front) return { sx: x, sy: y + horizon, sw: w, sh: h - horizon };
    return { sx: x, sy: y, sw: w, sh: horizon };
}

export function shouldUseAtlasForCategory({
    atlasBytes = 0,
    individualBytes = 0,
    recordCount = 0,
    atlasResident = false,
} = {}) {
    const atlas = Math.max(0, Number(atlasBytes) || 0);
    const individual = Math.max(0, Number(individualBytes) || 0);
    const count = Math.max(0, Math.floor(Number(recordCount) || 0));
    if (count <= 0 || atlas <= 0) return false;
    if (atlasResident) return true;
    if (individual >= atlas) return true;
    return count >= 2;
}

export function derivedArtPriority(job = {}) {
    const status = String(job.status || '').toLowerCase();
    if (job.selected || status === 'waiting_on_user' || status === 'errored') {
        return DERIVED_ART_PRIORITY.SELECTED_WAITING_ERROR;
    }
    if (job.onScreen && (job.kind === 'landmark' || job.kind === 'building'
        || job.kind === 'prop' || job.kind === 'agent')) {
        return DERIVED_ART_PRIORITY.ONSCREEN_LANDMARK;
    }
    return DERIVED_ART_PRIORITY.BACKGROUND_PROFILE;
}

export function growTypedArray(TypedArray, buffer, needed, min = 32) {
    const want = Math.max(0, Math.floor(Number(needed) || 0));
    const length = buffer?.length || 0;
    if (buffer && length >= want) return buffer;
    let cap = Math.max(min, length || min);
    while (cap < want) cap *= 2;
    return new TypedArray(cap);
}

export function createDerivedArtQueue({
    sliceMs = DERIVED_ART_SLICE_MS,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    scheduleIdle = null,
    scheduleTimeout = null,
} = {}) {
    const pending = new Map();
    let generation = 0;
    let idleHandle = null;
    let timeoutHandle = null;
    let pumping = false;

    const idle = scheduleIdle
        || (typeof requestIdleCallback === 'function'
            ? (fn) => requestIdleCallback(fn, { timeout: 16 })
            : null);
    const timeout = scheduleTimeout
        || ((fn) => setTimeout(fn, 0));
    const cancelIdle = typeof cancelIdleCallback === 'function' ? cancelIdleCallback : null;
    const cancelTimeout = typeof clearTimeout === 'function' ? clearTimeout : null;

    function clearSchedule() {
        if (idleHandle != null && cancelIdle) cancelIdle(idleHandle);
        if (timeoutHandle != null && cancelTimeout) cancelTimeout(timeoutHandle);
        idleHandle = null;
        timeoutHandle = null;
    }

    function schedule() {
        if (pumping || idleHandle != null || timeoutHandle != null || pending.size === 0) return;
        if (idle) {
            idleHandle = idle((deadline) => tick(deadline));
            return;
        }
        timeoutHandle = timeout(() => tick());
    }

    function tick(deadline) {
        idleHandle = null;
        timeoutHandle = null;
        pumping = true;
        const start = now();
        const jobs = [...pending.values()].sort((a, b) => (
            a.priority - b.priority || a.seq - b.seq
        ));
        for (const job of jobs) {
            if (now() - start >= sliceMs) break;
            if (typeof deadline?.timeRemaining === 'function' && deadline.timeRemaining() <= 0) break;
            pending.delete(job.key);
            if (job.generation !== generation) continue;
            job.build?.();
        }
        pumping = false;
        if (pending.size) schedule();
    }

    return {
        enqueue(job = {}) {
            if (!job.key || typeof job.build !== 'function') return;
            const priority = Number.isFinite(job.priority) ? job.priority : derivedArtPriority(job);
            const existing = pending.get(job.key);
            if (existing) {
                if (priority < existing.priority) existing.priority = priority;
                existing.generation = job.generation ?? generation;
                existing.build = job.build;
                existing.status = job.status;
                existing.selected = job.selected;
                existing.onScreen = job.onScreen;
                existing.kind = job.kind;
                return;
            }
            pending.set(job.key, {
                ...job,
                priority,
                generation: job.generation ?? generation,
                seq: ++derivedArtJobSequence,
            });
            schedule();
        },
        cancel(key) {
            if (key) pending.delete(key);
        },
        cancelAll() {
            pending.clear();
            clearSchedule();
        },
        bumpGeneration() {
            generation += 1;
            pending.clear();
            clearSchedule();
            return generation;
        },
        get generation() { return generation; },
        get size() { return pending.size; },
        tick,
    };
}

export class AssetManager {
    constructor(manifestPath = 'assets/sprites/manifest.yaml', options = {}) {
        if (manifestPath && typeof manifestPath === 'object') {
            options = manifestPath;
            manifestPath = options.manifestPath || 'assets/sprites/manifest.yaml';
        }
        this.manifestPath = manifestPath;
        this.manifest = null;          // parsed YAML root
        this.palettes = null;
        this.bitmaps = new Map();      // id → HTMLImageElement (or composed canvas)
        this.alphaMasks = new Map();   // interactive id → Uint8Array
        this.dimensions = new Map();   // id → { w, h }
        this.anchors = new Map();      // id → [cx, cy] in sprite-local px
        this.outlines = new Map();     // interactive id → HTMLCanvasElement (1-px gold edge)
        this.companions = new Map(MATERIAL_CHANNELS
            .filter((channel) => channel !== 'albedo')
            .map((channel) => [channel, new Map()]));
        this.atlasImages = new Map();  // `${atlasId}:${channel}` → HTMLImageElement
        this.atlasMetadata = new Map();// atlas id → deterministic metadata JSON
        this.actionStrips = new Map(); // agent id → { image, meta, path, channels }
        this._actionStripLoads = new Map();
        this._entriesCache = null;
        this._entryById = new Map();
        this.assetVersion = null;
        // IDs that resolved to the placeholder checker (404 or load error).
        // has(id) returns false for these so callers can skip drawing them.
        this.missing = new Set();
        // Per-asset miss records ({id, path}) collected across this load() pass;
        // flushed as one summary warn when load() resolves.
        this._loadMisses = [];
        this._decodedLoaded = false;
        this._materialAssetsEnabled = options.materialAssets === true;
        this._materialDecodedLoaded = false;
        this._suspended = false;
        this._loadPromise = null;
        this._loadController = null;
        this._materialLoadPromise = null;
        this._materialLoadController = null;
        this._requestedCharacterIds = new Set();
        // Distinguishes "caller named a character set" from "caller named
        // nothing". Unspecified must keep loading every character sheet so
        // existing callers behave exactly as before.
        this._characterSelectionProvided = false;
        this._characterLoads = new Map();
        this._characterLoadControllers = new Map();
        this._characterFailures = new Map();
        this._loadGeneration = 0;
        this._decodePasses = 0;
        this._disposed = false;
        this._optionalLoadMisses = [];
        this._activeProfilePins = new Map();
        this._evictedOptionalEntries = new Map();
        this._optionalReloads = new Map();
        this._resourceEstimateId = ++assetManagerResourceSequence;
        this._unregisterResourceEstimates = registerRendererResourceEstimateProvider(
            () => this._resourceEstimateLeaves(),
        );
        this._materialChannelCache = new Map();
        this._derivedArtQueue = createDerivedArtQueue();
        this._materialChannelRevision = 0;
    }

    load({ signal = null, characterIds = null } = {}) {
        this._rememberCharacterIds(characterIds);
        return this._ensureDecoded({ signal, loadManifest: !this.manifest }).then((loaded) => (
            loaded ? this._ensureRequestedCharacters({ signal }) : false
        ));
    }

    /**
     * Reload decoded World assets after Dashboard mode released them. The
     * parsed manifest/palettes stay resident, so a resume only fetches images.
     */
    resume({ signal = null, characterIds = null } = {}) {
        if (this._disposed) return Promise.resolve(false);
        this._rememberCharacterIds(characterIds);
        this._suspended = false;
        return this._ensureDecoded({ signal, loadManifest: !this.manifest }).then((loaded) => (
            loaded ? this._ensureRequestedCharacters({ signal }) : false
        ));
    }

    /**
     * Dashboard does not consume this manager. Abort any partial reload and
     * drop all decoded image/canvas, mask, and outline ownership immediately.
     */
    suspend() {
        if (this._disposed) return;
        this._suspended = true;
        this._decodedLoaded = false;
        this._materialDecodedLoaded = false;
        this._loadGeneration++;
        this._loadController?.abort?.();
        this._materialLoadController?.abort?.();
        this._abortCharacterLoads();
        // Pins protect live-World pressure eviction only. A mode-driven
        // suspension is authoritative and must leave no stale ownership that
        // can influence the next generation's reload.
        this._activeProfilePins.clear();
        this._invalidateDerivedArt();
        this._releaseDecodedEntries();
    }

    _ensureDecoded({ signal = null, loadManifest = false } = {}) {
        if (this._disposed || this._suspended) return Promise.resolve(false);
        if (this._decodedLoaded) {
            if (this._materialAssetsEnabled && !this._materialDecodedLoaded) {
                return this._ensureMaterialDecoded({ signal });
            }
            return Promise.resolve(true);
        }
        if (this._loadPromise) {
            if (!this._loadController?.signal?.aborted) return this._loadPromise;
            const previous = this._loadPromise;
            return previous.catch(() => false).then(() => {
                if (this._disposed || this._suspended) return false;
                return this._ensureDecoded({ signal, loadManifest: loadManifest || !this.manifest });
            });
        }

        const controller = new AbortController();
        const generation = ++this._loadGeneration;
        const forwardAbort = () => controller.abort(signal?.reason);
        if (signal?.aborted) forwardAbort();
        else signal?.addEventListener?.('abort', forwardAbort, { once: true });
        this._loadController = controller;

        const operation = this._decodeAssets({
            signal: controller.signal,
            generation,
            loadManifest: loadManifest || !this.manifest,
        }).catch((err) => {
            if (generation === this._loadGeneration) {
                this._decodedLoaded = false;
                this._releaseDecodedEntries();
            }
            if (
                controller.signal.aborted
                || this._disposed
                || this._suspended
                || err?.name === 'AbortError'
            ) return false;
            throw err;
        });
        const wrapped = operation.finally(() => {
            signal?.removeEventListener?.('abort', forwardAbort);
            if (this._loadPromise === wrapped) {
                this._loadPromise = null;
                this._loadController = null;
            }
        });
        this._loadPromise = wrapped;
        return wrapped;
    }

    async _decodeAssets({ signal, generation, loadManifest }) {
        if (loadManifest) {
            const [manifestText, palettesText] = await Promise.all([
                this._fetchText(this.manifestPath, { signal }),
                this._fetchText('assets/sprites/palettes.yaml', { signal }),
            ]);
            if (!this._canCommitLoad(signal, generation)) return false;
            try {
                this.manifest = jsyaml.load(manifestText);
                this.palettes = jsyaml.load(palettesText);
            } catch (err) {
                throw new Error(`[AssetManager] failed to parse YAML: ${err.message}`);
            }
            this.assetVersion = this.manifest?.style?.assetVersion || null;
            const entries = this._flattenManifest(this.manifest);
            this._entriesCache = entries;
            this._entryById = this._indexManifestEntries(entries);
        }

        const entries = this._entriesCache || [];
        this._releaseDecodedEntries();
        this._loadMisses = [];
        const criticalEntries = entries.filter((entry) => (
            !this._isCharacterEntry(entry)
            || !this._characterSelectionProvided
            || this._requestedCharacterIds.has(entry.id)
        ));
        await Promise.all(criticalEntries.map(entry => this._loadEntry(entry, { signal, generation })));
        if (!this._canCommitLoad(signal, generation)) return false;

        if (this._materialAssetsEnabled) {
            await this._decodeMaterialAssets({ signal, generation });
            if (!this._canCommitLoad(signal, generation)) return false;
        }

        this._decodedLoaded = true;
        this._decodePasses++;
        if (this._loadMisses.length > 0) {
            console.warn(
                `[AssetManager] missing ${this._loadMisses.length} assets:`,
                this._loadMisses.map(m => m.id)
            );
        }
        return true;
    }

    async loadMaterialAssets({ signal = null, characterIds = null } = {}) {
        if (this._disposed || this._suspended) return false;
        this._rememberCharacterIds(characterIds);
        this._materialAssetsEnabled = true;
        const decoded = await this._ensureDecoded({ signal, loadManifest: !this.manifest });
        if (!decoded) return false;
        const requested = [...this._requestedCharacterIds]
            .filter((id) => !this.bitmaps.has(id));
        if (requested.length > 0) {
            await Promise.all(requested.map((id) => this.requestCharacterAssets(id, { signal })));
            if (signal?.aborted || this._disposed || this._suspended) return false;
        }
        if (this._materialDecodedLoaded) return true;
        return this._ensureMaterialDecoded({ signal });
    }

    _ensureMaterialDecoded({ signal = null } = {}) {
        if (this._disposed || this._suspended || !this._materialAssetsEnabled) return Promise.resolve(false);
        if (this._materialDecodedLoaded) return Promise.resolve(true);
        if (this._materialLoadPromise) return this._materialLoadPromise;

        const controller = new AbortController();
        const generation = this._loadGeneration;
        const forwardAbort = () => controller.abort(signal?.reason);
        if (signal?.aborted) forwardAbort();
        else signal?.addEventListener?.('abort', forwardAbort, { once: true });
        this._materialLoadController = controller;
        const operation = this._decodeMaterialAssets({
            signal: controller.signal,
            generation,
        }).then(() => this._canCommitLoad(controller.signal, generation));
        const wrapped = operation.finally(() => {
            signal?.removeEventListener?.('abort', forwardAbort);
            if (this._materialLoadPromise === wrapped) {
                this._materialLoadPromise = null;
                this._materialLoadController = null;
            }
        });
        this._materialLoadPromise = wrapped;
        return wrapped;
    }

    _canCommitLoad(signal, generation) {
        return !signal?.aborted
            && !this._disposed
            && !this._suspended
            && generation === this._loadGeneration;
    }

    _rememberCharacterIds(characterIds) {
        if (characterIds === null || characterIds === undefined) return;
        const ids = typeof characterIds === 'string' ? [characterIds] : characterIds;
        if (typeof ids[Symbol.iterator] !== 'function') return;
        // An explicit (even empty) selection opts into narrowed eager loading;
        // anything absent from it arrives later via requestCharacterAssets().
        this._characterSelectionProvided = true;
        for (const id of ids) {
            if (typeof id === 'string' && id.startsWith('agent.')) {
                this._requestedCharacterIds.add(id);
            }
        }
    }

    async _ensureRequestedCharacters({ signal = null } = {}) {
        const missingIds = [...this._requestedCharacterIds]
            .filter((id) => !this.has(id, { request: false }));
        if (missingIds.length === 0) return true;
        await Promise.all(missingIds.map((id) => (
            this.requestCharacterAssets(id, { signal })
        )));
        return !signal?.aborted && !this._disposed && !this._suspended;
    }

    _isCharacterEntry(entry) {
        return Boolean(entry?.id?.startsWith('agent.'));
    }

    /**
     * Ensure one manifest character sheet is resident. Calls for the same id
     * share one operation; a failed request remains drawable-safe and retries
     * with bounded backoff when a later frame asks for the character again.
     */
    requestCharacterAssets(id, { signal = null, retry = false } = {}) {
        if (typeof id !== 'string' || !id.startsWith('agent.')) return Promise.resolve(false);
        if (this._disposed || this._suspended || signal?.aborted) return Promise.resolve(false);
        this._requestedCharacterIds.add(id);
        if (this.has(id, { request: false })) return Promise.resolve(true);

        const existing = this._characterLoads.get(id);
        if (existing) {
            const controller = this._characterLoadControllers.get(id);
            const forwardAbort = () => controller?.abort(signal?.reason);
            signal?.addEventListener?.('abort', forwardAbort, { once: true });
            return existing.finally(() => {
                signal?.removeEventListener?.('abort', forwardAbort);
            });
        }

        const failure = this._characterFailures.get(id);
        if (!retry && failure && Date.now() < failure.retryAt) return Promise.resolve(false);

        if (!this.manifest) {
            return this._ensureDecoded({ signal, loadManifest: true }).then((loaded) => (
                Boolean(loaded && this.has(id, { request: false }))
            ));
        }
        const entry = this._entryById.get(id);
        if (!this._isCharacterEntry(entry)) return Promise.resolve(false);

        const controller = new AbortController();
        const generation = this._loadGeneration;
        const forwardAbort = () => controller.abort(signal?.reason);
        if (signal?.aborted) forwardAbort();
        else signal?.addEventListener?.('abort', forwardAbort, { once: true });
        this._characterLoadControllers.set(id, controller);

        const operation = this._loadCharacterEntry(entry, {
            signal: controller.signal,
            generation,
        }).catch((error) => {
            if (
                controller.signal.aborted
                || this._disposed
                || this._suspended
                || error?.name === 'AbortError'
            ) return false;
            this._recordCharacterFailure(id, this._pathFor(entry), error?.message || 'load failed');
            return false;
        });
        const tracked = operation.finally(() => {
            signal?.removeEventListener?.('abort', forwardAbort);
            if (this._characterLoads.get(id) === tracked) this._characterLoads.delete(id);
            if (this._characterLoadControllers.get(id) === controller) {
                this._characterLoadControllers.delete(id);
            }
        });
        this._characterLoads.set(id, tracked);
        return tracked;
    }

    async _loadCharacterEntry(entry, { signal, generation }) {
        const path = this._pathFor(entry);
        const { img, ok, reason } = await this._loadOptionalImage(path, { signal });
        if (!this._canCommitLoad(signal, generation)) return false;
        if (!ok || !img) {
            this._recordCharacterFailure(entry.id, path, reason || 'load failed');
            return false;
        }
        this.missing.delete(entry.id);
        this._characterFailures.delete(entry.id);
        if (this._materialDecodedLoaded) {
            // Keep the albedo private until its declared material channels have
            // settled. This prevents a draw from caching a fallback material in
            // the narrow window between sheet and sidecar completion.
            this.dimensions.set(entry.id, { w: img.width, h: img.height });
            try {
                await this._loadCharacterCompanions(entry, { signal, generation });
            } catch (error) {
                this.dimensions.delete(entry.id);
                this._releaseImage(img);
                throw error;
            }
            if (!this._canCommitLoad(signal, generation)) {
                this.dimensions.delete(entry.id);
                this._releaseImage(img);
                return false;
            }
        }
        this._storeBitmap(entry.id, img, {
            anchor: entry.anchor || null,
            generation,
        });
        // C2: the optional action strip is a separate PNG loaded after the base
        // sheet is drawable, so a body never waits on it and never widens.
        await this._loadActionStrip(entry, { signal, generation });
        return true;
    }

    // Lazily resident per demanded character. A missing, malformed, or
    // mis-sized strip leaves the character strip-less and rendering identical.
    async _loadActionStrip(entry, { signal, generation }) {
        const meta = entry?.actionStrip;
        const path = actionStripPathFor(meta);
        if (!path) return;
        if (this.actionStrips.get(entry.id)?.generation === generation) return;
        const { img, ok, reason } = await this._loadOptionalImage(path, { signal });
        if (!this._canCommitLoad(signal, generation)) {
            if (img) this._releaseImage(img);
            return;
        }
        const invalid = !ok || !img ? (reason || 'load failed') : actionStripMismatch(meta, img);
        if (invalid) {
            if (img) this._releaseImage(img);
            this._optionalLoadMisses.push({ id: entry.id, channel: 'actionStrip', path, reason: invalid });
            return;
        }
        const channels = { albedo: img, material: null, emissive: null, occluder: null };
        if (this._materialDecodedLoaded) {
            await Promise.all(MATERIAL_CHANNELS
                .filter((channel) => channel !== 'albedo')
                .map(async (channel) => {
                    // Strip companions follow the existing sidecar declaration
                    // of their character entry, keyed off the strip path.
                    const companionPath = companionPathFor(entry, channel, path);
                    if (!companionPath) return;
                    const loaded = await this._loadOptionalImage(companionPath, { signal });
                    if (!this._canCommitLoad(signal, generation) || !loaded.ok || !loaded.img) {
                        if (loaded.img) this._releaseImage(loaded.img);
                        if (!loaded.ok) {
                            this._optionalLoadMisses.push({
                                id: entry.id,
                                channel: `actionStrip:${channel}`,
                                path: companionPath,
                                reason: loaded.reason || 'load failed',
                            });
                        }
                        return;
                    }
                    if (loaded.img.width !== img.width || loaded.img.height !== img.height) {
                        this._releaseImage(loaded.img);
                        this._optionalLoadMisses.push({
                            id: entry.id,
                            channel: `actionStrip:${channel}`,
                            path: companionPath,
                            reason: `dimension ${loaded.img.width}x${loaded.img.height} != ${img.width}x${img.height}`,
                        });
                        return;
                    }
                    channels[channel] = loaded.img;
                }));
        }
        if (!this._canCommitLoad(signal, generation)) {
            for (const image of Object.values(channels)) if (image) this._releaseImage(image);
            return;
        }
        this._releaseActionStrip(entry.id);
        this.actionStrips.set(entry.id, { image: img, meta, path, channels, generation });
    }

    _releaseActionStrip(id) {
        const strip = this.actionStrips.get(id);
        if (!strip) return;
        for (const image of Object.values(strip.channels)) if (image) this._releaseImage(image);
        this.actionStrips.delete(id);
    }

    async _loadCharacterCompanions(entry, { signal, generation }) {
        const loads = [];
        for (const channel of MATERIAL_CHANNELS) {
            if (channel === 'albedo') continue;
            const path = companionPathFor(entry, channel, this._pathFor(entry));
            if (path) loads.push(this._loadCompanion(entry, channel, path, { signal, generation }));
        }
        await Promise.all(loads);
    }

    _recordCharacterFailure(id, path, reason) {
        const previous = this._characterFailures.get(id);
        const attempts = (previous?.attempts || 0) + 1;
        const retryMs = Math.min(
            CHARACTER_RETRY_MAX_MS,
            CHARACTER_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 4)),
        );
        this._characterFailures.set(id, { attempts, retryAt: Date.now() + retryMs });
        this.missing.add(id);
        console.warn(`[AssetManager] character ${id} unavailable; retrying on demand: ${reason}`, path);
    }

    _abortCharacterLoads() {
        for (const controller of this._characterLoadControllers.values()) controller.abort();
        this._characterLoadControllers.clear();
        this._characterLoads.clear();
    }

    async _fetchText(path, { signal = null } = {}) {
        const r = await fetch(path, { signal });
        if (!r.ok) throw new Error(`[AssetManager] HTTP ${r.status} for ${path}`);
        return r.text();
    }

    _flattenManifest(root) {
        const out = [];
        const collect = (arr) => arr && arr.forEach(e => out.push(e));
        collect(root.characters);
        collect(root.equipment);
        collect(root.accessories);
        collect(root.statusOverlays);
        collect(root.buildings);
        collect(root.props);
        collect(root.vegetation);
        collect(root.terrain);
        collect(root.bridges);
        collect(root.atmosphere);
        collect(root.luts);
        return out;
    }

    _indexManifestEntries(entries) {
        const indexed = new Map(entries.map((entry) => [entry.id, entry]));
        for (const entry of entries) {
            if (!entry.id?.startsWith('building.') || !entry.layers) continue;
            const parentAtlas = normalizeAtlasFrame(entry.atlasFrame);
            for (const [name, layer] of Object.entries(entry.layers)) {
                if (name === 'base') continue;
                const id = `${entry.id}.${name}`;
                indexed.set(id, {
                    ...layer,
                    id,
                    assetPath: `assets/sprites/buildings/${entry.id}/${name}.png`,
                    materialClass: layer.materialClass || entry.materialClass,
                    elevation: layer.elevation || entry.elevation,
                    occluder: layer.occluder || entry.occluder,
                    atlasFrame: parentAtlas?.atlas
                        ? { atlas: parentAtlas.atlas, key: id }
                        : null,
                    parentId: entry.id,
                });
            }
        }
        return indexed;
    }

    async _loadEntry(entry, { signal = null, generation = this._loadGeneration } = {}) {
        // Single-PNG entry (buildings are all single-image; composeGrid retired).
        const path = this._pathFor(entry);
        const { img: loadedImg, ok } = await this._loadImage(path, { signal });
        if (!this._canCommitLoad(signal, generation)) return;
        if (!ok) {
            this.missing.add(entry.id);
            this._loadMisses.push({ id: entry.id, path });
            if (this._isCharacterEntry(entry)) {
                const attempts = (this._characterFailures.get(entry.id)?.attempts || 0) + 1;
                this._characterFailures.set(entry.id, {
                    attempts,
                    retryAt: Date.now() + CHARACTER_RETRY_BASE_MS,
                });
            }
        }
        const normalizedImg = this._normalizeImageToManifestSize(entry, loadedImg);
        const img = this._applyStructureMask(entry, normalizedImg);
        const anchor = entry.anchor
            ? entry.anchor
            : entry.id.startsWith('building.')
                ? [Math.floor(img.width / 2), Math.floor(img.height * 7 / 8)]
                : null;
        this._storeBitmap(entry.id, img, {
            anchor,
            generation,
            // Only building bases participate in per-pixel hit testing and
            // hover outlines. Avoid deriving full-sheet buffers for every
            // character, terrain, prop, and atmosphere asset.
            buildMask: entry.id.startsWith('building.'),
        });
        // C2: characters loaded through the eager pass get their optional strip
        // as well, so residency does not depend on which path demanded them.
        if (this._isCharacterEntry(entry) && ok) {
            await this._loadActionStrip(entry, { signal, generation });
        }
        // Recurse for layered entries (overlays).
        if (entry.layers) {
            await Promise.all(Object.entries(entry.layers).map(([name, layer]) => {
                if (name === 'base') return null;
                const layerId = `${entry.id}.${name}`;
                // Building overlay layers (e.g. watchfire, beacon) live beside the
                // base PNG at buildings/<id>/<name>.png — same convention the
                // composed-building loader uses. Without this, single-image
                // buildings with layers would misroute through _pathFor.
                const layerPath = entry.id.startsWith('building.')
                    ? `assets/sprites/buildings/${entry.id}/${name}.png`
                    : this._pathFor({ id: layerId, ...layer });
                return this._loadLayer(layerId, layer, layerPath, { signal, generation });
            }));
        }
    }

    _storeBitmap(id, img, {
        anchor = null,
        mask = null,
        buildMask = false,
        generation = this._loadGeneration,
    } = {}) {
        if (this._disposed || this._suspended || generation !== this._loadGeneration) return;
        this.bitmaps.set(id, img);
        this.dimensions.set(id, { w: img.width, h: img.height });
        if (anchor) this.anchors.set(id, anchor);
        if (!buildMask) return;
        const alphaMask = mask || this._buildAlphaMask(img);
        this.alphaMasks.set(id, alphaMask);
        this.outlines.set(id, this._bakeOutline(img.width, img.height, alphaMask));
    }

    async _loadLayer(
        layerId,
        layer,
        layerPath,
        { signal = null, generation = this._loadGeneration } = {},
    ) {
        const { img: loadedImg, ok } = await this._loadImage(layerPath, { signal });
        if (!this._canCommitLoad(signal, generation)) return;
        if (!ok) {
            this.missing.add(layerId);
            this._loadMisses.push({ id: layerId, path: layerPath });
        }
        const img = this._normalizeImageToManifestSize({ id: layerId, ...layer }, loadedImg);
        this._storeBitmap(layerId, img, {
            anchor: layer.anchor || null,
            buildMask: false,
            generation,
        });
    }

    async _decodeMaterialAssets({ signal, generation }) {
        this._releaseMaterialEntries();
        this._optionalLoadMisses = [];
        const entries = [...this._entryById.values()].filter((entry) => (
            !this._isCharacterEntry(entry) || this.bitmaps.has(entry.id)
        ));
        const sidecarLoads = [];
        for (const entry of entries) {
            for (const channel of MATERIAL_CHANNELS) {
                if (channel === 'albedo') continue;
                const path = companionPathFor(entry, channel, this._pathFor(entry));
                if (!path) continue;
                sidecarLoads.push(this._loadCompanion(entry, channel, path, { signal, generation }));
            }
        }
        const atlasLoads = (this.manifest?.atlases || []).map((atlas) => (
            this._loadAtlas(atlas, { signal, generation })
        ));
        await Promise.all([...sidecarLoads, ...atlasLoads]);
        if (!this._canCommitLoad(signal, generation)) return false;
        this._materialDecodedLoaded = true;
        if (this._optionalLoadMisses.length > 0) {
            console.warn(
                `[AssetManager] skipped ${this._optionalLoadMisses.length} optional material assets:`,
                this._optionalLoadMisses.map((miss) => `${miss.id}:${miss.channel}`),
            );
        }
        return true;
    }

    async _loadCompanion(entry, channel, path, { signal, generation }) {
        const { img, ok, reason } = await this._loadOptionalImage(path, { signal });
        if (!this._canCommitLoad(signal, generation)) return;
        if (!ok || !img) {
            this._optionalLoadMisses.push({ id: entry.id, channel, path, reason });
            return;
        }
        const albedoDims = this.dimensions.get(entry.id);
        if (albedoDims && (img.width !== albedoDims.w || img.height !== albedoDims.h)) {
            this._releaseImage(img);
            this._optionalLoadMisses.push({
                id: entry.id,
                channel,
                path,
                reason: `dimension ${img.width}x${img.height} != ${albedoDims.w}x${albedoDims.h}`,
            });
            return;
        }
        this.companions.get(channel)?.set(entry.id, img);
    }

    async _loadAtlas(atlas, { signal, generation }) {
        if (!atlas?.id || !atlas?.metadata || !atlas?.channels) return;
        let metadata = null;
        try {
            const text = await this._fetchText(this._versionedPath(atlas.metadata), { signal });
            metadata = JSON.parse(text);
        } catch (err) {
            if (signal?.aborted) return;
            this._optionalLoadMisses.push({
                id: atlas.id,
                channel: 'metadata',
                path: atlas.metadata,
                reason: err.message,
            });
            return;
        }
        if (!this._canCommitLoad(signal, generation)) return;
        this.atlasMetadata.set(atlas.id, metadata);
        await Promise.all(Object.entries(atlas.channels).map(async ([channel, path]) => {
            if (!MATERIAL_CHANNELS.includes(channel) || !path) return;
            const { img, ok, reason } = await this._loadOptionalImage(path, { signal });
            if (!this._canCommitLoad(signal, generation)) return;
            if (!ok || !img) {
                this._optionalLoadMisses.push({ id: atlas.id, channel, path, reason });
                return;
            }
            if (
                Number(metadata.width) !== img.width
                || Number(metadata.height) !== img.height
            ) {
                this._releaseImage(img);
                this._optionalLoadMisses.push({
                    id: atlas.id,
                    channel,
                    path,
                    reason: `dimension ${img.width}x${img.height} != metadata ${metadata.width}x${metadata.height}`,
                });
                return;
            }
            this.atlasImages.set(`${atlas.id}:${channel}`, img);
        }));
    }

    _pathFor(entry) {
        if (entry.assetPath) return entry.assetPath;
        // Deterministic path mapping by id prefix.
        if (entry.id.startsWith('agent.')) return `assets/sprites/characters/${entry.id}/sheet.png`;
        if (entry.id.startsWith('equipment.')) return `assets/sprites/equipment/${entry.id}.png`;
        if (entry.id.startsWith('overlay.accessory.')) return `assets/sprites/overlays/${entry.id}.png`;
        if (entry.id.startsWith('overlay.status.')) return `assets/sprites/overlays/${entry.id}.png`;
        if (entry.id.startsWith('building.')) return `assets/sprites/buildings/${entry.id}/base.png`;
        if (entry.id.startsWith('prop.')) return `assets/sprites/props/${entry.id}.png`;
        if (entry.id.startsWith('veg.')) return `assets/sprites/vegetation/${entry.id}.png`;
        if (entry.id.startsWith('terrain.')) return `assets/sprites/terrain/${entry.id}/sheet.png`;
        if (entry.id.startsWith('bridge.') || entry.id.startsWith('dock.')) return `assets/sprites/bridges/${entry.id}.png`;
        if (entry.id.startsWith('atmosphere.')) return `assets/sprites/atmosphere/${entry.id}.png`;
        // Hand-authored data images (palette ramps); `lut.<name>` → `luts/<name>.png`.
        if (entry.id.startsWith('lut.')) return `assets/sprites/luts/${entry.id.slice('lut.'.length)}.png`;
        return PLACEHOLDER_PATH;
    }

    _loadOptionalImage(path, { signal = null } = {}) {
        return new Promise((resolve) => {
            const img = new Image();
            let settled = false;
            const cleanup = () => {
                signal?.removeEventListener?.('abort', abort);
                img.onload = null;
                img.onerror = null;
            };
            const finish = (value) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            };
            const abort = () => {
                img.onload = null;
                img.onerror = null;
                img.src = '';
                finish({ img: null, ok: false, reason: 'aborted' });
            };
            if (signal?.aborted) {
                abort();
                return;
            }
            signal?.addEventListener?.('abort', abort, { once: true });
            img.onload = async () => {
                await this._decodeImage(img);
                if (!signal?.aborted) finish({ img, ok: true, reason: null });
            };
            img.onerror = () => finish({ img: null, ok: false, reason: 'load failed' });
            img.src = this._versionedPath(path);
        });
    }

    // Resolves with { img, ok } where ok=false means the real PNG failed and
    // img is the placeholder checker instead.
    _loadImage(path, { signal = null } = {}) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            let placeholder = null;
            let settled = false;
            const cleanup = () => {
                signal?.removeEventListener?.('abort', abort);
                img.onload = null;
                img.onerror = null;
                if (placeholder) {
                    placeholder.onload = null;
                    placeholder.onerror = null;
                }
            };
            const finish = (value, error = null) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error);
                else resolve(value);
            };
            const abort = () => {
                img.onload = null;
                img.onerror = null;
                if (placeholder) {
                    placeholder.onload = null;
                    placeholder.onerror = null;
                    placeholder.src = '';
                }
                img.src = '';
                finish(null, signal?.reason instanceof Error
                    ? signal.reason
                    : new DOMException('Asset load aborted', 'AbortError'));
            };
            if (signal?.aborted) {
                abort();
                return;
            }
            signal?.addEventListener?.('abort', abort, { once: true });
            img.onload = async () => {
                await this._decodeImage(img);
                if (!signal?.aborted) finish({ img, ok: true });
            };
            img.onerror = () => {
                if (signal?.aborted) return;
                placeholder = new Image();
                placeholder.onload = () => finish({ img: placeholder, ok: false });
                placeholder.onerror = () => finish({ img, ok: false });
                placeholder.src = this._versionedPath(PLACEHOLDER_PATH);
            };
            img.src = this._versionedPath(path);
        });
    }

    async _decodeImage(img) {
        if (typeof img?.decode !== 'function') return;
        try {
            await img.decode();
        } catch {
            // onload already established a drawable image. Some browsers
            // reject decode() for otherwise usable images, so keep that path.
        }
    }

    _versionedPath(path) {
        if (!this.assetVersion || path.startsWith('data:')) return path;
        const separator = path.includes('?') ? '&' : '?';
        return `${path}${separator}v=${encodeURIComponent(this.assetVersion)}`;
    }

    _normalizeImageToManifestSize(entry, img) {
        if (!entry?.size || !img?.width || !img?.height) return img;
        if (entry.id?.startsWith('agent.') || entry.id?.startsWith('terrain.') || entry.id?.startsWith('atmosphere.')) {
            return img;
        }
        const target = entry.displaySize || entry.size;
        if (img.width === target && img.height === target) return img;

        const canvas = document.createElement('canvas');
        canvas.width = target;
        canvas.height = target;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, target, target);
        return canvas;
    }

    // Legacy building sources can retain a baked site slab while the runtime
    // contract exposes structure-only pixels. The manifest mask is applied once
    // at load, before hit masks and hover outlines are derived.
    _applyStructureMask(entry, img) {
        const shapes = entry?.structureMask?.shapes;
        if (!entry?.id?.startsWith('building.') || !Array.isArray(shapes) || shapes.length === 0) {
            return img;
        }
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                const index = (y * canvas.width + x) * 4;
                if (data[index + 3] === 0) continue;
                const inside = this._structureMaskContains(shapes, x + 0.5, y + 0.5);
                const removeSiteColor = inside && this._matchesSiteColorCutout(
                    entry.structureMask,
                    x,
                    y,
                    data[index],
                    data[index + 1],
                    data[index + 2],
                );
                if (inside && !removeSiteColor) continue;
                data[index] = 0;
                data[index + 1] = 0;
                data[index + 2] = 0;
                data[index + 3] = 0;
            }
        }
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    _matchesSiteColorCutout(mask, x, y, red, green, blue) {
        const cutout = mask?.siteColorCutout;
        if (!cutout || y < Number(cutout.fromY || 0)) return false;
        if (cutout.family === 'grass' || cutout.family === 'grass-and-retaining') {
            const isGrass = green >= 34
                && green > red * 1.16
                && green > blue * 1.12;
            if (isGrass) return true;
        }
        if (cutout.family === 'grass-and-retaining' && y >= Number(cutout.lipFromY || Infinity)) {
            const isRetaining = red < 136
                && green < 82
                && blue < 108
                && red > green * 1.22
                && blue > green * 1.12;
            if (isRetaining) return true;
        }
        if (y >= Number(cutout.eraseOutsideProtectFromY || Infinity)) {
            const protectedShapes = cutout.protectShapes;
            return !Array.isArray(protectedShapes)
                || !this._structureMaskContains(protectedShapes, x + 0.5, y + 0.5);
        }
        return false;
    }

    _structureMaskContains(shapes, x, y) {
        for (const shape of shapes) {
            const rect = shape?.rect;
            if (Array.isArray(rect) && rect.length === 4) {
                const [rx, ry, rw, rh] = rect.map(Number);
                if (x >= rx && y >= ry && x < rx + rw && y < ry + rh) return true;
            }
            const polygon = shape?.polygon;
            if (Array.isArray(polygon) && polygon.length >= 3 && this._pointInPolygon(polygon, x, y)) {
                return true;
            }
        }
        return false;
    }

    _pointInPolygon(points, x, y) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const xi = Number(points[i]?.[0]);
            const yi = Number(points[i]?.[1]);
            const xj = Number(points[j]?.[0]);
            const yj = Number(points[j]?.[1]);
            const crosses = ((yi > y) !== (yj > y))
                && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1) + xi;
            if (crosses) inside = !inside;
        }
        return inside;
    }

    _buildAlphaMask(img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const mask = this._buildAlphaMaskFromCanvas(canvas);
        canvas.width = 0;
        canvas.height = 0;
        return mask;
    }

    _buildAlphaMaskFromCanvas(canvas) {
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const mask = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > ALPHA_THRESHOLD ? 1 : 0;
        return mask;
    }

    // Pre-bake a 1-px gold outline as a transparent canvas the same size as the
    // sprite. Edge = pixel where the mask is empty AND any 4-neighbour is filled.
    // Done once at load so per-frame outline draw is a single ctx.drawImage.
    _bakeOutline(w, h, mask) {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = OUTLINE_COLOR;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (mask[y * w + x]) continue;
                const n = (y > 0 && mask[(y - 1) * w + x])
                       || (y < h - 1 && mask[(y + 1) * w + x])
                       || (x > 0 && mask[y * w + (x - 1)])
                       || (x < w - 1 && mask[y * w + (x + 1)]);
                if (n) ctx.fillRect(x, y, 1, 1);
            }
        }
        return canvas;
    }

    get(id, { request = true } = {}) {
        const character = typeof id === 'string' && id.startsWith('agent.');
        if (character && (!this.bitmaps.has(id) || this.missing.has(id))) {
            if (request) this.requestCharacterAssets(id).catch(() => {});
            return undefined;
        }
        return this.bitmaps.get(id);
    }
    // Returns true only when the real PNG loaded successfully (not a placeholder).
    has(id, { request = true } = {}) {
        const available = this.bitmaps.has(id) && !this.missing.has(id);
        if (!available && request && typeof id === 'string' && id.startsWith('agent.')) {
            this.requestCharacterAssets(id).catch(() => {});
        }
        return available;
    }
    getMask(id) { return this.alphaMasks.get(id); }
    getDims(id) {
        if (typeof id === 'string' && id.startsWith('agent.') && !this.has(id)) return undefined;
        return this.dimensions.get(id);
    }
    getAnchor(id) { return this.anchors.get(id) ?? [0, 0]; }
    getOutline(id) { return this.outlines.get(id); }
    getEntry(id) {
        return this._entryById.get(id);
    }
    // C2: `{ image, meta, path, channels }` for a resident action strip, or null.
    // Null is the byte-identical fallback contract — callers keep the existing
    // procedural overlay. Demanding a strip demands its character.
    getActionStrip(id, { request = true } = {}) {
        const strip = this.actionStrips.get(id) || null;
        if (!strip && request && typeof id === 'string' && id.startsWith('agent.')
            && this.getEntry(id)?.actionStrip) {
            // A character whose sheet is already resident never re-enters the
            // demand path, so ask for the strip on its own.
            if (this.has(id, { request: false })) this._ensureActionStrip(id);
            else this.requestCharacterAssets(id).catch(() => {});
        }
        return strip;
    }
    _ensureActionStrip(id) {
        const inFlight = this._actionStripLoads.get(id);
        if (inFlight) return inFlight;
        const entry = this.getEntry(id);
        if (!entry?.actionStrip || this._disposed || this._suspended) return Promise.resolve();
        const operation = this._loadActionStrip(entry, { signal: null, generation: this._loadGeneration })
            .catch(() => {})
            .finally(() => {
                if (this._actionStripLoads.get(id) === operation) this._actionStripLoads.delete(id);
            });
        this._actionStripLoads.set(id, operation);
        return operation;
    }
    getCompanion(id, channel) {
        const image = this.companions.get(channel)?.get(id) || null;
        if (!image) this._reloadOptionalEntry(`companion:${channel}:${id}`);
        return image;
    }
    // Compatibility name used by GPU scene builders; companion channels are
    // the same optional sidecar images and still never use checker fallback.
    getSidecar(id, channel) {
        return this.getCompanion(id, channel);
    }
    getMaterialSidecar(id, channel = 'material') {
        return this.getCompanion(id, channel);
    }
    getMaterialChannels(id) {
        const atlasFrame = normalizeAtlasFrame(this.getEntry(id)?.atlasFrame);
        return Object.fromEntries(MATERIAL_CHANNELS.map((channel) => [
            channel,
            channel === 'albedo'
                ? this.get(id) || null
                : this.getCompanion(id, channel)
                    || (atlasFrame?.atlas ? this.getAtlas(atlasFrame.atlas, channel) : null),
        ]));
    }
    getMaterialMetadata(id) {
        const entry = this.getEntry(id) || { id };
        return normalizeMaterialMetadata(entry);
    }
    getAtlas(atlasId, channel = 'albedo') {
        const image = this.atlasImages.get(`${atlasId}:${channel}`) || null;
        if (!image) this._reloadOptionalEntry(`atlas:${atlasId}:${channel}`);
        return image;
    }
    getAtlasChannels(atlasId) {
        return Object.fromEntries(MATERIAL_CHANNELS.map((channel) => [
            channel,
            this.getAtlas(atlasId, channel),
        ]));
    }
    getAtlasMetadata(atlasId) {
        return this.atlasMetadata.get(atlasId) || null;
    }
    getAtlasFrame(id, frameKey = null) {
        const entry = this.getEntry(id);
        const declaration = normalizeAtlasFrame(entry?.atlasFrame);
        if (!declaration?.atlas) return null;
        const metadata = this.getAtlasMetadata(declaration.atlas);
        if (!metadata?.frames) return null;
        const key = frameKey
            ? `${declaration.keyPrefix || declaration.key || id}/${frameKey}`
            : declaration.key || id;
        const frame = metadata.frames[key];
        if (!frame) return null;
        return {
            atlas: declaration.atlas,
            key,
            ...frame,
        };
    }

    // C5: sidecar, then atlas, then the deterministic fallback. Cache lookup
    // only — cropping and packing run on the derived-art queue so a visible
    // draw never waits on pixel archaeology.
    resolveMaterialChannels(id, frameKey = null, hint = {}) {
        const declaration = normalizeAtlasFrame(this.getEntry(id)?.atlasFrame);
        const atlasKey = declaration?.atlas || '';
        const cropRequested = Boolean(hint.crop || frameKey);
        const resolvedFrameKey = frameKey
            || (cropRequested ? `${declaration?.key || id || ''}#local` : (declaration?.key || id || ''));
        const cacheKey = materialChannelCacheKey(this.assetVersion, atlasKey, resolvedFrameKey);
        const cached = this._materialChannelCache.get(cacheKey);
        if (cached && cached.generation === this._loadGeneration) return cached;

        const sidecar = {
            material: this.getCompanion(id, 'material'),
            emissive: this.getCompanion(id, 'emissive'),
            occluder: this.getCompanion(id, 'occluder'),
        };
        const frame = this.getAtlasFrame(id, frameKey);
        const atlasId = frame?.atlas || atlasKey || null;
        const atlas = atlasId ? {
            material: this.getAtlas(atlasId, 'material'),
            emissive: this.getAtlas(atlasId, 'emissive'),
            occluder: this.getAtlas(atlasId, 'occluder'),
        } : {};
        const picked = resolveMaterialChannelSources({ sidecar, atlas });
        if (cropRequested && picked.origin === 'atlas' && !frame?.rect) {
            return {
                id,
                frameKey: resolvedFrameKey,
                origin: 'fallback',
                layout: 'fallback',
                albedo: this.get(id),
                material: null,
                emissive: null,
                occluder: null,
                frame: null,
                atlas: atlasId,
                revision: cacheKey,
                ready: false,
                generation: this._loadGeneration,
                pixels: picked.pixels,
            };
        }
        const crop = Boolean(cropRequested && frame?.rect && picked.origin === 'atlas');
        if (picked.origin !== 'atlas' || !crop) {
            const result = {
                id,
                frameKey: resolvedFrameKey,
                origin: picked.origin,
                layout: picked.origin === 'atlas' ? 'atlas-rect' : picked.origin === 'sidecar' ? 'sidecar' : 'fallback',
                albedo: picked.origin === 'atlas' && atlasId ? this.getAtlas(atlasId, 'albedo') : this.get(id),
                material: picked.material,
                emissive: picked.emissive,
                occluder: picked.occluder,
                frame: frame || null,
                atlas: atlasId,
                revision: cacheKey,
                ready: true,
                generation: this._loadGeneration,
                pixels: picked.pixels,
            };
            this._materialChannelCache.set(cacheKey, result);
            return result;
        }

        const pending = {
            id,
            frameKey: resolvedFrameKey,
            origin: 'fallback',
            layout: 'fallback',
            albedo: this.get(id),
            material: null,
            emissive: null,
            occluder: null,
            frame,
            atlas: atlasId,
            revision: cacheKey,
            ready: false,
            generation: this._loadGeneration,
            pixels: picked.pixels,
        };
        this._enqueueAtlasFrameCrop({
            id,
            frameKey,
            cacheKey,
            frame,
            hint,
        });
        return pending;
    }

    enqueueDerivedArt(job) {
        this._derivedArtQueue.enqueue(job);
    }

    get derivedArtGeneration() {
        return this._loadGeneration;
    }

    _enqueueAtlasFrameCrop({ id, frameKey, cacheKey, frame, hint = {} }) {
        const generation = this._loadGeneration;
        this._derivedArtQueue.enqueue({
            key: cacheKey,
            kind: hint.kind || 'agent',
            status: hint.status,
            selected: hint.selected,
            onScreen: hint.onScreen !== false,
            build: () => {
                if (generation !== this._loadGeneration) return;
                const composed = this._composeAtlasFrameCrop(frame);
                if (!composed || generation !== this._loadGeneration) {
                    if (composed) this._releaseCroppedChannels(composed);
                    return;
                }
                const revision = cacheKey;
                const result = {
                    id,
                    frameKey,
                    origin: 'atlas',
                    layout: 'frame-local',
                    albedo: composed.albedo,
                    material: composed.material,
                    emissive: composed.emissive,
                    occluder: composed.occluder,
                    frame,
                    atlas: frame.atlas,
                    revision,
                    ready: true,
                    generation,
                    pixels: resolveMaterialChannelSources({}).pixels,
                };
                this._materialChannelCache.set(cacheKey, result);
                this._materialChannelRevision += 1;
            },
        });
    }

    _composeAtlasFrameCrop(frame) {
        if (!frame?.rect || typeof document === 'undefined') return null;
        const { x, y, w, h } = frame.rect;
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
        const crop = (source) => {
            if (!source) return null;
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { alpha: true });
            if (!ctx) return null;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
            return canvas;
        };
        return {
            albedo: crop(this.getAtlas(frame.atlas, 'albedo')),
            material: crop(this.getAtlas(frame.atlas, 'material')),
            emissive: crop(this.getAtlas(frame.atlas, 'emissive')),
            occluder: crop(this.getAtlas(frame.atlas, 'occluder')),
        };
    }

    _releaseCroppedChannels(channels = {}) {
        for (const image of Object.values(channels)) this._releaseImage(image);
    }

    _invalidateDerivedArt() {
        this._derivedArtQueue?.bumpGeneration();
        for (const entry of this._materialChannelCache.values()) {
            if (entry?.layout === 'frame-local') {
                this._releaseCroppedChannels({
                    albedo: entry.albedo,
                    material: entry.material,
                    emissive: entry.emissive,
                    occluder: entry.occluder,
                });
            }
        }
        this._materialChannelCache.clear();
        this._materialChannelRevision += 1;
    }
    materialDebugSnapshot() {
        const assets = [];
        for (const entry of this._entryById.values()) {
            if (!entry?.materialClass && !entry?.atlasFrame) continue;
            const atlasFrame = normalizeAtlasFrame(entry.atlasFrame);
            const available = Object.fromEntries(MATERIAL_CHANNELS
                .filter((channel) => channel !== 'albedo')
                .map((channel) => [channel, Boolean(
                    this.getCompanion(entry.id, channel)
                    || (atlasFrame?.atlas && this.getAtlas(atlasFrame.atlas, channel)),
                )]));
            assets.push(materialDebugDescriptor(entry, available));
        }
        return {
            enabled: this._materialAssetsEnabled,
            decodedLoaded: this._materialDecodedLoaded,
            atlases: [...this.atlasMetadata.keys()].sort(),
            optionalMisses: [...this._optionalLoadMisses],
            assets,
        };
    }

    cacheStats() {
        let bitmapPixels = 0;
        let decodedBitmapPixels = 0;
        let derivedBitmapPixels = 0;
        let maskBytes = 0;
        let outlinePixels = 0;
        let companionPixels = 0;
        let atlasPixels = 0;
        for (const bitmap of this.bitmaps.values()) {
            const pixels = Math.max(0, Number(bitmap?.width) || 0) * Math.max(0, Number(bitmap?.height) || 0);
            bitmapPixels += pixels;
            if (typeof bitmap?.getContext === 'function') derivedBitmapPixels += pixels;
            else decodedBitmapPixels += pixels;
        }
        for (const mask of this.alphaMasks.values()) maskBytes += mask?.byteLength || 0;
        for (const outline of this.outlines.values()) {
            outlinePixels += Math.max(0, Number(outline?.width) || 0) * Math.max(0, Number(outline?.height) || 0);
        }
        for (const channel of this.companions.values()) {
            for (const image of channel.values()) {
                companionPixels += Math.max(0, Number(image?.width) || 0) * Math.max(0, Number(image?.height) || 0);
            }
        }
        for (const image of this.atlasImages.values()) {
            atlasPixels += Math.max(0, Number(image?.width) || 0) * Math.max(0, Number(image?.height) || 0);
        }
        let actionStripPixels = 0;
        let actionStripCompanionPixels = 0;
        for (const strip of this.actionStrips.values()) {
            for (const [channel, image] of Object.entries(strip.channels || {})) {
                const pixels = Math.max(0, Number(image?.width) || 0) * Math.max(0, Number(image?.height) || 0);
                if (channel === 'albedo') actionStripPixels += pixels;
                else actionStripCompanionPixels += pixels;
            }
        }
        // Browser image/canvas implementations do not expose allocation size.
        // RGBA width x height is therefore a diagnostic estimate, not a claim
        // that every backing allocation is simultaneously resident or exact.
        const baseDecodedImageEstimateBytes = (decodedBitmapPixels + actionStripPixels) * 4;
        const optionalMaterialImageEstimateBytes = (companionPixels + atlasPixels + actionStripCompanionPixels) * 4;
        const decodedImageEstimateBytes = baseDecodedImageEstimateBytes + optionalMaterialImageEstimateBytes;
        const derivedCanvasEstimateBytes = (derivedBitmapPixels + outlinePixels) * 4 + maskBytes;
        const stats = {
            bitmaps: this.bitmaps.size,
            bitmapPixels,
            masks: this.alphaMasks.size,
            maskBytes,
            outlines: this.outlines.size,
            outlinePixels,
            companions: [...this.companions.values()].reduce((sum, channel) => sum + channel.size, 0),
            companionPixels,
            atlasImages: this.atlasImages.size,
            atlasPixels,
            atlasMetadata: this.atlasMetadata.size,
            // Retain the original enumerable diagnostic contract. The value is
            // still an RGBA dimension estimate despite this legacy field name.
            materialTextureBytes: optionalMaterialImageEstimateBytes,
            missing: this.missing.size,
            optionalMissing: this._optionalLoadMisses.length,
            decodedLoaded: this._decodedLoaded,
            materialAssetsEnabled: this._materialAssetsEnabled,
            materialDecodedLoaded: this._materialDecodedLoaded,
            suspended: this._suspended,
            loadInFlight: this._loadPromise !== null,
            decodePasses: this._decodePasses,
        };
        // New accounting diagnostics are non-enumerable so existing snapshot
        // consumers keep their stable shape. They remain normal readable API
        // properties and are consumed directly by the unified ledger.
        Object.defineProperties(stats, {
            ownership: { value: {
                decodedImages: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DECODED,
                    estimateBytes: baseDecodedImageEstimateBytes,
                },
                normalizedBitmapsAndOutlines: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: (derivedBitmapPixels + outlinePixels) * 4,
                },
                alphaMasks: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED,
                    estimateBytes: maskBytes,
                },
                optionalMaterialImages: {
                    ownershipClass: RESOURCE_OWNERSHIP.CPU_DECODED,
                    estimateBytes: optionalMaterialImageEstimateBytes,
                },
            } },
            decodedImageEstimateBytes: { value: decodedImageEstimateBytes },
            derivedCanvasEstimateBytes: { value: derivedCanvasEstimateBytes },
            materialTextureEstimateBytes: { value: optionalMaterialImageEstimateBytes },
            optionalSidecarHighWaterEstimateBytes: { value: OPTIONAL_SIDECAR_HIGH_WATER_ESTIMATE_BYTES },
            actionStrips: { value: this.actionStrips.size },
            actionStripPixels: { value: actionStripPixels + actionStripCompanionPixels },
            activeProfileKeys: { value: [...this._activeProfilePins.keys()].sort() },
            selectedProfilePins: { value: [...this._activeProfilePins]
                .filter(([, pin]) => pin.selected)
                .map(([key]) => key)
                .sort() },
            primaryProfilePins: { value: [...this._activeProfilePins]
                .filter(([, pin]) => pin.primary)
                .map(([key]) => key)
                .sort() },
            evictedOptionalEntries: { value: this._evictedOptionalEntries.size },
        });
        return stats;
    }

    _resourceEstimateLeaves() {
        const stats = this.cacheStats();
        return {
            cpuDecoded: [{
                key: `asset-manager:${this._resourceEstimateId}:decoded`,
                estimateBytes: stats.decodedImageEstimateBytes,
            }],
            cpuDerived: [{
                key: `asset-manager:${this._resourceEstimateId}:derived`,
                estimateBytes: stats.derivedCanvasEstimateBytes,
            }],
        };
    }

    retainProfileAssets(profileKey, assetIds = [], { selected = false, primary = false } = {}) {
        if (!profileKey) return;
        this._activeProfilePins.set(profileKey, {
            assetIds: new Set(assetIds.filter(Boolean)),
            selected: Boolean(selected),
            primary: Boolean(primary),
        });
    }

    releaseProfileAssets(profileKey) {
        if (profileKey) this._activeProfilePins.delete(profileKey);
    }

    /**
     * Explicit pressure operation for optional decoded sidecars only. It never
     * changes a quality setting and is not called by the diagnostic budget.
     */
    evictUnpinnedOptionalSidecars({
        highWaterEstimateBytes = OPTIONAL_SIDECAR_HIGH_WATER_ESTIMATE_BYTES,
    } = {}) {
        const candidates = [];
        for (const [channel, images] of this.companions) {
            for (const [id, image] of images) {
                candidates.push({
                    key: `companion:${channel}:${id}`,
                    estimateBytes: (image?.width || 0) * (image?.height || 0) * 4,
                    image,
                });
            }
        }
        for (const [atlasKey, image] of this.atlasImages) {
            const separator = atlasKey.lastIndexOf(':');
            const atlasId = atlasKey.slice(0, separator);
            const channel = atlasKey.slice(separator + 1);
            candidates.push({
                key: `atlas:${atlasId}:${channel}`,
                estimateBytes: (image?.width || 0) * (image?.height || 0) * 4,
                image,
            });
        }
        let residentEstimateBytes = candidates.reduce((sum, entry) => sum + entry.estimateBytes, 0);
        if (!shouldEvictAtHighWater(residentEstimateBytes, highWaterEstimateBytes)) {
            return { evicted: [], residentEstimateBytes };
        }
        const pinnedKeys = this._optionalSidecarPins();
        const evictable = new Set(unpinnedCacheKeys(candidates, pinnedKeys));
        const evicted = [];
        for (const entry of candidates) {
            if (!evictable.has(entry.key)) continue;
            const parts = entry.key.split(':');
            if (parts[0] === 'companion') this.companions.get(parts[1])?.delete(parts.slice(2).join(':'));
            else this.atlasImages.delete(`${parts[1]}:${parts.slice(2).join(':')}`);
            this._releaseImage(entry.image);
            this._evictedOptionalEntries.set(entry.key, true);
            evicted.push(entry.key);
            residentEstimateBytes -= entry.estimateBytes;
            if (!shouldEvictAtHighWater(residentEstimateBytes, highWaterEstimateBytes)) break;
        }
        return { evicted, residentEstimateBytes: Math.max(0, residentEstimateBytes) };
    }

    _optionalSidecarPins() {
        const pins = new Set();
        for (const pin of this._activeProfilePins.values()) {
            for (const id of pin.assetIds) {
                for (const channel of MATERIAL_CHANNELS) {
                    if (channel !== 'albedo') pins.add(`companion:${channel}:${id}`);
                }
                const atlasId = normalizeAtlasFrame(this.getEntry(id)?.atlasFrame)?.atlas;
                if (!atlasId) continue;
                for (const channel of MATERIAL_CHANNELS) pins.add(`atlas:${atlasId}:${channel}`);
            }
        }
        return pins;
    }

    _reloadOptionalEntry(key) {
        if (!this._evictedOptionalEntries.has(key) || this._optionalReloads.has(key)) return;
        const parts = key.split(':');
        const generation = this._loadGeneration;
        let operation = null;
        if (parts[0] === 'companion') {
            const channel = parts[1];
            const id = parts.slice(2).join(':');
            const entry = this.getEntry(id);
            const path = entry && companionPathFor(entry, channel, this._pathFor(entry));
            if (entry && path) operation = this._loadCompanion(entry, channel, path, { generation });
        } else {
            const atlasId = parts[1];
            const channel = parts.slice(2).join(':');
            const atlas = (this.manifest?.atlases || []).find((item) => item.id === atlasId);
            if (atlas) operation = this._reloadAtlasChannel(atlas, channel, { generation });
        }
        if (!operation) return;
        const tracked = Promise.resolve(operation).finally(() => {
            if (this._optionalReloads.get(key) === tracked) this._optionalReloads.delete(key);
            if (this._optionalEntryResident(key)) this._evictedOptionalEntries.delete(key);
        });
        this._optionalReloads.set(key, tracked);
    }

    _optionalEntryResident(key) {
        const parts = key.split(':');
        if (parts[0] === 'companion') {
            return this.companions.get(parts[1])?.has(parts.slice(2).join(':')) || false;
        }
        return this.atlasImages.has(`${parts[1]}:${parts.slice(2).join(':')}`);
    }

    async _reloadAtlasChannel(atlas, channel, { generation }) {
        const path = atlas?.channels?.[channel];
        const metadata = this.atlasMetadata.get(atlas?.id);
        if (!path || !metadata) return;
        const { img, ok, reason } = await this._loadOptionalImage(path);
        if (!this._canCommitLoad(null, generation)) return;
        if (
            !ok
            || !img
            || Number(metadata.width) !== img.width
            || Number(metadata.height) !== img.height
        ) {
            if (img) this._releaseImage(img);
            this._optionalLoadMisses.push({
                id: atlas.id,
                channel,
                path,
                reason: reason || `dimension ${img?.width}x${img?.height} != metadata ${metadata.width}x${metadata.height}`,
            });
            return;
        }
        this.atlasImages.set(`${atlas.id}:${channel}`, img);
    }

    _releaseDecodedEntries() {
        for (const outline of this.outlines.values()) {
            if (outline && typeof outline === 'object' && 'width' in outline && 'height' in outline) {
                outline.width = 0;
                outline.height = 0;
            }
        }
        for (const bitmap of this.bitmaps.values()) {
            if (typeof bitmap?.close === 'function') {
                try { bitmap.close(); } catch { /* best-effort ImageBitmap release */ }
            } else if (
                typeof HTMLCanvasElement !== 'undefined'
                && bitmap instanceof HTMLCanvasElement
            ) {
                bitmap.width = 0;
                bitmap.height = 0;
            }
        }
        for (const id of [...this.actionStrips.keys()]) this._releaseActionStrip(id);
        this._actionStripLoads.clear();
        this.bitmaps.clear();
        this.alphaMasks.clear();
        this.dimensions.clear();
        this.anchors.clear();
        this.outlines.clear();
        this.missing.clear();
        this._characterFailures.clear();
        this._loadMisses.length = 0;
        this._releaseMaterialEntries();
    }

    _releaseMaterialEntries() {
        for (const channel of this.companions.values()) {
            for (const image of channel.values()) this._releaseImage(image);
            channel.clear();
        }
        for (const image of this.atlasImages.values()) this._releaseImage(image);
        this.atlasImages.clear();
        this.atlasMetadata.clear();
        this._optionalLoadMisses.length = 0;
        this._evictedOptionalEntries.clear();
        this._optionalReloads.clear();
        this._materialDecodedLoaded = false;
        this._invalidateDerivedArt();
    }

    _releaseImage(image) {
        if (typeof image?.close === 'function') {
            try { image.close(); } catch { /* best-effort ImageBitmap release */ }
        } else if (
            typeof HTMLCanvasElement !== 'undefined'
            && image instanceof HTMLCanvasElement
        ) {
            image.width = 0;
            image.height = 0;
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._suspended = true;
        this._decodedLoaded = false;
        this._loadGeneration++;
        this._loadController?.abort?.();
        this._materialLoadController?.abort?.();
        this._abortCharacterLoads();
        this._invalidateDerivedArt();
        this._releaseDecodedEntries();
        this._entryById.clear();
        this._entriesCache = null;
        this.manifest = null;
        this.palettes = null;
        this.assetVersion = null;
        this._materialAssetsEnabled = false;
        this._requestedCharacterIds.clear();
        this._activeProfilePins.clear();
        this._unregisterResourceEstimates?.();
        this._unregisterResourceEstimates = null;
    }
}
