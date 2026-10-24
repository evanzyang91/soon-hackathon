// The look post pass: the view is rendered into a render target exactly as it would have been
// rendered to the canvas, then one fullscreen shader grades it into the canvas (or a PiP rect).
//
// Pixel parity with the direct path: three.js and Spark only encode sRGB (and Spark only blends
// splats in sRGB, like it does on the canvas) when the target is the canvas or an XR target, so
// the scene target is flagged `isXRRenderTarget` with an sRGB colour space and a plain RGBA8
// store. Its bytes are then the canvas's bytes; the grade decodes them to linear itself, works in
// linear light and writes sRGB.
import * as THREE from 'three';
import type { GradeParams } from './grade';
import { BLUR_FRAG, BRIGHT_FRAG, GRADE_FRAG, QUAD_VERT } from './shaders';

/** What one view's post pass needs (computed by the scene's look, see scene-look.ts). */
export interface PostSettings {
  params: GradeParams;
}

export interface PostOptions {
  /** Bloom target scale against the view (0.5 = half resolution). */
  bloomScale?: number;
  /** Separable blur iterations (H+V each). */
  bloomIterations?: number;
}

/** CSS-pixel rectangle on the canvas, origin bottom-left (three.js viewport convention). */
export interface PostRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BLOOM_THRESHOLD = 0.55;

function sceneTarget(): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
  });
  // sRGB-encoded bytes in a plain RGBA8 store (no hardware sRGB conversion), see the header
  rt.texture.internalFormat = 'RGBA8';
  (rt as THREE.WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  return rt;
}

function bloomTarget(type: THREE.TextureDataType): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(1, 1, {
    type,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
  });
}

const mat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: QUAD_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

