import test from 'node:test';
import assert from 'node:assert/strict';

import { Toast, formatCueCaption } from '../../claudeville/src/presentation/shared/Toast.js';

class FakeClassList {
    constructor(owner) {
        this.owner = owner;
    }

    add(value) {
        const names = new Set(this.owner.className.split(/\s+/).filter(Boolean));
        names.add(value);
        this.owner.className = [...names].join(' ');
    }
}

class FakeElement {
    constructor() {
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.classList = new FakeClassList(this);
        this.dataset = {};
        this.attributes = new Map();
        this.textContent = '';
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }
}

function harness() {
    const container = new FakeElement();
    const listeners = new Map();
    const eventTarget = {
        on(name, listener) {
            listeners.set(name, listener);
            return () => listeners.delete(name);
        },
        emit(name, payload) {
            listeners.get(name)?.(payload);
        },
    };
    const documentRef = {
        getElementById(id) { return id === 'toastContainer' ? container : null; },
        createElement() { return new FakeElement(); },
    };
    const toast = new Toast({ eventTarget, documentRef });
    return {
        container,
        eventTarget,
        toast,
        cleanup() {
            toast.destroy();
        },
    };
}

test('cue copy names agents and translates internal cue kinds', () => {
    assert.equal(formatCueCaption({ kind: 'summons', agentId: 'a-1', label: 'Aurora' }), 'Aurora needs you');
    assert.equal(formatCueCaption({ kind: 'arrival', agentId: 'a-1', label: 'Aurora' }), 'Aurora arrived');
    assert.equal(formatCueCaption({ kind: 'distress', agentId: 'a-1', label: 'Aurora' }), 'Aurora needs attention');
    assert.equal(formatCueCaption({ kind: 'hourBell', agentId: null, label: '' }), 'The hour bell is ringing');
    assert.equal(formatCueCaption({ kind: 'summons', label: 'Aurora needs you' }), 'Aurora needs you');
    assert.equal(formatCueCaption({ kind: 'summons', label: 'is waiting for approval' }), 'An agent is waiting for approval');
    assert.equal(
        formatCueCaption({ kind: 'summons', agentId: 'a-1', label: 'is waiting for approval' }, 'Aurora'),
        'Aurora is waiting for approval',
    );
    assert.equal(formatCueCaption(null), '');
});

test('audio cues render independently of audio state and duplicate cues coalesce', () => {
    const view = harness();
    try {
        view.eventTarget.emit('agent:added', { id: 'a-1', name: 'Aurora' });
        view.eventTarget.emit('audio:cue-played', {
            kind: 'summons',
            agentId: 'a-1',
            label: 'is waiting for approval',
            at: Date.now(),
        });
        view.eventTarget.emit('audio:cue-played', {
            kind: 'summons',
            agentId: 'a-1',
            label: 'is waiting for approval',
            at: Date.now(),
        });

        assert.equal(view.container.children.length, 1);
        assert.equal(view.container.children[0].textContent, 'Aurora is waiting for approval ×2');
        assert.equal(view.container.children[0].attributes.get('role'), 'alert');
        assert.equal(view.container.children[0].dataset.cueKind, 'summons');
    } finally {
        view.cleanup();
    }
});

test('caption bursts stay bounded while primary cues displace routine cues first', () => {
    const view = harness();
    try {
        view.eventTarget.emit('audio:cue-played', { kind: 'arrival', agentId: 'a', label: 'Aurora' });
        view.eventTarget.emit('audio:cue-played', { kind: 'departure', agentId: 'b', label: 'Bramble' });
        view.eventTarget.emit('audio:cue-played', { kind: 'thunder', agentId: null, label: '' });
        view.eventTarget.emit('audio:cue-played', { kind: 'summons', agentId: 'c', label: 'Cinder' });

        assert.equal(view.container.children.length, 3);
        assert.deepEqual(
            view.container.children.map(child => child.textContent),
            ['Bramble departed', 'Thunder nearby', 'Cinder needs you'],
        );
    } finally {
        view.cleanup();
    }
});

test('nullable lifecycle cue ids use synchronous village context to retain the agent name', () => {
    const view = harness();
    try {
        view.eventTarget.emit('village:scene', { kind: 'arrival', agentId: 'a-1', label: 'Aurora' });
        view.eventTarget.emit('audio:cue-played', {
            kind: 'arrival',
            agentId: null,
            label: 'Agent arrived',
        });

        assert.equal(view.container.children[0].textContent, 'Aurora arrived');
    } finally {
        view.cleanup();
    }
});

test('missing cue events and partial payloads are harmless', () => {
    const view = harness();
    try {
        assert.equal(view.container.children.length, 0);
        view.eventTarget.emit('audio:cue-played', undefined);
        view.eventTarget.emit('audio:cue-played', {});
        assert.equal(view.container.children.length, 0);
    } finally {
        view.cleanup();
    }
});
