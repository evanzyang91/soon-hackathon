// Deterministic, offline screenplay → ScreenplayPlan (the MOCK path, and the fallback when no
// Anthropic key is configured). A pragmatic subset of Fountain: title page, scene headings
// (INT./EXT./EST./INT./EXT./I/E or forced with a leading '.'), CHARACTER cues in caps with
// optional extensions and '@' forcing, parentheticals, dialogue, transitions, notes/boneyard.
// Blocking, dynamics and shots come from simple heuristics — good enough to drive the pipeline.
import type {
  Blocking,
  Character,
  DialogueLine,
  DynamicElement,
  ScenePlan,
  ScreenplayPlan,
  SuggestedShot,
  Vec3,
} from '../../shared/schema.ts';
import { lookAtQuat, round3, slugify, uniqueSlug, yawFacing } from './geometry.ts';

export const VOICES = {
  female: ['nova', 'shimmer', 'coral', 'sage'],
  male: ['onyx', 'ash', 'echo', 'ballad'],
  neutral: ['alloy', 'fable'],
} as const;
export const VOICE_IDS = [...VOICES.female, ...VOICES.male, ...VOICES.neutral] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

const HEADING_RE = /^(?:INT\.?\/EXT|EXT\.?\/INT|I\/E|INT|EXT|EST)[.\s]/i;
const TRANSITION_RE = /^(?:[A-Z0-9 ]+ TO:|FADE (?:IN|OUT|TO BLACK)\.?:?|CUT TO BLACK\.?)$/;

export interface ParsedHeading {
  interior: boolean;
  location: string;
  timeOfDay: ScenePlan['timeOfDay'];
}

export function parseHeading(heading: string): ParsedHeading {
  const h = heading.replace(/^\./, '').trim();
  const prefix = h.match(/^(INT\.?\/EXT|EXT\.?\/INT|I\/E|INT|EXT|EST)\.?/i)?.[0] ?? '';
  const interior = /^INT(?!\.?\/EXT)/i.test(prefix) || /^I\/E/i.test(prefix);
  const rest = h.slice(prefix.length).replace(/^[.\s]+/, '');
  const parts = rest.split(/\s+[-–—]\s+/);
  const timeWord = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  const location = (parts.length > 1 ? parts.slice(0, -1).join(' - ') : rest).trim() || 'location';
  return { interior, location, timeOfDay: timeOfDayFrom(timeWord || rest) };
}

export function timeOfDayFrom(s: string): ScenePlan['timeOfDay'] {
  const t = s.toUpperCase();
  if (/\b(NIGHT|MIDNIGHT|LATE NIGHT)\b/.test(t)) return 'night';
  if (/\b(DUSK|SUNSET|EVENING|TWILIGHT|MAGIC HOUR|GOLDEN HOUR)\b/.test(t)) return 'dusk';
  if (/\b(DAWN|SUNRISE|DAYBREAK|EARLY MORNING|FIRST LIGHT)\b/.test(t)) return 'dawn';
  return 'day';
}

interface RawScene {
  heading: string;
  action: string[];
  dialogue: { name: string; text: string; parenthetical?: string }[];
}

interface RawScript {
  title?: string;
  scenes: RawScene[];
}

const isUpperCue = (line: string) => {
  const name = line
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/\s*\^$/, '')
    .trim();
  return (
    /[A-Z]/.test(name) &&
    name === name.toUpperCase() &&
    /^[A-Z0-9 .'\-]+$/.test(name) &&
    !/[.!?:]$/.test(name.replace(/\b(?:MR|MRS|MS|DR|ST|JR|SR)\.$/, 'X'))
  );
};

