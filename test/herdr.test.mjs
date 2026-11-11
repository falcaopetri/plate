// `herdr: on`: a Devin run opens in the Herdr app, one space per workstream, one tab per session; unreachable Herdr = headless run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-herdr-'));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plate-work-')));
const PR1 = 'https://github.com/o/r/pull/1', PR2 = 'https://github.com/o/r/pull/2', PR3 = 'https://github.com/o/r/pull/3';
fs.mkdirSync(path.join(dir, 'workstreams'));
fs.writeFileSync(path.join(dir, 'workstreams/proj.md'), '---\nname: My Project\nstate: active\nparent:\n---\n');
fs.writeFileSync(path.join(dir, 'sources.md'), `---\ndevin_review_dir: ${work}\nherdr: on\n---\n`);
fs.writeFileSync(path.join(dir, 'items.jsonl'), [PR1, PR2, PR3].map((url, n) => JSON.stringify({ id: `gh:${n + 1}`, source: 'github', kind: 'pr', url, title: `PR ${n + 1}`, state: 'open', workstream: n < 2 ? 'proj' : null })).join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
const db = path.join(dir, 'sessions.db');
const sdb = new DatabaseSync(db);
sdb.exec('CREATE TABLE sessions (id TEXT, title TEXT, working_directory TEXT, backend_type TEXT, model TEXT, created_at INT, last_activity_at INT, hidden INT, main_chain_id TEXT); CREATE TABLE message_nodes (session_id TEXT, node_id TEXT, chat_message TEXT);');
const addSession = (id) => { const now = Math.floor(Date.now() / 1000); sdb.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,0,?)').run(id, 'Greeting', work, 'local', 'm', now, now, 'n1'); sdb.prepare('INSERT INTO message_nodes VALUES (?,?,?)').run(id, 'n1', JSON.stringify({ role: 'assistant', content: 'hi' })); };
// fake herdr-app: `ls` reads the spaces it was told about, `do space.new|tab.new <json>` appends to a call log
const calls = path.join(dir, 'calls.jsonl'), spaces = path.join(dir, 'spaces.json');
fs.writeFileSync(spaces, '[]');
const fake = path.join(dir, 'herdr-app');
fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
const sp = JSON.parse(fs.readFileSync(${JSON.stringify(spaces)}, 'utf8'));
if (a[0] === 'ls') { console.log(JSON.stringify({ spaces: sp })); process.exit(0); }
const body = JSON.parse(a[2]);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cmd: a[1], ...body }) + '\\n');
if (a[1] === 'space.new') { sp.push({ id: 'sp' + sp.length, name: body.name, machine: null, tabs: [] }); fs.writeFileSync(${JSON.stringify(spaces)}, JSON.stringify(sp)); console.log(JSON.stringify({ space: 'sp' + (sp.length - 1), tab: 'tb', terminal: 't1' })); }
else console.log(JSON.stringify({ space: body.space, tab: 'tb2', terminal: 't2' }));
`);
fs.chmodSync(fake, 0o755);
const bin = path.join(dir, 'devin-fake.mjs');
fs.writeFileSync(bin, '#!/usr/bin/env node\nprocess.exit(0);\n');
fs.chmodSync(bin, 0o755);
Object.assign(process.env, { PLATE_DATA_DIR: dir, DEVIN_SESSIONS_DB: db, DEVIN_DESKTOP_STATE: path.join(dir, 'none.vscdb'), DEVIN_BIN: bin, HERDR_APP_BIN: fake, PLATE_NO_SCHEDULE: '1', PLATE_CACHE_DIR: path.join(dir, 'cache') });
const { startReview, runs } = await import('../lib/devinrun.mjs');
const { readItems } = await import('../lib/store.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logged = () => fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('two sessions of one workstream: a space named like it, then a second tab in the same space', async () => {
  startReview(PR1);
  for (let n = 0; n < 50 && !runs[PR1].herdr; n++) await sleep(100);
  assert.equal(runs[PR1].herdr.space, 'My Project');
  let c = logged();
  assert.deepEqual([c[0].cmd, c[0].name, c[0].tab, c[0].folder], ['space.new', 'My Project', 'Review: PR 1', work]);
  assert.deepEqual(c[0].argv, [bin, '--', '/code-review ' + PR1]); // Devin's prompt goes after `--`, never as the task
  assert.equal(c[0].task, undefined);
  addSession('s1'); // what the interactive Devin in the tab does
  for (let n = 0; n < 50 && runs[PR1].state === 'running'; n++) await sleep(200);
  assert.equal(runs[PR1].state, 'done');
  assert.equal(runs[PR1].session, 'session:s1');
  assert.equal(readItems().find((i) => i.tool === 'devin').anchor, PR1);

  startReview(PR2);
  for (let n = 0; n < 50 && !runs[PR2].herdr; n++) await sleep(100);
  c = logged();
  assert.equal(c.length, 2);
  assert.deepEqual([c[1].cmd, c[1].space, c[1].name], ['tab.new', 'sp0', 'Review: PR 2']);
});

test('a ticket without a workstream goes to the shared "Plate" space', async () => {
  startReview(PR3);
  for (let n = 0; n < 50 && !runs[PR3].herdr; n++) await sleep(100);
  assert.equal(runs[PR3].herdr.space, 'Plate');
});

test('Herdr unreachable: the headless run starts instead', async () => {
  process.env.HERDR_APP_BIN = path.join(dir, 'nope');
  const PR4 = 'https://github.com/o/r/pull/4';
  startReview(PR4);
  for (let n = 0; n < 100 && runs[PR4].state === 'running'; n++) await sleep(100);
  assert.equal(runs[PR4].herdr, undefined);
  assert.notEqual(runs[PR4].state, 'running'); // the fake CLI exited 0 at once
});

test('names match case-insensitively; reuseFolder picks the space already open on that folder', async () => {
  process.env.HERDR_APP_BIN = fake;
  fs.writeFileSync(spaces, JSON.stringify([{ id: 'a', name: 'plate', folder: '/x/Plate/', machine: null, tabs: [] }, { id: 'b', name: 'Other', folder: '/y', machine: null, tabs: [] }]));
  const { openInHerdr } = await import('../lib/herdr.mjs');
  assert.equal((await openInHerdr({ workstream: null, folder: '/x/plate', tab: 't', argv: ['x'], reuseFolder: '/x/plate' })).space, 'plate');
  assert.equal((await openInHerdr({ workstream: 'OTHER', folder: '/y', tab: 't', argv: ['x'] })).space, 'Other');
  assert.equal((await openInHerdr({ workstream: 'Fresh', folder: '/z', tab: 't', argv: ['x'] })).space, 'Fresh'); // nothing to reuse: made
});

test('herdr_dir: the tab starts there and the session is matched by that folder', async () => {
  process.env.HERDR_APP_BIN = fake;
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plate-hdir-')));
  fs.writeFileSync(path.join(dir, 'sources.md'), `---\ndevin_review_dir: ${work}\nherdr: on\nherdr_dir: ${other}\n---\n`);
  fs.writeFileSync(spaces, '[]'); fs.writeFileSync(calls, '');
  const PR5 = 'https://github.com/o/r/pull/5';
  fs.appendFileSync(path.join(dir, 'items.jsonl'), JSON.stringify({ id: 'gh:5', source: 'github', kind: 'pr', url: PR5, title: 'PR 5', state: 'open', workstream: null }) + '\n');
  startReview(PR5);
  for (let n = 0; n < 50 && !runs[PR5].herdr; n++) await sleep(100);
  assert.equal(logged()[0].folder, other);
  const now = Math.floor(Date.now() / 1000);
  sdb.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,0,?)').run('s5', 'Greeting', other, 'local', 'm', now, now, 'n5');
  sdb.prepare('INSERT INTO message_nodes VALUES (?,?,?)').run('s5', 'n5', JSON.stringify({ role: 'assistant', content: 'hi' }));
  for (let n = 0; n < 50 && runs[PR5].state === 'running'; n++) await sleep(200);
  assert.equal(runs[PR5].session, 'session:s5');
});
