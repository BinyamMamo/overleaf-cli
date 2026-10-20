// olf extension: draw the agent's claimed sections in the Overleaf editor and
// ask before the person types inside one.
//
// It reads only the DOM Overleaf renders (line-number gutter, active line,
// file tree). If Overleaf changes that markup, the extension just shows
// nothing; olf itself keeps working through comments and pausing.

(() => {
  const projectId = (location.pathname.match(/\/project\/([0-9a-f]{24})/) || [])[1];
  if (!projectId) return;

  let claims = [];
  let allowed = new Set(); // claim ids the person chose to edit anyway
  let bridgeUp = false;

  const layer = document.createElement('div');
  layer.className = 'olf-layer';
  document.body.appendChild(layer);

  const banner = document.createElement('div');
  banner.className = 'olf-banner';
  banner.hidden = true;
  document.body.appendChild(banner);

  function ask(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, reply => resolve(chrome.runtime.lastError ? { ok: false } : reply));
      } catch {
        resolve({ ok: false });
      }
    });
  }

  // The selected file-tree row. Its text also holds icon names
  // ("description", "more_vert"), so match claim file names inside it.
  function selectedTreeText() {
    const selected = document.querySelector('[role="treeitem"][aria-selected="true"]');
    return selected?.textContent || '';
  }

  function claimsForOpenFile() {
    const text = selectedTreeText();
    if (!text) return [];
    return claims.filter(c => text.includes(c.path.split('/').pop()));
  }

  function gutterLines() {
    const map = new Map();
    for (const el of document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')) {
      const n = Number(el.textContent);
      if (Number.isFinite(n) && n > 0) map.set(n, el);
    }
    return map;
  }

  function activeLine() {
    const el = document.querySelector('.cm-lineNumbers .cm-activeLineGutter');
    const n = el ? Number(el.textContent) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  function claimAt(line) {
    if (line == null) return null;
    return claimsForOpenFile().find(c => line >= c.startLine && line <= c.endLine) || null;
  }

  function draw() {
    layer.textContent = '';
    const scroller = document.querySelector('.cm-scroller');
    const content = document.querySelector('.cm-content');
    if (!scroller || !content) {
      banner.hidden = true;
      return;
    }
    const view = scroller.getBoundingClientRect();
    const left = content.getBoundingClientRect().left;
    const lines = gutterLines();
    const visible = claimsForOpenFile();

    for (const claim of visible) {
      let top = Infinity;
      let bottom = -Infinity;
      for (let n = claim.startLine; n <= claim.endLine; n++) {
        const el = lines.get(n);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
      if (top === Infinity) continue;
      top = Math.max(top, view.top);
      bottom = Math.min(bottom, view.bottom);
      if (bottom <= top) continue;
      const band = document.createElement('div');
      band.className = 'olf-band' + (claim.state === 'paused' ? ' olf-paused' : '');
      Object.assign(band.style, { top: `${top}px`, left: `${left - 6}px`, width: `${view.right - left}px`, height: `${bottom - top}px` });
      const tag = document.createElement('span');
      tag.className = 'olf-tag';
      tag.textContent = claim.state === 'paused' ? 'Agent paused' : 'Agent editing';
      band.appendChild(tag);
      layer.appendChild(band);
    }

    const here = claimAt(activeLine()) || visible[0];
    if (!here) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    // Bottom right of the editor, where it covers the least text.
    Object.assign(banner.style, { top: `${Math.max(view.top + 8, view.bottom - banner.offsetHeight - 12)}px`, left: `${view.right - 380}px` });
    banner.textContent = '';
    const text = document.createElement('div');
    text.className = 'olf-banner-text';
    text.textContent = here.state === 'paused'
      ? `The agent stopped working on "${here.section}" while you edit.`
      : `The agent is working on "${here.section}": ${here.task}`;
    banner.appendChild(text);
    const meta = document.createElement('div');
    meta.className = 'olf-banner-meta';
    const edits = here.edits === 1 ? '1 edit so far' : `${here.edits || 0} edits so far`;
    meta.textContent = `${here.mode === 'suggest' ? 'Suggest mode: changes arrive as comments' : 'Direct mode: edits appear live'}, ${edits}`;
    banner.appendChild(meta);
    const panel = document.createElement('button');
    panel.className = 'olf-link';
    panel.textContent = 'Open the olf panel';
    panel.onclick = () => ask({ type: 'open-panel' });
    banner.appendChild(panel);
    if (here.state === 'paused') {
      const done = document.createElement('button');
      done.textContent = 'Done, let it continue';
      done.onclick = async () => {
        allowed.delete(here.id);
        await ask({ type: 'resume', project: projectId, claimId: here.id });
        void refresh();
      };
      banner.appendChild(done);
    }
  }

  function confirmEdit(claim) {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'olf-modal-backdrop';
      const box = document.createElement('div');
      box.className = 'olf-modal';
      const title = document.createElement('p');
      title.className = 'olf-modal-title';
      title.textContent = `The agent is editing "${claim.section}"`;
      const body = document.createElement('p');
      body.textContent = 'If you edit here now, the agent pauses until you press "Done, let it continue" (or reply "done" in its comment).';
      const wait = document.createElement('button');
      wait.textContent = 'Wait';
      const go = document.createElement('button');
      go.textContent = 'Edit anyway';
      go.className = 'olf-primary';
      const close = value => {
        backdrop.remove();
        resolve(value);
      };
      wait.onclick = () => close(false);
      go.onclick = () => close(true);
      backdrop.onclick = e => { if (e.target === backdrop) close(false); };
      const actions = document.createElement('div');
      actions.className = 'olf-modal-actions';
      actions.append(wait, go);
      box.append(title, body, actions);
      backdrop.appendChild(box);
      document.body.appendChild(backdrop);
      go.focus();
    });
  }

  const EDIT_KEYS = /^(.|Enter|Backspace|Delete|Tab)$/;
  let asking = false;

  document.addEventListener('keydown', async event => {
    if (!event.target?.closest?.('.cm-content')) return;
    if (event.ctrlKey || event.metaKey) {
      if (!/^[vx]$/i.test(event.key)) return; // allow copy, undo, save...
    } else if (!EDIT_KEYS.test(event.key)) {
      return;
    }
    const claim = claimAt(activeLine());
    if (!claim || claim.state === 'paused' || allowed.has(claim.id)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (asking) return;
    asking = true;
    const editor = event.target.closest('.cm-content');
    const editAnyway = await confirmEdit(claim);
    asking = false;
    // Give the editor its focus back at once, with the caret where it was.
    editor?.focus();
    if (editAnyway) {
      allowed.add(claim.id);
      await ask({ type: 'pause', project: projectId, claimId: claim.id });
      void refresh();
    }
  }, true);

  async function refresh() {
    const reply = await ask({ type: 'claims', project: projectId });
    bridgeUp = Boolean(reply?.ok);
    claims = bridgeUp ? reply.data.claims || [] : [];
    const live = new Set(claims.map(c => c.id));
    allowed = new Set([...allowed].filter(id => live.has(id) && claims.find(c => c.id === id)?.state === 'paused'));
    draw();
  }

  // Tell the extension which project this tab shows (for the side panel).
  ask({ type: 'project', project: projectId });

  // The side panel's "Show" button: open the section through Overleaf's own
  // file outline, which knows how to scroll the editor there.
  chrome.runtime.onMessage.addListener(message => {
    if (message.type !== 'jump') return;
    const wanted = String(message.section || '').trim().toLowerCase();
    const items = [...document.querySelectorAll('.outline-item-link, [class*="outline-item"] button')];
    const match = items.find(el => el.textContent.trim().toLowerCase() === wanted) || items.find(el => el.textContent.trim().toLowerCase().includes(wanted));
    if (match) match.click();
  });

  setInterval(refresh, 1500);
  document.addEventListener('scroll', draw, true);
  window.addEventListener('resize', draw);
  setInterval(draw, 400);
  void refresh();
})();
