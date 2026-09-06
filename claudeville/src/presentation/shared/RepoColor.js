// Canonical per-repo and per-branch hash-keyed color profiles.
// Both the harbor (canvas, ship markers) and the sidebar (DOM, project groups)
// must agree on the color for a given repo path.

const GOLDEN_ANGLE = 137.508;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
}

function hslColor(hue, saturation, lightness) {
    return `hsl(${Math.round(hue)}, ${Math.round(saturation)}%, ${Math.round(lightness)}%)`;
}

function hslaColor(hue, saturation, lightness, alpha) {
    return `hsla(${Math.round(hue)}, ${Math.round(saturation)}%, ${Math.round(lightness)}%, ${alpha})`;
}

function readableAccentLightness(hue, baseLightness) {
    const normalizedHue = positiveModulo(hue, 360);
    const blueViolet = normalizedHue >= 205 && normalizedHue <= 285;
    const redOrange = normalizedHue <= 32 || normalizedHue >= 345;
    if (blueViolet) return clamp(baseLightness + 8, 72, 80);
    if (redOrange) return clamp(baseLightness + 4, 68, 76);
    return clamp(baseLightness, 66, 76);
}

function colorProfileFromHash(hash, options = {}) {
    const offset = Number(options.hueOffset) || 0;
    const hue = positiveModulo((hash % 360) + ((hash >> 7) % 29) * GOLDEN_ANGLE + offset, 360);
    const saturation = clamp(70 + (hash % 16), 66, 86);
    const lightness = readableAccentLightness(hue, 66 + ((hash >> 4) % 8));
    const labelLightness = readableAccentLightness(hue, lightness + 5);
    return {
        hue,
        saturation,
        lightness,
        accent: hslColor(hue, saturation, lightness),
        labelText: hslColor(hue, clamp(saturation - 6, 64, 82), labelLightness),
        glow: hslaColor(hue, saturation, lightness, 0.38),
        panel: hslaColor(hue, clamp(saturation - 34, 30, 46), 11, 0.94),
        panelBorder: hslaColor(hue, clamp(saturation - 4, 64, 84), lightness, 0.96),
    };
}

function branchColorProfile(baseProfile, branchHash) {
    const direction = branchHash % 2 === 0 ? 1 : -1;
    const shift = 18 + (branchHash % 28);
    const hue = positiveModulo((baseProfile.hue || 0) + direction * shift, 360);
    const saturation = clamp((baseProfile.saturation || 74) + ((branchHash >> 5) % 9) - 3, 64, 86);
    const lightness = readableAccentLightness(hue, (baseProfile.lightness || 68) + ((branchHash >> 9) % 7) - 3);
    const labelLightness = readableAccentLightness(hue, lightness + 5);
    return {
        hue,
        saturation,
        lightness,
        accent: hslColor(hue, saturation, lightness),
        labelText: hslColor(hue, clamp(saturation - 6, 64, 82), labelLightness),
        glow: hslaColor(hue, saturation, lightness, 0.4),
        panel: hslaColor(hue, clamp(saturation - 34, 30, 48), 11, 0.95),
        panelBorder: hslaColor(hue, clamp(saturation - 4, 64, 84), lightness, 0.98),
    };
}

function stableHash(input) {
    const text = String(input || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function shorten(value, maxChars) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function projectName(project) {
    const text = String(project || 'unknown').trim();
    const parts = text.split(/[\\/]/).filter(Boolean);
    return shorten(parts.at(-1) || text || 'unknown', 26);
}

export function normalizeRepoBranch(branch) {
    const text = String(branch || '')
        .replace(/^refs\/heads\//, '')
        .replace(/^refs\/remotes\/[^/]+\//, '')
        .trim();
    if (!text || text === 'HEAD' || text === 'unknown') return '';
    return text;
}

export function repoProfile(project) {
    const name = projectName(project);
    const hash = stableHash(String(project || name || 'unknown'));
    const colors = colorProfileFromHash(hash);
    return {
        key: `${name.toLowerCase()}:${hash.toString(36)}`,
        name,
        shortName: shorten(name, 16),
        hash,
        ...colors,
    };
}

export function repoBranchProfile(project, branch) {
    const normalizedBranch = normalizeRepoBranch(branch);
    const base = repoProfile(project);
    if (!normalizedBranch) return base;

    const branchHash = stableHash(`${base.key}:${normalizedBranch}`);
    const colors = branchColorProfile(base, branchHash);
    const branchName = shorten(normalizedBranch, 18);
    return {
        ...base,
        key: `${base.key}@${branchHash.toString(36)}`,
        branch: normalizedBranch,
        branchName,
        fullName: `${base.name}/${branchName}`,
        shortName: `${base.shortName}/${shorten(normalizedBranch, 10)}`,
        branchHash,
        baseAccent: base.accent,
        baseGlow: base.glow,
        basePanel: base.panel,
        isBranchVariant: true,
        ...colors,
    };
}
