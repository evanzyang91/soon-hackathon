// Background action (ScenePlan.dynamics) as every planner sees it: which words name which prop
// kind, whether a sentence moves or only stands there, and the path + speed each kind gets near the
// actors. Shared by the offline screenplay parser (fountain.ts detectDynamics), the Claude
// screenplay planner (screenplay.ts: unknown kinds, the rules text), the project chat (chat/patch.ts
// `dynamics` patches, chat/mock.ts) and the scoped re-prompt (reprompt/mock.ts, reprompt/planner.ts).
//
// World frame (docs/PLAN.md): metres, Y up, floor y = 0, the world's camera at the origin looking
// down -Z. Actors stand ~3 m out (z ≈ -3); "N m out" below means z ≈ -N.
//
//   creature    on the ground 6-10 m out (big ones 9-10 m), straight across the view ±12 m (±16 m for
//               big ones), 2.5 m/s (big 3, running 4); "stands / grazes / watches" = parked there
//   airplane    20-40 m up (low 22 m), 25 m/s: "overhead / over / low" along the view over the
//               actors' heads (z -150 → +60); else straight across the sky (z ≈ -80, x ±150);
//               take-off and landing reach the ground
//   helicopter  10-20 m up, 12 m/s: "hovers" = parked 12 m up ~22 m out, turned three-quarters to
//               the camera; "circles" a ring; "lands / takes off" to the ground; else across (z ≈ -33)
//   others      the ground lanes and flier shapes the mock sets were built for (car 9.5 m out …)
import { DynamicElement, type Blocking, type Vec3 } from '../../shared/schema.ts';
import { round3 } from './geometry.ts';

type Kind = DynamicElement['kind'];

/**
 * Words that name each kind. Order matters where two kinds share a sentence ("a horse-drawn
 * wagon", "a rider on horseback"): detectDynamics takes each kind once, kindForWords the first
 * word in the text.
 */
export const DYNAMIC_WORDS: { kind: Kind; re: RegExp }[] = [
  {
    kind: 'car',
    re: /\b(cars?|sedans?|taxis?|cabs?|vans?|suvs?|jeeps?|convertibles?|limo(usine)?s?)\b/i,
  },
  { kind: 'bus', re: /\b(bus|buses|trams?|streetcars?|trolleys?|trains?|subway cars?)\b/i },
  {
    kind: 'truck',
    re: /\b(trucks?|lorr(?:y|ies)|pickups?|semis?|tractor-trailers?|tractors?|tanks?|bulldozers?)\b/i,
  },
  { kind: 'motorcycle', re: /\b(motorcycles?|motorbikes?|scooters?|mopeds?)\b/i },
  { kind: 'bicycle', re: /\b(bikes?|bicycles?|cyclists?|bicyclists?)\b/i },
  {
    kind: 'bird',
    re: /\b(birds?|pigeons?|gulls?|seagulls?|crows?|ravens?|sparrows?|starlings?|doves?|eagles?|hawks?|owls?|geese|flocks? of \w+)\b/i,
  },
  { kind: 'pedestrian', re: /\b(joggers?|pedestrians?|passers?-?by|commuters?)\b/i },
  { kind: 'dog', re: /\b(dogs?|hounds?|pupp(?:y|ies))\b/i },
  {
    kind: 'horse',
    re: /\b(horses?|horseback|riders?|stallions?|mares?|pon(?:y|ies)|cavalry|unicorns?)\b/i,
  },
  {
    kind: 'wagon',
    re: /\b(wagons?|stagecoach(?:es)?|carriages?|carts?|bugg(?:y|ies)|chariots?)\b/i,
  },
  {
    kind: 'boat',
    re: /\b(boats?|ships?|rowboats?|canoes?|kayaks?|ferr(?:y|ies)|yachts?|sailboats?|gondolas?|barges?|tugboats?|submarines?)\b/i,
  },
  { kind: 'dragon', re: /\b(dragons?|wyverns?|wyrms?|drakes?)\b/i },
  { kind: 'drone', re: /\b(drones?|quadcopters?)\b/i },
  {
    kind: 'helicopter',
    re: /\b(helicopters?|choppers?|helis?|gunships?|black hawks?|medevac)\b/i,
  },
  {
    kind: 'airplane',
    re: /\b(air-?planes?|aeroplanes?|planes?|jets?(?![- ]?(?:black|ski|stream|lag|set))|jetliners?|airliners?|aircraft|biplanes?|bombers?|fighter(?: jet| plane)?s?|warplanes?|sea-?planes?|cessnas?|crop-?dusters?|gliders?)\b/i,
  },
  {
    kind: 'spacecraft',
    re: /\b(spacecraft|spaceships?|starships?|shuttles?|rockets?|landers?|ufos?|flying saucers?)\b|\blift(?:s|ing)? off\b/i,
  },
  {
    kind: 'creature',
    re: /\b(dinosaurs?|dinos?|t(?:-|\. ?| )?rex(es)?|tyrannosaur\w*|raptors?|velociraptors?|triceratops|stegosaur\w*|brachiosaur\w*|brontosaur\w*|diplodoc\w*|sauropods?|pterodactyls?|mammoths?|elephants?|giraffes?|rhinos?|rhinoceros(es)?|hippos?|bears?(?!\s+(?:down|with|witness|the brunt|in mind|no\b))|grizzl(?:y|ies)|wol(?:f|ves)|wolf pack|werewol(?:f|ves)|coyotes?|foxes|fox|deer|stags?|moose|elks?|reindeer|antelopes?|gazelles?|lions?|lioness(es)?|tigers?|leopards?|panthers?|jaguars?|cheetahs?|cougars?|cows?|cattle|bulls?|oxen|ox|bison|buffalo(es)?|yaks?|camels?|llamas?|alpacas?|zebras?|sheep|lambs?|goats?|pigs?|boars?|hogs?|cats?|kittens?|rabbits?|hares?|kangaroos?|ostrich(es)?|emus?|gorillas?|apes?|monkeys?|crocodiles?|alligators?|monsters?(?!\s+trucks?)|beasts?|creatures?|giants?(?=\s+(?:lumbers?|strides?|stomps?|walks?|wades?|crosses|passes|plods?|marches|appears?|rises?|looms?|steps?|sits?|stands?|sleeps?|roars?)|[.,;!?]|$)|trolls?|ogres?|yetis?|bigfoot|sasquatch|cyclops|minotaurs?|golems?|kaijus?|godzilla|behemoths?|wargs?)\b/i,
  },
];

