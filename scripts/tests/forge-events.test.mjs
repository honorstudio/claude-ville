import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    MAX_FORGE_EVENTS_PER_PROJECT,
    extractGitEventsFromCommandSource,
} = require('../../claudeville/adapters/gitEvents.js');

import {
    verifiedOutcomeFromGitEvent,
} from '../../claudeville/src/presentation/character-mode/ChronicleEvents.js';

const project = '/tmp/claude-ville-forge-events';
const context = {
    project,
    provider: 'codex',
    sessionId: 'session-forge',
    ts: Date.parse('2026-09-02T12:00:00Z'),
};

function forgeSource(command, stdout) {
    return {
        command,
        result: { stdout },
    };
}

test('parses PR, issue, and release events with URLs from tool results', () => {
    const fixtures = [
        forgeSource(
            'gh pr create --title "Ship the harbor"',
            'https://github.com/example/claude-ville/pull/42\n',
        ),
        forgeSource(
            'gh issue create --title "Track the harbor"',
            'https://github.com/example/claude-ville/issues/7\n',
        ),
        forgeSource(
            'gh release create v0.39.0 --title "The harbor release"',
            'https://github.com/example/claude-ville/releases/tag/v0.39.0\n',
        ),
    ];

    const events = fixtures.flatMap((source, index) => extractGitEventsFromCommandSource(source, {
        ...context,
        sourceId: `forge-${index}`,
    }));

    assert.deepEqual(events.map(event => event.type), ['pr', 'issue', 'release']);
    assert.deepEqual(events.map(event => event.url), [
        'https://github.com/example/claude-ville/pull/42',
        'https://github.com/example/claude-ville/issues/7',
        'https://github.com/example/claude-ville/releases/tag/v0.39.0',
    ]);
    for (const event of events) {
        assert.equal(event.inferred, true);
        assert.equal(event.observed, false);
    }
});

test('does not guess a URL when a forge command result has none', () => {
    const [event] = extractGitEventsFromCommandSource(
        forgeSource('gh pr create --title "No link"', 'Created pull request #43\n'),
        context,
    );

    assert.equal(event.type, 'pr');
    assert.equal(Object.hasOwn(event, 'url'), false);
});

test('strips long tokens and key/token assignments before storing forge events', () => {
    const secret = 'A'.repeat(40);
    const [event] = extractGitEventsFromCommandSource(
        forgeSource(
            `gh pr create --title "Secret" --token=${secret} key=${secret}`,
            `https://github.com/example/claude-ville/pull/44 token=${secret}\n`,
        ),
        context,
    );

    const stored = JSON.stringify(event);
    assert.equal(stored.includes(secret), false);
    assert.equal(/(?:key|token)=/i.test(stored), false);
});

test('bounds forge events retained for each project', () => {
    const count = MAX_FORGE_EVENTS_PER_PROJECT + 17;
    const command = Array.from({ length: count }, (_, index) => (
        `gh issue create --title "Issue ${index}"`
    )).join('\n');
    const stdout = Array.from({ length: count }, (_, index) => (
        `https://github.com/example/claude-ville/issues/${index + 1}`
    )).join('\n');

    const events = extractGitEventsFromCommandSource(
        forgeSource(command, stdout),
        context,
    );
    const issueEvents = events.filter(event => event.type === 'issue');

    assert.equal(MAX_FORGE_EVENTS_PER_PROJECT > 0, true);
    assert.equal(issueEvents.length, MAX_FORGE_EVENTS_PER_PROJECT);
    assert.equal(issueEvents.at(-1).url, `https://github.com/example/claude-ville/issues/${count}`);
});

test('release events can feed the existing verified-outcome release kind', () => {
    const outcome = verifiedOutcomeFromGitEvent({
        type: 'release',
        project,
        success: true,
        completedAt: context.ts,
    }, { agentId: 'agent-forge' });

    assert.deepEqual(outcome, {
        kind: 'release',
        project,
        agentId: 'agent-forge',
        at: context.ts,
    });
});
