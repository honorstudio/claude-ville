// Bubble legibility. The old renderer shrank text one character at a time and
// cut mid-word, which is what produced unreadable fragments over villagers'
// heads. These tests defend the pixel-fit-then-word-boundary behaviour and the
// hover provenance that makes the badge on the bubble mean something.
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentSprite, CODEX_WEAPON_ASSETS } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

// Monospace stand-in: every glyph is 6px wide, so expected widths are exact and
// the assertions do not depend on a real font being present.
const CHAR_PX = 6;
function fakeCtx() {
    return {
        font: '10px test',
        measureCalls: 0,
        measureText(text) {
            this.measureCalls++;
            return { width: String(text).length * CHAR_PX };
        },
    };
}

function layout(text, maxWidthChars) {
    const ctx = fakeCtx();
    // Fresh host per call, so the layout cache never masks a measurement count.
    const host = { _bubbleLayoutCacheKey: null, _bubbleLayoutCache: null };
    const result = AgentSprite.prototype._bubbleLayout.call(host, ctx, text, maxWidthChars * CHAR_PX, true);
    return { ...result, measureCalls: ctx.measureCalls };
}

test('text that fits is left completely alone', () => {
    const { displayText } = layout('Running the checks', 40);
    assert.equal(displayText, 'Running the checks');
});

test('overlong text is cut at a word boundary, never mid-word', () => {
    const { displayText } = layout('Reclassify supplemental Aave lending rows', 24);
    assert.equal(displayText.endsWith('…'), true);
    assert.equal(displayText.length <= 24, true);
    // The body must end on a whole word.
    const body = displayText.slice(0, -1);
    assert.equal('Reclassify supplemental Aave lending rows'.startsWith(body), true);
    assert.match(body, /(Reclassify|supplemental|Aave|lending)$/);
});

test('a long unbroken token still yields readable text', () => {
    // No space to break on: a word-boundary-only rule would collapse this to
    // nothing, which is worse than a hard cut.
    const { displayText } = layout('$PROJECT/src/presentation/character-mode/AgentSprite.js', 20);
    assert.equal(displayText.endsWith('…'), true);
    assert.equal(displayText.length > 2, true);
});

test('fitting is logarithmic, not one character per measurement', () => {
    const long = 'Reclassify supplemental Aave lending rows so they stop outranking native wrappers';
    const { measureCalls } = layout(long, 24);
    // Character-by-character shrinking would need ~60 measurements here.
    assert.equal(measureCalls < 15, true, `expected a binary search, got ${measureCalls} measureText calls`);
});

test('trailing punctuation is not left dangling before the ellipsis', () => {
    const { displayText } = layout('Checking the adapter, then the renderer', 22);
    assert.doesNotMatch(displayText, /[,;:]…$/);
});

test('a surrogate pair is never split', () => {
    const { displayText } = layout('🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷', 6);
    assert.doesNotMatch(displayText, /[\ud800-\udbff]…$/);
});

test('hover exposes the untrimmed wording and the exact origin', () => {
    const host = {
        _activitySnapshot: {
            text: 'The user wants me to execute a research procedure for mint…',
            full: 'The user wants me to execute a research procedure for mint-bridge-boundary analysis.',
            kind: 'thinking',
            source: 'grok.thought.chunk',
            fidelity: 'excerpt',
            redacted: false,
        },
    };
    const tip = AgentSprite.prototype.dialogueTooltip.call(host);
    // Full text, so hovering recovers what the bubble had to cut.
    assert.match(tip, /boundary analysis\./);
    // And the origin, named exactly.
    assert.match(tip, /Model reasoning — grok\.thought\.chunk \(excerpt\)/);
});

test('hover discloses redaction', () => {
    const host = {
        _activitySnapshot: {
            text: 'Implemented the fix in $PROJECT/src/foo.js',
            full: null,
            kind: 'assistant',
            source: 'claude.text',
            fidelity: 'verbatim',
            redacted: true,
        },
    };
    assert.match(AgentSprite.prototype.dialogueTooltip.call(host), /\(redacted\)/);
});

test('a silent villager has no tooltip', () => {
    assert.equal(AgentSprite.prototype.dialogueTooltip.call({ _activitySnapshot: null }), '');
    // Harness status entries carry no source, so they claim no provenance.
    assert.equal(
        AgentSprite.prototype.dialogueTooltip.call({ _activitySnapshot: { text: 'WORKING', source: null } }),
        '',
    );
});

