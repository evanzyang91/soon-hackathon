// WP D: actors in the shared viewer. One ActorHandle per character, any asset kind:
//   splat-sequence -> LHM gaussian avatar looping idle/talk frames (splat-actor.ts)
//   glb-humanoid   -> rigged GLB when `glb` is a real .glb/.gltf URL that loads, else the
//                     procedural mannequin (mannequin.ts); `glb: 'procedural:mannequin'` asks
//                     for the mannequin directly (what server/pipeline/actors.ts writes).
// `object` stands with its feet at local y = 0 and faces -Z; the caller sets position and
// rotation.y = yaw. A splat actor that fails to load degrades to the mannequin.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ActorAsset, Character } from '@shared/schema';
import { createSpeech, resolveUrl, textSprite, type Speech } from './common';
import { buildMannequin, type Pose } from './mannequin';
import { loadSplatBody } from './splat-actor';
import { tintFor } from './tint';

export interface ActorHandle {
  object: THREE.Object3D;
  characterId: string;
  speak(lineId: string, audioUrl: string, durationSeconds: number): Promise<void>;
  stopSpeaking(): void;
  setPose(pose: 'standing' | 'sitting' | 'walking'): void;
  update(dt: number, sceneTime: number): void;
  dispose(): void;
}

/** What a body kind contributes; the handle adds label, caption and voice around it. */
interface Body {
  kind: 'splat' | 'mannequin' | 'glb';
  root: THREE.Object3D;
  headY: number;
  animate(dt: number, t: number, speaking: boolean, level: number): void;
  setPose(pose: Pose): void;
  /** small numbers for tests/HUD, mirrored into object.userData.debug every update */
  debug?(): Record<string, number>;
  dispose(): void;
}

export const PROCEDURAL_GLB = 'procedural:mannequin';

/** True when `glb` names a loadable file rather than the procedural mannequin. */
export function wantsGlbFile(glb: string): boolean {
  return !!glb && !glb.startsWith('procedural:') && /\.(glb|gltf)(\?|#|$)/i.test(glb);
}

function mannequinBody(tint: string): Body {
  const m = buildMannequin(tint);
  return {
    kind: 'mannequin',
    root: m.root,
    headY: m.headY,
    animate: (dt, t, speaking, level) => m.animate(dt, t, speaking, level),
    setPose: (p) => m.setPose(p),
    debug: () => ({ jaw: m.jawOpen() }),
    dispose: () => m.dispose(),
  };
}

async function glbBody(asset: Extract<ActorAsset, { kind: 'glb-humanoid' }>, baseUrl: string, tint: string): Promise<Body> {
  const gltf = await new GLTFLoader().loadAsync(resolveUrl(asset.glb, baseUrl));
  const root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root);
  const h = box.max.y - box.min.y || 1.7;
  root.scale.setScalar(1.7 / h);
  root.position.y = (-box.min.y * 1.7) / h;
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && asset.tint && o.material instanceof THREE.MeshStandardMaterial) {
      o.material = o.material.clone();
      o.material.color.lerp(new THREE.Color(tint), 0.6);
    }
  });
  const mixer = new THREE.AnimationMixer(root);
  const clip = (name?: string) => (name ? THREE.AnimationClip.findByName(gltf.animations, name) ?? undefined : undefined);
  const actions = {
    idle: clip(asset.clips.idle),
    talk: clip(asset.clips.talk),
    walk: clip(asset.clips.walk),
  };
  const morphs: { mesh: THREE.Mesh; index: number }[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && o.morphTargetDictionary) {
      for (const key of ['jawOpen', 'mouthOpen', 'viseme_aa', 'MouthOpen']) {
        const index = o.morphTargetDictionary[key];
        if (index !== undefined) morphs.push({ mesh: o, index });
      }
    }
  });
  let playing: THREE.AnimationAction | null = null;
  let pose: Pose = 'standing';
  const play = (c?: THREE.AnimationClip) => {
    if (!c) return;
    const next = mixer.clipAction(c);
    if (next === playing) return;
    next.reset().fadeIn(0.25).play();
    playing?.fadeOut(0.25);
    playing = next;
  };
  play(actions.idle);
  return {
    kind: 'glb',
    root,
    headY: 1.6,
    animate(dt, _t, speaking, level) {
      play(speaking ? actions.talk ?? actions.idle : pose === 'walking' ? actions.walk ?? actions.idle : actions.idle);
      mixer.update(dt);
      for (const { mesh, index } of morphs) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = speaking ? level : 0;
    },
    setPose(p) {
      pose = p;
    },
    dispose() {
      mixer.stopAllAction();
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    },
  };
}

