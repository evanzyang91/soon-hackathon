// What the re-prompt planner knows about a scene: the plan, the actors and props where the
// current edits put them, the effective look, and whether the world's panorama is available for a
// pano-inpaint regeneration. `buildSceneContext` is pure (tests build fixtures with it);
// `loadSceneContext` reads a scene directory.
import { join } from 'node:path';
import type { Light, Look, SceneEdits } from '../../../shared/look.ts';
import { SceneManifest, type ScenePlan, type Vec3 } from '../../../shared/schema.ts';
import { effectiveProps, effectiveTransforms, isParked } from '../../../web/src/viewer/edits/model.ts';
import { readJson } from '../fsutil.ts';

export interface ActorInfo {
  id: string;
  name: string;
  position: Vec3;
  yaw: number;
  scale: number;
  pose: string;
}

export interface PropInfo {
  id: string;
  kind: string;
  label: string;
  /** Where it is (parked) or where its path starts. */
  position: Vec3;
  moving: boolean;
  /** Added by a prop-add edit (vs. part of the screenplay's dynamics). */
  added: boolean;
  scale: number;
}

export interface WorldInfo {
  provider: string;
  /** Marble's equirectangular panorama of the world (pano-inpaint regeneration). */
  panoUrl?: string;
  caption?: string;
  prompt: string;
  interior: boolean;
  timeOfDay: string;
}

export interface SceneContext {
  projectId: string;
  sceneIndex: number;
  plan: ScenePlan;
  edits: SceneEdits;
  look: Look;
  actors: ActorInfo[];
  props: PropInfo[];
  lights: Light[];
  world: WorldInfo;
}

interface MarbleWorldJson {
  caption?: string;
  assets?: { imagery?: { pano_url?: string } };
}

export function buildSceneContext(o: {
  projectId: string;
  sceneIndex: number;
  plan: ScenePlan;
  manifest?: Pick<SceneManifest, 'characters' | 'world'>;
  edits: SceneEdits;
  marbleWorld?: MarbleWorldJson;
}): SceneContext {
  const { plan, edits } = o;
  const transforms = effectiveTransforms(edits.edits);
  const names = new Map((o.manifest?.characters ?? []).map((c) => [c.id, c.name]));
  const actors: ActorInfo[] = plan.blocking.map((b) => {
    const t = transforms.get(`actor:${b.characterId}`) ?? {};
    return {
      id: b.characterId,
      name: names.get(b.characterId) ?? b.characterId.toUpperCase(),
      position: t.position ?? b.position,
      yaw: t.yaw ?? b.yaw,
      scale: t.scale ?? 1,
      pose: b.pose,
    };
  });
  const { added, removed } = effectiveProps(edits.edits);
  const props: PropInfo[] = [
    ...plan.dynamics.map((d) => ({ d, added: false })),
    ...added.map((d) => ({ d, added: true })),
  ]
    .filter(({ d }) => !removed.has(d.id))
    .map(({ d, added: isAdded }) => {
      const t = transforms.get(`prop:${d.id}`) ?? {};
      return {
        id: d.id,
        kind: d.kind,
        label: d.label,
        position: t.position ?? d.path[0]!,
        moving: !isParked(d),
        added: isAdded,
        scale: t.scale ?? d.scale ?? 1,
      };
    });
  // re-prompt looks are baked into edits.look (model.ts), so the stored look is the effective one
  const look = edits.look;
  const pano = o.marbleWorld?.assets?.imagery?.pano_url;
  return {
    projectId: o.projectId,
    sceneIndex: o.sceneIndex,
    plan,
    edits,
    look,
    actors,
    props,
    lights: look.lights,
    world: {
      provider: o.manifest?.world.provider ?? 'unknown',
      ...(o.manifest?.world.provider === 'marble' && typeof pano === 'string' && /^https:\/\//.test(pano)
        ? { panoUrl: pano }
        : {}),
      caption: o.manifest?.world.caption ?? o.marbleWorld?.caption,
      prompt: plan.worldPrompt,
      interior: plan.interior,
      timeOfDay: plan.timeOfDay,
    },
  };
}

/** Reads <sceneDir>/manifest.json and world/marble-world.json (both optional) around `plan`. */
export async function loadSceneContext(o: {
  projectId: string;
  sceneIndex: number;
  sceneDir: string;
  plan: ScenePlan;
  edits: SceneEdits;
}): Promise<SceneContext & { manifest?: SceneManifest }> {
  const raw = await readJson(join(o.sceneDir, 'manifest.json')).catch(() => undefined);
  const manifest = raw ? SceneManifest.safeParse(raw).data : undefined;
  const marbleWorld = await readJson<MarbleWorldJson>(join(o.sceneDir, 'world', 'marble-world.json')).catch(
    () => undefined,
  );
  return { ...buildSceneContext({ ...o, manifest, marbleWorld }), manifest };
}
