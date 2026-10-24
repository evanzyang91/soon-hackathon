// Look lights. Mesh actors and props get real three.js lights; baked splats cannot be relit, so a
// Spark world modifier (a dyno program run per splat when the splats are generated) multiplies
// each splat's colour, in linear light, by
//
//   ambient + Σ intensity · colour · falloff(distance) · cone(angle) · shade(N·L)
//
// falloff = (1 − (d/radius)⁴)² / (1 + (d/2 m)²) (inverse square, 2 m reference, windowed to the
// radius); cone = soft edge over the outer quarter of a spot's half-angle; sun = no falloff, a
// uniform directional tint. N is the splat's thinnest axis turned toward the viewer (a visible
// splat faces the camera); round splats in the world get a flat 0.55 instead of N·L, round splats
// of an actor use the outward direction from the actor's vertical axis (a body is roughly
// convex), so the side facing the light brightens and the far side stays. Honest limit: no new
// shadows — a baked splat cannot know what is between it and the light.
//
// The same program carries the atmosphere: sky tint multiplies splats seen above the horizon band
// and far away (grade.ts skyMask), and fog blends every splat toward the fog colour by its
// distance from the viewing camera (grade.ts fogFactor) — per splat, so semi-transparent splats
// fog correctly before they blend (a depth buffer holds one depth per pixel and cannot). Meshes
// get three.js FogExp2 matched at 15 m.
import * as THREE from 'three';
import { dyno, SplatAccumulator, SplatMesh } from '@sparkjsdev/spark';
import type { Light, Look } from '@shared/look';
import { atmosphereParams, FOG_MAX, hexToLinear, SKY_DISTANCE, SKY_ELEVATION } from './grade';

export const MAX_SPLAT_LIGHTS = 4;
/** three.js candela per Look intensity unit, so a mesh at 2 m brightens about like the splats. */
const MESH_INTENSITY = 8;
const SUN_INTENSITY = 2;
const KIND = { point: 1, spot: 2, sun: 3 } as const;

const { Dyno, Gsplat, defineGsplat, dynoFloat, dynoVec4, unindent } = dyno;

const LIGHT_GLSL = unindent(`
  vec3 previzQuatRotate(vec4 q, vec3 v) {
    vec3 t = 2.0 * cross(q.xyz, v);
    return v + q.w * t + cross(q.xyz, t);
  }
  vec3 previzToLin(vec3 c) {
    c = max(c, 0.0);
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }
  vec3 previzToSrgb(vec3 c) {
    c = max(c, 0.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  float previzShade(vec3 p, vec3 n, float flatness, vec4 axis, vec3 L) {
    float ndl = max(dot(n, L), 0.0);
    if (axis.w < 0.5) return mix(0.55, ndl, flatness);
    vec3 o = p - axis.xyz;
    o.y = 0.0;
    float len = length(o);
    o = len > 1e-4 ? o / len : n;
    return mix(0.12 + 0.88 * max(dot(o, L), 0.0), ndl, 0.5 * flatness);
  }
  vec3 previzOneLight(vec3 p, vec3 n, float flatness, vec4 axis, vec4 pr, vec4 ci, vec4 dc) {
    if (ci.w < 0.5) return vec3(0.0);
    vec3 L;
    float att = 1.0;
    if (ci.w > 2.5) {
      L = dc.xyz;
    } else {
      vec3 toL = pr.xyz - p;
      float d = length(toL);
      L = toL / max(d, 1e-4);
      float x = d / max(pr.w, 1e-3);
      float win = clamp(1.0 - x * x * x * x, 0.0, 1.0);
      att = win * win / (1.0 + 0.25 * d * d);
      if (ci.w > 1.5) att *= smoothstep(dc.w, mix(dc.w, 1.0, 0.25), dot(-L, dc.xyz));
    }
    return ci.rgb * att * previzShade(p, n, flatness, axis, L);
  }
  vec3 previzAtmosphere(vec3 lin, vec3 p, vec3 view, vec4 fog, vec4 sky, vec4 skyBand) {
    vec3 toP = p - view;
    float d = length(toP);
    if (sky.w > 0.0) {
      float elev = toP.y / max(d, 1e-4);
      float m = smoothstep(skyBand.x, skyBand.y, elev) * smoothstep(skyBand.z, skyBand.w, d);
      lin *= mix(vec3(1.0), sky.rgb, m * sky.w);
    }
    if (fog.w > 0.0) lin = mix(lin, fog.rgb, min(${FOG_MAX.toFixed(4)}, 1.0 - exp(-fog.w * d)));
    return lin;
  }
`);

