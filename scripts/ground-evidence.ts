// Evidence for the ground height field (server/pipeline/calibrate-ground.ts): for one world, 1.70 m
// mannequins at the blocking marks and at the spots where the field differs most from the median
// floor, drawn by the scale harness in GPU Chromium (calibrate-render.ts, the k500 tier the viewer
// shows by default) twice — left as the viewer stood actors before (feet at y = 0, the median
// floor floorOffsetMeters raises the world to), right on the field (viewer/ground.ts) — plus a
// heat map of the field. Feet errors are measured against the k500 splats under each figure
// (r 0.15 m, the lowest flat layer: an independent look at the ground the viewer draws).
//
//   pnpm tsx scripts/ground-evidence.ts <worldDir> --name bus-stop [--title "Bus stop"]
//     [--marks "x,z;x,z"] [--labels "maya,leo"] [--spots 3] [--out docs/images]
//
// Marks default to ../manifest.json's blocking (a project scene), else the world's floor probes
// (scale-calibration.json). Writes <out>/ground-<name>-before-after.png and
// <out>/ground-<name>-field.png and prints the numbers. Read-only on the world dir: it uses the
// stored ground.json when world-asset.json names a current one, else measures a field in memory.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { cellHeight, feetY, sampleGround, type GroundField } from '../shared/ground.ts';
import { WorldAsset } from '../shared/schema.ts';
import { fieldCoverage, fieldPoints, groundField, groundLayers, storedGroundField } from '../server/pipeline/calibrate-ground.ts';
import { openWorldRenderer } from '../server/pipeline/calibrate-render.ts';
import { encodePng } from '../server/pipeline/mock-world.ts';
import { calibrationFactor, floorOffset } from '../web/src/viewer/transform.ts';
import type { ScaleFigure } from '../web/src/viewer/dev/scale-shot.ts';
import { decodePng } from '../tests/e2e/helpers.ts';

type V3 = [number, number, number];

function args(argv: string[]) {
  const pos: string[] = [];
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) o[a.slice(2)] = argv[++i] ?? '';
    else pos.push(a);
  }
  return { pos, o };
}

interface Figure {
  label: string;
  kind: 'mark' | 'spot';
  /** scene metres */
  x: number;
  z: number;
}

const cm = (m: number) => `${m >= 0 ? '+' : '−'}${Math.abs(m * 100).toFixed(1)} cm`;

