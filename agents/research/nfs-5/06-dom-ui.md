# DOM/UI performance investigation

Status: ready — read-only static audit, 2026-09-01

## Executive summary

- The DOM/CSS layer is not a credible cause of a 20–30s dark screen by itself; its eight blocking CSS files total 123,888 bytes raw (27,825 bytes with local `gzip -c`). A stalled server can nevertheless delay all eight blocking responses.
- The strongest sustained DOM issue is `Sidebar.render()`: when its signature changes it discards and recreates every project/workflow/agent row, approximately `6P + 7W + 8A + extras` element nodes per pass.
- `DashboardRenderer` is substantially disciplined: a normal same-project/same-status update patches a persistent card and creates zero DOM nodes; cards (38 elements) and project sections (22 elements) are created only when new.
- `ActivityPanel` has 23 replacement call sites, but every live list is signature-guarded and bounded (largest cap: 30 tools; Chronicle modal: 100 events). It does not contain an append-only DOM feed.
- Forced layout is concentrated in Dashboard FLIP reordering (`2A` rect reads plus one explicit reflow) and a post-render visibility scan (`A + 1` rect reads), not in ActivityPanel, Sidebar, or normal TopBar updates.
- No `blur()`, `backdrop-filter`, or `will-change` occurs. The costly CSS is instead perpetual paint animation of `box-shadow` and `background-position`, multiplied across working/sidebar/card states.
- Timers are generally destroyed and mode-aware. ActivityPanel fully stops on panel hide/tab hide; Dashboard stops on mode hide but still wakes every 3s in a hidden tab; TopBar's 1s clock and stale retry do not respect visibility.

## Scope and method

Static inspection covered the requested shared DOM surfaces, `DashboardRenderer.js`, and all eight CSS files. Counts below are source call-site counts from `rg`, not runtime invocation counts. `el()` is the project helper that calls `document.createElement`; its call sites are listed separately from direct `createElement`. A maintained server was not listening on port 4000 during the audit, and the rules prohibited starting it, so live Resource Timing and browser style-parse timing could not be captured. On-disk bytes and `gzip -c` are therefore the transfer proxies. No source file was modified.

## Quantified per-file patterns

Legend: `HTML` = direct `innerHTML =`; `replace` includes helper/direct `replaceChildren` call sites; `layout` = `getBoundingClientRect`, `offset*`, `scrollHeight/Width`, or `getComputedStyle`; `DOM +/−` = `addEventListener` / `removeEventListener`; `bus +/−` = `eventBus.on` / `eventBus.off`; `timer` = interval/timeout creation sites; `observer` includes Intersection/Resize/Mutation observer mentions.

| File | HTML | replace | direct create / `el()` sites | layout reads | DOM +/− | bus +/− | timer sites | observer sites | Update discipline |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `shared/ActivityPanel.js` | 0 | 23 | 0 / 140 | 0 | 13 / 7 | 14 / 14 | 2 intervals | 0 | Patches scalar fields; replaces individual bounded lists only after signatures change. |
| `dashboard-mode/DashboardRenderer.js` | 2 | 5 | 10 / 0 | 6 (3 rect, 3 offset) | 7 / 3 | 4 / 4 | 2 intervals, 3 timeout sites | 2 IntersectionObserver sites | Persistent sections/cards; scalar patching. Rebuilds attention queue and bounded tool lists. |
| `shared/TopBar.js` | 0 | 5 | 0 / 40 | 5 (4 rect, 1 offset) | 31 / 29 | 10 / 10 | 1 interval, 2 timeout sites | 0 | Scalar patching normally; open spend/connection/FPS popovers replace their small contents. |
| `shared/Sidebar.js` | 0 | 7 | 0 / 41 | 0 | 4 / 4 | 4 / 4 | 2 timeout, 3 rAF call sites | 0 | Full agent-list and harbor-list replacement after signature changes. |
| `shared/Toast.js` | 0 | 0 | 1 / 0 | 0 | 0 / 0 | indirect unsubscribe array | 2 timeout sites | 0 | Append/remove, capped at five live toasts. |
| `shared/Modal.js` | 2 | 1 | 0 / 0 | 0 | 3 / 3 | 0 / 0 | 0 | 0 | Replaces modal content only on open/close. |
| `shared/ChroniclePanel.js` | 0 | 1 | 1 / 23 | 0 | 3 / 0 | 0 / 0 | 0 | 0 | Full modal-page rebuild on open/date change; capped at 100 events. Detached row listeners are collected with old nodes. |
| `shared/DomSafe.js` | 0 | 2 | 1 / 1 | 0 | 0 / 0 | 0 / 0 | 0 | 0 | `replaceChildren()` deliberately removes all children, then appends new nodes. |
| `shared/AgentSelection.js` | 0 | 0 | 0 / 0 | 0 | 0 / 0 | 4 / 0 | 0 | 0 | Selection mirrors unsubscribe through returned callbacks; two global self-installed listeners intentionally live for page lifetime. |
| `shared/SessionDetailsService.js` | 0 | 0 | 0 / 0 | 0 | 0 / 0 | 0 / 0 | 1 timeout | 0 | No DOM work. |

