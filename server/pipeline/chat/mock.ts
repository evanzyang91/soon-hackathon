// Offline chat planner (MOCK=1, or no ANTHROPIC_API_KEY): deterministic keyword rules that fill
// the same ChatDraft as Claude, so draft.ts / apply.ts treat both alike. Case-insensitive; a
// character is named by its name or id. Quoted text ('…', "…", ‘…’, “…”) is the new line and never
// triggers a rule.
//
//   make <Name> taller|shorter                → heightMeters ± 0.10 (from 1.70 when unset)
//   make <Name> older|younger|<adjective> …   → description += ", <adjective …>"
//   <Name> says '…' · <Name>'s line N is '…' · <Name>'s second line is '…' · line s1-l3: '…'
//                                             → the line's text (the Nth line of the character in
//                                               the named scene, else the first scene they speak in)
//   scene N is|should be|becomes <place>      → scene N-1 worldPrompt ("X, not Y" swaps Y for X)
//   <X> instead of <Y>, Y naming a heading    → that scene's worldPrompt with Y swapped for X
//   <Name>'s voice … <voice id>               → voice.id ("swap/change/another" without an id:
//                                               the next free voice of the same gender)
//   photo hint character:<id> · "this is <Name>" · "<Name> looks like this" → character-reference
//   photo hint scene:<index> · "use this for scene N" · "use this for the <heading words>"
//                                             → world-reference (pano for 360 / 2:1 photos)
//   generate | go ahead | build it | start    → generate (a draft; a generated project says so)
//   anything else                             → MOCK_FALLBACK, no action
import type { Attachment } from '../../../shared/chat.ts';
import type { Character, ScenePlan, ScreenplayPlan } from '../../../shared/schema.ts';
import { parseHeading, VOICES } from '../fountain.ts';
import { castName, listNames } from './plan-card.ts';
import { emptyDraftAction, type ChatContext, type ChatDraft, type DraftAction } from './draft.ts';
import { VOICE_CHOICES } from './patch.ts';

export const MOCK_FALLBACK =
  'I can change characters, lines and scenes, take reference photos, and start generation.';
