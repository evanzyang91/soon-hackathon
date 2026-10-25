// WP D: actors in the shared viewer. One ActorHandle per character, any asset kind:
//   splat-sequence -> LHM gaussian avatar. With a runtime rig (sequence.json `rig`) it performs
//                     from the shared motion library, skinned on the GPU (skinned-actor.ts);
//                     otherwise it loops the baked idle/talk frames (splat-actor.ts)
//   glb-humanoid   -> rigged GLB when `glb` is a real .glb/.gltf URL that loads, else the
//                     procedural mannequin (mannequin.ts); `glb: 'procedural:mannequin'` asks
//                     for the mannequin directly (what server/pipeline/actors.ts writes).
// `object` stands with its feet at local y = 0 and faces -Z; the caller sets position and
// rotation.y = yaw. Every body kind stands at the character's height (asset.heightMeters, from
// Character.heightMeters; 1.7 m when absent), and head, label, caption, voice and the seated
// drop scale with it; object.userData.heightMeters says how tall (the manipulator's hit box). A splat actor that fails to load degrades to the mannequin.
// While speaking, a caption above the head shows the line (`speak(..., text)`), word-wrapped.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ActorAsset, Character } from '@shared/schema';
import type { Performance } from '@shared/beats';
import { createSpeech, resolveUrl, textSprite, type Speech } from './common';
import { headYawToward } from '../gaze';
import { buildMannequin, MANNEQUIN_HEIGHT_M, restHeight, type Pose } from './mannequin';
import { loadSequence, loadSplatBody } from './splat-actor';
import { loadSkinnedBody } from './skinned-actor';
import type { Clip, RigPointer } from './rig';
import { tintFor } from '@shared/tint';

export interface ActorHandle {
  object: THREE.Object3D;
  characterId: string;
  /** Plays the line's audio at the actor's head; `text` (the line) is shown in the caption. */
  speak(lineId: string, audioUrl: string, durationSeconds: number, text?: string): Promise<void>;
  stopSpeaking(): void;
  setPose(pose: 'standing' | 'sitting' | 'walking'): void;
  /**
   * Who to turn the head toward (world position; null = nobody): the speaker or the scene
   * partner (world.ts decides, viewer/gaze.ts). The mannequin and rigged splat actors turn their
   * heads; a baked splat sequence cannot.
   */
  lookAt?(target: THREE.Vector3 | null): void;
  /**
   * Beats: put the actor where the timeline says (shared/beats.ts performanceAt) at this scene
   * time. Position and pose follow at once (the clock can be scrubbed); the body turns toward the
   * yaw at a natural rate unless it is walking (it faces where it walks).
   */
  perform?(p: Performance): void;
  /** The scene's generated gesture clips (rigged splat actors play them during beats). */
  addGestures?(clips: Clip[]): void;
  update(dt: number, sceneTime: number): void;
  dispose(): void;
}

/** What a body kind contributes; the handle adds label, caption and voice around it. */
interface Body {
  kind: 'splat' | 'mannequin' | 'glb';
  root: THREE.Object3D;
  headY: number;
  animate(dt: number, t: number, speaking: boolean, level: number, sceneTime: number): void;
  setPose(pose: Pose): void;
  /** Seated drop the handle applies to label/voice (bodies that really sit report their own). */
  drop?(pose: Pose): number;
  /** Body position relative to the mark (actor frame, metres); walking-in moves it. */
  offset?: THREE.Vector3;
  /** Head yaw toward the look target, relative to the body (null = none). */
  look?(yaw: number | null): void;
  /** Distance-locked walk cycle while beats move the actor (rigged splat actors). */
  travel?(walking: boolean, walked: number): void;
  /** A beat's gesture clip, `time` seconds in (rigged splat actors). */
  gesture?(name: string | null, time: number): void;
  addGestures?(clips: Clip[]): void;
  /** small numbers for tests/HUD, mirrored into object.userData.debug every update */
  debug?(): Record<string, number>;
  dispose(): void;
}

export const PROCEDURAL_GLB = 'procedural:mannequin';

/** How fast an actor turns to a beat's new facing (rad/s): about half a turn in a second. */
export const TURN_RATE = 3.5;

/** `from` turned toward `to` by at most `step` radians, the short way round. */
export function turnToward(from: number, to: number, step: number): number {
  const d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return Math.abs(d) <= step ? to : from + Math.sign(d) * step;
}

/**
 * How far a seated actor's body (and head) sits below standing height. The mannequin poses its
 * hips at this height; splat and GLB bodies, which have no sitting motion, are lowered by it so
 * blocking that says "sitting" still reads at a plausible seated eye line.
 */
export const SIT_DROP_M = 0.45;
export const poseDrop = (pose: Pose, heightM = MANNEQUIN_HEIGHT_M) =>
  pose === 'sitting' ? (SIT_DROP_M * heightM) / MANNEQUIN_HEIGHT_M : 0;
