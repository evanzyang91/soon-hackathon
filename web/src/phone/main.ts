// Phone camera entry (web/phone.html). Flow: room code → "Tap to start" (user gesture: sensor
// permission, fullscreen, landscape lock, wake lock) → wss /ws Hello{phone} → stream PhonePose
// ≤30 Hz while rendering the scene from the phone's pose (or the 2D viewfinder fallback).
//
// Pose streaming is the critical path: it never waits on, or breaks because of, the 3D view.
import { Euler, Quaternion } from 'three';
import type { PhonePose, SceneState, ServerMessage } from '@shared/protocol';
import { SceneManifest } from '@shared/schema';
import { clampFov, DEFAULT_FOV, focalLabel, pinchFov } from './fov.ts';
import { Gestures } from './gestures.ts';
import { HandheldNudge } from './nudge.ts';
import { RelayClient, relayUrl, type ConnState } from './relay-client.ts';
import { anchorFor, captionFor, SceneClockTracker, type Anchor } from './scene-sync.ts';
import { OrientationTracker, screenAngle, toQuat } from './sensors.ts';
import { LEVELS, RenderGovernor } from './render-governor.ts';
import { PoseThrottle, poseKey } from './throttle.ts';
import { bindUi } from './ui.ts';
import { attitudeOf } from './viewfinder.ts';
import { enterFullscreenLandscape, keepScreenOn, requestSensorPermission } from './platform.ts';
import type { PhoneView } from './view.ts';

const params = new URLSearchParams(location.search);
const SIM = params.get('sim') === '1';
const ANGLE_OVERRIDE = params.has('angle') ? Number(params.get('angle')) : null;
const AUTO_RECENTER = params.get('recenter') !== '0';
const NO_3D = params.get('3d') === '0';
const SWAY_GAIN = Number(params.get('sway') ?? 1) || 1;
const QUALITY =
  (['k100', 'k500', 'full'] as const).find((q) => q === params.get('quality')) ?? 'k500';

const ui = bindUi();
const tracker = new OrientationTracker();
const nudge = new HandheldNudge({ gain: SWAY_GAIN });
const throttle = new PoseThrottle(30, 250);
const clock = new SceneClockTracker();
/** ?governor=0 disables adaptive render throttling (always render every frame). */
const governor = new RenderGovernor({ enabled: params.get('governor') !== '0' });

let relay: RelayClient | null = null;
let view: PhoneView | null = null;
let started = false;
let fovDeg = DEFAULT_FOV;
let pinchStartFov = fovDeg;
let recording = false;
let recordStartedAt = 0;
let scene: SceneState | null = null;
let manifest: SceneManifest | null = null;
let manifestUrlLoaded: string | null = null;
let anchor: Anchor = anchorFor(null, null);
let lastMotionAt = -Infinity;
let lastMotionTs = 0;
let lastPumpAt = performance.now();
let gestures: Gestures | null = null;

const angle = () =>
  ANGLE_OVERRIDE !== null && Number.isFinite(ANGLE_OVERRIDE) ? ANGLE_OVERRIDE : screenAngle();

/** Debug / e2e hook — see web/src/phone/README.md. */
const debug = {
  sim: SIM,
  room: '',
  started: false,
  conn: 'idle' as ConnState,
  peers: { laptop: false, phones: 0 },
  posesSent: 0,
  lastPose: null as PhonePose | null,
  orientationEvents: 0,
  motionEvents: 0,
  scene: null as SceneState | null,
  viewMode: 'viewfinder' as 'viewfinder' | 'webgl',
  /** Smoothed main-thread cost of one 3D frame (ms). */
  renderMs: 0,
  /** RenderGovernor level: 0 = full quality … 4 = 3D paused (see render-governor.ts). */
  renderLevel: 0,
  framesRendered: 0,
  viewStatus: '',
  yawOffset: 0,
  anchor,
  recording: false,
  permission: 'unknown' as string,
  start: () => start(),
  recenter: () => recenter(),
  setFov: (f: number) => setFov(f),
};
export type PhoneDebug = typeof debug;
declare global {
  interface Window {
    __phone?: PhoneDebug;
  }
}
window.__phone = debug;

// -- start screen ------------------------------------------------------------------------------

const initialRoom = (params.get('room') ?? '').trim().toUpperCase();
ui.roomInput.value = initialRoom;
if (!window.isSecureContext) {
  ui.startError('Motion sensors need HTTPS. Open the https:// link printed by the server.');
}
ui.startButton.addEventListener('click', () => start());
ui.roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start();
});
if (params.get('autostart') === '1' && initialRoom) start();

