// Server-side dialogue contract: sanitation, trimming, arbitration, and the
// source gate. These are the guarantees the world view relies on to claim that
// a bubble is the model's own words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    DIALOGUE_MAX_AGE_MS,
    DIALOGUE_TIE_WINDOW_MS,
    emptyObservedSources,
    makeDialogue,
    normalizeDialogue,
    normalizeObservedSources,
    pickDialogue,
    sanitizeDialogueText,
    trimToCap,
} = require('../../claudeville/adapters/dialogue.js');

const NOW = 1_800_000_000_000;

test('secrets are redacted and the redaction is disclosed', () => {
    const cases = [
        'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345',
        'curl -H "Authorization: Bearer abcdefghijklmnop"',
        'AWS key AKIAIOSFODNN7EXAMPLE in the config',
        'mailto someone@example.com about it',
        'API_SECRET: "hunter2hunter2hunter2"',
    ];
    for (const input of cases) {
        const result = sanitizeDialogueText(input, { project: null, home: '/home/nobody' });
        assert.equal(result.redacted, true, `expected redaction for: ${input}`);
        assert.match(result.text, /\[redacted\]/);
    }
});

test('absolute paths become portable tokens without losing the meaningful suffix', () => {
    const result = sanitizeDialogueText('Editing /home/dev/work/app/src/foo.js now', {
        project: '/home/dev/work/app',
        home: '/home/dev',
    });
    // Project wins over home because the longer prefix is applied first.
    assert.equal(result.text, 'Editing $PROJECT/src/foo.js now');
    assert.equal(result.redacted, true);
});

test('markdown markup is stripped without counting as redaction', () => {
    // Reasoning text arrives as Markdown. Removing emphasis syntax drops no
    // words, so the line is still verbatim and must not be flagged.
    const result = sanitizeDialogueText('**Confirming safe filename handling**');
    assert.equal(result.text, 'Confirming safe filename handling');
    assert.equal(result.redacted, false);

    const heading = sanitizeDialogueText('## Verifying `parseTimestamp` output');
    assert.equal(heading.text, 'Verifying parseTimestamp output');
    assert.equal(heading.redacted, false);
});

test('bidi overrides and control characters cannot survive', () => {
    const result = sanitizeDialogueText('Deleting\u202Etxt.exe\u202C file');
    assert.doesNotMatch(result.text, /[\u202a-\u202e]/);
});

test('trimming stops at a word boundary and reports that it cut', () => {
    const untouched = trimToCap('Running the checks', 24);
    assert.equal(untouched.text, 'Running the checks');
    assert.equal(untouched.cut, false);

    const cut = trimToCap('Reclassifying supplemental Aave lending rows', 24);
    assert.equal(cut.cut, true);
    assert.equal(cut.text.endsWith('…'), true);
    // Whole words only: no dangling partial token before the ellipsis.
    assert.doesNotMatch(cut.text, /suppleme…$/);
    assert.equal([...cut.text].length <= 24, true);
});

test('trimming a single unbroken token still yields text', () => {
    // A long path has no space to break on; collapsing to nothing would be worse
    // than a hard cut.
    const cut = trimToCap('/very/long/path/without/any/spaces/at/all/file.js', 20);
    assert.equal(cut.cut, true);
    assert.equal(cut.text.length > 1, true);
});

test('trimming counts graphemes, not UTF-16 units', () => {
    const flags = '🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷';
    const cut = trimToCap(flags, 3);
    assert.equal(cut.cut, true);
    // Naive slicing would split a surrogate pair and emit replacement junk.
    assert.doesNotMatch(cut.text, /\uFFFD/);
});

test('makeDialogue tags fidelity from whether it had to trim', () => {
    const verbatim = makeDialogue({
        text: 'Measuring repo scale by area',
        kind: 'intent',
        source: 'omp.tool.i',
        observedAt: NOW,
        actionId: 'call-1',
    });
    assert.equal(verbatim.fidelity, 'verbatim');
    assert.equal(verbatim.authorship, 'model');
    assert.equal(verbatim.full, null);

    const long = 'a'.repeat(200);
    const excerpt = makeDialogue({ text: long, kind: 'thinking', source: 'grok.thought.chunk', observedAt: NOW });
    assert.equal(excerpt.fidelity, 'excerpt');
    assert.equal([...excerpt.text].length <= 80, true);
    // The untrimmed remainder is retained separately for the narration panel.
    assert.equal([...excerpt.full].length > 80, true);
});

test('makeDialogue refuses unusable input instead of inventing a line', () => {
    const base = { text: 'Running the checks', kind: 'intent', source: 's', observedAt: NOW };
    assert.equal(makeDialogue({ ...base, kind: 'gossip' }), null);
    assert.equal(makeDialogue({ ...base, observedAt: 0 }), null);
    assert.equal(makeDialogue({ ...base, observedAt: NaN }), null);
    assert.equal(makeDialogue({ ...base, text: '   ' }), null);
});

