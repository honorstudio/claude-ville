import { World } from '../domain/entities/World.js';
import { Building } from '../domain/entities/Building.js';
import { BUILDING_DEFS } from '../config/buildings.js';
import { BUILDING_EVENTS, eventBus } from '../domain/events/DomainEvent.js';
import { i18n } from '../config/i18n.js';
import { STATUS_VISUALS, STATUS_CSS_VARS } from '../config/theme.js';

import { ClaudeDataSource } from '../infrastructure/ClaudeDataSource.js';
import { WebSocketClient } from '../infrastructure/WebSocketClient.js';
import { ChronicleStore } from '../infrastructure/ChronicleStore.js';

import {
    VillagePhase,
    LinkState,
    ProviderHealth,
    initialVillageState,
    reduceVillageState,
    bootStatusText,
    isRetryable,
} from '../application/VillageState.js';
import { AgentManager } from '../application/AgentManager.js';
import { ModeManager } from '../application/ModeManager.js';
import { SessionWatcher } from '../application/SessionWatcher.js';
import { NotificationService } from '../application/NotificationService.js';
import { AttentionService } from '../application/AttentionService.js';
import { ChronicleLog } from '../application/ChronicleLog.js';
import { SpendLedger } from '../application/SpendLedger.js';
import { AuroraGate } from '../application/AuroraGate.js';
import { AgentBiographyService } from '../application/AgentBiographyService.js';
import { MoodService } from '../application/MoodService.js';
import { RelationshipAffinityService } from '../application/RelationshipAffinityService.js';

import { TopBar } from './shared/TopBar.js';
import { Sidebar } from './shared/Sidebar.js';
import { Toast } from './shared/Toast.js';
import { Modal } from './shared/Modal.js';
import { el } from './shared/DomSafe.js';
import { emitAgentSelected, emitAgentDeselected, resetAgentSelection } from './shared/AgentSelection.js';
import { sessionDetailsService } from './shared/SessionDetailsService.js';
import { ClientPerfMetrics } from './shared/ClientPerfMetrics.js';
import { getModelVisualIdentity } from './shared/ModelVisualIdentity.js';
import { isKeyboardEditTarget } from './dashboard-mode/DashboardKeyboardNavigation.js';

import { AssetManager } from './character-mode/AssetManager.js';
import { effectiveCanvasDpr } from './character-mode/CanvasBudget.js';

const LIFECYCLE_DRAIN_TIMEOUT_MS = 2000;
const INITIAL_WEBSOCKET_TIMEOUT_MS = 2500;
const FIRST_RUN_HINT_STORAGE_KEY = 'claudeville.firstRunHint.worldControls.v1';
const FEATURE_STYLES = Object.freeze({
    activity: 'css/activity-panel.css',
    dashboard: 'css/dashboard.css',
    modal: 'css/modal.css',
});

const USABLE_VILLAGE_PHASES = new Set([
    VillagePhase.READY_LIVE,
    VillagePhase.READY_EMPTY,
    VillagePhase.READY_NO_PROVIDERS,
    VillagePhase.DEGRADED,
]);

const EMPTY_SURFACE_COPY = Object.freeze({
    [VillagePhase.STARTING]: Object.freeze({
        title: 'OPENING THE VILLAGE',
        copy: 'Preparing the local watchtowers.',
        next: 'The first snapshot has not arrived yet.',
    }),
    [VillagePhase.SYNCING]: Object.freeze({
        title: 'LISTENING FOR LOCAL SESSIONS',
        copy: 'Still syncing with this machine.',
        next: 'Wait here — agents appear when a session is read.',
    }),
    [VillagePhase.READY_NO_PROVIDERS]: Object.freeze({
        title: 'NO PROVIDERS FOUND',
        copy: 'No supported coding CLI is installed on this machine.',
        next: 'Install Claude, Codex, Gemini, OpenCode, or Kimi, then try again.',
    }),
    [VillagePhase.READY_EMPTY]: Object.freeze({
        title: 'PROVIDERS FOUND / NOTHING ACTIVE',
        copy: 'A watchtower is ready, but no coding session is running.',
        next: 'Start a coding CLI session to see agents here.',
        legend: Object.freeze([
            Object.freeze({ label: 'Forge', value: 'Code work' }),
            Object.freeze({ label: 'Archive', value: 'Reading and search' }),
            Object.freeze({ label: 'Harbor', value: 'Commit ships' }),
            Object.freeze({ label: 'Mine', value: 'Token usage' }),
        ]),
    }),
    [VillagePhase.DEGRADED]: Object.freeze({
        title: 'A WATCHTOWER IS UNREADABLE',
        copy: 'The village cannot read one or more local session sources.',
        next: 'Try again to re-read local sessions.',
    }),
    [VillagePhase.FAILED]: Object.freeze({
        title: 'THE VILLAGE DID NOT OPEN',
        copy: 'The village shell is still here. A step failed while opening.',
        next: 'Try again to re-run the failed step.',
    }),
});

const BOOT_FAILURE_COPY = Object.freeze({
    'network-failed': 'Could not reach the local village server.',
    'server-error': 'The village server returned an error.',
    'request-failed': 'The village server refused a request.',
    'session-read-failed': 'Could not read local sessions.',
    'providers-failed': 'Could not read installed providers.',
    'assets-failed': 'Village art failed to load.',
    'renderer-failed': 'The world renderer failed to open.',
    'aborted': 'Opening the village was interrupted.',
    'boot-failed': 'The village did not finish opening.',
});

export class App {
    constructor() {
        this.world = null;
        this.dataSource = null;
        this.wsClient = null;
        this.agentManager = null;
        this.modeManager = null;
        this.sessionWatcher = null;
        this.notificationService = null;
        this.attentionService = null;
        this.chronicleLog = null;
        this.chroniclePanel = null;
        this.spendLedger = null;
        this.topBar = null;
        this.sidebar = null;
        this.toast = null;
        this.modal = null;
        this.renderer = null;
        this.dashboardRenderer = null;
        this.activityPanel = null;
        this.assets = null;
        this.chronicleStore = null;
        this.auroraGate = null;
        this.biographyService = null;
        this.moodService = null;
        this.affinityService = null;
        this.agentSimulator = null;
        this.simMode = false;
        this.latestUsage = null;
        this._chroniclePruneInterval = null;
        this._chroniclePruneState = { promise: null };
        this._chronicleTasks = new Set();
        this._resizeWorldCanvas = null;
        this._resizeObserver = null;
        this._resizeHandle = null;
        this._loadRendererRetryHandle = null;
        this._loadRendererRetryScheduled = false;
        this._centerCameraHandle = null;
        this._onWindowResize = null;
        this._watchDevicePixelRatio = null;
        this._onDevicePixelRatioChange = null;
        this._dprQuery = null;
        this._perfDebugCanvasBudget = null;
        this._perfDebugStartProfile = null;
        this._perfDebugStopProfile = null;
        this._perfDebugFrameProfile = null;
        this._cameraSetHelper = null;
        this._onWorldContextLost = null;
        this._onWorldContextRestored = null;
        this._onVisibilityChange = null;
        this._worldCanvas = null;
        this._eventUnsubscribers = [];
        this._onPageHide = null;
        this._onFirstRunHintDismiss = null;
        this._bootPromise = null;
        this._bootController = null;
        this._destroyPromise = null;
        this._cleanupPromise = null;
        this._bootState = 'idle';
        this._destroyed = false;
        this._chronicleSignalsBound = false;
        this._agentFollowBound = false;
        this._deepLinkBound = false;
        this.villageState = initialVillageState();
        this._villageBound = false;
        this._foundationReady = false;
        this._surfacesBound = false;
        this._usageRequested = false;
        this._bootStatusWrap = null;
        this._bootStatusEl = null;
        this._bootAnnouncementEl = null;
        this._bootFailureEl = null;
        this._bootActionEl = null;
        this._onBootRetry = null;
        this._retryPromise = null;
        this._firstRunHintRevealed = false;
        this._rendererModulePromise = null;
        this._yamlParserPromise = null;
        this._dashboardLoadPromise = null;
        this._activityPanelLoadPromise = null;
        this._chroniclePanelLoadPromise = null;
        this._stylesheetPromises = new Map();
        this._onDashboardIntent = null;
        this._onDeferredModalIntent = null;
        this._onGlobalKeydown = null;
        this._deferredActivityBound = false;
        this._characterAssetsBound = false;
    }

    boot() {
        if (this._bootPromise) return this._bootPromise;
        if (this._bootState !== 'idle') return Promise.resolve(null);
        this._destroyed = false;
        this._bootState = 'booting';
        this._bootController = new AbortController();
        this._bindPageExit();
        this._bootPromise = this._bootOnce();
        return this._bootPromise;
    }