/** Must run inside the user-gesture handler: permission + fullscreen requests happen synchronously. */
function start(): void {
  if (started) return;
  const room = ui.roomInput.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(room)) {
    ui.startError('Enter the 4-letter room code shown on the laptop.');
    return;
  }
  started = true;
  debug.started = true;
  debug.room = room;

  // Sim mode never asks: synthetic events need no permission, and newer Chromium answers
  // 'denied' headless (Playwright: grant 'accelerometer'/'gyroscope' to test the real path).
  const permission = SIM ? Promise.resolve('not-needed' as const) : requestSensorPermission();
  if (!SIM) void enterFullscreenLandscape();
  void keepScreenOn();
  ui.showHud(room);
  history.replaceState(null, '', withParam('room', room));

  permission.then((p) => {
    debug.permission = p;
    if (p === 'denied' || p === 'error') {
      ui.toast(
        p === 'denied'
          ? 'Motion access denied — drag to look. Reload to try again.'
          : 'Motion sensors unavailable — drag to look.',
        5000,
      );
      enableManualLook();
    }
  });

  listenSensors();
  gestures = new Gestures(
    ui.stage,
    {
      pinchStart: () => (pinchStartFov = fovDeg),
      pinch: (scale) => setFov(pinchFov(pinchStartFov, scale)),
      wheel: (dy) => setFov(pinchFov(fovDeg, Math.exp(-dy * 0.0015))),
      look: (q) => {
        tracker.setCameraQuaternion(q);
      },
      currentLook: () => {
        const e = new Euler().setFromQuaternion(tracker.rawQuaternion, 'YXZ');
        return { yaw: e.y, pitch: e.x };
      },
    },
    () => fovDeg,
  );
  if (SIM) {
    enableManualLook();
  } else {
    // No orientation events within 1.5 s (desktop browser, sensors blocked): drag to look.
    setTimeout(() => {
      if (tracker.source !== 'sensor') {
        ui.toast('No motion sensors — drag to look', 4000);
        enableManualLook();
      }
    }, 1500);
  }

  relay = new RelayClient({
    url: relayUrl(),
    role: 'phone',
    room,
    onState: (s) => {
      debug.conn = s;
      ui.setConn(s);
    },
    onMessage,
  });
  relay.start();

  void initView();
  window.addEventListener('resize', () => view?.resize());
  ui.onRecenter(() => {
    recenter();
    ui.toast(`Recentered to ${anchor.name}`);
  });
  ui.onShutter(() => {
    relay?.send({ type: 'cmd', cmd: 'shutter' });
    ui.flash();
  });
  ui.onRecord(() => setRecording(!recording, true));
  ui.onNextCamera(() => relay?.send({ type: 'cmd', cmd: 'next-camera' }));
  setFov(fovDeg);
  requestAnimationFrame(frame);
  // rAF stalls when rendering is slow or the tab is hidden; keep the pose stream alive anyway.
  setInterval(() => pump(performance.now()), 20);
}

function enableManualLook() {
  if (!gestures || gestures.lookEnabled) return;
  gestures.lookEnabled = true;
  ui.setHint('Drag to look · pinch / wheel to zoom');
  // Start level, facing the anchor (the pending recenter applies on this first sample).
  if (!tracker.hasSample) tracker.setCameraQuaternion(new Quaternion());
}

async function initView() {
  if (NO_3D) {
    ui.setViewMode('viewfinder');
    return;
  }
  try {
    const { PhoneView } = await import('./view.ts');
    view = new PhoneView(ui.glCanvas, ui.vfCanvas, QUALITY);
    governor.onChange = (level, reason) => {
      debug.renderLevel = level;
      const lvl = LEVELS[level]!;
      console.info(`[phone] render level ${level} (${reason})`);
      view?.setPixelRatio(lvl.pixelRatio);
      if (!lvl.render3d)
        ui.toast('3D paused — this device renders too slowly. Pose streaming continues.', 4000);
    };
    if (scene) void loadScene(scene.manifestUrl);
  } catch (err) {
    console.warn('[phone] 3D view unavailable', err);
    ui.setViewMode('viewfinder');
  }
}

// -- sensors -----------------------------------------------------------------------------------

function listenSensors() {
  window.addEventListener('deviceorientation', (e: DeviceOrientationEvent) => {
    const firstSensor = tracker.source !== 'sensor';
    if (
      !tracker.setSample(
        { alpha: e.alpha ?? NaN, beta: e.beta ?? NaN, gamma: e.gamma ?? NaN },
        angle(),
      )
    ) {
      return;
    }
    debug.orientationEvents++;
    if (firstSensor && AUTO_RECENTER) tracker.recenter(anchor.yaw);
    if (firstSensor && gestures?.lookEnabled && !SIM) {
      gestures.lookEnabled = false;
      ui.setHint('');
    }
  });
  window.addEventListener('devicemotion', (e: DeviceMotionEvent) => {
    const a = e.acceleration;
    const ts = e.timeStamp || performance.now();
    const dt = lastMotionTs ? (ts - lastMotionTs) / 1000 : 1 / 60;
    lastMotionTs = ts;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    debug.motionEvents++;
    lastMotionAt = performance.now();
    nudge.update([a.x, a.y, a.z], tracker.deviceFrame, dt);
  });
}

function recenter() {
  tracker.recenter(anchor.yaw);
  debug.yawOffset = tracker.yawOffset;
}

function setFov(f: number) {
  fovDeg = clampFov(f);
  ui.setLens(focalLabel(fovDeg));
}

