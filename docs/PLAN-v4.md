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

## The phone (2026-10-25)

The phone is the handheld camera and nothing else. Its HUD keeps only what an operator needs while
shooting: the shot name + lens as one quiet label, a connection dot, the shutter, record, a camera
button, recenter as an icon, the joystick and height slider without captions, captions for lines, and
the rotate prompt. Gone from the frame: the room code (start screen only), "live · director
connected", heading/tilt/roll readouts, the drag/pinch hint (one toast on first run), "walk · 2× tap",
the fps readout (`?perf=1`), the ACTION / Line › text buttons (one play/pause icon). The **camera
button opens a small popover** listing the scene's shots (number · name · lens, the attached one
marked), "Free (handheld)", and **"Add shot from here"**, which places the phone's current perspective
as a new shot on both the laptop's shot list and the phone (`PhoneCommand` `select-camera` /
`add-shot`; the laptop owns the list and broadcasts `SceneState.cameras`).

**Result (P1).** As above. Picking a shot on the phone is clicking its Shots row; Handheld keeps the
view where it stands; Add shot from here is the laptop's Add shot at the phone's pose and lens (frame
grabbed). Hold play = next line; a sideways swipe on the label steps through the shots. Evidence:
`docs/images/phone-minimal-before-after.png`, `phone-camera-popover.png`, `phone-add-shot.png`.

## Dynamic scenes (2026-10-25)

Every moving thing in the action lines is background action in any genre: an animal or monster is a `creature` whose label names the species, aircraft are `airplane` / `helicopter`, each with a label-driven body (`web/src/viewer/props-more.ts`) and standard paths near the actors (`server/pipeline/dynamics.ts`), and the chat's free `dynamics` patch ("add a dinosaur walking by in scene 1", "remove the dinosaur") rewrites the manifest and swaps the open scene's props live.
**Result (D1).** `tests/e2e/dynamics.spec.ts` (MOCK); evidence `docs/images/dynamics-dinosaur-airplane.png`, `dynamics-chat.png` and three new rows in `genre-props.png`.

## Props by import or by prompt (2026-10-25)

Besides the procedural kinds, a director can put their own object in the scene: **Import a 3D model**
(a .glb dropped on the viewport or picked in Scene › Background › Add prop) or **Generate from a
description** ("a weathered wooden barrel"). Generation = a reference image of the object on a plain
background (OpenAI image) → image-to-3D on Modal (an open-source model that returns a textured glTF
binary) → `props/<jobId>/model.glb`; `PropJob` reports progress; MOCK / no keys returns a bundled sample
after a short delay. Either way the prop lands as a `prop-add` scene edit of kind `model`
(`DynamicElement.model`), static (one-point path, speed 0), 2 m in front of the camera on the ground,
scaled to `heightM`; it is then an object like any other: drag, scale, delete, Re-prompt, phone sync.
Also: a **Reset** button beside Play (clock to 0:00, everyone back on their marks, start view; key 0).

## Found models (2026-10-25, branch `feature/found-models`)

During generation, every piece of background action keeps its procedural kind and may gain a real
model: the server looks the label up in a local index of open-licence models (Objaverse: no API key,
~800k objects with animation count, face count, licence and names; optionally Sketchfab / Poly Pizza when
a token is present), downloads the best match within a budget (index lookup is local; download ≤ 15 s
and ≤ 15 MB, run alongside the world stage so it never extends the critical path), caches it in a shared
model library (`data/models-library/<id>/`, served at `/models/<id>/…`), and attaches it as
`DynamicElement.model` with its licence and attribution. Selection rules: creatures and characters need
an animated model (clips); vehicles, aircraft, UFOs and props accept static meshes and move rigidly with
named parts spinning (wheel, rotor, propeller). The viewer drives a found model's clips by intent (idle /
move / fast, speed-matched to the path, blended) and falls back to the kind's procedural body when the
model is missing, fails to load, or a creature has no clips. MOCK and `FOUND_MODELS=0` skip the lookup.

**F2 viewer (2026-10-25).** `web/src/viewer/found-model.ts` draws `model` on any kind: primitive first, swapped on load (≤ 15 MB, shared per URL, spec/gloss materials read), scaled to `heightM` or the primitive, facing from part names → root motion → shape (verified on 20 Objaverse models), clips by name speed-matched to the path (distance-driven, 0.3 s idle cross-fade), wheels / rotors turning on rigid kinds, the primitive kept for a creature without a clip for what it does. Background and Objects show licence + attribution, Use primitive and Turn around (localStorage until a scene-edit field exists). Evidence `docs/images/found-models-gallery.png`, `found-models-fallback.png`; `tests/e2e/found-models.spec.ts`.
Measured: 5–51 ms per model load on the laptop; uncapped 649 / 699 fps with six found models vs 673 / 730 with their primitives (two runs, ~4 %).

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

**Q1 props (2026-10-25).** Scene › Background › Add prop imports a .glb (file picker or a drop on the view) or generates one from a description: an OpenAI picture, then TripoSR on a Modal L4 (`worker/run_prop.py`), levelled, with a polled job row; MOCK returns the bundled barrel. Either way the prop becomes a `prop-add` of kind `model` 2 m in front of the camera on the ground, undoable, and the phone draws it (`tests/e2e/props.spec.ts`; evidence `docs/images/prop-import.png`, `prop-generated.png`).
Live: "a weathered wooden barrel" took 263 s (cold start; about 6 s of GPU work) and cost about $0.08. Not done: Re-prompt does not edit model props, and nothing keeps a container warm.

**F1 found models, server (2026-10-25).** `fixtures/models/index.json.gz` (42,597 CC0 / CC-BY / CC-BY-SA Objaverse objects, 3.0 MB, `scripts/build-model-index.ts`) and `server/pipeline/models.ts` (+ `model-vocab.ts`: families, synonyms, LVIS, height priors) attach `DynamicElement.model` in the manifest step. The lookups start with the world stage; the budget is 20 s; creatures need clips and a skeleton; the files are served at `/models/<uid>/`. Bench, 20 labels from a cold library: lookup p50 1.2 ms, download p50 0.48 s / p95 0.67 s, 20 / 20 found, 9 / 10 creatures rigged on the first choice.
In MOCK with `FOUND_MODELS=1`, the T. rex / UFO / sports car / airliner screenplay had its manifest 1.6 s after the POST, all four attached; the chat's added helicopter got its model 0.8 s after the message. Not done: drawing the models (F2), a Sketchfab or Poly Pizza search when the index misses, and a length prior for vehicles.

Not done, or done differently: **walk-to** is not in the cast rows (the viewer has no way to send
an actor along a path yet; it needs a blocking-path contract). Frames for the seeded coverage are
grabbed by visiting each shot with the main view (when the Shots mode first shows them, from
"Grab N frames", or before an export), not rendered off-screen, because a second view would need
its own splat sort. A shot's own depth of field still lives in the laptop's browser storage, and a
phone already on a shot keeps its own pinch lens when the shot's lens changes.