/** "MAYA (V.O.)" → "MAYA"; "@McCLANE" → "McCLANE". */
export function cueName(line: string): string {
  return line
    .replace(/^@/, '')
    .replace(/\s*\^$/, '')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function stripMarkup(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '') // boneyard
    .replace(/\[\[[\s\S]*?\]\]/g, '') // notes
    .replace(/^=.*$/gm, '') // synopses
    .replace(/^#+.*$/gm, ''); // sections
}

export function parseFountain(text: string): RawScript {
  let lines = stripMarkup(text).split('\n');
  let title: string | undefined;

  // Title page: leading "Key: value" block terminated by a blank line.
  if (/^\s*(Title|Credit|Author|Authors|Source|Draft date|Contact)\s*:/i.test(lines[0] ?? '')) {
    const end = lines.findIndex((l) => l.trim() === '');
    const page = lines.slice(0, end < 0 ? lines.length : end);
    for (let i = 0; i < page.length; i++) {
      const m = page[i]!.match(/^\s*Title\s*:\s*(.*)$/i);
      if (m) {
        const inline = m[1]!.trim();
        const cont = [];
        for (let j = i + 1; j < page.length && /^\s{2,}|\t/.test(page[j]!); j++)
          cont.push(page[j]!.trim());
        title =
          [inline, ...cont].filter(Boolean).join(' ').replace(/[*_]/g, '').trim() || undefined;
      }
    }
    lines = lines.slice(end < 0 ? lines.length : end);
  }

  const scenes: RawScene[] = [];
  let scene: RawScene | null = null;
  const pre: RawScene = { heading: '', action: [], dialogue: [] };
  const cur = () => scene ?? pre;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const prevBlank = i === 0 || lines[i - 1]!.trim() === '';
    const next = lines[i + 1]?.trim() ?? '';

    const forcedHeading = /^\.[^.]/.test(line);
    if (prevBlank && (forcedHeading || HEADING_RE.test(line))) {
      const heading = (forcedHeading ? line.slice(1) : line).replace(/\s+#[^#]+#$/, '').trim();
      scene = { heading: heading.toUpperCase(), action: [], dialogue: [] };
      scenes.push(scene);
      continue;
    }
    if (/^>.*<$/.test(line)) continue; // centered text
    if (/^>/.test(line) || (prevBlank && TRANSITION_RE.test(line) && next === '')) continue;

    const forcedCue = line.startsWith('@');
    if (prevBlank && next !== '' && (forcedCue || isUpperCue(line)) && !TRANSITION_RE.test(line)) {
      const name = cueName(line);
      let parenthetical: string | undefined;
      const said: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j]!.trim();
        if (!l) break;
        if (/^\(.*\)$/.test(l)) {
          if (said.length === 0 && !parenthetical) parenthetical = l.slice(1, -1).trim();
          else if (said.length > 0) {
            // A mid-speech parenthetical starts a new beat; keep it with the following text.
            cur().dialogue.push({ name, text: said.join(' '), parenthetical });
            said.length = 0;
            parenthetical = l.slice(1, -1).trim();
          }
          continue;
        }
        said.push(l.replace(/^[~]/, ''));
      }
      if (said.length) cur().dialogue.push({ name, text: said.join(' '), parenthetical });
      i = j - 1;
      continue;
    }

    // Action paragraph (consecutive non-blank lines).
    const para = [line.replace(/^!/, '')];
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== '') para.push(lines[++i]!.trim());
    cur().action.push(para.join(' '));
  }

  // Dialogue before the first heading still needs a scene.
  if (scenes.length === 0 || pre.dialogue.length) {
    scenes.unshift({ ...pre, heading: pre.heading || 'INT. UNTITLED LOCATION - DAY' });
  }
  return { title, scenes };
}

// ---------------------------------------------------------------------------
// Heuristic staging
// ---------------------------------------------------------------------------