The raw `eventBus.on/off` count understates classes that retain unsubscribe callbacks and overstates neither DOM nor row listeners. Likewise, `add/removeEventListener` differences are not automatically leaks: listeners on a node removed as a unit are reclaimed with that node.

### Re-render discipline and node creation

#### ActivityPanel

The selected-agent update handler patches scalar fields, then calls section renderers (`ActivityPanel.js:476-494`). Each list renderer hashes a bounded view and returns early when unchanged: tools (`1248-1282`), messages (`1304-1327`), Harbor events (`1440-1472`), narration (`1598-1627`), Chronicle biography (`1728-1773`), director feed (`1874-1893`), relationships (`1936-1975`), message edges (`2035-2056`), journey (`2147-2179`), and building subviews (`2534-2670`). Consequently an unchanged 2-second detail poll creates zero list nodes, despite 23 replacement sites in the file.

When a list signature does change, replacement cost is bounded:

| Surface | Cap | Elements created by a full changed-list render (approx.) |
| --- | ---: | ---: |
| Tool history | 30 | 4 per row, plus optional exit chip: 120–150 |
| Messages | 12 | 3 per row: 36 |
| Git/Harbor events | 6 | 6–7 per row: 36–42 |
| Narration | 20 and 5-minute retention | 5–7 per row: 100–140 |
| Director feed | 12 | 4 per row: about 48 |
| Relationships | 4 + one overflow row | 6 per relationship: at most about 25 |
| Inter-agent messages | 5 | 3 per row: 15 |
| Biography chapters/milestones | 32 retained chapters, 6 visible plus one archive disclosure; 6 milestones | bounded, but all retained chapter nodes are materialized immediately; older ones are merely hidden inside the closed disclosure |
| Pin comparison | 2 | small fixed cells |

The containers remain stable, so their own `scrollTop` is not inherently reset, but replacing descendants can clamp scroll when height changes and discards DOM text selection/focus inside those descendants. Signature guards make this an occasional correctness smell rather than a 30-times/minute one.

#### DashboardRenderer

`render()` reuses maps of sections and cards (`DashboardRenderer.js:219-304`). A project section is about 22 elements: the section root, 15 template descendants, and six programmatic health-stat spans (`408-453`). A new card is about 38 elements: card root, 36 template descendants, and one avatar canvas (`526-646`). Existing cards are patched using cached element references and a render signature (`676-844`); a normal same-project/same-status `agent:updated` takes the fast path (`313-326`) and creates zero DOM nodes.

Exceptions:

- A status or project-path transition calls the structural `render()` path and can reorder cards.
- `_renderAttentionQueue()` always recreates `2 + Q` elements and attaches `Q` click listeners when structural `render()` runs (`649-673`). It has no signature guard or delegation.
- Changed tool history recreates five elements per row (plus optional exit chip), capped at 12: 60–72 elements per affected card (`1025-1070`). It is signature-guarded.
- Card removal tears down the observer, canvas, timers, caches, and node (`1143-1171`).

#### TopBar

Each agent event invokes `render()` (`TopBar.js:153-156`, `667-676`). The normal path creates zero element nodes but unconditionally writes several `textContent`, title, and CSS-custom-property values. The only potentially repeated subtree rebuild is an open spend panel: `_renderSpend()` calls `_renderSpendPanel()` on every agent update (`682-699`), recreating `7 + 5(P+V) + overflow` elements, where each rollup list is capped at five (maximum about 59 elements; `745-821`). Connection and FPS detail panels are small and only rendered when instantiated/open.

#### Sidebar

