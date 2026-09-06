import {
    ChronicleEventKind,
    chronicleDateFromKey,
    chronicleDateKey,
    chronicleDateWindow,
    summarizeDay,
} from '../../application/ChronicleLog.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { el, replaceChildren } from './DomSafe.js';
import { formatCost, formatNumber } from './Formatters.js';

// The day's recap, told the way the village would tell it. Reads the
// ChronicleLog day book and renders a short ledger plus a timeline, so looking
// away for an hour no longer costs you the whole hour.

const KIND_GLYPH = {
    [ChronicleEventKind.ARRIVED]: '→',
    [ChronicleEventKind.DEPARTED]: '←',
    [ChronicleEventKind.COMPLETED]: '✦',
    [ChronicleEventKind.WAITING]: '?',
    [ChronicleEventKind.RESOLVED]: '✓',
    [ChronicleEventKind.ERRORED]: '!',
    [ChronicleEventKind.RATE_LIMITED]: '~',
    [ChronicleEventKind.COMMIT]: '◆',
    [ChronicleEventKind.PUSH]: '▲',
};

const REASON_TEXT = {
    question: 'asked a question',
    approval: 'awaited approval',
    plan_review: 'awaited plan review',
};

const TIMELINE_LABELS = Object.freeze({
    arrived: 'arrival',
    departed: 'departure',
    completed: 'completed turn',
    waiting: 'wait',
    resolved: 'resolution',
    errored: 'error',
    'rate limited': 'rate limit',
    commit: 'commit',
    push: 'push',
});

function humanizeTimelineKind(kind) {
    const normalized = String(kind ?? 'event')
        .trim()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ');
    if (/^[a-z]{2}$/i.test(normalized)) return normalized.toUpperCase();
    return normalized || 'event';
}

function pluralizeTimelineLabel(value) {
    const words = value.split(' ');
    const last = words.pop() || 'event';
    let plural = last;
    if (/(s|x|z|ch|sh)$/i.test(last)) {
        plural = `${last}es`;
    } else if (/[^aeiou]y$/i.test(last)) {
        plural = `${last.slice(0, -1)}ies`;
    } else {
        plural = `${last}s`;
    }
    return [...words, plural].join(' ');
}

export const CHRONICLE_TIMELINE_PAGE_SIZE = 100;

const CHRONICLE_EXPORT_MIME = {
    markdown: 'text/markdown;charset=utf-8',
    csv: 'text/csv;charset=utf-8',
};

const CHRONICLE_READ_FAILURE_EVENT = 'chronicle:read-failed';
const CHRONICLE_EXPORT_FAILURE_EVENT = 'chronicle:export-failed';

