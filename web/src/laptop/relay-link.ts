// Laptop side of the /ws relay: hello as 'laptop', reconnect with backoff, typed send/receive.
import { api } from '@shared/api';
import type { ClientMessage, ServerMessage } from '@shared/protocol';
import { parseServerMessage } from './messages';

export type LinkStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface RelayLinkOptions {
  onMessage(msg: ServerMessage): void;
  onStatus(status: LinkStatus): void;
  /** Called on every (re)connect, after hello — resend state here. */
  onOpen?(): void;
}

export class RelayLink {
  status: LinkStatus = 'idle';
  private ws: WebSocket | null = null;
  private room: string | null = null;
  private retryMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: RelayLinkOptions) {}

  connect(room: string) {
    this.room = room;
    this.retryMs = 500;
    this.open();
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close() {
    this.room = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('idle');
  }

  private setStatus(s: LinkStatus) {
    this.status = s;
    this.opts.onStatus(s);
  }

  private open() {
    if (!this.room) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${api.ws}`);
    this.ws = ws;
    this.setStatus('connecting');
    const room = this.room;
    ws.onopen = () => {
      this.retryMs = 500;
      ws.send(JSON.stringify({ type: 'hello', role: 'laptop', room } satisfies ClientMessage));
      this.setStatus('open');
      this.opts.onOpen?.();
    };
    ws.onmessage = (ev) => {
      const msg = parseServerMessage(typeof ev.data === 'string' ? ev.data : '');
      if (msg) this.opts.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus('closed');
      if (!this.room) return;
      this.retryTimer = setTimeout(() => this.open(), this.retryMs);
      this.retryMs = Math.min(8000, this.retryMs * 2);
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do
    };
  }
}
