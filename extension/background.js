// Talks to olf-mcp on this machine. Done here, not in the page, so the
// request comes from the extension and not from overleaf.com.
const BRIDGE = 'http://127.0.0.1:47321';

// The pairing token: set from the popup, or baked in by
// `olf extension install` / `olf browser` as pairing.json.
async function getToken() {
  const { olfToken } = await chrome.storage.local.get('olfToken');
  if (olfToken) return olfToken;
  try {
    const res = await fetch(chrome.runtime.getURL('pairing.json'));
    if (res.ok) {
      const { token } = await res.json();
      if (token) {
        await chrome.storage.local.set({ olfToken: token });
        return token;
      }
    }
  } catch {
    // not bundled
  }
  return null;
}

async function bridge(message) {
  const token = await getToken();
  if (!token) return { ok: false, reason: 'not-paired' };
  const headers = { 'X-Olf-Token': token };
  const url = message.type === 'claims'
    ? `${BRIDGE}/claims?project=${encodeURIComponent(message.project)}`
    : message.type === 'health' ? `${BRIDGE}/health` : `${BRIDGE}/${message.type}`;
  const init = message.type === 'claims' || message.type === 'health'
    ? { headers }
    : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: message.project, claimId: message.claimId }) };
  try {
    const res = await fetch(url, init);
    if (res.status === 401) return { ok: false, reason: 'bad-token' };
    return { ok: res.ok, data: await res.json() };
  } catch {
    return { ok: false, reason: 'no-agent' };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type === 'set-token') {
    chrome.storage.local.set({ olfToken: message.token.trim() }).then(() => reply({ ok: true }));
    return true;
  }
  bridge(message).then(reply);
  return true;
});
