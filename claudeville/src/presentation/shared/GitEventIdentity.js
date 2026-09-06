const DEFAULT_LABEL_CHARS = 30;

export function parseEventTime(value, fallback = 0) {
    if (Number.isFinite(Number(value))) return Number(value);
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

export function stripShellQuotes(value = '') {
    const text = String(value).trim();
    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return text.slice(1, -1);
        }
    }
    return text;
}

export function cleanCommitSubject(value = '') {
    let text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';

    const heredoc = text.match(/\$\(cat\s+<<['"]?([A-Za-z0-9_-]+)['"]?\s+([\s\S]*?)\s+\1\s*\)?/);
    if (heredoc) text = heredoc[2];

    text = stripShellQuotes(text)
        .replace(/\s+Co-Authored-By:.*$/i, '')
        .replace(/\s+Signed-off-by:.*$/i, '')
        .replace(/\s+EOF\s*\)?\s*$/i, '')
        .replace(/^\$\(cat\s+<<['"]?[A-Za-z0-9_-]+['"]?\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();

    return text;
}

export function commitMessageFromCommand(command) {
    const text = String(command || '');
    const match = text.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
    if (!match) return '';
    return cleanCommitSubject(match[1] || match[2] || match[3] || '');
}

export function shortGitLabel(value, maxChars = DEFAULT_LABEL_CHARS, ellipsis = '...') {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(1, maxChars - ellipsis.length))}${ellipsis}`;
}

export function projectNameFromPath(project) {
    const text = String(project || 'unknown').trim();
    const parts = text.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || text || 'unknown';
}

export function displayRepoName(project, maxChars = 26) {
    return shortGitLabel(projectNameFromPath(project), maxChars, '…')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

export function gitEventKind(event) {
    const raw = String(event?.type || event?.kind || event?.action || event?.event || event?.name || '').toLowerCase();
    const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
    if (raw.includes('push')) return 'push';
    if (raw.includes('commit')) return 'commit';
    if (tokens.includes('fetch') || raw.includes('fetch')) return 'fetch';
    if ((tokens.includes('pull') || raw.includes('git pull')) && !tokens.includes('request')) return 'pull';
    if (event?.pushed === true || Array.isArray(event?.commits)) return 'push';
    if (event?.sha || event?.commit || event?.hash) return 'commit';
    if (event?.fetched === true) return 'fetch';
    if (event?.pulled === true) return 'pull';
    return null;
}

const CANCELLED_STATUS_KEYWORDS = new Set(['cancelled', 'canceled', 'timed_out', 'timeout']);

function normalizeGitCommandStatus(event) {
    if (!event || typeof event !== 'object') return 'unknown';
    if (typeof event.success === 'boolean') return event.success ? 'success' : 'failed';

    const exitCode = event.exitCode ?? event.exit_code ?? event.code ?? event.returnCode ?? event.return_code;
    if (Number.isFinite(Number(exitCode))) return Number(exitCode) === 0 ? 'success' : 'failed';

    const raw = event.status
        ?? event.outcome
        ?? event.conclusion
        ?? event.result
        ?? event.state
        ?? event.lifecycle
        ?? '';
    const text = String(raw).toLowerCase();
    if (!text) return 'unknown';
    if (['success', 'succeeded', 'ok', 'passed', 'pass', 'complete', 'completed', 'landed'].includes(text)) return 'success';
    if (CANCELLED_STATUS_KEYWORDS.has(text)) return 'cancelled';
    if (['failed', 'failure', 'fail', 'error', 'errored'].includes(text)) return 'failed';
    return 'unknown';
}

export function normalizePushStatus(event) {
    if (!event || typeof event !== 'object') return 'unknown';
    // rejected: non-fast-forward or upstream refused
    const stderr = String(event.stderr || event.output || '');
    const looksRejected = /rejected|non-fast-forward|failed to push some refs/i.test(stderr);
    if (typeof event.success === 'boolean') {
        if (event.success) return 'success';
        return looksRejected ? 'rejected' : 'failed';
    }
    const exitCode = event.exitCode ?? event.exit_code ?? event.code ?? event.returnCode ?? event.return_code;
    if (Number.isFinite(Number(exitCode))) {
        if (Number(exitCode) === 0) return 'success';
        return looksRejected ? 'rejected' : 'failed';
    }

    const raw = event.status
        ?? event.outcome
        ?? event.conclusion
        ?? event.result
        ?? event.state
        ?? event.lifecycle
        ?? '';
    const text = String(raw).toLowerCase();
    if (!text) return looksRejected ? 'rejected' : 'unknown';
    if (['success', 'succeeded', 'ok', 'passed', 'pass', 'complete', 'completed', 'landed'].includes(text)) return 'success';
    if (text === 'rejected') return 'rejected';
    // 5.11 — cancel/timeout keywords are conceptually distinct from a hard failure;
    // surface them as 'cancelled' so the harbor renderer can show a soft return.
    if (CANCELLED_STATUS_KEYWORDS.has(text)) {
        return looksRejected ? 'rejected' : 'cancelled';
    }
    if (['failed', 'failure', 'fail', 'error', 'errored'].includes(text)) {
        return looksRejected ? 'rejected' : 'failed';
    }
    return looksRejected ? 'rejected' : 'unknown';
}

function eventLabel(event, type, sha, options = {}) {
    const {
        maxLabelChars = DEFAULT_LABEL_CHARS,
        ellipsis = '...',
        cleanCommitLabels = true,
        includeTitle = true,
        subjectBeforeMessage = false,
    } = options;
    const explicit = subjectBeforeMessage
        ? event.label || event.subject || event.message || (includeTitle ? event.title : '') || ''
        : event.label || event.message || event.subject || (includeTitle ? event.title : '') || '';
    if (explicit) {
        const text = type === 'commit' && cleanCommitLabels
            ? cleanCommitSubject(explicit) || explicit
            : explicit;
        return shortGitLabel(text, maxLabelChars, ellipsis);
    }
    if (type === 'commit') {
        const commandLabel = commitMessageFromCommand(event.command);
        if (commandLabel) return shortGitLabel(commandLabel, maxLabelChars, ellipsis);
    }
    if (sha) return shortGitLabel(String(sha).slice(0, 10), maxLabelChars, ellipsis);
    if (type === 'pull' || type === 'fetch') {
        const remote = event.remote || '';
        const ref = event.targetRef || event.ref || event.branch || event.refspec || '';
        const parts = [type, remote, ref].filter(Boolean);
        if (parts.length > 1) return shortGitLabel(parts.join(' '), maxLabelChars, ellipsis);
    }
    return shortGitLabel(event.commandHash || event.id || type, maxLabelChars, ellipsis);
}

function boundedConfidence(value, fallback = null) {
    if (value == null || value === '') return fallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(0, Math.min(1, numeric));
}

function eventSource(event, inferred) {
    const explicit = event.source || event.eventSource || event.sourceType || event.origin || '';
    if (explicit) return String(explicit);
    if (event.command) return 'command-parser';
    return inferred ? 'inferred' : 'observed';
}

export function normalizeGitEvent(event, agent = {}, index = 0, options = {}) {
    if (!event || typeof event !== 'object') return null;

    const type = gitEventKind(event);
    if (!type) return null;

    const fallbackTimestamp = Object.prototype.hasOwnProperty.call(options, 'fallbackTimestamp')
        ? options.fallbackTimestamp
        : parseEventTime(agent.lastSessionActivity, 0);
    const project = event.project
        || event.projectPath
        || event.repository
        || event.repo
        || event.workspace
        || agent.projectPath
        || agent.teamName
        || agent.project
        || 'unknown';
    const sha = event.sha || event.commit || event.hash || event.commitSha || event.revision || '';
    const targetRef = event.targetRef || event.target || event.ref || event.branch || '';
    const branch = event.branch || (type === 'commit' || type === 'push' || type === 'pull' || type === 'fetch' ? targetRef : '');
    const completedAt = parseEventTime(event.completedAt || event.completed_at, 0);
    const timestamp = parseEventTime(
        event.timestamp || event.time || event.ts || event.date || event.createdAt || event.created_at || completedAt,
        fallbackTimestamp
    );
    const id = event.id
        || event.eventId
        || event.uuid
        || event.key
        || `${type}:${project}:${sha}:${timestamp}:${index}`;
    const inferred = event.inferred === true;
    const hasCompletionMetadata = completedAt > 0
        || typeof event.success === 'boolean'
        || Number.isFinite(Number(event.exitCode ?? event.exit_code))
        || event.status != null;
    const confidence = boundedConfidence(
        event.confidence ?? event.sourceConfidence ?? event.confidenceScore,
        inferred ? 0.7 : (hasCompletionMetadata ? 0.95 : 0.82)
    );
    const status = type === 'push'
        ? normalizePushStatus(event)
        : (type === 'pull' || type === 'fetch' ? normalizeGitCommandStatus(event) : null);
    const remote = event.remote || event.remoteName || event.repositoryRemote || '';
    const refspecs = Array.isArray(event.refspecs)
        ? event.refspecs.map(refspec => String(refspec)).filter(Boolean)
        : [];
    const refspec = event.refspec || event.refSpec || refspecs[0] || '';

    return {
        id: String(id),
        type,
        project: String(project),
        repoName: projectNameFromPath(project),
        sha: sha ? String(sha) : '',
        timestamp,
        ts: timestamp,
        label: eventLabel(event, type, sha, options),
        command: event.command ? String(event.command) : '',
        commandHash: event.commandHash || '',
        targetRef,
        branch,
        remote,
        ref: event.ref || refspec || targetRef || branch || '',
        refspec,
        refspecs,
        flags: Array.isArray(event.flags) ? [...event.flags] : [],
        upstream: event.upstream || '',
        comparisonRef: event.comparisonRef || '',
        inferred,
        observed: event.observed === true || (!inferred && event.observed !== false),
        source: eventSource(event, inferred),
        confidence,
        provider: event.provider || agent.provider || '',
        sessionId: event.sessionId || event.session_id || agent.sessionId || agent.agentId || agent.id || '',
        sourceId: event.sourceId || '',
        success: typeof event.success === 'boolean' ? event.success : null,
        exitCode: Number.isFinite(Number(event.exitCode ?? event.exit_code))
            ? Number(event.exitCode ?? event.exit_code)
            : null,
        completedAt,
        status,
        force: event.force || null,
        dryRun: event.dryRun === true,
        agentId: agent.id || agent.agentId || '',
        agentName: event.agentName || agent.agentName || agent.name || '',
        agentStatus: agent.status || '',
        agentModel: event.model || agent.model || '',
        teamName: event.teamName || agent.teamName || '',
    };
}

export function collectGitEventsFromAgents(agents, options = {}) {
    const events = [];
    for (const agent of agents || []) {
        const sources = [
            agent?.gitEvents,
            agent?.git?.events,
            agent?.vcsEvents,
        ].filter(Array.isArray);
        for (const source of sources) {
            source.forEach((event, index) => {
                const normalized = normalizeGitEvent(event, agent, index, options);
                if (normalized && (!options.type || normalized.type === options.type)) {
                    events.push(normalized);
                }
            });
        }
    }
    events.sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
    return events;
}

export function collectCommitEvents(agents, options = {}) {
    return collectGitEventsFromAgents(agents, {
        type: 'commit',
        maxLabelChars: 34,
        ellipsis: '...',
        includeTitle: false,
        subjectBeforeMessage: true,
        fallbackTimestamp: Date.now(),
        ...options,
    });
}
