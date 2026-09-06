import { BRIDGE_LANTERN_SCENE_CATEGORY } from './BridgeLanterns.js';
import { HARBOR_TRAFFIC_SCENE_CATEGORY } from './HarborTraffic.js';
import { LANDMARK_ACTIVITY_SCENE_CATEGORY } from './LandmarkActivity.js';

const UNSUPPORTED_POLICIES = new Set([
    'overlay-safe',
    'require-canvas-frame',
    'omit',
]);
const EMPTY_ENTRIES = [];

/**
 * Registry for visual sources that must declare how every scene backend treats
 * them. Categories still enter DrawablePass; this registry owns discovery,
 * neutral command emission, and the policy used when a backend cannot consume
 * those commands.
 */
export class SceneCategoryRegistry {
    constructor(categories = []) {
        this.categories = [];
        this.byId = new Map();
        this._enumeration = { entries: [], totalItems: 0 };
        this._entryPool = [];
        this._flattenPools = new Map();
        this._resolution = {
            requireCanvasFrame: false,
            overlayCategoryIds: new Set(),
            omittedCategoryIds: new Set(),
            nativeCommandBatches: [],
            diagnostics: [],
            categories: [],
        };
        this._statusPool = [];
        this._batchPool = [];
        this._diagnosticPool = [];
        this._diagnosticMessageCache = new Map();
        this._supportRequest = { categoryId: '', commands: null };
        for (const category of categories) this.register(category);
    }

    register(definition) {
        const category = normalizeCategory(definition);
        if (this.byId.has(category.id)) {
            throw new Error(`Scene category already registered: ${category.id}`);
        }
        this.categories.push(category);
        this.byId.set(category.id, category);
        return category;
    }

    enumerate(context = {}) {
        const frame = this._enumeration;
        const entries = frame.entries;
        entries.length = 0;
        let totalItems = 0;
        for (let categoryIndex = 0; categoryIndex < this.categories.length; categoryIndex++) {
            const category = this.categories[categoryIndex];
            const entry = this._entryPool[categoryIndex] ||= {
                category: null,
                items: [],
                commandGroups: [],
                flatCommands: [],
            };
            entry.category = category;
            normalizeItemsInto(category.enumerate(context), entry.items);
            const { items, commandGroups } = entry;
            for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
                const commands = commandGroups[itemIndex] ||= [];
                normalizeCommandsInto(
                    category.emitSceneCommands(items[itemIndex], context),
                    commands,
                );
            }
            commandGroups.length = items.length;
            entries[categoryIndex] = entry;
            totalItems += items.length;
        }
        frame.totalItems = totalItems;
        return frame;
    }

    resolve(frame, backend = {}) {
        const output = this._resolution;
        const overlayCategoryIds = output.overlayCategoryIds;
        const omittedCategoryIds = output.omittedCategoryIds;
        const nativeCommandBatches = output.nativeCommandBatches;
        const diagnostics = output.diagnostics;
        const categories = output.categories;
        overlayCategoryIds.clear();
        omittedCategoryIds.clear();
        nativeCommandBatches.length = 0;
        diagnostics.length = 0;
        categories.length = 0;
        const frameEntries = frame?.entries || EMPTY_ENTRIES;
        let requireCanvasFrame = false;

        for (let entryIndex = 0; entryIndex < frameEntries.length; entryIndex++) {
            const entry = frameEntries[entryIndex];
            const { category, items, commandGroups } = entry;
            if (!items.length) {
                categories[entryIndex] = writeCategoryStatus(
                    this._statusPool,
                    entryIndex,
                    category,
                    'empty',
                    0,
                );
                continue;
            }
            if (backend.canvasFallback === true) {
                categories[entryIndex] = writeCategoryStatus(
                    this._statusPool,
                    entryIndex,
                    category,
                    'canvas-fallback',
                    items.length,
                );
                continue;
            }

            // Native support is all-or-nothing for a category. A missing command
            // for even one item follows the declared unsupported policy instead
            // of allowing a partially rendered category to vanish silently.
            let completeCommands = commandGroups.length === items.length;
            let commands = entry.flatCommands || this._flattenPools.get(category.id);
            if (!commands) {
                commands = [];
                this._flattenPools.set(category.id, commands);
            }
            commands.length = 0;
            for (let groupIndex = 0; groupIndex < commandGroups.length; groupIndex++) {
                const group = commandGroups[groupIndex];
                if (!group.length) completeCommands = false;
                for (let commandIndex = 0; commandIndex < group.length; commandIndex++) {
                    commands.push(group[commandIndex]);
                }
            }
            this._supportRequest.categoryId = category.id;
            this._supportRequest.commands = commands;
            const native = completeCommands
                && backend.supportsSceneCommands?.(this._supportRequest) === true;
            if (native) {
                const batchIndex = nativeCommandBatches.length;
                const batch = this._batchPool[batchIndex] ||= { categoryId: '', commands: null };
                batch.categoryId = category.id;
                batch.commands = commands;
                nativeCommandBatches[batchIndex] = batch;
                categories[entryIndex] = writeCategoryStatus(
                    this._statusPool,
                    entryIndex,
                    category,
                    'native',
                    items.length,
                );
                continue;
            }

            if (category.unsupported === 'overlay-safe') {
                overlayCategoryIds.add(category.id);
                categories[entryIndex] = writeCategoryStatus(
                    this._statusPool,
                    entryIndex,
                    category,
                    'overlay',
                    items.length,
                );
                continue;
            }
            if (category.unsupported === 'require-canvas-frame') {
                requireCanvasFrame = true;
                const diagnosticIndex = diagnostics.length;
                const diagnostic = this._diagnosticPool[diagnosticIndex] ||= {
                    code: '',
                    categoryId: '',
                    backendId: '',
                    message: '',
                };
                const backendId = backend.id || 'unknown';
                diagnostic.code = 'scene-category-requires-canvas';
                diagnostic.categoryId = category.id;
                diagnostic.backendId = backendId;
                diagnostic.message = this._diagnosticMessage(backendId, category);
                diagnostics[diagnosticIndex] = diagnostic;
                categories[entryIndex] = writeCategoryStatus(
                    this._statusPool,
                    entryIndex,
                    category,
                    'canvas-required',
                    items.length,
                );
                continue;
            }

            omittedCategoryIds.add(category.id);
            categories[entryIndex] = writeCategoryStatus(
                this._statusPool,
                entryIndex,
                category,
                'omitted',
                items.length,
            );
        }

        categories.length = frameEntries.length;
        output.requireCanvasFrame = requireCanvasFrame;
        return output;
    }

    _diagnosticMessage(backendId, category) {
        let messages = this._diagnosticMessageCache.get(backendId);
        if (!messages) {
            messages = new Map();
            this._diagnosticMessageCache.set(backendId, messages);
        }
        let message = messages.get(category.id);
        if (!message) {
            message = `Scene backend ${backendId} cannot render category ${category.id}; using the Canvas frame.`;
            messages.set(category.id, message);
        }
        return message;
    }
}

