// `repo:` anchors as a collection source (collectors/github.mjs). Runs the real collector against a stub `gh` and a scratch data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const U = (n, kind = 'issues') => `https://github.com/o/r/${kind}/${n}`;
const issue = (n, state = 'OPEN') => ({ id: `I_${n}`, url: U(n), number: n, title: `issue ${n}`, state, repository: { nameWithOwner: 'o/r' }, assignees: { nodes: [] }, parent: null });
const pr = (n, state = 'OPEN') => ({ id: `PR_${n}`, url: U(n, 'pull'), number: n, title: `pr ${n}`, state, isDraft: false, repository: { nameWithOwner: 'o/r' }, assignees: { nodes: [] }, closingIssuesReferences: { nodes: [] } });

function setup({ sources = '', items = [], fixture }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-test-'));
  fs.mkdirSync(path.join(dir, 'workstreams'));
  fs.writeFileSync(path.join(dir, 'workstreams/proj.md'), '---\nname: Proj\nstate: active\nparent:\ngithub: ["repo:o/r"]\n---\n');
  fs.writeFileSync(path.join(dir, 'sources.md'), `---\n${sources}\n---\n`);
  fs.writeFileSync(path.join(dir, 'items.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'fx.json'), JSON.stringify(fixture));
  const run = () => execFileSync('node', ['collectors/github.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, PLATE_DATA_DIR: dir, PLATE_GH_BIN: path.join(root, 'test/gh-stub.mjs'), STUB_GH: path.join(dir, 'fx.json') } });
  const read = () => fs.readFileSync(path.join(dir, 'items.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { run, read };
}

test('no board: open issues and PRs of an anchored repo land in its workstream', () => {
  const t = setup({ fixture: { repos: { 'o/r': [issue(1), pr(2)] }, known: {} } });
  t.run();
  const items = t.read();
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.workstream === 'proj' && i.state === 'open' && i.source === 'github'));
  assert.deepEqual(items.map((i) => i.kind).sort(), ['issue', 'pr']);
});

test('board + repo: the same url is one item, the board one (with its Status) wins', () => {
  const t = setup({ sources: 'github_projects: [o/1]', fixture: { board: [{ ...pr(2), status: 'In review' }], repos: { 'o/r': [issue(1), pr(2)] }, known: {} } });
  t.run();
  const items = t.read();
  assert.equal(items.filter((i) => i.url === U(2, 'pull')).length, 1);
  assert.equal(items.find((i) => i.url === U(2, 'pull')).id, 'github:PVTI_0');
  assert.equal(items.find((i) => i.url === U(2, 'pull')).status, 'In review');
  assert.equal(items.length, 2);
  t.run(); // idempotent: a second run adds nothing
  assert.equal(t.read().length, 2);
});

test('known closed items stay current; closed history is not imported', () => {
  const held = { id: 'github:I_5', source: 'github', kind: 'issue', url: U(5), title: 'issue 5', repo: 'o/r', number: 5, state: 'open', workstream: 'proj', created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };
  const ghref = { id: 'ghref:abcd', source: 'ghref', kind: 'pr', url: U(18, 'pull'), title: 'pr 18', repo: 'o/r', number: 18, status: 'Merged', state: 'done', workstream: null, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };
  const t = setup({ items: [held, ghref], fixture: { repos: { 'o/r': [issue(1)] }, known: { [U(5)]: issue(5, 'CLOSED'), [U(18, 'pull')]: pr(18, 'MERGED') } } });
  t.run();
  const items = t.read();
  assert.equal(items.find((i) => i.id === 'github:I_5').state, 'done', 'closed since last run: done, not gone');
  const p18 = items.find((i) => i.url === U(18, 'pull'));
  assert.equal(p18.source, 'github');
  assert.equal(p18.ghState, 'merged');
  assert.equal(p18.state, 'done');
  assert.equal(p18.workstream, 'proj', 'the merged PR is routed by the repo anchor');
  assert.ok(!items.some((i) => i.source === 'ghref'), 'the pasted link was absorbed');
  assert.ok(!items.some((i) => i.url === U(99)), 'no closed history imported');
  t.run();
  assert.equal(t.read().find((i) => i.id === 'github:I_5').state, 'done', 'still done (not gone) on the next run');
});
