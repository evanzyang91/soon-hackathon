import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildMannequin } from './mannequin';
import { poseDrop, wantsGlbFile, PROCEDURAL_GLB, SIT_DROP_M } from './index';
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
});
