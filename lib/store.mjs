// File-backed store. The data dir is the source of truth; nothing is cached.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Data dir resolution: env var, then a gitignored local override file, then a
// repo-relative default. No personal/absolute paths live in tracked code.
const readLocalDir = () => {
  try { return fs.readFileSync('.plate-data-dir', 'utf8').trim() || null; } catch { return null; }
};
export const DATA_DIR = process.env.PLATE_DATA_DIR || readLocalDir() || path.resolve('data');
const itemsFile = () => path.join(DATA_DIR, 'items.jsonl');
const eventsFile = () => path.join(DATA_DIR, 'events.jsonl');

const readJsonl = (f) => fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];

export const readItems = () => readJsonl(itemsFile());

export function writeItems(items) {
  const tmp = itemsFile() + '.tmp';
  fs.writeFileSync(tmp, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
  fs.renameSync(tmp, itemsFile());
}

export function appendEvent(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), source: null, workstream: null, type: null, title: null, ref: null, ...ev });
  fs.appendFileSync(eventsFile(), line + '\n');
}

export const readEvents = () => readJsonl(eventsFile());
export const eventDay = (e) => new Date(e.ts).toLocaleDateString('en-CA'); // local calendar day, YYYY-MM-DD
export const eventsBetween = (all, from, to) => all.filter((e) => { const d = eventDay(e); return d >= from && d <= to; });
// last event ts per workstream, and when the log starts: the UI needs both to tell "idle for N days" from "not recorded yet"
export function activitySummary(all) {
  const last = {};
  let since = null;
  for (const e of all) {
    if (!since || e.ts < since) since = e.ts;
    if (e.workstream && (!last[e.workstream] || e.ts > last[e.workstream])) last[e.workstream] = e.ts;
  }
  return { last, since };
}

// ---------- today's top 3: pinned items/workstreams, one line per day in focus.jsonl (the last line of a day wins) ----------
export const TOP_N = 3;
const focusFile = () => path.join(DATA_DIR, 'focus.jsonl');
export function readTop3(day) {
  const last = readJsonl(focusFile()).filter((l) => l.day === day).pop();
  return last ? last.pins : [];
}
// the most recent earlier day that ended with pins (a weekend or a day off is skipped), so the UI can offer to carry them over
export function readTop3Prev(day) {
  const byDay = new Map();
  for (const l of readJsonl(focusFile())) if (l.day < day) byDay.set(l.day, l.pins); // last line of a day wins
  const d = [...byDay.keys()].filter((k) => byDay.get(k).length).sort().pop();
  return d ? { day: d, pins: byDay.get(d) } : null;
}
// pins: [{type: 'ws' | 'item', ref: slug | item id}]; on=true appends (max TOP_N), on=false removes
export function setTop3(day, type, ref, on, done) {
  if (type !== 'ws' && type !== 'item') throw new BadRequest('type must be ws or item');
  if (type === 'ws' ? !readWorkstreams().some((w) => w.slug === ref) : !readItems().some((i) => i.id === ref)) throw new BadRequest(`unknown ${type}: ${ref}`);
  const cur = readTop3(day), pins = cur.filter((p) => !(p.type === type && p.ref === ref));
  if (done !== undefined) { // "I did this one": mark a pin met (or reopen it) without losing its slot
    const at = cur.findIndex((p) => p.type === type && p.ref === ref);
    if (at < 0) throw new BadRequest('not pinned today');
    const next = cur.map((p, n) => n === at ? (done ? { ...p, done: true } : { type: p.type, ref: p.ref }) : p);
    fs.appendFileSync(focusFile(), JSON.stringify({ day, ts: new Date().toISOString(), pins: next }) + '\n');
    return next;
  }
  if (on && pins.length < cur.length) return cur; // already pinned: keep its slot
  if (on) { if (pins.length >= TOP_N) throw new BadRequest(`top ${TOP_N} is full: unpin one first`); pins.push({ type, ref }); }
  fs.appendFileSync(focusFile(), JSON.stringify({ day, ts: new Date().toISOString(), pins }) + '\n');
  return pins;
}

