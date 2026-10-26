#!/usr/bin/env node
// GitHub Projects (v2) collector: issues + PRs (+ drafts) of one project board -> items.jsonl.
//
//   node collectors/github.mjs --owner <owner> --project <N>   live: `gh project item-list` (needs `gh auth refresh -s read:project`)
//   node collectors/github.mjs [--file dump.json]               dump (default .cache/github.json), same JSON as `gh ... --format json`
//
// Produce the dump:  gh project item-list <N> --owner <owner> --format json -L 200 > .cache/github.json
//
// Mapping: kind = issue | pr | draft. `status` / `iteration` are the board's custom fields of those names.
// state: `open`; `done` when Status is Done/Closed/Merged or content.state says CLOSED/MERGED; `gone` when the item left the board.
// Routing on creation: if an item's repository matches a workstream anchor `repo:<owner/name>`, it starts in that workstream.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upsert } from '../lib/upsert.mjs';
import { readWorkstreams } from '../lib/store.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };

const owner = arg('owner'), project = arg('project');
const raw = owner && project
  ? JSON.parse(execFileSync('gh', ['project', 'item-list', project, '--owner', owner, '--format', 'json', '-L', '200'], { encoding: 'utf8', maxBuffer: 64e6 }))
  : JSON.parse(fs.readFileSync(arg('file') || path.join(root, '.cache/github.json'), 'utf8'));

const anchors = new Map(); // repo -> workstream slug
for (const w of readWorkstreams()) for (const a of w.github) if (a.startsWith('repo:')) anchors.set(a.slice(5), w.slug);

const DONE = /^(done|closed|merged|shipped)$/i;
const title = (v) => (v && typeof v === 'object' ? v.title : v) || null; // iteration may be a string or {title, startDate, duration}

const incoming = [];
for (const it of raw.items || []) {
  const c = it.content || {};
  if (!c.url && it.type !== 'DRAFT_ISSUE' && c.type !== 'DraftIssue') continue;
  const kind = c.type === 'PullRequest' ? 'pr' : c.type === 'Issue' ? 'issue' : 'draft';
  const repo = typeof c.repository === 'string' ? c.repository.replace(/^https:\/\/github.com\//, '') : null;
  const done = DONE.test(it.status || '') || /^(closed|merged)$/i.test(c.state || '');
  incoming.push({
    id: `github:${it.id}`, source: 'github', kind, url: c.url || null,
    title: it.title || c.title, repo, number: c.number ?? null,
    status: it.status || null, iteration: title(it.iteration),
    state: done ? 'done' : 'open',
    workstream: anchors.get(repo) ?? undefined,
  });
}
upsert('github', incoming, { closedStates: ['gone'] });
