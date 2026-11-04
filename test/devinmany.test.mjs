// "Review N PRs in Devin": one CLI run, one prompt listing every PR, the same run state on each of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-many-'));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plate-manywork-')));
const A = 'https://github.com/o/r/pull/1', B = 'https://github.com/o/r/pull/2';
fs.mkdirSync(path.join(dir, 'workstreams'));
fs.writeFileSync(path.join(dir, 'sources.md'), `---\ndevin_review_dir: ${work}\n---\n`);
fs.writeFileSync(path.join(dir, 'items.jsonl'), '');
fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
const argvFile = path.join(dir, 'argv.json');
const bin = path.join(dir, 'devin-fake.mjs');
fs.writeFileSync(bin, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`);
fs.chmodSync(bin, 0o755);
Object.assign(process.env, { PLATE_DATA_DIR: dir, DEVIN_SESSIONS_DB: path.join(dir, 'none.db'), DEVIN_DESKTOP_STATE: path.join(dir, 'none.vscdb'), DEVIN_BIN: bin, PLATE_NO_SCHEDULE: '1', PLATE_CACHE_DIR: path.join(dir, 'cache') });
const { startReviewMany, runs } = await import('../lib/devinrun.mjs');

test('needs two to ten real PR urls', () => {
  assert.throws(() => startReviewMany([A]), /at least two/);
  assert.throws(() => startReviewMany([A, A]), /at least two/); // duplicates collapse
  assert.throws(() => startReviewMany([A, 'https://github.com/o/r/issues/3']), /not a GitHub PR/);
});

test('one run, a prompt with every PR, and the run shared by each PR', async () => {
  const r = startReviewMany([A, `${B}#discussion`]);
  assert.deepEqual(r.urls, [A, B]);
  assert.equal(runs[A], runs[B]);
  assert.throws(() => startReviewMany([B, 'https://github.com/o/r/pull/9']), /already running/);
  for (let n = 0; n < 50 && !fs.existsSync(argvFile); n++) await new Promise((ok) => setTimeout(ok, 100));
  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert.equal(argv[0], '-p');
  assert.ok(argv[1].includes(A) && argv[1].includes(B));
  for (let n = 0; n < 50 && runs[A].state === 'running'; n++) await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(runs[A].state, 'done');
});