// a lone capital with a full stop is an initial, not a sentence end ("A huge T. rex lumbers past.")
const sentences = (paragraphs: string[]) =>
  paragraphs
    .flatMap((p) => p.split(/(?<=[.!?])(?<!\b[A-Z]\.)\s+/))
    .map((s) => s.trim())
    .filter(Boolean);

// Only moving things become dynamics ("a bus shelter" stays scenery; "a bus rumbles by" moves).
// A bare "by" is not motion ("a hall lit by torches … a cart", "a carriage waits by the gate").
export const MOTION_RE =
  /\b(drives?|driving|drove|pass(?:es|ing|ed)?|past|(?:goes|go|went|rushes|races?|flash(?:es)?|whizz(?:es)?|walks?|walking|strolls?) by|rumbles?|ambles?|wanders?|crosses|crossing|rumbling|speeds?|speeding|zooms?|rolls?|rolling|pulls? (?:up|away|out)|circles?|circling|fl(?:y|ies|ying|ew)|swoops?|wheels?|rides?|riding|cycles?|pedals?|jogs?|jogging|hurr(?:y|ies)|streams?|trots?|trotting|gallops?|galloping|canters?|hums?|humming|hover(?:s|ing)?|lift(?:s|ing)? off|takes? off|launch(?:es|ing)?|glides?|gliding|sails?|sailing|soars?|soaring|patrols?|patrolling|chugs?|bobs?|bobbing|lumber(?:s|ing)?|stomps?|stomping|plods?|plodding|prowls?|prowling|stalks?|stalking|roams?|roaming|charg(?:es|ing)|thunders? (?:past|by|through|across)|lopes?|loping|crawls?|crawling|slither(?:s|ing)?|waddles?|hops?|hopping|bounds?|bounding|leaps?|leaping|swims?|swimming|runs?|running|ran|sprints?|sprinting|stampedes?|stampeding|walks?|walking|strides?|striding|marches|marching|overhead|buzz(?:es|ing)?|taxis|taxiing|lands|landing|touch(?:es)? down|descends?|climbs?|dives?|screams? (?:past|by|overhead)|roars? (?:past|by|overhead|over))\b/i;

/** A creature that is there without moving ("a brachiosaurus grazes in the distance"). */
export const STAND_RE =
  /\b(stands?|standing|graz(?:es|ing)|waits?|waiting|sleeps?|sleeping|lies|lying|rests?|resting|watch(?:es|ing)|looms?|looming|sits?|sitting|lurks?|lurking|feeds?|feeding|drinks?|drinking|perch(?:es|ed)|tethered|chained|appears?|emerges?|peers?|growls?|snarls?|roars?|howls?|bellows?)\b/i;

