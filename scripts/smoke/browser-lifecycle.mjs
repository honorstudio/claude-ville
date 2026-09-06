#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const DEFAULT_URL = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';
const DEFAULT_SWITCH_COUNT = Number(process.env.CLAUDEVILLE_LIFECYCLE_SWITCHES) || 250;
const DEFAULT_TIMEOUT_MS = Number(process.env.CLAUDEVILLE_BROWSER_TIMEOUT_MS) || 30_000;
const OWNER_KEYS = [
  'world',
  'dataSource',
  'wsClient',
  'agentManager',
  'modeManager',
  'sessionWatcher',
  'notificationService',
  'topBar',
  'sidebar',
  'toast',
  'modal',
  'renderer',
  'dashboardRenderer',
  'activityPanel',
  'assets',
  'chronicleStore',
  'auroraGate',
  'biographyService',
  'moodService',
  'affinityService',
];
const STATIC_OWNER_TARGETS = new Set([
  '#activityPanel',
  '#agentList',
  '#btnModeCharacter',
  '#btnModeDashboard',
  '#modalClose',
  '#modalOverlay',
  '#panelClose',
  '#sidebarToggle',
  '#topbarCinemaToggle',
  '#topbarSoundMode',
  '#topbarSoundToggle',
  '#topbarSoundVolume',
  '#worldCanvas',
  'input.sidebar__filter-input',
  'span.topbar__version',
]);
const PERSISTENT_EVENT_BUS_LISTENERS = {
  'agent:deselected': 1,
  'agent:selected': 1,
};

