// Light gizmos for the director's view: a small sphere in the light's colour, a stem down to the
// floor and its falloff radius as a ring on the floor (y = 0) around the stem's foot (a ring at
// the light's own height reads as a line across the frame), and for a spot its cone (four edge
// lines + rim);
// a sun gets a line toward its aim point. Always drawn on top (no depth test), on `layer` so only
// cameras that enable that layer (the director's, not the phone's PiP) see them. Dragging is WP H.
import * as THREE from 'three';
import type { Light } from '@shared/look';

const RING_SEGMENTS = 64;

function lineMat(color: THREE.ColorRepresentation, opacity = 0.9) {
  return new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity });
}

function ring(radius: number, color: THREE.Color): THREE.LineLoop {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const a = (i / RING_SEGMENTS) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat(color, 0.55));
}

export class LightGizmos {
  readonly group = new THREE.Group();
  private key = '';

  constructor(private readonly layer: number) {
    this.group.name = 'look-light-gizmos';
    this.group.renderOrder = 9;
  }

  set(lights: Light[], selectedId: string | null = null): void {
    const key = JSON.stringify([lights, selectedId]);
    if (key === this.key) return;
    this.key = key;
    this.clear();
    for (const l of lights) this.group.add(this.build(l, l.id === selectedId));
    this.group.traverse((o) => {
      o.layers.set(this.layer);
      o.renderOrder = 9;
    });
  }

  private build(l: Light, selected: boolean): THREE.Group {
    const g = new THREE.Group();
    g.name = `light-gizmo:${l.id}`;
    const color = new THREE.Color(l.color);
    const pos = new THREE.Vector3(...l.position);
    const dim = l.enabled ? 1 : 0.35;
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(selected ? 0.07 : 0.05, 16, 12),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: dim }),
    );
    ball.position.copy(pos);
    g.add(ball);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(selected ? 0.14 : 0.1, 12, 8),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.18 * dim, wireframe: true }),
    );
    halo.position.copy(pos);
    g.add(halo);
    if (l.kind !== 'sun') {
      const r = ring(l.radius, color);
      r.position.set(pos.x, 0.02, pos.z);
      g.add(r);
      const stem = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([pos, new THREE.Vector3(pos.x, 0.02, pos.z)]),
        lineMat(color, 0.45 * dim),
      );
      g.add(stem);
    }
    const target = new THREE.Vector3(...(l.target ?? (l.kind === 'sun' ? [0, 0, 0] : [l.position[0], 0, l.position[2]])));
    if (l.kind === 'spot') {
      const axis = target.clone().sub(pos);
      const len = Math.min(l.radius, Math.max(0.5, axis.length()));
      axis.normalize();
      const half = ((l.coneDeg / 2) * Math.PI) / 180;
      const rimR = Math.tan(half) * len;
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), axis);
      const pts: THREE.Vector3[] = [];
      const rim: THREE.Vector3[] = [];
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        const p = new THREE.Vector3(Math.cos(a) * rimR, -len, Math.sin(a) * rimR).applyQuaternion(q).add(pos);
        rim.push(p);
        if (i % 8 === 0) pts.push(pos.clone(), p);
      }
      g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat(color, 0.8 * dim)));
      g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(rim), lineMat(color, 0.6 * dim)));
    } else if (l.kind === 'sun') {
      const dir = target.clone().sub(pos).normalize().multiplyScalar(1.5);
      g.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([pos, pos.clone().add(dir)]),
          lineMat(color, 0.9 * dim),
        ),
      );
    }
    return g;
  }

  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
  }

  dispose() {
    this.clear();
    this.group.removeFromParent();
  }
}
