import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-tddone-'));
process.env.PLATE_DATA_DIR = path.join(dir, 'data');
fs.mkdirSync(path.join(dir, 'data/workstreams'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data/items.jsonl'), JSON.stringify({ id: 'todoist:42', source: 'todoist', title: 'T', state: 'open', workstream: null }) + '\n');
const calls = [];
const srv = http.createServer((req, res) => { calls.push(`${req.method} ${req.url} ${req.headers.authorization}`); res.end('{}'); });
await new Promise((r) => srv.listen(0, r));
process.env.TODOIST_API_BASE = `http://127.0.0.1:${srv.address().port}`;
const store = await import('../lib/store.mjs');

test('Todoist done needs the token, then closes and reopens through the API', async () => {
  delete process.env.TODOIST_API_TOKEN;
  await assert.rejects(store.setTodoistDone('todoist:42', true), /TODOIST_API_TOKEN/);
  process.env.TODOIST_API_TOKEN = 'tok';
  assert.equal((await store.setTodoistDone('todoist:42', true)).state, 'done');
  assert.equal((await store.setTodoistDone('todoist:42', false)).state, 'open');
  assert.deepEqual(calls, ['POST /tasks/42/close Bearer tok', 'POST /tasks/42/reopen Bearer tok']);
  await assert.rejects(store.setTodoistDone('todoist:nope', true), /not a Todoist/);
  srv.close();
});