function usage() {
  console.log(`Usage: node scripts/smoke/browser-lifecycle.mjs [options]

Options:
  --url=<url>       ClaudeVille URL (default: ${DEFAULT_URL})
  --count=<number>  Mode switches to run (default: ${DEFAULT_SWITCH_COUNT})
  --timeout=<ms>    Browser operation timeout (default: ${DEFAULT_TIMEOUT_MS})
  --headed          Show the Chromium window
  --help            Print this help

Environment equivalents: CLAUDEVILLE_URL, CLAUDEVILLE_LIFECYCLE_SWITCHES,
CLAUDEVILLE_BROWSER_TIMEOUT_MS.`);
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    count: DEFAULT_SWITCH_COUNT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headed: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--headed') {
      options.headed = true;
      continue;
    }
    const [flag, inlineValue] = arg.split('=', 2);
    if (!['--url', '--count', '--timeout'].includes(flag)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--url') options.url = value;
    if (flag === '--count') options.count = Number(value);
    if (flag === '--timeout') options.timeoutMs = Number(value);
  }
  if (!Number.isInteger(options.count) || options.count < 1) {
    throw new Error(`--count must be a positive integer, received ${options.count}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error(`--timeout must be at least 1000ms, received ${options.timeoutMs}`);
  }
  options.url = options.url.replace(/\/+$/, '');
  return options;
}

function listenerCounts(entries) {
  const counts = {};
  for (const entry of entries) {
    const key = `${entry.target}:${entry.type}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function ownerDomListeners(entries) {
  return entries.filter((entry) => {
    if (STATIC_OWNER_TARGETS.has(entry.target)) return true;
    if (entry.target === 'window') {
      if (entry.type === 'load' || entry.type.startsWith('__playwright_')) return false;
      return entry.capture === false;
    }
    if (entry.target === 'document') {
      return ['visibilitychange', 'pointerdown', 'keydown'].includes(entry.type);
    }
    return ['BroadcastChannel', 'MediaQueryList'].includes(entry.target);
  });
}

async function installListenerAudit(page) {
  await page.addInitScript(() => {
    const originalAdd = EventTarget.prototype.addEventListener;
    const originalRemove = EventTarget.prototype.removeEventListener;
    const targetIds = new WeakMap();
    const listenerIds = new WeakMap();
    const active = new Map();
    let nextTargetId = 1;
    let nextListenerId = 1;

    const idFor = (map, value, next) => {
      if (!map.has(value)) map.set(value, next());
      return map.get(value);
    };
    const captureFor = (options) => (
      typeof options === 'boolean' ? options : Boolean(options?.capture)
    );
    const keyFor = (target, type, listener, options) => {
      const targetId = idFor(targetIds, target, () => nextTargetId++);
      const listenerId = idFor(listenerIds, listener, () => nextListenerId++);
      return `${targetId}|${type}|${listenerId}|${captureFor(options) ? 1 : 0}`;
    };
    const labelFor = (target) => {
      if (target === window) return 'window';
      if (target === document) return 'document';
      if (target instanceof Element) {
        if (target.id) return `#${target.id}`;
        const classes = [...target.classList].slice(0, 2).join('.');
        return `${target.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`;
      }
      return target?.constructor?.name || 'EventTarget';
    };

    EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
      originalAdd.call(this, type, listener, options);
      if (!listener || (typeof listener !== 'function' && typeof listener !== 'object')) return;
      active.set(keyFor(this, type, listener, options), {
        target: this,
        type: String(type),
        capture: captureFor(options),
      });
    };
    EventTarget.prototype.removeEventListener = function removeEventListener(type, listener, options) {
      originalRemove.call(this, type, listener, options);
      if (!listener || (typeof listener !== 'function' && typeof listener !== 'object')) return;
      active.delete(keyFor(this, type, listener, options));
    };

    window.__cvLifecycleListenerAudit = {
      snapshot() {
        return [...active.values()]
          .map((entry) => ({
            target: labelFor(entry.target),
            type: entry.type,
            capture: entry.capture,
          }))
          .sort((a, b) => (
            a.target.localeCompare(b.target)
            || a.type.localeCompare(b.type)
            || Number(a.capture) - Number(b.capture)
          ));
      },
    };
  });
}

async function runtimeSnapshot(page) {
  return page.evaluate(async (ownerKeys) => {
    const { eventBus } = await import('/src/domain/events/DomainEvent.js');
    const app = window.__claudeVilleApp || window.__cvLifecycleRefs?.app || null;
    const perf = window.__claudeVillePerf || {};
    const canvasBudget = typeof perf.canvasBudget === 'function' ? perf.canvasBudget() : null;
    return {
      bootState: app?._bootState || null,
      destroyed: Boolean(app?._destroyed),
      mode: app?.modeManager?.getCurrentMode?.() || null,
      owners: Object.fromEntries(ownerKeys.map((key) => [key, app?.[key] != null])),
      eventBus: Object.fromEntries(
        [...eventBus.listeners.entries()]
          .map(([name, callbacks]) => [name, callbacks.size])
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
      domListeners: window.__cvLifecycleListenerAudit?.snapshot?.() || [],
      cards: {
        map: app?.dashboardRenderer?.cards?.size || 0,
        dom: document.querySelectorAll('.dash-card').length,
        sections: document.querySelectorAll('.dashboard__section').length,
        avatarCanvases: document.querySelectorAll('.dash-card canvas, .activity-panel canvas').length,
      },
      canvas: {
        width: document.getElementById('worldCanvas')?.width || 0,
        height: document.getElementById('worldCanvas')?.height || 0,
      },
      ui: {
        characterDisplay: document.getElementById('characterMode')?.style.display ?? null,
        dashboardDisplay: document.getElementById('dashboardMode')?.style.display ?? null,
        characterActive: document.getElementById('btnModeCharacter')?.classList.contains('topbar__mode-btn--active') || false,
        dashboardActive: document.getElementById('btnModeDashboard')?.classList.contains('topbar__mode-btn--active') || false,
        selectionEcho: document.body.hasAttribute('data-cv-selected'),
      },
      panel: {
        open: document.body.classList.contains('cv-panel-open'),
        display: document.getElementById('activityPanel')?.style.display ?? null,
      },
      perf: {
        keys: Object.keys(perf).sort(),
        hasCanvasBudget: typeof perf.canvasBudget === 'function',
        canvasBudget,
      },
      sessionDetails: window.__claudeVilleSessionDetails?.snapshot?.() || null,
      globals: {
        app: Boolean(window.__claudeVilleApp),
        chronicle: Boolean(window.__chronicle),
        cameraSet: typeof window.cameraSet === 'function',
      },
    };
  }, OWNER_KEYS);
}

async function runSessionWatcherProbe(page) {
  return page.evaluate(async () => {
    const [{ SessionWatcher }, { eventBus }] = await Promise.all([
      import('/src/application/SessionWatcher.js'),
      import('/src/domain/events/DomainEvent.js'),
    ]);
    const before = Object.fromEntries(
      [...eventBus.listeners.entries()].map(([name, callbacks]) => [name, callbacks.size]),
    );
    const deferred = [];
    const signals = [];
    const makeDeferred = (signal) => new Promise((resolve) => {
      signals.push(signal);
      deferred.push(resolve);
    });
    const agentManager = {
      messages: [],
      handleWebSocketMessage(message) { this.messages.push(message); },
    };
    const wsClient = {
      isConnected: false,
      connectCalls: 0,
      disconnectCalls: 0,
      connect() { this.connectCalls++; },
      disconnect() { this.disconnectCalls++; },
    };
    const dataSource = {
      getSessions({ signal } = {}) { return makeDeferred(signal); },
      getUsage({ signal } = {}) { return makeDeferred(signal); },
    };
    let usageEvents = 0;
    const onUsage = () => { usageEvents++; };
    eventBus.on('usage:updated', onUsage);

    const watcher = new SessionWatcher(agentManager, wsClient, dataSource);
    watcher.start();
    const firstPoll = watcher._pollPromise;
    const singleFlight = watcher._poll() === firstPoll;
    await Promise.resolve();
    watcher.stop();
    const abortedOnStop = signals.length === 2 && signals.every((signal) => signal?.aborted);
    deferred[0]?.([{ id: 'late-session' }]);
    deferred[1]?.({ totalInput: 1 });
    await firstPoll;
    eventBus.off('usage:updated', onUsage);

    const after = Object.fromEntries(
      [...eventBus.listeners.entries()].map(([name, callbacks]) => [name, callbacks.size]),
    );
    return {
      singleFlight,
      abortedOnStop,
      running: watcher.running,
      pollTimerCleared: watcher.pollTimer === null,
      pollControllerCleared: watcher._pollController === null,
      pollPromiseCleared: watcher._pollPromise === null,
      managerMessages: agentManager.messages.length,
      usageEvents,
      connectCalls: wsClient.connectCalls,
      disconnectCalls: wsClient.disconnectCalls,
      listenerCountsRestored: JSON.stringify(before) === JSON.stringify(after),
    };
  });
}

async function runSessionDetailsAbortProbe(page) {
  return page.evaluate(async () => {
    const { sessionDetailsService } = await import('/src/presentation/shared/SessionDetailsService.js');
    const originalFetch = window.fetch;
    const deferred = [];
    const makeResponse = detail => ({ ok: true, json: async () => detail });
    try {
      sessionDetailsService.clear();
      window.fetch = (input, init = {}) => new Promise(resolve => {
        deferred.push({ input: String(input), init, resolve });
      });

      const clearAgent = {
        id: '__delayed_detail__',
        provider: 'claude',
        projectPath: '/lifecycle/detail',
      };
      const pending = sessionDetailsService.fetchSessionDetail(clearAgent);
      await Promise.resolve();
      const before = sessionDetailsService.getDebugSnapshot();
      sessionDetailsService.clear();
      deferred.shift().resolve(makeResponse({ sessionId: clearAgent.id, marker: 'late-clear' }));
      await pending;
      await Promise.resolve();
      const afterClear = sessionDetailsService.getDebugSnapshot();

      const singleAgent = {
        id: '__deleted_single__',
        provider: 'claude',
        projectPath: '/lifecycle/single',
      };
      const oldSingle = sessionDetailsService.fetchSessionDetail(singleAgent);
      await Promise.resolve();
      const oldRequest = deferred.shift();
      sessionDetailsService.deleteForAgent(singleAgent);
      const newSingle = sessionDetailsService.fetchSessionDetail(singleAgent);
      await Promise.resolve();
      const newRequest = deferred.shift();
      newRequest.resolve(makeResponse({ sessionId: singleAgent.id, marker: 'new' }));
      await newSingle;
      oldRequest.resolve(makeResponse({ sessionId: singleAgent.id, marker: 'old' }));
      await oldSingle;
      await Promise.resolve();
      const singleState = sessionDetailsService.detailCacheState(singleAgent);

      sessionDetailsService.clear();
      const batchAgents = [
        { id: '__deleted_batch__', provider: 'claude', projectPath: '/lifecycle/batch' },
        { id: '__kept_batch__', provider: 'claude', projectPath: '/lifecycle/batch' },
      ];
      const batch = sessionDetailsService.fetchSessionDetailsBatch(batchAgents);
      await Promise.resolve();
      const batchRequest = deferred.shift();
      sessionDetailsService.deleteForAgent(batchAgents[0]);
      const keys = Object.fromEntries(batchAgents.map(agent => [
        sessionDetailsService.getSessionDetailKey(agent),
        { sessionId: agent.id, marker: agent.id },
      ]));
      batchRequest.resolve(makeResponse({ details: keys }));
      await batch;
      await Promise.resolve();

      return {
        before,
        afterClear,
        single: {
          oldAborted: Boolean(oldRequest.init.signal?.aborted),
          marker: singleState?.value?.marker || null,
          cacheEntries: sessionDetailsService.getDebugSnapshot().cacheEntries,
        },
        batch: {
          requestAborted: Boolean(batchRequest.init.signal?.aborted),
          deletedCached: sessionDetailsService.detailCacheState(batchAgents[0])?.hasEntry || false,
          keptCached: sessionDetailsService.detailCacheState(batchAgents[1])?.hasEntry || false,
          cacheEntries: sessionDetailsService.getDebugSnapshot().cacheEntries,
        },
      };
    } finally {
      window.fetch = originalFetch;
      sessionDetailsService.clear();
    }
  });
}

async function runAudioLifecycleProbe(page) {
  return page.evaluate(async () => {
    const { AmbientAudioController } = await import('/src/presentation/shared/AmbientAudioController.js');
    const previousDebug = window.__claudevilleAudio;
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

    const calls = { ensure: 0, start: 0, stop: 0, suspend: 0, dispose: 0, directorStart: 0 };
    let delayedResolve = null;
    let delayEnsure = false;
    const controller = new AmbientAudioController();
    controller.available = true;
    controller.engine = {
      context: { state: 'running' },
      setVolume() {},
      ensureContext() {
        calls.ensure++;
        if (!delayEnsure) return Promise.resolve(true);
        return new Promise(resolve => { delayedResolve = resolve; });
      },
      start() { calls.start++; },
      stop() { calls.stop++; },
      suspend() { calls.suspend++; return Promise.resolve(); },
      dispose() { calls.dispose++; return Promise.resolve(); },
      rms() { return 0; },
    };
    const director = {
      running: false,
      start() { this.running = true; calls.directorStart++; },
      stop() { this.running = false; },
      snapshot() { return {}; },
      cue() {},
    };
    controller.directors = { ambient: director, bgm: { ...director } };
    controller.enabled = true;
    controller.userActivated = true;

    try {
      await controller._activate();
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(resolve => setTimeout(resolve, 850));
      const suspendedWhileHidden = calls.suspend === 1 && controller.director.running === false;

      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
      const resumedOnce = calls.start === 2 && calls.directorStart === 2;

      delayEnsure = true;
      const pendingActivation = controller._activate();
      await Promise.resolve();
      const destroy = controller.destroy();
      delayedResolve(true);
      await Promise.all([pendingActivation, destroy]);
      return {
        suspendedWhileHidden,
        resumedOnce,
        noStartAfterDestroy: calls.start === 2 && calls.directorStart === 2,
        disposedOnce: calls.dispose === 1,
      };
    } finally {
      await controller.destroy();
      if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor);
      else delete document.hidden;
      if (previousDebug) window.__claudevilleAudio = previousDebug;
      else delete window.__claudevilleAudio;
    }
  });
}

async function runActualAudioLifecycleProbe(page) {
  const initial = await page.evaluate(() => window.__claudevilleAudio?.() || null);
  if (!initial?.available) return { available: false };
  if (!initial.enabled) await page.click('#topbarSoundToggle');
  await page.waitForFunction(() => {
    const audio = window.__claudevilleAudio?.();
    return audio?.contextState === 'running' && audio?.running === true;
  });
  const running = await page.evaluate(() => window.__claudevilleAudio?.() || null);

  await page.evaluate(() => {
    window.__cvOriginalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden') || null;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__claudevilleAudio?.()?.contextState === 'suspended', null, {
    timeout: 5000,
  });
  const hidden = await page.evaluate(() => window.__claudevilleAudio?.() || null);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => {
    const audio = window.__claudevilleAudio?.();
    return audio?.contextState === 'running' && audio?.running === true;
  });
  const visible = await page.evaluate(() => window.__claudevilleAudio?.() || null);
  await page.evaluate(() => {
    if (window.__cvOriginalHiddenDescriptor) {
      Object.defineProperty(document, 'hidden', window.__cvOriginalHiddenDescriptor);
    } else {
      delete document.hidden;
    }
    delete window.__cvOriginalHiddenDescriptor;
  });
  if (!initial.enabled) await page.click('#topbarSoundToggle');

  return {
    available: true,
    runningState: running.contextState,
    hiddenState: hidden.contextState,
    hiddenRunning: hidden.running,
    visibleState: visible.contextState,
    visibleRunning: visible.running,
  };
}

