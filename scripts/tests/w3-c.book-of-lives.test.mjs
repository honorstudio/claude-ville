import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    BOOK_OF_LIVES_CHAPTER_LIMIT,
    BOOK_OF_LIVES_MILESTONE_LIMIT,
    BOOK_OF_LIVES_VISIBLE_CHAPTER_LIMIT,
    buildBookOfLivesViewModel,
} from '../../claudeville/src/presentation/shared/ActivityPanel.js';

const NOW = Date.UTC(2026, 7, 30, 12);
const GENERATED_CHAPTER_LABELS = new Set([
    'Arrived',
    'Departed',
    'Completed a task',
    'Waited for you',
    'Recovered',
    'Encountered an error',
    'Paused at a rate limit',
    'Committed',
    'Pushed',
]);

function biography(overrides = {}) {
    return {
        identityKey: 'named:codex:ada',
        firstSeenAt: NOW - 10_000,
        lastSeenAt: NOW - 1_000,
        milestones: [],
        extensions: { lifeEpisodes: [] },
        ...overrides,
    };
}

test('ActivityPanel remains importable and chapters are chronological with a bounded window', () => {
    const episodes = Array.from({ length: 40 }, (_, index) => ({
        id: `episode-${index}`,
        kind: index % 2 ? 'waiting' : 'arrived',
        at: NOW - (40 - index) * 1000,
        project: 'claude-ville',
        label: 'Private transcript prose must not survive.',
    })).reverse();
    const model = buildBookOfLivesViewModel(biography({
        extensions: { lifeEpisodes: episodes },
    }), { now: NOW });
    const chapters = [...model.archivedChapters, ...model.visibleChapters];

    assert.equal(model.visibleChapters.length, BOOK_OF_LIVES_VISIBLE_CHAPTER_LIMIT);
    assert.equal(chapters.length, BOOK_OF_LIVES_CHAPTER_LIMIT);
    assert.deepEqual(chapters.map(chapter => chapter.at), [...chapters.map(chapter => chapter.at)].sort());
    assert.equal(JSON.stringify(model).includes('Private transcript prose'), false);
});

test('an empty ring has a graceful state and anonymous history is session-scoped', () => {
    const model = buildBookOfLivesViewModel(biography({
        identityKey: 'anonymous:codex:session-42',
    }), { now: NOW });

    assert.deepEqual(model.visibleChapters, []);
    assert.deepEqual(model.archivedChapters, []);
    assert.equal(model.emptyLabel, 'No life chapters have been recorded yet.');
    assert.equal(model.sessionScoped, true);
    assert.match(model.scopeLabel, /scoped to this session/i);
    assert.doesNotMatch(model.scopeLabel, /across sessions/i);
});

test('generated descriptors expose first and last seen plus multiple bounded milestones', () => {
    const model = buildBookOfLivesViewModel(biography({
        milestones: [
            { id: 'first-seen', at: NOW - 10_000, label: 'Injected prose' },
            { id: 'sessionsCompleted-1', at: NOW - 9_000, label: 'Injected prose' },
            { id: 'commitsPushed-1', at: NOW - 8_000, label: 'Injected prose' },
            { id: 'unknown-milestone', at: NOW - 7_000, label: 'Injected prose' },
        ],
    }), { now: NOW });

    assert.notEqual(model.firstSeenLabel, 'Not recorded');
    assert.notEqual(model.lastReturnedLabel, 'Not recorded');
    assert.deepEqual(model.milestones.map(milestone => milestone.label), [
        'Settled in the village',
        'First session completed',
        'First push to the harbor',
    ]);
    assert.ok(model.milestones.length > 1);
    assert.ok(model.milestones.length <= BOOK_OF_LIVES_MILESTONE_LIMIT);
    assert.equal(JSON.stringify(model).includes('Injected prose'), false);
});

test('chapter descriptor copy comes only from closed labels and bounded project names', () => {
    const modelProse = 'I reasoned through the user prompt in private.';
    const model = buildBookOfLivesViewModel(biography({
        extensions: {
            lifeEpisodes: [
                { id: modelProse, kind: 'push', at: NOW - 3, project: 'claude-ville', label: modelProse },
                { id: modelProse, kind: 'invented', at: NOW - 2, project: 'secret', label: modelProse },
                { id: modelProse, kind: 'departed', at: NOW - 1, project: '', label: modelProse },
            ],
        },
    }), { now: NOW });
    const chapters = [...model.archivedChapters, ...model.visibleChapters];

    assert.equal(chapters.length, 2);
    for (const chapter of chapters) {
        assert.ok(GENERATED_CHAPTER_LABELS.has(chapter.label));
        assert.equal(chapter.copy, chapter.project ? `${chapter.label} in ${chapter.project}` : chapter.label);
        assert.equal(Object.hasOwn(chapter, 'id'), false);
    }
    assert.equal(JSON.stringify(chapters).includes(modelProse), false);
});

test('activity panel CSS preserves desktop-only policy and reduced-motion coverage', async () => {
    const css = await readFile(new URL('../../claudeville/css/activity-panel.css', import.meta.url), 'utf8');

    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    assert.doesNotMatch(css, /@media[^\{]*\b(?:width|min-width|max-width)\b/i);
    assert.doesNotMatch(css, /activity-panel__life[^\{]*\{[^\}]*transition\s*:/i);
});