type V4 = ReturnType<typeof dynoVec4<THREE.Vector4>>;

/**
 * The splat light / atmosphere modifier. Every lit mesh gets its own modifier block (Spark
 * compiles one program per mesh generator anyway) sharing these light uniforms, plus an `axis`
 * uniform: an actor's vertical axis (xyz = its mark, w = 1), or w = 0 for the world.
 */
export class SplatLights {
  readonly pos: V4[] = [];
  readonly col: V4[] = [];
  readonly dir: V4[] = [];
  readonly ambient = dynoFloat(1);
  /** rgb = linear fog colour, w = fog coefficient (1/m). */
  readonly fog = dynoVec4(new THREE.Vector4(0, 0, 0, 0));
  /** rgb = unit-luminance sky tint, w = strength. */
  readonly sky = dynoVec4(new THREE.Vector4(1, 1, 1, 0));
  readonly skyBand = dynoVec4(new THREE.Vector4(SKY_ELEVATION[0], SKY_ELEVATION[1], SKY_DISTANCE[0], SKY_DISTANCE[1]));
  private readonly attached = new Map<SplatMesh, { axis: V4; root: THREE.Object3D | null }>();
  private key = '';

  constructor() {
    for (let i = 0; i < MAX_SPLAT_LIGHTS; i++) {
      this.pos.push(dynoVec4(new THREE.Vector4(0, 0, 0, 1)));
      this.col.push(dynoVec4(new THREE.Vector4(0, 0, 0, 0)));
      this.dir.push(dynoVec4(new THREE.Vector4(0, -1, 0, 0)));
    }
  }

