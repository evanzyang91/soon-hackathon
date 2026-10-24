// phone.html?pose=external: the native ARKit app (ios/) owns the relay and the pose; this page
// only renders. Contract: ios/README.md, "Web side contract".
import type { PhonePose, ServerMessage } from '@shared/protocol';

declare global {
  interface Window {
    __previzPose?: (pose: PhonePose) => void;
    __previzMessage?: (msg: ServerMessage) => void;
    __previzNative?: Record<string, unknown>;
    __previzNativeHost?: { platform: 'ios'; source: 'arkit'; bridge: number };
    webkit?: { messageHandlers?: { previz?: { postMessage(msg: unknown): void } } };
  }
}

/** The external pose's lens, clamped only to what the protocol allows ([10, 120]). */
export const clampExternalFov = (f: number) => Math.min(120, Math.max(10, f));

/** Page → native (optional-chained: a plain browser has no handler). */
export function postToNative(
  msg: { type: 'ready' } | { type: 'cmd'; cmd: string } | { type: 'log'; message: string },
) {
  window.webkit?.messageHandlers?.previz?.postMessage(msg);
}

/**
 * Installs window.__previzPose / __previzMessage, then tells native the page is ready (native
 * replays the latest peers, scene and pose). `onPose` must stay cheap: it runs up to 60 Hz.
 */
export function installBridge(handlers: {
  onPose: (pose: PhonePose) => void;
  onMessage: (msg: ServerMessage) => void;
}): void {
  window.__previzPose = (pose) => handlers.onPose(pose);
  window.__previzMessage = (msg) => {
    if (msg.type !== 'pose') handlers.onMessage(msg);
  };
  postToNative({ type: 'ready' });
}
