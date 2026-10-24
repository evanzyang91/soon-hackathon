// Browser platform glue for the phone page: iOS motion permission, fullscreen + landscape lock,
// screen wake lock. All best-effort; every call must be made from inside the "Tap to start"
// gesture handler (they are invoked synchronously before their first await).

export type PermissionResult = 'granted' | 'denied' | 'not-needed' | 'error';

export function requestSensorPermission(): Promise<PermissionResult> {
  type WithPermission = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };
  const DOE = (window as unknown as { DeviceOrientationEvent?: WithPermission })
    .DeviceOrientationEvent;
  const DME = (window as unknown as { DeviceMotionEvent?: WithPermission }).DeviceMotionEvent;
  const asks: Promise<string>[] = [];
  // Both requests are issued synchronously inside the tap (iOS shows a single prompt).
  if (typeof DOE?.requestPermission === 'function') asks.push(DOE.requestPermission());
  if (typeof DME?.requestPermission === 'function') asks.push(DME.requestPermission());
  if (asks.length === 0) return Promise.resolve('not-needed');
  return Promise.all(asks).then(
    (r) => (r.every((x) => x === 'granted') ? 'granted' : 'denied'),
    (err) => {
      console.warn('[phone] sensor permission failed', err);
      return 'error' as const;
    },
  );
}

export async function enterFullscreenLandscape() {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else el.webkitRequestFullscreen?.(); // iPhone Safari has neither for non-video elements
  } catch {
    // not allowed / unsupported: carry on windowed
  }
  try {
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await so?.lock?.('landscape');
  } catch {
    // iOS Safari and desktop do not support orientation lock
  }
}

type WakeLockApi = { request(t: 'screen'): Promise<unknown> };
let wakeLockBound = false;
/** Keep the display awake during a take (re-acquired when the page becomes visible again). */
export async function keepScreenOn() {
  const wl = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
  if (!wl) return;
  try {
    await wl.request('screen');
  } catch {
    // battery saver / unsupported
  }
  if (!wakeLockBound) {
    wakeLockBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void keepScreenOn();
    });
  }
}