function clockTime(ts) {
    const date = new Date(ts);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function duration(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

function eventText(event) {
    const who = event.agentName || 'someone';
    const where = event.project ? ` · ${event.project}` : '';
    const detailLabel = event.count !== undefined ? event.eventLabel : event.label;
    switch (event.kind) {
        case ChronicleEventKind.ARRIVED: return `${who} arrived${where}`;
        case ChronicleEventKind.DEPARTED: return `${who} left${where}`;
        case ChronicleEventKind.COMPLETED: return `${who} finished a turn${where}`;
        case ChronicleEventKind.WAITING: {
            const reason = REASON_TEXT[event.reason];
            const tool = event.tool ? ` (${event.tool})` : '';
            return `${who} ${reason || 'waited for you'}${tool}${where}`;
        }
        case ChronicleEventKind.RESOLVED:
            return `${who} was answered after ${duration(event.waitedMs || 0)}${where}`;
        case ChronicleEventKind.ERRORED: return `${who} hit an error${where}`;
        case ChronicleEventKind.RATE_LIMITED: return `${who} hit the rate limit${where}`;
        case ChronicleEventKind.COMMIT: return `${who} committed ${detailLabel || 'a change'}${where}`;
        case ChronicleEventKind.PUSH: return `${who} pushed ${detailLabel || ''}${where}`.trim();
        default: return `${who} ${event.kind}${where}`;
    }
}

function timelineKind(event) {
    const value = event?.kind ?? event?.type;
    return String(value ?? 'event').trim() || 'event';
}

function timelineKindLabel(kind, count = 1) {
    const normalized = humanizeTimelineKind(kind);
    const singular = TIMELINE_LABELS[normalized.toLowerCase()] || normalized;
    return Number(count) > 1 ? pluralizeTimelineLabel(singular) : singular;
}

function timelineMinute(ts) {
    const value = Number(ts);
    return Number.isFinite(value) ? Math.floor(value / 60_000) : null;
}

/** Fold same-kind events within each minute into deterministic chronological rows. */
export function foldTimeline(events = []) {
    const rows = [];
    // Folding is per minute and kind across the whole minute, not just over
    // adjacent rows: a burst stays one row per kind even when another kind is
    // interleaved. Each folded row keeps the position of its first member, so
    // the timeline order stays chronological and deterministic.
    const folded = new Map();
    for (const event of orderedEvents(events)) {
        if (!event || typeof event !== 'object') continue;
        const kind = timelineKind(event);
        const minute = timelineMinute(event.ts);
        const foldKey = minute === null ? null : `${minute}\u0000${kind}`;
        const previous = foldKey === null ? undefined : folded.get(foldKey);
        if (previous) {
            previous.count++;
            previous.label = timelineKindLabel(kind, previous.count);
            if (previous.project !== event.project) previous.project = null;
            continue;
        }
        const row = {
            ...event,
            kind,
            count: 1,
            label: timelineKindLabel(kind),
        };
        if (event.label !== undefined) row.eventLabel = event.label;
        rows.push(row);
        if (foldKey !== null) folded.set(foldKey, row);
    }
    return rows;
}

function ledgerRow(label, value) {
    return el('div', { className: 'chronicle__stat' }, [
        el('span', { className: 'chronicle__stat-label' }, label),
        el('span', { className: 'chronicle__stat-value' }, String(value)),
    ]);
}

function openingLine(summary, isToday = true) {
    if (!summary.agents.length) {
        return isToday
            ? 'A quiet day. Nothing has passed through the village yet.'
            : 'No Chronicle entries were recorded on this day.';
    }
    const since = summary.firstTs ? `From ${clockTime(summary.firstTs)}` : (isToday ? 'Today' : 'That day');
    const agents = `${summary.agents.length} ${summary.agents.length === 1 ? 'agent' : 'agents'}`;
    const projects = summary.projects.length
        ? ` across ${summary.projects.length} ${summary.projects.length === 1 ? 'project' : 'projects'}`
        : '';
    return `${since}: ${agents}${projects}.`;
}

function orderedEvents(events) {
    return (Array.isArray(events) ? events : [])
        .map((event, index) => ({ event, index }))
        .sort((a, b) => (Number(a.event?.ts) || 0) - (Number(b.event?.ts) || 0) || a.index - b.index)
        .map(({ event }) => event);
}

function markdownCell(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\t/g, ' ')
        // Encode HTML before escaping Markdown punctuation. Entities render as
        // readable prose but cannot become tags in a permissive previewer.
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\|/g, '\\|')
        // Escaping the whole link/image delimiter prevents both inline and
        // reference-style Markdown destinations from becoming active.
        .replace(/!/g, '\\!')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
}

function durationOrZero(ms) {
    return Number(ms) > 0 ? duration(ms) : '0m';
}

function summaryRows(summary) {
    return [
        ['Events', summary.totalEvents],
        ['Agents', summary.agents.length],
        ['Projects', summary.projects.length],
        ['Commits', summary.commits],
        ['Pushes', summary.pushes],
        ['Turns done', summary.completed],
        ['Waited on you', summary.waits],
        ['Errors', summary.errors],
        ['Rate limits', summary.rateLimits],
        ['Total wait', durationOrZero(summary.totalWaitMs)],
        ['Longest wait', durationOrZero(summary.longestWaitMs)],
    ];
}

function projectKey(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    return String(value.name ?? value.key ?? value.project ?? '').trim();
}

function projectSubtotals(summary, events) {
    const projects = Array.isArray(summary?.projects) ? summary.projects : [];
    const names = [];
    const counts = new Map();
    for (const project of projects) {
        const name = projectKey(project);
        if (!name || counts.has(name)) continue;
        names.push(name);
        counts.set(name, 0);
    }
    for (const event of Array.isArray(events) ? events : []) {
        const name = projectKey(event?.project);
        if (name && counts.has(name)) counts.set(name, counts.get(name) + 1);
    }
    return names.map(name => ({ name, count: counts.get(name) || 0 }));
}

