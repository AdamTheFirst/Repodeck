// Local HTTP server: 127.0.0.1 only, Host/Origin checks, per-launch token on every API call.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('./api');
const state = require('./state');
const log = require('./log');

const UI_DIR = path.join(__dirname, '..', 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.json': 'application/json' };

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function createServer({ token, onClients }) {
  let port = 0;
  const clients = new Set();

  const allowedHost = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const allowedOrigin = (o) => !o || o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  const tokenOk = (t) => typeof t === 'string' && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }
  const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) return send(res, 421, 'Misdirected request');
      if (!allowedOrigin(req.headers.origin)) return send(res, 403, 'Forbidden origin');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        if (!tokenOk(req.headers['x-token'])) return sendJson(res, 401, { error: 'Invalid session token. Reload the window.' });
        if (!/^application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'JSON required' });
        const body = await readBody(req, 20 * 1024 * 1024);
        let msg;
        try { msg = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad JSON' }); }
        try {
          const result = await api.call(msg.method, msg.params);
          return sendJson(res, 200, { result });
        } catch (e) {
          if (!e.command) log.warn(`${msg.method} failed`, { error: e.message });
          return sendJson(res, e.status || 200, {
            error: e.message || String(e), kind: e.kind || null, command: e.command || null,
            stderr: e.stderr ? String(e.stderr).slice(0, 20_000) : null, code: e.code ?? null, hint: e.hint || null,
          });
        }
      }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!tokenOk(url.searchParams.get('token'))) return send(res, 401, 'Invalid token');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
        res.write('retry: 2000\n\n');
        const client = { res };
        clients.add(client);
        onClients(clients.size);
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
        req.on('close', () => { clearInterval(ping); clients.delete(client); onClients(clients.size); });
        return;
      }

      if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
      let rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const file = path.resolve(UI_DIR, '.' + rel);
      if (!file.startsWith(UI_DIR + path.sep)) return send(res, 403, 'Forbidden');
      let data;
      try { data = fs.readFileSync(file); } catch { return send(res, 404, 'Not found'); }
      if (rel === '/index.html') data = Buffer.from(data.toString('utf8').replace('__SESSION_TOKEN__', token));
      return send(res, 200, data, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    } catch (e) {
      log.error('HTTP handler error', { error: e.stack });
      try { sendJson(res, 500, { error: e.message }); } catch {}
    }
  });

  function broadcast(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) { try { c.res.write(payload); } catch {} }
  }

  for (const ev of ['repos', 'summary', 'board', 'trackers', 'notify', 'myprs', 'focus']) state.bus.on(ev, (d) => broadcast(ev, d));
  log.events.on('activity', (e) => broadcast('activity', e));

  async function listen(preferred) {
    for (let p = preferred; p < preferred + 20; p++) {
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(p, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
        port = p;
        return p;
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
      }
    }
    throw new Error(`No free port between ${preferred} and ${preferred + 19}`);
  }

  return { server, listen, broadcast, clients };
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (d) => { n += d.length; if (n > max) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = { createServer };
