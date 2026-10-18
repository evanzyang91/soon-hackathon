// WP D: dialogue line -> audio file + measured duration.
//
//   synthesizeLine({ line, character, outDir, mock, log }) -> LineAudio   (contract with WP C)
//
// Provider order: ElevenLabs when ELEVENLABS_API_KEY is set, else OpenAI `gpt-4o-mini-tts`
// (voice = character.voice.id, delivery from the parenthetical). Output `<outDir>/<lineId>.mp3`,
// duration measured by walking the MP3 frames (no ffmpeg). A sidecar `<lineId>.json` caches the
// result per (provider, voice, model, text, instructions). MOCK, missing keys or a provider
// failure write `<lineId>.wav`: offline syllable beeps, 0.06 s per character (min 1 s), so the
// actors' playback/jaw path is exercised without credits. Outside MOCK those beeps are marked
// `fallback: true` so project.ts retries the real provider later. Key values are never logged.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Character, DialogueLine, LineAudio } from '../../shared/schema.ts';
import { env } from '../env.ts';

export interface SynthesizeLineOptions {
  line: DialogueLine;
  character: Character;
  outDir: string;
  mock: boolean;
  log: (m: string) => void;
  /** Provider keys (default: env). Tests pass their own so they never reach the network. */
  keys?: typeof env.keys;
}

export const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';
export const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2';
export const OPENAI_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
] as const; // prettier-ignore
const VOICES_BY_GENDER: Record<Character['voice']['gender'], string[]> = {
  female: ['coral', 'nova', 'shimmer', 'sage'],
  male: ['onyx', 'ash', 'echo', 'verse'],
  neutral: ['alloy', 'fable', 'ballad'],
};
/**
 * OpenAI voice name -> ElevenLabs premade voice id (default library voices, available to every
 * account). A character.voice.id that already looks like an ElevenLabs id is used verbatim.
 */
export const ELEVENLABS_VOICES: Record<string, string> = {
  alloy: '21m00Tcm4TlvDq8ikWAM', // Rachel
  ash: 'pNInz6obpgDQGcFmaJgB', // Adam
  ballad: 'ErXwobaYiN019PkySvjV', // Antoni
  coral: 'EXAVITQu4vr4xnSDxMaL', // Bella / Sarah
  echo: 'TxGEqnHWrfWFTfGW9XjX', // Josh
  fable: 'yoZ06aMxZJJ28mfd3POQ', // Sam
  nova: 'MF3mGyEYCl7XYWbV9V5O', // Elli
  onyx: 'VR6AewLTigWG4xSOukaG', // Arnold
  sage: 'AZnzlk1XvdvUeBnXmlld', // Domi
  shimmer: 'EXAVITQu4vr4xnSDxMaL', // Bella / Sarah
  verse: 'ErXwobaYiN019PkySvjV', // Antoni
  marin: '21m00Tcm4TlvDq8ikWAM', // Rachel
  cedar: 'pNInz6obpgDQGcFmaJgB', // Adam
};
const ELEVEN_BY_GENDER = { female: 'EXAVITQu4vr4xnSDxMaL', male: 'pNInz6obpgDQGcFmaJgB', neutral: '21m00Tcm4TlvDq8ikWAM' };

function hashIndex(s: string, n: number): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h % n;
}

/** A valid OpenAI voice for the character: its own id when OpenAI knows it, else by gender. */
export function openaiVoiceFor(character: Character): string {
  const id = character.voice.id.toLowerCase();
  if ((OPENAI_VOICES as readonly string[]).includes(id)) return id;
  const pool = VOICES_BY_GENDER[character.voice.gender ?? 'neutral'];
  return pool[hashIndex(character.id, pool.length)]!;
}

export function elevenVoiceFor(character: Character): string {
  if (/^[A-Za-z0-9]{20}$/.test(character.voice.id)) return character.voice.id;
  return ELEVENLABS_VOICES[character.voice.id.toLowerCase()] ?? ELEVEN_BY_GENDER[character.voice.gender ?? 'neutral'];
}

