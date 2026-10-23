// Contact sheets of the full-look presets (shared/look-presets.ts) on one world: the scale harness
// draws the world with two 1.70 m mannequins on the ground field, once ungraded and once per
// preset, graded exactly as the laptop grades it (ScaleShot.look → SceneLook + LookPost), in GPU
// Chromium (calibrate-render.ts, the k500 tier the viewer shows by default).
//
//   pnpm tsx scripts/genre-looks.ts <worldDir> --name city-street-night [--title "City street, night"]
//     [--out docs/images] [--panels <dir>] [--only candlelit,moonlit] [--luts]
//     [--cam "x,y,z,yawDeg,pitchDeg,hfovDeg"] [--marks "x,z;x,z"] [--size 512x288]
//   pnpm tsx scripts/genre-looks.ts --check     (no browser: the preset table's rules, below)
//
// Writes <out>/genre-presets-<name>.png (with --luts: <out>/genre-luts-<name>.png, every LUT at
// full strength instead) and prints per panel: mean luma, share of pixels crushed to black / blown
// to white, mean saturation, colour cast (R − B, G − (R + B) / 2), the mannequins' skin colour
// (hue°, saturation, luma) and the nearest other panel (mean abs difference). --panels keeps each
// panel as its own PNG. Read-only on the world dir; a directory with only world.spz is read as a
// MOCK set (server/pipeline/marble.ts mockWorld).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { feetY } from '../shared/ground.ts';
import { defaultLook, Look } from '../shared/look.ts';
import {
  LOOK_PRESET_GROUPS,
  LOOK_PRESET_LABELS,
  LOOK_PRESETS,
  presetLook,
  type LookMood,
} from '../shared/look-presets.ts';
import { LookPresetName, LutPreset, WorldAsset } from '../shared/schema.ts';
import {
  applyLut,
  gradeParams,
  gradePixel,
  hexToRgb,
  luma,
  LUT_PRESETS,
  type Vec3,
} from '../web/src/viewer/look/grade.ts';
import { storedGroundField } from '../server/pipeline/calibrate-ground.ts';
import { openWorldRenderer } from '../server/pipeline/calibrate-render.ts';
import { calibrationFactor, floorOffset } from '../web/src/viewer/transform.ts';
import type { ScaleFigure, ScaleShot } from '../web/src/viewer/dev/scale-shot.ts';
import { decodePng } from '../tests/e2e/helpers.ts';

type Img = { width: number; height: number; rgba: Uint8Array };

function args(argv: string[]) {
  const pos: string[] = [];
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      o[a.slice(2)] = next === undefined || next.startsWith('--') ? '1' : argv[++i]!;
    } else pos.push(a);
  }
  return { pos, o };
}

const LUT_LABELS: Record<LutPreset, string> = {
  neutral: 'Neutral',
  'teal-orange': 'Teal & orange',
  noir: 'Noir',
  kodak: 'Kodak print',
  bleach: 'Bleach bypass',
  'cool-night': 'Cool night',
  golden: 'Golden hour',
  sepia: 'Sepia print',
  verdant: 'Verdant',
  cyber: 'Cyber neon',
  ice: 'Ice',
  ember: 'Ember',
};

// ---- pixel metrics -------------------------------------------------------------------------------

interface Metrics {
  luma: number;
  black: number;
  white: number;
  sat: number;
  rb: number;
  g: number;
  skin: { hue: number; sat: number; luma: number } | null;
}

const lumaOf = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function hsv(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max > 1e-6 ? d / max : 0, v: max };
}

