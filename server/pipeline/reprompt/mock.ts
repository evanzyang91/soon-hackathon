// Offline keyword planner (MOCK=1, or no ANTHROPIC_API_KEY): deterministic, good enough for tests
// and demos. It fills the same Draft as Claude, so draft.ts applies the same scope rules.
//
//   colour word + object             → splat-region recolour (target from the selection, else needsTarget)
//   hide/remove + non-prop object    → splat-region opacity 0
//   move/closer/bigger/smaller + actor or prop name → transform
//   warmer/cooler/darker/brighter/night/day/contrast/… → look patch
//   sky/weather/season/snow/…        → world-regen (pano-inpaint when the panorama exists)
//   add/remove + prop kind           → prop (any kind dynamics.ts names: "add a dinosaur walking by",
//                                      "add an airplane flying low overhead", "add a helicopter
//                                      hovering over the street"; moving ones get its standard path
//                                      near the actors, a hover / a standing animal is parked there)
//   vague ("the thing on the left")  → clarify
import type { DynamicElement, Quat, Vec3 } from '../../../shared/schema.ts';
import { DYNAMIC_WORDS, dynamicPath, kindForWords, MOTION_RE, sceneCentre } from '../dynamics.ts';
import type { ActorInfo, PropInfo, SceneContext } from './context.ts';
import { emptyDraft, type Draft, type LookNumeric, type Point, type Selection } from './draft.ts';

export const COLOR_WORDS: Record<string, string> = {
  red: '#d0312d',
  crimson: '#b0172e',
  blue: '#2e6bd6',
  navy: '#1f3a7a',
  teal: '#1f8a8a',
  cyan: '#22b8cf',
  green: '#2e9b57',
  yellow: '#f2c230',
  gold: '#d4a017',
  orange: '#e67e22',
  purple: '#7d4bb3',
  violet: '#8a4fd6',
  magenta: '#c0389b',
  pink: '#e58fb0',
  white: '#f2f2f2',
  black: '#1e1e1e',
  grey: '#808080',
  gray: '#808080',
  brown: '#7a5232',
};

/** Hover / stand words: the prop is parked where it is (at its height), not driven along a path. */
const PARKED_RE = /\b(hover\w*|hangs?|parked|park it|standing|stands|sits|sitting|grazing|grazes|waiting|leaning|lying)\b/;

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  half: 0.5,
};
const P = (v: Vec3): Point => ({ x: v[0], y: v[1], z: v[2] });
const ZERO: Point = { x: 0, y: 0, z: 0 };

/** "a metre", "2 m", "half a meter", "30 cm" → metres (default when none is given). */
export function parseDistance(text: string, fallback = 1): number {
  const t = text.toLowerCase();
  const cm = /(\d+(?:\.\d+)?)\s*(cm|centimet(?:er|re)s?)\b/.exec(t);
  if (cm) return Number(cm[1]) / 100;
  const num = /(\d+(?:\.\d+)?)\s*(m|met(?:er|re)s?)\b/.exec(t);
  if (num) return Number(num[1]);
  if (/\bhalf a met(?:er|re)\b/.test(t)) return 0.5;
  const word = /\b(a|an|one|two|three|four|five)\s+met(?:er|re)s?\b/.exec(t);
  if (word) return NUMBER_WORDS[word[1]!]!;
  if (/\b(a bit|a little|slightly)\b/.test(t)) return 0.5;
  return fallback;
}

/** Camera axes on the floor plane (forward, right) from a view quaternion (default: look down -Z). */
export function cameraAxes(q?: Quat): { forward: [number, number]; right: [number, number] } {
  if (!q) return { forward: [0, -1], right: [1, 0] };
  const [x, y, z, w] = q;
  // rotate (0,0,-1) and (1,0,0) by q
  const fx = -(2 * (x * z + w * y));
  const fz = -(1 - 2 * (x * x + y * y));
  const rx = 1 - 2 * (y * y + z * z);
  const rz = 2 * (x * z - w * y);
  const fl = Math.hypot(fx, fz) || 1;
  const rl = Math.hypot(rx, rz) || 1;
  return { forward: [fx / fl, fz / fl], right: [rx / rl, rz / rl] };
}