/** Delivery instructions for gpt-4o-mini-tts from the screenplay parenthetical. */
export function ttsInstructions(character: Character, parenthetical?: string): string {
  const how = parenthetical?.replace(/^\s*\(|\)\s*$/g, '').trim();
  return [
    `You are ${character.name}, a character in a short film, performing a line of dialogue.`,
    'Natural, grounded screen-acting delivery; no narration voice.',
    how ? `Direction: ${how}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------------------------
// Audio formats
// ---------------------------------------------------------------------------------------------

export const MOCK_SECONDS_PER_CHAR = 0.06;
export const mockDurationSeconds = (text: string) => Math.max(1, MOCK_SECONDS_PER_CHAR * text.length);

/** 16-bit mono PCM WAV of syllable-like beeps (loud/quiet alternation drives the actor's jaw). */
export function mockWav(text: string, rate = 22050): Buffer {
  const seconds = mockDurationSeconds(text);
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(n * 2, 40);
  const syllable = 0.2;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const k = Math.floor(t / syllable);
    const u = (t % syllable) / syllable;
    const env = u < 0.6 ? Math.sin((Math.PI * u) / 0.6) : 0; // 120 ms beep, 80 ms gap
    const f = 180 + 60 * ((k * 7) % 5); // a little melody so lines are distinguishable
    const fade = Math.min(1, t / 0.02, (seconds - t) / 0.02);
    b.writeInt16LE(Math.round(0.3 * 32767 * env * fade * Math.sin(2 * Math.PI * f * t)), 44 + i * 2);
  }
  return b;
}

/** Duration of a PCM WAV from its fmt/data chunks. */
export function wavDurationSeconds(buf: Uint8Array): number {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = b.readUInt32LE(off + 16);
    if (id === 'data') {
      if (!byteRate) throw new Error('WAV data before fmt');
      return Math.min(size, b.length - off - 8) / byteRate;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

const MP3_BITRATES = {
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Mp3Frame {
  length: number;
  samples: number;
  sampleRate: number;
  sideInfo: number;
}

export function mp3FrameAt(b: Uint8Array, i: number): Mp3Frame | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1]! >> 3) & 3; // 0 = 2.5, 2 = 2, 3 = 1
  const layer = (b[i + 1]! >> 1) & 3; // 1 = III, 2 = II, 3 = I
  const brIndex = b[i + 2]! >> 4;
  const srIndex = (b[i + 2]! >> 2) & 3;
  const padding = (b[i + 2]! >> 1) & 1;
  const mono = b[i + 3]! >> 6 === 3;
  if (version === 1 || layer === 0 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const v1 = version === 3;
  const table = layer === 3 ? (v1 ? MP3_BITRATES.v1l1 : MP3_BITRATES.v2l1) : layer === 2 ? (v1 ? MP3_BITRATES.v1l2 : MP3_BITRATES.v2l23) : v1 ? MP3_BITRATES.v1l3 : MP3_BITRATES.v2l23;
  const bitrate = table[brIndex]! * 1000;
  const sampleRate = MP3_RATES[version]![srIndex]!;
  let length: number;
  let samples: number;
  if (layer === 3) {
    length = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
    samples = 384;
  } else if (layer === 2 || v1) {
    length = Math.floor((144 * bitrate) / sampleRate) + padding;
    samples = 1152;
  } else {
    length = Math.floor((72 * bitrate) / sampleRate) + padding;
    samples = 576;
  }
  const sideInfo = layer === 1 ? (v1 ? (mono ? 17 : 32) : mono ? 9 : 17) : 0;
  return length >= 21 ? { length, samples, sampleRate, sideInfo } : null;
}

/** Duration of an MP3 (CBR or VBR) by walking its frames; skips ID3v2 and a Xing/Info frame. */
export function mp3DurationSeconds(b: Uint8Array): number {
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 && b.length >= 10) {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    i = 10 + size + (b[5]! & 0x10 ? 10 : 0);
  }
  let samples = 0;
  let rate = 0;
  let frames = 0;
  while (i + 4 <= b.length) {
    const f = mp3FrameAt(b, i);
    // a real frame is followed by another frame (or the end / an ID3v1 tag)
    const next = f && i + f.length;
    const chained =
      f && next !== null && (next! + 4 > b.length || mp3FrameAt(b, next!) || (b[next!] === 0x54 && b[next! + 1] === 0x41 && b[next! + 2] === 0x47));
    if (!f || !chained) {
      i++;
      continue;
    }
    const tag = String.fromCharCode(...b.subarray(i + 4 + f.sideInfo, i + 8 + f.sideInfo));
    const vbrHeader = frames === 0 && (tag === 'Xing' || tag === 'Info' || String.fromCharCode(...b.subarray(i + 36, i + 40)) === 'VBRI');
    if (!vbrHeader) {
      samples += f.samples;
      rate = f.sampleRate;
    }
    frames++;
    i += f.length;
  }
  if (!rate) throw new Error('no MPEG audio frames found');
  return samples / rate;
}

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

type Provider = 'elevenlabs' | 'openai' | 'mock';

export function chooseProvider(mock: boolean, keys = env.keys): Provider {
  if (mock) return 'mock';
  if (keys.elevenlabs) return 'elevenlabs';
  if (keys.openai) return 'openai';
  return 'mock';
}

async function openaiSpeech(text: string, voice: string, instructions: string): Promise<Buffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.keys.openai}`, 'content-type': 'application/json' },
    // `instructions` exists only on the gpt-*-tts models (tts-1/tts-1-hd reject it)
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice,
      input: text,
      ...(OPENAI_TTS_MODEL.startsWith('gpt-') ? { instructions } : {}),
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function elevenSpeech(text: string, voiceId: string): Promise<Buffer> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': env.keys.elevenlabs, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25 },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

interface Sidecar {
  key: string;
  provider: Provider;
  file: string;
  durationSeconds: number;
}

const round3 = (s: number) => Math.round(s * 1000) / 1000;

async function readSidecar(path: string): Promise<Sidecar | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Sidecar;
  } catch {
    return undefined;
  }
}

