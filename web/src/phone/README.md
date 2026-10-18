# Phone camera (`/phone.html`)

The phone is the handheld camera. It joins a relay room, streams `PhonePose` (≤ 30 Hz) to the
laptop, and renders the scene from its own pose (WP A's `viewer/world.ts` + `viewer/render.ts`),
or a 2D viewfinder when 3D is unavailable. Pose streaming never depends on the 3D view.

```
?room=ABCD        pre-fill the room code (the laptop's QR links here)
?sim=1            desktop simulator: drag-to-look + wheel zoom, no fullscreen / permission
?autostart=1      skip the "Tap to start" click (needs ?room=; fine in sim, no gesture needed)
?angle=90         override screen.orientation.angle (deg) for the orientation math
?recenter=0       disable auto-recenter (pose q = raw sensor math, handy for exact asserts)
?3d=0             never create WebGL; 2D viewfinder only
?quality=k100     splat LOD (default k500)
?governor=0       always render every frame (disable the render governor, see below)
?sway=2           exaggerate the handheld nudge
?ws=wss://…/ws    override the relay URL
```

## Modules

| file                                  | what                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `main.ts`                             | boot + wiring: start gesture, relay, sensors, pose pump, scene state          |
| `sensors.ts`                          | `deviceorientation` → camera quaternion, yaw recenter (`OrientationTracker`)  |
| `nudge.ts`                            | `devicemotion` → damped, high-passed, clamped (±0.3 m) handheld sway          |
| `fov.ts` / `throttle.ts`              | pinch zoom (24–90°, "35mm" labels) / ≤ 30 Hz + 4 Hz keepalive                 |
| `scene-sync.ts`                       | `SceneState` → anchor camera, caption, extrapolated scene clock               |
| `relay-client.ts`                     | reconnecting WebSocket client (role-agnostic; the laptop can reuse it)        |
| `render-governor.ts`                  | steps 3D quality down (down to paused) when rendering starves the pose stream |
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
| `conn`                                                           | `'idle' \| 'connecting' \| 'open' \| 'reconnecting' \| 'closed'`          |
| `peers`                                                          | last `peers` message `{ laptop, phones }`                                 |
| `posesSent`, `lastPose`                                          | count and last `PhonePose` sent                                           |
| `orientationEvents`, `motionEvents`                              | sensor events applied                                                     |
| `scene`, `anchor`                                                | last `SceneState`; current anchor `{ position, yaw, fovDeg, name, key }`  |
| `viewMode`, `viewStatus`                                         | `'webgl' \| 'viewfinder'`, plus a human-readable status                   |
| `renderLevel`, `renderMs`, `framesRendered`                      | governor level (0 full … 4 paused), JS cost per 3D frame, 3D frames drawn |
| `yawOffset`, `recording`, `permission`, `started`, `room`, `sim` | self-explanatory                                                          |
| `start()`, `recenter()`, `setFov(deg)`                           | actions                                                                   |

Mobile emulation note: with `isMobile: true` and a landscape viewport, Chromium reports
`screen.orientation.angle = 90`. So feed landscape samples (`alpha, 0, -90` = upright, top edge
left) or pass `?angle=0`. A portrait sample on a landscape screen shows up as a 90° roll. To
test the non-sim permission path, call `context.grantPermissions(['accelerometer', 'gyroscope',
'magnetometer'])` and tap `#start-button`. Newer Chromium implements `requestPermission()` and
answers `denied` otherwise. Sim mode never asks.

Without `autostart`, click `#start-button`. Other selectors: `#room-input`, `#recenter`,
`#shutter`, `#record` (`aria-pressed`), `#next-cam`, `#caption`, `#lens`, `#cam-name`, and the
`#gl` / `#vf` canvases (`body[data-view]` says which one is showing).

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