const has = (p: string, re: RegExp) => re.test(p);
const nameRe = (s: string) => new RegExp(`\\b${s.toLowerCase().replace(/[^a-z0-9]+/g, '\\W*')}\\b`);

function mentionedActors(p: string, scene: SceneContext): ActorInfo[] {
  return scene.actors
    .map((a) => {
      const m = nameRe(a.id).exec(p) ?? nameRe(a.name).exec(p);
      return m ? { a, at: m.index } : null;
    })
    .filter((x): x is { a: ActorInfo; at: number } => !!x)
    .sort((x, y) => x.at - y.at)
    .map((x) => x.a);
}

function mentionedProp(p: string, scene: SceneContext): PropInfo | undefined {
  const kind = kindForWords(p);
  if (kind) {
    // "remove the dinosaur" among several creatures: the one whose label names it
    const word = DYNAMIC_WORDS.find((w) => w.kind === kind)!.re.exec(p)?.[0] ?? kind;
    const one = /[^sui]s$/.test(word) ? word.slice(0, -1) : word;
    const ofKind = scene.props.filter((x) => x.kind === kind);
    return ofKind.find((x) => x.label.toLowerCase().includes(one)) ?? ofKind[0];
  }
  return scene.props.find((x) => p.includes(x.id.toLowerCase()));
}

function propKind(p: string): DynamicElement['kind'] | undefined {
  return kindForWords(p);
}

function colorIn(p: string): string | undefined {
  const m = Object.keys(COLOR_WORDS).find((c) => new RegExp(`\\b${c}\\b`).test(p));
  return m;
}

/** The object noun phrase of "make the bus shelter's roof red" → "bus shelter's roof". */
export function objectPhrase(p: string, colour?: string): string {
  let t = p
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/^(please\s+)?(can you\s+)?(make|paint|turn|colou?r|recolou?r|tint|change|hide|remove|delete|erase|get rid of|take away|move|shift|push|grow|shrink)\s+/, '');
  if (colour) t = t.replace(new RegExp(`\\s*(to\\s+|into\\s+)?\\b${colour}\\b.*$`), '');
  t = t.replace(/\s+(bigger|larger|smaller|taller|shorter|wider|narrower|left|right|forward|back(?:wards?)?|closer|further|farther|up|down|away)\b.*$/, '');
  t = t.replace(/^(the|a|an|that|this)\s+/, '').trim();
  return t || 'object';
}

