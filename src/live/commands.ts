/**
 * Replies a person writes in an agent's comment thread, read as commands.
 *
 * Only a whole reply that is exactly one command counts. "done" resumes a
 * paused claim; "not done yet", "do not accept this" or "I will accept later"
 * do nothing. An optional "/olf" prefix and an ID are allowed
 * ("/olf accept 6ad2..."); an ID that names a different item does nothing.
 */

export type ThreadCommand = 'resume' | 'accept' | 'reject';

const WORDS: Record<ThreadCommand, string[]> = {
  resume: ['done', 'continue', 'resume', 'go ahead', 'go on', 'carry on', 'ok', 'okay'],
  accept: ['accept', 'accepted', 'apply', 'approve', 'approved', 'yes'],
  reject: ['reject', 'rejected', 'decline', 'discard', 'no'],
};

export function parseThreadCommand(text: string, targetId?: string): ThreadCommand | null {
  let body = text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trim();
  body = body.replace(/^\/olf\s+/, '');
  const idMatch = body.match(/^(.*?)\s+([0-9a-f]{24})$/);
  if (idMatch) {
    if (!targetId || idMatch[2] !== targetId.toLowerCase()) return null;
    body = idMatch[1];
  }
  for (const [command, words] of Object.entries(WORDS) as [ThreadCommand, string[]][]) {
    if (words.includes(body)) return command;
  }
  return null;
}
