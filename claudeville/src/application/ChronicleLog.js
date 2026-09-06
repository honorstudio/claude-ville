import { eventBus } from '../domain/events/DomainEvent.js';
import { AgentBiography } from '../domain/value-objects/AgentBiography.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';

// The village has always been a live view: look away for forty minutes and
// nothing tells you what happened. Monuments remember commits and biographies
// remember agents, but neither answers "what did I miss?".
//
// ChronicleLog is the town's day book. It records the handful of moments worth
// remembering — who arrived and left, what shipped, what broke, who waited and
// how long — into the ChronicleStore `events` table, where the Chronicle modal
// reads them back as a recap.

export const ChronicleEventKind = Object.freeze({
    ARRIVED: 'arrived',
    DEPARTED: 'departed',
    COMPLETED: 'completed',
    WAITING: 'waiting',
    RESOLVED: 'resolved',
    ERRORED: 'errored',
    RATE_LIMITED: 'rate_limited',
    COMMIT: 'commit',
    PUSH: 'push',
});

// Statuses whose entry is worth a line in the day book, and the kind to log.
const STATUS_EVENTS = {
    [AgentStatus.WAITING_ON_USER]: ChronicleEventKind.WAITING,
    [AgentStatus.ERRORED]: ChronicleEventKind.ERRORED,
    [AgentStatus.RATE_LIMITED]: ChronicleEventKind.RATE_LIMITED,
    [AgentStatus.COMPLETED]: ChronicleEventKind.COMPLETED,
};

const DIGEST_DETAIL_LIMIT = 8;
export const DIGEST_STATE_LIMIT = 2048;
const PENDING_ARRIVAL_LIMIT = 512;
let activeChronicleLog = null;

/** The running day book, used by services that are constructed before it. */
export function getActiveChronicleLog() {
    return activeChronicleLog;
}

