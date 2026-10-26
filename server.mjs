// Thin localhost view over the Plate data folder. Reads/writes files on every request.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, readItems, writeItems, readWorkstreams, appendEvent, needsYou, today, createWorkstream, updateWorkstream, addManualItem, removeManualItem, BadRequest } from './lib/store.mjs';

const PORT = Number(process.env.PORT) || 4173;
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/state') {
      const t = today();
      const items = readItems().filter((i) => i.state !== 'gone').map((i) => ({ ...i, needsYou: needsYou(i, t) }));
      return json(res, 200, { dataDir: DATA_DIR, today: t, workstreams: readWorkstreams(), items });
    }
    if (url.pathname === '/api/move' && req.method === 'POST') {
      const { id, workstream } = JSON.parse(await readBody(req));
      const target = workstream || null;
      if (target && !readWorkstreams().some((w) => w.slug === target)) return json(res, 400, { error: 'unknown workstream' });
      const items = readItems();
      const item = items.find((i) => i.id === id);
      if (!item) return json(res, 404, { error: 'unknown item' });
      if (item.workstream !== target) {
        const from = item.workstream;
        item.workstream = target;
        item.updated = new Date().toISOString();
        writeItems(items);
        appendEvent({ source: item.source, workstream: target, type: 'item.moved', title: item.title, ref: item.id, from });
      }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/items/add-teams' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      return json(res, 200, { id: addManualItem({ source: 'teams', title: b.label, url: b.url, workstream: b.workstream }) });
    }
    if (url.pathname === '/api/items/add' && req.method === 'POST') {
      return json(res, 200, { id: addManualItem(JSON.parse(await readBody(req))) });
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
  } catch (e) { json(res, e instanceof BadRequest ? 400 : 500, { error: e instanceof BadRequest ? e.message : String(e) }); }
}).listen(PORT, '127.0.0.1', () => console.log(`plate on http://localhost:${PORT}  (data: ${DATA_DIR})`));
