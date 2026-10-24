import { describe, expect, it } from 'vitest';
import type { PhonePose, SceneState } from '../shared/protocol.ts';
import { normalizeRoom, ROOM_ALPHABET, RoomHub, type Outbound } from './relay-rooms.ts';

const pose = (t: number): PhonePose => ({
  type: 'pose',
  t,
  q: [0, 0, 0, 1],
  nudge: [0, 0, 0],
  fovDeg: 50,
  recording: false,
});

const scene = (time = 0): SceneState => ({
  type: 'scene',
  projectId: 'p1',
  sceneIndex: 0,
  manifestUrl: '/projects/p1/scene-0/manifest.json',
  time,
  playing: false,
  cameras: [{ id: 'c1', name: 'A', position: [0, 1.6, 0], quaternion: [0, 0, 0, 1], fovDeg: 40 }],
  activeCameraId: 'c1',
  speakingLineId: null,
});

function setup() {
  const warnings: string[] = [];
  const hub = new RoomHub({ warn: (m) => warnings.push(m) });
  const send = (id: string, msg: unknown, now = 0) => hub.receive(id, JSON.stringify(msg), now);
  const join = (id: string, role: 'laptop' | 'phone', room = 'ABCD', now = 0) => {
    hub.connect(id, now);
    return send(id, { type: 'hello', role, room }, now);
  };
  return { hub, warnings, send, join };
}

const to = (out: Outbound[], id: string) => out.filter((o) => o.to === id).map((o) => o.msg);
/** What a laptop receives for `pose(t)` sent by phone peer `phoneId`. */
const fwd = (t: number, phoneId = 'P'): PhonePose => ({ ...pose(t), phoneId });

describe('room codes', () => {
  it('reserves unique 4-char codes from the unambiguous alphabet', () => {
    const hub = new RoomHub();
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) codes.add(hub.reserveRoom(0));
    expect(codes.size).toBe(500);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z0-9]{4}$/);
      for (const ch of c) expect(ROOM_ALPHABET).toContain(ch);
      expect(c).not.toMatch(/[01OIL]/);
    }
  });

  it('normalizes case and whitespace, rejects junk', () => {
    expect(normalizeRoom(' abcd ')).toBe('ABCD');
    expect(normalizeRoom('ab')).toBeNull();
    expect(normalizeRoom('ab-cd')).toBeNull();
  });

  it('keeps reservations alive until they lapse, then sweeps them', () => {
    const hub = new RoomHub({ idleMs: 1000, reserveMs: 5000 });
    hub.reserveRoom(0);
    expect(hub.sweepRooms(2000)).toEqual([]);
    expect(hub.sweepRooms(6000)).toHaveLength(1);
    expect(hub.roomCount).toBe(0);
  });
});

describe('hello + peers', () => {
  it('sends peers to everyone on join and leave', () => {
    const { hub, join } = setup();
    expect(to(join('L', 'laptop'), 'L')).toEqual([{ type: 'peers', laptop: true, phones: 0 }]);
    const out = join('P', 'phone', 'abcd');
    expect(to(out, 'L')).toEqual([{ type: 'peers', laptop: true, phones: 1 }]);
    expect(to(out, 'P')).toEqual([{ type: 'peers', laptop: true, phones: 1 }]);
    expect(hub.roomOf('P')).toEqual({ code: 'ABCD', role: 'phone' });

    const left = hub.disconnect('L', 1);
    expect(to(left, 'P')).toEqual([{ type: 'peers', laptop: false, phones: 1 }]);
    expect(to(left, 'L')).toEqual([]);
  });

  it('moving to another room notifies the old room', () => {
    const { send, join } = setup();
    join('L', 'laptop', 'ROOM');
    join('P', 'phone', 'ROOM');
    const out = send('P', { type: 'hello', role: 'phone', room: 'OTHR' });
    expect(to(out, 'L')).toEqual([{ type: 'peers', laptop: true, phones: 0 }]);
    expect(to(out, 'P')).toEqual([{ type: 'peers', laptop: false, phones: 1 }]);
  });

  it('re-hello to the same room is idempotent', () => {
    const { hub, send, join } = setup();
    join('L', 'laptop');
    join('P', 'phone');
    const out = send('P', { type: 'hello', role: 'phone', room: 'ABCD' });
    expect(out).toEqual([{ to: 'P', msg: { type: 'peers', laptop: true, phones: 1 } }]);
    expect(hub.roomInfo('ABCD')).toMatchObject({ laptops: 1, phones: 1 });
  });

  it('drops a hello with a bad room code', () => {
    const { hub, warnings, join } = setup();
    expect(join('P', 'phone', '!!')).toEqual([]);
    expect(hub.roomOf('P')).toBeNull();
    expect(warnings[0]).toMatch(/bad room code/);
  });
});

