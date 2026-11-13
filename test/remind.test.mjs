import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-remind-'));
process.env.PLATE_DATA_DIR = path.join(dir, 'data');
process.env.PLATE_CACHE_DIR = path.join(dir, 'cache');
fs.mkdirSync(path.join(dir, 'data/workstreams'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data/items.jsonl'), JSON.stringify({ id: 'pr1', source: 'github', kind: 'pr', state: 'open', workstream: null }) + '\n');
const store = await import('../lib/store.mjs');

test('remindOn: quiet before the day, needs you from that day, never when done', () => {
  const t = '2026-11-20';
  const item = store.patchItem('pr1', { remindOn: '2026-11-20' });
  assert.equal(store.needsYou(item, '2026-11-19'), false);
  assert.equal(store.needsYou(item, t), true);
  assert.equal(store.needsYou(item, '2026-11-25'), true);
  assert.equal(store.needsYou({ ...item, state: 'done' }, t), false);
  assert.equal(store.needsYou({ ...item, dismissed: true }, t), false);
  assert.equal(store.needsYou({ ...item, snoozedUntil: new Date(Date.now() + 36e5).toISOString() }, t), false);
});

test('remindOn must be a plain date and clears with an empty value', () => {
  assert.throws(() => store.patchItem('pr1', { remindOn: 'tomorrow' }), /YYYY-MM-DD/);
  const item = store.patchItem('pr1', { remindOn: '' });
  assert.equal(item.remindOn, undefined);
});
