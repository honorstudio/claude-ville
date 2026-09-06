import { eventBus } from '../../domain/events/DomainEvent.js';
import { bucketAgents, bucketCounts, bucketForStatus } from '../../domain/services/SignalLedger.js';
import { toolCategory } from '../../domain/services/ToolIdentity.js';
import { AvatarCanvas } from './AvatarCanvas.js';
import { i18n } from '../../config/i18n.js';
import { sessionDetailsService } from '../shared/SessionDetailsService.js';
import { SESSION_DETAIL_REFRESH_INTERVAL } from '../../config/constants.js';
import { replaceChildren } from '../shared/DomSafe.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import {
    collisionsForAgent,
    formatCost,
    formatRelative,
    formatStatusElapsed,
    formatTokens,
    formatToolDetail,
    normalizeStatus,
    shortenHomePath,
    shortProjectName,
    subscribeElapsedText,
    truncateText,
    workingSetForAgent,
} from '../shared/Formatters.js';
import { AgentSelectionMirror, emitAgentDeselected, emitAgentSelected } from '../shared/AgentSelection.js';
import { operatorStatusLabel } from '../shared/SemanticTriage.js';
import { getTeamColor, shortTeamName } from '../shared/TeamColor.js';
import { phaseNameForDate } from '../character-mode/AtmosphereState.js';
import { attentionAgentIds, isKeyboardEditTarget, nextCardId, recoveryCardId } from './DashboardKeyboardNavigation.js';
import {
    pixelIcon,
    inspectableText,
    replaceDetailRows,
    detailFreshnessLabel,
    signalProvenance,
    buildingClassForAgent,
    buildingPresentation,
    currentToolPresentation,
    groupAgentsByProject,
    modelPresentation,
    projectProfile,
    providerPresentation,
    statusPresentation,
    waitReasonLabel,
    toolHistoryNodes,
    toolHistorySignature,
} from '../shared/AgentPresentation.js';

const DASHBOARD_TOOL_HISTORY_LIMIT = 12;
const PROMPT_DETAIL_MAX_LENGTH = 200;
const DASHBOARD_FILTER_EVENT = 'dashboard:filter-changed';
const DASHBOARD_FILTER_REQUEST_EVENT = 'dashboard:filter-requested';
const ROW_STATUS_FILTERS = Object.freeze([
    { key: 'needsYou', label: 'Needs you' },
    { key: 'errors', label: 'Errors' },
    { key: 'quota', label: 'Quota' },
    { key: 'working', label: 'Working' },
]);
const ROW_STATUS_RANK = Object.freeze({
    waiting_on_user: 0,
    errored: 1,
    rate_limited: 2,
    working: 3,
    waiting: 4,
    idle: 5,
    completed: 6,
});
const TURN_STATE_LABELS = Object.freeze({
    tool_pending: 'Tool pending',
    awaiting_input: 'Awaiting input',
    working: 'Responding',
});

function safePromptDetail(agent, limit = PROMPT_DETAIL_MAX_LENGTH) {
    const source = agent?.promptDetail
        || (agent?.signalSource === 'hook' ? agent?.lastToolInput : '');
    const clean = String(source || '')
        .replace(/\b((?:[A-Za-z0-9_-]*?(?:key|token)))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi, '$1=[REDACTED]')
        .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (clean.length <= limit) return clean;
    return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

function waitProvenance(agent) {
    const certainty = agent?.signalCertainty || (agent?.signalSource === 'hook' ? 'observed' : 'inferred');
    return `${certainty}${agent?.signalStale ? ' · stale' : ''}`.toUpperCase();
}

function rowWaitAnchor(agent) {
    return Number(agent?.awaitingSince
        || agent?.pendingSince
        || agent?.turnStartedAt
        || agent?.lastSessionActivity
        || 0) || 0;
}

function rowPhase(agent) {
    if (agent?.currentTool) return agent.currentTool;
    return TURN_STATE_LABELS[agent?.turnState]
        || operatorStatusLabel(agent?.status)
        || 'Unknown';
}

function rowExceptionRank(agent) {
    const statusRank = ROW_STATUS_RANK[normalizeStatus(agent?.status)] ?? 7;
    if (statusRank <= 2) return statusRank;
    if (collisionsForAgent(agent).length) return 3;
    return statusRank + 1;
}

/** Dashboard health display precedence: error, blocked, quota, working, waiting, idle. */
export const SECTION_HEALTH_ORDER = Object.freeze([
    'errors',
    'needsYou',
    'quota',
    'working',
    'watchlist',
    'idle',
]);

const SECTION_HEALTH_PRESENTATION = Object.freeze({
    errors: Object.freeze({ className: 'errored', label: 'error' }),
    needsYou: Object.freeze({ className: 'needs-you', label: 'blocked' }),
    quota: Object.freeze({ className: 'quota', label: 'quota' }),
    working: Object.freeze({ className: 'working', label: 'working' }),
    watchlist: Object.freeze({ className: 'watchlist', label: 'waiting' }),
    idle: Object.freeze({ className: 'idle', label: 'idle' }),
});

/**
 * Project-header counts derived from the shared SignalLedger vocabulary.
 * `quiet` combines idle, completed, and unknown statuses for the compact
 * header readout and is presented as `idle`.
 */
export function sectionHealthCounts(agents) {
    const counts = bucketCounts(agents);
    return {
        errors: counts.errors,
        needsYou: counts.needsYou,
        quota: counts.quota,
        working: counts.working,
        watchlist: counts.watchlist,
        idle: counts.quiet,
    };
}

/** Stable display order with zero-count buckets omitted. */
export function nonZeroSectionHealthBuckets(counts) {
    return SECTION_HEALTH_ORDER.filter(bucket => Number(counts?.[bucket]) > 0);
}

/** The edge flash belongs only to a genuine errored status. */
export function shouldFlashForStatus(status) {
    return bucketForStatus(status) === 'errors';
}
const EXECUTION_TASK_DONE_STATUSES = new Set(['complete', 'completed', 'done', 'success', 'succeeded']);
const EXECUTION_CHILD_STATUSES = new Set([
    'active',
    'completed',
    'complete',
    'done',
    'errored',
    'idle',
    'rate_limited',
    'waiting',
    'waiting_on_user',
    'working',
]);
const EXECUTION_TASK_LIMIT = 12;

function executionStatus(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
}

function executionChildId(child, index) {
    return String(child?.id ?? child?.sessionId ?? child?.agentId ?? `child-${index}`);
}

function executionTask(task, index) {
    if (!task || typeof task !== 'object') return null;
    const subject = String(task.subject || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/(^|[\s"'([{=])((?:\/|[A-Za-z]:[\\/])(?:[^\s"'`<>()[\]{};,]+))/g, '$1[path]');
    if (!subject) return null;
    return {
        kind: 'task',
        type: 'task',
        id: `task:${String(task.id || index)}`,
        subject: subject.length > 120 ? `${subject.slice(0, 119).trimEnd()}…` : subject,
        status: executionStatus(task.status),
        owner: String(task.owner || task.assignee || '').trim(),
    };
}

function executionChildIsDone(child) {
    return !child?.isDeparted && EXECUTION_TASK_DONE_STATUSES.has(executionStatus(child?.status));
}

function executionChildIsUnknown(child) {
    return child?.isDeparted === true
        || !EXECUTION_CHILD_STATUSES.has(executionStatus(child?.status));
}

/**
 * Progress is exact only when a Claude task-store projection supplied it.
 * Otherwise count observed children, retaining prior IDs as unknown when a
 * child disappears. A departed child is not a completed child.
 */
export function deriveChildProgress(agent, children = [], { previousChildIds = [] } = {}) {
    const provider = String(agent?.provider || 'claude').toLowerCase();
    const supplied = agent?.taskProgress;
    const suppliedDone = Number(supplied?.done);
    const suppliedTotal = Number(supplied?.total);
    const hasExact = provider === 'claude'
        && supplied?.source === 'exact'
        && Number.isFinite(suppliedDone)
        && Number.isFinite(suppliedTotal)
        && suppliedDone >= 0
        && suppliedTotal >= suppliedDone
        && (suppliedTotal > 0 || !Array.isArray(children) || children.length === 0);
    if (hasExact) {
        return {
            done: Math.trunc(suppliedDone),
            total: Math.trunc(suppliedTotal),
            source: 'exact',
        };
    }

    const current = Array.isArray(children) ? children : [];
    const currentIds = new Set(current.map(executionChildId));
    const previousIds = new Set(
        (Array.isArray(previousChildIds) ? previousChildIds : [])
            .map(id => String(id || '').trim())
            .filter(Boolean),
    );
    const disappeared = [...previousIds].filter(id => !currentIds.has(id)).length;
    const hintedTotal = provider === 'claude' && supplied?.source === 'inferred'
        ? Math.max(0, Math.trunc(Number(supplied.total) || 0))
        : 0;
    const total = Math.max(current.length, currentIds.size + disappeared, hintedTotal);
    const done = Math.min(total, current.filter(executionChildIsDone).length);
    return {
        done,
        total,
        source: 'inferred',
        unknown: disappeared + current.filter(executionChildIsUnknown).length,
    };
}

function executionNodeAgent(child) {
    const id = String(child?.id ?? child?.sessionId ?? child?.agentId ?? '');
    return {
        kind: 'subagent',
        type: 'subagent',
        id,
        label: String(child?.name || child?.agentName || child?.agentId || id || 'Subagent'),
        agentType: String(child?.agentType || 'sub-agent'),
        subagentKind: child?.subagentKind || null,
        status: child?.isDeparted ? 'unknown' : executionStatus(child?.status),
        departed: child?.isDeparted === true,
        children: [],
    };
}

function executionOwnerMatches(node, owner) {
    if (!owner) return false;
    if (node.kind === 'subagent') {
        return [node.id, node.label, node.agentType, node.subagentKind]
            .filter(Boolean)
            .some(value => String(value) === owner);
    }
    return node.children.some(child => executionOwnerMatches(child, owner));
}

/**
 * Build the UI-safe hierarchy from the session fields already on Agent.
 * Claude gets subagent/workflow/task nodes; other providers intentionally
 * receive a counts-only shape.
 */
export function buildExecutionTree(agent, agents = [], options = {}) {
    const provider = String(agent?.provider || 'claude').toLowerCase();
    const rootId = String(agent?.id ?? agent?.sessionId ?? '');
    const children = (Array.isArray(agents) ? agents : []).filter((candidate) => (
        candidate
        && String(candidate.parentSessionId || '') === rootId
        && (candidate.isSubagent === true
            || Boolean(candidate.parentSessionId)
            || (candidate.agentType && candidate.agentType !== 'main'))
    ));
    const progress = deriveChildProgress(agent, children, options);
    if (provider !== 'claude') {
        return {
            kind: 'counts',
            type: 'counts',
            id: rootId,
            provider,
            progress,
            children: [],
            hasChildren: children.length > 0,
        };
    }

    const workflows = new Map();
    const nodes = [];
    for (const child of children) {
        const workflowKey = child.workflowId
            || (child.agentType === 'workflow-subagent'
                ? child.workflowName || child.subagentKind || 'workflow'
                : null);
        if (!workflowKey) {
            nodes.push(executionNodeAgent(child));
            continue;
        }
        const key = String(workflowKey);
        let workflow = workflows.get(key);
        if (!workflow) {
            workflow = {
                kind: 'workflow',
                type: 'workflow',
                id: `workflow:${key}`,
                label: String(child.workflowName || child.subagentKind || child.workflowId || 'Workflow'),
                children: [],
            };
            workflows.set(key, workflow);
            nodes.push(workflow);
        }
        workflow.children.push(executionNodeAgent(child));
    }

    const taskNodes = (Array.isArray(agent?.tasks) ? agent.tasks : [])
        .slice(0, EXECUTION_TASK_LIMIT)
        .map(executionTask)
        .filter(Boolean);
    for (const task of taskNodes) {
        const owner = task.owner;
        const ownerNode = nodes.find(node => executionOwnerMatches(node, owner));
        if (ownerNode) {
            const target = ownerNode.kind === 'workflow'
                ? ownerNode.children.find(child => executionOwnerMatches(child, owner)) || ownerNode
                : ownerNode;
            target.children.push(task);
        } else {
            nodes.push(task);
        }
        delete task.owner;
    }

    return {
        kind: 'session',
        type: 'session',
        id: rootId,
        provider,
        label: String(agent?.name || agent?.agentName || rootId || 'Session'),
        progress,
        children: nodes,
        hasChildren: nodes.length > 0,
    };
}


function healthCounterText(bucket, count) {
    const label = SECTION_HEALTH_PRESENTATION[bucket].label;
    return `${count} ${bucket === 'errors' && count !== 1 ? `${label}s` : label}`;
}

function healthDescription(bucket, count) {
    const agentNoun = count === 1 ? 'agent' : 'agents';
    const descriptions = {
        errors: `${count} errored ${agentNoun}`,
        needsYou: `${count} blocked ${agentNoun} waiting for your input`,
        quota: `${count} rate-limited ${agentNoun}`,
        working: `${count} working ${agentNoun}`,
        watchlist: `${count} waiting ${agentNoun} on the watchlist`,
        idle: `${count} idle or completed ${agentNoun}`,
    };
    return descriptions[bucket];
}

function hasOpenSurface(documentRef = globalThis.document) {
    const modal = documentRef?.getElementById?.('modalOverlay');
    if (modal?.getAttribute?.('aria-hidden') === 'false') return true;

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
                // Older engines do not know :popover-open; use the fallback
                // state below for test doubles and older native implementations.
            }
        }
        return popover.hasAttribute?.('open') === true || popover.open === true;
    });
}

