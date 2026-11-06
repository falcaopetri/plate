// My tickets (collectors/mine.mjs): author/assignee/mention searches, activity by someone else, absorption by the GitHub collector,
// and the "Needs you" rules that depend on them. Real collectors against a stub `gh` and a scratch data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const U = (n, kind = 'issues') => `https://github.com/o/r/${kind}/${n}`;
const ago = (h) => new Date(Date.now() - h * 36e5).toISOString();
const node = (n, extra = {}) => ({ __typename: 'Issue', url: U(n), number: n, title: `issue ${n}`, createdAt: ago(100), updatedAt: ago(1), author: { login: 'me' }, repository: { nameWithOwner: 'o/r' }, comments: { nodes: [] }, ...extra });
const comment = (login, h, text = 'hello') => ({ author: { login }, createdAt: ago(h), bodyText: text });

function setup({ sources = '', items = [], fixture }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-test-'));
  fs.mkdirSync(path.join(dir, 'workstreams'));
  fs.writeFileSync(path.join(dir, 'workstreams/proj.md'), '---\nname: Proj\nstate: active\nparent:\ngithub: ["repo:o/r"]\n---\n');
  fs.writeFileSync(path.join(dir, 'sources.md'), `---\n${sources}\n---\n`);
  fs.writeFileSync(path.join(dir, 'items.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'fx.json'), JSON.stringify(fixture));
  const run = (c = 'mine') => execFileSync('node', [`collectors/${c}.mjs`], { cwd: root, encoding: 'utf8', env: { ...process.env, PLATE_DATA_DIR: dir, PLATE_GH_BIN: path.join(root, 'test/gh-stub.mjs'), STUB_GH: path.join(dir, 'fx.json') } });
  const read = () => fs.readFileSync(path.join(dir, 'items.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { run, read, dir };
}

test('author + assignee + mention of the same ticket is one item with all three reasons, routed by repo anchor', () => {
  const t = setup({ fixture: { mine: { author: [node(1)], assignee: [node(1), node(2)], mention: [node(1), node(3)] } } });
  t.run();
  const items = t.read();
  assert.equal(items.length, 3);
  assert.deepEqual(items.find((i) => i.number === 1).mineWhy, ['author', 'assignee', 'mention']);
  assert.ok(items.every((i) => i.source === 'mine' && i.workstream === 'proj' && i.state === 'open'));
});

test('activity = newest comment by someone else within mine_days; my own and old ones do not count', () => {
  const t = setup({ fixture: { mine: { author: [
    node(1, { comments: { nodes: [comment('bob', 30, 'old one'), comment('me', 2), comment('alice', 5, 'please look')] } }),
    node(2, { comments: { nodes: [comment('me', 1)] } }),
    node(3, { comments: { nodes: [comment('bob', 24 * 20)] } }),
    node(4, { __typename: 'PullRequest', url: U(4, 'pull'), comments: { nodes: [] }, reviews: { nodes: [{ author: { login: 'carol' }, createdAt: ago(3), bodyText: 'needs work', state: 'CHANGES_REQUESTED' }] } }),
  ] } } });
  t.run();
  const by = (n) => t.read().find((i) => i.number === n);
  assert.equal(by(1).activity.by, 'alice');
  assert.equal(by(1).activity.text, 'please look');
  assert.equal(by(2).activity, undefined);
  assert.equal(by(3).activity, undefined);
  assert.deepEqual([by(4).kind, by(4).activity.what, by(4).activity.by], ['pr', 'review', 'carol']);
});

test('a ticket already on the plate is flagged, not duplicated; flags clear when it stops matching', () => {
  const held = { id: 'github:X', source: 'github', kind: 'issue', url: U(1), title: 'issue 1', state: 'open', workstream: 'proj' };
  const t = setup({ items: [held], fixture: { mine: { author: [node(1, { comments: { nodes: [comment('bob', 2)] } })] } } });
  t.run();
  let items = t.read();
  assert.equal(items.length, 1);
  assert.equal(items[0].activity.by, 'bob');
  assert.deepEqual(items[0].mineWhy, ['author']);
  fs.writeFileSync(path.join(t.dir, 'fx.json'), JSON.stringify({ mine: {} }));
  t.run();
  items = t.read();
  assert.equal(items.length, 1);
  assert.equal(items[0].activity, undefined);
  assert.equal(items[0].mineWhy, undefined);
});

test('a mine item goes gone when it stops matching, and the GitHub collector absorbs it keeping its workstream', () => {
  const t = setup({ fixture: { mine: { author: [node(1)] }, repos: { 'o/r': [{ id: 'I_1', url: U(1), number: 1, title: 'issue 1', state: 'OPEN', repository: { nameWithOwner: 'o/r' }, assignees: { nodes: [] }, parent: null }] }, known: {} } });
  t.run();
  assert.equal(t.read()[0].source, 'mine');
  const items = t.read(); items[0].workstream = 'proj'; fs.writeFileSync(path.join(t.dir, 'items.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  t.run('github');
  const after = t.read();
  assert.deepEqual(after.map((i) => i.source), ['github']);
  assert.equal(after[0].workstream, 'proj');
});

test('Needs you: Devin turn=me, new activity until seen, never when archived', async () => {
  const { needsYou } = await import('../lib/store.mjs');
  const sess = (o) => ({ source: 'session', state: 'idle', ...o });
  assert.ok(needsYou(sess({ turn: 'me' })));
  assert.ok(!needsYou(sess({ turn: 'devin' })));
  assert.ok(!needsYou(sess({ turn: 'me', state: 'done' })));
  const tk = (o) => ({ source: 'mine', state: 'open', activity: { at: '2026-10-28T10:00:00Z' }, ...o });
  assert.ok(needsYou(tk({})));
  assert.ok(!needsYou(tk({ activitySeen: '2026-10-28T11:00:00Z' })));
  assert.ok(!needsYou(tk({ dismissed: true })));
  assert.ok(needsYou(tk({ activitySeen: '2026-10-28T09:00:00Z' })));
});

test('sources.md settings: edit in place, keep unknown keys and the body, empty removes, bad values rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-test-'));
  fs.writeFileSync(path.join(dir, 'sources.md'), '---\ngithub_projects: [a/1]\ncollect: off\nweird_key: keep me\npeople:\n  - octo: o@x.com\n---\nBody stays.\n');
  const out = execFileSync('node', ['--input-type=module', '-e', `
    import { patchSources, readSettings } from './lib/store.mjs';
    patchSources({ github_projects: 'a/1, b/2', collect: '', devin_review_model: 'opus', stale_days: '5' });
    let bad = []; for (const p of [{ stale_days: 'x' }, { collect: 'maybe' }, { nope: '1' }]) { try { patchSources(p); } catch (e) { bad.push(e.message); } }
    console.log(JSON.stringify({ bad, v: readSettings().values }));`], { cwd: root, encoding: 'utf8', env: { ...process.env, PLATE_DATA_DIR: dir } });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(r.v.github_projects, ['a/1', 'b/2']);
  assert.equal(r.v.collect, '');
  assert.equal(r.v.devin_review_model, 'opus');
  assert.equal(r.bad.length, 3);
  const text = fs.readFileSync(path.join(dir, 'sources.md'), 'utf8');
  assert.match(text, /weird_key: keep me/);
  assert.match(text, /people:\n {2}- octo: o@x.com/);
  assert.match(text, /Body stays\./);
  assert.doesNotMatch(text, /collect:/);
});

test('github_query -status: a board item the board collector dropped does not come back as mine:', () => {
  const stale = { id: 'github:I_1', source: 'github', kind: 'issue', url: U(1), title: 'old', status: 'Stale', state: 'gone', workstream: 'proj' };
  const t = setup({ sources: 'github_query: "-status:Cancelled,Done,Stale"', items: [stale], fixture: { mine: { author: [node(1), node(2)], assignee: [], mention: [] } } });
  t.run();
  assert.deepEqual(t.read().filter((i) => i.source === 'mine').map((i) => i.number), [2]);
});
test('without that term the same ticket does come back', () => {
  const stale = { id: 'github:I_1', source: 'github', kind: 'issue', url: U(1), title: 'old', status: 'Stale', state: 'gone', workstream: 'proj' };
  const t = setup({ items: [stale], fixture: { mine: { author: [node(1)], assignee: [], mention: [] } } });
  t.run();
  assert.equal(t.read().filter((i) => i.source === 'mine').length, 1);
});
