#!/usr/bin/env node
// TaskNotes collector: tasks of the Obsidian TaskNotes plugin (one .md per task, frontmatter `title`, `status`, `due`,
// `scheduled`, `projects: ["[[Project]]"]`) -> items.jsonl, read-only (edit them in Obsidian).
//
//   node collectors/tasknotes.mjs [--dir <tasks folder>]     default: sources.md `tasknotes_dir`, else <data>/../TaskNotes/Tasks
//
// Open tasks only: a completed task is imported only if it is already on the plate (so it flips to `done`, never to `gone`), and the
// history of finished tasks stays out. `due` (else `scheduled`) feeds "Needs you" when it is today or earlier, like Todoist.
// A task starts in the workstream whose name (or `project:`) matches one of its `projects:` links, else the Inbox.
import fs from 'node:fs';
import path from 'node:path';
import { upsert } from '../lib/upsert.mjs';
import { parseFrontmatter, readItems, readWorkstreams, readSources, tasknotesDir, DATA_DIR } from '../lib/store.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const dir = arg('dir') || tasknotesDir();
if (!dir || !fs.existsSync(dir)) { console.log('tasknotes: no tasks folder here, skipped'); process.exit(0); }

const vault = readSources().obsidian_vault || path.basename(path.resolve(DATA_DIR, '../..'));
const norm = (s) => String(s || '').toLowerCase().replace(/^\[\[|\]\]$/g, '').replace(/\|.*$/, '').trim();
const byProject = new Map();
for (const w of readWorkstreams()) for (const n of [w.name, w.project]) if (n && !byProject.has(norm(n))) byProject.set(norm(n), w.slug);

const CLOSED = /^(done|completed|cancelled|canceled|resolved)$/i;
const day = (v) => (String(v || '').match(/^\d{4}-\d{2}-\d{2}/) || [null])[0];
const heldIds = new Set(readItems().filter((i) => i.source === 'tasknotes').map((i) => i.id));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.md') ? [path.join(d, e.name)] : []);

const incoming = [];
for (const f of walk(dir)) {
  const { meta } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
  const rel = path.relative(dir, f).replace(/\\/g, '/');
  const id = `tasknotes:${rel}`;
  const closed = CLOSED.test(String(meta.status || '')) || !!meta.completedDate;
  if (closed && !heldIds.has(id)) continue;
  const projects = (Array.isArray(meta.projects) ? meta.projects : meta.projects ? [meta.projects] : []).map(norm);
  const ws = projects.map((p) => byProject.get(p)).find(Boolean);
  const vaultPath = path.relative(path.resolve(DATA_DIR, '../..'), f).replace(/\\/g, '/');
  incoming.push({
    id, source: 'tasknotes', kind: 'tasknotes', title: String(meta.title || path.basename(f, '.md')),
    url: `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(vaultPath.replace(/\.md$/, ''))}`,
    due: day(meta.due) || day(meta.scheduled) || undefined, priority: meta.priority || undefined, project: projects[0] || undefined,
    recurring: meta.recurrence ? true : undefined, state: closed ? 'done' : 'open', workstream: ws,
  });
}
upsert('tasknotes', incoming, { closedStates: ['gone'] });