function metrics(img: Img, skinMask: Uint8Array | null): Metrics {
  const n = img.width * img.height;
  let L = 0,
    black = 0,
    white = 0,
    sat = 0,
    rb = 0,
    gg = 0;
  let sr = 0,
    sg = 0,
    sb = 0,
    sn = 0;
  for (let i = 0; i < n; i++) {
    const r = img.rgba[i * 4]! / 255;
    const g = img.rgba[i * 4 + 1]! / 255;
    const b = img.rgba[i * 4 + 2]! / 255;
    L += lumaOf(r, g, b);
    if (Math.max(r, g, b) <= 4 / 255) black++;
    if (Math.min(r, g, b) >= 251 / 255) white++;
    sat += Math.max(r, g, b) - Math.min(r, g, b);
    rb += r - b;
    gg += g - (r + b) / 2;
    if (skinMask?.[i]) {
      sr += r;
      sg += g;
      sb += b;
      sn++;
    }
  }
  let skin: Metrics['skin'] = null;
  if (sn > 0) {
    const c = [sr / sn, sg / sn, sb / sn] as const;
    const x = hsv(...c);
    skin = { hue: x.h > 180 ? x.h - 360 : x.h, sat: x.s, luma: lumaOf(...c) };
  }
  return {
    luma: L / n,
    black: black / n,
    white: white / n,
    sat: sat / n,
    rb: rb / n,
    g: gg / n,
    skin,
  };
}

function meanAbs(a: Img, b: Img): number {
  let s = 0;
  for (let i = 0; i < a.rgba.length; i += 4)
    for (let c = 0; c < 3; c++) s += Math.abs(a.rgba[i + c]! - b.rgba[i + c]!);
  return s / ((a.rgba.length / 4) * 3 * 255);
}

/** The mannequins' skin: pixels that change when the figures are added and look like skin there. */
function skinMaskOf(withFigs: Img, without: Img): Uint8Array {
  const n = withFigs.width * withFigs.height;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d += Math.abs(withFigs.rgba[i * 4 + c]! - without.rgba[i * 4 + c]!);
    if (d < 30) continue;
    const x = hsv(
      withFigs.rgba[i * 4]! / 255,
      withFigs.rgba[i * 4 + 1]! / 255,
      withFigs.rgba[i * 4 + 2]! / 255,
    );
    // skin (#d9b08c under the harness lights): orange hue, moderate saturation, not in shadow
    if (x.h >= 14 && x.h <= 45 && x.s >= 0.15 && x.s <= 0.6 && x.v >= 0.3) m[i] = 1;
  }
  return m;
}

// ---- --check: the preset table without a browser ------------------------------------------------
// Distinctness in parameter space, skin under every preset but film noir, mid-tone clipping. Exit
// code 1 when a rule fails, so a retune can be checked in a second before rendering the sheets.

/**
 * A preset as a point in parameter space, each axis scaled to about one visible step: 0.25 stop,
 * 0.1 contrast, 0.15 saturation / temperature, 0.1 tint, 0.2 for the tone and film amounts; the
 * LUT as its effect at the preset's strength on a few greys and colours (0.05 per channel);
 * atmosphere as density / strength and the colour they push toward.
 */
function presetVector(m: LookMood): number[] {
  const v = [
    m.exposure / 0.25,
    (m.contrast - 1) / 0.1,
    (m.saturation - 1) / 0.15,
    m.temperature / 0.15,
    m.tint / 0.1,
    m.shadows / 0.2,
    m.highlights / 0.2,
    m.vignette / 0.2,
    m.grain / 0.2,
    m.bloom / 0.2,
    (1 - m.ambient) / 0.1,
  ];
  const strength = m.lut === 'neutral' ? 0 : m.lutStrength;
  const samples: Vec3[] = [
    [0.15, 0.15, 0.15],
    [0.5, 0.5, 0.5],
    [0.85, 0.85, 0.85],
    [0.8, 0.55, 0.4],
    [0.2, 0.3, 0.6],
    [0.1, 0.6, 0.2],
  ];
  for (const c of samples) {
    const out = applyLut(c, LUT_PRESETS[m.lut]);
    for (let i = 0; i < 3; i++) v.push(((out[i]! - c[i]!) * strength) / 0.05);
  }
  const fog = hexToRgb(m.fog.color);
  const sky = hexToRgb(m.skyTint.color);
  v.push(m.fog.density / 0.1, m.skyTint.strength / 0.2);
  for (let i = 0; i < 3; i++)
    v.push((fog[i]! * m.fog.density) / 0.05, ((sky[i]! - 1) * m.skyTint.strength) / 0.1);
  return v;
}

