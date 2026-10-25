// Phone camera entry (web/phone.html). Flow: room code → "Tap to start" (user gesture: sensor
// permission, fullscreen, landscape lock, wake lock) → wss /ws Hello{phone} → stream PhonePose
// ≤30 Hz while rendering the scene from the phone's pose (or the 2D viewfinder fallback).
//
// Pose streaming is the critical path: it never waits on, or breaks because of, the 3D view.
//
// ?pose=external (the native ARKit app in ios/, "Web side contract" in ios/README.md): no start
// screen, sensors, walk controls or relay. The app owns the relay socket and pushes its pose and
// the relay's messages through window.__previzPose / __previzMessage; the page only renders.
import { Euler, Quaternion } from 'three';
import type { PhonePose, SceneState, ServerMessage } from '@shared/protocol';
import { SceneManifest, type Quat, type Vec3 } from '@shared/schema';
import { parseExternalPose, type ExternalPose } from './external.ts';
import { clampFov, DEFAULT_FOV, pinchFov } from './fov.ts';
import { Gestures } from './gestures.ts';
import { KeyboardWalk, TouchStick } from './joystick.ts';
import { HandheldNudge } from './nudge.ts';
import { RelayClient, relayUrl, type ConnState } from './relay-client.ts';
import {
  anchorFor,
  captionFor,
  DialogueActivity,
  SceneClockTracker,
  shotEntries,
  shotLabel,
  type Anchor,
} from './scene-sync.ts';
import { OrientationTracker, screenAngle, toQuat } from './sensors.ts';
import { LEVELS, perfLabel, RenderGovernor, type PerfState } from './render-governor.ts';
import { PoseThrottle, poseKey } from './throttle.ts';
import { unlockAudio } from './audio.ts';
import { bindUi, type CamMenu, type LinkLevel } from './ui.ts';
import { enterFullscreenLandscape, keepScreenOn, requestSensorPermission } from './platform.ts';
import type { PhoneView } from './view.ts';
import { cameraPosition, headingOf, NO_WALK, Walker, type WalkInput } from './walk.ts';

const params = new URLSearchParams(location.search);
/** ?pose=external: the native app streams the pose and relays messages; the page only renders. */
const EXTERNAL = params.get('pose') === 'external';
const SIM = params.get('sim') === '1';
const ANGLE_OVERRIDE = params.has('angle') ? Number(params.get('angle')) : null;
const AUTO_RECENTER = params.get('recenter') !== '0';
const NO_3D = params.get('3d') === '0';
const SWAY_GAIN = Number(params.get('sway') ?? 1) || 1;
/** ?voice=0 mutes the actors on the phone (e.g. when the laptop's speakers are in the room). */
const VOICE = params.get('voice') !== '0';
const QUALITY =
  (['k100', 'k500', 'full'] as const).find((q) => q === params.get('quality')) ?? 'k500';
/** The joystick never takes the camera closer than this to the floor (y = 0). */
const MIN_EYE_HEIGHT = 0.15;
/** ?perf=1 shows the render rate + governor level (bottom right). */
const PERF = params.get('perf') === '1';
/** The drag / pinch hint shows once per browser (first start without motion sensors). */
const HINT_KEY = 'previz:phone-hint';
/** The start-up handshake (connecting → open → laptop) gets no toasts for this long. */
const LINK_QUIET_MS = 4000;

const ui = bindUi();
const tracker = new OrientationTracker();
const nudge = new HandheldNudge({ gain: SWAY_GAIN });
const walker = new Walker();
const throttle = new PoseThrottle(30, 250);
const clock = new SceneClockTracker();
const dialogue = new DialogueActivity();
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
/** The 3D module failed to load: only the viewfinder can show. */
let viewUnavailable = false;
/** The connection dot's level, and whether a change of it is news yet (after the start-up). */
let linkLevel: LinkLevel | null = null;
let linkQuiet = true;
/** "Add shot from here" was sent: the next new shot the laptop puts the phone on is it. */
let addPending: { at: number; known: Set<string> } | null = null;
let stick: TouchStick | null = null;
let heightSlider: TouchStick | null = null;
let keys: KeyboardWalk | null = null;
/** ?pose=external: the latest native pose, and its orientation as a three.js quaternion. */
let ext: ExternalPose = {
  q: [0, 0, 0, 1],
  nudge: [0, 0, 0],
  offset: [0, 0, 0],
  fovDeg,
  recording: false,
};
const extQuat = new Quaternion();
let extAudioUnlocked = false;

