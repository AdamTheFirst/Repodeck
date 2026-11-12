// Hash routing: #/repo/<id>/<tab>, #/board, #/feature, #/multi, #/activity, #/settings
const listeners = new Set();
export function onRoute(fn) { listeners.add(fn); }
export function navigate(hash) {
  if (location.hash === hash) fire(); else location.hash = hash;
}
export function parse() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return parts;
}
function fire() { const p = parse(); for (const fn of listeners) fn(p); }
window.addEventListener('hashchange', fire);
export function start() { fire(); }