/** Default standing height when neither the asset nor the character says (m). */
export const DEFAULT_HEIGHT_M = MANNEQUIN_HEIGHT_M;

/** The height an actor's body is scaled to: the asset's, else the character's, else 1.7 m. */
export function actorHeight(asset: Pick<ActorAsset, 'heightMeters'>, character?: Pick<Character, 'heightMeters'>): number {
  for (const h of [asset.heightMeters, character?.heightMeters])
    if (typeof h === 'number' && Number.isFinite(h) && h > 0) return h;
  return DEFAULT_HEIGHT_M;
}
/** Head drop of a rigged splat actor playing the seated clips (measured on the library). */
export const SKINNED_SIT_DROP_M = 0.42;

/** True when `glb` names a loadable file rather than the procedural mannequin. */
export function wantsGlbFile(glb: string): boolean {
  return !!glb && !glb.startsWith('procedural:') && /\.(glb|gltf)(\?|#|$)/i.test(glb);
}

function mannequinBody(tint: string, heightM: number): Body {
  const m = buildMannequin(tint);
  // scaling the root scales every joint, the sitting pose included; the head top lands at heightM
  const s = heightM / restHeight(m.root);
  m.root.scale.setScalar(s);
  return {
    kind: 'mannequin',
    root: m.root,
    headY: m.headY * s,
    animate: (dt, t, speaking, level) => m.animate(dt, t, speaking, level),
    setPose: (p) => m.setPose(p),
    drop: (p) => poseDrop(p, heightM),
    look: (yaw) => m.setLook(yaw),
    debug: () => ({ jaw: m.jawOpen(), look: m.lookYaw(), shift: m.weightShift() }),
    dispose: () => m.dispose(),
  };
}

async function glbBody(
  asset: Extract<ActorAsset, { kind: 'glb-humanoid' }>,
  baseUrl: string,
  tint: string,
  heightM: number,
): Promise<Body> {
  const gltf = await new GLTFLoader().loadAsync(resolveUrl(asset.glb, baseUrl));
  const root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root);
  const h = box.max.y - box.min.y || heightM;
  root.scale.setScalar(heightM / h);
  const baseY = (-box.min.y * heightM) / h;
  root.position.y = baseY;
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
    headY: heightM * 0.94,
    animate(dt, _t, speaking, level) {
      play(speaking ? actions.talk ?? actions.idle : pose === 'walking' ? actions.walk ?? actions.idle : actions.idle);
      mixer.update(dt);
      for (const { mesh, index } of morphs) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = speaking ? level : 0;
    },
    setPose(p) {
      pose = p;
      root.position.y = baseY - poseDrop(p, heightM); // no sitting clip: lower the standing body
    },
    drop: (p) => poseDrop(p, heightM),
    dispose() {
      mixer.stopAllAction();
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    },
  };
}