All agent changes are coalesced into one rAF, which is good (`Sidebar.js:116-171`). However, the subsequent signature includes search-index revision and displayed agent fields (`335-393`). The search index revision advances whenever status/tool/file/commit search fields change (`SearchIndex.js:143-162`), so meaningful tool activity can invalidate the list even though the visible sidebar row does not display that tool. On invalidation, the entire `#agentList` is replaced (`Sidebar.js:406-499`). Approximate element creation per pass is:

`6P + 7W + 8A + extras`

where `P` is visible projects, `W` workflow groups, and `A` visible agents. Extras are up to six elements per agent for team/workflow/age/search/parent/working-caret states. Example: 20 ordinary agents in four projects create at least 184 elements (`6×4 + 8×20`), potentially every 2 seconds (5,520 element creations/minute) if searchable activity changes each broadcast. The parent `.sidebar__body` is the scroller, so its scroll position is likely retained, but the replaced row/button loses keyboard focus and any descendant text selection. This is the clearest re-render/correctness smell in scope. Harbor is also full-replaced but only after a dedicated content signature changes (`Sidebar.js:707-766`).

## Layout-thrash sites

No forced-layout property reads exist in ActivityPanel, Sidebar, Toast, Modal, ChroniclePanel, DomSafe, AgentSelection, or SessionDetailsService.

| Site | Pattern | Frequency and assessment |
| --- | --- | --- |
| `DashboardRenderer.js:345-365` | Read every card rect; append/move cards; read every rect again; write transforms; force `gridEl.offsetWidth`. | Deliberate FLIP read/write/read. Up to `2A` rect reads plus one forced reflow on an actual order change. Correctly avoided when order is stable (`330-340`) and reduced motion/inactive mode skips animation. Still the largest synchronous layout burst for large fleets. |
| `DashboardRenderer.js:1216-1228` | After structural render writes, read root rect then every card rect. | `A + 1` layout reads to seed visibility after structural render. IntersectionObserver already maintains the steady state; this scan is not on the ordinary same-status fast path. It can force one layout then perform O(A) geometry work. |
| `DashboardRenderer.js:516-519` | Remove flash class, read `sectionEl.offsetWidth`, re-add class. | One intentional forced reflow only when true error count rises; not a loop. |
| `DashboardRenderer.js:953-958` | Remove parent-flash class, read `cardEl.offsetWidth`, re-add class. | One intentional reflow on explicit parent navigation. |
| `TopBar.js:1150-1155` | Remove reconnect class, read `body.offsetWidth`, re-add class. | One intentional reflow per successful reconnect sweep. |
| `TopBar.js:589-597`, `723-735`, `1084-1095` | Read trigger rect, then position/show mixer, spend, or connection popover. | Correct read-before-write, one rect per user open; not thrash. |
| `TopBar.js:1208-1248` | Build/replace FPS panel, then read trigger rect and position panel. | The read follows writes and may flush once, but only on hover and not in a loop. |

No `scrollHeight`, `scrollWidth`, `getComputedStyle`, `offsetHeight`, `offsetTop`, or `offsetLeft` reads were found in scope. There is therefore no classic per-row alternating write/read loop in the 2-second update path.

## Unbounded growth findings

No unbounded live DOM list was found.

- ActivityPanel: tools 30, messages 12, inter-agent messages 5, Git events 6, relationships 4, director feed 12, narration 20 plus 5-minute retention, pinned agents 2, visible biography chapters 6 / retained view-model chapters 32 (`ActivityPanel.js:25-52`, `1249`, `1305`, `1446-1454`, `1551`, `1868-1869`, `1957`, `2042`). All are fully materialized; no virtualization is needed at these caps.
- Chronicle modal: newest 100 events (`ChroniclePanel.js:34`, `326-331`, `570-583`). A full page is roughly 401 timeline elements (one `ul`, 100 `li`, 300 spans) plus summary controls. This is bounded and only built on open/date change.
- Toast: five live notices (`Toast.js:3`, `362-369`); cue captions have a separate cap of three, and agent labels cap at 256 (`257-264`, `388-394`).
- Dashboard tool history: 12 per card; detail candidates: 48 per pass (`DashboardRenderer.js:30-31`, `1029`, `1205`). Card count tracks currently resident agents and removals clean maps/nodes.
- Sidebar rows track currently resident agents; workflow grace state has a 32-entry recent tail (`Sidebar.js:24`, `502-529`). Harbor rows mirror the current repository snapshot rather than append.

