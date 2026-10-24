// window.__previz: read-only snapshot for e2e tests and debugging from the devtools console.
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
  actors: string[];
  dynamics: { id: string; position: number[]; phase: string }[];
}

export function installDebugHook(director: Director) {
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
      viewFromPhone: director.viewFromPhone,
      recording: director.recorder.recording,
      actors: rt ? [...rt.actors.keys()] : [],
      dynamics: rt?.dynamics.positions() ?? [],
    };
  };
  Object.defineProperty(window, '__previz', {
    configurable: true,
    value: Object.freeze({ state, director }),
  });
}
