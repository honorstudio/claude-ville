import { eventBus } from '../../domain/events/DomainEvent.js';
import { i18n } from '../../config/i18n.js';
import { getTeamColor, shortTeamName } from './TeamColor.js';
import { repoBranchProfile } from './RepoColor.js';
import { AgentSearchIndex } from './SearchIndex.js';
import { sessionDetailsService } from './SessionDetailsService.js';
import { el, replaceChildren } from './DomSafe.js';
import { bucketAgents, waitAnchor } from '../../domain/services/SignalLedger.js';
import {
    formatElapsed,
    formatRelative,
    formatStatusElapsed,
    hashRows,
    shortProjectName,
    statusClass,
    subscribeElapsedText,
} from './Formatters.js';
import {
    AgentSelectionMirror,
    emitAgentSelected,
    toggleAgentSelection,
} from './AgentSelection.js';
import {
    groupAgentsByProject,
    modelPresentation,
    projectProfile,
    providerPresentation,
} from './AgentPresentation.js';

// Preserve a workflow's expanded/collapsed choice through brief ingestion gaps,
// while bounding remembered state to live workflows plus a small recent tail.
const WORKFLOW_STATE_GRACE_MS = 60 * 1000;
const WORKFLOW_STATE_GRACE_LIMIT = 32;
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'claudeville.sidebarCollapsed';
const DASHBOARD_FILTER_EVENT = 'dashboard:filter-changed';
const DASHBOARD_FILTER_REQUEST_EVENT = 'dashboard:filter-requested';

