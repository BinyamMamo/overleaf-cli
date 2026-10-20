const state = document.getElementById('state');

function check() {
  chrome.runtime.sendMessage({ type: 'health' }, reply => {
    if (reply?.ok) {
      const n = reply.data.projects.length;
      state.textContent = n ? `Connected. The agent is live on ${n} project${n === 1 ? '' : 's'}.` : 'Connected. No agent is editing right now.';
    } else if (reply?.reason === 'not-paired') {
      state.textContent = 'Not paired yet.';
    } else if (reply?.reason === 'bad-token') {
      state.textContent = 'The pairing code is wrong or was replaced. Pair again.';
    } else {
      state.textContent = 'Paired. No agent is running (start your AI client with olf).';
    }
  });
}

document.getElementById('save').onclick = () => {
  const token = document.getElementById('token').value;
  if (!token.trim()) return;
  chrome.runtime.sendMessage({ type: 'set-token', token }, () => {
    document.getElementById('token').value = '';
    check();
  });
};

check();
