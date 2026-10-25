# Previz Stage v4 — the filmmaker's workflow

Builds on docs/PLAN.md, PLAN-v2.md (look, re-prompting, UX, ARKit), PLAN-v3.md (genres). This document
is the product spine: what a director actually does with a previs tool, in what order, and what the
app must put in front of them at each step. Everything that does not serve that spine moves out of the
way (not deleted: tucked under **Tools**).

## Who uses it and why

A director (or a DP, or a student making their first short) has a script and a shoot coming up. They
want to answer, before anyone builds a set or books a location: *does this scene work on its feet,
where does everyone stand, what are the shots, and can I show the crew?* They think in scenes, marks,
coverage, lenses and a shot list, not in splats, FOV degrees, colliders or revisions.

## The spine: Script → Scenes → Blocking → Coverage → Shoot → Share

| Step | The director's question | What the app shows | Where |
| --- | --- | --- | --- |
| **Script** | What's in this script? | Paste the screenplay; the breakdown comes back as a plan card (cast, locations, day/night, line counts). Change it in words, attach reference photos, press **Generate**. | Left drawer: **Script** (the project chat + the project list) |
| **Scenes** | What does the location look like, at this time of day, in this mood? | One scene at a time in the viewport, already graded with the planner's look. The scene strip in the drawer steps through scenes. | Viewport + drawer |
| **Blocking** | Where does everyone stand and move? | Cast with marks on the ground; drag a mark, set a pose, "walk to"; dialogue plays in place so timing can be felt. Background action (traffic, animals, vehicles) listed and toggleable. | Right panel: **Scene** |
| **Coverage** | What are my shots? | A numbered **shot list**: suggested coverage (wide, two-shot, OTS, close-ups, derived from the actual marks) plus the director's own, each with a frame grab, lens (mm), height and a note. Keys 1–9 jump between shots; **C** adds the current view as a shot. | Right panel: **Shots** |
| **Shoot** | What does it feel like handheld? | Pair the phone (QR), operate: pan, walk, re-center; record takes with dialogue; takes land in the list. | Right panel: **Camera** |
| **Share** | How do I show the crew? | **Export**: a storyboard sheet (PNG / print-to-PDF) with scene heading, shot numbers, frames, lenses and the lines each shot covers; a shot list CSV; the takes as WebM. | Top bar: **Export** |

## What changes on the laptop

