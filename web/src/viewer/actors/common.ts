// Pieces every actor kind shares: name label + speaking caption sprites, and positional speech
// (THREE.PositionalAudio at head height, an AnalyserNode for mouth amplitude, a promise that
// resolves when the line ends even if the AudioContext never starts).
import * as THREE from 'three';

export interface TextSprite {
  sprite: THREE.Sprite;
  setText(text: string): void;
  dispose(): void;
}

/** Billboard text, sized in metres (height `h`), drawn on a canvas texture. */
export function textSprite(text: string, opts: { h: number; bg: string; fg: string }): TextSprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 10;
  const draw = (t: string) => {
    if (!ctx) return;
    const px = 48;
    ctx.font = `600 ${px}px system-ui, sans-serif`;
    const w = Math.ceil(ctx.measureText(t).width) + px;
    canvas.width = w;
    canvas.height = px * 1.6;
    ctx.font = `600 ${px}px system-ui, sans-serif`;
    ctx.fillStyle = opts.bg;
    const r = canvas.height / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, w, canvas.height, r);
    else ctx.rect(0, 0, w, canvas.height);
    ctx.fill();
    ctx.fillStyle = opts.fg;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(t, w / 2, canvas.height / 2 + 2);
    texture.needsUpdate = true;
    sprite.scale.set((opts.h * w) / canvas.height, opts.h, 1);
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
        // browsers start the context only after a gesture; WP A's director resumes it on click
        if (listener.context.state === 'suspended') void listener.context.resume().catch(() => {});
        let p = bufferCache.get(url);
        if (!p) {
          p = new THREE.AudioLoader().loadAsync(url);
          bufferCache.set(url, p);
          p.catch(() => bufferCache.delete(url));
        }
        const buffer = await p;
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
