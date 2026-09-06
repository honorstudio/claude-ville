import test from 'node:test';
import assert from 'node:assert/strict';

import {
    attentionAgentIds,
    isKeyboardEditTarget,
    nextCardId,
    recoveryCardId,
} from '../../claudeville/src/presentation/dashboard-mode/DashboardKeyboardNavigation.js';

test('card traversal follows visual order and wraps in both directions', () => {
    const ids = ['agent-a', 'agent-b', 'agent-c'];
    assert.equal(nextCardId(ids, 'agent-a', 1), 'agent-b');
    assert.equal(nextCardId(ids, 'agent-c', 1), 'agent-a');
    assert.equal(nextCardId(ids, 'agent-a', -1), 'agent-c');
    assert.equal(nextCardId(ids, 'missing', 1), 'agent-a');
    assert.equal(nextCardId(ids, 'missing', -1), 'agent-c');
});

test('focus recovery chooses the card occupying the removed card position', () => {
    const ids = ['agent-a', 'agent-b', 'agent-c'];
    assert.equal(recoveryCardId(ids, 'agent-b'), 'agent-c');
    assert.equal(recoveryCardId(ids, 'agent-c'), 'agent-b');
    assert.equal(recoveryCardId(['agent-a'], 'agent-a'), null);
});

test('attention shortcut candidates are actionable and longest-waiting first', () => {
    const ids = attentionAgentIds([
        { id: 'working', status: 'working', awaitingSince: 1 },
        { id: 'generic-wait', status: 'waiting', awaitingSince: 50 },
        { id: 'newer', status: 'waiting_on_user', awaitingSince: 300 },
        { id: 'oldest', status: 'errored', awaitingSince: 100 },
        { id: 'middle', status: 'rate_limited', awaitingSince: 200 },
    ]);
    assert.deepEqual(ids, ['oldest', 'middle', 'newer']);
});

test('keyboard commands ignore editing controls', () => {
    assert.equal(isKeyboardEditTarget({ tagName: 'INPUT' }), true);
    assert.equal(isKeyboardEditTarget({ tagName: 'textarea' }), true);
    assert.equal(isKeyboardEditTarget({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(isKeyboardEditTarget({ tagName: 'BUTTON' }), false);
});