async function main() {
  const { pos, o } = args(process.argv.slice(2));
  const dir = pos[0];
  const name = o.name;
  if (!dir || !name) throw new Error('usage: ground-evidence.ts <worldDir> --name <name> [--title t] [--marks "x,z;x,z"] [--labels a,b] [--spots 3] [--out dir]');
  const worldDir = resolve(dir);
  const outDir = resolve(o.out ?? 'docs/images');
  const asset = WorldAsset.parse(JSON.parse(await readFile(join(worldDir, 'world-asset.json'), 'utf8')));
  const f = calibrationFactor(asset);
  const off = floorOffset(asset);
  const frame = { factor: f, floorOffset: off };

  // marks: explicit, else the scene's blocking, else the floor probes of the last calibration
  let marks: [number, number][] = [];
  let labels: string[] = [];
  let markKind = 'blocking marks';
  if (o.marks) {
    marks = o.marks.split(';').map((p) => p.split(',').map(Number) as [number, number]);
    labels = o.labels?.split(',') ?? marks.map((_, i) => `mark ${i + 1}`);
  } else {
    const m = JSON.parse(await readFile(join(dirname(worldDir), 'manifest.json'), 'utf8').catch(() => 'null')) as {
      world?: { worldId?: string };
      plan?: { blocking?: { characterId: string; position: number[] }[] };
    } | null;
    if (m?.world?.worldId === asset.worldId && m.plan?.blocking?.length) {
      marks = m.plan.blocking.map((b) => [b.position[0]!, b.position[2]!]);
      labels = m.plan.blocking.map((b) => b.characterId);
    } else {
      const rep = JSON.parse(await readFile(join(worldDir, 'scale-calibration.json'), 'utf8')) as {
        ground?: { probes: { x: number; z: number }[] };
      };
      marks = (rep.ground?.probes ?? []).map((p) => [p.x * f, p.z * f]);
      labels = marks.map((_, i) => `probe ${i + 1}`);
      markKind = 'floor probes (no blocking in a library world: where actors usually stand)';
    }
  }

  const field: GroundField | null =
    (await storedGroundField(worldDir, asset)) ?? (await groundField(worldDir, asset, { marks }));
  if (!field) throw new Error('no ground field for this world');
  const { covered, cells } = fieldCoverage(field);
  const hs = field.heights.filter((h): h is number => h !== null);
  const median = -off; // the median floor, Marble's frame

  // the spots near the staging area where the field differs most from the median floor: cells
  // whose 3×3 neighbourhood all holds ground (no edge of a hole), ≥ 1 m from the marks and each other
  const cx = marks.reduce((s, m) => s + m[0], 0) / Math.max(1, marks.length);
  const zs = marks.map((m) => m[1]);
  const zMin = Math.min(...zs, -2.5) - 2.2;
  const zMax = Math.min(-1.2, Math.max(...zs, -2.5) + 1);
  const cands: { x: number; z: number; d: number }[] = [];
  for (let k = 1; k < field.rows - 1; k++)
    for (let i = 1; i < field.cols - 1; i++) {
      const x = (field.origin[0] + (i + 0.5) * field.cell) * f;
      const z = (field.origin[1] + (k + 0.5) * field.cell) * f;
      // in the staging area, in the source camera's view (where Marble captured the ground best)
      if (Math.abs(x - cx) > 2.6 || z < zMin || z > zMax || Math.abs(x) > -z * Math.tan((50 * Math.PI) / 180)) continue;
      // inside a patch of ground (5×5 all measured), not at the foot of a wall or a panel
      let full = true;
      for (let dk = -2; dk <= 2; dk++) for (let di = -2; di <= 2; di++) if (cellHeight(field, i + di, k + dk) === null) full = false;
      if (!full) continue;
      cands.push({ x, z, d: cellHeight(field, i, k)! - median });
    }
  cands.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const k500 = await fieldPoints(worldDir, asset, 'k500');
  /** Opaque splats in a 0.35 m cylinder from 0.12 to 1.8 m above the ground at (x, z) (scene m). */
  const clutter = (x: number, z: number, ground: number) => {
    let n = 0;
    for (let j = 0; j < k500.opacities.length; j++) {
      if (k500.opacities[j]! < 0.5) continue;
      const dy = k500.positions[3 * j + 1]! - ground;
      if (dy < 0.12 || dy > 1.8) continue;
      if ((k500.positions[3 * j]! - x / f) ** 2 + (k500.positions[3 * j + 2]! - z / f) ** 2 <= 0.35 ** 2) n++;
    }
    return n;
  };
  const want = Number(o.spots ?? 3);
  const spots: Figure[] = [];
  for (const c of cands) {
    if (spots.length >= want) break;
    const far = (p: [number, number], r: number) => Math.hypot(p[0] - c.x, p[1] - c.z) >= r;
    if (!marks.every((m) => far(m, 1.0)) || !spots.every((s) => far([s.x, s.z], 1.2))) continue;
    // room to stand and a clear view from the source camera's side: nothing over the spot (a
    // bench, a panel) and nothing on the close-up camera's line 0.7 m toward the source camera
    const g = median + c.d;
    const t = Math.atan2(-c.x, -c.z);
    if (clutter(c.x, c.z, g) > 10 || clutter(c.x + 0.7 * Math.sin(t), c.z + 0.7 * Math.cos(t), g) > 10) continue;
    spots.push({ label: `Δ ${cm(c.d)}`, kind: 'spot', x: Math.round(c.x * 100) / 100, z: Math.round(c.z * 100) / 100 });
  }
  const figures: Figure[] = [...marks.map(([x, z], i) => ({ label: labels[i] ?? `mark ${i + 1}`, kind: 'mark' as const, x, z })), ...spots];

  // the ground the viewer draws under each figure, measured independently: k500 splats, r 0.15 m
  const local = figures.map((g) => {
    for (const r of [0.15, 0.25, 0.4]) {
      const ys: number[] = [];
      const px = g.x / f;
      const pz = g.z / f;
      for (let j = 0; j < k500.opacities.length; j++) {
        if (k500.opacities[j]! < 0.5 || (k500.surfaceUp && k500.surfaceUp[j]! < 0.75)) continue;
        const dx = k500.positions[3 * j]! - px;
        const dz = k500.positions[3 * j + 2]! - pz;
        if (dx * dx + dz * dz <= r * r) ys.push(k500.positions[3 * j + 1]!);
      }
      const l = groundLayers(ys.sort((a, b) => a - b), 5)[0];
      if (l) return { h: l.y, r };
    }
    return null;
  });

  // viewer frame: ground height h lands at f (h + off); feet before at 0, after at feetY
  const rows = figures.map((g, i) => {
    const fieldH = sampleGround(field, g.x / f, g.z / f);
    const after = feetY(field, frame, g.x / f, g.z / f);
    const truth = local[i] ? f * (local[i]!.h + off) : null;
    return { g, fieldH, after, truth, errBefore: truth === null ? null : 0 - truth, errAfter: truth === null ? null : after - truth };
  });

  // ---- renders: harness frame = viewer frame without the floor raise (y_h = y_v − f·off)
  const lift = f * off;
  const xs = figures.map((g) => g.x);
  const zsAll = figures.map((g) => g.z);
  const mid: V3 = [(Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zsAll) + Math.max(...zsAll)) / 2];
  const hfov = Number(o.fov ?? 80);
  // the overview stands behind the figures on the source camera's side, low, far enough back that
  // every figure is in frame
  const camX = mid[0];
  const half = Math.tan(((hfov / 2) * 0.82 * Math.PI) / 180);
  const fit = Math.max(...figures.map((g) => g.z + Math.abs(g.x - camX) / half));
  const camZ = Number(o.camz ?? Math.min(2, Math.max(Math.max(...zsAll) + 1.5, fit)));
  const camY = Number(o.camy ?? 1.1);
  const camPos: V3 = [camX, camY - lift, camZ];
  const yawTo = (from: V3, x: number, z: number) => (Math.atan2(-(x - from[0]), -(z - from[2])) * 180) / Math.PI;
  const overview = {
    position: camPos,
    yawDeg: yawTo(camPos, mid[0], mid[2]),
    pitchDeg: (Math.atan2(0.45 - camY, Math.hypot(mid[0] - camPos[0], mid[2] - camZ)) * 180) / Math.PI,
    fovDeg: hfov,
  };
  const tint = (g: Figure) => (g.kind === 'mark' ? '#ff8a1f' : '#3d8bfd');
  const figs = (after: boolean, only?: number): ScaleFigure[] =>
    rows.flatMap((r, i) =>
      only !== undefined && only !== i
        ? []
        : [
            {
              x: r.g.x,
              z: r.g.z,
              y: (after ? r.after : 0) - lift,
              label: only === undefined ? `${i + 1} ${r.g.label}` : ' ',
              tint: tint(r.g),
              // three-quarter view from the source camera's side: both feet visible
              yaw: Math.atan2(-r.g.x, -r.g.z) + Math.PI + 0.6,
            },
          ],
    );
  const renderer = await openWorldRenderer(worldDir, asset, { quality: 'k500', log: (m) => console.log(m) });
  try {
    const W = 1180;
    const H = 640;
    const title = o.title ?? name;
    const shot = (after: boolean) => renderer.shot({ factor: f, camera: overview, figures: figs(after), width: W, height: H });
    const row1 = decodePng(
      await renderer.compose(
        [
          { image: await shot(false), title: 'Before: feet at y = 0 (one median floor)', subtitle: `${title}: every actor at the median ground height` },
          { image: await shot(true), title: 'After: feet on the ground field', subtitle: `${title}: each actor on the ground under its own spot` },
        ],
        [],
      ),
    );
    // close-ups of each figure's feet, before | after, from the source camera's side
    const CW = Math.floor((row1.width - 12 * (rows.length - 1)) / rows.length / 2) - 2;
    const CH = 330;
    const fmt = (v: number | null) => (v === null ? '—' : cm(v));
    const closeups: { image: Buffer; title: string; subtitle: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const toward = Math.atan2(-r.g.x, -r.g.z); // heading from the figure to the source camera
      const d = 1.25;
      const groundH = r.after - lift;
      const cam: V3 = [r.g.x + d * Math.sin(toward), groundH + 0.42, r.g.z + d * Math.cos(toward)];
      const camera = {
        position: cam,
        yawDeg: yawTo(cam, r.g.x, r.g.z),
        pitchDeg: (Math.atan2(groundH + 0.12 - cam[1], d) * 180) / Math.PI,
        fovDeg: 34,
      };
      const one = async (after: boolean) => decodePng(await renderer.shot({ factor: f, camera, figures: figs(after, i), width: CW, height: CH }));
      const pair = hstack([await one(false), await one(true)], 4);
      closeups.push({
        image: encodePng(pair.width, pair.height, (x, y) => {
          const j = (y * pair.width + x) * 4;
          return [pair.rgba[j]! / 255, pair.rgba[j + 1]! / 255, pair.rgba[j + 2]! / 255];
        }),
        title: `${i + 1} ${r.g.label}`,
        subtitle: `before | after: ${fmt(r.errBefore)} → ${fmt(r.errAfter)}`,
      });
    }
    const errs = (k: 'errBefore' | 'errAfter', kind: Figure['kind']) => {
      const v = rows.filter((r) => r.g.kind === kind && r[k] !== null).map((r) => Math.abs(r[k]!));
      return v.length ? `${(Math.max(...v) * 100).toFixed(1)} cm` : '—';
    };
    const footer = [
      `${title}: ground field ${field.cols}×${field.rows} cells of ${field.cell} m, ${Math.round((100 * covered) / cells)} % with ground, ${cm(Math.min(...hs))}..${cm(Math.max(...hs))} vs Marble's plane; median floor ${cm(median)} (floorOffsetMeters ${off.toFixed(3)}).`,
      `Feet minus the visible ground under each figure (k500 splats lying flat within 0.15 m, the tier the viewer draws), before → after: ${rows.map((r, i) => `${i + 1} ${r.g.label} (${r.g.x.toFixed(2)}, ${r.g.z.toFixed(2)}) ${fmt(r.errBefore)} → ${fmt(r.errAfter)}`).join(' · ')}.`,
      `Worst |error| at the marks ${errs('errBefore', 'mark')} → ${errs('errAfter', 'mark')}; at the spots where the field is furthest from the median ${errs('errBefore', 'spot')} → ${errs('errAfter', 'spot')}. Orange: ${markKind}; blue: those spots (Δ = field − median). Same cameras, frozen pose, GPU Chromium (Metal).`,
    ];
    const row2 = decodePng(await renderer.compose(closeups, footer));
    const png = vstack([row1, row2]);
    const ba = join(outDir, `ground-${name}-before-after.png`);
    await writeFile(
      ba,
      encodePng(png.width, png.height, (x, y) => {
        const j = (y * png.width + x) * 4;
        return [png.rgba[j]! / 255, png.rgba[j + 1]! / 255, png.rgba[j + 2]! / 255];
      }),
    );

    // ---- heat map (diverging about the median floor; hatched = no ground)
    const heat = heatMap(field, median, f, figures);
    const range = heat.range;
    const map = await renderer.compose(
      [
        {
          image: heat.png,
          title: `${title}: ground height field`,
          subtitle: `blue lower / red higher than the median floor, ±${(range * 100).toFixed(0)} cm full scale · hatched: no ground`,
        },
      ],
      [
        `${field.cols}×${field.rows} cells of ${field.cell} m (x ${(field.origin[0] * f).toFixed(2)}..${((field.origin[0] + field.cols * field.cell) * f).toFixed(2)}, z ${(field.origin[1] * f).toFixed(2)}..${((field.origin[1] + field.rows * field.cell) * f).toFixed(2)} m; far side up), ${Math.round((100 * covered) / cells)} % with ground, ${cm(Math.min(...hs))}..${cm(Math.max(...hs))}.`,
        `Black ring = ${markKind.startsWith('floor') ? 'floor probe (no blocking)' : 'blocking mark'}, black square = a spot where the field is furthest from the median (numbered as in the before/after, ${figures.map((g, i) => `${i + 1} ${g.label}`).join(', ')}), triangle = Marble's source camera; grid lines every metre.`,
      ],
    );
    const fp = join(outDir, `ground-${name}-field.png`);
    await writeFile(fp, map);
    console.log(footer.join('\n'));
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          label: r.g.label,
          kind: r.g.kind,
          x: r.g.x,
          z: r.g.z,
          field: r.fieldH,
          local: local[rows.indexOf(r)],
          feetBefore: 0,
          feetAfter: Math.round(r.after * 1000) / 1000,
          errBefore: r.errBefore === null ? null : Math.round(r.errBefore * 1000) / 1000,
          errAfter: r.errAfter === null ? null : Math.round(r.errAfter * 1000) / 1000,
        })),
      ),
    );
    console.log(`wrote ${ba}\nwrote ${fp}`);
  } finally {
    await renderer.close();
  }
}