test('arbitration prefers the newest line, not the highest-ranked one', () => {
    // This is the load-bearing rule: a stale plan step outranking a newer tool
    // intent is how the previous system showed confident text about work the
    // agent had already finished.
    const stalePlan = makeDialogue({
        text: 'Audit banner-driven freshness inputs',
        kind: 'plan',
        source: 'codex.plan.step',
        observedAt: NOW - 40_000,
    });
    const freshIntent = makeDialogue({
        text: 'Running the checks',
        kind: 'intent',
        source: 'claude.bash.description',
        observedAt: NOW - 1_000,
    });
    assert.equal(pickDialogue([stalePlan, freshIntent], { now: NOW }).text, 'Running the checks');
    // And the reverse: a newer plan step beats an older intent.
    const olderIntent = makeDialogue({ ...freshIntent, observedAt: NOW - 60_000 });
    const newPlan = makeDialogue({ ...stalePlan, observedAt: NOW - 2_000 });
    assert.equal(pickDialogue([olderIntent, newPlan], { now: NOW }).kind, 'plan');
});

test('rank breaks ties only inside the simultaneity window', () => {
    const thinking = makeDialogue({ text: 'Weighing two options', kind: 'thinking', source: 't', observedAt: NOW });
    const intent = makeDialogue({
        text: 'Reading the adapter',
        kind: 'intent',
        source: 'i',
        observedAt: NOW - (DIALOGUE_TIE_WINDOW_MS - 100),
    });
    // Simultaneous: the hierarchy decides, so concrete intent wins over musing.
    assert.equal(pickDialogue([thinking, intent], { now: NOW }).kind, 'intent');

    const olderIntent = makeDialogue({ ...intent, observedAt: NOW - (DIALOGUE_TIE_WINDOW_MS + 100) });
    // Outside the window, recency decides again.
    assert.equal(pickDialogue([thinking, olderIntent], { now: NOW }).kind, 'thinking');
});

test('arbitration drops stale and implausibly-future candidates', () => {
    const stale = makeDialogue({ text: 'Old news', kind: 'intent', source: 's', observedAt: NOW - DIALOGUE_MAX_AGE_MS - 1 });
    assert.equal(pickDialogue([stale], { now: NOW }), null);

    const future = makeDialogue({ text: 'Tomorrow work', kind: 'intent', source: 's', observedAt: NOW + 60_000 });
    assert.equal(pickDialogue([future], { now: NOW }), null);

    // Small clock skew is tolerated rather than silencing a live agent.
    const skewed = makeDialogue({ text: 'Just now', kind: 'intent', source: 's', observedAt: NOW + 1_000 });
    assert.equal(pickDialogue([skewed], { now: NOW }).text, 'Just now');
});

test('empty candidate sets stay silent', () => {
    assert.equal(pickDialogue([], { now: NOW }), null);
    assert.equal(pickDialogue(null, { now: NOW }), null);
    assert.equal(pickDialogue([null, undefined], { now: NOW }), null);
});

test('observed sources are a strict boolean record, never a capability guess', () => {
    assert.deepEqual(emptyObservedSources(), {
        toolIntent: false,
        planStep: false,
        thinkingPlaintext: false,
        assistantText: false,
    });
    // Truthy-but-not-true values do not count as an observation.
    assert.deepEqual(normalizeObservedSources({ toolIntent: 'yes', planStep: 1, thinkingPlaintext: true }), {
        toolIntent: false,
        planStep: false,
        thinkingPlaintext: true,
        assistantText: false,
    });
    assert.deepEqual(normalizeObservedSources(undefined), emptyObservedSources());
});

test('wire normalization rejects malformed dialogue rather than passing it through', () => {
    assert.equal(normalizeDialogue(null), null);
    assert.equal(normalizeDialogue({ text: 'hi' }), null);
    assert.equal(normalizeDialogue({ text: 'hi', kind: 'intent', observedAt: 0 }), null);
    assert.equal(normalizeDialogue({ text: 'hi', kind: 'nonsense', observedAt: NOW }), null);

    const ok = normalizeDialogue({
        text: 'Running the checks',
        kind: 'intent',
        source: 'omp.tool.i',
        fidelity: 'verbatim',
        observedAt: NOW,
        actionId: 7,
    });
    assert.equal(ok.actionId, '7');
    assert.equal(ok.authorship, 'model');
    // An unrecognized fidelity is downgraded, never upgraded to verbatim.
    assert.equal(normalizeDialogue({ text: 'x', kind: 'intent', observedAt: NOW, fidelity: 'perfect' }).fidelity, 'excerpt');
});