/** The kind the text names first ("a dinosaur chases a jeep" → creature), if any. */
export function kindForWords(text: string): Kind | undefined {
  let best: { kind: Kind; at: number } | undefined;
  for (const { kind, re } of DYNAMIC_WORDS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { kind, at: m.index };
  }
  return best?.kind;
}

/** Metres per second each kind moves at when nothing says otherwise. */
export const DEFAULT_SPEED: Record<Kind, number> = {
  car: 8,
  bus: 6,
  truck: 7,
  motorcycle: 9,
  bicycle: 5,
  pedestrian: 1.4,
  bird: 6,
  dog: 2.5,
  horse: 4,
  wagon: 2.5,
  boat: 3,
  dragon: 10,
  drone: 4,
  spacecraft: 15,
  airplane: 25,
  helicopter: 12,
  creature: 3,
  generic: 3,
  model: 0,
};

/** Big creatures walk further out and slower in the stride (the viewer builds them ≥ 3 m). */
const BIG_CREATURE =
  /\b(dinosaurs?|dinos?|t(?:-|\. ?| )?rex|tyrannosaur\w*|triceratops|stegosaur\w*|brachiosaur\w*|brontosaur\w*|diplodoc\w*|sauropods?|mammoths?|elephants?|giraffes?|giants?|trolls?|ogres?|cyclops|kaijus?|godzilla|behemoths?|huge|giant|massive|enormous|colossal|gigantic)\b/i;
const RUN_RE =
  /\b(run\w*|ran|charg\w*|gallop\w*|sprint\w*|bound\w*|chas\w*|stampede\w*|races?|racing|flee\w*|fled|dash\w*|bolts?)\b/i;
const LOW_RE = /\b(low|skims?|skimming|buzz\w*|treetop|rooftop)\b/i;
const OVER_RE =
  /\b(overhead|over (?:the |our |their )?(?:heads?|actors?|street|square|town|village|city|roof\w*|us|them|camera)|above|directly over|right over|flies over|passes over|low)\b/i;
const FROM_RIGHT = /\b(from the right|right to left|from (?:the )?east)\b/i;
const TOWARD_RE =
  /\b(approach\w*|toward\w* (?:the )?(?:camera|us|them|the actors)|charges? (?:at|toward\w*)|comes? (?:at|toward\w*)|heads? (?:for|toward\w*) (?:the )?(?:camera|us|them))\b/i;

export interface PathContext {
  /** The actors' centre on the floor (the default: the mock blocking's ~3 m out). */
  centre?: Vec3;
}

/** Where the scene's actors stand, on the floor (their marks' centroid; ~3 m out when none). */
export function sceneCentre(blocking: readonly Pick<Blocking, 'position'>[]): Vec3 {
  if (!blocking.length) return [0, 0, -3];
  const x = blocking.reduce((s, b) => s + b.position[0], 0) / blocking.length;
  const z = blocking.reduce((s, b) => s + b.position[2], 0) / blocking.length;
  return [round3(x), 0, round3(z)];
}

