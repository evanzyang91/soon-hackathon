// Found models (docs/PLAN-v4.md "Found models"): during generation each piece of background action
// keeps its procedural kind and may gain a real model from a local index of open-licence Objaverse
// objects, attached as `DynamicElement.model` (the viewer draws it, or falls back to the body).
//
//   index     fixtures/models/index.json.gz (scripts/build-model-index.ts): ~50k Objaverse objects
//             under CC0 / CC-BY / CC-BY-SA, ≤ 150k faces, glb ≤ 15 MB, with a thumbnail, kept for
//             the noun families of model-vocab.ts and the LVIS categories. Loaded once, in memory.
//   find      findModel(label, kind): the family the label names (the first one, its head noun:
//             "a red sports car" → sports car, "a giant panda" → bear), else the kind's own family;
//             candidates scored on name / tags / LVIS category against the family's synonyms, the
//             label's other words (red, police), clips, likes and size. Creature-like kinds and
//             families (creature, dog, horse, bird, dragon, pedestrian; animals, monsters, people)
//             REQUIRE clips (animationCount ≥ 1, and the downloaded glb must carry animations): a
//             creature without them is never attached, the procedural body wins. Vehicles, aircraft,
//             boats and props accept static meshes. Local: a few milliseconds.
//   fetch     fetchModel(candidate): https://huggingface.co/datasets/allenai/objaverse/resolve/main/<path>
//             → <MODELS_LIBRARY_DIR = data/models-library>/<uid>/model.glb + model.json (name,
//             author, licence, attribution, source url, clips, faces, bytes, fetchedAt). Atomic
//             writes, 15 MB cap enforced while streaming, 15 s timeout, at most 2 downloads at once,
//             one download per uid; a library hit needs no network. Served at /models/<uid>/model.glb.
//   attach    FoundModels.start(dynamics) begins the lookups when a scene is scheduled (alongside
//             world / actors / tts); FoundModels.attach(dynamics) in the manifest step joins them
//             with a budget of 20 s from their start: whatever arrived is attached, late or failed =
//             no model (one log line per scene). A late download still lands in the library, so the
//             next manifest rewrite (a chat change, a retry) picks it up from disk.
//
// FOUND_MODELS=0 disables it; MOCK skips it unless FOUND_MODELS=1 (the offline e2e stays offline).
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { DynamicElement, PropModel } from '../../shared/schema.ts';
import { MOTION_RE, STAND_RE } from './dynamics.ts';
import { exists, readJson, writeFileAtomic, writeJsonAtomic } from './fsutil.ts';
import { parseGlb } from './glb.ts';
import {
  FAMILY_BY_ID,
  FAMILY_TERMS,
  GROUP_NEGATIVE,
  MOTION_HINTS,
  SIZE_WORDS,
  NAME_NOISE,
  NEGATIVE_WORDS,
  TERMS_BY_ID,
  lineage,
  needsClips,
  phraseAt,
  relatives,
  tokens,
  type FamilyTerms,
  type ModelFamily,
  type ModelGroup,
} from './model-vocab.ts';

type Kind = DynamicElement['kind'];

export const MODEL_INDEX_FILE = fileURLToPath(
  new URL('../../fixtures/models/index.json.gz', import.meta.url),
);
export const OBJAVERSE_BASE = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/';
export const MAX_MODEL_BYTES = 15 * 1024 * 1024;
export const MAX_MODEL_FACES = 150_000;
export const DOWNLOAD_TIMEOUT_MS = 15_000;
export const SCENE_BUDGET_MS = 20_000;
export const MAX_DOWNLOADS = 2;
/** Below this a candidate is not a match (a name or LVIS hit is worth 8-13 on its own). */
export const MIN_SCORE = 8;

const UID_RE = /^[0-9a-f]{32}$/;
const GLB_PATH_RE = /^glbs\/\d{3}-\d{3}\/[0-9a-f]{32}\.glb$/;
export const isModelId = (id: string) => UID_RE.test(id);
/** The served URL of a library model (server/index.ts serves /models/<uid>/model.glb | model.json). */
export const modelUrl = (uid: string) => `/models/${uid}/model.glb`;

// ---- the index ---------------------------------------------------------------------------------

/** Sketchfab licence slugs kept in the index (never NC / ND). */
export type IndexLicense = 'by' | 'by-sa' | 'cc0';
export const LICENSES: Record<IndexLicense, { id: string; label: string }> = {
  by: { id: 'CC-BY-4.0', label: 'CC BY 4.0' },
  'by-sa': { id: 'CC-BY-SA-4.0', label: 'CC BY-SA 4.0' },
  cc0: { id: 'CC0-1.0', label: 'CC0 1.0' },
};

