// Shared tonal vocabulary for every pitched element in the soundscape.
//
// All layers and cues draw notes from one pentatonic scale per time-of-day
// phase so nothing can clash harmonically: A major pentatonic while the sun
// is up, drifting to A minor pentatonic at night. Registers shift with the
// phase (airy at dawn, warm and low at dusk, dark and sparse at night).

const A4 = 440;

export function noteHz(semitonesFromA4) {
    return A4 * Math.pow(2, semitonesFromA4 / 12);
}

// `tones` are semitone offsets from A4 forming the melodic pool for the
// music layer. `bass` anchors the tonal bed. `brightness` 0..1 maps to
// filter cutoffs downstream.
const SCALES = {
    dawn: { tones: [0, 2, 4, 7, 9, 12, 14], bass: -24, brightness: 0.85 },
    day: { tones: [-12, -10, -8, -5, -3, 0, 2], bass: -24, brightness: 1 },
    dusk: { tones: [-12, -10, -8, -5, -3, 0], bass: -36, brightness: 0.62 },
    night: { tones: [-12, -9, -7, -5, -2, 0], bass: -36, brightness: 0.4 },
};

function bellPartial(ratio, gain, decay) {
    return Object.freeze({ ratio, gain, decay });
}

// Provider voices keep the fundamental on the shared cue scale, then use
// integer harmonic partials for colour. Integer partials keep simultaneous
// providers consonant while the register and harmonic recipe make each house
// recognizable without needing samples.
const BELL_VOICINGS = Object.freeze({
    default: Object.freeze({
        register: 1,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(2.756, 0.3, 0.5),
        ]),
    }),
    claude: Object.freeze({
        register: 1,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(2, 0.3, 0.5),
            bellPartial(4, 0.14, 0.34),
        ]),
    }),
    codex: Object.freeze({
        register: 2,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(3, 0.22, 0.42),
            bellPartial(5, 0.1, 0.27),
        ]),
    }),
    gemini: Object.freeze({
        register: 1,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(2, 0.24, 0.5),
            bellPartial(5, 0.1, 0.28),
        ]),
    }),
    grok: Object.freeze({
        register: 0.5,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(3, 0.24, 0.44),
            bellPartial(4, 0.12, 0.32),
        ]),
    }),
    kimi: Object.freeze({
        register: 1,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(4, 0.2, 0.38),
            bellPartial(6, 0.08, 0.24),
        ]),
    }),
    omp: Object.freeze({
        register: 0.5,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(2, 0.28, 0.5),
            bellPartial(3, 0.16, 0.4),
        ]),
    }),
    opencode: Object.freeze({
        register: 2,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(4, 0.18, 0.36),
            bellPartial(5, 0.1, 0.27),
        ]),
    }),
    deepseek: Object.freeze({
        register: 1,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(3, 0.2, 0.43),
            bellPartial(6, 0.08, 0.24),
        ]),
    }),
    zai: Object.freeze({
        register: 2,
        partials: Object.freeze([
            bellPartial(1, 1, 1),
            bellPartial(2, 0.26, 0.48),
            bellPartial(6, 0.09, 0.25),
        ]),
    }),
});

function providerFamily(provider) {
    const key = String(provider || '').toLowerCase();
    if (key.includes('deepseek')) return 'deepseek';
    if (key.includes('zai') || key.includes('glm') || key.includes('zhipu')) return 'zai';
    if (key.includes('opencode')) return 'opencode';
    if (key === 'omp' || key.includes('open-model')) return 'omp';
    if (key.includes('codex') || key.includes('openai') || key.includes('gpt')) return 'codex';
    if (key.includes('gemini')) return 'gemini';
    if (key.includes('grok')) return 'grok';
    if (key.includes('kimi')) return 'kimi';
    if (key.includes('claude') || key.includes('anthropic')) return 'claude';
    return 'default';
}

export function scaleForPhase(phase) {
    return SCALES[phase] || SCALES.day;
}

export function bellVoicingForProvider(provider) {
    return BELL_VOICINGS[providerFamily(provider)] || BELL_VOICINGS.default;
}

// Fixed interval set for one-shot cues, voiced from the same tonal center.
// Night borrows the minor third so cues agree with the night scale.
export function cueTones(phase) {
    const minor = phase === 'night';
    return {
        low: noteHz(-24), // A2
        root: noteHz(-12), // A3
        third: noteHz(minor ? -9 : -8), // C4 / C#4
        fifth: noteHz(-5), // E4
        octave: noteHz(0), // A4
        high: noteHz(minor ? 3 : 4), // C5 / C#5
    };
}
