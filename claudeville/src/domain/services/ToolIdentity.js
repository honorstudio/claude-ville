const TOOL_METADATA = Object.freeze({
    Read: {
        classification: { building: 'archive', reason: 'read-local', confidence: 0.72 },
        icon: '📖',
        category: 'read',
        actionLabel: 'Reading',
        localInspection: true,
    },
    Grep: {
        classification: { building: 'archive', reason: 'search-local', confidence: 0.7 },
        icon: '🔍',
        category: 'search',
        actionLabel: 'Searching',
        localInspection: true,
    },
    Glob: {
        classification: { building: 'archive', reason: 'find-local', confidence: 0.68 },
        icon: '📁',
        category: 'search',
        actionLabel: 'Finding',
        localInspection: true,
    },
    LS: {
        classification: { building: 'archive', reason: 'list-local', confidence: 0.64 },
        localInspection: true,
    },

    WebSearch: {
        classification: { building: 'observatory', reason: 'web-search', confidence: 0.95 },
        icon: '🌐',
        category: 'search',
        actionLabel: 'Researching',
        hostLabel: true,
    },
    WebFetch: {
        classification: { building: 'observatory', reason: 'web-fetch', confidence: 0.95 },
        icon: '🌐',
        category: 'search',
        actionLabel: 'Fetching',
        hostLabel: true,
    },
    'web.run': {
        classification: { building: 'observatory', reason: 'web-tool', confidence: 0.95 },
        hostLabel: true,
    },

    Edit: {
        classification: { building: 'forge', reason: 'edit-file', confidence: 0.96 },
        icon: '✏️',
        category: 'write',
        actionLabel: 'Editing',
        fileMutation: true,
    },
    MultiEdit: {
        classification: { building: 'forge', reason: 'edit-file', confidence: 0.96 },
        category: 'write',
        actionLabel: 'Editing',
        fileMutation: true,
    },
    Write: {
        classification: { building: 'forge', reason: 'write-file', confidence: 0.96 },
        icon: '📝',
        category: 'write',
        actionLabel: 'Writing',
        fileMutation: true,
    },
    apply_patch: {
        classification: { building: 'forge', reason: 'patch-file', confidence: 0.98 },
        actionLabel: 'Patching',
        fileMutation: true,
    },
    'functions.apply_patch': {
        classification: { building: 'forge', reason: 'patch-file', confidence: 0.98 },
        actionLabel: 'Patching',
        fileMutation: true,
    },
    NotebookEdit: {
        classification: { building: 'forge', reason: 'edit-notebook', confidence: 0.86 },
        icon: '📓',
        category: 'write',
        actionLabel: 'Editing notebook',
    },
    'image_gen.imagegen': {
        classification: { building: 'forge', reason: 'generate-asset', confidence: 0.82 },
    },

    Bash: { icon: '⚡', category: 'exec', actionLabel: 'Running' },

    Task: {
        classification: { building: 'command', reason: 'delegate-task', confidence: 0.82 },
        icon: '📋',
        category: 'task',
        actionLabel: 'Delegating',
    },
    TeamCreate: {
        classification: { building: 'command', reason: 'form-team', confidence: 0.96 },
        icon: '👥',
        category: 'task',
        actionLabel: 'Forming team',
    },
    SendMessage: {
        classification: { building: 'command', reason: 'message-agent', confidence: 0.98 },
        icon: '💬',
        category: 'task',
        actionLabel: 'Messaging',
    },
    send_message: {
        classification: { building: 'command', reason: 'message-agent', confidence: 0.98 },
        icon: '💬',
        category: 'task',
        actionLabel: 'Messaging',
    },
    'functions.spawn_agent': {
        classification: { building: 'command', reason: 'spawn-agent', confidence: 0.98 },
        agentCommand: true,
    },
    spawn_agent: {
        classification: { building: 'command', reason: 'spawn-agent', confidence: 0.98 },
        agentCommand: true,
    },
    'functions.send_input': {
        classification: { building: 'command', reason: 'send-agent-input', confidence: 0.98 },
        agentCommand: true,
    },
    'functions.wait_agent': {
        classification: { building: 'command', reason: 'wait-agent', confidence: 0.98 },
        agentCommand: true,
    },
    wait_agent: {
        classification: { building: 'command', reason: 'wait-agent', confidence: 0.98 },
        agentCommand: true,
    },
    wait: {
        classification: { building: 'command', reason: 'wait-agent', confidence: 0.9 },
        agentCommand: true,
    },
    'functions.close_agent': {
        classification: { building: 'command', reason: 'close-agent', confidence: 0.98 },
        agentCommand: true,
    },
    close_agent: {
        classification: { building: 'command', reason: 'close-agent', confidence: 0.98 },
        agentCommand: true,
    },
    'functions.resume_agent': {
        classification: { building: 'command', reason: 'resume-agent', confidence: 0.98 },
        agentCommand: true,
    },
    resume_agent: {
        classification: { building: 'command', reason: 'resume-agent', confidence: 0.98 },
        agentCommand: true,
    },
    list_agents: {
        classification: { building: 'command', reason: 'list-agents', confidence: 0.9 },
        icon: '👥',
        category: 'task',
        actionLabel: 'Coordinating',
    },

    TaskCreate: {
        classification: { building: 'taskboard', reason: 'plan-task', confidence: 0.92 },
        icon: '📋',
        category: 'task',
        actionLabel: 'Planning',
    },
    TaskUpdate: {
        classification: { building: 'taskboard', reason: 'update-task', confidence: 0.92 },
        icon: '📋',
        category: 'task',
    },
    TaskList: {
        classification: { building: 'taskboard', reason: 'review-tasks', confidence: 0.88 },
        icon: '📋',
        category: 'task',
        actionLabel: 'Reviewing tasks',
    },
    TodoWrite: {
        classification: { building: 'taskboard', reason: 'plan-work', confidence: 0.95 },
        icon: '📋',
        category: 'task',
    },
    EnterPlanMode: {
        classification: { building: 'taskboard', reason: 'plan-mode-enter', confidence: 0.94 },
        icon: '📐',
    },
    ExitPlanMode: {
        classification: { building: 'taskboard', reason: 'plan-mode-exit', confidence: 0.94 },
        icon: '📐',
    },
    'functions.update_plan': {
        classification: { building: 'taskboard', reason: 'plan-work', confidence: 0.95 },
    },
    'functions.request_user_input': {
        classification: { building: 'taskboard', reason: 'ask-decision', confidence: 0.86 },
    },

    AskUserQuestion: { icon: '❓' },
});

