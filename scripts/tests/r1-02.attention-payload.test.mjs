import test from 'node:test';
import assert from 'node:assert/strict';

import { AttentionService } from '../../claudeville/src/application/AttentionService.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

class FakeNotification {
    static permission = 'granted';
    static instances = [];

    constructor(title, options) {
        this.title = title;
        this.options = options;
        this.closeCalls = 0;
        FakeNotification.instances.push(this);
    }

    close() {
        this.closeCalls++;
        this.onclose?.();
    }
}

function hiddenDocument() {
    return {
        visibilityState: 'hidden',
        querySelector() { return null; },
    };
}

test('attention:raised carries enriched context and keeps legacy fields', () => {
    const now = Date.now();
    const oldest = {
        id: 'agent-oldest',
        name: 'Oldest',
        status: 'waiting_on_user',
        waitReason: 'approval',
        awaitingSince: now - 120_000,
    };
    const newer = {
        id: 'agent-newer',
        name: 'Newer',
        status: 'waiting_on_user',
        waitReason: 'question',
        awaitingSince: now - 30_000,
    };
    const errored = {
        id: 'agent-error',
        name: 'Error',
        status: 'errored',
        awaitingSince: null,
    };
    const world = {
        agents: new Map([
            [oldest.id, oldest],
            [newer.id, newer],
            [errored.id, errored],
        ]),
    };
    const raised = [];
    const legacy = [];
    const onRaised = payload => raised.push(payload);
    const onLegacy = ({ agentId, status, label }) => legacy.push({ agentId, status, label });
    eventBus.on('attention:raised', onRaised);
    eventBus.on('attention:raised', onLegacy);
    const service = new AttentionService(world);

    try {
        service.refresh();
    } finally {
        eventBus.off('attention:raised', onRaised);
        eventBus.off('attention:raised', onLegacy);
        service.destroy();
    }

    assert.equal(raised.length, 3);
    assert.equal(legacy.length, 3);
    for (const payload of raised) {
        assert.ok(payload.agent);
        assert.equal(payload.agentId, payload.agent.id);
        assert.equal(payload.reason, payload.agent.waitReason || payload.agent.status);
        assert.equal(payload.waitingCount, 3);
        assert.ok(payload.oldestWaitMs >= 120_000);
        assert.ok(payload.oldestWaitMs < 121_000);
    }
    assert.deepEqual(
        new Set(legacy.map(({ agentId }) => agentId)),
        new Set([oldest.id, newer.id, errored.id]),
    );
    const oldestLegacy = legacy.find(({ agentId }) => agentId === oldest.id);
    assert.equal(oldestLegacy.status, oldest.status);
    assert.equal(oldestLegacy.label, 'is waiting for approval');
});

test('desktop notification click focuses and selects the current agent', () => {
    FakeNotification.instances = [];
    const waiting = {
        id: 'agent-click',
        name: 'Click',
        status: 'waiting_on_user',
    };
    const current = { ...waiting, name: 'Current Click' };
    const world = { agents: new Map([[waiting.id, current]]) };
    const service = new AttentionService(world, {
        document: hiddenDocument(),
        NotificationClass: FakeNotification,
    });
    service.desktopAlerts = true;
    const previousWindow = globalThis.window;
    let focusCalls = 0;
    globalThis.window = { focus: () => { focusCalls++; } };
    let selected = null;
    const onSelected = agent => { selected = agent; };
    eventBus.on('agent:selected', onSelected);

    try {
        service._notify(waiting, 'is waiting for you');
        const notification = FakeNotification.instances.at(-1);
        notification.onclick();
    } finally {
        eventBus.off('agent:selected', onSelected);
        service.destroy();
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }

    assert.equal(focusCalls, 1);
    assert.strictEqual(selected, current);
});