describe('validation', () => {
  it('drops non-JSON, unknown types, schema violations and pre-hello traffic without throwing', () => {
    const { hub, warnings, send, join } = setup();
    hub.connect('X', 0);
    expect(hub.receive('X', '{nope', 0)).toEqual([]);
    expect(send('X', { type: 'teleport' })).toEqual([]);
    expect(send('X', pose(1))).toEqual([]); // before hello
    join('P', 'phone');
    expect(send('P', { ...pose(1), q: [0, 0, 1] })).toEqual([]);
    expect(send('P', { type: 'cmd', cmd: 'self-destruct' })).toEqual([]);
    expect(hub.receive('P', null, 0)).toEqual([]);
    expect(hub.receive('ghost', '{}', 0)).toEqual([]);
    expect(warnings.length).toBe(6);
  });

  it('enforces roles: laptops cannot send poses, phones cannot send scenes', () => {
    const { send, join, warnings } = setup();
    join('L', 'laptop');
    join('P', 'phone');
    expect(send('L', pose(1))).toEqual([]);
    expect(send('P', scene())).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it('rate-limits warnings per peer', () => {
    const { hub, warnings } = setup();
    hub.connect('X', 0);
    for (let i = 0; i < 250; i++) hub.receive('X', 'garbage', 0);
    expect(warnings.length).toBe(5 + 2); // first five, then #100 and #200
  });
});

describe('pose forwarding', () => {
  it('forwards a phone pose to every laptop in the room only', () => {
    const { send, join } = setup();
    join('L1', 'laptop');
    join('L2', 'laptop');
    join('LX', 'laptop', 'ZZZZ');
    join('P', 'phone');
    const out = send('P', pose(1), 100);
    expect(out.map((o) => o.to).sort()).toEqual(['L1', 'L2']);
    expect(out[0]!.msg).toEqual(fwd(1));
  });

  it('stamps the sender as phoneId, overwriting a client-supplied one', () => {
    const { send, join } = setup();
    join('L', 'laptop');
    join('P1', 'phone');
    join('P2', 'phone');
    expect(to(send('P1', { ...pose(1), phoneId: 'P2' }, 100), 'L')).toEqual([fwd(1, 'P1')]);
    expect(to(send('P2', pose(2), 101), 'L')).toEqual([fwd(2, 'P2')]);
  });

  it('coalesces: within one 33 ms window only the latest pose survives', () => {
    const { hub, send, join } = setup();
    join('L', 'laptop');
    join('P', 'phone');
    expect(to(send('P', pose(1), 100), 'L')).toEqual([fwd(1)]); // leading edge: immediate
    expect(send('P', pose(2), 105)).toEqual([]);
    expect(send('P', pose(3), 110)).toEqual([]);
    expect(send('P', pose(4), 120)).toEqual([]);
    expect(hub.tick(125)).toEqual([]); // window not over yet
    expect(to(hub.tick(133), 'L')).toEqual([fwd(4)]); // trailing edge: latest only
    expect(hub.tick(200)).toEqual([]); // nothing pending
    expect(to(send('P', pose(5), 210), 'L')).toEqual([fwd(5)]);
  });

  it('throttles each phone independently', () => {
    const { hub, send, join } = setup();
    join('L', 'laptop');
    join('P1', 'phone');
    join('P2', 'phone');
    expect(send('P1', pose(1), 100)).toHaveLength(1);
    expect(send('P2', pose(2), 101)).toHaveLength(1);
    expect(send('P1', pose(3), 110)).toHaveLength(0);
    expect(to(hub.tick(140), 'L')).toEqual([fwd(3, 'P1')]);
  });

  it('a pending pose is discarded when the phone leaves', () => {
    const { hub, send, join } = setup();
    join('L', 'laptop');
    join('P', 'phone');
    send('P', pose(1), 100);
    send('P', pose(2), 110);
    hub.disconnect('P', 115);
    expect(hub.tick(200)).toEqual([]);
  });
});

describe('scene + cmd', () => {
  it('broadcasts scene to phones and caches it for late joiners', () => {
    const { hub, send, join } = setup();
    join('L', 'laptop');
    join('P1', 'phone');
    const out = send('L', scene(1));
    expect(out).toEqual([{ to: 'P1', msg: scene(1) }]);
    send('L', scene(2));
    const late = join('P2', 'phone');
    expect(to(late, 'P2')).toEqual([{ type: 'peers', laptop: true, phones: 2 }, scene(2)]);
    expect(hub.roomInfo('ABCD')?.scene).toEqual(scene(2));
  });

  it('routes cmd laptop → phones and phone → laptops', () => {
    const { send, join } = setup();
    join('L', 'laptop');
    join('P1', 'phone');
    join('P2', 'phone');
    const down = send('L', { type: 'cmd', cmd: 'recenter' });
    expect(down.map((o) => o.to).sort()).toEqual(['P1', 'P2']);
    const up = send('P1', { type: 'cmd', cmd: 'shutter' });
    expect(up).toEqual([{ to: 'L', msg: { type: 'cmd', cmd: 'shutter' } }]);
  });
});

describe('room scan', () => {
  const scan = {
    type: 'room',
    source: 'lidar',
    outline: [
      [-2, -3],
      [2, -3],
      [2, 1],
      [-2, 1],
    ],
    floorY: -1.4,
    ceiling: 2.5,
    area: 16,
  };

  it('forwards a phone scan to laptops (stamped), caches it for a laptop that joins later', () => {
    const { join, send } = setup();
    join('L', 'laptop');
    join('P', 'phone');
    const out = send('P', { ...scan, phoneId: 'spoofed' });
    expect(to(out, 'L')).toEqual([{ ...scan, phoneId: 'P' }]);
    expect(to(out, 'P')).toEqual([]);
    const late = join('L2', 'laptop');
    expect(to(late, 'L2')).toContainEqual({ ...scan, phoneId: 'P' });
  });

  it('rejects a scan from a laptop and malformed outlines', () => {
    const { join, send, warnings } = setup();
    join('L', 'laptop');
    join('P', 'phone');
    expect(send('L', scan)).toEqual([]);
    expect(send('P', { ...scan, outline: [[0, 0]] })).toEqual([]);
    expect(warnings.length).toBe(2);
  });
});

describe('idle cleanup', () => {
  it('reports silent peers and removes empty rooms after idleMs', () => {
    const hub = new RoomHub({ idleMs: 30_000, warn: () => {} });
    hub.connect('L', 0);
    hub.receive('L', JSON.stringify({ type: 'hello', role: 'laptop', room: 'ABCD' }), 0);
    hub.connect('P', 0);
    hub.touch('P', 20_000);
    expect(hub.idlePeers(31_000)).toEqual(['L']);
    hub.disconnect('L', 31_000);
    expect(hub.sweepRooms(40_000)).toEqual([]); // emptied at 31 s; not idle long enough
    expect(hub.sweepRooms(62_000)).toEqual(['ABCD']);
  });
});
