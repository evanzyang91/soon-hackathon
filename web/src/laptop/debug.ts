// window.__previz: read-only snapshot for e2e tests and debugging from the devtools console.
import * as THREE from 'three';
import type { Director } from './director';

export interface PrevizDebugState {
  sceneLoaded: boolean;
  loading: string | null;
  error: string | null;
  placeholder: boolean;
  projectId: string | null;
  sceneIndex: number | null;
  time: number;
  playing: boolean;
  speakingLineId: string | null;
  /** Last line started (what the phone's "Line ›" continues from). */
  lastLineId: string | null;
  /** Clock playing with dialogue under way: the phone shows CUT. */
  sceneRunning: boolean;
  cameras: number;
  activeCameraId: string | null;
  linkStatus: string;
  room: string | null;
  phones: number;
  lastPose: unknown;
  gizmo: { visible: boolean; position: number[]; quaternion: number[] };
  pip: { visible: boolean; label: string; frames: number };
  mainFrames: number;
  viewFromPhone: boolean;
  recording: boolean;
  /** performance.now() of the last still (phone shutter / Still button), 0 = none yet. */
  lastStillAt: number;
  /** The scene's ground height field (viewer/ground.ts), null without one. */
  ground: { cols: number; rows: number; cell: number } | null;
  /**
   * Placed actors; `placementCorrected` = moved out of collider geometry (viewer/placement.ts);
   * `groundY` = the visible ground's y under the actor's spot (its feet are there when standing).
   */
  actors: {
    id: string;
    kind: string;
    position: number[];
    groundY: number;
    yaw: number;
    placementCorrected: boolean;
    placement: { status: string; from: number[]; to: number[] } | null;
  }[];
  dynamics: { id: string; position: number[]; phase: string }[];
  /**
   * Dialogue audio: WebAudio context state, actors whose voice is playing, loudest level now
   * (0..1); `heard` / `peak`: who played and how loud during the current / last line (sampled
   * every frame, so a short line cannot slip between two state() calls).
   */
  voice: { context: string; playing: string[]; level: number; heard: string[]; peak: number };
}

export function installDebugHook(director: Director) {
  let peak = 0;
  let peakLine: string | null = null;
  const heard = new Set<string>();
  const voice = (): PrevizDebugState['voice'] => {
    const playing: string[] = [];
    let level = 0;
    for (const actor of director.runtime?.actors.values() ?? []) {
      actor.object.traverse((o) => {
        if (o instanceof THREE.PositionalAudio && o.isPlaying) playing.push(actor.characterId);
      });
      const d = actor.object.userData.debug as { level?: number } | undefined;
      level = Math.max(level, d?.level ?? 0);
    }
    return { context: director.listener.context.state, playing, level, heard: [...heard], peak };
  };
  director.on((c) => {
    if (c === 'lines' && director.speakingLineId && director.speakingLineId !== peakLine) {
      peakLine = director.speakingLineId;
      peak = 0;
      heard.clear();
    }
    // 'clock' fires from the frame loop (≥ every 100 ms), right after the actors updated
    if (c === 'clock') {
      const v = voice();
      peak = Math.max(peak, v.level);
      for (const id of v.playing) heard.add(id);
    }
  });
  const state = (): PrevizDebugState => {
    const rt = director.runtime;
    const g = director.phoneGizmo.object;
    return {
      sceneLoaded: !!rt,
      loading: director.loading,
      error: director.error,
      placeholder: !!rt?.placeholder,
      projectId: director.projectId,
      sceneIndex: director.sceneIndex,
      time: rt?.time ?? 0,
      playing: !!rt?.playing,
      speakingLineId: director.speakingLineId,
      lastLineId: director.lastLineId,
      sceneRunning: director.sceneRunning,
      cameras: director.cameras.length,
      activeCameraId: director.activeCameraId,
      linkStatus: director.linkStatus,
      room: director.room?.room ?? null,
      phones: director.phone.phones,
      lastPose: director.phone.lastPose,
      gizmo: {
        visible: g.visible,
        position: g.position.toArray(),
        quaternion: g.quaternion.toArray(),
      },
      pip: {
        visible: !!director.pipRect,
        label: director.pipLabel,
        frames: director.view.pipFrames,
      },
      mainFrames: director.view.mainFrames,
      ground: rt?.ground ? { cols: rt.ground.cols, rows: rt.ground.rows, cell: rt.ground.cell } : null,
      viewFromPhone: director.viewFromPhone,
      recording: director.recorder.recording,
      lastStillAt: director.lastStillAt,
      actors: [...(rt?.actors.values() ?? [])].map((a) => {
        const placement = (a.object.userData.placement ?? null) as {
          status: string;
          from: number[];
          to: number[];
        } | null;
        return {
          id: a.characterId,
          kind: String(a.object.userData.actorKind ?? ''),
          position: a.object.position.toArray(),
          groundY: rt?.groundY(a.object.position.x, a.object.position.z) ?? 0,
          yaw: a.object.rotation.y,
          /** Line id whose bubble this actor is showing right now (null = name label). */
          speakingLine: (a.object.userData.speakingLine ?? null) as string | null,
          placementCorrected: placement?.status === 'moved',
          placement,
        };
      }),
      dynamics: rt?.dynamics.positions() ?? [],
      voice: voice(),
    };
  };
  Object.defineProperty(window, '__previz', {
    configurable: true,
    value: Object.freeze({ state, director }),
  });
}
