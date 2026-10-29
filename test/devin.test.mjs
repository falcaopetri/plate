import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = 'aaaaaaaa-0000-0000-0000-000000000001', B = 'bbbbbbbb-0000-0000-0000-000000000002', C = 'cccccccc-0000-0000-0000-000000000003';
const NEW = 'windsurf.acp.session/archivedSessions';

// scratch data dir + a sessions.db (3 old sessions whose last message leaves the turn to the user) + a Desktop state.vscdb
function setup(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-devin-'));
  fs.mkdirSync(path.join(dir, 'workstreams'));
  const sdb = new DatabaseSync(path.join(dir, 'sessions.db'));
  sdb.exec(`CREATE TABLE sessions (id TEXT, title TEXT, working_directory TEXT, backend_type TEXT, model TEXT, created_at INT, last_activity_at INT, hidden INT, main_chain_id TEXT);
    CREATE TABLE message_nodes (session_id TEXT, node_id TEXT, chat_message TEXT);`);
  for (const id of [A, B, C]) {
    sdb.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,0,?)').run(id, `s ${id.slice(0, 1)}`, '/tmp', 'local', 'm', 1700000000, 1700000000, `n-${id}`);
    sdb.prepare('INSERT INTO message_nodes VALUES (?,?,?)').run(id, `n-${id}`, JSON.stringify({ role: 'assistant', content: 'done, your call' }));
  }
  sdb.close();
  const state = path.join(dir, 'state.vscdb');
  const vdb = new DatabaseSync(state);
  vdb.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)');
  for (const [k, v] of rows) vdb.prepare('INSERT INTO ItemTable VALUES (?,?)').run(k, v);
  vdb.close();
  return { dir, state };
}
function collect({ dir, state }) {
  const env = { ...process.env, PLATE_DATA_DIR: dir, DEVIN_SESSIONS_DB: path.join(dir, 'sessions.db'), DEVIN_DESKTOP_STATE: state };
  execFileSync(process.execPath, ['collectors/devin.mjs'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const items = fs.readFileSync(path.join(dir, 'items.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return Object.fromEntries(items.map((i) => [i.id.replace('session:', ''), i]));
}

test('current format: archivedSessions array of acp refs -> done, no turn, not needs-you', async () => {
  const by = collect(setup([[NEW, JSON.stringify([`acp/devin-cli/${A}`])]]));
  assert.equal(by[A].state, 'done');
  assert.equal(by[A].turn, undefined);
  assert.equal(by[B].state, 'waiting'); assert.equal(by[B].turn, 'me'); // not archived: still yours
  process.env.PLATE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-devin-store-'));
  const { needsYou } = await import('../lib/store.mjs');
  assert.ok(!needsYou(by[A]));
  assert.ok(needsYou(by[B]));
});

test('legacy format: localSessionAnnotations still recognized (archived and done)', () => {
  const ann = { [`devin-acp/devin-cli/${A}`]: { archived: true, folder: 'f' }, [`devin-acp/devin-cli/${B}`]: { done: true } };
  const by = collect(setup([['devin.desktopShell.localSessionAnnotations.org1', JSON.stringify(ann)]]));
  assert.equal(by[A].state, 'done'); assert.equal(by[A].devinFolder, 'f');
  assert.equal(by[B].state, 'done');
  assert.equal(by[C].state, 'waiting');
});

test('both formats together', () => {
  const by = collect(setup([[NEW, JSON.stringify([`acp/devin-cli/${A}`])], ['x.localSessionAnnotations.o', JSON.stringify({ [`devin-acp/devin-cli/${B}`]: { archived: true } })]]));
  assert.deepEqual([by[A].state, by[B].state, by[C].state], ['done', 'done', 'waiting']);
});

test('malformed or absent archive data does not crash collection', () => {
  for (const rows of [[], [[NEW, 'not json']], [[NEW, '{"a":1}']], [[NEW, '[1,null,{}]']], [['x.localSessionAnnotations.o', '[1]']], [['x.localSessionAnnotations.o', 'null']]]) {
    assert.equal(collect(setup(rows))[A].state, 'waiting'); // nothing archived, but it ran
  }
  const s = setup([]); fs.rmSync(s.state); // no Desktop at all
  assert.equal(collect(s)[A].state, 'waiting');
  const t = setup([]); fs.writeFileSync(t.state, 'garbage'); // not even a database
  assert.equal(collect(t)[A].state, 'waiting');
});
