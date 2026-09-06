// Token-conformance smoke (visual-quality plan 1.4). The status ramps forked
// twice between theme.js (JS authority) and reset.css (CSS fallback), so this
// script fails validate:quick if:
//   1. reset.css no longer defines every --cv-status-* at its authority or
//      declared CSS fallback color (or STATUS_CSS_VARS drifts from the
//      STATUS_VISUALS keys);
//   2. another CSS file re-defines a --cv-status-* literal;
//   3. a new private status hex table appears in src/ outside the allowlist;
//   4. anything but the App.js boot bridge touches --cv-status-* from JS.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATUS_VISUALS, STATUS_CSS_VARS } from '../../claudeville/src/config/theme.js';

const SCRIPT_NAME = 'theme-tokens.mjs';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RESET_CSS = path.join(REPO_ROOT, 'claudeville/css/reset.css');
const LAYOUT_CSS = path.join(REPO_ROOT, 'claudeville/css/layout.css');
const TOPBAR_CSS = path.join(REPO_ROOT, 'claudeville/css/topbar.css');
const CSS_DIR = path.join(REPO_ROOT, 'claudeville/css');
const SRC_DIR = path.join(REPO_ROOT, 'claudeville/src');

const CONTRAST_BASE = '#0d0a0c';
const RAW_TAILWIND_HEXES = Object.freeze([
    '#ef4444', '#facc15', '#eab308', '#60a5fa',
    '#a78bfa', '#34d399', '#f59e0b', '#c084fc',
]);

// CSS retains the house-ramp fallback values for these two status colors. The
// JS status authority is still checked for every other status below; when its
// owning palette changes, these overrides can be removed in the same commit.
const CSS_STATUS_FALLBACK_OVERRIDES = Object.freeze({
    errored: '#e06c5b',
    waiting_on_user: '#e8d44d',
});

const EXPECTED_HOUSE_TOKENS = Object.freeze({
    '--cv-tool-read': '#7eb7d6',
    '--cv-tool-write': '#d8843a',
    '--cv-tool-exec': '#e06c5b',
    '--cv-tool-search': '#b79ae6',
    '--cv-tool-task': '#72d071',
    '--cv-purple': '#b79ae6',
    '--cv-warn-yellow': '#e8d44d',
});

const EXPECTED_LAYOUT_TOKENS = Object.freeze({
    '--cv-dash-detail': '#a08a68',
});

const DASHBOARD_TEXT_TOKEN_NAMES = Object.freeze([
    '--cv-dash-amber',
    '--cv-dash-gilt',
    '--cv-dash-tan-warm',
    '--cv-dash-tool-name',
    '--cv-dash-error-text',
]);

const CONTRAST_TOKEN_NAMES = Object.freeze([
    ...Object.values(STATUS_CSS_VARS),
    '--cv-tool-read',
    '--cv-tool-write',
    '--cv-tool-exec',
    '--cv-tool-search',
    '--cv-tool-task',
    '--cv-tool-other',
    '--cv-green-soft',
    '--cv-blue-soft',
    '--cv-purple',
    '--cv-warn-yellow',
    '--cv-amber-deep',
    '--cv-gold',
    '--cv-gold-deep',
    '--cv-gold-bright',
    '--cv-gold-warm',
    '--cv-gold-soft',
    '--cv-yellow',
    '--cv-tan',
    '--cv-text-muted',
    '--cv-text-gray',
]);

// Files allowed to mention status tokens literally. Everything else must
// consume STATUS_VISUALS (JS) or var(--cv-status-*) (CSS).
const HEX_TABLE_ALLOWLIST = new Set([
    path.join(REPO_ROOT, 'claudeville/src/config/theme.js'),
]);
const CSS_DEFINITION_ALLOWLIST = new Set([
    path.join(REPO_ROOT, 'claudeville/css/reset.css'),
]);
const JS_VAR_TOUCH_ALLOWLIST = new Set([
    path.join(REPO_ROOT, 'claudeville/src/config/theme.js'),    // STATUS_CSS_VARS names
    path.join(REPO_ROOT, 'claudeville/src/presentation/App.js'), // boot bridge
]);

