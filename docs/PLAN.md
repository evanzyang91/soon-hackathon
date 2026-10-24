# Previz Stage — screenplay → walkable 3D scenes you can film with your phone

## Goal

Paste a short-film screenplay. Get one immersive 3D scene per screenplay scene. Fly around it on a
laptop, drop virtual cameras, and pair an iPhone (browser, no app install) that acts as the
handheld camera: pan/tilt/roll from the phone's sensors, slight handheld movement from the
accelerometer, and its position/frustum visible on the laptop. Actors from the screenplay exist in
the world as 3D avatars generated through the same process OrbisEngine uses (LHM on Modal from a
reference image → gaussian-splat avatar), and speak their lines out loud so you can film a take
before going on location.

## Non-negotiables

- Everything the user touches runs in a browser (laptop: Chrome; phone: iOS Safari / Android Chrome).
- Real Marble + Modal + Claude + TTS when keys are present; a `MOCK=1` mode that exercises the
  entire pipeline with local fixtures so tests never need credits.
- Every piece verified: vitest unit tests, Playwright e2e with two browser contexts (laptop + a
  simulated phone with injected `deviceorientation` events), and a final verification loop.

## Architecture

```
screenplay.txt/.fountain
        │  POST /api/projects (text)
        ▼
 server/pipeline/screenplay.ts   Claude → ScenePlan[] (zod validated)
        │                        setting prompt, time of day, actors + lines, blocking,
        │                        dynamic elements (car drive-by loop, etc.), suggested shots
        ▼
 server/pipeline/marble.ts       World Labs Marble text→world (marble-1.1), receipts, poll,
        │                        download SPZ(500k + full) + collider GLB + semantics
        ▼
 server/pipeline/actors.ts       character description → reference image (OpenAI image) →
        │                        Modal LHM (ported from OrbisEngine worker/modal_lhm.py) →
        │                        animated gaussian PLY sequence (talk/idle loop)
        │                        fallback: rigged GLB humanoid w/ viseme morphs
        ▼
 server/pipeline/tts.ts          every dialogue line → mp3 (OpenAI tts / ElevenLabs), cached
        ▼
 data/projects/<id>/scene-<n>/manifest.json   (shared/schema.ts SceneManifest)

 server/index.ts     HTTPS (self-signed, required for iOS sensors) static + /api + WS relay
 server/relay.ts     rooms: laptop creates room → QR → phone joins; phone streams PhonePose
                     @ 30 Hz; laptop streams SceneState (scene id, time, drop cams) to phone

 web/ (Vite + three + @sparkjsdev/spark)
   /           laptop director: scene list, pipeline progress, fly (WASD+mouse), drop
               cameras, phone frustum gizmo + PiP of phone view, take recorder (WebM)
   /phone      phone camera: pairing, sensor permission, renders scene from phone pose,
               shutter/record, pinch-zoom focal length, "re-center" button
   shared viewer: world loading (SPZ, metric transform: scale, ground y=0, 180° X flip),
               actors (splat sequence or GLB), dynamics (looped GLB props on paths), audio
```

### Coordinate conventions (from OrbisEngine + Marble docs)

- Marble SPZ is OpenCV (Y down, +Z forward). Apply `world.rotation.x = Math.PI` so Y is up.
- `metric_scale_factor` converts units → meters; floor world-y = `-ground_plane_offset / metric_scale_factor`
  before the scale is applied (Orbis `fourd-runtime.js`). We scale the world object so 1 unit = 1 m
  and translate so the floor sits at y = 0.
- Actors are placed with feet on y = 0; blocking positions are meters in the world frame, origin at
  Marble's source camera.
- `WorldAsset.scaleCalibration.factor` (server/pipeline/calibrate.ts) multiplies Marble's scale
  (S = factor × msf, ty = factor × gpo, floor still at y = 0). It is measured after download from
  collider references and Claude vision with 1.70 m mannequins; absent or 1 means Marble's scale
  was kept.

