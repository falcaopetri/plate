// Workstream lifecycle: archive (with its children, deciding what happens to the open items) and restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-arch-'));
process.env.PLATE_DATA_DIR = dir;
fs.mkdirSync(path.join(dir, 'workstreams'));
const ws = (slug, parent = '', extra = '') => fs.writeFileSync(path.join(dir, `workstreams/${slug}.md`), `---\nname: ${slug}\nstate: active\nparent:${parent ? ' ' + parent : ''}\ngithub: [${extra}]\n---\n`);
const reset = () => {
  ws('a', '', 'repo:o/r'); ws('b', 'a'); ws('c'); ws('d', 'b');
  fs.writeFileSync(path.join(dir, 'items.jsonl'), [
    { id: 'x', source: 'todoist', state: 'open', workstream: 'a', title: 'x' },
    { id: 'y', source: 'github', url: 'https://github.com/o/r/pull/1', state: 'open', workstream: 'b', title: 'y' },
    { id: 'z', source: 'todoist', state: 'done', workstream: 'a', title: 'z' },
  ].map((i) => JSON.stringify(i)).join('\n') + '\n');
};
reset();
const store = await import('../lib/store.mjs');
const state = (s) => store.readWorkstreams().find((w) => w.slug === s).state;
const wsOf = (id) => store.readItems().find((i) => i.id === id).workstream;

test('preview counts the open items of the workstream and its children', () => {
  const p = store.archivePreview('a');
  assert.equal(p.open, 2);
  assert.deepEqual(p.kinds, { tasks: 1, PRs: 1 });
  assert.deepEqual(p.children.map((c) => c.slug).sort(), ['b', 'd']);
});

test('archiving with its children sends the open items to the Inbox and hides the repo anchor', () => {
  const r = store.archiveWorkstream('a', { items: 'inbox' });
  assert.deepEqual(r.archived.sort(), ['a', 'b', 'd']);
  assert.equal(r.moved.length, 2);
  assert.equal(wsOf('x'), null); assert.equal(wsOf('y'), null); assert.equal(wsOf('z'), 'a'); // finished ones stay
  assert.equal(state('b'), 'archived');
  assert.equal(store.readWorkstreams().find((w) => w.slug === 'b').archivedWith, 'a');
  assert.equal(store.repoAnchors().get('o/r'), undefined);
  assert.throws(() => store.archiveWorkstream('a'), /already/);
});

test('restore brings the children back with it, to their previous state', () => {
  assert.deepEqual(store.restoreWorkstream('a').restored.sort(), ['a', 'b', 'd']);
  assert.equal(state('a'), 'active'); assert.equal(state('d'), 'active');
  assert.equal(store.readWorkstreams().find((w) => w.slug === 'a').archivedAt, undefined);
  assert.equal(store.repoAnchors().get('o/r'), 'a');
});

test('another workstream as the destination, or leaving the items where they are', () => {
  reset();
  store.archiveWorkstream('b', { items: 'ws', to: 'c' });
  assert.equal(wsOf('y'), 'c');
  assert.throws(() => store.archiveWorkstream('a', { items: 'ws', to: 'd' }), /pick another/); // d is inside a
  reset();
  store.archiveWorkstream('a', { items: 'keep' });
  assert.equal(wsOf('x'), 'a'); assert.equal(wsOf('y'), 'b');
});

test('without children: they move up one level; a restored child under an archived parent becomes a root', () => {
  reset();
  store.archiveWorkstream('b', { cascade: false, items: 'inbox' });
  assert.equal(store.readWorkstreams().find((w) => w.slug === 'd').parent, 'a');
  reset();
  store.archiveWorkstream('a', { items: 'inbox' });
  store.restoreWorkstream('b'); // b was archived with a; restoring b alone
  assert.equal(state('b'), 'active');
  assert.ok(!store.readWorkstreams().find((w) => w.slug === 'b').parent);
});

test('a pasted link, a Teams chat and a note are references: they are not pending items to move', () => {
  reset();
  fs.appendFileSync(path.join(dir, 'items.jsonl'), [
    { id: 'l1', source: 'link', state: 'open', workstream: 'a', title: 'ref' },
    { id: 't1', source: 'teams', state: 'open', workstream: 'a', title: 'chat' },
    { id: 'n1', source: 'note', state: 'open', workstream: 'a', title: 'note' },
    { id: 'g1', source: 'ghref', url: 'https://github.com/o/r/issues/3', state: 'open', workstream: 'a', title: 'ticket' },
  ].map((i) => JSON.stringify(i)).join('\n') + '\n');
  assert.equal(store.archivePreview('a').open, 3); // x, y and the pasted ticket
  store.archiveWorkstream('a');
  assert.equal(wsOf('l1'), 'a'); assert.equal(wsOf('t1'), 'a'); assert.equal(wsOf('n1'), 'a'); // stay (hidden with it)
  assert.equal(wsOf('g1'), null); // the open ticket goes to the Inbox
  reset();
});