  /** A modifier block for one mesh (its own `axis`, the shared light uniforms). */
  private modifierFor(axis: V4) {
    const lights = this;
    return dyno.dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
      const inputs: Record<string, unknown> = {
        gsplat,
        axis,
        view: SplatAccumulator.viewCenterUniform,
        ambient: lights.ambient,
        fog: lights.fog,
        sky: lights.sky,
        skyBand: lights.skyBand,
      };
      const inTypes: Record<string, string | typeof Gsplat> = {
        gsplat: Gsplat,
        axis: 'vec4',
        view: 'vec3',
        ambient: 'float',
        fog: 'vec4',
        sky: 'vec4',
        skyBand: 'vec4',
      };
      for (let i = 0; i < MAX_SPLAT_LIGHTS; i++) {
        inputs[`p${i}`] = lights.pos[i];
        inputs[`c${i}`] = lights.col[i];
        inputs[`d${i}`] = lights.dir[i];
        inTypes[`p${i}`] = inTypes[`c${i}`] = inTypes[`d${i}`] = 'vec4';
      }
      const d = new Dyno({
        inTypes: inTypes as never,
        outTypes: { gsplat: Gsplat },
        inputs: inputs as never,
        globals: () => [defineGsplat, LIGHT_GLSL],
        statements: ({ inputs: i, outputs: o }) => {
          const io = i as Record<string, string>;
          const out = (o as Record<string, string>).gsplat!;
          const g = io.gsplat!;
          const sum = Array.from({ length: MAX_SPLAT_LIGHTS }, (_, k) =>
            `previzOneLight(${out}.center, n, flatness, ${io.axis}, ${io[`p${k}`]}, ${io[`c${k}`]}, ${io[`d${k}`]})`,
          ).join(' + ');
          return unindent(`
            ${out} = ${g};
            if (isGsplatActive(${out}.flags)) {
              vec3 s = ${out}.scales;
              float smin = min(s.x, min(s.y, s.z));
              float smax = max(s.x, max(s.y, s.z));
              float smid = s.x + s.y + s.z - smin - smax;
              vec3 axis = (s.z == smin) ? vec3(0.0, 0.0, 1.0) : ((s.y == smin) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
              vec3 n = previzQuatRotate(${out}.quaternion, axis);
              if (dot(n, ${io.view} - ${out}.center) < 0.0) n = -n;
              float flatness = 1.0 - smin / max(smid, 1e-6);
              vec3 light = vec3(${io.ambient}) + ${sum};
              vec3 lin = previzToLin(${out}.rgba.rgb) * light;
              lin = previzAtmosphere(lin, ${out}.center, ${io.view}, ${io.fog}, ${io.sky}, ${io.skyBand});
              ${out}.rgba.rgb = previzToSrgb(lin);
            }
          `).split('\n');
        },
      });
      return { gsplat: (d.outputs as Record<string, unknown>).gsplat as never };
    });
  }

  /**
   * Uniform values for `look` (≤ 4 enabled lights; extra lights are ignored; null = neutral).
   * Returns true if anything changed.
   */
  set(look: Pick<Look, 'lights' | 'ambient' | 'fog' | 'skyTint'> | null): boolean {
    const lights = (look?.lights ?? []).filter((l) => l.enabled).slice(0, MAX_SPLAT_LIGHTS);
    const ambient = look ? look.ambient : 1;
    const key = JSON.stringify([ambient, lights, look?.fog, look?.skyTint]);
    if (key === this.key) return false;
    this.key = key;
    this.ambient.value = ambient;
    const a = look ? atmosphereParams(look) : null;
    this.fog.value.set(...(a?.fogColor ?? [0, 0, 0]), a?.fogK ?? 0);
    this.sky.value.set(...(a?.skyColor ?? [1, 1, 1]), a?.skyStrength ?? 0);
    for (let i = 0; i < MAX_SPLAT_LIGHTS; i++) {
      const l = lights[i];
      const p = this.pos[i]!.value;
      const c = this.col[i]!.value;
      const d = this.dir[i]!.value;
      if (!l) {
        c.set(0, 0, 0, 0);
        continue;
      }
      const lin = hexToLinear(l.color);
      p.set(l.position[0], l.position[1], l.position[2], l.radius);
      c.set(lin[0] * l.intensity, lin[1] * l.intensity, lin[2] * l.intensity, KIND[l.kind]);
      const target = new THREE.Vector3(...(l.target ?? [0, 0, 0]));
      const from = new THREE.Vector3(...l.position);
      if (l.kind === 'sun') {
        // the direction toward the sun (from its aim point to its position)
        const toSun = from.sub(target).normalize();
        d.set(toSun.x, toSun.y, toSun.z, 0);
      } else {
        const axis = target.sub(from);
        if (axis.lengthSq() < 1e-8) axis.set(0, -1, 0);
        axis.normalize();
        d.set(axis.x, axis.y, axis.z, Math.cos(((l.coneDeg / 2) * Math.PI) / 180));
      }
    }
    for (const m of this.attached.keys()) m.updateVersion();
    return true;
  }

  /** True when the uniforms change nothing (no light, full ambient, no fog or sky tint). */
  get neutral(): boolean {
    return (
      this.ambient.value === 1 &&
      this.col.every((c) => c.value.w === 0) &&
      this.fog.value.w === 0 &&
      this.sky.value.w === 0
    );
  }

  /** Adds the modifier to every splat mesh under `root` that does not have it yet. */
  attachAll(root: THREE.Object3D): number {
    let added = 0;
    root.traverse((o) => {
      if (!(o instanceof SplatMesh) || this.attached.has(o)) return;
      const actor = actorRoot(o);
      const axis = dynoVec4(new THREE.Vector4(0, 0, 0, actor ? 1 : 0));
      const modifier = this.modifierFor(axis);
      o.worldModifiers = [...(o.worldModifiers ?? []), modifier];
      o.updateGenerator();
      this.attached.set(o, { axis, root: actor });
      (o.userData as Record<string, unknown>).previzLightModifier = modifier;
      added++;
    });
    for (const m of this.attached.keys()) if (!isInScene(m)) this.attached.delete(m);
    this.follow();
    return added;
  }

  /** Keeps each actor's axis on the actor (walk-ins move them); regenerates the ones that moved. */
  follow(): void {
    const p = new THREE.Vector3();
    for (const [mesh, { axis, root }] of this.attached) {
      if (!root) continue;
      root.getWorldPosition(p);
      const a = axis.value;
      if (Math.abs(a.x - p.x) + Math.abs(a.y - p.y) + Math.abs(a.z - p.z) < 1e-4) continue;
      a.set(p.x, p.y, p.z, 1);
      mesh.updateVersion();
    }
  }

  get attachedCount(): number {
    return this.attached.size;
  }

  dispose() {
    for (const m of this.attached.keys()) {
      const mod = (m.userData as Record<string, unknown>).previzLightModifier;
      m.worldModifiers = m.worldModifiers?.filter((x) => x !== mod);
      m.updateGenerator();
    }
    this.attached.clear();
  }
}