// 1.8 — dashboard ambience follows the same local clock as the World sky.
// Phase resolution (bounds + seasonal day-length offsets) is shared with the
// world-side atmosphere stack via phaseNameForDate, so the two clocks cannot
// drift. Static per phase (no motion), re-stamped at minute scale.
const AMBIENCE_TINTS = Object.freeze({
    dawn: { tint: 'rgba(255, 196, 138, 0.05)', hearth: 'rgba(255, 176, 102, 0.15)' },
    day: { tint: 'rgba(255, 226, 138, 0.02)', hearth: 'rgba(245, 171, 75, 0.13)' },
    dusk: { tint: 'rgba(214, 120, 64, 0.06)', hearth: 'rgba(240, 140, 60, 0.16)' },
    // Cooler parchment after dark: steel-blue veil + dimmer, cooler hearth.
    night: { tint: 'rgba(104, 132, 190, 0.08)', hearth: 'rgba(122, 108, 168, 0.10)' },
});
const AMBIENCE_SYNC_INTERVAL = 60_000;

export class DashboardRenderer {
    constructor(world, { toast = null } = {}) {
        this.world = world;
        this.toast = toast;
        this.gridEl = document.getElementById('dashboardGrid');
        this.attentionEl = document.getElementById('dashboardAttentionQueue');
        this.emptyEl = document.getElementById('dashboardEmpty');
        this._appendEmptyHints();
        this.cards = new Map();
        this.toolHistories = new Map();
        this.usageFooters = new Map();
        this.toolHistoryRenderSignatures = new Map();
        this._cardRenderSignatures = new Map();
        this._executionChildIdsByParent = new Map();
        this._selectedAgentId = null;
        this._focusedAgentId = null;
        this._attentionCursor = 0;
        this._statusFilters = new Set();
        this._providerFilters = new Set();
        this._searchQuery = '';
        this._searchMatches = null;
        this._searchContexts = new Map();
        this._stableAgentOrder = new Map();
        this._stableProjectOrder = new Map();
        this._nextStableAgentOrder = 0;
        this._nextStableProjectOrder = 0;
        this._controlsSignature = '';
        this._filteredEmptyEl = null;
        this.active = false;
        this._destroyed = false;
        this._isFetchingDetails = false;
        this._detailFetchGeneration = 0;
        this._sectionEls = new Map(); // projectPath → section element
        this._pendingAvatarDraws = new Set();
        this._avatarDrawFrame = null;
        this._ambienceEl = document.getElementById('dashboardMode');
        this._ambiencePhase = '';
        this._ambienceTimer = null;
        this._flipTimers = new Set();
        this._motionQuery = typeof window !== 'undefined'
            ? window.matchMedia?.('(prefers-reduced-motion: reduce)')
            : null;
        this.selection = new AgentSelectionMirror({
            notifyOnRepeat: true,
            onChange: (nextId, previousId) => {
                this._selectedAgentId = nextId;
                this._syncSelectionControls(nextId, previousId);
                if (this.active) void this._fetchAllDetails();
            },
        });

        this._onAgentAdded = () => { if (this.active) this.render(); };
        this._onAgentUpdated = (agent) => {
            if (this.active) {
                this._renderAgentUpdate(agent);
                const parentId = String(agent?.parentSessionId || '');
                const parent = parentId ? this.world.agents.get(parentId) : null;
                const parentCard = parentId ? this.cards.get(parentId) : null;
                if (parent && parentCard) this._updateChildProgress(parentCard, parent);
                this._renderAttentionQueue(Array.from(this.world.agents.values()));
            }
        };
        this._onAgentRemoved = (agent) => {
            this._executionChildIdsByParent.delete(String(agent.id));
            sessionDetailsService.deleteForAgent(agent);
            if (this.active) this.render();
        };
        this._onModeChanged = (mode) => {
            this.active = mode === 'dashboard';
            if (this.active) {
                this.render();
                this._startDetailFetching();
                this._startAmbienceSync();
            } else {
                this._stopDetailFetching();
                this._stopAmbienceSync();
            }
        };
        // Pause detail polling while the tab is hidden; refresh once on return.
        this._onVisibilityChange = () => {
            if (document.hidden || !this.active) return;
            this._fetchAllDetails();
            this._syncAmbience();
        };
        this._onDashboardKeyDown = (event) => this._handleDashboardKeyboardCommand(event);
        this._onDashboardFocusIn = (event) => {
            const select = event.target?.closest?.('.dash-card__select');
            const card = select?.closest?.('.dash-card');
            if (!card?.dataset?.agentId) return;
            this._focusedAgentId = card.dataset.agentId;
            this._syncCardTabStops();
        };
        this._onSharedFilterChanged = (payload = {}) => {
            this._searchQuery = String(payload.query || '').trim().toLowerCase();
            const matches = Array.isArray(payload.matches) ? payload.matches : [];
            this._searchMatches = this._searchQuery
                ? new Set(matches.map(match => String(match.agentId)))
                : null;
            this._searchContexts = new Map(matches
                .filter(match => match?.context)
                .map(match => [String(match.agentId), String(match.context)]));
            if (this.active) this.render();
        };
        eventBus.on('agent:added', this._onAgentAdded);
        eventBus.on('agent:updated', this._onAgentUpdated);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on('mode:changed', this._onModeChanged);
        eventBus.on(DASHBOARD_FILTER_EVENT, this._onSharedFilterChanged);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
        window.addEventListener('keydown', this._onDashboardKeyDown);
        this.gridEl?.addEventListener('focusin', this._onDashboardFocusIn);
        eventBus.emit(DASHBOARD_FILTER_REQUEST_EVENT);
    }