const angle = () =>
  ANGLE_OVERRIDE !== null && Number.isFinite(ANGLE_OVERRIDE) ? ANGLE_OVERRIDE : screenAngle();

/** Debug / e2e hook — see web/src/phone/README.md. */
const debug = {
  sim: SIM,
  room: '',
  started: false,
  /** Relay link (ConnState); with ?pose=external, window.__previzNative.conn (the app's link). */
  conn: 'idle' as ConnState | (string & {}),
  /** 'external': the native app streams the pose (?pose=external); 'browser': this page does. */
  poseSource: (EXTERNAL ? 'external' : 'browser') as 'external' | 'browser',
  /** Native poses applied through window.__previzPose. */
  externalPoses: 0,
  peers: { laptop: false, phones: 0 },
  posesSent: 0,
  lastPose: null as PhonePose | null,
  orientationEvents: 0,
  motionEvents: 0,
  scene: null as SceneState | null,
  viewMode: 'viewfinder' as 'viewfinder' | 'webgl',
  /** Smoothed main-thread cost of one 3D frame (ms). */
  renderMs: 0,
  /** 3D frames drawn per second (measured each second; what the HUD's perf label shows). */
  fps: 0,
  /** RenderGovernor level: 0 = full quality … 4 = 3D paused (see render-governor.ts). */
  renderLevel: 0,
  framesRendered: 0,
  viewStatus: '',
  /** Per actor, the line id whose bubble is showing (null = name label). */
  actors: {} as Record<string, string | null>,
  yawOffset: 0,
  anchor,
  /** The laptop is running the scene (clock + dialogue): the play button shows pause. */
  sceneRunning: false,
  /** The HUD's label: "1B · Two-shot · 35 mm" or "Handheld · 35 mm". */
  label: '',
  /** AudioContext state: 'none' until the start tap creates it, then suspended / running / … */
  audio: 'none' as AudioContextState | 'none' | 'interrupted',
  /** An actor's voice is playing on the phone right now. */
  audioPlaying: false,
  /** Last line whose voice actually played on the phone (null = none yet). */
  lastLinePlayed: null as string | null,
  /** Loudest voice level heard during the last line, 0..1 (> 0 only when sound really flows). */
  audioPeak: 0,
  /** ?voice=0 mutes the phone's actors. */
  voice: VOICE,
  /** Joystick walk offset from the anchor (m, world frame) — also in every PhonePose. */
  offset: [0, 0, 0] as Vec3,
  /** Walking heading (rad, 0 = −Z), from the camera's view direction. */
  heading: 0,
  /** Current walk input: stick x / y, height rate (each -1..1). */
  walk: { ...NO_WALK } as WalkInput,
  /** Phone camera position = anchor + offset + nudge (as rendered, when 3D is drawing). */
  cameraPosition: [0, 1.6, 0] as Vec3,
  /** Phone camera orientation [x, y, z, w] in the world frame (what the 3D view renders). */
  cameraQuaternion: [0, 0, 0, 1] as Quat,
  recording: false,
  /** The director's look as rendered here: name, edits.json revision, frames through the post pass. */
  look: { name: 'Default', revision: -1, postFrames: 0 },
  permission: 'unknown' as string,
  start: () => start(),
  recenter: () => recenter(),
  setFov: (f: number) => setFov(f),
  /** Back to the attached camera (what a double-tap on the joystick does). */
  resetWalk: () => resetWalk(),
  /** The loaded scene (look checks freeze its clock and read its look). */
  sceneRuntime: () => view?.sceneRuntime ?? null,
};
export type PhoneDebug = typeof debug;
declare global {
  interface Window {
    __phone?: PhoneDebug;
    // ?pose=external bridge (ios/README.md "Web side contract")
    __previzPose?: (pose: PhonePose) => void;
    __previzMessage?: (msg: ServerMessage) => void;
    __previzNative?: Record<string, unknown>;
    __previzNativeHost?: { platform: 'ios'; source: 'arkit'; bridge: number };
    webkit?: { messageHandlers?: { previz?: { postMessage(msg: unknown): void } } };
  }
}
window.__phone = debug;

// -- start screen ------------------------------------------------------------------------------

