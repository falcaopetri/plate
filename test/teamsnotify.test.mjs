// Archiving the Devin review session opens the Teams draft to the PR's author (e-mail from `people:`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-teams-'));
const out = path.join(dir, 'opened.txt');
const opener = path.join(dir, 'open-fake.mjs');
fs.writeFileSync(opener, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(out)}, process.argv[2] + '\\n');\n`);
fs.chmodSync(opener, 0o755);
fs.mkdirSync(path.join(dir, 'workstreams'));
fs.writeFileSync(path.join(dir, 'sources.md'), '---\npeople:\n  - anas: ana.souza@corp.com\n---\n');
const PR = 'https://github.com/o/r/pull/5';
const write = (state) => fs.writeFileSync(path.join(dir, 'items.jsonl'), [
  { id: 'gh:5', source: 'github', kind: 'pr', url: PR, title: 'Fix it', state: 'open', author: 'anas' },
  { id: 'session:s1', source: 'session', tool: 'devin', anchor: PR, state },
].map((i) => JSON.stringify(i)).join('\n') + '\n');
Object.assign(process.env, { PLATE_DATA_DIR: dir, PLATE_OPEN_BIN: opener, PLATE_NO_SCHEDULE: '1', PLATE_CACHE_DIR: path.join(dir, 'cache') }); // keep the test's log lines out of the real plate.log
const t = await import('../lib/teamsnotify.mjs');

test('only a session that turns done between runs opens the chat, once', async () => {
  write('idle');
  const before = t.snapshotSessions();
  assert.equal(await t.notifyArchived(before), 0); // nothing changed
  write('done');
  assert.equal(await t.notifyArchived(before), 1);
  for (let n = 0; n < 100 && !fs.existsSync(out); n++) await new Promise((ok) => setTimeout(ok, 50)); // the fake opener is a spawned process: wait for it, up to 5 s
  const url = fs.readFileSync(out, 'utf8').trim();
  assert.match(url, /^msteams:\/\/.*users=ana\.souza%40corp\.com/);
  assert.match(decodeURIComponent(url), /Fix it/);
  assert.equal(await t.notifyArchived(before), 0); // already notified
});

test('already archived before, or switched off: nothing opens', async () => {
  write('done');
  fs.appendFileSync(path.join(dir, 'sources.md'), '');
  assert.equal(await t.notifyArchived(t.snapshotSessions()), 0);
});