const DYNAMIC_WORDS: { kind: DynamicElement['kind']; re: RegExp }[] = [
  {
    kind: 'car',
    re: /\b(cars?|sedans?|taxis?|cabs?|trucks?|vans?|suvs?|motorcycles?|jeeps?|convertibles?)\b/i,
  },
  { kind: 'bus', re: /\b(bus|buses|trams?|streetcars?|trolleys?)\b/i },
  { kind: 'bicycle', re: /\b(bikes?|bicycles?|cyclists?|bicyclists?)\b/i },
  {
    kind: 'bird',
    re: /\b(birds?|pigeons?|gulls?|seagulls?|crows?|sparrows?|starlings?|doves?)\b/i,
  },
  { kind: 'pedestrian', re: /\b(joggers?|pedestrians?|passers?-?by|commuters?)\b/i },
];

const sentences = (paragraphs: string[]) =>
  paragraphs
    .flatMap((p) => p.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);

// Only moving things become dynamics ("a bus shelter" stays scenery; "a bus rumbles by" moves).
const MOTION_RE =
  /\b(drives?|driving|drove|pass(?:es|ing|ed)?|past|by|rumbles?|rumbling|speeds?|speeding|zooms?|rolls?|rolling|pulls? (?:up|away|out)|circles?|circling|fl(?:y|ies|ying|ew)|swoops?|wheels?|rides?|riding|cycles?|pedals?|jogs?|jogging|hurr(?:y|ies)|streams?)\b/i;

export function detectDynamics(action: string[], sceneIndex: number): DynamicElement[] {
  const out: DynamicElement[] = [];
  const all = sentences(action);
  for (const { kind, re } of DYNAMIC_WORDS) {
    const hit = all.find((s) => re.test(s) && MOTION_RE.test(s));
    if (!hit) continue;
    const id = `s${sceneIndex + 1}-${kind}`;
    const label = hit.length > 120 ? `${hit.slice(0, 117)}...` : hit;
    if (kind === 'car') {
      out.push({
        id,
        kind,
        label,
        path: [
          [-30, 0, -9.5],
          [30, 0, -9.5],
        ],
        speed: 8,
        loop: true,
        pauseSeconds: 2,
        scale: 1,
      });
    } else if (kind === 'bus') {
      out.push({
        id,
        kind,
        label,
        path: [
          [30, 0, -11.5],
          [-30, 0, -11.5],
        ],
        speed: 6,
        loop: true,
        pauseSeconds: 4,
        scale: 1,
      });
    } else if (kind === 'bicycle') {
      out.push({
        id,
        kind,
        label,
        path: [
          [-20, 0, -7],
          [20, 0, -7],
        ],
        speed: 5,
        loop: true,
        pauseSeconds: 3,
        scale: 1,
      });
    } else if (kind === 'pedestrian') {
      out.push({
        id,
        kind,
        label,
        path: [
          [12, 0, -7.5],
          [-12, 0, -7.5],
        ],
        speed: 1.4,
        loop: true,
        pauseSeconds: 2,
        scale: 1,
      });
    } else {
      // Birds circle overhead: a closed ring, 6 m radius, ~8 m up, centred 9 m out.
      const ring: Vec3[] = [];
      for (let k = 0; k <= 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        ring.push([
          round3(Math.cos(a) * 6),
          round3(8 + Math.sin(a * 2) * 0.6),
          round3(-9 + Math.sin(a) * 6),
        ]);
      }
      out.push({ id, kind, label, path: ring, speed: 6, loop: true, pauseSeconds: 0, scale: 1 });
    }
  }
  return out;
}

