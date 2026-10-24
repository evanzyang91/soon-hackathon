// Pure room state machine for the WebSocket relay (no sockets, no timers).
// server/relay.ts feeds it decoded frames and delivers the Outbound messages it returns.
//
// Rules:
// - Every inbound message is validated with ClientMessage; invalid ones are dropped (warned).
// - `hello` registers the peer's role + room (creating the room if needed, so clients recover
//   after a server restart). Everyone in the room gets `peers` on every join/leave.
// - `pose` (phone → laptops) is throttled per phone: the first pose in a window is forwarded at
//   once, later ones in the same `poseIntervalMs` window only keep the latest, flushed by tick().
// - `scene` (laptop → phones) is cached per room so a late-joining phone gets it immediately.
// - `cmd` goes laptop → phones and phone → laptops.
import { randomInt } from 'node:crypto';
import {
  ClientMessage,
  type PhonePose,
  type SceneState,
  type ServerMessage,
} from '../shared/protocol.ts';

export type Role = 'laptop' | 'phone';
export type PeerId = string;

export interface Outbound {
  to: PeerId;
  msg: ServerMessage;
}

export interface RoomHubOptions {
  /** Max one forwarded pose per phone per window. Default 33 ms (≈30 Hz). */
  poseIntervalMs?: number;
  /** Peers silent for longer are reported by idlePeers(); empty rooms are removed. Default 30 s. */
  idleMs?: number;
  /** How long a code from reserveRoom() stays reserved without anyone joining. Default 10 min. */
  reserveMs?: number;
  warn?: (msg: string) => void;
}

interface Peer {
  id: PeerId;
  role: Role | null;
  room: string | null;
  lastSeen: number;
  warnings: number;
  /** Phones only: throttle state. */
  lastPoseSentAt: number;
  pendingPose: PhonePose | null;
}

interface Room {
  code: string;
  laptops: Set<PeerId>;
  phones: Set<PeerId>;
  scene: SceneState | null;
  /** Last time the room had a member (or was reserved). */
  lastActive: number;
  reservedUntil: number;
}

/** No 0/O, 1/I/L — readable when typed off a laptop screen. */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_RE = /^[A-Z0-9]{4,6}$/;

export function normalizeRoom(code: string): string | null {
  const c = code.trim().toUpperCase();
  return ROOM_RE.test(c) ? c : null;
}

export class RoomHub {
  readonly poseIntervalMs: number;
  readonly idleMs: number;
  readonly reserveMs: number;
  private readonly warnFn: (msg: string) => void;
  private readonly peers = new Map<PeerId, Peer>();
  private readonly rooms = new Map<string, Room>();

  constructor(opts: RoomHubOptions = {}) {
    this.poseIntervalMs = opts.poseIntervalMs ?? 33;
    this.idleMs = opts.idleMs ?? 30_000;
    this.reserveMs = opts.reserveMs ?? 10 * 60_000;
    this.warnFn = opts.warn ?? ((m) => console.warn(`[relay] ${m}`));
  }

