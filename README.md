# Previz Stage

Paste a short-film screenplay and get one walkable 3D scene per screenplay scene: a World Labs
Marble gaussian-splat world, the characters standing in it as LHM gaussian avatars (or a tinted
mannequin), their dialogue voiced with TTS, and moving props for the action lines ("a red sedan
drives past"). Fly around the scene on the laptop, drop virtual cameras, then pair a phone in its
browser (no app) and use it as the handheld camera: its orientation sensors pan, tilt and roll
the shot, its accelerometer adds handheld sway, and its frustum and live view appear on the
laptop while the actors speak their lines.

![Real pipeline, scene 0: a Marble street, the LHM avatar for MAYA and the THEO mannequin](docs/images/real-pipeline-scene-0.png)

## Architecture

```
 screenplay (.fountain / text)
        │  POST /api/projects
        ▼
 server/pipeline/  ── per project, every stage idempotent and resumable after a restart ─────────┐
   screenplay.ts   Claude (claude-opus-5-5) → ScreenplayPlan: scenes, characters, dialogue,     │
                   blocking, moving props, suggested shots           (offline parser in MOCK)  │
   marble.ts       world prompt → Marble text→world, receipt-first (a crash never pays twice)   │
                   ↳ world-library.ts: reuse data/marble/<slug without INT./EXT.>              │
   actors.ts       description → OpenAI reference image → LHM on Modal L4 (worker/) →          │
                   splat sequence; any failure → procedural mannequin (marked fallback)        │
                   ↳ actor-library.ts: reuse data/actors-library/<characterId>                 │
   tts.ts          each line → mp3 (ElevenLabs or OpenAI gpt-4o-mini-tts); beeps offline       │
   project.ts      orchestration → <DATA_DIR>/<id>/scene-<n>/manifest.json (shared/schema.ts) ─┘
        │
 server/index.ts   one HTTPS origin: Vite (dev) + /api + /projects/* assets + /cert.pem + wss /ws
 server/relay.ts   rooms: laptop ⇄ relay ⇄ phones (shared/protocol.ts)
        │                         ▲ PhonePose ≤ 30 Hz (relay stamps phoneId)
        ▼                         │ SceneState (scene, clock, cameras, speaking line), commands
 web/  (three.js + Spark)         │
   /              laptop director: scene list + pipeline chips, fly, drop cameras, phone frustum
                  gizmo + picture-in-picture of the phone view, dialogue playback, take recorder
   /phone.html    phone camera: sensors → pose, renders the same scene from the phone's pose
   viewer/        shared loader: SPZ world (Marble OpenCV → metric, floor at y = 0), collider,
                  actors (splat sequence / mannequin), props on looped paths, placement fix-up
```

Contracts between the pieces live in `shared/` (`schema.ts`: plans and manifests, `protocol.ts`:
the WebSocket messages, `api.ts`: routes). `docs/PLAN.md` has the design notes.

## Setup

Requirements: Node 22+ (developed on 24), pnpm, a laptop and a phone on the same
Wi-Fi. Python 3 with `modal` is needed only for real LHM avatars (see `worker/README.md`).

```sh
pnpm install
cp .env.example .env.local      # then fill in what you have (all optional, see below)
pnpm dev                        # https://localhost:5173 (PORT=…) — the phone URL is printed too
```

| Variable | Used for | Without it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | screenplay → scene plan (Claude) | offline rule-based parser |
| `WLT_API_KEY` | Marble worlds | mock world (a small procedural stage) |
| `OPENAI_API_KEY` | actor reference images, TTS | mannequin actors, beep audio |
| `ELEVENLABS_API_KEY` | preferred TTS when set | OpenAI TTS |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | LHM avatars on a Modal L4 | mannequin actors |
| `MOCK=1` | everything offline from `fixtures/` (what the tests use) | live mode |
| `MARBLE_MODEL` | `marble-1.1` (default), `marble-1.0-draft`, `marble-1.1-plus` | |
| `MARBLE_DRY_RUN=1` | log the exact Marble request instead of sending it; mock world | |
| `WORLD_LIBRARY_DIR` / `ACTORS_LIBRARY_DIR` | reuse folders (default `data/marble`, `data/actors-library`) | |
| `DATA_DIR`, `PORT` | project store (default `data/projects`), port (5173) | |

Keys are read only by `server/env.ts`, never logged, and `/api/health` reports presence only.
The header badge says `MOCK` or `LIVE`; hover it to see which keys are set.

## Make a scene

1. Open `https://localhost:5173/` and accept the self-signed certificate once.
2. Paste a screenplay (or press **Sample**) and press **Generate**. The project appears with one
   row per scene and a chip per stage (parse, world, actors, tts, manifest). Hover a chip for the
   detail; a red (failed) or amber (fallback) chip can be clicked to retry.
3. The first ready scene opens on its own; click any ready row to switch.

## Pair the phone

1. Phone and laptop on the same Wi-Fi. The laptop's right panel shows a room code, a QR code and
   the phone URL (`https://<laptop LAN IP>:5173/phone.html?room=ABCD`); the terminal prints the
   LAN address too. If the panel shows `localhost`, edit the URL to the LAN address.
2. **iOS:** motion sensors need a secure (HTTPS) page. Tap through Safari's certificate warning
   once ("Show Details → visit this website"). To avoid the warning, open
   `https://<LAN IP>:5173/cert.pem` first and install the downloaded profile (Settings → General →
   VPN & Device Management); if it is listed under Settings → General → About → Certificate Trust
   Settings, enable full trust there. A certificate from `mkcert` dropped into `certs/` (without
   `meta.json`) is used as-is and is the most reliable option. The certificate is regenerated
   when the laptop's LAN IP changes, so accept it again after switching networks.
3. Scan the QR (or open the URL), check the room code and tap **Tap to start**. Allow motion
   access when asked and hold the phone in landscape. Without sensors (or if access is denied)
   the phone falls back to drag-to-look.
4. The laptop now shows a pink phone frustum and a PHONE picture-in-picture. The phone is attached
   to the active dropped camera (or the scene's start camera); **Re-center** maps the phone's
   current heading onto that camera's heading.

## Controls

**Laptop**

| Input | Action |
| --- | --- |
| W A S D, Q / E, Shift | fly, down / up, faster |
| right-drag, or double-click for mouselook | look |
| wheel | zoom (field of view) |
| Space | play / pause the scene clock (moving props, dialogue sync) |
| C, or **Drop** | drop a camera at the current view; 1–9 jump to a camera |
| V, or **View** | view through the phone (the PiP then shows the director view) |
| R, or **Record take** | record the canvas plus dialogue audio as WebM |
| G, **Grid**, **Collider** | ground grid at y = 0, collider wireframe |
| click a dialogue line / **Play scene** | speak one line / the whole scene in order (caption + positional audio) |
| **Re-center phone**, **Still**, **New room** | phone heading reset, PNG from the phone camera, new pairing code |

**Phone**: move the phone to frame the shot, pinch (or wheel in `?sim=1`) to change the lens,
**Recenter**, **Shutter** (the laptop saves a still), **Record** (starts a take on the laptop),
**Cam ›** (switch to the next dropped camera). The caption shows the line being spoken.

## Real Marble generation

Marble is the slow and costly stage: about 5 minutes and 1,580 credits (≈ $1.26) per scene with
`marble-1.1`, 230 credits with `marble-1.0-draft`. Every job writes `marble-receipt.json` before
and after the POST, so a crash or a retry polls or downloads the recorded job instead of paying
for a second one.

- From the UI: run the server with `MOCK=0` and `WLT_API_KEY` set, then **Generate**.
- One world from the CLI, straight into the world library so every later project reuses it:

  ```sh
  pnpm tsx server/pipeline/cli.ts generate-world "<environment prompt, no people>" data/marble/city-street-night
  ```

- `MARBLE_DRY_RUN=1` runs the whole live pipeline but logs (and writes to
  `scene-<n>/world/marble-dry-run.json`) the exact request instead of submitting it.
- `pnpm tsx server/pipeline/cli.ts parse <file>` prints Claude's plan (about $0.10 per call:
  ~4.2k input / ~4.4k output tokens on `claude-opus-5-5`); `… cli.ts run <file>` runs a whole
  project from the terminal.

### Reuse instead of re-spending: the two libraries

Live (non-MOCK) projects check two gitignored folders before calling a paid service:

| Library | Path | Matched by | Saves |
| --- | --- | --- | --- |
| worlds | `data/marble/<key>/world-asset.json` (+ files) | scene slug minus `int-` / `ext-` / `int-ext-`: `ext-city-street-night` → `city-street-night` | ≈ $1.26 and ~5 min per scene |
| actors | `data/actors-library/<characterId>/sequence/sequence.json` (+ `frame_000.ply`, `motion.u16`) | character id (`maya`) | ≈ $0.08 and ~3–8 min per character |

A match is copied (APFS clone) into the project, so projects stay self-contained. With both
libraries filled, `MOCK=0` on `fixtures/screenplay.fountain` spends only the Claude plan and TTS
(cents for ~12 lines).

### Real avatars need Modal billing

The LHM stage runs on a Modal L4 GPU. Modal refuses L4 functions until the workspace has a payment
method, and until then every actor falls back to the mannequin (marked `fallback`, so a retry
upgrades it once billing works). Measured: 480 s wall clock for the first avatar including the
download, 162 s of L4 time, about $0.08, 72 frames at 12 fps (49 MB slim). Setup, one-time weight
staging and the worker CLI are in `worker/README.md`. Copy a finished
`<project>/actors/<id>/sequence/` into `data/actors-library/<id>/` to reuse it.

## Tests

```sh
pnpm typecheck                        # tsc --noEmit
pnpm test                             # vitest: pipeline, relay, protocol, viewer math, actors
npx playwright install chromium       # once, for the e2e browser
pnpm e2e                              # Playwright against a MOCK server on :5390 (temp DATA_DIR)
pnpm check                            # all three
npx tsx scripts/actor-browser-check.ts [--sequence data/actors-library/maya --gpu]
cd worker && python3 -m pytest -q tests
```

The e2e suite (`tests/e2e/`) creates projects through the API, opens the laptop, and pairs a
second browser context as the phone (`/phone.html?sim=1`, synthetic `deviceorientation`). It
checks that manifests validate and every asset is served, the splat world renders with real
colour, props move, a clicked line shows a caption and plays WebAudio, the phone's pose turns the
laptop's frustum gizmo and feeds the PiP, the phone captions the line the laptop plays, recenter /
shutter / next-camera cross the relay both ways, the phone renders WebGL on its own, and the
certificate / health / room endpoints work. Headless Chromium has no GPU: SwiftShader draws the
33k-splat mock world at about 1 fps at 1280x720 once it is fully loaded (the e2e specs are written
for that). A real Marble world (500k splats) needs a GPU; full Chromium with
`--use-angle=metal --enable-gpu` renders it at 60 fps.

Debug hooks: `window.__previz.state()` on the laptop and `window.__phone` on the phone
(see `web/src/phone/README.md` for the phone's URL flags such as `?sim=1`, `?3d=0`, `?governor=0`).

## Known limitations

- **No 6DoF tracking.** A browser exposes orientation and acceleration, not position: the phone
  rotates freely around the camera it is attached to and adds a damped ±0.3 m handheld sway, but
  walking with the phone does not move the camera. True 6DoF would need a native ARKit/ARCore
  companion speaking the same protocol.
- **No lip-sync on splat avatars.** The LHM avatar switches to a talk loop while it speaks; only
  the mannequin moves its jaw with the audio. Seated blocking lowers a splat avatar by 0.45 m
  (there is no sitting motion), and walking blocking does not walk.
- **iOS is untested headless.** The automated tests drive desktop Chromium with synthetic sensor
  events; the iOS Safari permission and certificate flow was only exercised by hand.
- Blocking is written by an LLM without seeing the world. When a collider is available, actors
  standing inside geometry or off the floor are moved to the nearest free floor (within 3 m),
  which is approximate in very tight interiors.
- Moving props are simple procedural shapes on straight looped paths, composited over the splats.
- Takes record the laptop canvas (WebM), not the phone's own render.

## Repository map

```
shared/           contracts (schema, protocol, api) + pure helpers shared by server and browser
server/           HTTPS entry, relay, env, pipeline/ (stages, libraries, CLI)
web/src/laptop/   director UI;  web/src/phone/  phone camera;  web/src/viewer/  shared 3D loader
worker/           Modal LHM avatar worker (Python)
fixtures/         sample screenplay, mock world, real-provider samples
tests/            unit tests (tests/unit) and Playwright e2e (tests/e2e)
docs/             PLAN.md and screenshots
```
