// Phone audio unlock. iOS Safari (and Chromium with a user-gesture autoplay policy) only lets an
// AudioContext start inside a user gesture, while the viewer creates its AudioListener much later,
// at scene load, where a resume() silently fails and the actors never speak. So the "Tap to start"
// handler creates the context, resumes it and plays one silent sample (all synchronously, inside
// the gesture), then hands it to three.js: every later THREE.AudioListener shares that context.
// Any later tap resumes it again (autostart without a gesture, iOS "interrupted" after a call or
// a trip to the background).
import { AudioContext as ThreeAudioContext } from 'three';

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };
type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** Plays one silent sample: what actually unlocks output on iOS. */
function kick(ctx: AudioContext) {
  try {
    void ctx.resume().catch(() => {});
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    // a closed or broken context: nothing to unlock
  }
}

/**
 * Call synchronously from a user-gesture handler, before any await. Returns the shared context
 * (null when the browser has no Web Audio); `onState` hears every state change.
 */
export function unlockAudio(onState: (state: AudioContextState | 'none') => void): AudioContext | null {
  const nav = navigator as AudioSessionNavigator;
  // iOS 16.4+: play through the ring / silent switch like a video would (default 'auto' mutes)
  try {
    if (nav.audioSession) nav.audioSession.type = 'playback';
  } catch {
    // older WebKit: the switch decides
  }
  const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
  if (!Ctor) {
    onState('none');
    return null;
  }
  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    onState('none');
    return null;
  }
  kick(ctx);
  ThreeAudioContext.setContext(ctx);
  ctx.addEventListener('statechange', () => onState(ctx.state));
  onState(ctx.state);
  const again = () => {
    if (ctx.state !== 'running') kick(ctx);
  };
  // touchend / click are the gestures iOS accepts; pointerdown / keydown cover desktop Chromium
  for (const ev of ['touchend', 'pointerup', 'click', 'pointerdown', 'keydown'])
    document.addEventListener(ev, again, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') again();
  });
  return ctx;
}
