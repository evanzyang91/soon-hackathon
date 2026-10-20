// Phone camera view: renders the shared scene (WP A's viewer/world.ts + viewer/render.ts) from the
// phone's pose, falling back to the 2D viewfinder whenever 3D is unavailable. Never throws into the
// caller — pose streaming must keep running whatever happens here.
import * as THREE from 'three';
import { defaultLook, Look } from '@shared/look';
import type { SceneState } from '@shared/protocol';
import type { Quat, Vec3 } from '@shared/schema';
import { fetchEdits } from '../viewer/look/edits-client.ts';
import { ViewportRenderer } from '../viewer/render.ts';
import type { SparkOptions } from '../viewer/spark.ts';
import { loadScene, type SceneRuntime, type SplatQuality } from '../viewer/world.ts';
import { drawViewfinder } from './viewfinder.ts';
import { cameraPosition } from './walk.ts';

export interface CameraPose {
  /** The attached (anchor) camera. */
  position: Vec3;
  quaternion: THREE.Quaternion;
  fovDeg: number;
  /** Joystick walk offset (m, world frame). */
  offset: Vec3;
  /** Handheld sway (m, world frame). */
  nudge: Vec3;
}

export interface SceneClock {
  /** Scene time (s) the laptop reported, extrapolated to now. */
  time: number;
  playing: boolean;
  speakingLineId: string | null;
}

export type ViewMode = 'viewfinder' | 'webgl';

export interface FrameOptions {
  /** Render a new 3D frame (false = keep the last one). */
  draw: boolean;
  /** Show the viewfinder instead of 3D (device too slow). */
  paused: boolean;
}

const DRAW: FrameOptions = { draw: true, paused: false };

/**
 * When the laptop's line ends, the phone (which started it a little later) gets this long to
 * finish its own copy before it is cut; a CUT from the laptop also stops it within this time.
 */
const LINE_TAIL_MS = 600;

export interface PhoneViewOptions {
  /** Play the actors' voices on the phone (positional, heard from the phone camera). */
  voice?: boolean;
}

/** What the phone's actors are saying right now (debug / e2e). */
export interface VoiceState {
  /** Characters whose voice is playing. */
  playing: string[];
  /** Line id of a voice that is playing (null when silent). */
  lineId: string | null;
  /** Loudest voice now, 0..1 (only non-zero when audio really flows: context running). */
  level: number;
}

/**
 * The director's look on the phone: edits.json (re-fetched whenever SceneState.editsRevision moves)
 * with the live look from SceneState on top while the laptop has unsaved changes. The live look
 * is kept until the file has caught up with the announced revision, so a save never flickers
 * back to the previous grade.
 */
export class PhoneLook {
  private key = '';
  private fileLook: Look | null = null;
  private fetched = -1;
  private wanted = 0;
  private live: Look | null = null;
  private inflight: Promise<void> | null = null;
  private applied = '';
  private lastName: string | null = null;
  /** The look's name changed (the HUD shows it briefly). */
  onName?: (name: string) => void;

  constructor(
    private readonly runtime: () => SceneRuntime | null,
    private readonly load: typeof fetchEdits = fetchEdits,
  ) {}

  /** What the phone renders now (defaults until anything arrives). */
  get look(): Look {
    return this.live ?? this.fileLook ?? defaultLook();
  }

  get revision(): number {
    return this.fetched;
  }

  update(s: SceneState): void {
    const key = `${s.projectId}/${s.sceneIndex}`;
    if (key !== this.key) {
      this.key = key;
      this.fileLook = null;
      this.fetched = -1;
      this.live = null;
    }
    this.wanted = s.editsRevision ?? 0;
    if (s.look) {
      const parsed = Look.safeParse(s.look);
      if (parsed.success) this.live = parsed.data;
    } else if (this.fetched >= this.wanted) this.live = null;
    if (this.fetched < this.wanted || this.fetched < 0) this.refetch(s.projectId, s.sceneIndex, key);
    this.apply();
  }

  private refetch(projectId: string, sceneIndex: number, key: string): void {
    if (this.inflight) return;
    this.inflight = this.load(projectId, sceneIndex)
      .then((doc) => {
        if (key !== this.key) return;
        this.fileLook = doc.look;
        this.fetched = doc.revision;
        if (this.fetched >= this.wanted) this.live = null;
        const rt = this.runtime();
        if (rt) rt.edits = doc;
        this.apply();
      })
      .catch((err) => {
        // no edits for this scene (ad-hoc manifest): the live look still applies
        console.warn('[phone] edits fetch failed', err);
        if (key === this.key) this.fetched = Math.max(this.fetched, 0);
      })
      .finally(() => {
        this.inflight = null;
        // the laptop announced a newer revision while this fetch was in flight
        if (key === this.key && this.fetched >= 0 && this.fetched < this.wanted)
          setTimeout(() => this.refetch(projectId, sceneIndex, key), 250);
      });
  }

