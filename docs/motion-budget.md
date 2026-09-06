# Motion Budget And Pulse Policy

ClaudeVille's World mode uses motion to communicate state. New motion-bearing work must follow this budget before it ships.

## Required Gates

- Check `motionScale` before allocating animation state, particles, paths, timers, or offscreen caches.
- Ship a static fallback for `motionScale <= 0`. The fallback may show a fixed pose, fixed alpha, or snapped end-state, but it must not allocate continuous motion resources.
- Declare the pulse band claimed by each new animated cue.
- Prefer alpha decay, static tint, or one-shot flashes when motion is ornamental rather than semantic.
- Reuse the shared `getPulsePriority()` hook for visual A/B work instead of hardcoding competing priority orders in feature modules.

## Shared Helper Direction

World mode exposes shared pulse helpers in `claudeville/src/presentation/character-mode/PulsePolicy.js`. Before adding another repeating sine cadence, use `pulseValue()` or `pulseAlpha()` when possible. The helper:

- accepts `motionScale` and returns fixed fallback values when motion is disabled
- exposes named bands matching the table below
- keeps band choice visible at the call site
- avoids allocating timers, particles, paths, or offscreen caches when `motionScale <= 0`

Existing local pulse math can migrate gradually as nearby features are touched. Add local pulse math only when a feature needs a distinct waveform or timing model, and document why the shared helper is not enough.

## Pulse Bands

| Band | Cadence | Canonical owner | Permitted claimants | Forbidden |
| --- | --- | --- | --- | --- |
| `slow` | More than 1 second | Selection ring | Observatory sweep, lighthouse beam, directional chat flow | Competing pulse claimants when selection is active on the same agent |
| `medium` | Around 600 ms | Working-status glow | Forge burst, archive page flip, mine pickaxe, portal rune boost, mote orbit, carrier-bird flight | A second medium pulse on an entity already showing working glow |
| `fast` | Less than 300 ms | Recent-event flash | Spark ring, taskboard pin, re-merge sparkle, wisp landing pulse | Continuous use |
| `static` | No pulse | Idle agents, building lights, hearth glow | Command flag, harbor crate, mine seam tint, council ring, council gather notches and team mark, recovery bracket and relief diamond, departure sigil, monument freshness, manifest plank weathering | Replacing these static cues with repeating motion |

## Priority Iteration

Foundation freezes the bands, not the final visual priority order. The default order is exposed through `getPulsePriority()` and can be overridden with `?pulsePriority=selection,working,recent,intrinsic` during browser visual testing.

Feature work that introduces motion should test dense worlds with mixed selected, working, and recent-event states. If a different priority order reads better, update the hook default with that feature and record the tested order in the change notes.

## Reduced Motion

Reduced motion means:

- State machines may advance logical time if downstream state depends on completion.
- No particles, path walkers, drifting trails, or repeated pulse allocations should be created.
- Existing static visual meaning should remain visible through fixed alpha, fixed pose, or snapped final state.