### Phone pose model (browser PWA)

- `DeviceOrientationEvent` (alpha/beta/gamma, `requestPermission()` on iOS over HTTPS) →
  quaternion with screen-orientation correction. Yaw is relative: the laptop/phone "re-center"
  sets the current heading as the drop-camera's heading.
- Position = the camera the phone is attached to (dropped on the laptop or dragged) + a
  high-passed, double-integrated `DeviceMotionEvent` accelerometer nudge, clamped to ±0.3 m
  and decayed back, which gives natural handheld sway without drift.
- Phone sends `{t, q:[x,y,z,w], nudge:[x,y,z], fov}` at ≤30 Hz; laptop draws a camera frustum
  gizmo at that pose and a PiP rendered with a second three.js camera.
- Stretch (not in scope now): native ARKit companion sending true 6DoF poses on the same protocol.

### Actors

- Pipeline: Claude writes a physical description per character → OpenAI image model generates a
  full-body, front-facing, neutral-background reference → Modal LHM (`worker/modal_lhm.py`,
  ported from Orbis) builds the gaussian avatar and renders an animated sequence from a bundled
  SMPL-X talking/idle motion → packaged as PLY frames + `sequence.json` (Orbis `wander.person-motion/1`
  compatible) → browser plays the loop with Spark `SplatMesh` per frame.
- Speaking: when a line is triggered (laptop clicks a line, or "play scene" runs the dialogue in
  order), the actor's TTS mp3 plays positional (three.js `PositionalAudio`) while the talk loop
  runs; a caption shows the line. Lip-sync on a splat avatar is out of scope; the GLB fallback does
  viseme-driven jaw/mouth morphs from audio amplitude.
- Fallback when Modal is absent or fails: rigged GLB humanoid (bundled), tinted/labelled per
  character, idle + talk animation clips.

### Dynamics

Marble worlds are static splats. "A car drives by" becomes a `DynamicElement` in the ScenePlan:
a bundled GLB prop (car, bike, bus, bird, …) on a looped spline path with speed, generated by
Claude from the action lines, rendered as a normal three.js mesh composited with the splats.

## Verification loop

1. Each work package ships with vitest unit tests and runs `pnpm typecheck && pnpm test`.
2. `pnpm e2e` (Playwright): starts the server in `MOCK=1`, creates a project from
   `fixtures/screenplay.fountain`, waits for scenes, opens the laptop page, pairs a second context
   as the phone (inject `deviceorientation`), asserts: scene renders (non-black pixels), pose
   reaches the laptop, frustum gizmo moves, PiP updates, an actor speaks (audio element plays),
   a dynamic element moves between frames.
3. Final verifier agent re-runs everything from a clean clone, fixes, repeats until green, then
   does a real-key smoke run of one scene if the keys are set.

## Work packages (parallel, Opus 5.5)

| WP | Owns | Interface it must honor |
| --- | --- | --- |
| A viewer + laptop director | `web/src/viewer/**` (except `actors/`), `web/src/laptop/**`, `web/index.html` | consumes `SceneManifest`, `PhonePose`; calls `createActor()` from WP D |
| B phone + relay | `web/src/phone/**`, `web/phone.html`, `server/relay.ts`, `server/https.ts` | `shared/protocol.ts` |
| C pipeline | `server/pipeline/**`, `fixtures/**`, `MOCK=1` fixtures | writes `SceneManifest`, job API in `shared/api.ts` |
| D actors | `worker/**`, `server/pipeline/actors.ts`, `server/pipeline/tts.ts`, `web/src/viewer/actors/**` | `ActorHandle` in `web/src/viewer/actors/index.ts` |
| E verification | `tests/e2e/**`, `playwright.config.ts`, fixes anywhere | — |

Contracts live in `shared/` and are owned by the lead; WPs propose changes rather than editing them
unilaterally.
