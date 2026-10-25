// Deterministic, offline screenplay → ScreenplayPlan (the MOCK path, and the fallback when no
// Anthropic key is configured). A pragmatic subset of Fountain: title page, scene headings
// (INT./EXT./EST./INT./EXT./I/E or forced with a leading '.'), CHARACTER cues in caps with
// optional extensions and '@' forcing, parentheticals, dialogue, transitions, notes/boneyard.
// Blocking, dynamics and shots come from simple heuristics — good enough to drive the pipeline.
import { LOOK_PRESET_LABELS } from '../../shared/look-presets.ts';
import type {
  Blocking,
  Character,
  DialogueLine,
  DynamicElement,
  LookPresetName,
  LookSeed,
  ScenePlan,
  ScreenplayPlan,
  SuggestedShot,
  Vec3,
  VisualStyle,
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
  { kind: 'car', re: /\b(cars?|sedans?|taxis?|cabs?|vans?|suvs?|jeeps?|convertibles?)\b/i },
  { kind: 'bus', re: /\b(bus|buses|trams?|streetcars?|trolleys?)\b/i },
  { kind: 'truck', re: /\b(trucks?|lorr(?:y|ies)|pickups?|semis?|tractor-trailers?)\b/i },
  { kind: 'motorcycle', re: /\b(motorcycles?|motorbikes?|scooters?|mopeds?)\b/i },
  { kind: 'bicycle', re: /\b(bikes?|bicycles?|cyclists?|bicyclists?)\b/i },
  {
    kind: 'bird',
    re: /\b(birds?|pigeons?|gulls?|seagulls?|crows?|ravens?|sparrows?|starlings?|doves?)\b/i,
  },
  { kind: 'pedestrian', re: /\b(joggers?|pedestrians?|passers?-?by|commuters?)\b/i },
  { kind: 'dog', re: /\b(dogs?|hounds?|pupp(?:y|ies)|wolf|wolves|coyotes?)\b/i },
  { kind: 'horse', re: /\b(horses?|horseback|riders?|stallions?|mares?|pon(?:y|ies)|cavalry)\b/i },
  { kind: 'wagon', re: /\b(wagons?|stagecoach(?:es)?|carriages?|carts?|bugg(?:y|ies))\b/i },
  {
    kind: 'boat',
    re: /\b(boats?|ships?|rowboats?|canoes?|ferr(?:y|ies)|yachts?|sailboats?|gondolas?|barges?)\b/i,
  },
  { kind: 'dragon', re: /\b(dragons?|wyverns?|wyrms?|drakes?)\b/i },
  { kind: 'drone', re: /\b(drones?|quadcopters?)\b/i },
  {
    kind: 'spacecraft',
    re: /\b(spacecraft|spaceships?|starships?|shuttles?|rockets?|landers?|ufos?)\b|\blift(?:s|ing)? off\b/i,
  },
];

const sentences = (paragraphs: string[]) =>
  paragraphs
    .flatMap((p) => p.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);

// Only moving things become dynamics ("a bus shelter" stays scenery; "a bus rumbles by" moves).
// A bare "by" is not motion ("a hall lit by torches … a cart", "a carriage waits by the gate").
const MOTION_RE =
  /\b(drives?|driving|drove|pass(?:es|ing|ed)?|past|(?:goes|go|went|rushes|races?|flash(?:es)?|whizz(?:es)?) by|rumbles?|ambles?|wanders?|crosses|crossing|rumbling|speeds?|speeding|zooms?|rolls?|rolling|pulls? (?:up|away|out)|circles?|circling|fl(?:y|ies|ying|ew)|swoops?|wheels?|rides?|riding|cycles?|pedals?|jogs?|jogging|hurr(?:y|ies)|streams?|trots?|trotting|gallops?|galloping|canters?|hums?|humming|hover(?:s|ing)?|lift(?:s|ing)? off|takes? off|launch(?:es|ing)?|glides?|gliding|sails?|sailing|soars?|soaring|patrols?|patrolling|chugs?|bobs?|bobbing)\b/i;