// ---------- doing now: the short-memory slots (what I'm working on right now). Unlike the top 3 it isn't per day: it stays until
// the thing is finished or dropped, and it has a size limit (`doing_limit`) so new things can't pile up without closing old ones ----------
export const doingLimit = () => Math.max(1, Math.min(9, Math.floor(Number(readSources().doing_limit)) || 4));
const doingFile = () => path.join(DATA_DIR, 'doing.json');
export function readDoing() {
  try { const l = JSON.parse(fs.readFileSync(doingFile(), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; }
}
// on=true appends (stops at the limit), on=false removes; `note` = a one-line "where I stopped" kept on the slot
export function setDoing(type, ref, on, note) {
  if (type !== 'ws' && type !== 'item') throw new BadRequest('type must be ws or item');
  const cur = readDoing(), at = cur.findIndex((p) => p.type === type && p.ref === ref);
  if (note !== undefined) {
    if (at < 0) throw new BadRequest('not in focus now');
    cur[at] = { ...cur[at], note: String(note).trim().slice(0, 200) || undefined };
  } else if (on) {
    if (at >= 0) return cur;
    if (type === 'ws' ? !readWorkstreams().some((w) => w.slug === ref) : !readItems().some((i) => i.id === ref)) throw new BadRequest(`unknown ${type}: ${ref}`);
    if (cur.length >= doingLimit()) throw new BadRequest(`focus now is full (${doingLimit()}): finish or drop one first`);
    cur.push({ type, ref, since: new Date().toISOString() });
  } else if (at >= 0) cur.splice(at, 1);
  writeFileAtomic(doingFile(), JSON.stringify(cur, null, 1) + '\n');
  return cur;
}

// Minimal frontmatter parser: `key: scalar`, `key: [a, b]`, or block lists (`- a`).
export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    const li = line.match(/^\s+-\s+(.*)$/);
    if (li && listKey) {
      if (!Array.isArray(meta[listKey])) meta[listKey] = [];
      const kv = li[1].match(/^([\w-]+):\s*(.*)$/);
      meta[listKey].push(kv ? { [kv[1]]: unquote(kv[2]) } : unquote(li[1]));
      continue;
    }
    const cont = line.match(/^\s+([\w-]+):\s*(.*)$/); // `    url: …` continues the last mapping item
    if (cont && listKey && Array.isArray(meta[listKey]) && typeof meta[listKey].at(-1) === 'object') {
      meta[listKey].at(-1)[cont[1]] = unquote(cont[2]);
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    listKey = null;
    if (v === '') { meta[k] = ''; listKey = k; }
    else if (v.startsWith('[')) meta[k] = v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
    else meta[k] = unquote(v);
  }
  return { meta, body: m[2].trim() };
}
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const unquote = (s) => s.replace(/^["']|["']$/g, '').replace(/\\"/g, '"');

const TODO = /^(\s*[-*] \[)([ xX])(\] )(.*)$/;
// ---------- a workstream backed by a vault note: `note: "[[Name]]"` in workstreams/<slug>.md ----------
// The note stays where it is (nothing is duplicated): the workstream's text and to-dos are the note's, and ticking or adding a
// to-do writes into the note. Notes are found by file name anywhere in the vault (two levels above the data folder).
export const vaultRoot = () => path.resolve(DATA_DIR, '../..');
export const noteName = (raw) => String(raw || '').trim().replace(/^\[\[|\]\]$/g, '').replace(/[|#].*$/, '').replace(/\.md$/i, '').trim();
let noteIdx = { at: 0, map: new Map() };
function noteIndex(maxAge) {
  if (Date.now() - noteIdx.at < maxAge) return noteIdx.map;
  const map = new Map(), root = vaultRoot();
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (e.isDirectory()) { if (depth < 8) walk(path.join(dir, e.name), depth + 1); }
      else if (e.name.endsWith('.md')) { const n = e.name.slice(0, -3); if (!map.has(n)) map.set(n, path.join(dir, e.name)); }
    }
  };
  walk(root, 0);
  noteIdx = { at: Date.now(), map };
  return map;
}
export function findNote(name) {
  name = noteName(name); if (!name) return null;
  if (name.includes('/')) { const f = path.join(vaultRoot(), `${name}.md`); if (f.startsWith(vaultRoot()) && fs.existsSync(f)) return f; name = name.split('/').pop(); }
  return noteIndex(15000).get(name) || noteIndex(2000).get(name) || null;
}
// note names containing every word of q (case-insensitive), the Plate's own data folder left out
export function searchNotes(q, limit = 20) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean), data = path.resolve(DATA_DIR) + path.sep;
  return [...noteIndex(15000)].filter(([n, f]) => !f.startsWith(data) && terms.every((t) => n.toLowerCase().includes(t))).map(([n]) => n)
    .sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
}
// what the focus view needs from a note: the first paragraphs of text (a book note can be huge) and every checkbox line, in order
function noteBody(file) {
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const lines = text.replace(/^---\n[\s\S]*?\n---\n?/, '').split('\n');
  const prose = lines.filter((l) => !TODO.test(l)).join('\n').trim();
  return [prose.length > 600 ? `${prose.slice(0, 600).trimEnd()}…` : prose, ...lines.filter((l) => TODO.test(l))].filter(Boolean).join('\n');
}

export function readWorkstreams() {
  const dir = path.join(DATA_DIR, 'workstreams');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const { meta, body: own } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    const slug = f.slice(0, -3);
    const note = meta.note ? noteName(meta.note) : null, noteFile = note ? findNote(note) : null;
    const body = noteFile ? noteBody(noteFile) : own;
    return {
      slug, name: meta.name || slug, state: meta.state || 'active', archivedAt: meta.archivedAt || undefined, archivedFrom: meta.archivedFrom || undefined, archivedWith: meta.archivedWith || undefined, note, noteMissing: !!note && !noteFile,
      parent: meta.parent || null, related: asList(meta.related),
      github: asList(meta.github), people: asList(meta.people).map((n) => String(n).replace(/^\[\[|\]\]$/g, '').replace(/\|.*$/, '').trim()).filter(Boolean), teams: asList(meta.teams), email: asList(meta.email), color: meta.color || null, project: meta.project || null, body,
    };
  });
}

// "Needs you" rules: open Todoist items due today or earlier, sessions waiting on the human, open PRs requesting my review
// (`reviewMe`, collectors/reviews.mjs). A dismissed item never needs you.
export const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
export const snoozed = (item, now = Date.now()) => !!item.snoozedUntil && Date.parse(item.snoozedUntil) > now;
export const needsYou = (item, t = today()) => !item.dismissed && !snoozed(item) && (
  ((item.source === 'todoist' || item.source === 'tasknotes') && item.state === 'open' && !!item.due && item.due <= t) ||
  (item.source === 'session' && (item.state === 'waiting' || (item.turn === 'me' && item.state !== 'done'))) ||
  (!!item.activity && item.activity.at > (item.activitySeen || '') && item.state !== 'done') || // a comment by someone else on a ticket of mine, not yet opened
  (!!item.reviewMe && item.state === 'open'));

// ---------- workstream writes: line-level frontmatter edits, so unknown fields and the body survive ----------
export class BadRequest extends Error {}
const wsFile = (slug) => path.join(DATA_DIR, 'workstreams', `${slug}.md`);
const STATES = ['active', 'paused', 'done', 'archived'];

const fmt = (v) => {
  if (Array.isArray(v)) return ` [${v.map((x) => JSON.stringify(x)).join(', ')}]`;
  if (v == null || v === '') return '';
  return /^[\w][\w .\/&-]*$/.test(v) ? ` ${v}` : ` ${JSON.stringify(v)}`;
};

