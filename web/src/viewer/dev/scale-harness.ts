// Offscreen scale renders: a Marble world with the viewer's transform (× a calibration factor),
// 1.70 m reference mannequins and an optional measuring pole, drawn from a given camera. Driven
// by server/pipeline/calibrate-render.ts through window.__scale (Playwright, GPU Chromium).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SplatMesh } from '@sparkjsdev/spark';
import { createSpark } from '../spark';
import { worldTransform } from '../transform';
import { buildMannequin } from '../actors/mannequin';
import { textSprite } from '../actors/common';
import type { ScaleHarness, ScaleMark, ScalePanel, ScaleShot, ScaleWorld } from './scale-shot';

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(1280, 720);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#1a1d22');
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(3, 6, 4);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 500);
camera.rotation.order = 'YXZ';
scene.add(createSpark(renderer));
const worldRoot = new THREE.Group();
scene.add(worldRoot);
const props = new THREE.Group();
scene.add(props);
let frame: ScaleWorld | null = null;
let collider: THREE.Object3D | null = null;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function clearProps() {
  for (const o of [...props.children]) {
    props.remove(o);
    o.traverse((c) => {
      if (c instanceof THREE.Mesh || c instanceof THREE.Sprite) {
        c.geometry?.dispose();
        const m = c.material as THREE.Material | THREE.Material[];
        for (const mm of Array.isArray(m) ? m : [m]) {
          (mm as THREE.SpriteMaterial).map?.dispose();
          mm.dispose();
        }
      }
    });
  }
}

/** 2 m pole, alternating 0.5 m bands, with a tick label at 1 m and 2 m. */
function ruler(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8),
      new THREE.MeshBasicMaterial({ color: i % 2 ? '#ffffff' : '#e8452c' }),
    );
    m.position.y = 0.25 + i * 0.5;
    g.add(m);
  }
  for (const h of [1, 2]) {
    const s = textSprite(`${h} m`, { h: 0.09, bg: 'rgba(0,0,0,0.55)', fg: '#fff' });
    s.sprite.position.set(0.16, h, 0);
    g.add(s.sprite);
  }
  return g;
}

/**
 * The current frame with each mark drawn as a ring on the ground (projected, so it foreshortens
 * like the floor) and a fixed-size label just above it, on a 2D copy of the canvas: labels stay
 * readable at any depth and never sort against the splats.
 */
function drawMarks(marks: ScaleMark[], width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(renderer.domElement, 0, 0);
  const px = (x: number, y: number, z: number): [number, number] | null => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return v.z > 1 ? null : [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height];
  };
  ctx.font = '700 15px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const m of marks) {
    const centre = px(m.x, m.y, m.z);
    if (!centre) continue;
    const r = m.radius ?? 0.14;
    const ring = Array.from({ length: 20 }, (_, k) => px(m.x + r * Math.cos((k * Math.PI) / 10), m.y, m.z + r * Math.sin((k * Math.PI) / 10)));
    const color = m.color ?? '#ffd23f';
    if (ring.every(Boolean)) {
      ctx.beginPath();
      ring.forEach((p, k) => (k ? ctx.lineTo(p![0], p![1]) : ctx.moveTo(p![0], p![1])));
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(centre[0], centre[1], 2.5, 0, Math.PI * 2);
    ctx.fill();
    const w = ctx.measureText(m.label).width + 8;
    const [lx, ly] = [centre[0], centre[1] - 15];
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(lx - w / 2, ly - 9, w, 18);
    ctx.fillStyle = color;
    ctx.fillText(m.label, lx, ly + 1);
  }
  return c;
}

