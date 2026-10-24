# Previz Camera: the ARKit camera app (prototype)

A native iPhone app that films with true 6DoF tracking. It joins the same relay room as the web
phone page, streams `PhonePose` with a real `offset` (`source: 'arkit'`), and renders the shot
through the existing web renderer in a full-screen `WKWebView` (`/phone.html?pose=external`), so
the world, actors and look are identical. You walk with the phone to move the camera 1:1. There is
no joystick and no camera passthrough (we film the virtual scene).

**Status:** the app builds for iOS with Xcode 26.5 (no errors or warnings), `PrevizCore` passes
its 59 tests, and the page side of the bridge (`phone.html?pose=external`) is implemented and
covered by `tests/e2e/phone-external-pose.spec.ts`. It has not run on an iPhone yet. See
[Verified vs not yet verified](#verified-vs-not-yet-verified).

```
ios/
  project.yml                 XcodeGen spec  →  PrevizCamera.xcodeproj (generated, committed)
  Config/Base.xcconfig        bundle id + signing; Local.xcconfig (gitignored) overrides
  PrevizCamera/
    Info.plist                camera + local-network strings, NSAllowsLocalNetworking, arkit
    Assets.xcassets           icon, launch colour
    Sources/
      PrevizCameraApp.swift   @main, Join ↔ Stage
      AppModel.swift          orchestration: join, AR frames → poses, relay ⇄ page, controls
      ARTracker.swift         ARSession (world tracking, headless) → per-frame samples
      RelayConnection.swift   URLSessionWebSocketTask: hello, reconnect/backoff, ping, stall guard
      WebStage.swift          WKWebView + bridge (evaluateJavaScript / script message handler)
      DevTrust.swift          SHA-256 pinning of the laptop's self-signed cert (URLSession + WKWebView)
      JoinView.swift          host + room, QR scan, "Trust this laptop?" fingerprint prompt
      QRScanner.swift         AVFoundation QR reader
      StageView.swift         native HUD over the web view
  PrevizCore/                 Swift package, no UIKit/ARKit: `swift test` works without Xcode
    Sources/PrevizCore/       PoseMath, PoseTracker, Lens, RelayProtocol, PoseThrottle, JoinLink,
                              CertPin, WebBridge, DebugSnapshot
    Tests/PrevizCoreTests/    59 tests, incl. zod validation against shared/protocol.ts
  scripts/
    protocol-harness.ts       zod + bridge-script harness used by the tests (tsx)
    typecheck-app.sh          app typecheck without Xcode; with Xcode: xcodebuild
```

## Build and run on an iPhone

Needs Xcode 16 or newer (Swift 5 language mode, iOS 17+), and an iPhone with ARKit (any A9 or
newer; iPhone XS or newer recommended).

1. `cd ios && xcodegen generate` (only after editing `project.yml`; the generated project is
   committed). Then open `ios/PrevizCamera.xcodeproj`.
2. **Signing (free personal team works):** copy `Config/Local.xcconfig.example` to
   `Config/Local.xcconfig` and set `DEVELOPMENT_TEAM` and a bundle id of your own (for example
   `com.yourname.previzcamera`; personal teams cannot reuse an id). Find the team id in Xcode →
   Settings → Accounts. You can also pick the team in Signing & Capabilities, but
   `xcodegen generate` overwrites that and the xcconfig survives.
3. Plug in the iPhone and select it as the run destination. On the phone, enable Settings →
   Privacy & Security → **Developer Mode** (iOS 16+, needs a restart). Press Run.
4. First launch with a personal team: Settings → General → VPN & Device Management → your Apple ID
   → **Trust**. Personal-team builds expire after 7 days; re-run from Xcode.
5. On the laptop: `pnpm dev`, open `https://localhost:5173/`, open a scene.
6. In the app, tap **Scan the laptop's QR code** (or type `192.168.x.y:5173` and the room code),
   then confirm the certificate fingerprint (see below). Allow **Local Network** and **Camera**
   when iOS asks. The first connection (the certificate check) is what raises the Local Network
   prompt; the app retries it for about 10 s while you answer.
7. Move the phone slowly until the badge says **ARKit · Tracking**. The first good frame re-centres
   you onto the active camera. Walk to move, turn to pan, and press **Recentre** to snap back.

`ios/scripts/typecheck-app.sh` runs `xcodebuild … -destination 'generic/platform=iOS'
CODE_SIGNING_ALLOWED=NO build` once Xcode is installed. That is the first thing to run after the
macOS upgrade.

## Trusting the laptop's certificate

The dev server uses a self-signed certificate (`server/https.ts`) that iOS does not trust.
The app trusts it by **SHA-256 pin, per `host:port`**, and applies the pin to every TLS
connection it makes: the relay WebSocket, the manifest fetch, and the `WKWebView`'s page and
sub-resources (via `webView(_:didReceive:completionHandler:)`).

Pairing works on trust on first use (TOFU), and you confirm it:

1. On **Join**, the app downloads `https://<host>/cert.pem`. That one request accepts whatever
   certificate TLS presents, and the app checks the served PEM is the same certificate.
2. It shows **"Trust this laptop?"** with the SHA-256 fingerprint. Compare it on the laptop with
   `openssl x509 -noout -fingerprint -sha256 -in certs/cert.pem`, then tap Trust.
3. From then on, only a certificate whose SHA-256 equals the pin is accepted for that host. The
   server makes a new certificate when the laptop's LAN IP changes, so after switching networks
   the app says "Certificate changed" and asks again.

If the system already trusts the certificate (see mkcert below), there is no prompt and no pin.

**Why this approach (trade-offs):**

- **ATS keys alone cannot do it.** App Transport Security exceptions never make a self-signed
  certificate pass trust evaluation; they only allow an app to override it. Apple DTS: "If you
  want to talk to a server with a self-signed certificate, you must disable ATS for that server"
  ([forum thread 53314](https://developer.apple.com/forums/thread/53314)). Since iOS 17, ATS also
  blocks plain IP-address hosts unless `NSAllowsLocalNetworking` is set
  ([docs](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)).
  So Info.plist sets `NSAllowsLocalNetworking` (LAN IPs and `.local` names only, nothing on the
  internet), and the pin decides which certificate to accept.
- **Pinning works for URLSession and WKWebView** through the same `DevTrust.evaluate`, with no
  device-wide changes. It accepts exactly one certificate, never "any certificate".
- **mkcert is the most robust alternative**, and it is what Apple DTS recommends. Create a private
  CA, put its certificate into `certs/` (the server uses a `key.pem` + `cert.pem` there as-is),
  install the CA root on the iPhone, and enable it under Settings → General → About → Certificate
  Trust Settings. Then everything (app and Safari) trusts the laptop system-wide, there is no
  pairing prompt, and nothing changes when the network changes. The cost is a one-time profile
  install. Use it if the web view ever fails to load a sub-resource that never reached the
  delegate (for example a worker fetch; see unverified items).
- `NSLocalNetworkUsageDescription` is required: iOS shows the Local Network prompt on the first
  connection to the laptop.

## Pose convention

```
 Phone in landscape with the Home button / bottom edge on the RIGHT
 (UIInterfaceOrientation.landscapeRight). Here ARKit's camera frame and the web camera frame agree:

            +Y  (up on the screen)
             ▲
   ┌─────────┼─────────────────────┐
   │ front   │                     │
   │ camera ○│                     │ ← bottom edge / Home button
   │         └────────────▶ +X     │
   └───────────────────────────────┘
   +Z points out of the screen at you; the back camera looks along −Z, into the scene.

 ARKit world (worldAlignment .gravity)          scene world (three.js)
   +Y up, metres                                 +Y up, metres
   −Z = back-camera heading at session start     anchor = active drop camera (position P, yaw θ)
   origin = where the phone was then             (else the manifest start camera, else (0,1.6,0), 0)
```

The facts, from Apple's `ARCamera.transform` docs: ARKit camera space is fixed to the device. +X
runs along the long axis from the front camera toward the Home button, +Y is up in that
landscape, and +Z points out of the screen. That is the device frame rolled by Rz(−90°). The web
page's camera (`web/src/phone/sensors.ts`) is the device frame rolled by Rz(−a), where
`a = screen.orientation.angle`. So, per frame (`PrevizCore/PoseMath.swift`, `PoseTracker.swift`):

```
q_web   = q_arkit · Rz(90° − a)        a: portrait 0, landscapeRight 90, upsideDown 180, landscapeLeft 270
Recentre (first good frame, Recentre button, laptop cmd 'recenter', anchor camera changed):
  ψ  = wrap(θ − yaw(q_web))           yaw = three.js Euler 'YXZ' .y (heading of the view direction)
  p₀ = p                               (ARKit camera position, transform.columns.3)
q       = Ry(ψ) · q_web                → PhonePose.q (canonical sign, w ≥ 0)
offset  = Ry(ψ) · (p − p₀)             → PhonePose.offset, metres, scene frame
nudge   = [0, 0, 0]                    (ARKit's position already contains handheld motion)
fovDeg  = 2·atan(min(tV, tH / A))      the real lens aspect-filled into the view (A = width / height):
          tLong = (W/2)/fx, tShort = (H/2)/fy on ARCamera.imageResolution W×H (landscape sensor);
          landscape UI: tH = tLong, tV = tShort; portrait: tH = tShort, tV = tLong
aspect  = web view width / height
scene camera = P + offset, orientation q   (the laptop and the page both add exactly this)
```

- Rotating the UI only rolls the camera about its view axis. Heading and offset do not change, so
  no Recentre is needed. Portrait and landscape both work.
- Recentre here also rebases the position ("I'm standing on the camera now"). The web page's
  Recentre keeps its joystick offset, but with real tracking a reset to the camera is the useful
  meaning. A change of attached camera re-centres, as on the web.
- **Tracking quality:** only `.normal` frames move the camera. `limited(initializing |
  relocalizing | excessiveMotion | insufficientFeatures)` and `notAvailable` hold the last good
  pose (`held: true` in the debug JSON). Before the first good frame the camera is level, facing
  the anchor. A Recentre requested while limited applies on the next good frame. Interruptions
  keep the world (`sessionShouldAttemptRelocalization` → true).
- Landscape vertical FOV of the full sensor = 2·atan(H / 2fy) (≈ 53° on a wide camera). On a
  19.5:9 screen the app reports ≈ 34° in landscape (horizontal = the sensor's full ≈ 67°) and
  ≈ 67° in portrait.

## Web side contract

The page in external-pose mode **only renders**. The native app is the room's only phone. It
sends `hello` / `pose` (≤ 30 Hz, authoritative) / `cmd` to the relay itself, and forwards every
relay message to the page. The page must not open the relay socket and must not send poses.

**URL:** `https://<host>/phone.html?room=ABCD&pose=external&voice=0&sim=0`.
Before any page script runs, the app also injects
`window.__previzNativeHost = { platform: 'ios', source: 'arkit', bridge: 1 }`.

When `pose=external`:

1. **Start at once.** No "Tap to start" (`#start`), no sensor permission request, no fullscreen,
   orientation lock or wake lock, and no `deviceorientation` / `devicemotion` listeners.
   `OrientationTracker`, `HandheldNudge` and `Walker` stay idle. No joystick / keyboard walk, no
   pinch lens.
2. **No relay.** Do not construct `RelayClient`; never send.
3. **Install the bridge, then say ready:**

   ```ts
   window.__previzPose = (pose: PhonePose) => void
   //   Store it; the rAF loop renders the latest. Called up to 60 Hz, so keep it cheap.
   //   orientation = pose.q verbatim (already world frame, already re-centred: no recenter, no
   //   screen-angle term). position = anchor.position + pose.offset + pose.nudge, with the anchor
   //   from anchorFor(scene, manifest) as today. fov = pose.fovDeg verbatim (no clampFov 24–90;
   //   [10, 120] at most). pose.recording drives #rec-badge. Ignore pose.aspect (it equals the
   //   page's own viewport).
   window.__previzMessage = (msg: ServerMessage) => void
   //   Exactly today's onMessage(msg) for 'peers' | 'scene' | 'cmd' (native never forwards
   //   'pose'). cmd 'recenter': leave the pose alone (native already re-centred); a toast is fine.
   window.webkit?.messageHandlers?.previz?.postMessage({ type: 'ready' })
   //   After both functions exist, on every (re)load. Native then replays the latest peers +
   //   scene and the current pose. Native also calls the functions guarded
   //   (`window.__previzPose&&…`), so early calls are harmless.
   ```

4. **Optional page → native:** `postMessage({ type: 'cmd', cmd })` for any page button that
   would send a `PhoneCommand` (native forwards it; `recenter` re-centres natively), and
   `postMessage({ type: 'log', message })`.
5. **HUD:** hide `#start`, `#joystick`, `#height`, `#controls` (Recenter / Shutter / Record /
   Cam ›), `#top-right` (ACTION / Line ›), `#top-left` (room + connection), `#walk-readout`,
   `#hint`, `#rotate`. Keep `#top-center` (camera name, lens label from `pose.fovDeg`, clock,
   rec badge), `#caption`, `#perf`, `#toast`, `#flash`, `#attitude`. The native overlay uses
   top-left (tracking badge, room, connection), top-right (ACTION / CUT), the right edge
   (Recentre, Shutter, Record) and bottom-left (Leave).
6. **Debug:** `window.__phone` gains `poseSource: 'external'` and a count of external poses
   applied. `window.__previzNative` is the native debug snapshot (read-only, refreshed at 1 Hz;
   fields below). The page may mirror `__previzNative.conn` in `__phone.conn`.
7. **Audio:** the app passes `voice=0` (the laptop plays the voices). The web view allows media
   without a user gesture, so `voice=1` can work if the page resumes its AudioContext on the
   first `__previzPose`.
8. **Plain-browser testability:** everything above works in desktop Chromium too.
   `postMessage` is optional-chained, and Playwright can drive the page with
   `page.evaluate(() => window.__previzPose({...}))` and `__previzMessage({...})`.

TypeScript declarations for the page:

```ts
declare global {
  interface Window {
    __previzPose?: (pose: PhonePose) => void;
    __previzMessage?: (msg: ServerMessage) => void;
    __previzNative?: Record<string, unknown>;
    __previzNativeHost?: { platform: 'ios'; source: 'arkit'; bridge: number };
    webkit?: { messageHandlers?: { previz?: { postMessage(msg: unknown): void } } };
  }
}
```

PrevizCore's tests run the exact script strings the app evaluates (`window.__previzPose&&
window.__previzPose({...});0`, and the same for `__previzMessage`) against a stub `window` in
Node, and zod-validate the argument with `PhonePose` / `ServerMessage`.

## The relay side (what the app sends and handles)

- `{type:'hello', role:'phone', room}` on every (re)connect to `wss://<host>/ws`.
- `PhonePose` with `source: 'arkit'`, `nudge: [0,0,0]`, `offset`, `fovDeg`, `aspect`,
  `recording`, `t` = ARFrame time in ms. At most 30 Hz, using the same throttle and change key as
  `web/src/phone/throttle.ts`, plus a keepalive every 250 ms when nothing changes and while frames
  stop (an interruption), so the laptop keeps following this phone.
- `cmd`: `shutter`, `record-start` / `record-stop`, `play-scene` from the native buttons.
- Handled: `peers` (HUD), `scene` (anchor = active drop camera, else the manifest `startCamera`;
  fetched over the pinned session), and `cmd` (`recenter` re-centres, `shutter` flashes,
  `record-*` sets the record state). All of them also go to the page.
- Reconnect backoff 0.5 s → 5 s (relay-client.ts parity), a ping every 5 s (no pong for 12 s
  means reconnect), a stall guard (> 60 unacknowledged sends means reconnect), and an immediate
  reconnect when the app returns to the foreground.

## Room scan

**Scan room** (right edge) collects ARKit's horizontal planes (depth-assisted on LiDAR phones)
every 0.5 s; **Done** turns them into a `RoomScan` (`shared/protocol.ts`) with
`PrevizCore/RoomFootprint`: the floor height (classified floor planes, else the lowest horizontal
planes), the convex hull of the floor seen, simplified to ≤ 32 points, the ceiling height when a
ceiling plane was seen, and the area. Points are mapped with `PoseTracker.toScene`, the same rigid
map the camera gets, so the outline is in the pose `offset` frame. The app sends it to the relay
(cached per room for laptops that join later), to its own page (wall warning), again after every
Recentre or camera switch, and again when the relay reconnects.

## Debugging

- Tap the tracking badge for the in-app debug overlay (JSON).
- In Debug builds the web view is inspectable: Safari → Develop → *your iPhone* → phone.html.
  `window.__previzNative` holds the native state; `window.__phone` holds the page's.
- `__previzNative` / overlay fields: `room`, `host`, `conn`, `peers`, `trackingState`
  (`normal` | `limited:initializing` | `limited:relocalizing` | `limited:excessiveMotion` |
  `limited:insufficientFeatures` | `notAvailable`), `held`, `posesSent`, `framesTracked`,
  `lastPose`, `orientation`, `recentreYaw`, `recentres`, `anchor {name,key,yaw}`,
  `trust` (`pinned` | `system`), `web {url, ready, loads, processTerminations, posesPushed,
  lastError}`, `check`, `error`.
- **`check` is the on-device proof of the pose math.** Every 30 good frames, the app compares
  PrevizCore's oriented camera with ARKit's own `viewMatrix(for: orientation).inverse`
  (`rotationErrorDeg`, expect ≈ 0), and its FOV with ARKit's aspect-fill
  `projectionMatrix(for:viewportSize:zNear:zFar:)` (`fovErrorDeg`, expect ≈ 0). A large rotation
  error in one orientation means the roll table is wrong there.
- Logs: Console.app, subsystem `dev.previz.camera`.

## Web camera or ARKit camera

Both are phones in the same room. The laptop follows the most recently joined phone that is
sending poses, and hands over after 1 s of silence (`web/src/laptop/messages.ts`).

- **Web camera:** scan the QR with the iPhone camera, which opens Safari on `phone.html`. Nothing
  to install. It gives orientation sensors plus joystick walking.
- **ARKit camera:** scan the same QR inside Previz Camera. To switch, close the Safari tab (or
  leave it in the background) and join with the app. To switch back, tap **Leave** (✕) in the app
  and open the Safari page again.
- The laptop can tell them apart by `PhonePose.source` (`'arkit'` vs absent / `'browser'`).

## Verified vs not yet verified

Verified on this Mac (Command Line Tools only, Swift 6.1 toolchain):

- `cd ios/PrevizCore && swift test`: **59 tests pass.** They cover:
  - ARKit → web camera conversion in all four UI orientations, using Apple's documented camera
    axes, and agreement with the page's `deviceorientation` formula on 800 random attitudes
    after Recentre.
  - three.js `YXZ` yaw parity (including the gimbal branch), `wrapAngle` parity, Recentre, the
    1:1 offset (one rigid map), and hold-while-limited.
  - FOV from intrinsics (landscape, portrait, aspect fill).
  - Exact JSON of `PhonePose`, `Hello` and `PhoneCommand`, and decoding of
    `peers` / `scene` / `cmd`.
  - Throttle parity with `throttle.ts` (`poseKey` compared to the real function), join-link
    parsing (QR, host:port, IPv6), PEM / SHA-256 pins against `openssl`, and the bridge scripts.
  - **zod:** every frame the app sends is parsed by `ClientMessage` from `shared/protocol.ts`
    (nothing stripped, plus a negative control). The bridge scripts run in Node and their
    arguments parse as `PhonePose` / `ServerMessage`. Relay samples built by zod decode in Swift.
  - A mutation check: flipping the sign of the orientation roll fails 11 assertions.
  - `swift build` is clean in Swift 6 mode and with `-strict-concurrency=complete`.
- `ios/scripts/typecheck-app.sh`: every app source typechecks against the Mac Catalyst SDK's
  UIKit / ARKit / WebKit / AVFoundation / SwiftUI interfaces. That covers names, labels, types,
  optionality, availability and actor isolation. It is clean in Swift 5 mode (the project's),
  with `STRICT=1`, and in Swift 6 mode. An emitted ObjC header confirms that every delegate method
  binds to the intended selector (`session:didUpdateFrame:`,
  `webView:didReceiveAuthenticationChallenge:completionHandler:`,
  `URLSession:webSocketTask:didOpenWithProtocol:`, …).
- `xcodegen generate` succeeds. `plutil -lint` passes on Info.plist and project.pbxproj.
- **iOS build (Xcode 26.5, iPhoneOS 26.5 SDK, 2026-10-24):** `ios/scripts/typecheck-app.sh` builds
  `PrevizCamera` for `generic/platform=iOS` unsigned: BUILD SUCCEEDED with no errors or warnings,
  asset catalog included.
- **The page side of the bridge:** `phone.html?pose=external` (`web/src/phone/external.ts`)
  starts without the gate, hides the page controls, installs `__previzPose` / `__previzMessage`,
  posts `ready`, places the camera at anchor + offset + nudge with the pose's lens, follows
  `recording`, and never opens the relay socket (`tests/e2e/phone-external-pose.spec.ts`).

Not yet verified (needs an iPhone and a signing team):

- Device behaviour: ARKit tracking at 60 Hz without a view, `check.rotationErrorDeg` /
  `fovErrorDeg` ≈ 0 on device, the camera / Local Network prompts, and QR scanning.
- TLS: whether ATS honours the pin override for LAN IPs under `NSAllowsLocalNetworking` alone. If
  connections fail with an ATS error, add `NSAllowsArbitraryLoads` for the dev build, or use
  mkcert. Also unverified: whether WKWebView routes every sub-resource / worker request's server
  trust challenge to the navigation delegate (if not, use mkcert).
- Performance: evaluateJavaScript at 60 Hz alongside a splat render (the app keeps at most one
  pose evaluation in flight and drops stale ones).
