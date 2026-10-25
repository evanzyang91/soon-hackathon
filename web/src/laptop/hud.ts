// Viewport overlays and the top bar's breadcrumb: `Project · Sc 1 · HEADING`, the warnings that
// matter to the director (a stand-in world, a rebuilt actor waiting for a reload), loading / error,
// caption, PiP frame, REC badge, PiP + frame-guide toggles, and the viewport keys Space / 0 / V / R.
// (Splat quality, grid, collider and reload live in Tools › Developer, tools.ts.)
import type { WorldAsset } from '@shared/schema';
import type { Director } from './director';
import { byId, fmtTime, isTyping } from './dom';
import type { ProjectsPanel } from './projects-panel';
import type { ShotsPanel } from './shots-panel';

/**
 * The world's scale reference: calibrate.ts's `headline` ("door 2.04 m" / "unverified"); older
 * calibrations without one lead their evidence with the same text before the first " · ".
 */
export function scaleHeadline(cal: NonNullable<WorldAsset['scaleCalibration']>): string {
  return cal.headline?.trim() || cal.evidence.split(' · ')[0]?.trim() || '';
}

export function mountHud(director: Director, projects: ProjectsPanel) {
  const crumbs = byId('crumbs');
  const project = byId('hud-project');
  const sceneNo = byId('hud-scene-no');
  const title = byId('hud-title');
  const badges = byId('hud-badges');
  const loading = byId('hud-loading');
  const caption = byId('hud-caption');
  const pipFrame = byId('pip-frame');
  const pipLabel = byId('pip-label');
  const rec = byId('hud-rec');
  const pipBtn = byId<HTMLButtonElement>('hud-pip');
  const empty = byId('hud-empty');

  pipBtn.addEventListener('click', () => director.setPip(!director.pipEnabled));

  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') {
      // a focused button would also activate on Space and toggle twice
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      director.togglePlay();
    } else if (e.code === 'Digit0' || e.code === 'Numpad0') director.resetScene();
    else if (e.code === 'KeyV') director.setViewFromPhone(!director.viewFromPhone);
    else if (e.code === 'KeyR') void director.toggleRecording();
  });

  const renderCrumbs = () => {
    const rt = director.runtime;
    crumbs.hidden = !rt;
    const p = projects.current();
    project.textContent = p?.title ?? '';
    project.hidden = !p?.title;
    sceneNo.textContent = director.sceneIndex != null ? `Sc ${director.sceneIndex + 1}` : '';
    title.textContent = rt ? rt.manifest.plan.heading : '';
    title.title = rt?.manifest.world.caption ?? '';
  };

  const renderScene = () => {
    const rt = director.runtime;
    empty.hidden = !!rt || !!director.loading;
    renderCrumbs();
    badges.replaceChildren();
    if (rt?.placeholder) {
      const b = document.createElement('span');
      b.className = 'badge warn';
      b.textContent = 'placeholder world';
      b.title = 'The world could not be loaded; a procedural stand-in is shown.';
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
  };

  const renderLoading = () => {
    loading.hidden = !director.loading && !director.error;
    loading.classList.toggle('error', !!director.error);
    loading.textContent = director.error ? `Scene failed: ${director.error}` : (director.loading ?? '');
    empty.hidden = !!director.runtime || !!director.loading;
  };

  const renderCaption = () => {
    const rt = director.runtime;
    const line = rt?.manifest.plan.dialogue.find((l) => l.id === director.speakingLineId);
    caption.hidden = !line;
    if (line && rt) {
      const who = rt.manifest.characters.find((c) => c.id === line.characterId)?.name ?? line.characterId;
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
    if (recording) rec.textContent = `REC ${fmtTime((performance.now() - director.recorder.startedAt) / 1000)}`;
  };

  director.on((c) => {
    if (c === 'scene' || c === 'loading') {
      renderScene();
      renderLoading();
    }
    if (c === 'lines' || c === 'scene') renderCaption();
    if (c === 'clock' || c === 'view' || c === 'recording') renderFrame();
  });
  projects.onChange(renderCrumbs);
  renderScene();
  renderLoading();
  renderCaption();
  renderFrame();
}

/** The viewport's frame-guide aspect toggle (16:9 / 2.39), next to PiP. */
export function mountGuideToggle(shots: ShotsPanel) {
  const b169 = byId<HTMLButtonElement>('hud-guide-169');
  const b239 = byId<HTMLButtonElement>('hud-guide-239');
  const render = () => {
    const a = shots.guideAspect();
    b169.classList.toggle('on', a === '16:9');
    b239.classList.toggle('on', a === '2.39');
    b169.setAttribute('aria-pressed', String(a === '16:9'));
    b239.setAttribute('aria-pressed', String(a === '2.39'));
  };
  b169.addEventListener('click', () => shots.setGuideAspect('16:9'));
  b239.addEventListener('click', () => shots.setGuideAspect('2.39'));
  shots.onChange(render);
  render();
}