    render() {
        const agents = Array.from(this.world.agents.values());
        this._rememberStableOrder(agents);
        this._renderAttentionQueue(agents);

        if (agents.length === 0) {
            this._detailFetchGeneration++;
            this._clearAllCardsAndSections();
            this.gridEl.style.display = 'none';
            this.emptyEl.classList.add('dashboard__empty--visible');
            sessionDetailsService.sweep([]);
            return;
        }

        this.gridEl.style.display = '';
        this.emptyEl.classList.remove('dashboard__empty--visible');
        const visibleAgents = this._filteredAgents(agents);
        this._setFilteredEmpty(visibleAgents.length === 0);

        const groups = [...groupAgentsByProject(visibleAgents)];
        this._sortProjectGroups(groups);

        const existingIds = new Set();
        const existingSections = new Set();

        for (const [projectPath, groupAgents] of groups) {
            existingSections.add(projectPath);
            this._sortAgentsExceptionFirst(groupAgents);

            // Create/get section element
            let sectionEl = this._sectionEls.get(projectPath);
            if (!sectionEl) {
                sectionEl = this._createSection(projectPath);
                this._sectionEls.set(projectPath, sectionEl);
            }
            this.gridEl.appendChild(sectionEl);
            this._updateSectionHeader(sectionEl, projectPath, groupAgents);

            const gridInner = sectionEl._sectionRefs?.grid || sectionEl.querySelector('.dashboard__section-grid');

            const orderedCards = [];
            for (const agent of groupAgents) {
                existingIds.add(agent.id);
                let cardEl = this.cards.get(agent.id);

                if (!cardEl) {
                    cardEl = this._createCard(agent);
                    this.cards.set(agent.id, cardEl);
                }

                // Move the card if it is not in this section
                if (cardEl.parentElement !== gridInner) {
                    gridInner.appendChild(cardEl);
                }
                orderedCards.push(cardEl);

                this._updateCard(cardEl, agent);
            }

            // 4.3 — keep DOM order in sync with the status sort, FLIP-animated.
            this._placeCardsInOrder(gridInner, orderedCards);
        }

        // Remove missing agent cards
        for (const [id, cardEl] of this.cards) {
            if (!existingIds.has(id)) {
                this._removeCard(id, { removeEmptySection: false });
            }
        }

        // Remove missing sections
        for (const [path, sectionEl] of this._sectionEls) {
            if (!existingSections.has(path)) {
                if (sectionEl._erroredFlashTimer) clearTimeout(sectionEl._erroredFlashTimer);
                sectionEl.remove();
                this._sectionEls.delete(path);
            }
        }
        sessionDetailsService.sweep(agents);
        this._syncCardTabStops();
    }

    _rememberStableOrder(agents) {
        const liveIds = new Set();
        const liveProjects = new Set();
        for (const agent of agents) {
            liveIds.add(String(agent.id));
            const project = agent.projectPath || '_unknown';
            liveProjects.add(project);
            if (!this._stableAgentOrder.has(String(agent.id))) {
                this._stableAgentOrder.set(String(agent.id), this._nextStableAgentOrder++);
            }
            if (!this._stableProjectOrder.has(project)) {
                this._stableProjectOrder.set(project, this._nextStableProjectOrder++);
            }
        }
        for (const id of this._stableAgentOrder.keys()) {
            if (!liveIds.has(id)) this._stableAgentOrder.delete(id);
        }
        for (const project of this._stableProjectOrder.keys()) {
            if (!liveProjects.has(project)) this._stableProjectOrder.delete(project);
        }
    }

    _filteredAgents(agents) {
        return agents.filter(agent => {
            if (this._searchMatches && !this._searchMatches.has(String(agent.id))) return false;
            if (this._statusFilters.size) {
                const bucket = bucketForStatus(agent.status);
                if (!this._statusFilters.has(bucket)) return false;
            }
            if (this._providerFilters.size
                && !this._providerFilters.has(String(agent.provider || 'claude').toLowerCase())) return false;
            return true;
        });
    }

    _sortAgentsExceptionFirst(agents) {
        agents.sort((a, b) => {
            const rankDelta = rowExceptionRank(a) - rowExceptionRank(b);
            if (rankDelta) return rankDelta;
            const waitDelta = rowWaitAnchor(a) - rowWaitAnchor(b);
            if (waitDelta) return waitDelta;
            return (this._stableAgentOrder.get(String(a.id)) ?? 0)
                - (this._stableAgentOrder.get(String(b.id)) ?? 0);
        });
        return agents;
    }

    _sortProjectGroups(groups) {
        const projectRank = ([, agents]) => Math.min(
            ...agents.map(rowExceptionRank),
        );
        const projectWait = ([, agents]) => Math.min(
            ...agents.map(rowWaitAnchor).filter(Boolean),
            Number.MAX_SAFE_INTEGER,
        );
        groups.sort((a, b) => projectRank(a) - projectRank(b)
            || projectWait(a) - projectWait(b)
            || (this._stableProjectOrder.get(a[0]) ?? 0) - (this._stableProjectOrder.get(b[0]) ?? 0));
    }

    _setFilteredEmpty(visible) {
        if (!this.gridEl) return;
        if (!this._filteredEmptyEl) {
            this._filteredEmptyEl = document.createElement('div');
            this._filteredEmptyEl.className = 'dashboard__filtered-empty';
            this._filteredEmptyEl.textContent = 'No agents match the active filters';
            this.gridEl.appendChild(this._filteredEmptyEl);
        }
        this._filteredEmptyEl.hidden = !visible;
    }

    _renderAgentUpdate(agent) {
        const cardEl = this.cards.get(agent.id);
        const projectPath = agent.projectPath || '_unknown';
        const status = normalizeStatus(agent.status);
        if (!cardEl || cardEl._projectPath !== projectPath || cardEl._status !== status) {
            this.render();
            return;
        }
        this._updateCard(cardEl, agent);
    }

    // 4.3 — FLIP: keep each section's cards in status-sort order. When the
    // order actually changed (a status transition re-sorted the section),
    // cards that existed before the move glide to their new slots; newly
    // created cards have no "first" rect and simply appear. Reduced motion
    // (or an inactive dashboard) skips the animation — the reorder is an
    // instant cut. Rects are read only when an order change is detected.
    _placeCardsInOrder(gridEl, orderedCards) {
        if (!gridEl || orderedCards.length < 2) return;
        const cardSet = new Set(orderedCards);
        let index = 0;
        let orderChanged = false;
        for (const child of gridEl.children) {
            if (!cardSet.has(child)) continue;
            if (child !== orderedCards[index]) { orderChanged = true; break; }
            index++;
        }
        if (!orderChanged && index === orderedCards.length) return;

        const canAnimate = this.active && !this._destroyed && !(this._motionQuery?.matches);
        const firstRects = new Map();
        if (canAnimate) {
            for (const card of orderedCards) {
                if (card.parentElement === gridEl) firstRects.set(card, card.getBoundingClientRect());
            }
        }

        for (const card of orderedCards) gridEl.appendChild(card);
        if (!canAnimate || firstRects.size === 0) return;

        const moved = [];
        for (const [card, first] of firstRects) {
            const last = card.getBoundingClientRect();
            const dx = first.left - last.left;
            const dy = first.top - last.top;
            if (!dx && !dy) continue;
            card.style.transition = 'none';
            card.style.transform = `translate(${dx}px, ${dy}px)`;
            moved.push(card);
        }
        if (moved.length === 0) return;

        void gridEl.offsetWidth; // single reflow so the inverted offsets apply
        for (const card of moved) {
            card.style.transition = 'transform 240ms ease';
            card.style.transform = '';
            const timer = setTimeout(() => {
                this._flipTimers.delete(timer);
                card.style.transition = '';
            }, 280);
            this._flipTimers.add(timer);
        }
    }

    // 1.8 — ambience sync: stamp --cv-ambient-tint / --cv-ambient-hearth on the
    // dashboard container from the local-clock phase, re-checked once a minute
    // while dashboard mode is active. Static tints (no motion), so no
    // reduced-motion fallback is required.
    _startAmbienceSync() {
        this._stopAmbienceSync();
        this._syncAmbience();
        this._ambienceTimer = setInterval(() => this._syncAmbience(), AMBIENCE_SYNC_INTERVAL);
    }

    _stopAmbienceSync() {
        if (this._ambienceTimer) {
            clearInterval(this._ambienceTimer);
            this._ambienceTimer = null;
        }
    }

    _syncAmbience(now = new Date()) {
        if (!this._ambienceEl || this._destroyed) return;
        const phase = this._ambiencePhaseFor(now);
        if (phase === this._ambiencePhase) return;
        this._ambiencePhase = phase;
        const tints = AMBIENCE_TINTS[phase] || AMBIENCE_TINTS.day;
        this._ambienceEl.style.setProperty('--cv-ambient-tint', tints.tint);
        this._ambienceEl.style.setProperty('--cv-ambient-hearth', tints.hearth);
    }

    _ambiencePhaseFor(date) {
        return phaseNameForDate(date);
    }