    async _bootOnce() {
        try {
            console.log('[App] ClaudeVille boot started...');

            // 0. Stamp --cv-status-* from STATUS_VISUALS so CSS and canvas can
            // never fork (plan 1.1); reset.css holds identical fallbacks.
            this._stampStatusCssVars();
            this._ensureBootStatus();
            this._renderVillageSurfaces();
            await new Promise((resolve) => requestAnimationFrame(resolve));
            if (this._destroyed) return null;

            this._dispatchVillage({ type: 'sync-start' });
            this._advanceFromStarting();

            // 4-1. Behavior simulator (?sim=1, dev only — overrides session ingestion)
            const simMode = new URLSearchParams(location.search).get('sim') === '1';
            this.simMode = simMode;
            this._bootFoundation();
            this._bindVillageObservations();
            if (simMode && !this.agentSimulator) {
                const mod = await import('./character-mode/__simfixture__/AgentSimulator.js');
                if (this._destroyed) return null;
                this.agentSimulator = new mod.default({ world: this.world, agentManager: this.agentManager, eventBus });
                this.agentSimulator.start();
            }

            const signal = this._bootController?.signal;

            // 5. Start the independent boot work together. Character image
            // loading joins only after the initial snapshot tells us which
            // profiles are actually resident; parser/module/network discovery
            // does not need to wait for that data dependency.
            if (!this.assets) this.assets = new AssetManager();
            const assetMetadataPromise = this._prepareAssetMetadata({ signal });
            const rendererModulePromise = this._getRendererModule();
            // Dashboard is fetched concurrently with the renderer module rather
            // than lazily on click: a mode switch must paint immediately, and a
            // click can land the instant boot reports ready. Concurrent here, so
            // it costs no serial round trip; it is joined before ready below.
            const dashboardReadyPromise = this._loadDashboard();
            const renderParams = new URLSearchParams(location.search);
            const materialWorldRequested = renderParams.get('renderer') !== 'canvas'
                && renderParams.get('postfx') !== '0';
            let assetsReady = null;
            const beginResidentAssets = (snapshotResult) => {
                if (assetsReady) return;
                if (snapshotResult?.source === 'websocket' && !simMode && !this.sessionWatcher) {
                    this.sessionWatcher = new SessionWatcher(
                        this.agentManager, this.wsClient, this.dataSource
                    );
                    this.sessionWatcher.start();
                }
                const snapshotKnown = snapshotResult?.ok === true;
                assetsReady = assetMetadataPromise.then(() => {
                    const characterIds = snapshotKnown
                        ? this._residentCharacterIds()
                        : null;
                    const albedo = this.assets.load({ signal, characterIds });
                    // From this point onward the manager has either a known
                    // narrowed set or the legacy all-character policy.
                    this._bindCharacterAssetRequests();
                    const materials = materialWorldRequested
                        ? this.assets.loadMaterialAssets({ signal, characterIds })
                        : Promise.resolve(true);
                    return Promise.all([albedo, materials]);
                });
            };
            const sourceResult = await this._syncVillageSources({
                signal,
                onSnapshot: beginResidentAssets,
            });
            if (!assetsReady) beginResidentAssets({ ok: sourceResult?.snapshotKnown === true });
            if (this._destroyed) return null;

            // A normal WebSocket init already includes usage. REST usage is a
            // fallback only, so the same payload is not transferred and parsed
            // twice during a healthy boot.
            if (!simMode && sourceResult?.source !== 'websocket' && !this._usageRequested && this.dataSource) {
                this._usageRequested = true;
                this.dataSource.getUsage({ signal }).then(usage => {
                    if (this._destroyed) return;
                    if (usage) {
                        this.latestUsage = usage;
                        eventBus.emit('usage:updated', usage);
                    }
                });
            }

            // 6. Start session watching (skipped in sim mode)
            if (!simMode && !this.sessionWatcher) {
                this.sessionWatcher = new SessionWatcher(
                    this.agentManager, this.wsClient, this.dataSource
                );
                this.sessionWatcher.start();
            }

            // 7. Handle canvas resizing (run before the renderer so the canvas size is set)
            if (!this._resizeWorldCanvas) this._bindResize();

            // 8. Join the asset and renderer-module branches only when both are
            // ready to mount the World surface.
            const [, rendererModule] = await Promise.all([
                assetsReady,
                rendererModulePromise,
            ]);
            if (this._destroyed) return null;
            console.log('[App] sprite assets loaded');
            if (!this.renderer) await this._loadRenderer(rendererModule);
            if (this._destroyed) return null;

            // 9. Selection plumbing is critical; the panel itself is not. Its
            // module and stylesheet load together on the first selection.
            this._bindAgentFollow();
            this._bindDeepLink();
            if (this.renderer?.selectedAgent) {
                emitAgentSelected(this.renderer.selectedAgent);
            }
            this._applyDeepLink();

            // 10. Apply initial i18n
            this._applyI18n();
            this._renderVillageSurfaces();

            if (this._destroyed) return null;
            // Join the concurrent Dashboard fetch before reporting ready, so a
            // mode switch immediately after boot renders on the next frame
            // instead of waiting on a network round trip. A failure here is not
            // fatal to World mode; the click path retries.
            await dashboardReadyPromise.catch(() => {});
            if (this._destroyed) return null;
            this._bootState = 'ready';
            console.log('[App] ClaudeVille boot complete!');
            return this;
        } catch (err) {
            if (this._destroyed) {
                await this._cleanupOwned();
                return null;
            }
            this._handleBootFailure(err);
            return null;
        }
    }

    _stampStatusCssVars() {
        const rootStyle = document.documentElement?.style;
        if (!rootStyle) return;
        for (const [status, varName] of Object.entries(STATUS_CSS_VARS)) {
            const color = STATUS_VISUALS[status]?.color;
            if (color) rootStyle.setProperty(varName, color);
        }
    }

    _bootFoundation() {
        if (this._foundationReady) return;

        // 1. Initialize domain
        if (!this.world) {
            this.world = new World();
            for (const def of BUILDING_DEFS) {
                this.world.addBuilding(new Building(def));
            }
        }

        // 2. Initialize infrastructure
        if (!this.dataSource) this.dataSource = new ClaudeDataSource();
        if (!this.clientPerfMetrics) this.clientPerfMetrics = new ClientPerfMetrics();
        if (!this.wsClient) {
            this.wsClient = new WebSocketClient({
                performanceMetrics: this.clientPerfMetrics,
            });
        }
        if (!this.chronicleStore) {
            this.chronicleStore = new ChronicleStore(this.simMode
                ? { dbName: 'claudeville-chronicle-simulation' }
                : {});
            this._bindVillageObservations();
            const initialStore = this.chronicleStore;
            this._trackChronicleTask(this._runChroniclePrune().then(() => {
                if (!initialStore._closed) window.__chronicle = initialStore;
            }).catch((err) => {
                console.warn('[App] ChronicleStore unavailable:', err.message);
            }));
            this.biographyService = new AgentBiographyService({ store: this.chronicleStore }).start();
            this.affinityService = new RelationshipAffinityService({ store: this.chronicleStore }).start();
            this.auroraGate = new AuroraGate({ store: this.chronicleStore });
            this._chroniclePruneInterval = window.setInterval(() => {
                this._runChroniclePrune().catch((err) => {
                    console.warn('[App] ChronicleStore prune failed:', err.message);
                });
            }, 5 * 60 * 1000);
        } else {
            this._bindVillageObservations();
        }

        // 3. Initialize UI components
        if (!this.toast) this.toast = new Toast();
        if (!this.modal) this.modal = new Modal();
        if (!this.attentionService) {
            this.attentionService = new AttentionService(this.world, { toast: this.toast });
        }
        if (!this.chronicleLog) {
            this.chronicleLog = new ChronicleLog({ store: this.chronicleStore }).start();
        }
        if (!this.spendLedger) {
            this.spendLedger = new SpendLedger(this.world, { store: this.chronicleStore });
            this._trackChronicleTask(this.spendLedger.start().catch((err) => {
                console.warn('[App] SpendLedger unavailable:', err.message);
            }));
        }
        if (!this.chroniclePanel) {
            this.chroniclePanel = {
                open: () => this._openChroniclePanel(),
            };
        }
        if (!this.topBar) {
            this.topBar = new TopBar(this.world, {
                modal: this.modal,
                attention: this.attentionService,
                chronicle: this.chroniclePanel,
                spendLedger: this.spendLedger,
                frameAttention: () => {
                    if (this.modeManager?.getCurrentMode() === 'dashboard') return false;
                    this.renderer?.cameraDirector?.frameAttention(this.renderer.agentSprites);
                    return true;
                },
            });
        }
        if (!this.sidebar) this.sidebar = new Sidebar(this.world);
        this._bindGlobalKeyboardNavigation();
        this._bindWorldEmptyState();
        this._initFirstRunHint();
        this._initReadControl();
        this._initAmbientControl();

        // 4. Initialize application services
        if (!this.agentManager) {
            this.agentManager = new AgentManager(this.world, this.dataSource);
            this.agentManager.setUsageGetter(() => this.latestUsage);
            this.agentManager.startDepartureSweep();
        }
        if (!this.modeManager) this.modeManager = new ModeManager();
        if (!this.notificationService) this.notificationService = new NotificationService(this.toast);
        if (!this.moodService) this.moodService = new MoodService().start();
        this._bindDeferredDashboard();
        this._bindDeferredActivityPanel();
        this._bindDeferredModalCss();
        this._bindChronicleSignals();

        this._foundationReady = true;
    }

    _dispatchVillage(action, { render = true } = {}) {
        this.villageState = reduceVillageState(this.villageState || initialVillageState(), action);
        if (render) {
            eventBus.emit('village:state', this.villageState);
            this._renderVillageSurfaces();
        }
        return this.villageState;
    }

    _advanceFromStarting() {
        // The reducer latches STARTING until a non-STARTING phase is stored,
        // so boot must advance the latch once loading begins.
        if (this.villageState?.phase !== VillagePhase.STARTING) return;
        this.villageState = { ...this.villageState, phase: VillagePhase.SYNCING };
        eventBus.emit('village:state', this.villageState);
        this._renderVillageSurfaces();
    }

