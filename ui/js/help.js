// Keyboard shortcut reference (press ? anywhere).
import { h, modal } from './dom.js';

const GROUPS = [
  ['Anywhere', [
    ['Ctrl+P', 'Go to a repository (type > for commands)'], ['Alt+1 … Alt+7', 'Changes, Graph, Branches, Stashes, Pull requests, Issues, Actions'],
    ['F5 or Ctrl+R', 'Refresh'], ['Ctrl+Shift+B', 'Actions board'], ['?', 'This list'], ['Esc', 'Close a dialog or menu'],
  ]],
  ['Changes', [
    ['Ctrl+Enter', 'Commit (in the message box)'], ['↑ / ↓', 'Select a file'], ['S', 'Stage or unstage the selected file'], ['Delete', 'Discard the selected file (asks first)'], ['E', 'Open the selected file in your editor'],
    ['Click a line number', 'Select a line; Shift+click for a range, Ctrl+click to add'],
  ]],
  ['Graph', [['↑ / ↓', 'Move between commits'], ['Ctrl+click', 'Compare with a second commit'], ['Right-click', 'Commit, branch and tag actions']]],
];

export function showShortcuts() {
  return modal({
    title: 'Keyboard shortcuts', wide: true,
    body: h('div', { class: 'shortcut-grid' }, GROUPS.map(([title, rows]) => h('div', null, h('h3', { style: { margin: '0 0 8px' } }, title),
      rows.map(([k, d]) => h('div', { class: 'shortcut-row' }, h('span', { class: 'kbd' }, k), h('span', null, d)))))),
    actions: [{ label: 'Close', cls: 'primary', default: true, value: null }],
  });
}
