// Director-only overlays: camera frustums for the shots and the live phone. They live on
// GIZMO_LAYER, which the director camera sees and the phone/PiP cameras do not.
import * as THREE from 'three';
import type { DropCamera, RoomScan } from '@shared/protocol';
import type { Vec3 } from '@shared/schema';

export const GIZMO_LAYER = 1;

function onLayer(root: THREE.Object3D) {
  root.traverse((o) => o.layers.set(GIZMO_LAYER));
}

function labelSprite(text: string, color: string) {
  const font = '600 28px system-ui, sans-serif';
  const shown = text.slice(0, 16);
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  g.font = font;
  // the pill fits its text ("1B" is a small tag, a longer name up to the old 256 px)
  const w = Math.min(256, Math.ceil(g.measureText(shown).width) + 36);
  c.width = w;
  c.height = 64;
  g.fillStyle = 'rgba(10,12,16,0.75)';
  g.beginPath();
  g.roundRect(2, 8, w - 4, 48, 10);
  g.fill();
  g.fillStyle = color;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(shown, w / 2, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
  );
  sprite.scale.set((0.48 * w) / 256, 0.12, 1);
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

/** One frustum + label per shot (director.cameras); the one the phone is on is highlighted. */
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
        // a shot is marked by its number on the set ("1B"), as on a floor plan
        const label = /^\d+[A-Z]+ · /.test(c.name) ? c.name.split(' · ')[0]! : c.name;
        const g = new FrustumGizmo(color, 0.35, { label });
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

/**
 * The physical room the ARKit phone scanned (RoomScan), drawn where it really is relative to the
 * scene: the phone's anchor + the scan's offset-frame outline. Floor outline, and walls up to the
 * ceiling when one was seen (else 2.4 m), so the director keeps the blocking inside the real room.
 */
export class RoomOutlineGizmo {
  readonly object = new THREE.Group();
  private lines: THREE.LineSegments | null = null;
  private label: THREE.Sprite | null = null;
  private readonly material = new THREE.LineDashedMaterial({
    color: '#36d6e7',
    dashSize: 0.12,
    gapSize: 0.08,
    depthTest: false,
    transparent: true,
    opacity: 0.9,
  });
  private key = '';

  constructor() {
    this.object.name = 'room-outline';
    this.object.renderOrder = 9;
  }

  /** `scan` null hides it. Rebuilt only when the scan or the anchor changes. */
  set(scan: RoomScan | null, anchor: Vec3) {
    const key = scan ? JSON.stringify([scan.outline, scan.floorY, scan.ceiling, anchor]) : '';
    if (key === this.key) return;
    this.key = key;
    this.clear();
    if (!scan) return;
    const floor = anchor[1] + scan.floorY + 0.01;
    const top = floor + (scan.ceiling ?? 2.4);
    const pts = scan.outline.map(([x, z]) => [anchor[0] + x, anchor[2] + z] as const);
    const v: number[] = [];
    pts.forEach(([x, z], i) => {
      const [nx, nz] = pts[(i + 1) % pts.length]!;
      v.push(x, floor, z, nx, floor, nz); // floor edge
      v.push(x, top, z, nx, top, nz); // ceiling edge
      v.push(x, floor, z, x, top, z); // wall corner
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    this.lines = new THREE.LineSegments(g, this.material);
    this.lines.computeLineDistances();
    this.object.add(this.lines);
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    this.label = labelSprite(`REAL ROOM ${scan.area.toFixed(1)} m²`, '#36d6e7');
    this.label.position.set(cx, top + 0.15, cz);
    this.object.add(this.label);
    onLayer(this.object);
  }

  private clear() {
    this.lines?.geometry.dispose();
    this.lines?.removeFromParent();
    this.lines = null;
    if (this.label) {
      this.label.material.map?.dispose();
      this.label.material.dispose();
      this.label.removeFromParent();
      this.label = null;
    }
  }

  dispose() {
    this.clear();
    this.material.dispose();
    this.key = '';
    this.object.removeFromParent();
  }
}
