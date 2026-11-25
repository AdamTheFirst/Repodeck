// Activity log: every git/gh command the app ran, with timing and output for failures.
import { h, mount, btn, ago, copyText } from '../dom.js';
import { rpc } from '../api.js';
import { store, subscribe } from '../store.js';

export function render(main) {
  let entries = [];
  let onlyFailed = false;
  let repo = '';
  let text = '';
  let loaded = false;
  const page = h('div', { class: 'page' });
  mount(main, page);
  // Made once: a new box on every keystroke lost the cursor after the first letter.
  const filterIn = h('input', { type: 'search', placeholder: 'Filter commands', style: { width: '260px' }, oninput: (e) => { text = e.target.value; draw(); } });
  function draw() {
    const typing = document.activeElement === filterIn;
    const list = entries.filter((e) => (!onlyFailed || !e.ok) && (!repo || e.repo === repo) && (!text || e.command.toLowerCase().includes(text.toLowerCase()))).slice().reverse();
    const repos = [...new Set(entries.map((e) => e.repo).filter(Boolean))].sort();
    mount(page,
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Activity'), h('div', { class: 'muted' }, 'Every git and GitHub CLI command Repodeck ran, newest first. Background status checks are not listed.'))),
      h('div', { class: 'row wrap', style: { marginBottom: '12px' } },
        filterIn,
        h('select', { onchange: (e) => { repo = e.target.value; draw(); } }, h('option', { value: '' }, 'All repositories'), repos.map((r) => h('option', { value: r, selected: r === repo }, r))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: onlyFailed, onchange: (e) => { onlyFailed = e.target.checked; draw(); } }), 'Failures only'),
        h('span', { class: 'spacer' }), loaded ? h('span', { class: 'faint' }, list.length === entries.length ? `${list.length} commands` : `${list.length} of ${entries.length} commands`) : null,
        btn('Copy as text', () => copyText(list.map((e) => `${new Date(e.time).toISOString()} ${e.ok ? 'OK ' : 'ERR'} ${e.repo ? `[${e.repo}] ` : ''}${e.command} (${e.ms} ms)${e.error ? `\n    ${e.error.replace(/\n/g, '\n    ')}` : ''}`).join('\n')), { cls: 'small', iconName: 'copy' })),
      list.length ? h('table', { class: 'grid panel' }, h('tr', null, h('th', null, 'When'), h('th', null, 'Repository'), h('th', null, 'Command'), h('th', null, 'Time'), h('th', null, 'Result')),
        list.slice(0, 800).map((e) => h('tr', null,
          h('td', { class: 'muted', style: { whiteSpace: 'nowrap' }, title: new Date(e.time).toLocaleString() }, ago(e.time)),
          h('td', { class: 'ellipsis', style: { maxWidth: '220px' } }, e.repo || ''),
          h('td', { class: 'mono wrapcell', style: { fontSize: '11px', wordBreak: 'break-all' } }, e.command, e.error ? h('div', { class: 'errbox', style: { marginTop: '4px' } }, e.error) : e.output ? h('div', { class: 'faint', style: { whiteSpace: 'pre-wrap', marginTop: '4px' } }, e.output.slice(0, 1500)) : null),
          h('td', { class: 'muted' }, `${e.ms} ms`),
          h('td', null, h('span', { class: `badge ${e.ok ? 'ok' : 'bad'}` }, e.ok ? 'ok' : `failed${e.code != null ? ` (${e.code})` : ''}`)))))
        : !loaded ? h('div', { class: 'skeleton' }, 'Loading…')
          : h('div', { class: 'empty' }, entries.length ? h('h3', null, 'No commands match') : h('h3', null, 'No commands yet'), h('div', null, entries.length ? 'Nothing fits the filter above.' : 'Fetch, commit or push something and it is listed here.')));
    if (typing) filterIn.focus();
  }
  rpc('activity.list', { limit: 2000 }).then((l) => { entries = l; loaded = true; draw(); }, (e) => mount(page, h('div', { class: 'errbox' }, e.message)));
  const un = subscribe('activity', (e) => { entries.push(e); if (entries.length > 2000) entries.shift(); if (!document.activeElement || !/^(INPUT|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.type === 'checkbox') draw(); });
  draw();
  void store;
  return () => un();
}