function patchFrontmatter(text, patch) {
  const m = text.match(/^---\n([\s\S]*?)\n---([\s\S]*)$/);
  if (!m) throw new BadRequest('workstream file has no frontmatter');
  const lines = m[1].split('\n');
  for (const [k, v] of Object.entries(patch)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}:`));
    const out = `${k}:${fmt(v)}`;
    if (idx < 0) { lines.push(out); continue; }
    let end = idx + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) end++; // drop an old block list / mapping
    lines.splice(idx, end - idx, out);
  }
  return `---\n${lines.join('\n')}\n---${m[2]}`;
}

function writeFileAtomic(file, text) {
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

export function createWorkstream(name, parent, note) {
  name = String(name || '').trim();
  if (!name) throw new BadRequest('name required');
  const all = readWorkstreams();
  if (parent && !all.some((w) => w.slug === parent)) throw new BadRequest('unknown parent');
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workstream';
  let slug = base;
  for (let n = 2; all.some((w) => w.slug === slug); n++) slug = `${base}-${n}`;
  const text = `---\nname:${fmt(name)}\nstate: active\nparent:${fmt(parent || '')}\nrelated: []\ngithub: []\nteams: []\nemail: []\n${note ? `note: ${JSON.stringify(`[[${note}]]`)}\n` : ''}---\n`;
  fs.mkdirSync(path.dirname(wsFile(slug)), { recursive: true });
  fs.writeFileSync(wsFile(slug), text, { flag: 'wx' });
  appendEvent({ source: 'plate', workstream: slug, type: 'workstream.new', title: name, ref: slug });
  return slug;
}

// patch: any of name, state, parent ('' = root), related (slugs), github (anchor strings)
export function updateWorkstream(slug, patch) {
  const all = readWorkstreams();
  const ws = all.find((w) => w.slug === slug);
  if (!ws) throw new BadRequest('unknown workstream');
  const slugs = new Set(all.map((w) => w.slug));
  const out = {};
  if ('name' in patch) {
    const n = String(patch.name).trim();
    if (!n) throw new BadRequest('name required');
    out.name = n;
  }
  if ('state' in patch) {
    if (!STATES.includes(patch.state)) throw new BadRequest(`state must be one of ${STATES}`);
    out.state = patch.state;
  }
  if ('parent' in patch) {
    const p = patch.parent || '';
    if (p) {
      if (!slugs.has(p)) throw new BadRequest('unknown parent');
      const parentOf = new Map(all.map((w) => [w.slug, w.parent]));
      for (let c = p, guard = 0; c && guard < 1000; c = parentOf.get(c), guard++) {
        if (c === slug) throw new BadRequest('that would make a cycle');
      }
    }
    out.parent = p;
  }
  if ('related' in patch) {
    const rel = [...new Set(patch.related)].filter((r) => r !== slug);
    if (rel.some((r) => !slugs.has(r))) throw new BadRequest('unknown related workstream');
    out.related = rel;
  }
  if ('note' in patch) {
    const n = noteName(patch.note);
    if (n && !findNote(n)) throw new BadRequest(`note “${n}” not found in the vault`);
    out.note = n ? `[[${n}]]` : '';
  }
  if ('github' in patch) out.github = patch.github.map((s) => String(s).trim()).filter(Boolean);
  if ('people' in patch) out.people = [...new Set(patch.people.map((s) => String(s).trim().replace(/^\[\[|\]\]$/g, '')).filter(Boolean))].map((n) => `[[${n}]]`);

  writeFileAtomic(wsFile(slug), patchFrontmatter(fs.readFileSync(wsFile(slug), 'utf8'), out));
  // related is an undirected edge: unlinking here also removes the back-reference stored on the other side
  if (out.related) {
    for (const o of all) {
      if (o.slug !== slug && o.related.includes(slug) && !out.related.includes(o.slug)) {
        writeFileAtomic(wsFile(o.slug), patchFrontmatter(fs.readFileSync(wsFile(o.slug), 'utf8'), { related: o.related.filter((r) => r !== slug) }));
      }
    }
  }
  if ('parent' in out && out.parent !== (ws.parent || '')) {
    appendEvent({ source: 'plate', workstream: slug, type: 'workstream.reparented', title: ws.name, ref: slug, from: ws.parent, to: out.parent || null });
  }
}

// A vault note becomes a workstream (named after it) that points at it; one already pointing at that note is returned instead.
export function workstreamFromNote(raw, parent) {
  const n = noteName(raw), f = findNote(n);
  if (!n) throw new BadRequest('note name required');
  if (!f) throw new BadRequest(`note “${n}” not found in the vault`);
  const name = path.basename(f, '.md'), have = readWorkstreams().find((w) => w.note === name);
  if (have) return { slug: have.slug, existing: true };
  return { slug: createWorkstream(name, parent, name), existing: false };
}

// Manual sources have no collector, so nothing ever marks them `gone`; only the UI adds/removes them.
// `ghref` = a pasted GitHub issue/PR; collectors/github.mjs absorbs it when the same url shows up on the board.
export const MANUAL_SOURCES = ['teams', 'link', 'note', 'ghref'];

// Teams web links open the browser; the msteams:// form opens the desktop app on the same chat/meeting.
export const teamsDeepLink = (url) => url.replace(/^https:\/\/(teams\.microsoft\.com|teams\.cloud\.microsoft)\//i, 'msteams://$1/');

// url without fragment/query/trailing slash, so the same ticket or link pasted twice is recognized
const canonUrl = (u) => String(u || '').replace(/[#?].*$/, '').replace(/\/$/, '');
export const findByUrl = (url) => { const c = canonUrl(url); return c ? readItems().find((i) => i.state !== 'gone' && canonUrl(i.url) === c) : null; };

export function addManualItem({ source, title, url, note, workstream, extra }) {
  if (!MANUAL_SOURCES.includes(source)) throw new BadRequest(`source must be one of ${MANUAL_SOURCES}`);
  title = String(title || '').trim(); url = String(url || '').trim();
  if (source === 'teams') url = teamsDeepLink(url);
  if (source !== 'note' && !url) throw new BadRequest('url required');
  if (source === 'note' && !title) throw new BadRequest('text required');
  const ws = workstream || null;
  if (ws && !readWorkstreams().some((w) => w.slug === ws)) throw new BadRequest('unknown workstream');
  const now = new Date().toISOString();
  const item = {
    id: `${source}:${crypto.randomUUID().slice(0, 8)}`, source, kind: source, url: source === 'note' ? null : url,
    title: title || url, ...(note ? { note: String(note) } : {}), workstream: ws, state: 'open', created: now, updated: now, ...extra,
  };
  writeItems([...readItems(), item]);
  appendEvent({ source, workstream: ws, type: 'item.new', title: item.title, ref: item.id });
  return item.id;
}

export function removeManualItem(id) {
  const items = readItems();
  const item = items.find((i) => i.id === id);
  if (!item) throw new BadRequest('unknown item');
  if (!MANUAL_SOURCES.includes(item.source)) throw new BadRequest('only manual items can be removed');
  writeItems(items.filter((i) => i.id !== id));
  appendEvent({ source: item.source, workstream: item.workstream, type: 'item.removed', title: item.title, ref: id });
}

// Pasted GitHub issue/PR url -> `ghref` item with repo/number/kind, title and state from `gh api` when it can reach it.
const GH_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)/i;
export const isGithubItemUrl = (url) => GH_URL.test(String(url || '').trim());

export async function addGithubItem({ url, workstream }) {
  const m = String(url || '').trim().match(GH_URL);
  if (!m) throw new BadRequest('not a GitHub issue or PR url');
  const [, repo, type, num] = m, canon = `https://github.com/${repo}/${type}/${num}`;
  const dup = findByUrl(canon);
  if (dup) return { id: dup.id, existing: true, workstream: dup.workstream };
  let kind = type === 'pull' ? 'pr' : 'issue', title = `${repo}#${num}`, status = null, state = 'open', parent;
  try {
    const { stdout } = await execFileP('gh', ['api', `repos/${repo}/issues/${num}`], { timeout: 6000 });
    const j = JSON.parse(stdout);
    title = j.title || title;
    if (j.pull_request) kind = j.draft ? 'draft' : 'pr';
    status = j.pull_request?.merged_at ? 'Merged' : j.state === 'closed' ? 'Closed' : null;
    if (status) state = 'done';
    if (j.parent_issue_url) parent = String(j.parent_issue_url).replace('https://api.github.com/repos/', 'https://github.com/'); // sub-issue: nests under its parent when both are in the workstream
  } catch { /* no gh / no access: keep the repo#N title */ }
  const anchor = readWorkstreams().find((w) => w.github.includes(`repo:${repo}`))?.slug;
  const ws = workstream || anchor || null;
  const id = addManualItem({ source: 'ghref', title, url: canon, workstream: ws, extra: { kind, repo, number: Number(num), status, state, ...(parent ? { parent } : {}) } });
  // an attached issue brings the PRs that close it: new ones as ghref, Inbox ones moved next to the issue
  let prs = 0;
  if (kind === 'issue') {
    for (const p of await closingPrs(repo, num)) {
      const have = findByUrl(p.url);
      if (!have) {
        addManualItem({ source: 'ghref', title: p.title, url: p.url, workstream: ws, extra: { kind: p.isDraft ? 'draft' : 'pr', repo: p.repository.nameWithOwner, number: p.number, status: p.state === 'MERGED' ? 'Merged' : null, state: p.state === 'MERGED' ? 'done' : 'open', closes: [canon] } });
        prs++;
      } else if (!have.workstream && ws) {
        const items = readItems(), it = items.find((i) => i.id === have.id);
        it.workstream = ws; it.updated = new Date().toISOString();
        writeItems(items);
        appendEvent({ source: it.source, workstream: ws, type: 'item.moved', title: it.title, ref: it.id, from: null });
        prs++;
      }
    }
  }
  return { id, existing: false, workstream: ws, prs };
}

