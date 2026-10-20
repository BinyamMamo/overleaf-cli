/**
 * A tiny local HTTP endpoint for the optional browser extension.
 *
 * It is off until the extension is paired (`olf extension pair`, or
 * `olf browser`, which pairs automatically). Pairing creates a random token
 * in the olf config folder; every request must carry it in `X-Olf-Token`.
 * The server listens on 127.0.0.1 only, accepts only its own Host header,
 * only extension (or origin-less) callers, only small JSON bodies, and only
 * well-formed IDs. The extension asks it which sections are claimed (to draw
 * them) and tells it when the person chose "Edit anyway" (to pause the agent).
 * Nothing in olf depends on it being reached.
 */

import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigPath } from '../config.js';
import { diffWordsWithSpace } from 'diff';
import type { Coop } from './coop.js';
import { listTasks } from './tasklog.js';
import { diffSnapshot, getSnapshotRemote, listSnapshots, restoreSnapshot, saveSnapshot, snapshotForTask } from '../snapshot.js';

export const BRIDGE_PORT = Number(process.env.OLF_BRIDGE_PORT) || 47321;
const MAX_BODY = 8192;
const ID = /^[0-9a-f]{24}$/;
const REF = /^[0-9a-f]{4,40}$/;

type Segment = ['=' | '-' | '+', string];

/** Word-level diff for display, trimmed around long unchanged runs. */
export function wordSegments(before: string, after: string): Segment[] {
  const parts = diffWordsWithSpace(before, after);
  // Many small changes read badly word by word; show old and new whole.
  const changes = parts.filter(p => p.added || p.removed).length;
  if (changes > 6) return [['-', before], ['=', '\n'], ['+', after]];
  return parts.map(part => {
    const kind: Segment[0] = part.added ? '+' : part.removed ? '-' : '=';
    let text = part.value;
    if (kind === '=' && text.length > 160) text = `${text.slice(0, 70)} ... ${text.slice(-70)}`;
    return [kind, text];
  });
}

/** Everything the side panel shows, in one response. */
function panelFor(coop: Coop) {
  const tasks = listTasks(coop.projectId).slice(0, 15).map(task => ({
    id: task.taskId,
    task: task.task,
    at: task.edits[0]?.ts,
    undone: task.undone,
    snapshot: snapshotForTask(coop.projectId, task.taskId),
    edits: task.edits.map(e => ({ path: e.path, kind: e.kind, diff: wordSegments(e.before, e.after) })),
  }));
  return {
    project: { id: coop.projectId, name: coop.live.name },
    mode: coop.mode,
    claims: claimsFor(coop),
    suggestions: coop.pendingSuggestions().map(sug => ({ id: sug.id, path: sug.path, note: sug.note, at: sug.createdAt, diff: wordSegments(sug.oldText, sug.newText) })),
    tasks,
    snapshots: listSnapshots(coop.projectId, 15),
    backup: getSnapshotRemote(coop.projectId) || null,
    compile: coop.lastCompile || null,
  };
}

function str(value: unknown, max = 200): string {
  const text = typeof value === 'string' ? value : '';
  if (text.length > max) throw new Error('value too long');
  return text;
}

function tokenPath(): string {
  return join(dirname(getConfigPath()), 'bridge-token');
}