export async function synthesizeLine(opts: SynthesizeLineOptions): Promise<LineAudio> {
  const { line, character, outDir, log } = opts;
  await mkdir(outDir, { recursive: true });
  const provider = chooseProvider(opts.mock, opts.keys ?? env.keys);
  /** Beeps produced while not in MOCK are a fallback a later run should upgrade. */
  const flag = opts.mock ? {} : { fallback: true as const };
  const voice = provider === 'elevenlabs' ? elevenVoiceFor(character) : provider === 'openai' ? openaiVoiceFor(character) : 'beeps';
  const instructions = provider === 'openai' ? ttsInstructions(character, line.parenthetical) : '';
  const model = provider === 'elevenlabs' ? ELEVENLABS_MODEL : provider === 'openai' ? OPENAI_TTS_MODEL : 'mock-wav/1';
  const key = createHash('sha256').update(JSON.stringify([provider, model, voice, line.text, instructions])).digest('hex');
  const sidecarPath = join(outDir, `${line.id}.json`);
  const cached = await readSidecar(sidecarPath);
  if (cached?.key === key && (await stat(join(outDir, cached.file)).catch(() => null))) {
    const beeps = cached.provider === 'mock' ? flag : {};
    return { lineId: line.id, url: cached.file, durationSeconds: cached.durationSeconds, ...beeps };
  }

  const writeMock = async (why: string): Promise<LineAudio> => {
    const file = `${line.id}.wav`;
    const wav = mockWav(line.text);
    await writeFile(join(outDir, file), wav);
    const durationSeconds = round3(wavDurationSeconds(wav));
    // a fallback is cached under its own key, so the real provider is retried next time
    const mockKey = createHash('sha256').update(JSON.stringify(['mock', 'mock-wav/1', 'beeps', line.text, ''])).digest('hex');
    await writeFile(sidecarPath, JSON.stringify({ key: mockKey, provider: 'mock', file, durationSeconds } satisfies Sidecar));
    log(`tts ${line.id}: ${why} -> ${file} (${durationSeconds}s beeps)`);
    return { lineId: line.id, url: file, durationSeconds, ...flag };
  };

  if (provider === 'mock') return writeMock(opts.mock ? 'MOCK' : 'no TTS key');
  try {
    const t0 = Date.now();
    const mp3 = provider === 'elevenlabs' ? await elevenSpeech(line.text, voice) : await openaiSpeech(line.text, voice, instructions);
    const durationSeconds = round3(mp3DurationSeconds(mp3));
    const file = `${line.id}.mp3`;
    await writeFile(join(outDir, file), mp3);
    await writeFile(sidecarPath, JSON.stringify({ key, provider, file, durationSeconds } satisfies Sidecar));
    log(`tts ${line.id}: ${provider} ${model} voice=${voice} ${durationSeconds}s in ${Date.now() - t0}ms`);
    return { lineId: line.id, url: file, durationSeconds };
  } catch (err) {
    return writeMock(`${provider} failed (${err instanceof Error ? err.message : String(err)})`);
  }
}
