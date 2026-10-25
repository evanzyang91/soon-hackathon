// Which procedural mock set (fixtures/mock-world/<set>/, built by mock-world.ts) a scene gets in
// MOCK mode and under MARBLE_DRY_RUN, so a fantasy clearing is reviewed in a forest and a throne
// hall in a stone hall instead of everything on the same concrete street.
//
// The heading decides first: its keywords are tried against the rules below in order, and the
// first rule that fits the scene's interior flag wins. Order matters where a heading names two
// places ("LUNAR LANDING FIELD" is the moon, not a meadow; "FARMHOUSE CELLAR" is the cellar). Only
// a heading with no keyword falls back to the world prompt, which is long and photographic, so a
// stray word ("depth of field", "a two-lane road") must not move the scene: there a set needs at
// least two keyword hits. Nothing matched: interior → room, exterior → street, nudged by the
// screenplay's style (a sci-fi interior is a station deck, a fantasy / western / period exterior
// a village lane).
import type { ScenePlan, VisualStyle } from '../../shared/schema.ts';

export const MOCK_SETS = [
  'street',
  'forest',
  'hall',
  'cave',
  'desert',
  'station',
  'shore',
  'village',
  'room',
  'field',
] as const;
export type MockSet = (typeof MOCK_SETS)[number];
/** The original mock stage; what a caller that names no set gets. */
export const DEFAULT_MOCK_SET: MockSet = 'street';

export const isMockSet = (s: unknown): s is MockSet =>
  typeof s === 'string' && (MOCK_SETS as readonly string[]).includes(s);

/** WorldAsset.caption of a mock world. */
export const mockSetCaption = (set: MockSet) => `mock set: ${set}`;

/** The set named by a mock world's caption (undefined for a Marble caption or none). */
export function mockSetFromCaption(caption: string | undefined): MockSet | undefined {
  const m = /^mock set: ([a-z]+)$/.exec(caption ?? '');
  return m && isMockSet(m[1]) ? m[1] : undefined;
}

type Where = 'interior' | 'exterior' | 'any';
interface Rule {
  set: MockSet;
  /** Which scenes the rule may route: "INT. BEACH HOUSE" is a room, not the shore. */
  where: Where;
  words: string[];
  /**
   * Words that mean a ship's deck only in science fiction ("INT. HOSPITAL CORRIDOR" in a
   * contemporary drama is not a station): skipped when the style says another genre.
   */
  sciFiOnly?: boolean;
}

// Contemporary buildings called "station" are not a space station.
const STATION = String.raw`(?<!\b(?:police|train|gas|fire|bus|petrol|subway|railway|rail|metro|tube|radio|tv|service|filling|polling|weather|ranger|pumping|power|coach|way)[\s-])stations?`;