async function makeBody(asset: ActorAsset, baseUrl: string, tint: string): Promise<Body> {
  if (asset.kind === 'splat-sequence') {
    try {
      const s = await loadSplatBody(asset, baseUrl);
      return {
        kind: 'splat',
        root: s.root,
        headY: s.headY,
        animate: (dt, _t, speaking) => s.animate(dt, speaking),
        setPose: () => {}, // one captured idle/talk motion; sitting/walking are not in the sequence
        debug: () => ({ frame: s.frame, frames: s.sequence.count }),
        dispose: () => s.dispose(),
      };
    } catch (err) {
      console.warn(`actor ${asset.characterId}: splat sequence failed, using mannequin`, err);
      return mannequinBody(tint);
    }
  }
  if (wantsGlbFile(asset.glb)) {
    try {
      return await glbBody(asset, baseUrl, tint);
    } catch (err) {
      console.warn(`actor ${asset.characterId}: ${asset.glb} failed to load, using mannequin`, err);
    }
  }
  return mannequinBody(tint);
}

export async function createActor(
  asset: ActorAsset,
  character: Character,
  listener: THREE.AudioListener,
  baseUrl: string,
): Promise<ActorHandle> {
  const tint = (asset.kind === 'glb-humanoid' && asset.tint) || tintFor(character.id);
  const object = new THREE.Group();
  object.name = `actor:${character.id}`;
  object.userData.characterId = character.id;
  const body = await makeBody(asset, baseUrl, tint);
  object.userData.actorKind = body.kind;
  object.add(body.root);

  const label = textSprite(character.name, { h: 0.11, bg: 'rgba(15,18,24,0.72)', fg: '#ffffff' });
  label.sprite.position.y = body.headY + 0.3;
  object.add(label.sprite);
  const caption = textSprite(`${character.name} ▸`, { h: 0.15, bg: 'rgba(255,255,255,0.92)', fg: '#111111' });
  caption.sprite.position.y = body.headY + 0.42;
  caption.sprite.visible = false;
  object.add(caption.sprite);
  const speech: Speech = createSpeech(listener, object, body.headY);

  let t = 0;
  let speakingLine: string | null = null;
  const handle: ActorHandle = {
    object,
    characterId: character.id,
    async speak(lineId, audioUrl, durationSeconds) {
      speakingLine = lineId;
      caption.sprite.visible = true;
      label.sprite.visible = false;
      object.userData.speakingLine = lineId;
      try {
        await speech.play(audioUrl, durationSeconds);
      } finally {
        if (speakingLine === lineId) {
          speakingLine = null;
          caption.sprite.visible = false;
          label.sprite.visible = true;
          object.userData.speakingLine = null;
        }
      }
    },
    stopSpeaking() {
      speech.stop();
    },
    setPose(pose) {
      body.setPose(pose);
    },
    update(dt, _sceneTime) {
      t += dt;
      const speaking = speech.speaking;
      const level = speech.level();
      body.animate(dt, t, speaking, level);
      if (body.debug) object.userData.debug = { ...body.debug(), level, speaking: speaking ? 1 : 0 };
      if (caption.sprite.visible) caption.sprite.position.y = body.headY + 0.42 + 0.015 * Math.sin(t * 5);
    },
    dispose() {
      speech.dispose();
      label.dispose();
      caption.dispose();
      body.dispose();
      object.clear();
    },
  };
  return handle;
}