let failed = false;

function pass(message) {
    console.log(`  PASS ${message}`);
}

function fail(message, err) {
    failed = true;
    console.log(`  FAIL ${message}${err ? `: ${err.message || err}` : ''}`);
}

function check(label, fn) {
    try {
        fn();
        pass(label);
    } catch (err) {
        fail(label, err);
    }
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

const normalizeHex = (value) => String(value || '').trim().toLowerCase();

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readCustomProperty(css, name) {
    const pattern = new RegExp(`${escapeRegExp(name)}\\s*:\\s*([^;]+);`);
    const match = css.match(pattern);
    assert.ok(match, `${name} is not defined`);
    return match[1].trim();
}

function readRuleDeclaration(css, selector, declaration) {
    const declarationPattern = new RegExp(
        `(?:^|\\s)${escapeRegExp(declaration)}\\s*:\\s*([^;]+);`,
    );
    const rulePattern = new RegExp(
        `${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`,
        'g',
    );
    for (const ruleMatch of css.matchAll(rulePattern)) {
        const declarationMatch = ruleMatch[1].match(declarationPattern);
        if (declarationMatch) return declarationMatch[1].trim();
    }
    assert.fail(`${selector} has no ${declaration} declaration`);
}

function parseColor(value) {
    const normalized = String(value || '').trim().toLowerCase();
    const hex = normalized.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
        const digits = hex[1];
        assert.ok([3, 4, 6, 8].includes(digits.length), `unsupported hex color '${value}'`);
        const expanded = digits.length <= 4
            ? [...digits].map((digit) => `${digit}${digit}`).join('')
            : digits;
        const channels = [
            Number.parseInt(expanded.slice(0, 2), 16),
            Number.parseInt(expanded.slice(2, 4), 16),
            Number.parseInt(expanded.slice(4, 6), 16),
        ];
        const alphaDigits = expanded.length === 8 ? expanded.slice(6, 8) : 'ff';
        return {
            r: channels[0] / 255,
            g: channels[1] / 255,
            b: channels[2] / 255,
            a: Number.parseInt(alphaDigits, 16) / 255,
        };
    }

    const functional = normalized.match(/^rgba?\((.*)\)$/i);
    if (!functional) throw new Error(`unsupported color '${value}'`);
    const parts = functional[1].split(',').map((part) => part.trim());
    assert.ok(parts.length === 3 || parts.length === 4, `invalid color '${value}'`);
    const channels = parts.slice(0, 3).map((part) => {
        const number = part.endsWith('%')
            ? Number.parseFloat(part) * 2.55
            : Number.parseFloat(part);
        assert.ok(Number.isFinite(number), `invalid color channel '${part}'`);
        return Math.max(0, Math.min(255, number)) / 255;
    });
    const alpha = parts.length === 4 ? Number.parseFloat(parts[3]) : 1;
    assert.ok(Number.isFinite(alpha), `invalid color alpha '${parts[3]}'`);
    return { r: channels[0], g: channels[1], b: channels[2], a: Math.max(0, Math.min(1, alpha)) };
}

function blendOver(foreground, background) {
    const alpha = foreground.a ?? 1;
    return {
        r: foreground.r * alpha + background.r * (1 - alpha),
        g: foreground.g * alpha + background.g * (1 - alpha),
        b: foreground.b * alpha + background.b * (1 - alpha),
        a: 1,
    };
}

function linearize(channel) {
    return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color) {
    return 0.2126 * linearize(color.r)
        + 0.7152 * linearize(color.g)
        + 0.0722 * linearize(color.b);
}