    _bindVillageObservations() {
        if (this._villageBound) return;
        this._villageBound = true;

        const onWsState = (payload = {}) => {
            this._dispatchVillage({
                type: 'link',
                state: payload.state,
                attempts: payload.attempts,
                nextRetryAt: payload.nextRetryAt,
                lastErrorCode: payload.lastErrorCode,
            });
        };
        const onWatcherState = (payload = {}) => {
            if (payload?.ok === true) {
                this._dispatchVillage({
                    type: 'snapshot',
                    source: 'polling',
                    agentCount: this.world?.agents?.size || 0,
                    at: payload.at || Date.now(),
                });
                return;
            }
            if (payload?.ok === false) {
                this._dispatchVillage({
                    type: 'source-failed',
                    code: payload.code || 'session-poll-failed',
                });
                return;
            }
            if (payload?.state === 'polling') {
                this._dispatchVillage({ type: 'link', state: LinkState.POLLING });
            }
        };
        const onWsSnapshot = (data) => {
            const count = Array.isArray(data?.sessions)
                ? data.sessions.length
                : (this.world?.agents?.size || 0);
            this._dispatchVillage({
                type: 'snapshot',
                source: 'websocket',
                agentCount: count,
                at: Date.now(),
            });
        };
        const onChronicleStatus = (payload = {}) => {
            this._dispatchVillage({
                type: 'storage',
                chronicle: payload.status || 'unknown',
            });
        };

        this._eventUnsubscribers.push(eventBus.on('ws:state', onWsState));
        this._eventUnsubscribers.push(eventBus.on('watcher:state', onWatcherState));
        this._eventUnsubscribers.push(eventBus.on('ws:init', onWsSnapshot));
        this._eventUnsubscribers.push(eventBus.on('ws:update', onWsSnapshot));
        this._eventUnsubscribers.push(eventBus.on('chronicle:status', onChronicleStatus));
    }

    async _syncVillageSources({ signal = null, onSnapshot = null } = {}) {
        if (this._destroyed) return;
        if (this.simMode) {
            this.latestUsage = null;
            this._dispatchVillage({
                type: 'providers',
                providers: [{
                    id: 'sim',
                    name: 'Simulator',
                    health: ProviderHealth.HEALTHY,
                    sessions: this.world?.agents?.size || 0,
                }],
            });
            this._dispatchVillage({
                type: 'snapshot',
                source: 'simulator',
                agentCount: this.world?.agents?.size || 0,
                at: Date.now(),
            });
            const result = { ok: true, source: 'simulator', snapshotKnown: true };
            onSnapshot?.(result);
            return result;
        }

        const providersPromise = this._readProviders({ signal });
        const sessionsResult = await this._readInitialSnapshot({ signal });
        onSnapshot?.(sessionsResult);
        const providersResult = await providersPromise;
        if (this._destroyed || signal?.aborted) {
            return { source: 'aborted', snapshotKnown: false };
        }
        if (providersResult?.failed && sessionsResult?.ok) {
            this._dispatchVillage({
                type: 'source-failed',
                code: providersResult.code || 'providers-failed',
            });
        }
        return {
            source: sessionsResult?.source || 'rest',
            snapshotKnown: sessionsResult?.ok === true,
        };
    }

    async _readInitialSnapshot({ signal = null } = {}) {
        const websocket = await this._waitForInitialWebSocketSnapshot({ signal });
        if (websocket?.ok || this._destroyed || signal?.aborted) return websocket;
        const rest = await this._readInitialSessions({ signal });
        return { ...rest, source: 'rest' };
    }

    _waitForInitialWebSocketSnapshot({ signal = null } = {}) {
        if (!this.wsClient || !this.agentManager || signal?.aborted) {
            return Promise.resolve({ ok: false, failed: false, source: 'websocket' });
        }

        return new Promise((resolve) => {
            let settled = false;
            let timeoutHandle = null;
            const unsubscribers = [];
            const finish = (result) => {
                if (settled) return;
                settled = true;
                if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
                for (const unsubscribe of unsubscribers) unsubscribe?.();
                signal?.removeEventListener?.('abort', onAbort);
                resolve(result);
            };
            const onInit = (data) => {
                if (!Array.isArray(data?.sessions)) return;
                this.agentManager.handleWebSocketMessage(data);
                finish({
                    ok: true,
                    failed: false,
                    source: 'websocket',
                    count: data.sessions.length,
                });
            };
            const onDisconnected = () => finish({
                ok: false,
                failed: true,
                source: 'websocket',
            });
            const onAbort = () => finish({
                ok: false,
                failed: false,
                source: 'websocket',
            });

            unsubscribers.push(eventBus.on('ws:init', onInit));
            unsubscribers.push(eventBus.on('ws:disconnected', onDisconnected));
            signal?.addEventListener?.('abort', onAbort, { once: true });
            timeoutHandle = window.setTimeout(() => finish({
                ok: false,
                failed: true,
                source: 'websocket',
            }), INITIAL_WEBSOCKET_TIMEOUT_MS);
            this.wsClient.connect();
        });
    }

    async _readProviders({ signal = null } = {}) {
        if (!this.dataSource) {
            this._dispatchVillage({ type: 'source-failed', code: 'source-unavailable' });
            this._dispatchVillage({ type: 'providers', providers: [] });
            return { failed: true, code: 'source-unavailable' };
        }
        try {
            const providers = await this.dataSource.getProviders({ signal, rejectOnError: true });
            if (this._destroyed || signal?.aborted) return { failed: false };
            this._dispatchVillage({ type: 'providers', providers });
            return { failed: false };
        } catch (err) {
            if (this._destroyed || signal?.aborted || err?.name === 'AbortError') return { failed: false };
            console.error('[App] Failed to read providers:', err);
            const code = this._failureCode(err, 'providers-failed');
            this._dispatchVillage({ type: 'source-failed', code });
            this._dispatchVillage({ type: 'providers', providers: [] });
            return { failed: true, code };
        }
    }

    async _readInitialSessions({ signal = null } = {}) {
        const dataSource = this.dataSource;
        if (!dataSource) {
            this._dispatchVillage({ type: 'source-failed', code: 'source-unavailable' });
            return { ok: false, failed: true };
        }

        const originalGetSessions = dataSource.getSessions;
        const read = { seen: false, ok: false, code: null, count: 0 };
        dataSource.getSessions = async (...args) => {
            try {
                const sessions = await originalGetSessions.apply(dataSource, args);
                read.seen = true;
                read.ok = true;
                read.code = null;
                read.count = Array.isArray(sessions) ? sessions.length : 0;
                return sessions;
            } catch (err) {
                read.seen = true;
                read.ok = false;
                read.code = this._failureCode(err, 'session-read-failed');
                read.count = 0;
                throw err;
            }
        };

        try {
            if (this.agentManager && !this.sessionWatcher) {
                await this.agentManager.loadInitialData({ signal });
            } else {
                try {
                    const sessions = await dataSource.getSessions({ signal });
                    if (this.agentManager && Array.isArray(sessions)) {
                        this.agentManager.handleWebSocketMessage({ sessions });
                    }
                } catch (err) {
                    if (signal?.aborted || err?.name === 'AbortError') return;
                }
            }
        } finally {
            dataSource.getSessions = originalGetSessions;
        }

        if (this._destroyed || signal?.aborted) return { ok: false, failed: false };
        if (read.ok) {
            this._dispatchVillage({
                type: 'snapshot',
                agentCount: this.world?.agents?.size || read.count,
                at: Date.now(),
            });
            return { ok: true, failed: false };
        }
        if (read.seen) {
            // Snapshot then fail in one turn: DEGRADED is unreachable until
            // providersKnown and lastSnapshotAt are both set, and a lone
            // source-failed would leave the operator stuck on SYNCING without retry.
            this._dispatchVillage({
                type: 'snapshot',
                agentCount: this.world?.agents?.size || 0,
                at: Date.now(),
            }, { render: false });
            this._dispatchVillage({
                type: 'source-failed',
                code: read.code || 'session-read-failed',
            }, { render: false });
            this._dispatchVillage({ type: 'link', state: LinkState.SYNCING });
            return { ok: false, failed: true };
        }
        return { ok: false, failed: false };
    }

    _failureCode(err, fallback = 'boot-failed') {
        if (!err) return fallback;
        if (err.name === 'AbortError') return 'aborted';
        const message = String(err.message || '');
        if (/failed to fetch|networkerror|net::/i.test(message)) return 'network-failed';
        if (/HTTP 5\d\d/.test(message)) return 'server-error';
        if (/HTTP 4\d\d/.test(message)) return 'request-failed';
        if (/asset|sprite|yaml/i.test(message)) return 'assets-failed';
        if (/renderer/i.test(message)) return 'renderer-failed';
        return fallback;
    }

    _failureCopy(code) {
        return BOOT_FAILURE_COPY[code] || BOOT_FAILURE_COPY['boot-failed'];
    }

    _handleBootFailure(err) {
        console.error('[App] boot failed:', err);
        this._bootState = 'failed';
        this._dispatchVillage({ type: 'boot-failed', code: this._failureCode(err, 'boot-failed') });
    }

    async _retryVillage() {
        if (this._destroyed) return null;
        if (this._retryPromise) return this._retryPromise;
        this._retryPromise = this._retryVillageOnce();
        try {
            return await this._retryPromise;
        } finally {
            this._retryPromise = null;
        }
    }