  /** Applies the current look to the loaded scene (call again after a scene load). */
  apply(force = false): void {
    const look = this.look;
    const rt = this.runtime();
    const json = JSON.stringify(look);
    if (rt && (force || json !== this.applied)) {
      this.applied = json;
      rt.setLook(look);
    }
    if (look.name !== this.lastName) {
      const first = this.lastName === null;
      this.lastName = look.name;
      if (!first || look.name !== 'Default') this.onName?.(look.name);
    }
  }
}

/** Mobile-friendly Spark settings (WP A defaults are tuned for the laptop), applied at load. */
export const MOBILE_SPARK: SparkOptions = {
  maxStdDev: 2, // √4: the low end of Spark's acceptable range
  maxPixelRadius: 256,
  minAlpha: 2 / 255,
  minSortIntervalMs: 33,
};

export class PhoneView {
  mode: ViewMode = 'viewfinder';
  /** Why we are (or are not) rendering 3D — shown in the viewfinder and the debug hook. */
  status = 'waiting for the director…';
  private viewport: ViewportRenderer | null = null;
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
  private runtime: SceneRuntime | null = null;
  /** Per actor, the line id whose bubble is showing (debug / e2e). */
  actorsSpeaking(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const a of this.runtime?.actors.values() ?? [])
      out[a.characterId] = (a.object.userData.speakingLine ?? null) as string | null;
    return out;
  }
  private loadingUrl: string | null = null;
  private loadToken = 0;
  private lastSpeaking: string | null = null;
  private readonly vf: CanvasRenderingContext2D | null;
  private glFailed = false;
  private shownMode: ViewMode = 'viewfinder';
  /** One listener for every scene, riding on the phone camera so voices are positional. */
  private listener: THREE.AudioListener | null = null;
  private stopLinesAt: number | null = null;
  /** The director's grade / lens / lights (edits.json + the live look). */
  readonly look = new PhoneLook(() => this.runtime);
  private lookQuality = { bloom: true };

  constructor(
    private readonly glCanvas: HTMLCanvasElement,
    private readonly vfCanvas: HTMLCanvasElement,
    private readonly quality: SplatQuality = 'k500',
    private readonly opts: PhoneViewOptions = {},
  ) {
    this.vf = vfCanvas.getContext('2d');
    try {
      // Same renderer setup as the laptop (no MSAA, sRGB); pixel ratio capped at 1.5 for phones.
      // The look's bloom runs at half resolution with one blur iteration (mobile GPUs).
      this.viewport = new ViewportRenderer(glCanvas, {
        maxPixelRatio: 1.5,
        post: { bloomScale: 0.5, bloomIterations: 1 },
      });
      glCanvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.fail('WebGL context lost');
      });
    } catch (err) {
      this.fail(`3D unavailable (${(err as Error).message || 'no WebGL2'})`);
    }
    this.resize();
  }

  /** The last scene load failed (the viewfinder shows instead). */
  get loadFailed(): boolean {
    return this.mode !== 'webgl' && this.status.startsWith('scene failed');
  }

  /** False once WebGL is missing or has failed for good (the viewfinder is all there is). */
  get canRender3d(): boolean {
    return !!this.viewport && !this.glFailed;
  }

  get manifestUrl(): string | null {
    return this.runtime?.manifestUrl ?? this.loadingUrl;
  }

  get sceneRuntime(): SceneRuntime | null {
    return this.runtime;
  }

  /** Load (or switch to) a scene. Safe to call repeatedly with the same URL. */
  async load(manifestUrl: string): Promise<void> {
    if (!this.viewport || this.glFailed) return;
    if (manifestUrl === this.manifestUrl) return;
    const token = ++this.loadToken;
    this.loadingUrl = manifestUrl;
    this.status = 'loading scene…';
    try {
      // created here, not earlier: by now the start tap has handed three.js its unlocked context
      if (!this.listener) {
        this.listener = new THREE.AudioListener();
        this.listener.setMasterVolume(this.opts.voice === false ? 0 : 1);
        this.camera.add(this.listener);
      }
      const rt = await loadScene(manifestUrl, {
        renderer: this.viewport.renderer,
        listener: this.listener,
        quality: this.quality,
        spark: MOBILE_SPARK,
        onStatus: (m) => {
          if (token === this.loadToken) this.status = m;
        },
      });
      if (token !== this.loadToken) {
        rt.dispose();
        return;
      }
      this.viewport.setScene(rt.scene);
      this.runtime?.dispose();
      this.runtime = rt;
      rt.look.quality = { ...this.lookQuality };
      this.look.apply(true);
      this.lastSpeaking = null;
      this.stopLinesAt = null;
      this.mode = 'webgl';
      this.status = rt.placeholder ? 'placeholder world' : 'ready';
    } catch (err) {
      if (token !== this.loadToken) return;
      console.warn('[phone] scene failed to load', err);
      this.status = `scene failed to load: ${(err as Error).message}`;
      this.mode = 'viewfinder';
    } finally {
      if (token === this.loadToken) this.loadingUrl = null;
    }
  }

  resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.viewport?.resize(w, h);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.vfCanvas.width = Math.round(w * dpr);
    this.vfCanvas.height = Math.round(h * dpr);
    this.vf?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * One animation frame. The scene clock always advances. `draw: false` keeps the last image
   * (render throttling). `paused: true` shows the viewfinder while the scene stays loaded.
   */
  frame(pose: CameraPose, dt: number, clock: SceneClock, opts: FrameOptions = DRAW): void {
    const rt = this.runtime;
    if (this.mode === 'webgl' && rt && this.viewport) {
      try {
        this.syncClock(rt, dt, clock);
        if (opts.paused) {
          this.setShown('viewfinder');
          this.drawViewfinder(
            pose,
            '3D paused: this device renders too slowly — pose streaming continues',
          );
          return;
        }
        this.setShown('webgl');
        if (!opts.draw) return;
        this.camera.position.set(...cameraPosition(pose));
        this.camera.quaternion.copy(pose.quaternion);
        if (this.camera.fov !== pose.fovDeg) {
          this.camera.fov = pose.fovDeg;
          this.camera.updateProjectionMatrix();
        }
        this.viewport.renderMain(this.camera); // also keeps camera.aspect in sync
        return;
      } catch (err) {
        console.warn('[phone] render failed; switching to viewfinder', err);
        this.fail(`render failed: ${(err as Error).message}`);
      }
    }
    this.setShown('viewfinder');
    this.drawViewfinder(pose, this.status);
  }

  /** Position of the last rendered 3D frame's camera (debug / e2e). */
  get renderedPosition(): Vec3 {
    const p = this.camera.position;
    return [p.x, p.y, p.z];
  }

  /** What is on screen right now. */
  get shown(): ViewMode {
    return this.shownMode;
  }

  /** SceneState from the laptop: the look (edits revision + live look) follows it. */
  applySceneState(s: SceneState): void {
    try {
      this.look.update(s);
    } catch (err) {
      console.warn('[phone] look update failed', err);
    }
  }

  /** Cheaper look when the device renders slowly (render-governor level ≥ 1 drops bloom). */
  setLookQuality(q: { bloom: boolean }): void {
    this.lookQuality = { ...q };
    if (this.runtime) this.runtime.look.quality = { ...q };
  }

  /** Frames graded by the look's post pass (debug / e2e). */
  get postFrames(): number {
    return this.viewport?.postFrames.main ?? 0;
  }

  /** Render resolution multiplier (capped by devicePixelRatio). */
  setPixelRatio(ratio: number): void {
    if (!this.viewport) return;
    const next = Math.min(window.devicePixelRatio || 1, ratio);
    if (Math.abs(this.viewport.renderer.getPixelRatio() - next) < 1e-3) return;
    this.viewport.renderer.setPixelRatio(next);
    this.resize();
  }

  private syncClock(rt: SceneRuntime, dt: number, clock: SceneClock) {
    rt.playing = clock.playing;
    rt.update(Math.min(dt, 0.1));
    if (Math.abs(rt.time - clock.time) > 0.3) rt.setTime(clock.time);
    if (clock.speakingLineId !== this.lastSpeaking) {
      this.lastSpeaking = clock.speakingLineId;
      // the actor speaks (voice + talk animation + caption) as the laptop's line starts
      if (clock.speakingLineId) {
        this.stopLinesAt = null;
        rt.playLine(clock.speakingLineId).catch(() => {});
      } else this.stopLinesAt = performance.now() + LINE_TAIL_MS;
    }
    if (this.stopLinesAt !== null && performance.now() >= this.stopLinesAt) {
      this.stopLinesAt = null;
      rt.stopLines();
    }
  }

  /** Whose voice is playing on the phone right now. */
  voiceState(): VoiceState {
    const out: VoiceState = { playing: [], lineId: null, level: 0 };
    for (const actor of this.runtime?.actors.values() ?? []) {
      let playing = false;
      actor.object.traverse((o) => {
        if (o instanceof THREE.PositionalAudio && o.isPlaying) playing = true;
      });
      if (playing) {
        out.playing.push(actor.characterId);
        out.lineId ??= (actor.object.userData.speakingLine as string | null) ?? null;
      }
      const d = actor.object.userData.debug as { level?: number } | undefined;
      out.level = Math.max(out.level, d?.level ?? 0);
    }
    return out;
  }

  private drawViewfinder(pose: CameraPose, note: string) {
    if (!this.vf) return;
    const q: Quat = [pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w];
    drawViewfinder(this.vf, window.innerWidth, window.innerHeight, {
      q,
      fovDeg: pose.fovDeg,
      nudge: pose.nudge,
      note,
    });
  }

  private fail(why: string) {
    this.glFailed = true;
    this.mode = 'viewfinder';
    this.status = `${why} — streaming pose only`;
    this.loadToken++;
    try {
      this.runtime?.dispose();
    } catch {
      // ignore
    }
    this.runtime = null;
    try {
      this.viewport?.setScene(null);
    } catch {
      // ignore
    }
    this.setShown('viewfinder');
  }

  private setShown(mode: ViewMode) {
    if (mode === this.shownMode && this.glCanvas.style.display) return;
    this.shownMode = mode;
    const gl = mode === 'webgl';
    this.glCanvas.style.display = gl ? 'block' : 'none';
    this.vfCanvas.style.display = gl ? 'none' : 'block';
  }
}
