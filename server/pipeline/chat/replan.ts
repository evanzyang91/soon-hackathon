// A re-plan (the chat's structural change: a new scene, a removed character) parses the amended
// screenplay from scratch; mergeReplan carries over what the director already settled so it
// survives the new parse:
//   characters matched by name keep their id (actors/<id>/ and every reference to it stay valid),
//     description, height, voice and reference photo — the chat may have amended all of them;
//   scenes matched by heading slug keep their world prompt, time of day, interior flag, place photo
//     and the marks of characters still in them, and keep their scene-<n>/ folder (its world,
//     receipt and edits) even when the scene moves to another index.
// Everything else (dialogue, new scenes, new characters, dynamics) comes from the new parse.
import type { Blocking, Character, ScreenplayPlan } from '../../../shared/schema.ts';
import { slugify, uniqueSlug } from '../geometry.ts';

export interface ReplanMerge {
  plan: ScreenplayPlan;
  /** For each new scene index, the old scene index it continues (its folder moves along), or null. */
  sceneFrom: (number | null)[];
  kept: string[];
  added: string[];
  removed: string[];
  /** Old scene indices no new scene continues (their folders are set aside, not deleted). */
  droppedScenes: number[];
}

const key = (name: string) => name.trim().toUpperCase().replace(/\s+/g, ' ');

export function mergeReplan(prev: ScreenplayPlan, next: ScreenplayPlan): ReplanMerge {
  const oldByName = new Map(prev.characters.map((c) => [key(c.name), c]));
  const oldById = new Map(prev.characters.map((c) => [c.id, c]));
  const taken = new Set<string>();
  const idMap = new Map<string, string>();
  const kept: string[] = [];
  const added: string[] = [];
  const characters: Character[] = next.characters.map((c) => {
    const old = oldByName.get(key(c.name)) ?? (oldById.get(c.id)?.name && key(oldById.get(c.id)!.name) === key(c.name) ? oldById.get(c.id) : undefined);
    if (old && !taken.has(old.id)) {
      taken.add(old.id);
      idMap.set(c.id, old.id);
      kept.push(old.id);
      return {
        ...c,
        id: old.id,
        description: old.description,
        voice: old.voice,
        ...(old.heightMeters ?? c.heightMeters ? { heightMeters: old.heightMeters ?? c.heightMeters } : {}),
        ...(old.referenceImage ? { referenceImage: old.referenceImage } : {}),
      };
    }
    // a new character must not take an id that still names someone else's actor folder
    const id = uniqueSlug(c.id, new Set([...taken, ...oldById.keys()]));
    taken.add(id);
    idMap.set(c.id, id);
    added.push(id);
    return { ...c, id };
  });
  const removed = prev.characters.filter((c) => !kept.includes(c.id)).map((c) => c.id);
  const remap = (id: string) => idMap.get(id) ?? id;

  const oldBySlug = new Map(prev.scenes.map((s) => [s.slug, s]));
  const used = new Set<number>();
  const sceneFrom: (number | null)[] = [];
  const scenes = next.scenes.map((s) => {
    const dialogue = s.dialogue.map((d) => ({ ...d, characterId: remap(d.characterId) }));
    const characterIds = [...new Set(s.characterIds.map(remap))];
    const fresh: Blocking[] = s.blocking.map((b) => ({ ...b, characterId: remap(b.characterId) }));
    const old = oldBySlug.get(s.slug) ?? oldBySlug.get(slugify(s.heading));
    if (!old || used.has(old.index)) {
      sceneFrom.push(null);
      return { ...s, dialogue, characterIds, blocking: fresh };
    }
    used.add(old.index);
    sceneFrom.push(old.index);
    const blocking = fresh.map((b) => old.blocking.find((o) => o.characterId === b.characterId) ?? b);
    return {
      ...s,
      slug: old.slug,
      worldPrompt: old.worldPrompt,
      timeOfDay: old.timeOfDay,
      interior: old.interior,
      ...(old.worldReference ? { worldReference: old.worldReference } : {}),
      dialogue,
      characterIds,
      blocking,
    };
  });
  return {
    plan: { ...next, characters, scenes },
    sceneFrom,
    kept,
    added,
    removed,
    droppedScenes: prev.scenes.map((s) => s.index).filter((i) => !used.has(i)),
  };
}

/** What a re-plan of `prev` with these headings would keep, offline (for the confirm card). */
export function replanImpact(prev: ScreenplayPlan, headings: string[]): { keep: number; fresh: number; dropped: number } {
  const slugs = new Set(prev.scenes.map((s) => s.slug));
  const seen = new Set<string>();
  let keep = 0;
  for (const h of headings) {
    const slug = uniqueSlug(slugify(h), seen);
    if (slugs.has(slug)) keep++;
  }
  return { keep, fresh: headings.length - keep, dropped: prev.scenes.length - keep };
}
