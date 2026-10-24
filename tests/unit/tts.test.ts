import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Character, DialogueLine } from '../../shared/schema.ts';
import {
  chooseProvider,
  elevenVoiceFor,
  mockDurationSeconds,
  mockWav,
  mp3DurationSeconds,
  openaiVoiceFor,
  synthesizeLine,
  ttsInstructions,
  wavDurationSeconds,
} from '../../server/pipeline/tts.ts';

const maya: Character = { id: 'maya', name: 'MAYA', description: 'x', voice: { id: 'coral', gender: 'female' } };
const line = (text: string, id = 's1-l1'): DialogueLine => ({ id, characterId: 'maya', text, order: 0 });

/** n MPEG audio frames with the given 4-byte header, zero payload. */
function frames(header: number[], length: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(...header, ...new Array(length - 4).fill(0));
  return out;
}

describe('mock WAV', () => {
  it('is a 22.05 kHz mono 16-bit PCM WAV whose length follows the text (0.06 s/char, min 1 s)', () => {
    const text = 'x'.repeat(50);
    const wav = mockWav(text);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(22050);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wavDurationSeconds(wav)).toBeCloseTo(3, 3);
    expect(mockDurationSeconds('hi')).toBe(1);
    expect(wavDurationSeconds(mockWav('hi'))).toBeCloseTo(1, 3);
  });

  it('carries audible syllables (so the mannequin jaw has amplitude to follow)', () => {
    const wav = mockWav('Hello there, how are you');
    let peak = 0;
    let quiet = 0;
    for (let i = 44; i < wav.length; i += 2) {
      const v = Math.abs(wav.readInt16LE(i));
      peak = Math.max(peak, v);
      if (v < 50) quiet++;
    }
    expect(peak).toBeGreaterThan(8000);
    expect(quiet).toBeGreaterThan(100); // gaps between beeps
  });
});

describe('mp3DurationSeconds', () => {
  it('walks MPEG-1 Layer III frames, skipping ID3v2 and the Xing/Info frame', () => {
    const id3 = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0)];
    const header = [0xff, 0xfb, 0x90, 0x64]; // MPEG1 L3, 128 kbps, 44.1 kHz, joint stereo
    const xing = [...header, ...new Array(32).fill(0), ...Buffer.from('Info'), ...new Array(417 - 40).fill(0)];
    const buf = new Uint8Array([...id3, ...xing, ...frames(header, 417, 100)]);
    expect(mp3DurationSeconds(buf)).toBeCloseTo((100 * 1152) / 44100, 6);
  });

  it('handles MPEG-2 Layer III (576 samples/frame) and resyncs over junk', () => {
    const header = [0xff, 0xf3, 0x84, 0xc4]; // MPEG2 L3, 64 kbps, 24 kHz, mono
    const buf = new Uint8Array([1, 2, 3, ...frames(header, 192, 50)]);
    expect(mp3DurationSeconds(buf)).toBeCloseTo((50 * 576) / 24000, 6);
  });

  it('rejects data without MPEG frames', () => {
    expect(() => mp3DurationSeconds(new Uint8Array(1000))).toThrow(/no MPEG/);
  });
});

describe('provider and voice selection', () => {
  const keys = (o: Partial<{ openai: string; elevenlabs: string }>) =>
    ({ marble: '', anthropic: '', openai: '', elevenlabs: '', modalTokenId: '', modalTokenSecret: '', ...o }) as const;
  it('prefers ElevenLabs, then OpenAI, and is offline under MOCK or without keys', () => {
    expect(chooseProvider(true, keys({ openai: 'k', elevenlabs: 'k' }))).toBe('mock');
    expect(chooseProvider(false, keys({ openai: 'k', elevenlabs: 'k' }))).toBe('elevenlabs');
    expect(chooseProvider(false, keys({ openai: 'k' }))).toBe('openai');
    expect(chooseProvider(false, keys({}))).toBe('mock');
  });
  it('keeps a known OpenAI voice, picks by gender otherwise, and maps to ElevenLabs ids', () => {
    expect(openaiVoiceFor(maya)).toBe('coral');
    const raj: Character = { ...maya, id: 'raj', voice: { id: 'deep-baritone', gender: 'male' } };
    expect(['onyx', 'ash', 'echo', 'verse']).toContain(openaiVoiceFor(raj));
    expect(elevenVoiceFor(maya)).toBe('EXAVITQu4vr4xnSDxMaL');
    expect(elevenVoiceFor({ ...maya, voice: { id: 'pNInz6obpgDQGcFmaJgB', gender: 'male' } })).toBe('pNInz6obpgDQGcFmaJgB');
    expect(elevenVoiceFor(raj)).toBe('pNInz6obpgDQGcFmaJgB');
  });
  it('turns the parenthetical into delivery direction', () => {
    expect(ttsInstructions(maya, '(whispering, urgent)')).toMatch(/Direction: whispering, urgent\./);
    expect(ttsInstructions(maya)).not.toMatch(/Direction/);
  });
});

describe('synthesizeLine (MOCK)', () => {
  let dir = '';
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('writes <lineId>.wav, reports its measured duration, and caches via a sidecar', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tts-'));
    const logs: string[] = [];
    const text = 'We should not be here.';
    const a = await synthesizeLine({ line: line(text), character: maya, outDir: dir, mock: true, log: (m) => logs.push(m) });
    expect(a).toEqual({ lineId: 's1-l1', url: 's1-l1.wav', durationSeconds: Math.round(mockDurationSeconds(text) * 1000) / 1000 });
    expect(wavDurationSeconds(await readFile(join(dir, 's1-l1.wav')))).toBeCloseTo(a.durationSeconds, 3);
    const b = await synthesizeLine({ line: line(text), character: maya, outDir: dir, mock: true, log: (m) => logs.push(m) });
    expect(b).toEqual(a);
    expect(logs.filter((l) => l.includes('MOCK'))).toHaveLength(1); // second call was a cache hit
    expect((await readdir(dir)).sort()).toEqual(['s1-l1.json', 's1-l1.wav']);
  });
});
