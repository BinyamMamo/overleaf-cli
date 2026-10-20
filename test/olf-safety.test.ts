import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, pathAllowed, projectAllowed } from '../src/policy.js';
import { rejectRequest } from '../src/live/bridge.js';
import { conflictLines } from '../src/live/push.js';

const token = 'a'.repeat(48);
const ok = { host: '127.0.0.1:47321', 'x-olf-token': token, 'content-type': 'application/json', origin: 'chrome-extension://abc' };

test('bridge accepts a paired extension request', () => {
  assert.equal(rejectRequest({ method: 'POST', headers: ok }, token), null);
  assert.equal(rejectRequest({ method: 'GET', headers: { host: 'localhost:47321', 'x-olf-token': token } }, token), null);
});

test('bridge rejects missing token, wrong token, web origins, odd hosts and text bodies', () => {
  assert.match(rejectRequest({ method: 'POST', headers: { ...ok, 'x-olf-token': undefined } }, token)!, /token/);
  assert.match(rejectRequest({ method: 'POST', headers: { ...ok, 'x-olf-token': 'b'.repeat(48) } }, token)!, /token/);
  assert.match(rejectRequest({ method: 'POST', headers: { ...ok, origin: 'https://untrusted.example' } }, token)!, /Origin/);
  assert.match(rejectRequest({ method: 'POST', headers: { ...ok, host: 'evil.test:47321' } }, token)!, /Host/);
  assert.match(rejectRequest({ method: 'POST', headers: { ...ok, 'content-type': 'text/plain' } }, token)!, /Content-Type/);
});

test('project allowlist matches names and IDs', () => {
  const policy = loadPolicy({ OLF_PROJECTS: 'My Thesis, 6ad21171c6e369340d355cba' });
  assert.ok(projectAllowed(policy, { id: 'x', name: 'my thesis' }));
  assert.ok(projectAllowed(policy, { id: '6ad21171c6e369340d355cba' }));
  assert.ok(!projectAllowed(policy, { id: 'y', name: 'Other paper' }));
  assert.ok(projectAllowed(loadPolicy({}), { id: 'y', name: 'anything' }));
});

test('workspace check follows symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'olf-ws-'));
  const ws = join(root, 'ws');
  const outside = join(root, 'outside');
  mkdirSync(ws);
  mkdirSync(outside);
  symlinkSync(outside, join(ws, 'escape'));
  const policy = loadPolicy({ OLF_WORKSPACE: ws });
  assert.ok(pathAllowed(policy, join(ws, 'paper', 'main.tex')));
  assert.ok(!pathAllowed(policy, join(ws, 'escape', 'secret.txt')));
  assert.ok(!pathAllowed(policy, join(ws, '..', 'outside', 'x')));
});

test('read-only flag parses', () => {
  assert.equal(loadPolicy({ OLF_READ_ONLY: '1' }).readOnly, true);
  assert.equal(loadPolicy({}).readOnly, false);
});

test('conflictLines finds edits to the same words, not separate ones', () => {
  const base = 'Line one is here.\nLine two is here.\n';
  assert.deepEqual(conflictLines(base, 'Line one is HERE.\nLine two is here.\n', 'Line one is here.\nLine two is THERE.\n'), []);
  assert.deepEqual(conflictLines(base, 'Line one is HERE.\nLine two is here.\n', 'Line one is there.\nLine two is here.\n'), [1]);
});
