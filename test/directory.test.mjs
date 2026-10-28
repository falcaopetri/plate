import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-dir-'));
process.env.PLATE_DATA_DIR = path.join(dir, 'x/Plate');
fs.mkdirSync(process.env.PLATE_DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(dir, 'Atlas/People'), { recursive: true });
process.env.PLATE_DSCL_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dscl-stub.mjs');
const { lookupByEmail } = await import('../lib/directory.mjs');
const store = await import('../lib/store.mjs');

test('lookup by e-mail through dscl: name, role, department, company, photo', async () => {
  const d = await lookupByEmail('jdoe@corp.com');
  assert.deepEqual({ ...d, photo: !!d.photo }, { name: 'Jane Doe', email: 'jdoe@corp.com', role: 'Staff Engineer', department: 'Platform', company: 'Corp', photo: true });
  assert.equal(await lookupByEmail('nobody@corp.com'), null);
  await assert.rejects(lookupByEmail('not an email'), /e-mail/);
});

test('person note: standard properties written, then updated in place without touching the body', () => {
  const n = store.createPerson({ name: 'Jane Doe', email: 'jdoe@corp.com', role: 'Old role' });
  const f = path.join(dir, 'Atlas/People/Jane Doe.md');
  fs.appendFileSync(f, 'Notas minhas.\n');
  store.patchPerson(n, { role: 'Staff Engineer', department: 'Platform', photo: '[[Jane Doe.jpg]]' });
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, /role: Staff Engineer/); assert.match(text, /department: Platform/); assert.match(text, /email: "?jdoe@corp.com/); assert.match(text, /Notas minhas\./);
  assert.equal(store.readContacts(['Jane Doe'])['Jane Doe'].department, 'Platform');
  fs.writeFileSync(path.join(dir, 'Atlas/People/Sem fm.md'), 'só texto\n');
  store.patchPerson('Sem fm', { email: 'a@b.co' });
  assert.match(fs.readFileSync(path.join(dir, 'Atlas/People/Sem fm.md'), 'utf8'), /^---\nin:\n  - "\[\[People\]\]"\nemail: "?a@b.co"?\n---\nsó texto/);
});
