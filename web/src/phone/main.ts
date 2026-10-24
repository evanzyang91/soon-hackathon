// Phone camera entry (web/phone.html). Flow: room code → "Tap to start" (user gesture: sensor
// permission, fullscreen, landscape lock, wake lock) → wss /ws Hello{phone} → stream PhonePose
// ≤30 Hz while rendering the scene from the phone's pose (or the 2D viewfinder fallback).
//
// Pose streaming is the critical path: it never waits on, or breaks because of, the 3D view.
import { Euler, Quaternion } from 'three';
import type { PhonePose, RoomScan, SceneState, ServerMessage } from '@shared/protocol';
import { wallProximity } from '@shared/room';
import { SceneManifest, type Vec3 } from '@shared/schema';
import { clampFov, DEFAULT_FOV, focalLabel, pinchFov } from './fov.ts';
import { Gestures } from './gestures.ts';
import { KeyboardWalk, TouchStick } from './joystick.ts';
import { HandheldNudge } from './nudge.ts';
import { RelayClient, relayUrl, type ConnState } from './relay-client.ts';
import {
  anchorFor,
  captionFor,
  clockLabel,
  DialogueActivity,
  SceneClockTracker,
  type Anchor,
} from './scene-sync.ts';
import { OrientationTracker, screenAngle, toQuat } from './sensors.ts';
import { LEVELS, perfLabel, RenderGovernor, type PerfState } from './render-governor.ts';
import { PoseThrottle, poseKey } from './throttle.ts';
import { unlockAudio } from './audio.ts';
import { bindUi } from './ui.ts';
import { attitudeOf } from './viewfinder.ts';
import { enterFullscreenLandscape, keepScreenOn, requestSensorPermission } from './platform.ts';
import type { PhoneView } from './view.ts';
import { cameraPosition, headingOf, NO_WALK, Walker, type WalkInput } from './walk.ts';
import { clampExternalFov, installBridge } from './external.ts';

const params = new URLSearchParams(location.search);
const SIM = params.get('sim') === '1';
const ANGLE_OVERRIDE = params.has('angle') ? Number(params.get('angle')) : null;
const AUTO_RECENTER = params.get('recenter') !== '0';
const NO_3D = params.get('3d') === '0';
const SWAY_GAIN = Number(params.get('sway') ?? 1) || 1;
/** ?voice=0 mutes the actors on the phone (e.g. when the laptop's speakers are in the room). */
const VOICE = params.get('voice') !== '0';
/** ?pose=external: the native ARKit app sends poses and relay messages; this page only renders. */
const EXTERNAL = params.get('pose') === 'external';
const QUALITY =
  (['k100', 'k500', 'full'] as const).find((q) => q === params.get('quality')) ?? 'k500';
/** The joystick never takes the camera closer than this to the floor (y = 0). */
const MIN_EYE_HEIGHT = 0.15;

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
/** Manifest URL the "press Play" hint was last shown for. */
let hintedScene: string | null = null;
let stick: TouchStick | null = null;
let heightSlider: TouchStick | null = null;
let keys: KeyboardWalk | null = null;
/** Latest pose from the native app (pose=external), applied by the rAF loop. */
let extPose: PhonePose | null = null;
/** The real room the native app scanned (offset frame), for the wall warning. */
let roomScan: RoomScan | null = null;
const extQuat = new Quaternion();

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
  /** The laptop is running the scene (clock + dialogue): the ACTION button shows CUT. */
  sceneRunning: false,
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
  recording: false,
  /** The director's look as rendered here: name, edits.json revision, frames through the post pass. */
  look: { name: 'Default', revision: -1, postFrames: 0 },
  permission: 'unknown' as string,
  /** 'external' when the native app drives the pose (phone.html?pose=external). */
  poseSource: (EXTERNAL ? 'external' : 'sensors') as 'external' | 'sensors',
  /** Poses received through window.__previzPose. */
  externalPoses: 0,
  /** Real-wall state from the room scan: clear / near / outside (null without a scan). */
  wall: null as null | 'clear' | 'near' | 'outside',
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
  }
}
window.__phone = debug;

// -- start screen ------------------------------------------------------------------------------

const initialRoom = (params.get('room') ?? '').trim().toUpperCase();
ui.roomInput.value = initialRoom;
if (EXTERNAL) {
  startExternal();
} else {
  if (!window.isSecureContext) {
    ui.startError('Motion sensors need HTTPS. Open the https:// link printed by the server.');
  }
  ui.startButton.addEventListener('click', () => start());
  ui.roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') start();
  });
  if (params.get('autostart') === '1' && initialRoom) start();
}

/**
 * Native-driven start (ios/README.md, "Web side contract"): no start gate, sensors, relay,
 * joystick or pinch; the app forwards relay messages and sends the pose it also streams.
 */
function startExternal(): void {
  started = true;
  debug.started = true;
  debug.room = initialRoom;
  ui.showHud(initialRoom);
  ui.hideForExternal();
  // WKWebView allows media without a gesture; with ?voice=1 the actors speak here too.
  if (VOICE) unlockAudio((s) => (debug.audio = s));
  void initView();
  window.addEventListener('resize', () => view?.resize());
  installBridge({
    onPose: (pose) => {
      extPose = pose;
      debug.externalPoses++;
      debug.lastPose = pose;
      if (pose.recording !== recording) setRecording(pose.recording, false);
    },
    onMessage,
  });
  requestAnimationFrame(frame);
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

  stick = new TouchStick(ui.joystick.zone, ui.joystick.base, ui.joystick.knob, {
    radius: 48,
    axis: 'xy',
    floating: true,
  });
  stick.onDoubleTap = () => {
    resetWalk();
    ui.toast(`Back at ${anchor.name}`);
  };
  heightSlider = new TouchStick(ui.height.zone, ui.height.zone, ui.height.knob, {
    radius: 56,
    axis: 'y',
    floating: false,
  });
  if (SIM) keys = new KeyboardWalk();

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
  ui.onAction(() => sendSceneCommand('play-scene'));
  ui.onNextLine(() => sendSceneCommand('next-line'));
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
    view = new PhoneView(ui.glCanvas, ui.vfCanvas, QUALITY, { voice: VOICE });
    // the director's look: show its name briefly when it changes
    view.look.onName = (name) => ui.toast(`Look: ${name}`, 1800);
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
  ui.setLens(focalLabel(fovDeg));
}