function setRecording(on: boolean, fromUser: boolean) {
  if (on === recording) return;
  recording = on;
  debug.recording = on;
  recordStartedAt = performance.now();
  ui.setRecording(on);
  if (fromUser) relay?.send({ type: 'cmd', cmd: on ? 'record-start' : 'record-stop' });
}

// -- relay messages ----------------------------------------------------------------------------

function onMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'peers':
      debug.peers = { laptop: msg.laptop, phones: msg.phones };
      ui.setPeers(msg.laptop);
      break;
    case 'scene':
      onScene(msg);
      break;
    case 'cmd':
      if (msg.cmd === 'recenter') {
        recenter();
        ui.toast('Director recentered you');
      } else if (msg.cmd === 'shutter') ui.flash();
      else if (msg.cmd === 'record-start') setRecording(true, false);
      else if (msg.cmd === 'record-stop') setRecording(false, false);
      break;
    case 'pose':
      break; // phones do not receive poses
  }
}

function onScene(s: SceneState) {
  scene = s;
  debug.scene = s;
  clock.update(s, performance.now());
  if (s.manifestUrl !== manifestUrlLoaded) {
    manifestUrlLoaded = s.manifestUrl;
    manifest = null;
    void fetchManifest(s.manifestUrl);
    void loadScene(s.manifestUrl);
  }
  refreshAnchor();
  const cap = captionFor(manifest, s.speakingLineId);
  ui.setCaption(cap ? `${cap.speaker}: ${cap.text}` : '');
}

function refreshAnchor() {
  const next = anchorFor(scene, manifest);
  const changed = next.key !== anchor.key;
  anchor = next;
  debug.anchor = next;
  ui.setCameraName(next.name);
  if (changed) {
    setFov(next.fovDeg);
    if (AUTO_RECENTER) recenter();
  }
}

async function fetchManifest(url: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = SceneManifest.safeParse(await res.json());
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid manifest');
    if (url !== manifestUrlLoaded) return;
    manifest = parsed.data;
    refreshAnchor();
    if (scene) {
      const cap = captionFor(manifest, scene.speakingLineId);
      ui.setCaption(cap ? `${cap.speaker}: ${cap.text}` : '');
    }
  } catch (err) {
    console.warn('[phone] manifest fetch failed', err);
  }
}

async function loadScene(url: string) {
  if (!view) return;
  await view.load(url);
}

// -- loops -------------------------------------------------------------------------------------

function currentPose(now: number): PhonePose {
  const q = toQuat(tracker.quaternion);
  // Viewport aspect of the phone's render, so the laptop's frustum gizmo / PiP match the framing.
  const aspect = Math.round((window.innerWidth / Math.max(1, window.innerHeight)) * 1000) / 1000;
  return { type: 'pose', t: now, q, nudge: nudge.offset, fovDeg, aspect, recording };
}

/** Advance sway decay and send a pose if the throttle allows. Called from rAF and a timer. */
function pump(now: number) {
  const gapMs = now - lastPumpAt;
  const dt = Math.min(0.1, Math.max(0, gapMs / 1000));
  lastPumpAt = now;
  // Main-thread stalls between pump ticks are what starve the pose stream.
  if (document.visibilityState === 'visible' && view?.mode === 'webgl')
    governor.observeGap(now, gapMs);
  if (now - lastMotionAt > 250) nudge.update(null, tracker.deviceFrame, dt);
  if (!relay || relay.state !== 'open') return;
  const pose = currentPose(now);
  if (!throttle.shouldSend(now, poseKey(pose))) return;
  if (relay.send(pose)) {
    debug.posesSent++;
    debug.lastPose = pose;
  }
}

let lastFrameAt = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  pump(now);
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
  const q = tracker.quaternion;
  const off = nudge.offset;
  if (view) {
    const t0 = performance.now();
    const draw = governor.shouldRender(now);
    try {
      view.frame(
        { position: anchor.position, quaternion: q, fovDeg, nudge: off },
        dt,
        {
          time: clock.time(now),
          playing: clock.isPlaying,
          speakingLineId: scene?.speakingLineId ?? null,
        },
        { draw, paused: !governor.current.render3d },
      );
      if (draw && view.mode === 'webgl') {
        governor.rendered(now);
        const cost = performance.now() - t0;
        debug.renderMs = debug.renderMs ? debug.renderMs * 0.9 + cost * 0.1 : cost;
        debug.framesRendered++;
      }
      debug.viewMode = view.shown;
      debug.viewStatus = view.status;
      ui.setViewMode(view.shown);
    } catch (err) {
      console.warn('[phone] view frame failed', err);
    }
  } else {
    ui.drawFallback(toQuat(q), fovDeg, off, NO_3D ? '3D disabled (?3d=0)' : 'loading 3D…');
  }
  const a = attitudeOf(q);
  ui.setAttitude(
    `HDG ${a.headingDeg.toFixed(0).padStart(3, '0')}° TILT ${a.pitchDeg.toFixed(0)}° ROLL ${a.rollDeg.toFixed(0)}°`,
  );
  if (recording) ui.setRecordTime((now - recordStartedAt) / 1000);
}

function withParam(key: string, value: string) {
  const u = new URL(location.href);
  u.searchParams.set(key, value);
  return u.toString();
}