function toolMetadata(tool) {
    return TOOL_METADATA[String(tool || '')] || null;
}

function toolNamesWhere(predicate) {
    return new Set(Object.entries(TOOL_METADATA)
        .filter(([, metadata]) => predicate(metadata))
        .map(([tool]) => tool));
}

const COMMAND_AGENT_TOOLS = toolNamesWhere((metadata) => metadata.agentCommand);
const FILE_MUTATION_TOOLS = toolNamesWhere((metadata) => metadata.fileMutation);
const LOCAL_INSPECTION_TOOLS = toolNamesWhere((metadata) => metadata.localInspection);
const HOST_LABEL_TOOLS = toolNamesWhere((metadata) => metadata.hostLabel);

const MULTI_TOOL_NAMES = new Set([
    'multi_tool_use',
    'multi_tool_use.parallel',
]);

const SHELL_TOOL_NAMES = new Set([
    'Bash',
    'shell',
    'exec',
    'exec_command',
    'functions.exec_command',
    'functions.write_stdin',
    'command_execution',
]);

const MULTI_TOOL_PRIORITY = ['harbor', 'taskboard', 'command', 'forge', 'archive', 'portal', 'observatory', 'mine'];

const NORMALIZED_INPUT_FIELDS = Object.freeze([
    'cmd',
    'command',
    'script',
    'args',
    'arguments',
    'url',
    'path',
    'file_path',
    'cwd',
    'pattern',
    'query',
    'prompt',
    'description',
    'recipient_name',
]);

