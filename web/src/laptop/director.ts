// Laptop director state + render loop. Panels read state from here and call its actions; it
// emits coarse change events so they can re-render.
import * as THREE from 'three';
import type { DropCamera, PhoneCommand, ServerMessage } from '@shared/protocol';
import type { Quat, SuggestedShot, Vec3 } from '@shared/schema';
import { ViewportRenderer, type PipRect } from '../viewer/render';
import { loadScene, type SceneRuntime, type SplatQuality } from '../viewer/world';
import { downloadBlob } from './dom';
import { FlyControls } from './fly-controls';
import { CameraMarkers, FrustumGizmo, GIZMO_LAYER } from './gizmos';
import {
  buildSceneState,
  cycleCamera,
  initialPhoneLink,
  nextCameraName,
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
import { storageGet, storageSet } from './storage';

export type Change =
  'scene' | 'loading' | 'cameras' | 'clock' | 'phone' | 'lines' | 'view' | 'recording' | 'pairing';

/** Phone framing when its pose does not carry `aspect` (landscape 16:9). */
export const PHONE_ASPECT = 16 / 9;
const HEARTBEAT_MS = 250;

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);
const q4 = (q: Quat) => new THREE.Quaternion(q[0], q[1], q[2], q[3]);
const toVec3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
const toQuat = (q: THREE.Quaternion): Quat => [q.x, q.y, q.z, q.w];
const uid = () => Math.random().toString(36).slice(2, 10);

export class Director {
  readonly view: ViewportRenderer;
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
  readonly phoneCamera = new THREE.PerspectiveCamera(60, PHONE_ASPECT, 0.05, 2000);
  /** Stand-in for the active drop camera when no phone is attached (PiP preview). */
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
  cameras: DropCamera[] = [];
  activeCameraId: string | null = null;
  speakingLineId: string | null = null;
  viewFromPhone = false;
  pipEnabled = true;
  quality: SplatQuality = 'k500';
  phone: PhoneLinkState = initialPhoneLink();
  linkStatus: LinkStatus = 'idle';
  room: { room: string; phoneUrl: string } | null = null;
  pipRect: PipRect | null = null;
  pipLabel = '';
  takes = 0;
  lastStillAt = 0;

  private readonly subscribers = new Set<(c: Change) => void>();
  private lastSentKey = '';
  private lastSentAt = 0;
  private loadToken = 0;
  private playlistToken = 0;
  private raf = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastFrame = 0;
  private lastClockEmit = 0;
  private hadPhone = false;

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
    const resume = () => void this.listener.context.resume();
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
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
      this.projectId = projectId;
      this.sceneIndex = sceneIndex;
      this.manifestUrl = manifestUrl;
      this.speakingLineId = null;
      rt.scene.add(this.markers.group, this.phoneGizmo.object);
      this.view.setScene(rt.scene);
      prev?.dispose();
      const sc = rt.manifest.startCamera;
      this.controls.flyTo(v3(sc.position), q4(sc.quaternion), sc.fovDeg, 0);
      const saved = storageGet<{ cameras: DropCamera[]; activeCameraId: string | null }>(
        this.storageKey(),
      );
      this.cameras = saved?.cameras ?? [];
      this.activeCameraId = saved?.activeCameraId ?? null;
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

  private storageKey() {
    return `previz:cams:${this.projectId}:${this.sceneIndex}`;
  }

  // ---- cameras ------------------------------------------------------------------------------

  private camerasChanged() {
    if (this.projectId)
      storageSet(this.storageKey(), { cameras: this.cameras, activeCameraId: this.activeCameraId });
    this.emit('cameras');
    this.broadcast();
  }

  /** Drops a camera at the current main view (the phone's view when viewing from the phone). */
  dropCamera(name?: string): DropCamera {
    const src = this.mainCamera();
    const cam: DropCamera = {
      id: uid(),
      name: name?.trim() || nextCameraName(this.cameras),
      position: toVec3(src.position),
      quaternion: toQuat(src.quaternion),
      fovDeg: Math.round(src.fov * 10) / 10,
    };
    this.cameras = [...this.cameras, cam];
    if (!this.activeCameraId) this.activeCameraId = cam.id;
    this.camerasChanged();
    return cam;
  }

  addShotAsCamera(shot: SuggestedShot) {
    const cam: DropCamera = { id: uid(), ...shot, name: shot.name.slice(0, 40) };
    this.cameras = [...this.cameras, cam];
    if (!this.activeCameraId) this.activeCameraId = cam.id;
    this.camerasChanged();
  }

  removeCamera(id: string) {
    this.cameras = this.cameras.filter((c) => c.id !== id);
    if (this.activeCameraId === id) this.activeCameraId = this.cameras[0]?.id ?? null;
    this.camerasChanged();
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
    this.setPlaying(true);
    const lines = [...rt.manifest.plan.dialogue].sort((a, b) => a.order - b.order);
    for (const line of lines) {
      if (token !== this.playlistToken || this.runtime !== rt) return;
      await this.speak(rt, line.id);
      await new Promise((r) => setTimeout(r, 350));
    }
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
    const blob = await this.recorder.stop();
    this.emit('recording');
    if (!blob) return;
    this.takes++;
    const slug = this.runtime?.manifest.plan.slug ?? 'scene';
    downloadBlob(blob, `previz-${slug}-take${this.takes}.webm`);
  }

  /** Renders one frame from the phone (or main) camera and downloads it as PNG. */
  captureStill() {
    const cam = this.phone.lastPose ? this.phoneCamera : this.mainCamera();
    this.view.renderMain(cam);
    // toBlob reads the drawing buffer before the next composite, so no preserveDrawingBuffer
    this.canvas.toBlob((b) => {
      if (!b) return;
      const slug = this.runtime?.manifest.plan.slug ?? 'scene';
      downloadBlob(b, `previz-${slug}-still-${Date.now()}.png`);
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
    this.markers.sync(this.cameras, this.activeCameraId);
    this.updatePhone(t);

    const main = this.mainCamera();
    if (this.listener.parent !== main) main.add(this.listener);
    this.view.renderMain(main);

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
