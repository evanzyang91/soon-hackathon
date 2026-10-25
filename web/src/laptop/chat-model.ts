// Pure helpers behind the project chat panel (chat-panel.ts): labels, the attachment target
// options, the plan summary line, before → after text of a plan patch. No DOM, so vitest runs them
// in node.
import type { ActionStatus, ChatAction, ChatMessage, ProjectChat } from '@shared/chat';
import type { Character, ScenePlan, ScreenplayPlan } from '@shared/schema';
import { displayName } from './projects-panel';

/** Height the actor pipeline assumes when the plan has none (shared/schema.ts Character). */
export const DEFAULT_HEIGHT_M = 1.7;

export const STATUS_LABEL: Record<ActionStatus, string> = {
  applied: 'applied',
  'needs-confirm': 'needs confirm',
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

export const ACTION_LABEL: Record<ChatAction['type'], string> = {
  'plan-patch': 'Plan change',
  'character-reference': 'Character photo',
  'world-reference': 'Set photo',
  'regenerate-world': 'New world',
  'rebuild-actor': 'Actor rebuild',
  revoice: 'Re-voice',
  replan: 'Re-plan',
  generate: 'Generate',
};

export interface TargetOption {
  /** The ChatRequest attachment hint ('' = none). */
  value: string;
  label: string;
  group?: 'character' | 'scene';
}

/** Scene headings and character cues of a screenplay, before the planner has read it. */
export function scriptOutline(text: string): { characters: string[]; headings: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const headings: string[] = [];
  const characters = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^(?:INT\.?\/EXT|EXT\.?\/INT|I\/E|INT|EXT|EST)[.\s]/i.test(line) || /^\.[A-Z]/.test(line)) {
      headings.push(line.replace(/^\./, ''));
      continue;
    }
    // a cue: upper case, short, not a transition, followed by dialogue (or a parenthetical)
    const next = lines[i + 1] ?? '';
    if (
      /^@?[A-Z][A-Z0-9 .'-]{0,28}(?:\s*\([^)]*\))?$/.test(line) &&
      !/(?:TO:|FADE|CUT|DISSOLVE)/.test(line) &&
      next &&
      (lines[i - 1] ?? '') === ''
    )
      characters.add(
        line
          .replace(/^@/, '')
          .replace(/\s*\(.*\)$/, '')
          .trim(),
      );
  }
  return { characters: [...characters], headings };
}

/**
 * Attachment targets: none, every character, every scene ("scene:<0-based index>", labelled with
 * the director's 1-based number). With a plan the hints use character ids; before it (the first
 * message) they use the cue names, which the server resolves by name.
 */
export function targetOptions(plan: ScreenplayPlan | null, screenplay = ''): TargetOption[] {
  const out: TargetOption[] = [{ value: '', label: 'No target' }];
  if (plan) {
    for (const c of plan.characters)
      out.push({ value: `character:${c.id}`, label: displayName(c.name), group: 'character' });
    for (const s of plan.scenes)
      out.push({
        value: `scene:${s.index}`,
        label: `Scene ${s.index + 1} · ${s.heading}`,
        group: 'scene',
      });
    return out;
  }
  const { characters, headings } = scriptOutline(screenplay);
  for (const name of characters)
    out.push({
      value: `character:${name.toLowerCase()}`,
      label: displayName(name),
      group: 'character',
    });
  headings.forEach((hd, i) =>
    out.push({ value: `scene:${i}`, label: `Scene ${i + 1} · ${hd}`, group: 'scene' }),
  );
  return out;
}

/** "Maya" / "Scene 2" (for "scene:1") for a hint; null when there is none. */
export function hintLabel(hint: string | undefined, plan: ScreenplayPlan | null): string | null {
  if (!hint) return null;
  const [kind, ref = ''] = hint.split(':');
  if (kind === 'scene') return `Scene ${Number(ref) + 1}`;
  if (kind === 'character') {
    const c = plan ? findCharacter(plan, ref) : undefined;
    return c ? displayName(c.name) : displayName(ref);
  }
  return hint;
}

/** A character by id or name, case-insensitive (how the chat planner resolves names). */
export function findCharacter(plan: ScreenplayPlan, name: string): Character | undefined {
  const n = name
    .trim()
    .toLowerCase()
    .replace(/['’]s$/, '');
  return plan.characters.find((c) => c.id.toLowerCase() === n || c.name.toLowerCase() === n);
}

/** A scene's background action in a few words: "a red sedan drives past · a night bus rumbles by". */
export function backgroundSummary(s: Pick<ScenePlan, 'dynamics'>): string {
  return s.dynamics
    .map((d) => {
      const first = (d.label.split(/[,.;:—–(]/)[0] ?? d.label).trim();
      const t = first.length > 48 ? `${first.slice(0, 48).replace(/\s+\S*$/, '')}…` : first;
      return t.charAt(0).toLowerCase() + t.slice(1);
    })
    .join(' · ');
}

/** "Planned 3 scenes and 2 characters: Maya, Theo." */
export function planSummary(plan: ScreenplayPlan): string {
  const n = plan.scenes.length;
  const c = plan.characters.length;
  const names = plan.characters.map((x) => displayName(x.name)).join(', ');
  return `Planned ${n} scene${n === 1 ? '' : 's'} and ${c} character${c === 1 ? '' : 's'}${c ? `: ${names}` : ''}.`;
}

export function heightLabel(c: Character): string {
  return `${(c.heightMeters ?? DEFAULT_HEIGHT_M).toFixed(2)} m`;
}

export function excerpt(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).replace(/[\s,;:.]+\S*$/, '')}…`;
}

/** "1.70 m → 1.80 m" / "“Deal.” → “Fine.”" for a plan patch; null when there is nothing short to show. */
export function patchDiff(a: ChatAction): string | null {
  if (a.type !== 'plan-patch') return null;
  if (a.field === 'dynamics') {
    // "+ a dinosaur walking by · − the bus": what the background gained and lost
    const labels = (v: unknown) =>
      new Map((Array.isArray(v) ? (v as { id: string; label: string }[]) : []).map((d) => [d.id, d.label]));
    const was = labels(a.before);
    const now = labels(a.after);
    const out = [
      ...[...now].filter(([id]) => !was.has(id)).map(([, l]) => `+ ${l}`),
      ...[...was].filter(([id]) => !now.has(id)).map(([, l]) => `− ${l}`),
    ];
    return out.length ? excerpt(out.join(' · '), 96) : null;
  }
  const fmt = (v: unknown): string | null => {
    if (v == null) return null;
    if (typeof v === 'number') return a.field === 'heightMeters' ? `${v.toFixed(2)} m` : String(v);
    if (typeof v === 'string') return v.length <= 48 ? `“${v}”` : null;
    return null;
  };
  const before = fmt(a.before);
  const after = fmt(a.after);
  if (!after) return null;
  return before ? `${before} → ${after}` : after;
}

/** Id of the last assistant message that asks for the plan card (older ones render compact). */
export function lastPlanCardId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.planCard) return messages[i]!.id;
  return null;
}

export const hasRunning = (chat: ProjectChat | null | undefined) =>
  !!chat?.messages.some((m) => m.actions?.some((a) => a.status === 'running'));

/** A reply that started the generation of a draft (the laptop then opens the first ready scene). */
export const startedGeneration = (m: ChatMessage | undefined) =>
  !!m?.actions?.some(
    (a) =>
      a.type === 'generate' &&
      (a.status === 'applied' || a.status === 'running' || a.status === 'done'),
  );

export const fmtUsd = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`);