// ---- image stacking (compose() lays panels out in one row) ------------------------------------

type Img = { width: number; height: number; rgba: Uint8Array };
const BG = [0x12, 0x14, 0x18, 255];

function hstack(imgs: Img[], gap: number): Img {
  const width = imgs.reduce((s, m) => s + m.width, 0) + gap * (imgs.length - 1);
  const height = Math.max(...imgs.map((m) => m.height));
  const rgba = new Uint8Array(width * height * 4);
  for (let j = 0; j < rgba.length; j += 4) rgba.set(BG, j);
  let x0 = 0;
  for (const m of imgs) {
    for (let y = 0; y < m.height; y++) rgba.set(m.rgba.subarray(y * m.width * 4, (y + 1) * m.width * 4), (y * width + x0) * 4);
    x0 += m.width + gap;
  }
  return { width, height, rgba };
}

function vstack(imgs: Img[]): Img {
  const width = Math.max(...imgs.map((m) => m.width));
  const height = imgs.reduce((s, m) => s + m.height, 0);
  const rgba = new Uint8Array(width * height * 4);
  for (let j = 0; j < rgba.length; j += 4) rgba.set(BG, j);
  let y0 = 0;
  for (const m of imgs) {
    for (let y = 0; y < m.height; y++) rgba.set(m.rgba.subarray(y * m.width * 4, (y + 1) * m.width * 4), ((y0 + y) * width) * 4);
    y0 += m.height;
  }
  return { width, height, rgba };
}

