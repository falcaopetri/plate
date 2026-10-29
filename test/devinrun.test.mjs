// A headless Devin run whose CLI exits 1 after the session exists (a pre-hook rejecting a tool call) is not a failed run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-run-'));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plate-work-')));
const PR = 'https://github.com/o/r/pull/7';
fs.mkdirSync(path.join(dir, 'workstreams'));
fs.writeFileSync(path.join(dir, 'workstreams/proj.md'), '---\nname: Proj\nstate: active\nparent:\n---\n');
fs.writeFileSync(path.join(dir, 'sources.md'), `---\ndevin_review_dir: ${work}/\n---\n`);
fs.writeFileSync(path.join(dir, 'items.jsonl'), JSON.stringify({ id: 'gh:7', source: 'github', kind: 'pr', url: PR, title: 'Fix the thing', state: 'open', workstream: 'proj' }) + '\n');
fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
const db = path.join(dir, 'sessions.db');
const sdb = new DatabaseSync(db);
sdb.exec('CREATE TABLE sessions (id TEXT, title TEXT, working_directory TEXT, backend_type TEXT, model TEXT, created_at INT, last_activity_at INT, hidden INT, main_chain_id TEXT); CREATE TABLE message_nodes (session_id TEXT, node_id TEXT, chat_message TEXT);');
sdb.close();
// fake CLI: creates the session in sessions.db (cwd spelled differently from the setting: trailing slash comes from sources.md), then dies like the rejected tool call did
const bin = path.join(dir, 'devin-fake.mjs');
fs.writeFileSync(bin, `#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync(${JSON.stringify(db)});
const now = Math.floor(Date.now() / 1000);
d.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,0,?)').run('new-run', 'Greeting', ${JSON.stringify(work)}, 'local', 'm', now, now, 'n1');
d.prepare('INSERT INTO message_nodes VALUES (?,?,?)').run('new-run', 'n1', JSON.stringify({ role: 'assistant', content: 'working' }));
d.close();
setTimeout(() => { console.error('Error: A tool was rejected by the user'); process.exit(1); }, 300);
`);
fs.chmodSync(bin, 0o755);
Object.assign(process.env, { PLATE_DATA_DIR: dir, DEVIN_SESSIONS_DB: db, DEVIN_DESKTOP_STATE: path.join(dir, 'none.vscdb'), DEVIN_BIN: bin, PLATE_NO_SCHEDULE: '1', PLATE_CACHE_DIR: path.join(dir, 'cache') });
const { startReview, runs } = await import('../lib/devinrun.mjs');
const { readItems } = await import('../lib/store.mjs');

test('CLI exit 1 with the session already created: run is done (kept), session anchored and renamed', async () => {
  startReview(PR);
  for (let n = 0; n < 100 && runs[PR].state === 'running'; n++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(runs[PR].state, 'done');
  assert.equal(runs[PR].warn, true);
  assert.match(runs[PR].msg, /session created/);
  const s = readItems().find((i) => i.tool === 'devin');
  assert.equal(s.anchor, PR);
  assert.equal(s.alias, 'Review: Fix the thing');
  assert.equal(s.workstream, 'proj');
});