function projectSubtotalNodes(summary, events) {
    const rows = projectSubtotals(summary, events);
    if (!rows.length) return [];
    return [
        el('div', { className: 'chronicle__project-subtotals' }, [
            el('div', { className: 'chronicle__project-heading' }, 'PROJECT SUBTOTALS'),
            ...rows.map(({ name, count }) => el('div', { className: 'chronicle__project-row' }, [
                el('span', { className: 'chronicle__project-name' }, name),
                el('span', { className: 'chronicle__project-count' }, `${formatNumber(count)} ${count === 1 ? 'event' : 'events'}`),
            ])),
        ]),
    ];
}

function spendRows(spend) {
    if (!spend) return [];
    return [
        ['New tokens', spend.tokens],
        ['Cache reads', spend.cacheRead],
        [spend.costLabel || 'Est. cost', spend.cost],
    ];
}

/** Build paste-ready prose and tables for one retained Chronicle day. */
export function buildChronicleMarkdown({
    dateKey = chronicleDateKey(),
    events = [],
    summary = summarizeDay(events),
    spend = null,
} = {}) {
    const daySummary = summary || summarizeDay(events);
    const dayEvents = orderedEvents(events);
    const isToday = dateKey === chronicleDateKey();
    const lines = [
        `# Chronicle — ${markdownCell(dateKey)}`,
        '',
        markdownCell(openingLine(daySummary, isToday)),
        '',
        '## Summary',
        '',
        '| Metric | Value |',
        '| --- | ---: |',
        ...summaryRows(daySummary).map(([label, value]) => `| ${markdownCell(label)} | ${markdownCell(value)} |`),
    ];

    const spending = dateKey === chronicleDateKey() ? spendRows(spend) : [];
    if (spending.length) {
        lines.push(
            '',
            '## Spend summary',
            '',
            '| Metric | Value |',
            '| --- | ---: |',
            ...spending.map(([label, value]) => `| ${markdownCell(label)} | ${markdownCell(
                label === 'New tokens' || label === 'Cache reads' ? formatNumber(value) : formatCost(value),
            )} |`),
        );
    }

    lines.push('', '## Timeline', '', '| Time | Glyph | Event |', '| --- | :---: | --- |');
    if (dayEvents.length) {
        lines.push(...dayEvents.map(event => (
            `| ${markdownCell(clockTime(event.ts))} | ${markdownCell(KIND_GLYPH[event.kind] || '·')} | ${markdownCell(eventText(event))} |`
        )));
    } else {
        lines.push('| — | — | No Chronicle entries were recorded on this day. |');
    }

    return `${lines.join('\n')}\n`;
}