async function runFrameFailureProbe(page) {
  return page.evaluate(async () => {
    const { eventBus } = await import('/src/domain/events/DomainEvent.js');
    const renderer = window.__claudeVilleApp?.renderer;
    if (!renderer) throw new Error('frame failure probe requires the World renderer');

    const original = {
      update: renderer._update,
      render: renderer._render,
      reset: renderer._resetContextAfterFrameFailure,
      stats: renderer._frameFailureStats,
      running: renderer.running,
      worldModeActive: renderer._worldModeActive,
      contextLost: renderer._contextLost,
      requestAnimationFrame: window.requestAnimationFrame,
      consoleError: console.error,
    };
    const events = [];
    const onError = detail => events.push({ ...detail });
    eventBus.on('world:frame-error', onError);
    let scheduled = 0;
    let contextResets = 0;
    let updateCalls = 0;
    let renderCalls = 0;

    try {
      renderer._stopLoop();
      renderer.running = true;
      renderer._worldModeActive = true;
      renderer._contextLost = false;
      renderer._frameFailureStats = {
        total: 0,
        consecutive: 0,
        lastStage: null,
        lastMessage: null,
        lastAt: 0,
        lastReportedAt: -Infinity,
        byStage: {},
        paused: false,
      };
      window.requestAnimationFrame = () => {
        scheduled++;
        return 4242;
      };
      console.error = () => {};
      renderer._resetContextAfterFrameFailure = () => { contextResets++; };

      renderer._update = () => { updateCalls++; throw new Error('injected update failure'); };
      renderer._render = () => { renderCalls++; };
      renderer._loop();
      renderer._loop();
      renderer._loop();
      const updateTrip = {
        paused: renderer._frameFailureStats.paused,
        scheduled,
        lastEvent: events.at(-1) || null,
      };
      const updateRecovered = renderer.resumeAfterFrameFailure();

      renderer.frameId = null;
      renderer._frameFailureStats.lastReportedAt = -Infinity;
      renderer._update = () => { updateCalls++; };
      renderer._render = () => { renderCalls++; throw new Error('injected render failure'); };
      const scheduledBeforeRender = scheduled;
      renderer._loop();
      renderer._loop();
      renderer._loop();
      const renderTrip = {
        paused: renderer._frameFailureStats.paused,
        scheduled: scheduled - scheduledBeforeRender,
        lastEvent: events.at(-1) || null,
      };
      const renderRecovered = renderer.resumeAfterFrameFailure();

      return {
        updateTrip,
        renderTrip,
        updateRecovered,
        renderRecovered,
        updateCalls,
        renderCalls,
        contextResets,
      };
    } finally {
      eventBus.off('world:frame-error', onError);
      renderer._stopLoop();
      renderer._update = original.update;
      renderer._render = original.render;
      renderer._resetContextAfterFrameFailure = original.reset;
      renderer._frameFailureStats = original.stats;
      renderer.running = original.running;
      renderer._worldModeActive = original.worldModeActive;
      renderer._contextLost = original.contextLost;
      window.requestAnimationFrame = original.requestAnimationFrame;
      console.error = original.consoleError;
      renderer.frameId = null;
      if (renderer.running && renderer._worldModeActive && !renderer._contextLost) renderer._startLoop();
    }
  });
}