/** One object of fixtures/models/index.json.gz. */
export interface IndexEntry {
  uid: string;
  /** ≤ 60 chars */
  name: string;
  /** a few informative Sketchfab tags */
  tags: string[];
  license: IndexLicense;
  /** Sketchfab animationCount */
  anim: number;
  faces: number;
  /** archives.glb.size */
  bytes: number;
  /** glb path inside the dataset ("glbs/000-023/<uid>.glb") */
  path: string;
  author?: string;
  likes?: number;
  /** LVIS category when the object is a curated LVIS member */
  lvis?: string;
}

export interface ModelIndexFile {
  version: 1;
  source: string;
  builtAt: string;
  filters: Record<string, unknown>;
  entries: IndexEntry[];
}

/** An index entry with its words tokenised once. */
export interface PreparedEntry {
  e: IndexEntry;
  name: string[];
  tags: string[][];
  /** index of the name's head noun (its last token that is not noise), -1 when none */
  head: number;
  /** families whose label words appear in the name (for conflicts) */
  nameFamilies: Set<string>;
}

/** Families whose words (label + also) appear in `toks`, by first token. */
const FIRST_TOKEN = new Map<string, { terms: FamilyTerms; phrase: string[]; label: boolean }[]>();
for (const terms of FAMILY_TERMS) {
  const seen = new Set<string>();
  for (const phrase of terms.meta) {
    const key = phrase.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const list = FIRST_TOKEN.get(phrase[0]!) ?? [];
    list.push({ terms, phrase, label: terms.label.some((l) => l.join(' ') === key) });
    FIRST_TOKEN.set(phrase[0]!, list);
  }
}

/** Every family whose words occur in `toks` (`labelOnly`: its label words only). */
export function familiesIn(toks: readonly string[], labelOnly = false): Set<string> {
  const out = new Set<string>();
  toks.forEach((t, i) => {
    for (const c of FIRST_TOKEN.get(t) ?? []) {
      if (labelOnly && !c.label) continue;
      if (phraseAt(toks, c.phrase, i) === i) out.add(c.terms.family.id);
    }
  });
  return out;
}

export function prepareEntry(e: IndexEntry): PreparedEntry {
  const name = tokens(e.name);
  let head = -1;
  for (let i = name.length - 1; i >= 0; i--) {
    const t = name[i]!;
    if (!NAME_NOISE.has(t) && !/^\d+$/.test(t)) {
      head = i;
      break;
    }
  }
  return { e, name, tags: e.tags.map(tokens), head, nameFamilies: familiesIn(name, true) };
}