function normalizeCategory(definition = {}) {
    const id = String(definition.id || '').trim();
    if (!id) throw new TypeError('Scene category id is required.');
    if (typeof definition.enumerate !== 'function') {
        throw new TypeError(`Scene category ${id} must define enumerate().`);
    }
    if (typeof definition.emitSceneCommands !== 'function') {
        throw new TypeError(`Scene category ${id} must define emitSceneCommands().`);
    }
    if (typeof definition.canvasFallback !== 'function') {
        throw new TypeError(`Scene category ${id} must define canvasFallback().`);
    }
    if (!UNSUPPORTED_POLICIES.has(definition.unsupported)) {
        throw new TypeError(`Scene category ${id} has an invalid unsupported policy.`);
    }
    const sortBand = finiteBand(definition.sortBand, 50);
    return Object.freeze({
        id,
        sortBand,
        enumerate: definition.enumerate,
        emitSceneCommands: definition.emitSceneCommands,
        canvasFallback: definition.canvasFallback,
        unsupported: definition.unsupported,
        overlayBand: finiteBand(definition.overlayBand, sortBand),
    });
}

function normalizeItemsInto(value, target) {
    if (value === target) return target;
    target.length = 0;
    if (value == null) return target;
    if (Array.isArray(value)) {
        for (const item of value) target.push(item);
        return target;
    }
    for (const item of value) target.push(item);
    return target;
}

function normalizeCommandsInto(value, target) {
    if (value === target) return target;
    target.length = 0;
    if (value == null) return target;
    if (Array.isArray(value)) {
        for (const command of value) if (command) target.push(command);
        return target;
    }
    if (value) {
        target[0] = value;
        target.length = 1;
    }
    return target;
}

function finiteBand(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function writeCategoryStatus(pool, index, category, handling, count) {
    const status = pool[index] ||= {
        id: '',
        handling: '',
        count: 0,
        unsupported: '',
    };
    status.id = category.id;
    status.handling = handling;
    status.count = count;
    status.unsupported = category.unsupported;
    return status;
}

// Built-in registration lives here so frame orchestration has no category list,
// backend-specific or otherwise. Adding a category changes the registry and its
// source adapter, while every renderer receives the same resolved frame.
export const worldSceneCategoryRegistry = new SceneCategoryRegistry([
    HARBOR_TRAFFIC_SCENE_CATEGORY,
    LANDMARK_ACTIVITY_SCENE_CATEGORY,
    BRIDGE_LANTERN_SCENE_CATEGORY,
]);
