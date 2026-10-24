// WebSocket relay on wss://<host>/ws (shared/protocol.ts). Thin socket layer over RoomHub.
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import type { WebSocketServer as ViteWebSocketServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { RoomHub, type Outbound, type PeerId } from './relay-rooms.ts';

export const WS_PATH = '/ws';

/** Process-wide hub so /api/rooms/new (newRoom) and the /ws relay share room state. */
const defaultHub = new RoomHub();

/** Reserve a fresh, unused 4-character room code. */
export function newRoom(): string {
  return defaultHub.reserveRoom(Date.now());
}

export interface RelayOptions {
  /**
   * Vite's HMR channel. Not used for routing: in middleware mode Vite listens on its own port,
   * and if it is ever configured to share `server` it attaches its own 'upgrade' listener, which
   * we leave alone — we only claim upgrades for /ws.
   */
  viteHmr?: ViteWebSocketServer;
  hub?: RoomHub;
  /** Pose flush cadence. Default: hub.poseIntervalMs / 2 so a coalesced pose waits ≤ ~1.5 windows. */
  tickMs?: number;
  /** Ping interval. Default 10 s; peers silent for hub.idleMs (30 s) are terminated. */
  heartbeatMs?: number;
}

export interface Relay {
  wss: WebSocketServer;
  hub: RoomHub;
  close(): Promise<void>;
}

export function attachRelay(server: HttpServer | HttpsServer, opts: RelayOptions = {}): Relay {
  const hub = opts.hub ?? defaultHub;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const sockets = new Map<PeerId, WebSocket>();
  let seq = 0;

  const deliver = (out: Outbound[]) => {
    // Many recipients share one message object; stringify each distinct message once.
    const cache = new Map<object, string>();
    for (const { to, msg } of out) {
      const ws = sockets.get(to);
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      let text = cache.get(msg);
      if (text === undefined) cache.set(msg, (text = JSON.stringify(msg)));
      ws.send(text);
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== WS_PATH) {
      // Someone else (Vite HMR when sharing this server) may claim it. If nobody else listens,
      // fail fast instead of leaving the client hanging.
      if (server.listenerCount('upgrade') <= 1) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const id = `p${++seq}@${req.socket.remoteAddress ?? '?'}`;
    sockets.set(id, ws);
    hub.connect(id, Date.now());

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        hub.touch(id, Date.now());
        console.warn(`[relay] ${id}: dropped binary frame`);
        return;
      }
      try {
        deliver(hub.receive(id, data.toString(), Date.now()));
      } catch (err) {
        console.warn(`[relay] ${id}: error handling message`, err);
      }
    });
    ws.on('pong', () => hub.touch(id, Date.now()));
    ws.on('error', (err) => console.warn(`[relay] ${id}: socket error ${err.message}`));
    ws.on('close', () => {
      sockets.delete(id);
      deliver(hub.disconnect(id, Date.now()));
    });
  });

  const tick = setInterval(
    () => deliver(hub.tick(Date.now())),
    opts.tickMs ?? Math.max(5, Math.floor(hub.poseIntervalMs / 2)),
  );
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const id of hub.idlePeers(now)) sockets.get(id)?.terminate();
    for (const ws of sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.ping();
    hub.sweepRooms(now);
  }, opts.heartbeatMs ?? 10_000);
  tick.unref();
  heartbeat.unref();

  return {
    wss,
    hub,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(tick);
        clearInterval(heartbeat);
        server.off('upgrade', onUpgrade);
        for (const ws of sockets.values()) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}