export class LookPost {
  /** Frames drawn through the pass (debug / tests). */
  frames = 0;
  private readonly target = sceneTarget();
  private bloomA: THREE.WebGLRenderTarget | null = null;
  private bloomB: THREE.WebGLRenderTarget | null = null;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly grade: THREE.ShaderMaterial;
  private readonly bright: THREE.ShaderMaterial;
  private readonly blur: THREE.ShaderMaterial;
  private readonly bloomScale: number;
  private readonly bloomIterations: number;
  private frame = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    opts: PostOptions = {},
  ) {
    this.bloomScale = opts.bloomScale ?? 0.5;
    this.bloomIterations = opts.bloomIterations ?? 2;
    this.grade = mat(GRADE_FRAG, {
      tColor: { value: this.target.texture },
      tBloom: { value: null },
      uUseBloom: { value: false },
      uWB: { value: new THREE.Matrix3() },
      uExposure: { value: 1 },
      uContrast: { value: 1 },
      uSaturation: { value: 1 },
      uShadows: { value: 0 },
      uHighlights: { value: 0 },
      uLutSat: { value: 1 },
      uLutContrast: { value: 1 },
      uLutStrength: { value: 0 },
      uLutLift: { value: new THREE.Vector3() },
      uLutGamma: { value: new THREE.Vector3(1, 1, 1) },
      uLutGain: { value: new THREE.Vector3(1, 1, 1) },
      uLutShadow: { value: new THREE.Vector3() },
      uLutHigh: { value: new THREE.Vector3() },
      uVignette: { value: 0 },
      uAspect: { value: 1 },
      uGrain: { value: 0 },
      uFrame: { value: 0 },
      uBloom: { value: 0 },
    });
    this.bright = mat(BRIGHT_FRAG, {
      tColor: { value: this.target.texture },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: BLOOM_THRESHOLD },
    });
    this.blur = mat(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.grade);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /**
   * Renders one graded view: `draw()` renders the scene (into the pass's target, which is bound
   * when it is called); the graded result lands in `rect` of the canvas.
   */
  render(post: PostSettings, rect: PostRect, draw: () => void): void {
    const r = this.renderer;
    const pr = r.getPixelRatio();
    const w = Math.max(1, Math.round(rect.width * pr));
    const h = Math.max(1, Math.round(rect.height * pr));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    const prevTarget = r.getRenderTarget();
    const prevScissor = r.getScissorTest();
    const prevAutoClear = r.autoClear;
    try {
      r.setScissorTest(false);
      r.setRenderTarget(this.target);
      draw();
      const p = post.params;
      const bloom = p.bloom > 0 && this.drawBloom(w, h);
      this.setUniforms(post, w / h, bloom);
      r.setRenderTarget(prevTarget);
      r.setViewport(rect.x, rect.y, rect.width, rect.height);
      r.setScissor(rect.x, rect.y, rect.width, rect.height);
      r.setScissorTest(true);
      r.autoClear = false;
      this.quad.material = this.grade;
      r.render(this.quadScene, this.quadCamera);
      this.frames++;
    } finally {
      r.autoClear = prevAutoClear;
      r.setScissorTest(prevScissor);
      r.setRenderTarget(prevTarget);
    }
  }

  private drawBloom(w: number, h: number): boolean {
    const r = this.renderer;
    const bw = Math.max(1, Math.round(w * this.bloomScale));
    const bh = Math.max(1, Math.round(h * this.bloomScale));
    if (!this.bloomA || !this.bloomB) {
      const half =
        r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float');
      const type = half ? THREE.HalfFloatType : THREE.UnsignedByteType;
      this.bloomA = bloomTarget(type);
      this.bloomB = bloomTarget(type);
    }
    const a = this.bloomA;
    const b = this.bloomB;
    if (a.width !== bw || a.height !== bh) {
      a.setSize(bw, bh);
      b.setSize(bw, bh);
    }
    this.bright.uniforms.uTexel!.value.set(1 / w, 1 / h);
    this.quad.material = this.bright;
    r.setRenderTarget(a);
    r.render(this.quadScene, this.quadCamera);
    const dir = this.blur.uniforms.uDir!.value as THREE.Vector2;
    this.quad.material = this.blur;
    for (let i = 0; i < this.bloomIterations; i++) {
      const spread = 1 + i * 1.5;
      this.blur.uniforms.tSrc!.value = a.texture;
      dir.set(spread / bw, 0);
      r.setRenderTarget(b);
      r.render(this.quadScene, this.quadCamera);
      this.blur.uniforms.tSrc!.value = b.texture;
      dir.set(0, spread / bh);
      r.setRenderTarget(a);
      r.render(this.quadScene, this.quadCamera);
    }
    return true;
  }

  private setUniforms(post: PostSettings, aspect: number, bloom: boolean) {
    const u = this.grade.uniforms as Record<string, THREE.IUniform>;
    const p = post.params;
    (u.uWB!.value as THREE.Matrix3).set(...p.wb);
    u.uExposure!.value = p.exposureGain;
    u.uContrast!.value = p.contrast;
    u.uSaturation!.value = p.saturation;
    u.uShadows!.value = p.shadows;
    u.uHighlights!.value = p.highlights;
    u.uLutSat!.value = p.lut.sat;
    u.uLutContrast!.value = p.lut.contrast;
    u.uLutStrength!.value = p.lutStrength;
    (u.uLutLift!.value as THREE.Vector3).set(...p.lut.lift);
    (u.uLutGamma!.value as THREE.Vector3).set(...p.lut.gamma);
    (u.uLutGain!.value as THREE.Vector3).set(...p.lut.gain);
    (u.uLutShadow!.value as THREE.Vector3).set(...p.lut.shadowTint);
    (u.uLutHigh!.value as THREE.Vector3).set(...p.lut.highlightTint);
    u.uVignette!.value = p.vignette;
    u.uAspect!.value = aspect;
    u.uGrain!.value = p.grain;
    u.uFrame!.value = (this.frame = (this.frame + 1) % 64);
    u.uBloom!.value = p.bloom;
    u.uUseBloom!.value = bloom;
    u.tBloom!.value = bloom ? this.bloomA!.texture : null;
  }

  dispose() {
    this.target.dispose();
    this.bloomA?.dispose();
    this.bloomB?.dispose();
    this.quad.geometry.dispose();
    this.grade.dispose();
    this.bright.dispose();
    this.blur.dispose();
  }
}