export interface LoadedIndex {
  file: string;
  builtAt: string;
  entries: PreparedEntry[];
  /** family id → entries whose name / tags / LVIS category match it */
  byFamily: Map<string, number[]>;
  /** name token → entries (the generic fallback) */
  byToken: Map<string, number[]>;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

/** Builds the lookup tables of an index (the builder uses it on its own output, too). */
export function indexFrom(data: ModelIndexFile, file = ''): LoadedIndex {
  const entries = data.entries.map(prepareEntry);
  const byFamily = new Map<string, number[]>();
  const byToken = new Map<string, number[]>();
  const lvisFamilies = new Map<string, string[]>();
  for (const t of FAMILY_TERMS)
    for (const c of t.family.lvis ?? []) push(lvisFamilies, c, t.family.id);
  entries.forEach((p, i) => {
    const fams = familiesIn(p.name);
    for (const tag of p.tags) for (const id of familiesIn(tag)) fams.add(id);
    for (const id of p.e.lvis ? (lvisFamilies.get(p.e.lvis) ?? []) : []) fams.add(id);
    for (const id of fams) push(byFamily, id, i);
    for (const t of new Set(p.name)) push(byToken, t, i);
  });
  return { file, builtAt: data.builtAt, entries, byFamily, byToken };
}

const loaded = new Map<string, Promise<LoadedIndex>>();

/** The index at `file` (default fixtures/models/index.json.gz), read and prepared once per process. */
export function loadModelIndex(file = MODEL_INDEX_FILE): Promise<LoadedIndex> {
  let p = loaded.get(file);
  if (!p) {
    p = (async () => {
      const data = JSON.parse(gunzipSync(await readFile(file)).toString('utf8')) as ModelIndexFile;
      if (data.version !== 1 || !Array.isArray(data.entries))
        throw new Error(`${file}: not a model index`);
      return indexFrom(data, file);
    })();
    p.catch(() => loaded.delete(file));
    loaded.set(file, p);
  }
  return p;
}

// ---- what a label asks for ---------------------------------------------------------------------

/** The kinds whose procedural body walks: a found model must bring clips to replace it. */
const CREATURE_KINDS = new Set<Kind>(['creature', 'dog', 'horse', 'bird', 'dragon', 'pedestrian']);
const ALL_GROUPS: ModelGroup[] = ['creature', 'person', 'vehicle', 'aircraft', 'boat', 'prop'];
const KIND_GROUPS: Record<Kind, ModelGroup[]> = {
  car: ['vehicle'],
  bus: ['vehicle'],
  truck: ['vehicle'],
  motorcycle: ['vehicle'],
  bicycle: ['vehicle'],
  wagon: ['vehicle'],
  pedestrian: ['person'],
  bird: ['creature'],
  dog: ['creature'],
  horse: ['creature'],
  dragon: ['creature'],
  creature: ['creature', 'person'],
  boat: ['boat'],
  airplane: ['aircraft'],
  helicopter: ['aircraft'],
  drone: ['aircraft'],
  spacecraft: ['aircraft'],
  generic: ALL_GROUPS,
  model: [],
};
/** The family a kind stands for when its label names none ("a sedan" → car already; "it roars past"). */
const KIND_FAMILY: Partial<Record<Kind, string>> = {
  car: 'car',
  bus: 'bus',
  truck: 'truck',
  motorcycle: 'motorcycle',
  bicycle: 'bicycle',
  wagon: 'wagon',
  pedestrian: 'person',
  bird: 'bird',
  dog: 'dog',
  horse: 'horse',
  dragon: 'dragon',
  boat: 'boat',
  airplane: 'airplane',
  helicopter: 'helicopter',
  drone: 'drone',
  spacecraft: 'spaceship',
};

// the viewer's size words (web/src/viewer/props-more.ts creatureSpec): huge 2×, big 1.3×, small 0.5×
const GIANT_WORDS =
  /\b(huge|giant|gigantic|massive|enormous|colossal|towering|monstrous|titanic|immense|mammoth)\b/i;
const BIG_WORDS = /\b(big|large|great|hulking|bulky)\b/i;
const SMALL_WORDS = /\b(small|little|tiny|baby|young|juvenile|miniature|dwarf|pygmy|cub|cubs)\b/i;
/** Label words that say nothing about which model ("a … drives past the café at dusk"). */
// prettier-ignore
const LABEL_STOP = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'with', 'by', 'to', 'in', 'on', 'at', 'from', 'into', 'onto', 'over',
  'under', 'past', 'across', 'through', 'toward', 'towards', 'around', 'along', 'behind', 'above', 'below',
  'near', 'off', 'up', 'down', 'out', 'away', 'back', 'its', 'it', 'their', 'his', 'her', 'them', 'they',
  'one', 'two', 'three', 'few', 'some', 'several', 'herd', 'pack', 'flock', 'group', 'pair', 'couple',
  'street', 'road', 'sky', 'field', 'overhead', 'low', 'high', 'far', 'distance', 'slowly', 'quickly',
  'fast', 'slow', 'by', 'then', 'again', 'just', 'very', 'huge', 'giant', 'gigantic', 'massive', 'enormous',
  'colossal', 'big', 'large', 'great', 'small', 'little', 'tiny', 'baby', 'young', 'scene', 'camera', 'actor',
  'head', 'town', 'city', 'square', 'park', 'water', 'ground', 'lane', 'way', 'side', 'left', 'right', 'is',
  'are', 'that', 'who', 'which', 'while', 'as', 'like', 'between', 'beyond', 'outside', 'inside', 'here',
  'there', 'now', 'suddenly', 'another', 'other', 'lone', 'single', 'pull', 'go', 'come', 'get', 'take',
  'make', 'sit', 'stand', 'move', 'turn', 'stop', 'start', 'keep', 'look', 'watch', 'wait', 'still', 'once',
]);

/** Size multiplier from the label's words (same as the procedural bodies). */
export function sizeFactor(label: string): number {
  return GIANT_WORDS.test(label)
    ? 2
    : SMALL_WORDS.test(label)
      ? 0.5
      : BIG_WORDS.test(label)
        ? 1.3
        : 1;
}

export interface ModelQuery {
  family: ModelFamily;
  /** the label words that are not the family's (red, police, vintage) */
  extras: string[];
  /** the label's own size words ("huge", "baby"): a model named for them is not penalised */
  sizes?: string[];
  /** families the label names (none of them costs a candidate as a conflict) */
  labelFamilies: Set<string>;
  /** clips required (creature-like kind or family) */
  needsClips: boolean;
  /** standing height the model is scaled to */
  heightM: number;
}