    async _retryVillageOnce() {
        const failed = this.villageState?.phase === VillagePhase.FAILED || this._bootState === 'failed';
        this._dispatchVillage({ type: 'retry' });
        if (this._bootActionEl) this._bootActionEl.disabled = true;
        try {
            if (failed) {
                this._bootPromise = null;
                this._bootState = 'idle';
                return await this.boot();
            }
            await this._syncVillageSources({ signal: this._bootController?.signal });
            if (!this.renderer) await this._loadRenderer();
            this._renderVillageSurfaces();
            return this;
        } catch (err) {
            this._handleBootFailure(err);
            return null;
        } finally {
            if (this._bootActionEl) this._bootActionEl.disabled = false;
        }
    }

    _ensureBootStatus() {
        if (this._bootStatusEl?.isConnected) return;
        const wrap = el('div', {
            className: 'boot-status-wrap',
            style: {
                position: 'fixed',
                top: '58px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: '90',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '8px',
                pointerEvents: 'none',
                maxWidth: '520px',
                textAlign: 'center',
            },
        });
        wrap.id = 'bootStatusWrap';

        const status = el('div', {
            className: 'boot-status',
            text: bootStatusText(this.villageState),
        });
        status.id = 'bootStatus';
        status.setAttribute('aria-hidden', 'true');

        const announcement = el('div', {
            className: 'visually-hidden',
            text: bootStatusText(this.villageState),
        });
        announcement.id = 'bootStatusAnnouncement';
        announcement.setAttribute('role', 'status');
        announcement.setAttribute('aria-live', 'polite');
        announcement.setAttribute('aria-atomic', 'true');

        const failure = el('div', {
            className: 'boot-failure',
        });
        failure.id = 'bootFailureCopy';

        const action = document.createElement('button');
        action.id = 'bootAction';
        action.type = 'button';
        action.className = 'boot-action';
        action.textContent = 'TRY AGAIN';
        action.setAttribute('aria-label', 'Try again');
        Object.assign(action.style, {
            pointerEvents: 'auto',
            cursor: 'pointer',
            display: 'none',
        });
        this._onBootRetry = () => { void this._retryVillage(); };
        action.addEventListener('click', this._onBootRetry);

        wrap.append(status, failure, action);
        document.body.append(wrap, announcement);
        this._bootStatusWrap = wrap;
        this._bootStatusEl = status;
        this._bootAnnouncementEl = announcement;
        this._bootFailureEl = failure;
        this._bootActionEl = action;
    }

    _renderVillageSurfaces() {
        if (this._destroyed) return;
        this._ensureBootStatus();
        const state = this.villageState || initialVillageState();
        const phase = state.phase;
        let status = bootStatusText(state);
        if (state.storage?.chronicle === 'degraded') {
            status = `${status} · CHRONICLE HISTORY UNAVAILABLE`;
        }
        this._setTextIfChanged(this._bootStatusEl, status);
        this._setTextIfChanged(this._bootAnnouncementEl, status);
        if (this._bootStatusWrap) {
            const settled = phase === VillagePhase.READY_LIVE
                || phase === VillagePhase.READY_EMPTY
                || phase === VillagePhase.READY_NO_PROVIDERS;
            this._bootStatusWrap.hidden = settled && state.storage?.chronicle !== 'degraded';
        }

        const retryable = isRetryable(state);
        const failureCode = state.failureCode || (phase === VillagePhase.DEGRADED ? state.link?.lastErrorCode : null);
        if (this._bootFailureEl) {
            if (phase === VillagePhase.FAILED) {
                this._setTextIfChanged(this._bootFailureEl, this._failureCopy(failureCode));
                this._bootFailureEl.style.display = '';
            } else {
                this._bootFailureEl.style.display = 'none';
            }
        }
        if (this._bootActionEl) {
            this._bootActionEl.style.display = retryable ? '' : 'none';
            this._bootActionEl.disabled = Boolean(this._retryPromise);
        }

        const copy = EMPTY_SURFACE_COPY[phase] || EMPTY_SURFACE_COPY[VillagePhase.SYNCING];
        const occupied = (state.agentCount || 0) > 0 || (this.world?.agents?.size || 0) > 0;
        const showEmpty = phase !== VillagePhase.READY_LIVE && !occupied;
        this._paintEmptySurface(document.getElementById('worldEmpty'), {
            titleSel: '.world-empty__title',
            copySel: '.world-empty__copy',
            nextClass: 'world-empty__next',
            legendSel: '.world-empty__legend',
            copy,
            show: showEmpty,
            useHidden: true,
        });
        this._paintEmptySurface(document.getElementById('dashboardEmpty'), {
            titleSel: '.dashboard__empty-text',
            copySel: '.dashboard__empty-sub',
            nextClass: 'dashboard__empty-next',
            copy,
            show: showEmpty,
            visibleClass: 'dashboard__empty--visible',
        });

        this._syncFirstRunHint();
    }

    _paintEmptySurface(root, { titleSel, copySel, nextClass, legendSel, copy, show, useHidden, visibleClass }) {
        if (!root) return;
        root.dataset.phase = this.villageState?.phase || VillagePhase.SYNCING;
        const quietWorld = root.id === 'worldEmpty' && copy === EMPTY_SURFACE_COPY[VillagePhase.READY_EMPTY];
        const title = root.querySelector(titleSel);
        const body = root.querySelector(copySel);
        let next = root.querySelector(`.${nextClass}`);
        if (!next) {
            next = el('span', {
                className: nextClass,
            });
            root.appendChild(next);
        }
        this._setTextIfChanged(title, quietWorld ? 'VILLAGE READY' : copy.title);
        this._setTextIfChanged(body, quietWorld ? 'Start a coding CLI session to see agents here.' : copy.copy);
        this._setTextIfChanged(next, copy.next);
        const legend = legendSel ? root.querySelector(legendSel) : null;
        if (legend) {
            const rows = copy.legend || [];
            legend.replaceChildren(...rows.flatMap(({ label, value }) => {
                const term = document.createElement('dt');
                const description = document.createElement('dd');
                term.textContent = label;
                description.textContent = value;
                return [term, description];
            }));
            legend.hidden = rows.length === 0;
        }
        if (useHidden) root.hidden = !show;
        if (visibleClass) root.classList.toggle(visibleClass, show);
        const hints = root.querySelector('.dashboard__empty-hints');
        if (hints) hints.hidden = copy !== EMPTY_SURFACE_COPY[VillagePhase.READY_EMPTY];
    }

    _setTextIfChanged(node, text) {
        if (!node) return;
        const next = text == null ? '' : String(text);
        if (node.textContent !== next) node.textContent = next;
    }

    _bindWorldEmptyState() {
        if (this._surfacesBound) return;
        this._surfacesBound = true;
        const sync = () => this._renderVillageSurfaces();
        this._eventUnsubscribers.push(eventBus.on('agent:added', sync));
        this._eventUnsubscribers.push(eventBus.on('agent:removed', sync));
        sync();
        this._eventUnsubscribers.push(eventBus.on('mode:changed', mode => {
            if (mode !== 'dashboard') return;
            const hint = document.getElementById('firstRunHint');
            if (hint && !hint.hidden) this._onFirstRunHintDismiss?.();
        }));
    }

    _initReadControl() {
        const button = document.getElementById('worldRead');
        if (!button || this._readControlCleanup) return;
        const set = on => {
            this.renderer?.setReadMode(on);
            button.setAttribute('aria-pressed', String(on));
        };
        const down = event => {
            if (event.type === 'keydown' && ![' ', 'Enter'].includes(event.key)) return;
            if (event.type === 'pointerdown' && event.button !== 0) return;
            event.preventDefault();
            set(true);
        };
        const up = () => set(false);
        const bindings = [
            [button, 'pointerdown', down], [button, 'keydown', down],
            [button, 'keyup', up], [button, 'pointerup', up],
            [button, 'pointerleave', up], [button, 'pointercancel', up],
            [button, 'blur', up], [window, 'pointerup', up], [window, 'blur', up],
        ];
        for (const [target, name, handler] of bindings) target.addEventListener(name, handler);
        this._eventUnsubscribers.push(eventBus.on('mode:changed', mode => {
            up();
            button.hidden = mode === 'dashboard';
        }));
        this._readControlCleanup = () => {
            up();
            for (const [target, name, handler] of bindings) target.removeEventListener(name, handler);
            this._readControlCleanup = null;
        };
    }

    // 5.1 (C6) — the only way into Ambient. The control also carries the
    // revocation state: once a genuine input hands the frame back, it reads
    // RESUME AMBIENT and waits to be asked again. Nothing here is on a timer.
    _initAmbientControl() {
        const button = document.getElementById('worldAmbient');
        if (!button || this._ambientControlCleanup) return;
        const apply = state => {
            const on = state === 'on';
            button.dataset.state = state;
            button.textContent = state === 'resume' ? 'RESUME AMBIENT' : 'AMBIENT CAM';
            button.setAttribute('aria-pressed', String(on));
            button.classList.toggle('topbar__sound-btn--on', on);
        };
        const onClick = () => {
            const director = this.renderer?.cameraDirector;
            if (!director?.setAmbient) return;
            if (button.dataset.state === 'on') {
                director.setAmbient(false);
                apply('off');
                return;
            }
            apply(director.setAmbient(true) ? 'on' : 'off');
        };
        button.addEventListener('click', onClick);
        const onOwner = payload => {
            if (payload?.owner === 'ambient') { apply('on'); return; }
            if (payload?.previous !== 'ambient') return;
            apply(payload.reason === 'release' ? 'off' : 'resume');
        };
        this._eventUnsubscribers.push(eventBus.on('camera:owner', onOwner));
        this._eventUnsubscribers.push(eventBus.on('mode:changed', mode => {
            // The World stops while Dashboard is up; a broadcast cannot run
            // behind a hidden canvas, so the claim is dropped, not parked.
            this.renderer?.cameraDirector?.setAmbient?.(false);
            apply('off');
            button.hidden = mode === 'dashboard';
        }));
        this._ambientControlCleanup = () => {
            button.removeEventListener('click', onClick);
            this._ambientControlCleanup = null;
        };
        apply('off');
    }

