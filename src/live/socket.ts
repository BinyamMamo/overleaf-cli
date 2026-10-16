/**
 * A long-lived Socket.IO 0.9 connection to an Overleaf project.
 *
 * client.ts opens the same socket for one request and closes it. Live editing
 * needs it to stay open: one GET is always waiting for packets from the
 * server (the xhr-polling transport), events are dispatched as they arrive,
 * and RPC calls are matched to their acknowledgements by id.
 */

import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as https from 'node:https';

export interface LiveAuth {
  baseUrl: string;
  userAgent: string;
  cookieHeader: () => string;
  absorbSetCookie: (headers?: string[]) => void;
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export function decodePayload(payload: string): string[] {
  if (!payload) return [];
  if (!payload.startsWith('�')) return [payload];
  const packets: string[] = [];
  let i = 0;
  while (i < payload.length && payload[i] === '�') {
    const close = payload.indexOf('�', i + 1);
    if (close === -1) break;
    const len = Number.parseInt(payload.slice(i + 1, close), 10);
    if (!Number.isFinite(len) || len < 0) break;
    packets.push(payload.slice(close + 1, close + 1 + len));
    i = close + 1 + len;
  }
  return packets;
}

/**
 * Events emitted:
 *   'event' (name, args)   a server event such as otUpdateApplied
 *   'disconnect' (reason)  the server closed the session or polling failed
 */
export class LiveSocket extends EventEmitter {
  private sid = '';
  private closed = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (args: any[]) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private sendChain: Promise<void> = Promise.resolve();
  publicId = '';
  joinProject: any = null;

  constructor(private auth: LiveAuth, readonly projectId: string, private verbose = false) {
    super();
  }

  private log(...args: unknown[]): void {
    if (this.verbose) console.error('[olf live]', ...args);
  }

  private url(path: string): string {
    return `${this.auth.baseUrl}/socket.io/1/${path}?projectId=${encodeURIComponent(this.projectId)}&t=${Date.now()}`;
  }

  private request(url: string, method: 'GET' | 'POST', body?: string, timeoutMs = 45_000): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const transport = url.startsWith('https:') ? https : http;
      const headers: Record<string, string> = {
        Cookie: this.auth.cookieHeader(),
        'User-Agent': this.auth.userAgent,
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'text/plain;charset=UTF-8';
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }
      const req = transport.request(url, { method, headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          this.auth.absorbSetCookie(res.headers['set-cookie']);
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Socket request timed out after ${timeoutMs}ms`)));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** Handshake, start polling, and wait for joinProjectResponse. */
  async connect(): Promise<any> {
    const res = await this.request(this.url(''), 'GET', undefined, 10_000);
    if (res.status !== 200) {
      const err = new Error(`Socket handshake failed: HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    this.sid = res.body.trim().split(':')[0];
    if (!this.sid) throw new Error('Socket handshake returned no session id');

    const joined = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No joinProjectResponse within 20s')), 20_000);
      const onEvent = (name: string, args: any[]) => {
        if (name === 'connectionAccepted') this.publicId = args?.[1] || this.publicId;
        if (name === 'connectionRejected') {
          clearTimeout(timer);
          this.off('event', onEvent);
          reject(new Error(`Connection rejected: ${JSON.stringify(args)}`));
        }
        if (name === 'joinProjectResponse') {
          clearTimeout(timer);
          this.off('event', onEvent);
          this.joinProject = args?.[0];
          this.publicId = args?.[0]?.publicId || this.publicId;
          resolve(args?.[0]);
        }
      };
      this.on('event', onEvent);
    });
    void this.pollLoop();
    return joined;
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (!this.closed) {
      try {
        const res = await this.request(this.url(`xhr-polling/${this.sid}`), 'GET');
        if (res.status !== 200) throw new Error(`Poll failed: HTTP ${res.status}`);
        failures = 0;
        for (const packet of decodePayload(res.body)) this.handlePacket(packet);
      } catch (error) {
        failures++;
        this.log('poll error', (error as Error).message);
        if (failures >= 3) {
          this.shutdown(`poll failed: ${(error as Error).message}`);
          return;
        }
        await new Promise(r => setTimeout(r, 1000 * failures));
      }
    }
  }

  private handlePacket(packet: string): void {
    this.log('<', packet.length > 300 ? `${packet.slice(0, 300)}...` : packet);
    const type = packet[0];
    if (type === '2') {
      void this.send('2::');
    } else if (type === '0') {
      this.shutdown('server disconnected');
    } else if (type === '5') {
      const json = packet.replace(/^5:[^:]*:[^:]*:/, '');
      try {
        const { name, args } = JSON.parse(json);
        this.emit('event', name, args || []);
      } catch {
        this.log('bad event packet', packet);
      }
    } else if (type === '6') {
      const match = packet.match(/^6:::(\d+)\+?(.*)$/s);
      if (!match) return;
      const id = Number(match[1]);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      let args: any[] = [];
      try {
        const parsed = match[2] ? JSON.parse(match[2]) : [];
        args = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // keep empty
      }
      entry.resolve(args);
    } else if (type === '7') {
      this.log('socket error packet', packet);
    }
  }

  /** Packets go out one at a time, in order. */
  private send(packet: string): Promise<void> {
    const run = async () => {
      if (this.closed && packet !== '0::') return;
      this.log('>', packet.length > 300 ? `${packet.slice(0, 300)}...` : packet);
      const res = await this.request(this.url(`xhr-polling/${this.sid}`), 'POST', packet, 15_000);
      if (res.status !== 200) throw new Error(`Socket send failed: HTTP ${res.status}`);
    };
    const next = this.sendChain.then(run, run);
    this.sendChain = next.catch(() => {});
    return next;
  }

  /** Emit an event without waiting for a reply. */
  async emitEvent(name: string, args: any[]): Promise<void> {
    await this.send(`5:::${JSON.stringify({ name, args })}`);
  }

  /** Emit an event and wait for its acknowledgement. Throws on a server error. */
  rpc(name: string, args: any[], timeoutMs = 30_000): Promise<any[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${name}: no reply within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: ack => {
          const [error, ...rest] = ack;
          if (error) reject(new Error(`${name} failed: ${typeof error === 'string' ? error : error.message || JSON.stringify(error)}`));
          else resolve(rest);
        },
        reject,
        timer,
      });
      this.send(`5:${id}+::${JSON.stringify({ name, args })}`).catch(err => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Socket closed: ${reason}`));
    }
    this.pending.clear();
    this.emit('disconnect', reason);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.send('0::');
    } catch {
      // best effort
    }
    this.shutdown('closed by client');
  }
}