/** A closed ring of `n` + 1 points (first = last) around `centre`, with a gentle height wave. */
export function ring(centre: Vec3, rx: number, rz: number, wave: number, n = 12): Vec3[] {
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

const r3 = (p: Vec3): Vec3 => [round3(p[0]), round3(p[1]), round3(p[2])];

/** A prop parked at `at`, turned to face `toward` (two points 5 cm apart; speed 0). */
export function parkedAt(at: Vec3, toward: Vec3): Vec3[] {
  const dx = toward[0] - at[0];
  const dz = toward[2] - at[2];
  const d = Math.hypot(dx, dz) || 1;
  return [r3(at), r3([at[0] + (dx / d) * 0.05, at[1], at[2] + (dz / d) * 0.05])];
}

/** Path, speed (m/s) and end pause per kind: shapes and speeds the props in the viewer are built for. */
export function dynamicPath(
  kind: Kind,
  sentence: string,
  ctx: PathContext = {},
): Pick<DynamicElement, 'path' | 'speed' | 'pauseSeconds'> {
  const [cx, , cz] = ctx.centre ?? [0, 0, -3];
  const line = (z: number, x: number, y = 0): Vec3[] => [
    [-x, y, z],
    [x, y, z],
  ];
  const rtl = FROM_RIGHT.test(sentence);
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
    case 'creature': {
      const big = BIG_CREATURE.test(sentence);
      // behind the actors, on the ground: 6-10 m out (a big one ~10 m), never on top of them
      const z = Math.min(cz - (big ? 7 : 4), big ? -9 : -6);
      const moving = MOTION_RE.test(sentence);
      if (!moving && STAND_RE.test(sentence))
        // standing a little off to the side, turned across the view (side-on reads best)
        return {
          path: parkedAt([cx + (big ? 6 : 4), 0, z], [cx + 100, 0, z]),
          speed: 0,
          pauseSeconds: 0,
        };
      const speed = RUN_RE.test(sentence) ? 4 : big ? 3 : 2.5;
      if (TOWARD_RE.test(sentence))
        return { path: [r3([cx + 3, 0, -45]), r3([cx + 2, 0, cz - 5])], speed, pauseSeconds: 3 };
      const span = big ? 16 : 12;
      const path: Vec3[] = [r3([cx - span, 0, z]), r3([cx + span, 0, z])];
      return { path: rtl ? path.reverse() : path, speed, pauseSeconds: 3 };
    }
    case 'airplane': {
      const low = LOW_RE.test(sentence);
      const y = low ? 22 : 34;
      if (/\b(takes? off|taking off|lifts? off|climbs? (?:out|away))\b/i.test(sentence))
        return {
          path: [
            r3([cx - 60, 0, cz - 45]),
            r3([cx - 10, 0, cz - 45]),
            r3([cx + 40, 12, cz - 45]),
            r3([cx + 150, 45, cz - 45]),
          ],
          speed: 25,
          pauseSeconds: 4,
        };
      if (/\b(lands?|landing|touch(?:es)? down|comes? in to land|descends?)\b/i.test(sentence))
        return {
          path: [
            r3([cx - 150, 40, cz - 45]),
            r3([cx - 30, 6, cz - 45]),
            r3([cx + 10, 0, cz - 45]),
            r3([cx + 60, 0, cz - 45]),
          ],
          speed: 25,
          pauseSeconds: 4,
        };
      if (
        /\b(parked|sits on|on the (?:tarmac|runway|apron)|grounded)\b/i.test(sentence) &&
        !MOTION_RE.test(sentence)
      )
        return {
          path: parkedAt([cx + 8, 0, cz - 40], [cx + 100, 0, cz - 40]),
          speed: 0,
          pauseSeconds: 0,
        };
      if (OVER_RE.test(sentence)) {
        // along the view: from the horizon ahead, over the actors' heads, away behind the camera
        const path: Vec3[] = [r3([cx - 40, y + 2, cz - 147]), r3([cx + 20, y, cz + 63])];
        return { path: rtl ? path.reverse() : path, speed: 25, pauseSeconds: 4 };
      }
      // straight across the sky, well out
      const path: Vec3[] = [r3([cx - 150, y, cz - 77]), r3([cx + 150, y + 3, cz - 77])];
      return { path: rtl ? path.reverse() : path, speed: 25, pauseSeconds: 4 };
    }
    case 'helicopter': {
      const y = LOW_RE.test(sentence) ? 10 : /\bhigh\b/i.test(sentence) ? 18 : 12;
      if (/\bhover\w*|\bhangs?\b|\bholds? (?:station|position)\b/i.test(sentence)) {
        // hovering off to one side, nose turned three-quarters toward the camera
        const at: Vec3 = [cx + 5, y, cz - 22];
        const a = Math.atan2(-at[0], -at[2]) + 0.9;
        return {
          path: parkedAt(at, [at[0] + Math.sin(a), y, at[2] + Math.cos(a)]),
          speed: 0,
          pauseSeconds: 0,
        };
      }
      if (/\b(circl\w*|orbit\w*|loops?)\b/i.test(sentence))
        return {
          path: ring([cx, Math.max(y, 15), cz - 30], 25, 18, 1.5),
          speed: 12,
          pauseSeconds: 0,
        };
      if (/\b(lands?|landing|touch(?:es)? down|sets? down)\b/i.test(sentence))
        return {
          path: [r3([cx + 60, 18, cz - 40]), r3([cx + 18, 6, cz - 26]), r3([cx + 10, 0, cz - 22])],
          speed: 6,
          pauseSeconds: 6,
        };
      if (/\b(takes? off|taking off|lifts? off)\b/i.test(sentence))
        return {
          path: [r3([cx + 10, 0, cz - 22]), r3([cx + 14, 8, cz - 26]), r3([cx + 70, 22, cz - 45])],
          speed: 6,
          pauseSeconds: 6,
        };
      if (OVER_RE.test(sentence)) {
        const path: Vec3[] = [r3([cx - 15, y + 2, cz - 117]), r3([cx + 10, y, cz + 43])];
        return { path: rtl ? path.reverse() : path, speed: 12, pauseSeconds: 3 };
      }
      const path: Vec3[] = [r3([cx - 100, y, cz - 30]), r3([cx + 100, y, cz - 30])];
      return { path: rtl ? path.reverse() : path, speed: 12, pauseSeconds: 3 };
    }
    default:
      // birds circle overhead: a closed ring, 6 m radius, ~8 m up, centred 9 m out
      return { path: ring([0, 8, -9], 6, 6, 0.6), speed: 6, pauseSeconds: 0 };
  }
}

