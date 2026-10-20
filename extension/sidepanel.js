// olf side panel: what the agent is doing in this project, and the controls
// to steer it. All data comes from olf-mcp through the background worker.

const params = new URLSearchParams(location.search);
const state = {
  project: params.get('project'),
  tabId: null,
  tab: 'now',
  data: null,
  // Open confirmations and comparisons, keyed by item id, so a refresh does
  // not close them.
  open: {},
  notice: null,
  busy: false,
};

const $ = id => document.getElementById(id);
const main = $('main');

function send(message) {
  return new Promise(resolve => chrome.runtime.sendMessage(message, reply => resolve(chrome.runtime.lastError ? { ok: false } : reply)));
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function ago(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function diffView(segments) {
  return el('div', { class: 'diff' }, segments.map(([kind, text]) => kind === '+' ? el('ins', {}, text) : kind === '-' ? el('del', {}, text) : text));
}

async function act(action, body, after) {
  state.busy = true;
  render();
  const reply = await send({ type: 'action', project: state.project, action, body });
  state.busy = false;
  if (!reply?.ok) state.notice = { error: true, text: reply?.error || 'olf did not answer. Is your AI client still running?' };
  else if (after) after(reply.data);
  await refresh();
}

// ---------------------------------------------------------------- tabs

function viewNow(d) {
  if (!d.claims.length) {
    return el('div', { class: 'empty' },
      el('p', {}, 'The agent is not editing any section right now.'),
      el('p', {}, 'When it claims one, it shows up here with its task, and you can pause it.'));
  }
  return d.claims.map(c => el('div', { class: 'row' },
    el('div', { class: 'row-head' },
      el('span', { class: 'row-title' }, c.section),
      el('span', { class: `state ${c.state === 'paused' ? 'paused' : 'editing'}` }, c.state === 'paused' ? 'Paused' : 'Editing')),
    el('div', { class: 'row-sub' }, c.task),
    el('div', { class: 'row-meta' }, `${c.path}, lines ${c.startLine}-${c.endLine}, ${c.edits} edit${c.edits === 1 ? '' : 's'}`),
    el('div', { class: 'actions' },
      c.state === 'paused'
        ? el('button', { class: 'btn primary', disabled: state.busy, onclick: () => send({ type: 'resume', project: state.project, claimId: c.id }).then(refresh) }, 'Let it continue')
        : el('button', { class: 'btn', disabled: state.busy, onclick: () => send({ type: 'pause', project: state.project, claimId: c.id }).then(refresh) }, 'Pause'),
      el('button', { class: 'btn', onclick: () => send({ type: 'jump', tabId: state.tabId, section: c.section }) }, 'Show in editor'))));
}

function viewReview(d) {
  if (!d.suggestions.length) {
    return el('div', { class: 'empty' },
      el('p', {}, 'No suggestions waiting.'),
      el('p', {}, d.mode === 'suggest'
        ? 'The agent is in suggest mode: its changes will appear here for you to accept or reject.'
        : 'The agent edits directly. Ask it to "use suggest mode" if you want to approve each change here first.'));
  }
  return d.suggestions.map(s => el('div', { class: 'row' },
    el('div', { class: 'row-head' },
      el('span', { class: 'row-title' }, s.note || 'Suggested change'),
      el('span', { class: 'row-meta' }, ago(s.at))),
    el('div', { class: 'diff-path' }, s.path),
    diffView(s.diff),
    el('div', { class: 'actions' },
      el('button', { class: 'btn primary', disabled: state.busy, onclick: () => act('suggestion', { id: s.id, action: 'accept' }) }, 'Accept'),
      el('button', { class: 'btn', disabled: state.busy, onclick: () => act('suggestion', { id: s.id, action: 'reject' }) }, 'Reject'))));
}

function viewHistory(d) {
  if (!d.tasks.length) return el('div', { class: 'empty' }, el('p', {}, 'No agent tasks yet on this project.'));
  return d.tasks.map(t => {
    const open = state.open[`task:${t.id}`];
    const preview = state.open[`undo:${t.id}`];
    return el('div', { class: 'row' },
      el('div', { class: 'row-head' },
        el('span', { class: 'row-title' }, t.task),
        t.undone ? el('span', { class: 'state undone' }, 'Undone') : el('span', { class: 'row-meta' }, ago(t.at))),
      el('div', { class: 'row-meta' }, `${t.edits.length} edit${t.edits.length === 1 ? '' : 's'}${t.snapshot ? `, snapshot ${t.snapshot}` : ''}`),
      el('div', { class: 'actions' },
        el('button', { class: 'link', onclick: () => { state.open[`task:${t.id}`] = !open; render(); } }, open ? 'Hide changes' : 'Show changes'),
        !t.undone && el('button', { class: 'link', disabled: state.busy, onclick: () => act('undo-preview', { id: t.id }, data => { state.open[`undo:${t.id}`] = data; }) }, 'Undo...')),
      open && t.edits.map(e => [el('div', { class: 'diff-path' }, e.path), diffView(e.diff)]),
      preview && el('div', { class: 'confirm' },
        el('p', {}, 'Undo puts back the text before each edit, where the agent\'s text is still unchanged:'),
        el('ul', {}, preview.edits.map(e => el('li', { class: e.revertible ? '' : 'skip' }, `${e.path}: ${e.revertible ? 'can be undone' : `skipped (${e.reason})`}`))),
        el('div', { class: 'actions' },
          el('button', { class: 'btn primary', disabled: state.busy || !preview.edits.some(e => e.revertible), onclick: () => act('undo', { id: t.id, confirm: true }, r => { delete state.open[`undo:${t.id}`]; state.notice = { text: `Undid ${r.reverted} edit(s)${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}.` }; }) }, 'Undo these edits'),
          el('button', { class: 'btn', onclick: () => { delete state.open[`undo:${t.id}`]; render(); } }, 'Cancel'))));
  });
}

function viewSnapshots(d) {
  const input = el('input', { id: 'snap-msg', placeholder: 'What this snapshot marks', maxlength: '200' });
  const save = el('div', { class: 'save' }, input,
    el('button', { class: 'btn primary', disabled: state.busy, onclick: () => act('snapshot', { message: input.value }, r => { state.notice = { text: r.created ? `Saved snapshot ${r.commit}.` : 'Nothing changed since the last snapshot.' }; }) }, 'Save snapshot'));
  const backup = el('p', { class: 'hint row-meta' }, d.backup ? `Backed up to ${d.backup}` : 'Not backed up yet. ', !d.backup && el('code', {}, 'olf snapshot backup --github'));
  if (!d.snapshots.length) return [save, el('div', { class: 'empty' }, el('p', {}, 'No snapshots yet. Save one, or let the agent finish a task: each finished task is saved automatically.')), backup];
  return [save, d.snapshots.map(s => {
    const compare = state.open[`diff:${s.commit}`];
    const plan = state.open[`restore:${s.commit}`];
    return el('div', { class: 'row' },
      el('div', { class: 'row-head' },
        el('span', { class: 'row-title' }, s.message),
        el('span', { class: 'row-meta' }, ago(s.date))),
      el('div', { class: 'hash' }, s.commit),
      el('div', { class: 'actions' },
        el('button', { class: 'link', disabled: state.busy, onclick: () => compare ? (delete state.open[`diff:${s.commit}`], render()) : act('snapshot-diff', { id: s.commit }, r => { state.open[`diff:${s.commit}`] = r; }) }, compare ? 'Hide comparison' : 'Compare with now'),
        el('button', { class: 'link', disabled: state.busy, onclick: () => act('restore', { id: s.commit }, r => { state.open[`restore:${s.commit}`] = r; }) }, 'Restore...')),
      compare && el('div', { class: 'confirm' }, compare.changed.length
        ? el('ul', {}, compare.changed.map(c => el('li', {}, `${c.path}: ${c.status === 'modified' ? 'changed since' : c.status === 'added' ? 'new since' : 'removed since'}`)))
        : el('p', {}, 'Same as now.')),
      plan && el('div', { class: 'confirm' }, plan.plan.length
        ? [el('p', {}, `Restoring changes ${plan.plan.length} file(s). The current state is saved as a snapshot first.`),
           el('ul', {}, plan.plan.map(c => el('li', {}, `${c.path}: ${c.status === 'deleted' ? 'brought back' : 'restored'}`))),
           el('div', { class: 'actions' },
             el('button', { class: 'btn primary', disabled: state.busy, onclick: () => act('restore', { id: s.commit, confirm: true }, r => { delete state.open[`restore:${s.commit}`]; state.notice = { text: `Restored ${r.ref}. The state before is snapshot ${r.safetySnapshot}.` }; }) }, 'Restore'),
             el('button', { class: 'btn', onclick: () => { delete state.open[`restore:${s.commit}`]; render(); } }, 'Cancel'))]
        : el('p', {}, 'Nothing to restore: the project already matches.')));
  }), backup];
}

// ---------------------------------------------------------------- frame

function setStatus(parts) {
  $('status').replaceChildren(...parts.map(p => typeof p === 'string' ? document.createTextNode(p) : p));
}

function renderUnpaired(reason) {
  $('tabs').hidden = true;
  setStatus([reason === 'bad-token' ? 'The pairing code was replaced.' : 'Not paired with olf yet.']);
  const input = el('input', { placeholder: 'pairing code', autocomplete: 'off' });
  main.replaceChildren(el('div', { class: 'empty pair' },
    el('p', {}, 'Run this in a terminal and paste the code:'),
    el('p', {}, el('code', {}, 'olf extension pair')),
    input,
    el('button', { class: 'btn primary', onclick: async () => { await send({ type: 'set-token', token: input.value }); refresh(); } }, 'Pair'),
    el('p', { class: 'row-meta' }, 'Tip: "olf browser" and "olf extension install" pair it for you.')));
}

function render() {
  const d = state.data;
  if (!d) return;
  if (!d.live) {
    $('tabs').hidden = true;
    $('project-name').textContent = '';
    setStatus(['No agent is working on this project.']);
    main.replaceChildren(el('div', { class: 'empty' },
      el('p', {}, 'Start your AI client with olf and ask it to work on this project. This panel fills in as soon as it connects.'),
      d.projects?.length ? el('p', {}, `The agent is connected to: ${d.projects.map(p => p.name).join(', ')}.`) : null,
      el('p', {}, 'Not set up yet? Run ', el('code', {}, 'olf doctor'), '.')));
    return;
  }
  $('tabs').hidden = false;
  $('project-name').textContent = d.project.name;
  const editing = d.claims.filter(c => c.state !== 'paused').length;
  const paused = d.claims.length - editing;
  setStatus([
    el('strong', {}, 'Agent connected'),
    `, ${d.mode === 'suggest' ? 'suggest mode' : 'direct edits'}`,
    d.claims.length ? `, ${editing ? `editing ${editing}` : ''}${editing && paused ? ', ' : ''}${paused ? `${paused} paused` : ''}` : '',
    d.compile ? `. Last build ${d.compile.ok ? 'passed' : `failed (${d.compile.errors.length} error${d.compile.errors.length === 1 ? '' : 's'})`} ${ago(d.compile.at)}` : '',
  ]);
  $('count-now').textContent = d.claims.length ? String(d.claims.length) : '';
  $('count-review').textContent = d.suggestions.length ? String(d.suggestions.length) : '';
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === state.tab);
  const views = { now: viewNow, review: viewReview, history: viewHistory, snapshots: viewSnapshots };
  const keepInput = document.getElementById('snap-msg')?.value;
  main.replaceChildren(...[views[state.tab](d)].flat(2).filter(Boolean),
    ...(state.notice ? [el('p', { class: `notice${state.notice.error ? ' error' : ''}` }, state.notice.text)] : []));
  if (keepInput) { const input = document.getElementById('snap-msg'); if (input) input.value = keepInput; }
}

async function refresh() {
  if (!params.get('project')) {
    const current = await send({ type: 'current-project' });
    state.project = current?.project || null;
    state.tabId = current?.tabId ?? null;
  }
  if (!state.project) {
    $('tabs').hidden = true;
    $('project-name').textContent = '';
    setStatus(['Open an Overleaf project in this tab.']);
    main.replaceChildren(el('div', { class: 'empty' }, el('p', {}, 'This panel follows the Overleaf project in the active tab.')));
    return;
  }
  const reply = await send({ type: 'panel', project: state.project });
  if (!reply?.ok) {
    if (reply?.reason === 'not-paired' || reply?.reason === 'bad-token') return renderUnpaired(reply.reason);
    state.data = { live: false };
  } else {
    state.data = reply.data;
  }
  // Don't redraw while someone is typing a snapshot message.
  if (document.activeElement?.id === 'snap-msg' && state.data.live) return;
  render();
}

for (const button of document.querySelectorAll('.tabs button')) {
  button.addEventListener('click', () => {
    state.tab = button.dataset.tab;
    state.notice = null;
    render();
  });
}

chrome.tabs?.onActivated?.addListener(() => refresh());
setInterval(() => { if (!document.hidden && !state.busy) refresh(); }, 2000);
refresh();
