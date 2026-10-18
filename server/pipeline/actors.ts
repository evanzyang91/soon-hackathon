// STUB written by WP C so the pipeline runs before WP D lands; WP D owns and replaces this file.
// Contract used by server/pipeline/project.ts:
//   buildActor({ character, projectDir, sceneDir, mock, log }) → ActorAsset
// project.ts passes sceneDir = <projectDir>/actors/<character.id>/ (the shared per-character
// output dir) and accepts asset paths relative to sceneDir, relative to projectDir, or absolute.
import type { ActorAsset, Character } from '../../shared/schema.ts';

export interface BuildActorOptions {
  character: Character;
  projectDir: string;
  sceneDir: string;
  mock: boolean;
  log: (m: string) => void;
}

const TINTS = ['#e07a5f', '#3d85c6', '#81b29a', '#f2cc8f', '#b56576', '#6d597a'];

export async function buildActor(opts: BuildActorOptions): Promise<ActorAsset> {
  const { id } = opts.character;
  const tint = TINTS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length];
  opts.log(`actor ${id}: stub glb-humanoid fallback (WP D not installed yet)`);
  return {
    kind: 'glb-humanoid',
    characterId: id,
    glb: '/assets/humanoid.glb',
    clips: { idle: 'idle', talk: 'talk' },
    tint,
  };
}
