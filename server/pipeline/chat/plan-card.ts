// The assistant's plan card: the message that opens a draft project's thread after the parse (and
// follows a re-plan), so the director reads what was planned before amending it.
import { randomBytes } from 'node:crypto';
import type { ChatMessage } from '../../../shared/chat.ts';
import type { ScreenplayPlan } from '../../../shared/schema.ts';

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

/** "Planned 3 scenes and 2 characters: Maya and Theo. 1 EXT. CITY STREET - NIGHT (4 lines) · …" */
export function planCardText(
  plan: ScreenplayPlan,
  o: { replanned?: boolean; draft?: boolean } = {},
): string {
  const cast = listNames(plan.characters.map((c) => castName(c.name)));
  const scenes = plan.scenes
    .map((s) => `${s.index + 1} ${s.heading} (${plural(s.dialogue.length, 'line')})`)
    .join(' · ');
  const head = `${o.replanned ? 'Re-planned' : 'Planned'} ${plural(plan.scenes.length, 'scene')} and ${plural(plan.characters.length, 'character')}${cast ? `: ${cast}` : ''}.`;
  const next =
    o.draft === false
      ? ''
      : ' Tell me what to change, attach photos of the cast or the places, or say "generate" when it looks right.';
  return `${head} ${scenes}.${next}`;
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
