// Authored pixel silhouettes. Coordinates are shared by Canvas stamps and DOM icons.
const motifs = {
    'weather-clear': ['00010000','01010100','00111000','11111110','00111000','01010100','00010000','00000000'],
    'weather-cloud': ['00000000','00111000','01111100','11111110','11111111','01111110','00000000','00000000'],
    'weather-rain': ['00111000','01111100','11111110','01111111','00000000','01010100','10101000','00000000'],
    'edit-strike': ['00010010','00100100','01001001','10010010','00100100','01001000','10010000','00100000'],
    'read-page': ['11100111','10011001','10111101','10011001','10111101','10011001','11111111','00011000'],
    'shell-slate': ['11111111','10000001','10100001','10010001','10100101','10000001','11111111','00000000'],
    'message-scroll': ['01111110','11000011','01011010','01000010','01011010','01000010','11000011','01111110'],
    'incident-bracket': ['11100111','10000001','10011001','00011000','00011000','10000001','10011001','11100111'],
    'child-return': ['00010000','00110000','01111110','11100010','01100110','00101100','00011000','00000000'],
    'release-crown': ['10011001','11011011','11111111','01111110','01000010','01111110','00000000','00111100'],
    'stale-seal': ['00111111','01000001','10011001','10010001','10011101','10000001','10000010','11111100'],
    'turn-sand': ['11111111','01000010','00100100','00011000','00011000','00111100','01111110','11111111'],
    'search-lens': ['00111100','01000010','10000001','10000001','01000010','00111110','00000110','00000011'],
    'task-slip': ['00011000','01111110','01000010','01011110','01000010','01011110','01000010','01111110'],
    'tool-unknown': ['00111100','01000010','00000010','00000100','00001000','00001000','00000000','00001000'],
    'district-command': ['01000000','01111110','01111100','01111110','01000000','01000000','01000000','11100000'],
    'district-taskboard': ['00111100','11100111','10000001','10101101','10000001','10101101','10000001','11111111'],
    'district-forge': ['00110000','01111000','00110000','00010000','01111110','11111111','00111100','01111110'],
    'district-mine': ['00011000','00111100','01111110','11011011','10011001','10011001','10000001','11111111'],
    'district-archive': ['00011000','00111100','11111111','01011010','01011010','01011010','11111111','11111111'],
    'district-observatory': ['00000110','00011111','01111110','11111000','01101000','00010000','00101000','01000100'],
    'district-portal': ['00111100','01100110','11000011','10011001','10100101','10011001','11000011','01100110'],
    'district-watchtower': ['00111100','00100100','01111110','01011010','01011010','01011010','11111111','10000001'],
    'district-harbor': ['00011000','00111100','00011000','10011001','10011001','11011011','01111110','00011000'],
    // 4.5 — working-set bench tile and the shared-file overlap marks: one
    // pencil for a read/write advisory, two crossed pencils for two writers.
    'file-tile': ['01111100','01000110','01000010','01011010','01000010','01011010','01000010','01111110'],
    'pencil-single': ['00000011','00000111','00001110','00011100','00111000','01110000','11100000','01000000'],
    'pencil-double': ['10000001','11000011','01100110','00111100','00111100','01100110','11000011','10000001'],
};
export const EVENT_SHAPES = Object.freeze(Object.fromEntries(Object.entries(motifs).map(([id, rows]) => [
    id, Object.freeze(['0000000000000000', '0000000000000000', '0000000000000000', '0000000000000000',
        ...rows.map(row => `0000${row}0000`),
        '0000000000000000', '0000000000000000', '0000000000000000', '0000000000000000']),
])));
const runs = Object.fromEntries(Object.entries(EVENT_SHAPES).map(([id, rows]) => {
    const rects = [];
    rows.forEach((row, y) => {
        for (let x = 0; x < 16; x++) {
            if (row[x] !== '1') continue;
            const start = x;
            while (x + 1 < 16 && row[x + 1] === '1') x++;
            rects.push([start, y, x - start + 1]);
        }
    });
    return [id, rects];
}));
const paths = Object.fromEntries(Object.entries(runs).map(([id, rects]) => [id,
    rects.map(([x, y, width]) => `M${x} ${y}h${width}v1h-${width}Z`).join(''),
]));
// DOM icons fill their box: the drawn extent, not the padded 16×16 grid.
const viewBoxes = Object.fromEntries(Object.entries(runs).map(([id, rects]) => {
    if (!rects.length) return [id, '0 0 16 16'];
    const minX = Math.min(...rects.map(([x]) => x));
    const maxX = Math.max(...rects.map(([x, , width]) => x + width));
    const minY = rects[0][1];
    const maxY = rects[rects.length - 1][1] + 1;
    return [id, `${minX} ${minY} ${maxX - minX} ${maxY - minY}`];
}));
export function drawEventShape(ctx, id, x, y, scale = 1, color = 'currentColor') {
    const rects = runs[id];
    if (!rects) return;
    const step = Math.max(1, Math.round(scale));
    const left = Math.round(x);
    const top = Math.round(y);
    ctx.fillStyle = color;
    for (const [rx, ry, width] of rects) ctx.fillRect(left + rx * step, top + ry * step, width * step, step);
}
export function eventShapeSvgPath(id) {
    return paths[id] || '';
}
export function eventShapeSvgViewBox(id) {
    return viewBoxes[id] || '0 0 16 16';
}
