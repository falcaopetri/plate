// File-backed store. The data dir is the source of truth; nothing is cached.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
      github: asList(meta.github), teams: asList(meta.teams), email: asList(meta.email), body,
    };
  });
}

// "Needs you" rules (v1): open Todoist items due today or earlier, and sessions waiting on the human.
export const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
export const needsYou = (item, t = today()) =>
  (item.source === 'todoist' && item.state === 'open' && !!item.due && item.due <= t) ||
  (item.source === 'session' && item.state === 'waiting');

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
export const MANUAL_SOURCES = ['teams', 'link', 'note'];

export function addManualItem({ source, title, url, note, workstream }) {
  if (!MANUAL_SOURCES.includes(source)) throw new BadRequest(`source must be one of ${MANUAL_SOURCES}`);
  title = String(title || '').trim(); url = String(url || '').trim();
  if (source !== 'note' && !url) throw new BadRequest('url required');
  if (source === 'note' && !title) throw new BadRequest('text required');
  const ws = workstream || null;
  if (ws && !readWorkstreams().some((w) => w.slug === ws)) throw new BadRequest('unknown workstream');
  const now = new Date().toISOString();
  const item = {
    id: `${source}:${crypto.randomUUID().slice(0, 8)}`, source, kind: source, url: source === 'note' ? null : url,
    title: title || url, ...(note ? { note: String(note) } : {}), workstream: ws, state: 'open', created: now, updated: now,
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