async function runContextRecoveryProbe(page) {
  return page.evaluate(async () => {
    const app = window.__claudeVilleApp;
    const renderer = app?.renderer;
    const canvas = document.getElementById('worldCanvas');
    if (!renderer || !canvas) throw new Error('context recovery probe requires the World canvas');
    const lostEvent = new Event('contextlost', { cancelable: true });
    canvas.dispatchEvent(lostEvent);
    const lost = {
      defaultPrevented: lostEvent.defaultPrevented,
      contextLost: renderer._contextLost,
      frameStopped: renderer.frameId === null,
      volatilePixels: renderer.getCanvasBudget().volatilePixels,
    };
    canvas.dispatchEvent(new Event('contextrestored'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      lost,
      restored: {
        contextLost: renderer._contextLost,
        contextReady: Boolean(renderer.ctx),
        framePending: renderer.frameId !== null,
        volatilePixels: renderer.getCanvasBudget().volatilePixels,
      },
    };
  });
}

async function primeInteractiveState(page) {
  await page.evaluate(async () => {
    const app = window.__claudeVilleApp;
    document.getElementById('btnModeDashboard')?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const firstAgent = app?.world?.agents?.values?.().next?.().value || null;
    if (firstAgent) app.activityPanel?.show?.(firstAgent);
    document.getElementById('btnModeCharacter')?.click();
  });
  await page.waitForTimeout(100);
}

async function switchModes(page, count) {
  return page.evaluate(async (switchCount) => {
    const app = window.__claudeVilleApp;
    const buttons = {
      character: document.getElementById('btnModeCharacter'),
      dashboard: document.getElementById('btnModeDashboard'),
    };
    let expected = app.modeManager.getCurrentMode();
    for (let index = 0; index < switchCount; index++) {
      expected = expected === 'character' ? 'dashboard' : 'character';
      buttons[expected].click();
      if (app.modeManager.getCurrentMode() !== expected) {
        throw new Error(`mode switch ${index + 1} did not enter ${expected}`);
      }
      if ((index + 1) % 25 === 0) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
    return app.modeManager.getCurrentMode();
  }, count);
}

async function prepareDestroyProbe(page) {
  return page.evaluate(async () => {
    const app = window.__claudeVilleApp;
    document.getElementById('btnModeDashboard')?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const dashboard = app.dashboardRenderer;
    let cards = [...dashboard.cards.values()];
    let syntheticCard = false;
    if (cards.length === 0) {
      const { Agent } = await import('/src/domain/entities/Agent.js');
      const agent = new Agent({
        id: '__browser_lifecycle_probe__',
        name: 'Lifecycle Probe',
        model: 'probe',
        provider: 'claude',
        projectPath: '/lifecycle/probe',
        status: 'idle',
      });
      const card = dashboard._createCard(agent);
      dashboard.cards.set(agent.id, card);
      dashboard.gridEl.appendChild(card);
      dashboard._observer?.observe?.(card);
      cards = [card];
      syntheticCard = true;
    }

    const activity = app.activityPanel;
    const avatars = cards.map((card) => card._avatarCanvas).filter(Boolean);
    if (activity?._heroAvatar) avatars.push(activity._heroAvatar);
    const avatarAudit = { expected: avatars.length, destroyed: 0 };
    for (const avatar of avatars) {
      const originalDestroy = avatar.destroy.bind(avatar);
      avatar.destroy = () => {
        avatarAudit.destroyed++;
        return originalDestroy();
      };
    }
    const { emitAgentSelected } = await import('/src/presentation/shared/AgentSelection.js');
    const selected = app.world?.agents?.values?.().next?.().value || {
      id: cards[0]?.dataset?.agentId || '__browser_lifecycle_probe__',
      name: 'Lifecycle Probe',
    };
    emitAgentSelected(selected);

    const clipboardOwnDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    let resolveClipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => new Promise(resolve => { resolveClipboard = resolve; }),
      },
    });
    const clipboardPromise = dashboard._copyAgentId(cards[0]?.dataset?.agentId || selected.id);
    await Promise.resolve();

    window.__cvLifecycleRefs = {
      app,
      assets: app.assets,
      dashboard,
      activity,
      sidebar: app.sidebar,
      renderer: app.renderer,
      trail: app.renderer?.trailRenderer || null,
      watcher: app.sessionWatcher,
      cards,
      activityNodes: [
        activity?._pinStripEl,
        activity?._journeySectionEl,
        activity?._harborLogSectionEl,
        activity?._chronicleSectionEl,
        activity?._directorFeedSectionEl,
        activity?._relationshipsSectionEl,
        activity?._messageEdgesSectionEl,
      ].filter(Boolean),
      filterWrap: app.sidebar?._filterWrapEl || null,
      clipboard: {
        ownDescriptor: clipboardOwnDescriptor,
        promise: clipboardPromise,
        resolve: resolveClipboard,
      },
      avatarAudit,
    };
    return {
      cards: cards.length,
      avatars: avatars.length,
      syntheticCard,
      selectionSet: document.body.hasAttribute('data-cv-selected'),
    };
  });
}