Thus “getting slower lately” is not explained by append-only DOM accumulation in these surfaces. Increasing resident agent count still increases Sidebar rebuild cost and Dashboard card/style cost linearly, even though both are bounded by current state rather than history.

## Listener hygiene

- Sidebar uses one delegated click listener for all agent, parent, and workflow controls (`Sidebar.js:306-321`), exactly the right pattern for a replaced large list. Its four DOM listeners have four explicit removals; event-bus subscriptions are symmetrical.
- Dashboard cards attach three persistent listeners per new card (copy, parent, select; `DashboardRenderer.js:592-617`). They are not re-added during patch updates and disappear with the card node. The attention queue instead attaches one closure per item on every queue rebuild (`665-673`); delegate one listener on `attentionEl` to remove churn. The single IntersectionObserver observes/unobserves cards and disconnects on destroy (`298-311`, `1159`, `1291`). No ResizeObserver or MutationObserver churn exists.
- ActivityPanel's 13 add sites versus seven remove sites comprise seven explicitly paired long-lived bindings, four bindings on the owned workdir row, and two per rebuilt building-occupant row (`ActivityPanel.js:573-592`, `743-746`, `2643-2648`, `3557-3590`). Owned/old nodes are removed, so this is not an accumulating listener leak. Delegating occupant activation to the occupants list would eliminate two listeners per row per changed render.
- TopBar's 31 add versus 29 remove sites are mostly paired. The apparent difference is listeners owned by lazily-created/rebuilt nodes (for example the anonymous settings reset action); those nodes are removed on close/destroy. No per-agent row listeners exist. The connection panel's keydown handler is not explicitly removed, but the entire panel is removed at destroy (`1069`, `1383-1388`), so it is collectable.
- Chronicle creates three listeners per page (date, Markdown, CSV; `ChroniclePanel.js:500-516`) and replaces the whole page on date change. They are collectable with detached nodes, but delegation to stable modal content would reduce churn. Toast event subscriptions are held as unsubscribe callbacks and all are invoked on destroy (`Toast.js:430-438`).
- `AgentSelection.installSelectionEcho()` intentionally installs two global page-lifetime event-bus listeners without unsubscribe (`AgentSelection.js:62-82`). Its install-once guard prevents multiplication. Per-instance mirrors do unsubscribe (`92-110`).

## Timers, mode hiding, and background tabs

| Surface | Timer | Hidden-mode behavior | Background-tab behavior |
| --- | --- | --- | --- |
| ActivityPanel | Agent details every 2s; building refresh every 5s (`1166-1201`) | Both stop when the panel closes or switches modes. | `visibilitychange` explicitly stops both and performs one refresh/restart on return (`1204-1218`). Best hygiene in scope. |
| DashboardRenderer | Detail fetch every 3s; ambience every 60s (`1085-1103`, `381-400`) | Both stop when Dashboard mode is inactive (`185-197`). | Detail interval remains installed and wakes every 3s, although `_fetchAllDetails()` immediately returns on `document.hidden`; ambience interval also remains installed while Dashboard is active. Visibility return triggers refresh (`200-205`). Low CPU cost but unnecessary wakeups. |
| TopBar | Clock every 1s; stale retry every 1s while stale (`1045-1056`, `1255-1262`) | Shared UI, so mode hiding is not applicable. | No `visibilitychange`; both continue to schedule in background (subject to browser throttling). The clock writes text every second even if `world.activeTime` is unchanged. |
| Sidebar | rAF batching; workflow prune; selected-detail probes at 0.5/1/3s | Shared UI remains visible in both modes. | rAF naturally pauses in background. Timeouts remain scheduled but are bounded/cancelled on destroy. |
| Toast / SessionDetailsService | Short dismissal/removal and request timeouts | Toasts remain global. | Browser throttles them; all handles are cleared during removal/destroy. |

## CSS cost findings

### Quantified declarations

| CSS file | `filter` | `backdrop-filter` / `blur()` | `box-shadow` | `text-shadow` | `will-change` | keyframes | infinite-animation declarations | containment |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `activity-panel.css` | 0 | 0 | 9 | 3 | 0 | 3 | 2 | 2 `contain` |
| `character.css` | 0 | 0 | 3 | 2 | 0 | 0 | 0 | 0 |
| `dashboard.css` | 2 | 0 | 27 | 4 | 0 | 6 | 7 | 2 `contain`, 1 `content-visibility` |
| `layout.css` | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| `modal.css` | 0 | 0 | 3 | 1 | 0 | 4 | 0 | 0 |
| `reset.css` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `sidebar.css` | 0 | 0 | 26 | 4 | 0 | 5 | 8 | 1 `contain` |
| `topbar.css` | 2 | 0 | 17 | 4 | 0 | 5 | 4 | 0 |

