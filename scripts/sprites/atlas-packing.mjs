export const DEFAULT_ATLAS_PAGE_SIZE = 2048;

export function packFrames(frames, {
    maxWidth = DEFAULT_ATLAS_PAGE_SIZE,
    maxHeight = DEFAULT_ATLAS_PAGE_SIZE,
    padding = 2,
    powerOfTwo = true,
} = {}) {
    const width = positiveInteger(maxWidth, DEFAULT_ATLAS_PAGE_SIZE);
    const height = positiveInteger(maxHeight, DEFAULT_ATLAS_PAGE_SIZE);
    const pad = nonNegativeInteger(padding, 2);
    const ordered = [...frames].sort((a, b) => (
        (b.h - a.h)
        || (b.w - a.w)
        || a.key.localeCompare(b.key)
    ));
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    let contentWidth = 0;
    for (const frame of ordered) {
        const outerW = frame.w + pad * 2;
        const outerH = frame.h + pad * 2;
        if (outerW > width) throw new Error(`${frame.key} is ${outerW}px wide with padding; atlas cap is ${width}`);
        if (x > 0 && x + outerW > width) {
            x = 0;
            y += rowHeight;
            rowHeight = 0;
        }
        frame.paddedRect = { x, y, w: outerW, h: outerH };
        frame.rect = { x: x + pad, y: y + pad, w: frame.w, h: frame.h };
        x += outerW;
        rowHeight = Math.max(rowHeight, outerH);
        contentWidth = Math.max(contentWidth, x);
    }
    const contentHeight = y + rowHeight;
    const pageWidth = powerOfTwo ? nextPowerOfTwo(Math.max(contentWidth, 1)) : Math.max(contentWidth, 1);
    const pageHeight = powerOfTwo ? nextPowerOfTwo(Math.max(contentHeight, 1)) : Math.max(contentHeight, 1);
    assertPageBudget({
        pageWidth,
        pageHeight,
        maxWidth: width,
        maxHeight: height,
        contentWidth,
        contentHeight,
        lastFrame: ordered.at(-1),
    });
    return {
        width: pageWidth,
        height: pageHeight,
        contentHeight,
        padding: pad,
        frames: ordered,
    };
}

export function stableJson(value) {
    return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function assertPageBudget({ pageWidth, pageHeight, maxWidth, maxHeight, contentWidth, contentHeight, lastFrame }) {
    if (pageWidth > maxWidth) {
        throw new Error(
            `atlas page width budget exceeded: ${pageWidth}px required `
            + `(packed content ${contentWidth}px), maximum is ${maxWidth}px `
            + `(${pageWidth - maxWidth}px over); reduce the atlas contents or raise maxWidth after reviewing texture memory`,
        );
    }
    if (pageHeight > maxHeight) {
        const frame = lastFrame?.key ? `; last packed frame: ${lastFrame.key}` : '';
        throw new Error(
            `atlas page height budget exceeded: ${pageHeight}px required `
            + `(packed content ${contentHeight}px), maximum is ${maxHeight}px `
            + `(${pageHeight - maxHeight}px over)${frame}; reduce atlas ids/frames or raise maxHeight after reviewing texture memory`,
        );
    }
}

function nextPowerOfTwo(value) {
    let result = 1;
    while (result < value) result *= 2;
    return result;
}
