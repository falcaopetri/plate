// Claude Code sessions (collectors/claude.mjs): state from the tail of a transcript, and the collector run against a scratch dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-claude-'));
const projects = path.join(tmp, 'projects', '-Users-a-repo'), data = path.join(tmp, 'data');
fs.mkdirSync(projects, { recursive: true }); fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'items.jsonl'), ''); fs.writeFileSync(path.join(data, 'events.jsonl'), ''); fs.writeFileSync(path.join(data, 'sources.md'), '---\n---\n');
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const rec = (type, min, message, extra = {}) => JSON.stringify({ type, timestamp: ago(min), cwd: '/Users/a/repo', sessionId: 'x', isSidechain: false, message, ...extra });
const text = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] });
const tool = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] };
const write = (id, lines, minAgo = 0) => { const f = path.join(projects, `${id}.jsonl`); fs.writeFileSync(f, lines.join('\n') + '\n'); const t = new Date(Date.now() - minAgo * 60e3); fs.utimesSync(f, t, t); return f; };
const { readSession } = await import('../collectors/claude.mjs');

test('Claude finished its turn: waiting on you; the title is the custom title', () => {
  const f = write('a1', [rec('user', 5, { role: 'user', content: 'fix the bug' }), JSON.stringify({ type: 'custom-title', customTitle: 'Fix login' }), rec('assistant', 1, text('done, take a look'))], 1);
  const s = readSession(f);
  assert.equal(s.title, 'Fix login'); assert.equal(s.state, 'waiting'); assert.equal(s.turn, 'me'); assert.equal(s.cwd, '/Users/a/repo');
});
test('a tool call with nothing back for 90 s is a permission prompt; a fresh one is just running', () => {
  assert.equal(readSession(write('a2', [rec('user', 5, { role: 'user', content: 'go' }), rec('assistant', 3, tool)], 3)).asking, true);
  assert.equal(readSession(write('a3', [rec('user', 5, { role: 'user', content: 'go' }), rec('assistant', 0.1, tool)], 0)).state, 'running');
});
test('quiet for a day = done; no conversation at all = not a session', () => {
  assert.equal(readSession(write('a4', [rec('user', 3000, { role: 'user', content: 'old' }), rec('assistant', 2990, text('ok'))], 2990)).state, 'done');
  assert.equal(readSession(write('a5', [JSON.stringify({ type: 'queue-operation', timestamp: ago(1) })])), null);
});
test('the collector lists recent sessions as tool claude, in the Inbox, and ignores old files', () => {
  write('b1', [rec('user', 5, { role: 'user', content: 'hello there' }), rec('assistant', 4, text('hi'))], 4);
  const old = write('b2', [rec('user', 20000, { role: 'user', content: 'ancient' }), rec('assistant', 19999, text('x'))], 20000);
  execFileSync('node', ['collectors/claude.mjs', '--dir', path.join(tmp, 'projects')], { cwd: root, env: { ...process.env, PLATE_DATA_DIR: data } });
  const items = fs.readFileSync(path.join(data, 'items.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const b1 = items.find((i) => i.id === 'session:claude-b1');
  assert.equal(b1.tool, 'claude'); assert.equal(b1.title, 'hello there'); assert.equal(b1.workstream, null); assert.equal(b1.turn, 'me');
  assert.ok(!items.some((i) => i.id === 'session:claude-b2'));
  assert.ok(old);
});
