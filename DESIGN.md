---
name: ClaudeVille
description: A torchlit medieval-keep HUD wrapped around a living pixel-art village of AI coding agents.
colors:
  torchlight-gold: "#f2d36b"
  gold-bright: "#ffe58d"
  gold-deep: "#c79d4c"
  gold-soft: "#d7b979"
  signal-yellow: "#e8d44d"
  harbor-teal: "#7ac8d8"
  sky-soft: "#7eb7d6"
  charred-timber: "#08070b"
  timber-panel: "#140f12"
  ember-brown: "#2d1e17"
  parchment-tan: "#a89476"
  tan-bright: "#c6b08a"
  ash-gray: "#8b8b9e"
  status-working: "#4ade80"
  status-idle: "#60a5fa"
  status-waiting: "#f97316"
  status-rate-limited: "#f59e0b"
  status-errored: "#ef4444"
  status-waiting-user: "#facc15"
  accent-purple: "#c084fc"
  accent-green: "#72d071"
typography:
  display:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "2px"
  headline:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "1px"
  title:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "'Departure Mono', ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "'Press Start 2P', monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "1px"
  micro:
    fontFamily: "'Departure Mono', ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  xs: "1px"
  sm: "2px"
  md: "3px"
  lg: "6px"
  pill: "9999px"
spacing:
  2xs: "4px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  2xl: "16px"
  3xl: "20px"
components:
  button-mode:
    backgroundColor: "{colors.ember-brown}"
    textColor: "#bba17a"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
  button-mode-hover:
    backgroundColor: "#3a2518"
    textColor: "{colors.torchlight-gold}"
  button-mode-active:
    backgroundColor: "{colors.torchlight-gold}"
    textColor: "#241812"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
  chip-count:
    backgroundColor: "{colors.ember-brown}"
    textColor: "{colors.gold-soft}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  card-dossier:
    backgroundColor: "{colors.timber-panel}"
    textColor: "{colors.gold-bright}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  version-chip:
    backgroundColor: "#241811"
    textColor: "#c0a172"
    rounded: "{rounded.xs}"
    padding: "2px 6px"
  modal:
    backgroundColor: "#0f0f19"
    textColor: "{colors.ash-gray}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: ClaudeVille

## 1. Overview

**Creative North Star: "The Keep at Night"** *(the chrome only)*

"The Keep at Night" describes the DOM **frame**, not the whole app. The chrome is the interior of a darkened keep: walls of near-black timber, gold lamplight pooling along every bevelled panel edge, and at the center a window onto the village below. The chrome is never bright by default. It is meant to be left lit in the corner of a second monitor: quiet when the work is quiet, warm to glance at, and only loud when a single agent genuinely needs a person. Every chrome surface is *carved and torchlit*, raised plates with bevelled edges and a faint inset gold hairline, depth built from a warm highlight above and a dark drop below.

The window the frame surrounds is a *living* world. The canvas village runs on the real clock and weather: bright blue sky and lit water at midday, torchlit and moonlit at 2am. A permanently-dark keep framing a window onto a world that changes with the hour is the deliberate two-mood idea at the heart of ClaudeVille; do not flatten either half toward the other.

This system serves a `brand`-register product: the village is the point, and the chrome is its frame, not a competing dashboard. It is built for one developer at a desktop (1280px and wider; no mobile, no fluid breakpoints). Density is high and type is small because the reward is a dense, hand-made little world, not a roomy app shell. Color is rationed: gold is light, not fill, and saturated hues belong to agent status alone.

This spec documents the DOM chrome only. The canvas village's own visual system (terrain and water palette, the nine buildings, sprite identity, and a real-time atmosphere engine for day/dusk/night, weather, and seasons) is canonical in `claudeville/src/config/theme.js`, `docs/visual-experience-crafting.md`, `docs/motion-budget.md`, and `docs/world-visual-qa-checklist.md`. Treat those as the reference for anything drawn on canvas.

It explicitly rejects the look of a **generic SaaS dashboard** (cool grays, Inter, chart-card grids), **neon cyberpunk / synthwave** (glowing neon grids, purple-and-cyan), **corporate gamification** (badges, points, XP bars bolted onto a business app), and **mobile / casual-game UI** (bubbly buttons, candy gradients, juicy CTAs). It is a game world, hand-pixelled, not a gamified spreadsheet and not an App Store toy.