const RULES: readonly Rule[] = [
  {
    set: 'station',
    where: 'any',
    words: [
      STATION,
      'spaceships?',
      'starships?',
      'spacecraft',
      'spaceports?',
      'starbase',
      'space ?docks?',
      'motherships?',
      'shuttle ?bays?',
      'shuttles?',
      'hangars?',
      'airlocks?',
      'orbital',
      'orbit',
      'cryo(?:genic)? ?bay',
      "ship's bridge",
      'bridge of the ship',
    ],
  },
  {
    set: 'cave',
    where: 'any',
    words: [
      'caves?',
      'caverns?',
      'grottos?',
      'grottoes',
      'mines?',
      'mine ?shafts?',
      'tunnels?',
      'crypts?',
      'catacombs?',
      'cellars?',
      'sewers?',
      'underground',
      'lair',
      'burrow',
    ],
  },
  {
    set: 'hall',
    where: 'interior',
    words: [
      'halls?',
      'great hall',
      'throne(?: room)?',
      'ballrooms?',
      'churche?s?',
      'cathedrals?',
      'chapels?',
      'temples?',
      'dungeons?',
      'palaces?',
      'castles?',
      'abbey',
      'monastery',
      'mosque',
      'synagogue',
      'shrine',
      'basilica',
      'citadel',
      'banquet(?:ing)?',
    ],
  },
  {
    set: 'forest',
    where: 'exterior',
    words: [
      'forests?',
      'woods',
      'woodlands?',
      'groves?',
      'glades?',
      'jungles?',
      'clearing',
      'thickets?',
      'rainforests?',
      'copse',
      'orchards?',
    ],
  },
  {
    set: 'desert',
    where: 'exterior',
    words: [
      'deserts?',
      'dunes?',
      'canyons?',
      'wasteland',
      'wastes',
      'mesas?',
      'badlands',
      'regolith',
      'lunar',
      'moonscape',
      'moon ?base',
      "moon(?:'s)? surface",
      'surface of the moon',
      'martian',
      'mars',
      'craters?',
      'salt flats?',
      'outback',
      'sahara',
      'oasis',
      'alien (?:planet|world|landscape|surface)',
      'planet surface',
    ],
  },
  {
    set: 'shore',
    where: 'exterior',
    words: [
      'beach(?:es)?',
      'shores?',
      'shoreline',
      'harbou?rs?',
      'docks?',
      'dockside',
      'piers?',
      'lakes?',
      'lakeside',
      'lakeshore',
      'rivers?',
      'riverbank',
      'riverside',
      'seas?',
      'seaside',
      'seafront',
      'coast',
      'coastline',
      'coastal',
      'oceans?',
      'oceanside',
      'waterfront',
      'jett(?:y|ies)',
      'wharf',
      'marina',
      'lagoon',
      'islands?',
      'coves?',
      'bay',
      'ships?',
      'boats?',
      'ferry',
      'yacht',
      'sailboat',
    ],
  },
  {
    set: 'field',
    where: 'exterior',
    words: [
      'fields?',
      'meadows?',
      'farms?',
      'farmhouse',
      'farmland',
      'farmyard',
      'cornfields?',
      'wheat ?fields?',
      'hayfields?',
      'plains?',
      'moors?',
      'moorland',
      'pastures?',
      'prairie',
      'ranch',
      'countryside',
      'steppe',
      'heath',
      'vineyards?',
      'battlefield',
      'airfield',
      'paddock',
      'hillside',
      'cemetery',
      'graveyard',
      'churchyard',
    ],
  },
  {
    set: 'village',
    where: 'exterior',
    words: [
      'villages?',
      'market(?:place)?s?',
      'bazaar',
      'squares?',
      'main street',
      'high street',
      'towns?',
      'township',
      'hamlet',
      'saloon',
      'courtyards?',
      'plazas?',
      'piazza',
      'lanes?',
      'frontier',
      'boardwalk',
      'stables?',
      'livery',
      // the outside of a castle, palace or temple: a medieval lane, not a modern street
      'castles?',
      'palaces?',
      'churche?s?',
      'cathedrals?',
      'chapels?',
      'temples?',
      'abbey',
      'monastery',
      'forts?',
      'fortress',
      'citadel',
    ],
  },
  {
    set: 'station',
    where: 'interior',
    sciFiOnly: true,
    words: [
      'corridors?',
      'decks?',
      'bridge',
      'labs?',
      'laboratory',
      'bunker',
      'reactor',
      'engine room',
      'control room',
      'command (?:center|centre|deck)',
      'cockpit',
      'cargo hold',
    ],
  },
];

const compiled = RULES.map((r) => {
  const src = String.raw`\b(?:${r.words.join('|')})\b`;
  return { ...r, test: new RegExp(src, 'i'), all: new RegExp(src, 'gi') };
});

/** Photographic phrases that contain a keyword without naming a place. */
const NOT_PLACES =
  /\b(?:depth[- ]of[- ]field|field[- ]of[- ]view|two[- ]lane|four[- ]lane|one[- ]lane)\b/gi;

type StyleKind = 'sci-fi' | 'old-world' | 'other';

/** Coarse genre of the screenplay's style, from its free-text fields. */
export function styleKind(style?: VisualStyle): StyleKind | undefined {
  if (!style) return undefined;
  const text = `${style.genre} ${style.era} ${style.worldStyle}`;
  if (
    /\b(?:sci-?fi|science[- ]fiction|space|spacefaring|futur\w*|cyberpunk|orbital|starships?|interstellar|galactic|dystopian)\b/i.test(
      text,
    )
  )
    return 'sci-fi';
  if (
    /\b(?:fantasy|medieval|middle ages|western|frontier|wild west|period|victorian|edwardian|regency|georgian|elizabethan|renaissance|ancient|mytholog\w*|mythic|viking|feudal|samurai|fairy[- ]?tale|sword|1[5-8]\d\ds?|1[5-8]th century)\b/i.test(
      text,
    )
  )
    return 'old-world';
  return 'other';
}

/** The mock set that fits a scene (see the header for the rule). */
export function pickMockSet(
  plan: Pick<ScenePlan, 'heading' | 'worldPrompt' | 'interior'>,
  style?: VisualStyle,
): MockSet {
  const kind = styleKind(style);
  const rules = compiled.filter(
    (r) =>
      (r.where === 'any' || (r.where === 'interior') === plan.interior) &&
      !(r.sciFiOnly && kind !== undefined && kind !== 'sci-fi'),
  );
  const byHeading = rules.find((r) => r.test.test(plan.heading));
  if (byHeading) return byHeading.set;
  const prompt = plan.worldPrompt.replace(NOT_PLACES, ' ');
  let best: MockSet | undefined;
  let hits = 1; // a set needs two hits in the prompt
  for (const r of rules) {
    const n = prompt.match(r.all)?.length ?? 0;
    if (n > hits) [best, hits] = [r.set, n];
  }
  if (best) return best;
  if (plan.interior) return kind === 'sci-fi' ? 'station' : 'room';
  return kind === 'old-world' ? 'village' : 'street';
}
