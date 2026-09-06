#!/usr/bin/env node

import assert from 'node:assert/strict';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

const proto = IsometricRenderer.prototype;

function renderer(annotationMode = 'compact', occupancy = 0) {
  const instance = Object.create(proto);
  instance.camera = { zoom: 1 };
  instance._annotationMode = annotationMode;
  instance._overlayBubbleOrder = [];
  instance._overlayBubbleBaseRects = [];
  instance._overlayBubbleClusters = [];
  instance._overlayBubbleClusterCount = 0;
  instance._overlayBubbleGroups = new Map();
  instance._overlayBubbleOccupiedRects = [];
  instance._overlayBubbleGrid = proto._createRectGrid.call(instance);
  instance._overlayClusterGrid = proto._createRectGrid.call(instance);
  const forge = { type: 'forge' };
  instance.buildingRenderer = {
    buildings: [forge],
    _buildingOccupancyInfo: () => ({ count: occupancy }),
  };
  return instance;
}

function sprite({ id, x, y, status = AgentStatus.WORKING, text = 'Working', selected = false }) {
  return {
    x,
    y,
    selected,
    hovered: false,
    addedAt: -60000,
    overlaySlot: 0,
    nameTagSlot: 0,
    labelAlpha: 1,
    foldedIntoBuilding: false,
    _foldBuildingType: 'forge',
    _activitySnapshot: { text, accent: '#f2d36b', confidence: 1 },
    agent: {
      id,
      name: id,
      status,
      activityAgeMs: 60000,
    },
    _shouldUseLongWaitClock: () => false,
    _statusVisual: () => ({ color: '#f2d36b' }),
  };
}

function cloneSprites(sprites) {
  return sprites.map((item) => sprite({
    id: item.agent.id,
    x: item.x,
    y: item.y,
    status: item.agent.status,
    text: item._activitySnapshot.text,
    selected: item.selected,
  }));
}

function snapshot(sprites) {
  return sprites.map((item) => ({
    id: item.agent.id,
    bubbleSlot: item.bubbleSlot,
    bubbleSuppressed: item.bubbleSuppressed,
    bubbleMergedCount: item.bubbleMergedCount,
    bubbleMergedInto: item.bubbleMergedInto?.agent?.id || null,
    foldedIntoBuilding: item.foldedIntoBuilding,
  }));
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const rand = random(0x37f5);
const statuses = [AgentStatus.WORKING, AgentStatus.IDLE, AgentStatus.WAITING];
const lines = ['Working', 'Reading', 'Testing', 'Waiting'];

for (let layout = 0; layout < 200; layout++) {
  const count = 1 + Math.floor(rand() * 80);
  const source = Array.from({ length: count }, (_, index) => sprite({
    id: `layout-${layout}-agent-${index}`,
    x: Math.round(rand() * 900),
    y: Math.round(rand() * 600),
    status: statuses[Math.floor(rand() * statuses.length)],
    text: lines[Math.floor(rand() * lines.length)],
    selected: rand() < 0.025,
  }));
  const linearSprites = cloneSprites(source);
  const gridSprites = cloneSprites(source);
  const linear = renderer('compact', count);
  const grid = renderer('compact', count);
  proto._assignAgentBubbleSlots.call(linear, linearSprites, 1, [], false);
  proto._assignAgentBubbleSlots.call(grid, gridSprites, 1, [], null);
  assert.deepEqual(snapshot(gridSprites), snapshot(linearSprites), `layout ${layout} diverged`);
}

const primaryStatuses = [
  AgentStatus.WAITING_ON_USER,
  AgentStatus.ERRORED,
  AgentStatus.RATE_LIMITED,
];
const dense = Array.from({ length: 24 }, (_, index) => sprite({
  id: `dense-${index}`,
  x: 400 + (index % 3),
  y: 300 + (index % 2),
  status: index < primaryStatuses.length ? primaryStatuses[index] : AgentStatus.WORKING,
  text: `Activity ${index}`,
}));
const denseRenderer = renderer('compact', dense.length);
proto._assignAgentBubbleSlots.call(denseRenderer, dense, 1, [], false);

const visibleNames = dense.filter((item) => !item.foldedIntoBuilding && item.labelAlpha > 0);
assert.ok(visibleNames.length <= 6, `dense cluster retained ${visibleNames.length} name pills`);
for (const status of primaryStatuses) {
  const primary = dense.find((item) => item.agent.status === status);
  assert.equal(primary?.foldedIntoBuilding, false, `${status} name was folded`);
  assert.equal(primary?.labelAlpha, 1, `${status} name was hidden`);
}
assert.ok(dense.some((item) => item.foldedIntoBuilding), 'dense cluster did not fold routine names');

console.log('overlay layout smoke: 200 randomized layouts and dense fold assertion passed');
