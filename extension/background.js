// Talks to olf-mcp on this machine. Done here, not in the page, so the
// request comes from the extension and not from overleaf.com.
const BRIDGE = 'http://127.0.0.1:47321';

// The pairing token: set from the side panel, or baked in by
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

async function call(method, path, body) {
  const token = await getToken();
  if (!token) return { ok: false, reason: 'not-paired' };
  const init = { method, headers: { 'X-Olf-Token': token } };
  if (body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(BRIDGE + path, init);
    if (res.status === 401) return { ok: false, reason: 'bad-token' };
    const data = await res.json();
    return res.ok ? { ok: true, data } : { ok: false, reason: 'error', error: data.error };
  } catch {
    return { ok: false, reason: 'no-agent' };
  }
}

// Which Overleaf project each tab shows, reported by the content script.
const tabProjects = new Map();

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const handle = async () => {
    switch (message.type) {
      case 'project':
        if (sender.tab?.id != null) tabProjects.set(sender.tab.id, message.project);
        if (message.name) {
          // Remember names, so the panel can show one even with no tab open.
          const { projectNames = {} } = await chrome.storage.local.get('projectNames');
          if (projectNames[message.project] !== message.name) {
            projectNames[message.project] = message.name;
            await chrome.storage.local.set({ projectNames });
          }
        }
        return { ok: true };
      case 'current-project': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const project = tab ? tabProjects.get(tab.id) || null : null;
        return { ok: true, project, tabId: tab?.id ?? null };
      }
      case 'project-name': {
        const { projectNames = {} } = await chrome.storage.local.get('projectNames');
        return { ok: true, name: projectNames[message.project] || null };
      }
      case 'open-panel':
        if (sender.tab?.id != null) await chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
        return { ok: true };
      case 'jump':
        if (message.tabId != null) await chrome.tabs.sendMessage(message.tabId, { type: 'jump', section: message.section }).catch(() => {});
        return { ok: true };
      case 'set-token':
        await chrome.storage.local.set({ olfToken: String(message.token || '').trim() });
        return { ok: true };
      // Bridge calls.
      case 'claims':
        return call('GET', `/claims?project=${encodeURIComponent(message.project)}`);
      case 'panel':
        return call('GET', `/panel?project=${encodeURIComponent(message.project)}`);
      case 'health':
        return call('GET', '/health');
      case 'pause':
      case 'resume':
        return call('POST', `/${message.type}`, { project: message.project, claimId: message.claimId });
      case 'action':
        return call('POST', `/${message.action}`, { project: message.project, ...message.body });
      default:
        return { ok: false, reason: 'unknown' };
    }
  };
  handle().then(reply);
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => tabProjects.delete(tabId));
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
