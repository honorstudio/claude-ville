import { resolveObservation } from '../character-mode/ObservationCertainty.js';
import { eventBus, BUILDING_EVENTS } from '../../domain/events/DomainEvent.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import { AgentBiography } from '../../domain/value-objects/AgentBiography.js';
import { sessionDetailsService } from './SessionDetailsService.js';
import { SESSION_DETAIL_PANEL_REFRESH_INTERVAL } from '../../config/constants.js';
import { BUILDING_DEFS, normalizeBuildingType } from '../../config/buildings.js';
import { dialogueShape, dialogueSourceLabel } from '../../config/dialogue.js';
import { el, replaceChildren } from './DomSafe.js';
import {
    collisionsForAgent,
    formatCdCommand,
    formatCost,
    formatElapsed,
    formatRelative,
    formatStatusElapsed,
    formatTokens,
    formatToolDetail,
    hashRows,
    redactSecrets,
    shortenHomePath,
    subscribeElapsedText,
    truncateText,
    workingSetForAgent,
} from './Formatters.js';
import { emitAgentDeselected, emitAgentSelected } from './AgentSelection.js';
import { toolCategory } from '../../domain/services/ToolIdentity.js';
import { Toast } from './Toast.js';
import {
    currentToolPresentation,
    pixelIcon,
    inspectableText,
    replaceDetailRows,
    detailFreshnessLabel,
    signalProvenance,
    modelPresentation,
    statusPresentation,
    waitReasonLabel,
    toolHistoryNodes,
    toolHistorySignature,
} from './AgentPresentation.js';
import { normalizeGitEvent } from './GitEventIdentity.js';
import { contextWindowLimitForModel } from './ModelVisualIdentity.js';
import { AvatarCanvas } from '../dashboard-mode/AvatarCanvas.js';
import { buildExecutionTree } from '../dashboard-mode/DashboardRenderer.js';
import { narrativeFeedEntries } from '../character-mode/VillageDirector.js';
import { groupTodosByPhase } from '../character-mode/TaskboardBoardModel.js';
import { buildBuildingInstrumentModel, BUILDING_INSTRUMENT_NAME_LIMIT } from './BuildingInstrumentModel.js';
import { buildCausalWaterfall, causalTimestamp } from './WorkWaterfallModel.js';
import {
    buildSpatialWorkScore,
    litScoreNode,
    workScoreCaption,
    SCORE_PLAYBACK_MS,
    WORK_SCORE_REQUEST_EVENT,
    WORK_SCORE_STATE_EVENT,
} from '../character-mode/SpatialWorkScore.js';

const PANEL_TOOL_LIMIT = 30;
const PANEL_MESSAGE_LIMIT = 12;
const PANEL_INTER_AGENT_MESSAGE_LIMIT = 5;
const PANEL_GIT_EVENT_LIMIT = 6;
const PANEL_RELATIONSHIP_LIMIT = 4;
// 4.5 — the bench shows four tiles; the rest of the observed set stays exact
// behind one overflow row.
const WORKING_SET_TILE_LIMIT = 4;
const DIRECTOR_FEED_LIMIT = 12;
const BUILDING_SIGNAL_REFRESH_INTERVAL = 5000;
const JOURNEY_BREADCRUMB_LIMIT = 5;
const BUILDING_RECENT_WORK_LIMIT = 3;
const PIN_COMPARE_LIMIT = 2;
const NARRATION_ENTRY_LIMIT = 20;
const NARRATION_RETENTION_MS = 5 * 60_000;
const PINNED_AGENTS_STORAGE_KEY = 'claudeville.pinnedAgents';
const VILLAGE_OPEN_STORAGE_KEY = 'claudeville.activityPanel.villageOpen';
const VILLAGE_DIRECTOR_EVENT = 'village:director';
const VILLAGE_BUILDING_SIGNAL_EVENT = 'village:building-signal';
const CONFIGURED_BUILDING_TYPES = new Set(BUILDING_DEFS.map(def => normalizeBuildingType(def.type)));
const BUILDING_PAYLOAD_STRING_LIMIT = 512;
const BUILDING_PAYLOAD_ARRAY_LIMIT = 3;
const BUILDING_PAYLOAD_DEPTH_LIMIT = 3;
const BUILDING_PAYLOAD_NODE_LIMIT = 64;
const BUILDING_PAYLOAD_FIELD_LIMIT = 128;
const BUILDING_PAYLOAD_CHARACTER_LIMIT = 8192;
const BUILDING_PAYLOAD_SCAN_LIMIT = 512;
const BUILDING_PAYLOAD_ENTRY_LIMIT = 64;
const PROMPT_DETAIL_MAX_LENGTH = 200;

const ROMAN_NUMERALS = Object.freeze([
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
]);

function romanNumeral(value) {
    const numerals = ROMAN_NUMERALS;
    let remaining = Math.max(1, Math.trunc(Number(value) || 1));
    let result = '';
    for (const [amount, glyph] of numerals) {
        while (remaining >= amount) {
            result += glyph;
            remaining -= amount;
        }
    }
    return result;
}

function phaseHeading(phase, index) {
    return /^[IVXLCDM]+\.\s/i.test(phase)
        ? phase
        : `${romanNumeral(index)}. ${phase}`;
}

function promptPlanTodoNode(todo) {
    const status = String(todo?.status || 'pending').replace(/[^a-z0-9_-]/g, '-');
    return el('div', {
        className: ['activity-panel__todo', `activity-panel__todo--${status}`],
    }, [
        el('span', { className: 'activity-panel__todo-status', text: todo.status }),
        el('span', { className: 'activity-panel__todo-subject', text: todo.subject }),
    ]);
}
export const BOOK_OF_LIVES_VISIBLE_CHAPTER_LIMIT = 6;
export const BOOK_OF_LIVES_CHAPTER_LIMIT = 32;
export const BOOK_OF_LIVES_MILESTONE_LIMIT = 6;
export const SECTION_ORDER = Object.freeze([
    'blocked',
    'current-tool',
    'tool-history',
    'messages',
    'cost-tokens',
    'prompt-plan',
    'execution-tree',
    'causal-waterfall',
    'working-set',
    'journey',
    'village',
    'scene-log',
    'chronicle',
    'harbor-log',
    'narration',
    'village-bonds',
]);

function safePromptDetail(agent, limit = PROMPT_DETAIL_MAX_LENGTH) {
    const source = agent?.promptDetail
        || (agent?.signalSource === 'hook' ? agent?.lastToolInput : '');
    const clean = redactSecrets(source || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (clean.length <= limit) return clean;
    return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

const BOOK_OF_LIVES_EPISODE_LABELS = Object.freeze({
    arrived: 'Arrived',
    departed: 'Departed',
    completed: 'Completed a task',
    waiting: 'Waited for you',
    resolved: 'Recovered',
    errored: 'Encountered an error',
    rate_limited: 'Paused at a rate limit',
    commit: 'Committed',
    push: 'Pushed',
});

const BOOK_OF_LIVES_NICKNAME_LABELS = Object.freeze({
    'nickname-errorsRecovered-10': 'Earned the nickname "the Debugger"',
    'nickname-commitsPushed-25': 'Earned the nickname "the Shipwright"',
    'nickname-sessionsCompleted-25': 'Earned the nickname "the Veteran"',
    'nickname-lifetimeTokens-100000000': 'Earned the nickname "the Tokensmith"',
});

function bookOfLivesDate(timestamp) {
    const at = Number(timestamp);
    if (!Number.isFinite(at) || at <= 0) return 'Unknown';
    return new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    }).format(new Date(at));
}

function bookOfLivesProject(value) {
    const project = String(value || '').trim().slice(0, 80);
    return project && project !== '_unknown' ? project : '';
}

function generatedMilestoneLabel(milestone) {
    const id = String(milestone?.id || '');
    if (id === 'first-seen') return 'Settled in the village';
    if (id === 'village-founder') return 'Founded the village';
    if (BOOK_OF_LIVES_NICKNAME_LABELS[id]) return BOOK_OF_LIVES_NICKNAME_LABELS[id];
    const match = /^(sessionsCompleted|commitsPushed|lifetimeTokens|errorsRecovered)-(\d+)$/.exec(id);
    if (!match) return '';
    const value = Number(match[2]);
    switch (match[1]) {
        case 'sessionsCompleted':
            return value === 1 ? 'First session completed' : `${value} sessions completed`;
        case 'commitsPushed':
            return value === 1 ? 'First push to the harbor' : `${value} pushes to the harbor`;
        case 'lifetimeTokens':
            return `${value >= 1e9 ? `${value / 1e9}B` : `${value / 1e6}M`} lifetime tokens`;
        case 'errorsRecovered':
            return value === 1 ? 'First error overcome' : `${value} errors overcome`;
        default:
            return '';
    }
}

/**
 * Build the bounded, prose-free presentation model for a villager's memory.
 * Episode and milestone labels are regenerated from closed identifiers; stored
 * labels, prompts, reasoning, and transcript text never enter the model.
 */
