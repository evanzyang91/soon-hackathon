// Laptop director state + render loop. Panels read state from here and call its actions; it
// emits coarse change events so they can re-render.
import * as THREE from 'three';
import type { DropCamera, PhoneCommand, SceneState, ServerMessage } from '@shared/protocol';
import { SceneManifest, type Quat, type SuggestedShot, type Vec3 } from '@shared/schema';
import type { RegionSelection } from '../viewer/edits/select';
import type { TargetRef } from '../viewer/manipulate/edits';
import { UndoStack } from '../viewer/manipulate/undo';
import { colliderTriangles, rayHit, TriGrid } from '../viewer/placement';
import { ViewportRenderer, type PipRect } from '../viewer/render';
import { sceneShotActors, suggestShots } from '../viewer/shots';
import { loadScene, type SceneRuntime, type SplatQuality } from '../viewer/world';
import { downloadBlob } from './dom';
import { FlyControls } from './fly-controls';
import { CameraMarkers, FrustumGizmo, GIZMO_LAYER } from './gizmos';
import {
  buildSceneState,
  cycleCamera,
  initialPhoneLink,
  nextLineId,
  phoneAnchor,
  phoneCameraPose,
  phoneCommand,
  pipRectFor,
  poseAspect,
  poseIsFresh,
  reducePhoneLink,
  sceneStateKey,
  type CameraPose,
  type PhoneLinkState,
} from './messages';
import { TakeRecorder } from './recorder';
import { RelayLink, type LinkStatus } from './relay-link';
import { storageSet } from './storage';

export type Change =
  | 'scene'
  | 'loading'
  | 'cameras'
  | 'clock'
  | 'phone'
  | 'lines'
  | 'view'
  | 'recording'
  | 'pairing'
  /** The viewport selection (`selection`) changed. */
  | 'selection'
  /** The selected splat region (`pendingRegion`) changed. */
  | 'region'
  /** The direct-manipulation undo stack changed. */
  | 'undo';

/** A recorded take, kept for this session (the WebM also downloads when the take stops). */
export interface Take {
  n: number;
  /** "Take 2 · 1B · Over Leo's shoulder": the shot the phone was on when it started. */
  name: string;
  blob: Blob;
  /** Object URL of `blob` (lives as long as the page). */
  url: string;
  seconds: number;
  file: string;
}

/** Phone framing when its pose does not carry `aspect` (landscape 16:9). */
export const PHONE_ASPECT = 16 / 9;
const HEARTBEAT_MS = 250;
/** A dragged camera reaches the phone at most this often (its anchor follows live). */
const LIVE_CAMERA_MS = 50;

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);
const q4 = (q: Quat) => new THREE.Quaternion(q[0], q[1], q[2], q[3]);
/** The server's start camera (server/pipeline/project.ts START_CAMERA): nobody chose it. */
const isDefaultStart = (c: { position: Vec3; quaternion: Quat }) =>
  [0, 1.6, 0].every((v, i) => Math.abs(c.position[i]! - v) < 1e-6) &&
  [0, 0, 0, 1].every((v, i) => Math.abs(c.quaternion[i]! - v) < 1e-6);
/** How long after a scene opens its start view keeps re-framing the cast as it settles (ms). */
const FRAME_CAST_MS = 10_000;

export class Director {
  readonly view: ViewportRenderer;
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
  readonly phoneCamera = new THREE.PerspectiveCamera(60, PHONE_ASPECT, 0.05, 2000);
  /** Stand-in for the active shot when no phone is attached (PiP preview). */
  readonly shotCamera = new THREE.PerspectiveCamera(50, PHONE_ASPECT, 0.05, 2000);
  readonly listener = new THREE.AudioListener();
  readonly controls: FlyControls;
  readonly link: RelayLink;
  readonly recorder: TakeRecorder;
  readonly markers = new CameraMarkers();
  readonly phoneGizmo = new FrustumGizmo('#ff4fa0', 0.7, { body: true, label: 'PHONE' });

