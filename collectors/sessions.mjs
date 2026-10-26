#!/usr/bin/env node
// Sessions collector: agent/coding sessions as items (source "session").
//
//   node collectors/sessions.mjs [--file dump.json]     default .cache/sessions.json
//
// Dump shape (on the work machine, something converts the Devin CLI session store into this):
//   { "sessions": [ {
//       "id": "abc123",                  // stable, unique per tool; item id becomes session:<id>
//       "title": "Fix flaky login test", // required
//       "state": "waiting",              // waiting (needs the human) | running | done
//       "tool": "devin",                 // optional: devin | claude | ...
//       "url": "devin://...",            // optional: deep link / resume command target
//       "cwd": "/path/to/repo",          // optional
//       "created": "ISO", "updated": "ISO",   // optional
//       "github": "https://github.com/o/r/pull/7",  // optional: anchor item. A NEW session inherits that item's workstream
//       "workstream": "slug"             // optional: initial workstream (only applied when the item is first created)
//   } ] }
// Sessions missing from a later dump become `gone`. Items in state `done` stay visible until they disappear.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsert } from '../lib/upsert.mjs';
import { readItems } from '../lib/store.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--file');
const file = i > 0 ? process.argv[i + 1] : path.join(root, '.cache/sessions.json');
const STATES = ['waiting', 'running', 'done'];

const items = readItems();
const inherit = (url) => (url ? items.find((x) => x.url === url)?.workstream ?? undefined : undefined);

const incoming = JSON.parse(fs.readFileSync(file, 'utf8')).sessions.map((s) => {
  if (!STATES.includes(s.state)) throw new Error(`session ${s.id}: state must be one of ${STATES}`);
  return {
    id: `session:${s.id}`, source: 'session', kind: 'session', tool: s.tool || null,
    url: s.url || null, title: s.title, cwd: s.cwd || null, anchor: s.github || null,
    state: s.state, created: s.created, workstream: s.workstream ?? inherit(s.github),
  };
});
upsert('session', incoming, { closedStates: [], owns: (it) => it.tool !== 'devin' }); // devin items belong to collectors/devin.mjs
