#!/usr/bin/env node

/**
 * Playwright capture script for Codex equipment coherence validation.
 *
 * Loads the local ClaudeVille app, then renders controlled Codex AgentSprite
 * instances into a browser canvas for every Codex model, effort tier, and
 * direction. The app runtime does not currently expose camera/sprite forcing
 * hooks, so this script imports the same browser modules and uses their public
 * classes directly instead of mutating runtime app files.
 *
 * Usage:
 *   node scripts/sprites/capture-codex-equipment.mjs
 *   node scripts/sprites/capture-codex-equipment.mjs --base-url=http://localhost:4000
 *   node scripts/sprites/capture-codex-equipment.mjs --individual
 *   node scripts/sprites/capture-codex-equipment.mjs --model=gpt6astra --effort=medium --all-frames
 *   node scripts/sprites/capture-codex-equipment.mjs --effort=none --all-frames --verify-gpu
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const defaultOutDir = join(repoRoot, 'agents', 'research', 'codex-equipment-coherence', 'captures');

const args = new Map();
const flags = new Set();
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--') && arg.includes('=')) {
    const [key, ...rest] = arg.slice(2).split('=');
    args.set(key, rest.join('='));
  } else if (arg.startsWith('--')) {
    flags.add(arg.slice(2));
  }
}

const baseUrl = (args.get('base-url') || 'http://localhost:4000').replace(/\/+$/, '');
const outDir = args.get('out-dir') || defaultOutDir;
const captureIndividual = flags.has('individual');
const viewport = { width: 1440, height: 1000 };

const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  .filter(effort => !args.has('effort') || effort === args.get('effort'));
const POSES = flags.has('all-frames') ? [
  ...Array.from({ length: 4 }, (_, frame) => ({ key: `idle${frame}`, label: `idle ${frame}`, moving: false, motionScale: 0, frame })),
  ...Array.from({ length: 6 }, (_, frame) => ({ key: `walk${frame}`, label: `walk ${frame}`, moving: true, motionScale: 1, frame })),
] : [
  { key: 'idle0', label: 'idle 0', moving: false, motionScale: 0, frame: 0 },
  { key: 'walk0', label: 'walk 0', moving: true, motionScale: 1, frame: 0 },
  { key: 'walk3', label: 'walk 3', moving: true, motionScale: 1, frame: 3 },
];
const CODEX_MODELS = [
  { key: 'codex', label: 'Codex', model: 'codex' },
  { key: 'gpt56sol', label: 'GPT-5.6 Sol', model: 'gpt-5.6-sol' },
  { key: 'gpt56terra', label: 'GPT-5.6 Terra', model: 'gpt-5.6-terra' },
  { key: 'gpt56luna', label: 'GPT-5.6 Luna', model: 'gpt-5.6-luna' },
  {
    key: 'gpt6astra',
    label: 'GPT-6 Astra',
    model: 'gpt-6-astra',
  },
  {
    key: 'gpt53spark',
    label: 'GPT-5.3 Spark',
    model: 'gpt-5-3-codex-spark',
  },
  {
    key: 'gpt54',
    label: 'GPT-5.4',
    model: 'gpt-5.4',
  },
  {
    key: 'gpt55',
    label: 'GPT-5.5',
    model: 'gpt-5.5',
  },
].filter(model => !args.has('model') || model.key === args.get('model'));
if (!CODEX_MODELS.length || !EFFORTS.length) throw new Error('Unknown model or effort filter');
const REQUIRED_EQUIPMENT_ASSETS = [
  'equipment.codex.crescentSaber',
  'equipment.codex.dawnblade',
  'equipment.codex.earthbreaker',
  'equipment.codex.runeblade',
  'equipment.codex.greatsword',
  'equipment.codex.polearm',
  'equipment.codex.engineerWrench',
];
const REQUIRED_CHARACTER_ASSETS = [
  'agent.codex.base',
  'agent.codex.gpt56sol',
  'agent.codex.gpt56terra',
  'agent.codex.gpt56luna',
  'agent.codex.gpt6astra',
  'agent.codex.gpt53spark',
  'agent.codex.gpt54',
  'agent.codex.gpt55',
  'agent.codex.gpt55.high',
  'agent.codex.gpt55.xhigh',
];

await assertDevServer(baseUrl);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport,
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));

page.on('console', (msg) => {
  if (msg.type() === 'error') browserErrors.push(msg.text());
});

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  await page.waitForFunction(() => window.jsyaml && document.getElementById('worldCanvas'), null, { timeout: 10_000 });

  const setup = await page.evaluate(async ({ models, efforts, directions, poses, equipmentAssets, characterAssets }) => {
    const [
      { AssetManager },
      { Compositor },
      { AgentSprite },
      { Agent },
      { AgentStatus },
      { DIRECTIONS: runtimeDirections },
    ] = await Promise.all([
      import('/src/presentation/character-mode/AssetManager.js'),
      import('/src/presentation/character-mode/Compositor.js'),
      import('/src/presentation/character-mode/AgentSprite.js'),
      import('/src/domain/entities/Agent.js'),
      import('/src/domain/value-objects/AgentStatus.js'),
      import('/src/presentation/character-mode/SpriteSheet.js'),
    ]);

    const missingDirections = directions.filter((direction) => !runtimeDirections.includes(direction));
    if (missingDirections.length) {
      throw new Error(`Script directions do not match runtime SpriteSheet directions: ${missingDirections.join(', ')}`);
    }

    const canvas = document.createElement('canvas');
    canvas.id = 'codexEquipmentCapture';
    canvas.style.cssText = [
      'position: fixed',
      'left: 0',
      'top: 0',
      'z-index: 2147483647',
      'background: #14211f',
      'image-rendering: pixelated',
    ].join(';');
    document.body.appendChild(canvas);

    const assets = new AssetManager();
    await assets.load();
    const compositor = new Compositor(assets);
    const missingSprites = characterAssets.filter((id) => !assets.has(id));
    const missingEquipmentAssets = equipmentAssets.filter((id) => !assets.has(id));

    globalThis.drawBackground = (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#14211f';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#1f3530';
      for (let x = 0; x < width; x += 16) ctx.fillRect(x, 0, 1, height);
      for (let y = 0; y < height; y += 16) ctx.fillRect(0, y, width, 1);
    };

    globalThis.drawText = (ctx, text, x, y, color, font, align = 'left') => {
      ctx.save();
      ctx.font = font;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillText(text, x + 1, y + 1);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      ctx.restore();
    };

    globalThis.drawAgentCell = (capture, { model, effort, direction, pose, x, y, label = true }) => {
      const { Agent, AgentSprite, AgentStatus, assets, compositor, ctx, directions: captureDirections } = capture;
      const poseSpec = pose || poses[0];
      const agent = new Agent({
        id: `capture-${model.key}-${effort}-${direction}-${poseSpec.key}`,
        name: label ? `${model.key} ${effort} ${poseSpec.key}` : '',
        model: model.model,
        effort: effort === 'none' ? null : effort,
        provider: 'codex',
        status: AgentStatus.WORKING,
        currentTool: 'Edit',
      });
      const sprite = new AgentSprite(agent, { assets, compositor });
      sprite.setMotionScale(poseSpec.motionScale);
      sprite.x = x;
      sprite.y = y;
      sprite.targetX = x;
      sprite.targetY = y;
      sprite.direction = captureDirections.indexOf(direction);
      sprite.animState = poseSpec.moving ? 'walk' : 'idle';
      sprite.frame = poseSpec.frame;
      sprite.moving = poseSpec.moving;
      sprite.selected = false;
      sprite.nameTagSlot = null;
      sprite.labelAlpha = 0;
      sprite._drawNameTag = () => {};
      sprite._drawStatus = () => {};
      sprite._drawCompactNameStatus = () => {};
      sprite.draw(ctx, 2);
      sprite.releaseRenderResources();
    };

    window.__codexEquipmentCapture = {
      Agent,
      AgentSprite,
      AgentStatus,
      assets,
      compositor,
      canvas,
      ctx: canvas.getContext('2d'),
      models,
      efforts,
      directions,
      poses,
      runtimeDirections,
    };

    return {
      assetVersion: assets.assetVersion || null,
      missingSprites,
      missingEquipmentAssets,
    };
  }, { models: CODEX_MODELS, efforts: EFFORTS, directions: DIRECTIONS, poses: POSES, equipmentAssets: REQUIRED_EQUIPMENT_ASSETS, characterAssets: REQUIRED_CHARACTER_ASSETS });

  if (setup.missingSprites.length) {
    throw new Error(`Missing required Codex sprite assets: ${setup.missingSprites.join(', ')}`);
  }
  if (setup.missingEquipmentAssets.length) {
    throw new Error(`Missing required Codex equipment assets: ${setup.missingEquipmentAssets.join(', ')}`);
  }

  if (flags.has('verify-gpu')) {
    const verified = await verifyGpuFrames(page);
    console.log(`Canvas/GPU pixel parity passed: ${verified.cells} cells (${verified.rasterTies} with sampling ties)`);
  }

  for (const model of CODEX_MODELS) {
    await renderGrid(page, model);
    const gridPath = join(outDir, `${model.key}-equipment-grid.png`);
    await page.locator('#codexEquipmentCapture').screenshot({ path: gridPath });
    console.log(`captured ${gridPath}`);
  }

  await renderOverview(page);
  const overviewPath = join(outDir, 'codex-equipment-overview.png');
  await page.locator('#codexEquipmentCapture').screenshot({ path: overviewPath });
  console.log(`captured ${overviewPath}`);

  if (captureIndividual) {
    for (const model of CODEX_MODELS) {
      for (const effort of EFFORTS) {
        for (const direction of DIRECTIONS) {
          for (const pose of POSES) {
            await renderSingle(page, model, effort, direction, pose);
            const path = join(outDir, `${model.key}-${effort}-${direction}-${pose.key}.png`);
            await page.locator('#codexEquipmentCapture').screenshot({ path });
            console.log(`captured ${path}`);
          }
        }
      }
    }
  }

  const total = CODEX_MODELS.length * EFFORTS.length * DIRECTIONS.length * POSES.length;
  if (browserErrors.length) throw new Error(browserErrors.join('\n'));
  console.log(`Done. Captured ${total} forced Codex combinations into ${outDir}`);
  if (!captureIndividual) {
    console.log('Tip: pass --individual to also write one PNG per model/effort/direction combination.');
  }
} finally {
  await browser.close();
}

async function renderGrid(page, model) {
  await page.evaluate(({ model }) => {
    const capture = window.__codexEquipmentCapture;
    const { canvas, ctx, efforts, directions, poses } = capture;
    const labelW = 104;
    const topH = 34;
    const cellW = 144;
    const cellH = 148;
    const rowCount = efforts.length * poses.length;
    canvas.width = labelW + directions.length * cellW;
    canvas.height = topH + rowCount * cellH;
    drawBackground(ctx, canvas.width, canvas.height);
    drawText(ctx, model.label, 14, 18, '#dffcf2', 'bold 13px monospace', 'left');
    directions.forEach((direction, col) => {
      drawText(ctx, direction.toUpperCase(), labelW + col * cellW + cellW / 2, 21, '#9ff5d8', 'bold 12px monospace', 'center');
    });
    efforts.forEach((effort, effortIndex) => {
      poses.forEach((pose, poseIndex) => {
        const row = effortIndex * poses.length + poseIndex;
        drawText(ctx, effort.toUpperCase(), 14, topH + row * cellH + 23, '#f8e36f', 'bold 11px monospace', 'left');
        drawText(ctx, pose.label, 14, topH + row * cellH + 39, '#9ff5d8', '10px monospace', 'left');
        directions.forEach((direction, col) => {
          drawAgentCell(capture, {
            model,
            effort,
            direction,
            pose,
            x: labelW + col * cellW + cellW / 2,
            y: topH + row * cellH + 104,
          });
        });
      });
    });
  }, { model });
}

// Compare the baked GPU texture with the Canvas equipment/body composition at
// source scale. This catches missing frame metadata and front/back divergence.
async function verifyGpuFrames(page) {
  return page.evaluate(async () => {
    const { getModelVisualIdentity } = await import('/src/presentation/shared/ModelVisualIdentity.js');
    const { Agent, AgentSprite, assets, compositor, models, efforts, directions } = window.__codexEquipmentCapture;
    const scratch = document.createElement('canvas');
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    let cells = 0;
    let rasterTies = 0;
    for (const model of models) for (const effort of efforts) {
      const identity = getModelVisualIdentity(model.model, effort, 'codex');
      const agent = new Agent({ id: `gpu-${model.key}-${effort}`, model: model.model, effort, provider: 'codex' });
      const sprite = new AgentSprite(agent, { assets, compositor });
      sprite.setMotionScale(0);
      sprite.draw(ctx, 1);
      const baked = sprite._composeGpuEquippedSheet(identity);
      const padded = baked.width / directions.length;
      const cellSize = sprite.spriteSheet.cellSize;
      const pad = (padded - cellSize) / 2;
      const gpuCtx = baked.getContext('2d', { willReadFrequently: true });
      scratch.width = scratch.height = padded;
      ctx.imageSmoothingEnabled = false;
      for (let dir = 0; dir < directions.length; dir++) for (let row = 0; row < 10; row++) {
        const cell = sprite.spriteSheet.cell(row < 6 ? 'walk' : 'idle', dir, row < 6 ? row : row - 6);
        const geometry = { cell, dx: 0, dy: 0, drawScale: 1, bounds: sprite._getCellContentBounds(cell), cacheEquipment: false };
        ctx.clearRect(0, 0, padded, padded);
        ctx.save();
        ctx.translate(pad, pad);
        sprite._drawCodexEquipment(ctx, identity, geometry, 'back', directions[dir]);
        ctx.drawImage(sprite.spriteCanvas, cell.sx, cell.sy, cellSize, cellSize, 0, 0, cellSize, cellSize);
        sprite._drawCodexEquipment(ctx, identity, geometry, 'front', directions[dir]);
        ctx.restore();
        const expected = ctx.getImageData(0, 0, padded, padded).data;
        const actual = gpuCtx.getImageData(dir * padded, row * padded, padded, padded).data;
        // Translating the same rotated PNG can break a nearest-neighbor tie
        // at a source pixel boundary. Allow two pixels, plus channel rounding
        // on antialiased edges (6/255 for vector tools, 1/255 for PNGs).
        const channelTolerance = identity.equipment === 'multitool' ? 6 : 1;
        let differentPixels = 0;
        for (let index = 0; index < expected.length; index += 4) {
          if (Math.abs(expected[index] - actual[index]) > channelTolerance
            || Math.abs(expected[index + 1] - actual[index + 1]) > channelTolerance
            || Math.abs(expected[index + 2] - actual[index + 2]) > channelTolerance
            || Math.abs(expected[index + 3] - actual[index + 3]) > channelTolerance) differentPixels++;
        }
        if (differentPixels > 2) {
          throw new Error(`Canvas/GPU mismatch: ${model.key}/${effort}/${directions[dir]}/row${row} (${differentPixels} pixels)`);
        }
        if (differentPixels) rasterTies++;
        cells++;
      }
      baked.width = baked.height = 0;
      sprite.releaseRenderResources();
    }
    return { cells, rasterTies };
  });
}

async function renderOverview(page) {
  await page.evaluate(() => {
    const capture = window.__codexEquipmentCapture;
    const { canvas, ctx, models, efforts, directions, poses } = capture;
    const modelW = 384;
    const rowH = 120;
    const headerH = 38;
    const cellW = modelW / directions.length;
    const rowCount = efforts.length * poses.length;
    canvas.width = models.length * modelW;
    canvas.height = headerH + rowCount * rowH;
    drawBackground(ctx, canvas.width, canvas.height);
    models.forEach((model, modelIndex) => {
      const baseX = modelIndex * modelW;
      drawText(ctx, model.label, baseX + 14, 19, '#dffcf2', 'bold 13px monospace', 'left');
      directions.forEach((direction, col) => {
        drawText(ctx, direction.toUpperCase(), baseX + col * cellW + cellW / 2, 35, '#9ff5d8', 'bold 9px monospace', 'center');
      });
      efforts.forEach((effort, effortIndex) => {
        poses.forEach((pose, poseIndex) => {
          const row = effortIndex * poses.length + poseIndex;
          drawText(ctx, `${effort.toUpperCase()} ${pose.key}`, baseX + 8, headerH + row * rowH + 16, '#f8e36f', 'bold 8px monospace', 'left');
          directions.forEach((direction, col) => {
            drawAgentCell(capture, {
              model,
              effort,
              direction,
              pose,
              x: baseX + col * cellW + cellW / 2,
              y: headerH + row * rowH + 92,
              label: false,
            });
          });
        });
      });
    });
  });
}

async function renderSingle(page, model, effort, direction, pose) {
  await page.evaluate(({ model, effort, direction, pose }) => {
    const capture = window.__codexEquipmentCapture;
    const { canvas, ctx } = capture;
    canvas.width = 256;
    canvas.height = 224;
    drawBackground(ctx, canvas.width, canvas.height);
    drawText(ctx, `${model.label} / ${effort} / ${direction.toUpperCase()} / ${pose.key}`, 128, 22, '#dffcf2', 'bold 12px monospace', 'center');
    drawAgentCell(capture, { model, effort, direction, pose, x: 128, y: 166 });
  }, { model, effort, direction, pose });
}

async function assertDevServer(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'request timed out' : err.message;
    console.error(`Cannot reach ClaudeVille at ${url} (${reason}).`);
    console.error('Start the dev server in another terminal with: npm run dev');
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}