  runtime: SceneRuntime | null = null;
  loading: string | null = null;
  error: string | null = null;
  projectId: string | null = null;
  sceneIndex: number | null = null;
  manifestUrl: string | null = null;
  /** The open scene's manifest changed on disk but could not be applied live: offer a reload. */
  sceneStale = false;
  /**
   * The open scene's shot list as the phone sees it (shots-panel.ts keeps it in step with
   * scene-<n>/shots.json: one DropCamera per shot, same ids); the phone attaches to the active one.
   */
  cameras: DropCamera[] = [];
  activeCameraId: string | null = null;
  speakingLineId: string | null = null;
  /** Last dialogue line started (clicked, played in order, or from the phone's "Line ›"). */
  lastLineId: string | null = null;
  viewFromPhone = false;
  pipEnabled = true;
  quality: SplatQuality = 'k500';
  phone: PhoneLinkState = initialPhoneLink();
  linkStatus: LinkStatus = 'idle';
  room: { room: string; phoneUrl: string } | null = null;
  pipRect: PipRect | null = null;
  pipLabel = '';
  takes = 0;
  /** This session's takes, newest last (the Camera panel lists them). */
  readonly takeList: Take[] = [];
  lastStillAt = 0;
  /** Adds fields to each SceneState before it is sent (look panel: editsRevision, live look). */
  decorateState: ((state: SceneState) => void) | null = null;
  /** Direct manipulation's undo stack (moves, deletes, region edits, camera drags) for this scene. */
  readonly undo = new UndoStack();
  /** What is selected in the viewport (viewer/manipulate); panels highlight it. */
  selection: TargetRef | null = null;
  /**
   * The splat region the director clicked in the viewport (a sphere around the hit, resized by
   * dragging its outline): Re-prompt can use it as the selection for its next prompt.
   */
  pendingRegion: RegionSelection | null = null;