/** The actor (viewer/actors: `object.userData.actorKind`) a splat mesh belongs to, if any. */
function actorRoot(o: THREE.Object3D): THREE.Object3D | null {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.actorKind !== undefined) return p;
  return null;
}

function isInScene(o: THREE.Object3D): boolean {
  let p: THREE.Object3D | null = o;
  while (p.parent) p = p.parent;
  return p instanceof THREE.Scene;
}

/** Matches three.js FogExp2 (1 − e^−(ρd)²) to the splats' 1 − e^−kd at this distance. */
const MESH_FOG_MATCH_M = 15;
export const meshFogDensity = (k: number) => (k > 0 ? Math.sqrt(k * MESH_FOG_MATCH_M) / MESH_FOG_MATCH_M : 0);

/**
 * Mesh side of the atmosphere: three.js fog for lit/unlit materials, and the scene background
 * (what is behind everything: infinitely far, so fully fogged and sky-tinted).
 */
export class MeshAtmosphere {
  private readonly baseBackground: THREE.Color | null;
  private key = '';

  constructor(private readonly scene: THREE.Scene) {
    this.baseBackground = scene.background instanceof THREE.Color ? scene.background.clone() : null;
  }

  set(look: Pick<Look, 'fog' | 'skyTint'> | null): void {
    const key = JSON.stringify([look?.fog, look?.skyTint]);
    if (key === this.key) return;
    this.key = key;
    const a = look ? atmosphereParams(look) : null;
    if (a && a.fogK > 0) {
      const color = new THREE.Color().setRGB(...a.fogColor, THREE.LinearSRGBColorSpace);
      if (this.scene.fog instanceof THREE.FogExp2) {
        this.scene.fog.color.copy(color);
        this.scene.fog.density = meshFogDensity(a.fogK);
      } else this.scene.fog = new THREE.FogExp2(color, meshFogDensity(a.fogK));
    } else this.scene.fog = null;
    if (!this.baseBackground) return;
    if (!a || (a.fogK <= 0 && a.skyStrength <= 0)) {
      (this.scene.background as THREE.Color).copy(this.baseBackground);
      return;
    }
    const bg = this.baseBackground.clone();
    const lin = [bg.r, bg.g, bg.b].map((c, i) => c * (1 + (a.skyColor[i]! - 1) * a.skyStrength));
    const f = a.fogK > 0 ? FOG_MAX : 0;
    const out = lin.map((c, i) => c + (a.fogColor[i]! - c) * f);
    (this.scene.background as THREE.Color).setRGB(out[0]!, out[1]!, out[2]!, THREE.LinearSRGBColorSpace);
  }
}

/** three.js lights for the meshes (mannequins, GLB actors, props), one per Look light. */
export class MeshLights {
  readonly group = new THREE.Group();
  private key = '';

  constructor() {
    this.group.name = 'look-lights';
  }

  set(lights: Light[]): void {
    const key = JSON.stringify(lights);
    if (key === this.key) return;
    this.key = key;
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.Light).dispose?.();
    }
    for (const l of lights) {
      if (!l.enabled) continue;
      const color = new THREE.Color(l.color);
      let light: THREE.Light;
      if (l.kind === 'point') {
        light = new THREE.PointLight(color, l.intensity * MESH_INTENSITY, l.radius, 2);
      } else if (l.kind === 'spot') {
        const s = new THREE.SpotLight(color, l.intensity * MESH_INTENSITY, l.radius, ((l.coneDeg / 2) * Math.PI) / 180, 0.25, 2);
        s.target.position.set(...(l.target ?? [l.position[0], 0, l.position[2]]));
        this.group.add(s.target);
        light = s;
      } else {
        const s = new THREE.DirectionalLight(color, l.intensity * SUN_INTENSITY);
        s.target.position.set(...(l.target ?? [0, 0, 0]));
        this.group.add(s.target);
        light = s;
      }
      light.name = `look-light:${l.id}`;
      light.position.set(...l.position);
      this.group.add(light);
    }
  }

  dispose() {
    this.set([]);
  }
}
