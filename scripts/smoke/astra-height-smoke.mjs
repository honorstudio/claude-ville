#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`${baseUrl}/astra-height-probe`, route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
    await page.goto(`${baseUrl}/astra-height-probe`);
    const result = await page.evaluate(async () => {
        const { GpuWorldRenderer } = await import('/src/presentation/character-mode/gpu/GpuWorldRenderer.js');
        const source = (color) => {
            const c = document.createElement('canvas'); c.width = c.height = 1;
            c.getContext('2d').fillStyle = color; c.getContext('2d').fillRect(0, 0, 1, 1); return c;
        };
        const albedo = source('#555555');
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 64;
        document.body.append(canvas);
        const renderer = new GpuWorldRenderer(canvas);
        const camera = { x: 0, y: 0, zoom: 1, _dpr: () => 1 };
        const feed = { lighting: { ambientLight: 0, beaconIntensity: 1 }, reducedMotion: true,
            lights: [{ id: 'probe', x: 144, y: 32, radius: 180, intensity: 2, r: 255, g: 210, b: 150 }] };
        const sample = (wallHeight, strength = 255, defaultHeight = .82) => {
            const wall = source(`rgb(${wallHeight},${strength},0)`);
            const receiver = source('rgb(230,255,0)');
            renderer.qualityLadder.reset(0);
            const ok = renderer.render({ camera, feed, records: [
                { id: 'receiver', source: albedo, occluderSource: receiver, sidecarKey: 'receiver', x: 0, y: 0, width: 32, height: 64, elevation: .9, occluder: 1 },
                { id: 'wall', source: albedo, occluderSource: wall, sidecarKey: 'wall', x: 48, y: 0, width: 80, height: 64, elevation: defaultHeight, occluder: defaultHeight ? .86 : 0 },
            ] });
            const gl = renderer.gl;
            const pixel = new Uint8Array(4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.occlusionTarget.framebuffer);
            gl.readPixels(30, 12, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            const geometry = [...pixel];
            gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.sceneTarget.framebuffer);
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
            gl.readPixels(16, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            return { ok, geometry, receiver: [...pixel], error: gl.getError() };
        };
        const low = sample(26);
        const zero = sample(0);
        const tall = sample(230);
        const weak = sample(230, 64);
        const upward = sample(230, 255, 0);
        const materialSample = (opaque) => {
            const material = source(opaque ? 'rgb(0,0,0)' : 'rgba(0,0,0,0)');
            renderer.qualityLadder.reset(0);
            renderer.render({ camera, feed: { lighting: { ambientLight: 1 }, reducedMotion: true }, records: [
                { id: 'material', source: albedo, materialSource: material, material: 3,
                    width: 160, height: 64, x: 0, y: 0 },
            ] });
            const gl = renderer.gl;
            const pixel = new Uint8Array(4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.sceneTarget.framebuffer);
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
            gl.readPixels(80, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            return [...pixel];
        };
        const authoredUnlit = materialSample(true);
        const fallbackMetal = materialSample(false);
        renderer.dispose();
        return { low, zero, tall, weak, upward, authoredUnlit, fallbackMetal };
    });
    assert.deepEqual(errors, []);
    for (const frame of [result.low, result.zero, result.tall, result.weak, result.upward]) { assert.equal(frame.ok, true); assert.equal(frame.error, 0); }
    assert.ok(Math.abs(result.low.geometry[0] - 26) <= 1, JSON.stringify(result));
    assert.equal(result.zero.geometry[0], 0);
    assert.ok(result.tall.geometry[0] > 220);
    assert.deepEqual(result.upward.geometry, result.tall.geometry);
    assert.deepEqual(result.upward.receiver, result.tall.receiver);
    assert.ok(result.weak.geometry[3] < 70);
    assert.ok(result.low.receiver[0] > result.tall.receiver[0] + 5, JSON.stringify(result));
    assert.ok(result.weak.receiver[0] > result.tall.receiver[0], JSON.stringify(result));
    assert.ok(result.authoredUnlit[0] < result.fallbackMetal[0] - 5, JSON.stringify(result));
    console.log(JSON.stringify(result));
} finally { await browser.close(); }