/** Escape one CSV cell, including Excel formula-injection protection. */
export function csvEscapeCell(value) {
    const text = value == null ? '' : String(value);
    // Spreadsheet applications may trim tabs, newlines, and other leading
    // controls before deciding whether a cell is a formula. Detect the first
    // visible character after that prefix, while preserving the original text
    // inside the CSV cell.
    const normalized = text.replace(/^[\s\p{C}]*/u, '');
    // A leading apostrophe makes Excel treat formula-like text as a literal.
    const safe = /^[=+\-@]/.test(normalized) ? `'${text}` : text;
    return /[",\r\n\t]/.test(safe)
        ? `"${safe.replace(/"/g, '""')}"`
        : safe;
}

/** Build a spreadsheet-friendly CSV with summary and event rows. */
export function buildChronicleCsv({
    dateKey = chronicleDateKey(),
    events = [],
    summary = summarizeDay(events),
    spend = null,
} = {}) {
    const daySummary = summary || summarizeDay(events);
    const dayEvents = orderedEvents(events);
    const rows = [[
        'row_type', 'date', 'time', 'glyph', 'event', 'kind', 'agent', 'provider',
        'project', 'reason', 'tool', 'waited_ms', 'metric', 'value',
    ]];

    for (const [metric, value] of summaryRows(daySummary)) {
        rows.push(['summary', dateKey, '', '', '', '', '', '', '', '', '', '', metric, value]);
    }
    for (const [metric, value] of (dateKey === chronicleDateKey() ? spendRows(spend) : [])) {
        rows.push(['spend', dateKey, '', '', '', '', '', '', '', '', '', '', metric, value]);
    }
    for (const event of dayEvents) {
        rows.push([
            'event',
            dateKey,
            clockTime(event.ts),
            KIND_GLYPH[event.kind] || '·',
            eventText(event),
            event.kind,
            event.agentName,
            event.provider,
            event.project,
            event.reason,
            event.tool,
            event.waitedMs,
            '',
            '',
        ]);
    }

    return `${rows.map(row => row.map(csvEscapeCell).join(',')).join('\r\n')}\r\n`;
}

function downloadText(text, filename, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    let link = null;
    try {
        link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        document.body.append(link);
        link.click();
    } finally {
        link?.remove();
        URL.revokeObjectURL(url);
    }
}

export class ChroniclePanel {
    constructor({ modal, chronicleLog, spendLedger = null, usageGetter = null, toast = null }) {
        this.modal = modal;
        this.log = chronicleLog;
        this.spendLedger = spendLedger;
        this.usageGetter = usageGetter;
        this.toast = toast;
        this._request = null;
        this._dateReadSeq = 0;
        this._selectedDateKey = null;
        this._destroyed = false;
    }

    async open() {
        if (!this.modal || this._destroyed) return;
        const request = this.modal.beginRequest();
        if (request === null) return;
        this._request = request;
        const dateKey = chronicleDateKey();
        let page;
        try {
            page = await this._readPage(dateKey);
        } catch (error) {
            if (
                !this._destroyed
                && this._request === request
                && this.modal.isRequestCurrent(request)
            ) {
                this._reportFailure(
                    CHRONICLE_READ_FAILURE_EVENT,
                    'Could not load today\'s Chronicle.',
                    { dateKey, error },
                );
            }
            return;
        }
        if (
            this._destroyed
            || this._request !== request
            || !this.modal.isRequestCurrent(request)
        ) return;
        this._selectedDateKey = dateKey;
        if (!this.modal.open('Village Chronicle', '', { wide: true, request })) return;
        this._renderPage(page, dateKey, request);
    }

    async _readPage(dateKey) {
        if (typeof this.log.readDayPage === 'function') {
            return this.log.readDayPage(dateKey, { limit: CHRONICLE_TIMELINE_PAGE_SIZE });
        }
        const all = await this.log.readDay(dateKey);
        return {
            events: all.slice(-CHRONICLE_TIMELINE_PAGE_SIZE).reverse(),
            summary: summarizeDay(all),
            totalCount: all.length,
        };
    }

    async _showDate(dateKey, request) {
        if (!dateKey || dateKey === this._selectedDateKey) return;
        const previousDateKey = this._selectedDateKey;
        const readSeq = ++this._dateReadSeq;
        // The native date input changes before its async handler runs. Keep it
        // on the committed day while the new page is loading so it cannot show
        // a new date beside the old timeline.
        this._setDatePickerValue(previousDateKey);
        let page;
        try {
            page = await this._readPage(dateKey);
        } catch (error) {
            if (
                !this._destroyed
                && this._request === request
                && readSeq === this._dateReadSeq
                && this.modal.isRequestCurrent(request)
            ) {
                this._setDatePickerValue(previousDateKey);
                this._reportFailure(
                    CHRONICLE_READ_FAILURE_EVENT,
                    'Could not load that Chronicle day.',
                    { dateKey, error },
                );
            }
            return;
        }
        if (
            this._destroyed
            || this._request !== request
            || readSeq !== this._dateReadSeq
            || !this.modal.isRequestCurrent(request)
        ) return;
        // Commit only after the read has succeeded and is still the current
        // request. The rendered controls then receive the same committed key.
        this._selectedDateKey = dateKey;
        this._renderPage(page, dateKey, request);
    }

    _setDatePickerValue(dateKey) {
        const input = this.modal?.contentEl?.querySelector?.('.chronicle__date-input');
        if (input && dateKey) input.value = dateKey;
    }

    _reportFailure(eventName, message, details = {}) {
        if (this.toast?.show) {
            this.toast.show(message, 'warning');
            return;
        }
        eventBus.emit(eventName, { message, ...details });
    }

    _spendForExport(dateKey) {
        if (dateKey !== chronicleDateKey()) return null;
        const today = this.spendLedger?.today;
        if (!today || typeof today !== 'object') return null;
        if (this.spendLedger.date && this.spendLedger.date !== dateKey) return null;
        const subscription = this.usageGetter?.()?.account?.subscriptionType;
        const onPlan = typeof subscription === 'string'
            && ['max', 'pro', 'team', 'enterprise'].includes(subscription.toLowerCase());
        return {
            tokens: Number(today.tokens) || 0,
            cacheRead: Number(today.cacheRead) || 0,
            cost: Number(today.cost) || 0,
            costLabel: onPlan ? 'API equivalent' : 'Est. cost',
        };
    }

    async _readExportData(dateKey) {
        const selectedDateKey = dateKey || chronicleDateKey();
        let events;
        if (typeof this.log?.readDay === 'function') {
            events = await this.log.readDay(selectedDateKey);
        } else {
            events = (await this._readPage(selectedDateKey)).events;
        }
        const dayEvents = Array.isArray(events) ? events : [];
        return {
            dateKey: selectedDateKey,
            events: dayEvents,
            summary: summarizeDay(dayEvents),
            spend: this._spendForExport(selectedDateKey),
        };
    }

    async _export(format) {
        if (this._destroyed) return;
        const dateKey = this._selectedDateKey || chronicleDateKey();
        try {
            const data = await this._readExportData(dateKey);
            // A date change during the read must never download the wrong day.
            if (this._destroyed || dateKey !== this._selectedDateKey) return;
            const isCsv = format === 'csv';
            const text = isCsv ? buildChronicleCsv(data) : buildChronicleMarkdown(data);
            const extension = isCsv ? 'csv' : 'md';
            downloadText(text, `chronicle-${dateKey}.${extension}`, CHRONICLE_EXPORT_MIME[isCsv ? 'csv' : 'markdown']);
        } catch (error) {
            const formatLabel = format === 'csv' ? 'CSV' : 'Markdown';
            this._reportFailure(
                CHRONICLE_EXPORT_FAILURE_EVENT,
                `Could not export the Chronicle as ${formatLabel}.`,
                { format, dateKey, error },
            );
        }
    }

    _renderPage({ events, summary, totalCount }, dateKey, request) {
        const content = this.modal.contentEl;
        if (content) {
            replaceChildren(content, this._render(events, summary, {
                newestFirst: true,
                totalCount,
                dateKey,
                onDateChange: nextDate => this._showDate(nextDate, request),
            }));
        }
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._dateReadSeq++;
        this.modal?.invalidateRequest?.(this._request);
        this._request = null;
        this.modal = null;
        this.log = null;
        this.spendLedger = null;
        this.usageGetter = null;
        this.toast = null;
    }

    // The day's accounting lives here rather than in the topbar: a dollar
    // figure you are not billed for has not earned permanent space in the
    // corner of someone's eye, but it belongs in the record of the day.
    _spendNodes(isToday = true) {
        if (!isToday) return [];
        const today = this.spendLedger?.today;
        if (!today) return [];
        const subscription = this.usageGetter?.()?.account?.subscriptionType;
        const onPlan = typeof subscription === 'string'
            && ['max', 'pro', 'team', 'enterprise'].includes(subscription.toLowerCase());

        const nodes = [el('div', { className: 'chronicle__ledger' }, [
            ledgerRow('NEW TOKENS', formatNumber(today.tokens)),
            ledgerRow('CACHE READS', formatNumber(today.cacheRead)),
            ledgerRow(onPlan ? 'API EQUIVALENT' : 'EST. COST', formatCost(today.cost)),
        ])];
        nodes.push(el('p', { className: 'chronicle__note' }, onPlan
            ? `Counted while ClaudeVille was open. Your ${subscription} plan bills on quota, not on this figure — it is what today's tokens would have cost at API rates.`
            : 'Counted while ClaudeVille was open, from the growth in each session\'s token totals.'));
        return nodes;
    }

    _datePicker(dateKey, onDateChange) {
        const retentionDays = Number(this.log?.retentionDays) || 14;
        const window = chronicleDateWindow(Date.now(), retentionDays);
        const shiftDate = offset => {
            const shifted = chronicleDateFromKey(dateKey);
            shifted.setDate(shifted.getDate() + offset);
            return chronicleDateKey(shifted);
        };
        const previousKey = shiftDate(-1);
        const nextKey = shiftDate(1);
        const input = el('input', {
            className: 'chronicle__date-input',
            ariaLabel: 'Chronicle date',
        });
        input.type = 'date';
        input.value = dateKey;
        input.min = window.min;
        input.max = window.max;
        input.addEventListener('change', () => onDateChange?.(input.value));

        const previousButton = el('button', {
            className: 'chronicle__date-button',
            text: 'Previous',
            title: 'Show the previous retained Chronicle day',
            ariaLabel: 'Show previous Chronicle day',
        });
        previousButton.type = 'button';
        previousButton.disabled = dateKey <= window.min;
        previousButton.addEventListener('click', () => onDateChange?.(previousKey));

        const nextButton = el('button', {
            className: 'chronicle__date-button',
            text: 'Next',
            title: 'Show the next Chronicle day',
            ariaLabel: 'Show next Chronicle day',
        });
        nextButton.type = 'button';
        nextButton.disabled = dateKey >= window.max;
        nextButton.addEventListener('click', () => onDateChange?.(nextKey));

        const todayButton = el('button', {
            className: ['chronicle__date-button', 'chronicle__today-button'],
            text: 'Today',
            title: 'Return to today\'s Chronicle',
            ariaLabel: 'Show today\'s Chronicle',
        });
        todayButton.type = 'button';
        todayButton.addEventListener('click', () => onDateChange?.(window.max));

        const markdownButton = el('button', {
            className: 'chronicle__export-button',
            text: 'Markdown',
            title: 'Download the selected day as Markdown',
            ariaLabel: 'Download selected Chronicle day as Markdown',
        });
        markdownButton.type = 'button';
        markdownButton.addEventListener('click', () => this._export('markdown'));
        const csvButton = el('button', {
            className: 'chronicle__export-button',
            text: 'CSV',
            title: 'Download the selected day as CSV',
            ariaLabel: 'Download selected Chronicle day as CSV',
        });
        csvButton.type = 'button';
        csvButton.addEventListener('click', () => this._export('csv'));
        const selected = chronicleDateFromKey(dateKey);
        const heading = selected.toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
        return el('div', { className: 'chronicle__date-controls' }, [
            el('div', { className: 'chronicle__date-navigation' }, [
                previousButton,
                el('label', { className: 'chronicle__date-label' }, [
                    el('span', { className: 'chronicle__date-label-text' }, 'Day'),
                    input,
                ]),
                nextButton,
                todayButton,
            ]),
            el('span', { className: 'chronicle__date-heading' }, heading),
            el('span', { className: 'chronicle__export-actions' }, [markdownButton, csvButton]),
        ]);
    }

    _render(events, summary, {
        newestFirst = false,
        totalCount = events.length,
        dateKey = chronicleDateKey(),
        onDateChange = null,
    } = {}) {
        const isToday = dateKey === chronicleDateKey();
        const nodes = [
            this._datePicker(dateKey, onDateChange),
            el('p', { className: 'chronicle__opening' }, openingLine(summary, isToday)),
        ];

        nodes.push(el('div', { className: 'chronicle__ledger' }, [
            ledgerRow('COMMITS', summary.commits),
            ledgerRow('PUSHES', summary.pushes),
            ledgerRow('TURNS DONE', summary.completed),
            ledgerRow('WAITED ON YOU', summary.waits),
            ledgerRow('ERRORS', summary.errors),
            ledgerRow('RATE LIMITS', summary.rateLimits),
        ]));
        nodes.push(...projectSubtotalNodes(summary, events));

        nodes.push(...this._spendNodes(isToday));

        if (summary.longestWaitMs > 0) {
            nodes.push(el('p', { className: 'chronicle__note' },
                `Longest wait for you: ${duration(summary.longestWaitMs)}.`));
        }

        if (!events.length) {
            nodes.push(el('p', { className: 'chronicle__note' },
                isToday
                    ? 'The day book fills as agents work — it records only what happens while ClaudeVille is open.'
                    : 'Choose another date to continue browsing the retained Chronicle.'));
            return nodes;
        }

        // Newest first: the recap answers "what did I miss" before "how did the
        // day start", while same-minute bursts stay on one intelligible row.
        const timeline = foldTimeline(events);
        const ordered = newestFirst ? [...timeline].reverse() : timeline;
        nodes.push(el('ul', { className: 'chronicle__timeline' }, ordered.map(row => {
            const text = row.count > 1
                ? `${row.label} ×${row.count}${row.project ? ` · ${row.project}` : ''}`
                : eventText(row);
            return el('li', { className: `chronicle__entry chronicle__entry--${row.kind}` }, [
                el('span', { className: 'chronicle__time' }, clockTime(row.ts)),
                el('span', { className: 'chronicle__glyph' }, KIND_GLYPH[row.kind] || '·'),
                el('span', { className: 'chronicle__text' }, text),
            ]);
        })));
        const omitted = Math.max(0, totalCount - events.length);
        if (omitted > 0) {
            nodes.push(el('p', { className: 'chronicle__note' },
                `Showing the newest ${events.length} of ${totalCount} events.`));
        }

        return nodes;
    }
}
