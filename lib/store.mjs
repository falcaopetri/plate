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

// Minimal frontmatter parser: `key: scalar`, `key: [a, b]`, or block lists (`- a`).
function parseFrontmatter(text) {
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

export function readWorkstreams() {
  const dir = path.join(DATA_DIR, 'workstreams');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    const slug = f.slice(0, -3);
    return {
      slug, name: meta.name || slug, state: meta.state || 'active',
      parent: meta.parent || null, related: asList(meta.related),
      github: asList(meta.github), teams: asList(meta.teams), email: asList(meta.email), color: meta.color || null, project: meta.project || null, body,
    };
  });
}

// "Needs you" rules: open Todoist items due today or earlier, sessions waiting on the human, open PRs requesting my review
// (`reviewMe`, collectors/reviews.mjs). A dismissed item never needs you.
export const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
export const snoozed = (item, now = Date.now()) => !!item.snoozedUntil && Date.parse(item.snoozedUntil) > now;
export const needsYou = (item, t = today()) => !item.dismissed && !snoozed(item) && (
  (item.source === 'todoist' && item.state === 'open' && !!item.due && item.due <= t) ||
  (item.source === 'session' && item.state === 'waiting') ||
  (!!item.reviewMe && item.state === 'open'));

// ---------- workstream writes: line-level frontmatter edits, so unknown fields and the body survive ----------
export class BadRequest extends Error {}
const wsFile = (slug) => path.join(DATA_DIR, 'workstreams', `${slug}.md`);
const STATES = ['active', 'paused', 'done'];

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

export function createWorkstream(name, parent) {
  name = String(name || '').trim();
  if (!name) throw new BadRequest('name required');
  const all = readWorkstreams();
  if (parent && !all.some((w) => w.slug === parent)) throw new BadRequest('unknown parent');
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workstream';
  let slug = base;
  for (let n = 2; all.some((w) => w.slug === slug); n++) slug = `${base}-${n}`;
  const text = `---\nname:${fmt(name)}\nstate: active\nparent:${fmt(parent || '')}\nrelated: []\ngithub: []\nteams: []\nemail: []\n---\n`;
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
  if ('github' in patch) out.github = patch.github.map((s) => String(s).trim()).filter(Boolean);

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
  let kind = type === 'pull' ? 'pr' : 'issue', title = `${repo}#${num}`, status = null, state = 'open';
  try {
    const { stdout } = await execFileP('gh', ['api', `repos/${repo}/issues/${num}`], { timeout: 6000 });
    const j = JSON.parse(stdout);
    title = j.title || title;
    if (j.pull_request) kind = j.draft ? 'draft' : 'pr';
    status = j.pull_request?.merged_at ? 'Merged' : j.state === 'closed' ? 'Closed' : null;
    if (status) state = 'done';
  } catch { /* no gh / no access: keep the repo#N title */ }
  const anchor = readWorkstreams().find((w) => w.github.includes(`repo:${repo}`))?.slug;
  const ws = workstream || anchor || null;
  const id = addManualItem({ source: 'ghref', title, url: canon, workstream: ws, extra: { kind, repo, number: Number(num), status, state } });
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

// ---------- per-workstream to-dos: the Markdown checkboxes in the body of workstreams/<slug>.md ----------
const TODO = /^(\s*[-*] \[)([ xX])(\] )(.*)$/;
const splitFile = (slug) => {
  if (!fs.existsSync(wsFile(slug))) throw new BadRequest('unknown workstream');
  const m = fs.readFileSync(wsFile(slug), 'utf8').match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
  if (!m) throw new BadRequest('workstream file has no frontmatter');
  return { head: m[1], lines: m[2].split('\n') };
};

// n = index among the body's checkbox lines; text must still match, so a stale UI can't tick the wrong line
export function setTodo(slug, n, text, done) {
  const { head, lines } = splitFile(slug);
  const at = lines.map((l, i) => (TODO.test(l) ? i : -1)).filter((i) => i >= 0)[n];
  const m = at != null && lines[at].match(TODO);
  if (!m || m[4].trim() !== String(text).trim()) throw new BadRequest('that to-do changed in the file; reload');
  lines[at] = `${m[1]}${done ? 'x' : ' '}${m[3]}${m[4]}`;
  writeFileAtomic(wsFile(slug), head + lines.join('\n'));
  appendEvent({ source: 'plate', workstream: slug, type: done ? 'todo.done' : 'todo.reopened', title: m[4].trim(), ref: slug });
}

// new to-do goes right after the last existing one, else at the end of the body
export function addTodo(slug, text) {
  text = String(text || '').trim().replace(/\s+/g, ' ');
  if (!text) throw new BadRequest('text required');
  const { head, lines } = splitFile(slug);
  const last = lines.map((l, i) => (TODO.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  if (last != null) lines.splice(last + 1, 0, `- [ ] ${text}`);
  else {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines.push(...(lines.length ? [''] : []), `- [ ] ${text}`, '');
  }
  writeFileAtomic(wsFile(slug), head + lines.join('\n'));
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

// Per-item annotations the UI sets on any item and collectors never overwrite (they only assign the fields they pull):
// `alias` (display name instead of `title`), `label` (free text, e.g. what a Teams chat is about), `snoozedUntil` (ISO instant;
// until then the item is not "needs you"). '' / null clears a field.
const ANNOTATIONS = ['alias', 'label', 'snoozedUntil'];
export function patchItem(id, patch) {
  const items = readItems(), item = items.find((i) => i.id === id);
  if (!item) throw new BadRequest('unknown item');
  for (const k of Object.keys(patch)) {
    if (!ANNOTATIONS.includes(k)) throw new BadRequest(`cannot set ${k}`);
    const v = patch[k] == null ? '' : String(patch[k]).trim();
    if (k === 'snoozedUntil' && v && Number.isNaN(Date.parse(v))) throw new BadRequest('snoozedUntil must be an ISO date');
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
export function applyRules() {
  const items = readItems(), ws = readWorkstreams();
  const byRepo = new Map();
  for (const w of ws) for (const a of w.github) { const m = (typeof a === 'object' && a ? `repo:${a.repo ?? ''}` : String(a)).trim().match(/^repo:\s*(\S+)$/); if (m && !byRepo.has(m[1].toLowerCase())) byRepo.set(m[1].toLowerCase(), w.slug); }
  const byUrl = new Map(items.filter((i) => i.url && i.workstream).map((i) => [canonUrl(i.url), i.workstream]));
  let n = 0;
  for (const i of items) {
    if (i.workstream || i.dismissed || i.state === 'gone' || i.state === 'done') continue;
    const target = (i.repo && byRepo.get(i.repo.toLowerCase())) || (i.anchor && byUrl.get(canonUrl(i.anchor))) || null;
    if (!target) continue;
    i.workstream = target; i.updated = new Date().toISOString(); n++;
    appendEvent({ source: i.source, workstream: target, type: 'item.moved', title: i.alias || i.title, ref: i.id, from: null, rule: true });
  }
  if (n) writeItems(items);
  return n;
}
