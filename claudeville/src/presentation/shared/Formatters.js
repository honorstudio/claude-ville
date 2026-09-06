import { AgentStatus, normalizeAgentStatus } from '../../domain/value-objects/AgentStatus.js';

const HOME_ROOTS = Object.freeze(['users', 'home']);
const ABSOLUTE_PATH_TOKEN_RE = /(^|[\s"'`=(\[{])((?:\/|[A-Za-z]:[\\/])[^"'`\s;&|<>()[\]{}]*)/g;
const COMMAND_PREFIX_RE = /^(?:(?:env|sudo|command|exec|time)\s+)*(?:apply_patch|awk|bash|bun|cargo|cat|cd|chmod|chown|cmd|composer|cp|curl|deno|diff|docker|fd|find|gh|git|grep|head|java|javac|jest|kubectl|ls|make|mkdir|mv|node|npm|npx|patch|perl|php|pip|pnpm|powershell|pytest|python|python3|pwd|pwsh|rg|rm|ruby|rustc|sed|scp|sh|ssh|tail|touch|vitest|wget|yarn|zsh)(?=\s|$)/i;
const RELATIVE_TIME_THRESHOLDS = [
    [60_000, 'just now'],
    [60 * 60_000, (ms) => `${Math.floor(ms / 60_000)}m ago`],
    [24 * 60 * 60_000, (ms) => `${Math.floor(ms / (60 * 60_000))}h ago`],
    [7 * 24 * 60 * 60_000, (ms) => `${Math.floor(ms / (24 * 60 * 60_000))}d ago`],
];
const ELAPSED_PATCH_INTERVAL_MS = 1000;
const elapsedTargets = new Set();
let elapsedTimer = null;

export function hashRows(rows, fields) {
    let hash = 2166136261;
    for (const row of rows || []) {
        for (const field of fields) {
            const value = typeof field === 'function' ? field(row) : row?.[field];
            const str = String(value ?? '');
            for (let i = 0; i < str.length; i++) {
                hash ^= str.charCodeAt(i);
                hash = Math.imul(hash, 16777619);
            }
            hash ^= 31;
            hash = Math.imul(hash, 16777619);
        }
        hash ^= 124;
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function normalizeStatus(status, fallback = 'idle') {
    return normalizeAgentStatus(status, fallback);
}

export function statusClass(status, fallback = 'idle') {
    const normalized = normalizeStatus(status, fallback);
    return [
        AgentStatus.WORKING,
        AgentStatus.IDLE,
        AgentStatus.WAITING,
        AgentStatus.RATE_LIMITED,
        AgentStatus.ERRORED,
        AgentStatus.WAITING_ON_USER,
        // 0.4 — completed is a first-class status with its own rail/dot/token;
        // without it a finished agent fell through to the idle class.
        AgentStatus.COMPLETED,
    ].includes(normalized) ? normalized : fallback;
}

export function formatNumber(num) {
    const value = Number(num) || 0;
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
    return String(value);
}

export function formatTokens(value) {
    return formatNumber(value);
}

export function formatRelative(ts, now = Date.now()) {
    if (!Number.isFinite(ts) || ts <= 0) return '';
    const ms = Math.max(0, now - ts);
    for (const [bound, fmt] of RELATIVE_TIME_THRESHOLDS) {
        if (ms < bound) return typeof fmt === 'function' ? fmt(ms) : fmt;
    }
    return `${Math.floor(ms / (7 * 24 * 60 * 60_000))}w ago`;
}

export function formatElapsed(ms) {
    const elapsed = Math.max(0, Math.floor(Number(ms) || 0));
    const seconds = Math.floor(elapsed / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return remainingSeconds ? `${minutes}m${remainingSeconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) return remainingMinutes ? `${hours}h${remainingMinutes}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours ? `${days}d${remainingHours}h` : `${days}d`;
}

export function workingSetForAgent(agent) {
    return Array.isArray(agent?.workingSet) ? agent.workingSet.slice(0, 16) : [];
}

export function collisionsForAgent(agent) {
    return Array.isArray(agent?.collisions) ? agent.collisions : [];
}

export function formatStatusElapsed(agent, now = Date.now()) {
    const since = Number(agent?.statusSince);
    if (!Number.isFinite(since) || since <= 0) return '';
    const elapsed = formatElapsed(Math.max(0, now - since));
    const status = normalizeStatus(agent?.status);
    const prefix = {
        [AgentStatus.WORKING]: 'Working for',
        [AgentStatus.WAITING_ON_USER]: 'Waiting on you for',
        [AgentStatus.WAITING]: 'Waiting for',
        [AgentStatus.RATE_LIMITED]: 'Rate limited for',
        [AgentStatus.ERRORED]: 'Errored for',
        [AgentStatus.COMPLETED]: 'Idle',
        [AgentStatus.IDLE]: 'Idle',
    }[status] || 'In state for';
    return `${prefix} ${elapsed}`;
}

function patchElapsedTargets() {
    const now = Date.now();
    for (const target of [...elapsedTargets]) {
        if (!target.node?.isConnected) {
            elapsedTargets.delete(target);
            continue;
        }
        const text = String(target.text(now) ?? '');
        if (target.node.nodeType === 3) {
            if (target.node.nodeValue !== text) target.node.nodeValue = text;
        } else if (target.node.textContent !== text) {
            target.node.textContent = text;
        }
    }
    if (elapsedTargets.size === 0 && elapsedTimer !== null) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
    }
}

/** Register an existing text node/element for the single shared 1 Hz patch. */
export function subscribeElapsedText(node, text) {
    if (!node || typeof text !== 'function') return () => {};
    const target = { node, text };
    elapsedTargets.add(target);
    const initial = String(text(Date.now()) ?? '');
    if (node.nodeType === 3) node.nodeValue = initial;
    else node.textContent = initial;
    if (elapsedTimer === null) elapsedTimer = setInterval(patchElapsedTargets, ELAPSED_PATCH_INTERVAL_MS);
    return () => {
        elapsedTargets.delete(target);
        if (elapsedTargets.size === 0 && elapsedTimer !== null) {
            clearInterval(elapsedTimer);
            elapsedTimer = null;
        }
    };
}

export function formatCost(cost) {
    const value = Number(cost);
    if (!Number.isFinite(value) || value <= 0) return '$0.00';
    if (value < 0.001) return '<$0.001';
    if (value >= 1) return `$${value.toFixed(2)}`;
    return `$${value.toFixed(3)}`;
}

export function shortenHomePath(path) {
    const text = String(path || '');
    if (!text || text === '_unknown') return '';
    const separator = text.includes('\\') ? '\\' : '/';
    const parts = text.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    const homeRootIndex = HOME_ROOTS.includes(String(parts[0] || '').toLowerCase())
        ? 0
        : (/^[A-Za-z]:$/.test(parts[0] || '')
            && HOME_ROOTS.includes(String(parts[1] || '').toLowerCase()) ? 1 : -1);
    if (homeRootIndex >= 0 && parts.length > homeRootIndex) {
        const suffix = parts.slice(homeRootIndex + 2).join(separator);
        return suffix ? `~${separator}${suffix}` : '~';
    }
    return text;
}

export function shortProjectName(path, unknownLabel = 'Unknown Project') {
    if (!path || path === '_unknown') return unknownLabel;
    const shortened = shortenHomePath(path);
    if (shortened === '~') return '~';
    const parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || String(path);
}

export function formatCdCommand(path) {
    const text = String(path || '').trim();
    if (!text || text === '_unknown') return '';
    return `cd '${text.replace(/'/g, `'"'"'`)}'`;
}

export function truncateText(value, max) {
    const text = String(value || '');
    const limit = Math.max(0, Math.floor(Number(max) || 0));
    if (text.length <= limit) return text;
    if (limit === 0) return '';
    if (limit === 1) return '…';
    return `${text.slice(0, limit - 1)}…`;
}

// Secrets never reach the DOM. The causal waterfall, the work score and the
// blocked banner share one redaction so a command echoed into tool history
// cannot leak a token that the banner would have stripped.
export function redactSecrets(text) {
    return String(text)
        .replace(/\b((?:[A-Za-z0-9_-]*?(?:key|token)))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi, '$1=[REDACTED]')
        .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]');
}

function normalizedPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function isWindowsPath(value) {
    return /^[A-Za-z]:[\\/]/.test(String(value || '')) || String(value || '').includes('\\');
}

function shortenAbsolutePathTokens(value) {
    return String(value || '').replace(ABSOLUTE_PATH_TOKEN_RE, (match, prefix, token) => (
        `${prefix}${shortenHomePath(token)}`
    ));
}

function unwrapPath(value) {
    const text = String(value || '').trim();
    if (text.length >= 2 && ['"', "'", '`'].includes(text[0]) && text.at(-1) === text[0]) {
        return text.slice(1, -1);
    }
    return text;
}

function isPathShapedDetail(value) {
    const text = unwrapPath(value);
    if (!text || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(text)) return false;
    if (isAbsolutePath(text) || /^~[\\/]/.test(text) || /^\.{1,2}[\\/]/.test(text)) return true;
    if (!/\s/.test(text) && /[\\/]/.test(text) && /(?:^|[\\/])[^\\/]+(?:\.[A-Za-z\d_-]+)?$/.test(text)) return true;
    return /^[^\\/\s]+\.[A-Za-z\d_-]+$/.test(text);
}

function isAbsolutePath(value) {
    return /^(?:\/|[A-Za-z]:[\\/])/.test(String(value || ''));
}

function stripProjectPrefix(pathText, projectPath) {
    const text = String(pathText || '');
    const rawProject = String(projectPath || '');
    const project = shortenHomePath(rawProject);
    const normalizedText = normalizedPath(text);
    const normalizedProject = normalizedPath(project);
    if (!normalizedText || !normalizedProject || normalizedProject === '_unknown') return text;

    const caseInsensitive = isWindowsPath(text) || isWindowsPath(rawProject) || isWindowsPath(project);
    const comparableText = caseInsensitive ? normalizedText.toLowerCase() : normalizedText;
    const comparableProject = caseInsensitive ? normalizedProject.toLowerCase() : normalizedProject;
    if (comparableText === comparableProject) return '.';
    if (!comparableText.startsWith(`${comparableProject}/`)) return text;

    const suffix = normalizedText.slice(normalizedProject.length).replace(/^\/+/, '');
    const separator = text.includes('\\') || project.includes('\\') ? '\\' : '/';
    return suffix.replace(/\//g, separator);
}

function truncatePathFromHead(value, max) {
    const text = String(value || '');
    const limit = Math.max(0, Math.floor(Number(max) || 0));
    if (text.length <= limit) return text;
    if (limit === 0) return '';
    if (limit === 1) return '…';

    const separator = text.includes('\\') ? '\\' : '/';
    const segments = text.split(/[\\/]+/).filter(Boolean);
    const filename = segments.at(-1) || text;
    const marker = `…${separator}`;
    const available = limit - marker.length;
    if (available <= 0) return `…${filename.slice(-(limit - 1))}`;
    if (filename.length >= available) return `${marker}${filename.slice(-available)}`;

    const parent = segments.at(-2) || '';
    const parentBudget = available - separator.length - filename.length;
    if (parentBudget <= 0 || !parent) return `${marker}${filename}`;
    return `${marker}${parent.slice(-parentBudget)}${separator}${filename}`;
}

/**
 * Format a tool detail without sacrificing the useful end of a file path.
 * The raw value remains available to the caller for hover text.
 */
export function formatToolDetail(detail, { max = 48, projectPath = '' } = {}) {
    const raw = String(detail || '');
    if (!raw) return '';

    if (COMMAND_PREFIX_RE.test(raw.trim())) {
        return truncateText(shortenAbsolutePathTokens(raw), max);
    }

    const shortened = shortenAbsolutePathTokens(raw);
    const pathCandidate = unwrapPath(shortened);
    if (isPathShapedDetail(pathCandidate)) {
        const displayPath = shortenHomePath(pathCandidate);
        const relativePath = stripProjectPrefix(displayPath, projectPath);
        return truncatePathFromHead(relativePath, max);
    }

    return truncateText(shortened, max);
}
