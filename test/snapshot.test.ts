import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

process.env.OLF_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), 'olf-snaps-'));
const { saveSnapshot, listSnapshots, diffSnapshot, snapshotForTask, snapshotRepoDir } = await import('../src/snapshot.js');

function zipOf(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, text] of Object.entries(files)) zip.addFile(path, Buffer.from(text));
  return zip.toBuffer();
}

let remote: Record<string, string> = { 'main.tex': 'Hello\n', 'sections/intro.tex': 'Intro\n', '.env': 'SECRET=1\n' };
const client = {
  getProjectById: async () => ({ id: 'p1', name: 'Test paper' }),
  downloadProject: async () => zipOf(remote),
} as any;

test('save, skip when unchanged, save again, list and find by task', async () => {
  const first = await saveSnapshot(client, 'p1', { message: 'first' });
  assert.equal(first.created, true);
  assert.ok(!existsSync(join(snapshotRepoDir('p1'), '.env')), 'secret files are not committed');
  const again = await saveSnapshot(client, 'p1', { message: 'again' });
  assert.equal(again.created, false);
  remote = { ...remote, 'main.tex': 'Hello world\n' };
  const second = await saveSnapshot(client, 'p1', { message: 'agent edit', taskId: 'task123' });
  assert.equal(second.created, true);
  assert.deepEqual(listSnapshots('p1').map(s => s.message), ['agent edit', 'first']);
  assert.equal(snapshotForTask('p1', 'task123'), second.commit);
});

test('diff reports changed, added and removed files against now', async () => {
  const head = listSnapshots('p1')[0].commit;
  remote = { 'main.tex': 'Changed\n', 'new.tex': 'x\n' };
  const d = await diffSnapshot(client, 'p1', head);
  assert.deepEqual(d.changed, [
    { status: 'modified', path: 'main.tex' },
    { status: 'added', path: 'new.tex' },
    { status: 'deleted', path: 'sections/intro.tex' },
  ]);
});
