const FIELD_PRIORITY = Object.freeze({
    name: 500,
    model: 450,
    identity: 425,
    status: 400,
    tool: 300,
    file: 250,
    commit: 200,
});

const CONTEXT_LABELS = Object.freeze({
    identity: 'Identity',
    tool: 'Tool',
    file: 'File',
    commit: 'Commit',
});

const PATH_KEYS = /^(?:path|file|filename|filePath|file_path|absolutePath|relativePath|cwd|workdir|workingDirectory)$/i;
const PATH_TOKEN_PATTERN = /(?:[A-Za-z]:[\\/][^\s"'`<>|]+|\/(?:[^\s"'`<>|]+\/)*[^\s"'`<>|]+|(?:~|\.\.?)[\\/][^\s"'`<>|]+|(?:[A-Za-z0-9_.@()-]+[\\/])+(?:[A-Za-z0-9_.@()-]+)|[A-Za-z0-9_.@()-]+\.[A-Za-z0-9]{1,10})/g;
const COMMIT_MESSAGE_PATTERN = /(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i;
const MAX_CONTEXT_CHARS = 96;

function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function addValue(target, value) {
    const text = cleanText(value);
    if (text) target.add(text);
}

function cleanPath(value) {
    return cleanText(value).replace(/^[([{]+|[\])},;:]+$/g, '');
}

function collectPaths(value, target, key = '', depth = 0, seen = new Set()) {
    if (value === null || value === undefined || depth > 5) return;
    if (typeof value === 'string') {
        if (PATH_KEYS.test(key)) addValue(target, cleanPath(value));
        for (const match of value.matchAll(PATH_TOKEN_PATTERN)) addValue(target, cleanPath(match[0]));
        return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) collectPaths(item, target, key, depth + 1, seen);
        return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
        collectPaths(childValue, target, childKey, depth + 1, seen);
    }
}

function commitMessage(event) {
    if (typeof event === 'string') return cleanText(event);
    if (!event || typeof event !== 'object') return '';
    for (const key of ['subject', 'message', 'title', 'label', 'summary']) {
        const value = cleanText(event[key]);
        if (value) return value;
    }
    const match = String(event.command || '').match(COMMIT_MESSAGE_PATTERN);
    return cleanText(match?.[1] || match?.[2] || match?.[3] || '');
}

function addCommitFields(fields, events) {
    for (const event of events || []) {
        addField(fields, 'commit', commitMessage(event));
        for (const commit of event?.commits || []) addField(fields, 'commit', commitMessage(commit));
    }
}

function addField(fields, kind, value) {
    const display = cleanText(value);
    if (!display) return;
    fields.push({ kind, display, normalized: display.toLowerCase() });
}

function liveFields(agent, modelLabel) {
    const fields = [];
    addField(fields, 'name', agent?.name);
    addField(fields, 'model', modelLabel);
    addField(fields, 'model', agent?.model);
    addField(fields, 'status', agent?.status);
    for (const value of [agent?.provider, agent?.projectPath, agent?.teamName, agent?.workflowName, agent?.id, agent?.agentId, agent?.sessionId]) {
        addField(fields, 'identity', value);
    }

    for (const tool of [agent?.currentTool, agent?.lastTool, agent?.pendingTool]) {
        addField(fields, 'tool', tool);
    }

    const paths = new Set();
    collectPaths(agent?.currentToolInput, paths);
    collectPaths(agent?.lastToolInput, paths);
    for (const path of paths) addField(fields, 'file', path);

    addCommitFields(fields, agent?.gitEvents);
    return fields;
}

function detailFields(detail) {
    const fields = [];
    if (!detail || typeof detail !== 'object') return fields;

    const paths = new Set();
    for (const item of detail.toolHistory || []) {
        addField(fields, 'tool', item?.tool || item?.name || item?.action);
        collectPaths(item?.detail, paths);
        collectPaths(item?.input, paths);
        collectPaths(item?.arguments, paths);
    }
    for (const path of paths) addField(fields, 'file', path);
    addCommitFields(fields, detail.gitEvents);
    return fields;
}

function dedupeFields(fields) {
    const seen = new Set();
    return fields.filter((field) => {
        const key = `${field.kind}\u0000${field.normalized}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function fieldsSignature(fields) {
    return fields.map(field => `${field.kind}:${field.normalized}`).join('\u0001');
}

function contextText(field) {
    const label = CONTEXT_LABELS[field?.kind];
    if (!label) return null;
    const value = field.display.length > MAX_CONTEXT_CHARS
        ? `${field.display.slice(0, MAX_CONTEXT_CHARS - 1)}…`
        : field.display;
    return `${label} · ${value}`;
}

function scoreMatch(field, query) {
    const position = field.normalized.indexOf(query);
    if (position < 0) return null;
    let score = FIELD_PRIORITY[field.kind] || 0;
    if (field.normalized === query) score += 40;
    else if (position === 0) score += 20;
    score += Math.max(0, 10 - Math.min(position, 10));
    return score;
}

export class AgentSearchIndex {
    constructor() {
        this._entries = new Map();
        this._nextOrder = 0;
        this.revision = 0;
    }

    has(agentId) {
        return this._entries.has(agentId);
    }

    upsert(agent, { modelLabel = '', detail = null } = {}) {
        if (!agent?.id) return false;
        const previous = this._entries.get(agent.id);
        const sessionKey = `${agent.provider || ''}\u0000${agent.projectPath || ''}\u0000${agent.id}`;
        const retainedDetailFields = previous?.sessionKey === sessionKey ? previous.detailFields : [];
        const nextDetailFields = detail ? detailFields(detail) : retainedDetailFields;
        const fields = dedupeFields([...liveFields(agent, modelLabel), ...nextDetailFields]);
        const signature = fieldsSignature(fields);
        if (previous?.sessionKey === sessionKey && previous.signature === signature) return false;

        this._entries.set(agent.id, {
            agentId: agent.id,
            sessionKey,
            fields,
            detailFields: nextDetailFields,
            signature,
            order: previous?.order ?? this._nextOrder++,
        });
        this.revision++;
        return true;
    }

    remove(agentId) {
        if (!this._entries.delete(agentId)) return false;
        this.revision++;
        return true;
    }

    clear() {
        if (this._entries.size === 0) return;
        this._entries.clear();
        this.revision++;
    }

    match(agentId, query) {
        const normalizedQuery = cleanText(query).toLowerCase();
        const entry = this._entries.get(agentId);
        if (!entry) return null;
        if (!normalizedQuery) return { agentId, score: 0, context: null, order: entry.order };

        const matches = [];
        for (const field of entry.fields) {
            const score = scoreMatch(field, normalizedQuery);
            if (score !== null) matches.push({ field, score });
        }
        if (matches.length === 0) return null;
        matches.sort((a, b) => b.score - a.score);
        const contextMatch = matches
            .filter(match => CONTEXT_LABELS[match.field.kind])
            .sort((a, b) => b.score - a.score)[0];
        return {
            agentId,
            score: matches[0].score + Math.min(30, (matches.length - 1) * 5),
            context: contextText(contextMatch?.field),
            order: entry.order,
        };
    }

    search(query, agentIds = null) {
        const allowed = agentIds ? new Set(agentIds) : null;
        const results = [];
        for (const agentId of this._entries.keys()) {
            if (allowed && !allowed.has(agentId)) continue;
            const result = this.match(agentId, query);
            if (result) results.push(result);
        }
        return results.sort((a, b) => b.score - a.score || a.order - b.order);
    }
}
