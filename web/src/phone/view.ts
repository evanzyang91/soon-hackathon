// Phone camera view: renders the shared scene (WP A's viewer/world.ts + viewer/render.ts) from the
// phone's pose, falling back to the 2D viewfinder whenever 3D is unavailable. Never throws into the
// caller — pose streaming must keep running whatever happens here.
import * as THREE from 'three';
import type { Quat, Vec3 } from '@shared/schema';
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
  private loadingUrl: string | null = null;
  private loadToken = 0;
  private lastSpeaking: string | null = null;
  private readonly vf: CanvasRenderingContext2D | null;
  private glFailed = false;
  private shownMode: ViewMode = 'viewfinder';

  constructor(
    private readonly glCanvas: HTMLCanvasElement,
    private readonly vfCanvas: HTMLCanvasElement,
    private readonly quality: SplatQuality = 'k500',
  ) {
    this.vf = vfCanvas.getContext('2d');
    try {
      // Same renderer setup as the laptop (no MSAA, sRGB); pixel ratio capped at 1.5 for phones.
      this.viewport = new ViewportRenderer(glCanvas, { maxPixelRatio: 1.5 });
      glCanvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.fail('WebGL context lost');
      });
    } catch (err) {
      this.fail(`3D unavailable (${(err as Error).message || 'no WebGL2'})`);
    }
    this.resize();
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
      const rt = await loadScene(manifestUrl, {
        renderer: this.viewport.renderer,
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
      rt.listener.setMasterVolume(0); // the laptop plays the dialogue; avoid echo
      this.viewport.setScene(rt.scene);
      this.runtime?.dispose();
      this.runtime = rt;
      this.lastSpeaking = null;
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
      // Muted on the phone; this only drives the actors' talk animation.
      if (clock.speakingLineId) rt.playLine(clock.speakingLineId).catch(() => {});
      else rt.stopLines();
    }
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