Static gradients/shadows add paint complexity but are not per-frame by themselves. The important distinction is animation property:

- Compositor-friendly: opacity pulses on ActivityPanel selected bar/hero aura (`activity-panel.css:57-107`), TopBar connection/offline indicator (`topbar.css:188-193`, `320-325`), Dashboard status dots (`dashboard.css:674-690`), Sidebar status dots (`sidebar.css:245-295`), and transform rotation on the working caret (`sidebar.css:330-334`). Modal/toast/mode entrance animations use transform/opacity and are short-lived (`modal.css:9-40`, `114-150`; `layout.css:87-93`).
- Paint every frame: selected Sidebar row and working Sidebar row animate multi-layer `box-shadow` (`sidebar.css:203-218`, `301-310`); selected Dashboard card animates multi-layer `box-shadow` (`dashboard.css:462-480`); stale TopBar chip and one-shot project error flash animate `box-shadow` (`topbar.css:248-269`; `dashboard.css:235-241`). These are the highest-value CSS targets because cost scales with live/selected rows/cards.
- Paint every frame over larger areas: TopBar rail, reconnect sweeps, Dashboard offline shimmer, reconnect sweep, and skeleton shimmer animate `background-position` (`topbar.css:52-57`, `339-344`; `dashboard.css:396-423`, `890-898`). The topbar rail is permanent and full-width; offline shimmer is duplicated over every card; first-fetch skeleton is three animated lines per loading card.
- Layout each animation frame: Dashboard health segments transition `flex-grow` (`dashboard.css:201`), which reflows the health bar for 240ms on status mix changes. Toast container transitions `right` (`modal.css:96`) and therefore lays out/paints for 160ms when ActivityPanel opens. No permanent `top`, `left`, `width`, or `height` animation was found. The `transition: all` declarations (`modal.css:68`, `topbar.css:686`) are broad but apply to small interactive controls, not perpetual update loops.
- Filters: offline state filters the TopBar once and every Dashboard card (`topbar.css:315-316`; `dashboard.css:378-380`); the card building emblem uses a small `drop-shadow` (`dashboard.css:456`). Filters can allocate offscreen surfaces, especially one per card, but they are conditional/static rather than continuously animated. There are no large blur radii.
- Positive containment: dashboard sections use `contain: layout style` plus `content-visibility: auto` (`dashboard.css:53-54`); cards, Sidebar rows, and ActivityPanel list items also use layout/style containment. This limits reflow propagation. No `will-change` over-allocation exists.
- Selector complexity is low. The one `:has()` selector is `body:has(#worldGrammar:popover-open) #topbarWorldControls` (`topbar.css:667`) and reacts to a single popover state; it is not a broad row-matching hot path. Other combinators/attribute selectors are shallow. Universal selectors are confined to reset rules (`reset.css:1`, `136`).
- Reduced-motion rules disable essentially all perpetual motion. That is good accessibility behavior but not a general performance policy for default users.

## First-paint contribution

All eight stylesheets are ordinary `<link rel="stylesheet">` elements in `<head>` (`index.html:11-18`), so all block first render regardless of initial mode.

| Stylesheet | Raw bytes | `gzip -c` bytes | Needed for initial World chrome? |
| --- | ---: | ---: | --- |
| `reset.css` | 4,773 | 2,019 | Yes |
| `layout.css` | 2,794 | 1,147 | Yes |
| `topbar.css` | 22,201 | 5,500 | Yes |
| `sidebar.css` | 16,473 | 3,605 | Yes |
| `character.css` | 4,743 | 1,458 | Yes for World |
| `modal.css` | 10,188 | 2,401 | Modal is hidden, but this file also owns potentially early toasts |
| `dashboard.css` | 31,074 | 6,297 | No for initial World |
| `activity-panel.css` | 31,642 | 5,398 | No while no panel is selected |
| **Total** | **123,888** | **27,825** | 8 blocking requests, 4,700 CSS lines |