/** Actors 1.4 m apart facing each other (2), facing camera (1), or on an arc around a centre. */
export function heuristicBlocking(characterIds: string[], interior: boolean): Blocking[] {
  const z = interior ? -2.4 : -3;
  const n = characterIds.length;
  if (n === 0) return [];
  if (n === 1) {
    const position: Vec3 = [0, 0, z];
    return [
      {
        characterId: characterIds[0]!,
        position,
        yaw: round3(yawFacing(position, [0, 0, 0])),
        pose: 'standing',
      },
    ];
  }
  if (n === 2) {
    const a: Vec3 = [-0.7, 0, z];
    const b: Vec3 = [0.7, 0, z];
    return [
      {
        characterId: characterIds[0]!,
        position: a,
        yaw: round3(yawFacing(a, b)),
        pose: 'standing',
      },
      {
        characterId: characterIds[1]!,
        position: b,
        yaw: round3(yawFacing(b, a)),
        pose: 'standing',
      },
    ];
  }
  // Semi-circle behind a centre point, opening towards the camera so nobody turns their back.
  const centre: Vec3 = [0, 0, z + 0.4];
  const radius = Math.max(1.2, (n * 0.75) / Math.PI);
  return characterIds.map((characterId, k) => {
    const a = Math.PI * (0.1 + (0.8 * k) / (n - 1)); // 18°..162°, left to right
    const position: Vec3 = [
      round3(-Math.cos(a) * radius),
      0,
      round3(centre[2] - Math.sin(a) * radius),
    ];
    return { characterId, position, yaw: round3(yawFacing(position, centre)), pose: 'standing' };
  });
}

export function heuristicShots(blocking: Blocking[]): SuggestedShot[] {
  const head = 1.55;
  if (blocking.length === 0) {
    return [
      {
        name: 'Wide establishing',
        position: [0, 1.6, 0],
        quaternion: lookAtQuat([0, 1.6, 0], [0, 1.4, -8]),
        fovDeg: 60,
      },
    ];
  }
  const cx = blocking.reduce((s, b) => s + b.position[0], 0) / blocking.length;
  const cz = blocking.reduce((s, b) => s + b.position[2], 0) / blocking.length;
  const centre: Vec3 = [round3(cx), 1.3, round3(cz)];
  const wideFrom: Vec3 = [0, 1.6, 0.6];
  const shots: SuggestedShot[] = [
    {
      name: 'Wide master',
      position: wideFrom,
      quaternion: lookAtQuat(wideFrom, centre),
      fovDeg: 55,
    },
  ];
  const a = blocking[0]!;
  const b = blocking[1];
  if (b) {
    const twoFrom: Vec3 = [round3(cx + 0.4), 1.5, round3(cz + 1.9)];
    shots.push({
      name: 'Two-shot',
      position: twoFrom,
      quaternion: lookAtQuat(twoFrom, [centre[0], 1.45, centre[2]]),
      fovDeg: 40,
    });
    // Over A's shoulder onto B: step back from A away from B and slightly to the side.
    const dx = b.position[0] - a.position[0];
    const dz = b.position[2] - a.position[2];
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const from: Vec3 = [
      round3(a.position[0] - ux * 0.55 - uz * 0.35),
      1.62,
      round3(a.position[2] - uz * 0.55 + ux * 0.35),
    ];
    shots.push({
      name: 'Over-the-shoulder',
      position: from,
      quaternion: lookAtQuat(from, [b.position[0], head, b.position[2]]),
      fovDeg: 35,
    });
  } else {
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    const from: Vec3 = [round3(a.position[0] + fx * 1.3), 1.55, round3(a.position[2] + fz * 1.3)];
    shots.push({
      name: 'Medium close-up',
      position: from,
      quaternion: lookAtQuat(from, [a.position[0], head, a.position[2]]),
      fovDeg: 38,
    });
  }
  return shots;
}

const LIGHTING: Record<ScenePlan['timeOfDay'], string> = {
  dawn: 'soft pink-gold dawn light, long low shadows, faint morning haze',
  day: 'bright natural daylight, crisp shadows, clear air',
  dusk: 'warm orange dusk light, deep blue sky, first lights coming on',
  night: 'night, pools of warm streetlight and cool moonlight, deep shadows',
};

