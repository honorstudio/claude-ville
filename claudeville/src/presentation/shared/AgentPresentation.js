import { i18n } from '../../config/i18n.js';
import { BUILDING_ACCENTS, BUILDING_ACCENTS_RGB, PROVIDER_HUES, STATUS_VISUALS } from '../../config/theme.js';
import { buildingForTool, toolCategory, toolIcon, shortToolName } from '../../domain/services/ToolIdentity.js';
import { formatModelLabel, getModelVisualIdentity } from './ModelVisualIdentity.js';
import { repoProfile } from './RepoColor.js';
import { el } from './DomSafe.js';
import { formatToolDetail, hashRows, formatRelative, formatElapsed, normalizeStatus } from './Formatters.js';
import { EVENT_SHAPES, eventShapeSvgPath, eventShapeSvgViewBox } from './EventShapes.js';

export const UNKNOWN_PROJECT_KEY = '_unknown';

const UNKNOWN_PROJECT_PROFILE = Object.freeze({
    accent: '#8b8b9e',
    labelText: '#d7d7e8',
    glow: 'rgba(139, 139, 158, 0.3)',
    panel: 'rgba(28, 28, 36, 0.72)',
    panelBorder: 'rgba(139, 139, 158, 0.9)',
});
const UNKNOWN_PROJECT_SIDEBAR_PROFILE = Object.freeze({
    accent: '#8b8b9e',
    labelText: '#d7d7e8',
    glow: 'rgba(139, 139, 158, 0.3)',
    panel: 'rgba(28, 28, 36, 0.68)',
    panelBorder: 'rgba(139, 139, 158, 0.86)',
});

const PROVIDER_ICONS = Object.freeze({ claude: 'C', codex: 'X', gemini: 'G', git: '#', grok: 'R', kimi: 'K', omp: 'M', opencode: 'O', deepseek: 'D', zai: 'Z' });
// Provider hues come from the theme.js House Palette (#1); only icons/labels
// are presentation-local.
const PROVIDER_COLORS = Object.freeze(Object.fromEntries(
    Object.entries(PROVIDER_HUES)
        .filter(([key]) => key !== 'default')
        .map(([key, hue]) => [key, hue.badge]),
));
const PROVIDER_LABELS = Object.freeze({
    claude: 'Claude', codex: 'Codex', gemini: 'Gemini', git: 'Git', grok: 'Grok', kimi: 'Kimi', omp: 'OMP', opencode: 'OpenCode', deepseek: 'DeepSeek', zai: 'z.AI',
});
const PROVIDER_BADGES = Object.freeze(Object.fromEntries(
    Object.keys(PROVIDER_LABELS).map(key => [key, {
        label: PROVIDER_LABELS[key],
        color: PROVIDER_HUES[key].badge,
        bg: PROVIDER_HUES[key].badgeBg,
    }]),
));

export function projectKeyForAgent(agent) {
    return agent?.projectPath || UNKNOWN_PROJECT_KEY;
}

export function groupAgentsByProject(agents) {
    const groups = new Map();
    for (const agent of agents || []) {
        const key = projectKeyForAgent(agent);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(agent);
    }
    return groups;
}

export function projectProfile(projectPath, { surface = 'dashboard' } = {}) {
    if (!projectPath || projectPath === UNKNOWN_PROJECT_KEY) {
        return surface === 'sidebar' ? UNKNOWN_PROJECT_SIDEBAR_PROFILE : UNKNOWN_PROJECT_PROFILE;
    }
    return repoProfile(projectPath);
}

export function sortAgentsByStatus(agents) {
    const order = {
        errored: 0,
        waiting_on_user: 1,
        working: 2,
        waiting: 3,
        rate_limited: 4,
        idle: 5,
        completed: 6,
    };
    return agents.sort((a, b) => {
        const statusA = normalizeStatus(a.status);
        const statusB = normalizeStatus(b.status);
        return (order[statusA] ?? 6) - (order[statusB] ?? 6);
    });
}

export function providerPresentation(provider, identity = null) {
    const key = String(provider || 'unknown').toLowerCase();
    const badge = PROVIDER_BADGES[key] || { label: String(provider || 'Unknown'), color: '#c6c6d2', bg: 'rgba(139,139,158,0.14)' };
    return {
        key,
        icon: PROVIDER_ICONS[key] || '?',
        // 1.5 — one provider hue across badge / trim / glyph: the shared
        // `color` (sidebar + dashboard glyph) follows the provider badge hue;
        // per-model minimap colors only survive for unlisted providers.
        color: PROVIDER_COLORS[key] || identity?.minimapColor || '#8b8b9e',
        badge,
    };
}

// Why an agent is waiting, when the adapter could tell. "Waiting for you" is
// true but unhelpful; "Waiting for approval — Bash" is what makes a person act.
const WAIT_REASON_LABELS = {
    question: 'Asked you a question',
    approval: 'Waiting for approval',
    plan_review: 'Plan needs review',
};