Deferring only Dashboard and ActivityPanel removes 62,716 raw / 11,695 gzip-proxy bytes (50.6% raw, 42.0% gzip-proxy) from the initial World render-critical CSS. The remaining 61,172 raw bytes are small enough that local transfer and parse should ordinarily be milliseconds to low tens of milliseconds, not 20–30 seconds. The eight-request shape matters chiefly when the event loop cannot serve responses: each is blocking, so any server stall can extend the dark interval. Splitting `modal.css` is only worthwhile if toast rules remain critical and the modal/changelog portion can load lazily.

Because localhost:4000 was unavailable and could not be restarted under the task rules, actual `transferSize`, response timing, stylesheet parse/recalc time, and first-contentful-paint could not be measured. The sizes above are exact on-disk measurements; compressed sizes are reproducible proxies, not claims about current server content encoding.

## Ranked remediations

### 1. Reconcile Sidebar rows by stable keys instead of replacing the whole list

- **Impact:** High for sustained use and large resident fleets. Eliminates O(A) allocation/GC and focus loss on every searchable activity change.
- **Effort:** Medium. Retain project/workflow/agent maps, patch only affected row fields/classes, and move nodes only when grouping/order changes. Keep the existing single delegated click listener.
- **Risk:** Medium; grouping, collapsed workflows, filtering, and ordering are stateful.
- **VISUAL CONSEQUENCE:** None intended. Rows, order, colors, and animations remain identical; keyboard focus and text selection become more stable.
- **Verification:** Instrument `document.createElement` or a local creation counter around 30 synthetic updates; unchanged and current-tool-only updates should create zero row nodes. Test selection, search, workflow collapse, add/remove, project move, and both World/Dashboard views at desktop width.

### 2. Remove search-index revision from the unfiltered Sidebar visual signature

- **Impact:** High/medium, very low allocation change. Tool/file/commit search-field changes currently force a visual rebuild even when no filter is active and no displayed row field changed.
- **Effort:** Low. Include `searchIndex.revision` only when `_filter` is non-empty, or separate search-index invalidation from visual row signatures.
- **Risk:** Low; filtered results must still update immediately.
- **VISUAL CONSEQUENCE:** None. Unfiltered Sidebar looks identical; active search continues to reveal new tool/file/commit matches.
- **Verification:** With an empty filter, update only `currentToolInput` and confirm no list replacement. With a matching filter, confirm the same update adds/removes the row/context correctly.

### 3. Replace perpetual shadow/background animations with compositor-friendly opacity/transform overlays

- **Impact:** Medium/high GPU/paint reduction, especially with many working Sidebar rows, a selected Dashboard card, loading cards, or offline state.
- **Effort:** Medium. Put a static glow on a pseudo-element and animate its opacity; for shimmers animate a translated pseudo-element rather than background-position; keep status-dot opacity and caret transform as-is.
- **Risk:** Medium because pixel-art glow intensity needs visual matching.
- **VISUAL CONSEQUENCE:** Low. Preserve the same breathing glow/shimmer cadence and colors; minute edge softness may differ. A static-glow fallback has no layout change.
- **Verification:** Compare screenshots at animation endpoints and record DevTools Performance/Paint flashing for 20+ agents. Default motion should show compositor activity with materially fewer paint events; reduced-motion snapshots must remain unchanged.

### 4. Stop Dashboard and TopBar periodic work while `document.hidden`

- **Impact:** Medium for background CPU/battery; low for foreground latency. Removes 3s Dashboard wakeups, 60s ambience wakeups, 1s TopBar clock writes, and stale retry churn in hidden tabs.
- **Effort:** Low. On `visibilitychange`, clear/restart intervals and perform a single catch-up render on return, following ActivityPanel's existing pattern.
- **Risk:** Low; connection age and active-time display must catch up immediately on visibility return.
- **VISUAL CONSEQUENCE:** None while visible. Hidden tabs stop updating pixels nobody can see; values refresh once when shown.
- **Verification:** Monkey-patch/count callbacks or use Performance recordings across hide/show. Assert zero callback executions while hidden and correct clock/connection/dashboard details immediately after return.

### 5. Avoid O(A) synchronous geometry scans after structural Dashboard renders

