// Builds fixtures/models/index.json.gz, the local index of open-licence models the found-model
// resolver searches (server/pipeline/models.ts; docs/PLAN-v4.md "Found models"). Run once; the
// result is committed. Hugging Face downloads only (dataset allenai/objaverse, no key):
//
//   object-paths.json.gz      uid → glb path in the dataset ("glbs/000-023/<uid>.glb")
//   lvis-annotations.json.gz  ~1,150 curated noun categories → uids
//   metadata/000-NNN.json.gz  160 shards (~580 MB): per object name, tags, categories, licence,
//                             animationCount, faceCount, archives.glb.size, thumbnails, user, likes
//
//   pnpm tsx scripts/build-model-index.ts [--cache data/objaverse-cache] [--out fixtures/models/index.json.gz]
//                                         [--keep 80] [--keep-animated 80]
//
// Kept: licence CC0 / CC-BY / CC-BY-SA (never NC / ND), not age-restricted, 0 < faces ≤ 150k,
// glb ≤ 15 MB, at least one thumbnail, a glb path; and then, per noun family of model-vocab.ts,
// the best `--keep` objects plus the best `--keep-animated` animated ones (scored by the
// resolver's own scoreEntry), together with every LVIS-curated object that passes the filters.
// The cache directory keeps the downloads, so a rebuild with new vocabulary takes ~1 minute.
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  FAMILY_TERMS,
  MOTION_HINTS,
  lvisTokens,
  needsClips,
  tokens,
} from '../server/pipeline/model-vocab.ts';
import {
  MAX_MODEL_BYTES,
  MAX_MODEL_FACES,
  MODEL_INDEX_FILE,
  familiesIn,
  indexFrom,
  prepareEntry,
  scoreEntry,
  type IndexEntry,
  type IndexLicense,
  type ModelIndexFile,
} from '../server/pipeline/models.ts';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const HF = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/';
const HF_TREE = 'https://huggingface.co/api/datasets/allenai/objaverse/tree/main/metadata';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const CACHE = resolve(arg('cache', join(REPO, 'data', 'objaverse-cache')));
const OUT = resolve(arg('out', MODEL_INDEX_FILE));
const KEEP = Number(arg('keep', '80'));
const KEEP_ANIMATED = Number(arg('keep-animated', '80'));
const MAX_OUT_BYTES = 8 * 1024 * 1024;

const LICENSE: Record<string, IndexLicense> = { by: 'by', 'by-sa': 'by-sa', cc0: 'cc0' };

/** Tags that say nothing about what the object is. */
// prettier-ignore
const TAG_NOISE = new Set([
  'lowpoly', 'low-poly', 'low poly', 'blender', 'blender3d', '3d', '3dmodel', '3d-model', 'free', 'freemodel',
  'game-ready', 'gameready', 'game', 'gameasset', 'game-asset', 'pbr', 'substance', 'substancepainter',
  'substance-painter', 'maya', '3dsmax', '3ds-max', 'cinema4d', 'c4d', 'zbrush', 'unity', 'unity3d', 'unreal',
  'unrealengine', 'fbx', 'obj', 'model', 'models', 'sketchfab', 'textured', 'asset', 'assets', 'photogrammetry',
  'scan', 'realistic', 'stylized', 'cartoon', 'handpainted', 'hand-painted', 'download', 'free-download',
  'freedownload', 'art', 'design', 'render', 'cgi', 'cg', 'modeling', 'modelling', 'sculpt', 'b3d', 'gltf', 'glb',
  'vr', 'ar', 'virtual-reality', 'noai', 'no-ai', 'ai', 'texture', 'textures', 'lowpolyart', 'polygon',
  'gamedev', 'indie', 'indiegame', 'gamedevelopment', 'mobile', 'cc0', 'cc-by', 'creative-commons',
]);

async function download(url: string, to: string): Promise<void> {
  if (
    await stat(to).then(
      (s) => s.size > 0,
      () => false,
    )
  )
    return;
  await mkdir(dirname(to), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(`${to}.part`, buf);
      await rename(`${to}.part`, to);
      return;
    } catch (e) {
      await rm(`${to}.part`, { force: true });
      if (attempt >= 3) throw new Error(`${url}: ${(e as Error).message}`);
    }
  }
}

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!, i);
      }
    }),
  );
}