const initialRoom = (params.get('room') ?? '').trim().toUpperCase();
if (EXTERNAL) {
  startExternal();
} else {
  ui.roomInput.value = initialRoom;
  if (!window.isSecureContext) {
    ui.startError('Motion sensors need HTTPS. Open the https:// link printed by the server.');
  }
  ui.startButton.addEventListener('click', () => start());
  ui.roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') start();
  });
  if (params.get('autostart') === '1' && initialRoom) start();
}

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
  // first, synchronously inside the tap: iOS only starts audio from a gesture (see audio.ts)
  unlockAudio((s) => (debug.audio = s));

  // Sim mode never asks: synthetic events need no permission, and newer Chromium answers
  // 'denied' headless (Playwright: grant 'accelerometer'/'gyroscope' to test the real path).
  const permission = SIM ? Promise.resolve('not-needed' as const) : requestSensorPermission();
  if (!SIM) void enterFullscreenLandscape();
  void keepScreenOn();
  ui.showHud();
  setTimeout(() => {
    linkQuiet = false;
    if (linkLevel !== 'ok') ui.toast('Waiting for the laptop…', 2400);
  }, LINK_QUIET_MS);
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
      updateLink();
    },
    onMessage,
  });
  relay.start();

  stick = new TouchStick(ui.joystick.zone, ui.joystick.base, ui.joystick.knob, {
    radius: 48,
    axis: 'xy',
    floating: true,
  });
  stick.onDoubleTap = () => {
    resetWalk();
    ui.toast(anchor.key.startsWith('cam:') ? 'Back on the shot' : 'Back at the start');
  };
  heightSlider = new TouchStick(ui.height.zone, ui.height.zone, ui.height.knob, {
    radius: 56,
    axis: 'y',
    floating: false,
  });
  if (SIM) keys = new KeyboardWalk();

  ui.onRecenter(() => {
    recenter();
    ui.toast('Recentered');
  });
  ui.onShutter(() => {
    relay?.send({ type: 'cmd', cmd: 'shutter' });
    ui.flash();
  });
  ui.onRecord(() => setRecording(!recording, true));
  ui.onCam(() => (ui.camMenuOpen ? ui.closeCamMenu() : openCamMenu()));
  ui.onPlay(
    () => sendSceneCommand('play-scene'),
    () => {
      if (sendSceneCommand('next-line')) ui.toast('Next line');
    },
  );
  ui.onLabelSwipe((dir) => {
    const shots = shotEntries(scene);
    if (!shots.length) return;
    const i = shots.findIndex((s) => s.id === scene?.activeCameraId);
    const next = i < 0 ? (dir > 0 ? 0 : shots.length - 1) : (i + dir + shots.length) % shots.length;
    selectCamera(shots[next]!.id);
  });
  boot();
}

/**
 * ?pose=external: start at once. No start screen, sensor permission, fullscreen, orientation or
 * wake lock, sensor listeners, walk controls, pinch lens or relay. Install the bridge the app
 * calls, then tell it the page is ready (it replays the latest peers + scene + pose).
 */
function startExternal(): void {
  started = true;
  debug.started = true;
  debug.room = initialRoom;
  document.body.dataset.pose = 'external'; // phone.html hides the page's own controls
  ui.showHud();
  window.__previzPose = onExternalPose;
  window.__previzMessage = (msg) => {
    if (typeof msg?.type === 'string') onMessage(msg);
  };
  boot();
  mirrorNativeConn();
  toNative({ type: 'ready' });
}

/** Both modes: the 3D view, the lens label and the loops. */
function boot() {
  void initView();
  window.addEventListener('resize', () => view?.resize());
  setFov(fovDeg);
  requestAnimationFrame(frame);
  // rAF stalls when rendering is slow or the tab is hidden; keep the pose stream alive anyway.
  setInterval(() => pump(performance.now()), 20);
}

/**
 * window.__previzPose: keep the latest native pose (up to 60 Hz, so cheap); frame() renders it.
 * Already world frame and re-centred: q verbatim, position = anchor + offset + nudge, its fov.
 */
