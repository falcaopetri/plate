#!/usr/bin/env node
// Todoist collector: overdue + today + next 21 days -> items.jsonl (new items land in the Inbox).
//
// Input (first that applies):
//   --file <path>          JSON dump: {"tasks":[...]} in the shape of the Todoist MCP `find-tasks-by-date`
//   TODOIST_API_TOKEN env  live pull from the Todoist REST API (v1)   [not exercised yet]
//   default dump path      .cache/todoist.json
// Re-running is idempotent: items are upserted by id and keep their `workstream`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsert } from '../lib/upsert.mjs';
import { readSources } from '../lib/store.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argFile = process.argv.indexOf('--file');
const dumpPath = argFile > 0 ? process.argv[argFile + 1] : path.join(root, '.cache/todoist.json');

// Live pull: overdue + today + next 21 days, plus everything in the Inbox project (undated tasks too, `todoist_inbox: off` skips it),
// minus tasks in the sections named by `todoist_ignore_sections` (default `dump`, case-insensitive). Those go `gone` in the plate.
const BASE = process.env.TODOIST_API_BASE || 'https://api.todoist.com/api/v1';
async function pullLive(token) {
  const src = readSources();
  const ignore = String(src.todoist_ignore_sections ?? 'dump').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const H = { headers: { Authorization: `Bearer ${token}` } };
  const sections = new Map();
  if (ignore.length) {
    let cur = '';
    do {
      const r = await fetch(`${BASE}/sections?limit=200${cur}`, H);
      if (!r.ok) throw new Error(`Todoist API ${r.status} (sections)`);
      const j = await r.json();
      for (const x of j.results) sections.set(String(x.id), String(x.name || '').toLowerCase());
      cur = j.next_cursor ? `&cursor=${j.next_cursor}` : '';
    } while (cur);
  }
  const out = [];
  const q = encodeURIComponent('overdue | today | next 21 days' + (src.todoist_inbox === 'off' ? '' : ' | #Inbox'));
  let cursor = '';
  do {
    const r = await fetch(`${BASE}/tasks/filter?query=${q}&limit=200${cursor}`, H);
    if (!r.ok) throw new Error(`Todoist API ${r.status}`);
    const j = await r.json();
    for (const t of j.results) {
      if (t.section_id && ignore.includes(sections.get(String(t.section_id)))) continue;
      out.push({ id: t.id, content: t.content, dueDate: t.due?.date?.slice(0, 10) ?? null, recurring: t.due?.is_recurring ? t.due.string : false, priority: 'p' + (5 - t.priority), addedAt: t.added_at });
    }
    cursor = j.next_cursor ? `&cursor=${j.next_cursor}` : '';
  } while (cursor);
  return out;
}

const tasks = process.env.TODOIST_API_TOKEN
  ? await pullLive(process.env.TODOIST_API_TOKEN)
  : JSON.parse(fs.readFileSync(dumpPath, 'utf8')).tasks;

upsert('todoist', tasks.map((t) => ({
  id: `todoist:${t.id}`, source: 'todoist', url: `https://app.todoist.com/app/task/${t.id}`, title: t.content,
  due: t.dueDate || null, priority: t.priority || null, recurring: t.recurring || null,
  state: 'open', created: t.addedAt,
})));