async function destroyAndInspect(page) {
  return page.evaluate(async (ownerKeys) => {
    const refs = window.__cvLifecycleRefs;
    const app = refs.app;
    const renderer = refs.renderer;
    const lateBiography = {
      identityKeys: [],
      nicknameSets: 0,
      pending: [],
      resolvers: [],
      generationBefore: renderer?._biographyReadGeneration ?? null,
    };
    if (renderer) {
      const syntheticAgent = {
        id: '__browser_lifecycle_late_biography__',
        name: 'Lifecycle Late Biography',
        provider: 'claude',
      };
      const syntheticSprite = {
        agent: syntheticAgent,
        setNickname: () => { lateBiography.nicknameSets++; },
      };
      const originalBiographyService = renderer.biographyService;
      renderer.biographyService = {
        getBiography(identityKey) {
          lateBiography.identityKeys.push(identityKey);
          const pending = new Promise(resolve => { lateBiography.resolvers.push(resolve); });
          lateBiography.pending.push(pending);
          return pending;
        },
      };
      renderer.agentSprites.set(syntheticAgent.id, syntheticSprite);
      renderer._primeNickname(syntheticSprite);
      renderer._chronicleChannelListener?.({
        data: {
          type: 'biography-updated',
          identityKey: 'villager:claude:lifecycle-late-channel',
        },
      });
      renderer.biographyService = originalBiographyService;
    }
    const first = app.destroy();
    const second = app.destroy();
    const identityWhileDestroying = first === second;
    await first;
    const identityAfterDestroy = app.destroy() === first;
    for (const resolve of lateBiography.resolvers) resolve({ nickname: 'the Late Arrival' });
    await Promise.allSettled(lateBiography.pending);
    await Promise.resolve();
    refs.clipboard?.resolve?.();
    await refs.clipboard?.promise;
    if (refs.clipboard?.ownDescriptor) {
      Object.defineProperty(navigator, 'clipboard', refs.clipboard.ownDescriptor);
    } else {
      delete navigator.clipboard;
    }
    const postDestroyBudget = refs.renderer?.getCanvasBudget?.() || null;
    const assetStats = refs.assets?.cacheStats?.() || null;
    return {
      identityWhileDestroying,
      identityAfterDestroy,
      bootState: app._bootState,
      destroyed: app._destroyed,
      ownersCleared: Object.fromEntries(ownerKeys.map((key) => [key, app[key] == null])),
      dashboard: {
        cards: refs.dashboard?.cards?.size ?? null,
        sections: refs.dashboard?._sectionEls?.size ?? null,
        pendingAvatars: refs.dashboard?._pendingAvatarDraws?.size ?? null,
        destroyed: refs.dashboard?._destroyed ?? null,
      },
      activity: {
        destroyed: refs.activity?._destroyed ?? null,
        panelRefCleared: refs.activity?.panelEl == null,
        heroRefCleared: refs.activity?._heroAvatar == null,
        ownedNodesDetached: refs.activityNodes.every((node) => !node.isConnected),
      },
      sidebar: {
        destroyed: refs.sidebar?._destroyed ?? null,
        filterDetached: !refs.filterWrap?.isConnected,
        workflowState: refs.sidebar?._seenWorkflows?.size ?? null,
        agentRows: document.getElementById('agentList')?.children?.length ?? null,
        harborRows: document.getElementById('harborList')?.children?.length ?? null,
      },
      lateClipboardToasts: document.getElementById('toastContainer')?.children?.length ?? null,
      lateBiography: {
        identityKeys: lateBiography.identityKeys,
        nicknameSets: lateBiography.nicknameSets,
        nicknameEntries: renderer?._nicknames?.size ?? null,
        generationAdvanced: renderer
          ? renderer._biographyReadGeneration > lateBiography.generationBefore
          : null,
      },
      watcher: {
        running: refs.watcher?.running ?? null,
        pollTimerCleared: refs.watcher?.pollTimer == null,
        pollControllerCleared: refs.watcher?._pollController == null,
      },
      trail: {
        disposed: refs.trail?._disposed ?? null,
        pending: refs.trail?.pending?.length ?? null,
        cacheReleased: refs.trail?.cache == null,
        unsubscribers: refs.trail?._unsubscribers?.length ?? null,
      },
      avatars: {
        ...refs.avatarAudit,
        cardsDetached: refs.cards.every((card) => !card.isConnected),
        cardAvatarRefsCleared: refs.cards.every((card) => card._avatarCanvas == null),
      },
      assetStats,
      postDestroyBudget,
    };
  }, OWNER_KEYS);
}

async function runBoundedCleanupProbe(page) {
  return page.evaluate(async () => {
    const { App } = await import('/src/presentation/App.js');
    const app = new App();
    const never = new Promise(() => {});
    const events = [];
    let settleCalls = 0;
    const settleLifecycleTasks = app._settleLifecycleTasks.bind(app);
    app._settleLifecycleTasks = (tasks) => {
      settleCalls++;
      return settleLifecycleTasks(tasks, 25);
    };
    app._bootState = 'ready';
    app.topBar = {
      destroy() {
        events.push('topbar:stop');
        return never;
      },
    };
    app.biographyService = {
      stop() {
        events.push('biography:stop');
        return never;
      },
    };
    app.affinityService = {
      stop() {
        events.push('affinity:stop');
        return never;
      },
    };
    app.renderer = {
      trailRenderer: {
        dispose() {
          events.push('trail:dispose');
          return never;
        },
      },
      pauseForVisibility() {
        events.push('renderer:pause');
      },
      drainChronicleUpdates() {
        events.push('renderer:drain');
        return never;
      },
      hide() {
        events.push('renderer:hide');
      },
    };
    app.assets = {
      dispose() {
        events.push('assets:dispose');
        return never;
      },
    };
    app.chronicleStore = {
      close() {
        events.push('store:close');
      },
    };
    app._chroniclePruneState.promise = never;
    app._chronicleTasks.add(never);

    const startedAt = performance.now();
    const first = app.destroy();
    const stablePromise = first === app.destroy();
    let escapeHandle = null;
    const result = await Promise.race([
      first.then(() => ({ resolved: true })),
      new Promise(resolve => {
        escapeHandle = window.setTimeout(() => resolve({ resolved: false }), 750);
      }),
    ]);
    if (escapeHandle !== null) window.clearTimeout(escapeHandle);
    return {
      ...result,
      stablePromise,
      state: app._bootState,
      elapsedMs: performance.now() - startedAt,
      settleCalls,
      events,
    };
  });
}

async function runAvatarFallbackCleanupProbe(page) {
  return page.evaluate(async () => {
    const [{ AvatarCanvas }, { Compositor }, { Agent }] = await Promise.all([
      import('/src/presentation/dashboard-mode/AvatarCanvas.js'),
      import('/src/presentation/character-mode/Compositor.js'),
      import('/src/domain/entities/Agent.js'),
    ]);
    const shared = Compositor._shared;
    const baseline = Compositor._sharedListeners.length;
    Compositor._shared = null;
    try {
      const avatar = new AvatarCanvas(new Agent({
        id: '__avatar_fallback_cleanup__',
        name: 'Fallback Avatar',
        provider: 'claude',
        model: 'claude',
        status: 'idle',
      }));
      const queued = Compositor._sharedListeners.length - baseline;
      avatar.destroy();
      return {
        queued,
        retainedAfterDestroy: Compositor._sharedListeners.length - baseline,
      };
    } finally {
      Compositor._shared = shared;
      Compositor._sharedListeners.splice(baseline);
    }
  });
}

