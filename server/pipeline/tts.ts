// STUB written by WP C so the pipeline runs before WP D lands; WP D owns and replaces this file.
// Contract used by server/pipeline/project.ts:
//   synthesizeLine({ line, character, outDir, mock, log }) → LineAudio
// project.ts passes outDir = <projectDir>/scene-<n>/audio/ and accepts `url` relative to outDir,
// relative to projectDir, or absolute. This stub writes a silent WAV sized to the line.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Character, DialogueLine, LineAudio } from '../../shared/schema.ts';

export interface SynthesizeLineOptions {
  line: DialogueLine;
  character: Character;
  outDir: string;
  mock: boolean;
  log: (m: string) => void;
}

function silentWav(seconds: number, rate = 8000): Buffer {
  const samples = Math.max(1, Math.round(seconds * rate));
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

export async function synthesizeLine(opts: SynthesizeLineOptions): Promise<LineAudio> {
  const words = opts.line.text.split(/\s+/).filter(Boolean).length;
  const durationSeconds = Math.round(Math.max(0.8, words * 0.38) * 100) / 100;
  await mkdir(opts.outDir, { recursive: true });
  const file = `${opts.line.id}.wav`;
  await writeFile(join(opts.outDir, file), silentWav(durationSeconds));
  opts.log(`tts ${opts.line.id}: stub silent wav (${durationSeconds}s)`);
  return { lineId: opts.line.id, url: file, durationSeconds };
}
