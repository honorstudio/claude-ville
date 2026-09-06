# ClaudeVille DOM/CSS design review — 2026-09-01

Scope: `claudeville/index.html`, `claudeville/css/*.css`, `src/presentation/shared/**`, `src/presentation/dashboard-mode/**`, `src/config/i18n.js`, `assets/fonts/*`, screenshots 02/03/04/05/06/18/30/31/42/60 at 1920x1080 (no `7x-1440x900-dpr2*` shots existed). Read-only; no repo file touched. Context honoured: v0.36.0 landed truthful boot chip, four labelled attention counts, Book of Lives, and the selection/focus lifecycle (`ActivityPanel.js:374-377, 456-466, 603-640`; `Modal.js:48-99`) — none re-proposed here.

---

## A. Verdict and design-director impression

**AI-slop / templated verdict: No — this is an authored house style, with a few generic-dark-dashboard leaks.**

What works and should be protected:

- **The topbar ledger.** `TODAY 130.0K` in its bronze-framed tag (`topbar.css:135-142, 383-458`) next to three status segments, with the idle ring drawn hollow rather than colour-only (`topbar.css:503-512`), is the best single piece of UI in the app. It reads as a village counting-house, not a KPI strip.
- **Pixel headings on wood.** `Press Start 2P` for wordmark, section titles and building banners, over layered wood/parchment gradients with a repeating 1px grain (`reset.css:93`, `topbar.css:11-20`, `activity-panel.css:6-13`), is consistent everywhere DOM meets canvas.
- **The Chronicle ledger.** 3x3 stat grid plus a timeline with one glyph per event kind (`ChroniclePanel.js:16-26`, `modal.css:369-441`) and the opening line "From 20:16: 5 agents across 2 projects." is exactly the daily-ledger document the audience wants. Markdown/CSV export already exists (`ChroniclePanel.js:157-260`).
- **The token grid** (INPUT / OUTPUT / CACHE READ / CACHE WRITE / CACHE HIT / TURNS, `index.html:232-262`) and context bar are the right precise-data shape.
- **Four honest empty-state copies** (`App.js:62-93`); "A watchtower is ready, but no coding session is running." is good microcopy.
- **Reduced motion is taken seriously** in every stylesheet (`topbar.css:60,196,347`; `sidebar.css:221,277,337`; `dashboard.css:975-1017`; `activity-panel.css:1298-1318`; `modal.css:154-165`; `layout.css:96`).

Where it leaks toward "generic dark AI dashboard":

- The status and tool-category palette is literally Tailwind's default hex set: `#ef4444` (red-500), `#facc15` (yellow-400), `#eab308` (yellow-500), `#60a5fa` (blue-400), `#a78bfa` (violet-400), `#34d399` (emerald-400), `#f59e0b` (amber-500), `#c084fc` (purple-400) (`reset.css:53-54, 59-63, 69-70`). On parchment, those saturated SaaS hues are the loudest template tell.
- The canvas-drawn empty card uses off-palette slate `#121822` with `#8bd7ff`/`#d6e7ee` text (`IsometricRenderer.js:10029-10056`) — a Bootstrap-dark card inside a medieval village.
- Read-only Settings built from inline styles (`TopBar.js:332-420`).

**Single biggest opportunity: a real typographic system.** Both loaded faces are bitmap-style (`PressStart2P-Regular.woff2`, `DepartureMono-Regular.woff2`, `reset.css:8-22`), `-webkit-font-smoothing: none` is applied to the whole document (`reset.css:105`), the token block promises a 10px floor and "display >=10px only" (`reset.css:74-79`), and that floor is broken in at least 14 places (C.6). The audience opens Dashboard/Panel precisely when they need exact numbers, paths and messages; today that is the least legible moment. Fix the type and half the other complaints (paths, panel density, chronicle rows, bond copy) become readable for free.

---

## B. Ranked improvements (operator impact x feasibility)

### 1. Two-face typographic system: pixel display + legible body face — M

**Operator sees.** Headings, banners, wordmark stay Press Start 2P; every path, message, chronicle row, bond line, meta value and modal paragraph is set in a smooth, readable face at 12-13px / 1.45 line-height. `0/O`, `l/1` stop blurring.

**Why.** `docs/visual-experience-crafting.md` section 3: DOM exists for "long text, copyable values, and accessible labels". At 10-11px, unsmoothed, in a pixel face, it cannot do that job.

