// The planner's suggested look (ScenePlan.look, a LookSeed) → the grade a scene opens with.
//
//   lookSeedFor(scene, style)   plan.look, else derived from heading, time of day, interior and the
//                               action (fountain.ts heuristicLookSeed), so plans made before looks
//                               were planned (the live bus-stop project) get one too
//   styleForPlan(plan)          plan.style, else read from the screenplay's keywords
//   seedSceneLook(...)          the manifest stage's first look: scene-<n>/edits.json written ONLY
//                               when it does not exist (revision 1, one history entry); the
//                               director's grade always wins, so every manifest rewrite may call it
//   writeSceneLook(...)         `cli look --write` and the chat's scene look patches: replaces the
//                               look (keeping the director's lights and lens, every edit op and the
//                               history), appends a history entry, revision + 1
import { seedToLook } from '../../shared/look-presets.ts';
import { emptySceneEdits, type Look, type SceneEdits } from '../../shared/look.ts';
import type { LookSeed, ScenePlan, ScreenplayPlan, VisualStyle } from '../../shared/schema.ts';
import type { EditsStore } from './edits.ts';
import { heuristicLookSeed, heuristicStyle, parseHeading } from './fountain.ts';

/** The history prompt of a seeded look (the Look panel and the edit history show it). */
export const SEED_PROMPT = 'suggested look from the plan';

/** The scene's planned look, or one derived from what the scene says about itself. */
export function lookSeedFor(scene: ScenePlan, style?: VisualStyle): LookSeed {
  if (scene.look) return scene.look;
  // time of day and interior from the plan (the chat may have amended them), the place from the heading
  return heuristicLookSeed(
    {
      interior: scene.interior,
      timeOfDay: scene.timeOfDay,
      location: parseHeading(scene.heading).location,
    },
    style,
    scene.action,
  );
}

/** The screenplay's style, or one read from the plan's own text when it predates styles. */
export function styleForPlan(plan: ScreenplayPlan): VisualStyle {
  if (plan.style) return plan.style;
  const text = [
    plan.title,
    ...plan.scenes.flatMap((s) => [s.action, ...s.dialogue.map((d) => d.text)]),
  ].join('\n');
  return heuristicStyle(
    text,
    plan.scenes.map((s) => s.heading),
  );
}

function historyEntry(prompt: string, look: Look): SceneEdits['history'][number] {
  return {
    at: new Date().toISOString(),
    prompt,
    plan: { scope: 'look', summary: look.name, ops: [], needsTarget: [] },
    appliedOpIds: [],
  };
}

/** Writes the scene's first look from `seed` when it has no edits.json; null when one exists. */
export function seedSceneLook(
  store: EditsStore,
  projectId: string,
  sceneIndex: number,
  seed: LookSeed,
): Promise<SceneEdits | null> {
  return store.createIfAbsent(projectId, sceneIndex, () => {
    const look = seedToLook(seed);
    return { ...emptySceneEdits(), revision: 1, look, history: [historyEntry(SEED_PROMPT, look)] };
  });
}

/** Re-grades the scene to `seed` (an existing edits.json keeps its edits, history, lights, lens). */
export function writeSceneLook(
  store: EditsStore,
  projectId: string,
  sceneIndex: number,
  seed: LookSeed,
  prompt: string,
): Promise<SceneEdits> {
  return store.update(projectId, sceneIndex, (current) => {
    const look = seedToLook(seed, current.look);
    return { ...current, look, history: [...current.history, historyEntry(prompt, look)] };
  });
}