/** Which family a label names for this kind, or null (kind 'model', a creature with no noun). */
export function queryFor(label: string, kind: Kind): ModelQuery | null {
  const groups = KIND_GROUPS[kind];
  if (!groups.length) return null;
  const toks = tokens(label);
  type M = { id: string; at: number; end: number };
  const matches: M[] = [];
  for (const terms of FAMILY_TERMS) {
    if (!groups.includes(terms.family.group)) continue;
    let best: M | undefined;
    for (const phrase of terms.label) {
      const at = phraseAt(toks, phrase);
      if (at < 0) continue;
      const m = { id: terms.family.id, at, end: at + phrase.length };
      if (!best || m.at < best.at || (m.at === best.at && m.end > best.end)) best = m;
    }
    if (best) matches.push(best);
  }
  // a phrase inside a longer one is the longer one ("car" in "police car")
  const kept = matches
    .filter(
      (m) =>
        !matches.some(
          (o) => o !== m && o.at <= m.at && o.end >= m.end && o.end - o.at > m.end - m.at,
        ),
    )
    .sort((a, b) => a.at - b.at || b.end - a.end);
  // the first thing named, at its head noun: "a giant panda" is a panda, "a robot dog" a dog
  let pick = kept[0];
  for (let i = 1; pick && i < kept.length; i++) if (kept[i]!.at === pick.end) pick = kept[i];
  const id = pick?.id ?? KIND_FAMILY[kind];
  const family = id ? FAMILY_BY_ID.get(id) : undefined;
  if (!family) return null;
  const own = new Set(TERMS_BY_ID.get(family.id)!.label.flat());
  const extras = [
    ...new Set(
      toks.filter(
        (t) =>
          t.length >= 3 &&
          !LABEL_STOP.has(t) &&
          !own.has(t) &&
          !/^\d+$/.test(t) &&
          !MOTION_RE.test(t) &&
          !STAND_RE.test(t),
      ),
    ),
  ].slice(0, 6);
  const heightM = Math.min(
    100,
    Math.max(0.05, Math.round(family.heightM * sizeFactor(label) * 100) / 100),
  );
  return {
    family,
    extras,
    sizes: toks.filter((t) => SIZE_WORDS.has(t)),
    labelFamilies: new Set(matches.map((m) => m.id)),
    needsClips: needsClips(family.group) || CREATURE_KINDS.has(kind),
    heightM,
  };
}

// ---- scoring -----------------------------------------------------------------------------------

const hasPhrase = (toks: readonly string[], phrases: readonly string[][]) =>
  phrases.some((p) => phraseAt(toks, p) >= 0);

/**
 * How well an entry fits a family (and the label's other words); ≤ 0 when it does not match at all.
 * name hit 8-10 (+3 at the head noun), LVIS member 8 (3 with a name hit), tag hit 4 (2), minus
 * the family's `not` words (10 each), negative words (8 each: skull, toy, pack, wheel …) and other
 * families named (5 each); plus clips and motion words (creatures), the label's extra words, likes
 * and detail (8k-100k faces is a real model, under 1k a sketch); minus a little per megabyte (a
 * small file arrives sooner), for "low poly", a named character ("Henry the Helicopter") and size
 * words the label does not have ("Baby Dragon" for "a dragon").
 */
export function scoreEntry(
  p: PreparedEntry,
  q: Pick<ModelQuery, 'family' | 'extras' | 'labelFamilies' | 'needsClips' | 'sizes'>,
): number {
  const terms = TERMS_BY_ID.get(q.family.id)!;
  const { e } = p;
  if (q.needsClips && !(e.anim >= 1)) return 0;
  let name = 0;
  for (const phrase of terms.meta) {
    const at = phraseAt(p.name, phrase);
    if (at < 0) continue;
    const s = (phrase === terms.label[0] ? 10 : 8) + (at + phrase.length - 1 === p.head ? 3 : 0);
    name = Math.max(name, s);
  }
  const lvis = !!e.lvis && !!q.family.lvis?.includes(e.lvis);
  const tag = p.tags.some((t) => hasPhrase(t, terms.meta));
  let match = name + (lvis ? (name ? 3 : 8) : 0) + (tag ? (name || lvis ? 2 : 4) : 0);
  if (match <= 0) return 0;
  const own = new Set(terms.meta.flat());
  let minus = 0;
  for (const n of terms.not) if (phraseAt(p.name, n) >= 0) minus += 10;
  const groupNeg = GROUP_NEGATIVE[q.family.group];
  for (const t of new Set(p.name)) {
    if (own.has(t)) continue;
    if (NEGATIVE_WORDS.has(t) || groupNeg?.has(t)) minus += 8;
    else if (SIZE_WORDS.has(t) && !q.sizes?.includes(t)) minus += 2;
  }
  // "Henry the Helicopter", "Tyler The Trex": a named cartoon character
  const the = p.name.indexOf('the');
  if (the >= 1 && !NAME_NOISE.has(p.name[the - 1]!)) minus += 2;
  if (phraseAt(p.name, ['low', 'poly']) >= 0 || p.name.includes('lowpoly') || p.name.includes('lp'))
    minus += 1;
  const related = relatives(q.family.id);
  let conflicts = 0;
  for (const id of p.nameFamilies) if (!related.has(id) && !q.labelFamilies.has(id)) conflicts += 5;
  let plus = 0;
  if (q.needsClips) {
    plus += Math.min(e.anim, 4) * 0.75;
    if (
      p.name.some((t) => MOTION_HINTS.has(t)) ||
      p.tags.some((t) => t.some((w) => MOTION_HINTS.has(w)))
    )
      plus += 2;
  } else if (e.anim >= 1 && q.family.group === 'aircraft') plus += 1; // rotors, propellers
  let extra = 0;
  for (const x of q.extras) {
    if (p.name.includes(x)) extra += 2;
    else if (p.tags.some((t) => t.includes(x))) extra += 1;
  }
  plus += Math.min(extra, 4);
  plus += Math.min(4.5, 1.5 * Math.log10(1 + (e.likes ?? 0)));
  plus -= (2 * e.bytes) / MAX_MODEL_BYTES;
  plus +=
    e.faces < 1000
      ? -3
      : e.faces < 3000
        ? -1.5
        : e.faces < 8000
          ? -0.5
          : e.faces <= 100_000
            ? 1.5
            : 0.5;
  match -= Math.min(minus, 20) + Math.min(conflicts, 10);
  return Math.round((match + plus) * 100) / 100;
}

