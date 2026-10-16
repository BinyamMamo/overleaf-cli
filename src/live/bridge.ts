/**
 * A tiny local HTTP endpoint for the optional browser extension.
 *
 * It only listens on 127.0.0.1. The extension asks it which sections are
 * claimed (to draw them) and tells it when the person chose "Edit anyway"
 * (to pause the agent). Nothing in olf depends on it being reached.
 */

import * as http from 'node:http';
import type { Coop } from './coop.js';

export const BRIDGE_PORT = Number(process.env.OLF_BRIDGE_PORT) || 47321;

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
      docId: doc?.id,
      section: claim.section,
      task: claim.task,
      state: claim.state,
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
  if (origin && (/^https:\/\/([a-z0-9-]+\.)*overleaf\.com$/.test(origin) || origin.startsWith('chrome-extension://'))) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  res.writeHead(status, headers);
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
  } catch {
    return {};
  }
}

export function startBridge(coop: Coop): void {
  coops.set(coop.projectId, coop);
  if (server || process.env.OLF_BRIDGE === 'off') return;

  server = http.createServer(async (req, res) => {
    const origin = req.headers.origin as string | undefined;
    if (req.method === 'OPTIONS') return send(res, 204, null, origin);
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/claims') {
        const projectId = url.searchParams.get('project') || '';
        const coop = coops.get(projectId);
        return send(res, 200, { project: projectId, live: Boolean(coop), claims: coop ? claimsFor(coop) : [] }, origin);
      }
      if (req.method === 'POST' && (url.pathname === '/pause' || url.pathname === '/resume')) {
        const body = await readJson(req);
        const coop = coops.get(String(body.project || ''));
        if (!coop) return send(res, 404, { error: 'project not live' }, origin);
        const claim = url.pathname === '/pause'
          ? await coop.pauseClaim(String(body.claimId), 'the person chose "Edit anyway" in the browser')
          : coop.resumeClaim(String(body.claimId), 'the person pressed "Done" in the browser');
        return send(res, 200, { id: claim.id, state: claim.state }, origin);
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, projects: [...coops.keys()] }, origin);
      }
      send(res, 404, { error: 'not found' }, origin);
    } catch (error) {
      send(res, 400, { error: (error as Error).message }, origin);
    }
  });
  server.on('error', () => {
    // Port taken (another olf-mcp is running): the extension talks to that one.
    server = null;
  });
  server.listen(BRIDGE_PORT, '127.0.0.1');
  server.unref();
}
