import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildMannequin, LOOK_LIMIT, MANNEQUIN_HEIGHT_M, restHeight } from './mannequin';
import { actorHeight, poseDrop, wantsGlbFile, PROCEDURAL_GLB, SIT_DROP_M } from './index';
import { tintFor } from '@shared/tint';
import { projectCandidates, wrapText } from './common';

const box = (o: THREE.Object3D) => {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o);
};
const meshes = (o: THREE.Object3D) => {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => c instanceof THREE.Mesh && out.push(c));
  return out;
};

describe('procedural mannequin', () => {
  it('stands 1.7 m tall with its feet on y = 0 and its face toward -Z', () => {
    const m = buildMannequin('#3366cc');
    m.animate(0.016, 0, false, 0);
    const b = box(m.root);
    expect(b.min.y).toBeCloseTo(0, 1);
    expect(b.max.y).toBeGreaterThan(1.6);
    expect(b.max.y).toBeLessThan(1.8);
    // eyes are the two tiny dark spheres: they sit on the -Z side of the head
    const eyes = meshes(m.root).filter((x) => x.geometry instanceof THREE.SphereGeometry && x.geometry.parameters.radius < 0.02);
    expect(eyes).toHaveLength(2);
    for (const e of eyes) expect(e.getWorldPosition(new THREE.Vector3()).z).toBeLessThan(-0.05);
    expect(m.headY).toBeGreaterThan(1.5);
    expect(meshes(m.root).length).toBeLessThan(30); // phone-light
  });

  it('opens the jaw with the voice level and mimes when the analyser is silent', () => {
    const m = buildMannequin('#3366cc');
    const jaw = () => {
      let r = 0;
      m.root.traverse((o) => {
        if (o instanceof THREE.Mesh && o.geometry instanceof THREE.BoxGeometry && o.geometry.parameters.height < 0.03) r = o.parent!.rotation.x;
      });
      return r;
    };
    for (let i = 0; i < 30; i++) m.animate(1 / 60, i / 60, false, 0);
    expect(jaw()).toBeCloseTo(0, 3);
    for (let i = 0; i < 30; i++) m.animate(1 / 60, i / 60, true, 0.8);
    expect(jaw()).toBeLessThan(-0.2); // open (front edge down)
    let opened = 0;
    for (let i = 0; i < 120; i++) {
      m.animate(1 / 60, 1 + i / 60, true, 0);
      opened = Math.min(opened, jaw());
    }
    expect(opened).toBeLessThan(-0.1);
  });

  it('walking swings the legs, sitting lowers the hips with thighs forward', () => {
    const m = buildMannequin('#3366cc');
    m.setPose('walking');
    const spans: number[] = [];
    for (let i = 0; i < 60; i++) {
      m.animate(1 / 30, i / 30, false, 0);
      spans.push(box(m.root).max.z - box(m.root).min.z);
    }
    expect(Math.max(...spans)).toBeGreaterThan(0.45);
    m.setPose('sitting');
    m.animate(1 / 30, 3, false, 0);
    const b = box(m.root);
    expect(b.max.y).toBeLessThan(1.4);
    expect(b.min.z).toBeLessThan(-0.4); // knees out in front (-Z)
    expect(b.min.y).toBeGreaterThan(-0.05);
    m.dispose();
  });
});

describe('mannequin idle life', () => {
  const shoes = (o: THREE.Object3D) =>
    meshes(o).filter((x) => x.geometry instanceof THREE.BoxGeometry && x.geometry.parameters.depth > 0.2);
  const world = (m: THREE.Mesh) => m.getWorldPosition(new THREE.Vector3());

  it('shifts its weight every 6–10 s, eased (no jumps), with the feet planted', () => {
    const m = buildMannequin('#3366cc');
    const dt = 1 / 30;
    m.animate(dt, 0, false, 0);
    m.root.updateMatrixWorld(true);
    const feet0 = shoes(m.root).map(world);
    expect(feet0).toHaveLength(2);
    const shifts: number[] = [];
    let maxStep = 0;
    let worstSlide = 0;
    let lowest = Infinity;
    for (let i = 1; i <= 30 * 40; i++) {
      const prev = m.weightShift();
      m.animate(dt, i * dt, false, 0);
      const s = m.weightShift();
      shifts.push(s);
      maxStep = Math.max(maxStep, Math.abs(s - prev));
      m.root.updateMatrixWorld(true);
      shoes(m.root).forEach((f, k) => {
        const p = world(f);
        worstSlide = Math.max(worstSlide, Math.abs(p.x - feet0[k]!.x));
        lowest = Math.min(lowest, p.y);
      });
    }
    // it does shift, both ways, and settles between shifts
    expect(Math.max(...shifts)).toBeGreaterThan(0.5);
    expect(Math.min(...shifts)).toBeLessThan(-0.5);
    // eased over ~1.4 s: even a left-to-right shift (travel 2) moves < 0.08 per 1/30 s frame
    expect(maxStep).toBeLessThan(0.08);
    // ...and only now and then: in 40 s it changes on at most ~7 occasions (every 6–10 s)
    let moves = 0;
    for (let i = 1; i < shifts.length; i++) {
      const moving = Math.abs(shifts[i]! - shifts[i - 1]!) > 1e-5;
      const was = i > 1 && Math.abs(shifts[i - 1]! - shifts[i - 2]!) > 1e-5;
      if (moving && !was) moves++;
    }
    expect(moves).toBeGreaterThanOrEqual(3);
    expect(moves).toBeLessThanOrEqual(7);
    // feet stay put (< 1.5 cm sideways) and never sink into the floor
    expect(worstSlide).toBeLessThan(0.015);
    expect(lowest).toBeGreaterThan(-0.03);
  });

  it('turns its head toward the look target, eased and clamped, and back when it is gone', () => {
    const m = buildMannequin('#cc6633');
    const dt = 1 / 60;
    let t = 0;
    const run = (seconds: number) => {
      let maxStep = 0;
      for (let i = 0; i < seconds / dt; i++) {
        const before = m.lookYaw();
        m.animate(dt, (t += dt), false, 0);
        maxStep = Math.max(maxStep, Math.abs(m.lookYaw() - before));
      }
      return maxStep;
    };
    run(0.5);
    expect(m.lookYaw()).toBeCloseTo(0, 6);
    m.setLook(0.8); // partner on the left
    m.animate(dt, (t += dt), false, 0);
    expect(m.lookYaw()).toBeLessThan(0.1); // no snap
    const step = run(2);
    expect(m.lookYaw()).toBeCloseTo(0.8, 2);
    expect(step).toBeLessThan(0.06);
    // the face (eyes, on −Z of the head) really points left (−X) now
    m.root.updateMatrixWorld(true);
    const eyes = meshes(m.root).filter((x) => x.geometry instanceof THREE.SphereGeometry && x.geometry.parameters.radius < 0.02);
    const mid = world(eyes[0]!).add(world(eyes[1]!)).multiplyScalar(0.5);
    expect(mid.x).toBeLessThan(-0.05);
    m.setLook(-3); // behind on the right: turns as far as a neck can
    run(3);
    expect(m.lookYaw()).toBeCloseTo(-LOOK_LIMIT, 2);
    m.setLook(null);
    run(3);
    expect(Math.abs(m.lookYaw())).toBeLessThan(0.01);
  });
});