export function heuristicWorldPrompt(h: ParsedHeading): string {
  const where = h.location.toLowerCase();
  const kind = h.interior
    ? `interior of a ${where}, furnished and lived-in, realistic materials and textures`
    : `exterior ${where}, realistic architecture, materials and street furniture`;
  return `Photorealistic ${kind}; ${LIGHTING[h.timeOfDay]}. Eye-level view, open floor space in the foreground. No people, no vehicles.`.slice(
    0,
    600,
  );
}

/**
 * The mock planner's standing height: a stable 1.62–1.85 m per character id (FNV-1a), so MOCK
 * scenes show actors of different heights; an intro that says "tall" or "short" narrows it to
 * the top or bottom of that range.
 */
export function mockHeight(id: string, details = ''): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  const u = (h % 1000) / 999;
  const d = details.toLowerCase();
  const [lo, hi] = /\b(tall|lanky|towering)\b/.test(d)
    ? [1.8, 1.85]
    : /\b(short|petite|small)\b/.test(d)
      ? [1.62, 1.67]
      : [1.62, 1.85];
  return Math.round((lo + u * (hi - lo)) * 100) / 100;
}

export function mockPlan(
  text: string,
  opts: { title?: string; log?: (m: string) => void } = {},
): ScreenplayPlan {
  const raw = parseFountain(text);
  const characters = new Map<string, Character>();
  const takenIds = new Set<string>();
  const nameToId = new Map<string, string>();
  const allAction = raw.scenes.flatMap((s) => s.action).join(' ');

  const idFor = (name: string) => {
    const key = name.toUpperCase();
    let id = nameToId.get(key);
    if (!id) {
      id = uniqueSlug(slugify(name, 24), takenIds);
      nameToId.set(key, id);
      // Fountain convention: a character's first appearance in action is "NAME (details)".
      const intro = allAction.match(
        new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(([^)]{3,160})\\)`),
      );
      const details = intro?.[1]?.trim();
      const voices = VOICE_IDS;
      characters.set(id, {
        id,
        name: key,
        description: details
          ? `${key}: ${details}. Generic placeholder look (mock parser): full body, plain everyday clothes.`
          : `${key}: an adult of average height and build in plain everyday clothes (generic placeholder, mock parser).`,
        heightMeters: mockHeight(id, details),
        voice: { id: voices[(characters.size * 3) % voices.length]!, gender: 'neutral' },
      });
    }
    return id;
  };

  const slugs = new Set<string>();
  const scenes: ScenePlan[] = raw.scenes.map((s, index) => {
    const heading = parseHeading(s.heading);
    const dialogue: DialogueLine[] = s.dialogue.map((d, order) => ({
      id: `s${index + 1}-l${order + 1}`,
      characterId: idFor(d.name),
      text: d.text,
      ...(d.parenthetical ? { parenthetical: d.parenthetical } : {}),
      order,
    }));
    const characterIds = [...new Set(dialogue.map((d) => d.characterId))];
    const blocking = heuristicBlocking(characterIds, heading.interior);
    return {
      index,
      slug: uniqueSlug(slugify(s.heading), slugs),
      heading: s.heading,
      action: s.action.join('\n\n'),
      worldPrompt: heuristicWorldPrompt(heading),
      timeOfDay: heading.timeOfDay,
      interior: heading.interior,
      characterIds,
      dialogue,
      blocking,
      dynamics: detectDynamics(s.action, index),
      shots: heuristicShots(blocking),
    };
  });

  const title = opts.title?.trim() || raw.title || raw.scenes[0]?.heading || 'Untitled';
  opts.log?.(
    `mock parser: ${scenes.length} scene(s), ${characters.size} character(s), ${scenes.reduce((n, s) => n + s.dialogue.length, 0)} line(s)`,
  );
  return { title, characters: [...characters.values()], scenes };
}

/** Count of scene headings, used to sanity-check the LLM output. */
export function countSceneHeadings(text: string): number {
  return parseFountain(text).scenes.filter((s) => s.heading && !/UNTITLED LOCATION/.test(s.heading))
    .length;
}
