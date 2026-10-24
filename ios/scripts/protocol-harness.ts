// Contract harness for PrevizCore's ZodContractTests (run with tsx from the repo root):
//
//   node_modules/.bin/tsx ios/scripts/protocol-harness.ts check   < request.json
//   node_modules/.bin/tsx ios/scripts/protocol-harness.ts samples
//
// `check` validates what the Swift side encodes against the real zod schemas in
// shared/protocol.ts, and runs the bridge scripts the app would evaluate in the WKWebView
// against a stub `window`, so a contract drift fails `swift test`.
// `samples` prints relay → phone messages built and validated here, for the Swift decoder.
import { runInNewContext } from 'node:vm';
import { ClientMessage, PhonePose, ServerMessage } from '../../shared/protocol.ts';
import { poseKey } from '../../web/src/phone/throttle.ts';

interface CheckRequest {
  /** Raw JSON text frames the app would send to the relay. */
  client: string[];
  /** Scripts the app evaluates in the page: window.__previzPose(...) / __previzMessage(...). */
  scripts: string[];
}

function keysDropped(input: unknown, parsed: unknown): string[] {
  if (!input || typeof input !== 'object' || !parsed || typeof parsed !== 'object') return [];
  return Object.keys(input).filter((k) => !(k in (parsed as object)));
}

function check(req: CheckRequest) {
  const client = req.client.map((text) => {
    const input = JSON.parse(text) as unknown;
    const r = ClientMessage.safeParse(input);
    return r.success
      ? {
          ok: true,
          dropped: keysDropped(input, r.data),
          // the web page's own change key, so the Swift port can be compared
          key: r.data.type === 'pose' ? poseKey(r.data) : undefined,
        }
      : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  });
  const scripts = req.scripts.map((script) => {
    const calls: { fn: string; arg: unknown }[] = [];
    const window = {
      __previzPose: (arg: unknown) => calls.push({ fn: '__previzPose', arg }),
      __previzMessage: (arg: unknown) => calls.push({ fn: '__previzMessage', arg }),
    } as Record<string, unknown>;
    let result: unknown;
    try {
      result = runInNewContext(script, { window });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    const call = calls[0];
    if (calls.length !== 1 || !call) return { ok: false, error: `${calls.length} calls`, result };
    const valid =
      call.fn === '__previzPose'
        ? PhonePose.safeParse(call.arg).success
        : ServerMessage.safeParse(call.arg).success;
    // The same script against a page without the bridge must be a harmless no-op.
    let noop = true;
    try {
      runInNewContext(script, { window: {} });
    } catch {
      noop = false;
    }
    return { ok: valid && noop, fn: call.fn, arg: call.arg, result, noop };
  });
  return { client, scripts };
}

function samples(): string[] {
  const msgs: unknown[] = [
    { type: 'peers', laptop: true, phones: 2 },
    {
      type: 'scene',
      projectId: 'p1',
      sceneIndex: 0,
      manifestUrl: '/projects/p1/scene-0/manifest.json',
      time: 4.25,
      playing: true,
      cameras: [
        { id: 'c1', name: 'Cam 1', position: [1, 1.6, 2], quaternion: [0, 0.3826834, 0, 0.9238795], fovDeg: 40 },
        { id: 'c2', name: 'Cam 2', position: [0, 1.2, -3], quaternion: [0, 0, 0, 1], fovDeg: 50 },
      ],
      activeCameraId: 'c1',
      speakingLineId: null,
      editsRevision: 3,
      look: { exposure: 0.2, lut: 'noir' },
    },
    {
      type: 'scene',
      projectId: 'p1',
      sceneIndex: 1,
      manifestUrl: 'https://192.168.1.20:5173/projects/p1/scene-1/manifest.json',
      time: 0,
      playing: false,
      cameras: [],
      activeCameraId: null,
      speakingLineId: 'l3',
    },
    { type: 'cmd', cmd: 'recenter' },
    { type: 'cmd', cmd: 'record-start' },
    {
      type: 'pose',
      phoneId: 'p2@::1',
      t: 1,
      q: [0, 0, 0, 1],
      nudge: [0, 0, 0],
      fovDeg: 50,
      recording: false,
    },
  ];
  return msgs.map((m) => JSON.stringify(ServerMessage.parse(m)));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const mode = process.argv[2];
if (mode === 'check') {
  process.stdout.write(JSON.stringify(check(JSON.parse(await readStdin()) as CheckRequest)));
} else if (mode === 'samples') {
  process.stdout.write(JSON.stringify(samples()));
} else {
  console.error('usage: protocol-harness.ts check|samples');
  process.exit(2);
}
