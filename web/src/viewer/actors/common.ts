// Pieces every actor kind shares: name label + speaking caption sprites, and positional speech
// (THREE.PositionalAudio at head height, an AnalyserNode for mouth amplitude, a promise that
// resolves when the line ends even if the AudioContext never starts).
import * as THREE from 'three';

export interface TextSprite {
  sprite: THREE.Sprite;
  setText(text: string): void;
  dispose(): void;
}

/** Greedy word wrap to lines of at most `maxChars` (a longer single word gets its own line). */
export function wrapText(text: string, maxChars: number, maxLines = 4): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > maxChars) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1]!.replace(/[\s.,;:!?]+$/, '')}…`;
  }
  return lines.length ? lines : [''];
}

export interface TextSpriteOptions {
  /** Height of one line of text, in metres. */
  h: number;
  bg: string;
  fg: string;
  /** Word-wrap at this many characters per line (default: one line). */
  wrap?: number;
  /** Anchor at the bottom edge so extra lines grow upwards (default: centred). */
  anchorBottom?: boolean;
}

/** Billboard text, sized in metres (line height `h`), drawn on a canvas texture. */
export function textSprite(text: string, opts: TextSpriteOptions): TextSprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 10;
  if (opts.anchorBottom) sprite.center.set(0.5, 0);
  const draw = (t: string) => {
    if (!ctx) return;
    const px = 48;
    const lineH = px * 1.6;
    const lines = opts.wrap ? wrapText(t, opts.wrap) : [t];
    ctx.font = `600 ${px}px system-ui, sans-serif`;
    const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + px;
    const hPx = Math.round(lineH * lines.length);
    // three.js allocates the GL texture once and then only updates it in place, so a canvas of a
    // new size never reaches the GPU (the sprite kept stretching the first line it ever showed).
    // Disposing makes the next render allocate a fresh texture at the new size.
    const resized = canvas.width !== w || canvas.height !== hPx;
    canvas.width = w;
    canvas.height = hPx;
    if (resized) texture.dispose();
    ctx.font = `600 ${px}px system-ui, sans-serif`;
    ctx.fillStyle = opts.bg;
    const r = lineH / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, w, canvas.height, r);
    else ctx.rect(0, 0, w, canvas.height);
    ctx.fill();
    ctx.fillStyle = opts.fg;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    lines.forEach((l, i) => ctx.fillText(l, w / 2, lineH * (i + 0.5) + 2));
    texture.needsUpdate = true;
    sprite.scale.set((opts.h * w) / lineH, opts.h * lines.length, 1);
  };
  draw(text);
  return {
    sprite,
    setText: draw,
    dispose() {
      texture.dispose();
      material.dispose();
    },
  };
}

export interface Speech {
  audio: THREE.PositionalAudio;
  /** 0..1 loudness of what is playing now (0 when silent). */
  level(): number;
  readonly speaking: boolean;
  play(url: string, durationSeconds: number): Promise<void>;
  stop(): void;
  dispose(): void;
}

const bufferCache = new Map<string, Promise<AudioBuffer>>();

function loadBuffer(url: string): Promise<AudioBuffer> {
  let p = bufferCache.get(url);
  if (!p) {
    p = new THREE.AudioLoader().loadAsync(url);
    bufferCache.set(url, p);
    p.catch(() => bufferCache.delete(url));
  }
  return p;
}

/**
 * Fetches and decodes a voice clip ahead of time (the cache `play` reads), so a line starts the
 * moment it is triggered: no network round trip between the laptop's cue and the phone's voice.
 */
export function preloadAudio(url: string): Promise<AudioBuffer | null> {
  return loadBuffer(url).catch(() => null);
}

/** Positional voice at `headY` metres inside `parent`. */
export function createSpeech(listener: THREE.AudioListener, parent: THREE.Object3D, headY: number): Speech {
  const audio = new THREE.PositionalAudio(listener);
  audio.position.y = headY;
  audio.setRefDistance(2.5);
  audio.setRolloffFactor(1.2);
  parent.add(audio);
  // time-domain RMS (unsmoothed, ~12 ms window) follows syllables; averaged FFT bins lag
  const analyser = new THREE.AudioAnalyser(audio, 512);
  const samples = new Float32Array(analyser.analyser.fftSize);
  let finish: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let token = 0;

  const end = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const f = finish;
    finish = null;
    f?.();
  };

  const speech: Speech = {
    audio,
    get speaking() {
      return finish !== null;
    },
    level() {
      if (!finish || !audio.isPlaying) return 0;
      analyser.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      return Math.min(1, Math.sqrt(sum / samples.length) * 5);
    },
    async play(url, durationSeconds) {
      speech.stop();
      const mine = ++token;
      const done = new Promise<void>((resolve) => (finish = resolve));
      try {
        // browsers start the context only after a gesture: the director resumes it on any click
        // or key, the phone unlocks it in its "Tap to start" handler (phone/audio.ts)
        if (listener.context.state === 'suspended') void listener.context.resume().catch(() => {});
        const buffer = await loadBuffer(url);
        if (mine !== token) return done;
        audio.setBuffer(buffer);
        audio.play();
        const source = audio.source as AudioBufferSourceNode | null;
        if (source) {
          source.onended = () => {
            audio.onEnded();
            if (mine === token) end();
          };
        }
        // safety net: a suspended context never fires `ended`
        timer = setTimeout(() => mine === token && end(), (buffer.duration + 0.75) * 1000);
      } catch (err) {
        console.warn(`actor audio ${url} failed; miming for ${durationSeconds}s`, err);
        if (mine === token) timer = setTimeout(() => mine === token && end(), Math.max(0.5, durationSeconds) * 1000);
      }
      return done;
    },
    stop() {
      token++;
      if (audio.isPlaying) audio.stop();
      end();
    },
    dispose() {
      speech.stop();
      audio.disconnect();
      parent.remove(audio);
    },
  };
  return speech;
}

/** Resolves `rel` against `base`; absolute URLs and `/paths` pass through. */
export function resolveUrl(rel: string, base: string): string {
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

/**
 * Candidate URLs for a project-root-relative asset path (the schema's convention). WP A may pass
 * the scene directory as `base`; then the project root (`../`) is tried first, so the expected
 * layout never costs a 404 in the console.
 */
export function projectCandidates(rel: string, base: string): string[] {
  const out = [resolveUrl(rel, base)];
  if (/\/scene-\d+\/$/.test(new URL(base, 'https://x/').pathname)) out.unshift(resolveUrl(`../${rel}`, base));
  return [...new Set(out)];
}