**Three modes instead of four tabs.** Scene / Look / Edit / Shoot become **Scene · Shots · Camera**.
The Look and Edit tabs were tools, not steps: the mood presets (the DP's call) move into Scene as a
row of named swatches; the grade sliders, lights, lens (DOF), the scoped re-prompt box with regions,
splat quality, collider, grid, reload and the API-key badge go under **Tools** (a single quiet button
in the top bar, ⌘, or `T`; it opens a drawer over the right panel). Nothing is removed; it stops
competing with the work.

**Scene panel**: heading + day/night + the mood swatch row ("Night street", "Candlelit", …; the
planner's choice marked); **Cast** (name, mark, pose, walk-to, eye line), **Lines** (each line with
play; the playing line highlights; "Play scene" runs them in order with the background action),
**Background** (the moving props, on/off), **Location** (world status in one line; "Change the
location…" opens the chat with the scene pre-targeted). Objects / splat region edits live in Tools.

**Shots panel**: the shot list for the scene, numbered 1A, 1B… (scene number + letter), each row:
frame thumbnail, name, lens, height, note. Suggested coverage appears as the initial list the first
time a scene opens (derived from the actual marks, re-derived when they move); the director edits,
reorders, renames, deletes, adds (**C** = add shot from the view; **F** = re-grab the frame from the
view). Selecting a row flies there; the phone attaches to the selected shot. A frame guide
(16:9 / 2.39) and the shot's name + lens draw over the viewport while a shot is selected.

**Camera panel**: QR + status, re-center, view-through-phone, record / stop, the takes list with
playback and download, the scene clock.

**Vocabulary**: lens in mm (full-frame 35 mm equivalent, from the vertical FOV: f = 12 / tan(vfov/2)
with a 24 mm sensor height; shown as the nearest of 18 · 24 · 28 · 35 · 50 · 85 · 135), camera
"height", "mark", "eye line", "coverage", "take", "frame"; never FOV°, collider, splat, revision.

**Top bar**: project · scene breadcrumb (`The Last Bus · Sc 1 · EXT. CITY STREET – NIGHT`), the
look name, clock + play, **Export**, **Tools**, help. Undo / redo stay on the keyboard.

**First run**: the empty chat says the three steps in one line each (paste a script → review the
breakdown, add photos → Generate), nothing else.

**Keys**: 1–9 shots · C add shot · F frame · Space play · R record · V phone view · Tab next mode ·
T tools · [ drawer · ? help.

## Contracts (lead-owned, `shared/`)

- `shared/shots.ts`: `Shot` { id, name, position, quaternion, fovDeg, heightM?, note?, frame?
  (`shots/<id>.jpg`, project-root relative), lines? (dialogue ids this shot covers), source:
  'suggested' | 'director' }, `ShotList` { version 1, revision, shots[] }, persisted per scene at
  `scene-<n>/shots.json` with GET / PUT (revision-checked, like edits) at
  `/api/projects/:id/scenes/:n/shots`; frames uploaded with
  `PUT /api/projects/:id/scenes/:n/shots/:shotId/frame` (JPEG ≤ 600 KB) and served from
  `/projects/<id>/scene-<n>/shots/<shotId>.jpg`; `GET /api/projects/:id/shotlist.csv` (every scene).
  The storyboard sheet is composed on the laptop (canvas → PNG, print stylesheet → PDF).
- `shared/protocol.ts`: `SceneState.cameras` stays the live shot list broadcast to the phone
  (a `DropCamera` per shot; `activeCameraId` = the selected shot).
- `lensMm(fovDeg)` / `fovDeg(lensMm)` helpers in `shared/lens.ts`.

## Work packages

| WP | Scope | Owns |
| --- | --- | --- |
| U1 design | the visual system (tokens, type, components, icons) on the current structure; U3 builds the new structure with it | `web/src/laptop/*.css`, `web/index.html`, DOM in `web/src/laptop/*.ts`, `web/phone.html` |
| U2 bugs | stale chat examples on + New; shots derived from the actual marks (`web/src/viewer/shots.ts`); start camera frames the cast | `chat-panel.ts` (hero / + New), `scene-panel.ts` (shots), `director.ts`, `web/src/viewer/shots.ts` |
| U4 shots server | `shots.json` store + routes, frame upload, `shotlist.csv`, MOCK green | `server/pipeline/shots.ts`, `routes.ts` registration, `shared/api.ts` helpers (lead-approved) |
| U3 streamline | the three modes, Tools drawer, shot list panel with frames + lens + numbering + reorder, frame guide, Export (storyboard PNG / print PDF, CSV), vocabulary, keys, first-run copy, README "How a filmmaker uses it" | `web/src/laptop/**` (after U1 + U2 merge), `web/src/viewer/` overlays |
| V verify | e2e: shot list persists + exports; before/after walkthrough screenshots of the whole spine | `tests/e2e/shots.spec.ts`, `docs/images/flow-*` |

## Result

**U3 (2026-10-25).** The laptop follows the spine. The right panel is **Scene · Shots · Camera**
(Tab steps through them); **Tools** (`T`) is a drawer over it holding Grade (the Look panel),
Re-prompt (the Edit panel), Objects and Developer (splat quality, grid, collider, reload, the
world's scale / ground details, the API-key badge), unchanged inside. Scene shows the heading, a
scene strip, the eighteen moods as swatches (the planner's choice marked, Scene's look first), the
cast with height / pose / eye line / mark, the lines (play in place, Play scene, the shots covering
each line), the background props with on / off and the location with "Change the location…" (the
chat composer focused on the scene). Shots is the scene's `shots.json` (seeded once with coverage
framed on the cast, Refresh coverage, rename / note / lens / lines in place, reorder by drag or
up / down, duplicate, delete with ⌘Z, revision-checked saves that replay on 409) and the phone's
camera list; selecting a shot (click, 1–9) flies there behind a 16:9 / 2.39 frame guide with a
`1B · Two-shot · 35 mm` label, C adds the view as a shot and F re-grabs a frame (the guide's part
of the next rendered frame, ≤ 960 px JPEG). Camera keeps pairing, record and the clock and lists
the session's takes. Export makes the storyboard sheet (PNG at 2400 px, or a print page for PDF)
and links the CSV. The UI speaks in lenses (mm), shots, frames, coverage and marks.
Evidence: `docs/images/flow-1-script.png` … `flow-6-export.png`, `flow-tools.png` (GPU Chromium,
1440×900, MOCK, the western fixture); `tests/e2e/shots.spec.ts`.

Not done, or done differently: **walk-to** is not in the cast rows (the viewer has no way to send
an actor along a path yet; it needs a blocking-path contract). Frames for the seeded coverage are
grabbed by visiting each shot with the main view (when the Shots mode first shows them, from
"Grab N frames", or before an export), not rendered off-screen, because a second view would need
its own splat sort. A shot's own depth of field still lives in the laptop's browser storage, and a
phone already on a shot keeps its own pinch lens when the shot's lens changes.