    _createSection(projectPath) {
        const section = document.createElement('div');
        section.className = 'dashboard__section';
        section.dataset.project = projectPath;

        const profile = projectProfile(projectPath);
        section.innerHTML = `
            <div class="dashboard__section-header" style="border-left-color: ${profile.panelBorder || profile.accent}; background: ${profile.panel}">
                <span class="dashboard__section-dot" style="background: ${profile.accent}; box-shadow: 0 0 8px ${profile.glow}"></span>
                <span class="dashboard__label-icon">#</span>
                <span class="dashboard__section-name" style="color: ${profile.labelText || profile.accent}"></span>
                <span class="dashboard__section-path"></span>
                <span class="dashboard__section-health" aria-label="Project health"></span>
                <span class="dashboard__section-count" style="color: ${profile.labelText || profile.accent}"></span>
            </div>
            <div class="dashboard__section-healthbar" aria-hidden="true">
                ${SECTION_HEALTH_ORDER.map(bucket => {
                    const className = SECTION_HEALTH_PRESENTATION[bucket].className;
                    return `<span class="dashboard__healthbar-seg dashboard__healthbar-seg--${className}" style="display: none"></span>`;
                }).join('')}
            </div>
            <div class="dashboard__section-grid"></div>
        `;
        const health = section.querySelector('.dashboard__section-health');
        section._sectionRefs = {
            name: section.querySelector('.dashboard__section-name'),
            path: section.querySelector('.dashboard__section-path'),
            count: section.querySelector('.dashboard__section-count'),
            grid: section.querySelector('.dashboard__section-grid'),
            health,
            healthStats: Object.fromEntries(SECTION_HEALTH_ORDER.map(bucket => {
                const className = SECTION_HEALTH_PRESENTATION[bucket].className;
                const stat = document.createElement('span');
                stat.className = `dashboard__health-stat dashboard__health-stat--${className}`;
                stat.style.display = 'none';
                stat.setAttribute('aria-hidden', 'true');
                health.appendChild(stat);
                return [bucket, stat];
            })),
            healthBars: Object.fromEntries(SECTION_HEALTH_ORDER.map(bucket => {
                const className = SECTION_HEALTH_PRESENTATION[bucket].className;
                return [bucket, section.querySelector(`.dashboard__healthbar-seg--${className}`)];
            })),
        };
        section._trueErrorCount = 0;
        return section;
    }

    _updateSectionHeader(sectionEl, projectPath, agents) {
        const refs = sectionEl._sectionRefs;
        const name = shortProjectName(projectPath, i18n.t('unknownProject'));
        refs.name.textContent = name;
        refs.count.textContent = i18n.t('nAgents')(agents.length);

        // Display shortened path
        const shortPath = projectPath === '_unknown' ? '' : shortenHomePath(projectPath);
        refs.path.textContent = shortPath;

        this._updateSectionHealth(sectionEl, refs, agents);
    }

    // Health rollup: six SignalLedger buckets for the section's agents.
    _updateSectionHealth(sectionEl, refs, agents) {
        const counts = sectionHealthCounts(agents);
        const orderedBuckets = nonZeroSectionHealthBuckets(counts);
        const visibleBuckets = new Set(orderedBuckets);
        const descriptions = orderedBuckets.map(bucket => healthDescription(bucket, counts[bucket]));
        refs.health.title = descriptions.join('; ');
        refs.health.setAttribute('aria-label', `Project health: ${descriptions.join('; ')}`);
        for (const bucket of SECTION_HEALTH_ORDER) {
            const el = refs.healthStats[bucket];
            const count = counts[bucket];
            if (!el) continue;
            if (visibleBuckets.has(bucket)) {
                this._setText(el, healthCounterText(bucket, count));
                const description = healthDescription(bucket, count);
                el.title = description;
                el.dataset.separator = String(bucket !== orderedBuckets.at(-1));
                el.setAttribute('aria-label', description);
                el.setAttribute('aria-hidden', 'false');
                this._setStyle(el, 'display', '');
            } else {
                this._setText(el, '');
                el.title = '';
                el.removeAttribute('data-separator');
                el.removeAttribute('aria-label');
                el.setAttribute('aria-hidden', 'true');
                this._setStyle(el, 'display', 'none');
            }
        }

        // #44 — composite health pulse-bar: 2px segments sized by the same
        // six counts, with a one-shot red edge-flash only for a new true error.
        for (const bucket of SECTION_HEALTH_ORDER) {
            const segment = refs.healthBars[bucket];
            if (!segment) continue;
            this._setStyle(segment, 'flexGrow', String(counts[bucket]));
            this._setStyle(segment, 'display', visibleBuckets.has(bucket) ? '' : 'none');
        }

        if (counts.errors > (sectionEl._trueErrorCount || 0)
            && agents.some(agent => shouldFlashForStatus(agent.status))) {
            this._flashSectionErrored(sectionEl);
        }
        sectionEl._trueErrorCount = counts.errors;
    }

    _flashSectionErrored(sectionEl) {
        sectionEl.classList.remove('dashboard__section--errored-flash');
        void sectionEl.offsetWidth;
        sectionEl.classList.add('dashboard__section--errored-flash');
        clearTimeout(sectionEl._erroredFlashTimer);
        sectionEl._erroredFlashTimer = setTimeout(() => {
            sectionEl.classList.remove('dashboard__section--errored-flash');
            sectionEl._erroredFlashTimer = null;
        }, 600);
    }