export function chronicleDateKey(ts = Date.now()) {
    const date = new Date(ts);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

export function chronicleDateFromKey(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return new Date(value);
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function chronicleDateWindow(now = Date.now(), retentionDays = 14) {
    const maxDate = new Date(now);
    maxDate.setHours(0, 0, 0, 0);
    const minDate = new Date(maxDate);
    minDate.setDate(minDate.getDate() - Math.max(0, retentionDays - 1));
    return {
        min: chronicleDateKey(minDate),
        max: chronicleDateKey(maxDate),
    };
}

function boundedText(value, maxLength = 200) {
    if (value == null) return null;
    return String(value).slice(0, maxLength);
}

function isDepartedAgent(agent) {
    return agent?.isDeparted === true
        || (agent?.departedAt !== null
            && agent?.departedAt !== undefined
            && Number.isFinite(Number(agent.departedAt)));
}

function projectName(path) {
    if (!path) return null;
    const parts = String(path).split('/').filter(Boolean);
    return parts[parts.length - 1] || null;
}

// Git events arrive in two shapes: a parsed subject line, and the raw shell
// text the agent actually ran. The Chronicle is prose, so it wants the former,
// and will dig a subject out of the latter rather than print a heredoc.
const SHELL_LOOKING = /^\s*git\b|<<\s*'?EOF|\$\(/;

// Identity key for a commit subject. The two records for one commit rarely
// agree character-for-character — one carries trailing heredoc text, the other
// a clean subject — so they are compared on a normalized prefix.
export function subjectKey(subject) {
    if (!subject) return null;
    return String(subject).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 48);
}

// A commit subject is one line. Some commits arrive as a whole squashed body
// on a single line, which would dump paragraphs into the timeline.
const SUBJECT_MAX = 100;

function trimSubject(text) {
    const clean = String(text).trim();
    if (clean.length <= SUBJECT_MAX) return clean;
    const cut = clean.slice(0, SUBJECT_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function commitSubject(event) {
    const label = String(event?.label || '').trim();
    if (label && !SHELL_LOOKING.test(label)) return trimSubject(label);

    const source = label || String(event?.command || '');
    // `git commit -m "subject"` / `-m 'subject'`
    const flag = source.match(/-m\s+["']([^"'\n]{3,})["']/);
    if (flag && !SHELL_LOOKING.test(flag[1])) return trimSubject(flag[1]);
    // Heredoc bodies put the subject on the line after the opener.
    const heredoc = source.match(/<<\s*'?EOF'?\s*\n?\s*([^\n]{3,})/);
    if (heredoc && !SHELL_LOOKING.test(heredoc[1])) return trimSubject(heredoc[1]);
    return null;
}

export class ChronicleLog {
    constructor({ store = null } = {}) {
        this.store = store;
        this.retentionDays = Number(store?.eventRetentionDays) || 14;
        this.running = false;
        this._statusById = new Map();
        this._waitingSince = new Map();
        this._seenGitEvents = new Set();
        this._presentIds = new Set();   // arrived today, no departure since
        this._writeTail = Promise.resolve();
        this._seq = 0;
        this._replayed = false;
        this._replayPromise = null;
        this._pendingArrivals = new Map();
        this._stopPromise = null;
    }

    start() {
        if (this.running) return this;
        this._stopPromise = null;
        this.running = true;
        activeChronicleLog = this;
        eventBus.emit('chronicle:log-ready', this);
        // Reloading the tab is not an arrival. Replay today's book so agents
        // that were already in town stay in town across a refresh.
        this._replayToday();

        this._onAdded = (agent) => {
            if (!isDepartedAgent(agent)) this._statusById.set(agent.id, agent.status);
            const arrived = this._noteArrival(agent);
            // A genuinely new resident may already be waiting, errored,
            // rate-limited, or complete when it enters the town. Preserve that
            // observed transition for the day book, while replayed residents
            // keep the reload de-duplication behavior above.
            if (arrived && STATUS_EVENTS[agent.status]) {
                this._statusById.delete(agent.id);
                this._noteStatus(agent);
            }
            this._noteGitEvents(agent);
        };
        this._onUpdated = (agent) => {
            this._noteStatus(agent);
            this._noteGitEvents(agent);
        };
        this._onRemoved = (agent) => {
            this._statusById.delete(agent.id);
            this._waitingSince.delete(agent.id);
            this._pendingArrivals.delete(agent.id);
            if (this._presentIds.delete(agent.id)) {
                this.record(ChronicleEventKind.DEPARTED, agent);
            }
        };

        eventBus.on('agent:added', this._onAdded);
        eventBus.on('agent:updated', this._onUpdated);
        eventBus.on('agent:removed', this._onRemoved);
        return this;
    }

    stop() {
        if (this._stopPromise) return this._stopPromise;
        if (this.running) {
            this.running = false;
            eventBus.off('agent:added', this._onAdded);
            eventBus.off('agent:updated', this._onUpdated);
            eventBus.off('agent:removed', this._onRemoved);
            if (activeChronicleLog === this) {
                activeChronicleLog = null;
                eventBus.emit('chronicle:log-stopped', this);
            }
        }
        this._stopPromise = this.flush();
        return this._stopPromise;
    }

    // Arrivals cannot be judged until the replay says who was already here, and
    // the first sessions can land before that read returns — so they queue.
    _noteArrival(agent) {
        if (!this._isTownsfolk(agent) || isDepartedAgent(agent)) return false;
        if (!this._replayed) {
            this._pendingArrivals.set(agent.id, agent);
            while (this._pendingArrivals.size > PENDING_ARRIVAL_LIMIT) {
                this._pendingArrivals.delete(this._pendingArrivals.keys().next().value);
            }
            return null;
        }
        if (this._presentIds.has(agent.id)) return false;
        this._presentIds.add(agent.id);
        this.record(ChronicleEventKind.ARRIVED, agent);
        return true;
    }

    _flushPendingArrivals() {
        const queued = [...this._pendingArrivals.values()];
        this._pendingArrivals.clear();
        for (const agent of queued) {
            const arrived = this._noteArrival(agent);
            if (arrived && STATUS_EVENTS[agent.status]) {
                this._statusById.delete(agent.id);
                this._noteStatus(agent);
            }
        }
    }

    // Repository watchers are a scan artifact, not somebody visiting the town.
    // They come and go with the git scan and would drown the day book.
    _isTownsfolk(agent) {
        return agent?.provider !== 'git' && agent?.agentType !== 'repository';
    }

    // Rebuild "who is already here" and "which commits are already recorded"
    // from today's entries, so a refresh does not re-announce the whole town.
    _replayToday() {
        if (this._replayPromise) return this._replayPromise;
        this._replayPromise = this._runReplay().finally(() => {
            this._replayed = true;
            this._flushPendingArrivals();
        });
        return this._replayPromise;
    }

    async _runReplay() {
        if (!this.store) return;
        try {
            await this._foldDay(null, (_unused, event) => {
                if (event.kind === ChronicleEventKind.ARRIVED && event.agentId) {
                    this._presentIds.add(event.agentId);
                } else if (event.kind === ChronicleEventKind.DEPARTED && event.agentId) {
                    this._presentIds.delete(event.agentId);
                } else if (event.kind === ChronicleEventKind.COMMIT || event.kind === ChronicleEventKind.PUSH) {
                    if (event.sha) this._seenGitEvents.add(event.sha);
                    const replayKey = subjectKey(event.label);
                    if (replayKey) this._seenGitEvents.add(`${event.kind}:${replayKey}`);
                }
                return null;
            });
        } catch { /* an unreadable book just starts empty */ }
    }

    // Only transitions are logged; a status that merely persists across polls
    // would otherwise write a line every two seconds.
    _noteStatus(agent) {
        const status = agent.status;

        // AgentManager projects a missing session onto COMPLETED while it is
        // held in the short departed grace period. That is a presence marker,
        // not an execution transition: do not record a completion or resolve
        // a wait until the real session reports a status change.
        if (isDepartedAgent(agent)) return;

        const previous = this._statusById.get(agent.id);
        if (previous === status) return;
        this._statusById.set(agent.id, status);

        if (previous === AgentStatus.WAITING_ON_USER) {
            const since = this._waitingSince.get(agent.id);
            this._waitingSince.delete(agent.id);
            if (since) {
                this.record(ChronicleEventKind.RESOLVED, agent, {
                    waitedMs: Math.max(0, Date.now() - since),
                });
            }
        }

        if (
            (previous === AgentStatus.ERRORED || previous === AgentStatus.RATE_LIMITED)
            && status
            && status !== AgentStatus.ERRORED
            && status !== AgentStatus.RATE_LIMITED
        ) {
            this.record(ChronicleEventKind.RESOLVED, agent, { waitedMs: 0 });
        }

        const kind = STATUS_EVENTS[status];
        if (!kind) return;
        if (status === AgentStatus.WAITING_ON_USER) {
            this._waitingSince.set(agent.id, agent.awaitingSince || Date.now());
        }
        this.record(kind, agent, { reason: agent.waitReason || null, tool: agent.pendingTool || null });
    }

    _noteGitEvents(agent) {
        // One commit reaches us twice: once parsed from the tool command and
        // once from the repository scan. Collapse on the commit identity and
        // keep the copy that carries a real subject line rather than the raw
        // `git commit -m "$(cat <<'EOF' ...` shell text.
        const best = new Map();
        for (const event of agent.gitEvents || []) {
            if (!event?.id) continue;
            const type = String(event.type || '').toLowerCase();
            if (type !== 'commit' && type !== 'push') continue;
            const key = event.sha || event.commandHash || event.id;
            const existing = best.get(key);
            if (!existing || this._gitEventScore(event) > this._gitEventScore(existing)) {
                best.set(key, event);
            }
        }

        for (const [key, event] of best) {
            const kind = String(event.type).toLowerCase() === 'push'
                ? ChronicleEventKind.PUSH
                : ChronicleEventKind.COMMIT;
            const subject = commitSubject(event);
            // One commit can still reach us as two records that share neither
            // sha nor commandHash, so identity is "any of these keys seen".
            const keys = [key];
            if (event.sha) keys.push(event.sha);
            const subjectId = subjectKey(subject);
            if (subjectId) keys.push(`${kind}:${subjectId}`);
            // A commit we can neither name nor identify by sha tells the
            // reader nothing, and its named twin will cover it.
            if (!subjectId && !event.sha) continue;
            if (keys.some((k) => this._seenGitEvents.has(k))) continue;
            keys.forEach((k) => this._seenGitEvents.add(k));
            // Backfilled repository scans surface history, not news; only log
            // what happened while this page was watching.
            const ts = Number(event.completedAt || event.ts || 0);
            if (!ts || Date.now() - ts > 60 * 60 * 1000) continue;
            this.record(kind, agent, { label: subject, ts, sha: event.sha || null });
        }
        // Keep the dedupe set from growing without bound across a long day.
        if (this._seenGitEvents.size > 2000) {
            this._seenGitEvents = new Set([...this._seenGitEvents].slice(-1000));
        }
    }

    // A commit record is better the more it can say. A readable subject line
    // outweighs everything else: a sha the reader cannot see is worth less than
    // knowing what the commit was.
    _gitEventScore(event) {
        let score = 0;
        if (commitSubject(event)) score += 8;
        if (event.sha) score += 2;
        if (event.observed) score += 1;
        return score;
    }

    record(kind, agent, extra = {}) {
        if (!this.store || !this.running) return;
        const ts = Number(extra.ts) || Date.now();
        const record = {
            id: `${ts}-${this._seq++}-${kind}`,
            ts,
            localDate: chronicleDateKey(ts),
            kind,
            agentId: agent?.id || null,
            agentName: agent?.name || null,
            provider: agent?.provider || null,
            project: projectName(agent?.projectPath),
            ...extra,
            identityKey: AgentBiography.identityKeyFor(agent),
        };
        delete record.ts_;
        // A row ceiling bounds count; bounding free-form fields also bounds
        // each row so an unusual provider payload cannot defeat that ceiling.
        for (const key of [
            'agentId', 'agentName', 'provider', 'project', 'reason', 'tool', 'label', 'sha', 'identityKey',
        ]) {
            record[key] = boundedText(record[key]);
        }
        eventBus.emit('chronicle:recorded', record);
        this._writeTail = this._writeTail
            .then(() => this.store.put('events', record))
            .catch(() => { /* the day book is best effort; never break the app */ });
    }

    /** Events for a local day, oldest first. */
    async readDay(date = new Date()) {
        if (!this.store) return [];
        const { lower, upper } = dayBounds(date);
        try {
            return await this.store.queryRange('events', {
                index: 'ts',
                lower,
                upper,
            });
        } catch {
            return [];
        }
    }

    /**
     * Exact summary plus a bounded newest-first timeline. IndexedDB records are
     * folded directly so opening the modal never retains a second full-day
     * array.
     */
    async readDayPage(date = new Date(), { limit = 100 } = {}) {
        if (!this.store) {
            return { events: [], summary: summarizeDay([]), totalCount: 0 };
        }
        const pageLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
        const state = {
            summary: createDaySummary(),
            events: [],
        };
        try {
            if (typeof this.store.reduceRange === 'function') {
                const folded = await this._foldDay(state, (result, event) => {
                    accumulateDaySummary(result.summary, event);
                    if (result.events.length < pageLimit) result.events.push(event);
                    return result;
                }, date, 'prev');
                const summary = finalizeDaySummary(folded.summary);
                return {
                    events: folded.events,
                    summary,
                    totalCount: summary.totalEvents,
                };
            }
            const all = await this.readDay(date);
            return {
                events: all.slice(-pageLimit).reverse(),
                summary: summarizeDay(all),
                totalCount: all.length,
            };
        } catch {
            return { events: [], summary: summarizeDay([]), totalCount: 0 };
        }
    }

    /**
     * Fold Chronicle records observed in an arbitrary timestamp interval into
     * a compact unattended-work summary. This deliberately uses the events
     * index rather than keeping a second in-memory history for the digest.
     */
    async readDigest(since, until = Date.now()) {
        const lower = Number(since);
        const upper = Number(until);
        if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper < lower) {
            return summarizeDigest([], { since: lower, until: upper });
        }
        if (!this.store) return summarizeDigest([], { since: lower, until: upper });

        try {
            await this.flush();
            const initial = createDigestSummary();
            let folded = initial;
            const collect = (result, event) => {
                const ts = Number(event?.ts);
                // Real ChronicleStore cursors respect the range. The explicit
                // check also keeps simple test stores and future adapters safe.
                if (!Number.isFinite(ts) || ts < lower || ts > upper) return result;
                return accumulateDigestSummary(result, event);
            };

            if (typeof this.store.reduceRange === 'function') {
                folded = await this.store.reduceRange('events', {
                    index: 'ts',
                    lower,
                    upper,
                    direction: 'next',
                }, collect, initial);
            } else if (typeof this.store.queryRange === 'function') {
                const events = await this.store.queryRange('events', {
                    index: 'ts',
                    lower,
                    upper,
                    direction: 'next',
                });
                for (const event of events || []) folded = collect(folded, event);
            }
            return finalizeDigestSummary(folded, { since: lower, until: upper });
        } catch {
            return summarizeDigest([], { since: lower, until: upper });
        }
    }

    async _foldDay(initialValue, reducer, date = new Date(), direction = 'next') {
        if (!this.store) return initialValue;
        if (typeof this.store.reduceRange !== 'function') {
            let result = initialValue;
            const events = await this.readDay(date);
            const ordered = direction === 'prev' ? events.reverse() : events;
            for (const event of ordered) result = reducer(result, event);
            return result;
        }
        const { lower, upper } = dayBounds(date);
        return this.store.reduceRange('events', {
            index: 'ts',
            lower,
            upper,
            direction,
        }, reducer, initialValue);
    }

    /** Wait for the replay and any queued writes. */
    async flush() {
        await this._replayPromise;
        return this._writeTail;
    }
}

/**
 * Roll a day's events into the numbers a recap needs. Pure, so it can be
 * tested without IndexedDB.
 */
function dayBounds(date) {
    const start = typeof date === 'string' ? chronicleDateFromKey(date) : new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { lower: start.getTime(), upper: end.getTime() - 1 };
}

function createDaySummary() {
    return {
        agents: new Set(),
        projects: new Set(),
        totalEvents: 0,
        commits: 0,
        pushes: 0,
        completed: 0,
        errors: 0,
        rateLimits: 0,
        waits: 0,
        totalWaitMs: 0,
        longestWaitMs: 0,
        firstTs: null,
        lastTs: null,
    };
}

function createDigestSummary() {
    return {
        ...createDaySummary(),
        arrivals: 0,
        departures: 0,
        resolved: 0,
        waiting: [],
        errorAgents: [],
        rateLimitAgents: [],
        commitDetails: [],
        _detailMaps: {
            waiting: new Map(),
            errorAgents: new Map(),
            rateLimitAgents: new Map(),
            commitDetails: new Map(),
        },
    };
}

function digestAgentKey(event) {
    const agentId = String(event?.agentId || '').trim();
    if (agentId) return boundedText(agentId);
    const fallback = `${String(event?.agentName || '').trim()}\u0000${String(event?.project || '').trim()}`;
    return boundedText(fallback === '\u0000' ? 'unknown' : fallback, 400);
}

function addDigestAgentDetail(summary, field, event, kind) {
    const key = digestAgentKey(event);
    const map = summary._detailMaps[field];
    const existing = map.get(key);
    if (existing) {
        existing.count++;
        existing.lastTs = Number(event?.ts) || existing.lastTs;
        return;
    }
    if (map.size >= DIGEST_STATE_LIMIT) return;

    const detail = {
        kind,
        agentId: boundedText(event?.agentId),
        agentName: boundedText(event?.agentName),
        project: boundedText(event?.project),
        reason: boundedText(event?.reason),
        count: 1,
        firstTs: Number(event?.ts) || null,
        lastTs: Number(event?.ts) || null,
    };
    map.set(key, detail);
    if (summary[field].length < DIGEST_DETAIL_LIMIT) summary[field].push(detail);
}

function addDigestCommitDetail(summary, event) {
    const label = boundedText(event?.label);
    if (!label) return;
    const key = `${label}\u0000${String(event?.agentId || '').trim()}`;
    const existing = summary._detailMaps.commitDetails.get(key);
    if (existing) {
        existing.count++;
        existing.lastTs = Number(event?.ts) || existing.lastTs;
        return;
    }
    if (summary._detailMaps.commitDetails.size >= DIGEST_STATE_LIMIT) return;
    const detail = {
        label,
        agentId: boundedText(event?.agentId),
        agentName: boundedText(event?.agentName),
        project: boundedText(event?.project),
        count: 1,
        firstTs: Number(event?.ts) || null,
        lastTs: Number(event?.ts) || null,
    };
    summary._detailMaps.commitDetails.set(key, detail);
    if (summary.commitDetails.length < DIGEST_DETAIL_LIMIT) summary.commitDetails.push(detail);
}

function accumulateDigestSummary(summary, event) {
    accumulateDaySummary(summary, event);
    switch (event?.kind) {
        case ChronicleEventKind.ARRIVED:
            summary.arrivals++;
            break;
        case ChronicleEventKind.DEPARTED:
            summary.departures++;
            clearDigestAgentState(summary, digestAgentKey(event), [
                'waiting',
                'errorAgents',
                'rateLimitAgents',
            ]);
            break;
        case ChronicleEventKind.WAITING:
            clearDigestAgentState(summary, digestAgentKey(event), [
                'errorAgents',
                'rateLimitAgents',
            ]);
            addDigestAgentDetail(summary, 'waiting', event, ChronicleEventKind.WAITING);
            break;
        case ChronicleEventKind.ERRORED:
            clearDigestAgentState(summary, digestAgentKey(event), [
                'waiting',
                'rateLimitAgents',
            ]);
            addDigestAgentDetail(summary, 'errorAgents', event, ChronicleEventKind.ERRORED);
            break;
        case ChronicleEventKind.RATE_LIMITED:
            clearDigestAgentState(summary, digestAgentKey(event), [
                'waiting',
                'errorAgents',
            ]);
            addDigestAgentDetail(summary, 'rateLimitAgents', event, ChronicleEventKind.RATE_LIMITED);
            break;
        case ChronicleEventKind.COMMIT:
            addDigestCommitDetail(summary, event);
            break;
        case ChronicleEventKind.RESOLVED:
            summary.resolved++;
            clearDigestAgentState(summary, digestAgentKey(event), ['waiting']);
            break;
        case ChronicleEventKind.COMPLETED:
            clearDigestAgentState(summary, digestAgentKey(event), [
                'waiting',
                'errorAgents',
                'rateLimitAgents',
            ]);
            break;
        default:
            break;
    }
    return summary;
}

function clearDigestAgentState(summary, key, fields) {
    for (const field of fields) summary._detailMaps[field]?.delete(key);
}

function finalizeDigestSummary(summary, { since = null, until = null } = {}) {
    const { _detailMaps: detailMaps, ...plain } = summary;
    const waitingAgentCount = detailMaps.waiting.size;
    const errorAgentCount = detailMaps.errorAgents.size;
    const rateLimitAgentCount = detailMaps.rateLimitAgents.size;
    const waiting = [...detailMaps.waiting.values()].slice(0, DIGEST_DETAIL_LIMIT);
    const errorAgents = [...detailMaps.errorAgents.values()].slice(0, DIGEST_DETAIL_LIMIT);
    const rateLimitAgents = [...detailMaps.rateLimitAgents.values()].slice(0, DIGEST_DETAIL_LIMIT);
    const daySummary = finalizeDaySummary(plain);
    return {
        ...daySummary,
        // The digest is a toast payload, not a second Chronicle page. Keep
        // names bounded even when a busy interval contains many agents.
        agents: daySummary.agents.slice(0, DIGEST_DETAIL_LIMIT),
        projects: daySummary.projects.slice(0, DIGEST_DETAIL_LIMIT),
        agentCount: daySummary.agents.length,
        projectCount: daySummary.projects.length,
        since,
        until,
        hasActivity: daySummary.totalEvents > 0,
        waiting,
        errorAgents,
        rateLimitAgents,
        commitDetails: daySummary.commitDetails,
        waitingAgents: waitingAgentCount,
        errorAgentCount,
        rateLimitAgentCount,
        unresolved: {
            waitingAgents: waitingAgentCount,
            errorAgentCount,
            rateLimitAgentCount,
        },
        urgent: {
            waiting,
            errors: errorAgents,
            rateLimits: rateLimitAgents,
        },
        routine: {
            completed: daySummary.completed,
            commits: daySummary.commits,
            pushes: daySummary.pushes,
            arrivals: countKind(daySummary, ChronicleEventKind.ARRIVED),
            departures: countKind(daySummary, ChronicleEventKind.DEPARTED),
            resolved: countKind(daySummary, ChronicleEventKind.RESOLVED),
        },
    };
}

function countKind(summary, kind) {
    // The day summary has dedicated counters only for the event kinds used by
    // its recap. Digest callers need the three quieter lifecycle counts too.
    if (kind === ChronicleEventKind.ARRIVED) return summary.arrivals || 0;
    if (kind === ChronicleEventKind.DEPARTED) return summary.departures || 0;
    if (kind === ChronicleEventKind.RESOLVED) return summary.resolved || 0;
    return 0;
}

/** Pure interval rollup used by the store-backed digest and unit tests. */
export function summarizeDigest(events = [], { since = null, until = null } = {}) {
    const summary = createDigestSummary();
    for (const event of events || []) accumulateDigestSummary(summary, event);
    return finalizeDigestSummary(summary, { since, until });
}

function accumulateDaySummary(summary, event) {
    summary.totalEvents++;
    if (event.agentName) summary.agents.add(event.agentName);
    if (event.project) summary.projects.add(event.project);
    if (summary.firstTs === null || event.ts < summary.firstTs) summary.firstTs = event.ts;
    if (summary.lastTs === null || event.ts > summary.lastTs) summary.lastTs = event.ts;
    switch (event.kind) {
        case ChronicleEventKind.COMMIT: summary.commits++; break;
        case ChronicleEventKind.PUSH: summary.pushes++; break;
        case ChronicleEventKind.COMPLETED: summary.completed++; break;
        case ChronicleEventKind.ERRORED: summary.errors++; break;
        case ChronicleEventKind.RATE_LIMITED: summary.rateLimits++; break;
        case ChronicleEventKind.WAITING: summary.waits++; break;
        case ChronicleEventKind.RESOLVED:
            summary.totalWaitMs += event.waitedMs || 0;
            summary.longestWaitMs = Math.max(summary.longestWaitMs, event.waitedMs || 0);
            break;
        default: break;
    }
    return summary;
}

function finalizeDaySummary(summary) {
    return {
        ...summary,
        agents: [...summary.agents],
        projects: [...summary.projects],
    };
}

export function summarizeDay(events = []) {
    const summary = createDaySummary();
    for (const event of events) accumulateDaySummary(summary, event);
    return finalizeDaySummary(summary);
}
