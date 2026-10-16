// Talks to olf-mcp on this machine. Done here, not in the page, so the
// request comes from the extension and not from overleaf.com.
const BRIDGE = 'http://127.0.0.1:47321';

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  const request = message.type === 'claims'
    ? fetch(`${BRIDGE}/claims?project=${encodeURIComponent(message.project)}`)
    : fetch(`${BRIDGE}/${message.type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: message.project, claimId: message.claimId }),
      });
  request
    .then(res => res.json())
    .then(data => reply({ ok: true, data }))
    .catch(() => reply({ ok: false }));
  return true;
});