export function buildBookOfLivesViewModel(biography, { now = Date.now() } = {}) {
    const identityKey = String(biography?.identityKey || '');
    const sessionScoped = identityKey.startsWith('anonymous:') || !identityKey.startsWith('named:');
    const firstSeenAt = Number(biography?.firstSeenAt) || 0;
    const lastSeenAt = Number(biography?.lastSeenAt) || firstSeenAt;
    const episodes = (Array.isArray(biography?.extensions?.lifeEpisodes)
        ? biography.extensions.lifeEpisodes
        : [])
        .map((episode, index) => {
            const kind = String(episode?.kind || '');
            const label = BOOK_OF_LIVES_EPISODE_LABELS[kind];
            const at = Number(episode?.at) || 0;
            if (!label || at <= 0) return null;
            const project = bookOfLivesProject(episode?.project);
            return {
                kind,
                at,
                label,
                project,
                copy: project ? `${label} in ${project}` : label,
                dateLabel: bookOfLivesDate(at),
                _order: index,
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.at - b.at || a._order - b._order)
        .slice(-BOOK_OF_LIVES_CHAPTER_LIMIT)
        .map(({ _order, ...chapter }) => chapter);
    const visibleChapters = episodes.slice(-BOOK_OF_LIVES_VISIBLE_CHAPTER_LIMIT);
    const archivedChapters = episodes.slice(0, -BOOK_OF_LIVES_VISIBLE_CHAPTER_LIMIT);
    const milestones = (Array.isArray(biography?.milestones) ? biography.milestones : [])
        .map((milestone, index) => ({
            at: Number(milestone?.at) || 0,
            label: generatedMilestoneLabel(milestone),
            _order: index,
        }))
        .filter(milestone => milestone.label)
        .sort((a, b) => a.at - b.at || a._order - b._order)
        .slice(-BOOK_OF_LIVES_MILESTONE_LIMIT)
        .map(({ _order, ...milestone }) => milestone);

    return {
        sessionScoped,
        scopeLabel: sessionScoped
            ? 'This history is scoped to this session; this villager has no durable identity.'
            : 'This history follows this named villager across sessions.',
        firstSeenAt,
        firstSeenLabel: firstSeenAt ? bookOfLivesDate(firstSeenAt) : 'Not recorded',
        lastSeenAt,
        lastReturnedLabel: lastSeenAt ? (formatRelative(lastSeenAt, now) || 'just now') : 'Not recorded',
        summaryLabel: 'History is retained as a summary of generated event labels; no transcript content is stored.',
        emptyLabel: 'No life chapters have been recorded yet.',
        milestones,
        visibleChapters,
        archivedChapters,
        chapterCount: episodes.length,
    };
}

export function shouldFocusActivityPanel(selectionOrigin) {
    return selectionOrigin === 'keyboard';
}

export function shouldHandleActivityPanelEscape({ panelOpen = false, modalOpen = false, popoverOpen = false } = {}) {
    return panelOpen && !modalOpen && !popoverOpen;
}

export function resolveClose({ origin = 'panel' } = {}) {
    const eventDriven = origin === 'event' || origin === 'mode';
    return {
        emit: !eventDriven,
        stopPolling: true,
        moveFocus: origin === 'panel',
    };
}

function hasOpenPopover(documentRef = globalThis.document) {
    for (const id of ['audioMixerPanel', 'spendBreakdownPanel']) {
        const panel = documentRef?.getElementById?.(id);
        if (panel && !panel.hidden && panel.style?.display !== 'none') return true;
    }

    const popovers = documentRef?.querySelectorAll?.('[popover]') || [];
    return [...popovers].some(popover => {
        if (typeof popover.matches === 'function') {
            try {
                return popover.matches(':popover-open') === true;
            } catch {
                // Older engines do not know :popover-open; use the fallback state.
            }
        }
        return popover.hasAttribute?.('open') === true || popover.open === true;
    });
}

const BUILDING_PAYLOAD_FIELDS = new Set([
    'active',
    'activeAgents',
    'activity',
    'alert',
    'alerts',
    'count',
    'counts',
    'data',
    'detail',
    'error',
    'errorCount',
    'errored',
    'errors',
    'headline',
    'inbound',
    'incident',
    'incidents',
    'issue',
    'issues',
    'label',
    'lastWork',
    'line',
    'message',
    'name',
    'occupied',
    'path',
    'payload',
    'phase',
    'problem',
    'problems',
    'queue',
    'queueDepth',
    'queued',
    'queues',
    'recent',
    'recentWork',
    'recency',
    'recencyScore',
    'route',
    'routes',
    'score',
    'signal',
    'state',
    'status',
    'summary',
    'text',
    'tier',
    'title',
    'waiting',
    'warning',
    'warnings',
    'work',
]);

const BEHAVIOR_STATE_LABELS = Object.freeze({
    blocked: 'Blocked',
    cooldown: 'Cooling down',
    performing: 'On site',
    roaming: 'Roaming',
    traveling: 'Traveling',
    wandering: 'Wandering',
});

const BEHAVIOR_PHASE_LABELS = Object.freeze({
    coordinating: 'Coordinating',
    editing: 'Editing',
    git: 'Git work',
    'quota/resource': 'Quota check',
    reading: 'Reading',
    researching: 'Researching',
    testing: 'Testing',
    waiting: 'Waiting',
});

const AGENT_GOAL_LABELS = Object.freeze({
    'assist-parent': 'Assist parent',
    'complete-task': 'Complete task',
    'monitor-quota': 'Monitor quota',
    'recover-error': 'Recover error',
});

const PUSH_STATUS_LABELS = Object.freeze({
    cancelled: 'Push cancelled',
    canceled: 'Push cancelled',
    failed: 'Push failed',
    rejected: 'Push rejected',
});

const REASON_LABELS = Object.freeze({
    'quota/resource': 'Quota check',
    'quota-resource': 'Quota check',
});

const RELATIONSHIP_WARMTH_LABELS = Object.freeze({
    'hearth-warm': 'Hearth-warm',
    warm: 'Warm trail',
    cooling: 'Cooling trail',
    faint: 'Faint trail',
});

export function relationshipLoreLine(bond, now = Date.now()) {
    const commits = Number(bond?.sharedCommits) || 0;
    const commitLore = commits === 1 ? '1 shared commit' : `${commits} shared commits`;
    const showsWarmth = bond?.tier !== 'strangers';
    const warmthLore = showsWarmth
        ? RELATIONSHIP_WARMTH_LABELS[bond?.warmth] || 'Faint trail'
        : '';
    const ago = formatRelative(Number(bond?.lastInteractionAt), now);
    return [warmthLore, commitLore, ago ? `crossed paths ${ago}` : 'no meeting recorded']
        .filter(Boolean)
        .join(' · ');
}

export class ActivityPanel {
    constructor({ world = null, renderer = null, harborTraffic = null, biographyService = null, affinityService = null, toast = null } = {}) {
        const getterFor = (value) => (typeof value === 'function' ? value : () => value);
        this.panelEl = document.getElementById('activityPanel');
        this.closeBtn = document.getElementById('panelClose');
        this._dependencies = {
            world: getterFor(world),
            renderer: getterFor(renderer),
            harborTraffic: getterFor(harborTraffic),
            biographyService: getterFor(biographyService),
            affinityService: getterFor(affinityService),
        };
        this.currentAgent = null;
        this._narrationAgentId = null;
        this._narrationEntries = [];
        this._mode = null;
        this._heroAvatar = null;
        this._heroPortraitEl = null;
        this._selectedBuilding = null;
        this._latestUsage = null;
        this.toast = toast || new Toast();
        this._ownsToast = !toast;
        this._buildingSignalByType = new Map();
        this._villageDirectorByType = new Map();
        this._pollTimer = null;
        this._buildingPollTimer = null;
        this.dom = {
            panelAgentName: document.getElementById('panelAgentName'),
            panelAgentStatus: document.getElementById('panelAgentStatus'),
            panelModel: document.getElementById('panelModel'),
            panelProvider: document.getElementById('panelProvider'),
            panelRole: document.getElementById('panelRole'),
            panelLevel: document.getElementById('panelLevel'),
            panelTeam: document.getElementById('panelTeam'),
            panelMoodRow: document.getElementById('panelMoodRow'),
            panelMood: document.getElementById('panelMood'),
            panelLastActive: document.getElementById('panelLastActive'),
            panelModeRow: document.getElementById('panelModeRow'),
            panelMode: document.getElementById('panelMode'),
            panelCurrentTool: document.getElementById('panelCurrentTool'),
            panelToolHistory: document.getElementById('panelToolHistory'),
            panelMessages: document.getElementById('panelMessages'),
            panelContextSize: document.getElementById('panelContextSize'),
            panelContextBar: document.getElementById('panelContextBar'),
            panelTokenGrid: document.getElementById('panelTokenGrid'),
            panelNoUsage: document.getElementById('panelNoUsage'),
            panelCostRow: document.getElementById('panelCostRow'),
            panelCostLabel: document.getElementById('panelCostLabel'),
            panelInputTokens: document.getElementById('panelInputTokens'),
            panelOutputTokens: document.getElementById('panelOutputTokens'),
            panelCacheRead: document.getElementById('panelCacheRead'),
            panelCacheCreate: document.getElementById('panelCacheCreate'),
            panelCacheHit: document.getElementById('panelCacheHit'),
            panelTurnCount: document.getElementById('panelTurnCount'),
            panelEstCost: document.getElementById('panelEstCost'),
        };
        this.panelEl?.setAttribute('role', 'region');
        this.panelEl?.setAttribute('aria-labelledby', 'panelAgentName');
        this.dom.panelAgentName?.setAttribute('role', 'heading');
        this.dom.panelAgentName?.setAttribute('aria-level', '2');
        if (this.dom.panelAgentName) this.dom.panelAgentName.tabIndex = -1;
        this._statusElapsedEl = el('span', {
            className: 'activity-panel__value activity-panel__status-age',
        });
        this.dom.panelAgentStatus?.parentNode?.insertBefore(
            this._statusElapsedEl,
            this.dom.panelAgentStatus.nextSibling,
        );
        this._blockedPromptEl = el('div', {
            className: 'activity-panel__value',
        });
        this._blockedProvenanceEl = el('span', {
            className: 'activity-panel__narration-provenance',
        });
        this._blockedBannerEl = el('div', {
            className: 'activity-panel__blocked',
            style: {
                display: 'none',
            },
        }, [this._blockedPromptEl, this._blockedProvenanceEl]);
        this._elapsedUnsubscribe = subscribeElapsedText(this._statusElapsedEl, () => (
            this._mode === 'agent' && this.currentAgent
                ? resolveObservation(this.currentAgent, Date.now()).state === 'stale' ? '' : formatStatusElapsed(this.currentAgent)
                : ''
        ));
        this._toolEls = {
            icon: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-icon'),
            name: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-name'),
            input: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-input'),
        };
        this._journeySectionEl = null;
        this._journeyBodyEl = null;
        this._journeyWhyEl = null;
        this._journeyDetailsEl = null;
        this._journeyDetailsBodyEl = null;
        // 5.4 — the frozen work-score copy plus its cursor and playback timer.
        // Presentation only: nothing here is written back to an agent.
        this._workScore = null;
        this._workScoreAgentId = null;
        this._workScoreCursorAt = 0;
        this._workScorePlaying = false;
        this._workScoreTimer = null;
        this._workScoreOwnerLost = false;
        this._workScorePositions = null;
        this._harborLogSectionEl = null;
        this._harborLogBodyEl = null;
        this._chronicleSectionEl = null;
        this._chronicleBodyEl = null;
        this._chronicleFetchSeq = 0;
        this._currentBiographyIdentityKey = null;
        this._detailFetchSeq = 0;
        this._directorFeedSectionEl = null;
        this._narrationSectionEl = null;
        this._narrationBodyEl = null;
        this._directorFeedBodyEl = null;
        this._directorFeed = [];
        this._directorFeedIds = new Set();
        this._relationshipsSectionEl = null;
        this._relationshipsBodyEl = null;
        this._messageEdgesSectionEl = null;
        this._messageEdgesBodyEl = null;
        this._executionTreeSectionEl = null;
        this._executionTreeBodyEl = null;
        this._executionChildIdsByParent = new Map();
        this._causalWaterfallSectionEl = null;
        this._causalWaterfallSummaryEl = null;
        this._causalWaterfallBodyEl = null;
        this._causalWaterfallRows = [];
        this._causalWaterfallToolHistory = [];
        this._causalWaterfallElapsedUnsubscribers = [];
        this._promptPlanSectionEl = null;
        this._promptPlanTitleEl = null;
        this._promptPlanBodyEl = null;
        this._villageSectionEl = null;
        this._villageBodyEl = null;
        this._pinStripEl = null;
        this._pinToggleBtn = null;
        this._pinFetchSeq = 0;
        const rendererPinnedIds = this._getRenderer()?.getPinnedAgentIds?.() || [];
        this._pinned = new Set(rendererPinnedIds.length ? rendererPinnedIds : this._loadPinnedAgentIds());
        this._pinnedDetails = new Map();
        this._agentSections = [];
        this._viewMode = document.getElementById('dashboardMode')?.style.display === '' ? 'dashboard' : 'character';
        this._workingDirectoryRowEl = null;
        this._workingDirectoryValueEl = null;
        this._workingDirectoryCopyBtn = null;
        this._ensurePinCompare();
        this._ensureWorkingDirectoryAction();
        this._ensureVillageSection();
        this._mountExistingSections();
        this._mountSection('blocked', this._blockedBannerEl);
        this._registerAgentSection(this._blockedBannerEl);
        this._ensurePromptPlanSection();
        this._ensureExecutionTreeSection();
        this._ensureCausalWaterfallSection();
        // 4.5 — the bench section was declared in SECTION_ORDER and built by
        // _ensureWorkingSetSection, but never mounted: the working set has been
        // invisible in the panel. Mount it beside the other agent sections.
        this._ensureWorkingSetSection();
        this._ensureJourneySection();
        this._ensureNarrationSection();
        this._ensureHarborLogSection();
        this._ensureChronicleSection();
        this._ensureDirectorFeedSection();
        this._ensureRelationshipsSection();
        this._ensureMessageEdgesSection();
        // Sections that belong to agent mode and must be hidden when a building is selected.
        for (const node of this.panelEl?.querySelectorAll('.activity-panel__meta, .activity-panel__section') || []) {
            this._registerAgentSection(node);
        }
        // Building-mode content container is created on demand and inserted after the header.
        this._buildingContentEl = null;
        this._renderSignatures = this._emptyRenderSignatures();
        this._destroyed = false;
        this._selectionIntent = null;
        this._selectionTrigger = null;
        this._focusRequestVersion = 0;
        this._panelKeydownBound = false;

        this._detailFreshnessEl = el('div', { className: 'activity-panel__freshness' });
        this._detailFreshnessEl.hidden = true;
        this.panelEl.querySelector('.activity-panel__header')?.appendChild(this._detailFreshnessEl);
        this._bind();
        this._renderPinCompare();
        eventBus.emit('agents:pins-changed', {
            pinnedAgentIds: [...this._pinned].slice(0, PIN_COMPARE_LIMIT),
        });
    }

    _bind() {
        this._onCloseClick = () => this.hide();
        this._onPinToggleClick = () => {
            if (this._mode === 'agent' && this.currentAgent) {
                this._togglePinnedAgent(this.currentAgent);
            }
        };
        this._onWorkingDirectoryCopyClick = () => this._copyWorkingDirectory();
        this._onInteractionClick = (event) => {
            this._recordSelectionIntent(event.detail === 0 ? 'keyboard' : 'pointer', event.target);
        };
        this._onInteractionKeydown = (event) => {
            this._recordSelectionIntent('keyboard', event.target);
        };
        this._onPanelKeydown = (event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            const modalOpen = document.getElementById('modalOverlay')?.getAttribute('aria-hidden') === 'false';
            if (!shouldHandleActivityPanelEscape({
                panelOpen: this._mode !== null,
                modalOpen,
                popoverOpen: hasOpenPopover(document),
            })) return;
            event.preventDefault();
            event.stopPropagation();
            this.hide();
        };
        this._onAgentSelected = (agent) => {
            if (!agent) return;
            // A score belongs to one run: selecting somebody else leaves it,
            // without re-selecting the frozen subject the operator just left.
            if (this._workScore && String(agent.id || '') !== this._workScoreAgentId) {
                this._closeWorkScore({ restoreSelection: false });
            }
            if (this._viewMode === 'dashboard') {
                this.currentAgent = agent;
                return;
            }
            this.show(agent);
        };
        // 5.4 — the director answers with the resolved position provenance and
        // tells us when genuine input took the camera back; playback stops
        // there and never re-acquires the claim on a timer.
        this._onWorkScoreState = (state = {}) => {
            if (!this._workScore) return;
            if (state.counts) this._workScorePositions = state.counts;
            if (state.ownerLost) {
                this._workScoreOwnerLost = true;
                this._stopWorkScorePlayback();
            }
            this._renderWorkScoreCursor();
        };
        this._onAgentDeselected = () => {
            if (this._viewMode === 'dashboard') {
                this.currentAgent = null;
                return;
            }
            if (this._mode === 'agent' && this.currentAgent) this._close({ origin: 'event' });
        };
        this._onAgentUpdated = (agent) => {
            if (agent?.id && this._pinned.has(agent.id)) {
                this._renderPinCompare();
                this._fetchPinnedDetails();
            }
            if (this._mode === 'agent'
                && this.currentAgent
                && String(agent?.parentSessionId || '') === String(this.currentAgent.id || '')) {
                this._updateExecutionTree(this.currentAgent);
                this._updateCausalWaterfall(this.currentAgent);
            }
            if (this._mode === 'agent' && this.currentAgent && agent.id === this.currentAgent.id) {
                const nextBiographyIdentityKey = this._biographyIdentityKey(agent);
                const biographyIdentityChanged = nextBiographyIdentityKey !== this._currentBiographyIdentityKey;
                this.currentAgent = agent;
                this._renderNarration(agent);
                this._updateInfo(agent);
                this._updateCurrentTool(agent);
                this._updatePromptPlan(agent);
                this._updateExecutionTree(agent);
                this._updateCausalWaterfall(agent);
                this._updateWorkingSet(agent);
                this._updateHarborLog(agent);
                this._updateMessageEdges(agent);
                if (biographyIdentityChanged) {
                    this._currentBiographyIdentityKey = nextBiographyIdentityKey;
                    this._setChronicleState('Loading biography…');
                    this._fetchAndRenderChronicle(agent);
                }
                this._renderRelationships(agent);
                this._updatePinToggle(agent);
            }
        };
        this._onAgentRemoved = (agent) => {
            if (agent?.id && agent.id === this._narrationAgentId) this._resetNarration();
            sessionDetailsService.deleteForAgent(agent);
            if (this._mode === 'agent'
                && this.currentAgent
                && String(agent?.parentSessionId || '') === String(this.currentAgent.id || '')) {
                this._updateExecutionTree(this.currentAgent);
                this._updateCausalWaterfall(this.currentAgent);
            }
            if (this.currentAgent && agent.id === this.currentAgent.id) {
                if (this._mode === 'agent') this.hide();
                else this.currentAgent = null;
            }
            this._renderPinCompare();
        };
        this._onBuildingSelected = (building) => {
            if (building) this.showBuilding(building);
        };
        this._onBuildingDeselected = () => {
            if (this._mode === 'building') this.hide();
        };
        this._onBuildingPresence = () => {
            if (this._mode === 'building') {
                this._renderBuildingSignal();
            }
        };
        this._onBuildingSignal = (payload) => {
            this._cacheBuildingPayload(payload, this._buildingSignalByType);
            if (this._mode === 'building') {
                this._renderBuildingSignal();
            }
        };
        this._onVillageDirector = (payload) => {
            this._cacheVillageDirectorPayload(payload);
            // #47 — fold the snapshot's narrative scenes into the bounded feed
            // regardless of mode, so the chronicle ribbon carries history once
            // an agent is opened.
            this._accumulateDirectorFeed(payload);
            if (this._mode === 'agent') {
                this._renderDirectorFeed();
            }
            if (this._mode === 'building') {
                this._renderBuildingSignal();
            }
        };
        this._onUsageUpdated = (usage) => {
            this._latestUsage = usage || null;
            if (this._mode === 'building') {
                this._renderBuildingSignal();
            }
        };
        this._onMoodChanged = ({ agent } = {}) => {
            if (agent?.id && this._pinned.has(agent.id)) this._renderPinCompare();
            if (this._mode === 'agent' && this.currentAgent && agent?.id === this.currentAgent.id) {
                this.currentAgent = agent;
                this._updateInfo(agent);
            }
        };
        this._onBiographyUpdated = ({ identityKey, biography } = {}) => {
            if (this._mode !== 'agent' || !this.currentAgent) return;
            if (identityKey !== this._biographyIdentityKey(this.currentAgent)) return;
            this._renderChronicleBody(biography);
        };
        this._onAffinityChanged = ({ affinity } = {}) => {
            if (this._mode !== 'agent' || !this.currentAgent) return;
            const identityKey = this._biographyIdentityKey(this.currentAgent);
            if (!affinity || affinity.involves?.(identityKey)) this._renderRelationships(this.currentAgent);
        };
        this._onAffinityReady = ({ service } = {}) => {
            if (this._mode !== 'agent' || !this.currentAgent) return;
            if (service && service !== this._getAffinityService()) return;
            this._renderRelationships(this.currentAgent);
        };
        this._onModeChanged = (mode) => {
            this._viewMode = mode;
            if (mode === 'dashboard') {
                if (this._mode !== null) this._close({ origin: 'mode' });
                return;
            }
            if (mode === 'character' && this._mode === null && this.currentAgent) {
                this.show(this.currentAgent);
            }
        };
        // Pause polling while the tab is hidden; refresh once on return.
        this._onVisibilityChange = () => this._syncPollingForVisibility();

        this.closeBtn.addEventListener('click', this._onCloseClick);
        this._pinToggleBtn?.addEventListener('click', this._onPinToggleClick);
        this._workingDirectoryCopyBtn?.addEventListener('click', this._onWorkingDirectoryCopyClick);
        document.addEventListener('click', this._onInteractionClick, true);
        document.addEventListener('keydown', this._onInteractionKeydown, true);
        eventBus.on('agent:selected', this._onAgentSelected);
        eventBus.on('agent:deselected', this._onAgentDeselected);
        eventBus.on('agent:updated', this._onAgentUpdated);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on(BUILDING_EVENTS.SELECTED, this._onBuildingSelected);
        eventBus.on(BUILDING_EVENTS.DESELECTED, this._onBuildingDeselected);
        eventBus.on(BUILDING_EVENTS.ACTIVE_AGENTS, this._onBuildingPresence);
        eventBus.on(VILLAGE_BUILDING_SIGNAL_EVENT, this._onBuildingSignal);
        eventBus.on(VILLAGE_DIRECTOR_EVENT, this._onVillageDirector);
        eventBus.on('usage:updated', this._onUsageUpdated);
        eventBus.on('mood:changed', this._onMoodChanged);
        eventBus.on('biography:updated', this._onBiographyUpdated);
        eventBus.on('affinity:changed', this._onAffinityChanged);
        eventBus.on('affinity:ready', this._onAffinityReady);
        eventBus.on('mode:changed', this._onModeChanged);
        eventBus.on(WORK_SCORE_STATE_EVENT, this._onWorkScoreState);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    _recordSelectionIntent(origin, trigger) {
        const intent = { origin, trigger };
        this._selectionIntent = intent;
        queueMicrotask(() => {
            if (this._selectionIntent === intent) this._selectionIntent = null;
        });
    }

    _preparePanelFocus() {
        const intent = this._selectionIntent;
        const trigger = intent?.trigger || document.activeElement;
        if (trigger && trigger !== document.body && !this.panelEl?.contains(trigger)) {
            this._selectionTrigger = trigger;
        }

        const request = ++this._focusRequestVersion;
        if (!shouldFocusActivityPanel(intent?.origin)) return;
        queueMicrotask(() => {
            if (request !== this._focusRequestVersion || this._mode === null) return;
            const active = document.activeElement;
            if ((!this._selectionTrigger || this._selectionTrigger === document.body)
                && active && active !== document.body && !this.panelEl?.contains(active)) {
                this._selectionTrigger = active;
            }
            this.closeBtn?.focus({ preventScroll: true });
        });
    }

    _startPanelKeyboardHandling() {
        if (this._panelKeydownBound) return;
        this._panelKeydownBound = true;
        document.addEventListener('keydown', this._onPanelKeydown);
    }

    _stopPanelKeyboardHandling() {
        if (!this._panelKeydownBound) return;
        this._panelKeydownBound = false;
        document.removeEventListener('keydown', this._onPanelKeydown);
    }

    _restoreSelectionFocus() {
        const trigger = this._selectionTrigger;
        this._selectionTrigger = null;
        if (!trigger?.isConnected || typeof trigger.focus !== 'function') return;
        trigger.focus({ preventScroll: true });
    }

    _emptyRenderSignatures() {
        return {
            journey: '',
            toolHistory: '',
            messages: '',
            tokenUsage: '',
            harborLog: '',
            executionTree: '',
            causalWaterfall: '',
            chronicle: '',
            directorFeed: '',
            narration: '',
            relationships: '',
            messageEdges: '',
            workingSet: '',
            promptPlan: '',
            pins: '',
            buildingSignal: '',
            buildingDetail: '',
        };
    }

    _registerAgentSection(node) {
        if (!node || this._agentSections.includes(node)) return;
        this._agentSections.push(node);
    }

    _mountExistingSections() {
        for (const key of [...SECTION_ORDER].reverse()) {
            const node = this.panelEl?.querySelector(`[data-section="${key}"]`);
            if (node) this._mountSection(key, node);
        }
    }

    _mountSection(key, node) {
        const index = SECTION_ORDER.indexOf(key);
        if (!node || index < 0 || !this.panelEl) return;
        node.dataset.section = key;

        const villageIndex = SECTION_ORDER.indexOf('village');
        const insideVillage = index > villageIndex;
        const parent = insideVillage ? this._villageBodyEl : this.panelEl;
        if (!parent) return;

        const next = SECTION_ORDER.slice(index + 1)
            .map(nextKey => parent.querySelector(`[data-section="${nextKey}"]`))
            .find(candidate => candidate?.parentNode === parent);
        if (next) {
            parent.insertBefore(node, next);
            return;
        }
        parent.appendChild(node);
    }

    _ensureVillageSection() {
        if (this._villageSectionEl && this._villageBodyEl) return;
        const body = el('div', { className: 'activity-panel__village-body' });
        const details = el('details', { className: 'activity-panel__village' }, [
            el('summary', { className: 'activity-panel__village-summary', text: 'IN THE VILLAGE' }),
            body,
        ]);
        details.open = this._loadVillageOpen();
        this._onVillageToggle = () => this._persistVillageOpen();
        details.addEventListener('toggle', this._onVillageToggle);
        this._villageSectionEl = details;
        this._villageBodyEl = body;
        this._mountSection('village', details);
        this._registerAgentSection(details);
    }

    _loadPinnedAgentIds() {
        if (typeof localStorage === 'undefined') return [];
        try {
            const parsed = JSON.parse(localStorage.getItem(PINNED_AGENTS_STORAGE_KEY) || '[]');
            if (!Array.isArray(parsed)) return [];
            return parsed
                .map(id => String(id || '').trim())
                .filter(Boolean)
                .slice(0, PIN_COMPARE_LIMIT);
        } catch {
            return [];
        }
    }

    _persistPinnedAgentIds() {
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(PINNED_AGENTS_STORAGE_KEY, JSON.stringify([...this._pinned].slice(0, PIN_COMPARE_LIMIT)));
        } catch { /* ignore */ }
    }

    _loadVillageOpen() {
        if (typeof localStorage === 'undefined') return false;
        try {
            return localStorage.getItem(VILLAGE_OPEN_STORAGE_KEY) === 'true';
        } catch {
            return false;
        }
    }

    _persistVillageOpen() {
        if (typeof localStorage === 'undefined' || !this._villageSectionEl) return;
        try {
            localStorage.setItem(VILLAGE_OPEN_STORAGE_KEY, String(this._villageSectionEl.open));
        } catch { /* ignore */ }
    }

    _ensurePinCompare() {
        if (this._pinStripEl && this._pinToggleBtn) return;
        const header = this.panelEl?.querySelector('.activity-panel__header');
        if (!this._pinStripEl) {
            const strip = el('div', {
                className: 'activity-panel__pin-strip',
                style: { display: 'none' },
            });
            if (header) this.panelEl.insertBefore(strip, header);
            else this.panelEl?.appendChild(strip);
            this._pinStripEl = strip;
        }
        if (!this._pinToggleBtn && this.closeBtn?.parentNode) {
            const button = el('button', {
                className: 'activity-panel__pin-toggle',
                text: 'Pin',
                title: 'Pin agent for comparison',
                style: { display: 'none' },
            });
            button.type = 'button';
            button.setAttribute('aria-pressed', 'false');
            this.closeBtn.parentNode.insertBefore(button, this.closeBtn);
            this._pinToggleBtn = button;
        }
    }

    _ensureWorkingDirectoryAction() {
        if (this._workingDirectoryRowEl) return;
        const meta = this.panelEl?.querySelector('.activity-panel__meta');
        if (!meta) return;

        const value = el('span', { className: 'activity-panel__value' });
        const copyButton = el('button', {
            className: 'activity-panel__pin-toggle',
            text: '⧉',
            title: 'Copy cd command',
            style: {
                opacity: '0',
                transition: 'opacity 0.15s, color 0.15s, border-color 0.15s',
            },
        });
        copyButton.type = 'button';
        copyButton.setAttribute('aria-label', 'Copy working directory cd command');

        const row = el('div', {
            className: 'activity-panel__meta-row',
            style: { display: 'none', gridColumn: '1 / -1' },
        }, [
            el('span', { className: 'activity-panel__label', text: 'Workdir' }),
            value,
            copyButton,
        ]);
        const reveal = () => { copyButton.style.opacity = '1'; };
        const conceal = () => {
            if (document.activeElement !== copyButton) copyButton.style.opacity = '0';
        };
        row.addEventListener('mouseenter', reveal);
        row.addEventListener('mouseleave', conceal);
        copyButton.addEventListener('focus', reveal);
        copyButton.addEventListener('blur', conceal);

        meta.appendChild(row);
        this._workingDirectoryRowEl = row;
        this._workingDirectoryValueEl = value;
        this._workingDirectoryCopyBtn = copyButton;
    }

    _updateWorkingDirectory(agent) {
        if (!this._workingDirectoryRowEl || !this._workingDirectoryValueEl) return;
        const path = String(agent?.projectPath || '').trim();
        const command = formatCdCommand(path);
        if (!command) {
            this._workingDirectoryRowEl.style.display = 'none';
            this._workingDirectoryValueEl.textContent = '';
            this._workingDirectoryValueEl.removeAttribute('title');
            return;
        }
        this._workingDirectoryRowEl.style.display = '';
        this._workingDirectoryValueEl.textContent = shortenHomePath(path);
        this._workingDirectoryValueEl.title = path;
    }

    async _copyWorkingDirectory() {
        if (this._destroyed) return;
        const command = formatCdCommand(this.currentAgent?.projectPath);
        if (!command) return;
        try {
            await navigator.clipboard.writeText(command);
            if (this._destroyed) return;
            this.toast?.show('cd command copied to clipboard', 'success');
        } catch {
            if (this._destroyed) return;
            this.toast?.show('Could not copy cd command', 'warning');
        }
    }

    _togglePinnedAgent(agent) {
        if (!agent?.id) return;
        if (this._pinned.has(agent.id)) {
            this._pinned.delete(agent.id);
        } else {
            while (this._pinned.size >= PIN_COMPARE_LIMIT) {
                const [oldest] = this._pinned;
                this._pinned.delete(oldest);
                this._pinnedDetails.delete(oldest);
            }
            this._pinned.add(agent.id);
        }
        this._persistPinnedAgentIds();
        eventBus.emit('agents:pins-changed', {
            pinnedAgentIds: [...this._pinned].slice(0, PIN_COMPARE_LIMIT),
        });
        this._renderPinCompare();
        this._updatePinToggle(agent);
        this._fetchPinnedDetails();
    }

    _updatePinToggle(agent) {
        if (!this._pinToggleBtn) return;
        if (this._mode !== 'agent' || !agent?.id) {
            this._pinToggleBtn.style.display = 'none';
            this._pinToggleBtn.setAttribute('aria-pressed', 'false');
            return;
        }
        const pinned = this._pinned.has(agent.id);
        this._pinToggleBtn.style.display = '';
        this._pinToggleBtn.textContent = pinned ? 'Pinned' : 'Pin';
        this._pinToggleBtn.classList.toggle('activity-panel__pin-toggle--active', pinned);
        this._pinToggleBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
        this._pinToggleBtn.title = pinned
            ? 'Remove agent from comparison'
            : 'Pin agent for comparison';
    }

    async _fetchPinnedDetails() {
        if (this._destroyed) return;
        const pinnedAgents = [...this._pinned]
            .map(id => this._getWorld()?.agents?.get?.(id))
            .filter(Boolean);
        if (!pinnedAgents.length) {
            this._renderPinCompare();
            return;
        }
        const seq = ++this._pinFetchSeq;
        try {
            const details = await sessionDetailsService.fetchSessionDetailsBatch(pinnedAgents);
            if (this._destroyed || seq !== this._pinFetchSeq) return;
            for (const [agentId, detail] of details) {
                if (this._pinned.has(agentId) && detail) this._pinnedDetails.set(agentId, detail);
            }
            this._renderPinCompare();
        } catch {
            if (!this._destroyed && seq === this._pinFetchSeq) this._renderPinCompare();
        }
    }

    _renderPinCompare() {
        if (!this._pinStripEl) return;
        const ids = [...this._pinned].slice(0, PIN_COMPARE_LIMIT);
        if (!ids.length) {
            this._pinStripEl.style.display = 'none';
            replaceChildren(this._pinStripEl, []);
            this._renderSignatures.pins = '';
            return;
        }

        const world = this._getWorld();
        const rows = ids.map(id => {
            const agent = world?.agents?.get?.(id) || null;
            const detail = this._pinnedDetails.get(id) || null;
            const tool = currentToolPresentation(agent);
            const status = agent ? statusPresentation(agent.status) : null;
            const tokenUsage = this._tokenUsageForPin(agent, detail);
            const maxContext = tokenUsage.contextWindowMax || contextWindowLimitForModel(agent?.model, agent?.provider);
            const contextPct = maxContext ? Math.min(100, (tokenUsage.contextWindow / maxContext) * 100) : 0;
            const suppliedCost = agent?.cost;
            const cost = suppliedCost && (suppliedCost.usd === null || Number.isFinite(Number(suppliedCost.usd)))
                ? suppliedCost
                : agent
                    ? {
                        ...TokenUsage.estimateCost(tokenUsage, agent.model, agent.provider),
                        source: 'estimate',
                        rateRevision: TokenUsage.rateRevision,
                    }
                    : { usd: 0, source: 'estimate', rateMatch: null, unknownModel: false };
            return {
                id,
                agent,
                status,
                tool,
                contextPct,
                cost,
            };
        });

        const signature = hashRows(rows, [
            row => row.id,
            row => row.agent?.name || '',
            row => row.agent?.status || '',
            row => row.tool?.icon || '',
            row => row.tool?.name || '',
            row => Math.round(row.contextPct),
            row => Number(row.cost.usd).toFixed(6),
            row => row.cost.source || 'estimate',
            row => row.cost.unknownModel,
        ]);
        this._pinStripEl.style.display = '';
        if (signature === this._renderSignatures.pins) return;
        this._renderSignatures.pins = signature;
        replaceChildren(this._pinStripEl, rows.map(row => this._pinCell(row)));
    }

    _tokenUsageForPin(agent, detail) {
        return TokenUsage.normalize(
            detail?.tokenUsage
            || detail?.tokens
            || detail?.usage
            || agent?.tokens
            || null
        );
    }

    _pinCell(row) {
        if (!row.agent) {
            return el('div', {
                className: ['activity-panel__pin-cell', 'activity-panel__pin-cell--missing'],
                title: 'Pinned agent is not loaded',
            }, [
                el('span', { className: 'activity-panel__pin-dot' }),
                el('span', { className: 'activity-panel__pin-name', text: '-' }),
                el('span', { className: 'activity-panel__pin-tool', text: '-' }),
            ]);
        }
        const name = truncateText(row.agent.displayName || row.agent.name || row.id, 8);
        const pct = Math.max(0, Math.min(100, row.contextPct));
        const statusColor = row.status?.color || '#8b8b9e';
        const estimated = row.cost.source !== 'provider';
        return el('div', {
            className: 'activity-panel__pin-cell',
            title: row.agent.name || row.id,
        }, [
            el('span', {
                className: 'activity-panel__pin-dot',
                style: { background: statusColor, boxShadow: `0 0 5px ${statusColor}` },
            }),
            el('span', { className: 'activity-panel__pin-name', text: name }),
            el('span', { className: 'activity-panel__pin-tool', text: row.tool?.icon || '-' }),
            el('span', {
                className: 'activity-panel__pin-cost',
                title: estimated
                    ? `Estimated using ${row.cost.rateMatch || 'default'} rates, revision ${row.cost.rateRevision || TokenUsage.rateRevision}`
                    : 'Provider-reported cost',
            }, [
                row.cost.usd == null ? 'Cost unavailable' : `${estimated ? '~' : ''}${formatCost(row.cost.usd)}${row.cost.availability === 'partial' ? ' · partial' : ''}`,
                row.cost.unknownModel ? ' ' : null,
                row.cost.unknownModel ? el('span', { className: 'activity-panel__cost-source', text: 'default rate' }) : null,
            ]),
            el('span', { className: 'activity-panel__pin-context' }, [
                el('span', {
                    className: 'activity-panel__pin-context-fill',
                    style: { width: `${pct}%` },
                }),
            ]),
        ]);
    }

    show(agent) {
        if (this._destroyed) return;
        if (this._viewMode === 'dashboard') {
            this.currentAgent = agent;
            return;
        }
        this._preparePanelFocus();
        const agentId = agent?.id ?? null;
        if (agentId !== this._narrationAgentId) this._resetNarration(agentId);
        this._detailFetchSeq++;
        this._chronicleFetchSeq++;
        // Agent selection takes over the panel: tear down any building view first.
        if (this._mode === 'building') {
            this._stopBuildingPolling();
            this._teardownBuildingView();
        }
        this._mode = 'agent';
        this.currentAgent = agent;
        this._causalWaterfallToolHistory = [];
        this._currentBiographyIdentityKey = this._biographyIdentityKey(agent);
        this._renderSignatures = this._emptyRenderSignatures();
        this._setDetailState('Loading activity…', 'Loading usage…');
        if (this._detailFreshnessEl) this._detailFreshnessEl.hidden = true;
        this._setChronicleState('Loading biography…');
        this._showAgentSections();
        this._ingestNarration(agent);
        this._renderNarration(agent);
        this.panelEl.style.display = '';
        this.panelEl.scrollTop = 0;
        document.body.classList.add('cv-panel-open');
        this._startPanelKeyboardHandling();
        this._mountHeroPortrait(agent);
        this._updateInfo(agent);
        this._updateCurrentTool(agent);
        this._updatePromptPlan(agent);
        this._updateExecutionTree(agent);
        this._updateCausalWaterfall(agent);
        this._updateWorkingSet(agent);
        this._updateJourney(agent);
        this._updateHarborLog(agent);
        this._updateMessageEdges(agent);
        this._fetchAndRenderChronicle(agent);
        this._renderDirectorFeed();
        this._renderRelationships(agent);
        this._updatePinToggle(agent);
        this._renderPinCompare();
        this._fetchPinnedDetails();
        this._startPolling();
    }

    showBuilding(building) {
        if (this._destroyed) return;
        this._preparePanelFocus();
        this._detailFetchSeq++;
        this._chronicleFetchSeq++;
        // Building selection overrides agent selection. Close any agent state first.
        this._resetNarration();
        if (this._mode === 'agent') {
            this._stopPolling();
            this.currentAgent = null;
            this._currentBiographyIdentityKey = null;
            // Notify renderer/sidebar/dashboard so highlight clears.
            emitAgentDeselected();
        }
        this._teardownHeroPortrait();
        this._mode = 'building';
        this._selectedBuilding = building;
        this._updateBlockedBanner(null);
        this._renderSignatures.buildingSignal = '';
        this._renderSignatures.buildingDetail = '';
        this._hideAgentSections();
        this._updatePinToggle(null);
        this._updateWorkingDirectory(null);
        this._renderPinCompare();
        this._ensureBuildingContentEl();
        this.panelEl.style.display = '';
        document.body.classList.add('cv-panel-open');
        this._startPanelKeyboardHandling();
        this._renderBuildingView();
        this._startBuildingPolling();
    }

    _close({ origin = 'panel' } = {}) {
        if (this._destroyed) return;
        const wasAgent = this._mode === 'agent';
        const wasBuilding = this._mode === 'building';
        const keepCurrentAgent = origin === 'mode' && wasAgent;
        const retainedAgent = keepCurrentAgent ? this.currentAgent : null;
        const { emit, stopPolling, moveFocus } = resolveClose({ origin });
        this._detailFetchSeq++;
        if (!keepCurrentAgent) this._resetNarration();
        this._chronicleFetchSeq++;
        this._pinFetchSeq++;
        this._focusRequestVersion++;
        this._stopPanelKeyboardHandling();
        // Closing the panel leaves the score: the badge must never outlive the
        // surface that owns its cursor.
        this._closeWorkScore({ restoreSelection: false });
        this.panelEl.style.display = 'none';
        document.body.classList.remove('cv-panel-open');
        this._teardownHeroPortrait();
        this.currentAgent = retainedAgent;
        this._currentBiographyIdentityKey = keepCurrentAgent
            ? this._biographyIdentityKey(retainedAgent)
            : null;
        this._renderSignatures = this._emptyRenderSignatures();
        this._updatePinToggle(retainedAgent);
        this._updateWorkingDirectory(retainedAgent);
        if (stopPolling) {
            this._stopPolling();
            this._stopBuildingPolling();
        }
        if (wasBuilding) this._teardownBuildingView();
        this._mode = null;
        if (wasAgent && emit) emitAgentDeselected();
        if (moveFocus) {
            this._restoreSelectionFocus();
        } else {
            this._selectionTrigger = null;
        }
    }

    hide() {
        this._close({ origin: 'panel' });
    }

    _updateInfo(agent) {
        const statusInfo = statusPresentation(agent.status);
        this._refreshHeroPortrait(agent, statusInfo);
        this.dom.panelAgentName.textContent = agent.name;
        const statusEl = this.dom.panelAgentStatus;
        // When the adapter knows why an agent is blocked, that is the headline.
        const reason = waitReasonLabel(agent);
        const observation = resolveObservation(agent, Date.now());
        statusEl.textContent = observation.state === 'stale'
            ? observation.ageMs === null ? 'Last observed time unknown' : `Last observed ${Math.floor(observation.ageMs / 1000)}s ago`
            : (reason || statusInfo.label).toUpperCase();
        statusEl.style.color = statusInfo.color;
        statusEl.title = reason ? statusInfo.label : '';
        this._updateBlockedBanner(agent, reason);

        const model = modelPresentation(agent);
        this.dom.panelModel.textContent = model.label;
        this.dom.panelModel.style.color = model.color;
        this.dom.panelModel.title = model.title;
        this.dom.panelProvider.textContent = agent.provider || 'claude';
        this.dom.panelRole.textContent = agent.role || 'general';
        this.dom.panelLevel.textContent = this._formatAgentLevel(model.identity);
        this.dom.panelLevel.style.color = model.identity.accent?.[1] || model.identity.accent?.[0] || '';
        this.dom.panelTeam.textContent = agent.teamName || '-';
        const moodLabel = this._formatMood(agent.mood);
        this.dom.panelMood.textContent = moodLabel;
        if (this.dom.panelMoodRow) {
            this.dom.panelMoodRow.style.display = moodLabel === '-' ? 'none' : '';
        }
        this.dom.panelLastActive.textContent = this._formatLastActive(agent);
        this._updateWorkingDirectory(agent);
        const modeLabel = this._formatPermissionMode(agent.permissionMode);
        if (modeLabel) {
            this.dom.panelModeRow.style.display = '';
            this.dom.panelMode.textContent = modeLabel;
            this.dom.panelMode.className = [
                'activity-panel__value',
                'activity-panel__mode-chip',
                `activity-panel__mode-chip--${modeLabel.toLowerCase()}`,
            ].join(' ');
        } else {
            this.dom.panelModeRow.style.display = 'none';
            this.dom.panelMode.textContent = '';
            this.dom.panelMode.className = 'activity-panel__value';
        }
    }

    _updateBlockedBanner(agent, reason = waitReasonLabel(agent)) {
        if (!this._blockedBannerEl) return;
        if (!agent || !reason) {
            this._blockedBannerEl.style.display = 'none';
            this._blockedPromptEl.textContent = '';
            this._blockedProvenanceEl.textContent = '';
            return;
        }
        const tool = agent.pendingTool || agent.currentTool || agent.lastTool || '';
        const detail = safePromptDetail(agent);
        const prompt = [tool ? `${tool} ${String(reason).toLowerCase()}` : reason, safePromptDetail(agent, Infinity)].filter(Boolean).join(' · ');
        replaceDetailRows(this._blockedPromptEl, [inspectableText(prompt, { summary: detail || reason, key: 'blocked-request' })]);
        this._blockedProvenanceEl.textContent = signalProvenance(agent);
        this._blockedBannerEl.style.color = statusPresentation(agent.status).color;
        this._blockedBannerEl.style.display = 'flex';
    }

    // ─── Hero portrait (#46, portrait crop 2.6) ─────────
    // A 96×96 integer-scaled pixel avatar in the panel header, framed by an
    // effort-aura color and a status-tinted ground. Created on open, destroyed
    // on close, so only the watched villager ever holds a canvas. When the
    // hero niche shows a head-and-shoulders portrait, a small full-body
    // witness joins the name row so held weapons and effort crowns stay
    // visible.

    _mountHeroPortrait(agent) {
        const info = this.panelEl?.querySelector('.activity-panel__agent-info');
        if (!info) return;
        this._teardownHeroPortrait();
        const frame = el('div', { className: 'activity-panel__hero-portrait' });
        this._heroAvatar = new AvatarCanvas(agent, 'hero');
        frame.appendChild(this._heroAvatar.canvas);
        // Sit the portrait ahead of the name/status text.
        info.insertBefore(frame, info.firstChild);
        this._heroPortraitEl = frame;
        this._syncHeroWitness(agent);
    }

    _refreshHeroPortrait(agent, statusInfo = statusPresentation(agent.status)) {
        if (!this._heroAvatar || !this._heroPortraitEl) return;
        // AvatarCanvas tracks the same agent reference; draw() repaints only
        // when the identity signature changed, and restyle the aura/status
        // frame.
        this._heroAvatar.agent = agent;
        this._heroAvatar.draw();
        const aura = this._heroAvatar.auraColor();
        this._heroPortraitEl.style.setProperty('--cv-hero-aura', aura);
        this._heroPortraitEl.className =
            `activity-panel__hero-portrait activity-panel__hero-portrait--${statusInfo.status}`;
        this._syncHeroWitness(agent);
    }

    // The witness exists only while the hero is a portrait; a full-body hero
    // is already its own witness. Portrait availability can arrive with the
    // sheet or the manifest, so this is re-checked on every refresh.
    _syncHeroWitness(agent) {
        const wanted = Boolean(this._heroAvatar?.isPortrait());
        if (!wanted) {
            this._teardownHeroWitness();
            return;
        }
        if (this._witnessAvatar) {
            this._witnessAvatar.agent = agent;
            this._witnessAvatar.draw();
            return;
        }
        const nameRow = this.panelEl?.querySelector('.activity-panel__name-row');
        if (!nameRow) return;
        const frame = el('span', { className: 'activity-panel__witness' });
        this._witnessAvatar = new AvatarCanvas(agent, 'witness');
        this._witnessAvatar.canvas.setAttribute('role', 'img');
        this._witnessAvatar.canvas.setAttribute('aria-label', 'Full body');
        frame.appendChild(this._witnessAvatar.canvas);
        nameRow.insertBefore(frame, nameRow.firstChild);
        this._witnessEl = frame;
    }

    _teardownHeroWitness() {
        if (this._witnessAvatar) {
            this._witnessAvatar.destroy();
            this._witnessAvatar = null;
        }
        if (this._witnessEl) {
            this._witnessEl.remove();
            this._witnessEl = null;
        }
    }

    _teardownHeroPortrait() {
        this._teardownHeroWitness();
        if (this._heroAvatar) {
            this._heroAvatar.destroy();
            this._heroAvatar = null;
        }
        if (this._heroPortraitEl) {
            this._heroPortraitEl.remove();
            this._heroPortraitEl = null;
        }
    }

    _formatAgentLevel(identity) {
        const tier = identity?.effortTier;
        if (!tier || tier === 'none') return '-';
        return {
            low: 'Low',
            medium: 'Medium',
            high: 'High',
            xhigh: 'Extra High',
            max: 'Max',
            ultra: 'Ultra',
        }[tier] || tier;
    }

    _formatMood(mood) {
        const type = String(mood?.type || '').trim();
        if (!type || type === 'neutral') return '-';
        return this._titleize(type);
    }

    _formatLastActive(agent) {
        const age = Number(agent?.activityAgeMs);
        const ts = Number.isFinite(age)
            ? Date.now() - Math.max(0, age)
            : Number(agent?.lastSessionActivity || 0);
        return formatRelative(ts) || '-';
    }

    _formatPermissionMode(mode) {
        const text = String(mode || '').trim();
        if (!text) return '';
        return text.toLowerCase().includes('plan') ? 'PLAN' : 'ACT';
    }

    _updateCurrentTool(agent) {
        const container = this.dom.panelCurrentTool;
        const iconEl = this._toolEls.icon;
        const nameEl = this._toolEls.name;
        const inputEl = this._toolEls.input;
        const tool = currentToolPresentation(agent);

        container.closest('[data-section]')?.style.setProperty('display', tool.isIdle ? 'none' : '');
        container.classList.toggle('activity-panel__current-tool--idle', tool.isIdle);
        iconEl.replaceChildren(pixelIcon(toolCategory(agent.currentTool)));
        nameEl.textContent = tool.name;
        replaceDetailRows(inputEl, tool.detail ? [inspectableText(tool.detail, { summary: formatToolDetail(tool.detail, { max: 45 }), key: 'current-tool' })] : []);
    }

    _ensureExecutionTreeSection() {
        if (this._executionTreeSectionEl && this._executionTreeBodyEl) return;
        const body = el('div', { className: 'activity-panel__execution-tree' });
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Execution tree' }),
            body,
        ]);
        this._mountSection('execution-tree', section);
        this._executionTreeSectionEl = section;
        this._executionTreeBodyEl = body;
        this._registerAgentSection(section);
    }

    _executionTreeNode(node) {
        if (!node || typeof node !== 'object') return null;
        const kind = String(node.kind || node.type || 'node')
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-');
        if (kind === 'task') {
            return el('div', {
                className: ['activity-panel__execution-node', 'activity-panel__execution-node--task'],
            }, [
                el('span', {
                    className: `activity-panel__execution-status activity-panel__execution-status--${String(node.status || 'unknown')}`,
                    text: String(node.status || 'unknown').toUpperCase(),
                }),
                el('span', {
                    className: 'activity-panel__execution-label',
                    text: String(node.subject || node.label || 'Untitled task'),
                }),
            ]);
        }

        const children = Array.isArray(node.children)
            ? node.children.map(child => this._executionTreeNode(child)).filter(Boolean)
            : [];
        const label = String(node.label || node.name || node.id || 'Execution node');
        const status = kind === 'subagent' ? String(node.status || 'unknown') : '';
        const heading = kind === 'workflow'
            ? `WORKFLOW · ${label}`
            : `${status ? `${status.toUpperCase()} · ` : ''}${label}`;
        return el('div', {
            className: [
                'activity-panel__execution-node',
                `activity-panel__execution-node--${kind || 'node'}`,
            ],
        }, [
            el('div', { className: 'activity-panel__execution-heading', text: heading }),
            children.length
                ? el('div', { className: 'activity-panel__execution-children' }, children)
                : null,
        ]);
    }

    _updateExecutionTree(agent) {
        if (!this._executionTreeSectionEl || !this._executionTreeBodyEl || !agent) return;
        const parentId = String(agent.id || '');
        if (!parentId) return;
        const worldAgents = this._getWorld()?.agents;
        const agents = [...worldAgents?.values?.() || []];
        const previousChildIds = this._executionChildIdsByParent.get(parentId) || [];
        const tree = buildExecutionTree(agent, agents, { previousChildIds });
        const currentChildIds = agents
            .filter(child => String(child?.parentSessionId || '') === parentId)
            .map((child, index) => String(child?.id ?? child?.sessionId ?? child?.agentId ?? `child-${index}`));
        this._executionChildIdsByParent.set(parentId, currentChildIds);

        if (!tree.hasChildren) {
            this._executionTreeSectionEl.style.display = 'none';
            this._renderSignatures.executionTree = '';
            replaceChildren(this._executionTreeBodyEl, []);
            return;
        }

        const signature = JSON.stringify(tree);
        this._executionTreeSectionEl.style.display = '';
        if (signature === this._renderSignatures.executionTree) return;
        this._renderSignatures.executionTree = signature;
        const progress = tree.progress || { done: 0, total: 0, source: 'inferred', unknown: 0 };
        const source = progress.source === 'exact' ? 'EXACT' : 'INFERRED';
        const unknown = Number(progress.unknown) || 0;
        const provenanceTitle = progress.source === 'exact'
            ? 'Progress from the Claude task store'
            : unknown
                ? `${unknown} child${unknown === 1 ? '' : 'ren'} unknown; disappeared children are not counted as done`
                : 'Progress inferred from observed child sessions';
        const summary = el('div', { className: 'activity-panel__execution-summary' }, [
            el('span', {
                className: 'activity-panel__execution-progress',
                text: `${Number(progress.done) || 0}/${Number(progress.total) || 0} children done`,
            }),
            el('span', {
                className: [
                    'activity-panel__execution-provenance',
                    `activity-panel__execution-provenance--${progress.source === 'exact' ? 'exact' : 'inferred'}`,
                ],
                text: source,
                title: provenanceTitle,
            }),
        ]);
        const nodes = tree.kind === 'counts'
            ? []
            : tree.children.map(child => this._executionTreeNode(child)).filter(Boolean);
        replaceChildren(this._executionTreeBodyEl, [summary, ...nodes]);
    }

    _ensureCausalWaterfallSection() {
        if (this._causalWaterfallSectionEl && this._causalWaterfallBodyEl) return;
        const summary = el('summary', {
            className: 'activity-panel__waterfall-summary',
            text: 'CAUSAL WATERFALL',
        });
        const body = el('div', { className: 'activity-panel__waterfall-body' });
        const section = el('details', {
            className: [
                'activity-panel__section',
                'activity-panel__waterfall-details',
            ],
            style: { display: 'none' },
        }, [summary, body]);
        section.open = false;
        this._mountSection('causal-waterfall', section);
        this._causalWaterfallSectionEl = section;
        this._causalWaterfallSummaryEl = summary;
        this._causalWaterfallBodyEl = body;
        this._registerAgentSection(section);
    }

    _causalWaterfallChildren(agent) {
        const parentId = String(agent?.id || '');
        if (!parentId) return [];
        const worldAgents = this._getWorld()?.agents;
        return [...worldAgents?.values?.() || []]
            .filter(child => (
                child
                && String(child.id || '') !== parentId
                && String(child.parentSessionId || '') === parentId
            ));
    }

    _clearCausalWaterfallSubscriptions() {
        for (const unsubscribe of this._causalWaterfallElapsedUnsubscribers) {
            unsubscribe?.();
        }
        this._causalWaterfallElapsedUnsubscribers = [];
    }

    _causalWaterfallSignature(rows) {
        return JSON.stringify(rows.map(row => [
            row.id,
            row.kind,
            row.at,
            row.ongoing ? '' : row.endAt,
            row.ongoing ? '' : row.durationMs,
            row.ongoing,
            row.label,
            row.toolExitCode ?? '',
            row.provenance,
            row.childId || '',
        ]));
    }

    _causalWaterfallDuration(row, now = Date.now()) {
        const current = causalTimestamp(now) || Date.now();
        return row?.ongoing
            ? Math.max(0, current - Number(row.at || current))
            : Math.max(0, Number(row?.durationMs) || 0);
    }

    _causalWaterfallRow(row) {
        const provenance = row.provenance === 'exact' ? 'exact' : 'inferred';
        const durationEl = el('span', {
            className: 'activity-panel__waterfall-duration',
            text: formatElapsed(this._causalWaterfallDuration(row)),
        });
        if (row.ongoing) {
            this._causalWaterfallElapsedUnsubscribers.push(
                subscribeElapsedText(durationEl, now => (
                    formatElapsed(this._causalWaterfallDuration(row, now))
                )),
            );
        }
        const provenanceEl = el('span', {
            className: [
                'activity-panel__execution-provenance',
                `activity-panel__execution-provenance--${provenance}`,
            ],
            text: provenance.toUpperCase(),
            title: row.derived
                ? 'Elapsed time inferred from adjacent session timestamps'
                : 'Timing reported by the provider',
        });
        const bar = el('span', {
            className: [
                'activity-panel__waterfall-bar',
                `activity-panel__waterfall-bar--${row.kind}`,
            ],
            style: { width: `${Math.max(row.widthPercent || 0, 1)}%` },
        });
        const track = el('span', {
            className: 'activity-panel__waterfall-track',
        }, [bar]);
        const exit = Number.isFinite(Number(row.toolExitCode))
            ? el('span', {
                className: 'activity-panel__waterfall-exit',
                text: `exit ${Number(row.toolExitCode)}`,
            })
            : null;
        const heading = el('div', {
            className: 'activity-panel__waterfall-heading',
        }, [
            el('span', {
                className: 'activity-panel__waterfall-label',
                text: row.label,
            }),
            el('span', {
                className: 'activity-panel__waterfall-detail',
                text: row.detail,
            }),
            provenanceEl,
            exit,
            durationEl,
        ]);
        return el('div', {
            className: [
                'activity-panel__waterfall-row',
                `activity-panel__waterfall-row--${row.kind}`,
            ],
            title: `${row.label} · ${formatRelative(row.at) || 'just now'}`,
        }, [heading, track]);
    }

    _updateCausalWaterfall(agent, now = Date.now()) {
        if (!this._causalWaterfallSectionEl || !this._causalWaterfallBodyEl) return;
        if (this._mode !== 'agent' || !agent) {
            this._causalWaterfallSectionEl.style.display = 'none';
            this._renderSignatures.causalWaterfall = '';
            this._causalWaterfallRows = [];
            this._clearCausalWaterfallSubscriptions();
            if (this._causalWaterfallBodyEl.childNodes.length) {
                replaceChildren(this._causalWaterfallBodyEl, []);
            }
            return;
        }

        const rows = buildCausalWaterfall(agent, {
            now,
            toolHistory: this._causalWaterfallToolHistory.length
                ? this._causalWaterfallToolHistory
                : undefined,
            children: this._causalWaterfallChildren(agent),
        });
        if (!rows.length) {
            this._causalWaterfallSectionEl.style.display = 'none';
            this._renderSignatures.causalWaterfall = '';
            this._causalWaterfallRows = [];
            this._clearCausalWaterfallSubscriptions();
            if (this._causalWaterfallBodyEl.childNodes.length) {
                replaceChildren(this._causalWaterfallBodyEl, []);
            }
            return;
        }

        this._causalWaterfallSectionEl.style.display = '';
        this._causalWaterfallRows = rows;
        const signature = this._causalWaterfallSignature(rows);
        if (signature === this._renderSignatures.causalWaterfall) return;
        this._renderSignatures.causalWaterfall = signature;
        this._causalWaterfallSummaryEl.textContent =
            `CAUSAL WATERFALL · ${rows.length} EVENT${rows.length === 1 ? '' : 'S'}`;
        this._clearCausalWaterfallSubscriptions();
        replaceChildren(this._causalWaterfallBodyEl, rows.map(row => this._causalWaterfallRow(row)));
    }

    _ensurePromptPlanSection() {
        if (this._promptPlanSectionEl && this._promptPlanBodyEl) return;
        const title = el('div', { className: 'activity-panel__section-title', text: 'Prompt & Plan' });
        const body = el('div', { className: 'activity-panel__prompt-plan' });
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [title, body]);
        this._mountSection('prompt-plan', section);
        this._promptPlanSectionEl = section;
        this._promptPlanTitleEl = title;
        this._promptPlanBodyEl = body;
        this._registerAgentSection(section);
    }

    _updatePromptPlan(agent) {
        if (!this._promptPlanSectionEl || !this._promptPlanTitleEl || !this._promptPlanBodyEl) return;
        const prompt = truncateText(String(agent?.lastPrompt || '').trim(), PROMPT_DETAIL_MAX_LENGTH);
        const todos = (Array.isArray(agent?.todos) ? agent.todos : [])
            .slice(0, 64)
            .flatMap((todo) => {
                const subject = String(todo?.subject || '').trim();
                if (!subject) return [];
                return [{
                    subject: truncateText(subject, 120),
                    status: String(todo?.status || 'pending').trim().toLowerCase(),
                    phase: typeof todo?.phase === 'string' && todo.phase.trim()
                        ? truncateText(todo.phase.trim(), 80)
                        : null,
                }];
            });
        if (!prompt && !todos.length) {
            this._promptPlanSectionEl.style.display = 'none';
            this._promptPlanTitleEl.textContent = 'Prompt & Plan';
            this._renderSignatures.promptPlan = '';
            replaceChildren(this._promptPlanBodyEl, []);
            return;
        }

        const done = todos.filter(todo => todo.status === 'completed').length;
        const signature = `${prompt}|${todos.map(todo => `${todo.phase}:${todo.status}:${todo.subject}`).join('|')}`;
        this._promptPlanSectionEl.style.display = '';
        this._promptPlanTitleEl.textContent = todos.length
            ? `Prompt & Plan · ${done}/${todos.length}`
            : 'Prompt & Plan';
        if (signature === this._renderSignatures.promptPlan) return;
        this._renderSignatures.promptPlan = signature;

        const nodes = [];
        if (prompt) {
            nodes.push(el('div', { className: 'activity-panel__prompt', text: prompt }));
        }
        if (todos.length) {
            const groups = groupTodosByPhase(todos);
            const hasNamedPhase = groups.some(group => group.phase !== null);
            if (!hasNamedPhase) {
                nodes.push(el('div', { className: 'activity-panel__todo-list' }, todos.map(promptPlanTodoNode)));
            } else {
                let activeIndex = groups.findIndex(group => group.done < group.total);
                if (activeIndex < 0) activeIndex = groups.length - 1;
                let phaseNumber = 0;
                const groupNodes = groups.map((group, index) => {
                    if (group.phase === null) {
                        return index === activeIndex
                            ? el('div', { className: 'activity-panel__todo-list' }, group.items.map(promptPlanTodoNode))
                            : null;
                    }
                    phaseNumber += 1;
                    const details = el('details', { className: 'activity-panel__todo-phase' }, [
                        el('summary', {
                            className: 'activity-panel__todo-phase-summary',
                            text: `${phaseHeading(group.phase, phaseNumber)} · ${group.done}/${group.total}`,
                        }),
                        el('div', {
                            className: ['activity-panel__todo-list', 'activity-panel__todo-phase-items'],
                        }, group.items.map(promptPlanTodoNode)),
                    ]);
                    details.open = index === activeIndex;
                    return details;
                });
                nodes.push(el('div', { className: 'activity-panel__todo-groups' }, groupNodes));
            }
        }
        replaceChildren(this._promptPlanBodyEl, nodes);
    }

    _ensureWorkingSetSection() {
        if (this._workingSetSectionEl && this._workingSetBodyEl) return;
        const body = el('div', { className: 'activity-panel__token-usage' });
        const section = el('div', { className: 'activity-panel__section' }, [
            el('div', { className: 'activity-panel__section-title', text: 'Working set' }),
            body,
        ]);
        this._mountSection('working-set', section);
        this._workingSetSectionEl = section;
        this._workingSetBodyEl = body;
        this._registerAgentSection(section);
    }

    // 4.5 — the working-set bench. At most four stepped file tiles, each with
    // its operation mark, a relative path, and the full path in a native
    // disclosure; every remaining observed path lives behind one `+N files`
    // row. An overlap is named on the tile of the path it actually affects and
    // is called an overlap, never a conflict: it is observation evidence.
    _updateWorkingSet(agent) {
        if (!this._workingSetSectionEl || !this._workingSetBodyEl) return;
        const workingSet = workingSetForAgent(agent);
        const collisions = collisionsForAgent(agent);
        const signature = JSON.stringify([workingSet, collisions]);
        if (signature === this._renderSignatures.workingSet) return;
        this._renderSignatures.workingSet = signature;

        if (!workingSet.length) {
            replaceChildren(this._workingSetBodyEl, [this._emptyState('no file activity recorded')]);
            return;
        }

        const overlapByPath = new Map();
        for (const collision of collisions) {
            const path = typeof collision?.path === 'string' ? collision.path : '';
            if (path && !overlapByPath.has(path)) overlapByPath.set(path, collision);
        }

        const entries = [];
        const byPath = new Map();
        for (const item of workingSet) {
            const path = typeof item?.path === 'string' ? item.path : '';
            if (!path) continue;
            const known = byPath.get(path);
            if (known) {
                if (item.op === 'write') known.op = 'write';
                continue;
            }
            const entry = {
                path,
                op: item.op === 'write' ? 'write' : 'read',
                overlap: overlapByPath.get(path) || null,
            };
            byPath.set(path, entry);
            entries.push(entry);
        }
        // Provider recency order, except that a path someone else is also on is
        // the reason to look at the bench at all, so those tiles come first.
        const ordered = entries
            .map((entry, index) => ({ entry, index }))
            .sort((a, b) => (Number(Boolean(b.entry.overlap)) - Number(Boolean(a.entry.overlap)))
                || (a.index - b.index))
            .map(item => item.entry);

        const nodes = ordered.slice(0, WORKING_SET_TILE_LIMIT)
            .map(entry => this._workingSetTile(entry, agent));
        const rest = ordered.slice(WORKING_SET_TILE_LIMIT);
        if (rest.length) nodes.push(this._workingSetOverflow(rest, agent));
        replaceDetailRows(this._workingSetBodyEl, nodes);
    }

    _workingSetOverlap(collision, agent) {
        const others = (Array.isArray(collision?.agents) ? collision.agents : [])
            .filter(id => String(id) !== String(agent?.id))
            .map(id => this._getWorld()?.agents?.get?.(String(id))?.name || String(id));
        const observations = Array.isArray(collision?.observations) ? collision.observations : [];
        const writers = observations.length
            ? observations.filter(entry => entry?.op === 'write').length
            : null;
        const parts = ['overlap'];
        if (writers === null) parts.push(`${(collision?.agents || []).length} agents`);
        else if (collision.kind === 'write-write') parts.push(`${writers} writers`);
        else parts.push(`${writers} writer`);
        if (others.length) {
            parts.push(others.length > 2
                ? `${others.slice(0, 2).join(', ')} +${others.length - 2}`
                : others.join(', '));
        }
        return {
            text: parts.join(' · '),
            // Overlapping working sets prove a shared file, not simultaneous
            // editing. Only matching observation times inside one minute do.
            note: collision?.overlapKind === 'concurrent' ? 'both observed within 60s' : 'recent shared file',
            kind: collision?.kind === 'write-write' ? 'write-write' : 'read-write',
        };
    }

    _workingSetTile(entry, agent) {
        const projectPath = agent?.projectPath || '';
        const overlap = entry.overlap ? this._workingSetOverlap(entry.overlap, agent) : null;
        const head = el('div', { className: 'activity-panel__bench-head' }, [
            pixelIcon('file'),
            el('span', { className: 'activity-panel__bench-op', text: entry.op.toUpperCase() }),
            el('span', {
                className: 'activity-panel__bench-path',
                text: formatToolDetail(entry.path, { max: 34, projectPath }) || entry.path,
            }),
        ]);
        const overlapRow = overlap
            ? el('div', { className: 'activity-panel__bench-overlap' }, [
                el('span', { className: 'activity-panel__bench-overlap-mark', text: overlap.text }),
                el('span', { className: 'activity-panel__bench-overlap-note', text: overlap.note }),
            ])
            : null;
        return el('details', {
            className: `activity-panel__bench-tile cv-inspection${overlap ? ` activity-panel__bench-tile--${overlap.kind}` : ''}`,
            dataset: {
                detailKey: `bench:${entry.path}`,
                detailSignature: JSON.stringify([entry.op, overlap?.text || '', overlap?.note || '']),
            },
        }, [
            el('summary', {}, [head, overlapRow]),
            el('pre', { className: 'cv-inspection__text', text: entry.path }),
        ]);
    }

    _workingSetOverflow(rest, agent) {
        const projectPath = agent?.projectPath || '';
        const rows = rest.map(entry => {
            const overlap = entry.overlap ? this._workingSetOverlap(entry.overlap, agent) : null;
            return el('div', { className: 'activity-panel__tool-item', title: entry.path }, [
                el('span', { className: 'activity-panel__tool-item-name', text: entry.op.toUpperCase() }),
                el('span', {
                    className: 'activity-panel__tool-item-detail',
                    text: formatToolDetail(entry.path, { max: 44, projectPath }) || entry.path,
                }),
                overlap ? el('span', { className: 'activity-panel__bench-overlap-mark', text: overlap.text }) : null,
            ]);
        });
        return el('details', {
            className: 'activity-panel__bench-more cv-inspection',
            dataset: {
                detailKey: 'bench:overflow',
                detailSignature: JSON.stringify(rest.map(entry => [entry.path, entry.op, Boolean(entry.overlap)])),
            },
        }, [
            el('summary', { text: `+${rest.length} ${rest.length === 1 ? 'file' : 'files'}` }),
            el('div', { className: 'activity-panel__bench-list' }, rows),
        ]);
    }

    // ─── Live polling ────────────────────────────────

    _startPolling() {
        this._stopPolling();
        if (document.hidden || this._mode !== 'agent') return;
        this._fetchDetail();
        this._fetchPinnedDetails();
        this._pollTimer = setInterval(() => {
            this._fetchDetail();
            this._fetchPinnedDetails();
            if (this.currentAgent) this._renderRelationships(this.currentAgent);
        }, SESSION_DETAIL_PANEL_REFRESH_INTERVAL);
    }

    _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    _startBuildingPolling() {
        this._stopBuildingPolling();
        if (document.hidden || this._mode !== 'building') return;
        this._buildingPollTimer = setInterval(() => {
            if (this._mode !== 'building') return;
            this._renderBuildingSignal();
            this._fetchPinnedDetails();
        }, BUILDING_SIGNAL_REFRESH_INTERVAL);
    }

    _stopBuildingPolling() {
        if (this._buildingPollTimer) {
            clearInterval(this._buildingPollTimer);
            this._buildingPollTimer = null;
        }
    }

    _syncPollingForVisibility() {
        if (document.hidden) {
            this._stopPolling();
            this._stopBuildingPolling();
            return;
        }
        if (this._mode === 'agent') {
            this._startPolling();
        } else if (this._mode === 'building') {
            this._renderBuildingSignal();
            this._fetchPinnedDetails();
            this._startBuildingPolling();
        }
    }

    async _fetchDetail() {
        if (!this.currentAgent || this._destroyed) return;
        const agent = this.currentAgent;
        const seq = ++this._detailFetchSeq;
        this._renderNarration(agent);
        this._updateJourney(agent);
        this._updateHarborLog(agent);
        this._updateMessageEdges(agent);
        this._updateCausalWaterfall(agent);
        const data = await sessionDetailsService.fetchSessionDetail(agent);
        if (
            this._destroyed
            || seq !== this._detailFetchSeq
            || !this.currentAgent
            || this.currentAgent.id !== agent.id
        ) return;
        const freshness = detailFreshnessLabel(agent, sessionDetailsService.detailCacheState(agent));
        if (this._detailFreshnessEl) {
            this._detailFreshnessEl.textContent = freshness;
            this._detailFreshnessEl.hidden = !freshness;
        }
        if (!data) {
            this._causalWaterfallToolHistory = [];
            this._updateCausalWaterfall(this.currentAgent);
            this._setDetailState('Activity unavailable', 'Usage unavailable');
            return;
        }
        this._causalWaterfallToolHistory = Array.isArray(data.toolHistory) ? data.toolHistory : [];
        this._updateCausalWaterfall(this.currentAgent);
        this._renderToolHistory(this._causalWaterfallToolHistory);
        this._renderMessages(data.messages || []);
        this._renderTokenUsage(data.tokenUsage || data.tokens || data.usage);
        if (Object.prototype.hasOwnProperty.call(data, 'lastPrompt')
            || Object.prototype.hasOwnProperty.call(data, 'todos')) {
            this._updatePromptPlan({
                ...agent,
                lastPrompt: data.lastPrompt ?? agent.lastPrompt,
                todos: Array.isArray(data.todos) ? data.todos : agent.todos,
            });
        }
    }

    // ─── Rendering ─────────────────────────────────────

    _renderToolHistory(tools) {
        const limited = (tools || []).slice(-PANEL_TOOL_LIMIT);
        const baseSignature = toolHistorySignature(limited, {
            limit: PANEL_TOOL_LIMIT,
            detailLength: 45,
        });
        // Exit codes can arrive after the tool row itself (Codex completion
        // events), so fold them into the signature to force a re-render.
        const exitSignature = limited
            .map(row => (Number.isFinite(Number(row?.toolExitCode)) ? row.toolExitCode : ''))
            .join(',');
        const signature = `${baseSignature}|${exitSignature}`;
        if (signature === this._renderSignatures.toolHistory) return;
        this._renderSignatures.toolHistory = signature;

        const container = this.dom.panelToolHistory;
        container.closest('[data-section]')?.style.setProperty('display', limited.length ? '' : 'none');
        const nodes = toolHistoryNodes(limited, {
            limit: PANEL_TOOL_LIMIT,
            detailLength: 45,
            emptyText: 'No tool usage',
            emptyClass: 'activity-panel__empty',
            itemClass: 'activity-panel__tool-item',
            iconClass: 'activity-panel__tool-item-icon',
            nameClass: 'activity-panel__tool-item-name',
            detailClass: 'activity-panel__tool-item-detail',
            formatDetail: detail => formatToolDetail(detail, {
                max: 45,
                projectPath: this.currentAgent?.projectPath || '',
            }),
        });
        if (limited.length) {
            // Nodes mirror `limited` in reverse order (newest first).
            const reversed = [...limited].reverse();
            nodes.forEach((node, index) => {
                const chip = this._toolExitChip(reversed[index]);
                if (chip) node.querySelector('summary')?.appendChild(chip);
            });
        }
        replaceDetailRows(container, nodes);
    }

    _toolExitChip(entry) {
        const exitCode = Number(entry?.toolExitCode);
        if (!Number.isFinite(exitCode) || exitCode === 0) return null;
        return el('span', {
            className: 'activity-panel__tool-item-exit',
            text: `exit ${exitCode}`,
            title: entry?.toolStderr
                ? truncateText(entry.toolStderr, 200)
                : `Exit code ${exitCode}`,
            style: {
                color: 'var(--cv-status-errored, #e06c5b)',
                fontSize: 'var(--fs-label)',
                whiteSpace: 'nowrap',
                flexShrink: '0',
                marginLeft: 'auto',
            },
        });
    }

    _renderMessages(messages) {
        const limited = (messages || []).slice(-PANEL_MESSAGE_LIMIT);
        const signature = `${limited.length}|${hashRows(limited, [
            row => row?.ts || 0,
            row => row?.role || '',
            row => row?.text || '',
        ])}`;
        if (signature === this._renderSignatures.messages) return;
        this._renderSignatures.messages = signature;

        const container = this.dom.panelMessages;
        container.closest('[data-section]')?.style.setProperty('display', limited.length ? '' : 'none');
        if (!limited.length) {
            replaceChildren(container, [
                this._emptyState('No messages'),
            ]);
            return;
        }
        const reversed = [...limited].reverse();
        replaceDetailRows(container, reversed.map((m, index) => {
            const node = inspectableText(m.text || '', {
                summary: `${m.role || 'Message'} excerpt · ${truncateText(m.text || '', 80)}`,
                key: String(m.id || `${m.ts || index}:${m.role || ''}`),
                truncated: m.truncated === true || m.textTruncated === true,
            });
            node.classList.add('activity-panel__msg');
            return node;
        }));
    }

    _renderTokenUsage(usage) {
        if (!usage) {
            this._clearTokenUsage('No usage data');
            return;
        }

        const normalizedUsage = TokenUsage.normalize(usage);
        if (normalizedUsage.availability === 'unavailable') {
            this._clearTokenUsage('Usage unavailable');
            if (normalizedUsage.contextWindow > 0) this.dom.panelContextSize.textContent = `${formatTokens(normalizedUsage.contextWindow)} context · billing unavailable`;
            return;
        }
        const cost = this._costForUsage(normalizedUsage);
        const usageSignature = `${normalizedUsage.availability}|${normalizedUsage.totalInput}|${normalizedUsage.totalOutput}|${normalizedUsage.cacheRead}|${normalizedUsage.cacheCreate}|${normalizedUsage.contextWindow}|${normalizedUsage.contextWindowMax}|${normalizedUsage.turnCount}|${cost.usd}|${cost.source}|${cost.rateMatch}|${cost.rateRevision}|${cost.unknownModel}`;
        if (usageSignature === this._renderSignatures.tokenUsage) return;
        this._renderSignatures.tokenUsage = usageSignature;

        const maxContext = normalizedUsage.contextWindowMax || contextWindowLimitForModel(
            this.currentAgent?.model,
            this.currentAgent?.provider,
        );
        const contextPct = maxContext ? Math.min(100, (normalizedUsage.contextWindow / maxContext) * 100) : 0;

        // Context size (human-readable form)
        this.dom.panelContextSize.textContent =
            formatTokens(normalizedUsage.contextWindow) + ` / ${formatTokens(maxContext)}`;

        // Context bar
        const bar = this.dom.panelContextBar;
        bar.style.transform = `scaleX(${contextPct / 100})`;
        bar.className = 'activity-panel__context-bar';
        if (contextPct > 80) bar.classList.add('activity-panel__context-bar--danger');
        else if (contextPct > 50) bar.classList.add('activity-panel__context-bar--warning');
        this.dom.panelTokenGrid.hidden = false;
        this.dom.panelCostRow.hidden = false;
        this.dom.panelNoUsage.hidden = normalizedUsage.availability !== 'partial';
        this.dom.panelNoUsage.textContent = 'Partial usage · some token counts are unavailable';

        // Token cells
        this.dom.panelInputTokens.textContent =
            formatTokens(normalizedUsage.totalInput);
        this.dom.panelOutputTokens.textContent =
            formatTokens(normalizedUsage.totalOutput);
        this.dom.panelCacheRead.textContent =
            formatTokens(normalizedUsage.cacheRead);
        this.dom.panelCacheCreate.textContent =
            formatTokens(normalizedUsage.cacheCreate);
        this.dom.panelCacheHit.textContent = formatTokens(TokenUsage.totalTokens(normalizedUsage));
        this.dom.panelTurnCount.textContent =
            normalizedUsage.turnCount.toLocaleString();

        this._renderCost(cost);
    }

    _costForUsage(usage) {
        const supplied = this.currentAgent?.cost;
        if (supplied?.usd === null || supplied?.availability === 'unavailable') return { ...supplied, usd: null };
        if (supplied && Number.isFinite(Number(supplied.usd))) {
            return {
                usd: Math.max(0, Number(supplied.usd)),
                availability: supplied.availability,
                source: supplied.source === 'provider' ? 'provider' : 'estimate',
                rateMatch: supplied.rateMatch ?? null,
                rateRevision: supplied.rateRevision || TokenUsage.rateRevision,
                unknownModel: supplied.unknownModel === true,
            };
        }
        const estimated = TokenUsage.estimateCost(
            usage,
            this.currentAgent?.model,
            this.currentAgent?.provider,
        );
        return {
            ...estimated,
            source: 'estimate',
            rateRevision: TokenUsage.rateRevision,
        };
    }

    _renderCost(cost) {
        if (!cost || cost.usd == null || !Number.isFinite(Number(cost.usd))) {
            this.dom.panelCostRow.hidden = false;
            this.dom.panelEstCost.textContent = 'Unavailable';
            this.dom.panelEstCost.title = 'No billable usage or provider-reported cost is available';
            return;
        }
        const estimated = cost.source !== 'provider';
        this.dom.panelCostRow.hidden = false;
        this.dom.panelCostLabel.textContent = 'Cost';
        this.dom.panelEstCost.title = estimated
            ? `Estimated using ${cost.rateMatch || 'default'} rates, revision ${cost.rateRevision || TokenUsage.rateRevision}`
            : 'Provider-reported cost';
        replaceChildren(this.dom.panelEstCost, [
            `${estimated ? '~' : ''}${formatCost(cost.usd)}`,
            ' ',
            el('span', {
                className: 'activity-panel__cost-source',
                text: `${estimated ? 'estimate' : 'provider'}${cost.availability === 'partial' ? ' · partial' : ''}`,
            }),
            cost.unknownModel ? ' ' : null,
            cost.unknownModel ? el('span', { className: 'activity-panel__cost-source', text: 'default rate' }) : null,
        ]);
    }

    _setDetailState(activityText, usageText) {
        for (const node of [this.dom.panelToolHistory, this.dom.panelMessages]) {
            node.closest('[data-section]')?.style.setProperty('display', '');
        }
        this._renderSignatures.toolHistory = `state:${activityText}`;
        this._renderSignatures.messages = `state:${activityText}`;
        replaceChildren(this.dom.panelToolHistory, [this._emptyState(activityText)]);
        replaceChildren(this.dom.panelMessages, [this._emptyState(activityText)]);
        this._clearTokenUsage(usageText);
    }

    _clearTokenUsage(label = 'No usage data') {
        this._renderSignatures.tokenUsage = `state:${label}`;
        this.dom.panelContextSize.textContent = label;
        this.dom.panelContextBar.style.transform = 'scaleX(0)';
        this.dom.panelContextBar.className = 'activity-panel__context-bar';
        this.dom.panelTokenGrid.hidden = true;
        this.dom.panelCostRow.hidden = true;
        this.dom.panelNoUsage.hidden = true;
        this.dom.panelNoUsage.textContent = label;
        this.dom.panelInputTokens.textContent = '-';
        this.dom.panelOutputTokens.textContent = '-';
        this.dom.panelCacheRead.textContent = '-';
        this.dom.panelCacheCreate.textContent = '-';
        this.dom.panelCacheHit.textContent = '-';
        this.dom.panelTurnCount.textContent = '-';
        this._renderCost(this._costForUsage(this.currentAgent?.tokens || null));
    }

    _emptyState(text) {
        return el('div', { className: 'activity-panel__empty', text });
    }

    // ─── Agent enrichment sections ──────────────────────

    _ensureHarborLogSection() {
        if (this._harborLogSectionEl && this._harborLogBodyEl) return;
        const body = el('div', { className: 'activity-panel__token-usage' });
        const details = el('details', { className: 'activity-panel__journey-details' }, [
            el('summary', { className: 'activity-panel__journey-summary', text: 'Recent shipments' }),
            body,
        ]);
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Harbor Log' }),
            details,
        ]);
        this._mountSection('harbor-log', section);
        this._harborLogSectionEl = section;
        this._harborLogBodyEl = body;
        this._registerAgentSection(section);
    }

    _updateHarborLog(agent) {
        if (!this._harborLogSectionEl || !this._harborLogBodyEl) return;
        if (this._mode !== 'agent' || !agent) {
            this._harborLogSectionEl.style.display = 'none';
            return;
        }
        const events = (Array.isArray(agent.gitEvents) ? agent.gitEvents : [])
            .map((event, index) => normalizeGitEvent(event, agent, index, {
                maxLabelChars: 42,
                ellipsis: '...',
                subjectBeforeMessage: true,
            }))
            .filter(Boolean)
            .sort((a, b) => (b.timestamp - a.timestamp) || b.id.localeCompare(a.id))
            .slice(0, PANEL_GIT_EVENT_LIMIT);
        if (!events.length) {
            this._harborLogSectionEl.style.display = 'none';
            this._renderSignatures.harborLog = '';
            return;
        }
        const signature = hashRows(events, [
            event => event.id,
            event => event.type,
            event => event.status,
            event => event.label,
            event => event.sha,
            event => event.force,
            event => event.inferred,
        ]);
        this._harborLogSectionEl.style.display = '';
        if (signature === this._renderSignatures.harborLog) return;
        this._renderSignatures.harborLog = signature;
        replaceChildren(this._harborLogBodyEl, events.map(event => this._harborLogRow(event)));
    }

    _harborLogRow(event) {
        const status = this._gitEventStatus(event);
        const shortSha = event.sha ? event.sha.slice(0, 7) : event.type;
        const label = [this._titleize(event.type), shortSha].filter(Boolean).join(' ');
        const row = el('div', {
            className: 'activity-panel__token-row activity-panel__harbor-row',
            title: event.project || '',
            style: event.inferred ? { opacity: '0.68' } : undefined,
        }, [
            el('span', { className: 'activity-panel__token-label' }, [
                el('span', {
                    className: 'activity-panel__harbor-dot',
                    style: { background: status.color },
                }),
                el('span', { text: label }),
            ]),
            el('span', { className: 'activity-panel__token-value activity-panel__harbor-subject' }, [
                el('span', { text: event.label || shortSha || event.id }),
            ]),
        ]);
        if (event.force) {
            row.querySelector('.activity-panel__harbor-subject')?.appendChild(
                el('span', { className: 'activity-panel__harbor-chip', text: 'force' }),
            );
        }
        return row;
    }

    _gitEventStatus(event) {
        const status = String(event?.status || '').toLowerCase();
        if (status === 'failed' || status === 'rejected') {
            return { label: 'failed', color: 'var(--cv-status-errored)' };
        }
        if (status === 'cancelled' || status === 'canceled' || status === 'unknown') {
            return { label: 'pending', color: 'var(--cv-status-waiting)' };
        }
        return { label: 'ok', color: 'var(--cv-green-soft)' };
    }
    _ensureNarrationSection() {
        if (this._narrationSectionEl && this._narrationBodyEl) return;
        const body = el('div', { className: 'activity-panel__narration-list' });
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Narration' }),
            body,
        ]);
        this._mountSection('narration', section);
        this._narrationSectionEl = section;
        this._narrationBodyEl = body;
        this._registerAgentSection(section);
    }

    _resetNarration(agentId = null) {
        this._narrationAgentId = agentId;
        this._narrationEntries = [];
        if (this._renderSignatures) this._renderSignatures.narration = '';
    }

    _narrationEntryKey(entry) {
        const actionId = entry?.actionId === null || entry?.actionId === undefined
            ? ''
            : String(entry.actionId).trim();
        if (actionId) return `action:${actionId}`;
        return `fallback:${String(entry?.source || '')}|${String(entry?.text || '')}|${Number(entry?.observedAt)}`;
    }

    _pruneNarrationEntries(now = Date.now()) {
        const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        this._narrationEntries = (this._narrationEntries || [])
            .filter((entry) => {
                const observedAt = Number(entry?.observedAt);
                return Number.isFinite(observedAt) && current - observedAt <= NARRATION_RETENTION_MS;
            })
            .sort((a, b) => Number(b.observedAt) - Number(a.observedAt))
            .slice(0, NARRATION_ENTRY_LIMIT);
    }

    _ingestNarration(agent, now = Date.now()) {
        const agentId = agent?.id ?? null;
        if (agentId === null) return;
        if (agentId !== this._narrationAgentId) this._resetNarration(agentId);
        this._pruneNarrationEntries(now);

        const dialogue = agent?.dialogue;
        if (!dialogue || typeof dialogue !== 'object') return;
        const text = typeof dialogue.text === 'string' ? dialogue.text : '';
        if (!text.trim()) return;
        const observedAt = Number(dialogue.observedAt);
        if (!Number.isFinite(observedAt)) return;

        const actionId = dialogue.actionId === null || dialogue.actionId === undefined
            ? ''
            : String(dialogue.actionId).trim();
        const entry = {
            text,
            full: typeof dialogue.full === 'string' && dialogue.full ? dialogue.full : null,
            kind: dialogue.kind || 'assistant',
            source: String(dialogue.source || ''),
            fidelity: dialogue.fidelity || null,
            redacted: dialogue.redacted === true,
            observedAt,
            actionId: actionId || null,
        };
        const key = this._narrationEntryKey(entry);
        if (this._narrationEntries.some(existing => this._narrationEntryKey(existing) === key)) return;
        this._narrationEntries.push(entry);
        this._pruneNarrationEntries(now);
    }

    _renderNarration(agent, now = Date.now()) {
        if (!this._narrationSectionEl || !this._narrationBodyEl) return;
        if (this._mode !== 'agent' || !agent) {
            this._narrationSectionEl.style.display = 'none';
            this._renderSignatures.narration = '';
            return;
        }

        this._pruneNarrationEntries(now);
        const ordered = [...this._narrationEntries];
        if (!ordered.length) {
            this._narrationSectionEl.style.display = 'none';
            this._renderSignatures.narration = '';
            replaceChildren(this._narrationBodyEl, []);
            return;
        }
        const signature = hashRows(ordered, [
            entry => entry.actionId || '',
            entry => entry.text || '',
            entry => entry.full || '',
            entry => entry.kind || '',
            entry => entry.source || '',
            entry => entry.fidelity || '',
            entry => entry.redacted,
            entry => entry.observedAt,
            entry => formatRelative(entry.observedAt, now) || '',
        ]);
        this._narrationSectionEl.style.display = '';
        if (signature === this._renderSignatures.narration) return;
        this._renderSignatures.narration = signature;
        replaceChildren(
            this._narrationBodyEl,
            ordered.map(entry => this._narrationRow(entry, now)),
        );
    }

    _narrationRow(entry, now = Date.now()) {
        const shape = dialogueShape(entry.kind);
        const text = entry.full || entry.text;
        const flags = [];
        if (entry.fidelity === 'excerpt') {
            flags.push(el('span', {
                className: 'activity-panel__narration-flag',
                text: 'excerpt',
            }));
        }
        if (entry.redacted) {
            flags.push(el('span', {
                className: 'activity-panel__narration-flag',
                text: 'redacted',
            }));
        }
        const footer = [
            el('span', {
                className: 'activity-panel__narration-provenance',
                text: dialogueSourceLabel(entry),
            }),
            ...flags,
            el('span', {
                className: 'activity-panel__narration-time',
                text: formatRelative(Number(entry.observedAt), now) || 'just now',
            }),
        ];
        return el('div', {
            className: [
                'activity-panel__narration-row',
                `activity-panel__narration-row--${shape}`,
            ],
        }, [
            el('div', { className: 'activity-panel__narration-text', text }),
            el('div', { className: 'activity-panel__narration-footer' }, footer),
        ]);
    }


    _ensureChronicleSection() {
        if (this._chronicleSectionEl && this._chronicleBodyEl) return;
        const body = el('div', { className: 'activity-panel__chronicle-body' });
        const details = el('details', { className: 'activity-panel__journey-details' }, [
            el('summary', { className: 'activity-panel__journey-summary', text: 'Lifetime dossier' }),
            body,
        ]);
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Chronicle' }),
            details,
        ]);
        this._mountSection('chronicle', section);
        this._chronicleSectionEl = section;
        this._chronicleBodyEl = body;
        this._registerAgentSection(section);
    }

    async _fetchAndRenderChronicle(agent) {
        if (!this._chronicleSectionEl || !agent || this._destroyed) return;
        const service = this._getBiographyService();
        const identityKey = this._biographyIdentityKey(agent);
        if (!service || !identityKey) {
            this._chronicleSectionEl.style.display = 'none';
            return;
        }
        const seq = ++this._chronicleFetchSeq;
        try {
            const biography = await service.getBiography(identityKey);
            if (
                seq !== this._chronicleFetchSeq
                || this._destroyed
                || this._mode !== 'agent'
                || !this.currentAgent
                || this.currentAgent.id !== agent.id
                || identityKey !== this._currentBiographyIdentityKey
            ) return;
            this._renderChronicleBody(biography);
        } catch {
            if (
                !this._destroyed
                && seq === this._chronicleFetchSeq
                && identityKey === this._currentBiographyIdentityKey
            ) {
                this._setChronicleState('Biography unavailable');
            }
        }
    }

    _setChronicleState(text) {
        if (!this._chronicleSectionEl || !this._chronicleBodyEl) return;
        this._renderSignatures.chronicle = `state:${text}`;
        this._chronicleSectionEl.style.display = '';
        replaceChildren(this._chronicleBodyEl, [this._emptyState(text)]);
    }

    _renderChronicleBody(biography) {
        if (!this._chronicleSectionEl || !this._chronicleBodyEl) return;
        if (!this._hasBiographyContent(biography)) {
            this._chronicleSectionEl.style.display = 'none';
            this._renderSignatures.chronicle = '';
            return;
        }
        const book = buildBookOfLivesViewModel(biography);
        const signature = [
            biography.identityKey,
            biography.nickname || '',
            biography.sessionsCompleted,
            biography.lifetimeTokens,
            biography.commitsPushed,
            biography.errorsRecovered,
            book.firstSeenAt,
            book.lastSeenAt,
            book.milestones.map(milestone => `${milestone.at}:${milestone.label}`).join(','),
            [...book.archivedChapters, ...book.visibleChapters]
                .map(chapter => `${chapter.at}:${chapter.kind}:${chapter.project}`).join(','),
        ].join('|');
        this._chronicleSectionEl.style.display = '';
        if (signature === this._renderSignatures.chronicle) return;
        this._renderSignatures.chronicle = signature;

        const nodes = [];
        if (biography.nickname) {
            nodes.push(el('div', { className: 'activity-panel__chronicle-nickname', text: biography.nickname }));
        }
        nodes.push(el('div', { className: 'activity-panel__token-grid' }, [
            this._tokenCell('Sessions', biography.sessionsCompleted.toLocaleString()),
            this._tokenCell('Tokens', formatTokens(biography.lifetimeTokens)),
            this._tokenCell('Pushes', biography.commitsPushed.toLocaleString()),
            this._tokenCell('Recovered', biography.errorsRecovered.toLocaleString()),
        ]));
        if (book.milestones.length) {
            nodes.push(el('div', { className: 'activity-panel__life-milestones' }, [
                el('div', { className: 'activity-panel__life-subtitle', text: 'Milestones' }),
                ...book.milestones.map(milestone => el('div', {
                    className: 'activity-panel__life-milestone',
                    text: milestone.label,
                })),
            ]));
        }
        nodes.push(this._bookOfLivesNode(book));
        replaceChildren(this._chronicleBodyEl, nodes);
    }

    _bookOfLivesNode(book) {
        const chapterNodes = book.visibleChapters.map(chapter => this._bookOfLivesChapterNode(chapter));
        if (!chapterNodes.length) {
            chapterNodes.push(el('div', { className: 'activity-panel__life-empty', text: book.emptyLabel }));
        }
        if (book.archivedChapters.length) {
            chapterNodes.unshift(el('details', { className: 'activity-panel__life-archive' }, [
                el('summary', {
                    className: 'activity-panel__life-archive-summary',
                    text: `${book.archivedChapters.length} earlier ${book.archivedChapters.length === 1 ? 'chapter' : 'chapters'}`,
                }),
                el('div', { className: 'activity-panel__life-chapters' },
                    book.archivedChapters.map(chapter => this._bookOfLivesChapterNode(chapter))),
            ]));
        }
        return el('section', {
            className: 'activity-panel__book-of-lives',
            ariaLabel: 'Book of Lives',
        }, [
            el('div', { className: 'activity-panel__life-title', text: 'Book of Lives' }),
            el('div', { className: 'activity-panel__life-scope', text: book.scopeLabel }),
            el('div', { className: 'activity-panel__life-seen' }, [
                this._buildingRow('First seen', book.firstSeenLabel),
                this._buildingRow('Last returned', book.lastReturnedLabel),
            ]),
            el('div', { className: 'activity-panel__life-chapters' }, chapterNodes),
            el('div', { className: 'activity-panel__life-summary-note', text: book.summaryLabel }),
        ]);
    }

    _bookOfLivesChapterNode(chapter) {
        return el('div', { className: 'activity-panel__life-chapter' }, [
            el('span', {
                className: `activity-panel__life-mark activity-panel__life-mark--${chapter.kind}`,
            }),
            el('span', { className: 'activity-panel__life-copy', text: chapter.copy }),
            el('time', { className: 'activity-panel__life-date', text: chapter.dateLabel }),
        ]);
    }

    _hasBiographyContent(biography) {
        if (!biography) return false;
        const statTotal = (
            Number(biography.sessionsCompleted) ||
            Number(biography.lifetimeTokens) ||
            Number(biography.commitsPushed) ||
            Number(biography.errorsRecovered)
        );
        const episodes = biography?.extensions?.lifeEpisodes;
        return !!(
            statTotal
            || biography.nickname
            || Number(biography.firstSeenAt)
            || (Array.isArray(biography.milestones) && biography.milestones.length)
            || (Array.isArray(episodes) && episodes.length)
        );
    }

    // ─── Director scene-log narrative ribbon (#47) ──────
    // A live Chronicle feed consuming the `village:director` snapshot. Entries
    // ("Handoff — Aria → Bren", "Parade — v0.16.0 sets sail") carry a
    // kind-colored tick and a relative timestamp. No motion; the disclosure
    // scrolls. Buffered as a bounded ring across snapshots, deduped by scene id.

    _ensureDirectorFeedSection() {
        if (this._directorFeedSectionEl && this._directorFeedBodyEl) return;
        const body = el('div', { className: 'activity-panel__director-feed' });
        const details = el('details', { className: 'activity-panel__journey-details' }, [
            el('summary', { className: 'activity-panel__journey-summary', text: 'Village chronicle' }),
            body,
        ]);
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Scene Log' }),
            details,
        ]);
        this._mountSection('scene-log', section);
        this._directorFeedSectionEl = section;
        this._directorFeedBodyEl = body;
        this._registerAgentSection(section);
    }

    _accumulateDirectorFeed(payload) {
        const entries = narrativeFeedEntries(payload);
        if (!entries.length) return;
        for (const entry of entries) {
            if (!entry?.id || this._directorFeedIds.has(entry.id)) continue;
            this._directorFeedIds.add(entry.id);
            this._directorFeed.push(entry);
        }
        if (this._directorFeed.length > DIRECTOR_FEED_LIMIT) {
            const dropped = this._directorFeed.splice(0, this._directorFeed.length - DIRECTOR_FEED_LIMIT);
            for (const entry of dropped) this._directorFeedIds.delete(entry.id);
        }
    }

    _renderDirectorFeed() {
        if (!this._directorFeedSectionEl || !this._directorFeedBodyEl) return;
        if (this._mode !== 'agent') {
            this._directorFeedSectionEl.style.display = 'none';
            return;
        }
        if (!this._directorFeed.length) {
            this._directorFeedSectionEl.style.display = 'none';
            this._renderSignatures.directorFeed = '';
            return;
        }
        // Newest first. Timestamps fold into the signature so the relative
        // labels refresh as scenes age.
        const ordered = [...this._directorFeed].sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const now = Date.now();
        const signature = ordered.map(entry => `${entry.id}:${formatRelative(entry.ts, now) || ''}`).join('|');
        this._directorFeedSectionEl.style.display = '';
        if (signature === this._renderSignatures.directorFeed) return;
        this._renderSignatures.directorFeed = signature;
        replaceChildren(this._directorFeedBodyEl, ordered.map(entry => this._directorFeedRow(entry, now)));
    }

    _directorFeedRow(entry, now = Date.now()) {
        const ago = formatRelative(entry.ts, now) || 'just now';
        return el('div', { className: ['activity-panel__feed-row', `activity-panel__feed-row--${entry.kind}`] }, [
            el('span', { className: `activity-panel__feed-tick activity-panel__feed-tick--${entry.kind}` }),
            el('span', { className: 'activity-panel__feed-label', text: entry.label }),
            el('span', { className: 'activity-panel__feed-time', text: ago }),
        ]);
    }

    _ensureRelationshipsSection() {
        if (this._relationshipsSectionEl && this._relationshipsBodyEl) return;
        const body = el('div', { className: 'activity-panel__rel-list' });
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', {
                className: 'activity-panel__section-title',
                text: 'Village Bonds',
                title: 'Bond warmth halves every 48 hours without a new meeting, message, or shared commit.',
            }),
            body,
        ]);
        this._mountSection('village-bonds', section);
        this._relationshipsSectionEl = section;
        this._relationshipsBodyEl = body;
        this._registerAgentSection(section);
    }

    /**
     * Surface the affinity the village already tracks. The service owns tier,
     * decay, and ranking semantics; this layer adds names and village voice.
     */
    _renderRelationships(agent) {
        if (!this._relationshipsSectionEl || !this._relationshipsBodyEl || !agent) return;
        const service = this._getAffinityService();
        const identityKey = this._biographyIdentityKey(agent);
        if (!identityKey) {
            this._relationshipsSectionEl.style.display = '';
            this._renderSignatures.relationships = 'empty';
            replaceChildren(this._relationshipsBodyEl, [this._emptyState('No shared work yet.')]);
            return;
        }
        const now = Date.now();
        const bonds = (service?.collaboratorsFor?.(identityKey, now) || [])
            .filter(bond => bond?.tier !== 'strangers' || Number(bond?.sharedCommits) > 0);
        this._relationshipsSectionEl.style.display = '';
        if (!bonds.length) {
            const signature = 'empty';
            if (signature === this._renderSignatures.relationships) return;
            this._renderSignatures.relationships = signature;
            replaceChildren(this._relationshipsBodyEl, [this._emptyState('No shared work yet.')]);
            return;
        }
        const shown = bonds.slice(0, PANEL_RELATIONSHIP_LIMIT);
        const nameByKey = this._identityDisplayNameMap();
        for (const bond of shown) {
            bond.name = nameByKey.get(bond.identityKey) || this._identityKeyDisplayName(bond.identityKey);
        }
        const overflow = bonds.length - shown.length;
        const signature = shown
            .map(b => `${b.identityKey}:${b.tier}:${b.warmth}:${b.sharedCommits}:${formatRelative(b.lastInteractionAt, now)}`)
            .join('|') + `+${overflow}`;
        if (signature === this._renderSignatures.relationships) return;
        this._renderSignatures.relationships = signature;
        const rows = shown.map(bond => this._relationshipRow(bond, now));
        if (overflow > 0) {
            rows.push(el('div', {
                className: 'activity-panel__rel-more',
                text: `+${overflow} more ${overflow === 1 ? 'name' : 'names'} in the village annals`,
            }));
        }
        replaceChildren(this._relationshipsBodyEl, rows);
    }

    _relationshipRow(bond, now = Date.now()) {
        const tier = bond?.tier === 'allies' || bond?.tier === 'acquaintances'
            ? bond.tier
            : 'strangers';
        const tierLabel = {
            allies: 'ally',
            acquaintances: 'acquaintance',
            strangers: 'stranger',
        }[tier];
        return el('div', { className: ['activity-panel__rel-row', `activity-panel__rel-row--${tier}`] }, [
            el('div', { className: 'activity-panel__rel-head' }, [
                el('span', { className: `activity-panel__rel-dot activity-panel__rel-dot--${tier}` }),
                el('span', { className: 'activity-panel__rel-name', text: bond.name }),
                el('span', { className: `activity-panel__rel-tier activity-panel__rel-tier--${tier}`, text: tierLabel }),
            ]),
            el('div', {
                className: 'activity-panel__rel-meta',
                text: relationshipLoreLine({ ...bond, tier }, now),
            }),
        ]);
    }

    /** Map live agents' biography identity keys to a display name, to resolve the other party. */
    _identityDisplayNameMap() {
        const map = new Map();
        const agents = this._getWorld()?.agents;
        if (agents?.values) {
            for (const agent of agents.values()) {
                const key = this._biographyIdentityKey(agent);
                if (!key || map.has(key)) continue;
                const name = agent.agentName || agent.name || agent.displayName || agent.id;
                if (name) map.set(key, String(name));
            }
        }
        return map;
    }

    /** Fallback display name parsed from an identity key (`named:provider:slug`). */
    _identityKeyDisplayName(identityKey) {
        const slug = String(identityKey || '').split(':').at(-1) || 'someone';
        return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    _ensureMessageEdgesSection() {
        if (this._messageEdgesSectionEl && this._messageEdgesBodyEl) return;
        const body = el('div', { className: 'activity-panel__messages' });
        const details = el('details', { className: 'activity-panel__journey-details' }, [
            el('summary', { className: 'activity-panel__journey-summary', text: 'Outgoing edges' }),
            body,
        ]);
        const section = el('div', {
            className: 'activity-panel__message-edges',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Team Messages' }),
            details,
        ]);
        const messagesSection = this.dom.panelMessages?.closest?.('[data-section="messages"]');
        messagesSection?.appendChild(section);
        this._messageEdgesSectionEl = section;
        this._messageEdgesBodyEl = body;
        this._registerAgentSection(section);
    }

    _updateMessageEdges(agent) {
        if (!this._messageEdgesSectionEl || !this._messageEdgesBodyEl) return;
        if (this._mode !== 'agent' || !agent) {
            this._messageEdgesSectionEl.style.display = 'none';
            return;
        }
        const messages = (Array.isArray(agent.sendMessages) ? agent.sendMessages : [])
            .slice(-PANEL_INTER_AGENT_MESSAGE_LIMIT);
        if (!messages.length) {
            this._messageEdgesSectionEl.style.display = 'none';
            this._renderSignatures.messageEdges = '';
            return;
        }
        const signature = hashRows(messages, [
            row => row?.ts || 0,
            row => row?.recipient || row?.to || row?.recipientName || row?.recipient_name || row?.target || row?.targetAgentId || '',
            row => row?.summary || row?.text || row?.message || '',
        ]);
        this._messageEdgesSectionEl.style.display = '';
        if (signature === this._renderSignatures.messageEdges) return;
        this._renderSignatures.messageEdges = signature;
        replaceChildren(this._messageEdgesBodyEl, [...messages].reverse().map(message => this._messageEdgeRow(message)));
    }

    _messageEdgeRow(message) {
        const target = this._messageTargetName(message);
        const text = message?.summary || message?.text || message?.message || message?.messageType || 'message';
        return el('div', { className: ['activity-panel__msg', 'activity-panel__msg--assistant'] }, [
            el('div', { className: 'activity-panel__msg-role', text: target }),
            el('div', { text: truncateText(text, 70) }),
        ]);
    }

    _messageTargetName(message) {
        const raw = String(
            message?.recipient
            || message?.to
            || message?.recipientName
            || message?.recipient_name
            || message?.target
            || message?.targetAgentId
            || message?.target_agent_id
            || ''
        ).trim();
        if (!raw) return 'Unknown';
        const normalized = raw.toLowerCase();
        const world = this._getWorld();
        for (const agent of world?.agents?.values?.() || []) {
            const candidates = [
                agent.id,
                agent.agentId,
                agent.agentName,
                agent.name,
                agent.displayName,
            ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
            if (candidates.includes(normalized)) return agent.name || raw;
        }
        return raw;
    }

    _tokenCell(label, value) {
        return el('div', { className: 'activity-panel__token-cell' }, [
            el('span', { className: 'activity-panel__token-cell-label', text: label }),
            el('span', { className: 'activity-panel__token-cell-value', text: String(value) }),
        ]);
    }

    // ─── Selected-agent journey ────────────────────────

    _ensureJourneySection() {
        if (this._journeySectionEl && this._journeyBodyEl) return;
        // Always-visible headline sentence.
        const whyEl = el('div', { className: 'activity-panel__journey-why' });
        // Secondary rows live in a closed-by-default native disclosure.
        const detailsBody = el('div', { className: ['activity-panel__token-usage', 'activity-panel__journey'] });
        const details = el('details', { className: 'activity-panel__journey-details' }, [
            el('summary', { className: 'activity-panel__journey-summary', text: 'More detail' }),
            detailsBody,
        ]);
        const body = el('div', { className: 'activity-panel__journey-body' }, [
            whyEl,
            details,
            this._buildWorkScoreControl(),
        ]);
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Journey' }),
            body,
        ]);
        this._mountSection('journey', section);
        this._journeySectionEl = section;
        this._journeyBodyEl = body;
        this._journeyWhyEl = whyEl;
        this._journeyDetailsEl = details;
        this._journeyDetailsBodyEl = detailsBody;
        this._registerAgentSection(section);
    }

    // ─── 5.4 Work as a spatial score ───────────────────
    //
    // The panel owns the frozen row copy, the scrub cursor and the optional
    // playback timer; the village draws what this publishes. Scrubbing emits a
    // presentation request and nothing else — no world, domain or provider
    // write happens on this path, so an agent's status cannot move because the
    // operator dragged the cursor.

    _buildWorkScoreControl() {
        const openBtn = el('button', {
            className: ['activity-panel__score-btn', 'activity-panel__score-btn--open'],
            text: 'SCORE',
            title: 'Draw the last 20 minutes of this run over the village',
        });
        openBtn.type = 'button';
        openBtn.addEventListener('click', () => this._openWorkScore());

        const liveBtn = el('button', {
            className: ['activity-panel__score-btn', 'activity-panel__score-btn--live'],
            text: 'LIVE',
            title: 'Leave the score: restore the live selection and the camera',
        });
        liveBtn.type = 'button';
        liveBtn.addEventListener('click', () => this._closeWorkScore());

        const playBtn = el('button', {
            className: ['activity-panel__score-btn', 'activity-panel__score-btn--play'],
            text: 'PLAY',
            title: 'Walk the cursor through the score once',
        });
        playBtn.type = 'button';
        playBtn.addEventListener('click', () => this._toggleWorkScorePlayback());

        const controls = el('div', { className: 'activity-panel__score-controls' }, [openBtn, liveBtn, playBtn]);
        const strip = el('div', { className: 'activity-panel__score-strip' });
        const range = document.createElement('input');
        range.type = 'range';
        range.className = 'activity-panel__score-range';
        range.setAttribute('aria-label', 'Work score time cursor');
        range.addEventListener('input', () => {
            this._stopWorkScorePlayback();
            this._setWorkScoreCursor(Number(range.value));
        });
        const caption = el('div', { className: 'activity-panel__score-caption' });
        const status = el('div', { className: 'activity-panel__score-status' });
        const overflowBody = el('div', { className: 'activity-panel__score-overflow-body' });
        const overflow = el('details', {
            className: ['activity-panel__journey-details', 'activity-panel__score-overflow'],
        }, [
            el('summary', { className: 'activity-panel__journey-summary', text: 'Earlier rows' }),
            overflowBody,
        ]);
        const scrub = el('div', {
            className: 'activity-panel__score-scrub',
            style: { display: 'none' },
        }, [strip, range, caption, status, overflow]);

        this._workScoreOpenBtn = openBtn;
        this._workScoreLiveBtn = liveBtn;
        this._workScorePlayBtn = playBtn;
        this._workScoreStripEl = strip;
        this._workScoreRangeEl = range;
        this._workScoreCaptionEl = caption;
        this._workScoreStatusEl = status;
        this._workScoreOverflowEl = overflow;
        this._workScoreOverflowBodyEl = overflowBody;
        this._workScoreScrubEl = scrub;
        return el('div', { className: 'activity-panel__score' }, [controls, scrub]);
    }

    // Reduced motion means manual scrub only: the playback control is not
    // offered at all, so no timer is ever allocated.
    _workScoreReducedMotion() {
        if (typeof window === 'undefined') return true;
        return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    }

    // Exactly the rows the panel's waterfall prints, so the score's
    // exact/inferred labels are the waterfall's by construction.
    _workScoreRows(agent, now = Date.now()) {
        if (!agent) return [];
        return buildCausalWaterfall(agent, {
            now,
            toolHistory: this._causalWaterfallToolHistory.length
                ? this._causalWaterfallToolHistory
                : undefined,
            children: this._causalWaterfallChildren(agent),
        });
    }

    _openWorkScore() {
        const agent = this.currentAgent;
        if (!agent) return;
        const rows = this._workScoreRows(agent);
        const score = buildSpatialWorkScore(rows, {
            agentId: agent.id,
            agentName: agent.agentName || agent.name || agent.id,
        });
        if (!score) {
            this._workScore = null;
            this._renderWorkScoreControl();
            Toast.show('No recorded rows in the last 20 minutes');
            return;
        }
        this._workScore = score;
        this._workScoreAgentId = String(agent.id || '');
        this._workScoreCursorAt = score.startAt;
        this._workScoreOwnerLost = false;
        this._workScorePositions = null;
        this._publishWorkScore();
        this._renderWorkScoreControl();
    }

    _closeWorkScore({ restoreSelection = true } = {}) {
        const frozenId = this._workScoreAgentId;
        const wasActive = Boolean(this._workScore);
        this._stopWorkScorePlayback();
        this._workScore = null;
        this._workScoreOwnerLost = false;
        this._workScorePositions = null;
        if (wasActive) eventBus.emit(WORK_SCORE_REQUEST_EVENT, { active: false, ts: Date.now() });
        if (wasActive && restoreSelection && frozenId) {
            const agent = this._getWorld()?.agents?.get?.(frozenId);
            if (agent && String(this.currentAgent?.id || '') !== frozenId) emitAgentSelected(agent);
        }
        this._workScoreAgentId = null;
        this._renderWorkScoreControl();
    }

    _publishWorkScore() {
        if (!this._workScore) return;
        eventBus.emit(WORK_SCORE_REQUEST_EVENT, {
            active: true,
            score: this._workScore,
            cursorAt: this._workScoreCursorAt,
            playing: this._workScorePlaying,
            ts: Date.now(),
        });
    }

    _setWorkScoreCursor(at) {
        const score = this._workScore;
        if (!score) return;
        const clamped = Math.max(score.startAt, Math.min(score.endAt, Number(at) || score.startAt));
        this._workScoreCursorAt = clamped;
        this._publishWorkScore();
        this._renderWorkScoreCursor();
    }

    _toggleWorkScorePlayback() {
        if (!this._workScore || this._workScoreReducedMotion()) return;
        if (this._workScorePlaying) {
            this._stopWorkScorePlayback();
            return;
        }
        const score = this._workScore;
        const stepMs = 120;
        const advance = Math.max(1, (score.endAt - score.startAt) / (SCORE_PLAYBACK_MS / stepMs));
        if (this._workScoreCursorAt >= score.endAt) this._workScoreCursorAt = score.startAt;
        this._workScorePlaying = true;
        this._workScoreTimer = setInterval(() => {
            const next = this._workScoreCursorAt + advance;
            if (next >= score.endAt) {
                this._setWorkScoreCursor(score.endAt);
                this._stopWorkScorePlayback();
                return;
            }
            this._setWorkScoreCursor(next);
        }, stepMs);
        this._publishWorkScore();
        this._renderWorkScoreControl();
    }

    _stopWorkScorePlayback() {
        clearInterval(this._workScoreTimer);
        this._workScoreTimer = null;
        if (!this._workScorePlaying) return;
        this._workScorePlaying = false;
        this._publishWorkScore();
        this._renderWorkScoreControl();
    }

    _renderWorkScoreControl() {
        if (!this._workScoreOpenBtn) return;
        const score = this._workScore;
        const active = Boolean(score);
        const reduced = this._workScoreReducedMotion();
        this._workScoreOpenBtn.style.display = active ? 'none' : '';
        this._workScoreLiveBtn.style.display = active ? '' : 'none';
        this._workScorePlayBtn.style.display = active && !reduced ? '' : 'none';
        this._workScorePlayBtn.textContent = this._workScorePlaying ? 'PAUSE' : 'PLAY';
        this._workScoreScrubEl.style.display = active ? '' : 'none';
        if (!active) {
            replaceChildren(this._workScoreStripEl, []);
            replaceChildren(this._workScoreOverflowBodyEl, []);
            this._workScoreCaptionEl.textContent = '';
            this._workScoreStatusEl.textContent = '';
            return;
        }

        const span = Math.max(1, score.endAt - score.startAt);
        this._workScoreRangeEl.min = String(score.startAt);
        this._workScoreRangeEl.max = String(score.endAt);
        this._workScoreRangeEl.step = '250';
        this._workScoreRangeEl.value = String(this._workScoreCursorAt);
        replaceChildren(this._workScoreStripEl, score.nodes.map((node) => {
            const left = ((node.at - score.startAt) / span) * 100;
            const width = Math.max(0.8, (node.durationMs / span) * 100);
            const tick = el('button', {
                className: [
                    'activity-panel__score-tick',
                    `activity-panel__score-tick--${node.kind}`,
                ],
                style: { left: `${left}%`, width: `${Math.min(100 - left, width)}%` },
                ariaLabel: `${node.label} at ${formatRelative(node.at)}, ${node.provenance}`,
                title: `${node.label} · ${node.detail} · ${formatElapsed(node.durationMs)} · ${node.provenance}`,
            });
            tick.type = 'button';
            tick.dataset.nodeId = node.id;
            tick.addEventListener('click', () => {
                this._stopWorkScorePlayback();
                this._setWorkScoreCursor(node.at + Math.min(node.durationMs, 500));
            });
            return tick;
        }));
        replaceChildren(this._workScoreOverflowBodyEl, score.overflowRows.map(row => el('div', {
            className: 'activity-panel__score-overflow-row',
        }, [
            el('span', { className: 'activity-panel__waterfall-label', text: row.label }),
            el('span', { className: 'activity-panel__waterfall-detail', text: row.detail }),
            el('span', {
                className: [
                    'activity-panel__execution-provenance',
                    `activity-panel__execution-provenance--${row.provenance}`,
                ],
                text: row.provenance.toUpperCase(),
            }),
            el('span', { className: 'activity-panel__waterfall-duration', text: formatElapsed(row.durationMs) }),
        ])));
        this._workScoreOverflowEl.style.display = score.overflow ? '' : 'none';
        this._workScoreOverflowEl.querySelector('summary').textContent =
            `${score.overflow} earlier row${score.overflow === 1 ? '' : 's'}`;
        this._renderWorkScoreCursor();
    }

    _renderWorkScoreCursor() {
        const score = this._workScore;
        if (!score || !this._workScoreCaptionEl) return;
        this._workScoreRangeEl.value = String(this._workScoreCursorAt);
        const lit = litScoreNode(score, this._workScoreCursorAt);
        for (const tick of this._workScoreStripEl.children) {
            tick.classList.toggle('is-lit', Boolean(lit) && tick.dataset.nodeId === lit.id);
        }
        this._workScoreCaptionEl.textContent = workScoreCaption(score, this._workScoreCursorAt);
        const counts = score.counts || {};
        const positions = this._workScorePositions;
        const parts = [
            `${counts.nodes} of ${counts.total} nodes`,
            `${counts.placed} placed`,
            `${counts.children} children`,
            `${counts.intervals} intervals`,
        ];
        if (positions) {
            parts.push(`${positions.recorded} recorded position${positions.recorded === 1 ? '' : 's'}`);
            parts.push(`${positions.semantic} semantic`);
            if (positions.unplaced) parts.push(`${positions.unplaced} unplaced`);
        }
        if (this._workScoreOwnerLost) parts.push('camera released — playback paused');
        this._workScoreStatusEl.textContent = parts.join(' · ');
    }

    // The SCORE control offers itself only when the waterfall it reads has
    // rows; an open score keeps the Journey section visible on its own.
    _syncWorkScoreAvailability() {
        if (!this._workScoreOpenBtn) return;
        const available = this._causalWaterfallRows.length > 0;
        this._workScoreOpenBtn.disabled = !available;
        this._workScoreOpenBtn.title = available
            ? 'Draw the last 20 minutes of this run over the village'
            : 'No recorded rows in the last 20 minutes';
    }

    _updateJourney(agent) {
        if (!this._journeySectionEl || !this._journeyBodyEl) return;
        if (this._mode !== 'agent' || !agent) {
            this._journeySectionEl.style.display = 'none';
            return;
        }
        this._syncWorkScoreAvailability();

        const snapshot = this._getAgentBehaviorSnapshot(agent);
        const { why, rows } = this._agentJourneyRows(agent, snapshot);
        const signature = `${why}|${hashRows(rows, [
            row => row.label,
            row => row.value,
        ])}`;
        if (!why && !rows.length && !this._workScore) {
            this._journeySectionEl.style.display = 'none';
            this._renderSignatures.journey = '';
            return;
        }
        this._journeySectionEl.style.display = '';
        if (signature === this._renderSignatures.journey) return;
        this._renderSignatures.journey = signature;

        // Headline sentence stays outside the disclosure, always visible.
        this._journeyWhyEl.textContent = why || '';
        this._journeyWhyEl.style.display = why ? '' : 'none';

        // Secondary rows live inside the closed-by-default disclosure.
        if (rows.length) {
            this._journeyDetailsEl.style.display = '';
            replaceChildren(this._journeyDetailsBodyEl, rows.map(row => this._journeyRow(row.label, row.value)));
        } else {
            this._journeyDetailsEl.style.display = 'none';
            replaceChildren(this._journeyDetailsBodyEl, []);
        }
    }

    _agentJourneyRows(agent, snapshot) {
        if (!snapshot) return { why: '', rows: [] };
        const behavior = snapshot.behavior || {};
        const currentIntent = behavior.currentIntent || {};
        const buildingType = behavior.building
            || snapshot.building
            || currentIntent.building
            || agent.lastKnownBuildingType
            || null;
        const buildingLabel = this._buildingLabel(buildingType);
        const state = snapshot.behaviorState || behavior.state || null;
        const phase = behavior.currentPhase || currentIntent.phase || null;
        const reason = this._formatReasonLabel(
            currentIntent.label
                || behavior.reason
                || snapshot.behaviorReason
                || currentIntent.reason
                || currentIntent.source
                || '',
        );
        const targetTile = behavior.targetTile || snapshot.targetTile || currentIntent.targetTile || null;
        const reservation = this._getVisitReservation(agent, snapshot);
        const breadcrumb = this._formatBreadcrumb(behavior.recentBuildings || snapshot.recentBuildings);
        const goal = this._formatGoalLabel(
            behavior.currentGoal
                || currentIntent.goal
                || snapshot.goal
                || snapshot.routeIntent?.goal,
        );
        const itinerary = this._formatItinerary(
            behavior.currentItinerary
                || currentIntent.itinerary
                || snapshot.itinerary
                || snapshot.routeIntent?.itinerary,
        );
        const why = this._journeyExplanation({
            state,
            moving: snapshot.moving,
            buildingLabel,
            phase,
            reason,
        });

        // The Why sentence is the always-visible headline; everything else is
        // secondary detail. Drop rows the sentence already conveys.
        const rows = [];
        if (goal) rows.push({ label: 'Goal', value: goal });
        // Only surface the standalone Building row when Why does not already name it.
        const whyNamesBuilding = !!(buildingLabel && why && why.includes(buildingLabel));
        if (buildingLabel && !whyNamesBuilding) rows.push({ label: 'Building', value: buildingLabel });

        // Reservation owns the target tile; suppress it in Route to avoid printing
        // the same tile twice.
        const reservationText = this._formatReservation(reservation, snapshot);
        const route = this._formatRoute({
            state,
            moving: snapshot.moving,
            targetTile: reservationText ? null : targetTile,
            waypointCount: snapshot.waypointCount,
        });
        if (route) rows.push({ label: 'Route', value: route });
        if (itinerary) rows.push({ label: 'Itinerary', value: itinerary });
        if (reason) rows.push({ label: 'Reason', value: reason });
        if (reservationText) rows.push({ label: 'Reservation', value: reservationText });
        if (breadcrumb) rows.push({ label: 'Breadcrumb', value: breadcrumb });
        return { why, rows };
    }

    _journeyExplanation({ state, moving, buildingLabel, phase, reason }) {
        const action = this._formatBehaviorAction(state, moving);
        const phaseLabel = this._formatPhaseLabel(phase);
        const destination = buildingLabel ? ` ${buildingLabel}` : '';
        const purpose = phaseLabel && phaseLabel !== 'Waiting' ? phaseLabel : reason;
        if (action && destination && purpose) return `${action}${destination} for ${purpose.toLowerCase()}`;
        if (action && destination) return `${action}${destination}`;
        if (action && purpose) return `${action} for ${purpose.toLowerCase()}`;
        return '';
    }

    _formatBehaviorAction(state, moving) {
        const normalized = String(state || '').toLowerCase();
        if (moving || normalized === 'traveling') return 'Moving to';
        if (normalized === 'performing') return 'Visiting';
        if (normalized === 'blocked') return 'Blocked near';
        if (normalized === 'cooldown') return 'Leaving';
        if (normalized === 'wandering' || normalized === 'roaming') return 'Roaming near';
        return '';
    }

    _formatRoute({ state, moving, targetTile, waypointCount }) {
        const parts = [];
        const stateLabel = BEHAVIOR_STATE_LABELS[String(state || '').toLowerCase()] || '';
        if (stateLabel) parts.push(stateLabel);
        else if (moving) parts.push('Moving');
        const tile = this._formatTile(targetTile);
        if (tile) parts.push(`target ${tile}`);
        const stops = Number(waypointCount);
        if (Number.isFinite(stops) && stops > 0) parts.push(`${stops} waypoint${stops === 1 ? '' : 's'}`);
        return parts.join(', ');
    }

    _formatReservation(reservation, snapshot) {
        if (!reservation && !snapshot?.reservationId) return '';
        const parts = [];
        const slot = reservation?.slotId || snapshot?.visitSlotId || '';
        if (slot) parts.push(`slot ${this._titleize(String(slot).replace(/[:/]+/g, ' ')).toLowerCase()}`);
        const tile = this._formatTile(reservation || snapshot?.targetTile);
        if (tile) parts.push(tile);
        const queueIndex = Number(reservation?.queueIndex);
        const queueDepth = Number(reservation?.queueDepth);
        if (Number.isFinite(queueIndex) && queueIndex > 0) {
            const position = queueIndex + 1;
            const total = Number.isFinite(queueDepth) && queueDepth >= 0
                ? Math.max(position, queueDepth + 1)
                : null;
            parts.push(Number.isFinite(queueDepth) && queueDepth > 0
                ? `queue ${position}/${total}`
                : `queue ${position}`);
        }
        if (reservation?.overflow || reservation?.queueOverflow) parts.push('overflow');
        if (!parts.length && snapshot?.reservationId) parts.push(String(snapshot.reservationId));
        return parts.join(', ');
    }

    _formatBreadcrumb(buildings) {
        const list = Array.isArray(buildings) ? buildings : [];
        const labels = list
            .slice(-JOURNEY_BREADCRUMB_LIMIT)
            .map(type => this._buildingLabel(type))
            .filter(Boolean);
        // Collapse consecutive duplicates (PORTAL > PORTAL > MINE > MINE → PORTAL > MINE).
        const deduped = labels.filter((label, index) => label !== labels[index - 1]);
        return deduped.join(' > ');
    }

    _formatGoalLabel(goal) {
        const key = String(goal || '')
            .trim()
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/[_\s]+/g, '-')
            .toLowerCase();
        return AGENT_GOAL_LABELS[key] || '';
    }

    _formatItinerary(itinerary) {
        const route = Array.isArray(itinerary?.route)
            ? itinerary.route
            : (Array.isArray(itinerary?.stops) ? itinerary.stops : []);
        if (route.length < 2) return '';
        const currentIndex = Number(itinerary?.currentIndex);
        return route
            .map((stop, index) => {
                const label = this._buildingLabel(
                    typeof stop === 'string'
                        ? stop
                        : (stop?.building || stop?.buildingType || stop?.type || stop?.id),
                );
                if (!label) return '';
                return Number.isFinite(currentIndex) && Math.round(currentIndex) === index
                    ? `${label} (now)`
                    : label;
            })
            .filter(Boolean)
            .join(' > ');
    }

    _formatTile(value) {
        const x = Number(value?.tileX);
        const y = Number(value?.tileY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
        return `tile ${Math.round(x)},${Math.round(y)}`;
    }

    _formatPhaseLabel(phase) {
        const key = String(phase || '').trim().toLowerCase();
        return BEHAVIOR_PHASE_LABELS[key] || this._titleize(key);
    }

    _formatReasonLabel(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const reasonKey = raw.toLowerCase().replace(/[_\s]+/g, '-');
        if (REASON_LABELS[reasonKey]) return REASON_LABELS[reasonKey];
        // Suppress raw/unmapped numeric codes (+135490, bare numbers, +/- digits).
        if (/^[+-]?\d+$/.test(raw)) return '';
        const normalized = raw.toLowerCase().replace(/[\/_-]+/g, ' ');
        const pushMatch = normalized.match(/\bpush\s+(failed|rejected|cancelled|canceled)\b/)
            || normalized.match(/\b(failed|rejected|cancelled|canceled)\s+push\b/);
        if (pushMatch) return PUSH_STATUS_LABELS[pushMatch[1]] || raw;
        return this._titleize(normalized);
    }

    _titleize(value) {
        return String(value || '')
            .replace(/[\/_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, char => char.toUpperCase());
    }

    _buildingLabel(type) {
        const key = String(type || '').trim();
        if (!key) return '';
        const building = this._getBuildingByType(key);
        return building?.shortLabel || building?.label || this._titleize(key.replace(/^ambient:/, ''));
    }

    _getBuildingByType(type) {
        const world = this._getWorld();
        if (!world?.buildings) return null;
        if (typeof world.buildings.get === 'function') return world.buildings.get(type) || null;
        if (Array.isArray(world.buildings)) return world.buildings.find(building => building?.type === type) || null;
        return null;
    }

    _getAgentBehaviorSnapshot(agent) {
        const sprite = this._getAgentSprite(agent);
        if (!sprite || typeof sprite.getBehaviorDebugSnapshot !== 'function') return null;
        try {
            return sprite.getBehaviorDebugSnapshot() || null;
        } catch {
            return null;
        }
    }

    _getAgentSprite(agent) {
        if (!agent?.id) return null;
        return this._getRenderer()?.agentSprites?.get?.(agent.id) || null;
    }

    _getVisitReservation(agent, snapshot) {
        const allocator = this._getRenderer()?.visitTileAllocator;
        if (!allocator || typeof allocator.snapshot !== 'function') return null;
        let reservations = [];
        try {
            reservations = allocator.snapshot?.()?.reservations || [];
        } catch {
            reservations = [];
        }
        if (!Array.isArray(reservations) || !reservations.length) return null;
        const reservationId = snapshot?.reservationId;
        return reservations.find(reservation => (
            (reservationId && reservation.id === reservationId)
            || (agent?.id && reservation.agentId === agent.id)
        )) || null;
    }

    // ─── Building mode ─────────────────────────────────

    _hideAgentSections() {
        for (const node of this._agentSections) {
            if (node) node.style.display = 'none';
        }
    }

    _showAgentSections() {
        for (const node of this._agentSections) {
            if (node) node.style.display = '';
        }
    }

    _ensureBuildingContentEl() {
        if (this._buildingContentEl && this._buildingContentEl.isConnected) return;
        const container = el('div', { className: 'activity-panel__building' });
        // Insert immediately after the header so building content occupies the
        // same vertical region the agent meta+sections would.
        const header = this.panelEl.querySelector('.activity-panel__header');
        if (header && header.nextSibling) {
            this.panelEl.insertBefore(container, header.nextSibling);
        } else {
            this.panelEl.appendChild(container);
        }
        this._buildingContentEl = container;
    }

    _teardownBuildingView() {
        if (this._buildingContentEl && this._buildingContentEl.parentNode) {
            this._buildingContentEl.parentNode.removeChild(this._buildingContentEl);
        }
        this._buildingContentEl = null;
        this._selectedBuilding = null;
        this._showAgentSections();
    }

    _renderBuildingView() {
        const building = this._selectedBuilding;
        if (!building) return;
        // Header title doubles as the building label (reuse the agent name slot).
        const labelText = building.label || building.shortLabel || building.type || 'BUILDING';
        const iconText = building.icon || '';
        this.dom.panelAgentName.textContent = iconText ? `${iconText}  ${labelText}` : labelText;
        const statusEl = this.dom.panelAgentStatus;
        statusEl.textContent = (building.district || 'BUILDING').toUpperCase();
        statusEl.style.color = '';

        this._renderBuildingBody();
        this._renderBuildingSignal();
    }

    _renderBuildingBody() {
        if (!this._buildingContentEl) return;
        this._renderSignatures.buildingSignal = '';
        this._renderSignatures.buildingDetail = '';
        replaceChildren(this._buildingContentEl, [
            el('div', { className: 'activity-panel__section', dataset: { role: 'instrument' } }),
            el('div', { className: 'activity-panel__section', dataset: { role: 'building-detail' } }),
        ]);
    }

    _renderBuildingSignal() {
        if (!this._buildingContentEl || !this._selectedBuilding) return;
        const context = this._buildingContext(this._selectedBuilding);
        const model = buildBuildingInstrumentModel(context);
        this._renderBuildingInstrument(model);
        this._renderBuildingDetail(context, model.purpose);
    }

    // Counts and selectable names. Kept on its own signature so the interactive
    // name rows survive refreshes that only changed recent-work text.
    _renderBuildingInstrument(model) {
        const host = this._buildingContentEl.querySelector('[data-role="instrument"]');
        if (!host) return;
        const signature = JSON.stringify([model.presence, model.signal, model.queue]);
        if (signature === this._renderSignatures.buildingSignal) return;
        this._renderSignatures.buildingSignal = signature;
        const wasOpen = host.querySelector('details')?.open || false;
        const names = model.queue.slice(0, BUILDING_INSTRUMENT_NAME_LIMIT)
            .map(entry => this._buildingQueueName(entry));
        const overflow = model.queue.length - names.length;
        if (overflow > 0) {
            const disclosure = el('details', { className: 'activity-panel__instrument-overflow' }, [
                el('summary', { text: `+${overflow} more` }),
                ...model.queue.slice(BUILDING_INSTRUMENT_NAME_LIMIT)
                    .map(entry => this._buildingQueueName(entry)),
            ]);
            disclosure.open = wasOpen;
            names.push(disclosure);
        }
        if (!names.length) names.push(this._emptyState('No inbound or waiting agents'));
        replaceChildren(host, [
            this._buildingMetric('VISITING', model.presence, 'seats', 'Physical visits / all configured visit slots'),
            this._buildingMetric('WORK SIGNAL', model.signal, 'work', 'Working assignments / work capacity'),
            el('div', { className: 'activity-panel__instrument-queue' }, [
                el('div', { className: 'activity-panel__section-title', text: 'Queue & assignments' }),
                ...names,
            ]),
        ]);
    }

    _buildingMetric(label, value, kind, explanation) {
        const nodes = [
            el('div', { className: 'activity-panel__instrument-heading' }, [
                el('span', { text: label }),
                el('span', { text: `${value.count} / ${value.capacity ?? 'unavailable'}` }),
            ]),
        ];
        // Static count ticks, never a percentage and never an empty unknown gauge.
        // Over-capacity counts keep their extra ticks so 6 / 5 cannot read as full.
        const ticks = value.capacity === null ? 0 : Math.min(64, Math.max(value.count, value.capacity));
        if (ticks > 0) {
            const row = el('div', {
                className: `activity-panel__instrument-ticks activity-panel__instrument-ticks--${kind}`,
            }, Array.from({ length: ticks }, (_, index) => el('span', {
                className: [
                    index < value.count ? 'is-filled' : '',
                    index >= value.capacity ? 'is-over' : '',
                ],
            })));
            row.setAttribute('aria-hidden', 'true');
            nodes.push(row);
        }
        nodes.push(el('div', { className: 'activity-panel__instrument-note', text: explanation }));
        return el('div', { className: 'activity-panel__instrument-metric' }, nodes);
    }

    _buildingQueueName(entry) {
        const button = el('button', {
            className: 'activity-panel__instrument-name',
            ariaLabel: `Switch to ${entry.name}`,
        }, [
            el('span', { text: entry.name }),
            el('span', { className: 'activity-panel__instrument-note', text: entry.state }),
        ]);
        button.type = 'button';
        button.addEventListener('click', () => {
            const agent = this._getWorld()?.agents?.get?.(entry.agentId);
            if (agent) emitAgentSelected(agent);
        });
        return button;
    }

    _renderBuildingDetail(context, purpose) {
        const host = this._buildingContentEl.querySelector('[data-role="building-detail"]');
        if (!host) return;
        const rows = [];
        const recent = this._formatBuildingRecentWork(context);
        if (recent) rows.push(this._buildingRow('Recent work', recent));
        const exceptions = Number(context.external?.counts?.errored);
        if (Number.isFinite(exceptions) && exceptions > 0) {
            rows.push(this._buildingRow('Error / rate limit', String(exceptions)));
        }
        rows.push(...this._buildingSpecificStateRows(context.building));
        rows.push(el('div', { className: 'activity-panel__instrument-purpose', text: purpose }));
        const signature = hashRows(rows, [row => row.textContent || '']);
        if (signature === this._renderSignatures.buildingDetail) return;
        this._renderSignatures.buildingDetail = signature;
        replaceChildren(host, rows);
    }

    _buildingOccupants(building) {
        const occupants = [];
        const world = this._getWorld();
        if (!building || !world?.agents?.values || typeof building.isAgentVisiting !== 'function') return occupants;
        for (const agent of world.agents.values()) {
            if (building.isAgentVisiting(agent)) occupants.push(agent);
        }
        return occupants;
    }

    _buildingContext(building) {
        const type = this._buildingKey(building);
        const occupants = this._buildingOccupants(building);
        const allocator = this._buildingAllocatorSnapshot();
        const reservations = (Array.isArray(allocator?.reservations) ? allocator.reservations : [])
            .filter(reservation => this._buildingKey(reservation?.buildingType || reservation?.building) === type);
        const routeAgents = this._buildingRouteAgents(building, occupants);
        const recentWork = this._buildingRecentWork(building, occupants, routeAgents);
        const external = this._buildingExternalData(type);
        const assignedAgents = [...(this._getWorld()?.agents?.values?.() || [])].filter(agent => (
            this._buildingKey(agent.targetBuildingType || agent.lastKnownBuildingType || agent.buildingType || agent.building) === type
        ));
        return {
            building,
            type,
            occupants,
            reservations,
            routeAgents,
            assignedAgents,
            recentWork,
            external,
        };
    }

    _buildingSpecificStateRows(building) {
        const type = building.type;
        if (type === 'mine') {
            const fiveHour = Number(this._latestUsage?.quota?.fiveHour);
            if (!Number.isFinite(fiveHour)) return [this._buildingRow('5h quota', 'unknown')];
            const pct = Math.max(0, Math.min(100, fiveHour * 100));
            return [this._buildingRow('5h quota', `${pct.toFixed(1)}%`)];
        }
        if (type === 'watchtower') {
            const harbor = this._getHarborTraffic();
            const failed = harbor?.getFailedPushState?.();
            const active = !!(failed && failed.hasFailedPush);
            return [this._buildingRow('Push issue', active ? 'Push failed' : 'clear')];
        }
        if (type === 'harbor') {
            const repos = this._getHarborRepoSummaries();
            if (!repos.length) return [this._buildingRow('Pending repos', 'none')];
            return repos.slice(0, 8).map((repo) => this._buildingRow(
                repo.shortName || repo.repoName || repo.project || 'repo',
                this._formatRepoLedger(repo),
            ));
        }
        return [];
    }

    _formatBuildingRecentWork(context) {
        const external = this._externalFieldText(context.external, [
            'recent',
            'recentWork',
            'work',
            'activity',
            'lastWork',
        ]);
        if (external) return truncateText(this._formatExternalSignalText(external), 80);
        if (!context.recentWork.length) return '';
        return truncateText(context.recentWork.slice(0, BUILDING_RECENT_WORK_LIMIT).join('; '), 86);
    }

    _buildingRouteAgents(building, occupants = []) {
        const type = this._buildingKey(building);
        const occupantIds = new Set(occupants.map(agent => agent?.id).filter(Boolean));
        const routes = [];
        const world = this._getWorld();
        for (const agent of world?.agents?.values?.() || []) {
            if (!agent?.id || occupantIds.has(agent.id)) continue;
            const snapshot = this._getAgentBehaviorSnapshot(agent);
            const target = this._agentTargetBuildingKey(agent, snapshot);
            const state = String(snapshot?.behaviorState || snapshot?.behavior?.state || '').toLowerCase();
            if (target !== type) continue;
            if (snapshot?.moving || state === 'traveling') routes.push(agent);
        }
        return routes;
    }

    _buildingRecentWork(building, occupants = [], routeAgents = []) {
        const type = this._buildingKey(building);
        const candidates = new Map();
        for (const agent of occupants) if (agent?.id) candidates.set(agent.id, agent);
        for (const agent of routeAgents) if (agent?.id) candidates.set(agent.id, agent);
        const world = this._getWorld();
        for (const agent of world?.agents?.values?.() || []) {
            if (!agent?.id || candidates.has(agent.id)) continue;
            const snapshot = this._getAgentBehaviorSnapshot(agent);
            if (this._agentTouchesBuilding(agent, snapshot, type)) candidates.set(agent.id, agent);
        }
        const rows = [];
        for (const agent of candidates.values()) {
            const tool = currentToolPresentation(agent);
            const age = Number(agent.activityAgeMs);
            if (tool.isIdle && Number.isFinite(age) && age > 300000) continue;
            if (tool.isIdle && !agent.currentTool) continue;
            const name = agent.displayName || agent.name || agent.id;
            rows.push(`${truncateText(name, 14)}: ${truncateText(tool.name || 'Work', 18)}`);
            if (rows.length >= BUILDING_RECENT_WORK_LIMIT) break;
        }
        return rows;
    }

    _agentTouchesBuilding(agent, snapshot, type) {
        const behavior = snapshot?.behavior || {};
        const intent = behavior.currentIntent || snapshot?.routeIntent || {};
        const recent = Array.isArray(behavior.recentBuildings)
            ? behavior.recentBuildings
            : (Array.isArray(snapshot?.recentBuildings) ? snapshot.recentBuildings : []);
        const candidates = [
            snapshot?.building,
            behavior.building,
            intent.building,
            agent?.targetBuildingType,
            agent?.lastKnownBuildingType,
            ...recent.slice(-2),
        ];
        return candidates.some(candidate => this._buildingKey(candidate) === type);
    }

    _agentTargetBuildingKey(agent, snapshot) {
        const behavior = snapshot?.behavior || {};
        const intent = behavior.currentIntent || snapshot?.routeIntent || {};
        return this._buildingKey(
            intent.building
            || snapshot?.routeIntent?.building
            || agent?.targetBuildingType
            || snapshot?.building
            || agent?.lastKnownBuildingType,
        );
    }

    _buildingAllocatorSnapshot() {
        const allocator = this._getRenderer()?.visitTileAllocator;
        if (!allocator || typeof allocator.snapshot !== 'function') return null;
        try {
            return allocator.snapshot() || null;
        } catch {
            return null;
        }
    }

    _buildingExternalData(type) {
        const director = this._villageDirectorByType.get(type) || null;
        const signal = this._buildingSignalByType.get(type) || null;
        if (!director && !signal) return null;
        return this._mergeBuildingPayload(director || {}, signal || {});
    }

    _buildingKey(value) {
        const raw = value && typeof value === 'object'
            ? (value.type || value.buildingType || value.building || value.id || value.key)
            : value;
        return normalizeBuildingType(String(raw || '').trim().toLowerCase()) || '';
    }

    _isConfiguredBuildingKey(value) {
        const key = this._buildingKey(value);
        return !!key && (CONFIGURED_BUILDING_TYPES.has(key) || !!this._getBuildingByType(key));
    }

    _cacheBuildingPayload(payload, targetMap) {
        if (!targetMap) return;
        for (const [type, value] of this._buildingPayloadEntries(payload)) {
            const key = this._buildingKey(type);
            if (!this._isConfiguredBuildingKey(key) || !value || typeof value !== 'object') continue;
            const projected = this._projectBuildingPayload(value);
            if (Object.keys(projected).length) targetMap.set(key, projected);
            else targetMap.delete(key);
        }
    }

    _cacheVillageDirectorPayload(payload) {
        this._cacheBuildingPayload(payload, this._villageDirectorByType);
    }

    _buildingPayloadEntries(payload, depth = 0, budget = null) {
        const remaining = budget || { scanned: 0, entries: 0 };
        if (
            !payload
            || depth > 3
            || remaining.scanned >= BUILDING_PAYLOAD_SCAN_LIMIT
            || remaining.entries >= BUILDING_PAYLOAD_ENTRY_LIMIT
        ) return [];
        if (Array.isArray(payload)) {
            const entries = [];
            for (const item of payload) {
                if (
                    remaining.scanned >= BUILDING_PAYLOAD_SCAN_LIMIT
                    || remaining.entries >= BUILDING_PAYLOAD_ENTRY_LIMIT
                ) break;
                remaining.scanned++;
                entries.push(...this._buildingPayloadEntries(item, depth + 1, remaining));
            }
            return entries;
        }
        if (typeof payload !== 'object') return [];

        const directKey = this._payloadBuildingKey(payload);
        if (directKey) {
            remaining.entries++;
            return [[directKey, payload]];
        }

        const entries = [];
        const containerKeys = [
            'buildings',
            'buildingSignals',
            'building_signals',
            'signals',
            'selectedBuildingSignal',
            'directives',
            'director',
            'payload',
            'data',
        ];
        for (const containerKey of containerKeys) {
            const container = payload[containerKey];
            if (!container || typeof container !== 'object') continue;
            const directContainerKey = this._payloadBuildingKey(container);
            if (directContainerKey) {
                entries.push([directContainerKey, container]);
                remaining.entries++;
                continue;
            }
            if (Array.isArray(container)) {
                for (const item of container) {
                    if (
                        remaining.scanned >= BUILDING_PAYLOAD_SCAN_LIMIT
                        || remaining.entries >= BUILDING_PAYLOAD_ENTRY_LIMIT
                    ) break;
                    remaining.scanned++;
                    entries.push(...this._buildingPayloadEntries(item, depth + 1, remaining));
                }
                continue;
            }
            const directConfiguredKeys = new Set();
            for (const configuredType of CONFIGURED_BUILDING_TYPES) {
                if (
                    remaining.entries >= BUILDING_PAYLOAD_ENTRY_LIMIT
                    || !Object.prototype.hasOwnProperty.call(container, configuredType)
                ) continue;
                const configuredValue = container[configuredType];
                if (!configuredValue || typeof configuredValue !== 'object') continue;
                entries.push([configuredType, configuredValue]);
                directConfiguredKeys.add(configuredType);
                remaining.entries++;
            }
            for (const key in container) {
                if (!Object.prototype.hasOwnProperty.call(container, key)) continue;
                if (directConfiguredKeys.has(key)) continue;
                if (
                    remaining.scanned >= BUILDING_PAYLOAD_SCAN_LIMIT
                    || remaining.entries >= BUILDING_PAYLOAD_ENTRY_LIMIT
                ) break;
                remaining.scanned++;
                const value = container[key];
                if (value && typeof value === 'object') {
                    const mapKey = this._buildingKey(key);
                    if (this._isConfiguredBuildingKey(mapKey)) {
                        entries.push([mapKey, value]);
                        remaining.entries++;
                    } else {
                        entries.push(...this._buildingPayloadEntries(value, depth + 1, remaining));
                    }
                }
            }
        }
        if (entries.length) return entries;

        for (const key in payload) {
            if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
            if (
                remaining.scanned >= BUILDING_PAYLOAD_SCAN_LIMIT
                || remaining.entries >= BUILDING_PAYLOAD_ENTRY_LIMIT
            ) break;
            remaining.scanned++;
            const value = payload[key];
            if (this._looksLikeBuildingPayloadMapEntry(key, value)) {
                entries.push([this._buildingKey(key), value]);
                remaining.entries++;
            }
        }
        return entries;
    }

    _payloadBuildingKey(payload) {
        for (const key of ['building', 'buildingType', 'targetBuilding', 'targetBuildingType']) {
            const value = payload?.[key];
            if (value) return this._buildingKey(value);
        }
        for (const key of ['type', 'id', 'key']) {
            const value = payload?.[key];
            const buildingKey = this._buildingKey(value);
            if (buildingKey && (this._getBuildingByType(buildingKey) || this._buildingKey(this._selectedBuilding) === buildingKey)) {
                return buildingKey;
            }
        }
        return '';
    }

    _looksLikeBuildingPayloadMapEntry(key, value) {
        const buildingKey = this._buildingKey(key);
        if (!buildingKey || !value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (!this._isConfiguredBuildingKey(buildingKey)) return false;
        if (this._getBuildingByType(buildingKey) || this._buildingKey(this._selectedBuilding) === buildingKey) return true;
        return this._hasAnyKey(value, [
            'count',
            'tier',
            'recencyScore',
            'headline',
            'summary',
            'message',
            'signal',
            'queue',
            'queued',
            'routes',
            'recentWork',
            'status',
            'state',
        ]);
    }

    _projectBuildingPayload(value, depth = 0, budget = null) {
        const remaining = budget || { nodes: 0, fields: 0, characters: 0 };
        if (
            depth > BUILDING_PAYLOAD_DEPTH_LIMIT
            || value === null
            || value === undefined
            || remaining.nodes >= BUILDING_PAYLOAD_NODE_LIMIT
        ) return {};
        if (typeof value !== 'object' || Array.isArray(value)) return {};
        remaining.nodes++;
        const projected = {};
        for (const [key, fieldValue] of Object.entries(value)) {
            if (!BUILDING_PAYLOAD_FIELDS.has(key)) continue;
            if (remaining.fields >= BUILDING_PAYLOAD_FIELD_LIMIT) break;
            remaining.fields++;
            if (typeof fieldValue === 'string') {
                const available = BUILDING_PAYLOAD_CHARACTER_LIMIT - remaining.characters;
                if (available <= 0) continue;
                projected[key] = truncateText(
                    fieldValue.trim(),
                    Math.min(BUILDING_PAYLOAD_STRING_LIMIT, available),
                );
                remaining.characters += projected[key].length;
            } else if (typeof fieldValue === 'number') {
                if (Number.isFinite(fieldValue)) projected[key] = fieldValue;
            } else if (typeof fieldValue === 'boolean') {
                projected[key] = fieldValue;
            } else if (Array.isArray(fieldValue)) {
                const items = fieldValue
                    .slice(0, BUILDING_PAYLOAD_ARRAY_LIMIT)
                    .map(item => {
                        if (typeof item === 'string') {
                            const available = BUILDING_PAYLOAD_CHARACTER_LIMIT - remaining.characters;
                            if (available <= 0) return null;
                            const projectedItem = truncateText(
                                item.trim(),
                                Math.min(BUILDING_PAYLOAD_STRING_LIMIT, available),
                            );
                            remaining.characters += projectedItem.length;
                            return projectedItem;
                        }
                        if (typeof item === 'number') return Number.isFinite(item) ? item : null;
                        if (typeof item === 'boolean') return item;
                        if (item && typeof item === 'object') {
                            const nested = this._projectBuildingPayload(item, depth + 1, remaining);
                            return Object.keys(nested).length ? nested : null;
                        }
                        return null;
                    })
                    .filter(item => item !== null);
                if (items.length) projected[key] = items;
            } else if (fieldValue && typeof fieldValue === 'object') {
                const nested = this._projectBuildingPayload(fieldValue, depth + 1, remaining);
                if (Object.keys(nested).length) projected[key] = nested;
            }
        }
        return projected;
    }

    _mergeBuildingPayload(base, overlay) {
        const merged = { ...(base || {}), ...(overlay || {}) };
        for (const key of ['signal', 'status', 'state', 'queue', 'route', 'routes', 'recent', 'recentWork', 'activity']) {
            const left = base?.[key];
            const right = overlay?.[key];
            if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
                merged[key] = { ...left, ...right };
            }
        }
        return merged;
    }

    _externalFieldText(source, keys, depth = 0) {
        if (source === null || source === undefined || depth > 3) return '';
        if (typeof source !== 'object') return this._formatExternalSignalText(source);
        for (const key of keys) {
            if (!this._hasOwn(source, key)) continue;
            const text = this._formatExternalSignalText(source[key]);
            if (text) return text;
        }
        for (const key of ['signal', 'status', 'state', 'detail', 'queue', 'route', 'routes', 'recent', 'work', 'activity', 'payload', 'data']) {
            const nested = source[key];
            if (!nested || typeof nested !== 'object') continue;
            const text = this._externalFieldText(nested, keys, depth + 1);
            if (text) return text;
        }
        return '';
    }

    _formatExternalSignalText(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') return value.trim();
        if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
        if (typeof value === 'boolean') return value ? 'active' : '';
        if (Array.isArray(value)) {
            return value
                .map(item => this._formatExternalSignalText(item))
                .filter(Boolean)
                .slice(0, 3)
                .join('; ');
        }
        if (typeof value !== 'object') return '';
        for (const key of ['headline', 'summary', 'message', 'label', 'text', 'name', 'status', 'state', 'phase', 'detail']) {
            if (!this._hasOwn(value, key)) continue;
            const text = this._formatExternalSignalText(value[key]);
            if (text) return text;
        }
        const waiting = this._firstFiniteNumber([value.waiting, value.queued, value.queueDepth]);
        if (Number.isFinite(waiting)) return `${waiting} waiting`;
        const count = this._firstFiniteNumber([value.count, Array.isArray(value.agents) ? value.agents.length : NaN]);
        return Number.isFinite(count) ? String(count) : '';
    }

    _firstFiniteNumber(values) {
        for (const value of values) {
            const number = Number(value);
            if (Number.isFinite(number)) return number;
        }
        return NaN;
    }

    _hasAnyKey(source, keys) {
        if (!source || typeof source !== 'object') return false;
        return keys.some(key => this._hasOwn(source, key));
    }

    _hasOwn(source, key) {
        return Object.prototype.hasOwnProperty.call(source, key);
    }

    _formatRepoLedger(repo) {
        const pending = Number(repo.pendingCommits) || 0;
        const docked = Number(repo.dockedCommits) || 0;
        const failed = Number(repo.failedPushes) || 0;
        const parts = [];
        if (pending) parts.push(`${pending} pending`);
        if (docked) parts.push(`${docked} docked`);
        if (failed) parts.push(this._formatPushIssueCount(failed, 'failed'));
        return parts.length ? parts.join(', ') : '0 pending';
    }

    _formatPushIssueCount(count, status) {
        const normalized = String(status || '').toLowerCase();
        if (normalized === 'failed') return `${count} ${count === 1 ? 'push failed' : 'pushes failed'}`;
        if (normalized === 'rejected') return `${count} ${count === 1 ? 'push rejected' : 'pushes rejected'}`;
        if (normalized === 'cancelled' || normalized === 'canceled') {
            return `${count} ${count === 1 ? 'push cancelled' : 'pushes cancelled'}`;
        }
        return `${count} ${this._titleize(status).toLowerCase()}`;
    }

    _buildingRow(label, value) {
        return el('div', { className: 'activity-panel__token-row' }, [
            el('span', { className: 'activity-panel__token-label', text: label }),
            el('span', { className: 'activity-panel__token-value', text: String(value) }),
        ]);
    }

    _journeyRow(label, value) {
        return el('div', { className: 'activity-panel__journey-row' }, [
            el('div', { className: 'activity-panel__journey-label', text: label }),
            el('div', { className: 'activity-panel__journey-value', text: String(value) }),
        ]);
    }

    _getWorld() {
        return this._dependencies.world?.() || null;
    }

    _getRenderer() {
        return this._dependencies.renderer?.() || null;
    }

    _getHarborTraffic() {
        return this._dependencies.harborTraffic?.() || this._getRenderer()?.harborTraffic || null;
    }

    _getBiographyService() {
        return this._dependencies.biographyService?.() || null;
    }

    _getAffinityService() {
        return this._dependencies.affinityService?.() || null;
    }

    _biographyIdentityKey(agent) {
        return this._getBiographyService()?.identityKeyFor?.(agent) || AgentBiography.identityKeyFor(agent);
    }

    _getHarborRepoSummaries() {
        const harbor = this._getHarborTraffic();
        if (!harbor) return [];
        if (typeof harbor.getRepoSummaries === 'function') {
            return harbor.getRepoSummaries() || [];
        }
        if (typeof harbor.getPendingRepoSummaries === 'function') {
            return harbor.getPendingRepoSummaries() || [];
        }
        return [];
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._detailFetchSeq++;
        this._chronicleFetchSeq++;
        this._pinFetchSeq++;
        this._focusRequestVersion++;
        this._stopPolling();
        this._stopBuildingPolling();
        this._stopPanelKeyboardHandling();
        this._teardownHeroPortrait();
        this._teardownBuildingView();
        this._elapsedUnsubscribe?.();
        this._elapsedUnsubscribe = null;
        this._clearCausalWaterfallSubscriptions();
        this._closeWorkScore({ restoreSelection: false });
        if (this.panelEl) this.panelEl.style.display = 'none';
        document.body.classList.remove('cv-panel-open');
        this.currentAgent = null;
        this._narrationAgentId = null;
        this._narrationEntries = [];
        this._currentBiographyIdentityKey = null;
        this._selectedBuilding = null;
        this._mode = null;
        this.closeBtn?.removeEventListener('click', this._onCloseClick);
        this._pinToggleBtn?.removeEventListener('click', this._onPinToggleClick);
        this._workingDirectoryCopyBtn?.removeEventListener('click', this._onWorkingDirectoryCopyClick);
        document.removeEventListener('click', this._onInteractionClick, true);
        document.removeEventListener('keydown', this._onInteractionKeydown, true);
        eventBus.off('agent:selected', this._onAgentSelected);
        eventBus.off('agent:deselected', this._onAgentDeselected);
        eventBus.off('agent:updated', this._onAgentUpdated);
        eventBus.off('agent:removed', this._onAgentRemoved);
        eventBus.off(BUILDING_EVENTS.SELECTED, this._onBuildingSelected);
        eventBus.off(BUILDING_EVENTS.DESELECTED, this._onBuildingDeselected);
        eventBus.off(BUILDING_EVENTS.ACTIVE_AGENTS, this._onBuildingPresence);
        eventBus.off(VILLAGE_BUILDING_SIGNAL_EVENT, this._onBuildingSignal);
        eventBus.off(VILLAGE_DIRECTOR_EVENT, this._onVillageDirector);
        eventBus.off('usage:updated', this._onUsageUpdated);
        eventBus.off('mood:changed', this._onMoodChanged);
        eventBus.off('biography:updated', this._onBiographyUpdated);
        eventBus.off('affinity:changed', this._onAffinityChanged);
        eventBus.off('affinity:ready', this._onAffinityReady);
        eventBus.off('mode:changed', this._onModeChanged);
        eventBus.off(WORK_SCORE_STATE_EVENT, this._onWorkScoreState);
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        this._villageSectionEl?.removeEventListener('toggle', this._onVillageToggle);

        const ownedNodes = [
            this._pinStripEl,
            this._pinToggleBtn,
            this._workingDirectoryRowEl,
            this._statusElapsedEl,
            this._blockedBannerEl,
            this._promptPlanSectionEl,
            this._executionTreeSectionEl,
            this._causalWaterfallSectionEl,
            this._workingSetSectionEl,
            this._journeySectionEl,
            this._harborLogSectionEl,
            this._chronicleSectionEl,
            this._directorFeedSectionEl,
            this._narrationSectionEl,
            this._relationshipsSectionEl,
            this._messageEdgesSectionEl,
            this._villageSectionEl,
        ];
        for (const node of ownedNodes) node?.remove?.();
        this._executionChildIdsByParent.clear();
        this._causalWaterfallRows = [];
        this._causalWaterfallToolHistory = [];
        this._agentSections = [];
        this._pinnedDetails.clear();
        eventBus.emit('agents:pins-changed', { pinnedAgentIds: [] });
        this._pinned.clear();
        this._buildingSignalByType.clear();
        this._villageDirectorByType.clear();
        this._directorFeed = [];
        this._directorFeedIds.clear();
        this._dependencies = null;
        if (this._ownsToast) this.toast?.destroy?.();
        this.toast = null;
        this.dom = null;
        this._toolEls = null;
        this.panelEl = null;
        this.closeBtn = null;
        this._pinStripEl = null;
        this._pinToggleBtn = null;
        this._workingDirectoryRowEl = null;
        this._workingDirectoryValueEl = null;
        this._workingDirectoryCopyBtn = null;
        this._journeySectionEl = null;
        this._journeyBodyEl = null;
        this._journeyWhyEl = null;
        this._journeyDetailsEl = null;
        this._journeyDetailsBodyEl = null;
        this._harborLogSectionEl = null;
        this._harborLogBodyEl = null;
        this._chronicleSectionEl = null;
        this._chronicleBodyEl = null;
        this._directorFeedSectionEl = null;
        this._narrationSectionEl = null;
        this._narrationBodyEl = null;
        this._directorFeedBodyEl = null;
        this._relationshipsSectionEl = null;
        this._relationshipsBodyEl = null;
        this._messageEdgesSectionEl = null;
        this._messageEdgesBodyEl = null;
        this._executionTreeSectionEl = null;
        this._executionTreeBodyEl = null;
        this._causalWaterfallSectionEl = null;
        this._causalWaterfallSummaryEl = null;
        this._causalWaterfallBodyEl = null;
        this._causalWaterfallRows = [];
        this._causalWaterfallToolHistory = [];
        this._promptPlanSectionEl = null;
        this._promptPlanTitleEl = null;
        this._villageSectionEl = null;
        this._villageBodyEl = null;
    }
}