// ---- find --------------------------------------------------------------------------------------

export interface ModelCandidate {
  uid: string;
  name: string;
  license: IndexLicense;
  author?: string;
  /** Sketchfab animationCount */
  anim: number;
  faces: number;
  bytes: number;
  path: string;
  likes: number;
  score: number;
  /** the family it was found for (may be the asked family's parent) */
  family: string;
}

export interface FindResult {
  /** the best candidate, or null (nothing scores MIN_SCORE, or the label names no family) */
  candidate: ModelCandidate | null;
  /** the best few, best first */
  candidates: ModelCandidate[];
  query: ModelQuery | null;
  ms: number;
}

export interface FindOptions {
  index?: LoadedIndex;
  indexFile?: string;
  /** how many candidates to return (default 5) */
  top?: number;
}

/** The best models in the index for a background-action label of this kind (local, no network). */
export async function findModel(
  label: string,
  kind: Kind,
  opts: FindOptions = {},
): Promise<FindResult> {
  const t0 = performance.now();
  const query = queryFor(label, kind);
  if (!query) return { candidate: null, candidates: [], query, ms: performance.now() - t0 };
  const index = opts.index ?? (await loadModelIndex(opts.indexFile));
  const top = opts.top ?? 5;
  let candidates: ModelCandidate[] = [];
  // the family, then its parents (a t-rex with no animated match takes an animated dinosaur)
  for (const id of lineage(query.family.id)) {
    const family = FAMILY_BY_ID.get(id)!;
    const q = { ...query, family };
    const scored: ModelCandidate[] = [];
    for (const i of index.byFamily.get(id) ?? []) {
      const p = index.entries[i]!;
      const score = scoreEntry(p, q);
      if (score < MIN_SCORE) continue;
      const { e } = p;
      scored.push({
        uid: e.uid,
        name: e.name,
        license: e.license,
        ...(e.author ? { author: e.author } : {}),
        anim: e.anim,
        faces: e.faces,
        bytes: e.bytes,
        path: e.path,
        likes: e.likes ?? 0,
        score,
        family: id,
      });
    }
    if (scored.length) {
      candidates = scored.sort((a, b) => b.score - a.score || a.bytes - b.bytes).slice(0, top);
      break;
    }
  }
  return { candidate: candidates[0] ?? null, candidates, query, ms: performance.now() - t0 };
}

// ---- fetch -------------------------------------------------------------------------------------

/** <library>/<uid>/model.json, written after model.glb (its presence means the glb is complete). */
export interface ModelMeta {
  uid: string;
  name: string;
  author?: string;
  /** SPDX-style id: CC-BY-4.0 | CC-BY-SA-4.0 | CC0-1.0 */
  license: string;
  attribution: string;
  sourceUrl: string;
  downloadUrl: string;
  /** Sketchfab animationCount */
  animationCount: number;
  /** animation clip names in the glb itself */
  clips: string[];
  skinned: boolean;
  faceCount: number;
  bytes: number;
  fetchedAt: string;
}

export interface FetchedModel {
  uid: string;
  /** "/models/<uid>/model.glb" */
  file: string;
  dir: string;
  meta: ModelMeta;
  /** true when the library already had it (no network) */
  cached: boolean;
  ms: number;
}

export interface FetchOptions {
  libraryDir: string;
  timeoutMs?: number;
  maxBytes?: number;
  baseUrl?: string;
  signal?: AbortSignal;
}

export class ModelFetchError extends Error {}

class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(private free: number) {}
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiters.push(r));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}

const downloads = new Semaphore(MAX_DOWNLOADS);
const inflight = new Map<string, Promise<FetchedModel>>();

export const sourceUrlFor = (uid: string) => `https://sketchfab.com/3d-models/${uid}`;

/** The attribution line a CC licence asks for: "Title" by Author (source), licence. */
export function attributionFor(
  c: Pick<ModelCandidate, 'uid' | 'name' | 'author' | 'license'>,
): string {
  const by = c.author ? ` by ${c.author}` : '';
  const tail = ` (sketchfab.com/3d-models/${c.uid}), ${LICENSES[c.license].label}`;
  const room = 200 - tail.length - by.length - 2;
  const title = c.name.length > room ? `${c.name.slice(0, Math.max(0, room - 1))}…` : c.name;
  return `"${title}"${by}${tail}`.slice(0, 200);
}