// Bubble slot geometry. These call the real methods so every module-level
// constant they touch is actually evaluated. A missing declaration is a runtime
// ReferenceError that `node --check` cannot see and that pauses the whole world
// renderer after three consecutive frame failures — which is exactly how it
// escaped review once already.
function slotHost() {
    return {
        camera: { zoom: 1 },
        // Real method, so the constants it reads are genuinely evaluated.
        _agentBubbleWidth: IsometricRenderer.prototype._agentBubbleWidth,
    };
}

test('slot reservation widens with the real line length and stays bounded', () => {
    const host = slotHost();
    const width = (text) => IsometricRenderer.prototype._agentBubbleWidth.call(host, {
        _activitySnapshot: text === null ? null : { text },
    });

    // Silent villager: falls back to the short-label floor.
    const floor = width(null);
    assert.equal(floor > 0, true);
    // A short status label does not exceed the floor.
    assert.equal(width('IDLE'), floor);
    // A real intent phrase reserves more room than the old fixed estimate.
    assert.equal(width('Checking git state and largest files') > floor, true);
    // A long reasoning excerpt is capped at the width the sprite truncates to.
    assert.equal(width('x'.repeat(400)), 232);
});

test('stacked slots step upward without overlapping', () => {
    const host = slotHost();
    const sprite = { x: 100, y: 200, _activitySnapshot: { text: 'Running the checks' } };
    const slot0 = IsometricRenderer.prototype._agentBubbleSlotRect.call(host, sprite, 0);
    const slot1 = IsometricRenderer.prototype._agentBubbleSlotRect.call(host, sprite, 1);

    for (const rect of [slot0, slot1]) {
        for (const key of ['x', 'y', 'w', 'h']) {
            assert.equal(Number.isFinite(rect[key]), true, `${key} must be finite, got ${rect[key]}`);
        }
    }
    assert.equal(slot0.h > 0, true);
    assert.equal(slot0.w > 0, true);
    // Higher slots sit above lower ones and do not share vertical space.
    assert.equal(slot1.y < slot0.y, true);
    assert.equal(slot1.y + slot1.h <= slot0.y + 1, true);
});

test('only villagers with something to show reserve a slot', () => {
    const wants = (sprite) => IsometricRenderer.prototype._spriteWantsBubble.call(slotHost(), sprite);

    assert.equal(wants({ _activitySnapshot: { text: 'Running the checks' } }), true);
    // Silent and not waiting: reserves nothing, so a speaking neighbour keeps slot 0.
    assert.equal(wants({ _activitySnapshot: null }), false);
    // Silent but blocked long enough for the wait clock: still needs its slot.
    assert.equal(wants({ _activitySnapshot: null, _shouldUseLongWaitClock: () => true }), true);
    assert.equal(wants({ chatting: true, _activitySnapshot: { text: 'x' } }), false);
    assert.equal(wants(null), false);
});

// A Sol villager rendered its dawnblade behind its own body in every direction,
// which hid roughly two thirds of the blade and left the authored empty hands
// gripping air. Measured on a frozen pose: 16,026 visible weapon pixels forced
// behind the body versus 29,570 with the default rule.
test('an empty-handed sprite carries its weapon in front, and tucks it away only when facing away', () => {
    const backLayer = (def, dir) => AgentSprite.prototype._assetWeaponBackLayer.call({}, def, dir);
    const dawnblade = CODEX_WEAPON_ASSETS.dawnblade;

    // The bug: `backLayer: 'always'` on a hand-held weapon.
    assert.equal(dawnblade.backLayer, undefined);
    for (const dir of ['s', 'se', 'e', 'sw', 'w']) {
        assert.equal(backLayer(dawnblade, dir), false, `dawnblade should be held in view facing ${dir}`);
    }
    // Facing away, the blade belongs behind the body.
    for (const dir of ['n', 'ne', 'nw']) {
        assert.equal(backLayer(dawnblade, dir), true, `dawnblade should sit behind the body facing ${dir}`);
    }

    // Sol/Luna/Terra sprites are all authored empty-handed, so none of them may
    // force its signature weapon behind the body.
    for (const key of ['dawnblade', 'crescentSaber', 'earthbreaker']) {
        assert.notEqual(CODEX_WEAPON_ASSETS[key].backLayer, 'always', `${key} must stay visible from the front`);
    }

    // `greatsword` is the deliberate exception: it pairs with procedural heavy
    // armour drawn on the front layer, so its blade has to stay behind.
    assert.equal(CODEX_WEAPON_ASSETS.greatsword.backLayer, 'always');
    assert.equal(backLayer(CODEX_WEAPON_ASSETS.greatsword, 's'), true);
});