/** Look changes relative to the current look. */
function lookDraft(p: string, scene: SceneContext): Draft['look'] | null {
  const l = emptyDraft().look;
  const cur = scene.look;
  const set = (param: LookNumeric, value: number) => {
    const i = l.set.findIndex((s) => s.param === param);
    if (i >= 0) l.set[i] = { param, value };
    else l.set.push({ param, value });
  };
  const much = has(p, /\b(much|a lot|way|very)\b/) ? 2 : has(p, /\b(slightly|a bit|a little|touch)\b/) ? 0.5 : 1;
  if (has(p, /\bwarm(er|th)?\b/)) set('temperature', cur.temperature + 0.3 * much);
  if (has(p, /\b(cool(er)?|cold(er)?|colder)\b/) && !has(p, /\bcool down\b/)) set('temperature', cur.temperature - 0.3 * much);
  if (has(p, /\b(darker|dim(mer)?|underexpos)/)) set('exposure', cur.exposure - 0.5 * much);
  if (has(p, /\b(brighter|lighter|brighten|overexpos)/)) set('exposure', cur.exposure + 0.5 * much);
  if (has(p, /\b(more|higher|punchier|increase)\b[^.]*\bcontrast\b|\bcontrast(y)?\b(?![^.]*\b(less|lower)\b)/) && !has(p, /\b(less|lower|reduce)\b[^.]*contrast/))
    set('contrast', cur.contrast + 0.25 * much);
  if (has(p, /\b(less|lower|reduce|softer)\b[^.]*\bcontrast\b|\bflat(ter)?\b/)) set('contrast', cur.contrast - 0.2 * much);
  if (has(p, /\b(more saturated|saturat(e|ion) up|vivid|more colou?rful)\b/)) set('saturation', cur.saturation + 0.3 * much);
  if (has(p, /\b(desaturat|less saturated|muted|washed out)/)) set('saturation', cur.saturation - 0.35 * much);
  if (has(p, /\bvignette\b/)) set('vignette', Math.max(cur.vignette, 0.45));
  if (has(p, /\b(grain|grainy|film look)\b/)) set('grain', Math.max(cur.grain, 0.35));
  if (has(p, /\b(bloom|glow(y)?)\b/)) set('bloom', Math.max(cur.bloom, 0.4));
  if (has(p, /\b(fog|foggy|mist(y)?|haz(e|y))\b/)) {
    set('fogDensity', Math.max(cur.fog.density, 0.35));
  }
  if (has(p, /\bnight\b/)) {
    set('exposure', cur.exposure - 0.7);
    set('temperature', cur.temperature - 0.3);
    l.lut = 'cool-night';
    l.name = 'Night';
  } else if (has(p, /\b(day|daytime|daylight)\b/)) {
    set('exposure', cur.exposure + 0.4);
    set('temperature', cur.temperature + 0.1);
    l.lut = 'neutral';
    l.name = 'Day';
  }
  if (has(p, /\bnoir\b|black and white|monochrome/)) {
    l.lut = 'noir';
    set('saturation', 0.1);
    l.name = 'Noir';
  }
  if (has(p, /\bmoody\b/)) {
    set('contrast', cur.contrast + 0.2);
    set('vignette', Math.max(cur.vignette, 0.35));
  }
  if (has(p, /\b(golden hour|golden)\b/)) l.lut = 'golden';
  if (has(p, /\b(teal and orange|teal-orange|blockbuster)\b/)) l.lut = 'teal-orange';
  if (has(p, /\b(depth of field|shallow focus|bokeh)\b/)) l.depthOfField = 'on';
  const light = /\b(key|fill|rim|back)?\s*light\b/.exec(p);
  if (light && has(p, /\badd\b/)) {
    const side = has(p, /\bleft\b/) ? -1 : has(p, /\bright\b/) ? 1 : 0;
    const name = light[1] ? `${light[1][0]!.toUpperCase()}${light[1].slice(1)}` : 'Key';
    const colour = colorIn(p);
    l.addLights.push({
      name,
      kind: 'spot',
      position: { x: side * 2.5, y: 2.6, z: -1 },
      target: { x: 0, y: 1.2, z: -3 },
      color: colour ? COLOR_WORDS[colour]! : has(p, /\bwarm\b/) ? '#ffd2a0' : '#ffffff',
      intensity: 2,
      radius: 8,
      coneDeg: 50,
    });
  }
  const touched = l.set.length || l.colors.length || l.lut !== 'unchanged' || l.depthOfField !== 'unchanged' || l.addLights.length;
  return touched ? l : null;
}