const harness: ScaleHarness = {
  async load(world) {
    frame = world;
    if (world.background) scene.background = new THREE.Color(world.background);
    const bytes = new Uint8Array(await (await fetch(world.spz)).arrayBuffer());
    const mesh = new SplatMesh({ fileBytes: bytes, fileName: world.spz.split('/').pop() || 'world.spz' });
    await mesh.initialized;
    worldRoot.add(mesh);
    if (world.collider) {
      const gltf = await new GLTFLoader().loadAsync(world.collider);
      const wire = new THREE.MeshBasicMaterial({ color: '#7fd1ff', wireframe: true, transparent: true, opacity: 0.35 });
      gltf.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) o.material = wire;
      });
      gltf.scene.visible = false;
      collider = gltf.scene;
      worldRoot.add(collider);
    }
    return { splats: mesh.numSplats };
  },

  async render(shot: ScaleShot) {
    if (!frame) throw new Error('load() a world first');
    const t = worldTransform({ ...frame, scaleCalibration: { factor: shot.factor } });
    worldRoot.rotation.x = t.rotationX;
    worldRoot.scale.setScalar(t.scale);
    worldRoot.position.y = t.positionY;
    if (collider) collider.visible = !!shot.showCollider;
    renderer.setSize(shot.width, shot.height);
    camera.aspect = shot.width / shot.height;
    camera.fov = (2 * Math.atan(Math.tan((shot.camera.fovDeg * Math.PI) / 360) / camera.aspect) * 180) / Math.PI;
    camera.position.set(...shot.camera.position);
    camera.rotation.set((shot.camera.pitchDeg * Math.PI) / 180, (shot.camera.yawDeg * Math.PI) / 180, 0);
    camera.updateProjectionMatrix();
    clearProps();
    for (const f of shot.figures) {
      const g = new THREE.Group();
      const m = buildMannequin(f.tint ?? '#ff8a1f');
      if (f.pose) m.setPose(f.pose);
      m.animate(0, 0, false, 0);
      g.add(m.root);
      const label = textSprite(f.label ?? '1.70 m', { h: 0.11, bg: 'rgba(0,0,0,0.6)', fg: '#fff' });
      label.sprite.center.set(0.5, 0);
      label.sprite.position.y = 1.74;
      g.add(label.sprite);
      if (shot.ruler) {
        const r = ruler();
        r.position.x = 0.45;
        g.add(r);
      }
      g.position.set(f.x, f.y ?? 0, f.z);
      g.rotation.y = f.yaw ?? Math.atan2(shot.camera.position[0] - f.x, shot.camera.position[2] - f.z);
      props.add(g);
    }
    // Spark sorts splats asynchronously: render until the order has settled
    for (let i = 0; i < 45; i++) {
      renderer.render(scene, camera);
      await nextFrame();
    }
    renderer.render(scene, camera);
    const out = shot.marks?.length ? drawMarks(shot.marks, shot.width, shot.height) : renderer.domElement;
    return shot.format === 'jpeg' ? out.toDataURL('image/jpeg', 0.9) : out.toDataURL('image/png');
  },

  async compose(panels: ScalePanel[], footer: string[]) {
    const imgs = await Promise.all(
      panels.map(
        (p) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = p.image;
          }),
      ),
    );
    const w = imgs.reduce((s, im) => s + im.width, 0) + 12 * (imgs.length - 1);
    const h = Math.max(...imgs.map((im) => im.height));
    const head = 78;
    const lineH = 26;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    // wrap footer lines to the picture width
    ctx.font = '400 19px ui-monospace, Menlo, monospace';
    const lines: string[] = [];
    for (const l of footer) {
      let cur = '';
      for (const word of l.split(' ')) {
        const next = cur ? `${cur} ${word}` : word;
        if (ctx.measureText(next).width > w - 32 && cur) {
          lines.push(cur);
          cur = `    ${word}`;
        } else cur = next;
      }
      lines.push(cur);
    }
    const foot = lines.length ? lines.length * lineH + 24 : 0;
    c.width = w;
    c.height = head + h + foot;
    ctx.fillStyle = '#121418';
    ctx.fillRect(0, 0, c.width, c.height);
    let x = 0;
    imgs.forEach((im, i) => {
      const p = panels[i]!;
      ctx.drawImage(im, x, head);
      ctx.fillStyle = '#f2f2f2';
      ctx.font = '600 28px system-ui, sans-serif';
      ctx.fillText(p.title, x + 16, 36);
      if (p.subtitle) {
        ctx.fillStyle = '#b8c0cc';
        ctx.font = '400 20px system-ui, sans-serif';
        ctx.fillText(p.subtitle, x + 16, 64);
      }
      x += im.width + 12;
    });
    ctx.fillStyle = '#d8dde4';
    ctx.font = '400 19px ui-monospace, Menlo, monospace';
    lines.forEach((l, i) => ctx.fillText(l, 16, head + h + 30 + i * lineH));
    return c.toDataURL('image/png');
  },
};

Object.defineProperty(window, '__scale', { value: harness });