// open and merged PRs that close an issue (closed-unmerged ones are noise); [] when gh can't reach it
async function closingPrs(repo, num) {
  const [owner, name] = repo.split('/');
  const query = `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { issue(number: $n) {
    closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { url number title state isDraft repository { nameWithOwner } } } } } }`;
  try {
    const { stdout } = await execFileP('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `n=${num}`], { timeout: 8000 });
    return (JSON.parse(stdout).data.repository.issue?.closedByPullRequestsReferences.nodes || []).filter((p) => p.state !== 'CLOSED');
  } catch { return []; }
}

// ---------- per-workstream to-dos: the Markdown checkboxes in the body of workstreams/<slug>.md (or of its `note`) ----------
const splitFile = (slug) => {
  if (!fs.existsSync(wsFile(slug))) throw new BadRequest('unknown workstream');
  const own = parseFrontmatter(fs.readFileSync(wsFile(slug), 'utf8')).meta.note;
  const file = own ? findNote(own) : wsFile(slug);
  if (!file) throw new BadRequest(`note “${noteName(own)}” not found in the vault`);
  const text = fs.readFileSync(file, 'utf8'), m = text.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
  if (!m && !own) throw new BadRequest('workstream file has no frontmatter');
  return { file, head: m ? m[1] : '', lines: (m ? m[2] : text).split('\n') };
};

// n = index among the body's checkbox lines; text must still match, so a stale UI can't tick the wrong line
export function setTodo(slug, n, text, done) {
  const { file, head, lines } = splitFile(slug);
  const at = lines.map((l, i) => (TODO.test(l) ? i : -1)).filter((i) => i >= 0)[n];
  const m = at != null && lines[at].match(TODO);
  if (!m || m[4].trim() !== String(text).trim()) throw new BadRequest('that to-do changed in the file; reload');
  lines[at] = `${m[1]}${done ? 'x' : ' '}${m[3]}${m[4]}`;
  writeFileAtomic(file, head + lines.join('\n'));
  appendEvent({ source: 'plate', workstream: slug, type: done ? 'todo.done' : 'todo.reopened', title: m[4].trim(), ref: slug });
}

// new to-do goes right after the last existing one, else at the end of the body
export function addTodo(slug, text) {
  text = String(text || '').trim().replace(/\s+/g, ' ');
  if (!text) throw new BadRequest('text required');
  const { file, head, lines } = splitFile(slug);
  const last = lines.map((l, i) => (TODO.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  if (last != null) lines.splice(last + 1, 0, `- [ ] ${text}`);
  else {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines.push(...(lines.length ? [''] : []), `- [ ] ${text}`, '');
  }
  writeFileAtomic(file, head + lines.join('\n'));
  appendEvent({ source: 'plate', workstream: slug, type: 'todo.new', title: text, ref: slug });
}

// Data-folder-wide source config: `sources.md` frontmatter (e.g. `github_projects: [owner/N, …]`).
export function readSources() {
  const f = path.join(DATA_DIR, 'sources.md');
  if (!fs.existsSync(f)) return { github_projects: [], people: {}, meeting_values: {} }; // callers read these without guards
  const { meta } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
  // `people:` block list of `- <github login>: <work e-mail>` (Teams chat participants)
  const people = Object.assign({}, ...asList(meta.people).filter((p) => p && typeof p === 'object'));
  // `meeting_values:` block list of `- <QuickAdd variable>: <template with {workstream} {project} {slug} {date}>`
  const meeting_values = Object.assign({}, ...asList(meta.meeting_values).filter((p) => p && typeof p === 'object'));
  return { ...meta, github_projects: asList(meta.github_projects), people, meeting_values };
}

// ---------- sources.md as a settings form ----------
// What the Settings drawer can edit: scalar keys and flat lists. `people:` and `meeting_values:` are mappings, so they stay in the file.
// type: text | number | list (comma-separated in the form, an inline list in the file) | onoff (`off` or unset) | enum:<a|b>
export const SETTINGS = [
  { group: 'Collection', key: 'collect', type: 'enum:|off', def: 'on', help: 'off = no collector runs by itself (Sync now and r d / r g still work)' },
  { group: 'Collection', key: 'github_projects', type: 'list', def: 'none', help: 'GitHub Projects boards, owner/N (e.g. my-org/12, my-org/15)' },
  { group: 'Collection', key: 'github_query', type: 'text', def: 'none (the whole board)', help: 'Projects filter applied to every board server-side, e.g. -label:Stale (same syntax as the board\'s filter box); items it filters out go away from the plate' },
  { group: 'Collection', key: 'github_reviews', type: 'enum:|off', def: 'on', help: 'off = do not collect PRs that request my review' },
  { group: 'Collection', key: 'github_mine', type: 'enum:|off', def: 'on', help: 'off = do not collect tickets I opened, am assigned to or was mentioned in' },
  { group: 'Collection', key: 'mine_days', type: 'number', def: '7', help: 'comments older than this many days never count as new activity' },
  { group: 'Collection', key: 'devin_every_minutes', type: 'number', def: '1', help: 'Devin collector interval' },
  { group: 'Collection', key: 'github_every_minutes', type: 'number', def: '10', help: 'GitHub collector interval' },
  { group: 'Collection', key: 'reviews_every_minutes', type: 'number', def: '10', help: 'review-requests collector interval' },
  { group: 'Collection', key: 'mine_every_minutes', type: 'number', def: '5', help: 'my-tickets collector interval' },
  { group: 'Collection', key: 'tasknotes_every_minutes', type: 'number', def: '5', help: 'TaskNotes collector interval' },
  { group: 'Network', key: 'lan', type: 'enum:|on', def: 'off', help: 'on = also listen on the local network (a phone on the same wifi); other devices need the access token from the server log. Restart required' },
  { group: 'Devin', key: 'setup_agent', type: 'enum:claude|devin', def: 'claude', help: 'who the "Setup pending" badge opens to apply the CHANGELOG: claude = Claude Code app, devin = a Devin CLI session (set devin on the work machine)' },
  { group: 'Devin', key: 'devin_waiting_minutes', type: 'number', def: '2', help: 'a Devin session untouched this long is waiting on you' },
  { group: 'Devin', key: 'devin_watch', type: 'enum:|off', def: 'on', help: 'off = do not collect Devin the moment its sessions.db changes' },
  { group: 'Devin', key: 'devin_link', type: 'enum:shell|acp', def: 'shell', help: 'Devin Desktop link format: shell (3.11+) or acp (older, e.g. 3.4)' },
  { group: 'Devin', key: 'devin_bin', type: 'text', def: 'the CLI inside Devin.app, else devin on PATH', help: 'path to the devin CLI' },
  { group: 'Devin', key: 'devin_review_dir', type: 'text', def: 'none (the review buttons refuse to run)', help: 'folder where "Review no Devin" and "O que falta?" run the CLI (holds clones of every repo)' },
  { group: 'Devin', key: 'devin_review_multi_prompt', type: 'text', def: 'one consolidated review of related PRs', help: 'prompt for "Review N PRs in Devin"; {urls} is the list of PRs, one per line' },
  { group: 'Claude Code', key: 'claude_sessions', type: 'enum:|off', def: 'on', help: 'off = do not list Claude Code sessions (read from ~/.claude/projects on this machine)' },
  { group: 'Claude Code', key: 'claude_projects_dir', type: 'text', def: '~/.claude/projects', help: 'folder with Claude Code transcripts (<folder>/<session>.jsonl)' },
  { group: 'Claude Code', key: 'claude_session_days', type: 'number', def: '3', help: 'only sessions with activity in the last N days are listed' },
  { group: 'Claude Code', key: 'claude_active_hours', type: 'number', def: '3', help: 'a session quiet this long is done instead of waiting on you' },
  { group: 'Devin', key: 'devin_permission_mode', type: 'enum:auto|accept-edits|smart|dangerous', def: 'smart', help: 'permission mode of the headless runs (review, O que falta?, setup): headless Devin cannot ask, so the default mode (auto, read-only) rejects every command ("Running in non-interactive mode"). smart lets a fast model approve what is safe; dangerous approves everything' },
  { group: 'Devin', key: 'devin_review_model', type: 'text', def: "Devin's own default", help: 'default --model for the review' },
  { group: 'Devin', key: 'devin_review_prompt', type: 'text', def: '/code-review {url}', help: 'prompt for the review; {url} is the PR' },
  { group: 'Devin', key: 'devin_close_prompt', type: 'text', def: 'a plain-words "what is still missing to close this ticket? {url}"', help: 'prompt for "O que falta?" on a ticket; {url} is the ticket (e.g. /my-skill {url})' },
  { group: 'Devin', key: 'devin_close_model', type: 'text', def: 'devin_review_model', help: '--model for "O que falta?"' },
  { group: 'Workstreams', key: 'stale_days', type: 'number', def: '3', help: 'days without events before an active workstream shows as idle' },
  { group: 'Workstreams', key: 'todoist_link', type: 'enum:|web', def: 'app', help: 'web = open Todoist tasks in the browser instead of the desktop app (todoist://task?id=...)' },
  { group: 'Workstreams', key: 'archive_after_days', type: 'number', def: '14', help: 'an active workstream with nothing open and no event for this many days gets an "archive?" suggestion (never archived on its own)' },
  { group: 'Workstreams', key: 'target_warn_days', type: 'number', def: '7', help: 'a board item whose "Target date" is this close (or past) gets an amber flag and moves to "Needs you / next"; 0 turns the flag off' },
  { group: 'Workstreams', key: 'doing_limit', type: 'number', def: '4', help: 'slots in "Focus now" (1-9): what I am working on right now; adding past the limit asks me to finish or drop one' },
  { group: 'Workstreams', key: 'done_days', type: 'number', def: '7', help: 'days a finished item stays under "Recently done" in a workstream' },
  { group: 'Workstreams', key: 'obsidian_vault', type: 'text', def: 'none', help: 'vault name for "+ Meeting note"' },
  { group: 'Workstreams', key: 'meeting_quickadd', type: 'text', def: 'none (no button)', help: 'QuickAdd choice name that creates a meeting note' },
  { group: 'Vault & people', key: 'tasknotes_dir', type: 'text', def: '<data>/../TaskNotes/Tasks if it exists', help: 'TaskNotes tasks folder; off disables the collector' },
  { group: 'Vault & people', key: 'people_dir', type: 'text', def: '<data>/../../Atlas/People', help: 'folder of the people notes behind a workstream\'s people:' },
  { group: 'Vault & people', key: 'teams_after_review', type: 'enum:|off', def: 'on', help: 'off = do not open the Teams draft to the PR author when I archive its Devin review session' },
  { group: 'Vault & people', key: 'people_directory', type: 'enum:|off', def: 'on (macOS dscl)', help: 'off = do not look people up in the Mac directory when creating them' },
  { group: 'Vault & people', key: 'dscl_node', type: 'text', def: '/Search', help: 'directory node for the dscl lookup' },
];
export function readSettings() {
  const src = readSources();
  return { file: path.join(DATA_DIR, 'sources.md'), schema: SETTINGS, values: Object.fromEntries(SETTINGS.map((s) => [s.key, src[s.key] ?? (s.type === 'list' ? [] : '')])), people: src.people, meeting_values: src.meeting_values };
}
// patch: {key: value}; '' / [] removes the key. Only SETTINGS keys; unknown keys and the body are kept as they are.
export function patchSources(patch) {
  const f = path.join(DATA_DIR, 'sources.md');
  let text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '---\n\n---\n';
  for (const [k, raw] of Object.entries(patch)) {
    const def = SETTINGS.find((s) => s.key === k);
    if (!def) throw new BadRequest(`unknown setting ${k}`);
    let v = def.type === 'list' ? (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => String(x).trim()).filter(Boolean) : String(raw ?? '').trim();
    if (def.type === 'number' && v !== '' && !(Number(v) > 0)) throw new BadRequest(`${k} must be a positive number`);
    if (def.type.startsWith('enum:') && !def.type.slice(5).split('|').includes(v)) throw new BadRequest(`${k} must be one of: ${def.type.slice(5).split('|').map((x) => x || '(empty)').join(', ')}`);
    if (/[\n\r]/.test(String(v))) throw new BadRequest(`${k} must be one line`);
    const empty = Array.isArray(v) ? !v.length : v === '';
    if (empty) {
      const m = text.match(/^---\n([\s\S]*?)\n---([\s\S]*)$/);
      if (!m) continue;
      const lines = m[1].split('\n'), i = lines.findIndex((l) => l.startsWith(`${k}:`));
      if (i < 0) continue;
      let end = i + 1;
      while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
      lines.splice(i, end - i);
      text = `---\n${lines.join('\n')}\n---${m[2]}`;
    } else text = patchFrontmatter(text, { [k]: v });
  }
  writeFileAtomic(f, text);
  return readSettings();
}

// Per-item annotations the UI sets on any item and collectors never overwrite (they only assign the fields they pull):
// `alias` (display name instead of `title`), `label` (free text, e.g. what a Teams chat is about), `snoozedUntil` (ISO instant;
// until then the item is not "needs you"). '' / null clears a field.
const ANNOTATIONS = ['alias', 'label', 'snoozedUntil', 'activitySeen'];
export function patchItem(id, patch) {
  const items = readItems(), item = items.find((i) => i.id === id);
  if (!item) throw new BadRequest('unknown item');
  for (const k of Object.keys(patch)) {
    if (!ANNOTATIONS.includes(k)) throw new BadRequest(`cannot set ${k}`);
    const v = patch[k] == null ? '' : String(patch[k]).trim();
    if ((k === 'snoozedUntil' || k === 'activitySeen') && v && Number.isNaN(Date.parse(v))) throw new BadRequest(`${k} must be an ISO date`);
    if (v) item[k] = v; else delete item[k];
  }
  item.updated = new Date().toISOString();
  writeItems(items);
  if ('snoozedUntil' in patch) appendEvent({ source: item.source, workstream: item.workstream, type: item.snoozedUntil ? 'item.snoozed' : 'item.unsnoozed', title: item.alias || item.title, ref: id, to: item.snoozedUntil || null });
  return item;
}

// Routing rules for items already on the plate: an Inbox item whose repo matches a workstream's `repo:` anchor moves there, and
// an Inbox session anchored to a classified item (a Devin review of a PR) follows it. Collectors only route NEW items, so this
// runs after every collector run, on Sync now, when a workstream's anchors change, and from the Inbox button. Returns the count.
// `repo:owner/name` anchors, lowercase repo -> workstream slug (first workstream wins). Also the list of repos the GitHub collector pulls.
export function repoAnchors(ws = readWorkstreams()) {
  const byRepo = new Map();
  for (const w of ws) if (w.state !== 'archived') for (const a of w.github) { const m = (typeof a === 'object' && a ? `repo:${a.repo ?? ''}` : String(a)).trim().match(/^repo:\s*([\w.-]+\/[\w.-]+)$/); if (m && !byRepo.has(m[1].toLowerCase())) byRepo.set(m[1].toLowerCase(), w.slug); }
  return byRepo;
}

export function applyRules() {
  const items = readItems(), byRepo = repoAnchors();
  const byUrl = new Map(items.filter((i) => i.url && i.workstream).map((i) => [canonUrl(i.url), i.workstream]));
  let n = 0;
  for (const i of items) {
    if (i.workstream || i.dismissed || i.state === 'gone') continue; // closed/merged ones route too: a known merged PR belongs to its repo's workstream
    const target = (i.repo && byRepo.get(i.repo.toLowerCase())) || (i.anchor && byUrl.get(canonUrl(i.anchor))) || null;
    if (!target) continue;
    i.workstream = target; i.updated = new Date().toISOString(); n++;
    appendEvent({ source: i.source, workstream: target, type: 'item.moved', title: i.alias || i.title, ref: i.id, from: null, rule: true });
  }
  if (n) writeItems(items);
  return n;
}

// Mini-CRM: a workstream's `people: ["[[Name]]"]` are notes in the people folder (sources.md `people_dir`; default Atlas/People
// two levels above the data folder, i.e. the vault root when the data lives in x/Plate). Optional frontmatter on the note:
// `role`, `email`, `teams` (e-mail or chat url), `github`, `company`. Missing note = just the name.
export function readContacts(names) {
  const src = readSources();
  const dir = peopleDir();
  const vault = src.obsidian_vault || path.basename(path.resolve(DATA_DIR, '../..'));
  const out = {};
  for (const name of new Set(names)) {
    const f = path.join(dir, `${name.replace(/[\\/]/g, '')}.md`);
    const c = { name, vault, note: fs.existsSync(f) };
    if (c.note) {
      const { meta } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
      for (const k of ['role', 'department', 'email', 'teams', 'github', 'company', 'photo']) if (meta[k]) c[k] = String(asList(meta[k])[0]);
    }
    out[name] = c;
  }
  return out;
}

// TaskNotes (Obsidian plugin) tasks folder: sources.md `tasknotes_dir` (`off` disables), else x/TaskNotes/Tasks next to the data
// folder when it exists. null = no TaskNotes here.
export function tasknotesDir() {
  const v = readSources().tasknotes_dir;
  if (String(v).toLowerCase() === 'off') return null;
  const d = v ? String(v).replace(/^~(?=$|\/)/, process.env.HOME || '') : path.resolve(DATA_DIR, '../TaskNotes/Tasks');
  return fs.existsSync(d) ? d : null;
}

const peopleDir = () => { const v = readSources().people_dir; return v ? String(v).replace(/^~(?=$|\/)/, process.env.HOME || '') : path.resolve(DATA_DIR, '../../Atlas/People'); };
const fileName = (n) => String(n).replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const yaml = (v) => JSON.stringify(String(v));

// New person note in the people folder (and nothing else: linking it to a workstream is a `people` patch). Never overwrites.
// Standard properties: role, department, company, email, teams, photo (an attachment link), directory_synced (date of the last directory read).
const PERSON_KEYS = ['role', 'department', 'company', 'email', 'teams', 'photo', 'directory_synced'];
export function createPerson({ name, ...fields }) {
  const n = fileName(name);
  if (!n) throw new BadRequest('name required (or an e-mail the directory knows)');
  const dir = peopleDir();
  if (!fs.existsSync(dir)) throw new BadRequest(`people folder not found: ${dir} (set people_dir in sources.md)`);
  const f = path.join(dir, `${n}.md`);
  if (fs.existsSync(f)) throw new BadRequest(`${n} already exists`);
  const fm = PERSON_KEYS.filter((k) => fields[k] && String(fields[k]).trim()).map((k) => `${k}:${fmt(String(fields[k]).trim())}`);
  writeFileAtomic(f, `---\nin:\n  - "[[People]]"\n${fm.length ? fm.join('\n') + '\n' : ''}---\n`);
  return n;
}

// Update the standard properties of an existing person note in place (body and other properties untouched; a note without
// frontmatter gets one with its home, `in: [[People]]`).
export function patchPerson(name, fields) {
  const f = path.join(peopleDir(), `${fileName(name)}.md`);
  if (!fs.existsSync(f)) throw new BadRequest('no note for this person');
  let text = fs.readFileSync(f, 'utf8');
  if (!/^---\n[\s\S]*?\n---/.test(text)) text = `---\nin:\n  - "[[People]]"\n---\n${text}`;
  const patch = Object.fromEntries(PERSON_KEYS.filter((k) => fields[k]).map((k) => [k, String(fields[k]).trim()]));
  writeFileAtomic(f, patchFrontmatter(text, patch));
  return patch;
}

// Attachments live in <vault>/x/Attachments; returns the file name
export function saveAttachment(fileBase, buf, ext = 'jpg') {
  const dir = path.resolve(DATA_DIR, '../Attachments');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${fileName(fileBase)}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}

// New TaskNotes task (the plugin's own format: tag `task`, status open, `projects: ["[[Project]]"]`), written into the tasks folder;
// the tasknotes collector then brings it in. `workstream` picks the project link (its `project:` or name).
export function createTask({ title, due, workstream }) {
  const t = String(title || '').trim();
  if (!t) throw new BadRequest('title required');
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new BadRequest('due must be YYYY-MM-DD');
  const dir = tasknotesDir();
  if (!dir) throw new BadRequest('no TaskNotes folder here (set tasknotes_dir in sources.md)');
  const ws = workstream ? readWorkstreams().find((w) => w.slug === workstream) : null;
  if (workstream && !ws) throw new BadRequest('unknown workstream');
  let f = path.join(dir, `${fileName(t) || 'Task'}.md`);
  for (let n = 2; fs.existsSync(f); n++) f = path.join(dir, `${fileName(t)} ${n}.md`);
  const now = new Date().toISOString();
  writeFileAtomic(f, ['---', `title: ${yaml(t)}`, 'status: open', 'priority: normal', ...(due ? [`due: ${due}`, `scheduled: ${due}`] : []),
    `dateCreated: ${now}`, `dateModified: ${now}`, 'tags:', '  - task', ...(ws ? ['projects:', `  - ${yaml(`[[${ws.project || ws.name}]]`)}`] : []), '---', ''].join('\n'));
  appendEvent({ source: 'tasknotes', workstream: ws?.slug ?? null, type: 'task.new', title: t, ref: path.basename(f, '.md') });
  return path.basename(f);
}

// ---------- lifecycle: active -> paused -> done -> archived ----------
// paused/done/archived workstreams stay out of "Needs you"; done hide from the map ("Show done"); archived leave every view
// (map, Inbox, counts, search) and are listed in the Archive, where they can be restored. New GitHub items never route into one.
const descendants = (all, slug) => { const out = []; const walk = (s) => all.filter((w) => w.parent === s).forEach((c) => { if (!out.includes(c.slug) && c.slug !== slug) { out.push(c.slug); walk(c.slug); } }); walk(slug); return out; };
const OPEN = (i) => i.state !== 'done' && i.state !== 'gone' && !i.dismissed;
// what archiving has to ask about: things that can still be done (tasks, open tickets/PRs, sessions). A pasted link, Teams chat or
// note is a reference, not a pending item: it stays in the archived workstream instead of being offered for moving.
const PENDING = (i) => OPEN(i) && !(MANUAL_SOURCES.includes(i.source) && i.source !== 'ghref');
// what archiving this workstream would touch, for the confirmation dialog
export function archivePreview(slug) {
  const all = readWorkstreams(), ws = all.find((w) => w.slug === slug);
  if (!ws) throw new BadRequest('unknown workstream');
  const kids = descendants(all, slug).filter((s) => all.find((w) => w.slug === s).state !== 'archived');
  const ids = new Set([slug, ...kids]), items = readItems().filter((i) => ids.has(i.workstream) && PENDING(i));
  return { slug, name: ws.name, children: kids.map((s) => ({ slug: s, name: all.find((w) => w.slug === s).name })), open: items.length, kinds: items.reduce((m, i) => { const k = i.source === 'session' ? 'sessions' : i.source === 'todoist' || i.source === 'tasknotes' ? 'tasks' : /\/pull\//.test(i.url || '') ? 'PRs' : 'other'; m[k] = (m[k] || 0) + 1; return m; }, {}) };
}
// items: 'inbox' (default) | 'keep' (stay in the archived workstream, hidden with it) | 'ws' + `to` (another workstream)
export function archiveWorkstream(slug, { items: what = 'inbox', to, cascade = true } = {}) {
  const all = readWorkstreams(), ws = all.find((w) => w.slug === slug);
  if (!ws) throw new BadRequest('unknown workstream');
  if (ws.state === 'archived') throw new BadRequest('already archived');
  const kids = descendants(all, slug), targets = new Set(cascade ? [slug, ...kids] : [slug]);
  let dest = null;
  if (what === 'ws') {
    dest = all.find((w) => w.slug === to);
    if (!dest || targets.has(dest.slug) || dest.state === 'archived') throw new BadRequest('pick another workstream to move the open items to');
  } else if (what !== 'inbox' && what !== 'keep') throw new BadRequest('items must be inbox, keep or ws');
  const moved = [];
  if (what !== 'keep') {
    const items = readItems();
    for (const i of items) {
      if (!targets.has(i.workstream) || !PENDING(i)) continue;
      moved.push({ id: i.id, from: i.workstream }); i.workstream = dest ? dest.slug : null; i.updated = new Date().toISOString();
      appendEvent({ source: i.source, workstream: i.workstream, type: 'item.moved', title: i.title, ref: i.id, from: moved[moved.length - 1].from });
    }
    if (moved.length) writeItems(items);
  }
  const day = today();
  for (const s of targets) {
    const w = all.find((x) => x.slug === s);
    if (w.state === 'archived') continue;
    writeFileAtomic(wsFile(s), patchFrontmatter(fs.readFileSync(wsFile(s), 'utf8'), { state: 'archived', archivedAt: day, archivedFrom: w.state, ...(s !== slug ? { archivedWith: slug } : {}) }));
    appendEvent({ source: 'plate', workstream: s, type: 'workstream.archived', title: w.name, ref: s });
    try { setDoing('ws', s, false); setTop3(day, 'ws', s, false); } catch { /* not pinned */ }
  }
  if (!cascade) for (const c of all.filter((w) => w.parent === slug)) writeFileAtomic(wsFile(c.slug), patchFrontmatter(fs.readFileSync(wsFile(c.slug), 'utf8'), { parent: ws.parent || '' })); // the children move up one level
  return { archived: [...targets], moved, reparented: !cascade ? all.filter((w) => w.parent === slug).map((w) => w.slug) : [] };
}
export function restoreWorkstream(slug) {
  const all = readWorkstreams(), ws = all.find((w) => w.slug === slug);
  if (!ws || ws.state !== 'archived') throw new BadRequest('not an archived workstream');
  const back = [slug, ...all.filter((w) => w.state === 'archived' && w.archivedWith === slug).map((w) => w.slug)];
  for (const s of back) {
    const w = all.find((x) => x.slug === s), prev = ['active', 'paused', 'done'].includes(w.archivedFrom) ? w.archivedFrom : 'active';
    const parent = w.parent && all.find((x) => x.slug === w.parent)?.state === 'archived' && !back.includes(w.parent) ? '' : undefined; // a parent that stays archived: come back as a root
    writeFileAtomic(wsFile(s), patchFrontmatter(fs.readFileSync(wsFile(s), 'utf8'), { state: prev, archivedAt: '', archivedFrom: '', archivedWith: '', ...(parent !== undefined ? { parent } : {}) }));
    appendEvent({ source: 'plate', workstream: s, type: 'workstream.restored', title: w.name, ref: s });
  }
  return { restored: back };
}

// Mark a TaskNotes task done (or reopen it) in its own .md, like the plugin does: `status` + `completedDate`. Recurring tasks stay
// out (the plugin tracks their instances). The item flips at once; the collector confirms on its next run.
export function setTaskDone(id, done) {
  const items = readItems(), item = items.find((i) => i.id === id && i.source === 'tasknotes');
  const dir = tasknotesDir();
  if (!item || !dir) throw new BadRequest('not a TaskNotes task');
  if (item.recurring) throw new BadRequest('recurring task: complete it in Obsidian (the plugin tracks its instances)');
  const f = path.resolve(dir, id.slice('tasknotes:'.length));
  if (!f.startsWith(path.resolve(dir) + path.sep) || !f.endsWith('.md') || !fs.existsSync(f)) throw new BadRequest('task file not found');
  const m = fs.readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---(\n?[\s\S]*)$/);
  if (!m) throw new BadRequest('task has no frontmatter');
  const now = new Date().toISOString();
  const keep = m[1].split('\n').filter((l) => !/^(status|completedDate|dateModified):/.test(l));
  const head = [...keep, `status: ${done ? 'done' : 'open'}`, ...(done ? [`completedDate: ${today()}`] : []), `dateModified: ${now}`];
  writeFileAtomic(f, `---\n${head.join('\n')}\n---${m[2]}`);
  item.state = done ? 'done' : 'open'; item.updated = now;
  writeItems(items);
  appendEvent({ source: 'tasknotes', workstream: item.workstream, type: 'item.state', title: item.title, ref: id, from: done ? 'open' : 'done', to: done ? 'done' : 'open' });
  return item;
}

// Closes (or reopens) a Todoist task through the REST API; needs TODOIST_API_TOKEN in the server's environment. A recurring task moves to its next date on Todoist's side: the next Sync shows it again.
export async function setTodoistDone(id, done) {
  const items = readItems(), item = items.find((i) => i.id === id && i.source === 'todoist');
  if (!item) throw new BadRequest('not a Todoist task');
  const token = process.env.TODOIST_API_TOKEN;
  if (!token) throw new BadRequest('TODOIST_API_TOKEN is not set in the environment of the Plate server');
  const base = process.env.TODOIST_API_BASE || 'https://api.todoist.com/api/v1';
  const r = await fetch(`${base}/tasks/${encodeURIComponent(id.slice('todoist:'.length))}/${done ? 'close' : 'reopen'}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new BadRequest(`Todoist answered ${r.status}`);
  const now = new Date().toISOString(), fresh = readItems(), cur = fresh.find((i) => i.id === id) || item;
  cur.state = done ? 'done' : 'open'; cur.updated = now;
  writeItems(fresh);
  appendEvent({ source: 'todoist', workstream: cur.workstream, type: 'item.state', title: cur.title, ref: id, from: done ? 'open' : 'done', to: done ? 'done' : 'open' });
  return cur;
}

// Backlog of bug/feature requests about Plate itself: `<data>/requests.md`, one `- [ ]` entry per request (continuation lines indented).
// The Submit button appends; the `plate` skill reads the open ones and ticks them off when implemented.
const requestsFile = () => path.join(DATA_DIR, 'requests.md');
const REQ = /^- \[( |x)\] (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?) · (bug|feature) · (.*)$/;
export function readRequests() {
  let txt = '';
  try { txt = fs.readFileSync(requestsFile(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    const m = line.match(REQ);
    if (m) out.push({ index: out.length, done: m[1] === 'x', at: m[2], kind: m[3], text: m[4] });
    else if (out.length && /^ {2}\S/.test(line)) out[out.length - 1].text += '\n' + line.slice(2);
  }
  return out;
}
export function addRequest({ kind, text }) {
  const t = String(text || '').trim();
  if (!t) throw new BadRequest('text required');
  if (!['bug', 'feature'].includes(kind)) throw new BadRequest('kind must be bug or feature');
  const f = requestsFile(), now = new Date(), at = `${today()} ${now.toTimeString().slice(0, 5)}`;
  const [first, ...rest] = t.split('\n').map((l) => l.trimEnd());
  const entry = [`- [ ] ${at} · ${kind} · ${first}`, ...rest.filter((l) => l.trim()).map((l) => `  ${l}`)].join('\n') + '\n';
  let cur = '';
  try { cur = fs.readFileSync(f, 'utf8'); } catch { cur = `---\ntags:\n  - ai-generated\n---\nBug reports e feature requests do Plate, mais novo embaixo. \`- [ ]\` = aberto; a skill \`plate\` lê os abertos, implementa e marca \`[x]\`. Entram pelo botão Submit do Plate ou à mão.\n\n`; }
  writeFileAtomic(f, cur.replace(/\n*$/, '\n') + entry);
  appendEvent({ source: 'note', workstream: null, type: 'request.new', title: first, ref: kind });
  return readRequests().pop();
}
export function toggleRequest(index, done) {
  const f = requestsFile();
  let lines;
  try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { throw new BadRequest('no requests yet'); }
  let n = -1;
  for (let i = 0; i < lines.length; i++) if (REQ.test(lines[i]) && ++n === Number(index)) {
    lines[i] = lines[i].replace(/^- \[[ x]\]/, done ? '- [x]' : '- [ ]');
    writeFileAtomic(f, lines.join('\n'));
    return true;
  }
  throw new BadRequest('unknown request');
}