/** ACTION / CUT and Line ›: the laptop owns the scene clock and the dialogue. */
function sendSceneCommand(cmd: 'play-scene' | 'next-line') {
  if (!scene || !debug.peers.laptop) {
    ui.toast('No scene yet — open one on the laptop');
    return;
  }
  relay?.send({ type: 'cmd', cmd });
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
        // pose=external: the app has already re-centred its own pose
        if (!EXTERNAL) recenter();
        ui.toast('Director recentered you');
      } else if (msg.cmd === 'shutter') ui.flash();
      else if (msg.cmd === 'record-start') setRecording(true, false);
      else if (msg.cmd === 'record-stop') setRecording(false, false);
      break;
    case 'pose':
      break; // phones do not receive poses
    case 'room':
      roomScan = msg; // only the native app forwards these (its own scan)
      break;
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
}

function refreshAnchor() {
  const next = anchorFor(scene, manifest);
  const changed = next.key !== anchor.key;
  anchor = next;
  debug.anchor = next;
  ui.setCameraName(next.name);
  if (changed) {
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
    // no 3D load to wait for: the scene is as loaded as it gets
    if (NO_3D || viewUnavailable || (view && !view.canRender3d)) sceneReady(url);
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
  if (view.sceneRuntime?.manifestUrl === url || view.loadFailed || !view.canRender3d) sceneReady(url);
}

/** A newly loaded scene that is not playing gets a hint about who starts it. */
function sceneReady(url: string) {
  if (url !== manifestUrlLoaded || hintedScene === url) return;
  hintedScene = url;
  if (!clock.isPlaying) ui.toast('Laptop: press Play or tap ACTION to start the scene', 2000);
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
  if (EXTERNAL) return; // the native app streams the pose
  const gapMs = now - lastPumpAt;
  const dt = Math.min(0.1, Math.max(0, gapMs / 1000));
  lastPumpAt = now;
  // Main-thread stalls between pump ticks are what starve the pose stream.
  if (document.visibilityState === 'visible' && view?.mode === 'webgl')
    governor.observeGap(now, gapMs);
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
  let q = tracker.quaternion;
  let off = nudge.offset;
  let walked = walker.offset;
  if (EXTERNAL && extPose) {
    q = extQuat.fromArray(extPose.q);
    off = extPose.nudge;
    walked = extPose.offset ?? [0, 0, 0];
    if (extPose.fovDeg !== fovDeg) {
      fovDeg = clampExternalFov(extPose.fovDeg);
      ui.setLens(focalLabel(fovDeg));
    }
  }
  const pose = { position: anchor.position, quaternion: q, fovDeg, offset: walked, nudge: off };
  debug.cameraPosition = cameraPosition(pose);
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
  const a = attitudeOf(q);
  ui.setAttitude(
    `HDG ${a.headingDeg.toFixed(0).padStart(3, '0')}° TILT ${a.pitchDeg.toFixed(0)}° ROLL ${a.rollDeg.toFixed(0)}°`,
  );
  if (recording) ui.setRecordTime((now - recordStartedAt) / 1000);
  debug.sceneRunning = dialogue.running(scene, now);
  ui.setAction(debug.sceneRunning);
  ui.setClock(scene ? clockLabel(clock.time(now), clock.isPlaying) : '', clock.isPlaying);
  if (now - fpsAt >= 1000) {
    debug.fps = Math.round(((debug.framesRendered - fpsFrames) * 10000) / (now - fpsAt)) / 10;
    fpsAt = now;
    fpsFrames = debug.framesRendered;
    ui.setPerf(perfLabel(perfState()));
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
  ui.setWalkReadout(walkReadout(walker.offset));
  if (roomScan && extPose) updateWall(roomScan, extPose.offset ?? [0, 0, 0]);
}

/** Warn before the person filming walks into a real wall (pose offset vs the scanned outline). */
function updateWall(room: RoomScan, offset: Vec3) {
  const w = wallProximity([offset[0], offset[2]], room.outline);
  if (w.kind === 'clear' && debug.wall === 'clear') return; // the distance only shows near walls
  debug.wall = w.kind;
  ui.setWall(
    w.kind,
    w.kind === 'near'
      ? `Wall ${w.meters.toFixed(1)} m`
      : w.kind === 'outside'
        ? `Outside the scanned room (${w.meters.toFixed(1)} m)`
        : 'Room scanned',
  );
}

/** "1.2 m · ↑0.4 m" away from the attached camera; '' while standing on it. */
function walkReadout(o: Vec3): string {
  const flat = Math.hypot(o[0], o[2]);
  const parts: string[] = [];
  if (flat >= 0.05) parts.push(`↔ ${flat.toFixed(1)} m`);
  if (Math.abs(o[1]) >= 0.05) parts.push(`${o[1] > 0 ? '↑' : '↓'} ${Math.abs(o[1]).toFixed(1)} m`);
  return parts.length ? `${parts.join(' · ')} from ${anchor.name}` : '';
}

function withParam(key: string, value: string) {
  const u = new URL(location.href);
  u.searchParams.set(key, value);
  return u.toString();
}
