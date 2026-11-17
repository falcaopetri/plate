import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-b1114-'));
process.env.PLATE_DATA_DIR = path.join(dir, 'data');
process.env.PLATE_CACHE_DIR = path.join(dir, 'cache');
fs.mkdirSync(path.join(dir, 'data/workstreams'), { recursive: true });
fs.writeFileSync(path.join(dir, 'data/workstreams/otw.md'), '---\nname: On the way back\nstate: active\n---\n');
fs.writeFileSync(path.join(dir, 'data/sources.md'), '---\nsession_routes:\n  - /Users/me/Not Synced/on-the-way-back > otw\n  - ~/other > nope\n---\n');
fs.writeFileSync(path.join(dir, 'data/items.jsonl'), [
  { id: 's1', source: 'session', cwd: '/Users/me/Not Synced/on-the-way-back/sub', state: 'waiting', workstream: null },
  { id: 's2', source: 'session', cwd: '/Users/me/.local/share/shepherdr/worktrees/on-the-way-back/task-27-x', state: 'waiting', workstream: null },
  { id: 's3', source: 'session', cwd: '/Users/me/Not Synced/on-the-way-back-2', state: 'waiting', workstream: null },
  { id: 's4', source: 'session', cwd: '/Users/me/other/x', state: 'waiting', workstream: null }, // route to a slug that does not exist
].map((x) => JSON.stringify(x)).join('\n') + '\n');
const store = await import('../lib/store.mjs');

test('session_routes: folder prefix and worktree repo name route sessions; unknown slug or sibling folder do not', () => {
  assert.equal(store.applyRules(), 2);
  const by = Object.fromEntries(store.readItems().map((i) => [i.id, i.workstream]));
  assert.equal(by.s1, 'otw'); assert.equal(by.s2, 'otw'); assert.equal(by.s3, null); assert.equal(by.s4, null);
});

test('request images: saved under requests-img, read back, bad names refused', () => {
  const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
  const name = store.saveRequestImage(png);
  assert.match(name, /^req-\d{12}-1\.png$/);
  assert.equal(store.readRequestImage(name).buf.toString(), 'fakepng');
  assert.throws(() => store.saveRequestImage('data:text/html;base64,AAAA'), /image required/);
  assert.throws(() => store.readRequestImage('../sources.md'), /bad image name/);
});
