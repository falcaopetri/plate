// Submit button backlog (requests.md) and the "Setup pending" session launcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-req-'));
fs.mkdirSync(path.join(dir, 'workstreams'));
fs.writeFileSync(path.join(dir, 'items.jsonl'), '');
fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
fs.writeFileSync(path.join(dir, 'sources.md'), '---\ncollect: off\n---\n');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = path.join(dir, 'sessions.db');
const sdb = new DatabaseSync(db);
sdb.exec('CREATE TABLE sessions (id TEXT, title TEXT, working_directory TEXT, backend_type TEXT, model TEXT, created_at INT, last_activity_at INT, hidden INT, main_chain_id TEXT); CREATE TABLE message_nodes (session_id TEXT, node_id TEXT, chat_message TEXT)');
sdb.close();
const bin = path.join(dir, 'devin-fake.mjs');
fs.writeFileSync(bin, `#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync(${JSON.stringify(db)});
const now = Math.floor(Date.now() / 1000);
d.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,0,?)').run('setup-run', 'Greeting', ${JSON.stringify(fs.realpathSync(root))}, 'local', 'm', now, now, 'n1');
d.prepare('INSERT INTO message_nodes VALUES (?,?,?)').run('setup-run', 'n1', JSON.stringify({ role: 'assistant', content: 'ok' }));
d.close();
console.log(process.argv.slice(2).join(' '));
`);
fs.chmodSync(bin, 0o755);
Object.assign(process.env, { PLATE_DATA_DIR: dir, DEVIN_SESSIONS_DB: db, DEVIN_DESKTOP_STATE: path.join(dir, 'none.vscdb'), DEVIN_BIN: bin, PLATE_NO_SCHEDULE: '1', PLATE_CACHE_DIR: path.join(dir, 'cache') });
const { addRequest, readRequests, toggleRequest, readSources } = await import('../lib/store.mjs');
const { startSetup, runs } = await import('../lib/devinrun.mjs');
const { readItems } = await import('../lib/store.mjs');

test('requests: add (multi-line), list, tick, reject bad input', () => {
  assert.deepEqual(readRequests(), []);
  addRequest({ kind: 'feature', text: 'Dark mode · please\nsecond line' });
  addRequest({ kind: 'bug', text: 'Toast is red' });
  let r = readRequests();
  assert.equal(r.length, 2);
  assert.equal(r[0].kind, 'feature');
  assert.equal(r[0].text, 'Dark mode · please\nsecond line');
  assert.equal(r[1].done, false);
  toggleRequest(0, true);
  r = readRequests();
  assert.equal(r[0].done, true);
  assert.equal(r[1].done, false);
  assert.throws(() => addRequest({ kind: 'idea', text: 'x' }), /kind/);
  assert.throws(() => addRequest({ kind: 'bug', text: '  ' }), /text/);
  assert.throws(() => toggleRequest(9, true), /unknown/);
});

test('setup: nothing pending is refused; claude (default) returns a claude:// link on this repo', () => {
  assert.throws(() => startSetup(null), /no setup pending/);
  const r = startSetup({ latest: 12, seen: 9 });
  assert.equal(r.agent, 'claude');
  assert.equal(r.range, '#10-12');
  const u = new URL(r.url);
  assert.equal(u.protocol, 'claude:');
  assert.equal(u.searchParams.get('folder'), path.resolve(root));
  assert.equal(u.searchParams.get('q'), '/plate-changelog');
});

test('setup: setup_agent devin runs the CLI with /plate-changelog and ties the session', async () => {
  fs.writeFileSync(path.join(dir, 'sources.md'), '---\nsetup_agent: devin\ncollect: off\n---\n');
  assert.equal(readSources().setup_agent, 'devin');
  assert.equal(startSetup({ latest: 5, seen: 4 }).agent, 'devin');
  for (let n = 0; n < 100 && runs.setup.state === 'running'; n++) await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(runs.setup.state, 'done');
  assert.match(fs.readFileSync(runs.setup.log, 'utf8'), /-p \/plate-changelog/);
  const s = readItems().find((i) => i.tool === 'devin');
  assert.equal(runs.setup.session, s.id);
  assert.equal(s.alias, 'Setup: CHANGELOG #5');
});
