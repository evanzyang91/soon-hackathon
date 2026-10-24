// Procedural stand-in world (grid floor + blocks) used when the SPZ is missing or fails to load,
// so the viewer is never a black screen. Deterministic per seed so laptop and phone match.
import * as THREE from 'three';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function createPlaceholderWorld(seedText: string, interior: boolean): THREE.Group {
  const group = new THREE.Group();
  group.name = 'placeholder-world';
  const rand = rng(hashString(seedText));
  const size = interior ? 14 : 40;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ color: interior ? '#6b5a4a' : '#4c5a46', roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.002;
  group.add(floor);

  const grid = new THREE.GridHelper(size, size, 0x9aa7b4, 0x5d6772);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.55;
  group.add(grid);

  const palette = ['#b7a58d', '#8f9fb0', '#a9746e', '#c9c1a8', '#6f8b7a', '#9a8fb8'];
  const half = size / 2;
  // keep the stage clear: nothing between the default camera (+Z) and where actors stand
  const clearX = interior ? 2.8 : 8;
  const clearBehind = interior ? -6 : -14;
  const spot = (): [number, number] => {
    for (let tries = 0; tries < 40; tries++) {
      const x = (rand() * 2 - 1) * half * 0.85;
      const z = (rand() * 2 - 1) * half * 0.85;
      if (Math.abs(x) < clearX && z > clearBehind) continue;
      return [x, z];
    }
    return [half * 0.7, -half * 0.7];
  };
  const blocks = interior ? 9 : 16;
  for (let i = 0; i < blocks; i++) {
    const w = interior ? 0.5 + rand() * 1.4 : 2 + rand() * 6;
    const h = interior ? 0.4 + rand() * 1.6 : 3 + rand() * 12;
    const d = interior ? 0.5 + rand() * 1.4 : 2 + rand() * 6;
    const [x, z] = spot();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({
        color: palette[i % palette.length],
        roughness: 0.85,
        flatShading: true,
      }),
    );
    box.position.set(x, h / 2, z);
    box.rotation.y = rand() * Math.PI;
    group.add(box);
  }

  if (interior) {
    const wallMat = new THREE.MeshStandardMaterial({
      color: '#9c9486',
      emissive: '#2a2620',
      roughness: 1,
      side: THREE.BackSide,
    });
    const room = new THREE.Mesh(new THREE.BoxGeometry(size, 3.2, size), wallMat);
    room.position.y = 1.6;
    group.add(room);
  }
  return group;
}

export function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}