const REGEN_ENV = /\b(sky|skies|weather|season|snow\w*|winter\w*|summer\w*|autumn\w*|fall leaves|spring\s*time|storm\w*|thunder\w*|cloud\w*|overcast|sunset|sunrise|dawn sky|stars|starry|aurora|desert|rain(y|ing)?|puddles)\b/;
const REGEN_TEXT = /\b(turn|transform|change|make)\b.*\b(into|to look like)\b|\bdifferent (place|location|world|set)\b/;
const VAGUE = /\b(thing|things|stuff|something|whatever|that one)\b/;
const ADD = /\b(add|put|place|park|bring in|spawn|drop in)\b/;
const REMOVE = /\b(remove|delete|get rid of|take away|take out|hide|erase|lose)\b/;
const MOVE = /\b(move|closer|nearer|further|farther|away from|towards?|shift|push|slide|step)\b/;
const SIZE_UP = /\b(bigger|larger|taller|grow|enlarge|scale up)\b/;
const SIZE_DOWN = /\b(smaller|shorter|shrink|scale down|tiny)\b/;
const TURN = /\b(rotate|turn around|turn to|face|facing)\b/;

/** Keyword planner: prompt + scene → Draft (then draftToPlan applies the rules). */
export function mockDraft(prompt: string, scene: SceneContext, o: { selection?: Selection; viewQuaternion?: Quat } = {}): Draft {
  const p = prompt.toLowerCase().trim();
  const d = emptyDraft('clarify');
  const actors = mentionedActors(p, scene);
  const prop = mentionedProp(p, scene);
  const kind = propKind(p);
  const colour = colorIn(p);
  const look = lookDraft(p, scene);
  const axes = cameraAxes(o.viewQuaternion);

  // vague reference with nothing concrete to hold on to
  if (VAGUE.test(p) && !actors.length && !kind && !colour && !look && !o.selection) {
    d.summary = 'The prompt does not say which object.';
    d.question = 'Which one do you mean? Click it in the viewport or name it.';
    return d;
  }

  // sky / weather / season / a different place → world regeneration (tinting the sky is a look)
  const tintSky = /\btint\b.*\bsky\b|\bsky\b.*\btint\b/.test(p);
  if (!tintSky && (REGEN_ENV.test(p) || REGEN_TEXT.test(p)) && !actors.length && !(kind && (ADD.test(p) || REMOVE.test(p)))) {
    const env = REGEN_ENV.test(p) && !REGEN_TEXT.test(p);
    d.scope = 'world-regen';
    const change = prompt.trim().replace(/^(please\s+)?(make|turn)\s+(it|the scene|the world)\s+/i, '').replace(/[.!]+$/, '');
    d.summary = `Regenerate the world for “${change}”: the whole environment changes, which a grade or a region edit cannot do.`;
    d.regen = {
      environmental: env,
      imageEdit: env ? `Edit this 360° panorama: ${prompt.trim().replace(/[.!]+$/, '')}. Keep the layout, buildings, street and objects exactly where they are; change only the environment.` : '',
      worldPrompt: `${scene.world.prompt.replace(/\s+$/, '')} Change: ${prompt.trim()}`,
    };
    return d;
  }
  if (tintSky) {
    const l = emptyDraft().look;
    l.colors.push({ param: 'skyTintColor', hex: colour ? COLOR_WORDS[colour]! : '#ffb070' });
    l.set.push({ param: 'skyTintStrength', value: 0.6 });
    d.scope = 'look';
    d.look = l;
    d.summary = `Tint the sky ${colour ?? 'warm'} (look only). The world itself does not change.`;
    return d;
  }

  // add / remove props
  if (kind && ADD.test(p)) {
    const parked = PARKED_RE.test(p);
    // an airplane flies unless it is parked; a helicopter hovers unless it moves
    const moving = !parked && (MOTION_RE.test(p) || /\bacross\b/.test(p) || kind === 'airplane');
    const centre = sceneCentre(scene.actors);
    // the director's words are the label: the viewer builds the body from them ("a dinosaur …")
    const label =
      prompt
        .trim()
        .replace(/[.!]+$/, '')
        .replace(/^(?:please\s+)?(?:can you\s+)?(?:add|put|place|park|bring in|spawn|drop in)\s+/i, '')
        .slice(0, 80) || kind;
    const start: Vec3 = [scene.actors[0] ? scene.actors[0].position[0] + 1.8 : 1.5, 0, (scene.actors[0]?.position[2] ?? -3) - 0.8];
    // aircraft and animals hover / stand where their standard path puts them; the rest by the actors
    const placed = !moving && (kind === 'helicopter' || kind === 'airplane' || (kind === 'creature' && parked));
    const std = dynamicPath(kind, p, { centre });
    const path = moving || placed ? std.path.map(P) : [P(start), P([start[0] + axes.right[0], 0, start[2] + axes.right[1]])];
    d.scope = 'prop';
    d.props.push({ action: 'add', elementId: '', kind, label, path, moving, speed: moving ? std.speed : 0, scale: 1 });
    d.summary = `Add ${/^(a|an|the|some|two|three)\b/i.test(label) ? '' : 'a '}${label}${o.selection?.point ? ' where you clicked' : ''} (a procedural prop). Nothing else changes.`;
    return d;
  }
  if (prop && REMOVE.test(p) && !actors.length) {
    d.scope = 'prop';
    d.props.push({ action: 'remove', elementId: prop.id, kind: prop.kind as DynamicElement['kind'], label: prop.label, path: [], moving: false, speed: 0, scale: 1 });
    d.summary = `Remove “${prop.label.replace(/[.!]+$/, '')}”. Nothing else changes.`;
    return d;
  }

  // transforms of actors / props
  const subject: { type: 'actor' | 'prop'; id: string; position: Vec3; name: string } | null = actors[0]
    ? { type: 'actor', id: actors[0].id, position: actors[0].position, name: actors[0].name }
    : prop && (MOVE.test(p) || SIZE_UP.test(p) || SIZE_DOWN.test(p) || TURN.test(p))
      ? { type: 'prop', id: prop.id, position: prop.position, name: prop.label }
      : null;
  if (subject && (MOVE.test(p) || SIZE_UP.test(p) || SIZE_DOWN.test(p) || TURN.test(p) || /\b(left|right)\b/.test(p))) {
    const t: Draft['transforms'][number] = {
      targetType: subject.type,
      targetId: subject.id,
      move: 'none',
      point: ZERO,
      turn: 'none',
      yawDeg: 0,
      facePoint: ZERO,
      scale: 1,
    };
    const dist = parseDistance(p);
    const other = actors[1];
    let what = '';
    if (other && /\b(closer|nearer|towards?|next to|up to)\b/.test(p)) {
      const dx = other.position[0] - subject.position[0];
      const dz = other.position[2] - subject.position[2];
      const gap = Math.hypot(dx, dz) || 1;
      const step = Math.min(dist, Math.max(0, gap - 0.5)); // never closer than 0.5 m
      t.move = 'by';
      t.point = { x: (dx / gap) * step, y: 0, z: (dz / gap) * step };
      t.turn = 'face';
      t.facePoint = P(other.position);
      what = `Move ${subject.name} ${step.toFixed(1)} m closer to ${other.name}, facing them`;
    } else if (other && /\b(away from|further from|farther from)\b/.test(p)) {
      const dx = subject.position[0] - other.position[0];
      const dz = subject.position[2] - other.position[2];
      const gap = Math.hypot(dx, dz) || 1;
      t.move = 'by';
      t.point = { x: (dx / gap) * dist, y: 0, z: (dz / gap) * dist };
      what = `Move ${subject.name} ${dist.toFixed(1)} m away from ${other.name}`;
    } else if (/\b(left|right|forward|back(wards?)?|closer|further|farther|away)\b/.test(p) && MOVE.test(p) || /\b(left|right)\b/.test(p)) {
      let dir: [number, number] = [0, 0];
      if (/\bleft\b/.test(p)) dir = [-axes.right[0], -axes.right[1]];
      else if (/\bright\b/.test(p)) dir = axes.right;
      else if (/\b(forward|away|further|farther|back(?!wards? to))\b/.test(p) && !/\b(closer|toward)/.test(p)) dir = axes.forward;
      else if (/\b(closer|toward|backwards?)\b/.test(p)) dir = [-axes.forward[0], -axes.forward[1]];
      if (dir[0] || dir[1]) {
        t.move = 'by';
        t.point = { x: dir[0] * dist, y: 0, z: dir[1] * dist };
        what = `Move ${subject.name} ${dist.toFixed(1)} m`;
      }
    }
    if (SIZE_UP.test(p)) [t.scale, what] = [has(p, /\b(much|a lot|way)\b/) ? 1.6 : 1.3, what || `Make ${subject.name} bigger`];
    if (SIZE_DOWN.test(p)) [t.scale, what] = [has(p, /\b(much|a lot|way)\b/) ? 0.6 : 0.75, what || `Make ${subject.name} smaller`];
    if (/\bturn around\b/.test(p)) [t.turn, t.yawDeg, what] = ['yaw', 0, what || `Turn ${subject.name} around`];
    if (t.move !== 'none' || t.turn !== 'none' || t.scale !== 1) {
      d.scope = 'transform';
      d.transforms.push(t);
      d.summary = `${what}. Nothing else changes.`;
      return d;
    }
  }

  // splat regions: recolour / hide / move / scale a named object in the world
  const obj = objectPhrase(prompt, colour);
  const regionVerb = colour || REMOVE.test(p) || (MOVE.test(p) && !actors.length) || SIZE_UP.test(p) || SIZE_DOWN.test(p);
  if (regionVerb && !look?.set.length && obj !== 'object' && !VAGUE.test(obj)) {
    const r: Draft['regions'][number] = { label: obj, colorMode: 'none', colorHex: '', strength: 1, hide: false, moveBy: ZERO, scale: 1 };
    let what = '';
    if (colour) [r.colorMode, r.colorHex, what] = ['hue', COLOR_WORDS[colour]!, `Recolour the ${obj} ${colour}`];
    if (REMOVE.test(p)) [r.hide, what] = [true, `Remove the ${obj}`];
    if (MOVE.test(p) && !colour && !REMOVE.test(p)) {
      const dist = parseDistance(p, 0.5);
      let dir: [number, number] = axes.right;
      if (/\bleft\b/.test(p)) dir = [-axes.right[0], -axes.right[1]];
      else if (/\b(back|away|further|farther)\b/.test(p)) dir = axes.forward;
      else if (/\b(closer|forward|toward)\b/.test(p)) dir = [-axes.forward[0], -axes.forward[1]];
      const up = /\bup\b/.test(p) ? dist : /\bdown\b/.test(p) ? -dist : 0;
      r.moveBy = up ? { x: 0, y: up, z: 0 } : { x: dir[0] * dist, y: 0, z: dir[1] * dist };
      what = `Shift the ${obj} ${dist.toFixed(1)} m`;
    }
    if (SIZE_UP.test(p)) [r.scale, what] = [1.25, `Make the ${obj} bigger`];
    if (SIZE_DOWN.test(p)) [r.scale, what] = [0.8, `Make the ${obj} smaller`];
    d.scope = 'splat-region';
    d.regions.push(r);
    d.summary = `${what} (one region of the world). Nothing else changes.`;
    return d;
  }

  if (look) {
    d.scope = 'look';
    d.look = look;
    const said: string[] = [...look.set.map((s) => s.param as string), ...(look.lut !== 'unchanged' ? [`${look.lut} LUT`] : [])];
    d.summary = `Adjust the look (${[...new Set(said)].join(', ') || 'lights'}). The world, actors and props do not change.`;
    return d;
  }

  d.summary = 'Nothing in the prompt matched an actor, prop, object or look setting.';
  d.question = 'What should change? Name an actor, a prop or an object (or click it), or describe the look.';
  return d;
}
