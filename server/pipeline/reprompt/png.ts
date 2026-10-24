// Minimal PNG codec for the panorama edit (no image dependency on the server): decode 8-bit
// grey / RGB / RGBA / grey-alpha non-interlaced PNGs, bilinear resize, encode RGB(A). Enough for
// Marble panoramas (8-bit RGB) and OpenAI image outputs.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA) */
  channels: 3 | 4;
  data: Uint8Array;
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const isPng = (b: Uint8Array) => Buffer.from(b.subarray(0, 8)).equals(SIG);

export function decodePng(buf: Uint8Array): Image {
  const b = Buffer.from(buf);
  if (!isPng(b)) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const name = b.toString('latin1', off + 4, off + 8);
    const body = b.subarray(off + 8, off + 8 + len);
    if (name === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (bit depth ${depth}, interlace ${interlace})`);
  const srcCh = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!srcCh) throw new Error(`unsupported PNG colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * srcCh;
  const px = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= srcCh ? cur[i - srcCh]! : 0;
      const up = prev[i]!;
      const c = i >= srcCh ? prev[i - srcCh]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  if (srcCh === 3 || srcCh === 4) return { width, height, channels: srcCh, data: px };
  // grey / grey-alpha → RGB(A)
  const ch = srcCh === 1 ? 3 : 4;
  const out = new Uint8Array(width * height * ch);
  for (let i = 0; i < width * height; i++) {
    const g = px[i * srcCh]!;
    out[i * ch] = out[i * ch + 1] = out[i * ch + 2] = g;
    if (ch === 4) out[i * ch + 3] = px[i * srcCh + 1]!;
  }
  return { width, height, channels: ch, data: out };
}

function chunk(name: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const nb = Buffer.from(name, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([nb, body])) >>> 0);
  return Buffer.concat([len, nb, body, crc]);
}

export function encodePng(img: Image): Buffer {
  const { width, height, channels, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Bilinear resize (channels kept). */
export function resize(img: Image, width: number, height: number): Image {
  const { channels: ch } = img;
  const out = new Uint8Array(width * height * ch);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(img.height - 1, Math.floor(fy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(img.width - 1, Math.floor(fx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < ch; c++) {
        const a = img.data[(y0 * img.width + x0) * ch + c]!;
        const b = img.data[(y0 * img.width + x1) * ch + c]!;
        const d = img.data[(y1 * img.width + x0) * ch + c]!;
        const e = img.data[(y1 * img.width + x1) * ch + c]!;
        out[(y * width + x) * ch + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
      }
    }
  }
  return { width, height, channels: ch, data: out };
}

/**
 * OpenAI edit mask (RGBA): transparent where the image may change, opaque where it must stay.
 * 'sky' frees the top `skyFraction` of an equirectangular panorama (above the horizon, with a
 * soft 4 % band); 'whole' frees everything.
 */
export function editMask(width: number, height: number, region: 'sky' | 'whole', skyFraction = 0.47): Image {
  const data = new Uint8Array(width * height * 4);
  const band = Math.max(1, Math.round(height * 0.04));
  const edge = Math.round(height * skyFraction);
  for (let y = 0; y < height; y++) {
    const alpha =
      region === 'whole' ? 0 : y < edge - band ? 0 : y >= edge ? 255 : Math.round(((y - (edge - band)) / band) * 255);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
      data[i + 3] = alpha;
    }
  }
  return { width, height, channels: 4, data };
}

/** Drops alpha (Marble image prompts are RGB). */
export function toRgb(img: Image): Image {
  if (img.channels === 3) return img;
  const out = new Uint8Array(img.width * img.height * 3);
  for (let i = 0; i < img.width * img.height; i++) {
    out[i * 3] = img.data[i * 4]!;
    out[i * 3 + 1] = img.data[i * 4 + 1]!;
    out[i * 3 + 2] = img.data[i * 4 + 2]!;
  }
  return { width: img.width, height: img.height, channels: 3, data: out };
}