/** Extensions the viewer's GLTFLoader cannot decode without extra decoders (as prop-upload.ts refuses). */
const UNSUPPORTED = [
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_meshopt_compression',
  'KHR_texture_basisu',
];

/**
 * Animation names and skinning from a GLB's JSON chunk; throws when it is not a complete glTF 2.0
 * binary the viewer can draw (bad magic / version / length, a required compression extension).
 */
export function glbInfo(bytes: Uint8Array): { clips: string[]; skinned: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 12 && view.getUint32(8, true) !== bytes.byteLength)
    throw new Error(
      `the glb says ${view.getUint32(8, true)} bytes but ${bytes.byteLength} arrived`,
    );
  const { json } = parseGlb(bytes);
  const g = json as {
    animations?: { name?: string }[];
    skins?: unknown[];
    extensionsRequired?: unknown;
  };
  const required = Array.isArray(g.extensionsRequired) ? g.extensionsRequired.map(String) : [];
  const blocked = required.filter((e) => UNSUPPORTED.includes(e));
  if (blocked.length) throw new Error(`needs ${blocked.join(', ')}`);
  const clips = (g.animations ?? []).map((a, i) =>
    typeof a.name === 'string' && a.name ? a.name : `clip ${i}`,
  );
  return { clips: clips.slice(0, 64), skinned: (g.skins?.length ?? 0) > 0 };
}

async function readMeta(dir: string): Promise<ModelMeta | undefined> {
  const m = await readJson<ModelMeta>(join(dir, 'model.json')).catch(() => undefined);
  if (!m || !UID_RE.test(m.uid ?? '') || !(await exists(join(dir, 'model.glb')))) return undefined;
  return m;
}

/** The library copy of a model, without any network; undefined when it is not there. */
export async function libraryModel(
  libraryDir: string,
  uid: string,
): Promise<ModelMeta | undefined> {
  return UID_RE.test(uid) ? readMeta(join(libraryDir, uid)) : undefined;
}

/**
 * The candidate's glb in the model library: a cache hit returns at once; otherwise one download per
 * uid, at most MAX_DOWNLOADS at a time, cut at maxBytes while streaming and at timeoutMs.
 */
export async function fetchModel(c: ModelCandidate, o: FetchOptions): Promise<FetchedModel> {
  const t0 = performance.now();
  if (!UID_RE.test(c.uid) || !GLB_PATH_RE.test(c.path))
    throw new ModelFetchError(`bad model id ${c.uid}`);
  const dir = join(o.libraryDir, c.uid);
  const hit = await readMeta(dir);
  if (hit)
    return {
      uid: c.uid,
      file: modelUrl(c.uid),
      dir,
      meta: hit,
      cached: true,
      ms: performance.now() - t0,
    };
  let p = inflight.get(c.uid);
  if (!p) {
    p = downloads.use(() => download(c, dir, o)).finally(() => inflight.delete(c.uid));
    inflight.set(c.uid, p);
  }
  const got = await p;
  return { ...got, ms: performance.now() - t0 };
}

