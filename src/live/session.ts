/**
 * A live view of one Overleaf project: an open collaboration socket, a local
 * copy of each joined document, and edits sent as operations that merge with
 * whatever other people type at the same time.
 *
 * Client-side OT follows the ShareJS model Overleaf's own editor uses: at most
 * one op in flight per document, later local ops wait in a queue, and every
 * op from someone else is transformed past both before it is applied here.
 */

import { EventEmitter } from 'node:events';
import { diffWordsWithSpace } from 'diff';
import type { OverleafClient } from '../client.js';
import { LiveSocket } from './socket.js';
import { apply, diffOp, transformX, type Op } from './ot.js';

export interface RemoteMeta {
  source?: string;
  user_id?: string;
  ts?: number;
}

export interface ChangeEvent {
  doc: LiveDoc;
  op: Op;
  local: boolean;
  meta?: RemoteMeta;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

function decodeLatin1Utf8(text: string): string {
  return Buffer.from(text, 'binary').toString('utf-8');
}

export class LiveDoc extends EventEmitter {
  content = '';
  version = 0;
  private inflight: { op: Op; v: number; waiters: Waiter[] } | null = null;
  private queue: Op = [];
  private queueWaiters: Waiter[] = [];

  constructor(readonly project: LiveProject, readonly id: string, readonly path: string) {
    super();
  }

  load(lines: string[], version: number): void {
    this.content = lines.map(decodeLatin1Utf8).join('\n');
    this.version = version;
  }

  get busy(): boolean {
    return Boolean(this.inflight) || this.queue.length > 0;
  }

  /** Apply an op here at once and send it; resolves when the server has it. */
  submit(op: Op): Promise<void> {
    if (!op.length) return Promise.resolve();
    this.content = apply(this.content, op);
    this.queue.push(...op);
    const done = new Promise<void>((resolve, reject) => this.queueWaiters.push({ resolve, reject }));
    this.emit('change', { doc: this, op, local: true } satisfies ChangeEvent);
    this.flush();
    return done;
  }

  private flush(): void {
    if (this.inflight || !this.queue.length) return;
    this.inflight = { op: this.queue, v: this.version, waiters: this.queueWaiters };
    this.queue = [];
    this.queueWaiters = [];
    const { op, v } = this.inflight;
    this.project.socket.rpc('applyOtUpdate', [this.id, { doc: this.id, op, v }]).catch(err => {
      this.failAll(err as Error);
      void this.project.resync(this);
    });
  }

  /**
   * The server applied our in-flight op at version `v`. That is our sent
   * version plus any ops from others that reached the server first; those
   * arrive here before the ack, so `v` matches our current version.
   */
  onAck(v: number): void {
    if (!this.inflight) return;
    if (v !== this.version) {
      void this.project.resync(this);
      return;
    }
    const { waiters } = this.inflight;
    this.inflight = null;
    this.version = v + 1;
    for (const w of waiters) w.resolve();
    this.flush();
  }

  /** Someone else's op, made against server version `v`. */
  onRemote(op: Op, v: number, meta?: RemoteMeta): void {
    if (v !== this.version) {
      void this.project.resync(this);
      return;
    }
    let remote = op;
    if (this.inflight) {
      const [mine, theirs] = transformX(this.inflight.op, remote);
      this.inflight.op = mine;
      remote = theirs;
    }
    if (this.queue.length) {
      const [mine, theirs] = transformX(this.queue, remote);
      this.queue = mine;
      remote = theirs;
    }
    this.version = v + 1;
    this.content = apply(this.content, remote);
    this.emit('change', { doc: this, op: remote, local: false, meta } satisfies ChangeEvent);
  }

