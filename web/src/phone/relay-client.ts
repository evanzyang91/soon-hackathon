// Browser WebSocket client for the relay (shared/protocol.ts). Role-agnostic: the laptop can use
// it too. Reconnects with backoff, re-sends Hello on every (re)connect, validates inbound frames.
import { ServerMessage, type ClientMessage } from '@shared/protocol';

export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RelayClientOptions {
  url: string;
  role: 'laptop' | 'phone';
  room: string;
  onMessage?: (msg: ServerMessage) => void;
  onState?: (state: ConnState) => void;
  /** Injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
}

/** wss://<host>/ws for the current page (ws:// on plain http). `?ws=` overrides. */
export function relayUrl(loc: Location = location): string {
  const override = new URLSearchParams(loc.search).get('ws');
  if (override) return override;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

/** Dead-connection heuristic: a socket that cannot drain this much is assumed stalled. */
const MAX_BUFFERED = 64 * 1024;

export class RelayClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private _state: ConnState = 'idle';
  /** Counters for the debug hook / e2e. */
  readonly stats = { sent: 0, received: 0, dropped: 0, connects: 0 };

  constructor(private readonly opts: RelayClientOptions) {}

  get state(): ConnState {
    return this._state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisible);
    }
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisible);
    }
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.setState('closed');
  }

  /** Change room/role at runtime (sends a new Hello when connected). */
  setRoom(room: string): void {
    this.opts.room = room;
    if (this._state === 'open') this.send({ type: 'hello', role: this.opts.role, room });
  }

  send(msg: ClientMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) return false;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      // iOS keeps sockets "open" after Wi-Fi hiccups; force a reconnect instead of buffering.
      ws.close(4000, 'stalled');
      return false;
    }
    ws.send(JSON.stringify(msg));
    this.stats.sent++;
    return true;
  }

  private open(): void {
    if (this.stopped) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(this.opts.url);
    } catch (err) {
      console.warn('[relay] cannot open socket', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.stats.connects++;
      this.setState('open');
      this.send({ type: 'hello', role: this.opts.role, room: this.opts.room });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let parsed: ReturnType<typeof ServerMessage.safeParse>;
      try {
        parsed = ServerMessage.safeParse(JSON.parse(ev.data));
      } catch {
        this.stats.dropped++;
        return;
      }
      if (!parsed.success) {
        this.stats.dropped++;
        console.warn('[relay] dropped invalid server message', parsed.error.issues[0]?.message);
        return;
      }
      this.stats.received++;
      this.opts.onMessage?.(parsed.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do.
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setState('reconnecting');
    const delay = Math.min(5000, 500 * 2 ** this.attempt++);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  private readonly onVisible = () => {
    if (document.visibilityState !== 'visible' || this.stopped) return;
    if (!this.ws || this.ws.readyState > 1) {
      this.attempt = 0;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.open();
    }
  };

  private setState(s: ConnState): void {
    if (s === this._state) return;
    this._state = s;
    this.opts.onState?.(s);
  }
}