/** A closed ring of `n` + 1 points (first = last) around `centre`, with a gentle height wave. */
function ring(centre: Vec3, rx: number, rz: number, wave: number, n = 12): Vec3[] {
  const out: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * Math.PI * 2;
    out.push([
      round3(centre[0] + Math.cos(a) * rx),
      round3(centre[1] + Math.sin(a * 2) * wave),
      round3(centre[2] + Math.sin(a) * rz),
    ]);
  }
  return out;
}

/** Path, speed (m/s) and end pause per kind: shapes and speeds the props in props.ts are built for. */
function dynamicPath(
  kind: DynamicElement['kind'],
  sentence: string,
): Pick<DynamicElement, 'path' | 'speed' | 'pauseSeconds'> {
  const line = (z: number, x: number, y = 0): Vec3[] => [
    [-x, y, z],
    [x, y, z],
  ];
  switch (kind) {
    case 'car':
      return { path: line(-9.5, 30), speed: 8, pauseSeconds: 2 };
    case 'bus':
      return { path: line(-11.5, 30).reverse(), speed: 6, pauseSeconds: 4 };
    case 'truck':
      return { path: line(-10.5, 30), speed: 7, pauseSeconds: 3 };
    case 'motorcycle':
      return { path: line(-9, 30).reverse(), speed: 9, pauseSeconds: 2 };
    case 'bicycle':
      return { path: line(-7, 20), speed: 5, pauseSeconds: 3 };
    case 'pedestrian':
      return { path: line(-7.5, 12).reverse(), speed: 1.4, pauseSeconds: 2 };
    case 'dog':
      return { path: line(-8, 12).reverse(), speed: 2.5, pauseSeconds: 3 };
    case 'horse':
      return { path: line(-9.5, 25), speed: 4, pauseSeconds: 3 };
    case 'wagon':
      // the ground-dynamics lane the mock sets keep open (docs/PLAN-v3.md §5)
      return { path: line(-10.5, 25), speed: 2.5, pauseSeconds: 4 };
    case 'boat':
      return { path: line(-25, 35), speed: 3, pauseSeconds: 4 };
    case 'dragon':
      // high and far so its wingspan reads against the sky, never over the actors
      return { path: ring([0, 22, -45], 25, 15, 4), speed: 10, pauseSeconds: 0 };
    case 'drone':
      return {
        path: [
          [-6, 3, -5],
          [0, 3.6, -6],
          [6, 3, -5],
        ],
        speed: 4,
        pauseSeconds: 3,
      };
    case 'spacecraft':
      return /\blift(?:s|ing)? off|\btakes? off|\blaunch/i.test(sentence)
        ? {
            path: [
              [-30, 0, -90],
              [-28, 25, -95],
              [-15, 90, -130],
            ],
            speed: 15,
            pauseSeconds: 4,
          }
        : { path: line(-140, 120, 50), speed: 15, pauseSeconds: 3 };
    default:
      // birds circle overhead: a closed ring, 6 m radius, ~8 m up, centred 9 m out
      return { path: ring([0, 8, -9], 6, 6, 0.6), speed: 6, pauseSeconds: 0 };
  }
}

