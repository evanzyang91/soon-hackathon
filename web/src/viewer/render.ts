// One WebGL canvas, two views per frame: the main view and a picture-in-picture corner view.
//
// Spark keeps one splat sort per SparkRenderer, so rendering a second camera through the in-scene
// SparkRenderer would make both views fight over the sort order every frame. Instead the PiP owns
// a second SparkRenderer that is *not* added to the scene: `pip.render(scene, camera)` sets
// SparkRenderer.sparkOverride, so the in-scene splat mesh draws using the PiP renderer's own
// accumulators and sort (the same mechanism Spark's SparkPortals uses for its second view).
import * as THREE from 'three';
import type { SparkRenderer } from '@sparkjsdev/spark';
import { createSpark } from './spark';
import { LookPost, type PostOptions } from './look/post';
import { lookProviderOf } from './look/scene-look';

/** CSS pixels, measured from the top-left of the canvas. */
export interface PipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportOptions {
  maxPixelRatio?: number;
  /** Needed for MediaRecorder-free screenshots/readback; off by default (costs bandwidth). */
  preserveDrawingBuffer?: boolean;
  /** Look post pass settings (the phone asks for a cheaper bloom). */
  post?: PostOptions;
}

export class ViewportRenderer {
  readonly renderer: THREE.WebGLRenderer;
  /** Frame counters, handy for tests and for the HUD. */
  mainFrames = 0;
  pipFrames = 0;
  private scene: THREE.Scene;
  private readonly empty = new THREE.Scene();
  private pipSpark: SparkRenderer | null = null;
  /** Look post passes (viewer/look/post.ts), created on the first graded frame of each view. */
  private mainPost: LookPost | null = null;
  private pipPost: LookPost | null = null;
  private readonly postOptions: PostOptions;
  private width = 1;
  private height = 1;

  constructor(
    readonly canvas: HTMLCanvasElement,
    opts: ViewportOptions = {},
  ) {
    // antialias off: MSAA does not help Gaussian splats and costs a lot (Spark docs)
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(
      Math.min(globalThis.devicePixelRatio ?? 1, opts.maxPixelRatio ?? 1.5),
    );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.empty.background = new THREE.Color('#14181d');
    this.scene = this.empty;
    this.postOptions = opts.post ?? {};
  }

  get size() {
    return { width: this.width, height: this.height };
  }

  setScene(scene: THREE.Scene | null) {
    if ((scene ?? this.empty) === this.scene) return;
    this.scene = scene ?? this.empty;
    // the PiP's accumulators hold the previous scene's splats; start fresh
    this.pipSpark?.dispose();
    this.pipSpark = null;
  }

  /** CSS pixel size of the drawing area. */
  resize(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.renderer.setSize(this.width, this.height, false);
  }

  renderMain(camera: THREE.Camera) {
    fitAspect(camera, this.width / this.height);
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
    // the scene's look (viewer/look/scene-look.ts) sets this view's lens and says whether to grade
    const post = lookProviderOf(this.scene)?.prepare(camera, null) ?? null;
    if (post) {
      const rect = { x: 0, y: 0, width: this.width, height: this.height };
      (this.mainPost ??= new LookPost(r, this.postOptions)).render(post, rect, () =>
        r.render(this.scene, camera),
      );
    } else r.render(this.scene, camera);
    this.mainFrames++;
  }

  renderPip(camera: THREE.Camera, rect: PipRect) {
    const r = this.renderer;
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    // three's viewport/scissor origin is bottom-left
    const x = Math.floor(rect.x);
    const y = Math.floor(this.height - rect.y - h);
    fitAspect(camera, w / h);
    r.setViewport(x, y, w, h);
    r.setScissor(x, y, w, h);
    r.setScissorTest(true);
    try {
      if (this.scene === this.empty) r.render(this.scene, camera);
      else {
        const spark = (this.pipSpark ??= createSpark(r));
        const post = lookProviderOf(this.scene)?.prepare(camera, spark) ?? null;
        if (post) {
          const pipPost = (this.pipPost ??= new LookPost(r, this.postOptions));
          pipPost.render(post, { x, y, width: w, height: h }, () => spark.render(this.scene, camera));
        } else spark.render(this.scene, camera);
      }
    } finally {
      r.setScissorTest(false);
      r.setViewport(0, 0, this.width, this.height);
    }
    this.pipFrames++;
  }

  /** Frames graded by the look post pass (main, PiP); debug / tests. */
  get postFrames() {
    return { main: this.mainPost?.frames ?? 0, pip: this.pipPost?.frames ?? 0 };
  }

  dispose() {
    this.pipSpark?.dispose();
    this.pipSpark = null;
    this.mainPost?.dispose();
    this.pipPost?.dispose();
    this.renderer.dispose();
  }
}

function fitAspect(camera: THREE.Camera, aspect: number) {
  if (camera instanceof THREE.PerspectiveCamera && Math.abs(camera.aspect - aspect) > 1e-4) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
}