// ---- heat map pixels -------------------------------------------------------------------------

const hex = (s: string): V3 => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as V3;
const BLUE = hex('#2a78d6');
const RED = hex('#e34948');
const MID = hex('#f0efec');
const HOLE_A = hex('#d9d8d4');
const HOLE_B = hex('#b9b8b3');
const INK: V3 = [0.08, 0.08, 0.08];
const mix = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 3×5 digits for the figure numbers. */
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];

function heatMap(field: GroundField, median: number, f: number, figures: Figure[]) {
  const S = 12; // px per cell
  const w = field.cols * S;
  const h = field.rows * S;
  const dev = field.heights.filter((v): v is number => v !== null).map((v) => Math.abs(v - median));
  dev.sort((a, b) => a - b);
  // full scale: the 98th percentile deviation, rounded up to 5 cm (a few outliers do not wash it out)
  const range = Math.max(0.05, Math.ceil((dev[Math.floor(0.98 * (dev.length - 1))] ?? 0.05) / 0.05) * 0.05);
  const px = new Array<V3>(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = Math.floor(x / S);
      const k = Math.floor(y / S);
      const v = cellHeight(field, i, k);
      if (v === null) px[y * w + x] = (x + y) % 8 < 3 ? HOLE_B : HOLE_A;
      else {
        const t = Math.max(-1, Math.min(1, (v - median) / range));
        px[y * w + x] = t < 0 ? mix(MID, BLUE, -t) : mix(MID, RED, t);
      }
    }
  const put = (x: number, y: number, c: V3) => {
    if (x >= 0 && y >= 0 && x < w && y < h) px[Math.round(y) * w + Math.round(x)] = c;
  };
  const toPx = (sx: number, sz: number): [number, number] => [((sx / f - field.origin[0]) / field.cell) * S, ((sz / f - field.origin[1]) / field.cell) * S];
  // metre grid
  for (let gx = Math.ceil(field.origin[0] * f); gx <= (field.origin[0] + field.cols * field.cell) * f; gx++) {
    const [x] = toPx(gx, 0);
    for (let y = 0; y < h; y += 2) {
      const c = px[y * w + Math.round(x)];
      if (c) put(x, y, mix(c, INK, 0.25));
    }
  }
  for (let gz = Math.ceil(field.origin[1] * f); gz <= (field.origin[1] + field.rows * field.cell) * f; gz++) {
    const [, y] = toPx(0, gz);
    for (let x = 0; x < w; x += 2) {
      const c = px[Math.round(y) * w + x];
      if (c) put(x, y, mix(c, INK, 0.25));
    }
  }
  // source camera
  const [ox, oz] = toPx(0, 0);
  for (let d = 0; d < 9; d++) for (let e = -d; e <= d; e++) put(ox + e, oz + d - 4, INK);
  // figures: ring (mark) / square (spot) + number
  figures.forEach((g, n) => {
    const [x, y] = toPx(g.x, g.z);
    for (let a = 0; a < 360; a += 2) {
      const r = 9;
      if (g.kind === 'mark') {
        put(x + r * Math.cos((a * Math.PI) / 180), y + r * Math.sin((a * Math.PI) / 180), INK);
        put(x + (r + 1) * Math.cos((a * Math.PI) / 180), y + (r + 1) * Math.sin((a * Math.PI) / 180), INK);
      }
    }
    if (g.kind === 'spot')
      for (let d = -9; d <= 9; d++) for (const s of [-9, -8, 8, 9]) {
        put(x + d, y + s, INK);
        put(x + s, y + d, INK);
      }
    const glyph = DIGITS[(n + 1) % 10]!;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (glyph[r * 3 + c] === '1') for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) put(x + 13 + c * 2 + a, y - 5 + r * 2 + b, INK);
  });
  return { png: encodePng(w, h, (x, y) => px[y * w + x]!), range };
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
