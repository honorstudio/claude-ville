# Product

## Register

brand

## Users

A solo developer who runs several AI coding CLIs at once (Claude Code, Codex, Gemini, Kimi, OpenCode) and wants to *watch* them work. ClaudeVille lives on a second monitor while they code on the first: glanced at, not stared at. The job to be done is mostly ambient awareness — "is anything stuck, waiting on me, or burning tokens?" — answered from the corner of the eye, plus the simple pleasure of seeing your agents alive in a place. It runs entirely locally (a zero-build Node server on port 4000) and reads provider session logs read-only. Desktop only, 1280px and wider; no mobile or narrow viewports.

## Product Purpose

ClaudeVille turns invisible local agent activity into a place you can look at. It reads session files from multiple coding-CLI providers, normalizes them into one session model, and renders them two ways: an isometric pixel-art **World** (a medieval-fantasy village that runs on real time, its sky and light shifting from bright midday to torchlit night with the actual hour and weather, where agents are little adventurers and durable concepts are buildings) and a dense DOM **Dashboard** for precise scanning.

The village is the product. Success is not "an accurate dashboard"; it's a place worth leaving open. A developer keeps ClaudeVille on a second screen because watching their agents inhabit a living town is a genuine small joy, and because a glance tells them what is happening without breaking flow. Dashboard mode is the product-shaped escape hatch for when someone needs to read exact state; World mode is where the brand lives.

The canvas village's visual system (its terrain and water palette, its nine buildings, sprite identity, and the real-time atmosphere engine for day/dusk/night, weather, and seasons) is the brand's center, but it is not captured in DESIGN.md, which documents the DOM chrome only. The canonical references for anything drawn on canvas are `claudeville/src/config/theme.js`, `docs/visual-experience-crafting.md`, `docs/motion-budget.md`, and `docs/world-visual-qa-checklist.md`.

## Brand Personality

Whimsical, characterful, and lovingly hand-crafted. Mostly playful fantasy: agents are adventurers with their own identity and motion, and the world has the warmth of a town you would want to visit. Underneath the whimsy is genuine retro reverence — constrained pixel-art craft, the `Press Start 2P` typeface, torchlight on near-black, strong outlines, tiny props that carry meaning. 8/16-bit nostalgia done with care, not applied as a filter.

Voice (UI copy): in-world and characterful, leaning on the village/RPG framing, playful without being cute for its own sake. Warm, a little mythic, never corporate. This applies to *our* copy — labels, empty states, chrome. It never applies to villager speech: what an agent says over its head is the model's own words, attributed and unedited (see `claudeville/adapters/dialogue.js`). A villager with nothing attributable to say stays silent rather than reciting flavor text.

Emotional goal: calm delight. A place that is nice to keep in the corner of your eye: alive and shifting with the time of day, rewarding a closer look, and never nagging.

## Anti-references

Explicitly NOT:

- **Generic SaaS dashboard.** Cool grays, Inter, chart-card grids, the analytics-tool look. This is the exact thing the village exists to escape.
- **Neon cyberpunk / synthwave.** Glowing neon grids, purple-and-cyan "techy game" cliche. The obvious second-order reflex for a dev tool; avoid it.
- **Corporate gamification.** Badges, points, XP bars, streaks bolted onto a business app. ClaudeVille is a game world, not a gamified spreadsheet.
- **Mobile / casual-game UI.** Bubbly rounded buttons, candy gradients, big juicy CTAs, freemium sheen. Crafted retro, not App Store casual.

## Design Principles

1. **The place is the point.** Judge every addition by whether it makes the world feel more alive and more glanceable, not merely more informative. ClaudeVille is a village worth leaving open, not a dashboard wearing a costume.

2. **Built for the corner of the eye.** It lives on a second monitor while the user works elsewhere. State should resolve in a peripheral glance and stay calm by default; it should only get loud when something genuinely needs a person.

3. **Agents are characters, not rows.** Sessions are little adventurers with identity, status, and motion. Variation is deterministic from stable identity, so the same agent reads as the same character across reloads.

4. **A grammar you learn once.** Building, color, glow, and motion each mean one thing and keep meaning it. Delight rides on top of a stable visual language; whimsy never makes "what is stuck" or "what changed" harder to read.

5. **Craft over volume.** The retro reverence is in restraint: a tight palette, strong outlines, torchlight, and tiny props that carry meaning. One well-tuned detail beats five effects competing for the eye.

## Accessibility & Inclusion

Minimal, by deliberate choice. This is a solo, local, desktop-only tool (1280px and wider), not a public product, so it does not chase a formal WCAG level. The working bar is basic readability of the DOM surfaces (sidebar, dashboard cards, panels, modals) and preserving the reduced-motion support that already exists as engineering policy (`docs/motion-budget.md`: declare a pulse band, ship a static reduced-motion fallback). No commitment to full keyboard navigation, screen-reader parity, or AA contrast beyond keeping text legible. Color is already not the sole status cue in much of the world layer; keep that where it is cheap, but it is not a hard requirement.