**Evidence.**
- `reset.css:8-22` loads only two woff2 files, both pixel faces; `reset.css:73-79` defines `--font-display`, `--font-body`, `--fs-title 12`, `--fs-body 12`, `--fs-data 11`, `--fs-label 10` ("floor — nothing smaller").
- `reset.css:104-107`: `font-family: var(--font-body); -webkit-font-smoothing: none; image-rendering: pixelated` on `html, body`.
- Sub-floor sizes: `character.css:85` (9px display), `:121` (9px), `:134` (8px), `:157` (7px display for the whole World Controls popover), `sidebar.css:420` (7px display), `modal.css:187-190` `.cl-ver` 8px, `:387-391` `.chronicle__stat-label` 8px display, `:424-428` `.chronicle__time` 9px display; inline `fontSize: '9px'/'8px'` at `App.js:793, 808, 825, 905` and `TopBar.js:312, 416, 517, 560, 600`.
- `--font-pixel` referenced (`topbar.css:755, 785`; `TopBar.js:415, 552, 599`) but never defined; only `--font-display` exists (`reset.css:74`).
- Dense body copy: `.dash-card__tool-item-detail` 10px `dashboard.css:827-833`; `.activity-panel__tool-item-detail` 10px `activity-panel.css:437-439`; `.modal__content` 11px `modal.css:76-82`; `.chronicle__entry` 11px `modal.css:413-418`; `.toast` 10px `modal.css:103-106`.

**Work.**
- `reset.css`: add a third `@font-face` for a genuinely legible body face bundled under `claudeville/assets/fonts/` (offline app; no Google Fonts). Redefine `--font-body` to it; add `--font-mono: 'Departure Mono', ...` reserved for paths, hashes and tabular numbers. Tokens: `--fs-body: 13px; --fs-data: 12px; --fs-label: 10px` (labels only as uppercase display eyebrows), add `--lh-body: 1.45`.
- Move `-webkit-font-smoothing: none` off `html, body` (`reset.css:105`) onto the display-face selectors (`.topbar__logo`, `.activity-panel__section-title`, `.sidebar__title`, `.dash-card__name`, `.modal__title`, `.world-empty__title`, ...).
- Define `--font-pixel: var(--font-display)` or replace the five references.
- Replace every sub-10px display usage (list above) with a 10px display eyebrow or an 11-12px body line; `character.css:157` becomes 10px display header + 12px body.
- Delete inline `fontSize` from `App.js:793-830, 899-907` and `TopBar.js:303-420`; move to classes in `modal.css`/`topbar.css`.

**Acceptance.** No Press Start 2P rendered below 10px (`rg "font(-size)?:\s*[7-9]px" claudeville/css` returns no display-face hits). All running text >=12px. Dashboard tool list at 1920x1080 shows filename glyphs distinguishable. Contrast unchanged or better.

### 2. Path and filename display that keeps the filename — S