/**
 * The nearest two presets must stay this far apart. The first draft's near-twins (daylight
 * neutral / warm interior 3.32, night street / moonlit 3.47) rendered within 2–4 % of each other
 * on the real worlds; at ≥ 3.5 every pair is ≥ 3.5 % mean abs apart on all five test worlds.
 */
const MIN_PRESET_DISTANCE = 3.5;
const SKIN_TONES: Record<string, string> = {
  light: '#e3bfa3',
  medium: '#c68e6a',
  deep: '#8d5a3c',
  mannequin: '#d9b08c',
};

function check(): boolean {
  const names = LookPresetName.options;
  let ok = true;
  // distinctness
  const vs = names.map((n) => presetVector(LOOK_PRESETS[n]));
  const pairs: { d: number; pair: string }[] = [];
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++)
      pairs.push({
        d: Math.hypot(...vs[i]!.map((x, k) => x - vs[j]![k]!)),
        pair: `${names[i]} / ${names[j]}`,
      });
  pairs.sort((a, b) => a.d - b.d);
  const near = pairs.filter((p) => p.d < MIN_PRESET_DISTANCE);
  console.log(`distinctness (parameter space, min ${MIN_PRESET_DISTANCE}): nearest pairs`);
  for (const p of pairs.slice(0, 6)) console.log(`  ${p.d.toFixed(2)}  ${p.pair}`);
  if (near.length) ok = false;
  // skin: a face may go pink under neon, amber by fire and silver-grey by moonlight, but never
  // blue, green or yellow, never a black hole, a blown-out patch or neon orange
  const bad: string[] = [];
  const rows: Record<string, string>[] = [];
  for (const n of names) {
    const p = gradeParams(presetLook(n));
    const row: Record<string, string> = { preset: n };
    for (const [tone, hex] of Object.entries(SKIN_TONES)) {
      const out = gradePixel(hexToRgb(hex), p);
      const x = hsv(...out);
      const hue = x.h > 180 ? x.h - 360 : x.h;
      const L = luma(out);
      row[tone] = `${hue.toFixed(0)}° s${x.s.toFixed(2)} L${L.toFixed(2)}`;
      const fine = L > 0.15 && L < 0.95 && x.s < 0.9 && (x.s <= 0.12 || (hue >= -25 && hue <= 50));
      if (!fine && n !== 'film-noir') bad.push(`${n} ${tone}: ${row[tone]}`);
    }
    rows.push(row);
  }
  console.log('skin (grade only; film noir exempt):');
  console.table(rows);
  if (bad.length) {
    ok = false;
    console.log(`  implausible skin: ${bad.join('; ')}`);
  }
  // mid tones (grey 0.15–0.80) never crushed to black or blown to white by the grade
  const clipped: string[] = [];
  for (const n of names) {
    const p = gradeParams(presetLook(n));
    for (let v = 0.15; v <= 0.801; v += 0.05) {
      const out = gradePixel([v, v, v], p);
      if (Math.max(...out) <= 3 / 255 || Math.min(...out) >= 252 / 255)
        clipped.push(`${n} grey ${v.toFixed(2)}`);
    }
  }
  if (clipped.length) {
    ok = false;
    console.log(`  clipped mid tones: ${clipped.join(', ')}`);
  }
  console.log(
    `${ok ? 'PASS' : 'FAIL'}: nearest ${pairs[0]!.d.toFixed(2)} (${pairs[0]!.pair}), ` +
      `${bad.length} implausible skin, ${clipped.length} clipped mid tones`,
  );
  return ok;
}

