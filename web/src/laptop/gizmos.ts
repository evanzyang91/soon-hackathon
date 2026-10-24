// Director-only overlays: camera frustums for dropped cameras and the live phone. They live on
// GIZMO_LAYER, which the director camera sees and the phone/PiP cameras do not.
import * as THREE from 'three';
import type { DropCamera } from '@shared/protocol';

export const GIZMO_LAYER = 1;

function onLayer(root: THREE.Object3D) {
  root.traverse((o) => o.layers.set(GIZMO_LAYER));
}

function labelSprite(text: string, color: string) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(10,12,16,0.75)';
  g.beginPath();
  g.roundRect(2, 8, 252, 48, 10);
  g.fill();
  g.fillStyle = color;
  g.font = '600 28px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text.slice(0, 16), 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
  );
  sprite.scale.set(0.48, 0.12, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export class FrustumGizmo {
  readonly object = new THREE.Group();
  private readonly lines: THREE.LineSegments;
  private readonly material: THREE.LineBasicMaterial;
  private readonly extras: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  private fov = -1;
  private aspect = -1;

  constructor(
    color: string,
    private readonly depth: number,
    opts: { body?: boolean; label?: string } = {},
  ) {
    this.material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.material);
    this.lines.renderOrder = 9;
    this.object.add(this.lines);
    if (opts.body) {
      // landscape phone body, screen facing the operator (+Z)
      const geometry = new THREE.BoxGeometry(0.16, 0.078, 0.009);
      const material = new THREE.MeshBasicMaterial({ color: '#15171c' });
      const body = new THREE.Mesh(geometry, material);
      body.position.z = 0.006;
      const screenGeo = new THREE.PlaneGeometry(0.15, 0.07);
      const screenMat = new THREE.MeshBasicMaterial({ color });
      const screen = new THREE.Mesh(screenGeo, screenMat);
      screen.position.z = 0.0106;
      this.object.add(body, screen);
      this.extras.push({ geometry, material }, { geometry: screenGeo, material: screenMat });
    }
    if (opts.label) {
      const sprite = labelSprite(opts.label, color);
      sprite.position.set(0, 0.16, 0);
      this.object.add(sprite);
      this.extras.push({ geometry: sprite.geometry, material: sprite.material });
    }
    this.setFov(50, 16 / 9);
    onLayer(this.object);
  }

  setFov(fovDeg: number, aspect: number) {
    if (Math.abs(fovDeg - this.fov) < 0.05 && Math.abs(aspect - this.aspect) < 1e-3) return;
    this.fov = fovDeg;
    this.aspect = aspect;
    const d = this.depth;
    const hh = d * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
    const hw = hh * aspect;
    const c = [
      [-hw, -hh, -d],
      [hw, -hh, -d],
      [hw, hh, -d],
      [-hw, hh, -d],
    ] as const;
    const v: number[] = [];
    const seg = (a: readonly number[], b: readonly number[]) => v.push(...a, ...b);
    for (const k of c) seg([0, 0, 0], k);
    for (let i = 0; i < 4; i++) seg(c[i]!, c[(i + 1) % 4]!);
    // "up" notch so roll is readable at a glance
    seg([-hw * 0.35, hh, -d], [0, hh * 1.35, -d]);
    seg([0, hh * 1.35, -d], [hw * 0.35, hh, -d]);
    this.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    this.lines.geometry.computeBoundingSphere();
  }

  setPose(position: THREE.Vector3Like, quaternion: THREE.QuaternionLike) {
    this.object.position.set(position.x, position.y, position.z);
    this.object.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  }

  setColor(color: string) {
    this.material.color.set(color);
  }

  dispose() {
    this.lines.geometry.dispose();
    this.material.dispose();
    for (const e of this.extras) {
      e.geometry.dispose();
      (e.material as THREE.SpriteMaterial).map?.dispose();
      e.material.dispose();
    }
    this.object.removeFromParent();
  }
}

/** One frustum + name label per dropped camera; the active one is highlighted. */
export class CameraMarkers {
  readonly group = new THREE.Group();
  private gizmos: FrustumGizmo[] = [];
  private key = '';

  constructor() {
    this.group.name = 'camera-markers';
  }

  sync(cameras: DropCamera[], activeId: string | null) {
    // rebuilt when the set, names, lenses or the active camera change; a drag only moves them
    const key = JSON.stringify([cameras.map((c) => [c.id, c.name, c.fovDeg]), activeId]);
    if (key !== this.key) {
      this.key = key;
      for (const g of this.gizmos) g.dispose();
      this.gizmos = cameras.map((c) => {
        const color = c.id === activeId ? '#ffd23f' : '#9aa4b1';
        const g = new FrustumGizmo(color, 0.35, { label: c.name });
        g.setFov(c.fovDeg, 16 / 9);
        this.group.add(g.object);
        return g;
      });
    }
    cameras.forEach((c, i) =>
      this.gizmos[i]?.setPose(
        { x: c.position[0], y: c.position[1], z: c.position[2] },
        { x: c.quaternion[0], y: c.quaternion[1], z: c.quaternion[2], w: c.quaternion[3] },
      ),
    );
  }

  dispose() {
    for (const g of this.gizmos) g.dispose();
    this.gizmos = [];
    this.key = '';
  }
}
