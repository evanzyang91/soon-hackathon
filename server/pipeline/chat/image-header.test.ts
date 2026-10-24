import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../reprompt/png.ts';
import { readImageInfo } from './image-header.ts';

const JPEG = readFileSync(
  new URL('../../../fixtures/real-samples/reference-512.jpg', import.meta.url),
);

/** SOI, an APP0 segment, fill bytes, then a SOFn frame header of the given size. */
function jpegWith(sof: number, width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46];
  const frame = [
    0xff,
    0xff,
    0xff,
    sof,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    0x03,
  ];
  return Buffer.from([0xff, 0xd8, ...app0, ...frame, ...new Array(12).fill(0)]);
}

function webp(chunk: 'VP8 ' | 'VP8L' | 'VP8X', body: number[]): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'latin1');
  b.write(chunk, 12, 'latin1');
  b.writeUInt32LE(20, 16);
  Buffer.from(body).copy(b, 20);
  return b;
}

describe('readImageInfo', () => {
  it('reads PNG IHDR, a real JPEG (APP0 + EXIF before SOF0) and SOF2 behind fill bytes', () => {
    const png = encodePng({ width: 3, height: 2, channels: 3, data: new Uint8Array(18) });
    expect(readImageInfo(png)).toEqual({
      kind: 'png',
      mime: 'image/png',
      ext: 'png',
      width: 3,
      height: 2,
    });
    expect(readImageInfo(JPEG)).toMatchObject({
      kind: 'jpeg',
      ext: 'jpg',
      width: 341,
      height: 512,
    });
    expect(readImageInfo(jpegWith(0xc2, 4032, 3024))).toMatchObject({
      kind: 'jpeg',
      width: 4032,
      height: 3024,
    });
    // DHT (C4) carries no size: it is skipped, not read as a frame
    const dht = [0xff, 0xc4, 0x00, 0x05, 0x00, 0x01, 0x02];
    const dhtFirst = Buffer.concat([
      Buffer.from([0xff, 0xd8, ...dht]),
      jpegWith(0xc0, 640, 480).subarray(2),
    ]);
    expect(readImageInfo(dhtFirst)).toMatchObject({ width: 640, height: 480 });
  });

  it('reads the three WebP flavours', () => {
    // lossy: frame tag, start code 9d 01 2a, 14-bit sizes (top bits are scale)
    expect(
      readImageInfo(webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x07, 0x38, 0x44])),
    ).toMatchObject({
      kind: 'webp',
      width: 1920,
      height: 1080,
    });
    // lossless: 0x2f, then (w-1) in 14 bits and (h-1) in the next 14
    const bits = (800 - 1) | ((600 - 1) << 14);
    expect(
      readImageInfo(
        webp('VP8L', [
          0x2f,
          bits & 255,
          (bits >> 8) & 255,
          (bits >> 16) & 255,
          (bits >>> 24) & 255,
        ]),
      ),
    ).toMatchObject({
      width: 800,
      height: 600,
    });
    // extended: 24-bit canvas size minus one at 24 / 27
    expect(
      readImageInfo(webp('VP8X', [0x10, 0, 0, 0, 0xff, 0x0f, 0, 0xff, 0x07, 0])),
    ).toMatchObject({ width: 4096, height: 2048 });
  });

  it('refuses what is not one of the three, or is cut short', () => {
    expect(readImageInfo(Buffer.from('GIF89a......................'))).toBeNull();
    expect(readImageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(readImageInfo(JPEG.subarray(0, 40))).toBeNull();
    expect(readImageInfo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
    expect(readImageInfo(webp('VP8 ', [0, 0, 0, 1, 2, 3, 0, 0, 0, 0]))).toBeNull();
  });
});