- **Impact:** Medium for large fleets and status churn; removes `A + 1` post-write rect reads and reduces risk of long synchronous frames.
- **Effort:** Low/medium. Let IntersectionObserver populate visibility, seed only newly-created/selected/active cards, or defer a single initial scan to the next rAF after paint. Preserve the 48-detail candidate limit.
- **Risk:** Medium: details for initially visible cards must not be delayed or omitted.
- **VISUAL CONSEQUENCE:** None. At worst, tool history could appear one frame later if seeding is deferred; design verification should keep that below perceptibility.
- **Verification:** Test initial Dashboard entry, scrolling, add/remove, and status reorder with >48 cards. Confirm visible/selected/active candidates fetch correctly and no synchronous `getBoundingClientRect` loop appears in the structural render task.

### 6. Signature-guard and delegate the Dashboard attention queue; delegate building occupants/Chronicle controls

- **Impact:** Low/medium allocation and listener churn reduction. Most useful during status churn or building monitoring.
- **Effort:** Low. Cache a queue signature and use one click listener on the stable container; apply the same `closest()` delegation pattern already used by Sidebar.
- **Risk:** Low; dataset IDs must resolve against current world state rather than stale closures.
- **VISUAL CONSEQUENCE:** None. Same controls and ordering; focus is more stable because unchanged buttons remain mounted.
- **Verification:** Repeated unrelated structural renders must create zero queue nodes/listeners. Test click/Enter/Space behavior, removal during interaction, and Chronicle date/export controls.

### 7. Make mode-specific CSS non-blocking after critical World chrome

- **Impact:** Medium for first paint under slow/stalled serving; removes 50.6% of raw CSS from the initial World critical path and two blocking requests.
- **Effort:** Medium in a zero-build app. Load `dashboard.css` before revealing Dashboard and `activity-panel.css` before opening the panel; keep reset/layout/topbar/sidebar/character critical. Consider splitting toast rules from otherwise-lazy modal rules.
- **Risk:** Medium: an immediate mode switch/panel open can flash unstyled content unless visibility is gated until the stylesheet's `load` event. No bundler is needed.
- **VISUAL CONSEQUENCE:** None after load; implementation must explicitly prevent any dashboard/panel/modal flash. Initial World pixels are unchanged and can appear sooner.
- **Verification:** Cold-cache network recording: initial World should request/parse only critical CSS before FCP; switch modes/open panel immediately and confirm no FOUC. Compare World/Dashboard/panel screenshots at >=1280px. Do not add responsive/mobile work.

### 8. Change health-bar `flex-grow` and toast-container `right` motion to transforms

- **Impact:** Low/medium; removes short layout-on-every-frame transitions.
- **Effort:** Medium for health segment geometry; low for toast container (`transform: translateX(...)`).
- **Risk:** Low/medium for exact proportional segment layout.
- **VISUAL CONSEQUENCE:** Low. Preserve the same 240ms bar growth and 160ms toast glide; transforms may alter subpixel edge rendering by less than a pixel.
- **Verification:** Paint/layout timeline during a status mix change and panel open. There should be no repeated Layout events during the transition; endpoint screenshots must match.

## Ruled out

- No unbounded activity, chronicle, toast, tool-history, narration, relationship, or message DOM feed.
- No virtualisation gap at current list caps; Chronicle's 100-event page is bounded and modal-only. Sidebar/Dashboard scale with current resident agents, where keyed reconciliation/content visibility are the appropriate tools.
- No routine `innerHTML` rebuild in ActivityPanel, TopBar, or Sidebar. Dashboard's two `innerHTML` assignments are creation-time templates, not per-update replacements.
- No forced-layout read in ActivityPanel or Sidebar, and no per-row alternating layout read/write loop in the ordinary 2-second update path.
- No ResizeObserver or MutationObserver churn in scope. Dashboard uses one shared IntersectionObserver with proper unobserve/disconnect.
- No `backdrop-filter`, `blur()`, or `will-change`; GPU-memory over-promotion is not present.
- No permanent animation of `top`, `left`, `width`, or `height`. The only continuous transform animation is a tiny caret rotation; opacity pulses are compositor-friendly. The problematic continuous effects are paint-bound shadows/background-position.
- CSS selector complexity is not a leading concern: one narrow `:has()` selector, shallow combinators, and reset-only universals.
- Modal/Toast entrance motion and mode fade use transform/opacity and are short-lived; they are not sustained-cost suspects.
- Desktop-only policy was respected: no responsive/mobile/media-query remediation is proposed. Existing `prefers-reduced-motion` accessibility queries are unrelated to viewport responsiveness.
- No bundler, transpiler, framework, or build pipeline is needed for any remediation.
