import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OverleafClient, planRedirect } from '../src/client.js';

const creds = { Cookie: 'overleaf_session2=secret', 'X-Csrf-Token': 'tok', 'User-Agent': 'olf' };

test('same-origin redirect keeps credentials', () => {
  const next = planRedirect(new URL('https://a.test/x'), new URL('https://a.test/y'), 302, { method: 'GET', headers: creds, body: undefined });
  assert.equal(next.headers.Cookie, 'overleaf_session2=secret');
});

test('cross-origin redirect drops cookie and CSRF token', () => {
  const next = planRedirect(new URL('https://a.test/x'), new URL('https://b.test/y'), 302, { method: 'GET', headers: creds, body: undefined });
  assert.equal(next.headers.Cookie, undefined);
  assert.equal(next.headers['X-Csrf-Token'], undefined);
  assert.equal(next.headers['User-Agent'], 'olf');
});

test('HTTPS to HTTP downgrade is refused', () => {
  assert.throws(() => planRedirect(new URL('https://a.test/x'), new URL('http://a.test/y'), 302, { method: 'GET', headers: creds, body: undefined }), /Refusing redirect/);
});

test('303 turns a POST into a GET without a body', () => {
  const next = planRedirect(new URL('https://a.test/x'), new URL('https://a.test/y'), 303, { method: 'POST', headers: { ...creds, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(next.method, 'GET');
  assert.equal(next.body, undefined);
  assert.equal(next.headers['Content-Type'], undefined);
});

test('307 to another origin with a body is refused', () => {
  assert.throws(() => planRedirect(new URL('https://a.test/x'), new URL('https://b.test/y'), 307, { method: 'POST', headers: creds, body: 'secret' }), /request body/);
});

test('a real redirect to another host does not carry the cookie', async () => {
  let seen: http.IncomingHttpHeaders | undefined;
  const target = http.createServer((req, res) => { seen = req.headers; res.end('ok'); });
  await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
  const targetPort = (target.address() as AddressInfo).port;
  const origin = http.createServer((_req, res) => { res.writeHead(302, { Location: `http://localhost:${targetPort}/landing` }); res.end(); });
  await new Promise<void>(r => origin.listen(0, '127.0.0.1', r));
  const originPort = (origin.address() as AddressInfo).port;
  try {
    const client = new OverleafClient({ cookies: { overleaf_session2: 'secret' }, csrf: 'tok', baseUrl: `http://127.0.0.1:${originPort}` });
    await client.getCommentThreads('p').catch(() => {});
    assert.ok(seen, 'target was reached');
    assert.equal(seen!.cookie, undefined);
    assert.equal(seen!['x-csrf-token'], undefined);
  } finally {
    target.close();
    origin.close();
  }
});
