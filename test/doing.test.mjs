import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-doing-'));
const tn = path.join(dir, 'tn');
process.env.PLATE_DATA_DIR = path.join(dir, 'data');
fs.mkdirSync(path.join(dir, 'data/workstreams'), { recursive: true });
fs.mkdirSync(tn);
fs.writeFileSync(path.join(dir, 'data/sources.md'), `---\ntasknotes_dir: ${tn}\ndoing_limit: 2\n---\n`);
for (const s of ['a', 'b']) fs.writeFileSync(path.join(dir, `data/workstreams/${s}.md`), `---\nname: ${s}\nstate: active\nparent:\n---\n`);
fs.writeFileSync(path.join(tn, 'T.md'), '---\ntitle: T\nstatus: open\ndateModified: x\n---\nbody\n');
fs.writeFileSync(path.join(dir, 'data/items.jsonl'), [
  { id: 'x', source: 'note', state: 'open', workstream: null },
  { id: 'tasknotes:T.md', source: 'tasknotes', title: 'T', state: 'open', workstream: 'a' },
  { id: 'tasknotes:R.md', source: 'tasknotes', title: 'R', state: 'open', recurring: true, workstream: 'a' },
].map((i) => JSON.stringify(i)).join('\n') + '\n');
const store = await import('../lib/store.mjs');

test('doing now keeps slots until dropped and stops at doing_limit', () => {
  assert.equal(store.doingLimit(), 2);
  store.setDoing('ws', 'a', true);
  store.setDoing('ws', 'a', true); // already there
  store.setDoing('item', 'x', true);
  assert.equal(store.readDoing().length, 2);
  assert.throws(() => store.setDoing('ws', 'b', true), /full/);
  assert.throws(() => store.setDoing('ws', 'nope', true), /full|unknown/);
  store.setDoing('ws', 'a', 'x', 'stopped at the test'); // note keeps the slot
  assert.equal(store.readDoing()[0].note, 'stopped at the test');
  assert.equal(store.setDoing('ws', 'a', false).length, 1);
  assert.equal(store.setDoing('ws', 'b', true).length, 2);
});

test('a TaskNotes task is marked done in its own file and can be reopened', () => {
  store.setTaskDone('tasknotes:T.md', true);
  const txt = fs.readFileSync(path.join(tn, 'T.md'), 'utf8');
  assert.match(txt, /^status: done$/m);
  assert.match(txt, /^completedDate: \d{4}-\d{2}-\d{2}$/m);
  assert.match(txt, /---\nbody\n$/);
  assert.equal(store.readItems().find((i) => i.id === 'tasknotes:T.md').state, 'done');
  store.setTaskDone('tasknotes:T.md', false);
  const back = fs.readFileSync(path.join(tn, 'T.md'), 'utf8');
  assert.match(back, /^status: open$/m);
  assert.doesNotMatch(back, /completedDate/);
});

test('recurring and foreign items are refused', () => {
  assert.throws(() => store.setTaskDone('tasknotes:R.md', true), /recurring/);
  assert.throws(() => store.setTaskDone('x', true), /not a TaskNotes/);
});
