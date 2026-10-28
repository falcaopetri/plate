import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-top3-'));
process.env.PLATE_DATA_DIR = dir;
fs.mkdirSync(path.join(dir, 'workstreams'));
for (const s of ['a', 'b']) fs.writeFileSync(path.join(dir, `workstreams/${s}.md`), `---\nname: ${s}\nstate: active\nparent:\n---\n`);
fs.writeFileSync(path.join(dir, 'items.jsonl'), ['x', 'y'].map((id) => JSON.stringify({ id, source: 'note', state: 'open', workstream: null })).join('\n') + '\n');
const store = await import('../lib/store.mjs');

test('pins keep order, ignore duplicates and stop at three', () => {
  assert.deepEqual(store.readTop3('2026-10-28'), []);
  store.setTop3('2026-10-28', 'ws', 'a', true);
  store.setTop3('2026-10-28', 'item', 'x', true);
  store.setTop3('2026-10-28', 'ws', 'a', true); // already pinned: no second slot
  assert.deepEqual(store.readTop3('2026-10-28'), [{ type: 'ws', ref: 'a' }, { type: 'item', ref: 'x' }]);
  store.setTop3('2026-10-28', 'item', 'y', true);
  assert.throws(() => store.setTop3('2026-10-28', 'ws', 'b', true), /full/);
  assert.equal(store.setTop3('2026-10-28', 'item', 'x', false).length, 2);
});

test('each day starts empty, and only known things can be pinned', () => {
  assert.deepEqual(store.readTop3('2026-10-29'), []);
  assert.throws(() => store.setTop3('2026-10-29', 'ws', 'nope', true), /unknown/);
  assert.throws(() => store.setTop3('2026-10-29', 'task', 'a', true), /type/);
});

test('prev = the latest earlier day that ended with pins', () => {
  assert.equal(store.readTop3Prev('2026-10-28'), null);
  assert.deepEqual(store.readTop3Prev('2026-10-29').pins.map((p) => p.ref).sort(), ['a', 'y']);
  assert.equal(store.readTop3Prev('2026-10-29').day, '2026-10-28');
  store.setTop3('2026-10-30', 'ws', 'b', true); store.setTop3('2026-10-30', 'ws', 'b', false); // emptied: skipped
  assert.equal(store.readTop3Prev('2026-10-31').day, '2026-10-28');
});