/** The pairing token, or undefined when the extension was never paired. */
export function readBridgeToken(): string | undefined {
  try {
    const token = readFileSync(tokenPath(), 'utf-8').trim();
    return token.length >= 32 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Create the pairing token if needed and return it. `rotate` makes a new one. */
export function ensureBridgeToken(rotate = false): string {
  const existing = readBridgeToken();
  if (existing && !rotate) return existing;
  const token = randomBytes(24).toString('hex');
  mkdirSync(dirname(tokenPath()), { recursive: true });
  writeFileSync(tokenPath(), token, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(tokenPath(), 0o600);
  } catch {
    // Windows: ACLs, not modes.
  }
  return token;
}

export function bridgeTokenExists(): boolean {
  return existsSync(tokenPath()) && Boolean(readBridgeToken());
}

const coops = new Map<string, Coop>();
let server: http.Server | null = null;

function claimsFor(coop: Coop) {
  return [...coop.claims.values()].map(claim => {
    const doc = coop.live.docs.get(claim.path);
    const content = doc?.content || '';
    const startLine = content.slice(0, claim.range.start).split('\n').length;
    const endLine = content.slice(0, Math.max(claim.range.start, claim.range.end - 1)).split('\n').length;
    return {
      id: claim.id,
      path: claim.path,
      section: claim.section,
      task: claim.task,
      mode: coop.mode,
      state: claim.state,
      edits: claim.edits,
      startLine,
      endLine,
    };
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, origin?: string): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (origin?.startsWith('chrome-extension://')) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Olf-Token';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }
  res.writeHead(status, headers);
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed;
}

/**
 * Check everything about a request except the route. Returns an error
 * message, or null when the request may proceed.
 */
export function rejectRequest(req: { method?: string; headers: http.IncomingHttpHeaders }, token: string, port = BRIDGE_PORT): string | null {
  const host = req.headers.host || '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'unexpected Host';
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) return 'unexpected Origin';
  const given = req.headers['x-olf-token'];
  if (!sameToken(Array.isArray(given) ? given[0] : given, token)) return 'missing or wrong token';
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return 'Content-Type must be application/json';
  return null;
}

export function handleBridgeRequest(token: string, port = BRIDGE_PORT) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const origin = req.headers.origin as string | undefined;
    req.setTimeout(5000);
    if (req.method === 'OPTIONS') return send(res, 204, null, origin);
    const problem = rejectRequest(req, token, port);
    if (problem) return send(res, problem === 'missing or wrong token' ? 401 : 403, { error: problem }, origin);
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/claims') {
        const projectId = url.searchParams.get('project') || '';
        if (!ID.test(projectId)) return send(res, 400, { error: 'bad project id' }, origin);
        const coop = coops.get(projectId);
        return send(res, 200, { project: projectId, live: Boolean(coop), claims: coop ? claimsFor(coop) : [] }, origin);
      }
      if (req.method === 'POST' && (url.pathname === '/pause' || url.pathname === '/resume')) {
        const body = await readJson(req);
        const projectId = String(body.project || '');
        const claimId = String(body.claimId || '');
        if (!ID.test(projectId) || !ID.test(claimId)) return send(res, 400, { error: 'bad id' }, origin);
        const coop = coops.get(projectId);
        if (!coop) return send(res, 404, { error: 'project not live' }, origin);
        const claim = url.pathname === '/pause'
          ? await coop.pauseClaim(claimId, 'the person chose "Edit anyway" in the browser')
          : coop.resumeClaim(claimId, 'the person pressed "Done" in the browser');
        return send(res, 200, { id: claim.id, state: claim.state }, origin);
      }
      if (req.method === 'GET' && url.pathname === '/panel') {
        const projectId = url.searchParams.get('project') || '';
        if (!ID.test(projectId)) return send(res, 400, { error: 'bad project id' }, origin);
        const coop = coops.get(projectId);
        if (!coop) return send(res, 200, { live: false, projects: [...coops.values()].map(c => ({ id: c.projectId, name: c.live.name })) }, origin);
        return send(res, 200, { live: true, ...panelFor(coop) }, origin);
      }
      if (req.method === 'POST' && ['/suggestion', '/undo-preview', '/undo', '/snapshot', '/snapshot-diff', '/restore'].includes(url.pathname)) {
        const body = await readJson(req);
        const projectId = str(body.project, 24);
        if (!ID.test(projectId)) return send(res, 400, { error: 'bad project id' }, origin);
        const coop = coops.get(projectId);
        if (!coop) return send(res, 404, { error: 'project not live' }, origin);
        const id = str(body.id, 40);
        switch (url.pathname) {
          case '/suggestion':
            if (!ID.test(id) || !['accept', 'reject'].includes(String(body.action))) return send(res, 400, { error: 'bad request' }, origin);
            return send(res, 200, await coop.decideSuggestion(id, body.action === 'accept'), origin);
          case '/undo-preview':
            if (!ID.test(id)) return send(res, 400, { error: 'bad task id' }, origin);
            return send(res, 200, await coop.undoPreview(id), origin);
          case '/undo':
            if (!ID.test(id) || body.confirm !== true) return send(res, 400, { error: 'confirm required' }, origin);
            return send(res, 200, await coop.undo(id), origin);
          case '/snapshot': {
            const message = str(body.message, 200).trim() || 'Saved from the olf panel';
            return send(res, 200, await saveSnapshot(coop.client, projectId, { message }), origin);
          }
          case '/snapshot-diff':
            if (!REF.test(id)) return send(res, 400, { error: 'bad snapshot id' }, origin);
            return send(res, 200, await diffSnapshot(coop.client, projectId, id), origin);
          case '/restore':
            if (!REF.test(id)) return send(res, 400, { error: 'bad snapshot id' }, origin);
            return send(res, 200, await restoreSnapshot(coop.client, projectId, id, { dryRun: body.confirm !== true }), origin);
        }
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, projects: [...coops.keys()] }, origin);
      }
      send(res, 404, { error: 'not found' }, origin);
    } catch (error) {
      send(res, 400, { error: (error as Error).message }, origin);
    }
  };
}

/** Register a live project; start the server if the extension is paired. */
export function startBridge(coop: Coop): void {
  coops.set(coop.projectId, coop);
  if (server || process.env.OLF_BRIDGE === 'off') return;
  const token = readBridgeToken();
  if (!token) return;

  server = http.createServer(handleBridgeRequest(token));
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('error', () => {
    // Port taken (another olf-mcp is running): the extension talks to that one.
    server = null;
  });
  server.listen(BRIDGE_PORT, '127.0.0.1');
  server.unref();
}

export function stopBridgeFor(projectId: string): void {
  coops.delete(projectId);
}
