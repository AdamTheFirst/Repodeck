// Talks to the local server. Every call carries the per-launch session token.
const token = document.querySelector('meta[name="session-token"]').content;

export class ApiError extends Error {
  constructor(data) {
    super(data.error || 'Request failed');
    this.kind = data.kind; this.command = data.command; this.stderr = data.stderr; this.code = data.code; this.hint = data.hint;
  }
}

const pending = new Set();
const listeners = new Set();
export function onPending(fn) { listeners.add(fn); }
function notifyPending() { for (const l of listeners) l(pending.size); }

export async function rpc(method, params = {}) {
  const key = { method };
  pending.add(key); notifyPending();
  try {
    let res;
    try {
      res = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token }, body: JSON.stringify({ method, params }) });
    } catch {
      throw new ApiError({ error: 'Cannot reach the git-helper server. It may have stopped; start git-helper again.' });
    }
    if (res.status === 401 && !sessionStorage.getItem('gh.reloaded')) {
      // The server restarted and issued a new session token: reload once to pick it up.
      sessionStorage.setItem('gh.reloaded', '1');
      location.reload();
      await new Promise(() => {});
    }
    if (res.ok) sessionStorage.removeItem('gh.reloaded');
    let data;
    try { data = await res.json(); } catch { throw new ApiError({ error: `Server returned ${res.status}` }); }
    if (data.error) throw new ApiError(data);
    return data.result;
  } finally { pending.delete(key); notifyPending(); }
}

const handlers = {};
export function on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); }
let es = null;
let connected = false;
const connListeners = new Set();
export function onConnection(fn) { connListeners.add(fn); }
export function connect() {
  es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  for (const t of ['repos', 'summary', 'board', 'trackers', 'notify', 'activity', 'myprs', 'focus']) {
    es.addEventListener(t, (e) => { const d = JSON.parse(e.data); for (const fn of handlers[t] || []) { try { fn(d); } catch (err) { console.error(err); } } });
  }
  es.onopen = () => { connected = true; for (const f of connListeners) f(true); };
  es.onerror = () => {
    if (connected) { connected = false; for (const f of connListeners) f(false); }
    // If the server came back with a new token, the event stream gets 401 forever; a ping detects that and reloads.
    setTimeout(() => { if (!connected) rpc('app.ping').catch(() => {}); }, 3000);
  };
}
