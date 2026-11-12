// Quick-open palette: jump to a repository (Ctrl+P), or run a command by typing ">".
import { h, mount, icon } from './dom.js';
import { store } from './store.js';
import { navigate } from './router.js';

const COMMANDS = [
  ['Actions board', '#/board'], ['Feature branches', '#/feature'], ['All repositories: overview', '#/multi/overview'],
  ['Bulk operations', '#/multi/bulk'], ['Branch cleanup', '#/multi/cleanup'], ['Search commits in all repositories', '#/multi/search'],
  ['Activity log', '#/activity'], ['Settings', '#/settings'], ['Diagnostics', '#/settings/diagnostics'],
];

export function openPalette() {
  const root = document.getElementById('overlay-root');
  if (root.querySelector('.palette')) return;
  let focus = 0;
  let items = [];
  const input = h('input', { placeholder: 'Type a repository name, or > for commands', spellcheck: 'false' });
  const list = h('div', { class: 'items' });
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'modal palette' }, input, list));
  const close = () => back.remove();
  const go = (it) => { close(); it.go(); };
  function score(text, q) {
    text = text.toLowerCase();
    if (!q) return 1;
    const i = text.indexOf(q);
    if (i >= 0) return 100 - i;
    let ti = 0;
    for (const ch of q) { ti = text.indexOf(ch, ti); if (ti < 0) return 0; ti++; }
    return 10;
  }
  function render() {
    const q = input.value.trim().toLowerCase();
    if (q.startsWith('>')) {
      const qq = q.slice(1).trim();
      items = COMMANDS.map(([label, hash]) => ({ label, sub: '', go: () => navigate(hash), s: score(label, qq) })).filter((x) => x.s > 0);
    } else {
      items = store.repos.map((r) => ({
        label: r.label, sub: r.summary ? r.summary.branch || '' : '', dirty: r.summary && r.summary.dirty,
        go: () => navigate(`#/repo/${r.id}/${store.tab || 'changes'}`), s: score(`${r.label} ${r.rootName}`, q),
      })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 50);
    }
    focus = Math.min(focus, Math.max(0, items.length - 1));
    mount(list, items.map((it, i) => h('div', { class: `item ${i === focus ? 'focus' : ''}`, onclick: () => go(it), onmousemove: () => { if (focus !== i) { focus = i; render(); } } },
      icon(input.value.startsWith('>') ? 'bolt' : 'folder', 'sm'), h('span', { class: 'grow ellipsis' }, it.label),
      it.dirty ? h('span', { class: 'badge dirty' }, it.dirty) : null, h('span', { class: 'muted' }, it.sub))));
    const f = list.querySelector('.focus'); if (f) f.scrollIntoView({ block: 'nearest' });
  }
  input.addEventListener('input', () => { focus = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focus = Math.min(items.length - 1, focus + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focus = Math.max(0, focus - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[focus]) go(items[focus]); }
  });
  root.append(back);
  render();
  input.focus();
}