const readGz = async <T>(file: string) =>
  JSON.parse(gunzipSync(await readFile(file)).toString('utf8')) as T;

interface RawObject {
  uid: string;
  name?: string;
  license?: string;
  isAgeRestricted?: boolean;
  animationCount?: number;
  faceCount?: number;
  likeCount?: number;
  tags?: { name?: string }[];
  thumbnails?: { images?: unknown[] };
  archives?: { glb?: { size?: number; faceCount?: number } };
  user?: { displayName?: string; username?: string };
}

async function main() {
  const t0 = Date.now();
  console.log(`cache ${CACHE}`);
  await download(`${HF}object-paths.json.gz`, join(CACHE, 'object-paths.json.gz'));
  await download(`${HF}lvis-annotations.json.gz`, join(CACHE, 'lvis-annotations.json.gz'));
  const tree = (await (await fetch(HF_TREE)).json()) as { path: string; type: string }[];
  const shards = tree
    .filter((t) => t.type === 'file' && /^metadata\/\d{3}-\d{3}\.json\.gz$/.test(t.path))
    .map((t) => t.path)
    .sort();
  if (shards.length < 100) throw new Error(`only ${shards.length} metadata shards listed`);
  let got = 0;
  await pool(shards, 8, async (p) => {
    await download(HF + p, join(CACHE, p));
    if (++got % 20 === 0) console.log(`  ${got}/${shards.length} metadata shards`);
  });
  console.log(`downloads ready in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  const paths = await readGz<Record<string, string>>(join(CACHE, 'object-paths.json.gz'));
  const lvisCats = await readGz<Record<string, string[]>>(join(CACHE, 'lvis-annotations.json.gz'));
  const lvisOf = new Map<string, string>();
  for (const [cat, uids] of Object.entries(lvisCats))
    for (const u of uids) if (!lvisOf.has(u)) lvisOf.set(u, cat);
  // LVIS categories of the families (their objects are kept whatever their names say)
  const familyLvis = new Set(FAMILY_TERMS.flatMap((t) => t.family.lvis ?? []));
  // every tag word the vocabulary knows, to keep the informative tags first
  const known = new Set<string>([...FAMILY_TERMS.flatMap((t) => t.meta.flat()), ...MOTION_HINTS]);
  for (const cat of Object.keys(lvisCats)) for (const w of lvisTokens(cat)) known.add(w);

  const entries: IndexEntry[] = [];
  const lvisKeep = new Set<number>();
  const perFamily = new Map<string, number[]>();
  let seen = 0;
  let passed = 0;
  for (const [k, shard] of shards.entries()) {
    const objs = await readGz<Record<string, RawObject>>(join(CACHE, shard));
    for (const o of Object.values(objs)) {
      seen++;
      const license = LICENSE[o.license ?? ''];
      const path = paths[o.uid];
      const bytes = o.archives?.glb?.size ?? 0;
      const faces = o.archives?.glb?.faceCount ?? o.faceCount ?? 0;
      if (!license || !path || o.isAgeRestricted) continue;
      if (!(bytes > 0 && bytes <= MAX_MODEL_BYTES) || !(faces > 0 && faces <= MAX_MODEL_FACES))
        continue;
      if (!o.thumbnails?.images?.length) continue;
      passed++;
      const name = (o.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name) continue;
      const lvis = lvisOf.get(o.uid);
      const rawTags = (o.tags ?? [])
        .map((t) => (t.name ?? '').toLowerCase().trim())
        .filter((t) => t && t.length <= 24 && !TAG_NOISE.has(t));
      const nameToks = tokens(name);
      const fams = familiesIn(nameToks);
      for (const t of rawTags) for (const id of familiesIn(tokens(t))) fams.add(id);
      if (!fams.size && !lvis) continue;
      const tags = [
        ...rawTags.filter((t) => tokens(t).some((w) => known.has(w))),
        ...rawTags.filter((t) => !tokens(t).some((w) => known.has(w))),
      ]
        .filter((t, i, all) => all.indexOf(t) === i)
        .slice(0, 6);
      const author = (o.user?.displayName || o.user?.username || '').trim().slice(0, 40);
      const e: IndexEntry = {
        uid: o.uid,
        name,
        tags,
        license,
        anim: o.animationCount ?? 0,
        faces,
        bytes,
        path,
        ...(author ? { author } : {}),
        ...(o.likeCount ? { likes: o.likeCount } : {}),
        ...(lvis ? { lvis } : {}),
      };
      const i = entries.push(e) - 1;
      if (lvis) lvisKeep.add(i);
      for (const id of fams) (perFamily.get(id) ?? perFamily.set(id, []).get(id)!).push(i);
      if (lvis && familyLvis.has(lvis))
        for (const t of FAMILY_TERMS)
          if (t.family.lvis?.includes(lvis))
            (perFamily.get(t.family.id) ?? perFamily.set(t.family.id, []).get(t.family.id)!).push(
              i,
            );
    }
    if ((k + 1) % 20 === 0)
      console.log(
        `  read ${k + 1}/${shards.length} shards: ${entries.length} candidates of ${seen}`,
      );
  }
  console.log(
    `${seen} objects, ${passed} pass the licence / size / thumbnail filters, ${entries.length} name a family or are LVIS`,
  );

  // per family: the best KEEP, plus the best KEEP_ANIMATED animated ones
  const keep = new Set<number>(lvisKeep);
  const report: string[] = [];
  for (const t of FAMILY_TERMS) {
    const ids = [...new Set(perFamily.get(t.family.id) ?? [])];
    const q = { family: t.family, extras: [], labelFamilies: new Set<string>(), needsClips: false };
    const scored = ids
      .map((i) => ({ i, s: scoreEntry(prepareEntry(entries[i]!), q), a: entries[i]!.anim > 0 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    const best = scored.slice(0, KEEP);
    const anim = scored.filter((x) => x.a).slice(0, KEEP_ANIMATED);
    for (const x of [...best, ...anim]) keep.add(x.i);
    report.push(`${t.family.id}: ${scored.length} (${scored.filter((x) => x.a).length} animated)`);
  }
  const kept = [...keep].sort((a, b) => a - b).map((i) => entries[i]!);
  kept.sort((a, b) => a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
  const data: ModelIndexFile = {
    version: 1,
    source:
      'Objaverse 1.0 (huggingface.co/datasets/allenai/objaverse): Sketchfab objects with their licences',
    builtAt: new Date().toISOString(),
    filters: {
      licenses: ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0'],
      maxFaces: MAX_MODEL_FACES,
      maxGlbBytes: MAX_MODEL_BYTES,
      thumbnail: true,
      perFamily: KEEP,
      perFamilyAnimated: KEEP_ANIMATED,
      lvis: 'every curated LVIS object that passes',
    },
    entries: kept,
  };
  const gz = gzipSync(JSON.stringify(data), { level: 9 });
  if (gz.byteLength > MAX_OUT_BYTES)
    throw new Error(`index is ${(gz.byteLength / 1e6).toFixed(1)} MB (> 8 MB); lower --keep`);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(`${OUT}.part`, gz);
  await rename(`${OUT}.part`, OUT);
  // the resolver's own view of the result: per family, how many it can choose from
  const index = indexFrom(data);
  const summary = FAMILY_TERMS.map((t) => {
    const list = index.byFamily.get(t.family.id) ?? [];
    const anim = list.filter((i) => index.entries[i]!.e.anim > 0).length;
    return `${t.family.id} ${list.length}${needsClips(t.family.group) ? `/${anim}a` : ''}`;
  });
  console.log(
    `\nper family (candidates in the index / animated for creatures and people):\n${summary.join(' · ')}`,
  );
  console.log(
    `\nwrote ${OUT}: ${kept.length} entries, ${(gz.byteLength / 1e6).toFixed(2)} MB gzipped, in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
  );
  if (process.argv.includes('--verbose')) console.log(report.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
