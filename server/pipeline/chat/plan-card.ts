// The assistant's plan card: the message that opens a draft project's thread after the parse (and
// follows a re-plan), so the director reads what was planned before amending it.
import { randomBytes } from 'node:crypto';
import type { ChatMessage } from '../../../shared/chat.ts';
import { LOOK_PRESET_LABELS } from '../../../shared/look-presets.ts';
import type { ScenePlan, ScreenplayPlan } from '../../../shared/schema.ts';
import { lookSeedFor, styleForPlan } from '../look-seed.ts';

/** "LEO" → "Leo", "MR. SMITH" → "Mr. Smith" (same rule as project.ts displayName). */
export const castName = (name: string) =>
  name
    .toLowerCase()
    .replace(/(^|[\s.'-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** "A red sedan drives past, its headlights sweeping …" → "a red sedan drives past" (its first clause). */
export function shortLabel(label: string, max = 48): string {
  const first = (label.split(/[,.;:—–(]/)[0] ?? label).trim();
  const t = first.length > max ? `${first.slice(0, max).replace(/\s+\S*$/, '')}…` : first;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/** A scene's background action in a few words: "a red sedan drives past, a night bus rumbles by". */
export const backgroundText = (s: ScenePlan) => s.dynamics.map((d) => shortLabel(d.label)).join(', ');

/**
 * "Planned 3 scenes and 2 characters: Maya and Theo. 1 EXT. CITY STREET - NIGHT (4 lines, Night
 * street; background: a red sedan drives past, a night bus rumbles by without stopping) · …", then "Style: contemporary drama · present day · natural tones …" on its own line
 * when the plan has a style. Each scene names the look it opens with (derived for older plans).
 */
export function planCardText(
  plan: ScreenplayPlan,
  o: { replanned?: boolean; draft?: boolean } = {},
): string {
  const cast = listNames(plan.characters.map((c) => castName(c.name)));
  const derived = styleForPlan(plan);
  const scenes = plan.scenes
    .map(
      (s) =>
        `${s.index + 1} ${s.heading} (${plural(s.dialogue.length, 'line')}, ${LOOK_PRESET_LABELS[lookSeedFor(s, derived).preset]}${s.dynamics.length ? `; background: ${backgroundText(s)}` : ''})`,
    )
    .join(' · ');
  const style = plan.style
    ? `\nStyle: ${plan.style.genre} · ${plan.style.era} · ${plan.style.palette}.`
    : '';
  const head = `${o.replanned ? 'Re-planned' : 'Planned'} ${plural(plan.scenes.length, 'scene')} and ${plural(plan.characters.length, 'character')}${cast ? `: ${cast}` : ''}.`;
  const next =
    o.draft === false
      ? ''
      : ' Tell me what to change, attach photos of the cast or the places, or say "generate" when it looks right.';
  // the style sits on its own line (the thread keeps line breaks); the prompt follows it
  return `${head} ${scenes}.${style}${style && next ? `\n${next.trimStart()}` : next}`;
}

/** `source`: which screenplay planner wrote the plan ('claude', or 'mock' for the offline parser). */
export function planCardMessage(
  plan: ScreenplayPlan,
  o: Parameters<typeof planCardText>[1] & { source: 'claude' | 'mock' },
): ChatMessage {
  return {
    id: `m-${randomBytes(5).toString('hex')}`,
    at: new Date().toISOString(),
    role: 'assistant',
    text: planCardText(plan, o),
    planCard: true,
    source: o.source,
  };
}
