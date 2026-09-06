// Wrist centers authored against Astra's 92px cells: six walk frames, then
// four idle frames. Keep these in sheet coordinates so capes and effort crests
// cannot move the grip. Follow the same hand around the body; E/NE hide the
// far forearm behind the torso instead of switching to the nearer hand.
const WRISTS = {
    s:  [[58,55], [58,54], [58,56], [58,57], [58,57], [58,55], [58,57], [58,55], [58,57], [58,57]],
    se: [[56,52], [56,52], [56,53], [56,54], [60,55], [60,52], [56,53], [56,52], [56,54], [56,54]],
    e:  [[48,58], [51,58], [50,59], [46,61], [42,61], [42,60], [48,58], [48,58], [48,59], [48,60]],
    ne: [[37,53], [37,54], [37,54], [37,55], [37,54], [37,53], [37,54], [37,53], [37,55], [37,55]],
    n:  [[33,54], [33,55], [33,55], [33,56], [33,53], [33,52], [33,54], [33,53], [33,55], [33,55]],
    nw: [[40,59], [42,60], [42,60], [39,60], [35,58], [35,56], [40,60], [39,58], [39,60], [39,60]],
    w:  [[47,59], [53,58], [52,60], [47,59], [43,57], [45,56], [48,59], [48,58], [48,59], [48,60]],
    sw: [[56,58], [59,59], [58,61], [54,61], [50,61], [50,59], [55,60], [55,59], [55,60], [55,61]],
};

export function astraWeaponPose({ cell, dx, dy, drawScale = 1 }, direction, equipment) {
    const wrist = WRISTS[direction]?.[cell?.sy / 92];
    if (!wrist) return null;
    return {
        x: dx + wrist[0] * drawScale,
        y: dy + wrist[1] * drawScale,
        flipX: ['ne', 'n', 'nw', 'w'].includes(direction),
        behindBody: direction === 'e' || direction === 'ne',
        // The source blades already lean diagonally; turn them up and out,
        // with a compact low carry that clears the helmet.
        angle: equipment === 'polearm'
            ? ['e', 'w'].includes(direction) ? 0.05 : -0.25
            : ['e', 'w'].includes(direction) ? -0.10 : -0.35,
        scale: equipment === 'polearm' ? 0.82 : 0.80,
    };
}