async function runStoreDrainOrderingProbe(page) {
  return page.evaluate(async () => {
    const { App } = await import('/src/presentation/App.js');
    const app = new App();
    const events = [];
    let releaseChronicle;
    let releaseSpend;
    const chronicleDrain = new Promise(resolve => { releaseChronicle = resolve; });
    const spendDrain = new Promise(resolve => { releaseSpend = resolve; });
    app._bootState = 'ready';
    app.chronicleLog = {
      stop() {
        events.push('chronicle:stop');
        return chronicleDrain.then(() => events.push('chronicle:drained'));
      },
    };
    app.spendLedger = {
      stop() {
        events.push('spend:stop');
        return spendDrain.then(() => events.push('spend:drained'));
      },
    };
    app.chronicleStore = {
      close() {
        events.push('store:close');
      },
    };

    const destroy = app.destroy();
    await Promise.resolve();
    await Promise.resolve();
    const closedBeforeDrains = events.includes('store:close');
    releaseChronicle();
    await Promise.resolve();
    const closedAfterOneDrain = events.includes('store:close');
    releaseSpend();
    await destroy;
    return { closedBeforeDrains, closedAfterOneDrain, events };
  });
}

async function sameDocumentReboot(page) {
  const boot = await page.evaluate(async () => {
    const { App } = await import('/src/presentation/App.js');
    history.replaceState(null, '', location.pathname + location.search);
    const app = new App();
    window.__claudeVilleApp = app;
    const first = app.boot();
    const stablePromise = first === app.boot();
    await first;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { stablePromise, state: app._bootState };
  });
  const ready = await runtimeSnapshot(page);
  const destroy = await page.evaluate(async () => {
    const app = window.__claudeVilleApp;
    const first = app.destroy();
    const stablePromise = first === app.destroy();
    await first;
    return { stablePromise, state: app._bootState };
  });
  const afterDestroy = await runtimeSnapshot(page);
  return { boot, ready, destroy, afterDestroy };
}

