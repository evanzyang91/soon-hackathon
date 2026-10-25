// Viewport overlays: scene title, loading/error, caption, PiP frame, REC badge, view toggles,
// plus the director keyboard shortcuts.
import type { WorldAsset } from '@shared/schema';
import { floorOffset } from '../viewer/transform';
import type { SplatQuality } from '../viewer/world';
import type { Director } from './director';
import { byId, fmtTime, isTyping } from './dom';

/**
 * The HUD's scale reference: calibrate.ts's `headline` ("door 2.04 m" / "unverified"); older
 * calibrations without one lead their evidence with the same text before the first " · ".
 */
export function scaleHeadline(cal: NonNullable<WorldAsset['scaleCalibration']>): string {
  return cal.headline?.trim() || cal.evidence.split(' · ')[0]?.trim() || '';
}

export function mountHud(director: Director) {
  const title = byId('hud-title');
  const badges = byId('hud-badges');
  const loading = byId('hud-loading');
  const caption = byId('hud-caption');
  const pipFrame = byId('pip-frame');
  const pipLabel = byId('pip-label');
  const rec = byId('hud-rec');
  const recBtn = byId<HTMLButtonElement>('hud-record');
  const pipBtn = byId<HTMLButtonElement>('hud-pip');
  const gridBtn = byId<HTMLButtonElement>('hud-grid');
  const colliderBtn = byId<HTMLButtonElement>('hud-collider');
  const quality = byId<HTMLSelectElement>('hud-quality');
  const empty = byId('hud-empty');

  recBtn.addEventListener('click', () => void director.toggleRecording());
  byId('hud-still').addEventListener('click', () => director.captureStill());
  byId('hud-reload').addEventListener('click', () => director.reloadScene());
  pipBtn.addEventListener('click', () => director.setPip(!director.pipEnabled));
  gridBtn.addEventListener('click', () => {
    const rt = director.runtime;
    if (!rt) return;
    rt.grid.visible = !rt.grid.visible;
    gridBtn.classList.toggle('on', rt.grid.visible);
  });
  colliderBtn.addEventListener('click', () => {
    const c = director.runtime?.collider;
    if (!c) return;
    c.visible = !c.visible;
    colliderBtn.classList.toggle('on', c.visible);
  });
  quality.addEventListener('change', () => void director.setQuality(quality.value as SplatQuality));

  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') {
      // a focused button would also activate on Space and toggle twice
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      director.togglePlay();
    } else if (e.code === 'KeyC') director.dropCamera();
    else if (e.code === 'KeyV') director.setViewFromPhone(!director.viewFromPhone);
    else if (e.code === 'KeyR') void director.toggleRecording();
    else if (e.code === 'KeyG') gridBtn.click();
    else if (/^Digit[1-9]$/.test(e.code)) {
      const cam = director.cameras[Number(e.code.slice(5)) - 1];
      if (cam) {
        director.setActiveCamera(cam.id);
        director.flyTo(cam);
      }
    }
  });

  const renderScene = () => {
    const rt = director.runtime;
    empty.hidden = !!rt || !!director.loading;
    title.textContent = rt ? rt.manifest.plan.heading : '';
    title.title = rt?.manifest.world.caption ?? '';
    badges.replaceChildren();
    if (rt?.placeholder) {
      const b = document.createElement('span');
      b.className = 'badge warn';
      b.textContent = 'placeholder world';
      b.title = 'The SPZ could not be loaded; showing a procedural stand-in.';
      badges.append(b);
    }
    if (rt && director.sceneStale) {
      const b = document.createElement('button');
      b.className = 'badge warn';
      b.dataset.testid = 'scene-stale';
      b.textContent = 'scene updated — reload';
      b.title = 'An actor was rebuilt; reload the scene to show it';
      b.addEventListener('click', () => director.reloadScene());
      badges.append(b);
    }
    if (rt?.manifest.world.provider === 'mock') {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'mock world';
      badges.append(b);
    }
    // measured scale (server/pipeline/calibrate.ts): "scale ×0.87 (door 2.04 m)"
    const world = rt?.manifest.world;
    const cal = world?.scaleCalibration;
    if (cal) {
      const b = document.createElement('span');
      b.className = `badge scale ${cal.confidence}`;
      b.dataset.testid = 'scale-calibration';
      const ref = scaleHeadline(cal);
      b.textContent = `scale ×${cal.factor.toFixed(2)}${ref ? ` (${ref})` : ''}`;
      const floor = floorOffset(world);
      b.title = [
        `Scale calibration: ×${cal.factor} on top of Marble's metric scale (${cal.method}, ${cal.confidence} confidence)`,
        ...cal.evidence.split(' · '),
        ...(floor ? [`Floor: world raised ${(floor * 100).toFixed(0)} cm so actors stand on the visible ground`] : []),
      ].join('\n');
      badges.append(b);
    }
    for (const opt of quality.options)
      opt.disabled = !rt?.manifest.world.spz[opt.value as SplatQuality];
    quality.value = rt?.quality ?? director.quality;
    gridBtn.classList.toggle('on', !!rt?.grid.visible);
    colliderBtn.disabled = !rt?.collider;
    colliderBtn.classList.toggle('on', !!rt?.collider?.visible);
  };

  const renderLoading = () => {
    loading.hidden = !director.loading && !director.error;
    loading.classList.toggle('error', !!director.error);
    loading.textContent = director.error
      ? `Scene failed: ${director.error}`
      : (director.loading ?? '');
    empty.hidden = !!director.runtime || !!director.loading;
  };

  const renderCaption = () => {
    const rt = director.runtime;
    const line = rt?.manifest.plan.dialogue.find((l) => l.id === director.speakingLineId);
    caption.hidden = !line;
    if (line && rt) {
      const who =
        rt.manifest.characters.find((c) => c.id === line.characterId)?.name ?? line.characterId;
      caption.replaceChildren();
      const b = document.createElement('b');
      b.textContent = `${who}: `;
      caption.append(b, line.text);
    }
  };

  const renderFrame = () => {
    const r = director.pipRect;
    pipFrame.hidden = !r;
    if (r) {
      pipFrame.style.left = `${r.x}px`;
      pipFrame.style.top = `${r.y}px`;
      pipFrame.style.width = `${r.width}px`;
      pipFrame.style.height = `${r.height}px`;
      pipLabel.textContent = director.pipLabel;
    }
    pipBtn.classList.toggle('on', director.pipEnabled);
    const recording = director.recorder.recording;
    rec.hidden = !recording;
    if (recording)
      rec.textContent = `REC ${fmtTime((performance.now() - director.recorder.startedAt) / 1000)}`;
    recBtn.textContent = recording ? 'Stop take' : 'Record take';
    recBtn.classList.toggle('rec', recording);
    recBtn.disabled = !director.recorder.supported;
  };

  director.on((c) => {
    if (c === 'scene' || c === 'loading') {
      renderScene();
      renderLoading();
    }
    if (c === 'lines' || c === 'scene') renderCaption();
    if (c === 'clock' || c === 'view' || c === 'recording') renderFrame();
  });
  renderScene();
  renderLoading();
  renderCaption();
  renderFrame();
}
