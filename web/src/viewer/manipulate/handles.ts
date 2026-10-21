// Director-only visuals for direct manipulation, drawn on top of everything (no depth test) on the
// gizmo layer (the phone and the PiP never see them): a thin outline around what the pointer is
// over, and for the selection a ring on the floor, a rotate ring with arrow ticks, a scale / radius
// knob and, for a camera with depth of field, its focus point on the view axis.
import * as THREE from 'three';

export type Part = 'body' | 'ring' | 'scale' | 'focus';

const COLORS = {
  hover: '#9fd3ff',
  select: '#4fa3ff',
  ring: '#ffd23f',
  ringHot: '#fff2a8',
  knob: '#ff8a3d',
  knobHot: '#ffd0a8',
  focus: '#7dffb1',
  focusHot: '#d4ffe4',
};

const overlay = (color: string, opacity = 1) => ({ color, transparent: true, opacity, depthTest: false, depthWrite: false });

function boxEdges(color: string, opacity: number) {
  const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial(overlay(color, opacity)));
}

export interface SelectionVisual {
  box: THREE.Box3;
  /** Centre of the floor / rotate rings. */
  center: THREE.Vector3;
  footprint: number;
  /** Rotate ring radius (null: not rotatable). */
  ring: number | null;
  /** Scale / radius knob position (null: none). */
  knob: THREE.Vector3 | null;
  /** Focus handle: from the camera to the focus point (null: depth of field off). */
  focus: { from: THREE.Vector3; to: THREE.Vector3; editable: boolean } | null;
}

export class ManipGizmos {
  readonly group = new THREE.Group();
  private readonly hoverBox = boxEdges(COLORS.hover, 0.75);
  private readonly selBox = boxEdges(COLORS.select, 0.55);
  private readonly floorRing: THREE.Mesh;
  private readonly rotRing: THREE.Mesh;
  private readonly ticks: THREE.Mesh[] = [];
  private readonly knob: THREE.Mesh;
  private readonly focusKnob: THREE.Mesh;
  private readonly focusLine: THREE.Line;
  private readonly focusDisc: THREE.Mesh;
  private hot: Part | null = null;

  constructor(private readonly layer: number) {
    this.group.name = 'manipulate-gizmos';
    this.floorRing = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), new THREE.MeshBasicMaterial({ ...overlay(COLORS.select, 0.9), side: THREE.DoubleSide }));
    this.floorRing.rotation.x = -Math.PI / 2;
    this.rotRing = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 6, 96), new THREE.MeshBasicMaterial(overlay(COLORS.ring, 0.95)));
    this.rotRing.rotation.x = Math.PI / 2;
    // arrow ticks around the rotate ring (pointing along the turning direction)
    const tickGeo = new THREE.ConeGeometry(0.035, 0.09, 8);
    for (let i = 0; i < 4; i++) {
      const t = new THREE.Mesh(tickGeo, new THREE.MeshBasicMaterial(overlay(COLORS.ring, 0.95)));
      t.userData.angle = (i * Math.PI) / 2 + Math.PI / 4;
      this.ticks.push(t);
    }
    this.knob = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), new THREE.MeshBasicMaterial(overlay(COLORS.knob, 1)));
    this.focusKnob = new THREE.Mesh(new THREE.OctahedronGeometry(0.055), new THREE.MeshBasicMaterial(overlay(COLORS.focus, 1)));
    this.focusLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineDashedMaterial({ ...overlay(COLORS.focus, 0.8), dashSize: 0.08, gapSize: 0.05 }));
    this.focusDisc = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.215, 48), new THREE.MeshBasicMaterial({ ...overlay(COLORS.focus, 0.7), side: THREE.DoubleSide }));
    this.group.add(this.hoverBox, this.selBox, this.floorRing, this.rotRing, ...this.ticks, this.knob, this.focusKnob, this.focusLine, this.focusDisc);
    this.group.traverse((o) => {
      o.layers.set(layer);
      o.renderOrder = 20;
      o.frustumCulled = false;
    });
    this.setHover(null);
    this.setSelection(null);
  }

  setHover(box: THREE.Box3 | null) {
    this.hoverBox.visible = !!box;
    if (box) placeBox(this.hoverBox, box, 0.02);
  }

  /** Brightens the handle under the pointer. */
  setHot(part: Part | null) {
    if (part === this.hot) return;
    this.hot = part;
    (this.rotRing.material as THREE.MeshBasicMaterial).color.set(part === 'ring' ? COLORS.ringHot : COLORS.ring);
    for (const t of this.ticks) (t.material as THREE.MeshBasicMaterial).color.set(part === 'ring' ? COLORS.ringHot : COLORS.ring);
    (this.knob.material as THREE.MeshBasicMaterial).color.set(part === 'scale' ? COLORS.knobHot : COLORS.knob);
    (this.focusKnob.material as THREE.MeshBasicMaterial).color.set(part === 'focus' ? COLORS.focusHot : COLORS.focus);
  }

  setSelection(s: SelectionVisual | null) {
    const on = !!s;
    this.selBox.visible = on;
    this.floorRing.visible = on;
    this.rotRing.visible = on && s!.ring !== null;
    for (const t of this.ticks) t.visible = this.rotRing.visible;
    this.knob.visible = on && !!s!.knob;
    const focus = on ? s!.focus : null;
    this.focusKnob.visible = this.focusLine.visible = this.focusDisc.visible = !!focus;
    if (!s) return;
    placeBox(this.selBox, s.box, 0.04);
    const r = s.footprint + 0.08;
    this.floorRing.position.set(s.center.x, s.center.y + 0.012, s.center.z);
    this.floorRing.scale.setScalar(r);
    if (s.ring !== null) {
      this.rotRing.position.set(s.center.x, s.center.y + 0.02, s.center.z);
      this.rotRing.scale.setScalar(s.ring);
      for (const t of this.ticks) {
        const a = t.userData.angle as number;
        t.position.set(s.center.x + Math.cos(a) * s.ring, s.center.y + 0.02, s.center.z + Math.sin(a) * s.ring);
        // cone axis (+Y) along the ring's tangent (counter-clockwise seen from above = +yaw)
        t.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)));
      }
    }
    if (s.knob) this.knob.position.copy(s.knob);
    if (focus) {
      this.focusKnob.position.copy(focus.to);
      const pos = this.focusLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, focus.from.x, focus.from.y, focus.from.z);
      pos.setXYZ(1, focus.to.x, focus.to.y, focus.to.z);
      pos.needsUpdate = true;
      this.focusLine.computeLineDistances();
      this.focusDisc.position.copy(focus.to);
      this.focusDisc.lookAt(focus.from);
      (this.focusKnob.material as THREE.MeshBasicMaterial).opacity = focus.editable ? 1 : 0.45;
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

function placeBox(o: THREE.Object3D, box: THREE.Box3, pad: number) {
  const size = box.getSize(new THREE.Vector3()).addScalar(pad * 2);
  box.getCenter(o.position);
  o.scale.set(Math.max(size.x, 1e-3), Math.max(size.y, 1e-3), Math.max(size.z, 1e-3));
}