/** Kinds a sentence may add more than once per scene (two creatures, a jet and a biplane). */
const REPEATABLE = new Set<Kind>(['creature', 'airplane', 'helicopter']);
const MAX_PER_KIND = 4;

/** The offline parser's background action: one element per moving thing the action lines name. */
export function detectDynamics(
  action: string[],
  sceneIndex: number,
  blocking: readonly Pick<Blocking, 'position'>[] = [],
): DynamicElement[] {
  const out: DynamicElement[] = [];
  const all = sentences(action);
  const wagon = DYNAMIC_WORDS.find((w) => w.kind === 'wagon')!.re;
  const centre = sceneCentre(blocking);
  for (const { kind, re } of DYNAMIC_WORDS) {
    // a creature that only stands there is still in the scene ("a brachiosaurus grazes")
    const hits = all.filter(
      (s) =>
        re.test(s) &&
        (MOTION_RE.test(s) || (kind === 'creature' && STAND_RE.test(s))) &&
        // a wagon's team is part of the wagon prop, not a second horse
        !(kind === 'horse' && wagon.test(s)),
    );
    const take = REPEATABLE.has(kind) ? hits.slice(0, MAX_PER_KIND) : hits.slice(0, 1);
    take.forEach((hit, k) => {
      const label = hit.length > 120 ? `${hit.slice(0, 117)}...` : hit;
      out.push({
        id: `s${sceneIndex + 1}-${kind}${k ? `-${k + 1}` : ''}`,
        kind,
        label,
        ...dynamicPath(kind, hit, { centre }),
        loop: true,
        scale: 1,
      });
    });
  }
  return out;
}

/** The kinds and what each covers, for the Claude planners. */
export const DYNAMIC_KINDS_TEXT =
  'car, bus (also a tram or streetcar; a train is a bus or truck, say so in the label), truck, motorcycle, bicycle, pedestrian, bird, dog, horse (the label says "rider" when ridden), wagon (a horse-drawn cart or stagecoach; its horses belong to it), boat (any vessel on water), dragon, drone, spacecraft, airplane (any fixed-wing aircraft: airliner, jet, fighter, biplane, propeller plane, seaplane), helicopter, creature (any other animal or monster: dinosaur, t-rex, raptor, triceratops, elephant, giraffe, bear, wolf pack, deer, lion, tiger, cow, sheep, goat, cat, kangaroo, troll, ogre, giant …), generic (anything else)';

/** Path rules for the kinds this module shapes, as the Claude planners read them. */
export const DYNAMIC_PATHS_TEXT = `- Creatures walk on the ground (y = 0) behind the actors, 6-10 m out (z between -6 and -10; a big one such as a dinosaur, an elephant or a giant 9-10 m out), on a straight path across the view, x from about -12 to 12 (-16 to 16 for big ones), speed 2-4 (2.5 walking, a dinosaur 3, running 4), pause 3. One that stands, grazes or watches: a single point there (or two points 5 cm apart to turn it), speed 0.
- Airplanes fly 20-40 m up (low overhead 20-25), speed 25, pause 4, on a straight path about 300 m long: across the sky (z about -80, x from -150 to 150), or for "overhead" along the view over the actors' heads (from about (-40, y, -150) to (20, y, 60)). A take-off or a landing reaches y = 0 on a runway 40-50 m out.
- Helicopters fly 10-20 m up at 12 m/s: straight across (z about -30, x from -100 to 100), along the view for "overhead", or a closed loop for circling. A hovering helicopter is a single point 10-20 m up and 15-25 m out (e.g. (5, 12, -25)), speed 0.`;