    _initFirstRunHint() {
        const hint = document.getElementById('firstRunHint');
        const dismiss = document.getElementById('firstRunHintDismiss');
        if (!hint || !dismiss) return;
        if (this._onFirstRunHintDismiss) return;

        this._onFirstRunHintDismiss = () => {
            hint.hidden = true;
            dismiss.removeEventListener('click', this._onFirstRunHintDismiss);
            this._onFirstRunHintDismiss = null;
            this._markFirstRunHintSeen();
        };
        dismiss.addEventListener('click', this._onFirstRunHintDismiss);
    }

    _syncFirstRunHint() {
        const hint = document.getElementById('firstRunHint');
        if (!hint || this._firstRunHintRevealed) return;
        if (this.modeManager?.getCurrentMode() === 'dashboard') return;
        if (!USABLE_VILLAGE_PHASES.has(this.villageState?.phase)) return;
        if (this._hasFirstRunHintBeenSeen()) return;
        hint.hidden = false;
        this._firstRunHintRevealed = true;
        this._markFirstRunHintSeen();
    }

    _hasFirstRunHintBeenSeen() {
        try {
            return window.localStorage?.getItem(FIRST_RUN_HINT_STORAGE_KEY) === '1';
        } catch {
            return false;
        }
    }

    _markFirstRunHintSeen() {
        try {
            window.localStorage?.setItem(FIRST_RUN_HINT_STORAGE_KEY, '1');
        } catch {
            // Storage may be disabled; the hint remains dismissible for this page.
        }
    }

    _bindPageExit() {
        if (this._onPageHide) return;
        this._onPageHide = (event) => {
            if (!event.persisted) void this.destroy();
        };
        window.addEventListener('pagehide', this._onPageHide);
    }

    _runChroniclePrune() {
        if (!this.chronicleStore) return Promise.resolve(null);
        const state = this._chroniclePruneState;
        if (state.promise) return state.promise;
        const store = this.chronicleStore;
        const prunePromise = store.open()
            .then(() => store.prune())
            .finally(() => {
                if (state.promise === prunePromise) state.promise = null;
            });
        state.promise = prunePromise;
        return prunePromise;
    }