async function download(c: ModelCandidate, dir: string, o: FetchOptions): Promise<FetchedModel> {
  const t0 = performance.now();
  const max = o.maxBytes ?? MAX_MODEL_BYTES;
  const url = (o.baseUrl ?? OBJAVERSE_BASE) + c.path;
  const signals = [
    AbortSignal.timeout(o.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
    ...(o.signal ? [o.signal] : []),
  ];
  const signal = AbortSignal.any(signals);
  let bytes: Buffer;
  try {
    const res = await fetch(url, { signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new ModelFetchError(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (declared > max) {
      await res.body.cancel().catch(() => undefined);
      throw new ModelFetchError(
        `${(declared / 1e6).toFixed(1)} MB is over the ${(max / 1e6).toFixed(0)} MB cap`,
      );
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new ModelFetchError(`over the ${(max / 1e6).toFixed(0)} MB cap`);
      }
      chunks.push(value);
    }
    bytes = Buffer.concat(chunks, total);
  } catch (e) {
    if (e instanceof ModelFetchError) throw e;
    const name = (e as Error).name;
    if (name === 'TimeoutError' || (name === 'AbortError' && !o.signal?.aborted))
      throw new ModelFetchError(
        `timed out after ${((o.timeoutMs ?? DOWNLOAD_TIMEOUT_MS) / 1000).toFixed(0)} s`,
      );
    throw new ModelFetchError(`download failed: ${(e as Error).message}`);
  }
  let info: ReturnType<typeof glbInfo>;
  try {
    info = glbInfo(bytes);
  } catch (e) {
    throw new ModelFetchError(`not usable: ${(e as Error).message}`);
  }
  const meta: ModelMeta = {
    uid: c.uid,
    name: c.name,
    ...(c.author ? { author: c.author } : {}),
    license: LICENSES[c.license].id,
    attribution: attributionFor(c),
    sourceUrl: sourceUrlFor(c.uid),
    downloadUrl: url,
    animationCount: c.anim,
    clips: info.clips,
    skinned: info.skinned,
    faceCount: c.faces,
    bytes: bytes.byteLength,
    fetchedAt: new Date().toISOString(),
  };
  // a fresh directory moved into place: a reader never sees a glb without its model.json
  const tmp = `${dir}.${randomBytes(4).toString('hex')}.part`;
  await mkdir(tmp, { recursive: true });
  try {
    await writeFileAtomic(join(tmp, 'model.glb'), bytes);
    await writeJsonAtomic(join(tmp, 'model.json'), meta);
    await rename(tmp, dir).catch(async (e) => {
      // someone else landed it first (another process): theirs is as good
      if (!(await readMeta(dir))) throw e;
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return {
    uid: c.uid,
    file: modelUrl(c.uid),
    dir,
    meta,
    cached: false,
    ms: performance.now() - t0,
  };
}

// ---- PropModel ---------------------------------------------------------------------------------

const IDLE_RE = /idle|stand|breath|rest|wait|look/i;
const MOVE_RE = /walk|move|locomot|trot|fly|flap|swim|glide|cruise|drive|crawl|slither/i;
const FAST_RE = /run|gallop|sprint|charge|dash|fast|rush/i;

/** Clip names per intent, when the file has several and their names say which is which. */
export function intentClips(clips: readonly string[]): PropModel['clips'] | undefined {
  if (clips.length < 2) return undefined;
  const pick = (re: RegExp, not?: RegExp) => clips.find((c) => re.test(c) && !(not && not.test(c)));
  const fast = pick(FAST_RE);
  const move = pick(MOVE_RE, FAST_RE);
  const idle = pick(IDLE_RE);
  const out = { ...(idle ? { idle } : {}), ...(move ? { move } : {}), ...(fast ? { fast } : {}) };
  return Object.keys(out).length ? out : undefined;
}

/** The DynamicElement.model for a fetched candidate. */
export function propModelFor(c: ModelCandidate, meta: ModelMeta, heightM: number): PropModel {
  const lic = LICENSES[c.license].id;
  const clips = intentClips(meta.clips);
  const src = `found: ${c.name} (Objaverse ${c.uid}, ${lic})`;
  return {
    file: modelUrl(c.uid),
    animated: meta.clips.length > 0,
    ...(clips ? { clips } : {}),
    license: lic,
    attribution: meta.attribution.slice(0, 200),
    heightM,
    source:
      src.length > 200
        ? `found: ${c.name.slice(0, 200 - src.length + c.name.length - 1)}… (Objaverse ${c.uid}, ${lic})`
        : src,
  };
}

// ---- attach ------------------------------------------------------------------------------------

const GAIT_CLIP = /walk|run|trot|gallop|move|locomot|fly|flap|swim|crawl|idle|cycle/i;

/**
 * Why a creature's glb cannot replace its procedural body, or null when it can: it needs clips,
 * and a skeleton or a clip named for a gait (a lone "CubeAction" on an unskinned mesh is usually a
 * turntable or one moving part).
 */
export function clipsMissing(meta: Pick<ModelMeta, 'clips' | 'skinned'>): string | null {
  if (!meta.clips.length) return 'has no clips';
  if (!meta.skinned && !meta.clips.some((c) => GAIT_CLIP.test(c)))
    return 'has no skeleton or gait clip';
  return null;
}

export interface FoundModelsOptions {
  enabled: boolean;
  libraryDir: string;
  indexFile?: string;
  /** per-scene budget from the start of its lookups (default 20 s) */
  budgetMs?: number;
  /** per-download timeout (default 15 s) */
  timeoutMs?: number;
  /** candidates tried per element when one fails or brings no clips (default 2) */
  attempts?: number;
}

interface Outcome {
  model: PropModel | null;
  /** "t-rex: "Tyrannosaurus Rex" CC-BY-4.0 4.1 MB 2.3 s" or "airliner: none (no match)" */
  note: string;
}

interface Lookup {
  startedAt: number;
  done: boolean;
  outcome: Outcome | null;
  promise: Promise<Outcome>;
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** The found-model lookups of every scene in this process (keyed by kind + label). */
export class FoundModels {
  readonly enabled: boolean;
  private readonly lookups = new Map<string, Lookup>();
  constructor(private readonly o: FoundModelsOptions) {
    this.enabled = o.enabled;
  }

  private static key = (d: Pick<DynamicElement, 'kind' | 'label'>) =>
    `${d.kind}|${d.label.trim().toLowerCase()}`;

  private static eligible = (d: DynamicElement) => d.kind !== 'model' && !d.model;

  /** Starts the lookups these elements need (no-op for those already running or done). */
  start(dynamics: readonly DynamicElement[]): void {
    if (!this.enabled) return;
    for (const d of dynamics) {
      if (!FoundModels.eligible(d)) continue;
      const key = FoundModels.key(d);
      if (this.lookups.has(key)) continue;
      const l: Lookup = {
        startedAt: Date.now(),
        done: false,
        outcome: null,
        promise: Promise.resolve(null as never),
      };
      l.promise = this.lookup(d.label, d.kind).then(
        (outcome) => {
          l.done = true;
          l.outcome = outcome;
          // a failed download is tried again by the next manifest; "no match" stays settled
          if (!outcome.model && /download|timed out|HTTP|cap/.test(outcome.note))
            this.lookups.delete(key);
          return outcome;
        },
        (e: unknown) => {
          l.done = true;
          l.outcome = { model: null, note: `${d.kind}: failed (${(e as Error).message})` };
          this.lookups.delete(key);
          return l.outcome;
        },
      );
      this.lookups.set(key, l);
      if (this.lookups.size > 500) {
        for (const [k, v] of this.lookups) {
          if (this.lookups.size <= 400) break;
          if (v.done) this.lookups.delete(k);
        }
      }
    }
  }

  private async lookup(label: string, kind: Kind): Promise<Outcome> {
    const found = await findModel(label, kind, { indexFile: this.o.indexFile, top: 4 });
    const what = found.query?.family.id ?? kind;
    if (!found.candidate) {
      const why = !found.query
        ? 'no family'
        : found.query.needsClips
          ? 'no animated match'
          : 'no match';
      return { model: null, note: `${what}: none (${why})` };
    }
    // no budget check here: attach() enforces it, and a download that ends after it still lands
    // in the library for the next manifest (each one is capped by its own timeout)
    const notes: string[] = [];
    for (const c of found.candidates.slice(0, this.o.attempts ?? 2)) {
      try {
        const got = await fetchModel(c, {
          libraryDir: this.o.libraryDir,
          timeoutMs: this.o.timeoutMs,
        });
        const why = found.query!.needsClips ? clipsMissing(got.meta) : null;
        if (why) {
          notes.push(`"${c.name}" ${why}`);
          continue;
        }
        const model = propModelFor(c, got.meta, found.query!.heightM);
        const how = got.cached ? 'library' : `${mb(got.meta.bytes)} in ${secs(got.ms)}`;
        const skipped = notes.length ? `; skipped ${notes.join(', ')}` : '';
        return { model, note: `${what}: "${c.name}" (${model.license}, ${how}${skipped})` };
      } catch (e) {
        notes.push(`"${c.name}" ${(e as Error).message}`);
      }
    }
    return { model: null, note: `${what}: none (${notes.join('; ') || 'nothing usable'})` };
  }

  /**
   * The elements with `model` attached for every lookup that has settled by the scene's budget
   * (counted from when its lookups started); late or failed ones keep their procedural body.
   * `summary` is the scene's one log line (null when there was nothing to look up).
   */
  async attach(
    dynamics: readonly DynamicElement[],
  ): Promise<{ dynamics: DynamicElement[]; summary: string | null }> {
    if (!this.enabled) return { dynamics: [...dynamics], summary: null };
    this.start(dynamics);
    const t0 = Date.now();
    const mine = dynamics.map((d) =>
      FoundModels.eligible(d) ? this.lookups.get(FoundModels.key(d)) : undefined,
    );
    const live = mine.filter((l): l is Lookup => !!l);
    if (!live.length) return { dynamics: [...dynamics], summary: null };
    // the budget runs from when the lookups still pending started (at the scene's scheduling, or
    // now for an element a chat turn just added); settled ones cost nothing
    const budget = this.o.budgetMs ?? SCENE_BUDGET_MS;
    const pending = live.filter((l) => !l.done);
    const deadline = Math.min(
      t0 + budget,
      Math.max(0, ...pending.map((l) => l.startedAt + budget)),
    );
    if (pending.length && deadline > Date.now())
      await Promise.race([
        Promise.all(pending.map((l) => l.promise)),
        sleep(deadline - Date.now()),
      ]);
    const notes: string[] = [];
    let attached = 0;
    const out = dynamics.map((d, i) => {
      const l = mine[i];
      if (!l) return d;
      if (!l.done) {
        notes.push(
          `${d.kind} "${d.label.slice(0, 40)}": late (not back within the ${secs(budget)} budget; the next manifest takes it from the library)`,
        );
        return d;
      }
      notes.push(l.outcome!.note);
      if (!l.outcome!.model) return d;
      attached++;
      return { ...d, model: l.outcome!.model };
    });
    const waited = Date.now() - t0;
    return {
      dynamics: out,
      summary:
        `found models: ${attached} of ${live.length} attached (waited ${secs(waited)}) — ${notes.join('; ')}`.slice(
          0,
          1200,
        ),
    };
  }
}
