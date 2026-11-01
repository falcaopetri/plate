// Thin localhost view over the Plate data folder. Reads/writes files on every request.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketContext } from './lib/ghcontext.mjs';
import { withLock, collectNow, startSchedule, status, busy } from './lib/schedule.mjs';
import { lookupByEmail } from './lib/directory.mjs';
import { transcript } from './lib/devintranscript.mjs';
import { startReview, startClose, startSetup, runs } from './lib/devinrun.mjs';
import { log, tail } from './lib/log.mjs';
import { readRequests, addRequest, toggleRequest, DATA_DIR, readItems, writeItems, readWorkstreams, readTop3, readTop3Prev, setTop3, readEvents, eventDay, eventsBetween, activitySummary, readSources, appendEvent, needsYou, today, readSettings, patchSources, createWorkstream, updateWorkstream, addManualItem, removeManualItem, addGithubItem, findByUrl, teamsDeepLink, setTodo, addTodo, patchItem, applyRules, readContacts, createPerson, patchPerson, saveAttachment, createTask, tasknotesDir, BadRequest } from './lib/store.mjs';

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
  const url = new URL(req.url, 'http://localhost'), t0 = Date.now();
  // one line per write, per error and per slow read; the 20s /api/state polls would drown the rest
  res.on('finish', () => {
    const ms = Date.now() - t0, quiet = req.method === 'GET' && res.statusCode < 400 && ms < 1000;
    if (!quiet && !(url.pathname === '/api/log')) (res.statusCode >= 400 ? log.warn : log.info)(`${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
  });
  try {
    // writes are serialized with the scheduled collectors (lib/schedule.mjs)
    await (req.method === 'POST' ? withLock(() => handle(req, res, url), `POST ${url.pathname}`) : handle(req, res, url));
  } catch (e) {
    if (!(e instanceof BadRequest)) log.error(`${req.method} ${url.pathname}: ${e.stack || e}`);
    json(res, e instanceof BadRequest ? 400 : 500, { error: e instanceof BadRequest ? e.message : String(e) });
  }
}).listen(PORT, '127.0.0.1', () => { log.info(`plate on http://localhost:${PORT}  (data: ${DATA_DIR})`); startSchedule(); });

async function handle(req, res, url) {
  {
    if (url.pathname === '/api/state') {
      const t = today();
      const items = readItems().filter((i) => i.state !== 'gone').map((i) => ({ ...i, needsYou: needsYou(i, t) }));
      // events: today's (local date), for the mindmap's Today mode; people: login -> e-mail for Teams chats
      const log = readEvents(), events = eventsBetween(log, t, t), src = readSources();
      const meeting = src.meeting_quickadd ? { choice: src.meeting_quickadd, vault: src.obsidian_vault || null, values: src.meeting_values } : null;
      const workstreams = readWorkstreams();
      return json(res, 200, { dataDir: DATA_DIR, today: t, workstreams, canTask: tasknotesDir() !== null, contacts: readContacts(workstreams.flatMap((w) => w.people)), items, events, top3: readTop3(t), top3Prev: readTop3Prev(t), activity: activitySummary(log), staleDays: Number(src.stale_days) || 3, doneDays: Number(src.done_days) || 7, people: src.people, meeting, setup: setupPending(), setupAgent: src.setup_agent === 'devin' ? 'devin' : 'claude', collect: status, runs, busy, devinModel: src.devin_review_model || null });
    }
    if (url.pathname === '/api/events') {
      // one local day (`day`) or a window (`from`..`to`, inclusive) of the event log, for Today mode's replay + the days that have any
      const all = readEvents(), q = url.searchParams, day = q.get('day') || today(), from = q.get('from') || day, to = q.get('to') || day;
      if (![day, from, to].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) return json(res, 400, { error: 'day, from and to must be YYYY-MM-DD' });
      const days = {};
      for (const e of all) days[eventDay(e)] = (days[eventDay(e)] || 0) + 1;
      return json(res, 200, { day, from, to, events: eventsBetween(all, from, to), days });
    }
    if (url.pathname === '/api/collect' && req.method === 'POST') {
      // runs outside the request's lock: each collector takes the lock itself
      // body (optional): {only: ['devin', …]} for a partial sync (the r+d / r+g shortcuts); none = everything enabled
      const raw = await readBody(req), only = raw ? JSON.parse(raw).only : null;
      setTimeout(async () => { await collectNow(Array.isArray(only) ? only : undefined); await withLock(() => applyRules(), 'rules'); }, 0);
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
    if (url.pathname === '/api/top3' && req.method === 'POST') {
      // body: {type: 'ws' | 'item', ref, on}; pins or unpins for today (max 3), answers today's pins
      // `done: true|false` instead of `on` marks the pin as met (or reopens it) and keeps its slot
      const { type, ref, on = true, done } = JSON.parse(await readBody(req));
      return json(res, 200, { top3: setTop3(today(), type, ref, !!on, done === undefined ? undefined : !!done) });
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
    if (url.pathname === '/api/item/update' && req.method === 'POST') {
      const { id, ...patch } = JSON.parse(await readBody(req)); // alias / label / snoozedUntil on any item
      return json(res, 200, { ok: true, item: patchItem(id, patch) });
    }
    if (url.pathname === '/api/rules/apply' && req.method === 'POST') return json(res, 200, { ok: true, routed: applyRules() });
    if (url.pathname === '/api/devin/review' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); return json(res, 200, startReview(b.url, b.model)); }
    if (url.pathname === '/api/devin/close' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); return json(res, 200, startClose(b.url, b.model)); }
    if (url.pathname === '/api/setup/apply' && req.method === 'POST') return json(res, 200, startSetup(setupPending()));
    if (url.pathname === '/api/requests' && req.method === 'POST') return json(res, 200, { ok: true, request: addRequest(JSON.parse(await readBody(req))) });
    if (url.pathname === '/api/requests/done' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); toggleRequest(b.index, !!b.done); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/requests') return json(res, 200, { requests: readRequests() });
    if (url.pathname === '/api/settings' && req.method === 'POST') { const patch = JSON.parse(await readBody(req)); log.info(`settings: ${Object.keys(patch).join(', ')}`); return json(res, 200, patchSources(patch)); }
    if (url.pathname === '/api/settings') return json(res, 200, readSettings());
    if (url.pathname === '/api/log') return json(res, 200, { lines: tail(Number(url.searchParams.get('n')) || 200) });
    if (url.pathname === '/api/devin/transcript') return json(res, 200, await transcript(url.searchParams.get('id')));
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
    if (url.pathname === '/api/tasks/create' && req.method === 'POST') {
      const file = createTask(JSON.parse(await readBody(req)));
      setTimeout(() => collectNow(['tasknotes']).catch(() => {}), 0); // the task shows up once the collector has read it
      return json(res, 200, { ok: true, file });
    }
    if (url.pathname === '/api/people/create' && req.method === 'POST') {
      // by e-mail: the directory (dscl) fills name, role, department, company and photo; whatever it can't, the form values cover
      const b = JSON.parse(await readBody(req));
      const { dir, fields } = await fromDirectory(b.email, b.name);
      const { photoBuf, name: dirName, ...props } = fields;
      const name = createPerson({ ...props, role: b.role || props.role, email: b.email, teams: b.teams, name: b.name || dirName });
      if (photoBuf) patchPerson(name, { photo: `[[${saveAttachment(name, photoBuf)}]]` });
      if (b.workstream) { const w = readWorkstreams().find((x) => x.slug === b.workstream); if (w) updateWorkstream(w.slug, { people: [...w.people, name] }); }
      return json(res, 200, { ok: true, name, directory: dir });
    }
    if (url.pathname === '/api/people/sync' && req.method === 'POST') {
      // re-read one person from the directory into their note's properties (by the e-mail already on the note)
      const { name } = JSON.parse(await readBody(req)), c = readContacts([name])[name];
      if (!c?.note) throw new BadRequest('no note for this person');
      if (!c.email) throw new BadRequest('add an email property to the note first');
      const { dir, fields } = await fromDirectory(c.email, name);
      if (dir !== 'ok') throw new BadRequest(dir);
      const { photoBuf, name: _n, ...props } = fields;
      if (photoBuf) props.photo = `[[${saveAttachment(name, photoBuf)}]]`;
      return json(res, 200, { ok: true, updated: patchPerson(name, props) });
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
      // new anchors claim matching Inbox items now, and a `repo:` anchor starts pulling that repo's open issues/PRs
      if ('github' in patch) setTimeout(() => collectNow(['github']).then(() => withLock(() => applyRules(), 'rules')).catch(() => {}), 0);
      return json(res, 200, { ok: true, routed: 'github' in patch ? applyRules() : 0 });
    }
    const file = path.join(pub, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(pub) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  }
}

// directory fields for an e-mail: dir = 'ok' | why it is not available (never throws, so creating a person works without it)
async function fromDirectory(email, name) {
  if (!email) return { dir: 'no email given', fields: {} };
  try {
    const d = await lookupByEmail(email);
    if (!d) return { dir: 'not found in the directory', fields: {} };
    return { dir: 'ok', fields: { name: d.name, role: d.role, department: d.department, company: d.company, directory_synced: today(), photoBuf: d.photo } };
  } catch (e) { return { dir: e.message, fields: {} }; }
}