export function waitReasonLabel(agent) {
    const label = WAIT_REASON_LABELS[agent?.waitReason];
    if (!label) return null;
    return agent.pendingTool && agent.waitReason === 'approval'
        ? `${label} — ${agent.pendingTool}`
        : label;
}

export function statusPresentation(status, translator = i18n) {
    const normalized = normalizeStatus(status);
    const statusKey = { working: 'statusWorking', idle: 'statusIdle', waiting: 'statusWaiting' };
    const statusOverrideLabel = {
        rate_limited: 'Rate-limited',
        errored: 'Errored',
        waiting_on_user: 'Waiting for you',
        completed: 'Completed',
    };
    const fallbackLabel = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    return {
        status: normalized,
        label: statusOverrideLabel[normalized]
            || translator?.t?.(statusKey[normalized] || normalized)
            || fallbackLabel,
        color: STATUS_VISUALS[normalized]?.color || '#8b8b9e',
    };
}

export function modelPresentation(agent) {
    const identity = getModelVisualIdentity(agent?.model, agent?.effort, agent?.provider);
    return {
        identity,
        label: agent?.model ? formatModelLabel(agent.model, agent.effort, agent.provider) : '',
        color: identity.accent?.[0] || '',
        title: identity.label || agent?.model || '',
    };
}

export function currentToolPresentation(agent, translator = i18n) {
    const statusInfo = statusPresentation(agent?.status, translator);
    if (agent?.currentTool) {
        return {
            isIdle: false,
            icon: toolIcon(agent.currentTool),
            name: agent.currentTool,
            detail: agent.currentToolInput || '',
        };
    }
    // Tool-less fallback: terminal statuses read as themselves (idle → "Idle",
    // completed → "Completed"); only genuinely in-flight tool-less statuses
    // read as waiting. Fixes completed agents showing "Waiting...".
    const readsAsSelf = statusInfo.status === 'idle' || statusInfo.status === 'completed';
    return {
        isIdle: true,
        icon: statusInfo.status === 'idle' ? '\u{1F4A4}' : (statusInfo.status === 'completed' ? '✓' : '\u23F3'),
        name: readsAsSelf
            ? statusInfo.label
            : `${translator?.t?.('statusWaiting') || 'Waiting'}...`,
        detail: '',
    };
}

// #30 — Dashboard cards carry their World building identity.
// Each building's emblem glyph + accent so a card visually echoes the village
// district its agent works in (Archive = cool blue, Forge = ember, ...).
const BUILDING_EMBLEMS = Object.freeze({
    command: '⚑',     // pennant — orchestration
    taskboard: '\u{1F4CB}', // clipboard — planning
    archive: '\u{1F4D6}',  // open book — reading
    mine: '⛏',        // pick — extraction
    forge: '\u{1F528}',    // hammer — editing
    harbor: '⚓',      // anchor — git flow
    watchtower: '\u{1F3F0}', // tower — watch
    observatory: '\u{1F52D}', // telescope — research
    portal: '\u{1F310}',   // globe — preview
});

// Derive an agent's World building from its live tool (via RitualConductor's
// tool->building map in ToolIdentity), falling back to the most recent tool
// in history. Returns null when no district can be inferred.
export function buildingClassForAgent(agent) {
    if (!agent) return null;
    if (agent.currentTool) {
        const fromCurrent = buildingForTool(agent.currentTool, agent.currentToolInput);
        if (fromCurrent && BUILDING_EMBLEMS[fromCurrent]) return fromCurrent;
    }
    const history = agent.toolHistory;
    if (Array.isArray(history)) {
        for (let i = history.length - 1; i >= 0; i--) {
            const entry = history[i];
            const building = buildingForTool(entry?.tool, entry?.detail ?? entry?.input);
            if (building && BUILDING_EMBLEMS[building]) return building;
        }
    }
    return null;
}

export function buildingPresentation(building) {
    if (!building || !BUILDING_EMBLEMS[building]) return null;
    return {
        building,
        emblem: BUILDING_EMBLEMS[building],
        accent: BUILDING_ACCENTS[building] || '#8b8b9e',
        accentRgb: BUILDING_ACCENTS_RGB[building] || '139, 139, 158',
    };
}

export function toolHistorySignature(tools, { limit, detailLength }) {
    const limited = (tools || []).slice(-limit);
    return `${limited.length}|${hashRows(limited, [
        row => row?.ts || 0,
        row => row?.tool || '',
        row => row?.detail || '',
    ])}`;
}

const PIXEL_ICON_SHAPES = Object.freeze({
    read: 'read-page', search: 'search-lens', write: 'edit-strike',
    exec: 'shell-slate', task: 'task-slip', other: 'tool-unknown',
});