function safeStorageGet(key) {
    try {
        return window.localStorage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

function safeStorageSet(key, value) {
    try {
        window.localStorage?.setItem(key, value);
    } catch {
        // Storage can be disabled by browser privacy settings. UI state remains
        // usable for the current page even when it cannot be persisted.
    }
}
export function buildHarborLedgerRows(repos = [], now = Date.now()) {
    return [...(Array.isArray(repos) ? repos : [])]
        .filter(repo => (Number(repo.pendingCommits ?? repo.count) || 0) > 0)
        .sort((a, b) => {
            const aOldest = Number(a.oldestCommitTime) || 0;
            const bOldest = Number(b.oldestCommitTime) || 0;
            if (aOldest > 0 && bOldest > 0 && aOldest !== bOldest) return aOldest - bOldest;
            if ((aOldest > 0) !== (bOldest > 0)) return aOldest > 0 ? -1 : 1;
            return (Number(b.failedPushes) || 0) - (Number(a.failedPushes) || 0)
                || (Number(b.pendingCommits ?? b.count) || 0) - (Number(a.pendingCommits ?? a.count) || 0)
                || String(a.repoName || a.shortName || a.project || '').localeCompare(
                    String(b.repoName || b.shortName || b.project || ''),
                );
        })
        .map((repo) => {
            const profile = repo.profile || repoBranchProfile(repo.project, repo.branch);
            const count = Number(repo.pendingCommits ?? repo.count) || 0;
            const oldestCommitTime = Number(repo.oldestCommitTime) || 0;
            const ageLabel = oldestCommitTime > 0 ? formatRelative(oldestCommitTime, now) : '';
            const branch = repo.branch || '';
            return {
                profile,
                project: repo.project || '',
                name: repo.repoName || repo.shortName || profile.shortName || profile.name || 'unknown',
                branch,
                count,
                ageLabel,
                countCapped: count >= 120,
                detailText: `${branch || 'unknown branch'} - ${count} ${count === 1 ? 'commit' : 'commits'}${ageLabel ? ` - oldest ${ageLabel}` : ''}`,
            };
        });
}


export class Sidebar {
    constructor(world) {
        this.world = world;
        this.sidebarEl = document.getElementById('sidebar');
        this.listEl = document.getElementById('agentList');
        this.countEl = document.getElementById('agentCount');
        this.shelfEl = document.getElementById('attentionShelf');
        this._shelfRows = new Map();
        this._shelfExpanded = false;
        this.harborListEl = document.getElementById('harborList');
        this.harborCountEl = document.getElementById('harborCount');
        this.toggleEl = document.getElementById('sidebarToggle');
        this.harborRepos = [];
        this._harborSignature = '';
        this._renderSignature = '';
        this._filter = '';
        this._sharedFilterSignature = '';
        this._highlightedAgentId = null;
        this.searchIndex = new AgentSearchIndex();
        this._collapsedWorkflows = new Set();
        this._seenWorkflows = new Set();
        this._workflowLastSeenAt = new Map();
        this._workflowPruneTimer = null;
        this._workflowPruneAt = 0;
        this._detailIndexTimer = null;
        this._reactiveFrame = null;
        this._reactiveFrameGeneration = 0;
        this._pendingAgentChanges = new Map();
        this._reactiveRenderPending = false;
        this._destroyed = false;
        this._agentRows = new Map();
        this._projectGroups = new Map();
        this._workflowGroups = new Map();
        this._emptyLegendEl = null;
        this._emptyNoMatchEl = null;
        this._renderWhileHidden = false;
        this.isCollapsed = safeStorageGet(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
        this.selection = new AgentSelectionMirror({
            onChange: (nextId, previousId) => {
                this._syncSelection(previousId, nextId);
                this._scheduleSelectedDetailIndex(nextId);
            },
        });

        this._onAgentUpdate = agent => this._handleAgentUpdate(agent);
        this._onAgentRemoved = agent => this._handleAgentRemoved(agent);
        this._onHarborUpdate = (repos = []) => {
            if (this._destroyed) return;
            const nextRepos = Array.isArray(repos) ? repos : [];
            const signature = hashRows(nextRepos, [
                repo => repo.project || '',
                repo => repo.branch || '',
                repo => Number(repo.pendingCommits ?? repo.count) || 0,
                repo => Number(repo.failedPushes) || 0,
                repo => Math.floor((Number(repo.latestEventTime) || 0) / 1000),
                repo => Math.floor((Number(repo.oldestCommitTime) || 0) / 60_000),
                repo => repo.profile?.accent || '',
            ]);
            if (signature === this._harborSignature) return;
            this._harborSignature = signature;
            this.harborRepos = nextRepos;
            this.renderHarbor();
        };
        this._onVisibilityChange = () => {
            if (!document.hidden && this._renderWhileHidden) {
                this.render();
                this.renderHarbor();
            }
        };
        this._onSharedFilterRequest = () => this._publishSharedFilter(null, true);
        eventBus.on('agent:added', this._onAgentUpdate);
        eventBus.on('agent:updated', this._onAgentUpdate);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on('harbor:updated', this._onHarborUpdate);
        eventBus.on(DASHBOARD_FILTER_REQUEST_EVENT, this._onSharedFilterRequest);
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        this._bindToggle();
        this._bindFilter();
        this._bindListClick();
        this._bindListKeyboard();
        this._applyCollapsedState();
        this.render();
        this.renderHarbor();
    }

    _handleAgentUpdate(agent) {
        if (this._destroyed) return;
        this._queueAgentChange(agent, 'upsert');
    }

    _handleAgentRemoved(agent) {
        if (this._destroyed) return;
        this._queueAgentChange(agent, 'remove');
    }

    _queueAgentChange(agent, type) {
        const id = agent?.id;
        if (id) {
            // Keep only the final operation for each agent in this frame. This
            // preserves the final world state while avoiding repeated index work.
            this._pendingAgentChanges.set(id, { agent, type });
        } else {
            // A malformed event can still mean the resident list changed.
            this._reactiveRenderPending = true;
        }
        this._scheduleReactiveRender();
    }

    _scheduleReactiveRender() {
        if (this._destroyed || this._reactiveFrame !== null) return;

        const generation = ++this._reactiveFrameGeneration;
        const callback = () => {
            if (generation !== this._reactiveFrameGeneration) return;
            this._reactiveFrame = null;
            if (this._destroyed) return;
            if (!this._reindexPendingAgentChanges()) return;
            // Read selection only after all queued events have been applied so
            // the frame cannot paint an intermediate cross-mode selection.
            if (!this._destroyed) this.render();
        };
        const frame = this._requestAnimationFrame(callback);
        if (frame === null || frame === undefined) {
            // Browsers targeted by ClaudeVille provide rAF. Keep the sidebar
            // usable in a non-browser harness without introducing a timer.
            callback();
            return;
        }
        this._reactiveFrame = frame;
    }

    _requestAnimationFrame(callback) {
        if (typeof requestAnimationFrame !== 'function') return null;
        return requestAnimationFrame(callback);
    }

    _cancelAnimationFrame(frame) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    }

    _cancelReactiveFrame() {
        if (this._reactiveFrame === null) return;
        this._reactiveFrameGeneration++;
        this._cancelAnimationFrame(this._reactiveFrame);
        this._reactiveFrame = null;
    }

    _reindexPendingAgentChanges() {
        if (this._destroyed) {
            this._pendingAgentChanges.clear();
            this._reactiveRenderPending = false;
            return false;
        }

        const changes = this._pendingAgentChanges;
        const shouldRender = this._reactiveRenderPending || changes.size > 0;
        this._pendingAgentChanges = new Map();
        this._reactiveRenderPending = false;

        for (const [id, change] of changes) {
            if (change.type === 'remove') this.searchIndex.remove(id);
            else this._indexAgent(change.agent);
        }
        return shouldRender;
    }

    _flushPendingReactiveChanges() {
        if (this._destroyed) return false;
        this._cancelReactiveFrame();
        return this._reindexPendingAgentChanges();
    }

    _bindFilter() {
        if (!this.listEl) return;
        const wrap = el('div', { className: 'sidebar__filter' }, [
            el('input', {
                className: 'sidebar__filter-input',
                ariaLabel: 'Search agents',
            }),
        ]);
        this._filterWrapEl = wrap;
        this.filterEl = wrap.firstChild;
        this.filterEl.type = 'text';
        this.filterEl.placeholder = 'Search agents, tools, files…';
        this.listEl.parentNode?.insertBefore(wrap, this.listEl);
        this._onFilterInput = event => this._handleFilterInput(event);
        this.filterEl.addEventListener('input', this._onFilterInput);
        this._onFilterKeydown = (event) => {
            const hadPendingChanges = this._flushPendingReactiveChanges();
            if (hadPendingChanges) {
                this._renderSignature = '';
                this.render();
            }
            if (this._handleAgentNavigationKey(event, { fromSearch: true })) return;
            if (event.key === 'Escape' && this.clearFilter()) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        this.filterEl.addEventListener('keydown', this._onFilterKeydown);
    }

    focusSearch() {
        if (this._destroyed || !this.filterEl) return false;
        if (this.isCollapsed) {
            this.isCollapsed = false;
            safeStorageSet(SIDEBAR_COLLAPSED_STORAGE_KEY, 'false');
            this._applyCollapsedState();
            this.render();
            this.renderHarbor();
        }
        this.filterEl.focus({ preventScroll: true });
        this.filterEl.select();
        return document.activeElement === this.filterEl;
    }

    clearFilter() {
        if (this._destroyed || !this._filter) return false;
        this._filter = '';
        if (this.filterEl) this.filterEl.value = '';
        this._renderSignature = '';
        this._flushPendingReactiveChanges();
        this.render();
        return true;
    }

    _handleFilterInput(event) {
        if (this._destroyed) return;
        this._filter = String(event.target.value || '').trim().toLowerCase();
        this._renderSignature = '';
        // Filter changes are operator input: apply queued index deltas and
        // render now instead of making the keystroke wait for the next frame.
        this._flushPendingReactiveChanges();
        this.render();
    }

    _matchesFilter(agent) {
        if (!this._filter) return true;
        return Boolean(this.searchIndex.match(agent.id, this._filter));
    }

    _indexAgent(agent) {
        if (!agent?.id) return;
        const cachedDetail = sessionDetailsService.detailCacheState(agent)?.value || null;
        this.searchIndex.upsert(agent, {
            modelLabel: modelPresentation(agent)?.label || '',
            detail: cachedDetail,
        });
    }

    _scheduleSelectedDetailIndex(agentId, attempt = 0) {
        if (this._detailIndexTimer) clearTimeout(this._detailIndexTimer);
        this._detailIndexTimer = null;
        if (!agentId || this._destroyed) return;

        const agent = this.world.agents.get(agentId);
        const cachedDetail = agent && sessionDetailsService.detailCacheState(agent)?.value;
        if (cachedDetail) {
            const changed = this.searchIndex.upsert(agent, {
                modelLabel: modelPresentation(agent)?.label || '',
                detail: cachedDetail,
            });
            if (changed) {
                this._flushPendingReactiveChanges();
                this._renderSignature = '';
                this.render();
            }
            return;
        }

        // The selected-agent panel may currently be filling the shared cache.
        // Probe only that one cache key; these checks never initiate a fetch.
        const delays = [500, 1000, 3000];
        if (attempt >= delays.length) return;
        this._detailIndexTimer = setTimeout(() => {
            this._detailIndexTimer = null;
            if (this.selection.selectedId === agentId) {
                this._scheduleSelectedDetailIndex(agentId, attempt + 1);
            }
        }, delays[attempt]);
    }

    _bindToggle() {
        if (!this.toggleEl) return;
        this._onToggleClick = () => {
            this.isCollapsed = !this.isCollapsed;
            safeStorageSet(SIDEBAR_COLLAPSED_STORAGE_KEY, String(this.isCollapsed));
            this._applyCollapsedState();
            if (!this.isCollapsed && this._renderWhileHidden) {
                this.render();
                this.renderHarbor();
            }
        };
        this.toggleEl.addEventListener('click', this._onToggleClick);
    }

    _bindListClick() {
        if (!this.listEl) return;
        this._onListClick = (event) => {
            const toggle = event.target.closest('.sidebar__workflow-toggle[data-workflow-id]');
            if (toggle && this.listEl.contains(toggle)) {
                this._flushPendingReactiveChanges();
                const wfId = toggle.dataset.workflowId;
                if (this._collapsedWorkflows.has(wfId)) this._collapsedWorkflows.delete(wfId);
                else this._collapsedWorkflows.add(wfId);
                this._renderSignature = '';
                this.render();
                return;
            }
            // 4.12 — subagent parent link: select the parent instead of
            // toggling the row's own selection.
            const parentLink = event.target.closest('.sidebar__agent-parent[data-parent-id]');
            if (parentLink && this.listEl.contains(parentLink)) {
                const parent = this.world.agents.get(parentLink.dataset.parentId);
                if (parent) emitAgentSelected(parent);
                return;
            }
            const select = event.target.closest('.sidebar__agent-select[data-agent-id]');
            if (!select || !this.listEl.contains(select)) return;
            const id = select.dataset.agentId;
            this._highlightedAgentId = id;
            this._syncRovingTabindex(id);
            toggleAgentSelection(this.world, id, this.selection.selectedId);
        };
        this.listEl.addEventListener('click', this._onListClick);
    }

    _bindListKeyboard() {
        if (!this.listEl) return;
        this._onListKeydown = (event) => {
            if (event.key === 'Escape' && this.clearFilter()) {
                event.preventDefault();
                event.stopPropagation();
                this.filterEl?.focus({ preventScroll: true });
                return;
            }
            if (!event.target.closest('.sidebar__agent-select[data-agent-id]')) return;
            this._handleAgentNavigationKey(event);
        };
        this.listEl.addEventListener('keydown', this._onListKeydown);
    }

    _visibleAgentSelects() {
        return [...(this.listEl?.querySelectorAll('.sidebar__agent-select[data-agent-id]') || [])]
            .filter(select => !select.closest('.sidebar__workflow-group--collapsed'));
    }

    _syncRovingTabindex(preferredId = this._highlightedAgentId) {
        const selects = this._visibleAgentSelects();
        if (!selects.length) {
            this._highlightedAgentId = null;
            return;
        }
        const preferred = selects.find(select => select.dataset.agentId === preferredId);
        const selected = selects.find(select => select.dataset.agentId === this.selection.selectedId);
        const highlighted = preferred || selected || selects[0];
        this._highlightedAgentId = highlighted.dataset.agentId;
        for (const select of selects) {
            select.tabIndex = select === highlighted ? 0 : -1;
        }
    }

    _focusAgentSelect(select) {
        if (!select) return;
        this._highlightedAgentId = select.dataset.agentId;
        this._syncRovingTabindex(this._highlightedAgentId);
        select.focus({ preventScroll: true });
        select.scrollIntoView?.({ block: 'nearest' });
    }

    _handleAgentNavigationKey(event, { fromSearch = false } = {}) {
        const keys = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']);
        if (!keys.has(event.key)) return false;
        const selects = this._visibleAgentSelects();
        if (!selects.length) return false;

        event.preventDefault();
        event.stopPropagation();
        const activeIndex = fromSearch
            ? -1
            : selects.findIndex(select => select === event.target.closest('.sidebar__agent-select'));
        let nextIndex = activeIndex;
        if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = selects.length - 1;
        else if (event.key === 'ArrowDown') nextIndex = activeIndex < 0
            ? 0
            : (activeIndex + 1) % selects.length;
        else if (event.key === 'ArrowUp') nextIndex = activeIndex < 0
            ? selects.length - 1
            : (activeIndex - 1 + selects.length) % selects.length;
        else if (event.key === 'Enter') {
            const highlighted = fromSearch
                ? selects.find(select => select.dataset.agentId === this._highlightedAgentId) || selects[0]
                : selects[activeIndex];
            const agent = this.world.agents.get(highlighted?.dataset.agentId);
            if (agent) emitAgentSelected(agent);
            return true;
        }
        this._focusAgentSelect(selects[nextIndex]);
        return true;
    }

    _applyCollapsedState() {
        if (!this.sidebarEl) return;
        this.sidebarEl.classList.toggle('sidebar--collapsed', this.isCollapsed);

        if (this.toggleEl) {
            const label = this.isCollapsed ? 'Expand agent sidebar' : 'Collapse agent sidebar';
            this.toggleEl.textContent = this.isCollapsed ? '>' : '<';
            this.toggleEl.setAttribute('aria-label', label);
            this.toggleEl.setAttribute('aria-expanded', String(!this.isCollapsed));
            this.toggleEl.title = this.isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
        }
    }

    _renderAttentionShelf(agents) {
        if (!this.shelfEl) return;
        const buckets = bucketAgents(agents);
        const exceptions = [...buckets.needsYou, ...buckets.errors, ...buckets.quota];
        this.shelfEl.hidden = exceptions.length === 0;
        if (!this._shelfList) {
            this._shelfHeading = el('div', { className: 'attention-shelf__heading' });
            this._shelfList = el('div', { className: 'attention-shelf__list' });
            this._shelfExpand = el('button', { className: 'attention-shelf__expand', type: 'button' });
            this._shelfExpand.onclick = () => {
                this._shelfExpanded = !this._shelfExpanded;
                this._renderAttentionShelf(Array.from(this.world.agents.values()));
            };
            this.shelfEl.append(this._shelfHeading, this._shelfList, this._shelfExpand);
        }
        this._setText(this._shelfHeading, `${buckets.needsYou.length} NEED YOU · ${buckets.errors.length} ERROR${buckets.quota.length ? ` · ${buckets.quota.length} QUOTA` : ''}`);
        const liveIds = new Set(exceptions.map(agent => agent.id));
        for (const [id, row] of this._shelfRows) {
            if (liveIds.has(id)) continue;
            row.unsubscribe?.();
            row.button.remove();
            this._shelfRows.delete(id);
        }
        // A focused row keeps its place across polls; other updates use the same
        // oldest-first ordering as the Dashboard's shared SignalLedger buckets.
        const focused = this._shelfList.contains(document.activeElement);
        exceptions.forEach((agent, index) => {
            let row = this._shelfRows.get(agent.id);
            if (!row) {
                const name = el('span', { className: 'attention-shelf__name' });
                const age = el('span', { className: 'attention-shelf__age' });
                const button = el('button', { className: 'attention-shelf__agent', type: 'button' }, [name, age]);
                row = { button, name, age, agent };
                button.onclick = () => {
                    const scroller = this.listEl?.parentElement;
                    const top = scroller?.scrollTop;
                    emitAgentSelected(row.agent);
                    if (scroller) scroller.scrollTop = top;
                };
                row.unsubscribe = subscribeElapsedText(age, now => waitAnchor(row.agent) ? formatElapsed(now - waitAnchor(row.agent)) : '');
                this._shelfRows.set(agent.id, row);
                this._shelfList.append(button);
            }
            row.agent = agent;
            this._setText(row.name, agent.name || agent.id);
            this._setText(row.age, waitAnchor(agent) ? formatElapsed(Date.now() - waitAnchor(agent)) : '');
            row.button.title = `${agent.name || agent.id} · ${agent.status}`;
            if (!focused) {
                row.button.hidden = !this._shelfExpanded && index >= 2;
                this._shelfList.append(row.button);
            }
        });
        this._shelfExpand.hidden = exceptions.length <= 2;
        this._shelfExpand.textContent = this._shelfExpanded ? 'Show oldest two' : `Show all · +${Math.max(0, exceptions.length - 2)}`;
        this._shelfExpand.setAttribute('aria-expanded', String(this._shelfExpanded));
    }

    render() {
        if (this._destroyed) return;
        const agents = Array.from(this.world.agents.values());
        // The shelf runs before the suspended-render bail-out so the exception
        // list stays honest while row rendering is paused.
        this._renderAttentionShelf?.(agents);
        for (const agent of agents) {
            if (!this.searchIndex.has(agent.id)) this._indexAgent(agent);
        }
        const searchResults = this.searchIndex.search(this._filter, agents.map(agent => agent.id));
        this._publishSharedFilter(searchResults);
        this._setText(this.countEl, agents.length);
        if (this._isRenderHidden()) {
            this._renderWhileHidden = true;
            return;
        }
        this._renderWhileHidden = false;
        const matchesById = new Map(searchResults.map(match => [match.agentId, match]));
        this._reconcileWorkflowState(agents);
        // Per-row extras (time in state, subagent parent link) feed
        // both the render signature and the row builder; the formatted age
        // string only changes when the displayed text would, so it stays cheap.
        const now = Date.now();
        const rowExtras = new Map();
        for (const agent of agents) {
            const ageText = formatStatusElapsed(agent, now);
            let parentLabel = '';
            if (agent.parentSessionId) {
                parentLabel = this.world.agents.get(agent.parentSessionId)?.name || 'ended';
            }
            rowExtras.set(agent.id, {
                ageText,
                parentLabel,
                searchContext: this._filter ? matchesById.get(agent.id)?.context || null : null,
            });
        }
        const signature = [
            this._filter,
            this.searchIndex.revision,
            [...this._collapsedWorkflows].sort().join(','),
            agents
                .map(agent => [
                    agent.id,
                    agent.name,
                    agent.status,
                    agent.model,
                    agent.effort,
                    agent.provider,
                    agent.projectPath,
                    agent.teamName,
                    agent.workflowName,
                    agent.agentType,
                    agent.workflowId,
                    agent.parentSessionId,
                    rowExtras.get(agent.id).ageText,
                    rowExtras.get(agent.id).parentLabel,
                ].join('|'))
                .join('\n'),
        ].join('');
        if (signature === this._renderSignature) {
            this._syncSelection(null, this.selection.selectedId);
            this._syncRovingTabindex();
            return;
        }
        this._renderSignature = signature;
        const transientState = this._captureTransientState();

        // Group by project
        const groups = [...groupAgentsByProject(agents)];
        if (this._filter) {
            groups.sort((a, b) => {
                const bestScore = group => Math.max(
                    ...group[1].map(agent => matchesById.get(agent.id)?.score ?? -1),
                );
                return bestScore(b) - bestScore(a);
            });
        }

        const nodes = [];
        const visibleProjectPaths = new Set();
        const visibleWorkflowKeys = new Set();
        for (const [projectPath, groupAgents] of groups) {
            const visible = groupAgents
                .filter(agent => this._matchesFilter(agent))
                .sort((a, b) => (matchesById.get(b.id)?.score || 0) - (matchesById.get(a.id)?.score || 0));
            if (visible.length === 0) continue;
            visibleProjectPaths.add(projectPath);

            // Split workflow subagents (collapsible per workflow) from top-level rows.
            const topLevel = [];
            const workflows = new Map();
            for (const agent of visible) {
                if (agent.agentType === 'workflow-subagent' && agent.workflowId) {
                    if (!workflows.has(agent.workflowId)) workflows.set(agent.workflowId, []);
                    workflows.get(agent.workflowId).push(agent);
                } else {
                    topLevel.push(agent);
                }
            }

            const projectName = shortProjectName(projectPath, i18n.t('unknownProject'));
            const profile = projectProfile(projectPath, { surface: 'sidebar' });
            let groupEl = this._projectGroups.get(projectPath);
            if (!groupEl) {
                groupEl = this._createProjectGroup();
                this._projectGroups.set(projectPath, groupEl);
            }
            this._patchProjectGroup(groupEl, projectName, visible.length, profile);
            const groupNodes = [groupEl._sidebarRefs.header];

            for (const agent of topLevel) {
                groupNodes.push(this._getAgentRow(agent, profile, rowExtras.get(agent.id)));
            }

            for (const [workflowId, members] of workflows) {
                const workflowName = members[0]?.workflowName || workflowId;
                // A search reveals matching workflow members without mutating
                // the operator's persisted collapsed/expanded preference.
                const collapsed = !this._filter && this._collapsedWorkflows.has(workflowId);
                const workflowKey = `${projectPath}\u0001${workflowId}`;
                visibleWorkflowKeys.add(workflowKey);
                let wfEl = this._workflowGroups.get(workflowKey);
                if (!wfEl) {
                    wfEl = this._createWorkflowGroup(workflowId);
                    this._workflowGroups.set(workflowKey, wfEl);
                }
                this._patchWorkflowGroup(wfEl, workflowName, members.length, collapsed);
                const memberNodes = [];
                for (const agent of members) {
                    memberNodes.push(this._getAgentRow(agent, profile, rowExtras.get(agent.id)));
                }
                this._placeChildren(wfEl._sidebarRefs.members, memberNodes);
                groupNodes.push(wfEl);
            }

            this._placeChildren(groupEl, groupNodes);
            nodes.push(groupEl);
        }

        this._prunePersistentElements(agents, visibleProjectPaths, visibleWorkflowKeys);
        if (agents.length === 0) {
            this._emptyLegendEl ||= this._emptyLegendNodes()[0];
            this._placeChildren(this.listEl, [this._emptyLegendEl]);
        } else if (nodes.length === 0) {
            this._emptyNoMatchEl ||= el('div', {
                className: 'sidebar__empty-nomatch',
                text: 'No agents match your filter',
            });
            this._placeChildren(this.listEl, [this._emptyNoMatchEl]);
        } else {
            this._placeChildren(this.listEl, nodes);
        }
        this._applyWorkflowToggleState();
        this._syncSelection(null, this.selection.selectedId);
        this._syncRovingTabindex();
        this._restoreTransientState(transientState);
    }

    _publishSharedFilter(results = null, force = false) {
        if (this._destroyed) return;
        const agents = Array.from(this.world.agents.values());
        const matches = results || this.searchIndex.search(this._filter, agents.map(agent => agent.id));
        const signature = `${this._filter}\u0001${this.searchIndex.revision}\u0001${matches
            .map(match => `${match.agentId}:${match.score}:${match.context || ''}`)
            .join('\u0002')}`;
        if (!force && signature === this._sharedFilterSignature) return;
        this._sharedFilterSignature = signature;
        eventBus.emit(DASHBOARD_FILTER_EVENT, {
            query: this._filter,
            matches: matches.map(match => ({
                agentId: match.agentId,
                score: match.score,
                context: match.context || null,
            })),
            revision: this.searchIndex.revision,
        });
    }

    _reconcileWorkflowState(agents, now = Date.now()) {
        const liveIds = new Set();
        for (const agent of agents) {
            if (agent.agentType !== 'workflow-subagent' || !agent.workflowId) continue;
            const workflowId = String(agent.workflowId);
            liveIds.add(workflowId);
            if (!this._seenWorkflows.has(workflowId)) {
                this._seenWorkflows.add(workflowId);
                this._collapsedWorkflows.add(workflowId);
            }
            this._workflowLastSeenAt.set(workflowId, now);
        }

        const grace = [];
        for (const workflowId of this._seenWorkflows) {
            if (liveIds.has(workflowId)) continue;
            const lastSeenAt = this._workflowLastSeenAt.get(workflowId) || 0;
            if (now - lastSeenAt >= WORKFLOW_STATE_GRACE_MS) {
                this._forgetWorkflow(workflowId);
            } else {
                grace.push([workflowId, lastSeenAt]);
            }
        }
        grace.sort((a, b) => b[1] - a[1]);
        for (const [workflowId] of grace.slice(WORKFLOW_STATE_GRACE_LIMIT)) {
            this._forgetWorkflow(workflowId);
        }
        this._scheduleWorkflowPrune(liveIds, now);
    }

    _forgetWorkflow(workflowId) {
        this._seenWorkflows.delete(workflowId);
        this._collapsedWorkflows.delete(workflowId);
        this._workflowLastSeenAt.delete(workflowId);
    }

    _scheduleWorkflowPrune(liveIds, now) {
        let nextAt = Infinity;
        for (const [workflowId, lastSeenAt] of this._workflowLastSeenAt) {
            if (!liveIds.has(workflowId)) {
                nextAt = Math.min(nextAt, lastSeenAt + WORKFLOW_STATE_GRACE_MS);
            }
        }
        if (!Number.isFinite(nextAt)) {
            if (this._workflowPruneTimer) clearTimeout(this._workflowPruneTimer);
            this._workflowPruneTimer = null;
            this._workflowPruneAt = 0;
            return;
        }
        if (this._workflowPruneTimer && this._workflowPruneAt <= nextAt) return;
        if (this._workflowPruneTimer) clearTimeout(this._workflowPruneTimer);
        this._workflowPruneAt = nextAt;
        this._workflowPruneTimer = setTimeout(() => {
            this._workflowPruneTimer = null;
            this._workflowPruneAt = 0;
            if (!this._destroyed) this.render();
        }, Math.max(0, nextAt - now));
    }

    // Empty-world onboarding: name the village and teach the building metaphor.
    _emptyLegendNodes() {
        return [
            el('div', { className: 'sidebar__empty' }, [
                el('div', { className: 'sidebar__empty-title', text: 'THE VILLAGE AWAITS' }),
                el('div', {
                    className: 'sidebar__empty-cta',
                    text: 'Start a coding session to populate the village.',
                }),
            ]),
        ];
    }

    _isRenderHidden() {
        if (this.isCollapsed || document.hidden) return true;
        if (!this.sidebarEl || !this.listEl) return true;
        return this.sidebarEl.hidden || this.sidebarEl.style?.display === 'none';
    }

    _setText(node, value) {
        const text = String(value ?? '');
        if (node && node.textContent !== text) node.textContent = text;
    }

    _setNodeText(node, value) {
        const text = String(value ?? '');
        if (node.nodeValue !== text) node.nodeValue = text;
    }

    _setAttribute(node, name, value) {
        const text = String(value);
        if (node.getAttribute(name) !== text) node.setAttribute(name, text);
    }

    _setStyle(node, property, value) {
        const text = value || '';
        node._sidebarStyleValues ||= new Map();
        if (node._sidebarStyleValues.get(property) === text) return;
        node.style[property] = text;
        node._sidebarStyleValues.set(property, text);
    }

    _toggleOptional(parent, node, present, before = null) {
        if (!present) {
            if (node.parentNode === parent) node.remove();
            return;
        }
        if (node.parentNode !== parent || (before && node.nextSibling !== before)) {
            parent.insertBefore(node, before);
        }
    }

    _placeChildren(parent, desired) {
        const desiredSet = new Set(desired);
        for (const child of [...parent.children]) {
            if (!desiredSet.has(child)) child.remove();
        }
        for (let index = 0; index < desired.length; index++) {
            const node = desired[index];
            const current = parent.children[index] || null;
            if (current !== node) parent.insertBefore(node, current);
        }
    }

    _captureTransientState() {
        const scrollEl = this.listEl.parentElement;
        const activeElement = this.listEl.contains(document.activeElement)
            ? document.activeElement
            : null;
        const selection = document.getSelection?.();
        const selectionState = selection?.rangeCount
            && this.listEl.contains(selection.getRangeAt(0).commonAncestorContainer)
            ? {
                anchorNode: selection.anchorNode,
                anchorOffset: selection.anchorOffset,
                focusNode: selection.focusNode,
                focusOffset: selection.focusOffset,
                ranges: Array.from(
                    { length: selection.rangeCount },
                    (_, index) => selection.getRangeAt(index).cloneRange(),
                ),
            }
            : null;
        return {
            scrollEl,
            scrollTop: scrollEl?.scrollTop || 0,
            scrollLeft: scrollEl?.scrollLeft || 0,
            activeElement,
            selectionState,
        };
    }

    _restoreTransientState(state) {
        if (!state) return;
        if (state.activeElement && this.listEl.contains(state.activeElement)
            && document.activeElement !== state.activeElement) {
            state.activeElement.focus({ preventScroll: true });
        }
        const selection = document.getSelection?.();
        const saved = state.selectionState;
        if (selection && saved && this.listEl.contains(saved.anchorNode)
            && this.listEl.contains(saved.focusNode)) {
            if (typeof selection.setBaseAndExtent === 'function') {
                selection.setBaseAndExtent(
                    saved.anchorNode,
                    saved.anchorOffset,
                    saved.focusNode,
                    saved.focusOffset,
                );
            } else {
                selection.removeAllRanges();
                for (const range of saved.ranges) selection.addRange(range);
            }
        }
        if (state.scrollEl) {
            state.scrollEl.scrollTop = state.scrollTop;
            state.scrollEl.scrollLeft = state.scrollLeft;
        }
    }

    _createProjectGroup() {
        const dot = el('span', {
            className: ['sidebar__project-dot', 'sidebar__project-dot--repo'],
        });
        const name = el('span', { className: 'sidebar__project-name' });
        const count = el('span', { className: 'sidebar__project-count' });
        const header = el('div', { className: 'sidebar__project-header' }, [
            dot,
            el('span', { className: 'sidebar__label-icon', text: '#' }),
            name,
            count,
        ]);
        const group = el('div', { className: 'sidebar__project-group' }, [header]);
        group._sidebarRefs = { header, dot, name, count };
        return group;
    }

    _patchProjectGroup(group, projectName, count, profile) {
        const refs = group._sidebarRefs;
        const labelColor = profile.labelText || profile.accent;
        this._setStyle(refs.header, 'borderLeftColor', profile.panelBorder || profile.accent);
        this._setStyle(refs.header, 'background', profile.panel);
        this._setStyle(refs.dot, 'background', profile.accent);
        this._setStyle(refs.dot, 'boxShadow', `0 0 6px ${profile.glow}`);
        this._setText(refs.name, projectName);
        this._setStyle(refs.name, 'color', labelColor);
        this._setText(refs.count, count);
        this._setStyle(refs.count, 'color', labelColor);
    }

    _createWorkflowGroup(workflowId) {
        const name = el('span', { className: 'sidebar__workflow-name' });
        const count = el('span', { className: 'sidebar__workflow-count' });
        const toggle = el('button', {
            className: 'sidebar__workflow-toggle',
            dataset: { workflowId },
        }, [
            el('span', { className: 'sidebar__workflow-caret', text: '▶' }),
            el('span', { className: 'sidebar__workflow-icon', text: 'W' }),
            name,
            count,
        ]);
        const members = el('div', { className: 'sidebar__workflow-members' });
        const group = el('div', { className: 'sidebar__workflow-group' }, [toggle, members]);
        group._sidebarRefs = { toggle, name, count, members };
        return group;
    }

    _patchWorkflowGroup(group, workflowName, count, collapsed) {
        const refs = group._sidebarRefs;
        const className = collapsed
            ? 'sidebar__workflow-group sidebar__workflow-group--collapsed'
            : 'sidebar__workflow-group';
        if (group.className !== className) group.className = className;
        this._setText(refs.name, workflowName);
        this._setText(refs.count, count);
        this._setAttribute(refs.toggle, 'aria-expanded', String(!collapsed));
    }

    _getAgentRow(agent, profile, extras = {}) {
        let row = this._agentRows.get(agent.id);
        if (!row) {
            row = this._createAgentRow(agent.id);
            this._agentRows.set(agent.id, row);
        }
        const parent = agent.parentSessionId
            ? this.world.agents.get(agent.parentSessionId)
            : null;
        const signature = [
            agent.name,
            agent.status,
            agent.model,
            agent.effort,
            agent.provider,
            agent.teamName,
            agent.workflowName,
            agent.parentSessionId,
            extras.ageText,
            extras.parentLabel,
            extras.searchContext,
            Boolean(parent),
            profile.accent,
        ].join('\u0001');
        if (row._sidebarSignature !== signature) {
            row._sidebarSignature = signature;
            this._patchAgentRow(row, agent, profile, extras, parent);
        }
        return row;
    }

    _createAgentRow(agentId) {
        const nameText = document.createTextNode('');
        const team = el('span', { className: 'sidebar__team-icon', text: 'T' });
        const workflow = el('span', { className: 'sidebar__workflow-icon', text: 'W' });
        const name = el('span', { className: 'sidebar__agent-name' }, [nameText]);
        const provider = el('span', { style: { fontWeight: 'bold' } });
        const modelText = document.createTextNode('');
        const age = el('span');
        const model = el('span', { className: 'sidebar__agent-model' }, [provider, modelText]);
        const match = el('span', {
            className: ['sidebar__agent-model', 'sidebar__agent-match'],
        });
        const info = el('span', { className: 'sidebar__agent-info' }, [name, model]);
        const dot = el('span', { className: 'sidebar__agent-dot' });
        const caret = el('span', { className: 'sidebar__working-caret' });
        caret.setAttribute('aria-hidden', 'true');
        const rail = el('span', { className: 'sidebar__agent-rail' }, [dot]);
        const select = el('button', {
            className: 'sidebar__agent-select',
            dataset: { agentId },
        }, [rail, info]);
        select.type = 'button';
        select.tabIndex = -1;
        const parent = el('button', { className: 'sidebar__agent-parent' });
        parent.type = 'button';
        const row = el('div', {
            className: 'sidebar__agent',
            dataset: { agentId },
        }, [select]);
        row._sidebarRefs = {
            nameText, team, workflow, name, provider, modelText, age, model,
            match, info, dot, caret, rail, select, parent,
        };
        row._elapsedUnsubscribe = subscribeElapsedText(age, () => {
            const current = this.world.agents.get(agentId);
            const text = current ? formatStatusElapsed(current) : '';
            return text ? ` · ${text}` : '';
        });
        return row;
    }

    _patchAgentRow(row, agent, profile, extras, parentAgent) {
        const model = modelPresentation(agent);
        const provider = providerPresentation(agent.provider, model.identity);
        const team = agent.teamName ? getTeamColor(agent.teamName) : null;
        const teamLabel = agent.teamName ? `Team ${shortTeamName(agent.teamName)}` : '';
        const status = statusClass(agent.status);
        const agentClasses = ['sidebar__agent', `sidebar__agent--${status}`];
        if (this.selection.isSelected(agent.id)) agentClasses.push('sidebar__agent--selected');
        const refs = row._sidebarRefs;
        const className = agentClasses.join(' ');
        if (row.className !== className) row.className = className;
        if (profile.accent && row._sidebarRepoColor !== profile.accent) {
            row.style.setProperty('--cv-repo-color', profile.accent);
            row._sidebarRepoColor = profile.accent;
        }
        this._setNodeText(refs.nameText, agent.name || '');
        this._setStyle(refs.name, 'color', profile.accent);

        this._toggleOptional(refs.name, refs.team, Boolean(team), refs.workflow.parentNode === refs.name
            ? refs.workflow
            : refs.nameText);
        if (team) {
            this._setAttribute(refs.team, 'title', teamLabel);
            this._setAttribute(refs.team, 'aria-label', teamLabel);
            this._setStyle(refs.team, 'background', team.accent);
            this._setStyle(refs.team, 'boxShadow', `0 0 6px ${team.glow}`);
        }
        this._toggleOptional(refs.name, refs.workflow, Boolean(agent.workflowName), refs.nameText);
        if (agent.workflowName) {
            const workflowLabel = `Workflow ${agent.workflowName}`;
            this._setAttribute(refs.workflow, 'title', workflowLabel);
            this._setAttribute(refs.workflow, 'aria-label', workflowLabel);
        }

        this._setText(refs.provider, provider.icon);
        this._setStyle(refs.provider, 'color', provider.color);
        this._setNodeText(refs.modelText, ` ${model.label}`);
        this._toggleOptional(refs.model, refs.age, Boolean(extras.ageText));
        if (extras.ageText) {
            this._setText(refs.age, ` · ${extras.ageText}`);
            this._setAttribute(refs.age, 'title', `Last active ${extras.ageText}`);
        }
        this._toggleOptional(refs.info, refs.match, Boolean(extras.searchContext));
        if (extras.searchContext) {
            this._setText(refs.match, extras.searchContext);
            this._setAttribute(refs.match, 'title', extras.searchContext);
        }

        const hasParent = Boolean(agent.parentSessionId);
        this._toggleOptional(row, refs.parent, hasParent);
        if (hasParent) {
            const parentLabel = parentAgent
                ? `Select parent ${extras.parentLabel}`
                : 'Parent session ended';
            this._setText(refs.parent, `↩ ${extras.parentLabel}`);
            this._setAttribute(refs.parent, 'title', parentLabel);
            this._setAttribute(refs.parent, 'aria-label', parentLabel);
            if (parentAgent) refs.parent.dataset.parentId = agent.parentSessionId;
            else delete refs.parent.dataset.parentId;
            if (refs.parent.disabled !== !parentAgent) refs.parent.disabled = !parentAgent;
        }

        const dotClass = `sidebar__agent-dot sidebar__agent-dot--${status}`;
        if (refs.dot.className !== dotClass) refs.dot.className = dotClass;
        this._toggleOptional(refs.rail, refs.caret, status === 'working');
        this._setAttribute(
            refs.select,
            'aria-label',
            `Select ${agent.name || agent.id}, ${status.replaceAll('_', ' ')}`,
        );
        this._setAttribute(
            refs.select,
            'aria-pressed',
            String(this.selection.isSelected(agent.id)),
        );
    }

    _prunePersistentElements(agents, visibleProjectPaths, visibleWorkflowKeys) {
        const liveIds = new Set(agents.map(agent => agent.id));
        const liveProjects = new Set(agents.map(agent => agent.projectPath || '_unknown'));
        const liveWorkflows = new Set(agents
            .filter(agent => agent.agentType === 'workflow-subagent' && agent.workflowId)
            .map(agent => `${agent.projectPath || '_unknown'}\u0001${agent.workflowId}`));
        for (const [id, row] of this._agentRows) {
            if (liveIds.has(id)) continue;
            row._elapsedUnsubscribe?.();
            row._elapsedUnsubscribe = null;
            row.remove();
            this._agentRows.delete(id);
        }
        for (const [path, group] of this._projectGroups) {
            if (liveProjects.has(path) || visibleProjectPaths.has(path)) continue;
            group.remove();
            this._projectGroups.delete(path);
        }
        for (const [key, group] of this._workflowGroups) {
            if (liveWorkflows.has(key) || visibleWorkflowKeys.has(key)) continue;
            group.remove();
            this._workflowGroups.delete(key);
        }
    }

    _applyWorkflowToggleState() {
        this.listEl?.querySelectorAll('.sidebar__workflow-toggle[data-workflow-id]')
            .forEach(toggle => {
                const collapsed = !this._filter && this._collapsedWorkflows.has(toggle.dataset.workflowId);
                this._setAttribute(toggle, 'aria-expanded', String(!collapsed));
            });
    }

    _syncSelection(previousId, nextId) {
        const ids = new Set([previousId, nextId].filter(Boolean));
        if (ids.size === 0 && nextId === null) {
            this.listEl?.querySelectorAll('.sidebar__agent--selected')
                .forEach(row => row.classList.remove('sidebar__agent--selected'));
            return;
        }
        for (const id of ids) {
            const selector = `.sidebar__agent[data-agent-id="${CSS.escape(id)}"]`;
            const row = this.listEl?.querySelector(selector);
            const selected = id === nextId;
            if (row?.classList.contains('sidebar__agent--selected') !== selected) {
                row?.classList.toggle('sidebar__agent--selected', selected);
            }
            const select = row?.querySelector('.sidebar__agent-select');
            if (select) this._setAttribute(select, 'aria-pressed', String(selected));
        }
        if (nextId) this._syncRovingTabindex(nextId);
    }

    renderHarbor() {
        if (this._destroyed) return;
        if (!this.harborListEl || !this.harborCountEl) return;
        if (this._isRenderHidden()) {
            this._renderWhileHidden = true;
            return;
        }

        const repos = buildHarborLedgerRows(this.harborRepos, Date.now());
        const total = repos.reduce((sum, repo) => sum + repo.count, 0);
        this.harborCountEl.textContent = total;

        if (repos.length === 0) {
            replaceChildren(this.harborListEl, [
                el('div', { className: ['sidebar__agent', 'sidebar__harbor-empty'], text: 'No pending commits' }),
            ]);
            return;
        }

        const nodes = repos.map(repo => {
            const { profile } = repo;
            const disclosure = `best-effort scan - newest 120 commits per branch - repo-watch window 7 days${repo.countCapped ? ' - count capped' : ''}`;
            const sourceTitle = repo.branch ? `${repo.project} (${repo.branch})` : repo.project;
            const infoChildren = [
                el('span', {
                    className: 'sidebar__agent-name',
                    text: repo.name,
                    style: { color: profile.labelText || profile.accent },
                }),
                el('span', { className: 'sidebar__agent-model', text: repo.detailText }),
            ];
            return el('div', {
                className: ['sidebar__agent', 'sidebar__harbor-row'],
                title: `${sourceTitle} - ${disclosure}`,
                style: {
                    borderLeftColor: profile.panelBorder || profile.accent,
                    background: profile.panel,
                },
            }, [
                el('span', {
                    className: ['sidebar__agent-dot', 'sidebar__harbor-dot'],
                    style: {
                        background: profile.accent,
                        boxShadow: `0 0 6px ${profile.glow}`,
                    },
                }),
                el('span', { className: 'sidebar__label-icon', text: repo.branch ? 'br' : '#' }),
                el('div', { className: 'sidebar__agent-info' }, infoChildren),
                el('span', {
                    className: ['sidebar__project-count', 'sidebar__harbor-count'],
                    text: repo.count,
                    style: { color: profile.labelText || profile.accent },
                }),
            ]);
        });
        replaceChildren(this.harborListEl, nodes);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        for (const row of this._shelfRows?.values() || []) row.unsubscribe?.();
        this._shelfRows?.clear();
        this.shelfEl?.replaceChildren();
        if (this.shelfEl) this.shelfEl.hidden = true;
        this._cancelReactiveFrame();
        this._pendingAgentChanges.clear();
        this._reactiveRenderPending = false;
        eventBus.off('agent:added', this._onAgentUpdate);
        eventBus.off('agent:updated', this._onAgentUpdate);
        eventBus.off('agent:removed', this._onAgentRemoved);
        eventBus.off('harbor:updated', this._onHarborUpdate);
        eventBus.off(DASHBOARD_FILTER_REQUEST_EVENT, this._onSharedFilterRequest);
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
        }
        this.selection?.destroy?.();
        if (this._onToggleClick) this.toggleEl?.removeEventListener('click', this._onToggleClick);
        if (this._onListClick) this.listEl?.removeEventListener('click', this._onListClick);
        if (this._onListKeydown) this.listEl?.removeEventListener('keydown', this._onListKeydown);
        if (this._onFilterInput) this.filterEl?.removeEventListener('input', this._onFilterInput);
        if (this._onFilterKeydown) this.filterEl?.removeEventListener('keydown', this._onFilterKeydown);
        if (this._workflowPruneTimer) clearTimeout(this._workflowPruneTimer);
        if (this._detailIndexTimer) clearTimeout(this._detailIndexTimer);
        this._workflowPruneTimer = null;
        this._workflowPruneAt = 0;
        this._detailIndexTimer = null;
        this._filterWrapEl?.remove?.();
        this._filterWrapEl = null;
        this.filterEl = null;
        this.listEl?.replaceChildren();
        this.harborListEl?.replaceChildren();
        if (this.countEl) this.countEl.textContent = '0';
        if (this.harborCountEl) this.harborCountEl.textContent = '0';
        this.harborRepos = [];
        for (const row of this._agentRows?.values?.() || []) row._elapsedUnsubscribe?.();
        this._agentRows?.clear?.();
        this._harborSignature = '';
        this._renderSignature = '';
        this._filter = '';
        this._sharedFilterSignature = '';
        this._highlightedAgentId = null;
        this._projectGroups?.clear?.();
        this._workflowGroups?.clear?.();
        this._emptyLegendEl = null;
        this._emptyNoMatchEl = null;
        this._renderWhileHidden = false;
        this.searchIndex.clear();
        this._seenWorkflows.clear();
        this._collapsedWorkflows.clear();
        this._workflowLastSeenAt.clear();
    }
}