    _prepareAssetMetadata({ signal = null } = {}) {
        const warm = (url) => fetch(url, { signal }).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            return response.text();
        });
        const warmMetadata = Promise.allSettled([
            warm('assets/sprites/manifest.yaml'),
            warm('assets/sprites/palettes.yaml'),
        ]);
        return Promise.all([
            this._loadYamlParser(),
            warmMetadata,
        ]);
    }

    _loadYamlParser() {
        if (globalThis.jsyaml?.load) return Promise.resolve(globalThis.jsyaml);
        if (!this._yamlParserPromise) {
            this._yamlParserPromise = import('../../vendor/js-yaml.min.js').then(() => {
                if (!globalThis.jsyaml?.load) {
                    throw new Error('js-yaml did not expose its parser');
                }
                return globalThis.jsyaml;
            });
        }
        return this._yamlParserPromise;
    }

    _residentCharacterIds() {
        const agents = this.world?.agents;
        if (!agents || typeof agents.values !== 'function') return null;
        const ids = new Set();
        for (const agent of agents.values()) {
            const identity = getModelVisualIdentity(agent?.model, agent?.effort, agent?.provider);
            if (identity?.spriteId?.startsWith('agent.')) ids.add(identity.spriteId);
        }
        return [...ids];
    }

    _bindCharacterAssetRequests() {
        if (this._characterAssetsBound) return;
        this._characterAssetsBound = true;
        const request = (agent) => {
            const identity = getModelVisualIdentity(agent?.model, agent?.effort, agent?.provider);
            const id = identity?.spriteId;
            if (!id?.startsWith('agent.')) return;
            void this._loadYamlParser().then(() => (
                this.assets?.requestCharacterAssets?.(id, {
                    signal: this._bootController?.signal,
                })
            )).catch((error) => {
                if (!this._destroyed) {
                    console.warn('[App] Character assets failed to load:', error.message);
                }
            });
        };
        this._eventUnsubscribers.push(eventBus.on('agent:added', request));
        this._eventUnsubscribers.push(eventBus.on('agent:updated', request));
    }

    _getRendererModule() {
        if (!this._rendererModulePromise) {
            this._rendererModulePromise = import('./character-mode/IsometricRenderer.js');
        }
        return this._rendererModulePromise;
    }

    _ensureStylesheet(feature) {
        const href = FEATURE_STYLES[feature];
        if (!href) return Promise.reject(new Error(`Unknown feature stylesheet: ${feature}`));
        if (this._stylesheetPromises.has(feature)) return this._stylesheetPromises.get(feature);

        const existing = document.querySelector(`link[data-cv-feature-style="${feature}"]`);
        const promise = new Promise((resolve, reject) => {
            const link = existing || document.createElement('link');
            const onLoad = () => {
                link.dataset.cvLoaded = 'true';
                resolve(link);
            };
            const onError = () => {
                link.remove();
                reject(new Error(`Failed to load ${href}`));
            };
            if (link.dataset.cvLoaded === 'true' || link.sheet) {
                resolve(link);
                return;
            }
            link.addEventListener('load', onLoad, { once: true });
            link.addEventListener('error', onError, { once: true });
            if (!existing) {
                link.rel = 'stylesheet';
                link.href = href;
                link.dataset.cvFeatureStyle = feature;
                document.head.append(link);
            }
        }).catch((error) => {
            this._stylesheetPromises.delete(feature);
            throw error;
        });
        this._stylesheetPromises.set(feature, promise);
        return promise;
    }

    _stylesheetLoaded(feature) {
        const link = document.querySelector(`link[data-cv-feature-style="${feature}"]`);
        return Boolean(link && (link.dataset.cvLoaded === 'true' || link.sheet));
    }

    _bindDeferredDashboard() {
        if (this._onDashboardIntent) return;
        const button = document.getElementById('btnModeDashboard');
        if (!button) return;
        this._onDashboardIntent = (event) => {
            if (this.dashboardRenderer || this._destroyed) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            void this._loadDashboard().then((loaded) => {
                if (loaded && !this._destroyed) this.modeManager?.switchMode('dashboard');
            }).finally(() => {
                if (!button.isConnected) return;
                button.disabled = false;
                button.removeAttribute('aria-busy');
            });
        };
        button.addEventListener('click', this._onDashboardIntent, true);
    }

    _bindGlobalKeyboardNavigation() {
        if (this._onGlobalKeydown) return;
        this._onGlobalKeydown = (event) => {
            if (event.defaultPrevented || isKeyboardEditTarget(event.target)) return;
            const searchShortcut = (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey)
                || (event.key.toLowerCase() === 'k'
                    && (event.ctrlKey || event.metaKey)
                    && !event.altKey);
            if (searchShortcut) {
                event.preventDefault();
                this.sidebar?.focusSearch();
                return;
            }
            if (event.key === 'Escape' && this.sidebar?.clearFilter()) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        };
        document.addEventListener('keydown', this._onGlobalKeydown);
    }

    _bindDeferredActivityPanel() {
        if (this._deferredActivityBound) return;
        this._deferredActivityBound = true;
        this._deferredSelectionIntent = null;
        this._onDeferredInteractionClick = (event) => {
            this._deferredSelectionIntent = {
                origin: event.detail === 0 ? 'keyboard' : 'pointer',
                trigger: event.target,
            };
            queueMicrotask(() => { this._deferredSelectionIntent = null; });
        };
        this._onDeferredInteractionKeydown = (event) => {
            this._deferredSelectionIntent = { origin: 'keyboard', trigger: event.target };
            queueMicrotask(() => { this._deferredSelectionIntent = null; });
        };
        document.addEventListener('click', this._onDeferredInteractionClick, true);
        document.addEventListener('keydown', this._onDeferredInteractionKeydown, true);

        this._eventUnsubscribers.push(eventBus.on('agent:selected', (agent) => {
            if (!agent || this.activityPanel) return;
            const intent = this._deferredSelectionIntent;
            void this._loadActivityPanel().then((panel) => {
                if (!panel || this._destroyed) return;
                if (intent) panel._selectionIntent = intent;
                panel.show(agent);
            });
        }));
        this._eventUnsubscribers.push(eventBus.on(BUILDING_EVENTS.SELECTED, (building) => {
            if (!building || this.activityPanel) return;
            const intent = this._deferredSelectionIntent;
            void this._loadActivityPanel().then((panel) => {
                if (!panel || this._destroyed) return;
                if (intent) panel._selectionIntent = intent;
                panel.showBuilding(building);
            });
        }));
    }

    _loadActivityPanel() {
        if (this.activityPanel) return Promise.resolve(this.activityPanel);
        if (this._activityPanelLoadPromise) return this._activityPanelLoadPromise;
        this._activityPanelLoadPromise = Promise.all([
            this._ensureStylesheet('activity'),
            import('./shared/ActivityPanel.js'),
        ]).then(([, module]) => {
            if (this._destroyed || !module.ActivityPanel) return null;
            this.activityPanel = new module.ActivityPanel({
                world: () => this.world,
                renderer: () => this.renderer,
                harborTraffic: () => this.renderer?.harborTraffic || null,
                biographyService: () => this.biographyService,
                affinityService: () => this.affinityService,
                toast: this.toast,
            });
            return this.activityPanel;
        }).catch((error) => {
            console.warn('[App] ActivityPanel failed to load:', error.message);
            this._activityPanelLoadPromise = null;
            return null;
        });
        return this._activityPanelLoadPromise;
    }

    _bindDeferredModalCss() {
        if (this._onDeferredModalIntent) return;
        this._onDeferredModalIntent = (event) => {
            if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
            const target = event.target?.closest?.(
                '.topbar__version, [aria-label="Open settings"]',
            );
            if (!target || this._stylesheetLoaded('modal')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            target.setAttribute('aria-busy', 'true');
            void this._ensureStylesheet('modal').then(() => {
                if (!this._destroyed && target.isConnected) target.click();
            }).catch((error) => {
                console.warn('[App] Modal stylesheet failed to load:', error.message);
            }).finally(() => target.removeAttribute('aria-busy'));
        };
        document.addEventListener('click', this._onDeferredModalIntent, true);
        document.addEventListener('keydown', this._onDeferredModalIntent, true);
    }

    async _openChroniclePanel() {
        if (!this._chroniclePanelLoadPromise) {
            this._chroniclePanelLoadPromise = Promise.all([
                this._ensureStylesheet('modal'),
                import('./shared/ChroniclePanel.js'),
            ]).then(([, module]) => {
                if (this._destroyed || !module.ChroniclePanel) return null;
                const panel = new module.ChroniclePanel({
                    modal: this.modal,
                    chronicleLog: this.chronicleLog,
                    spendLedger: this.spendLedger,
                    usageGetter: () => this.latestUsage,
                    toast: this.toast,
                });
                this.chroniclePanel = panel;
                return panel;
            }).catch((error) => {
                this._chroniclePanelLoadPromise = null;
                throw error;
            });
        }
        const panel = await this._chroniclePanelLoadPromise;
        return panel?.open?.();
    }

    async _loadRenderer(rendererModule = null) {
        let candidate = null;
        try {
            if (this._destroyed) return;
            const module = rendererModule || await this._getRendererModule();
            if (this._destroyed) return;
            const canvas = document.getElementById('worldCanvas');

            if (!module.IsometricRenderer) {
                throw new Error('IsometricRenderer module missing export');
            }

            if (!canvas) {
                if (!this._loadRendererRetryScheduled) {
                    this._loadRendererRetryScheduled = true;
                    this._loadRendererRetryHandle = requestAnimationFrame(() => {
                        this._loadRendererRetryHandle = null;
                        this._loadRendererRetryScheduled = false;
                        if (this._destroyed) return;
                        void this._loadRenderer();
                    });
                }
                console.warn('[App] worldCanvas not found yet (retrying render mount)');
                return;
            }

            candidate = new module.IsometricRenderer(this.world, {
                assets: this.assets,
                chronicleStore: this.chronicleStore,
                modal: this.modal,
                moodService: this.moodService,
                biographyService: this.biographyService,
                affinityService: this.affinityService,
            });
            if (candidate.show(canvas) === false) {
                throw new Error('IsometricRenderer failed to mount');
            }
            candidate.setWorldModeActive?.(
                this.modeManager?.getCurrentMode?.() !== 'dashboard',
            );
            if (this.latestUsage) candidate.setQuotaState?.(this.latestUsage);

            candidate.onAgentSelect = (agent) => {
                if (agent) emitAgentSelected(agent);
                else emitAgentDeselected();
            };

            const scenarioMetadata = this.agentSimulator?.getScenario?.()?.metadata || null;
            const scenarioApplied = candidate.applyScenarioMetadata?.(scenarioMetadata) || false;
            if (this._destroyed) {
                candidate.hide?.();
                return;
            }
            const previous = this.renderer;
            this.renderer = candidate;
            previous?.hide?.();
            this._installPerfDebugHelper();
            if (!scenarioApplied || !scenarioMetadata?.camera) {
                this._centerCameraHandle = requestAnimationFrame(() => {
                    this._centerCameraHandle = null;
                    if (this.renderer === candidate && candidate.camera) {
                        if (typeof candidate.frameContent === 'function') {
                            candidate.frameContent();
                        } else {
                            candidate.camera.centerOnMap();
                        }
                    }
                });
            }

            console.log('[App] IsometricRenderer loaded');
        } catch (err) {
            candidate?.hide?.();
            if (this.renderer === candidate) this.renderer = null;
            console.warn('[App] IsometricRenderer not available yet (waiting on canvas-artist work):', err.message);
        }
    }

    async _loadDashboard() {
        if (this.dashboardRenderer) return true;
        if (this._dashboardLoadPromise) return this._dashboardLoadPromise;
        this._dashboardLoadPromise = this._loadDashboardOnce();
        return this._dashboardLoadPromise;
    }

    async _loadDashboardOnce() {
        let candidate = null;
        try {
            if (this._destroyed) return;
            const [, module] = await Promise.all([
                this._ensureStylesheet('dashboard'),
                import('./dashboard-mode/DashboardRenderer.js'),
            ]);
            if (this._destroyed) return;
            if (module.DashboardRenderer) {
                candidate = new module.DashboardRenderer(this.world, { toast: this.toast });
                if (this._destroyed) {
                    candidate.destroy?.();
                    return;
                }
                this.dashboardRenderer?.destroy?.();
                this.dashboardRenderer = candidate;
                console.log('[App] DashboardRenderer loaded');
                return true;
            }
        } catch (err) {
            candidate?.destroy?.();
            if (this.dashboardRenderer === candidate) this.dashboardRenderer = null;
            this._dashboardLoadPromise = null;
            console.warn('[App] DashboardRenderer failed to load:', err.message);
            return false;
        }
        return false;
    }

    _bindAgentFollow() {
        if (this._agentFollowBound) return;
        this._agentFollowBound = true;
        // Follow the camera when an agent is selected
        this._eventUnsubscribers.push(eventBus.on('agent:selected', (agent) => {
            if (agent && this.renderer) {
                this.renderer.selectAgentById(agent.id);
            }
        }));
        this._eventUnsubscribers.push(eventBus.on('agents:pins-changed', (detail = {}) => {
            this.renderer?.setPinnedAgentIds?.(detail.pinnedAgentIds || []);
        }));


        // Stop following when the panel closes
        this._eventUnsubscribers.push(eventBus.on('agent:deselected', () => {
            if (this.renderer) {
                this.renderer.selectAgentById(null);
            }
        }));
    }

    _bindDeepLink() {
        if (this._deepLinkBound) return;
        this._deepLinkBound = true;
        // Mirror the current agent selection into the URL fragment so links
        // like /#agent=<id> can be shared.
        this._eventUnsubscribers.push(eventBus.on('agent:selected', (agent) => {
            if (!agent?.id) return;
            history.replaceState(null, '', `#agent=${encodeURIComponent(agent.id)}`);
        }));
        this._eventUnsubscribers.push(eventBus.on('agent:deselected', () => {
            if (location.hash.startsWith('#agent=')) {
                history.replaceState(null, '', location.pathname + location.search);
            }
        }));
    }

    _applyDeepLink() {
        const match = /^#agent=(.+)$/.exec(location.hash);
        if (!match) return;
        let agentId;
        try {
            agentId = decodeURIComponent(match[1]);
        } catch {
            return;
        }
        const agent = this.world?.agents?.get?.(agentId);
        if (agent) emitAgentSelected(agent);
    }

    _bindChronicleSignals() {
        if (this._chronicleSignalsBound) return;
        this._chronicleSignalsBound = true;
        this._eventUnsubscribers.push(eventBus.on('chronicle:milestone', (monument) => {
            this.auroraGate?.recordMilestone(monument);
            this._trackChronicleTask(this.auroraGate?.evaluate(Date.now(), {
                release: monument?.kind === 'release',
                majorVerified: monument?.kind === 'verified' && monument?.weight === 'major',
            }).then((result) => {
                if (result === 'fire') {
                    eventBus.emit('chronicle:aurora', { ts: Date.now(), reason: monument?.kind || 'milestone' });
                }
            }).catch(() => {}));
        }));

        this._eventUnsubscribers.push(eventBus.on('usage:updated', (usage) => {
            this.latestUsage = usage;
            this.renderer?.setQuotaState?.(usage);
            const fiveHour = Number(usage?.quota?.fiveHour);
            if (Number.isFinite(fiveHour) && fiveHour > 0.85) {
                eventBus.emit('quota:throttled', { fiveHour, ts: Date.now() });
            }
            this._trackChronicleTask(this.auroraGate?.handleUsageUpdate(usage).then((result) => {
                if (result === 'fire') {
                    eventBus.emit('chronicle:aurora', { ts: Date.now(), reason: 'quota-rollover' });
                }
            }).catch(() => {}));
        }));

        this._eventUnsubscribers.push(eventBus.on('chronicle:aurora', () => {
            this.renderer?.skyRenderer?.triggerAurora?.();
        }));
    }

    _trackChronicleTask(task) {
        if (!task || typeof task.finally !== 'function') return task;
        const tasks = this._chronicleTasks;
        tasks.add(task);
        task.then(
            () => tasks.delete(task),
            () => tasks.delete(task),
        );
        return task;
    }

    _bindResize() {
        const canvas = document.getElementById('worldCanvas');
        const fxCanvas = document.getElementById('worldFxCanvas');
        const overlayCanvas = document.getElementById('worldOverlayCanvas');
        const container = canvas?.parentElement;
        if (!canvas || !container) return;
        const canvasSurfaces = [canvas, fxCanvas, overlayCanvas].filter(Boolean);
        this._worldCanvas = canvas;
        if (this._resizeHandle) {
            cancelAnimationFrame(this._resizeHandle);
            this._resizeHandle = null;
        }

        const resize = ({ force = false } = {}) => {
            const w = container.clientWidth;
            const h = container.clientHeight;

            if (w === 0 || h === 0) {
                if (!this._resizeHandle && this.modeManager?.getCurrentMode() !== 'dashboard') {
                    this._resizeHandle = requestAnimationFrame(() => {
                        this._resizeHandle = null;
                        if (this._destroyed) return;
                        resize();
                    });
                }
                return;
            }

            this._resizeHandle = null;

            const cssWidth = Math.round(w);
            const cssHeight = Math.round(h);
            const dpr = effectiveCanvasDpr(cssWidth, cssHeight, window.devicePixelRatio || 1);
            const newW = Math.round(cssWidth * dpr);
            const newH = Math.round(cssHeight * dpr);
            if (
                !force &&
                canvasSurfaces.every(surface => (
                    surface.width === newW &&
                    surface.height === newH &&
                    surface._claudeVilleDpr === dpr
                ))
            ) return;
            for (const surface of canvasSurfaces) {
                surface.width = newW;
                surface.height = newH;
                surface._claudeVilleDpr = dpr;
                surface._claudeVilleCssWidth = cssWidth;
                surface._claudeVilleCssHeight = cssHeight;
                surface.style.width = `${cssWidth}px`;
                surface.style.height = `${cssHeight}px`;
            }
            // alpha:false — the sky pass paints the full viewport opaquely
            // every frame, so an opaque backing store lets the compositor
            // skip per-frame alpha blending of the whole canvas layer.
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.imageSmoothingEnabled = false;
            ctx.mozImageSmoothingEnabled = false;
            ctx.webkitImageSmoothingEnabled = false;
            const overlayCtx = overlayCanvas?.getContext?.('2d', { alpha: true });
            if (overlayCtx) {
                overlayCtx.imageSmoothingEnabled = false;
                overlayCtx.mozImageSmoothingEnabled = false;
                overlayCtx.webkitImageSmoothingEnabled = false;
            }
            this.renderer?.postFx?.resize?.(newW, newH);
            this.renderer?.gpuWorld?.resize?.(newW, newH);
            if (this.renderer?.invalidateViewportCaches) {
                this.renderer.invalidateViewportCaches();
            }
            if (this.renderer && this.renderer.camera) {
                const cam = this.renderer.camera;
                cam.onViewportResize();
                // Re-frame to the live village on relayout, unless the user has
                // taken manual control of the camera or is following an agent.
                if (!cam._userAdjusted && !cam.followTarget && typeof this.renderer.frameContent === 'function') {
                    this.renderer.frameContent();
                }
            }
        };

        // Use ResizeObserver to detect container size changes (including footer open/close)
        this._resizeObserver = new ResizeObserver(() => resize());
        this._resizeObserver.observe(container);

        this._onWindowResize = () => resize();
        window.addEventListener('resize', this._onWindowResize);

        // A DPR change without a layout change never fires `resize` — dragging
        // the window from a Retina laptop panel to a 1x external display is the
        // common case. Without this the backing store keeps the old ratio and
        // the browser rescales it by a fraction, which shreds pixel text.
        this._watchDevicePixelRatio = () => {
            this._dprQuery?.removeEventListener?.('change', this._onDevicePixelRatioChange);
            this._dprQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) || null;
            this._dprQuery?.addEventListener?.('change', this._onDevicePixelRatioChange);
        };
        this._onDevicePixelRatioChange = () => {
            this._watchDevicePixelRatio();
            resize();
        };
        this._watchDevicePixelRatio();
        this._resizeWorldCanvas = resize;
        this._bindGraphicsRecovery(canvas, resize);
        resize();
    }

    _bindGraphicsRecovery(canvas, resize) {
        if (this._onWorldContextLost) {
            canvas.removeEventListener('contextlost', this._onWorldContextLost);
            canvas.removeEventListener('contextrestored', this._onWorldContextRestored);
        }
        this._onWorldContextLost = (event) => {
            event.preventDefault?.();
            this.renderer?.handleContextLost?.();
        };
        this._onWorldContextRestored = () => {
            resize({ force: true });
            this.renderer?.handleContextRestored?.();
        };
        canvas.addEventListener('contextlost', this._onWorldContextLost, false);
        canvas.addEventListener('contextrestored', this._onWorldContextRestored, false);

        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
        }
        this._onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                this.renderer?.pauseForVisibility?.();
                return;
            }
            resize({ force: true });
            const worldVisible = this.modeManager?.getCurrentMode?.() !== 'dashboard';
            this.renderer?.resumeFromVisibility?.({ active: worldVisible });
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    _installPerfDebugHelper() {
        if (typeof window === 'undefined') return;
        const existing = window.__claudeVillePerf || {};
        this._perfDebugCanvasBudget = () => this.renderer?.getCanvasBudget?.() || null;
        this._perfDebugStartProfile = () => this.renderer?.startPerformanceProfile?.() || false;
        this._perfDebugStopProfile = () => this.renderer?.stopPerformanceProfile?.() || null;
        this._perfDebugFrameProfile = () => this.renderer?.getPerformanceProfile?.() || null;
        this._cameraSetHelper = (pose = {}) => this.renderer?.setCameraPose?.(pose) || false;
        this._clientPerfHelpers = this.clientPerfMetrics?.getDebugHelpers?.() || {};
        window.__claudeVillePerf = {
            ...existing,
            ...this._clientPerfHelpers,
            canvasBudget: this._perfDebugCanvasBudget,
            startFrameProfile: this._perfDebugStartProfile,
            stopFrameProfile: this._perfDebugStopProfile,
            frameProfile: this._perfDebugFrameProfile,
        };
        window.cameraSet = this._cameraSetHelper;
    }

    _applyI18n() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            const val = i18n.t(key);
            if (typeof val === 'string') {
                el.textContent = val;
            }
        });
    }

    _showBootError(err) {
        this._handleBootFailure(err);
    }

    destroy() {
        if (this._destroyPromise) return this._destroyPromise;
        this._destroyed = true;
        this._destroyPromise = (async () => {
            await this._cleanupOwned();
            if (this._bootState !== 'failed') this._bootState = 'destroyed';
        })();
        return this._destroyPromise;
    }

    _cleanupOwned() {
        if (this._cleanupPromise) return this._cleanupPromise;
        this._cleanupPromise = this._cleanupOwnedOnce();
        return this._cleanupPromise;
    }

    async _cleanupOwnedOnce() {
        const renderer = this.renderer;
        const store = this.chronicleStore;
        const worldCanvas = this._worldCanvas || document.getElementById('worldCanvas');
        const worldFxCanvas = document.getElementById('worldFxCanvas');
        const worldOverlayCanvas = document.getElementById('worldOverlayCanvas');

        this._bootController?.abort?.();

        if (this._chroniclePruneInterval) {
            window.clearInterval(this._chroniclePruneInterval);
            this._chroniclePruneInterval = null;
        }
        if (this._resizeHandle) {
            cancelAnimationFrame(this._resizeHandle);
            this._resizeHandle = null;
        }
        if (this._loadRendererRetryHandle) {
            cancelAnimationFrame(this._loadRendererRetryHandle);
            this._loadRendererRetryHandle = null;
        }
        this._loadRendererRetryScheduled = false;
        if (this._centerCameraHandle) {
            cancelAnimationFrame(this._centerCameraHandle);
            this._centerCameraHandle = null;
        }

        for (const unsubscribe of this._eventUnsubscribers.splice(0)) {
            unsubscribe?.();
        }
        if (this._onGlobalKeydown) {
            document.removeEventListener('keydown', this._onGlobalKeydown);
            this._onGlobalKeydown = null;
        }
        if (this._onDashboardIntent) {
            document.getElementById('btnModeDashboard')?.removeEventListener(
                'click',
                this._onDashboardIntent,
                true,
            );
            this._onDashboardIntent = null;
        }
        if (this._onDeferredModalIntent) {
            document.removeEventListener('click', this._onDeferredModalIntent, true);
            document.removeEventListener('keydown', this._onDeferredModalIntent, true);
            this._onDeferredModalIntent = null;
        }
        if (this._onDeferredInteractionClick) {
            document.removeEventListener('click', this._onDeferredInteractionClick, true);
            this._onDeferredInteractionClick = null;
        }
        if (this._onDeferredInteractionKeydown) {
            document.removeEventListener('keydown', this._onDeferredInteractionKeydown, true);
            this._onDeferredInteractionKeydown = null;
        }
        this._deferredSelectionIntent = null;
        this._readControlCleanup?.();
        this._ambientControlCleanup?.();
        if (this._onFirstRunHintDismiss) {
            document.getElementById('firstRunHintDismiss')?.removeEventListener(
                'click',
                this._onFirstRunHintDismiss,
            );
            this._onFirstRunHintDismiss = null;
        }
        if (this._onBootRetry && this._bootActionEl) {
            this._bootActionEl.removeEventListener('click', this._onBootRetry);
        }
        this._bootStatusWrap?.remove?.();
        this._bootAnnouncementEl?.remove?.();
        this._bootStatusWrap = null;
        this._bootStatusEl = null;
        this._bootAnnouncementEl = null;
        this._bootFailureEl = null;
        this._bootActionEl = null;
        this._onBootRetry = null;
        this._villageBound = false;
        this._foundationReady = false;
        this._surfacesBound = false;
        this._deferredActivityBound = false;
        this._characterAssetsBound = false;
        this._chronicleSignalsBound = false;
        this._agentFollowBound = false;
        this._deepLinkBound = false;
        this._usageRequested = false;
        this._firstRunHintRevealed = false;
        this.villageState = initialVillageState();
        resetAgentSelection();

        if (this._onWindowResize) {
            window.removeEventListener('resize', this._onWindowResize);
            this._onWindowResize = null;
        }
        if (this._dprQuery && this._onDevicePixelRatioChange) {
            this._dprQuery.removeEventListener?.('change', this._onDevicePixelRatioChange);
        }
        this._dprQuery = null;
        this._onDevicePixelRatioChange = null;
        this._watchDevicePixelRatio = null;
        this._resizeObserver?.disconnect?.();
        this._resizeObserver = null;

        if (this._worldCanvas && this._onWorldContextLost) {
            this._worldCanvas.removeEventListener('contextlost', this._onWorldContextLost);
            this._worldCanvas.removeEventListener('contextrestored', this._onWorldContextRestored);
        }
        this._onWorldContextLost = null;
        this._onWorldContextRestored = null;
        this._worldCanvas = null;

        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
            this._onVisibilityChange = null;
        }

        if (this._onPageHide) {
            window.removeEventListener('pagehide', this._onPageHide);
            this._onPageHide = null;
        }

        this._callLifecycle('SessionWatcher.stop', () => this.sessionWatcher?.stop?.());
        this._callLifecycle('AgentManager.stop', () => this.agentManager?.stop?.());
        this._callLifecycle('AgentSimulator.stop', () => this.agentSimulator?.stop?.());
        this._callLifecycle('NotificationService.destroy', () => this.notificationService?.destroy?.());
        this._callLifecycle('AttentionService.destroy', () => this.attentionService?.destroy?.());
        const chronicleStop = this._callLifecycle(
            'ChronicleLog.stop',
            () => this.chronicleLog?.stop?.(),
        );
        const spendStop = this._callLifecycle(
            'SpendLedger.stop',
            () => this.spendLedger?.stop?.(),
        );
        this._callLifecycle('ActivityPanel.destroy', () => this.activityPanel?.destroy?.());
        this._callLifecycle('DashboardRenderer.destroy', () => this.dashboardRenderer?.destroy?.());
        this._callLifecycle('ChroniclePanel.destroy', () => this.chroniclePanel?.destroy?.());
        this._callLifecycle('SessionDetailsService.clear', () => sessionDetailsService.clear());
        this._callLifecycle('ModeManager.destroy', () => this.modeManager?.destroy?.());
        this._callLifecycle('Sidebar.destroy', () => this.sidebar?.destroy?.());
        const topBarStop = this._callLifecycle('TopBar.destroy', () => this.topBar?.destroy?.());
        this._callLifecycle('Modal.destroy', () => this.modal?.destroy?.());
        this._callLifecycle('Toast.destroy', () => this.toast?.destroy?.());
        this._callLifecycle('MoodService.stop', () => this.moodService?.stop?.());

        const biographyStop = this._callLifecycle(
            'AgentBiographyService.stop',
            () => this.biographyService?.stop?.(),
        );
        const affinityStop = this._callLifecycle(
            'RelationshipAffinityService.stop',
            () => this.affinityService?.stop?.(),
        );
        const prune = this._chroniclePruneState.promise;
        const chronicleTasks = [...this._chronicleTasks];

        this._callLifecycle('IsometricRenderer.pauseForVisibility', () => renderer?.pauseForVisibility?.());
        const chronicleDrain = this._callLifecycle(
            'IsometricRenderer.drainChronicleUpdates',
            () => renderer?.drainChronicleUpdates?.(),
        );
        const trail = renderer?.trailRenderer || null;
        const trailDrain = this._callLifecycle('TrailRenderer.dispose', () => {
            if (typeof trail?.dispose === 'function') return trail.dispose();
            if (typeof trail?.drain === 'function') return trail.drain();
            return trail?.flush?.();
        });
        await this._settleLifecycleTasks([chronicleDrain, trailDrain]);
        this._callLifecycle('IsometricRenderer.hide', () => renderer?.hide?.());
        for (const canvas of [worldCanvas, worldFxCanvas, worldOverlayCanvas]) {
            if (!canvas) continue;
            canvas.width = 0;
            canvas.height = 0;
        }
        const assetsDispose = this._callLifecycle('AssetManager.dispose', () => this.assets?.dispose?.());

        const storeTasks = [
            biographyStop,
            affinityStop,
            prune,
            ...chronicleTasks,
        ].filter(task => task && typeof task.then === 'function');
        // These two tails own writes that are not represented in
        // _chronicleTasks. They must finish before IndexedDB closes.
        await Promise.allSettled(
            [chronicleStop, spendStop].filter(task => task && typeof task.then === 'function'),
        );
        await this._settleLifecycleTasks(storeTasks);
        await this._settleLifecycleTasks([topBarStop, assetsDispose]);
        this._callLifecycle('ChronicleStore.close', () => store?.close?.());

        if (typeof window !== 'undefined') {
            if (window.__chronicle === store) delete window.__chronicle;
            if (window.__claudeVilleApp === this) delete window.__claudeVilleApp;
            if (window.cameraSet === this._cameraSetHelper) delete window.cameraSet;
            // Stop before unpublishing: the collector owns a PerformanceObserver and
            // a pending-delta ring that must not outlive the app instance.
            this.clientPerfMetrics?.stop?.();
            for (const [name, fn] of Object.entries(this._clientPerfHelpers || {})) {
                if (window.__claudeVillePerf?.[name] === fn) delete window.__claudeVillePerf[name];
            }
            if (window.__claudeVillePerf?.canvasBudget === this._perfDebugCanvasBudget) {
                delete window.__claudeVillePerf.canvasBudget;
            }
            if (window.__claudeVillePerf?.startFrameProfile === this._perfDebugStartProfile) {
                delete window.__claudeVillePerf.startFrameProfile;
            }
            if (window.__claudeVillePerf?.stopFrameProfile === this._perfDebugStopProfile) {
                delete window.__claudeVillePerf.stopFrameProfile;
            }
            if (window.__claudeVillePerf?.frameProfile === this._perfDebugFrameProfile) {
                delete window.__claudeVillePerf.frameProfile;
            }
        }

        this.renderer = null;
        this.dashboardRenderer = null;
        this.activityPanel = null;
        this.assets = null;
        this.sessionWatcher = null;
        this.agentSimulator = null;
        this.notificationService = null;
        this.attentionService = null;
        this.chronicleLog = null;
        this.chroniclePanel = null;
        this.spendLedger = null;
        this.modeManager = null;
        this.sidebar = null;
        this.topBar = null;
        this.modal = null;
        this.toast = null;
        this.chronicleStore = null;
        this.auroraGate = null;
        this.biographyService = null;
        this.moodService = null;
        this.affinityService = null;
        this.agentManager = null;
        this.wsClient = null;
        this.dataSource = null;
        this.world = null;
        this.latestUsage = null;
        this._chroniclePruneState.promise = null;
        this._chronicleTasks.clear();
        this._perfDebugCanvasBudget = null;
        this._perfDebugStartProfile = null;
        this._perfDebugStopProfile = null;
        this._perfDebugFrameProfile = null;
        this._cameraSetHelper = null;
        this._resizeWorldCanvas = null;
        this._bootController = null;
        this._rendererModulePromise = null;
        this._dashboardLoadPromise = null;
        this._activityPanelLoadPromise = null;
        this._chroniclePanelLoadPromise = null;
        this._stylesheetPromises.clear();
    }

    _callLifecycle(label, callback) {
        try {
            return callback();
        } catch (err) {
            console.warn(`[App] ${label} failed:`, err?.message || err);
            return null;
        }
    }

    async _settleLifecycleTasks(tasks, timeoutMs = LIFECYCLE_DRAIN_TIMEOUT_MS) {
        const pending = tasks.filter(task => task && typeof task.then === 'function');
        if (!pending.length) return;
        let timeoutHandle = null;
        await Promise.race([
            Promise.allSettled(pending),
            new Promise(resolve => {
                timeoutHandle = window.setTimeout(resolve, timeoutMs);
            }),
        ]);
        if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
    }
}

// Boot
window.addEventListener('load', () => {
    const app = new App();
    window.__claudeVilleApp = app;
    app.boot();
});
