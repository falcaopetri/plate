import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PLATE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-events-'));
const store = await import('../lib/store.mjs');

const at = (day, h, workstream) => ({ ts: new Date(`${day}T${h}:00:00`).toISOString(), workstream, type: 'item.new' });
const log = [at('2026-10-20', '09', 'a'), at('2026-10-24', '10', 'b'), at('2026-10-24', '18', 'a'), at('2026-10-28', '08', null)];

test('eventsBetween is inclusive on local days', () => {
  assert.equal(store.eventsBetween(log, '2026-10-24', '2026-10-24').length, 2);
  assert.equal(store.eventsBetween(log, '2026-10-22', '2026-10-28').length, 3);
  assert.equal(store.eventsBetween(log, '2026-11-01', '2026-11-02').length, 0);
});

test('activitySummary: last event per workstream and where the log starts', () => {
  const { last, since } = store.activitySummary(log);
  assert.equal(since, log[0].ts);
  assert.equal(last.a, log[2].ts);
  assert.equal(last.b, log[1].ts);
  assert.deepEqual(store.activitySummary([]), { last: {}, since: null });
});
