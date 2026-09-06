import { TEAM_HUES } from '../../config/theme.js';

// The categorical team ramp lives in the theme.js House Palette as TEAM_HUES
// (plan 1.11); this module only derives glow/panel tones and the stable hash
// assignment.

function stableHash(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function hexToRgb(hex) {
    const normalized = String(hex || '').replace('#', '');
    const value = Number.parseInt(normalized, 16);
    if (!Number.isFinite(value)) return { r: 139, g: 139, b: 158 };
    return {
        r: (value >> 16) & 255,
        g: (value >> 8) & 255,
        b: value & 255,
    };
}

export function getTeamColor(teamName) {
    const key = String(teamName || '').trim();
    if (!key) {
        return {
            accent: '#8b8b9e',
            glow: 'rgba(139, 139, 158, 0.30)',
            panel: 'rgba(34, 34, 46, 0.90)',
        };
    }
    const accent = TEAM_HUES[stableHash(key) % TEAM_HUES.length];
    const { r, g, b } = hexToRgb(accent);
    return {
        accent,
        glow: `rgba(${r}, ${g}, ${b}, 0.34)`,
        panel: `rgba(${Math.round(r * 0.22)}, ${Math.round(g * 0.22)}, ${Math.round(b * 0.22)}, 0.90)`,
    };
}

export function shortTeamName(teamName) {
    const text = String(teamName || '').trim();
    if (!text) return '';
    if (text === 'default') return text;
    return /^[0-9a-f-]{32,}$/i.test(text) ? text.slice(0, 6) : text;
}
