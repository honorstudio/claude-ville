# Visual Experience Crafting

This note is for an agent building a visual representation layer for a different product, dataset, or operational domain. The useful idea to transfer is not "make it look like ClaudeVille." It is: turn abstract system state into a readable place, give entities bodies, give work locations, and keep the dense UI separate from the world metaphor.

The best result should feel like a tiny game board that explains the data before the user reads a table.

ClaudeVille's specific scenery is a fantasy village, but the transferable unit is the contract: durable concepts become places, active records become embodied actors, recent events become temporary effects, and dense truth stays in DOM panels. A different product can become a space station, harbor, factory floor, clinic, newsroom, research campus, or logistics map without copying a single ClaudeVille building.

## 1. Start With The World Model

Before drawing anything, decide what the world means.

- The world is the full system or bounded context.
- Buildings are durable concepts: queues, workflows, teams, assets, services, data sources, risk categories, accounts, or lifecycle stages.
- Characters are active entities: users, agents, jobs, sessions, transactions, alerts, tasks, devices, or records currently moving through the system.
- Terrain is ambient context: groups, regions, environments, load, health, time of day, or background capacity.
- Roads show relationships: dependency paths, handoffs, escalation routes, deployment flow, approval chains, or data movement.
- Particles and small effects show recent activity: execution, errors, messages, retries, progress, cache hits, or fresh data.

Keep the mapping stable. If a building means "review queue" today, it should not mean "failed jobs" tomorrow. Users learn the visual language through repetition.

## 2. Build A Data-To-Place Contract

Write the contract as a small table before implementation:

| Data concept | Visual form | Why it fits | Interaction |
| --- | --- | --- | --- |
| Long-lived category | Building | Stable destination and landmark | Hover, click, filter |
| Active entity | Character | Has identity, status, motion | Select, follow, inspect |
| Relationship | Road/path | Connects destinations | Highlight on selection |
| Recent event | Particle/effect | Temporary, low-cost signal | Usually passive |
| Dense detail | DOM panel/card | Text-heavy and accessible | Sort, scan, copy |

This prevents the metaphor from becoming decoration. Every visual element should answer a real question:

- What exists?
- Where is it?
- What is it doing?
- What changed recently?
- What needs attention?

## 3. Separate Canvas And DOM Responsibilities

Use canvas for the embodied, spatial, animated layer:

- terrain
- buildings
- character sprites
- motion
- depth sorting
- particles
- minimap or camera overlays
- low-level hit testing

Use DOM for structured information:

- dashboards
- detail panels
- tables
- cards
- forms
- filters
- keyboard-friendly controls
- long text, copyable values, and accessible labels

The canvas should communicate state at a glance. The DOM should let the user verify, inspect, and act. Do not force canvas to become a table renderer, and do not force DOM cards to carry the whole visual metaphor.

A good implementation shape is:

- domain state lives outside rendering
- a world adapter turns domain state into buildings, characters, relationships, and events
- the canvas renderer subscribes to changes and animates toward them
- the DOM renderer subscribes to the same state and renders precise details
- selection state bridges the two layers

## 4. Use A Clear Visual Grammar

Visual grammar is the set of rules users can infer without reading documentation.

Recommended rules:

- Shape identifies kind: buildings, people, paths, effects, panels.
- Color identifies family or provider, not every possible state.
- Motion identifies active behavior.
- Glow identifies attention or freshness.
- Size identifies importance only when importance is real.
- Labels are sparse and reserved for landmarks or selected objects.
- Depth order follows world position, usually lower Y draws later.
- Hover and selection use the same visual vocabulary everywhere.

Avoid overloading one cue. If red means "error", do not also use red as a provider color. If pulsing means "waiting", do not also use it for success.

## 5. Make Identity Cues Layered

Entities need to be recognizable at three distances:

- Far away: broad family color, silhouette, or building destination.
- Medium distance: accessory, trim, animation, or status ring.
- Close inspection: name, provider badge, model/type, role, exact status.

For provider or entity families, use a profile object rather than one-off drawing conditionals scattered through the renderer. A profile can define:

- palette
- outline and shadow
- clothing/body style
- accessory set
- accent marks
- eye or face style
- hand prop or tool symbol
- status treatment

Then make individual variation deterministic from entity identity. Hash the stable id plus provider/model/type and use that hash to pick small variants. This keeps characters distinct without making them random on every load.

## 6. Prefer Old-School RPG Constraints

The old-school RPG style works because it is constrained, symbolic, and readable.

Useful constraints:

- Use a limited palette with strong outlines.
- Favor simple geometric construction over photorealism.
- Keep sprites small and exaggerated.
- Use pixel/crisp rendering where appropriate.
- Let tiny props carry meaning.
- Build landmarks with recognizable silhouettes.
- Add ambient details sparingly: grass specks, water shimmer, torches, smoke, footsteps.
- Use a fixed camera grammar: pan, zoom, follow selected entity.
- Use a minimap when the world can exceed one screen.

This style tolerates abstraction. A "forge" does not need to literally be a software compiler, but users can quickly learn that it means active production work. A "mine" can mean quota, resource extraction, backlog excavation, or capacity burn if the rest of the system reinforces that meaning.

## 7. Map Behavior To Movement

Movement should explain state transitions:

- Working entities move toward the place where that work belongs.
- Idle entities wander in safe, low-salience areas.
- Waiting entities pause, pulse, or hover near a queue.
- Communicating entities move toward each other or show a shared effect.
- Failed entities stop, dim, flash, or route to an exception landmark.
- Completed entities leave the board or settle into an archive/completed area.

Do not animate everything all the time. Motion is expensive attention. Use it to show active work, recent change, or selected context.

## 8. Design Buildings As Semantic Landmarks

A building should communicate its purpose before the label is read.

For each building define:

- type id
- tile position
- footprint
- label
- core colors
- roof or silhouette
- one or two semantic decorations
- optional interior
- optional activity effects

Examples of transferable landmark metaphors:

- command center: overview, routing, orchestration
- forge/workshop: creation, mutation, builds, processing
- mine: resource usage, quota, extraction, backlog, cost
- archive/library: documents, memory, records
- observatory/tower: monitoring, alerts, external data
- market/exchange: flows, trades, matching, supply/demand
- clinic/repair shop: failures, retries, remediation
- council hall: communication, approvals, review

The label helps, but the silhouette should do the first half of the work.

## 9. Keep The World Legible Under Load

Plan for too many entities early.

Tactics:

- group entities by project, team, region, or state
- cap visible particles
- aggregate low-priority entities into clusters
- let the user follow or pin one entity
- fade labels until selected or hovered
- sort by Y for depth
- draw only visible terrain tiles
- keep hit testing simple and predictable
- use a detail panel instead of crowding text into the canvas

The canvas should remain a map, not a confetti layer.

## 10. Progressive Refinement Workflow

Build the visual experience in layers:

1. Define the semantic mapping in writing.
2. Render static terrain and landmarks.
3. Place entities without animation.
4. Add selection and a detail panel.
5. Add deterministic identity variation.
6. Add movement that reflects real state.
7. Add status cues and recent-event effects.
8. Add camera controls and minimap.
9. Add dashboard/card mode for dense scanning.
10. Tune the palette, spacing, labels, and empty states.

At each step, ask whether the visual makes the data easier to understand. If not, remove or simplify it.

## 11. Scenery Adaptation Brief

Before generating assets for a new scenery, write a brief with these fields:

