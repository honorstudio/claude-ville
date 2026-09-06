import assert from 'node:assert/strict';

// This is the browser-facing session contract consumed by AgentManager and by
// WebSocketClient's snapshot cloning. "nullable" means the key is mandatory,
// but its value may be null; "optional" is reserved for legacy/provider aliases.
export const SESSION_FIELD_CONTRACT = Object.freeze([
  { key: 'sessionId', requirement: 'required', types: ['string'] },
  { key: 'agentId', requirement: 'nullable', types: ['string'] },
  { key: 'subagentKind', requirement: 'nullable', types: ['string'] },
  { key: 'name', requirement: 'optional', types: ['string'], nullable: true },
  { key: 'agentName', requirement: 'nullable', types: ['string'] },
  { key: 'nickname', requirement: 'optional', types: ['string'], nullable: true },
  { key: 'agentType', requirement: 'required', types: ['string'] },
  { key: 'parentSessionId', requirement: 'nullable', types: ['string'] },
  { key: 'workflowId', requirement: 'nullable', types: ['string'] },
  { key: 'workflowName', requirement: 'nullable', types: ['string'] },
  { key: 'model', requirement: 'required', types: ['string'] },
  { key: 'reasoningEffort', requirement: 'nullable', types: ['string'] },
  { key: 'effort', requirement: 'optional', types: ['string'], nullable: true },
  { key: 'status', requirement: 'required', types: ['string'] },
  { key: 'teamName', requirement: 'optional', types: ['string'], nullable: true },
  { key: 'tokenUsage', requirement: 'nullable', types: ['object'] },
  { key: 'tokens', requirement: 'optional', types: ['object'], nullable: true },
  { key: 'usage', requirement: 'optional', types: ['object'], nullable: true },
  { key: 'estimatedCost', requirement: 'nullable', types: ['number'] },
  { key: 'cost', requirement: 'required', types: ['object'] },
  { key: 'taskProgress', requirement: 'nullable', types: ['object'] },
  { key: 'tasks', requirement: 'required', types: ['array'], maxLength: 12 },
  { key: 'lastPrompt', requirement: 'optional', types: ['string'], nullable: true },
  { key: 'todos', requirement: 'optional', types: ['array'], maxLength: 64, todoItems: true },
  { key: 'gitBranch', requirement: 'optional', types: ['string'], nullable: true },
  {
    key: 'lastToolInput',
    requirement: 'nullable',
    types: ['string', 'number', 'boolean', 'object', 'array'],
  },
  { key: 'lastTool', requirement: 'nullable', types: ['string'] },
  { key: 'gitEvents', requirement: 'required', types: ['array'], wireReferences: true },
  { key: 'permissionMode', requirement: 'nullable', types: ['string'] },
  { key: 'turnState', requirement: 'required', types: ['string'] },
  { key: 'pendingTool', requirement: 'nullable', types: ['string'] },
  { key: 'pendingSince', requirement: 'nullable', types: ['number'] },
  { key: 'waitReason', requirement: 'nullable', types: ['string'] },
  { key: 'awaitingSince', requirement: 'nullable', types: ['number'] },
  { key: 'turnStartedAt', requirement: 'nullable', types: ['number'] },
  { key: 'lastTurnDurationMs', requirement: 'nullable', types: ['number'] },
  { key: 'freshness', requirement: 'required', types: ['object'] },
  { key: 'signalCertainty', requirement: 'required', types: ['string'] },
  { key: 'signalObservedAt', requirement: 'nullable', types: ['number'] },
  { key: 'signalSource', requirement: 'required', types: ['string'] },
  { key: 'workingSet', requirement: 'required', types: ['array'], maxLength: 16 },
  { key: 'resident', requirement: 'required', types: ['boolean'] },
  { key: 'sendMessages', requirement: 'required', types: ['array'] },
  { key: 'lastActivity', requirement: 'required', types: ['number'] },
  { key: 'lastMessage', requirement: 'nullable', types: ['string'] },
  { key: 'dialogue', requirement: 'nullable', types: ['object'] },
  { key: 'observedSources', requirement: 'required', types: ['object'] },
  { key: 'project', requirement: 'nullable', types: ['string'] },
  { key: 'provider', requirement: 'required', types: ['string'] },
]);

function jsType(value) {
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function assertSessionContract(session, label = 'session') {
  assert.ok(session && typeof session === 'object' && !Array.isArray(session), `${label} must be an object`);

  for (const field of SESSION_FIELD_CONTRACT) {
    const fieldLabel = `${label}.${field.key}`;
    const present = Object.prototype.hasOwnProperty.call(session, field.key);
    if (field.requirement !== 'optional') {
      assert.ok(present, `${fieldLabel} is required`);
    }
    if (!present) continue;

    const value = session[field.key];
    const nullable = field.requirement === 'nullable' || field.nullable === true;
    if (value === null) {
      assert.ok(nullable, `${fieldLabel} must not be null`);
      continue;
    }

    const actualType = jsType(value);
    assert.ok(
      field.types.includes(actualType),
      `${fieldLabel} must be ${field.types.join(' or ')}, received ${actualType}`,
    );
    if (actualType === 'number') {
      assert.ok(Number.isFinite(value), `${fieldLabel} must be finite`);
    }
    if (field.maxLength !== undefined) {
      assert.ok(value.length <= field.maxLength, `${fieldLabel} must contain at most ${field.maxLength} items`);
    }
    if (field.todoItems) {
      for (const [index, todo] of value.entries()) {
        const itemLabel = `${fieldLabel}[${index}]`;
        assert.deepEqual(
          Object.keys(todo || {}).sort(),
          ['phase', 'status', 'subject'],
          `${itemLabel} must use the canonical todo shape`,
        );
        assert.ok(
          typeof todo.subject === 'string' && todo.subject.length <= 200,
          `${itemLabel}.subject must be a string of at most 200 characters`,
        );
        assert.ok(
          ['pending', 'in_progress', 'completed'].includes(todo.status),
          `${itemLabel}.status must be canonical`,
        );
        assert.ok(
          todo.phase === null || (typeof todo.phase === 'string' && todo.phase.length <= 80),
          `${itemLabel}.phase must be null or a string of at most 80 characters`,
        );
      }
    }
    if (field.wireReferences) {
      for (const [index, reference] of value.entries()) {
        assert.ok(
          (typeof reference === 'string' && reference.length > 0 && reference.length <= 128)
            || (Number.isInteger(reference) && reference >= 0),
          `${fieldLabel}[${index}] must be a bounded string or non-negative integer reference`,
        );
      }
    }
  }
}

// Independent successful scans have distinct observation times; content and
// freshness state still must agree across HTTP, full snapshots, and deltas.
export function stableSessionObservation(session) {
  assert.ok(Number.isFinite(session.freshness?.observedAt));
  assert.ok(Number.isFinite(session.freshness?.ageMs) && session.freshness.ageMs >= 0);
  return { ...session, freshness: { ...session.freshness, observedAt: 0, ageMs: 0 } };
}
