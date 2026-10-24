// Export (docs/PLAN-v4.md "Share"): how the director shows the crew.
//
//   Storyboard (PNG)        one sheet composed on a canvas, ~2400 px wide: the project title, the
//                           scene heading, then the scene's frames three to a row, each with its
//                           number, name, lens, camera height, note and the lines it covers (or —)
//   Storyboard (print/PDF)  the same sheet as a print-ready page in a new window (A4 landscape,
//                           rows kept whole) that opens the print dialog: Save as PDF
//   Shot list (CSV)         every scene's shots from the server (GET /api/projects/:id/shotlist.csv)
//
// Shots without a frame get one first (the view visits each and comes back).
import { api } from '@shared/api';
import { lensLabel } from '@shared/lens';
import { shotNumber, type Shot } from '@shared/shots';
import type { Director } from './director';
import { byId, downloadBlob } from './dom';
import type { ProjectsPanel } from './projects-panel';
import type { ShotsPanel } from './shots-panel';

interface Board {
  title: string;
  sceneLabel: string;
  heading: string;
  file: string;
  cells: { number: string; name: string; lens: string; height: string; note: string; lines: string[]; frame: string | null }[];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'previz';

export function mountExport(director: Director, projects: ProjectsPanel, shots: ShotsPanel, toast: (t: string, ms?: number) => void) {
  const png = byId<HTMLButtonElement>('export-png');
  const print = byId<HTMLButtonElement>('export-print');
  const csv = byId<HTMLAnchorElement>('export-csv');
  const exportBtn = byId<HTMLButtonElement>('top-export');

  const render = () => {
    const id = director.projectId;
    const open = !!director.runtime && !!id;
    exportBtn.disabled = !open;
    png.disabled = print.disabled = !open || !shots.shots().length;
    if (id) {
      csv.href = api.shotlistCsv(id);
      csv.removeAttribute('aria-disabled');
    } else {
      csv.removeAttribute('href');
      csv.setAttribute('aria-disabled', 'true');
    }
  };
  director.on((c) => c === 'scene' && render());
  shots.onChange(render);
  render();

  /** Everything the sheet shows, after grabbing the missing frames. */
  const board = async (): Promise<Board | null> => {
    const rt = director.runtime;
    if (!rt || director.sceneIndex == null) return null;
    if (shots.shots().some((s) => !s.frame)) {
      toast('Grabbing the missing frames…', 8000);
      await shots.grabMissing((done, total) => toast(`Grabbing frames ${Math.min(done + 1, total)} / ${total}…`, 8000));
    }
    await shots.flush().catch(() => {});
    const n = director.sceneIndex;
    const plan = rt.manifest.plan;
    const names = new Map(rt.manifest.characters.map((c) => [c.id, c.name]));
    const title = projects.current()?.title || plan.slug;
    const lineText = (id: string) => {
      const l = plan.dialogue.find((x) => x.id === id);
      return l ? `${names.get(l.characterId) ?? l.characterId}: ${l.text}` : null;
    };
    const cells = shots.shots().map((s: Shot, i) => ({
      number: shotNumber(n, i),
      name: s.name,
      lens: lensLabel(s.fovDeg),
      height: s.heightM != null ? `${s.heightM.toFixed(2)} m` : '',
      note: s.note ?? '',
      lines: s.lines.map(lineText).filter((x): x is string => !!x),
      frame: shots.frameUrl(s),
    }));
    return { title, sceneLabel: `Sc ${n + 1}`, heading: plan.heading, file: `${slug(title)}-sc${n + 1}-storyboard`, cells };
  };

  png.addEventListener('click', async () => {
    const b = await board();
    if (!b) return;
    const blob = await storyboardPng(b);
    if (!blob) return toast('The storyboard could not be drawn');
    downloadBlob(blob, `${b.file}.png`);
    toast(`Storyboard saved: ${b.file}.png`);
  });
  print.addEventListener('click', async () => {
    // opened now (inside the click) so no popup blocker stops it; filled once the frames are in
    const w = window.open('', '_blank');
    if (!w) return toast('Allow pop-ups for this page to print the storyboard');
    w.document.write('<!doctype html><title>Storyboard</title><body style="font:14px system-ui;padding:24px">Preparing the storyboard…</body>');
    const b = await board();
    if (!b) return w.close();
    w.document.open();
    w.document.write(printPage(b));
    w.document.close();
  });
  csv.addEventListener('click', async (e) => {
    if (!director.projectId) return e.preventDefault();
    // unsaved shot changes go first, then the file downloads
    e.preventDefault();
    await shots.flush().catch(() => {});
    const a = document.createElement('a');
    a.href = api.shotlistCsv(director.projectId);
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
  });

  // debug / evidence: window.__export.png() → the sheet as a Blob
  Object.defineProperty(window, '__export', {
    configurable: true,
    value: Object.freeze({ board, png: async () => ((b) => (b ? storyboardPng(b) : null))(await board()) }),
  });
}

// ---- the PNG sheet ----------------------------------------------------------------------------------

const W = 2400;
const M = 88;
const GAP = 44;
const COLS = 3;
const FONT = '-apple-system, system-ui, "Inter", sans-serif';
const INK = '#16171a';
const MUTED = '#6b6f78';
const RULE = '#e3e4e8';
const ACCENT = '#3f5fd8';

async function loadImage(url: string | null): Promise<ImageBitmap | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

/** Lines of `text` that fit `width` (at most `max`, the last one ellipsed). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= width || !line) line = next;
    else {
      out.push(line);
      line = word;
    }
    if (out.length === max) break;
  }
  if (out.length < max && line) out.push(line);
  const used = out.join(' ').split(/\s+/).length;
  if (used < text.split(/\s+/).length && out.length) {
    let last = out[out.length - 1]!;
    while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    out[out.length - 1] = `${last.trimEnd()}…`;
  }
  return out;
}

export async function storyboardPng(b: Board): Promise<Blob | null> {
  const cellW = (W - 2 * M - (COLS - 1) * GAP) / COLS;
  const frameH = Math.round((cellW * 9) / 16);
  const textH = 40 + 34 + 4 * 32 + 12;
  const rowH = frameH + 24 + textH + GAP;
  const headH = 200;
  const rows = Math.max(1, Math.ceil(b.cells.length / COLS));
  const H = headH + rows * rowH + M;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';
  // header: title, scene heading; shot count and date on the right
  ctx.fillStyle = INK;
  ctx.font = `600 60px ${FONT}`;
  ctx.fillText(b.title, M, M + 52);
  ctx.font = `500 34px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(`${b.sceneLabel} · ${b.heading}`, M, M + 104);
  ctx.textAlign = 'right';
  ctx.font = `400 26px ${FONT}`;
  ctx.fillText(`${b.cells.length} shot${b.cells.length === 1 ? '' : 's'} · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · Previz Stage`, W - M, M + 104);
  ctx.textAlign = 'left';
  ctx.fillStyle = RULE;
  ctx.fillRect(M, headH - 30, W - 2 * M, 2);

  const images = await Promise.all(b.cells.map((c) => loadImage(c.frame)));
  b.cells.forEach((c, i) => {
    const x = M + (i % COLS) * (cellW + GAP);
    const y = headH + Math.floor(i / COLS) * rowH;
    // the frame, letterboxed into a 16:9 box (a 2.39 frame keeps its bars)
    ctx.fillStyle = '#0c0d0f';
    ctx.fillRect(x, y, cellW, frameH);
    const img = images[i];
    if (img) {
      const k = Math.min(cellW / img.width, frameH / img.height);
      const w = img.width * k;
      const h = img.height * k;
      ctx.drawImage(img, x + (cellW - w) / 2, y + (frameH - h) / 2, w, h);
    } else {
      ctx.fillStyle = '#8b8f98';
      ctx.font = `400 26px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('no frame', x + cellW / 2, y + frameH / 2 + 9);
      ctx.textAlign = 'left';
    }
    ctx.strokeStyle = RULE;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, cellW - 2, frameH - 2);
    // number + name
    let ty = y + frameH + 24 + 34;
    ctx.fillStyle = ACCENT;
    ctx.font = `700 34px ${FONT}`;
    ctx.fillText(c.number, x, ty);
    const nx = x + ctx.measureText(c.number).width + 16;
    ctx.fillStyle = INK;
    ctx.font = `600 32px ${FONT}`;
    ctx.fillText(wrap(ctx, c.name, cellW - (nx - x), 1)[0] ?? '', nx, ty);
    // lens · height · note
    ty += 40;
    ctx.fillStyle = MUTED;
    ctx.font = `500 26px ${FONT}`;
    const meta = [c.lens, c.height, c.note].filter(Boolean).join(' · ');
    ctx.fillText(wrap(ctx, meta, cellW, 1)[0] ?? '', x, ty);
    // the lines it covers
    ctx.font = `400 25px ${FONT}`;
    ctx.fillStyle = INK;
    const lines = c.lines.length ? wrap(ctx, c.lines.join(' / '), cellW, 4) : ['—'];
    for (const l of lines) {
      ty += 32;
      ctx.fillText(l, x, ty);
    }
  });
  for (const img of images) img?.close();
  return new Promise((r) => canvas.toBlob(r, 'image/png'));
}

// ---- the print page -----------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function printPage(b: Board): string {
  const abs = (u: string | null) => (u ? new URL(u, location.href).href : null);
  const cells = b.cells
    .map((c) => {
      const src = abs(c.frame);
      const meta = [c.lens, c.height, c.note].filter(Boolean).map(esc).join(' · ');
      const lines = c.lines.length ? c.lines.map((l) => `<li>${esc(l)}</li>`).join('') : '<li class="none">—</li>';
      return `<figure>${src ? `<div class="frame"><img src="${esc(src)}" alt=""></div>` : '<div class="frame empty">no frame</div>'}<figcaption><b>${esc(c.number)}</b> ${esc(c.name)}<div class="meta">${meta}</div><ul>${lines}</ul></figcaption></figure>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(b.title)} — ${esc(b.sceneLabel)} storyboard</title>
<style>
@page { size: A4 landscape; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font: 12px/1.4 -apple-system, system-ui, 'Inter', sans-serif; color: #16171a; background: #fff; }
header { display: flex; align-items: baseline; gap: 16px; border-bottom: 1px solid #e3e4e8; padding-bottom: 10px; margin-bottom: 14px; }
h1 { margin: 0; font-size: 20px; }
.sub { color: #6b6f78; font-size: 13px; }
.spacer { flex: 1; }
main { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px 16px; }
figure { margin: 0; break-inside: avoid; page-break-inside: avoid; }
.frame { aspect-ratio: 16 / 9; background: #0c0d0f; display: grid; place-items: center; border: 1px solid #e3e4e8; overflow: hidden; color: #8b8f98; }
.frame img { width: 100%; height: 100%; object-fit: contain; display: block; }
figcaption { padding-top: 6px; }
figcaption b { color: #3f5fd8; margin-right: 4px; }
.meta { color: #6b6f78; font-size: 11px; }
ul { margin: 4px 0 0; padding: 0; list-style: none; font-size: 11px; }
li.none { color: #6b6f78; }
@media screen { body { max-width: 1200px; margin: 0 auto; } }
</style></head><body>
<header><h1>${esc(b.title)}</h1><span class="sub">${esc(b.sceneLabel)} · ${esc(b.heading)}</span><span class="spacer"></span><span class="sub">${b.cells.length} shots</span></header>
<main>${cells}</main>
<script>Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => setTimeout(() => print(), 100));</script>
</body></html>`;
}
