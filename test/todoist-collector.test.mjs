import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';

test('todoist collector: pulls the Inbox filter and skips tasks in the dump section', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-todo-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(decodeURIComponent(req.url));
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/sections')) return res.end(JSON.stringify({ results: [{ id: 'S1', name: 'Dump' }, { id: 'S2', name: 'Next' }] }));
    res.end(JSON.stringify({ results: [
      { id: 'a', content: 'keep', section_id: 'S2', priority: 1 },
      { id: 'b', content: 'dumped', section_id: 'S1', priority: 1 },
      { id: 'c', content: 'no section', section_id: null, priority: 1 },
    ] }));
  });
  await new Promise((ok) => srv.listen(0, ok));
  const env = { ...process.env, PLATE_DATA_DIR: path.join(dir, 'data'), TODOIST_API_TOKEN: 't', TODOIST_API_BASE: `http://127.0.0.1:${srv.address().port}` };
  await new Promise((ok, no) => { const c = spawn(process.execPath, ['collectors/todoist.mjs'], { env, stdio: 'ignore' }); c.on('exit', (code) => (code ? no(new Error('exit ' + code)) : ok())); });
  srv.close();
  const ids = fs.readFileSync(path.join(dir, 'data/items.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id).sort();
  assert.deepEqual(ids, ['todoist:a', 'todoist:c']);
  assert.ok(seen.some((u) => u.includes('#Inbox')));
});
