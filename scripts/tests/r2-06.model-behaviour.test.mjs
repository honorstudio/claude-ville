import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MODEL_BEHAVIOR_PROFILES,
    ModelBehaviorTier,
    Mood,
    modelBehaviorProfile,
    moodBehaviorMultiplier,
} from '../../claudeville/src/domain/value-objects/AgentMood.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';

test('model families resolve to intuitive quick, balanced, and deliberate tiers', () => {
    assert.equal(modelBehaviorProfile('claude-haiku-4-5').tier, ModelBehaviorTier.QUICK);
    assert.equal(modelBehaviorProfile('claude-sonnet-4-6').tier, ModelBehaviorTier.BALANCED);
    assert.equal(modelBehaviorProfile('claude-opus-4-6').tier, ModelBehaviorTier.DELIBERATE);
    assert.equal(modelBehaviorProfile('gpt-5.6-luna').tier, ModelBehaviorTier.QUICK);
    assert.equal(modelBehaviorProfile('gpt-5.6-terra').tier, ModelBehaviorTier.BALANCED);
    assert.equal(modelBehaviorProfile('gpt-5.6-sol').tier, ModelBehaviorTier.DELIBERATE);
    assert.equal(modelBehaviorProfile('deepseek-v4-flash').tier, ModelBehaviorTier.QUICK);
    assert.equal(modelBehaviorProfile('deepseek-reasoner').tier, ModelBehaviorTier.DELIBERATE);
    assert.equal(modelBehaviorProfile('zai/glm-5.3-flash').tier, ModelBehaviorTier.QUICK);
    assert.equal(modelBehaviorProfile('zai/glm-5.3').tier, ModelBehaviorTier.DELIBERATE);
});

test('reasoning effort can shift a balanced model without erasing model identity', () => {
    assert.equal(modelBehaviorProfile('gpt-5.4', 'low').tier, ModelBehaviorTier.QUICK);
    assert.equal(modelBehaviorProfile('gpt-5.4', 'medium').tier, ModelBehaviorTier.BALANCED);
    assert.equal(modelBehaviorProfile('gpt-5.4', 'high').tier, ModelBehaviorTier.DELIBERATE);
    assert.equal(modelBehaviorProfile('claude-opus-4-6', 'low').tier, ModelBehaviorTier.BALANCED);
    assert.equal(modelBehaviorProfile('claude-haiku-4-5', 'xhigh').tier, ModelBehaviorTier.BALANCED);
});

test('calibration is ordered, bounded, and returns shared immutable profiles', () => {
    const quick = MODEL_BEHAVIOR_PROFILES[ModelBehaviorTier.QUICK];
    const balanced = MODEL_BEHAVIOR_PROFILES[ModelBehaviorTier.BALANCED];
    const deliberate = MODEL_BEHAVIOR_PROFILES[ModelBehaviorTier.DELIBERATE];

    assert.ok(quick.walkPace > balanced.walkPace);
    assert.ok(balanced.walkPace > deliberate.walkPace);
    assert.ok(quick.fidgetInterval < balanced.fidgetInterval);
    assert.ok(balanced.fidgetInterval < deliberate.fidgetInterval);
    assert.ok(quick.thinkDuration < balanced.thinkDuration);
    assert.ok(balanced.thinkDuration < deliberate.thinkDuration);
    assert.ok(quick.walkPace / deliberate.walkPace < 1.2);
    assert.equal(modelBehaviorProfile('claude-haiku-4-5'), quick);
    assert.ok(Object.isFrozen(quick));
});

test('urgent and fatigued moods remain readable across model tiers', () => {
    const anxious = { type: Mood.ANXIOUS, intensity: 1 };
    const tired = { type: Mood.TIRED, intensity: 1 };
    const deliberate = MODEL_BEHAVIOR_PROFILES[ModelBehaviorTier.DELIBERATE];
    const quick = MODEL_BEHAVIOR_PROFILES[ModelBehaviorTier.QUICK];

    assert.ok(deliberate.walkPace * moodBehaviorMultiplier(anxious, 'walkPace') > 1);
    assert.ok(
        deliberate.fidgetInterval * moodBehaviorMultiplier(anxious, 'fidgetInterval')
        < MODEL_BEHAVIOR_PROFILES[ModelBehaviorTier.BALANCED].fidgetInterval,
    );
    assert.ok(quick.walkPace * moodBehaviorMultiplier(tired, 'walkPace') < deliberate.walkPace);
});

test('reduced motion keeps the complete static thinking glyph and allocates no fidget cadence', () => {
    const fillAlphas = [];
    const ctx = {
        fillStyle: '',
        globalAlpha: 1,
        beginPath() {},
        arc() {},
        fill() { fillAlphas.push(this.globalAlpha); },
    };
    const sprite = {
        motionScale: 0,
        statusAnim: 12,
        agent: { mood: { type: Mood.ANXIOUS, intensity: 1 } },
        _modelBehavior: MODEL_BEHAVIOR_PROFILES[ModelBehaviorTier.DELIBERATE],
    };

    AgentSprite.prototype._drawThinkingDotsGlyph.call(sprite, ctx, 12, '#fff');
    AgentSprite.prototype._advanceFidget.call(sprite, 16);

    assert.deepEqual(fillAlphas, [1, 1, 1]);
    assert.equal(sprite._fidgetCooldownMs, undefined);
    assert.equal(sprite._fidgetActiveMs, undefined);
});
