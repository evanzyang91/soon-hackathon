// Integration: real http server + attachRelay + two ws clients.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ServerMessage, type PhonePose, type SceneState } from '../shared/protocol.ts';
import { attachRelay, newRoom, type Relay } from './relay.ts';
import { RoomHub } from './relay-rooms.ts';

let server: Server;
let relay: Relay;
let base: string;
const open: WebSocket[] = [];

beforeEach(async () => {
  server = createServer((_req, res) => res.end('ok'));
  relay = attachRelay(server, { hub: new RoomHub({ warn: () => {} }) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await relay.close();
  await new Promise((r) => server.close(r));
});

/** A ws client that queues parsed ServerMessages so tests can await the next one of a type. */
function client(path = '/ws') {
  const ws = new WebSocket(base + path);
  open.push(ws);
  const inbox: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (d) => {
    inbox.push(ServerMessage.parse(JSON.parse(d.toString())));
    waiters.splice(0).forEach((w) => w());
  });
  const next = async <T extends ServerMessage['type']>(type: T, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, left);
      });
    }
  };
  const ready = new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  const send = (m: unknown) => ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  return { ws, ready, next, send, inbox };
}

const pose = (t: number): PhonePose => ({
  type: 'pose',
  t,
  q: [0, 0.38268, 0, 0.92388],
  nudge: [0.01, 0, -0.02],
  fovDeg: 38,
  recording: false,
});

const scene: SceneState = {
  type: 'scene',
  projectId: 'demo',
  sceneIndex: 1,
  manifestUrl: '/projects/demo/scene-1/manifest.json',
  time: 3.5,
  playing: true,
  cameras: [
    { id: 'c1', name: 'Wide', position: [1, 1.6, 2], quaternion: [0, 0, 0, 1], fovDeg: 40 },
  ],
  activeCameraId: 'c1',
  speakingLineId: 's1-l2',
};

describe('relay over real sockets', () => {
  it('forwards phone poses to the laptop, scene + cmd both ways, peers on join/leave', async () => {
    const room = newRoom();
    const laptop = client();
    const phone = client();
    await Promise.all([laptop.ready, phone.ready]);

    laptop.send({ type: 'hello', role: 'laptop', room });
    expect(await laptop.next('peers')).toEqual({ type: 'peers', laptop: true, phones: 0 });
    laptop.send(scene);

    phone.send({ type: 'hello', role: 'phone', room: room.toLowerCase() });
    expect(await laptop.next('peers')).toEqual({ type: 'peers', laptop: true, phones: 1 });
    expect(await phone.next('peers')).toEqual({ type: 'peers', laptop: true, phones: 1 });
    expect(await phone.next('scene')).toEqual(scene); // cached scene for the late joiner

    phone.send(pose(1));
    const got = await laptop.next('pose');
    expect(got).toEqual({ ...pose(1), phoneId: expect.stringMatching(/^p\d+@/) });

    // Garbage does not kill the connection.
    phone.send('not json');
    phone.send({ type: 'pose', q: 'nope' });

    // Burst: the relay coalesces; the laptop must eventually see the latest pose.
    for (let t = 2; t <= 20; t++) phone.send(pose(t));
    let last = await laptop.next('pose');
    while (last.t !== 20) last = await laptop.next('pose');
    expect(laptop.inbox.filter((m) => m.type === 'pose').length).toBe(0);

    laptop.send({ type: 'cmd', cmd: 'recenter' });
    expect(await phone.next('cmd')).toEqual({ type: 'cmd', cmd: 'recenter' });
    phone.send({ type: 'cmd', cmd: 'shutter' });
    expect(await laptop.next('cmd')).toEqual({ type: 'cmd', cmd: 'shutter' });

    phone.ws.close();
    expect(await laptop.next('peers')).toEqual({ type: 'peers', laptop: true, phones: 0 });
  });

  it('coalesces a burst into far fewer frames than were sent', async () => {
    const room = newRoom();
    const laptop = client();
    const phone = client();
    await Promise.all([laptop.ready, phone.ready]);
    laptop.send({ type: 'hello', role: 'laptop', room });
    phone.send({ type: 'hello', role: 'phone', room });
    await laptop.next('peers');
    await laptop.next('peers');
    for (let t = 1; t <= 200; t++) phone.send(pose(t));
    let last = await laptop.next('pose');
    let frames = 1;
    while (last.t !== 200) {
      last = await laptop.next('pose');
      frames++;
    }
    expect(frames).toBeLessThan(20);
  });

  it('does not claim non-/ws upgrades', async () => {
    const stray = client('/not-ws');
    await expect(stray.ready).rejects.toThrow(/404/);
  });
});
