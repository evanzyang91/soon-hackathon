// The bus-stop scene of "The Last Bus" (data/projects/the-last-bus-abcb17, scene 0) as a
// re-prompt fixture: tests and the offline planner demo build their SceneContext from it.
import { emptySceneEdits, type SceneEdits } from '../../../shared/look.ts';
import type { SceneManifest, ScenePlan } from '../../../shared/schema.ts';
import { buildSceneContext, type SceneContext } from './context.ts';

export const BUS_STOP_PANO =
  'https://cdn.marble.worldlabs.ai/23bc1e36-fd9f-46d3-aabe-c8298ed5abe9/14655fb4-fb00-44e2-8538-82ab4f53b769_panos/rgb_0.png';

export const busStopPlan = (): ScenePlan => ({
  index: 0,
  slug: 'ext-city-bus-stop-night',
  heading: 'EXT. CITY BUS STOP - NIGHT',
  action:
    'Rain-slick pavement under a flickering streetlight. A red sedan hisses past through the puddles.\n\nMAYA (30s, denim jacket, tired eyes) checks her phone under the shelter.\nLEO (40s, rumpled raincoat) jogs in, out of breath.',
  worldPrompt:
    'An empty city bus stop at night in steady rain. Foreground: wide open stretch of wet concrete sidewalk glistening with puddles. A glass-and-steel bus shelter with a metal bench, illuminated route map and timetable panel. A tall streetlight casts flickering sodium-orange light, rain streaks visible in its glow. Beyond the curb, a wet asphalt street reflecting neon and shop signs, dark brick storefronts with shuttered windows across the road. Cool blue shadows, orange highlights, misty, moody, cinematic urban atmosphere.',
  timeOfDay: 'night',
  interior: false,
  characterIds: ['maya', 'leo'],
  dialogue: [
    { id: 's1-l1', characterId: 'leo', text: 'Did I miss it?', order: 0 },
    { id: 's1-l2', characterId: 'maya', text: 'Ten minutes ago.', parenthetical: 'not looking up', order: 1 },
  ],
  blocking: [
    { characterId: 'maya', position: [-0.7, 0, -2.8], yaw: -1.703, pose: 'standing' },
    { characterId: 'leo', position: [0.8, 0, -2.6], yaw: 1.438, pose: 'walking' },
  ],
  dynamics: [
    { id: 's1-car-1', kind: 'car', label: 'red sedan', path: [[-30, 0, -10], [30, 0, -10]], speed: 8, loop: true, pauseSeconds: 3, scale: 1 },
    { id: 's1-bus-2', kind: 'bus', label: 'city bus', path: [[30, 0, -12], [-30, 0, -12]], speed: 6, loop: true, pauseSeconds: 4, scale: 1 },
  ],
  shots: [],
});

const manifestBits = (): Pick<SceneManifest, 'characters' | 'world'> => ({
  characters: [
    { id: 'maya', name: 'MAYA', description: '', voice: { id: 'nova', gender: 'female' } },
    { id: 'leo', name: 'LEO', description: '', voice: { id: 'onyx', gender: 'male' } },
  ],
  world: {
    provider: 'marble',
    worldId: '23bc1e36-fd9f-46d3-aabe-c8298ed5abe9',
    spz: { k500: 'scene-0/world/world_500k.spz' },
    metricScaleFactor: 2.2016,
    groundPlaneOffset: 1.4883,
    opencvFrame: true,
  },
});

/** The bus-stop scene with `edits` applied (defaults: no edits). */
export function busStopContext(edits: SceneEdits = emptySceneEdits(), o: { pano?: boolean } = {}): SceneContext {
  return buildSceneContext({
    projectId: 'the-last-bus-abcb17',
    sceneIndex: 0,
    plan: busStopPlan(),
    manifest: manifestBits(),
    edits,
    marbleWorld: o.pano === false ? {} : { assets: { imagery: { pano_url: BUS_STOP_PANO } } },
  });
}