export function detectDynamics(action: string[], sceneIndex: number): DynamicElement[] {
  const out: DynamicElement[] = [];
  const all = sentences(action);
  const wagon = DYNAMIC_WORDS.find((w) => w.kind === 'wagon')!.re;
  for (const { kind, re } of DYNAMIC_WORDS) {
    const hit = all.find(
      // a wagon's team is part of the wagon prop, not a second horse
      (s) => re.test(s) && MOTION_RE.test(s) && !(kind === 'horse' && wagon.test(s)),
    );
    if (!hit) continue;
    const label = hit.length > 120 ? `${hit.slice(0, 117)}...` : hit;
    out.push({
      id: `s${sceneIndex + 1}-${kind}`,
      kind,
      label,
      ...dynamicPath(kind, hit),
      loop: true,
      scale: 1,
    });
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

// ---------------------------------------------------------------------------
// Genre (VisualStyle) and look (LookSeed) heuristics
// ---------------------------------------------------------------------------

/** The genres the heuristics know; free-text styles (Claude's) are read back into one of them. */
export type GenreKey =
  'fantasy' | 'scifi' | 'horror' | 'western' | 'period' | 'noir' | 'contemporary';

/** One style per genre: what the mock planner writes, and the chat's "make it a western". */
export const GENRE_STYLES: Record<GenreKey, VisualStyle> = {
  fantasy: {
    genre: 'high fantasy',
    era: 'medieval-inspired fantasy kingdom',
    worldStyle:
      'Lush, painterly-realistic high-fantasy film still, volumetric light, weathered stone, moss and old timber',
    palette: 'mossy greens, torch gold, cold grey stone',
  },
  scifi: {
    genre: 'science fiction',
    era: 'spacefaring 22nd century',
    worldStyle:
      'Photoreal hard science-fiction film still, practical industrial set design, hard clean light',
    palette: 'cold steel blue, white strip light, warning orange',
  },
  horror: {
    genre: 'horror',
    era: 'present day, isolated and rural',
    worldStyle: 'Photoreal horror film still, low-key light, deep shadows, damp decaying textures',
    palette: 'desaturated greens, sickly yellow light, black shadows',
  },
  western: {
    genre: 'western',
    era: '1880s American frontier',
    worldStyle: 'Photoreal western film still, sun-bleached timber, dust in the air, hard sunlight',
    palette: 'dusty ochre, sun-bleached wood, faded denim blue',
  },
  period: {
    genre: 'period drama',
    era: '19th-century Europe',
    worldStyle:
      'Photoreal period-drama film still, ornate historical architecture and interiors, soft painterly light',
    palette: 'ivory, gilt gold, deep velvet red',
  },
  noir: {
    genre: 'film noir',
    era: '1940s American city',
    worldStyle:
      'Black-and-white film noir still, hard low-key light, venetian-blind shadows, wet streets',
    palette: 'inky blacks, silver highlights, cigarette smoke',
  },
  contemporary: {
    genre: 'contemporary drama',
    era: 'present day',
    worldStyle:
      'Photoreal cinematic film still, natural practical light, lived-in real-world locations',
    palette: 'natural tones, warm practicals, cool night blues',
  },
};

// Script keywords per genre (whole words, plural forms included); a genre needs 2 hits.
const GENRE_WORDS: { key: GenreKey; re: RegExp }[] = [
  {
    key: 'fantasy',
    re: /\b(dragons?|swords?|kingdoms?|wards|crowns?|thrones?|castles?|wizards?|sorcer\w*|elf|elves|dwarf|dwarves|enchant\w*|spells?|knights?|realms?|longbows?)\b/gi,
  },
  {
    key: 'scifi',
    re: /\b(station|orbit\w*|reactors?|regolith|androids?|spacecraft|spaceships?|starships?|airlocks?|lunar|cyborgs?|holograms?|thrusters?|zero-g)\b/gi,
  },
  {
    key: 'horror',
    re: /\b(cellars?|scream\w*|blood\w*|scarecrows?|breathing|corpses?|ghosts?|demons?|crypts?|haunt\w*|monsters?|rotting)\b/gi,
  },
  {
    key: 'western',
    re: /\b(saloons?|sheriffs?|wagons?|revolvers?|stagecoach(?:es)?|deputy|outlaws?|frontier|cowboys?|livery|six-shooters?|tin star)\b/gi,
  },
  {
    key: 'period',
    re: /\b(ballrooms?|carriages?|gowns?|sabres?|sabers?|chandeliers?|corsets?|footm[ae]n|duchess|countess|gas lamps?|dress uniform)\b/gi,
  },
];

/**
 * The screenplay's VisualStyle from keywords (the mock planner, and plans made before styles were
 * planned). A decade ("1890s") counts twice for period drama and becomes its era.
 */
export function heuristicStyle(script: string, headings: string[] = []): VisualStyle {
  const text = `${headings.join('\n')}\n${script}`;
  const score = new Map<GenreKey, number>();
  for (const { key, re } of GENRE_WORDS) score.set(key, text.match(re)?.length ?? 0);
  const decade = /\b(1[5-9]\d0)s\b(?:\s+([A-Z][a-z]+))?/.exec(text);
  if (decade) score.set('period', (score.get('period') ?? 0) + 2);
  else if (/\b1[5-9]\d\d\b/.test(text)) score.set('period', (score.get('period') ?? 0) + 1);
  let best: GenreKey = 'contemporary';
  let top = 1; // a single stray keyword ("the bus station") is not a genre
  for (const { key } of GENRE_WORDS) {
    const n = score.get(key) ?? 0;
    if (n > top) [best, top] = [key, n];
  }
  const style = { ...GENRE_STYLES[best] };
  if (best === 'period' && decade)
    style.era = decade[2] ? `${decade[1]}s ${decade[2]}` : `${decade[1]}s`;
  return style;
}

/** A free-text style (Claude's, or the director's in the chat) read back into a known genre. */
export function genreKey(style: VisualStyle | undefined): GenreKey {
  const g = `${style?.genre ?? ''} ${style?.era ?? ''}`.toLowerCase();
  if (/\bnoir\b/.test(g)) return 'noir';
  if (/horror|slasher|supernatural|haunt/.test(g)) return 'horror';
  if (/western|frontier/.test(g)) return 'western';
  if (/sci-?fi|science.fiction|space|cyberpunk|futur|\b2[1-9]\d\d/.test(g)) return 'scifi';
  if (/fantasy|myth|fairy|sword|sorcery/.test(g)) return 'fantasy';
  if (
    /period|histor|victorian|regency|edwardian|georgian|costume|1[5-9]\d0s|\b1[5-9]th.century/.test(
      g,
    )
  )
    return 'period';
  return 'contemporary';
}

// Mood words found in the action, in order of appearance (the look's name: "Candlelit · misty, cold").
const MOOD_WORDS: [RegExp, string][] = [
  [/\bmist/i, 'misty'],
  [/\bfog/i, 'foggy'],
  [/\b(?:cold|chill|freez|icy|frost)/i, 'cold'],
  [/\b(?:damp|dripp?|wet|rain-slick|puddle)/i, 'damp'],
  [/\bdust/i, 'dusty'],
  [/\b(?:heat|shimmer|scorch|sun-baked|blazing sun)/i, 'hot'],
  [/\b(?:torch|candle|oil lamp|lantern|firelight|fire pit|hearth)/i, 'firelit'],
  [/\bneon/i, 'neon'],
  [/\b(?:sodium|streetlight)/i, 'sodium-lit'],
  [/\b(?:eerie|uncanny|stares?|breathing|whisper)/i, 'eerie'],
  [/\b(?:rot|decay|rust)/i, 'decaying'],
  [/\b(?:gilded|crystal|chandelier|marble)/i, 'opulent'],
  [/\b(?:steel|conduit|metal)/i, 'steel'],
  [/\b(?:ancient|weathered|faded|cracked)/i, 'weathered'],
  [/\b(?:vast|colossal|towering)/i, 'vast'],
  [/\b(?:empty|alone|abandoned|deserted)/i, 'lonely'],
  [/\b(?:soft|pale)\b/i, 'soft'],
  [/\b(?:dark|shadow|gloom)/i, 'dark'],
  [/\bsnow/i, 'snowy'],
];

function moodFrom(action: string, preset: LookPresetName, interior: boolean): string {
  const label = LOOK_PRESET_LABELS[preset].toLowerCase();
  // a character intro ("BRANDT (30s, dark moustache …)") describes a person, not the set
  const set = action.replace(/\b[A-Z][A-Z0-9 .'-]+\s*\([^)]*\)/g, '');
  const hits = MOOD_WORDS.flatMap(([re, word]) => {
    const at = set.search(re);
    // "Snowfall · snowy" says nothing new; snow behind a ballroom's drapes is not the room's mood
    const skip = label.includes(word.slice(0, 4)) || (interior && word === 'snowy');
    return at >= 0 && !skip ? [{ at, word }] : [];
  });
  return [...new Set(hits.sort((a, b) => a.at - b.at).map((h) => h.word))].slice(0, 3).join(', ');
}

const FOREST_RE = /\b(forest|woods?|woodland|glade|clearing|grove|meadow|moss\w*|ferns?)\b/i;
const SNOW_RE = /\b(snow\w*|blizzard|sleet)\b/i;
const STORM_RE =
  /\b(storm\w*|thunder\w*|lightning|downpour|torrential|gale|raining|pouring rain|heavy rain)\b|\brain (?:falls|lashes|pours|hammers|beats|drums|sheets)\b/i;
const FIRE_RE =
  /\b(torch\w*|candle\w*|oil lamps?|lanterns?|firelight|fire ?pit|hearth|fireplace)\b/i;

/**
 * A scene's look from its heading, the screenplay's style and its action (the mock planner, and
 * plans made before looks were planned): weather outside first (snow, storm), then interior or
 * exterior by time of day with the genre's own night, day and dusk.
 */
export function heuristicLookSeed(
  h: ParsedHeading,
  style: VisualStyle | undefined,
  action: string,
): LookSeed {
  const g = genreKey(style);
  const preset = ((): LookPresetName => {
    if (!h.interior && SNOW_RE.test(action)) return 'snowfall';
    if (!h.interior && STORM_RE.test(action)) return 'storm';
    if (g === 'noir') return 'film-noir';
    const late = h.timeOfDay === 'night' || h.timeOfDay === 'dusk';
    if (g === 'horror') return h.interior || late ? 'horror' : 'overcast';
    if (g === 'scifi') {
      const city = /\b(city|street|neon|alley|downtown|megacity|market)\b/i.test(
        `${h.location} ${action}`,
      );
      return h.timeOfDay === 'night' && city && !h.interior ? 'neon-noir' : 'cold-steel';
    }
    if (h.interior) {
      if (g === 'period' && /\b(chandeliers?|ballroom|gilded|blaz\w*)\b/i.test(action))
        return 'period-warm';
      if (late && (g === 'fantasy' || g === 'period' || g === 'western')) return 'candlelit';
      if (g === 'period') return 'period-warm';
      if (g === 'fantasy' && FIRE_RE.test(action)) return 'candlelit';
      return 'warm-interior';
    }
    if (h.timeOfDay === 'night') return g === 'contemporary' ? 'night-street' : 'moonlit';
    if (g === 'fantasy' && h.timeOfDay !== 'dusk' && FOREST_RE.test(`${h.location} ${action}`))
      return 'enchanted';
    if (h.timeOfDay === 'dusk') return 'golden-hour';
    if (h.timeOfDay === 'dawn')
      return /\b(grey|gray|blue|cold|chill|frost\w*)\b/i.test(action) ? 'blue-hour' : 'golden-hour';
    if (g === 'western') return 'western-dust';
    if (g === 'period') return 'period-warm';
    if (/\b(overcast|drizzle|grey sky|gray sky|fog\w*)\b/i.test(action)) return 'overcast';
    return 'daylight-neutral';
  })();
  return { preset, mood: moodFrom(action, preset, h.interior) };
}

const LIGHTING: Record<ScenePlan['timeOfDay'], string> = {
  dawn: 'soft pink-gold dawn light, long low shadows, faint morning haze',
  day: 'bright natural daylight, crisp shadows, clear air',
  dusk: 'warm orange dusk light, deep blue sky, first lights coming on',
  night: 'night, pools of warm streetlight and cool moonlight, deep shadows',
};
const INTERIOR_LIGHTING: Record<ScenePlan['timeOfDay'], string> = {
  dawn: 'pale early light through the windows, soft shadows',
  day: 'soft daylight through the windows, gentle shadows',
  dusk: 'low orange evening light through the windows, lamps coming on',
  night: 'night, warm lamplight, deep shadows',
};

function lighting(g: GenreKey, h: ParsedHeading): string {
  const night = h.timeOfDay === 'night';
  if (g === 'scifi')
    return h.interior
      ? 'cold overhead strip lights, glowing displays, hard reflections'
      : night
        ? 'starlit black sky, hard floodlights, razor-sharp shadows'
        : 'harsh white sunlight, hard-edged shadows';
  if (g === 'horror')
    return night
      ? 'night, one weak light source, impenetrable black shadows'
      : 'flat grey light, colourless sky, gloom in every corner';
  if (g === 'noir') return 'hard low-key light, deep black shadows, smoke in the air';
  if (night && (g === 'fantasy' || g === 'western' || g === 'period'))
    return h.interior
      ? 'night, warm flickering firelight and candlelight, deep shadows'
      : 'night, cool moonlight and a few warm lanterns, deep shadows';
  return (h.interior ? INTERIOR_LIGHTING : LIGHTING)[h.timeOfDay];
}

const SETS: Record<
  GenreKey,
  { interior: (w: string) => string; exterior: (w: string, era: string) => string }
> = {
  fantasy: {
    interior: (w) =>
      `interior of the ${w}: ancient stone walls, heavy timber beams, iron fittings, woven banners and furs`,
    exterior: (w, era) =>
      `exterior ${w} in a ${era}: ancient trees, moss-covered stone, ferns and wild grass, an earthen path`,
  },
  scifi: {
    interior: (w) =>
      `interior of the ${w}: steel deck plates, exposed conduit, bulkheads, glowing control panels`,
    exterior: (w) =>
      `exterior ${w}: engineered structures, landing pads, antennas and modular habitats`,
  },
  horror: {
    interior: (w) =>
      `interior of the ${w}: stained walls, rotting wood, cobwebs, old furniture half in shadow`,
    exterior: (w) =>
      `exterior ${w}: dead vegetation, a sagging fence, rusted ironwork, a treeline in mist`,
  },
  western: {
    interior: (w) =>
      `interior of the ${w}: rough timber walls, plank floor with sawdust, oil lamps, worn wooden furniture`,
    exterior: (w) =>
      `exterior ${w}: packed dirt street, weathered timber storefronts with porches, hitching posts, dry hills beyond`,
  },
  period: {
    interior: (w) =>
      `interior of the ${w}: ornate plasterwork, polished wood, brocade drapes, period furniture and candelabra`,
    exterior: (w, era) =>
      `exterior ${w}, ${era}: cobblestones, stone facades with tall windows, wrought-iron lamps`,
  },
  noir: {
    interior: (w) =>
      `interior of a ${w}: venetian blinds, worn wood and leather, a desk lamp, cigarette haze`,
    exterior: (w) => `exterior ${w}: wet brick and asphalt, fire escapes, a lone streetlamp`,
  },
  contemporary: {
    interior: (w) => `interior of a ${w}, furnished and lived-in, realistic materials and textures`,
    exterior: (w) => `exterior ${w}, realistic architecture, materials and street furniture`,
  },
};

/** The mock planner's world prompt: the style's render words first, then a genre-fitting set. */
export function heuristicWorldPrompt(
  h: ParsedHeading,
  style: VisualStyle = GENRE_STYLES.contemporary,
): string {
  const g = genreKey(style);
  const where = h.location.toLowerCase();
  const set = h.interior ? SETS[g].interior(where) : SETS[g].exterior(where, style.era);
  const render = style.worldStyle.trim().replace(/[.\s]+$/, '');
  return `${render}. ${set.charAt(0).toUpperCase()}${set.slice(1)}; ${lighting(g, h)}. Eye-level view, open floor space in the foreground. No people, no animals, no vehicles.`.slice(
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

  const style = heuristicStyle(
    text,
    raw.scenes.map((s) => s.heading),
  );
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
      worldPrompt: heuristicWorldPrompt(heading, style),
      timeOfDay: heading.timeOfDay,
      interior: heading.interior,
      look: heuristicLookSeed(heading, style, s.action.join('\n\n')),
      characterIds,
      dialogue,
      blocking,
      dynamics: detectDynamics(s.action, index),
      shots: heuristicShots(blocking),
    };
  });

  const title = opts.title?.trim() || raw.title || raw.scenes[0]?.heading || 'Untitled';
  opts.log?.(
    `mock parser: ${scenes.length} scene(s), ${characters.size} character(s), ${scenes.reduce((n, s) => n + s.dialogue.length, 0)} line(s), ${style.genre}`,
  );
  return { title, style, characters: [...characters.values()], scenes };
}

/** Count of scene headings, used to sanity-check the LLM output. */
export function countSceneHeadings(text: string): number {
  return parseFountain(text).scenes.filter((s) => s.heading && !/UNTITLED LOCATION/.test(s.heading))
    .length;
}
