// Thin localhost view over the Plate data folder. Reads/writes files on every request.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketContext } from './lib/ghcontext.mjs';
import { withLock, collectNow, startSchedule, status } from './lib/schedule.mjs';
import { startReview, runs } from './lib/devinrun.mjs';
import { DATA_DIR, readItems, writeItems, readWorkstreams, readEvents, readSources, appendEvent, needsYou, today, createWorkstream, updateWorkstream, addManualItem, removeManualItem, addGithubItem, findByUrl, teamsDeepLink, setTodo, addTodo, BadRequest } from './lib/store.mjs';

const PORT = Number(process.env.PORT) || 4173;
const repo = path.dirname(fileURLToPath(import.meta.url));
// newest CHANGELOG entry this machine hasn't applied (`.plate-changelog-seen`), so the header can say setup is pending
const setupPending = () => {
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  const latest = Number(read('CHANGELOG.md').match(/^## (\d+)/m)?.[1] || 0), seen = Number(read('.plate-changelog-seen').trim() || 0);
  return latest > seen ? { latest, seen } : null;
};
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // writes are serialized with the scheduled collectors (lib/schedule.mjs)
    await (req.method === 'POST' ? withLock(() => handle(req, res, url)) : handle(req, res, url));
  } catch (e) { json(res, e instanceof BadRequest ? 400 : 500, { error: e instanceof BadRequest ? e.message : String(e) }); }
}).listen(PORT, '127.0.0.1', () => { console.log(`plate on http://localhost:${PORT}  (data: ${DATA_DIR})`); startSchedule(); });

async function handle(req, res, url) {
  {
    if (url.pathname === '/api/state') {
      const t = today();
      const items = readItems().filter((i) => i.state !== 'gone').map((i) => ({ ...i, needsYou: needsYou(i, t) }));
      // events: today's (local date), for the mindmap's Today mode; people: login -> e-mail for Teams chats
      const events = readEvents().filter((e) => new Date(e.ts).toLocaleDateString('en-CA') === t), src = readSources();
      const meeting = src.meeting_quickadd ? { choice: src.meeting_quickadd, vault: src.obsidian_vault || null, values: src.meeting_values } : null;
      return json(res, 200, { dataDir: DATA_DIR, today: t, workstreams: readWorkstreams(), items, events, people: src.people, meeting, setup: setupPending(), collect: status, runs });
    }
    if (url.pathname === '/api/collect' && req.method === 'POST') {
      // runs outside the request's lock: each collector takes the lock itself
      setTimeout(() => collectNow(), 0);
      return json(res, 202, { ok: true });
    }
    if (url.pathname === '/api/move' && req.method === 'POST') {
      // body: {id, workstream} or {ids: [...], workstream}; replies with each item's previous workstream (for undo)
      const { id, ids, workstream } = JSON.parse(await readBody(req));
      const target = workstream || null;
      if (target && !readWorkstreams().some((w) => w.slug === target)) return json(res, 400, { error: 'unknown workstream' });
      const items = readItems();
      const sel = (ids || [id]).map((one) => items.find((i) => i.id === one));
      if (sel.some((i) => !i)) return json(res, 404, { error: 'unknown item' });
      const moved = [];
      for (const item of sel) {
        if (item.workstream === target) continue;
        const from = item.workstream;
        item.workstream = target;
        if (target) delete item.dismissed; // classifying it undoes a dismiss
        item.updated = new Date().toISOString();
        moved.push({ id: item.id, from });
        appendEvent({ source: item.source, workstream: target, type: 'item.moved', title: item.title, ref: item.id, from });
      }
      if (moved.length) writeItems(items);
      return json(res, 200, { ok: true, moved });
    }
    if (url.pathname === '/api/dismiss' && req.method === 'POST') {
      // body: {ids, dismissed}; hides items from the Inbox (any source; collectors keep the flag) or brings them back
      const { ids, dismissed = true } = JSON.parse(await readBody(req));
      const items = readItems(), changed = [];
      for (const item of items) {
        if (!ids.includes(item.id) || !!item.dismissed === !!dismissed) continue;
        if (dismissed) item.dismissed = true; else delete item.dismissed;
        item.updated = new Date().toISOString(); changed.push(item.id);
        appendEvent({ source: item.source, workstream: item.workstream, type: dismissed ? 'item.dismissed' : 'item.undismissed', title: item.title, ref: item.id });
      }
      if (changed.length) writeItems(items);
      return json(res, 200, { ok: true, changed });
    }
    if (url.pathname === '/api/devin/review' && req.method === 'POST') return json(res, 200, startReview(JSON.parse(await readBody(req)).url));
    if (url.pathname === '/api/gh/context') return json(res, 200, await ticketContext(url.searchParams.get('url')));
    if (url.pathname === '/api/items/add-github' && req.method === 'POST') {
      return json(res, 200, await addGithubItem(JSON.parse(await readBody(req))));
    }
    if (url.pathname === '/api/items/add-teams' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      return json(res, 200, { id: addManualItem({ source: 'teams', title: b.label, url: b.url, workstream: b.workstream }) });
    }
    if (url.pathname === '/api/items/add' && req.method === 'POST') {
      const { extra, ...b } = JSON.parse(await readBody(req)); // extra fields are server-only (ghref)
      const dup = b.url && findByUrl(b.source === 'teams' ? teamsDeepLink(String(b.url).trim()) : String(b.url).trim());
      if (dup) return json(res, 200, { id: dup.id, existing: true, workstream: dup.workstream });
      return json(res, 200, { id: addManualItem(b) });
    }
    if (url.pathname === '/api/ws/todo' && req.method === 'POST') {
      const { slug, n, text, done } = JSON.parse(await readBody(req));
      setTodo(slug, n, text, !!done);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/ws/todo/add' && req.method === 'POST') {
      const { slug, text } = JSON.parse(await readBody(req));
      addTodo(slug, text);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/items/remove' && req.method === 'POST') {
      removeManualItem(JSON.parse(await readBody(req)).id);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/ws/create' && req.method === 'POST') {
      const { name, parent } = JSON.parse(await readBody(req));
      return json(res, 200, { slug: createWorkstream(name, parent) });
    }
    if (url.pathname === '/api/ws/update' && req.method === 'POST') {
      const { slug, ...patch } = JSON.parse(await readBody(req));
      updateWorkstream(slug, patch);
      return json(res, 200, { ok: true });
    }
    const file = path.join(pub, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(pub) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  }
}
