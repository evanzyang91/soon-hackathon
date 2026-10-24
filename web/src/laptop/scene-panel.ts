// Right panel: phone pairing, scene clock, dropped cameras, suggested shots, dialogue lines.
import QRCode from 'qrcode';
import { newRoom } from './api';
import type { Director } from './director';
import { byId, fmtTime, h } from './dom';
import { storageDel, storageGet, storageSet } from './storage';

function isLocalHost(url: string) {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function mountPhoneSection(director: Director) {
  const qr = byId<HTMLImageElement>('ph-qr');
  const urlInput = byId<HTMLInputElement>('ph-url');
  const status = byId('ph-status');
  const hint = byId('ph-hint');
  const viewBtn = byId<HTMLButtonElement>('ph-view');

  const drawQr = async (url: string) => {
    try {
      qr.src = await QRCode.toDataURL(url, { margin: 1, width: 176 });
      qr.alt = url;
    } catch {
      qr.removeAttribute('src');
    }
    hint.textContent = isLocalHost(url)
      ? 'Phone cannot reach "localhost": replace it with the LAN address printed in the terminal.'
      : '';
  };

  urlInput.addEventListener('change', () => {
    const url = urlInput.value.trim();
    try {
      storageSet('previz:phoneHost', new URL(url).host);
    } catch {
      // not a URL; leave the saved host alone
    }
    void drawQr(url);
  });

  const pair = async () => {
    // the relay recreates rooms on hello, so a saved code survives server restarts
    const saved = storageGet<string>('previz:room');
    const room =
      saved && /^[A-Z0-9]{4,6}$/.test(saved)
        ? { room: saved, phoneUrl: `${location.origin}/phone.html?room=${saved}` }
        : await newRoom();
    // keep a hand-corrected LAN host across reloads
    const host = storageGet<string>('previz:phoneHost');
    if (host) {
      const u = new URL(room.phoneUrl);
      u.host = host;
      room.phoneUrl = u.href;
    }
    urlInput.value = room.phoneUrl;
    await drawQr(room.phoneUrl);
    director.pair(room);
  };

  byId('ph-new').addEventListener('click', async () => {
    storageDel('previz:room');
    await pair().catch((e) => (status.textContent = `pairing failed: ${e}`));
  });
  byId('ph-recenter').addEventListener('click', () => director.recenterPhone());
  viewBtn.addEventListener('click', () => director.setViewFromPhone(!director.viewFromPhone));

  const render = () => {
    const room = director.room?.room ?? '—';
    const phones = director.phone.phones;
    const link = director.linkStatus;
    status.replaceChildren(
      h('span', { class: `dot ${link === 'open' ? (phones ? 'ok' : 'wait') : 'off'}` }),
      `Room ${room} · `,
      link !== 'open'
        ? `relay ${link}`
        : phones
          ? `${phones} phone${phones > 1 ? 's' : ''} connected`
          : 'waiting for phone',
    );
    status.dataset.phones = String(phones);
    viewBtn.classList.toggle('on', director.viewFromPhone);
    viewBtn.textContent = director.viewFromPhone ? 'View: phone' : 'View: director';
  };
  director.on((c) => {
    if (c === 'pairing' || c === 'phone' || c === 'view') render();
  });
  render();
  pair().catch((e) => (status.textContent = `pairing failed: ${e}`));
}

export function mountScenePanel(director: Director) {
  const clock = byId('sc-clock');
  const playBtn = byId<HTMLButtonElement>('sc-play');
  const camList = byId('cam-list');
  const camName = byId<HTMLInputElement>('cam-name');
  const shots = byId('shot-list');
  const lines = byId('line-list');

  playBtn.addEventListener('click', () => director.togglePlay());
  byId('sc-reset').addEventListener('click', () => director.resetClock());
  byId('sc-playall').addEventListener('click', () => void director.playAll());
  byId('sc-stop').addEventListener('click', () => director.stopLines());
  byId('cam-drop').addEventListener('click', () => {
    director.dropCamera(camName.value);
    camName.value = '';
  });
  camName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      director.dropCamera(camName.value);
      camName.value = '';
    }
  });

  const renderClock = () => {
    const rt = director.runtime;
    clock.textContent = fmtTime(rt?.time ?? 0);
    playBtn.textContent = rt?.playing ? 'Pause' : 'Play';
    playBtn.classList.toggle('on', !!rt?.playing);
    playBtn.disabled = !rt;
  };

  const renderCameras = () => {
    camList.replaceChildren();
    if (!director.cameras.length) {
      camList.append(h('div', { class: 'muted' }, 'Fly somewhere and drop a camera (C).'));
      return;
    }
    director.cameras.forEach((c, i) => {
      const active = c.id === director.activeCameraId;
      camList.append(
        h(
          'div',
          {
            class: `cam-row${active ? ' active' : ''}`,
            'data-testid': 'camera-row',
            'data-id': c.id,
          },
          h('input', {
            type: 'radio',
            name: 'active-cam',
            checked: active,
            title: 'Active: the phone attaches here',
            onchange: () => director.setActiveCamera(c.id),
          }),
          h(
            'button',
            { class: 'link', title: 'Fly to', onclick: () => director.flyTo(c) },
            `${i < 9 ? `${i + 1}. ` : ''}${c.name}`,
          ),
          h('span', { class: 'muted small' }, `${Math.round(c.fovDeg)}°`),
          h(
            'button',
            { class: 'icon', title: 'Delete', onclick: () => director.removeCamera(c.id) },
            '×',
          ),
        ),
      );
    });
  };

  const renderShots = () => {
    shots.replaceChildren();
    const list = director.runtime?.manifest.plan.shots ?? [];
    if (!list.length) {
      shots.append(h('div', { class: 'muted' }, 'No suggested shots.'));
      return;
    }
    for (const s of list) {
      shots.append(
        h(
          'div',
          { class: 'shot-row' },
          h('button', { class: 'link', onclick: () => director.flyTo(s) }, s.name),
          h('span', { class: 'muted small' }, `${Math.round(s.fovDeg)}°`),
          h(
            'button',
            { class: 'icon', title: 'Add as camera', onclick: () => director.addShotAsCamera(s) },
            '+',
          ),
        ),
      );
    }
  };

  const renderLines = () => {
    lines.replaceChildren();
    const rt = director.runtime;
    if (!rt) return;
    const names = new Map(rt.manifest.characters.map((c) => [c.id, c.name]));
    const dialogue = [...rt.manifest.plan.dialogue].sort((a, b) => a.order - b.order);
    if (!dialogue.length) lines.append(h('div', { class: 'muted' }, 'No dialogue in this scene.'));
    for (const l of dialogue) {
      const speaking = director.speakingLineId === l.id;
      const hasAudio = rt.manifest.audio.some((a) => a.lineId === l.id);
      lines.append(
        h(
          'button',
          {
            class: `line${speaking ? ' speaking' : ''}`,
            'data-testid': 'line',
            'data-line': l.id,
            title: hasAudio ? 'Play line' : 'Play line (no audio — caption only)',
            onclick: () => void director.playLine(l.id),
          },
          h('span', { class: 'who' }, names.get(l.characterId) ?? l.characterId),
          l.parenthetical
            ? h('span', { class: 'paren' }, `(${l.parenthetical.replace(/^\(|\)$/g, '')})`)
            : null,
          h('span', { class: 'text' }, l.text),
          hasAudio ? null : h('span', { class: 'muted small' }, ' · no audio'),
        ),
      );
    }
  };

  director.on((c) => {
    if (c === 'clock' || c === 'scene') renderClock();
    if (c === 'cameras' || c === 'scene') renderCameras();
    if (c === 'scene') renderShots();
    if (c === 'lines' || c === 'scene') renderLines();
  });
  renderClock();
  renderCameras();
  renderShots();
  renderLines();
}