const SHELL_WRAPPER_PREFIXES = new Set(['bash', 'sh', 'zsh', 'fish', 'exec_command', 'shell', 'command_execution']);
const BOUNDARY_CHARS = ['/', '.', ' ', ':'];
const SHELL_LIKE_INPUT_PATTERN = /^(?:bash|sh|zsh|fish|exec_command|shell|command_execution|git|gh|wrangler|vercel|npm|node|pnpm|yarn|bun|python|pytest|playwright|curl|wget|rg|grep|find|fd|ls|cat|sed|head|tail|jq|pharos-watch)\b/;
const DOCUMENTATION_INPUT_PATTERN = /\b(agents|docs|doc|documentation|readme|changelog|handover|plan|spec|adr)\b|(?:^|[\/\s"'=])(?:agents|claude|readme|changelog|contributing|license)(?:\.md)?\b|\.mdx?\b/;
const CODE_INPUT_PATTERN = /\b(src|server\.js|adapters|services|claudeville\/src|claudeville\/server\.js)\b|\.([cm]?js|ts|tsx|jsx|css|html|json|yaml|yml)\b/;
const JSONISH_INPUT_PATTERN = /^[\[{]/;
const TOOL_REFERENCE_PATTERN = /(?:recipient_name|tool|name)["']?\s*[:=]\s*["']([^"']+)["']/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/i;
const PLAYWRIGHT_PLUGIN_TOOL_PATTERN = /^mcp__plugin_playwright_/;
const LOCAL_PREVIEW_INPUT_PATTERN = /localhost:|127\.0\.0\.1:/;

const GIT_FLOW_COMMAND_PATTERN = /\b(git\s+(status|diff|show|log|branch|rev-list|fetch|pull|merge|rebase|commit|push|tag)|gh\s+(pr\s+create|release|workflow|run|repo)|wrangler\s+deploy|vercel\s+deploy|npm\s+run\s+deploy)\b/;
const VALIDATION_COMMAND_PATTERN = /\b(npm\s+(test|run\s+(test|check|lint|build|sprites:validate|sprites:visual-diff))|node\s+--check|xargs\s+-0\s+-n1\s+node\s+--check|pytest|vitest|playwright\s+test)\b/;
const BROWSER_PREVIEW_COMMAND_PATTERN = /\b(npm\s+run\s+dev|node\s+claudeville\/server\.js|playwright|browser|chrome|chromium|firefox|screenshot|localhost|127\.0\.0\.1)\b/;
const WEB_COMMAND_PATTERN = /\b(curl|wget|web|fetch|search_query|open\s+https?:\/\/)\b/;
const FILE_MUTATION_COMMAND_PATTERN = /\b(apply_patch|patch|edit|write|create|update|delete|mv|cp|perl\s+-pi)\b/;
const LOCAL_READ_COMMAND_PATTERN = /\b(rg|grep|find|fd|ls|cat|sed|head|tail|nl|wc|jq)\b/;
const TASK_COMMAND_INPUT_PATTERN = /\b(test|check|lint|build|vitest|pytest|playwright\s+test|node\s+--check|sprites:validate)\b/;

const AGENT_ORCHESTRATION_TOOL_PATTERN = /spawn_agent|send_input|wait_agent|resume_agent|close_agent/;
const BROWSER_TOOL_NAME_PATTERN = /playwright|browser|chrome/;
const GITHUB_TOOL_NAME_PATTERN = /github|pull_request| pr_/;
const WEB_TOOL_NAME_PATTERN = /web|fetch/;
const FILE_MUTATION_TOOL_NAME_PATTERN = /apply_patch|edit|write|update_file|create_file|delete_file/;
const TEAM_TOOL_NAME_PATTERN = /team|parallel/;
const TASK_TOOL_NAME_PATTERN = /task|todo|plan/;
const READ_TOOL_NAME_PATTERN = /read|grep|glob|find|search/;
const COMMAND_TOOL_NAME_PATTERN = /spawn_agent|send_input|resume_agent|close_agent|team|parallel/;

export function normalizeToolInput(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input.toLowerCase();
    if (typeof input === 'object') {
        const parts = [];
        for (const field of NORMALIZED_INPUT_FIELDS) {
            if (input[field] == null) continue;
            parts.push(typeof input[field] === 'object' ? JSON.stringify(input[field]) : String(input[field]));
        }
        if (parts.length) return parts.join(' ').toLowerCase();
    }
    return String(input).toLowerCase();
}

export function compactToolLabel(value, fallback = '', maxChars = 18) {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    const lastSlash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    const base = (lastSlash >= 0 ? text.slice(lastSlash + 1) : text).split(/\s+/)[0] || text;
    return base.length > maxChars ? `${base.slice(0, Math.max(1, maxChars - 3))}...` : base;
}

function snapToBoundary(text, maxLength) {
    if (text.length <= maxLength) return text;
    const window = Math.max(1, Math.floor(maxLength / 4));
    let bestIndex = -1;
    for (let i = maxLength; i >= Math.max(1, maxLength - window); i--) {
        if (BOUNDARY_CHARS.includes(text[i - 1])) { bestIndex = i - 1; break; }
    }
    if (bestIndex < 0) {
        const forwardLimit = Math.min(text.length, maxLength + 4);
        for (let i = maxLength; i < forwardLimit; i++) {
            if (BOUNDARY_CHARS.includes(text[i])) { bestIndex = i; break; }
        }
    }
    if (bestIndex > 0) {
        const snapped = text.slice(0, bestIndex).replace(/[\s./:]+$/, '');
        if (snapped.length >= Math.max(3, maxLength - window)) return `${snapped}...`;
    }
    return `${text.slice(0, Math.max(1, maxLength - 3))}...`;
}

export function compactShellInputPreview(input, maxLength = 18) {
    if (input == null) return '';
    const raw = String(input).trim();
    if (!raw) return '';
    const tokens = raw.split(/\s+/);
    let head = tokens[0] || '';
    if (SHELL_WRAPPER_PREFIXES.has(head.toLowerCase()) && tokens[1]) head = tokens[1];
    if (!head) return '';
    if (head.length <= maxLength) return head;
    return snapToBoundary(head, maxLength);
}

function isShellLikeTool(input) {
    if (input && typeof input === 'object') {
        if (typeof input.cmd === 'string' || typeof input.command === 'string' || typeof input.script === 'string') return true;
    }
    if (typeof input !== 'string') return false;
    return SHELL_LIKE_INPUT_PATTERN.test(input.trim());
}

export function compactToolInput(input, maxChars = 18) {
    if (input == null) return '';
    const raw = String(input).trim();
    if (!raw) return '';
    if (isShellLikeTool(input)) {
        const preview = compactShellInputPreview(raw, maxChars);
        if (preview) return preview;
    }
    const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
    const base = (lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw).split(/\s+/)[0] || '';
    if (base.length > 8 && /^[a-z0-9-]+$/i.test(base) && !/[aeiou]/i.test(base)) return '';
    if (base.length <= maxChars) return base;
    return snapToBoundary(base, maxChars);
}

export function isDocumentationToolInput(input) {
    const text = normalizeToolInput(input);
    return DOCUMENTATION_INPUT_PATTERN.test(text);
}

export function isCodeToolInput(input) {
    const text = normalizeToolInput(input);
    return CODE_INPUT_PATTERN.test(text) && !isDocumentationToolInput(input);
}

function tryParseToolInput(input) {
    if (!input || typeof input !== 'string') return input;
    const text = input.trim();
    if (!text || !JSONISH_INPUT_PATTERN.test(text)) return input;
    try {
        return JSON.parse(text);
    } catch {
        return input;
    }
}

export function extractToolCalls(input) {
    const parsed = tryParseToolInput(input);
    const calls = [];
    const collect = (value) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach(collect);
            return;
        }

        const tool = value.recipient_name || value.tool || value.name || value.function || value.type;
        const parameters = value.parameters || value.arguments || value.input || value.args || value;
        if (tool && !MULTI_TOOL_NAMES.has(tool)) {
            calls.push({ tool, input: parameters });
        }

        if (Array.isArray(value.tool_uses)) value.tool_uses.forEach(collect);
        if (Array.isArray(value.calls)) value.calls.forEach(collect);
        if (Array.isArray(value.tools)) value.tools.forEach(collect);
    };

    collect(parsed);
    if (calls.length) return calls;

    const text = normalizeToolInput(input);
    const found = [...text.matchAll(TOOL_REFERENCE_PATTERN)]
        .map((match) => ({ tool: match[1], input: text }));
    return found.length ? found : [{ tool: null, input: text }];
}

function extractFirstUrl(text) {
    if (!text) return null;
    const match = String(text).match(URL_PATTERN);
    return match ? match[0] : null;
}

export function currentToolInputHost(tool, input) {
    let url = null;
    if (input && typeof input === 'object') {
        const candidate = input.url || input.uri || input.href || input.target;
        if (typeof candidate === 'string') url = candidate;
    }
    if (!url) url = extractFirstUrl(typeof input === 'string' ? input : normalizeToolInput(input));
    if (!url) return null;
    try {
        return new URL(url).host || null;
    } catch {
        return null;
    }
}

function isPlaywrightMcpTool(tool) {
    const name = String(tool || '');
    return PLAYWRIGHT_PLUGIN_TOOL_PATTERN.test(name) || name.startsWith('mcp__playwright__') || name.startsWith('mcp__claude-in-chrome__');
}

function isPortalPreviewInput(input) {
    const text = normalizeToolInput(input);
    return LOCAL_PREVIEW_INPUT_PATTERN.test(text);
}

export function classifyShellInput(input) {
    const text = normalizeToolInput(input);
    if (!text) return null;

    if (GIT_FLOW_COMMAND_PATTERN.test(text)) {
        return { building: 'harbor', reason: 'git-flow', confidence: 0.9, label: compactToolLabel(text, 'git') };
    }
    if (VALIDATION_COMMAND_PATTERN.test(text)) {
        return { building: 'taskboard', reason: 'verify', confidence: 0.94, label: compactToolLabel(text, 'check') };
    }
    if (BROWSER_PREVIEW_COMMAND_PATTERN.test(text)) {
        return { building: 'portal', reason: 'browser-preview', confidence: 0.86, label: compactToolLabel(text, 'browser') };
    }
    if (WEB_COMMAND_PATTERN.test(text)) {
        return { building: 'observatory', reason: 'external-research', confidence: 0.86, label: compactToolLabel(text, 'web') };
    }
    if (FILE_MUTATION_COMMAND_PATTERN.test(text)) {
        return isDocumentationToolInput(input)
            ? { building: 'archive', reason: 'edit-docs', confidence: 0.78, label: compactToolLabel(text, 'docs') }
            : { building: 'forge', reason: 'modify-files', confidence: 0.9, label: compactToolLabel(text, 'edit') };
    }
    if (LOCAL_READ_COMMAND_PATTERN.test(text)) {
        if (TASK_COMMAND_INPUT_PATTERN.test(text)) {
            return { building: 'taskboard', reason: 'inspect-validation', confidence: 0.84, label: compactToolLabel(text, 'check') };
        }
        if (isCodeToolInput(input)) {
            return { building: 'forge', reason: 'inspect-code', confidence: 0.78, label: compactToolLabel(text, 'code') };
        }
        return { building: 'archive', reason: isDocumentationToolInput(input) ? 'read-docs' : 'search-local', confidence: 0.74, label: compactToolLabel(text, 'read') };
    }

    return isCodeToolInput(input)
        ? { building: 'forge', reason: 'run-shell', confidence: 0.6, label: compactToolLabel(text, 'run') }
        : { building: 'command', reason: 'run-shell', confidence: 0.55, label: compactToolLabel(text, 'run') };
}

export function classifyTool(toolName, input) {
    const tool = String(toolName || '');
    if (!tool) return null;
    const metadata = toolMetadata(tool);

    if (MULTI_TOOL_NAMES.has(tool)) {
        const calls = extractToolCalls(input);
        const weights = new Map();
        const examples = new Map();
        for (const call of calls) {
            const classified = classifyTool(call.tool, call.input) || classifyShellInput(call.input);
            if (!classified?.building) continue;
            weights.set(classified.building, (weights.get(classified.building) || 0) + classified.confidence);
            if (!examples.has(classified.building)) examples.set(classified.building, classified);
        }
        if (weights.size) {
            const building = MULTI_TOOL_PRIORITY
                .filter((candidate) => weights.has(candidate))
                .sort((a, b) => {
                    const delta = weights.get(b) - weights.get(a);
                    if (delta !== 0) return delta;
                    return MULTI_TOOL_PRIORITY.indexOf(a) - MULTI_TOOL_PRIORITY.indexOf(b);
                })[0];
            const example = examples.get(building);
            return {
                building,
                reason: example?.reason || 'multi-tool',
                confidence: Math.min(0.96, Math.max(0.65, weights.get(building) / Math.max(1, calls.length))),
                label: example?.label || compactToolLabel(tool, 'tools'),
                count: calls.length,
            };
        }
        return classifyShellInput(input);
    }

    if (isPlaywrightMcpTool(tool)) {
        const host = currentToolInputHost(tool, input);
        return {
            building: 'portal',
            reason: 'portal-active',
            confidence: 0.92,
            label: compactToolLabel(host || tool, 'browser'),
            ...(host ? { currentToolInputHost: host } : {}),
        };
    }

    if (tool === 'WebFetch' && isPortalPreviewInput(input)) {
        const host = currentToolInputHost(tool, input);
        return {
            building: 'portal',
            reason: 'portal-preview',
            confidence: 0.9,
            label: compactToolLabel(host || tool, 'preview'),
            ...(host ? { currentToolInputHost: host } : {}),
        };
    }

    if (COMMAND_AGENT_TOOLS.has(tool)) {
        return { ...metadata.classification, label: compactToolLabel(tool, 'agent') };
    }

    if (FILE_MUTATION_TOOLS.has(tool) && isDocumentationToolInput(input)) {
        return { building: 'archive', reason: 'edit-docs', confidence: 0.82, label: compactToolLabel(input, 'docs') };
    }

    if (metadata?.classification) {
        const base = metadata.classification;
        if (LOCAL_INSPECTION_TOOLS.has(tool)) {
            const split = classifyShellInput(input);
            if (split && ['forge', 'taskboard', 'harbor'].includes(split.building)) return split;
            if (isCodeToolInput(input)) {
                return { building: 'forge', reason: 'inspect-code', confidence: 0.78, label: compactToolLabel(input || tool, 'code') };
            }
        }
        if (HOST_LABEL_TOOLS.has(tool)) {
            const host = currentToolInputHost(tool, input);
            return {
                ...base,
                label: compactToolLabel(host || input || tool, tool),
                ...(host ? { currentToolInputHost: host } : {}),
            };
        }
        return { ...base, label: compactToolLabel(input || tool, tool) };
    }

    if (SHELL_TOOL_NAMES.has(tool)) {
        return classifyShellInput(input);
    }

    const lowerTool = tool.toLowerCase();
    if (AGENT_ORCHESTRATION_TOOL_PATTERN.test(lowerTool)) {
        return { building: 'command', reason: 'agent-orchestration', confidence: 0.9, label: compactToolLabel(tool, 'agent') };
    }
    if (BROWSER_TOOL_NAME_PATTERN.test(lowerTool)) {
        return { building: 'portal', reason: 'browser-preview', confidence: 0.84, label: compactToolLabel(tool, 'browser') };
    }
    if (GITHUB_TOOL_NAME_PATTERN.test(lowerTool)) {
        return { building: 'harbor', reason: 'github-flow', confidence: 0.84, label: compactToolLabel(tool, 'git') };
    }
    if (WEB_TOOL_NAME_PATTERN.test(lowerTool)) {
        return { building: 'observatory', reason: 'external-research', confidence: 0.82, label: compactToolLabel(tool, 'web') };
    }
    if (FILE_MUTATION_TOOL_NAME_PATTERN.test(lowerTool)) {
        return isDocumentationToolInput(input)
            ? { building: 'archive', reason: 'edit-docs', confidence: 0.78, label: compactToolLabel(input, 'docs') }
            : { building: 'forge', reason: 'modify-files', confidence: 0.84, label: compactToolLabel(input || tool, 'edit') };
    }
    if (TEAM_TOOL_NAME_PATTERN.test(lowerTool)) {
        return { building: 'command', reason: 'coordinate-team', confidence: 0.8, label: compactToolLabel(tool, 'team') };
    }
    if (TASK_TOOL_NAME_PATTERN.test(lowerTool)) {
        return { building: 'taskboard', reason: 'plan-work', confidence: 0.8, label: compactToolLabel(tool, 'task') };
    }
    if (READ_TOOL_NAME_PATTERN.test(lowerTool)) {
        const split = classifyShellInput(input);
        if (split) return split;
        return { building: isCodeToolInput(input) ? 'forge' : 'archive', reason: isCodeToolInput(input) ? 'inspect-code' : 'search-local', confidence: 0.68, label: compactToolLabel(input || tool, 'read') };
    }

    return classifyShellInput(input);
}

export function buildingForTool(toolName, input) {
    return classifyTool(toolName, input)?.building || null;
}

export function toolIcon(tool) {
    if (!tool) return '❓';
    const name = String(tool);
    if (name.startsWith('mcp__playwright__')) return '🎭';
    if (name.startsWith('mcp__')) return '🔌';
    return toolMetadata(name)?.icon || '🔧';
}

export function toolCategory(tool) {
    if (!tool) return 'other';
    const name = String(tool);
    if (name.startsWith('mcp__')) return 'exec';
    return toolMetadata(name)?.category || 'other';
}

export function shortToolName(name) {
    if (!name) return '';
    return String(name).replace('mcp__playwright__', 'pw:').replace('mcp__', '');
}

export function toolActionLabel(tool, options) {
    const name = String(tool || '');
    if (MULTI_TOOL_NAMES.has(name)) {
        const count = Number(options?.count);
        return count >= 2 ? `Coordinating ×${count}` : 'Coordinating';
    }
    return toolMetadata(name)?.actionLabel || name || '';
}

export function isTaskCommandInput(input) {
    const text = normalizeToolInput(input);
    return TASK_COMMAND_INPUT_PATTERN.test(text);
}

export function isCommandToolName(toolName) {
    const tool = String(toolName || '').toLowerCase();
    return COMMAND_TOOL_NAME_PATTERN.test(tool) ||
        tool === 'task' ||
        tool === 'multi_tool_use';
}