**Operator sees.** `Edit  …/pharos-watch/shared/v4.ts` (or project-relative `shared/v4.ts` when inside the agent's workdir). Full path on hover. Home directory never shown.

**Evidence.**
- Server sends the *full* path for history but a basename for the current tool: `adapters/claude.js:1208` `summarizeToolInput(block.input, { maxLength: 60, basenameFile: true })` vs `:1290` `summarizeToolInput(block.input, { maxLength: 80, basenameFile: false })`; same split in `gemini.js:390/441` and `kimi.js:666/715`.
- Client truncates from the end: `AgentPresentation.js:260` `truncateText(entry.detail, detailLength)` with `detailLength: 45` (`ActivityPanel.js:1266`) and `60` (`DashboardRenderer.js:1055`); `Formatters.js:103-110` keeps the head and appends `…`.
- `Formatters.js:77-87` `shortenHomePath()` exists but is only applied to the working directory (`ActivityPanel.js:765`) and project header (`DashboardRenderer.js:463`), never to tool details.
- CSS end-clips too: `dashboard.css:831-833`, `activity-panel.css:437-441`.
- Screenshot 03: eleven rows of `/Users/ahirice/Documents/git/pharos-watch/shar…`.

**Work.**
- `Formatters.js`: `export function formatToolDetail(detail, { max = 48, projectPath = '' } = {})` — if `detail` looks like a path, run `shortenHomePath`, strip `projectPath` prefix to a relative path, then truncate from the *head* keeping the last two segments (`…/shared/v4.ts`); for commands (`cd /Users/...`) apply `shortenHomePath` to each absolute token; non-path details keep `truncateText`.
- `AgentPresentation.js:toolHistoryNodes` gains a `formatDetail` option (default `formatToolDetail`) and sets `title` to the raw detail on the detail span.
- Keep server `maxLength: 80`; the client does the shaping.
- Optional: split into `.tool-item-dir` (muted) + `.tool-item-file` (gold) spans.

**Acceptance.** Every path-shaped tool row ends with its filename. No string starting with `/Users/` or `/home/` reaches the DOM. Hover reveals the full path. Unit test for `formatToolDetail` over POSIX and Windows paths.

### 3. Stop fixed overlays colliding with the Activity Panel and building labels — S

**Operator sees.** First-run hint sits under the compass button and slides left when the panel is open; World Controls popover never covers the panel; "WATCHING 5 AGENTS" no longer floats over PORTAL/MINE banners once live.

**Evidence.**
- `character.css:89-93` `.first-run-hint { position: fixed; top: 63px; right: 167px; width: 300px }` spans x=1453..1753 at 1920 wide; the panel is 320px (`activity-panel.css:4`) from x=1600. Screenshot 02 shows it covering the selected agent's name and status chip. `App.js:952-958` reveals it on the first usable phase regardless of panel state.
- `character.css:157` `.world-grammar { inset: 58px 174px auto auto; width: 310px }` — same overlap.
- Boot status: `App.js:768-800` creates `#bootStatusWrap` `position: fixed; top: 58px; left: 50%`; `VillageState.js:225-232` returns `WATCHING N AGENTS` for `READY_LIVE`; nothing hides it (`App.js:845-854` only updates text). Screenshots 02/04/06: overlaps PORTAL and MINE banners.
- Precedent: `modal.css:99-101` `body.cv-panel-open .toast-container { right: 336px }`.

**Work.** `character.css`: `body.cv-panel-open .first-run-hint, body.cv-panel-open .world-grammar { right: calc(167px + 320px) }` (or position from `#topbarWorldControls.getBoundingClientRect()` in `App._syncFirstRunHint`). Move boot status text into the topbar centre while not live (swap with the `TODAY` ledger) or into `#worldEmpty`; in `READY_LIVE` set `wrap.hidden = true` and let sidebar `#agentCount` carry the number, keeping a visually-hidden `role=status` element for the announcement.

**Acceptance.** With the panel open, no fixed overlay intersects `#activityPanel`. After the first snapshot, no DOM text sits over the canvas except `#worldEmpty` when empty.

### 4. One empty state, in the DOM — S

**Operator sees.** A single parchment card: title, copy, next step, plus the four-line building legend (Forge / Archive / Harbor / Mine) that today lives only in the canvas card.

**Evidence.** Canvas card `IsometricRenderer.js:10011-10059` `_drawEmptyStateWorldCue()`, called from `WorldFrameRenderer.js:670, 741`, gated only on `visibleAgentCount === 0`. DOM `#worldEmpty` `index.html:148-152` (`character.css:33-57`, z-index 3), painted by `App.js:871-881`. Sidebar has a third `THE VILLAGE AWAITS` (`Sidebar.js:568-577`) — fine, different region. Screenshot 30 shows the 536px canvas card behind the 420px DOM card.

**Work.** Delete `_drawEmptyStateWorldCue` and its two call sites (docs section 3: DOM owns structured text). Move the legend rows into `#worldEmpty` as `<dl class="world-empty__legend">` painted from `EMPTY_SURFACE_COPY` (`App.js:62-93`) — show for `READY_EMPTY`, hide for `READY_NO_PROVIDERS`.

**Acceptance.** Exactly one empty card in the World; no `#121822`/`#8bd7ff` colours in the world.

### 5. Toast styles must not depend on the modal stylesheet — S (defect)

**Operator sees.** The first "Forge Helper joined the village" appears as a framed toast top-right, not as raw yellow text bottom-left.

**Evidence.** `.toast-container`/`.toast*` live in `modal.css:86-165`; that file is deferred and only loaded via `_ensureStylesheet('modal')` when version chip / settings / chronicle open (`App.js:50-52, 1066-1090, 1195-1226`). `Toast.js:330-339` appends `.toast toast--type` immediately. Screenshots 18, 31, 60 show unstyled toasts; `index.html:299` places the container last in `body` (flex column) so they land bottom-left.

**Work.** Move `modal.css:86-165` into `layout.css` (always loaded) or a new `css/toast.css` linked in `index.html` head (~1.5KB); or call `_ensureStylesheet('modal')` in `Toast` before the first `show()`.

**Acceptance.** Reload with no modal ever opened; the first toast renders top-right with border and colour.

### 6. Activity Panel: operations first, village second — M

**Operator sees.** After the header: why it is waiting (only when blocked), Current Tool, Tool History, Messages, Cost & Tokens, Journey; then a collapsed "IN THE VILLAGE" group holding Scene Log, Chronicle / Book of Lives, Harbor Log, Narration, Village Bonds. `Mood` hidden unless it has a value; `Level` renamed `Effort`.

**Why.** The audience opens the panel for "what is it doing / is it blocked / what did it change / what did it cost". Today those are the last sections and off-screen at 1080p (screenshot 42: TOOL HISTORY and MESSAGES headings at y>1040).

**Evidence.**
- Order is an insertion artefact: each `_ensure*Section` calls `_insertAgentSectionAfterMeta()` (`ActivityPanel.js:2094-2103`), which inserts *directly after* `.activity-panel__meta`, so constructor order `Journey, Narration, HarborLog, Chronicle, DirectorFeed(Scene Log), Relationships, MessageEdges` (`:417-423`) appears reversed. Static sections follow (`index.html:222-282`), with Village Bonds spliced after Current Tool (`:1919-1921`) and before Tool History.
- `Mood`: `index.html:210-212`; `_formatMood` returns `-` unless non-neutral (`:1131-1135`) — `-` in every screenshot.
- `Level`: `_formatAgentLevel` maps `identity.effortTier` (`:1118-1129`) — reasoning effort, not a game level; `-` in every screenshot.
- Village Bonds: `relationshipLoreLine` (`:311-317`) always emits `Hearth-warm · 0 shared commits · crossed paths just now`; `_relationshipRow` (`:1978-1993`) prints `stranger`; screenshots 02/42/60 show 4-5 identical STRANGER rows plus "+2 more names in the village annals" (`:1969-1972`). "Hearth-warm" beside "stranger" is contradictory.
- Narration empty copy occupies 3 lines in every screenshot (`:1513-1528`).

**Work.**
- Replace `_insertAgentSectionAfterMeta` with an ordered mount: a `SECTION_ORDER` array of keys and `_mountSection(key, el)` inserting before the next present key; give the static `index.html` sections `data-section` keys.
- Wrap Scene Log / Chronicle / Harbor Log / Narration / Bonds in `<details class="activity-panel__village">` with a display-face summary; persist open state next to the pin list (`_loadPinnedAgentIds`).
- Hide the Mood row when `-`; rename `LEVEL` to `EFFORT` (`index.html:202`).
- Bonds: render only `tier !== 'strangers' || sharedCommits > 0`; show warmth only for ally/acquaintance; empty text "No shared work yet."
- Hide Narration when empty (pattern at `:1440-1445`).

**Acceptance.** At 1920x1080 with an agent selected, Current Tool, >=6 Tool History rows and Est. Cost are visible without scrolling. Section order lives in one array. No bond row with zero evidence.

### 7. Dashboard mode and the panel: one place for detail — S/M

**Operator sees.** In Dashboard mode, selecting a card expands *that card* (tool history, messages, cost) and the side panel stays closed; switching back to World reopens the panel for the selection.

**Evidence.** `#activityPanel` is a sibling of `.content` in `.main__body` (`index.html:142-283`), so it persists across modes; `ActivityPanel.js` has no `mode:changed` subscriber (listeners only in `IsometricRenderer.js:1764`, `NotificationService.js:48`, `AudioDirector.js:217`, `DashboardRenderer.js:213`). Screenshot 03 shows the same Tool History and token grid twice, side by side. `dashboard.css:770` already says "selection is the explicit diagnostic expansion."

**Work.** In `ActivityPanel._bind()` subscribe to `mode:changed`: on `dashboard` call `this._close({ origin: 'mode' })` but keep `currentAgent` so `character` re-shows it; make the selected card render Messages + Est. cost + context bar (data already fetched in `_fetchAllDetails`). Cheaper alternative: `body.cv-panel-open .dash-card__tools { display:none }`.

**Acceptance.** No tool row rendered twice on screen in Dashboard mode.

### 8. Topbar meta line: bigger, quieter, no FPS for civilians — S

**Operator sees.** `● LIVE · v0.37 · 00:26` at 11px, high contrast; quota bars appear only when a window has usage and read `5h 12% · 7d 40%`; FPS lives in Settings > Health and returns to the bar only in the danger band.

**Evidence.** `topbar.css:108-121` meta 10px muted; `.topbar__uptime`/`.topbar__stat-rate` `rgba(187,161,122,.72/.7)` (`:715-723`) = 3.78:1 and 3.63:1 (below AA). FPS: `index.html:35`, `TopBar.js:1229-1244` always shown; the v0.37 changelog says the average FPS "flattered itself" and the useful p95/p99 live in the hover panel (`TopBar.js:1297`). Quota: `TopBar.js:919-940` unhides whenever either window is finite, so a fresh session shows an empty bar and `0%` (screenshots 02/03); numbers only in `title`. `SET` button injected with inline styles (`TopBar.js:306-319`) so it does not match its icon-button neighbours.

**Work.** `topbar.css`: meta `font-size: 11px`, muted at full alpha; `.topbar__fps { display:none }` unless `.topbar__fps--danger` or `body[data-cv-debug]`. `_renderQuota`: hide while both windows are 0; text `5h 12% · 7d 40%`. Make `SET` an icon button with the shared class and a gear glyph (keep `aria-label="Open settings"`).

**Acceptance.** All topbar text >=4.5:1. No FPS text on a healthy frame. Quota text names its windows.

### 9. A real Settings & Health surface — M

**Operator sees.** One modal (already opened by `SET`) with editable controls (sound, alerts, auto-camera, sidebar, reduced-motion override); a Watchtowers roster per provider (not installed / ready · n sessions / empty / degraded); a Storage ledger (what survives reload; chronicle degraded notice); a Health row (link state, last snapshot age, frame p50/p95, event-loop delay).

**Evidence.** `TopBar.js:303-420` renders read-only label/value pairs from `readPersistedSettings()` with inline grid styles, one `RESET TO DEFAULTS` button, and the undefined `--font-pixel`. Provider health exists server-side (changelog v0.36.0) and the connection popover already shows link details (`topbar.css:283-307`). The "Settings/Health roster" was the one piece of plan item 1 not visibly shipped.

**Work.** New `src/presentation/shared/SettingsPanel.js` built with `el()` from `DomSafe.js`; styles in `modal.css` under `.settings-*`; controls drive the existing toggles (`topbarSoundToggle`, `topbarAlertsToggle`, `topbarCinemaToggle`, `sidebarToggle`) so state stays single-sourced; roster from `/api/providers`; perf rows from `window.__claudeVillePerf` / `ClientPerfMetrics`. Move the FPS panel there.

**Acceptance.** Every persisted setting changeable by keyboard from the modal; an unavailable provider is named; no inline `style:` blocks remain in `_buildSettingsContent`.

### 10. Keyboard-first agent navigation (search as the palette) — M

**Operator sees.** `/` or `Ctrl/Cmd+K` focuses sidebar search; Up/Down moves a highlight through the filtered list; Enter selects (and follows in World); Escape clears the filter, then closes the panel. `A` unchanged.

**Evidence.** `Sidebar.js:208-236` — Enter acts only with exactly one match; no arrow handling; no focus shortcut (`IsometricRenderer.js:2855` only excludes modifier keys). `#agentList` is a plain `div` (`index.html:126`); rows are `<button aria-pressed>` (`Sidebar.js:791-797, 876-886`). World keys exist (`IsometricRenderer.js:2870-2905`); Dashboard has cyclic helpers (`DashboardKeyboardNavigation.js:5-11`).

**Work.** `Sidebar._bindFilter`: handle `ArrowDown/ArrowUp/Home/End` with roving `tabindex` over visible `.sidebar__agent-select`, Enter -> `emitAgentSelected`. Global keydown in `App.js`: `/` or `Meta/Ctrl+K` -> `filterEl.focus()` unless `isKeyboardEditTarget` (`DashboardKeyboardNavigation.js:33-40`). Document keys in the World Controls popover (`index.html:158`).

**Acceptance.** Select any agent, open its panel, close it — no pointer. Focus visible at every step (global ring `reset.css:119-122`).

### 11. Colour, contrast and non-colour encodings — S

**Evidence (contrast from tokens, sRGB, alpha pre-blended on `#0d0a0c`).**
- `--cv-dash-detail #8d7659`: 4.11:1 on surface-1, **3.66:1** on surface-2 (`layout.css:79`; used `dashboard.css:830, 842`).
- `.topbar__uptime` **3.78:1**, `.topbar__stat-rate` **3.63:1**, idle mode button `rgba(187,161,122,.78)` **4.20:1** (`topbar.css:537, 715-723`).
- `--cv-text-muted #a89476`: 6.05 / 5.39 / 6.47 on surface-1 / surface-2 / panel — passes.
- `--cv-status-errored #ef4444`: 4.71:1 — marginal as 10px exit-chip text (`ActivityPanel.js:1288-1299`).
- Tailwind hex set at `reset.css:53-54, 59-63, 69-70`.
- Non-colour encoding: topbar hollow idle ring (`topbar.css:503-512`); Dashboard pills carry text; sidebar dots are colour-only but paired with a row status class.

**Work.** `reset.css`: `--cv-dash-detail` -> `#a08a68`; uptime/rate alpha -> 0.9. Re-derive status/tool hues from the house ramp (errored `#e06c5b` — already the CSS fallback at `activity-panel.css:120`; read `#7eb7d6` = `--cv-blue-soft`; task `#72d071` = `--cv-green-soft`; search a desaturated `#b79ae6`). Add glyph prefixes to `.sidebar__agent-dot--errored/waiting_on_user/rate_limited` (`!`, `?`, `~`) matching `ChroniclePanel.js:16-26` so the vocabulary is shared.

**Acceptance.** Every text token >=4.5:1 on every surface it is used on (the scratchpad `contrast.mjs` can become a unit test over `reset.css`). No raw Tailwind hex in `reset.css`.

### 12. The Chronicle as a day-ledger document — M

**Operator sees.** Prev/next-day arrows and a Today button instead of a locale-formatted date input; bursts folded ("21:11 — 4 villagers arrived · pharos-watch"); waited-on-you rows carry a duration badge; per-project subtotal under the ledger; export unchanged.

**Evidence.** `ChroniclePanel.js:489` `_datePicker` uses native `<input type=date>` (screenshot 04: `01. 09. 2026.`); `:57-77` `eventText` one line per event, no folding; `modal.css:387-391` stat labels 8px display; `:424-428` times 9px display; 100-row pages.

**Work.** Pure `foldTimeline(events)` grouping same-kind same-minute events; prev/next/today controls around the input; per-project rows from `summarizeDay().projects`; stat-label and time to 10px display.

**Acceptance.** Yesterday in one click; 40 arrivals render in <15 rows; unit test for `foldTimeline`.

### 13. Accessibility polish: live-region chatter, panel semantics — S

**Evidence.** Four polite live regions overlap: `#worldSemanticSummary` (`index.html:160`), `#toastContainer` `role=status` (`:299`), `#bootStatus` (`App.js:800-802`), `.topbar__connection-live` (`topbar.css:272-281`). Panel `role=region` + `aria-labelledby` is good (`ActivityPanel.js:374-377`); meta grid is `span` pairs (`index.html:188-221`) rather than `dl`; version chip is `span role=button tabindex=0` (`index.html:34`, keydown at `TopBar.js:206`).

**Work.** Toast container `aria-live="off"` for info toasts (errors keep `role=alert`, `Toast.js:334`); keep `#worldSemanticSummary` as the single polite narrator; meta rows -> `<dl>`; version chip -> `<button>`.

**Acceptance.** One announcement per event with VoiceOver; Tab order topbar -> search -> agent rows -> content -> panel close.

---

## C. Verified defects (file:line)

1. **Toasts unstyled until a modal has been opened.** `.toast*` only in `modal.css:86-165`; modal CSS deferred (`App.js:50-52, 1066-1090, 1195-1226`); `Toast.js:330-339`. Screenshots 18, 31, 60.
2. **First-run hint covers the Activity Panel header.** `character.css:89-93` vs panel 320px (`activity-panel.css:4`); revealed regardless of panel state (`App.js:952-958`). Screenshot 02.
3. **World Controls popover overlaps the open panel.** `character.css:157` `inset: 58px 174px auto auto; width: 310px`.
4. **Two empty-state cards on top of each other.** `IsometricRenderer.js:10011-10059` (called `WorldFrameRenderer.js:670, 741`) and `#worldEmpty` (`index.html:148-152`, `App.js:871-881`). Screenshot 30.
5. **"WATCHING N AGENTS" stays fixed over the canvas after boot.** `App.js:768-800`, text from `VillageState.js:225-232`, never hidden in `READY_LIVE` (`App.js:845-854`). Overlaps PORTAL/MINE in screenshots 02/04/06.
6. **Type floor broken.** `reset.css:74,79` vs `character.css:85, 121, 134, 157` (9/9/8/7px), `sidebar.css:420` (7px), `modal.css:187-190, 387-391, 424-428` (8/8/9px), `App.js:793, 808, 825, 905`, `TopBar.js:312, 416, 517, 560, 600`.
7. **`--font-pixel` undefined.** `topbar.css:755, 785`; `TopBar.js:415, 552, 599`; only `--font-display`/`--font-body` exist (`reset.css:74-75`).
8. **Tool-history paths truncated from the end, home dir included.** `adapters/claude.js:1290` (`basenameFile: false`; also `gemini.js:441`, `kimi.js:715`) vs current tool `claude.js:1208` (`true`); `AgentPresentation.js:260` + `Formatters.js:103-110`; `shortenHomePath` never applied to tool details. Screenshot 03.
9. **Contrast below AA.** `--cv-dash-detail` 3.66:1 on surface-2 (`layout.css:79`; `dashboard.css:830, 842`); `.topbar__uptime` 3.78:1, `.topbar__stat-rate` 3.63:1 (`topbar.css:715-723`); idle mode button 4.20:1 (`topbar.css:537`).
10. **Panel section order is an insertion artefact.** `_insertAgentSectionAfterMeta` (`ActivityPanel.js:2094-2103`) reverses constructor order `:417-423`; Bonds spliced at `:1919-1921`. Tool History/Messages below the fold at 1080p (screenshot 42).
11. **Contradictory bond copy.** `relationshipLoreLine` (`ActivityPanel.js:311-317`) prints `Hearth-warm` for every bond while `_relationshipRow` (`:1978-1993`) labels it `stranger`.
12. **Quota chip shows `0%` with an empty bar.** `TopBar.js:919-940`; exact numbers only in `title`.
13. **Inline-styled UI in JS bypasses tokens.** Settings modal (`TopBar.js:332-420`), boot status (`App.js:768-830`), empty-surface "next" line (`App.js:897-907`), exit chip (`ActivityPanel.js:1288-1299`).
14. **Canvas empty card uses off-palette colours.** `IsometricRenderer.js:10029-10056` (`#121822`, `#8bd7ff`, `#d6e7ee`).

Note on sim screenshots (18, 31, 42, 60): the chip reads `SYNCING` while agents are visible. `App.js:223-227` says the `?sim=1` simulator "overrides session ingestion", so the readiness reducer never sees a fulfilled snapshot — a harness artefact, not a live defect (live shots 02/03 show `LIVE`). Worth making the simulator publish the same readiness event so demos cannot show a lying chip.

---

## D. Do not do

- Do not replace Press Start 2P for headings, banners, wordmark or ledger tags — the pixel display face is the brand; stop using it below 10px and for running text only.
- Do not re-implement the truthful boot chip, four attention counts, Book of Lives or selection/Escape lifecycle — shipped in v0.36.0 (`ActivityPanel.js:374-377, 456-466, 603-640`; `Modal.js`).
- Do not add `@media (max-width)` queries, mobile layouts or shrink-to-fit; target is >=1280px desktop.
- Do not move tables, paths or messages into the canvas; docs section 3 assigns structured text to the DOM.
- Do not make the Activity Panel a focus trap; it needs a return path, not modal semantics (plan item 14).
- Do not invent flavour to fill empty sections (barks, fake bonds, mood adjectives); the "no false gossip" rule applies to copy — hide the section instead.
- Do not replace counts with percentages in attention/health surfaces (plan item 3: "percentages erase the outlier").
- Do not load fonts or CSS from the network; offline-first (`reset.css:7`).
- Do not add a build step, CSS preprocessor or component framework to get the type system; `reset.css` tokens suffice.
- Do not touch `IsometricRenderer.js` beyond deleting `_drawEmptyStateWorldCue`; canvas is another territory.