  failAll(err: Error): void {
    const waiters = [...(this.inflight?.waiters || []), ...this.queueWaiters];
    this.inflight = null;
    this.queue = [];
    this.queueWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  /** Wait until nothing of ours is unacknowledged. */
  async settle(timeoutMs = 20_000): Promise<void> {
    const start = Date.now();
    while (this.busy) {
      if (Date.now() - start > timeoutMs) throw new Error(`${this.path}: edits not confirmed within ${timeoutMs}ms`);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  /** Line/column (0-based) of an offset, for cursors. */
  rowColumn(offset: number): { row: number; column: number } {
    const before = this.content.slice(0, offset).split('\n');
    return { row: before.length - 1, column: before[before.length - 1].length };
  }

  /**
   * Find `text` once in [from, to). Errors say exactly why, so an agent can
   * re-read and try again.
   */
  locate(text: string, from = 0, to = this.content.length): number {
    if (!text) throw new Error('Text to find is empty');
    const first = this.content.indexOf(text, from);
    if (first === -1 || first + text.length > to) {
      throw new Error(`Text not found in ${this.path}${from > 0 || to < this.content.length ? ' (inside the claimed section)' : ''}. It may have changed; read it again.`);
    }
    const second = this.content.indexOf(text, first + 1);
    if (second !== -1 && second + text.length <= to) {
      throw new Error(`Text appears more than once in ${this.path}; include more surrounding text so it is unique.`);
    }
    return first;
  }

  /** Replace one unique piece of text, as word-level edits. Returns the op sent. */
  async replace(oldText: string, newText: string, within?: { start: number; end: number }): Promise<Op> {
    const at = this.locate(oldText, within?.start, within?.end);
    const op = diffOp(at, oldText, newText, diffWordsWithSpace);
    await this.submit(op);
    return op;
  }
}

export interface ProjectDocInfo {
  id: string;
  path: string;
}

function walkDocs(folder: any, prefix: string, out: ProjectDocInfo[]): void {
  for (const doc of folder?.docs || []) out.push({ id: doc._id, path: prefix ? `${prefix}/${doc.name}` : doc.name });
  for (const child of folder?.folders || []) walkDocs(child, prefix ? `${prefix}/${child.name}` : child.name, out);
}

/**
 * Events: 'change' (ChangeEvent) for every doc, 'event' (name, args) for
 * every raw socket event, 'reconnected', 'closed'.
 */
export class LiveProject extends EventEmitter {
  socket!: LiveSocket;
  joinInfo: any;
  docs = new Map<string, LiveDoc>();
  private closing = false;
  private resyncing = new Set<string>();

  private constructor(readonly client: OverleafClient, readonly projectId: string, private verbose: boolean) {
    super();
  }

  static async open(client: OverleafClient, projectId: string, options: { verbose?: boolean } = {}): Promise<LiveProject> {
    const project = new LiveProject(client, projectId, Boolean(options.verbose));
    await project.connect();
    return project;
  }

  get name(): string {
    return this.joinInfo?.project?.name || this.projectId;
  }

  get publicId(): string {
    return this.socket.publicId;
  }

  get features(): Record<string, unknown> {
    return this.joinInfo?.project?.features || {};
  }

  listDocs(): ProjectDocInfo[] {
    const out: ProjectDocInfo[] = [];
    for (const root of this.joinInfo?.project?.rootFolder || []) walkDocs(root, '', out);
    return out;
  }

  private async connect(): Promise<void> {
    this.socket = new LiveSocket(this.client.liveAuth(), this.projectId, this.verbose);
    this.socket.on('event', (name: string, args: any[]) => this.onEvent(name, args));
    this.socket.on('disconnect', (reason: string) => void this.onDisconnect(reason));
    this.joinInfo = await this.socket.connect();
  }

  private onEvent(name: string, args: any[]): void {
    if (name === 'otUpdateApplied') {
      const update = args[0];
      const doc = update && [...this.docs.values()].find(d => d.id === update.doc);
      if (doc) {
        if (!update.op) doc.onAck(update.v);
        else if (update.meta?.source === this.publicId) doc.onAck(update.v);
        else doc.onRemote(update.op, update.v, update.meta);
      }
    } else if (name === 'otUpdateError') {
      const docId = args?.[1]?.doc || args?.[0]?.doc;
      const doc = [...this.docs.values()].find(d => d.id === docId);
      if (doc) void this.resync(doc);
      else for (const d of this.docs.values()) void this.resync(d);
    } else if (name === 'reciveNewFile' || name === 'reciveNewDoc' || name === 'reciveNewFolder' || name === 'removeEntity' || name === 'reciveEntityRename' || name === 'reciveEntityMove') {
      // Tree changed; refresh it on next listDocs via a cheap rejoin later.
      this.treeStale = true;
    }
    this.emit('event', name, args);
  }

  private treeStale = false;

  async refreshTree(): Promise<void> {
    if (!this.treeStale) return;
    const info = await this.client.getProjectInfo(this.projectId).catch(() => null);
    if (info?.rootFolder) this.joinInfo.project.rootFolder = info.rootFolder;
    this.treeStale = false;
  }

  private async onDisconnect(reason: string): Promise<void> {
    if (this.closing) return;
    if (this.verbose) console.error('[olf live] disconnected:', reason);
    for (let attempt = 1; attempt <= 5 && !this.closing; attempt++) {
      try {
        await new Promise(r => setTimeout(r, 1000 * attempt));
        await this.connect();
        for (const doc of this.docs.values()) await this.rejoin(doc);
        this.emit('reconnected');
        return;
      } catch (error) {
        if (this.verbose) console.error('[olf live] reconnect failed:', (error as Error).message);
      }
    }
    this.emit('closed', reason);
  }

  private async rejoin(doc: LiveDoc): Promise<void> {
    const [lines, version] = await this.socket.rpc('joinDoc', [doc.id, { encodeRanges: true }]);
    doc.failAll(new Error(`${doc.path} was reloaded from the server; read it again and retry.`));
    const before = doc.content;
    doc.load(lines, version);
    if (before !== doc.content) doc.emit('reloaded', { doc, before });
  }

  /** Reload a doc after the server and this copy disagreed. */
  async resync(doc: LiveDoc): Promise<void> {
    if (this.resyncing.has(doc.id)) return;
    this.resyncing.add(doc.id);
    try {
      await this.socket.rpc('leaveDoc', [doc.id]).catch(() => {});
      await this.rejoin(doc);
    } finally {
      this.resyncing.delete(doc.id);
    }
  }

  async doc(path: string): Promise<LiveDoc> {
    const normalized = path.replace(/^\/+/, '');
    const existing = this.docs.get(normalized);
    if (existing) return existing;
    await this.refreshTree();
    const info = this.listDocs().find(d => d.path === normalized);
    if (!info) {
      throw new Error(`No editable doc named ${normalized} in "${this.name}". Docs: ${this.listDocs().map(d => d.path).join(', ')}`);
    }
    const doc = new LiveDoc(this, info.id, info.path);
    const [lines, version] = await this.socket.rpc('joinDoc', [info.id, { encodeRanges: true }]);
    doc.load(lines, version);
    doc.on('change', (event: ChangeEvent) => this.emit('change', event));
    this.docs.set(normalized, doc);
    return doc;
  }

  docById(id: string): LiveDoc | undefined {
    return [...this.docs.values()].find(d => d.id === id);
  }

  /** Show this connection's cursor in the editor of everyone else. */
  async moveCursor(doc: LiveDoc, offset: number): Promise<void> {
    const { row, column } = doc.rowColumn(offset);
    await this.socket.emitEvent('clientTracking.updatePosition', [{ row, column, doc_id: doc.id }]).catch(() => {});
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const doc of this.docs.values()) {
      await doc.settle(5000).catch(() => {});
    }
    await this.socket.close();
  }
}