  /** A fresh 4-char code that is not in use; it stays reserved for `reserveMs`. */
  reserveRoom(now: number): string {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
      if (this.rooms.has(code)) continue;
      const room = this.ensureRoom(code, now);
      room.reservedUntil = now + this.reserveMs;
      return code;
    }
    throw new Error('room code space exhausted');
  }

  connect(id: PeerId, now: number): void {
    this.peers.set(id, {
      id,
      role: null,
      room: null,
      lastSeen: now,
      warnings: 0,
      lastPoseSentAt: -Infinity,
      pendingPose: null,
    });
  }

  /** Any sign of life (message, pong). */
  touch(id: PeerId, now: number): void {
    const p = this.peers.get(id);
    if (p) p.lastSeen = now;
  }

  /** Feed one text frame (raw string or already-parsed JSON). */
  receive(id: PeerId, data: unknown, now: number): Outbound[] {
    const peer = this.peers.get(id);
    if (!peer) return [];
    peer.lastSeen = now;

    let json = data;
    if (typeof data === 'string') {
      try {
        json = JSON.parse(data);
      } catch {
        this.warn(peer, 'dropped non-JSON frame');
        return [];
      }
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) {
      const type = (json as { type?: unknown } | null)?.type;
      this.warn(
        peer,
        `dropped invalid ${String(type ?? 'message')}: ${parsed.error.issues[0]?.message}`,
      );
      return [];
    }
    const msg = parsed.data;

    if (msg.type === 'hello') return this.hello(peer, msg.role, msg.room, now);

    const room = peer.room ? this.rooms.get(peer.room) : undefined;
    if (!room || !peer.role) {
      this.warn(peer, `dropped ${msg.type} before hello`);
      return [];
    }
    room.lastActive = now;

    switch (msg.type) {
      case 'pose': {
        if (peer.role !== 'phone') return this.reject(peer, 'pose from a laptop');
        if (now - peer.lastPoseSentAt >= this.poseIntervalMs) {
          peer.lastPoseSentAt = now;
          peer.pendingPose = null;
          return fanOut(room.laptops, msg);
        }
        peer.pendingPose = msg; // coalesce: only the latest survives until the next tick
        return [];
      }
      case 'scene': {
        if (peer.role !== 'laptop') return this.reject(peer, 'scene from a phone');
        room.scene = msg;
        return fanOut(room.phones, msg);
      }
      case 'cmd':
        return fanOut(peer.role === 'laptop' ? room.phones : room.laptops, msg);
    }
  }

  /** Flush coalesced poses whose throttle window has elapsed. Call every few ms. */
  tick(now: number): Outbound[] {
    const out: Outbound[] = [];
    for (const peer of this.peers.values()) {
      if (!peer.pendingPose || now - peer.lastPoseSentAt < this.poseIntervalMs) continue;
      const room = peer.room ? this.rooms.get(peer.room) : undefined;
      if (room) out.push(...fanOut(room.laptops, peer.pendingPose));
      peer.pendingPose = null;
      peer.lastPoseSentAt = now;
    }
    return out;
  }

  disconnect(id: PeerId, now: number): Outbound[] {
    const peer = this.peers.get(id);
    if (!peer) return [];
    this.peers.delete(id);
    return this.leave(peer, now);
  }

  /** Peers that have been silent longer than idleMs (the socket layer should terminate them). */
  idlePeers(now: number): PeerId[] {
    const out: PeerId[] = [];
    for (const p of this.peers.values()) if (now - p.lastSeen > this.idleMs) out.push(p.id);
    return out;
  }

  /** Drop rooms that have been empty for idleMs and whose reservation has lapsed. */
  sweepRooms(now: number): string[] {
    const removed: string[] = [];
    for (const room of this.rooms.values()) {
      const empty = room.laptops.size === 0 && room.phones.size === 0;
      if (empty && now - room.lastActive > this.idleMs && now > room.reservedUntil) {
        this.rooms.delete(room.code);
        removed.push(room.code);
      }
    }
    return removed;
  }

  // -- introspection (tests, /api diagnostics) -------------------------------------------------

  roomOf(id: PeerId): { code: string; role: Role } | null {
    const p = this.peers.get(id);
    return p?.room && p.role ? { code: p.room, role: p.role } : null;
  }

  roomInfo(code: string): { laptops: number; phones: number; scene: SceneState | null } | null {
    const r = this.rooms.get(code);
    return r ? { laptops: r.laptops.size, phones: r.phones.size, scene: r.scene } : null;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  // -- internals --------------------------------------------------------------------------------

  private hello(peer: Peer, role: Role, rawRoom: string, now: number): Outbound[] {
    const code = normalizeRoom(rawRoom);
    if (!code) {
      this.warn(peer, `dropped hello with bad room code ${JSON.stringify(rawRoom)}`);
      return [];
    }
    const out: Outbound[] = [];
    if (peer.room === code && peer.role === role) {
      // Idempotent re-hello: just resend state to this peer.
      out.push({ to: peer.id, msg: peersPayload(this.rooms.get(code)!) });
    } else {
      out.push(...this.leave(peer, now));
      const room = this.ensureRoom(code, now);
      peer.room = code;
      peer.role = role;
      peer.pendingPose = null;
      (role === 'laptop' ? room.laptops : room.phones).add(peer.id);
      room.lastActive = now;
      out.push(...this.peersMsg(room));
    }
    const room = this.rooms.get(code)!;
    if (role === 'phone' && room.scene) out.push({ to: peer.id, msg: room.scene });
    return out;
  }

  private leave(peer: Peer, now: number): Outbound[] {
    const room = peer.room ? this.rooms.get(peer.room) : undefined;
    peer.room = null;
    peer.role = null;
    peer.pendingPose = null;
    if (!room) return [];
    room.laptops.delete(peer.id);
    room.phones.delete(peer.id);
    room.lastActive = now;
    return this.peersMsg(room);
  }

  private ensureRoom(code: string, now: number): Room {
    let room = this.rooms.get(code);
    if (!room) {
      room = {
        code,
        laptops: new Set(),
        phones: new Set(),
        scene: null,
        lastActive: now,
        reservedUntil: 0,
      };
      this.rooms.set(code, room);
    }
    return room;
  }

  private peersMsg(room: Room): Outbound[] {
    return fanOut([...room.laptops, ...room.phones], peersPayload(room));
  }

  private reject(peer: Peer, why: string): Outbound[] {
    this.warn(peer, `dropped ${why}`);
    return [];
  }

  /** Rate-limited per peer so a misbehaving client cannot flood the log. */
  private warn(peer: Peer, msg: string): void {
    peer.warnings++;
    if (peer.warnings <= 5 || peer.warnings % 100 === 0) {
      this.warnFn(`${peer.id}${peer.role ? ` (${peer.role} ${peer.room})` : ''}: ${msg}`);
    }
  }
}

function peersPayload(room: Room): ServerMessage {
  return { type: 'peers', laptop: room.laptops.size > 0, phones: room.phones.size };
}

function fanOut(to: Iterable<PeerId>, msg: ServerMessage): Outbound[] {
  const out: Outbound[] = [];
  for (const id of to) out.push({ to: id, msg });
  return out;
}
