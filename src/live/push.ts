/**
 * Push text files as live edits instead of whole-file uploads.
 *
 * `olcli push` replaces a remote file with the local one, which throws away
 * anything a collaborator wrote since your pull. olf keeps the version you
 * last pulled (the base, in .olf/base/) and does a three-way merge with OT:
 * your changes since the base are moved past their changes since the base,
 * then sent as live edits. Nothing either side wrote is lost, and someone
 * typing in the browser during the push is not interrupted.
 *
 * Without a base (first push after an old pull), the remote is brought to
 * your local text with the smallest edits, which is still safe for typing
 * that happens during the push.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as http from 'node:http';
import { diffWordsWithSpace } from 'diff';
import type { OverleafClient } from '../client.js';
import { LiveProject } from './session.js';
import { apply, diffOp, transformX, type Op } from './ot.js';
import { BRIDGE_PORT } from './bridge.js';

const BASE_DIR = join('.olf', 'base');

export function basePath(dir: string, relPath: string): string {
  return join(dir, BASE_DIR, relPath);
}

export function saveBase(dir: string, relPath: string, content: Buffer | string): void {
  if (Buffer.isBuffer(content) && !isUtf8Text(content)) return;
  try {
    const path = basePath(dir, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  } catch {
    // The base only improves merges; never fail a pull over it.
  }
}

function readBase(dir: string, relPath: string): string | undefined {
  const path = basePath(dir, relPath);
  return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
}

/**
 * Merge local edits into the remote text.
 * Returns the op to send to the remote and the merged result.
 */
export function mergeText(base: string | undefined, remote: string, local: string): { op: Op; merged: string; remoteChanged: boolean } {
  if (base === undefined || base === remote) {
    const op = diffOp(0, remote, local, diffWordsWithSpace);
    return { op, merged: apply(remote, op), remoteChanged: false };
  }
  const mine = diffOp(0, base, local, diffWordsWithSpace);
  const theirs = diffOp(0, base, remote, diffWordsWithSpace);
  const [mineAfterTheirs] = transformX(mine, theirs);
  return { op: mineAfterTheirs, merged: apply(remote, mineAfterTheirs), remoteChanged: true };
}

function isUtf8Text(content: Buffer): boolean {
  if (content.includes(0)) return false;
  return Buffer.from(content.toString('utf-8'), 'utf-8').equals(content);
}

interface BridgeClaim {
  path: string;
  section: string;
  state: string;
  startLine: number;
  endLine: number;
}

function fetchClaims(projectId: string): Promise<BridgeClaim[]> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: BRIDGE_PORT, path: `/claims?project=${projectId}`, timeout: 800 }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')).claims || []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

function lineRange(text: string, startLine: number, endLine: number): { start: number; end: number } {
  const lines = text.split('\n');
  const start = lines.slice(0, startLine - 1).reduce((n, l) => n + l.length + 1, 0);
  const end = lines.slice(0, endLine).reduce((n, l) => n + l.length + 1, 0);
  return { start, end };
}

export type PushResult =
  | { status: 'merged'; remoteChanged: boolean; merged: string }
  | { status: 'unchanged' }
  | { status: 'not-doc' }
  | { status: 'skipped'; reason: string };

export class LivePusher {
  private claims: BridgeClaim[] = [];

  private constructor(private live: LiveProject, private dir: string) {}

  static async open(client: OverleafClient, projectId: string, dir: string): Promise<LivePusher | null> {
    if (process.env.OLF_LIVE_PUSH === 'off') return null;
    try {
      const live = await LiveProject.open(client, projectId);
      const pusher = new LivePusher(live, dir);
      pusher.claims = await fetchClaims(projectId);
      return pusher;
    } catch {
      return null;
    }
  }

  async push(relPath: string, content: Buffer): Promise<PushResult> {
    const path = relPath.replace(/\\/g, '/');
    if (!this.live.listDocs().some(d => d.path === path) || !isUtf8Text(content)) return { status: 'not-doc' };
    const doc = await this.live.doc(path);
    const local = content.toString('utf-8');
    const { op, merged, remoteChanged } = mergeText(readBase(this.dir, path), doc.content, local);
    if (!op.length) {
      saveBase(this.dir, path, doc.content);
      return { status: 'unchanged' };
    }

    for (const claim of this.claims.filter(c => c.path === path)) {
      const range = lineRange(doc.content, claim.startLine, claim.endLine);
      const hits = op.some(c => c.p < range.end && c.p + ('d' in c ? c.d.length : 0) >= range.start);
      if (hits) return { status: 'skipped', reason: `the agent is editing "${claim.section}" (lines ${claim.startLine}-${claim.endLine}); push again after it releases` };
    }

    await doc.submit(op);
    await doc.settle();
    saveBase(this.dir, path, doc.content);
    return { status: 'merged', remoteChanged, merged: doc.content };
  }

  async close(): Promise<void> {
    await this.live.close().catch(() => {});
  }
}