// ---- main ----------------------------------------------------------------------------------------

async function main() {
  const { pos, o } = args(process.argv.slice(2));
  if (o.check) {
    if (!check()) process.exitCode = 1;
    return;
  }
  const dir = pos[0];
  const name = o.name;
  if (!dir || !name)
    throw new Error(
      'usage: genre-looks.ts <worldDir> --name <name> [--title t] [--out dir] [--panels dir] [--only a,b] [--luts] [--cam x,y,z,yaw,pitch,fov] [--marks "x,z;x,z"]',
    );
  const worldDir = resolve(dir);
  const outDir = resolve(o.out ?? 'docs/images');
  // a MOCK set (fixtures/mock-world/…) has only world.spz: describe it as the mock stage does
  const assetJson = await readFile(join(worldDir, 'world-asset.json'), 'utf8').catch(() => null);
  const asset = WorldAsset.parse(
    assetJson
      ? JSON.parse(assetJson)
      : {
          provider: 'mock',
          spz: { k500: 'world.spz' },
          metricScaleFactor: 1,
          groundPlaneOffset: 0,
          opencvFrame: true,
        },
  );
  const f = calibrationFactor(asset);
  const off = floorOffset(asset);
  const frame = { factor: f, floorOffset: off };
  const field = await storedGroundField(worldDir, asset);
  const [W, H] = (o.size ?? '512x288').split('x').map(Number) as [number, number];

  // marks: explicit, else the scene's blocking (a project world), else two spots in front of the
  // source camera where the floor probes stand (a library world)
  let marks: [number, number][] = [
    [-0.8, -3],
    [0.75, -3.4],
  ];
  if (o.marks) marks = o.marks.split(';').map((p) => p.split(',').map(Number) as [number, number]);
  else {
    const m = JSON.parse(
      await readFile(join(dirname(worldDir), 'manifest.json'), 'utf8').catch(() => 'null'),
    ) as {
      world?: { worldId?: string };
      plan?: { blocking?: { position: number[] }[] };
    } | null;
    if (m && asset.worldId && m.world?.worldId === asset.worldId && m.plan?.blocking?.length)
      marks = m.plan.blocking.slice(0, 3).map((b) => [b.position[0]!, b.position[2]!]);
  }
  // harness frame = viewer frame without the floor raise (see scripts/ground-evidence.ts)
  const lift = f * off;
  const tints = ['#3d6fb0', '#4f7a5a', '#7a5a9a'];
  const cam = (o.cam ?? '0,1.6,0,0,-7,70').split(',').map(Number);
  const figures: ScaleFigure[] = marks.map(([x, z], i) => ({
    x,
    z,
    y: feetY(field, frame, x / f, z / f) - lift,
    label: ' ',
    tint: tints[i % tints.length],
    // facing the camera, turned a little, so faces and hands (the skin) are in view
    yaw: Math.atan2(x - cam[0]!, z - cam[2]!) + (i % 2 ? -0.35 : 0.35),
  }));
  const camera: ScaleShot['camera'] = {
    position: [cam[0]!, cam[1]! - lift, cam[2]!],
    yawDeg: cam[3]!,
    pitchDeg: cam[4]!,
    fovDeg: cam[5]!,
  };
  const shotOf = (look: Look | undefined, figs = figures): ScaleShot => ({
    factor: f,
    camera,
    figures: figs,
    width: W,
    height: H,
    look,
  });

  const only = o.only ? new Set(o.only.split(',')) : null;
  type Panel = { key: string; title: string; subtitle: string; look: Look };
  const panels: Panel[] = [];
  if (o.luts) {
    for (const lut of LutPreset.options) {
      if (lut === 'neutral' || (only && !only.has(lut))) continue;
      panels.push({
        key: lut,
        title: LUT_LABELS[lut],
        subtitle: `LUT ${lut} at 100 %`,
        look: { ...defaultLook(), name: lut, lut, lutStrength: 1 },
      });
    }
  } else {
    for (const g of LOOK_PRESET_GROUPS)
      for (const p of g.presets) {
        if (only && !only.has(p)) continue;
        panels.push({
          key: p,
          title: LOOK_PRESET_LABELS[p],
          subtitle: g.label,
          look: presetLook(p),
        });
      }
  }

  const renderer = await openWorldRenderer(worldDir, asset, {
    quality: 'k500',
    log: (m) => console.log(m),
  });
  try {
    const raw = await renderer.shot(shotOf(undefined));
    const rawImg = decodePng(raw);
    const bare = decodePng(await renderer.shot(shotOf(undefined, [])));
    const skin = skinMaskOf(rawImg, bare);
    console.log(`skin mask: ${skin.reduce((s, v) => s + v, 0)} px`);
    const shots: { p: Panel | null; png: Buffer; img: Img; m: Metrics }[] = [
      { p: null, png: raw, img: rawImg, m: metrics(rawImg, skin) },
    ];
    if (o.panels) await mkdir(resolve(o.panels), { recursive: true });
    for (const p of panels) {
      const png = await renderer.shot(shotOf(p.look));
      const img = decodePng(png);
      shots.push({ p, png, img, m: metrics(img, skin) });
      if (o.panels) await writeFile(join(resolve(o.panels), `${name}-${p.key}.png`), png);
    }
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const rows = shots.map((s, i) => {
      let nearest = { key: '', d: Infinity };
      for (let j = 1; j < shots.length; j++) {
        if (j === i || i === 0) continue;
        const d = meanAbs(s.img, shots[j]!.img);
        if (d < nearest.d) nearest = { key: shots[j]!.p!.key, d };
      }
      const sk = s.m.skin;
      return {
        panel: s.p?.key ?? 'ungraded',
        luma: s.m.luma.toFixed(3),
        black: pct(s.m.black),
        white: pct(s.m.white),
        sat: s.m.sat.toFixed(3),
        'R-B': s.m.rb.toFixed(3),
        'G-RB': s.m.g.toFixed(3),
        skin: sk ? `${sk.hue.toFixed(0)}° s${sk.sat.toFixed(2)} L${sk.luma.toFixed(2)}` : '—',
        Δraw: i ? pct(meanAbs(s.img, rawImg)) : '',
        nearest: i ? `${nearest.key} ${pct(nearest.d)}` : '',
      };
    });
    console.table(rows);
    if (o.panels)
      await writeFile(
        join(resolve(o.panels), `${name}-metrics.json`),
        JSON.stringify(rows, null, 2),
      );

    const title = o.title ?? name;
    const sheet = await renderer.compose(
      shots.map((s) => ({
        image: s.png,
        title: s.p ? s.p.title : 'Ungraded',
        subtitle: s.p ? s.p.subtitle : 'the world as captured',
      })),
      [
        o.luts
          ? `Every LUT at 100 % on ${title} (web/src/viewer/look/grade.ts LUT_PRESETS), nothing else graded.`
          : `Every full-look preset on ${title} (shared/look-presets.ts), graded as the laptop grades it: splat fog / sky tint and mesh fog (SceneLook), then the post pass (grade, LUT, vignette, grain, bloom).`,
        `Same camera and frozen pose in every panel; two 1.70 m mannequins on the ground field; Marble k500 splats in GPU Chromium (Metal).`,
      ],
      { columns: o.luts ? 4 : 5, heading: o.luts ? `LUTs · ${title}` : `Genre looks · ${title}` },
    );
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, `${o.luts ? 'genre-luts' : 'genre-presets'}-${name}.png`);
    await writeFile(file, sheet);
    console.log(`wrote ${file}`);
  } finally {
    await renderer.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
