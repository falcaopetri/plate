#!/usr/bin/env node
// Claude Code sessions collector (source "session", tool "claude"): reads the transcripts Claude Code keeps on this machine,
// ~/.claude/projects/<folder>/<session>.jsonl (the Claude desktop app and the CLI write the same files).
//
//   node collectors/claude.mjs [--dir <projects dir>]     default `claude_projects_dir` in sources.md, else ~/.claude/projects
//
// One item per transcript touched within `claude_session_days` (default 3); title = the session's custom title (else the first
// prompt), `cwd` = its folder, `lastActivity` = the last record. State:
//   waiting (turn: me)  the last turn is Claude's text (or the prompt was interrupted): your move
//   waiting (asking)    Claude ended on a tool call and nothing came back for 90 s: most likely a permission prompt
//   running             anything else, while the file is fresh (< 10 min); older than that it is waiting on you too
//   done                no activity for `claude_active_hours` (default 3): it stays listed, but no longer asks for you
// There is no known deep link to open a session in the Claude app, so `url` is null (the card shows the folder).
// Only the tail of each file is read (transcripts reach tens of MB). A new item goes to the Inbox; moving it sticks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsert } from '../lib/upsert.mjs';
import { readSources } from '../lib/store.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const src = readSources();
const DIR = arg('dir') || src.claude_projects_dir || path.join(os.homedir(), '.claude/projects');
const DAYS = Number(src.claude_session_days) || 3, ACTIVE_H = Number(src.claude_active_hours) || 3; // wider windows listed 88 sessions, 38 "waiting", on a real machine
const TAIL = 1024 * 1024, HEAD = 64 * 1024;

function slice(file, from, len) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(len); const n = fs.readSync(fd, buf, 0, len, from); return buf.toString('utf8', 0, n); } finally { fs.closeSync(fd); }
}
const records = (text, dropFirst) => (dropFirst ? text.slice(text.indexOf('\n') + 1) : text).split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const textOf = (m) => (typeof m?.content === 'string' ? m.content : (m?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' '));
const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export function readSession(file, now = Date.now()) {
  const st = fs.statSync(file), id = path.basename(file, '.jsonl');
  const tail = records(slice(file, Math.max(0, st.size - TAIL), TAIL), st.size > TAIL);
  const head = st.size > TAIL ? records(slice(file, 0, Math.min(HEAD, st.size)), false) : [];
  const all = [...head, ...tail];
  const turns = all.filter((r) => (r.type === 'user' || r.type === 'assistant') && !r.isSidechain && !r.isMeta && r.message);
  if (!turns.length) return null; // only queue operations / hooks: not a conversation
  const titleRec = [...all].reverse().find((r) => (r.type === 'custom-title' && r.customTitle) || (r.type === 'agent-name' && r.agentName));
  const firstPrompt = turns.find((r) => r.type === 'user' && clean(textOf(r.message)) && !/^\[|^<(command|local)/.test(clean(textOf(r.message))));
  const title = clean(titleRec?.customTitle || titleRec?.agentName || textOf(firstPrompt?.message)).slice(0, 120) || id.slice(0, 8);
  const cwd = [...all].reverse().find((r) => r.cwd)?.cwd || null;
  const last = turns[turns.length - 1];
  const stamps = all.map((r) => Date.parse(r.timestamp)).filter(Number.isFinite);
  const lastAt = Math.max(st.mtimeMs, ...stamps.slice(-50)), age = now - lastAt;
  const blocks = Array.isArray(last.message.content) ? last.message.content : [];
  const pendingTool = last.type === 'assistant' && blocks.some((b) => b.type === 'tool_use');
  const interrupted = last.type === 'user' && /^\[Request interrupted/.test(clean(textOf(last.message)));
  const claudeSpoke = last.type === 'assistant' && !pendingTool;
  let state, turn, asking;
  if (age > ACTIVE_H * 36e5) state = 'done';
  else if (claudeSpoke || interrupted) { state = 'waiting'; turn = 'me'; }
  else if (pendingTool && age > 90e3) { state = 'waiting'; turn = 'me'; asking = true; }
  else if (age > 10 * 60e3) { state = 'waiting'; turn = 'me'; }
  else state = 'running';
  return { id, title, cwd, state, turn, asking, lastActivity: new Date(lastAt).toISOString(), created: new Date(Math.min(...stamps, st.birthtimeMs || lastAt)).toISOString() };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const cutoff = Date.now() - DAYS * 864e5, found = [];
  if (fs.existsSync(DIR)) {
    for (const d of fs.readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      for (const f of fs.readdirSync(path.join(DIR, d.name)).filter((n) => n.endsWith('.jsonl'))) {
        const file = path.join(DIR, d.name, f);
        try { if (fs.statSync(file).mtimeMs < cutoff) continue; const s = readSession(file); if (s) found.push(s); } catch (e) { console.error(`claude: ${f}: ${e.message}`); }
      }
    }
  }
  const incoming = found.map((s) => ({
    id: `session:claude-${s.id}`, source: 'session', kind: 'session', tool: 'claude', url: null, title: s.title, cwd: s.cwd, state: s.state,
    turn: s.turn ?? null, asking: s.asking ?? false, lastActivity: s.lastActivity, created: s.created,
  }));
  upsert('session', incoming, { closedStates: ['gone'], owns: (it) => it.tool === 'claude' });
  console.log(`claude: ${found.length} sessions in the last ${DAYS} days (${found.filter((s) => s.state === 'waiting').length} waiting on you)`);
}