function onExternalPose(raw: unknown) {
  const p = parseExternalPose(raw);
  if (!p) return;
  // ?voice=1: the app's web view lets media start without a gesture, so the first pose unlocks
  if (VOICE && !extAudioUnlocked) {
    extAudioUnlocked = true;
    unlockAudio((s) => (debug.audio = s));
  }
  ext = p;
  extQuat.set(p.q[0], p.q[1], p.q[2], p.q[3]);
  debug.externalPoses++;
  debug.offset = p.offset;
  if (p.fovDeg !== fovDeg) {
    fovDeg = p.fovDeg;
    updateLabel();
  }
  setRecording(p.recording, false);
}

/** ?pose=external: the app's relay link (window.__previzNative is refreshed at 1 Hz). */
function mirrorNativeConn() {
  const c = window.__previzNative?.conn;
  if (typeof c === 'string') debug.conn = c;
}

/** Page → native app (?pose=external). A no-op without the WKWebView bridge (desktop browsers). */
function toNative(msg: { type: 'ready' } | { type: 'log'; message: string }) {
  if (!EXTERNAL) return;
  try {
    window.webkit?.messageHandlers?.previz?.postMessage(msg);
  } catch {
    // the bridge went away: nothing to tell
  }
}

function enableManualLook() {
  if (!gestures || gestures.lookEnabled) return;
  gestures.lookEnabled = true;
  // once per browser: the frame stays clear after that
  if (!storageFlag(HINT_KEY)) {
    storageFlag(HINT_KEY, true);
    ui.toast('Drag to look · pinch / wheel to zoom', 4000, { hold: true });
  }
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
    view = new PhoneView(ui.glCanvas, ui.vfCanvas, QUALITY, { voice: VOICE });
    // the director's look: show its name briefly when it changes; a planner-seeded name runs to
    // 80 characters ("Candlelit · cold, eerie, damp stone"), so long names stay up long enough to
    // read (the toast wraps at 80 % of the screen width)
    view.look.onName = (name) => ui.toast(`Look: ${name}`, Math.min(4000, 1800 + 30 * Math.max(0, name.length - 20)));
    governor.onChange = (level, reason) => {
      debug.renderLevel = level;
      const lvl = LEVELS[level]!;
      console.info(`[phone] render level ${level} (${reason})`);
      view?.setPixelRatio(lvl.pixelRatio);
      // the first step down drops the look's bloom (the rest of the grade is one cheap pass)
      view?.setLookQuality({ bloom: level < 1 });
      if (!lvl.render3d)
        ui.toast('3D paused — this device renders too slowly. Pose streaming continues.', 4000);
    };
    if (scene) {
      view.applySceneState(scene);
      void loadScene(scene.manifestUrl);
    }
  } catch (err) {
    console.warn('[phone] 3D view unavailable', err);
    toNative({ type: 'log', message: `3D view unavailable: ${String(err)}` });
    viewUnavailable = true;
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
    if (firstSensor && gestures?.lookEnabled && !SIM) gestures.lookEnabled = false;
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
  // ?pose=external: the app re-centres its own pose (a laptop 'recenter' only shows a toast)
  if (EXTERNAL) return;
  // only the heading: a recenter keeps where the joystick has walked to
  tracker.recenter(anchor.yaw);
  debug.yawOffset = tracker.yawOffset;
}

function resetWalk() {
  walker.reset();
  debug.offset = walker.offset;
}

function walkInput(): WalkInput {
  const k = keys?.input ?? NO_WALK;
  return {
    x: stick?.active ? stick.x : k.x,
    y: stick?.active ? stick.y : k.y,
    rise: heightSlider?.active ? heightSlider.y : k.rise,
  };
}

function setFov(f: number) {
  fovDeg = clampFov(f);
  updateLabel();
}

function updateLabel() {
  debug.label = shotLabel(scene, fovDeg);
  ui.setLabel(debug.label);
}

/** The connection dot: green = the laptop is there, amber = on the way / waiting, red = cut off. */
function updateLink() {
  const c = debug.conn;
  const level: LinkLevel =
    c === 'open' ? (debug.peers.laptop ? 'ok' : 'wait') : c === 'closed' ? 'bad' : 'wait';
  const text =
    level === 'ok'
      ? 'Connected to the laptop'
      : c === 'open'
        ? 'Waiting for the laptop'
        : c === 'closed'
          ? 'Disconnected'
          : c === 'reconnecting'
            ? 'Reconnecting…'
            : 'Connecting…';
  ui.setLink(c, level, text);
  // ?pose=external: the app shows its own link
  if (level === linkLevel || EXTERNAL) return;
  linkLevel = level;
  // the start-up handshake is not news: the first green ends it
  if (linkQuiet) {
    if (level === 'ok') linkQuiet = false;
    return;
  }
  ui.toast(text, level === 'ok' ? 1800 : 2400);
}