    _createCard(agent) {
        const card = document.createElement('div');
        card.className = `dash-card dash-card--${agent.status}`;
        card.dataset.agentId = agent.id;

        card.innerHTML = `
            <button type="button" class="dash-card__select dash-card__row">
                <span class="dash-card__status">
                    <span class="dash-card__status-dot"></span>
                    <span class="dash-card__status-label"></span>
                    <span class="dash-card__status-elapsed"></span>
                </span>
                <span class="dash-card__identity">
                    <span class="dash-card__name"></span>
                    <span class="dash-card__role"></span>
                </span>
                <span class="dash-card__model-cell">
                    <span class="dash-card__provider-badge"></span>
                    <span class="dash-card__model"></span>
                    <span class="dash-card__signal-source"></span>
                </span>
                <span class="dash-card__row-cell dash-card__phase-cell">
                    <span class="dash-card__row-label">PHASE / TOOL</span>
                    <span class="dash-card__row-value dash-card__phase"></span>
                    <span class="dash-card__row-detail dash-card__phase-detail"></span>
                </span>
                <span class="dash-card__row-cell dash-card__blocker-cell">
                    <span class="dash-card__row-label">BLOCKER</span>
                    <span class="dash-card__row-value dash-card__blocker"></span>
                    <span class="dash-card__row-detail dash-card__prompt-detail"></span>
                </span>
                <span class="dash-card__row-cell dash-card__work-cell">
                    <span class="dash-card__row-label">WORKING SET</span>
                    <span class="dash-card__row-value dash-card__work-summary"></span>
                </span>
                <span class="dash-card__usage">
                    <span class="dash-card__usage-tokens"></span>
                    <span class="dash-card__usage-cost"></span>
                    <span class="dash-card__usage-source"></span>
                </span>
                <span class="dash-card__row-cell dash-card__children-cell">
                    <span class="dash-card__row-label">CHILDREN</span>
                    <span class="dash-card__row-value dash-card__children"></span>
                    <span class="dash-card__children-source"></span>
                </span>
                <span class="dash-card__search-context" style="display: none"></span>
            </button>
            <div class="dash-card__detail" aria-hidden="true">
                <div class="dash-card__header">
                    <span class="dash-card__building-emblem" aria-hidden="true" style="display: none"></span>
                    <span class="dash-card__avatar"></span>
                    <span class="dash-card__info">
                        <span class="dash-card__meta">
                            <span class="dash-card__workflow-badge"></span>
                            <span class="dash-card__team-badge" style="display: none"></span>
                            <span class="dash-card__activity-age" style="display: none"></span>
                        </span>
                    </span>
                    <button type="button" class="dash-card__parent-chip" style="display: none"></button>
                    <button type="button" class="dash-card__copy-id" title="Copy session ID" aria-label="Copy session ID">ID</button>
                    <span class="dash-card__stale-badge" style="display: none" title="Showing cached data; latest refresh did not complete">STALE</span>
                </div>
                <div class="dash-card__activity">
                    <div class="dash-card__current-tool">
                        <span class="dash-card__tool-icon"></span>
                        <div class="dash-card__tool-info">
                            <div class="dash-card__tool-name"></div>
                            <div class="dash-card__tool-detail"></div>
                        </div>
                    </div>
                    <div class="dash-card__message"></div>
                    <div class="dash-card__working-set"></div>
                </div>
                <div class="dash-card__tools">
                    <div class="dash-card__tools-title">${i18n.t('toolHistory')}</div>
                    <div class="dash-card__tool-list">
                        <div class="dash-card__skeleton" aria-hidden="true">
                            <span class="dash-card__skeleton-line"></span>
                            <span class="dash-card__skeleton-line"></span>
                            <span class="dash-card__skeleton-line"></span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        card.dataset.loading = 'true';

        // Avatar canvas
        const avatarContainer = card.querySelector('.dash-card__avatar');
        const avatarCanvas = new AvatarCanvas(agent);
        avatarContainer.appendChild(avatarCanvas.canvas);
        card._avatarCanvas = avatarCanvas;
        card._avatarSignature = '';

        // Copy session ID without triggering card selection
        const copyBtn = card.querySelector('.dash-card__copy-id');
        copyBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._copyAgentId(card.dataset.agentId);
        });

        const parentChip = card.querySelector('.dash-card__parent-chip');
        const selectParent = (event) => {
            event.stopPropagation();
            const parentId = parentChip.dataset.parentId;
            if (!parentId || parentChip.classList.contains('dash-card__parent-chip--muted')) return;
            const parent = this.world.agents.get(parentId);
            if (!parent) return;
            emitAgentSelected(parent);
            const parentCard = this.cards.get(parent.id);
            if (parentCard) {
                parentCard.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                this._flashParentCard(parentCard);
            }
        };
        parentChip.addEventListener('click', selectParent);
        const selectBtn = card.querySelector('.dash-card__select');
        selectBtn.tabIndex = -1;
        selectBtn.addEventListener('click', () => {
            const current = this.world.agents.get(card.dataset.agentId);
            emitAgentSelected(current);
        });
        selectBtn.setAttribute('aria-pressed', String(this.selection.isSelected(agent.id)));

        card._elements = {
            select: selectBtn,
            name: card.querySelector('.dash-card__name'),
            model: card.querySelector('.dash-card__model'),
            workflowBadge: card.querySelector('.dash-card__workflow-badge'),
            parentChip: card.querySelector('.dash-card__parent-chip'),
            teamBadge: card.querySelector('.dash-card__team-badge'),
            role: card.querySelector('.dash-card__role'),
            activityAge: card.querySelector('.dash-card__activity-age'),
            providerBadge: card.querySelector('.dash-card__provider-badge'),
            status: card.querySelector('.dash-card__status'),
            statusLabel: card.querySelector('.dash-card__status-label'),
            statusElapsed: card.querySelector('.dash-card__status-elapsed'),
            signalSource: card.querySelector('.dash-card__signal-source'),
            staleBadge: card.querySelector('.dash-card__stale-badge'),
            detail: card.querySelector('.dash-card__detail'),
            phase: card.querySelector('.dash-card__phase'),
            phaseDetail: card.querySelector('.dash-card__phase-detail'),
            blocker: card.querySelector('.dash-card__blocker'),
            promptDetail: card.querySelector('.dash-card__prompt-detail'),
            workSummary: card.querySelector('.dash-card__work-summary'),
            childrenSource: card.querySelector('.dash-card__children-source'),
            children: card.querySelector('.dash-card__children'),
            searchContext: card.querySelector('.dash-card__search-context'),
            currentTool: card.querySelector('.dash-card__current-tool'),
            toolIcon: card.querySelector('.dash-card__tool-icon'),
            toolName: card.querySelector('.dash-card__tool-name'),
            toolDetail: card.querySelector('.dash-card__tool-detail'),
            message: card.querySelector('.dash-card__message'),
            workingSet: card.querySelector('.dash-card__working-set'),
            tools: card.querySelector('.dash-card__tools'),
            toolList: card.querySelector('.dash-card__tool-list'),
            usage: card.querySelector('.dash-card__usage'),
            usageTokens: card.querySelector('.dash-card__usage-tokens'),
            usageCost: card.querySelector('.dash-card__usage-cost'),
            usageSource: card.querySelector('.dash-card__usage-source'),
            buildingEmblem: card.querySelector('.dash-card__building-emblem'),
        };
        card._elapsedUnsubscribe = subscribeElapsedText(card._elements.statusElapsed, () => {
            const current = this.world.agents.get(card.dataset.agentId);
            const text = current ? formatStatusElapsed(current) : '';
            return text ? ` · ${text}` : '';
        });

        return card;
    }

    _renderAttentionQueue(agents) {
        if (!this.attentionEl) return;
        const buckets = bucketAgents(agents);
        const counts = bucketCounts(buckets);
        const providers = [...new Set(agents.map(agent => String(agent.provider || 'claude').toLowerCase()))]
            .sort((a, b) => a.localeCompare(b));
        const providerCounts = Object.fromEntries(providers.map(provider => [
            provider,
            agents.filter(agent => String(agent.provider || 'claude').toLowerCase() === provider).length,
        ]));
        const signature = JSON.stringify({
            counts: ROW_STATUS_FILTERS.map(({ key }) => counts[key] || 0),
            providerCounts,
            status: [...this._statusFilters].sort(),
            provider: [...this._providerFilters].sort(),
            search: this._searchQuery,
            matches: this._searchMatches?.size ?? agents.length,
        });
        this.attentionEl.hidden = false;
        if (signature === this._controlsSignature) return;
        this._controlsSignature = signature;

        const focusedKey = this.attentionEl.contains(document.activeElement)
            ? document.activeElement?.dataset?.filterKey
            : null;
        const heading = document.createElement('div');
        heading.className = 'dashboard-attention__heading';
        heading.textContent = `EXCEPTIONS FIRST · ${counts.actionable} NEED ACTION`;
        const list = document.createElement('div');
        list.className = 'dashboard-attention__list';
        for (const { key, label } of ROW_STATUS_FILTERS) {
            list.appendChild(this._filterButton({
                key: `status:${key}`,
                label: `${label} ${counts[key] || 0}`,
                pressed: this._statusFilters.has(key),
                onClick: () => {
                    if (this._statusFilters.has(key)) this._statusFilters.delete(key);
                    else this._statusFilters.add(key);
                    this._controlsSignature = '';
                    this.render();
                },
            }));
        }
        const providerLabel = document.createElement('span');
        providerLabel.className = 'dashboard-attention__provider-label';
        providerLabel.textContent = 'Provider';
        list.appendChild(providerLabel);
        for (const provider of providers) {
            list.appendChild(this._filterButton({
                key: `provider:${provider}`,
                label: `${providerPresentation(provider).badge.label} ${providerCounts[provider]}`,
                pressed: this._providerFilters.has(provider),
                onClick: () => {
                    if (this._providerFilters.has(provider)) this._providerFilters.delete(provider);
                    else this._providerFilters.add(provider);
                    this._controlsSignature = '';
                    this.render();
                },
            }));
        }
        if (this._statusFilters.size || this._providerFilters.size) {
            list.appendChild(this._filterButton({
                key: 'clear',
                label: 'Clear filters',
                pressed: false,
                onClick: () => {
                    this._statusFilters.clear();
                    this._providerFilters.clear();
                    this._controlsSignature = '';
                    this.render();
                },
            }));
        }
        if (this._searchQuery) {
            const search = document.createElement('span');
            search.className = 'dashboard-attention__search';
            search.textContent = `Search "${truncateText(this._searchQuery, 32)}" · ${this._searchMatches?.size || 0} matches`;
            list.appendChild(search);
        }
        replaceChildren(this.attentionEl, [heading, list]);
        if (focusedKey) {
            [...this.attentionEl.querySelectorAll('[data-filter-key]')]
                .find(button => button.dataset.filterKey === focusedKey)
                ?.focus({ preventScroll: true });
        }
    }

    _filterButton({ key, label, pressed, onClick }) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dashboard-attention__item';
        button.dataset.filterKey = key;
        button.setAttribute('aria-pressed', String(pressed));
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    _updateCard(cardEl, agent) {
        const refs = cardEl._elements;
        const status = normalizeStatus(agent.status);
        const model = modelPresentation(agent);
        const provider = providerPresentation(agent.provider, model.identity);
        const statusInfo = statusPresentation(status, i18n);
        const building = buildingClassForAgent(agent);
        const signature = [
            building || '',
            agent.name || '',
            agent.model || '',
            agent.effort || '',
            agent.provider || '',
            agent.role || '',
            agent.workflowName || '',
            agent.parentSessionId || '',
            agent.teamName || '',
            status,
            agent.waitReason || '',
            agent.signalSource || '',
            agent.signalCertainty || '',
            agent.signalStale || false,
            agent.turnState || '',
            safePromptDetail(agent),
            agent.pendingTool || '',
            agent.currentTool || '',
            agent.currentToolInput || '',
            agent.lastMessage || '',
            i18n.lang || '',
        ].join('|');

        cardEl._projectPath = agent.projectPath || '_unknown';
        cardEl._status = status;
        if (this._cardRenderSignatures.get(agent.id) !== signature) {
            this._cardRenderSignatures.set(agent.id, signature);

            const selectedClass = this.selection.isSelected(agent.id) ? ' dash-card--selected' : '';
            const nextClass = `dash-card dash-card--${status}${selectedClass}`;
            if (cardEl.className !== nextClass) cardEl.className = nextClass;
            refs.select.setAttribute('aria-label', `Select agent ${agent.name || agent.id}, ${statusInfo.label}`);
            refs.select.setAttribute('aria-pressed', String(this.selection.isSelected(agent.id)));
            refs.select.setAttribute('aria-expanded', String(this.selection.isSelected(agent.id)));
            refs.detail?.setAttribute('aria-hidden', String(!this.selection.isSelected(agent.id)));

            this._setText(refs.name, agent.name);
            this._setText(refs.model, model.label);
            this._setStyle(refs.model, 'color', model.color);
            refs.model.title = model.title;

            // Workflow swarm members read as one unit via a shared workflow chip;
            // it stands in for the generic 'workflow-subagent' role text.
            if (agent.workflowName) {
                this._setText(refs.workflowBadge, `⚙ ${agent.workflowName}`);
                refs.workflowBadge.title = `Workflow: ${agent.workflowName}`;
                this._setStyle(refs.workflowBadge, 'display', '');
                this._setText(refs.role, '');
            } else {
                this._setStyle(refs.workflowBadge, 'display', 'none');
                this._setText(refs.role, agent.role || '');
            }

            if (agent.teamName) {
                const team = getTeamColor(agent.teamName);
                this._setText(refs.teamBadge, `⚑ ${shortTeamName(agent.teamName)}`);
                refs.teamBadge.title = `Team: ${agent.teamName}`;
                this._setStyle(refs.teamBadge, 'color', team.accent);
                this._setStyle(refs.teamBadge, 'borderColor', team.glow);
                this._setStyle(refs.teamBadge, 'background', team.panel);
                this._setStyle(refs.teamBadge, 'display', '');
            } else {
                this._setStyle(refs.teamBadge, 'display', 'none');
            }

            const badge = provider.badge;
            this._setText(refs.providerBadge, badge.label);
            this._setStyle(refs.providerBadge, 'color', badge.color);
            this._setStyle(refs.providerBadge, 'background', badge.bg);
            this._setText(refs.signalSource, waitProvenance(agent));
            refs.signalSource.title = signalProvenance(agent);

            const nextStatusClass = `dash-card__status dash-card__status--${status}`;
            if (refs.status.className !== nextStatusClass) refs.status.className = nextStatusClass;
            const reason = waitReasonLabel(agent);
            this._setText(refs.statusLabel, operatorStatusLabel(status));
            refs.status.title = reason ? `${statusInfo.label} — ${reason}` : '';

            const tool = currentToolPresentation(agent, i18n);
            refs.currentTool.classList.toggle('dash-card__current-tool--idle', tool.isIdle);
            refs.toolIcon.replaceChildren(pixelIcon(toolCategory(agent.currentTool)));
            this._setText(refs.toolName, tool.name);
            replaceDetailRows(refs.toolDetail, tool.detail ? [inspectableText(tool.detail, { summary: formatToolDetail(tool.detail, { max: 80 }), key: 'current-tool' })] : []);
            this._setText(refs.phase, rowPhase(agent));
            this._setText(refs.phaseDetail, formatToolDetail(tool.detail, {
                max: 54,
                projectPath: agent.projectPath || '',
            }));
            refs.phaseDetail.title = tool.detail || '';

            const promptDetail = safePromptDetail(agent);
            const blocker = reason
                || (status === 'waiting_on_user' ? 'Waiting for input' : '')
                || (status === 'errored' ? 'Session error' : '')
                || (status === 'rate_limited' ? 'Quota limit' : '')
                || '—';
            this._setText(refs.blocker, blocker);
            refs.blocker.title = blocker === '—' ? 'No blocker observed' : blocker;
            this._setText(refs.promptDetail, promptDetail);
            refs.promptDetail.title = promptDetail;
            refs.blocker.parentElement?.classList.toggle(
                'dash-card__blocker-cell--active',
                Boolean(reason || ['waiting_on_user', 'errored', 'rate_limited'].includes(status)),
            );

            const searchContext = this._searchContexts.get(String(agent.id)) || '';
            this._setText(refs.searchContext, searchContext);
            this._setStyle(refs.searchContext, 'display', searchContext ? '' : 'none');

            if (agent.lastMessage) {
                replaceDetailRows(refs.message, [inspectableText(agent.lastMessage, { summary: truncateText(agent.lastMessage, 100), key: 'latest-message', truncated: agent.lastMessageTruncated === true })]);
                this._setStyle(refs.message, 'display', '');
            } else if (promptDetail) {
                replaceDetailRows(refs.message, [inspectableText(safePromptDetail(agent, Infinity), { summary: `${blocker} · available request`, key: 'blocked-request' })]);
                this._setStyle(refs.message, 'display', '');
            } else {
                this._setStyle(refs.message, 'display', 'none');
            }

            // #30 — district identity: faint radial wash + emblem glyph echoing
            // the World building this agent works in (no motion).
            const buildingInfo = buildingPresentation(building);
            if (buildingInfo) {
                cardEl.dataset.building = buildingInfo.building;
                cardEl.style.setProperty('--cv-building', buildingInfo.accent);
                cardEl.style.setProperty('--cv-building-rgb', buildingInfo.accentRgb);
                if (refs.buildingEmblem) {
                    refs.buildingEmblem.replaceChildren(pixelIcon(buildingInfo.building));
                    refs.buildingEmblem.title = `${buildingInfo.building.charAt(0).toUpperCase()}${buildingInfo.building.slice(1)} district`;
                    this._setStyle(refs.buildingEmblem, 'display', '');
                }
            } else {
                delete cardEl.dataset.building;
                cardEl.style.removeProperty('--cv-building');
                cardEl.style.removeProperty('--cv-building-rgb');
                if (refs.buildingEmblem) this._setStyle(refs.buildingEmblem, 'display', 'none');
            }
        }

        this._updateParentChip(cardEl, agent);
        this._updateActivityAge(cardEl, agent);
        this._renderWorkingSet(cardEl, agent);
        this._updateChildProgress(cardEl, agent);

        const appearance = agent.appearance || {};
        const avatarSignature = [
            agent.model || '',
            agent.effort || '',
            agent.provider || '',
            agent.teamName || '',
            appearance.skin || '',
            appearance.shirt || '',
            appearance.hair || '',
            appearance.hairStyle || '',
            appearance.pants || '',
            appearance.accessory || '',
            appearance.eyeStyle || '',
        ].join('|');
        if (cardEl._avatarCanvas && cardEl._avatarSignature !== avatarSignature) {
            cardEl._avatarSignature = avatarSignature;
            cardEl._avatarCanvas.agent = agent;
            this._scheduleAvatarDraw(cardEl);
        }

        // Render tool history
        const history = this.toolHistories.get(agent.id);
        if (history) {
            this._renderToolHistory(cardEl, agent.id, history);
        }

        // The compact row always uses the live session payload. Detail fetches
        // are reserved for the one selected row and may refine token totals.
        this._renderUsageFooter(cardEl, this.selection.isSelected(agent.id)
            ? (this.usageFooters.get(agent.id) || this._usageFooterFor(agent, null))
            : this._usageFooterFor(agent, null));

        this._updateStaleBadge(cardEl, agent);
    }

    _renderWorkingSet(cardEl, agent) {
        const container = cardEl._elements?.workingSet;
        if (!container) return;
        const workingSet = workingSetForAgent(agent);
        const collisions = collisionsForAgent(agent);
        container.hidden = !workingSet.length && !collisions.length;
        const summary = cardEl._elements?.workSummary;
        const writes = workingSet.filter(item => item.op === 'write').length;
        const reads = workingSet.filter(item => item.op === 'read').length;
        const leadPath = collisions[0]?.path || workingSet[0]?.path || '';
        const counts = [writes ? `${writes} write` : '', reads ? `${reads} read` : ''].filter(Boolean);
        const prefix = collisions.length ? `${collisions.length} overlap` : counts.join(' · ');
        const summaryText = leadPath
            ? `${prefix}${prefix ? ' · ' : ''}${formatToolDetail(leadPath, { max: 38, projectPath: agent.projectPath || '' })}`
            : '—';
        this._setText(summary, summaryText);
        if (summary) summary.title = leadPath;
        summary?.parentElement?.classList.toggle('dash-card__work-cell--collision', collisions.length > 0);
        const signature = JSON.stringify([workingSet, collisions]);
        if (container._workingSetSignature === signature) return;
        container._workingSetSignature = signature;

        const title = document.createElement('div');
        title.className = 'dash-card__tools-title';
        title.textContent = 'WORKING SET';
        const rows = document.createElement('div');
        rows.className = 'dash-card__tool-list';
        if (!workingSet.length) {
            const empty = document.createElement('div');
            empty.className = 'dash-card__tool-detail';
            empty.textContent = 'no file activity recorded';
            rows.appendChild(empty);
        } else {
            for (const item of workingSet) {
                const row = document.createElement('div');
                row.className = 'dash-card__tool-detail';
                row.textContent = `${String(item.op).toUpperCase()} · ${item.path}`;
                row.title = item.path;
                rows.appendChild(row);
            }
        }
        for (const collision of collisions) {
            const others = collision.agents
                .filter(id => String(id) !== String(agent.id))
                .map(id => this.world.agents.get(String(id))?.name || String(id));
            const row = document.createElement('div');
            row.className = 'dash-card__tool-detail';
            row.textContent = `OVERLAP: ${collision.path} with ${others.join(', ')}`;
            row.style.color = collision.kind === 'write-write'
                ? 'var(--cv-status-errored, #e06c5b)'
                : 'var(--cv-text-muted, #8b8b9e)';
            rows.appendChild(row);
        }
        replaceChildren(container, [title, rows]);
    }

    _updateChildProgress(cardEl, agent) {
        const target = cardEl._elements?.children;
        if (!target) return;
        const sourceEl = cardEl._elements?.childrenSource;
        const parentId = String(agent.id);
        const children = [...this.world.agents.values()]
            .filter(candidate => String(candidate.parentSessionId || '') === parentId);
        const previousChildIds = this._executionChildIdsByParent.get(parentId) || [];
        const progress = deriveChildProgress(agent, children, { previousChildIds });
        this._executionChildIdsByParent.set(
            parentId,
            children.map((child, index) => executionChildId(child, index)),
        );
        const hasTaskProgress = progress.total > 0
            || children.length > 0
            || (String(agent.provider || 'claude').toLowerCase() === 'claude'
                && Array.isArray(agent.tasks)
                && agent.tasks.length > 0);
        if (!hasTaskProgress) {
            this._setText(target, agent.parentSessionId ? 'Child agent' : '—');
            target.title = agent.parentSessionId ? `Parent ${agent.parentSessionId}` : 'No child agents';
            this._setText(sourceEl, '');
            sourceEl?.removeAttribute('title');
            sourceEl?.classList.remove('dash-card__children-source--exact', 'dash-card__children-source--inferred');
            return;
        }
        this._setText(target, `${progress.done}/${progress.total} children done`);
        target.title = children.length
            ? children.map(child => `${child.name || child.id}: ${child.isDeparted ? 'Unknown' : operatorStatusLabel(child.status)}`).join('; ')
            : 'Task-store progress';
        this._setText(sourceEl, String(progress.source || 'inferred').toUpperCase());
        sourceEl?.classList.remove('dash-card__children-source--exact', 'dash-card__children-source--inferred');
        sourceEl?.classList.add(`dash-card__children-source--${progress.source || 'inferred'}`);
        if (sourceEl) {
            sourceEl.title = progress.source === 'exact'
                ? 'Exact progress from the Claude task store'
                : 'Inferred from observed child sessions; disappearance is unknown';
        }
    }

    _updateParentChip(cardEl, agent) {
        const chip = cardEl._elements?.parentChip;
        if (!chip) return;
        const parentId = agent.parentSessionId || '';
        if (!parentId) {
            this._setStyle(chip, 'display', 'none');
            delete chip.dataset.parentId;
            chip.disabled = true;
            chip.classList.remove('dash-card__parent-chip--clickable', 'dash-card__parent-chip--muted');
            return;
        }

        const parent = this.world.agents.get(parentId);
        const label = parent?.name || 'ended';
        this._setText(chip, `parent: ${label}`);
        chip.dataset.parentId = parentId;
        chip.title = parent ? `Select parent ${parent.name || parent.id}` : 'Parent session ended';
        chip.classList.toggle('dash-card__parent-chip--clickable', !!parent);
        chip.classList.toggle('dash-card__parent-chip--muted', !parent);
        chip.disabled = !parent;
        this._setStyle(chip, 'display', '');
    }

    _syncSelectionControls(nextId, previousId) {
        for (const id of new Set([nextId, previousId].filter(Boolean))) {
            const selected = id === nextId;
            this.cards.get(id)?._elements?.select
                ?.setAttribute('aria-pressed', String(selected));
            this.cards.get(id)?._elements?.select
                ?.setAttribute('aria-expanded', String(selected));
            this.cards.get(id)?.classList.toggle('dash-card--selected', selected);
            this.cards.get(id)?._elements?.detail
                ?.setAttribute('aria-hidden', String(!selected));
            const agent = this.world.agents.get(id);
            const card = this.cards.get(id);
            if (agent && card) {
                this._renderUsageFooter(card, selected
                    ? (this.usageFooters.get(id) || this._usageFooterFor(agent, null))
                    : this._usageFooterFor(agent, null));
            }
        }
        const focusIsInDashboard = this.gridEl?.contains?.(document.activeElement);
        if (!focusIsInDashboard && nextId && this.cards.has(nextId)) {
            this._focusedAgentId = nextId;
        }
        this._syncCardTabStops();
    }

    _cardIdsInVisualOrder() {
        if (!this.gridEl) return [];
        return [...this.gridEl.querySelectorAll('.dash-card[data-agent-id]')]
            .map(card => card.dataset.agentId)
            .filter(id => id && this.cards.has(id));
    }

    _syncCardTabStops(preferredId = null) {
        const ids = this._cardIdsInVisualOrder();
        let targetId = preferredId || this._focusedAgentId;
        if (!ids.includes(targetId)) {
            targetId = ids.includes(this._selectedAgentId) ? this._selectedAgentId : (ids[0] || null);
        }
        this._focusedAgentId = targetId;
        for (const [id, card] of this.cards) {
            const select = card._elements?.select;
            if (select) select.tabIndex = id === targetId ? 0 : -1;
        }
        return targetId;
    }

    _focusCard(agentId, { select = false } = {}) {
        const card = this.cards.get(agentId);
        const control = card?._elements?.select;
        if (!card || !control) return false;
        this._syncCardTabStops(agentId);
        control.focus({ preventScroll: true });
        card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (select) emitAgentSelected(this.world.agents.get(agentId));
        return true;
    }

    _handleDashboardKeyboardCommand(event) {
        if (!event || !this.active || this._destroyed) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (isKeyboardEditTarget(document.activeElement)) return;
        if (document.getElementById('modalOverlay')?.getAttribute('aria-hidden') === 'false') return;

        if (event.code === 'KeyA') {
            // TopBar owns the app-wide A command. It runs on document before
            // this window handler; when it handled A, selection is already
            // mirrored here and Dashboard only has to bring that card to focus.
            if (event.defaultPrevented && this._selectedAgentId) {
                this._focusCard(this._selectedAgentId);
                return;
            }
            // Standalone Dashboard instances (including embeds/tests) retain
            // the same longest-waiting, rotating attention behavior.
            const ids = attentionAgentIds(this.world?.agents?.values?.());
            if (!ids.length) return;
            const id = ids[this._attentionCursor % ids.length];
            this._attentionCursor = (this._attentionCursor + 1) % ids.length;
            if (this._focusCard(id, { select: true })) event.preventDefault();
            return;
        }

        if (event.code === 'Escape') {
            // Dashboard owns Escape only while a dashboard card has focus. A
            // topbar popover, modal, or native popover gets the first chance to
            // close itself; it must not also clear the selected agent.
            if (!this.gridEl?.contains?.(document.activeElement) || hasOpenSurface()) return;
            emitAgentDeselected();
            event.preventDefault();
            return;
        }

        const direction = event.code === 'ArrowLeft' || event.code === 'ArrowUp'
            ? -1
            : (event.code === 'ArrowRight' || event.code === 'ArrowDown' ? 1 : 0);
        if (!direction) return;
        const ids = this._cardIdsInVisualOrder();
        const activeCardId = document.activeElement?.closest?.('.dash-card')?.dataset?.agentId;
        const targetId = nextCardId(ids, activeCardId || this._focusedAgentId, direction);
        if (targetId && this._focusCard(targetId)) event.preventDefault();
    }

    _updateActivityAge(cardEl, agent) {
        const chip = cardEl._elements?.activityAge;
        const ageMs = Number(agent.activityAgeMs);
        const isAged = Number.isFinite(ageMs) && ageMs > 15 * 60_000;
        cardEl.classList.toggle('dash-card--aged', isAged);
        if (!chip) return;

        const relative = formatRelative(Number(agent.lastSessionActivity) || 0);
        if (!relative) {
            this._setStyle(chip, 'display', 'none');
            return;
        }
        this._setText(chip, `last active ${relative}`);
        this._setStyle(chip, 'display', '');
    }

    _flashParentCard(cardEl) {
        cardEl.classList.remove('dash-card--parent-flash');
        void cardEl.offsetWidth;
        cardEl.classList.add('dash-card--parent-flash');
        clearTimeout(cardEl._parentFlashTimer);
        cardEl._parentFlashTimer = setTimeout(() => {
            cardEl.classList.remove('dash-card--parent-flash');
            cardEl._parentFlashTimer = null;
        }, 900);
    }

    // Coalesce avatar redraws into one requestAnimationFrame per render cycle
    // so detail polling never redraws avatar canvases synchronously.
    _scheduleAvatarDraw(cardEl) {
        this._pendingAvatarDraws.add(cardEl);
        if (this._avatarDrawFrame !== null) return;
        this._avatarDrawFrame = requestAnimationFrame(() => {
            this._avatarDrawFrame = null;
            const pending = this._pendingAvatarDraws;
            this._pendingAvatarDraws = new Set();
            for (const el of pending) {
                if (el.isConnected) el._avatarCanvas?.draw();
            }
        });
    }

    _usageFooterFor(agent, data) {
        const raw = data?.tokenUsage || data?.tokens || data?.usage || agent?.tokens || null;
        const usage = TokenUsage.normalize(raw);
        const totalTokens = TokenUsage.totalTokens(usage);
        const reported = agent?.cost?.source === 'provider' ? agent.cost : null;
        const cost = reported || TokenUsage.estimateCost(usage, agent.model, agent.provider);
        const source = reported ? 'provider' : 'estimate';
        const revision = cost.rateRevision || TokenUsage.rateRevision;
        return {
            tokens: usage.availability === 'unavailable' ? 'Usage unavailable'
                : `${formatTokens(totalTokens)} tokens${usage.availability === 'partial' ? ' · partial' : ''}`,
            cost: cost.usd == null ? 'Cost unavailable' : `${source === 'estimate' ? '~' : ''}${formatCost(cost.usd)}`,
            costTitle: source === 'provider'
                ? `Reported by ${agent.provider || 'provider'}`
                : `Estimated using ${cost.rateMatch || 'default'} rates, revision ${revision}`,
            source: cost.usd == null ? 'unavailable' : source,
            unknownModel: cost.unknownModel,
        };
    }

    _renderUsageFooter(cardEl, footer) {
        const refs = cardEl._elements;
        if (!refs?.usage) return;
        if (!footer) {
            this._setStyle(refs.usage, 'display', 'none');
            return;
        }
        this._setText(refs.usageTokens, footer.tokens);
        this._setText(refs.usageSource, footer.source === 'unavailable' ? '' : footer.source === 'provider' ? 'reported' : 'estimate');
        refs.usageCost.title = footer.costTitle;
        refs.usageCost.replaceChildren(
            document.createTextNode(footer.cost),
            ...(footer.unknownModel ? [document.createTextNode(' '), Object.assign(document.createElement('span'), {
                className: 'dash-card__provider-badge',
                textContent: 'default rate',
            })] : []),
        );
        this._setStyle(refs.usage, 'display', '');
    }

    _renderDetailError(cardEl, agentId) {
        delete cardEl.dataset.loading;
        if (this.toolHistoryRenderSignatures.get(agentId) === '__error__') return;
        this.toolHistoryRenderSignatures.set(agentId, '__error__');
        // 4.1 — the error notice needs its container back if an earlier empty
        // history collapsed it.
        this._setStyle(cardEl._elements.tools, 'display', '');
        const errorEl = document.createElement('div');
        errorEl.className = 'dash-card__tool-error';
        errorEl.textContent = 'Session details unavailable';
        replaceChildren(cardEl._elements.toolList, [errorEl]);
    }

    _updateStaleBadge(cardEl, agent) {
        const badge = cardEl._elements?.staleBadge;
        if (!badge) return;
        const hasDetail = this.toolHistories.has(agent.id) || this.usageFooters.has(agent.id);
        const cacheState = hasDetail ? sessionDetailsService.detailCacheState(agent) : null;
        const label = detailFreshnessLabel(agent, cacheState);
        this._setText(badge, label);
        this._setStyle(badge, 'display', label ? '' : 'none');
    }

    _renderToolHistory(cardEl, agentId, tools) {
        delete cardEl.dataset.loading;
        const refs = cardEl._elements;
        const listEl = refs.toolList;
        const limited = (tools || []).slice(-DASHBOARD_TOOL_HISTORY_LIMIT);

        const signature = toolHistorySignature(limited, {
            limit: DASHBOARD_TOOL_HISTORY_LIMIT,
            detailLength: 60,
        });
        const exitSignature = limited
            .map(row => (Number.isFinite(Number(row?.toolExitCode)) ? row.toolExitCode : ''))
            .join(',');
        const historySignature = `${signature}|${exitSignature}`;

        if (this.toolHistoryRenderSignatures.get(agentId) === historySignature) return;
        this.toolHistoryRenderSignatures.set(agentId, historySignature);

        // 4.1 — no tool history: collapse the whole tools block (skeleton and
        // "No tool usage" copy included) so cards stay compact. The block
        // returns as soon as real history or an error notice arrives.
        if (limited.length === 0) {
            this._setStyle(refs.tools, 'display', 'none');
            replaceChildren(listEl, []);
            return;
        }
        this._setStyle(refs.tools, 'display', '');

        const nodes = toolHistoryNodes(limited, {
            limit: DASHBOARD_TOOL_HISTORY_LIMIT,
            detailLength: 60,
            emptyText: i18n.t('noToolUsage'),
            emptyClass: 'dash-card__loading',
            itemClass: 'dash-card__tool-item',
            iconClass: 'dash-card__tool-item-icon',
            nameClass: 'dash-card__tool-item-name',
            detailClass: 'dash-card__tool-item-detail',
            timeClass: 'dash-card__tool-item-time',
            includeCategoryClasses: true,
            formatDetail: detail => formatToolDetail(detail, {
                max: 60,
                projectPath: this.world.agents.get(agentId)?.projectPath || '',
            }),
        });
        const newestFirst = [...limited].reverse();
        nodes.forEach((node, index) => {
            const chip = this._toolExitChip(newestFirst[index]);
            if (chip) node.querySelector('summary')?.appendChild(chip);
        });
        replaceDetailRows(listEl, nodes);
    }

    _toolExitChip(entry) {
        const exitCode = Number(entry?.toolExitCode);
        if (!Number.isFinite(exitCode) || exitCode === 0) return null;
        const chip = document.createElement('span');
        chip.className = 'dash-card__tool-item-exit';
        chip.textContent = `exit ${exitCode}`;
        chip.title = entry?.toolStderr
            ? truncateText(entry.toolStderr, 200)
            : `Exit code ${exitCode}`;
        return chip;
    }

    _startDetailFetching() {
        this._stopDetailFetching();
        this._detailFetchGeneration++;
        // Run once immediately, then every 3 seconds
        this._fetchAllDetails();
        this._globalFetchTimer = setInterval(() => this._fetchAllDetails(), SESSION_DETAIL_REFRESH_INTERVAL);
    }

    _stopDetailFetching() {
        if (this._globalFetchTimer) {
            clearInterval(this._globalFetchTimer);
            this._globalFetchTimer = null;
        }
        this._detailFetchGeneration++;
    }

    async _fetchAllDetails() {
        if (!this.active || this._isFetchingDetails || document.hidden) return;
        this._isFetchingDetails = true;
        const generation = this._detailFetchGeneration;

        const agents = Array.from(this.world.agents.values());
        try {
            const candidates = this._detailCandidates(agents);
            if (!candidates.length) return;
            const detailsByAgentId = await sessionDetailsService.fetchSessionDetailsBatch(candidates);
            if (!this.active || generation !== this._detailFetchGeneration) return;
            for (const agent of candidates) {
                const data = detailsByAgentId.get(agent.id);
                const cardEl = this.cards.get(agent.id);
                if (!data) {
                    // Fetch failed (or detail unavailable) with nothing cached:
                    // show an explicit error instead of an eternal spinner.
                    if (cardEl && !this.toolHistories.has(agent.id)) this._renderDetailError(cardEl, agent.id);
                    if (cardEl) this._updateStaleBadge(cardEl, agent);
                    continue;
                }
                const footer = this._usageFooterFor(agent, data);
                if (footer) this.usageFooters.set(agent.id, footer);
                else this.usageFooters.delete(agent.id);
                if (cardEl) this._renderUsageFooter(cardEl, footer);
                const toolHistory = data.toolHistory || [];
                this.toolHistories.set(agent.id, toolHistory.slice(-DASHBOARD_TOOL_HISTORY_LIMIT));
                if (cardEl) {
                    this._renderToolHistory(cardEl, agent.id, toolHistory);
                    this._updateStaleBadge(cardEl, agent);
                }
            }
        } finally {
            this._isFetchingDetails = false;
        }
    }

    _clearAllCardsAndSections() {
        for (const id of [...this.cards.keys()]) this._removeCard(id, { removeEmptySection: false });
        this.toolHistories.clear();
        this.usageFooters.clear();
        this.toolHistoryRenderSignatures.clear();
        this._cardRenderSignatures.clear();

        for (const [, sectionEl] of this._sectionEls) {
            if (sectionEl._erroredFlashTimer) clearTimeout(sectionEl._erroredFlashTimer);
            sectionEl.remove();
        }
        this._sectionEls.clear();
    }

    _removeCard(agentId, { removeEmptySection = true } = {}) {
        const cardEl = this.cards.get(agentId);
        const projectPath = cardEl?._projectPath;
        const focusWasInCard = Boolean(cardEl?.contains?.(document.activeElement));
        const idsBeforeRemoval = (focusWasInCard || this._focusedAgentId === agentId)
            ? this._cardIdsInVisualOrder()
            : null;
        if (cardEl) {
            this._pendingAvatarDraws.delete(cardEl);
            if (cardEl._parentFlashTimer) clearTimeout(cardEl._parentFlashTimer);
            cardEl._elapsedUnsubscribe?.();
            cardEl._elapsedUnsubscribe = null;
            cardEl._avatarCanvas?.destroy?.();
            cardEl._avatarCanvas = null;
            cardEl.remove();
            this.cards.delete(agentId);
        }
        if (idsBeforeRemoval) {
            this._focusedAgentId = recoveryCardId(idsBeforeRemoval, agentId);
            this._syncCardTabStops();
            if (focusWasInCard && this._focusedAgentId) this._focusCard(this._focusedAgentId);
        }
        this.toolHistories.delete(agentId);
        this.usageFooters.delete(agentId);
        this.toolHistoryRenderSignatures.delete(agentId);
        this._cardRenderSignatures.delete(agentId);

        if (!removeEmptySection || !projectPath) return;
        const sectionEl = this._sectionEls.get(projectPath);
        const grid = sectionEl?._sectionRefs?.grid;
        if (sectionEl && (!grid || !grid.querySelector('.dash-card'))) {
            if (sectionEl._erroredFlashTimer) clearTimeout(sectionEl._erroredFlashTimer);
            sectionEl.remove();
            this._sectionEls.delete(projectPath);
        }
    }

    _detailCandidates(agents) {
        if (!this._selectedAgentId) return [];
        const selected = agents.find(agent => String(agent.id) === String(this._selectedAgentId));
        return selected ? [selected] : [];
    }


    async _copyAgentId(agentId) {
        if (!agentId || this._destroyed) return;
        try {
            await navigator.clipboard.writeText(agentId);
            if (this._destroyed) return;
            this.toast?.show('Session ID copied to clipboard', 'success');
        } catch {
            if (this._destroyed) return;
            this.toast?.show('Could not copy session ID', 'warning');
        }
    }

    // Actionable hints appended below the static empty-state copy in index.html.
    _appendEmptyHints() {
        if (!this.emptyEl || this.emptyEl.querySelector('.dashboard__empty-hints')) return;
        const hints = document.createElement('div');
        hints.className = 'dashboard__empty-hints';
        const lines = [
            '▸ Run a CLI agent (claude, codex, gemini, opencode, kimi) in any terminal',
            '▸ Or press WORLD in the top bar to watch the village view',
        ];
        for (const text of lines) {
            const el = document.createElement('span');
            el.className = 'dashboard__empty-hint';
            el.textContent = text;
            hints.appendChild(el);
        }
        this.emptyEl.appendChild(hints);
    }

    _setText(el, value) {
        const next = value == null ? '' : String(value);
        if (el && el.textContent !== next) el.textContent = next;
    }

    _setStyle(el, prop, value) {
        if (el && el.style[prop] !== value) el.style[prop] = value;
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.active = false;
        this._stopDetailFetching();
        this._stopAmbienceSync();
        for (const timer of this._flipTimers) clearTimeout(timer);
        this._flipTimers.clear();
        if (this._avatarDrawFrame !== null) {
            cancelAnimationFrame(this._avatarDrawFrame);
            this._avatarDrawFrame = null;
        }
        this._pendingAvatarDraws.clear();
        this._clearAllCardsAndSections();
        this.selection?.destroy?.();
        window.removeEventListener('keydown', this._onDashboardKeyDown);
        this.gridEl?.removeEventListener('focusin', this._onDashboardFocusIn);
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        eventBus.off('agent:added', this._onAgentAdded);
        eventBus.off('agent:updated', this._onAgentUpdated);
        eventBus.off('agent:removed', this._onAgentRemoved);
        eventBus.off('mode:changed', this._onModeChanged);
        eventBus.off(DASHBOARD_FILTER_EVENT, this._onSharedFilterChanged);
    }
}
