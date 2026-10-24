// The bundled sample prop (fixtures/props/sample.glb): a small textured wooden barrel built from
// three.js primitives and a procedural texture, exported with three's GLTFExporter in Node. It is
// what MOCK (or a missing OpenAI / Modal key) returns for "Generate from a description…"
// (server/pipeline/props.ts) and what the props e2e imports. Everything is generated here, so the
// file carries no third-party asset or licence.
//
//   pnpm tsx scripts/make-sample-prop.ts [out.glb]      (default fixtures/props/sample.glb)
//
// Barrel: 0.9 m tall, ~0.32 m radius at the belly, 16 staves, three iron hoops, lids at both ends;
// +Y up, front +Z (glTF convention), origin at the centre of its base. GLTFExporter needs a few
// browser APIs Node lacks: OffscreenCanvas (only putImageData + convertToBlob are used, for the
// texture; the PNG is encoded here with zlib), ImageData and FileReader.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// ---- the browser APIs GLTFExporter touches ---------------------------------------------------------

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf: Uint8Array) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** RGBA8 → PNG (filter 0 rows, zlib level 9). */
export function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

class NodeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}
class NodeOffscreenCanvas {
  private pixels: NodeImageData | null = null;
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return {
      translate: () => {
        throw new Error('flipY textures are not supported by this exporter shim');
      },
      scale: () => {},
      putImageData: (img: NodeImageData) => void (this.pixels = img),
    };
  }
  async convertToBlob(o: { type?: string }) {
    if (o.type && o.type !== 'image/png') throw new Error(`only PNG textures (asked for ${o.type})`);
    const p = this.pixels ?? new NodeImageData(new Uint8ClampedArray(this.width * this.height * 4), this.width, this.height);
    return new Blob([new Uint8Array(encodePng(p.width, p.height, p.data))], { type: 'image/png' });
  }
}
class NodeFileReader {
  result: ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob) {
    void blob.arrayBuffer().then((b) => {
      this.result = b;
      this.onloadend?.();
    });
  }
}
const g = globalThis as Record<string, unknown>;
g.OffscreenCanvas ??= NodeOffscreenCanvas;
g.ImageData ??= NodeImageData;
g.FileReader ??= NodeFileReader;

// ---- the barrel --------------------------------------------------------------------------------------

const HEIGHT = 0.9;
const STAVES = 16;
const radiusAt = (t: number) => 0.27 + 0.05 * Math.sin(Math.PI * t); // t = 0 bottom .. 1 top

/** Deterministic value noise (the sample must be byte-identical on every run). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Weathered oak staves: per-stave tone, grain streaks along v, dark seams between staves. */
function woodTexture(size = 128): THREE.DataTexture {
  const rand = rng(7);
  const tone = Array.from({ length: STAVES }, () => 0.82 + rand() * 0.3);
  const grain = Array.from({ length: size }, () => rand());
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const stave = Math.floor(u * STAVES);
      const inStave = u * STAVES - stave;
      const seam = inStave < 0.06 || inStave > 0.94 ? 0.45 : 1;
      const streak = 0.88 + 0.16 * Math.sin(grain[x]! * 40 + y * 0.09 + stave) * grain[(x * 7 + y) % size]!;
      const k = tone[stave]! * seam * streak;
      const i = (y * size + x) * 4;
      data[i] = Math.min(255, 128 * k);
      data[i + 1] = Math.min(255, 88 * k);
      data[i + 2] = Math.min(255, 52 * k);
      data[i + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

export function barrel(): THREE.Group {
  const wood = new THREE.MeshStandardMaterial({ name: 'oak', map: woodTexture(), roughness: 0.85, metalness: 0 });
  const iron = new THREE.MeshStandardMaterial({ name: 'iron', color: '#35322f', roughness: 0.55, metalness: 0.7 });
  const group = new THREE.Group();
  group.name = 'barrel';

  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    profile.push(new THREE.Vector2(radiusAt(t), t * HEIGHT));
  }
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 32), wood);
  body.name = 'staves';
  group.add(body);

  for (const [t, name] of [
    [0, 'bottom'],
    [1, 'top'],
  ] as const) {
    const lid = new THREE.Mesh(new THREE.CircleGeometry(radiusAt(t) - 0.012, 32), wood);
    lid.name = `lid-${name}`;
    lid.rotation.x = name === 'top' ? -Math.PI / 2 : Math.PI / 2;
    lid.position.y = t * HEIGHT + (name === 'top' ? -0.025 : 0.004);
    group.add(lid);
  }

  for (const t of [0.07, 0.3, 0.7, 0.93]) {
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(radiusAt(t) + 0.004, 0.011, 6, 40), iron);
    hoop.name = `hoop-${t}`;
    hoop.rotation.x = Math.PI / 2;
    hoop.position.y = t * HEIGHT;
    group.add(hoop);
  }
  // a bung on the belly, facing +Z (the glTF front), so the front is recognisable
  const bung = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 12), iron);
  bung.name = 'bung';
  bung.rotation.x = Math.PI / 2;
  bung.position.set(0, HEIGHT * 0.5, radiusAt(0.5) + 0.004);
  group.add(bung);
  return group;
}

async function main() {
  const out = resolve(process.argv[2] ?? new URL('../fixtures/props/sample.glb', import.meta.url).pathname);
  const scene = new THREE.Scene();
  scene.add(barrel());
  const glb = (await new GLTFExporter().parseAsync(scene, { binary: true, maxTextureSize: 256 })) as ArrayBuffer;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, new Uint8Array(glb));
  console.log(`${out}: ${glb.byteLength} bytes`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
