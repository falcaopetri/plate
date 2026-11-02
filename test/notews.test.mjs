// A vault note as a workstream: `note:` points at it, its text and to-dos are the note's, ticking writes into the note.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-note-'));
const dir = path.join(vault, 'x', 'Plate');
fs.mkdirSync(path.join(dir, 'workstreams'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Atlas', 'Sources'), { recursive: true });
fs.writeFileSync(path.join(dir, 'items.jsonl'), '');
fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
const book = path.join(vault, 'Atlas', 'Sources', 'Livro Bom.md');
fs.writeFileSync(book, '---\ntags: [livro]\n---\nIntro do livro.\n\n- [ ] ler capítulo 1\n- [x] comprar\n\n' + 'x'.repeat(2000) + '\n');
process.env.PLATE_DATA_DIR = dir;
const s = await import('../lib/store.mjs');

test('a note becomes a workstream that points at it, once', () => {
  assert.deepEqual(s.searchNotes('livro bom'), ['Livro Bom']);
  const r = s.workstreamFromNote('[[Livro Bom]]', '');
  assert.equal(r.existing, false);
  assert.equal(s.workstreamFromNote('Livro Bom', '').slug, r.slug);
  const w = s.readWorkstreams().find((x) => x.slug === r.slug);
  assert.equal(w.name, 'Livro Bom'); assert.equal(w.note, 'Livro Bom'); assert.equal(w.noteMissing, false);
  assert.match(w.body, /^Intro do livro\./);
  assert.ok(w.body.length < 800, 'long note text is cut');
  assert.deepEqual(w.body.split('\n').filter((l) => /^- \[/.test(l)), ['- [ ] ler capítulo 1', '- [x] comprar']);
});

test('ticking and adding to-dos write into the note, not the workstream file', () => {
  const slug = s.readWorkstreams()[0].slug;
  s.setTodo(slug, 0, 'ler capítulo 1', true);
  s.addTodo(slug, 'resenha');
  const txt = fs.readFileSync(book, 'utf8');
  assert.match(txt, /- \[x\] ler capítulo 1/);
  assert.match(txt, /- \[ \] resenha/);
  assert.ok(txt.startsWith('---\ntags: [livro]\n---\n'), 'note frontmatter untouched');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'workstreams', `${slug}.md`), 'utf8'), /resenha/);
});

test('unknown note is refused; unlinking works', () => {
  assert.throws(() => s.workstreamFromNote('Não existe', ''), /not found/);
  const slug = s.readWorkstreams()[0].slug;
  assert.throws(() => s.updateWorkstream(slug, { note: 'Não existe' }), /not found/);
  s.updateWorkstream(slug, { note: '' });
  const w = s.readWorkstreams()[0];
  assert.equal(w.note, null); assert.doesNotMatch(w.body, /Intro/);
});