async function makeBody(asset: ActorAsset, baseUrl: string, tint: string, heightM: number): Promise<Body> {
  // splat bodies scale themselves from asset.heightMeters (nativeHeight → metres)
  const k = heightM / MANNEQUIN_HEIGHT_M;
  if (asset.kind === 'splat-sequence') {
    try {
      const loaded = await loadSequence(asset, baseUrl);
      const rig = (loaded.seq as { rig?: RigPointer }).rig;
      if (rig?.file && rig.clips) {
        try {
          const sk = await loadSkinnedBody(asset, loaded.dir, rig);
          return {
            kind: 'splat',
            root: sk.root,
            headY: sk.headY,
            animate: (dt, _t, speaking, level, sceneTime) => sk.animate(dt, sceneTime, speaking, level),
            setPose: (p) => {
              sk.setPose(p);
              sk.root.position.y = sk.canSit ? 0 : -poseDrop(p, heightM);
            },
            drop: (p) => (p === 'sitting' ? (sk.canSit ? SKINNED_SIT_DROP_M * k : poseDrop(p, heightM)) : 0),
            look: (yaw) => sk.look(yaw),
            travel: (walking, walked) => sk.travel(walking, walked),
            gesture: (name, time) => sk.gesture(name, time),
            addGestures: (clips) => sk.addGestures(clips),
            offset: sk.offset,
            debug: () => sk.debug(),
            dispose: () => sk.dispose(),
          };
        } catch (err) {
          console.warn(`actor ${asset.characterId}: runtime rig failed, playing the baked sequence`, err);
        }
      }
      const s = await loadSplatBody(asset, baseUrl, loaded);
      return {
        kind: 'splat',
        root: s.root,
        headY: s.headY,
        animate: (dt, _t, speaking) => s.animate(dt, speaking),
        // one captured idle/talk motion: no sitting/walking frames, so a seated actor is lowered
        setPose: (p) => {
          s.root.position.y = -poseDrop(p, heightM);
        },
        drop: (p) => poseDrop(p, heightM),
        debug: () => ({ frame: s.frame, frames: s.sequence.count }),
        dispose: () => s.dispose(),
      };
    } catch (err) {
      console.warn(`actor ${asset.characterId}: splat sequence failed, using mannequin`, err);
      return mannequinBody(tint, heightM);
    }
  }
  if (wantsGlbFile(asset.glb)) {
    try {
      return await glbBody(asset, baseUrl, tint, heightM);
    } catch (err) {
      console.warn(`actor ${asset.characterId}: ${asset.glb} failed to load, using mannequin`, err);
    }
  }
  return mannequinBody(tint, heightM);
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
  const heightM = actorHeight(asset, character);
  object.userData.heightMeters = heightM;
  const body = await makeBody(asset, baseUrl, tint, heightM);
  object.userData.actorKind = body.kind;
  object.add(body.root);

  // the name: small and thin on a translucent pill
  const label = textSprite(character.name, { h: 0.075, bg: 'rgba(12,13,15,0.5)', fg: 'rgba(255,255,255,0.88)', weight: 500, tracking: 0.08 });
  object.add(label.sprite);
  const caption = textSprite(`${character.name} ▸`, {
    h: 0.1,
    bg: 'rgba(255,255,255,0.92)',
    fg: '#111111',
    wrap: 34,
    anchorBottom: true,
  });
  caption.sprite.visible = false;
  object.add(caption.sprite);
  const speech: Speech = createSpeech(listener, object, body.headY);
  /** Head height for the current pose (sitting lowers it). */
  let headY = body.headY;
  const place = () => {
    label.sprite.position.y = headY + 0.3;
    caption.sprite.position.y = headY + 0.3;
    speech.audio.position.y = headY;
  };
  /** label, caption and voice follow a body that walks in from behind its mark */
  const follow = (o: THREE.Vector3) => {
    for (const p of [label.sprite.position, caption.sprite.position, speech.audio.position]) {
      p.x = o.x;
      p.z = o.z;
    }
  };
  const bodyAt = new THREE.Vector3();
  const bodyOffset = new THREE.Vector3();
  place();

  let t = 0;
  let speakingLine: string | null = null;
  let pose: Performance['pose'] | null = null;
  /** Yaw the beats want; update() turns toward it (null: no beats, rotation is the caller's). */
  let wantYaw: number | null = null;
  let walkingNow = false;
  let lookTarget: THREE.Vector3 | null = null;
  const handle: ActorHandle = {
    object,
    characterId: character.id,
    async speak(lineId, audioUrl, durationSeconds, text) {
      speakingLine = lineId;
      const line = text?.trim();
      caption.setText(line ? `${character.name}: ${line}` : `${character.name} ▸`);
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
    setPose(next) {
      pose = next;
      body.setPose(next);
      headY = body.headY - (body.drop ? body.drop(next) : poseDrop(next, heightM));
      place();
    },
    perform(p) {
      object.position.x = p.x;
      object.position.z = p.z;
      walkingNow = p.pose === 'walking';
      // a rigged body walks with its own distance-locked cycle; others animate the walking pose
      const bodyPose = body.travel && walkingNow ? 'standing' : p.pose;
      if (bodyPose !== pose) handle.setPose(bodyPose);
      body.travel?.(walkingNow, p.walked);
      body.gesture?.(p.gesture?.clip ?? null, p.gesture?.time ?? 0);
      if (wantYaw === null || walkingNow) object.rotation.y = p.yaw;
      wantYaw = p.yaw;
    },
    addGestures(clips) {
      body.addGestures?.(clips);
    },
    lookAt(target) {
      lookTarget = target ? (lookTarget ?? new THREE.Vector3()).copy(target) : null;
    },
    update(dt, sceneTime) {
      t += dt;
      if (wantYaw !== null && !walkingNow) object.rotation.y = turnToward(object.rotation.y, wantYaw, TURN_RATE * dt);
      // actors are children of the scene root: position / rotation.y are world values
      bodyAt.copy(object.position);
      if (body.offset) bodyAt.add(bodyOffset.copy(body.offset).applyAxisAngle(THREE.Object3D.DEFAULT_UP, object.rotation.y));
      body.look?.(
        lookTarget ? headYawToward(bodyAt.x, bodyAt.z, object.rotation.y, lookTarget.x, lookTarget.z) : null,
      );
      const speaking = speech.speaking;
      const level = speech.level();
      body.animate(dt, t, speaking, level, sceneTime);
      if (body.offset) follow(body.offset);
      if (body.debug) object.userData.debug = { ...body.debug(), level, speaking: speaking ? 1 : 0 };
      if (caption.sprite.visible) caption.sprite.position.y = headY + 0.3 + 0.015 * Math.sin(t * 5);
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