/** Play / stop, the next line, a shot: the laptop owns the clock, the dialogue and the list. */
function laptopReady(): boolean {
  if (scene && debug.peers.laptop && relay?.state === 'open') return true;
  ui.toast('No scene yet — open one on the laptop');
  return false;
}

function sendSceneCommand(cmd: 'play-scene' | 'next-line'): boolean {
  if (!laptopReady()) return false;
  return !!relay?.send({ type: 'cmd', cmd });
}

/** Attach to a shot (null: handheld); the laptop answers with the new SceneState. */
function selectCamera(cameraId: string | null) {
  if (!laptopReady()) return;
  relay?.send({ type: 'cmd', cmd: 'select-camera', cameraId });
}

/** "Add shot from here": the laptop adds the phone's view as a shot and puts the phone on it. */
function addShot() {
  if (!laptopReady() || !scene) return;
  addPending = { at: performance.now(), known: new Set(scene.cameras.map((c) => c.id)) };
  relay?.send({ type: 'cmd', cmd: 'add-shot' });
}

/** The popover's rows: the scene's shots, the one the phone is on marked (null: handheld). */
function camMenu(): CamMenu {
  const on = anchor.key.startsWith('cam:') ? (scene?.activeCameraId ?? null) : null;
  return { shots: shotEntries(scene), current: on };
}

function openCamMenu() {
  ui.openCamMenu(camMenu(), { pick: selectCamera, add: addShot });
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
      updateLink();
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
  dialogue.update(s, performance.now());
  if (s.manifestUrl !== manifestUrlLoaded) {
    manifestUrlLoaded = s.manifestUrl;
    manifest = null;
    dialogue.reset();
    void fetchManifest(s.manifestUrl);
    void loadScene(s.manifestUrl);
  }
  refreshAnchor();
  view?.applySceneState(s);
  const cap = captionFor(manifest, s.speakingLineId);
  ui.setCaption(cap ? `${cap.speaker}: ${cap.text}` : '');
  ui.updateCamMenu(camMenu());
  // the shot "Add shot from here" made: the laptop put the phone on a shot it did not have
  if (addPending && s.activeCameraId && !addPending.known.has(s.activeCameraId)) {
    const shot = shotEntries(s).find((e) => e.id === s.activeCameraId);
    if (shot) ui.toast(`Shot ${shot.number} added`);
    addPending = null;
  } else if (addPending && performance.now() - addPending.at > 5000) addPending = null;
}