| Field | Decision |
| --- | --- |
| Domain | What system, dataset, or workflow the world represents. |
| Scenery metaphor | The place users will recognize: station, harbor, factory, campus, clinic, newsroom, fleet, market. |
| Durable landmarks | The stable categories that deserve buildings or large props. |
| Active actors | The moving entities users need to track. |
| Movement rules | Where actors go for work, waiting, failure, communication, and completion. |
| Attention rules | What earns glow, pulse, particles, labels, or camera focus. |
| Dense-detail surface | The DOM panel/card/table that carries exact text and actions. |
| Asset system | Manifest shape, path contract, sprite sizes, anchors, palette rules, and cache-busting version. |
| Validation | Empty, normal, overloaded, unknown-type, reduced-motion, and asset-missing checks. |

Do not generate art before this brief exists. Asset generation should fill a semantic plan, not discover one by accident.

## 12. Common Pitfalls

- Decorative metaphor: the world looks charming but does not answer real questions.
- Unstable mapping: users cannot learn the meaning because visuals change too often.
- Too many colors: provider, status, severity, and category all compete.
- Too much motion: the eye cannot tell what matters.
- Canvas-only details: text, controls, and accessibility suffer.
- DOM-only world: the interface becomes cards with a themed background instead of an embodied system.
- Random identity: entities look different on every reload.
- Label clutter: every object speaks at once.
- Poor depth rules: sprites appear in front of objects they should be behind.
- Hidden data loss: aggregation hides critical outliers or errors.
- No empty state: the world looks broken when there is simply no data.
- Asset-first planning: generated scenery dictates the product model instead of expressing it.
- Tool lock-in: the renderer assumes one generation provider instead of a manifest/path contract that another tool could satisfy.

## 13. Validation Checklist

Functional validation:

- The same data produces the same identity cues across reloads.
- Every entity can be selected and inspected.
- Selection in the world updates the DOM detail view.
- DOM actions or filters update the world consistently.
- Empty, small, normal, and overloaded datasets all render.
- Unknown providers or types fall back gracefully.
- Canvas hit targets match what the user sees.
- Camera pan, zoom, and follow do not trap the user.

Visual validation:

- The first screen communicates what kind of system this is.
- Landmarks are distinguishable without labels.
- Status is readable at a glance.
- Important motion is visible but not exhausting.
- Text does not overlap or become unreadable.
- The canvas fills its intended container.
- Dense dashboard mode remains scannable.
- The experience works at laptop and large-monitor sizes.

Performance validation:

- Rendering only draws visible terrain where possible.
- Particles are capped and cleaned up.
- Animation work stops when the mode is hidden.
- Event subscriptions are removed on teardown.
- Large datasets degrade through clustering or filtering.

Accessibility validation:

- Critical information also exists in DOM text.
- Keyboard users can reach equivalent detail views.
- Color is not the only status cue.
- Motion is not required to understand state.
- Labels and controls remain readable at expected zoom levels.

## 14. Implementation Checklist

Use this as a starting blueprint:

- Create a world adapter that converts raw records into landmarks, entities, relationships, and events.
- Define stable visual profiles for each provider, entity family, or source family.
- Add deterministic variant selection from stable ids.
- Build a canvas renderer with explicit update and render phases.
- Keep terrain, buildings, entities, particles, camera, and minimap as separate modules.
- Sort moving entities by screen Y before drawing.
- Add hit testing for selectable entities and landmarks.
- Keep dense information in DOM cards, panels, or tables.
- Share selection state between canvas and DOM.
- Add graceful fallbacks for unknown types.
- Add lifecycle cleanup for animation frames, listeners, subscriptions, and particles.
- Validate with no data, one entity, many entities, and mixed providers.

## 15. The North Star

The goal is not to gamify the product for its own sake. The goal is to give data a memorable spatial structure.

When it works, users can say:

- "That job is stuck near the repair shop."
- "The review queue is crowded."
- "The Codex-like entities are working in the forge."
- "The alert came from the observatory."
- "This project is quiet; that one is busy."

That language is the sign that the visual layer has become a thinking tool, not just a skin.