describe('fallback selection helpers', () => {
  it('only treats real .glb/.gltf URLs as files', () => {
    expect(wantsGlbFile(PROCEDURAL_GLB)).toBe(false);
    expect(wantsGlbFile('')).toBe(false);
    expect(wantsGlbFile('actors/maya')).toBe(false);
    expect(wantsGlbFile('/actors-fallback/humanoid.glb')).toBe(true);
    expect(wantsGlbFile('https://x/y.gltf?v=1')).toBe(true);
  });
  it('resolves project-root paths first when the base is a scene directory', () => {
    expect(projectCandidates('actors/maya/sequence/sequence.json', 'https://h/projects/p1/scene-0/')).toEqual([
      'https://h/projects/p1/actors/maya/sequence/sequence.json',
      'https://h/projects/p1/scene-0/actors/maya/sequence/sequence.json',
    ]);
    expect(projectCandidates('actors/maya/sequence/sequence.json', 'https://h/projects/p1/')).toEqual([
      'https://h/projects/p1/actors/maya/sequence/sequence.json',
    ]);
  });
  it('tints are stable css hex per id', () => {
    expect(tintFor('maya')).toBe(tintFor('maya'));
    expect(tintFor('maya')).not.toBe(tintFor('raj'));
    expect(tintFor('maya')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('speaking caption + seated height', () => {
  it('word-wraps the caption line and ellipsizes past the line cap', () => {
    expect(wrapText('MAYA: I let it go.', 34)).toEqual(['MAYA: I let it go.']);
    expect(wrapText("THEO: That's the saddest thing I've heard all week.", 34)).toEqual([
      "THEO: That's the saddest thing",
      "I've heard all week.",
    ]);
    const long = wrapText('word '.repeat(60), 10, 3);
    expect(long).toHaveLength(3);
    expect(long[2]!.endsWith('…')).toBe(true);
    expect(wrapText('   ', 10)).toEqual(['']);
  });

  it('lowers seated actors to a plausible seated eye line, matching the mannequin hips', () => {
    expect(poseDrop('standing')).toBe(0);
    expect(poseDrop('walking')).toBe(0);
    expect(poseDrop('sitting')).toBe(SIT_DROP_M);
    const m = buildMannequin('#3366cc');
    m.setPose('sitting');
    m.animate(0.016, 0, false, 0);
    const seatedTop = box(m.root).max.y;
    m.setPose('standing');
    m.animate(0.016, 0, false, 0);
    const standingTop = box(m.root).max.y;
    expect(standingTop - seatedTop).toBeCloseTo(SIT_DROP_M, 1);
  });

  it('scales to the character’s height: asset, else character, else 1.7 m; the seated drop too', () => {
    expect(actorHeight({ heightMeters: 1.85 }, { heightMeters: 1.6 })).toBe(1.85);
    expect(actorHeight({}, { heightMeters: 1.3 })).toBe(1.3);
    expect(actorHeight({})).toBe(1.7);
    expect(poseDrop('sitting', 1.3)).toBeCloseTo((SIT_DROP_M * 1.3) / 1.7, 6);
    // the mannequin body scales its root by height / rest height: the head top lands at 1.85 m
    const m = buildMannequin('#3366cc');
    const rest = restHeight(m.root);
    expect(rest).toBeGreaterThan(MANNEQUIN_HEIGHT_M); // the head sphere ends a little above 1.7
    expect(rest).toBeLessThan(1.75);
    m.root.scale.setScalar(1.85 / rest);
    expect(box(m.root).max.y).toBeCloseTo(1.85, 3);
    expect(box(m.root).min.y).toBeCloseTo(0, 1);
  });
});