**Key Characteristics:**
- A two-face type system: `Press Start 2P` for display and `Departure Mono` for body and data.
- Warm gold-on-near-black; gold used as lamplight (text, edges, glow), never as a fill.
- Carved relief: top highlight + drop shadow + inset hairline frame on every raised surface.
- Saturated color reserved for agent status and provider identity, never decoration.
- Near-square corners (1-3px); the changelog modal is the lone exception at 6px.
- Calm at rest; motion is a status signal, with a reduced-motion fallback everywhere.
- The canvas village is a separate, real-time visual system (day/night, weather); it is documented in `theme.js` and the world docs, not in this spec.

## 2. Colors

A torchlit timber palette: warm golds and ember browns over a charred near-black, with a single cool teal carried in from the harbor and a tightly-fenced status spectrum.

### Primary
- **Torchlight Gold** (#f2d36b): the workhorse. Body text on dark, stat values, panel titles, the lit edge of everything. This is the lamplight of the keep.
- **Gold Bright** (#ffe58d): the brightest highlight, used for selected names, hover text, and the warm top-edge glow on raised plates.
- **Brass** (#c79d4c): the metal of the system. Hairline borders, dividers, and bevels (almost always at low alpha, e.g. `rgba(199,157,76,0.42)`), and the deep stop in the active-button gradient.
- **Gold Soft** (#d7b979): secondary gold text, count chips, account tier labels, quieter than Torchlight Gold.
- **Signal Yellow** (#e8d44d): louder than gold, reserved for card names, the empty-state headline, and the modal title.

### Secondary
- **Harbor Teal** (#7ac8d8): the canvas world's accent (water, harbor, Pharos). In DOM it appears rarely; it is mostly a world-layer color.
- **Sky Soft** (#7eb7d6): model badges and user/info message accents. The one cool-warm bridge that reads as "information," distinct from gold authority.

### Neutral
- **Charred Timber** (#08070b): the body background. Near-black with the faintest warmth; the unlit interior.
- **Timber Panel** (#140f12): the base surface for panels and cards (shipped as `rgba(20,15,18,0.96)` over the body).
- **Tavern Ember Brown** (#2d1e17): the warm raised note in panel gradients, chips, and badges; the wood catching the torchlight.
- **Parchment Tan** (#a89476): muted body and label text, the readable quiet voice.
- **Tan Bright** (#c6b08a): slightly warmer, more legible secondary text (messages, hints).
- **Ash Gray** (#8b8b9e): the single cool-gray outlier, confined to the changelog modal and empty-state copy. It is the one note that is not on the warm ramp; keep it where it is.

### Status (the fenced spectrum)
- **Quest Green** (#4ade80): working.
- **Wanderer Blue** (#60a5fa): idle.
- **Hearth Orange** (#f97316): waiting.
- **Amber Warning** (#f59e0b): rate-limited.
- **Alarm Red** (#ef4444): errored (also the destructive/close hover color).
- **Beacon Yellow** (#facc15): waiting on user.
- **Workflow Purple** (#c084fc): provider/workflow identity badge, not a status.

### Named Rules
**The Lamplight Rule.** Gold is light, not fill. It lives on text, hairlines, top-edge highlights, and glows, and never floods more than a sliver of any surface. The surface underneath is always timber.

**The Status-Only Color Rule.** The saturated spectrum (green, blue, orange, amber, red, yellow) is reserved for agent status and provider identity. It never decorates. If red means "errored," nothing else may be red for flavor.

**The Single Outlier Rule.** Ash Gray (#8b8b9e) is the one cool note in a warm system. It belongs to the changelog modal and empty states. Do not spread it onto panels, cards, or the world chrome.

## 3. Typography

**Display / Label Font:** `Press Start 2P` (with `monospace` fallback)
**Body / Data / Code Font:** `Departure Mono` (with system monospace fallbacks)

**Character:** ClaudeVille uses exactly two local faces. `Press Start 2P` carries the wordmark, headings, short labels, and controls; it stays at 10px or larger and renders with smoothing disabled so its bitmap edges stay crisp. `Departure Mono` carries prose, paths, messages, timestamps, and numeric data at 12–13px with a 1.45 line height and normal font smoothing. Do not introduce a third face.

### Hierarchy
- **Display** (400, 13px, line-height 1, letter-spacing 2px): the `ClaudeVille` wordmark in the top bar, with a dark drop and a gold glow.
- **Headline** (700, 12px, letter-spacing 1px): dashboard section names, card names, modal title.
- **Title** (700, 11px): tool names, token values, primary in-card labels.
- **Body** (Departure Mono 400, 13px, line-height 1.45): messages, tool details, and modal prose.
- **Data** (Departure Mono 400, 12px, line-height 1.45): paths, timestamps, meta values, and dense readouts.
- **Label** (Press Start 2P 400, 10px, letter-spacing 1px, UPPERCASE): stat labels, section eyebrows, and short meta keys.

### Named Rules
**The Whole-Pixel Rule.** Sizes are whole pixels and fixed, never fluid `clamp()`. A pixel font sheared by sub-pixel scaling stops being pixel art. Keep smoothing off on display-face selectors only; body and data text retain normal smoothing.

**The Breathing-Label Rule.** Small labels get `letter-spacing` (1-3px) and uppercase so the heavy glyphs have air. Uppercase is for short labels only (a few words), never for sentences or messages.

## 4. Elevation

This system is emphatically **not flat**. Depth is built three ways at once, layered on a near-black ground: a warm highlight along the top edge, a dark drop shadow below, and a faint inset gold hairline a few pixels inside the border (drawn with `::before` / `::after`) that reads as a carved inner bezel. Tonal layering does the rest, panels are lighter timber than the body, chips lighter still. The effect is a relief carving lit by a torch held overhead.

### Shadow Vocabulary
- **Carved bevel** (`box-shadow: inset 0 1px 0 rgba(255,226,138,0.10), inset 0 -2px 0 rgba(0,0,0,0.30)`): the default raised-plate treatment on stat tiles, badges, chips, buttons. Light catches the top, shadow falls under.
- **Panel float** (`box-shadow: 0 6px 16px rgba(0,0,0,0.20)` to `0 8px 22px rgba(0,0,0,0.22)`): cards and dashboard sections lifting off the timber.
- **Edge seam** (`box-shadow: inset -1px 0 0 rgba(255,226,138,0.10), 8px 0 20px rgba(0,0,0,0.18)`): the lit inner edge plus cast shadow on the sidebar and activity panel, which also carry a 2px brass side border.
- **Torch glow** (`box-shadow: 0 0 18px rgba(214,169,81,0.08)` and `text-shadow: 0 0 12px rgba(255,222,117,0.32)`): hover bloom on cards and the wordmark; warmth, not a neon ring.
- **Status halo** (`box-shadow: 0 0 6px currentColor` on status dots): the dot glows in its own status hue.

### Named Rules
**The Torchlight-From-Above Rule.** Every raised surface carries a warm highlight on its top edge and a dark drop beneath, as if lit from overhead. Light never comes from below.

**The Double-Frame Rule.** Panels, stat plates, and cards carry a faint inset gold hairline a few pixels inside their border. It is the carved inner bezel that makes a plate look milled rather than printed.

## 5. Components

Every interactive surface is a carved, torchlit plate. Affordances are consistent across the keep: the same brass hairline, the same bevel, the same `:focus-visible` gold outline.

### Buttons
- **Shape:** near-square, 2px radius (`{rounded.sm}`).
- **Mode toggle (default):** ghost plate, ember-brown gradient, muted gold text (#bba17a), inset bevel. The unlit state.
- **Mode toggle (active):** the lit state, a gold gradient (`#fff0b0 -> #d6a951 -> #9c6732`) with near-black text (#241812) and an inner-glow bevel. Gold as a fill is permitted *only* here, on the single active control.
- **Hover / Focus:** hover warms the border to bright gold and lifts the text toward Torchlight Gold; `:focus-visible` is a `2px rgba(255,229,141,0.75)` outline at 2px offset.
- **Icon buttons (close, copy-id, sidebar toggle):** small brass-bordered plates. Close turns Alarm Red on hover; copy-id fades in on card hover (`opacity 0 -> 1`).

### Chips & Badges
- **Count chips** (sidebar count, section count): ember-brown gradient, gold-soft text, 2px radius, `2px 8px` padding, inset bevel.
- **Provider / model badges:** tinted by identity, e.g. model badges use a Sky-Soft wash (`rgba(126,183,214,0.14)` bg, #7eb7d6 text); workflow badges use a Workflow-Purple wash; team badges take their color inline from `TeamColor.js`.
- **Stale badge:** amber-bordered warning plate (`rgba(120,72,16,0.35)` bg, #f5b54b text), uppercase, letter-spaced.

### Cards / Containers (the Adventurer Dossier)
- **Corner Style:** 3px radius (`{rounded.md}`).
- **Background:** timber gradient with a faint top radial gold highlight and 1px scanline texture.
- **Status spine:** a 3px `border-left` in the agent's status color. This is a functional status encoding, not decorative trim (see the rule below).
- **Shadow Strategy:** Panel float at rest; on hover the border warms to bright gold, a Torch glow blooms, and the card lifts `translateY(-1px)`.
- **Inner frame:** a 3px-inset hairline (`::after`) per the Double-Frame Rule.
- **Internal Padding:** header `10px 12px`; body sections `8px 12px`.

### Panels (Guild Ledger & Quest Log)
- **Sidebar (240px) and activity panel (320px):** timber gradient, 1px scanline texture, a 2px brass border on the inner edge (right / left respectively), Edge-seam shadow, and a top radial torch highlight.
- **Entrance:** the activity panel fades and slides in (`translateX(12px) -> 0`, 0.16s); reduced-motion removes the animation.
- **Selected row:** gold gradient wash plus a Gold-Bright 3px status spine.

### Inputs / Fields
There are none. ClaudeVille is a read-only observatory; it has no forms, text fields, or editable controls. Do not invent input chrome; if a control is ever needed, build it as a carved plate matching the button vocabulary.

### Progress Meters
- **Quota bar (top bar) and context bar (activity panel):** a thin (6px) inset track with a square-cornered fill. Quota fill is Accent-Green, shifting to Amber Warning then Alarm Red by threshold. Context fill is a green-to-gold gradient, shifting to gold-to-amber then amber-to-red. These are *usage gauges*, not score bars; keep them functional.

### Status Dots & Skeletons
- **Status dot:** a small disc in its status hue with a Status-halo glow and a `1px` light rim. Active states pulse on a per-status cadence (1.2s errored, fastest, to 2.4s rate-limited, slowest); idle does not pulse.
- **Skeleton:** a shimmering brass gradient sweep (`dash-skeleton-shimmer`, 1.4s) for first-fetch card loading, in place of spinners.

### Signature: The Minimap Frame
The world minimap is a vector parchment plaque, a brass border, corner gilt brackets (drawn with layered linear-gradients), an inset shadow, and a hover that brightens the border and adds a torch glow. It is intentionally not pixel art; it is the framed map on the keep wall.

## 6. Do's and Don'ts

### Do:
- **Do** render every glyph in `Press Start 2P` at whole-pixel sizes, smoothing off, `image-rendering: pixelated`.
- **Do** treat gold as lamplight (text, hairlines, top-edge highlights, glow) and keep surfaces timber/near-black. Solid gold fill is allowed only on the single active mode button.
- **Do** reserve the saturated spectrum for agent status and provider identity, and pair every status color with a second cue (a dot, a label, a position), never color alone.
- **Do** build depth with torchlight-from-above relief: warm top highlight, dark drop shadow, and a faint inset gold hairline frame.
- **Do** keep corners near-square (1-3px); only the changelog modal rounds to 6px.
- **Do** ship a `@media (prefers-reduced-motion: reduce)` fallback for every animation (status pulses, skeleton shimmer, panel fade-in, hover lift), as `dashboard.css` and `activity-panel.css` already do.

### Don't:
- **Don't** let it read as a **generic SaaS dashboard**: no cool grays, no Inter, no chart-card grids, no analytics-tool look.
- **Don't** drift toward **neon cyberpunk / synthwave**: no glowing neon grids, no purple-and-cyan techno sheen.
- **Don't** add **corporate gamification**: no XP bars, points, streaks, or achievement badges bolted on. The quota and context bars are usage gauges, not scores; keep them so.
- **Don't** adopt **mobile / casual-game UI**: no bubbly rounded buttons, candy gradients, big juicy CTAs, or freemium sheen.
- **Don't** introduce a second typeface. One pixel family carries the whole system, deliberately.
- **Don't** apply fluid `clamp()` sizing to the pixel font; whole pixels only.
- **Don't** flood a surface with solid gold. Gold is a sliver per the Lamplight Rule.
- **Don't** spread Ash Gray (#8b8b9e) beyond the modal and empty states; it is the one off-hue note.
- **Don't** reuse the 3px left-accent as decorative trim. The status spine means status or selection, nothing else.