export const MOCK_ASK_PHOTO =
  'Who or where is this photo? Say "this is <name>" or "use this for scene <number>".';

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const GENERATE = /\b(generate|go ahead|build it|start)\b/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Quoted spans of the director's text; an apostrophe inside a word ("Maya's", "don't") is not one. */
export function quotedSpans(text: string): { start: number; end: number; content: string }[] {
  const spans: { start: number; end: number; content: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const prev = i === 0 ? ' ' : text[i - 1]!;
    if (`'"‘“`.includes(ch) && /[\s:(\[—–-]/.test(prev)) {
      const closers = ch === '"' || ch === '“' ? '"”' : `'’`;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (!closers.includes(text[j]!)) continue;
        // a closing single quote is not followed by a letter (that would be an apostrophe)
        if (closers === `'’` && /[\p{L}\p{N}]/u.test(text[j + 1] ?? '')) continue;
        break;
      }
      if (j < text.length && j > i + 1) {
        spans.push({ start: i, end: j + 1, content: text.slice(i + 1, j).trim() });
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return spans;
}

/** The text with every quoted span replaced by a «Qn» token, and the quotes. */
function tokenize(text: string): { bare: string; quotes: string[] } {
  const spans = quotedSpans(text);
  const quotes: string[] = [];
  let bare = '';
  let at = 0;
  for (const s of spans) {
    bare += `${text.slice(at, s.start)} «Q${quotes.length}» `;
    quotes.push(s.content);
    at = s.end;
  }
  return { bare: bare + text.slice(at), quotes };
}

const nameAlt = (c: Character) => [...new Set([c.id, c.name, castName(c.name)])].map(esc).join('|');
const ARTICLE = /^(?:a|an|the|some)\s+/i;
const core = (s: string) => s.trim().replace(/[.!?,;]+$/, '').replace(ARTICLE, '').trim();
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Scene whose heading (or slug) holds every core word of `words` ("the kitchen" → INT. KITCHEN). */
function sceneByWords(plan: ScreenplayPlan, words: string): ScenePlan | undefined {
  const parts = core(words).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!parts.length) return undefined;
  return plan.scenes.find((s) => {
    const h = `${s.heading} ${s.slug.replace(/-/g, ' ')}`.toLowerCase();
    return parts.every((w) => new RegExp(`\\b${esc(w)}\\b`).test(h));
  });
}

/** The scene's prompt with the place swapped: "kitchen" → "diner" where it occurs, else replaced. */
export function swapPlace(scene: ScenePlan, to: string, from?: string): string {
  const target = core(to);
  const source = core(from ?? parseHeading(scene.heading).location);
  if (source) {
    const re = new RegExp(`\\b${esc(source)}\\b`, 'gi');
    if (re.test(scene.worldPrompt))
      return scene.worldPrompt.replace(re, (m) => (m[0] === m[0]!.toUpperCase() ? capitalize(target) : target));
  }
  const whole = to.trim().replace(/[.!?,;]+$/, '');
  return `${capitalize(whole)}.`;
}

function linePatch(c: Character, scene: ScenePlan, nth: number, text: string): DraftAction | string {
  const mine = scene.dialogue.filter((l) => l.characterId === c.id);
  const line = nth === -1 ? mine.at(-1) : mine[nth - 1];
  if (!line) return `${castName(c.name)} has ${mine.length} line${mine.length === 1 ? '' : 's'} in scene ${scene.index + 1}.`;
  return {
    ...emptyDraftAction('plan-patch', `${castName(c.name)}'s line ${line.id} is now "${text}"`),
    target: `line:${line.id}`,
    field: 'text',
    value: text,
  };
}

function nextVoice(plan: ScreenplayPlan, c: Character): string {
  const pool: readonly string[] = VOICES[c.voice.gender] ?? VOICES.neutral;
  const taken = new Set(plan.characters.filter((x) => x.id !== c.id).map((x) => x.voice.id));
  const start = Math.max(0, pool.indexOf(c.voice.id));
  for (let k = 1; k <= pool.length; k++) {
    const v = pool[(start + k) % pool.length]!;
    if (v !== c.voice.id && !taken.has(v)) return v;
  }
  return pool[(start + 1) % pool.length]!;
}

export function mockChatDraft(ctx: ChatContext): ChatDraft {
  const { plan } = ctx;
  const { bare, quotes } = tokenize(ctx.message.text);
  const restore = (s: string) => s.replace(/«Q(\d+)»/g, (_, k: string) => `'${quotes[Number(k)]}'`).replace(/\s+/g, ' ').trim();
  const actions: DraftAction[] = [];
  const said: string[] = [];
  const draft = !!ctx.status.draft;
  const sceneNamed = /\bscene\s+(\d+)\b/i.exec(bare);
  const scopeScene = (c: Character): ScenePlan | undefined => {
    const n = sceneNamed ? Number(sceneNamed[1]) - 1 : -1;
    if (plan.scenes[n]) return plan.scenes[n];
    return plan.scenes.find((s) => s.dialogue.some((l) => l.characterId === c.id));
  };

  for (const c of plan.characters) {
    const who = nameAlt(c);
    const name = castName(c.name);

    // make <Name> taller / older and taller / a redhead
    const make = new RegExp(`\\bmake\\s+(?:${who})\\s+(.+?)(?=[.!?;]|\\bthen\\b|«Q|$)`, 'i').exec(bare);
    if (make) {
      const items = make[1]!.split(/\s*(?:,|\band\b|&)\s*/i).map((s) => s.trim()).filter(Boolean);
      const adjectives: string[] = [];
      for (const item of items) {
        const h = /^(?:(?:a\s+(?:bit|little)|much|slightly|a\s+lot)\s+)?(taller|shorter)$/i.exec(item);
        if (h) {
          const now = c.heightMeters ?? 1.7;
          const next = Math.min(2.3, Math.max(0.9, Math.round((now + (h[1]!.toLowerCase() === 'taller' ? 0.1 : -0.1)) * 100) / 100));
          const summary = `${name} is now ${next.toFixed(2)} m`;
          actions.push({ ...emptyDraftAction('plan-patch', summary), target: `character:${c.id}`, field: 'heightMeters', value: next.toFixed(2) });
          said.push(`${summary}.`);
        } else if (!GENERATE.test(item) && !/^please$/i.test(item)) adjectives.push(item.replace(/\s+please$/i, ''));
      }
      if (adjectives.length) {
        const add = adjectives.join(', ');
        actions.push({
          ...emptyDraftAction('plan-patch', `${name} is now ${add}`),
          target: `character:${c.id}`,
          field: 'description',
          value: `${c.description.replace(/[.\s]+$/, '')}, ${add}`,
        });
        said.push(`${name}'s description now adds "${add}".`);
      }
    }

    // <Name>'s second line is '…' · <Name>'s line 2 is '…' · <Name> says '…'
    const verb = '(?:is|should be|becomes|reads|to|=|:)?';
    const ordinal = new RegExp(`\\b(?:${who})(?:'s|’s)\\s+(?:(\\d+)(?:st|nd|rd|th)?|(${ORDINALS.join('|')}|last))\\s+line\\s+${verb}\\s*«Q(\\d+)»`, 'i').exec(bare);
    const numbered = new RegExp(`\\b(?:${who})(?:'s|’s)\\s+line\\s+(\\d+)\\s*${verb}\\s*«Q(\\d+)»`, 'i').exec(bare);
    const says = new RegExp(`\\b(?:${who})\\s+(?:says|should say|says instead)\\s*:?\\s*«Q(\\d+)»`, 'i').exec(bare);
    const hit = ordinal
      ? { nth: ordinal[1] ? Number(ordinal[1]) : ordinal[2]!.toLowerCase() === 'last' ? -1 : ORDINALS.indexOf(ordinal[2]!.toLowerCase()) + 1, q: ordinal[3]! }
      : numbered
        ? { nth: Number(numbered[1]), q: numbered[2]! }
        : says
          ? { nth: 1, q: says[1]! }
          : undefined;
    if (hit) {
      const scene = scopeScene(c);
      const r = scene ? linePatch(c, scene, hit.nth, quotes[Number(hit.q)]!) : `${name} has no lines.`;
      if (typeof r === 'string') said.push(r);
      else {
        actions.push(r);
        said.push(`${r.summary}.`);
      }
    }

    // <Name>'s voice … / the voice of <Name>
    const voice =
      new RegExp(`\\b(?:${who})(?:'s|’s)\\s+voice\\b([^.!?;]*)`, 'i').exec(bare) ??
      new RegExp(`\\bvoice\\s+(?:of|for)\\s+(?:${who})\\b([^.!?;]*)`, 'i').exec(bare);
    if (voice) {
      const named = new RegExp(`\\b(${VOICE_CHOICES.map(esc).join('|')})\\b`, 'i').exec(voice[1]!);
      const wants = /\b(swap|change|different|another|new|switch)\b/i.test(bare);
      const id = named ? named[1]!.toLowerCase() : wants ? nextVoice(plan, c) : undefined;
      if (id && id !== c.voice.id) {
        const summary = `${name}'s voice is now ${id}`;
        actions.push({ ...emptyDraftAction('plan-patch', summary), target: `character:${c.id}`, field: 'voice.id', value: id });
        said.push(`${summary}.`);
      } else if (id) said.push(`${name} already has the ${id} voice.`);
    }
  }

  // line s1-l3: '…'
  for (const m of bare.matchAll(/\bline\s+(s\d+-l\d+)\s*(?:is|should be|becomes|reads|=|:)?\s*«Q(\d+)»/gi)) {
    const id = m[1]!.toLowerCase();
    if (actions.some((a) => a.target === `line:${id}`)) continue;
    const text = quotes[Number(m[2])]!;
    const summary = `Line ${id} is now "${text}"`;
    actions.push({ ...emptyDraftAction('plan-patch', summary), target: `line:${id}`, field: 'text', value: text });
    said.push(`${summary}.`);
  }

  // scene N is a diner, not a kitchen · a diner instead of the kitchen
  const sceneIs = /\bscene\s+(\d+)\s+(?:is now|is|should be|becomes|will be)\s+(.+?)(?=[.!?;]|$)/i.exec(bare);
  // X is the article-led phrase right before "instead of" ("a diner"), else its last one or two words
  const instead =
    /\b((?:an?|the|some)\s+(?:[\p{L}'-]+\s+){0,2}?[\p{L}'-]+)\s+instead\s+of\s+(.+?)(?=[.!?;,]|$)/iu.exec(bare) ??
    /\b([\p{L}'-]+(?:\s+[\p{L}'-]+)?)\s+instead\s+of\s+(.+?)(?=[.!?;,]|$)/iu.exec(bare);
  let world: { scene: ScenePlan; to: string; from?: string } | undefined;
  if (sceneIs && plan.scenes[Number(sceneIs[1]) - 1]) {
    const words = restore(sceneIs[2]!);
    const not = /^(.*?),?\s+(?:not|rather than|instead of)\s+(.+)$/i.exec(words);
    world = { scene: plan.scenes[Number(sceneIs[1]) - 1]!, to: not ? not[1]! : words, from: not?.[2] };
  } else if (instead) {
    const scene = sceneByWords(plan, instead[2]!);
    const to = instead[1]!.replace(/^(?:(?:can you|please|let'?s|i want|make it|make|use|have|do|go with)\s+)+/i, '');
    if (scene && core(to)) world = { scene, to, from: instead[2] };
  }
  if (world) {
    const prompt = swapPlace(world.scene, world.to, world.from);
    const summary = `Scene ${world.scene.index + 1} is now ${core(world.to)}`;
    actions.push({ ...emptyDraftAction('plan-patch', summary), target: `scene:${world.scene.index}`, field: 'worldPrompt', value: prompt });
    said.push(`${summary}.`);
  }

  // photos: hints first, then "this is <Name>" / "use this for …" for the next unassigned one
  const fresh: Attachment[] = [];
  const pano = (a: Attachment) => /\b(360|pano(rama)?|equirect\w*)\b/i.test(bare) || a.width === 2 * a.height;
  for (const a of ctx.message.attachments) {
    const hint = a.hint?.trim() ?? '';
    const ch = /^character:(.+)$/i.exec(hint);
    const sc = /^scene:(\d+)/i.exec(hint);
    const c = ch ? plan.characters.find((x) => x.id === ch[1] || x.name.toLowerCase() === ch[1]!.toLowerCase()) : undefined;
    if (c) {
      const summary = `${castName(c.name)} is built from this photo`;
      actions.push({ ...emptyDraftAction('character-reference', summary), target: `character:${c.id}`, attachmentId: a.id });
      said.push(`${summary}.`);
    } else if (sc && plan.scenes[Number(sc[1])]) {
      const scene = plan.scenes[Number(sc[1])]!;
      const summary = `Scene ${scene.index + 1} (${scene.heading}) uses this photo`;
      actions.push({ ...emptyDraftAction('world-reference', summary), target: `scene:${scene.index}`, attachmentId: a.id, isPano: /:pano$/i.test(hint) || pano(a) });
      said.push(`${summary}.`);
    } else fresh.push(a);
  }
  const takePhoto = () => fresh.shift() ?? (ctx.message.attachments.length ? undefined : ctx.earlier[0]);
  for (const c of plan.characters) {
    const who = nameAlt(c);
    const re = new RegExp(`\\b(?:this is|that'?s|here(?:'s| is)|this photo is|this picture is)\\s+(?:${who})\\b|\\b(?:${who})\\s+looks like this\\b`, 'i');
    if (!re.test(bare)) continue;
    const a = takePhoto();
    if (!a) {
      said.push(`Attach a photo of ${castName(c.name)} first.`);
      continue;
    }
    const summary = `${castName(c.name)} is built from this photo`;
    actions.push({ ...emptyDraftAction('character-reference', summary), target: `character:${c.id}`, attachmentId: a.id });
    said.push(`${summary}.`);
  }
  const useFor = /\buse\s+(?:this|it|that)(?:\s+(?:photo|picture|image|pic|one))?\s+(?:for|as)\s+(?:scene\s+(\d+)|(?:the\s+)?([^.!?;,]+))/i.exec(bare);
  if (useFor) {
    const scene = useFor[1] ? plan.scenes[Number(useFor[1]) - 1] : sceneByWords(plan, useFor[2]!);
    const a = scene ? takePhoto() : undefined;
    if (!scene) said.push(`I could not find the scene "${(useFor[1] ?? useFor[2] ?? '').trim()}".`);
    else if (!a) said.push(`Attach the photo for scene ${scene.index + 1} first.`);
    else {
      const summary = `Scene ${scene.index + 1} (${scene.heading}) uses this photo`;
      actions.push({ ...emptyDraftAction('world-reference', summary), target: `scene:${scene.index}`, attachmentId: a.id, isPano: pano(a) });
      said.push(`${summary}.`);
    }
  }
  if (fresh.length && fresh.length === ctx.message.attachments.length) said.push(MOCK_ASK_PHOTO);

  if (GENERATE.test(bare)) {
    if (draft) {
      const n = plan.scenes.length;
      const summary = `Generating ${n} world${n === 1 ? '' : 's'}, ${listNames(plan.characters.map((c) => castName(c.name))) || 'no actors'} and the lines`;
      actions.push(emptyDraftAction('generate', summary));
      said.push(`${summary}.`);
    } else said.push('This project is already generated.');
  }

  return { reply: said.length ? said.join(' ') : MOCK_FALLBACK, actions };
}
