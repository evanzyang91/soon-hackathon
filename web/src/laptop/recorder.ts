// Take recorder: MediaRecorder over the viewport canvas (+ the scene's dialogue audio) → WebM.

function pickMime(): string {
  const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return options.find((m) => globalThis.MediaRecorder?.isTypeSupported?.(m)) ?? 'video/webm';
}

export class TakeRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private audioDest: MediaStreamAudioDestinationNode | null = null;
  private withAudio = false;
  startedAt = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** The AudioListener's output node and context, so takes include positional dialogue. */
    private readonly audio?: { context: AudioContext; output: AudioNode },
  ) {}

  get recording() {
    return this.recorder?.state === 'recording';
  }

  get supported() {
    return typeof MediaRecorder !== 'undefined' && 'captureStream' in this.canvas;
  }

  start(fps = 30) {
    if (this.recording || !this.supported) return false;
    const stream = this.canvas.captureStream(fps);
    // a suspended context yields an audio track with no samples, which stalls the WebM muxer
    this.withAudio = this.audio?.context.state === 'running';
    if (this.audio && this.withAudio) {
      this.audioDest ??= this.audio.context.createMediaStreamDestination();
      this.audio.output.connect(this.audioDest);
      for (const t of this.audioDest.stream.getAudioTracks()) stream.addTrack(t);
    }
    this.chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 8_000_000 });
    rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    rec.start(250);
    this.recorder = rec;
    this.startedAt = performance.now();
    return true;
  }

  stop(): Promise<Blob | null> {
    const rec = this.recorder;
    if (!rec || rec.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        for (const t of rec.stream.getVideoTracks()) t.stop();
        if (this.audio && this.audioDest && this.withAudio) {
          try {
            this.audio.output.disconnect(this.audioDest);
          } catch {
            // already disconnected
          }
        }
        this.recorder = null;
        resolve(this.chunks.length ? new Blob(this.chunks, { type: rec.mimeType }) : null);
      };
      rec.stop();
    });
  }
}