  private readonly subscribers = new Set<(c: Change) => void>();
  private lastSentKey = '';
  private lastSentAt = 0;
  private loadToken = 0;
  private playlistToken = 0;
  /** playlistToken of the "Play scene" run in progress (stale = not running). */
  private playlistRun = -1;
  private raf = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastFrame = 0;
  private lastClockEmit = 0;
  private hadPhone = false;
  private readonly frameHooks = new Set<(t: number) => void>();
  /** One-shot callbacks run right after the next main render, before the PiP draws over it. */
  private mainRendered: (() => void)[] = [];
  private lastLiveCamera = 0;
  /** Collider grids for the suggested shots' line-of-sight checks, built once per scene. */
  private readonly shotGrids = new WeakMap<SceneRuntime, TriGrid>();
  /**
   * The start view framing the cast (a scene with the default start camera): while the scene
   * settles (collider placement, edits moving actors) it follows the cast, until the director
   * moves the camera or selects something. `pose` is where it put the camera.
   */
  private castAim: { until: number; key: string; pose: number[] } | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.view = new ViewportRenderer(canvas);
    this.camera.layers.enable(GIZMO_LAYER);
    this.camera.position.set(0, 1.6, 4);
    this.camera.add(this.listener);
    this.controls = new FlyControls(this.camera, canvas);
    this.recorder = new TakeRecorder(canvas, {
      context: this.listener.context,
      output: this.listener.getInput(),
    });
    this.link = new RelayLink({
      onMessage: (m) => this.handleMessage(m),
      onStatus: (s) => {
        this.linkStatus = s;
        if (s !== 'open') this.phone = initialPhoneLink();
        this.emit('pairing');
      },
      onOpen: () => this.broadcast(true),
    });
    this.undo.onChange(() => this.emit('undo'));
    // Browsers start audio only from a user gesture: the first click anywhere (Generate, a scene
    // row, the canvas…) or key press resumes the context. Capture phase, so a handler that stops
    // propagation cannot swallow it; pointerup / click / touchend cover touch screens, where a
    // pointerdown does not count as a gesture.
    const resume = () => {
      const ctx = this.listener.context;
      if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    };
    for (const ev of ['pointerdown', 'pointerup', 'click', 'touchend', 'keydown'])
      window.addEventListener(ev, resume, { capture: true, passive: true });
  }

  // ---- events -------------------------------------------------------------------------------

  on(fn: (c: Change) => void) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(c: Change) {
    for (const fn of this.subscribers) fn(c);
  }

  // ---- scene --------------------------------------------------------------------------------

  async openScene(projectId: string, sceneIndex: number, manifestUrl: string) {
    const token = ++this.loadToken;
    this.stopLines();
    this.loading = 'loading…';
    this.error = null;
    this.emit('loading');
    try {
      const rt = await loadScene(manifestUrl, {
        renderer: this.view.renderer,
        listener: this.listener,
        quality: this.quality,
        onStatus: (m) => {
          if (token !== this.loadToken) return;
          this.loading = m;
          this.emit('loading');
        },
      });
      if (token !== this.loadToken) {
        rt.dispose();
        return;
      }
      const prev = this.runtime;
      this.runtime = rt;
      this.undo.clear();
      this.selection = null;
      this.pendingRegion = null;
      this.projectId = projectId;
      this.sceneIndex = sceneIndex;
      this.manifestUrl = manifestUrl;
      this.sceneStale = false;
      this.speakingLineId = null;
      this.lastLineId = null;
      rt.scene.add(this.markers.group, this.phoneGizmo.object);
      this.view.setScene(rt.scene);
      prev?.dispose();
      // the collider arrives after the scene opens: refresh the HUD (Collider button) then
      void rt.colliderReady.then((c) => c && this.runtime === rt && this.emit('scene'));
      // the server's default start camera knows nothing of the cast: open on the Wide master
      const sc = rt.manifest.startCamera;
      const wide = isDefaultStart(sc) ? this.suggestedShots()[0] : undefined;
      const start = wide ?? sc;
      this.controls.flyTo(v3(start.position), q4(start.quaternion), start.fovDeg, 0);
      this.castAim = wide
        ? { until: performance.now() + FRAME_CAST_MS, key: castKey(rt), pose: this.cameraPose() }
        : null;
      void rt.colliderReady.then(() => {
        if (this.castAim && this.runtime === rt)
          this.castAim.until = Math.max(this.castAim.until, performance.now() + 3000);
      });
      // the Shots panel loads this scene's shot list and hands it over (setCameras)
      this.cameras = [];
      this.activeCameraId = null;
      this.loading = null;
      const url = new URL(location.href);
      url.searchParams.set('project', projectId);
      url.searchParams.set('scene', String(sceneIndex));
      url.searchParams.delete('manifest');
      history.replaceState(null, '', url);
      this.emit('scene');
      this.emit('cameras');
      this.broadcast(true);
    } catch (err) {
      if (token !== this.loadToken) return;
      console.warn('scene failed to load', err);
      this.loading = null;
      this.error = err instanceof Error ? err.message : String(err);
      this.emit('loading');
    }
  }

  /**
   * Re-reads the open scene's manifest and swaps every actor whose asset changed (a finished
   * "High detail" rebuild), keeping the camera, the clock and the other actors. The manifest URL
   * gets a revision query so the paired phone reloads the scene with the new actor. When the swap
   * fails, `sceneStale` makes the HUD offer a reload instead.
   */
  async refreshActors(): Promise<string[]> {
    const rt = this.runtime;
    const url = this.manifestUrl;
    if (!rt || !url) return [];
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const fresh = SceneManifest.parse(await res.json());
      if (this.runtime !== rt) return [];
      const swapped = await rt.swapActors(fresh.actors);
      if (swapped.length && this.runtime === rt) {
        const u = new URL(url, location.href);
        u.searchParams.set('rev', String(Date.now()));
        this.manifestUrl = u.pathname + u.search;
        this.broadcast(true);
        this.emit('scene');
      }
      return swapped;
    } catch (err) {
      console.warn('actor refresh failed; offering a reload', err);
      if (this.runtime === rt) {
        this.sceneStale = true;
        this.emit('scene');
      }
      return [];
    }
  }

  reloadScene() {
    if (this.projectId && this.sceneIndex != null && this.manifestUrl)
      void this.openScene(this.projectId, this.sceneIndex, this.manifestUrl);
  }

  async setQuality(q: SplatQuality) {
    this.quality = q;
    if (this.runtime) {
      this.loading = `loading ${q} splats…`;
      this.emit('loading');
      await this.runtime.setQuality(q);
      this.loading = null;
      this.emit('loading');
    }
  }

  // ---- cameras (the shot list) -----------------------------------------------------------------

  private camerasChanged() {
    this.emit('cameras');
    this.broadcast();
  }

  /** The Shots panel's list as the phone's cameras (same ids); `activeId` = the shot the phone is on. */
  setCameras(cameras: DropCamera[], activeId: string | null) {
    const active = cameras.some((c) => c.id === activeId) ? activeId : null;
    if (JSON.stringify([cameras, active]) === JSON.stringify([this.cameras, this.activeCameraId])) return;
    this.cameras = structuredClone(cameras);
    this.activeCameraId = active;
    this.camerasChanged();
  }

  /**
   * Suggested coverage of the open scene from where its actors stand now (viewer/shots.ts): Wide
   * master, Two-shot, Over X's shoulder on Y, a Close-up each. Framed for `aspect` (default: the
   * narrower of this viewport and the phone's 16:9, what the start view needs); camera spots
   * behind a wall of the set are moved (collider). Empty without actors.
   */
  suggestedShots(aspect?: number): SuggestedShot[] {
    const rt = this.runtime;
    if (!rt) return [];
    const { width, height } = this.view.size;
    const sc = rt.manifest.startCamera.position;
    return suggestShots(sceneShotActors(rt), (x, z) => rt.groundY(x, z), {
      aspect: aspect ?? Math.min(PHONE_ASPECT, width > 0 && height > 0 ? width / height : PHONE_ASPECT),
      audience: [sc[0], sc[2]],
      hit: this.colliderHit(rt),
    });
  }

  /** Distance from `from` toward `to` to the first collider surface (null: clear; no collider: none). */
  private colliderHit(rt: SceneRuntime) {
    const collider = rt.collider;
    if (!collider) return undefined;
    let grid = this.shotGrids.get(rt);
    if (!grid) {
      grid = new TriGrid(colliderTriangles(collider));
      this.shotGrids.set(rt, grid);
    }
    const g = grid;
    return (from: Vec3, to: Vec3): number | null => {
      const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      if (len < 1e-6) return null;
      const near = g.query(
        Math.min(from[0], to[0]) - 0.1,
        Math.min(from[2], to[2]) - 0.1,
        Math.max(from[0], to[0]) + 0.1,
        Math.max(from[2], to[2]) + 0.1,
      );
      return rayHit(near, from, [d[0] / len, d[1] / len, d[2] / len], len);
    };
  }

  private cameraPose(): number[] {
    return [...this.camera.position.toArray(), ...this.camera.quaternion.toArray()];
  }

  /** Keeps the cast-framing start view on the cast while the scene settles (see `castAim`). */
  private followCast(now: number) {
    const aim = this.castAim;
    const rt = this.runtime;
    if (!aim || !rt) return;
    const pose = this.cameraPose();
    const moved = pose.some((v, i) => Math.abs(v - aim.pose[i]!) > 1e-5);
    if (now > aim.until || moved || this.viewFromPhone || this.selection) {
      this.castAim = null;
      return;
    }
    const key = castKey(rt);
    if (key === aim.key) return;
    aim.key = key;
    const wide = this.suggestedShots()[0];
    if (!wide) return;
    this.controls.flyTo(v3(wide.position), q4(wide.quaternion), wide.fovDeg, 0);
    aim.pose = this.cameraPose();
  }

  removeCamera(id: string) {
    this.cameras = this.cameras.filter((c) => c.id !== id);
    if (this.activeCameraId === id) this.activeCameraId = this.cameras[0]?.id ?? null;
    this.camerasChanged();
  }

  /**
   * Changes a shot's camera (its frustum dragged in the viewport). Live changes (a drag in the viewport) reach the phone at ≤ 20 Hz, so
   * a phone attached to it follows; `persist` ends the change (saved, panels re-render).
   */
  updateCamera(id: string, patch: Partial<Omit<DropCamera, 'id'>>, persist: boolean) {
    if (!this.cameras.some((c) => c.id === id)) return;
    this.cameras = this.cameras.map((c) => (c.id === id ? { ...c, ...structuredClone(patch), id } : c));
    if (persist) return this.camerasChanged();
    const now = performance.now();
    if (now - this.lastLiveCamera >= LIVE_CAMERA_MS) {
      this.lastLiveCamera = now;
      this.broadcast();
    }
  }

  /** Puts a deleted camera back where it was (undo). */
  restoreCamera(cam: DropCamera, index: number, active: boolean) {
    if (this.cameras.some((c) => c.id === cam.id)) return;
    const list = [...this.cameras];
    list.splice(Math.max(0, Math.min(index, list.length)), 0, structuredClone(cam));
    this.cameras = list;
    if (active || !this.activeCameraId) this.activeCameraId = cam.id;
    this.camerasChanged();
  }

  // ---- selection ----------------------------------------------------------------------------

  /** Selects an actor / prop / light / camera in the viewport (null clears). */
  select(ref: TargetRef | null) {
    const same = ref?.type === this.selection?.type && ref?.id === this.selection?.id;
    if (same) return;
    this.selection = ref ? { ...ref } : null;
    this.emit('selection');
  }

  setPendingRegion(sel: RegionSelection | null) {
    if (JSON.stringify(sel) === JSON.stringify(this.pendingRegion)) return;
    this.pendingRegion = sel ? structuredClone(sel) : null;
    this.emit('region');
  }

  /** Runs every frame right before the views render (viewport overlays that follow the scene). */
  onFrame(fn: (t: number) => void) {
    this.frameHooks.add(fn);
    return () => this.frameHooks.delete(fn);
  }

  /**
   * Runs `fn` once, right after the next main render and before the PiP is drawn over it (a
   * frame grab reads the canvas there; the canvas keeps its bytes until the task ends).
   */
  afterNextMainRender(fn: () => void) {
    this.mainRendered.push(fn);
  }

  setActiveCamera(id: string | null) {
    this.activeCameraId = this.cameras.some((c) => c.id === id) ? id : null;
    this.camerasChanged();
  }

  flyTo(target: { position: Vec3; quaternion: Quat; fovDeg: number }) {
    if (this.viewFromPhone) this.setViewFromPhone(false);
    this.controls.flyTo(v3(target.position), q4(target.quaternion), target.fovDeg);
  }

  // ---- clock + dialogue ---------------------------------------------------------------------

  setPlaying(playing: boolean) {
    if (!this.runtime) return;
    this.runtime.playing = playing;
    this.emit('clock');
    this.broadcast();
  }

  togglePlay() {
    this.setPlaying(!this.runtime?.playing);
  }

  resetClock() {
    this.runtime?.setTime(0);
    this.emit('clock');
    this.broadcast(true);
  }

  async playLine(lineId: string) {
    const rt = this.runtime;
    if (!rt) return;
    this.playlistToken++;
    await this.speak(rt, lineId);
  }

  private async speak(rt: SceneRuntime, lineId: string) {
    this.speakingLineId = lineId;
    this.lastLineId = lineId;
    this.emit('lines');
    this.broadcast();
    try {
      await rt.playLine(lineId);
    } catch (err) {
      console.warn(`line ${lineId} failed`, err);
    }
    if (this.runtime === rt && this.speakingLineId === lineId && !rt.speakingLineId) {
      this.speakingLineId = null;
      this.emit('lines');
      this.broadcast();
    }
  }

  /** Runs the scene's dialogue in order (also starts the clock so dynamics move). */
  async playAll() {
    const rt = this.runtime;
    if (!rt) return;
    const token = ++this.playlistToken;
    this.playlistRun = token;
    this.setPlaying(true);
    const lines = [...rt.manifest.plan.dialogue].sort((a, b) => a.order - b.order);
    try {
      for (const line of lines) {
        if (token !== this.playlistToken || this.runtime !== rt) return;
        await this.speak(rt, line.id);
        await new Promise((r) => setTimeout(r, 350));
      }
    } finally {
      if (this.playlistRun === token) this.playlistRun = -1;
    }
  }

  /**
   * The scene is running: clock playing and its dialogue under way ("Play scene" in progress or a
   * line being spoken). The phone shows its ACTION button as CUT exactly then.
   */
  get sceneRunning(): boolean {
    const playlist = this.playlistRun !== -1 && this.playlistRun === this.playlistToken;
    return !!this.runtime?.playing && (playlist || !!this.speakingLineId);
  }

  /** The phone's ACTION / CUT: "Play scene" from the first line, or stop the lines and the clock. */
  toggleScene() {
    if (!this.runtime) return;
    if (this.sceneRunning) {
      this.stopLines();
      this.setPlaying(false);
    } else void this.playAll();
  }

  /** The phone's "Line ›": the line after the last one played, wrapping to the first. */
  async playNextLine() {
    const rt = this.runtime;
    if (!rt) return;
    const id = nextLineId(rt.manifest.plan.dialogue, this.lastLineId);
    if (id) await this.playLine(id);
  }

  stopLines() {
    this.playlistToken++;
    this.runtime?.stopLines();
    if (this.speakingLineId) {
      this.speakingLineId = null;
      this.emit('lines');
      this.broadcast();
    }
  }

  // ---- view ---------------------------------------------------------------------------------

  setViewFromPhone(on: boolean) {
    this.viewFromPhone = on;
    this.controls.enabled = !on;
    this.emit('view');
  }

  setPip(on: boolean) {
    this.pipEnabled = on;
    this.emit('view');
  }

  mainCamera(): THREE.PerspectiveCamera {
    return this.viewFromPhone ? this.phoneCamera : this.camera;
  }

  phoneAttached(now = performance.now()) {
    return this.phone.phones > 0 || poseIsFresh(this.phone, now);
  }

  /** Width / height of what the followed phone renders (its pose says; else 16:9). */
  phoneAspect(): number {
    return poseAspect(this.phone.lastPose, PHONE_ASPECT);
  }

  /** Current phone camera pose in the world (null until the phone has sent one). */
  phonePose(): CameraPose | null {
    if (!this.phone.lastPose) return null;
    const start = this.runtime?.manifest.startCamera.position ?? [0, 1.6, 0];
    return phoneCameraPose(
      this.phone.lastPose,
      phoneAnchor(this.cameras, this.activeCameraId, start),
    );
  }

  // ---- takes --------------------------------------------------------------------------------

  async toggleRecording() {
    if (this.recorder.recording) await this.stopRecording();
    else this.startRecording();
  }

  startRecording() {
    if (!this.recorder.start()) return;
    this.emit('recording');
  }

  async stopRecording() {
    const seconds = (performance.now() - this.recorder.startedAt) / 1000;
    const on = this.cameras.find((c) => c.id === this.activeCameraId);
    const blob = await this.recorder.stop();
    this.emit('recording');
    if (!blob) return;
    this.takes++;
    const slug = this.runtime?.manifest.plan.slug ?? 'scene';
    const file = `previz-${slug}-take${this.takes}.webm`;
    this.takeList.push({
      n: this.takes,
      name: `Take ${this.takes}${on ? ` · ${on.name}` : ''}`,
      blob,
      url: URL.createObjectURL(blob),
      seconds,
      file,
    });
    downloadBlob(blob, file);
    this.emit('recording');
  }

  /** Renders one frame from the phone (or main) camera and downloads it as PNG ("Save frame"). */
  captureStill() {
    const cam = this.phone.lastPose ? this.phoneCamera : this.mainCamera();
    this.view.renderMain(cam);
    // toBlob reads the drawing buffer before the next composite, so no preserveDrawingBuffer
    this.canvas.toBlob((b) => {
      if (!b) return;
      const slug = this.runtime?.manifest.plan.slug ?? 'scene';
      downloadBlob(b, `previz-${slug}-frame-${Date.now()}.png`);
    }, 'image/png');
    this.lastStillAt = performance.now();
    this.emit('recording');
  }

  // ---- phone link ---------------------------------------------------------------------------

  pair(room: { room: string; phoneUrl: string }) {
    this.room = room;
    storageSet('previz:room', room.room);
    this.link.connect(room.room);
    this.emit('pairing');
  }

  recenterPhone() {
    this.link.send(phoneCommand('recenter'));
  }

  sendCommand(cmd: PhoneCommand['cmd']) {
    this.link.send(phoneCommand(cmd));
  }

  handleMessage(msg: ServerMessage) {
    const before = this.phone.phones;
    this.phone = reducePhoneLink(this.phone, msg, performance.now());
    if (msg.type === 'peers') {
      if (msg.phones > before) this.broadcast(true);
      this.emit('phone');
    } else if (msg.type === 'pose') {
      if (before === 0) this.emit('phone');
    } else if (msg.type === 'cmd') {
      this.handlePhoneCommand(msg.cmd);
    }
  }

  private handlePhoneCommand(cmd: PhoneCommand['cmd']) {
    switch (cmd) {
      case 'next-camera':
        this.setActiveCamera(cycleCamera(this.cameras, this.activeCameraId));
        break;
      case 'record-start':
        this.startRecording();
        break;
      case 'record-stop':
        void this.stopRecording();
        break;
      case 'shutter':
        this.captureStill();
        break;
      case 'play-scene':
        this.toggleScene();
        break;
      case 'next-line':
        void this.playNextLine();
        break;
      case 'recenter':
        break;
    }
  }

  /** Sends SceneState when it changed (or when forced / the heartbeat is due). */
  broadcast(force = false) {
    const state = buildSceneState({
      projectId: this.projectId,
      sceneIndex: this.sceneIndex,
      manifestUrl: this.manifestUrl,
      time: this.runtime?.time ?? 0,
      playing: this.runtime?.playing ?? false,
      cameras: this.cameras,
      activeCameraId: this.activeCameraId,
      speakingLineId: this.speakingLineId,
    });
    if (!state) return;
    this.decorateState?.(state);
    const key = sceneStateKey(state);
    const now = performance.now();
    if (!force && key === this.lastSentKey && now - this.lastSentAt < HEARTBEAT_MS) return;
    if (this.link.send(state)) {
      this.lastSentKey = key;
      this.lastSentAt = now;
    }
  }

  // ---- frame loop ---------------------------------------------------------------------------

  start() {
    // the heartbeat runs on a timer, not rAF, so the phone keeps getting the clock when the
    // director tab is in the background
    this.heartbeat = setInterval(() => this.broadcast(true), HEARTBEAT_MS);
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.heartbeat);
  }

  /** Computes where the PiP goes for a given canvas size (bottom-right, `aspect` shaped). */
  static pipRectFor(width: number, height: number, aspect = PHONE_ASPECT): PipRect {
    return pipRectFor(width, height, aspect);
  }

  private frame(t: number) {
    const raw = this.lastFrame ? (t - this.lastFrame) / 1000 : 0;
    this.lastFrame = t;
    // fly speed is clamped against hitches; the scene clock follows wall time so the phone and
    // the dialogue audio stay in sync even when the laptop renders slowly
    this.controls.update(Math.min(0.1, raw));
    const rt = this.runtime;
    rt?.update(Math.min(1, raw));
    this.followCast(t);
    this.markers.sync(this.cameras, this.activeCameraId);
    this.updatePhone(t);
    for (const fn of this.frameHooks) {
      try {
        fn(t);
      } catch (err) {
        console.warn('frame hook failed', err);
      }
    }

    const main = this.mainCamera();
    if (this.listener.parent !== main) main.add(this.listener);
    this.view.renderMain(main);
    for (const fn of this.mainRendered.splice(0)) {
      try {
        fn();
      } catch (err) {
        console.warn('after-render hook failed', err);
      }
    }

    const pip = this.pipSource(t);
    if (pip && this.pipEnabled && !this.recorder.recording) {
      const { width, height } = this.view.size;
      const aspect = pip.camera === this.phoneCamera ? this.phoneAspect() : PHONE_ASPECT;
      const rect = Director.pipRectFor(width, height, aspect);
      this.view.renderPip(pip.camera, rect);
      this.pipRect = rect;
      this.pipLabel = pip.label;
    } else {
      this.pipRect = null;
      this.pipLabel = '';
    }

    if (t - this.lastClockEmit > 100) {
      this.lastClockEmit = t;
      this.emit('clock');
    }
  }

  private updatePhone(now: number) {
    const attached = this.phoneAttached(now);
    if (attached !== this.hadPhone) {
      this.hadPhone = attached;
      this.emit('phone');
    }
    const pose = this.phonePose();
    if (pose) {
      this.phoneCamera.position.set(...pose.position);
      this.phoneCamera.quaternion.set(...pose.quaternion);
      if (Math.abs(this.phoneCamera.fov - pose.fovDeg) > 0.01) {
        this.phoneCamera.fov = pose.fovDeg;
        this.phoneCamera.updateProjectionMatrix();
      }
    } else {
      // no pose yet: the phone would see exactly the active camera (or the start camera)
      const active = this.cameras.find((c) => c.id === this.activeCameraId);
      const src = active ?? this.runtime?.manifest.startCamera;
      if (src) {
        this.phoneCamera.position.set(...src.position);
        this.phoneCamera.quaternion.set(...src.quaternion);
        this.phoneCamera.fov = src.fovDeg;
        this.phoneCamera.updateProjectionMatrix();
      }
    }
    this.phoneCamera.updateMatrixWorld();
    this.phoneGizmo.object.visible = attached && !this.viewFromPhone;
    this.phoneGizmo.setPose(this.phoneCamera.position, this.phoneCamera.quaternion);
    this.phoneGizmo.setFov(this.phoneCamera.fov, this.phoneAspect());
    this.phoneGizmo.setColor(
      poseIsFresh(this.phone, now)
        ? this.phone.lastPose?.recording
          ? '#ff3b3b'
          : '#ff4fa0'
        : '#7a5c6c',
    );
  }

  private pipSource(now: number): { camera: THREE.PerspectiveCamera; label: string } | null {
    if (!this.runtime) return null;
    if (this.viewFromPhone) return { camera: this.camera, label: 'DIRECTOR' };
    if (this.phone.lastPose && this.phoneAttached(now))
      return { camera: this.phoneCamera, label: 'PHONE' };
    const active = this.cameras.find((c) => c.id === this.activeCameraId);
    if (!active) return null;
    this.shotCamera.position.set(...active.position);
    this.shotCamera.quaternion.set(...active.quaternion);
    if (this.shotCamera.fov !== active.fovDeg) {
      this.shotCamera.fov = active.fovDeg;
      this.shotCamera.updateProjectionMatrix();
    }
    return { camera: this.shotCamera, label: active.name.toUpperCase() };
  }

  dispose() {
    this.stop();
    this.link.close();
    this.controls.dispose();
    this.runtime?.dispose();
    this.markers.dispose();
    this.phoneGizmo.dispose();
    this.view.dispose();
  }
}

/** Where the cast stands (cm) and whether the collider is in: a change re-frames the start view. */
export function castKey(rt: SceneRuntime): string {
  const spots = [...rt.actors.values()].map(
    (a) =>
      `${a.characterId}:${[a.object.position.x, a.object.position.z, a.object.rotation.y].map((v) => v.toFixed(2)).join(',')}`,
  );
  return `${rt.collider ? 1 : 0}|${spots.join('|')}`;
}