function contrastRatio(foreground, background) {
    const foregroundLuminance = relativeLuminance(foreground);
    const backgroundLuminance = relativeLuminance(background);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
        / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function assertContrast(label, foreground, background) {
    const effectiveForeground = blendOver(foreground, background);
    const ratio = contrastRatio(effectiveForeground, background);
    assert.ok(ratio >= 4.5, `${label} is ${ratio.toFixed(2)}:1`);
}

function readSurfaceTokens(resetCss) {
    const base = parseColor(CONTRAST_BASE);
    return {
        base,
        'surface-1': blendOver(parseColor(readCustomProperty(resetCss, '--cv-surface-1')), base),
        'surface-2': blendOver(parseColor(readCustomProperty(resetCss, '--cv-surface-2')), base),
        'surface-3': blendOver(parseColor(readCustomProperty(resetCss, '--cv-surface-3')), base),
        panel: blendOver(parseColor(readCustomProperty(resetCss, '--cv-panel')), base),
    };
}

function run() {
    const resetCss = fs.readFileSync(RESET_CSS, 'utf8');
    const layoutCss = fs.readFileSync(LAYOUT_CSS, 'utf8');
    const topbarCss = fs.readFileSync(TOPBAR_CSS, 'utf8');

    check('STATUS_CSS_VARS covers exactly the STATUS_VISUALS keys', () => {
        assert.deepEqual(
            Object.keys(STATUS_CSS_VARS).sort(),
            Object.keys(STATUS_VISUALS).sort(),
        );
    });

    // reset.css defines each --cv-status-* at the JS authority color, except
    // for the two house-ramp fallback overrides declared above.
    for (const [status, visual] of Object.entries(STATUS_VISUALS)) {
        const varName = STATUS_CSS_VARS[status] || '(unmapped)';
        const override = CSS_STATUS_FALLBACK_OVERRIDES[status];
        const expectedLabel = override
            ? `CSS house-ramp fallback for ${status}`
            : `STATUS_VISUALS.${status}.color`;
        check(`reset.css ${varName} == ${expectedLabel}`, () => {
            assert.ok(STATUS_CSS_VARS[status], `STATUS_CSS_VARS is missing '${status}'`);
            const pattern = new RegExp(`${varName.replace(/-/g, '\\-')}\\s*:\\s*([^;]+);`);
            const match = resetCss.match(pattern);
            assert.ok(match, `${varName} is not defined in reset.css`);
            const expected = override || visual.color;
            assert.equal(normalizeHex(match[1]), normalizeHex(expected));
        });
    }

    check('reset.css contains no raw Tailwind status/tool colors', () => {
        const css = resetCss.toLowerCase();
        const offenders = RAW_TAILWIND_HEXES.filter((hex) => css.includes(hex));
        assert.deepEqual(offenders, []);
    });

    for (const [token, expected] of Object.entries(EXPECTED_HOUSE_TOKENS)) {
        check(`reset.css ${token} uses the house-ramp color`, () => {
            assert.equal(normalizeHex(readCustomProperty(resetCss, token)), expected);
        });
    }

    for (const [token, expected] of Object.entries(EXPECTED_LAYOUT_TOKENS)) {
        check(`layout.css ${token} uses the dashboard detail color`, () => {
            assert.equal(normalizeHex(readCustomProperty(layoutCss, token)), expected);
        });
    }

    const surfaces = readSurfaceTokens(resetCss);
    check('dark text tokens meet 4.5:1 on every declared dark surface', () => {
        for (const token of CONTRAST_TOKEN_NAMES) {
            const color = parseColor(readCustomProperty(resetCss, token));
            for (const [surface, background] of Object.entries(surfaces)) {
                assertContrast(`${token} on ${surface}`, color, background);
            }
        }
    });

    check('--cv-dash-detail meets 4.5:1 on dashboard surfaces', () => {
        const detail = parseColor(readCustomProperty(layoutCss, '--cv-dash-detail'));
        for (const surface of ['surface-1', 'surface-2']) {
            assertContrast(`--cv-dash-detail on ${surface}`, detail, surfaces[surface]);
        }
    });

    check('dashboard text tokens meet 4.5:1 on every declared dark surface', () => {
        for (const token of DASHBOARD_TEXT_TOKEN_NAMES) {
            const color = parseColor(readCustomProperty(layoutCss, token));
            for (const [surface, background] of Object.entries(surfaces)) {
                assertContrast(`${token} on ${surface}`, color, background);
            }
        }
    });

    // The upper stop is the brightest recurring topbar backdrop and the tag
    // stop is the brightest ledger backdrop. Both are pre-blended over the
    // same #0d0a0c base used by the palette review.
    const topbarSurfaces = {
        topbar: blendOver(parseColor('rgba(58, 36, 22, 0.99)'), surfaces.base),
        tag: blendOver(parseColor('rgba(66, 43, 25, 0.96)'), surfaces.base),
    };
    check('topbar text declarations meet 4.5:1 and muted alpha is 0.9', () => {
        const selectors = [
            '.topbar__sound-btn',
            '.topbar__cinema-btn',
            '.topbar__seg-stat--muted .topbar__stat-value',
            '.topbar__uptime',
            '.topbar__stat-rate',
            '.topbar__mode-btn',
        ];
        for (const selector of selectors) {
            const color = parseColor(readRuleDeclaration(topbarCss, selector, 'color'));
            for (const [surface, background] of Object.entries(topbarSurfaces)) {
                assertContrast(`${selector} on ${surface}`, color, background);
            }
            if (selector === '.topbar__uptime' || selector === '.topbar__stat-rate') {
                assert.equal(color.a, 0.9, `${selector} alpha should be 0.9`);
            }
        }
    });

    // No other CSS file may re-define a --cv-status-* literal (consumption via
    // var(--cv-status-*) is fine — that is the point of the tokens).
    const cssDefinition = /--cv-status-[a-z-]+\s*:\s*(?!var\()[^;]+;/i;
    for (const file of walk(CSS_DIR).filter((f) => f.endsWith('.css'))) {
        if (CSS_DEFINITION_ALLOWLIST.has(file)) continue;
        check(`${path.relative(REPO_ROOT, file)} does not re-define --cv-status-*`, () => {
            const text = fs.readFileSync(file, 'utf8');
            const offenders = text.split('\n').filter((line) => cssDefinition.test(line));
            assert.deepEqual(offenders, []);
        });
    }

    // No private status-keyed hex tables in src/ outside the allowlist, e.g.
    // `working: '#4ade80'` or `rate_limited: '#f59e0b'`.
    const statusHex = /['"]?(?:working|idle|waiting|errored|rate_limited|rateLimited|waiting_on_user|waitingOnUser|completed|chatting)['"]?\s*:\s*['"]#[0-9a-fA-F]{3,8}\b/;
    for (const file of walk(SRC_DIR).filter((f) => f.endsWith('.js'))) {
        if (HEX_TABLE_ALLOWLIST.has(file)) continue;
        check(`${path.relative(REPO_ROOT, file)} has no private status hex table`, () => {
            const text = fs.readFileSync(file, 'utf8');
            const offenders = text.split('\n').filter((line) => statusHex.test(line));
            assert.deepEqual(offenders, []);
        });
    }

    // Only the boot bridge may setProperty --cv-status-* at runtime (reading
    // via var(--cv-status-*) in inline styles is fine — that is the point).
    const setStatusVar = /setProperty\(\s*['"]--cv-status-/;
    for (const file of walk(SRC_DIR).filter((f) => f.endsWith('.js'))) {
        if (JS_VAR_TOUCH_ALLOWLIST.has(file)) continue;
        check(`${path.relative(REPO_ROOT, file)} does not re-stamp --cv-status-*`, () => {
            const text = fs.readFileSync(file, 'utf8');
            const offenders = text.split('\n').filter((line) => setStatusVar.test(line));
            assert.deepEqual(offenders, []);
        });
    }
}

try {
    run();
} catch (err) {
    fail('uncaught failure in smoke', err);
}

if (failed) {
    console.log(`[${SCRIPT_NAME}] FAIL`);
    process.exit(1);
}
console.log(`[${SCRIPT_NAME}] PASS`);
