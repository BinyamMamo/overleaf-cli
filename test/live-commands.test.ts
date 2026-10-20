import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThreadCommand } from '../src/live/commands.js';

const id = '6ad212903ace090efeeda0a9';

test('exact replies are commands', () => {
  assert.equal(parseThreadCommand('done'), 'resume');
  assert.equal(parseThreadCommand('  Done. '), 'resume');
  assert.equal(parseThreadCommand('Accept'), 'accept');
  assert.equal(parseThreadCommand('reject!'), 'reject');
  assert.equal(parseThreadCommand('/olf accept'), 'accept');
});

test('negations, questions and longer sentences are not commands', () => {
  for (const text of ['do not accept this', 'not okay', 'not done yet', 'I will accept later', 'accept?', '"accept"', 'ok but change the second sentence', 'no wait, accept']) {
    assert.equal(parseThreadCommand(text, id), null, text);
  }
});

test('an ID must name the target', () => {
  assert.equal(parseThreadCommand(`/olf accept ${id}`, id), 'accept');
  assert.equal(parseThreadCommand(`/olf accept 6ad212903ace090efeeda0a0`, id), null);
  assert.equal(parseThreadCommand(`accept ${id}`), null);
});
