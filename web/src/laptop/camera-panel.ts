// Camera mode (docs/PLAN-v4.md "Shoot"): pair the phone (QR + status, re-center, view through the
// phone), record takes, the scene clock, and this session's takes (play in place, download; every
// take also downloads as WebM when it stops, as before). The phone attaches to the shot selected in
// the Shots mode; the line under the QR says which.
import QRCode from 'qrcode';
import { newRoom } from './api';
import type { Director } from './director';
import { byId, fmtTime, h } from './dom';
import { icon } from './icons';
import { storageDel, storageGet, storageSet } from './storage';

function isLocalHost(url: string) {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function mountCameraPanel(director: Director) {
  mountPairing(director);
  mountTake(director);
  mountClock(director);
  mountTakes(director);
}

function mountPairing(director: Director) {
  const qr = byId<HTMLImageElement>('ph-qr');
  const urlInput = byId<HTMLInputElement>('ph-url');
  const status = byId('ph-status');
  const hint = byId('ph-hint');
  const viewBtn = byId<HTMLButtonElement>('ph-view');
  const shot = byId('ph-shot');

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
    // The server picks the host (LAN IP, never localhost) even for a kept code.
    const saved = storageGet<string>('previz:room');
    const room = await newRoom(saved && /^[A-Z0-9]{4,6}$/.test(saved) ? saved : undefined);
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
    const on = director.cameras.find((c) => c.id === director.activeCameraId);
    shot.textContent = on
      ? `The phone is on ${on.name}. Pick another shot in Shots (1–9).`
      : director.runtime
        ? 'The phone is on the scene’s start view. Select a shot in Shots (1–9) to put it there.'
        : '';
  };
  director.on((c) => {
    if (c === 'pairing' || c === 'phone' || c === 'view' || c === 'cameras' || c === 'scene') render();
  });
  render();
  pair().catch((e) => (status.textContent = `pairing failed: ${e}`));
}

function mountTake(director: Director) {
  const recBtn = byId<HTMLButtonElement>('hud-record');
  recBtn.addEventListener('click', () => void director.toggleRecording());
  byId('hud-still').addEventListener('click', () => director.captureStill());
  const render = () => {
    const recording = director.recorder.recording;
    recBtn.textContent = recording ? `Stop take · ${fmtTime((performance.now() - director.recorder.startedAt) / 1000)}` : 'Record take';
    recBtn.classList.toggle('rec', recording);
    recBtn.disabled = !director.recorder.supported || !director.runtime;
  };
  director.on((c) => {
    if (c === 'recording' || c === 'scene' || (c === 'clock' && director.recorder.recording)) render();
  });
  render();
}

function mountClock(director: Director) {
  const clock = byId('sc-clock');
  const playBtn = byId<HTMLButtonElement>('sc-play');
  playBtn.addEventListener('click', () => director.togglePlay());
  byId('sc-reset').addEventListener('click', () => director.resetClock());
  const render = () => {
    const rt = director.runtime;
    clock.textContent = fmtTime(rt?.time ?? 0);
    playBtn.textContent = rt?.playing ? 'Pause' : 'Play';
    playBtn.classList.toggle('on', !!rt?.playing);
    playBtn.disabled = !rt;
  };
  director.on((c) => {
    if (c === 'clock' || c === 'scene') render();
  });
  render();
}

function mountTakes(director: Director) {
  const list = byId('take-list');
  let playing: number | null = null;
  const render = () => {
    list.replaceChildren();
    const takes = director.takeList;
    if (!takes.length) {
      list.append(h('div', { class: 'empty' }, 'No takes yet. Press R (or Record take) and play the scene.'));
      return;
    }
    for (const t of [...takes].reverse()) {
      const open = playing === t.n;
      const row = h(
        'div',
        { class: `list-row take-row${open ? ' current' : ''}`, 'data-testid': 'take-row', 'data-take': t.n },
        h('button', { type: 'button', class: 'icon', title: open ? 'Close the player' : 'Play this take', 'aria-label': open ? 'Close' : 'Play', 'data-testid': 'take-play', onclick: () => ((playing = open ? null : t.n), render()) }, icon(open ? 'close' : 'play')),
        h('span', { class: 'take-name', title: t.file }, t.name),
        h('span', { class: 'muted small num' }, fmtTime(t.seconds)),
        h('a', { class: 'icon-btn take-dl', href: t.url, download: t.file, title: `Download ${t.file}`, 'aria-label': 'Download', 'data-testid': 'take-download' }, icon('download')),
      );
      list.append(row);
      if (open) list.append(h('video', { class: 'take-video', src: t.url, controls: true, autoplay: true, playsinline: true, 'data-testid': 'take-video' }));
    }
  };
  director.on((c) => {
    if (c === 'recording') render();
  });
  render();
}
