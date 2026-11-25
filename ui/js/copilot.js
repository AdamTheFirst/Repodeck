// "Write with Copilot": shared by the commit box and the New pull request page.
// The server does the work (server/copilot.js); this part asks first, once, and explains a missing program.
import { h, modal, showError } from './dom.js';
import { rpc } from './api.js';
import { store, prefs } from './store.js';

export const copilotOn = () => !store.config || store.config.copilotButtons !== false;

/** Says once what is sent and to whom. False when the user backs out. */
async function agreed(what) {
  if (prefs.get('copilotTold', false)) return true;
  const who = store.config && store.config.currentAccount;
  const ok = await modal({
    title: 'Write this with GitHub Copilot?',
    body: h('div', { class: 'col' },
      h('div', null, `This sends ${what} to GitHub Copilot${who ? `, as ${who}` : ''}. Nothing is sent until you press a Copilot button, and Copilot gets that text only: it cannot read or change your files.`),
      h('div', { class: 'muted' }, 'It uses the GitHub Copilot CLI on this computer and counts against that account’s Copilot allowance. The buttons can be hidden in Settings → Behaviour. This is not asked again.')),
    actions: [{ label: 'Cancel', value: false }, { label: 'Continue', cls: 'primary', default: true, value: true }],
  });
  if (ok) prefs.set('copilotTold', true);
  return !!ok;
}

/**
 * One Copilot request. Returns the server's answer, or null when the user backed out or it failed
 * (the failure has been shown by then). onStart runs once the user has agreed and the request goes out.
 */
export async function askCopilot(method, params, what, onStart) {
  if (!(await agreed(what))) return null;
  if (onStart) onStart(); // only now is something on its way
  try {
    return await rpc(method, params);
  } catch (e) {
    if (e.kind === 'copilot-missing') {
      const v = await modal({
        title: 'GitHub Copilot CLI is not installed',
        body: h('div', { class: 'col' },
          h('div', null, 'Repodeck writes with Copilot through the GitHub Copilot CLI, which is not on this computer yet.'),
          h('div', { class: 'muted' }, 'Install it, run it once to sign in, then press the button again. The account also needs a Copilot plan.')),
        actions: [{ label: 'How to install', value: 'open' }, { label: 'Close', cls: 'primary', default: true, value: null }],
      });
      if (v === 'open' && e.hint) rpc('open.url', { url: e.hint }).catch(() => {});
      return null;
    }
    showError(e, 'Copilot could not write this');
    return null;
  }
}
