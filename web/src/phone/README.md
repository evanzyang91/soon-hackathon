# Phone camera (`/phone.html`)

The phone is the handheld camera. It joins a relay room, streams `PhonePose` (≤ 30 Hz) to the
laptop, and renders the scene from its own pose (WP A's `viewer/world.ts` + `viewer/render.ts`),
or a 2D viewfinder when 3D is unavailable. Pose streaming never depends on the 3D view.

## Controls

| Input | Action |
| --- | --- |
| move / turn the phone | pan, tilt, roll (orientation sensors) + handheld sway (accelerometer) |
| **joystick** (bottom left, drag with the left thumb) | walk: up = forward, sideways = strafe, along the camera's heading (level, whatever the tilt); dead zone, eases up to 1.5 m/s |
| double-tap the joystick | back to the attached camera (walk offset → 0) |
| **height slider** (right, next to the shutter) | drag up / down: raise / lower the camera, up to 0.5 m/s, ±2 m (never below 0.15 m) |
| pinch | lens (24–90° vertical fov, "35mm" labels) |
| **ACTION** / **CUT** (top right) | laptop "Play scene" (dialogue in order + scene clock) / stop it; shows CUT while the laptop runs the scene |
| **Line ›** | laptop plays the line after the last one played (wraps to the first) |
| **Recenter** | current heading → the attached camera's heading (keeps the walk offset) |
| **Shutter**, **Record**, **Cam ›** | laptop frame (PNG), laptop take, next shot in the shot list (resets the walk offset) |
| `?sim=1`: drag, wheel, W A S D / arrows, Q / E (or Page Down / Up) | look, lens, walk, height |

The walk offset (metres, world frame) goes out in every pose as `PhonePose.offset`; phone camera
= attached camera + offset + nudge, on the phone and on the laptop (gizmo, PiP, View from phone,
stills). It resets to zero whenever the anchor camera changes (Cam ›, the laptop switching the
active camera, another scene), and survives Recenter.

HUD: room + link (top left); camera name, lens and scene clock (`▶ 0:04` / `⏸ 0:04`, top
centre); ACTION + Line › (top right); the line being spoken (bottom centre); how far the
joystick has walked (`↔ 2.3 m · ↑ 0.5 m from Cam 1`, above the joystick); render rate + governor
level (`48 fps · full`, `3D paused`, `loading 3D…`, `2D viewfinder`, bottom right). A scene that
finishes loading while paused shows "Laptop: press Play or tap ACTION to start the scene" for 2 s.

**Sound.** The actors speak on the phone too (positional, heard from the phone camera), in sync
with the laptop's `speakingLineId`. iOS only starts audio inside a user gesture, so "Tap to start"
creates the AudioContext, resumes it, plays one silent sample and hands it to three.js
(`THREE.AudioContext.setContext`) before anything else (`audio.ts`); any later tap resumes it
again (after `?autostart=1`, or iOS "interrupted"). On iOS 16.4+ it plays through the silent
switch (`navigator.audioSession.type = 'playback'`). `?voice=0` mutes the phone when the laptop's
speakers are in the same room.

```
?room=ABCD        pre-fill the room code (the laptop's QR links here)
?sim=1            desktop simulator: drag-to-look + wheel zoom + WASD / QE walk, no fullscreen / permission
?autostart=1      skip the "Tap to start" click (needs ?room=; audio then waits for the first tap)
?angle=90         override screen.orientation.angle (deg) for the orientation math
?recenter=0       disable auto-recenter (pose q = raw sensor math, handy for exact asserts)
?3d=0             never create WebGL; 2D viewfinder only
?quality=k100     splat LOD (default k500)
?governor=0       always render every frame (disable the render governor, see below)
?sway=2           exaggerate the handheld nudge
?voice=0          mute the actors on the phone (the laptop still plays them)
?ws=wss://…/ws    override the relay URL
?pose=external    the native ARKit app streams the pose; the page only renders (see below)
```

## Native ARKit app (`?pose=external`)

The iOS app (`ios/`, contract: "Web side contract" in `ios/README.md`) loads
`/phone.html?room=ABCD&pose=external&voice=0&sim=0` in a `WKWebView`. The app owns the relay
socket and is the room's only phone: it sends `hello` / `pose` / `cmd` itself and forwards every
relay message to the page. The page:

- **starts at once**: no "Tap to start", sensor permission, fullscreen, orientation / wake lock,
  `deviceorientation` / `devicemotion` listeners, joystick, keyboard walk, pinch lens or
  "No motion sensors" fallback. `OrientationTracker`, `HandheldNudge` and `Walker` stay idle.
- **never opens the relay** (no `RelayClient`, nothing sent; `posesSent` stays 0).
- **installs the bridge, then says ready**: `window.__previzPose(pose)` stores the latest pose
  (cheap, up to 60 Hz; the rAF loop renders it) and `window.__previzMessage(msg)` is the relay
  `onMessage` (`peers` / `scene` / `cmd`). Then it calls
  `window.webkit?.messageHandlers?.previz?.postMessage({ type: 'ready' })` (a no-op in a desktop
  browser) and the app replays the latest peers, scene and pose.
- **renders the pose as is** (`external.ts`): orientation = `pose.q` verbatim (already world
  frame and re-centred), position = anchor + `pose.offset` + `pose.nudge` (anchor as in browser
  mode: active drop camera → manifest `startCamera`), fov = `pose.fovDeg` clamped to [10, 120]
  only (not the pinch lens's 24–90), lens label from it, `pose.recording` drives the REC badge;
  `pose.aspect` is ignored. Poses that fail the shape guard (non-finite / non-unit `q`,
  non-finite fov, malformed `nudge` / `offset`) are dropped.
- **leaves heading, fov and walk to the app**: a laptop `cmd: recenter` only shows a toast, and a
  new anchor camera does not reset fov / walk or recenter.
- **hides** `#start`, `#joystick`, `#height`, `#controls`, `#top-right`, `#top-left`,
  `#walk-readout`, `#hint` and `#rotate` (`body[data-pose="external"]` rules in `phone.html`; the
  app draws its own overlay there). It keeps `#top-center` (camera, lens, clock, REC), `#caption`,
  `#perf`, `#toast`, `#flash` and `#attitude`.
- **audio**: the app passes `voice=0`. With `voice=1` the first `__previzPose` creates and resumes
  the AudioContext (the web view allows media without a gesture).
- **page → app**: besides `ready`, it posts `{ type: 'log', message }` when the 3D view or a
  manifest fails to load. The render governor still runs (it keeps the page responsive).

Debug: `__phone.poseSource` is `'external'`, `__phone.externalPoses` counts the poses applied,
and `__phone.conn` mirrors `window.__previzNative.conn` (the app's relay link, refreshed at 1 Hz)
when that is a string. `window.__previzNativeHost` is injected by the app before any page script.

Driving it from Playwright (desktop Chromium, no app):

```ts
await ctx.addInitScript(() => {
  (window as any).webkit = {
    messageHandlers: { previz: { postMessage: (m: unknown) => ((window as any).__posted ||= []).push(m) } },
  };
});
await phone.goto(`${base}/phone.html?room=ABCD&pose=external&voice=0&sim=0`);
await phone.waitForFunction(() => (window as any).__posted?.some((m: any) => m.type === 'ready'));
await phone.evaluate((scene) => {
  window.__previzMessage!({ type: 'peers', laptop: true, phones: 1 });
  window.__previzMessage!(scene); // a SceneState
}, scene);
await phone.evaluate(() =>
  window.__previzPose!({
    type: 'pose', source: 'arkit', t: 1, q: [0, 0.2588, 0, 0.9659], nudge: [0, 0, 0],
    offset: [0.5, 0, -0.2], fovDeg: 38, recording: true,
  }),
);
await phone.waitForFunction(() => window.__phone?.viewMode === 'webgl');
// __phone.cameraPosition = anchor + offset + nudge, __phone.cameraQuaternion = q
```

The `webkit` stub is optional (the page optional-chains it); without it there is just no `ready`
to observe.

## Modules

| file                                  | what                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `main.ts`                             | boot + wiring: start gesture, relay, sensors, pose pump, scene state, HUD     |
| `external.ts`                         | `?pose=external`: native pose shape guard + fov range (the app owns the pose) |
| `sensors.ts`                          | `deviceorientation` → camera quaternion, yaw recenter (`OrientationTracker`)  |
| `nudge.ts`                            | `devicemotion` → damped, high-passed, clamped (±0.3 m) handheld sway          |
| `walk.ts` / `joystick.ts`             | joystick walk math (heading, dead zone, ramp, height clamp) / its DOM + keys  |
| `audio.ts`                            | AudioContext unlock inside the start tap, shared with three.js                |
| `fov.ts` / `throttle.ts`              | pinch zoom (24–90°, "35mm" labels) / ≤ 30 Hz + 4 Hz keepalive                 |
| `scene-sync.ts`                       | `SceneState` → anchor, caption, scene clock, ACTION / CUT (`DialogueActivity`)|
| `relay-client.ts`                     | reconnecting WebSocket client (role-agnostic; the laptop can reuse it)        |
| `render-governor.ts`                  | steps 3D quality down (down to paused) when rendering starves the pose stream; perf label |
| `view.ts` / `viewfinder.ts`           | 3D render via `loadScene` / 2D fallback                                       |
| `gestures.ts`, `platform.ts`, `ui.ts` | input, iOS permission + fullscreen + wake lock, DOM                           |

## Orientation math

`q = yaw(offset) · Euler(β, α, −γ, 'YXZ') · Rx(−π/2) · Rz(−screenAngle)`. The camera looks out of
the back of the phone along −Z, with Y up. Phone upright in portrait, `alpha=0, beta=90, gamma=0`,
gives the identity quaternion (camera faces −Z).

**Recenter.** The first orientation sample, every change of the active camera, the Recenter
button and a laptop `cmd: recenter` all set `offset` so that the current heading maps to the
anchor yaw. The anchor is the active drop camera; without one it is the manifest `startCamera`,
and without a scene it is yaw 0. Only yaw is aligned. The phone's own pitch and roll are kept.

So with `?sim=1` and no scene, the **first** synthetic event becomes heading 0, and later events
are relative to it. Add `&recenter=0` if you want `q` to equal the raw formula exactly.

## E2E / Playwright hooks

```ts
const phone = await ctx.newPage(); // ctx = browser.newContext({ ignoreHTTPSErrors: true })
await phone.goto(`${base}/phone.html?room=${room}&sim=1&autostart=1`);
await phone.waitForFunction(() => window.__phone?.conn === 'open');
await phone.evaluate(() =>
  window.dispatchEvent(
    new DeviceOrientationEvent('deviceorientation', { alpha: 30, beta: 90, gamma: 0 }),
  ),
);
// devicemotion works the same way:
//   new DeviceMotionEvent('devicemotion', { acceleration: { x: 0, y: 0, z: 2 }, interval: 16 })
```

`window.__phone` (read-only state, plus a few actions):

| field                                                            | meaning                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `conn`                                                           | `'idle' \| 'connecting' \| 'open' \| 'reconnecting' \| 'closed'`; with `?pose=external`, `__previzNative.conn` |
| `poseSource`, `externalPoses`                                    | `'external'` (`?pose=external`) or `'browser'`; native poses applied      |
| `peers`                                                          | last `peers` message `{ laptop, phones }`                                 |
| `posesSent`, `lastPose`                                          | count and last `PhonePose` sent                                           |
| `orientationEvents`, `motionEvents`                              | sensor events applied                                                     |
| `scene`, `anchor`                                                | last `SceneState`; current anchor `{ position, yaw, fovDeg, name, key }`  |
| `viewMode`, `viewStatus`                                         | `'webgl' \| 'viewfinder'`, plus a human-readable status                   |
| `renderLevel`, `renderMs`, `framesRendered`, `fps`               | governor level (0 full … 4 paused), JS cost per 3D frame, 3D frames drawn, 3D frames / s |
| `offset`, `heading`, `walk`, `cameraPosition`                    | walk offset (m), walking heading (rad), stick input `{ x, y, rise }`, anchor + offset + nudge |
| `cameraQuaternion`                                               | rendered camera orientation `[x, y, z, w]` (world frame)                  |
| `sceneRunning`                                                   | the laptop runs the scene (ACTION shows CUT)                              |
| `audio`, `audioPlaying`, `lastLinePlayed`, `audioPeak`, `voice`  | AudioContext state (`'none'` before the tap), a voice playing now, last line voiced, loudest level of it (0..1, > 0 only when sound really flows), `?voice` |
| `yawOffset`, `recording`, `permission`, `started`, `room`, `sim` | self-explanatory                                                          |
| `start()`, `recenter()`, `setFov(deg)`, `resetWalk()`            | actions                                                                   |

Mobile emulation note: with `isMobile: true` and a landscape viewport, Chromium reports
`screen.orientation.angle = 90`. So feed landscape samples (`alpha, 0, -90` = upright, top edge
left) or pass `?angle=0`. A portrait sample on a landscape screen shows up as a 90° roll. To
test the non-sim permission path, call `context.grantPermissions(['accelerometer', 'gyroscope',
'magnetometer'])` and tap `#start-button`. Newer Chromium implements `requestPermission()` and
answers `denied` otherwise. Sim mode never asks.

Without `autostart`, click `#start-button`. Other selectors: `#room-input`, `#recenter`,
`#shutter`, `#record` (`aria-pressed`), `#next-cam`, `#action` (`aria-pressed` = CUT),
`#next-line`, `#caption`, `#lens`, `#cam-name`, `#clock` (`data-playing`), `#perf`,
`#walk-readout`, the joystick `#joystick` (zone; `data-active` while dragged) with `#joy-base` /
`#joy-knob`, the height slider `#height` / `#height-knob`, and the `#gl` / `#vf` canvases
(`body[data-view]` says which one is showing).

Driving the walk controls: pointer events, so `page.mouse` works. Press in the middle of
`#joystick` and move up by ≥ 48 px for full forward (≥ 56 px on `#height` for full rise); two
clicks within 380 ms on `#joystick` reset. In `?sim=1`, `page.keyboard.down('KeyW')` walks too.

Testing audio: `page.evaluate()` runs with a user gesture (CDP `userGesture: true`), which by
itself lets an AudioContext start, and Chromium's `--autoplay-policy=user-gesture-required` does
not suspend Web Audio at all. Use `--autoplay-policy=document-user-activation-required` (desktop
Chrome's default) and read state from pages under test without `evaluate` (e.g. an init script
that logs `window.__phone` to the console), so only real `page.mouse` / `page.keyboard` input
counts as a gesture.

The laptop side gets poses from the relay as ordinary `pose` messages. The relay coalesces each
phone to the latest pose per 33 ms. A still phone still sends a keepalive pose every 250 ms.

## Render governor (pose streaming comes first)

A slow GPU blocks the browser main thread when a frame is submitted, which starves sensor events
and the pose timer. `render-governor.ts` watches main-thread timer gaps in 1 s windows. It steps
down through five levels: full quality, ≤ 20 fps at 1×, ≤ 10 fps at 0.75×, ≤ 4 fps at 0.5×, and
finally 3D paused. When 3D is paused the viewfinder is shown and the scene stays loaded. The
governor retries the next level up after clean windows, with exponential backoff.

**Headless Chromium uses software GL (SwiftShader).** A real splat world costs about 0.6 s per
frame there, so the phone reaches level 4 within about 6–8 s and then streams at ~29 Hz. For
e2e, assert pose streaming with the default settings. Assert phone-side WebGL pixels on a
separate page with `?governor=0`, where streaming will be slow in SwiftShader. Real phone GPUs
stay at level 0.

**Vite HMR in e2e.** Every dev server on a machine shares HMR port 24678, so other dev servers
can full-reload your pages. Stub it with `context.routeWebSocket(/:24678\//, () => {})`.

## iOS notes

- The page must be HTTPS (self-signed cert from `server/https.ts`). On the phone, tap through
  "Show Details → visit this website" once.
- `DeviceOrientationEvent.requestPermission()` only works from a tap, which is why "Tap to
  start" exists. If the user denies it, the page falls back to drag-to-look. Safari remembers a
  denial until its website data is cleared.
- iPhone Safari has no Fullscreen API for pages and no orientation lock, so the page tells the
  user to rotate. "Add to Home Screen" gives a chrome-less fullscreen view.
