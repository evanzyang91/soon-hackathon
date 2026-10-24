// Image type + pixel size from the first bytes of a PNG, JPEG or WebP, without decoding it. The
// upload route trusts these bytes, not the client's content-type: a phone that labels a JPEG as
// PNG still gets a correct Attachment, and anything else is refused before it reaches Claude.
//
//   PNG   signature + IHDR (width, height: u32 BE at 16 / 20)
//   JPEG  SOI, then marker segments up to the first SOFn (precision, height, width: u16 BE)
//   WebP  RIFF/WEBP with a VP8 (lossy key frame), VP8L (lossless) or VP8X (extended) first chunk
//
// JPEG sizes are the stored ones (EXIF orientation is not applied).

export type ImageKind = 'png' | 'jpeg' | 'webp';

export interface ImageInfo {
  kind: ImageKind;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  /** File extension used for uploads/<id>.<ext> (served with a matching MIME by server/index.ts). */
  ext: 'png' | 'jpg' | 'webp';
  width: number;
  height: number;
}

const INFO: Record<ImageKind, Pick<ImageInfo, 'mime' | 'ext'>> = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
};

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

/** Which of the three formats the bytes are, by magic number; null for anything else. */
export function sniffImageKind(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  return null;
}

function pngSize(b: Uint8Array): [number, number] | null {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  return [u32be(b, 16), u32be(b, 20)];
}

// SOF0-3, 5-7, 9-11, 13-15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1]!;
    // fill bytes: any number of 0xFF may precede the marker code
    while (m === 0xff && i + 2 < b.length) m = b[++i + 1]!;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    if (m === 0xd9 || m === 0xda) return null; // end of image / start of scan before any frame
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    if (isSof(m)) {
      if (i + 9 > b.length) return null;
      return [u16be(b, i + 7), u16be(b, i + 5)];
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): [number, number] | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    // key frame: 3-byte frame tag, start code 9d 01 2a, then 14-bit width / height (+2 scale bits)
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return [(b[26]! | (b[27]! << 8)) & 0x3fff, (b[28]! | (b[29]! << 8)) & 0x3fff];
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === 'VP8X') return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  return null;
}

/** Type and size of a PNG / JPEG / WebP; null when the bytes are not one or the header is broken. */
export function readImageInfo(b: Uint8Array): ImageInfo | null {
  const kind = sniffImageKind(b);
  if (!kind) return null;
  const size = kind === 'png' ? pngSize(b) : kind === 'jpeg' ? jpegSize(b) : webpSize(b);
  if (!size || size[0] < 1 || size[1] < 1) return null;
  return { kind, ...INFO[kind], width: size[0], height: size[1] };
}
