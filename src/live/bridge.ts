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
import type { Coop } from './coop.js';

export const BRIDGE_PORT = Number(process.env.OLF_BRIDGE_PORT) || 47321;
const MAX_BODY = 4096;
const ID = /^[0-9a-f]{24}$/;

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