function refreshAnchor() {
  const prev = anchor;
  const next = anchorFor(scene, manifest);
  const changed = next.key !== prev.key;
  anchor = next;
  debug.anchor = next;
  updateLabel();
  // ?pose=external: the app's pose carries its own fov, offset and heading
  if (changed && !EXTERNAL) {
    if (prev.key.startsWith('cam:') && next.key.startsWith('start:')) {
      // off the shot, handheld: the view stays where it is (same spot, heading and lens), now
      // walked from the scene's start camera
      const o = walker.offset;
      const p = prev.position;
      const n = next.position;
      walker.place([p[0] + o[0] - n[0], p[1] + o[1] - n[1], p[2] + o[2] - n[2]]);
      debug.offset = walker.offset;
      return;
    }
    setFov(next.fovDeg);
    // walking is relative to the attached camera: a new camera starts where it stands
    resetWalk();
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
    toNative({ type: 'log', message: `manifest fetch failed: ${String(err)}` });
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
  return {
    type: 'pose',
    t: now,
    q,
    nudge: nudge.offset,
    offset: walker.offset,
    fovDeg,
    aspect,
    recording,
  };
}

/** Advance sway decay and send a pose if the throttle allows. Called from rAF and a timer. */
function pump(now: number) {
  const gapMs = now - lastPumpAt;
  const dt = Math.min(0.1, Math.max(0, gapMs / 1000));
  lastPumpAt = now;
  // Main-thread stalls between pump ticks are what starve the pose stream.
  if (document.visibilityState === 'visible' && view?.mode === 'webgl')
    governor.observeGap(now, gapMs);
  if (EXTERNAL) return; // the app owns sway, walking and the pose stream
  if (now - lastMotionAt > 250) nudge.update(null, tracker.deviceFrame, dt);
  const input = walkInput();
  debug.walk = input;
  debug.heading = headingOf(tracker.quaternion);
  debug.offset = walker.update(input, debug.heading, dt, {
    down: Math.max(0, anchor.position[1] - MIN_EYE_HEIGHT),
  });
  if (!relay || relay.state !== 'open') return;
  const pose = currentPose(now);
  if (!throttle.shouldSend(now, poseKey(pose))) return;
  if (relay.send(pose)) {
    debug.posesSent++;
    debug.lastPose = pose;
  }
}

let fpsAt = performance.now();
let fpsFrames = 0;

function perfState(): PerfState {
  const s = { level: debug.renderLevel, fps: debug.fps };
  if (NO_3D) return { ...s, view: 'off' };
  if (viewUnavailable || (view && (!view.canRender3d || view.loadFailed)))
    return { ...s, view: 'unavailable' };
  if (view?.mode === 'webgl') return { ...s, view: 'webgl' };
  return { ...s, view: scene ? 'loading' : 'waiting' };
}

let lastFrameAt = performance.now();
let lastVoiceCheck = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  pump(now);
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
  const q = EXTERNAL ? extQuat : tracker.quaternion;
  const off = EXTERNAL ? ext.nudge : nudge.offset;
  const walked = EXTERNAL ? ext.offset : walker.offset;
  const pose = { position: anchor.position, quaternion: q, fovDeg, offset: walked, nudge: off };
  debug.cameraPosition = cameraPosition(pose);
  debug.cameraQuaternion = toQuat(q);
  if (view) {
    const t0 = performance.now();
    const draw = governor.shouldRender(now);
    try {
      view.frame(
        pose,
        dt,
        {
          time: clock.time(now),
          playing: clock.isPlaying,
          speakingLineId: scene?.speakingLineId ?? null,
        },
        { draw, paused: !governor.current.render3d },
      );
      if (draw && view.mode === 'webgl') {
        debug.cameraPosition = view.renderedPosition;
        governor.rendered(now);
        const cost = performance.now() - t0;
        debug.renderMs = debug.renderMs ? debug.renderMs * 0.9 + cost * 0.1 : cost;
        debug.framesRendered++;
      }
      debug.viewMode = view.shown;
      debug.viewStatus = view.status;
      debug.actors = view.actorsSpeaking();
      ui.setViewMode(view.shown);
    } catch (err) {
      console.warn('[phone] view frame failed', err);
    }
  } else {
    ui.drawFallback(toQuat(q), fovDeg, off, NO_3D ? '3D disabled (?3d=0)' : 'loading 3D…');
  }
  if (recording) ui.setRecordTime((now - recordStartedAt) / 1000);
  debug.sceneRunning = dialogue.running(scene, now);
  ui.setPlaying(debug.sceneRunning);
  if (now - fpsAt >= 1000) {
    debug.fps = Math.round(((debug.framesRendered - fpsFrames) * 10000) / (now - fpsAt)) / 10;
    fpsAt = now;
    fpsFrames = debug.framesRendered;
    if (PERF) ui.setPerf(perfLabel(perfState()));
    if (EXTERNAL) mirrorNativeConn();
    if (view) debug.look = { name: view.look.look.name, revision: view.look.revision, postFrames: view.postFrames };
  }
  if (view && now - lastVoiceCheck > 100) {
    lastVoiceCheck = now;
    const v = view.voiceState();
    debug.audioPlaying = v.playing.length > 0;
    if (v.lineId && v.lineId !== debug.lastLinePlayed) {
      debug.lastLinePlayed = v.lineId;
      debug.audioPeak = 0;
    }
    if (debug.audioPlaying) debug.audioPeak = Math.max(debug.audioPeak, v.level);
  }
}

/** A remembered yes / no in localStorage (private mode or blocked storage: never remembered). */
function storageFlag(key: string, set?: boolean): boolean {
  try {
    if (set !== undefined) localStorage.setItem(key, set ? '1' : '0');
    return localStorage.getItem(key) === '1';
  } catch {
    return set ?? false;
  }
}

function withParam(key: string, value: string) {
  const u = new URL(location.href);
  u.searchParams.set(key, value);
  return u.toString();
}