export function pixelIcon(kind = 'other') {
    const shape = PIXEL_ICON_SHAPES[kind] || (EVENT_SHAPES[`district-${kind}`] ? `district-${kind}` : 'tool-unknown');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', eventShapeSvgViewBox(shape));
    svg.setAttribute('class', 'cv-pixel-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('d', eventShapeSvgPath(shape) || eventShapeSvgPath('tool-unknown'));
    svg.appendChild(path);
    return svg;
}

export function inspectableText(text, { summary = 'Inspect available text', key = '', truncated = false } = {}) {
    const value = String(text ?? '');
    const node = el('details', {
        className: 'cv-inspection',
        dataset: { detailKey: key, detailSignature: JSON.stringify([summary, value, truncated]) },
    }, [
        el('summary', { text: summary }),
        el('pre', { className: 'cv-inspection__text', text: value }),
        truncated ? el('div', { className: 'cv-inspection__note', text: 'The provider supplied a truncated excerpt.' }) : null,
    ]);
    return node;
}

// Reuse unchanged disclosures so polling preserves expansion, focus and selected text.
export function replaceDetailRows(container, nodes) {
    const previous = new Map([...container.children].map(node => [node.dataset.detailKey, node]));
    const active = document.activeElement;
    const desired = nodes.map(node => {
        const old = previous.get(node.dataset.detailKey);
        if (old && old.dataset.detailSignature === node.dataset.detailSignature) return old;
        if (old?.open) node.open = true;
        if (old?.contains(active)) node._restoreFocus = true;
        return node;
    });
    for (const child of [...container.children]) if (!desired.includes(child)) child.remove();
    desired.forEach((node, index) => {
        if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
        if (node._restoreFocus) { node.querySelector('summary')?.focus({ preventScroll: true }); delete node._restoreFocus; }
    });
    if (active?.isConnected && container.contains(active) && document.activeElement !== active) active.focus?.({ preventScroll: true });
}

export function detailFreshnessLabel(agent, cacheState, now = Date.now()) {
    const server = cacheState?.value?.freshness || agent?.freshness;
    const stale = server?.state === 'stale' || (cacheState?.hasEntry && !cacheState.isFresh);
    if (!stale) return '';
    const observedAt = Number(server?.observedAt) || Number(cacheState?.entry?.at);
    const age = observedAt ? Math.max(0, now - observedAt) : Number(server?.ageMs ?? cacheState?.age);
    return Number.isFinite(age) ? `Cached · updated ${formatElapsed(age)} ago` : 'Cached · update unavailable';
}

export function signalProvenance(agent) {
    const source = agent?.signalSource === 'hook' ? 'HOOK' : 'TRANSCRIPT';
    const certainty = agent?.signalCertainty || (agent?.signalSource === 'hook' ? 'observed' : 'inferred');
    return `${source} · ${certainty}${agent?.signalStale ? ' · stale' : ''}`;
}

export function toolHistoryNodes(tools, options = {}) {
    const {
        limit,
        detailLength = 60,
        emptyText = 'No tool usage',
        emptyClass = '',
        emptyStyle = null,
        itemClass,
        iconClass,
        nameClass,
        detailClass,
        formatDetail = null,
        // 4.4 — opt-in relative-timestamp span per row (dashboard only);
        // callers that omit timeClass render exactly as before.
        timeClass = '',
        includeCategoryClasses = false,
    } = options;
    const limited = (tools || []).slice(-(limit || tools?.length || 0));
    if (!limited.length) {
        return [
            el('div', {
                className: emptyClass,
                text: emptyText,
                style: emptyStyle || undefined,
            }),
        ];
    }
    return [...limited].reverse().map((entry, index) => {
        const cat = includeCategoryClasses ? toolCategory(entry.tool) : '';
        const categoryClass = cat ? `tool-cat--${cat}` : '';
        const rawDetail = entry.detail == null ? '' : String(entry.detail);
        const formattedDetail = typeof formatDetail === 'function'
            ? formatDetail(rawDetail, entry)
            : formatToolDetail(rawDetail, { max: detailLength });
        const children = [
            el('span', {
                className: [iconClass, categoryClass],
            }, [pixelIcon(toolCategory(entry.tool))]),
            el('span', {
                className: [nameClass, categoryClass],
                text: shortToolName(entry.tool),
            }),
            el('span', {
                className: detailClass,
                text: formattedDetail,
                title: rawDetail,
            }),
        ];
        if (timeClass) {
            children.push(el('span', {
                className: timeClass,
                text: formatRelative(Number(entry.ts) || 0),
            }));
        }
        const key = String(entry.id || `${entry.ts || index}:${entry.tool || ''}`);
        const node = inspectableText(rawDetail, { key, truncated: entry.truncated === true || entry.detailTruncated === true });
        node.classList.add(itemClass);
        node.dataset.detailSignature = JSON.stringify(entry);
        node.querySelector('summary').replaceChildren(...children);
        return node;
    });
}
