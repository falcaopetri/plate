import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-rules-'));
process.env.PLATE_DATA_DIR = dir;
fs.mkdirSync(path.join(dir, 'workstreams'));
fs.writeFileSync(path.join(dir, 'workstreams/proj.md'), '---\nname: Proj\nstate: active\nparent:\ngithub: ["repo:O/R"]\npeople: ["[[Ana]]"]\n---\n');
fs.writeFileSync(path.join(dir, 'items.jsonl'), [
  { id: 'a', source: 'ghref', repo: 'o/r', state: 'done', workstream: null },
  { id: 'b', source: 'github', repo: 'x/y', state: 'open', workstream: null },
].map((i) => JSON.stringify(i)).join('\n') + '\n');
const store = await import('../lib/store.mjs');

test('repo anchors are case-insensitive and route closed items too', () => {
  assert.deepEqual([...store.repoAnchors().keys()], ['o/r']);
  assert.equal(store.applyRules(), 1);
  assert.equal(store.readItems().find((i) => i.id === 'a').workstream, 'proj');
  assert.equal(store.readItems().find((i) => i.id === 'b').workstream, null);
});

test('workstream people read as plain names and write back as wikilinks', () => {
  assert.deepEqual(store.readWorkstreams()[0].people, ['Ana']);
  store.updateWorkstream('proj', { people: ['Ana', 'Beto', ' Beto '] });
  assert.match(fs.readFileSync(path.join(dir, 'workstreams/proj.md'), 'utf8'), /people: \["\[\[Ana\]\]", "\[\[Beto\]\]"\]/);
});

test('TaskNotes tasks need you when due today or earlier', () => {
  assert.ok(store.needsYou({ source: 'tasknotes', state: 'open', due: '2000-01-01' }));
  assert.ok(!store.needsYou({ source: 'tasknotes', state: 'open', due: '2999-01-01' }));
});

test('createTask and createPerson write the plugin/note formats and never overwrite', () => {
  fs.mkdirSync(path.join(dir, '../TaskNotes/Tasks'), { recursive: true });
  const name = store.createTask({ title: 'Ligar: banco', due: '2026-10-30', workstream: 'proj' });
  const body = fs.readFileSync(path.join(dir, '../TaskNotes/Tasks', name), 'utf8');
  assert.match(body, /status: open/); assert.match(body, /due: 2026-10-30/); assert.match(body, /\[\[Proj\]\]/);
  assert.notEqual(store.createTask({ title: 'Ligar: banco' }), name);
  assert.throws(() => store.createTask({ title: 'x', due: 'amanhã' }), /YYYY-MM-DD/);
  process.env.HOME = dir; fs.writeFileSync(path.join(dir, 'sources.md'), `---\npeople_dir: ${dir}/people\n---\n`); fs.mkdirSync(path.join(dir, 'people'));
  assert.equal(store.createPerson({ name: 'Ana Souza', role: 'PO' }), 'Ana Souza');
  assert.throws(() => store.createPerson({ name: 'Ana Souza' }), /already exists/);
});