async function runDestroyDuringBootProbe(page) {
  return page.evaluate(async (ownerKeys) => {
    const [{ App }, { eventBus }] = await Promise.all([
      import('/src/presentation/App.js'),
      import('/src/domain/events/DomainEvent.js'),
    ]);
    const originalFetch = window.fetch;
    let manifestStartedResolve;
    const manifestStarted = new Promise(resolve => { manifestStartedResolve = resolve; });
    const app = new App();
    window.__claudeVilleApp = app;
    window.fetch = (input, init = {}) => {
      const url = String(input);
      if (!url.includes('assets/sprites/manifest.yaml')) return originalFetch(input, init);
      manifestStartedResolve();
      return new Promise((resolve, reject) => {
        if (init.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    };
    try {
      const boot = app.boot();
      await Promise.race([
        manifestStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('manifest load did not start')), 5000)),
      ]);
      const destroy = app.destroy();
      const stableDestroyPromise = destroy === app.destroy();
      await Promise.all([boot, destroy]);
      return {
        stableDestroyPromise,
        state: app._bootState,
        destroyed: app._destroyed,
        ownersCleared: ownerKeys.every(key => app[key] == null),
        globalCleared: !window.__claudeVilleApp,
        eventBus: Object.fromEntries(
          [...eventBus.listeners.entries()]
            .map(([name, callbacks]) => [name, callbacks.size])
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
        domListeners: window.__cvLifecycleListenerAudit?.snapshot?.() || [],
      };
    } finally {
      window.fetch = originalFetch;
      await app.destroy();
    }
  }, OWNER_KEYS);
}

async function runBootFailureProbe(page) {
  return page.evaluate(async (ownerKeys) => {
    const [{ App }, { eventBus }] = await Promise.all([
      import('/src/presentation/App.js'),
      import('/src/domain/events/DomainEvent.js'),
    ]);
    const originalFetch = window.fetch;
    const app = new App();
    window.__claudeVilleApp = app;
    window.fetch = (input, init) => {
      const url = String(input);
      if (url.includes('assets/sprites/manifest.yaml')) {
        return Promise.resolve({ ok: false, status: 503, text: async () => '' });
      }
      return originalFetch(input, init);
    };
    try {
      await app.boot();
    } finally {
      window.fetch = originalFetch;
    }
    return {
      state: app._bootState,
      destroyed: app._destroyed,
      ownersCleared: ownerKeys.every(key => app[key] == null),
      globalCleared: !window.__claudeVilleApp,
      eventBus: Object.fromEntries(
        [...eventBus.listeners.entries()]
          .map(([name, callbacks]) => [name, callbacks.size])
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
      domListeners: window.__cvLifecycleListenerAudit?.snapshot?.() || [],
    };
  }, OWNER_KEYS);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browserErrors = [];
  const browser = await chromium.launch({ headless: !options.headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(options.timeoutMs);
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));

  try {
    await installListenerAudit(page);
    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.waitForFunction(() => {
      const state = window.__claudeVilleApp?._bootState;
      return state === 'ready' || state === 'failed';
    });
    const state = await page.evaluate(() => window.__claudeVilleApp?._bootState);
    assert.equal(state, 'ready', `app boot state was ${state}`);
    await page.waitForFunction(() => typeof window.__claudeVillePerf?.canvasBudget === 'function');

    const bootIdentity = await page.evaluate(() => {
      const app = window.__claudeVilleApp;
      return app.boot() === app.boot();
    });
    assert.equal(bootIdentity, true, 'boot() must return one stable promise');

    await primeInteractiveState(page);
    const watcherProbe = await runSessionWatcherProbe(page);
    assert.deepEqual(watcherProbe, {
      singleFlight: true,
      abortedOnStop: true,
      running: false,
      pollTimerCleared: true,
      pollControllerCleared: true,
      pollPromiseCleared: true,
      managerMessages: 0,
      usageEvents: 0,
      connectCalls: 1,
      disconnectCalls: 1,
      listenerCountsRestored: true,
    });
    const sessionDetailsProbe = await runSessionDetailsAbortProbe(page);
    assert.equal(sessionDetailsProbe.before.activeRequests, 1);
    assert.equal(sessionDetailsProbe.before.inFlightEntries, 1);
    assert.equal(sessionDetailsProbe.afterClear.activeRequests, 0);
    assert.equal(sessionDetailsProbe.afterClear.inFlightEntries, 0);
    assert.equal(sessionDetailsProbe.afterClear.cacheEntries, 0, 'late session detail repopulated the cleared cache');
    assert.equal(sessionDetailsProbe.single.oldAborted, true, 'per-agent deletion did not abort its request');
    assert.equal(sessionDetailsProbe.single.marker, 'new', 'older detail response overwrote the replacement request');
    assert.equal(sessionDetailsProbe.batch.requestAborted, false, 'deleting one batch member aborted unrelated detail work');
    assert.equal(sessionDetailsProbe.batch.deletedCached, false, 'deleted batch detail repopulated the cache');
    assert.equal(sessionDetailsProbe.batch.keptCached, true, 'unrelated batch detail was discarded');
    const actualAudioProbe = await runActualAudioLifecycleProbe(page);
    assert.deepEqual(actualAudioProbe, {
      available: true,
      runningState: 'running',
      hiddenState: 'suspended',
      hiddenRunning: false,
      visibleState: 'running',
      visibleRunning: true,
    });
    const audioProbe = await runAudioLifecycleProbe(page);
    assert.deepEqual(audioProbe, {
      suspendedWhileHidden: true,
      resumedOnce: true,
      noStartAfterDestroy: true,
      disposedOnce: true,
    });
    const frameProbe = await runFrameFailureProbe(page);
    assert.equal(frameProbe.updateTrip.paused, true);
    assert.equal(frameProbe.updateTrip.scheduled, 2, 'update trip scheduled another failing frame');
    assert.equal(frameProbe.updateTrip.lastEvent?.paused, true, 'update trip was rate-limited out of telemetry');
    assert.equal(frameProbe.updateTrip.lastEvent?.stage, 'update');
    assert.equal(frameProbe.updateRecovered, true);
    assert.equal(frameProbe.renderTrip.paused, true);
    assert.equal(frameProbe.renderTrip.scheduled, 2, 'render trip scheduled another failing frame');
    assert.equal(frameProbe.renderTrip.lastEvent?.paused, true, 'render trip was rate-limited out of telemetry');
    assert.equal(frameProbe.renderTrip.lastEvent?.stage, 'render');
    assert.equal(frameProbe.renderRecovered, true);
    assert.equal(frameProbe.contextResets, 3, 'render failures did not reset context state');
    const contextProbe = await runContextRecoveryProbe(page);
    assert.deepEqual(contextProbe.lost, {
      defaultPrevented: true,
      contextLost: true,
      frameStopped: true,
      volatilePixels: 0,
    });
    assert.equal(contextProbe.restored.contextLost, false);
    assert.equal(contextProbe.restored.contextReady, true);
    assert.equal(contextProbe.restored.framePending, true);
    assert.ok(contextProbe.restored.volatilePixels > 0, 'context restore did not rebuild volatile buffers');

    const before = await runtimeSnapshot(page);
    assert.equal(before.perf.hasCanvasBudget, true, '__claudeVillePerf.canvasBudget must be installed');
    assert.ok(before.perf.canvasBudget, 'canvas budget diagnostics must be available');
    assert.ok(before.perf.canvasBudget.visibleCanvasPixels > 0, 'world canvas must have a backing store');
    assert.ok(
      before.perf.canvasBudget.visibleCanvasPixels <= before.perf.canvasBudget.budgets.maxMainCanvasPixels,
      'world canvas exceeds its main-canvas budget',
    );
    assert.ok(before.perf.canvasBudget.cacheStats?.assets, 'asset cache diagnostics must be exposed');
    assert.ok(before.perf.canvasBudget.runtime, 'world lifecycle diagnostics must be exposed');

    const finalMode = await switchModes(page, options.count);
    const afterSwitches = await runtimeSnapshot(page);
    assert.deepEqual(afterSwitches.eventBus, before.eventBus, 'mode switches changed event-bus listener counts');
    assert.deepEqual(
      listenerCounts(ownerDomListeners(afterSwitches.domListeners)),
      listenerCounts(ownerDomListeners(before.domListeners)),
      'mode switches changed owner DOM listener counts',
    );
    assert.equal(afterSwitches.perf.hasCanvasBudget, true, 'mode switches removed canvas diagnostics');

    const avatarFallbackCleanup = await runAvatarFallbackCleanupProbe(page);
    assert.deepEqual(avatarFallbackCleanup, {
      queued: 1,
      retainedAfterDestroy: 0,
    }, 'destroyed fallback avatars remained queued for a future compositor');

    const destroyProbe = await prepareDestroyProbe(page);
    assert.ok(destroyProbe.cards > 0, 'destroy probe needs at least one dashboard card');
    assert.ok(destroyProbe.avatars > 0, 'destroy probe needs at least one avatar');
    assert.equal(destroyProbe.selectionSet, true, 'destroy probe did not prime selection echo');
    const destroyed = await destroyAndInspect(page);
    assert.equal(destroyed.identityWhileDestroying, true, 'destroy() promise changed while running');
    assert.equal(destroyed.identityAfterDestroy, true, 'destroy() promise changed after completion');
    assert.equal(destroyed.bootState, 'destroyed');
    assert.equal(destroyed.destroyed, true);
    assert.ok(Object.values(destroyed.ownersCleared).every(Boolean), 'one or more app owner references remain');
    assert.deepEqual(destroyed.dashboard, {
      cards: 0,
      sections: 0,
      pendingAvatars: 0,
      destroyed: true,
    });
    assert.deepEqual(destroyed.activity, {
      destroyed: true,
      panelRefCleared: true,
      heroRefCleared: true,
      ownedNodesDetached: true,
    });
    assert.deepEqual(destroyed.sidebar, {
      destroyed: true,
      filterDetached: true,
      workflowState: 0,
      agentRows: 0,
      harborRows: 0,
    });
    assert.equal(destroyed.lateClipboardToasts, 0, 'late clipboard completion created a toast after destroy');
    assert.deepEqual(destroyed.lateBiography, {
      identityKeys: [
        'villager:claude:lifecycle-late-biography',
        'villager:claude:lifecycle-late-channel',
      ],
      nicknameSets: 0,
      nicknameEntries: 0,
      generationAdvanced: true,
    }, 'late biography completion repopulated a retired renderer');
    assert.deepEqual(destroyed.watcher, {
      running: false,
      pollTimerCleared: true,
      pollControllerCleared: true,
    });
    assert.equal(destroyed.trail.disposed, true);
    assert.equal(destroyed.trail.pending, 0);
    assert.equal(destroyed.trail.cacheReleased, true);
    assert.equal(destroyed.trail.unsubscribers, 0);
    assert.equal(destroyed.avatars.destroyed, destroyed.avatars.expected);
    assert.equal(destroyed.avatars.cardsDetached, true);
    assert.equal(destroyed.avatars.cardAvatarRefsCleared, true);
    assert.ok(destroyed.assetStats, 'asset cache stats unavailable after destroy');
    assert.equal(destroyed.assetStats.bitmaps, 0);
    assert.equal(destroyed.assetStats.masks, 0);
    assert.equal(destroyed.assetStats.outlines, 0);
    assert.equal(destroyed.assetStats.missing, 0);
    assert.equal(destroyed.postDestroyBudget.volatilePixels, 0);
    assert.equal(destroyed.postDestroyBudget.retainedAssetPixels, 0);

    const afterDestroy = await runtimeSnapshot(page);
    assert.equal(afterDestroy.globals.app, false);
    assert.equal(afterDestroy.globals.chronicle, false);
    assert.equal(afterDestroy.globals.cameraSet, false);
    assert.equal(afterDestroy.perf.hasCanvasBudget, false, 'canvas diagnostics survived app teardown');
    assert.deepEqual(
      afterDestroy.eventBus,
      PERSISTENT_EVENT_BUS_LISTENERS,
      'app-owned event-bus listeners survived app teardown',
    );
    assert.deepEqual(ownerDomListeners(afterDestroy.domListeners), [], 'owner DOM listeners survived app teardown');
    assert.equal(afterDestroy.cards.dom, 0);
    assert.equal(afterDestroy.cards.sections, 0);
    assert.equal(afterDestroy.cards.avatarCanvases, 0);
    assert.equal(afterDestroy.panel.open, false);
    assert.equal(afterDestroy.canvas.width, 0);
    assert.equal(afterDestroy.canvas.height, 0);
    assert.equal(afterDestroy.ui.selectionEcho, false);
    assert.equal(browserErrors.length, 0, browserErrors.join('\n'));

    const storeDrainOrdering = await runStoreDrainOrderingProbe(page);
    assert.equal(storeDrainOrdering.closedBeforeDrains, false);
    assert.equal(storeDrainOrdering.closedAfterOneDrain, false);
    assert.deepEqual(storeDrainOrdering.events, [
      'chronicle:stop',
      'spend:stop',
      'chronicle:drained',
      'spend:drained',
      'store:close',
    ]);

    const boundedCleanup = await runBoundedCleanupProbe(page);
    assert.equal(boundedCleanup.resolved, true, 'never-settling cleanup blocked destroy()');
    assert.equal(boundedCleanup.stablePromise, true, 'bounded cleanup changed the destroy() promise');
    assert.equal(boundedCleanup.state, 'destroyed');
    assert.equal(boundedCleanup.settleCalls, 3);
    assert.ok(boundedCleanup.elapsedMs < 750, `bounded cleanup took ${boundedCleanup.elapsedMs}ms`);
    assert.deepEqual(boundedCleanup.events, [
      'topbar:stop',
      'biography:stop',
      'affinity:stop',
      'renderer:pause',
      'renderer:drain',
      'trail:dispose',
      'renderer:hide',
      'assets:dispose',
      'store:close',
    ], 'cleanup producers were not stopped before bounded waits and store close');

    const reboot = await sameDocumentReboot(page);
    assert.deepEqual(reboot.boot, { stablePromise: true, state: 'ready' });
    assert.equal(reboot.ready.mode, 'character');
    assert.equal(reboot.ready.ui.characterDisplay, '');
    assert.equal(reboot.ready.ui.dashboardDisplay, 'none');
    assert.equal(reboot.ready.ui.characterActive, true);
    assert.equal(reboot.ready.ui.dashboardActive, false);
    assert.equal(reboot.ready.ui.selectionEcho, false);
    assert.ok(reboot.ready.canvas.width > 0 && reboot.ready.canvas.height > 0, 'second mount did not restore canvas backing');
    assert.deepEqual(reboot.ready.eventBus, before.eventBus, 'second mount duplicated or omitted event-bus listeners');
    assert.deepEqual(
      listenerCounts(ownerDomListeners(reboot.ready.domListeners)),
      listenerCounts(ownerDomListeners(before.domListeners)),
      'second mount duplicated or omitted owner DOM listeners',
    );
    assert.deepEqual(reboot.destroy, { stablePromise: true, state: 'destroyed' });
    assert.deepEqual(reboot.afterDestroy.eventBus, PERSISTENT_EVENT_BUS_LISTENERS);
    assert.deepEqual(ownerDomListeners(reboot.afterDestroy.domListeners), []);
    assert.equal(reboot.afterDestroy.canvas.width, 0);
    assert.equal(reboot.afterDestroy.canvas.height, 0);
    assert.equal(reboot.afterDestroy.ui.selectionEcho, false);
    assert.equal(browserErrors.length, 0, browserErrors.join('\n'));

    const destroyDuringBoot = await runDestroyDuringBootProbe(page);
    assert.equal(destroyDuringBoot.stableDestroyPromise, true);
    assert.equal(destroyDuringBoot.state, 'destroyed');
    assert.equal(destroyDuringBoot.destroyed, true);
    assert.equal(destroyDuringBoot.ownersCleared, true);
    assert.equal(destroyDuringBoot.globalCleared, true);
    assert.deepEqual(destroyDuringBoot.eventBus, PERSISTENT_EVENT_BUS_LISTENERS);
    assert.deepEqual(ownerDomListeners(destroyDuringBoot.domListeners), []);
    assert.equal(browserErrors.length, 0, browserErrors.join('\n'));

    const errorsBeforeFailureProbe = browserErrors.length;
    const bootFailure = await runBootFailureProbe(page);
    assert.equal(bootFailure.state, 'failed');
    assert.equal(bootFailure.destroyed, true);
    assert.equal(bootFailure.ownersCleared, true);
    assert.equal(bootFailure.globalCleared, true);
    assert.deepEqual(bootFailure.eventBus, PERSISTENT_EVENT_BUS_LISTENERS);
    assert.deepEqual(ownerDomListeners(bootFailure.domListeners), []);
    const failureErrors = browserErrors.slice(errorsBeforeFailureProbe);
    assert.ok(failureErrors.some(message => message.includes('[App] boot failed')),
      'failure injection did not reach the App boot error boundary');
    assert.equal(
      failureErrors.every(message => message.includes('[App] boot failed')),
      true,
      failureErrors.join('\n'),
    );

    console.log(JSON.stringify({
      ok: true,
      url: options.url,
      switches: options.count,
      finalMode,
      cardsExercised: destroyProbe.cards,
      avatarsExercised: destroyProbe.avatars,
      usedSyntheticCard: destroyProbe.syntheticCard,
      listenerEventsBeforeDestroy: Object.keys(before.eventBus).length,
      canvas: {
        visiblePixels: before.perf.canvasBudget.visibleCanvasPixels,
        volatilePixels: before.perf.canvasBudget.volatilePixels,
        cacheCounts: before.perf.canvasBudget.cacheCounts,
      },
      sessionDetails: before.sessionDetails,
      sessionDetailsProbe,
      actualAudioProbe,
      audioProbe,
      frameProbe,
      contextProbe,
      avatarFallbackCleanup,
      storeDrainOrdering,
      boundedCleanup,
      reboot: { boot: reboot.boot, destroy: reboot.destroy },
      destroyDuringBoot: { state: destroyDuringBoot.state, ownersCleared: destroyDuringBoot.ownersCleared },
      bootFailure: { state: bootFailure.state, ownersCleared: bootFailure.ownersCleared },
      watcherProbe,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`[browser-lifecycle] FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
