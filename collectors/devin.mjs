#!/usr/bin/env node
// Devin collector: local Devin sessions (CLI and Desktop share one store) as session items.
//
//   node collectors/devin.mjs [--db path] [--state path]
//     --db     default $DEVIN_SESSIONS_DB, else ~/.local/share/devin/cli/sessions.db           (sessions)
//     --state  default $DEVIN_DESKTOP_STATE, else Devin Desktop's User/globalStorage/state.vscdb (archive flags)
//
// Reads both SQLite DBs read-only instead of `devin list`, which only lists one cwd and caps at 50 rows.
// Needs `node:sqlite` (Node >= 22.5) or the `sqlite3` CLI on PATH.
// Archiving is a Desktop annotation, not a column of sessions.db: keys
// `devin.desktopShell.localSessionAnnotations.<org>` held {"devin-acp/devin-cli/<id>": {archived, done, folder, parent}} (legacy);
// current Desktops keep a JSON array of "acp/devin-cli/<id>" under `windsurf.acp.session/archivedSessions`.
// Mapping: archived or done there -> state `done`; idle for `devin_waiting_minutes` (default 2) -> `waiting` (= Needs you);
// otherwise `idle`. `turn` (me|devin) = who the last message left the move to.
// url = devin:// deep link that opens the session in Devin Desktop (see `link`).
// Only items with tool `devin` are owned here, so `collect:sessions` dump items are left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { upsert } from '../lib/upsert.mjs';
import { readSources } from '../lib/store.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const db = arg('db') || process.env.DEVIN_SESSIONS_DB || path.join(os.homedir(), '.local/share/devin/cli/sessions.db');
const appSupport = process.platform === 'win32' ? process.env.APPDATA
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : path.join(os.homedir(), '.config');
const stateDb = arg('state') || process.env.DEVIN_DESKTOP_STATE || path.join(appSupport || '', 'Devin/User/globalStorage/state.vscdb');

async function query(file, sql) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const h = new DatabaseSync(file, { readOnly: true });
    try { return h.prepare(sql).all(); } finally { h.close(); }
  } catch (e) {
    if (e.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && e.code !== 'ERR_UNKNOWN_BUILTIN_MODULE_NAME') throw e;
    const out = execFileSync('sqlite3', ['-readonly', '-json', file, sql], { encoding: 'utf8', maxBuffer: 64e6 });
    return out.trim() ? JSON.parse(out) : [];
  }
}

// session id -> {archived, done, folder}; empty when Desktop was never installed on this machine. Two formats, both read:
//   current: ItemTable key `windsurf.acp.session/archivedSessions` = JSON array of refs like "acp/devin-cli/<id>"
//   legacy:  any key naming `localSessionAnnotations` = {"devin-acp/devin-cli/<id>": {archived, done, folder, parent}}
// Absent, unreadable or malformed data only means "nothing archived": it must never stop the collection.
const ARCHIVED_KEY = 'windsurf.acp.session/archivedSessions';
async function annotations(file = stateDb) {
  const out = new Map();
  if (!fs.existsSync(file)) { console.warn(`devin: no Desktop state at ${file}; archived sessions can't be told apart`); return out; }
  let rows;
  try {
    // LIKE for the legacy key (the prefix has differed between Desktop generations), so an older Desktop's archive flags still count
    rows = await query(file, `SELECT key, value FROM ItemTable WHERE key = '${ARCHIVED_KEY}' OR key LIKE '%ocalSessionAnnotations%'`);
  } catch (e) { console.warn(`devin: can't read the Desktop state (${String(e.message).split('\n')[0]}); archived sessions can't be told apart`); return out; }
  for (const r of rows) {
    let o; try { o = JSON.parse(String(r.value)); } catch { continue; }
    if (r.key === ARCHIVED_KEY) {
      for (const ref of Array.isArray(o) ? o : []) if (typeof ref === 'string' && ref) out.set(ref.split('/').pop(), { ...out.get(ref.split('/').pop()), archived: true });
    } else if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) out.set(k.split('/').pop(), { ...v });
    }
  }
  return out;
}

// The Desktop's own session list: ItemTable `windsurf.acp.metadataCache` = {sessions: [{sessionId (or "acp/devin-cli/<id>"), providerId,
// status, title, updatedAt, isWaiting}]}. `isWaiting: true` = the session is stopped asking you something (a command to approve, a
// question): the one signal sessions.db lacks, and Cascade-provider sessions are only listed here (never in sessions.db).
// `_meta['cognition.ai/isArchived']` is where the Desktop records archiving a Cascade session (archivedSessions never listed it, 2026-11-02).
// Unreadable/missing = no sessions (never stops the collection).
async function liveSessions(file = stateDb) {
  if (!fs.existsSync(file)) return [];
  try {
    const [r] = await query(file, "SELECT value FROM ItemTable WHERE key = 'windsurf.acp.metadataCache'");
    const list = JSON.parse(String(r?.value || '{}')).sessions;
    return (Array.isArray(list) ? list : []).filter((x) => x && x.sessionId).map((x) => ({ ...x, id: String(x.sessionId).split('/').pop() }));
  } catch (e) { console.warn(`devin: can't read the Desktop session list (${String(e.message).split('\n')[0]})`); return []; }
}

// A CLI session stopped on a permission prompt (command, request_scope…) writes nothing to sessions.db: its head is an assistant message
// whose tool calls have no result yet, same as a tool that is running. The CLI process logs it though, in
// <cli dir>/logs/devin_<stamp>_<pid>.log: `... Permission decision for tool <name>: prompting user` (no session id in the line).
// `session_locks/<session>.lock` holds the pid, so: head waiting on tool calls + that process alive + a "prompting user" line at or after
// the last message's save time = asking (the row's main_chain_id can lag behind a running session, so the last node is used). Answered/denied -> a tool result node is saved and the last node changes. Heuristic, seen on CLI 2026-11-02.
const cliDir = path.dirname(db);
function promptingUser(id, lastActivityMs) {
  try {
    const pid = Number(fs.readFileSync(path.join(cliDir, 'session_locks', `${id}.lock`), 'utf8').trim());
    if (!pid) return false;
    try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
    const logs = path.join(cliDir, 'logs'), f = fs.readdirSync(logs).filter((n) => n.endsWith(`_${pid}.log`)).sort().pop();
    if (!f) return false;
    const fd = fs.openSync(path.join(logs, f), 'r'), size = fs.fstatSync(fd).size, len = Math.min(size, 262144), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const hits = [...buf.toString('utf8').matchAll(/^(\S+Z)\s+\w+\s+\S+: Permission decision for tool [^:\n]+: prompting user/gm)];
    return hits.length > 0 && Date.parse(hits.at(-1)[1]) >= lastActivityMs - 2000;
  } catch { return false; }
}

const iso = (t) => (t ? new Date(t < 1e12 ? t * 1000 : t).toISOString() : undefined); // epoch s or ms
// Two Desktop generations, two link handlers (sources.md `devin_link`):
//   shell (default; Desktop 3.11+): the shell routes `devin://app/return/<base64url(path)>` to an in-app path,
//         a local session's page being /sessions/<encoded "acp/devin-cli/<id>">. Here the acp form says "This session doesn't exist".
//   acp   (older Desktop, e.g. 3.4, where the editor UI is the app): `devin://acp/session?sessionId=<id>&connectorId=devin-cli`.
// Cloud sessions always use the acp form, untested.
const LINK = readSources().devin_link === 'acp' ? 'acp' : 'shell';
const link = (r) => /cloud/i.test(r.backend_type || '')
  ? `devin://acp/session?sessionId=${encodeURIComponent(`devin-${String(r.id).replace(/^devin-/, '')}`)}&connectorId=devin-cloud`
  : LINK === 'acp' ? `devin://acp/session?sessionId=${encodeURIComponent(r.id)}&connectorId=devin-cli`
  : `devin://app/return/${Buffer.from(`/sessions/${encodeURIComponent(`acp/devin-cli/${r.id}`)}`).toString('base64url')}`;

// A session needs the human when nobody has touched it for `devin_waiting_minutes` (sources.md, default 2: the prompt cache lasts 5 min, so a session untouched for 2 is one worth resuming): Devin is done
// and waiting for an answer, or stalled. `turn` says whose move the last message left: `me` = Devin's final text (no tool call
// pending), `devin` = it was mid-work. Archived/done sessions never wait.
const WAIT_MIN = Number(readSources().devin_waiting_minutes ?? 2);
const notes = await annotations();
const rows = await query(db, `SELECT s.id, s.title, s.working_directory, s.backend_type, s.model, s.created_at, s.last_activity_at, s.hidden,
  json_extract(n.chat_message, '$.role') AS head_role, json_array_length(json_extract(n.chat_message, '$.tool_calls')) AS head_tools,
  substr(n.chat_message, 1, 600) AS head_raw,
  (SELECT json_extract(t.chat_message, '$.role') FROM message_nodes t WHERE t.session_id = s.id ORDER BY t.node_id DESC LIMIT 1) AS tail_role,
  (SELECT json_array_length(json_extract(t.chat_message, '$.tool_calls')) FROM message_nodes t WHERE t.session_id = s.id ORDER BY t.node_id DESC LIMIT 1) AS tail_tools
  FROM sessions s LEFT JOIN message_nodes n ON n.session_id = s.id AND n.node_id = s.main_chain_id`);
// Devin's last message ended its turn (text with no tool call), or the last tool call was cancelled/interrupted: either way it won't
// continue by itself. The cancelled case is matched on the tool result's text (role `tool`), not verified against a real cancelled run.
const yoursTurn = (r) => (r.head_role === 'assistant' && !Number(r.head_tools)) || (r.head_role === 'tool' && /cancel|interrupt|abort|denied|rejected/i.test(r.head_raw || ''));
const live = new Map((await liveSessions()).map((x) => [x.id, x]));
const incoming = rows.map((r) => {
  const a = notes.get(r.id) || {};
  const lastMs = r.last_activity_at < 1e12 ? r.last_activity_at * 1000 : r.last_activity_at;
  const asking = !!live.get(r.id)?.isWaiting || (r.tail_role === 'assistant' && Number(r.tail_tools) > 0 && promptingUser(r.id, lastMs));
  const archived = !!(a.archived || a.done || Number(r.hidden) || live.get(r.id)?._meta?.['cognition.ai/isArchived']);
  const idleMin = (Date.now() - (r.last_activity_at < 1e12 ? r.last_activity_at * 1000 : r.last_activity_at)) / 6e4;
  return {
    id: `session:${r.id}`, source: 'session', kind: 'session', tool: 'devin', url: link(r),
    title: r.title || `Devin session ${String(r.id).slice(0, 8)}`, cwd: r.working_directory || null,
    model: r.model || null, lastActivity: iso(r.last_activity_at) || null, devinFolder: a.folder || null,
    state: archived ? 'done' : asking || idleMin >= WAIT_MIN ? 'waiting' : 'idle', created: iso(r.created_at),
    turn: archived ? undefined : asking || yoursTurn(r) ? 'me' : 'devin', asking: asking && !archived ? true : undefined, // always assigned: upsert keeps fields a run doesn't set
  };
});
// Desktop-only sessions (Cascade provider, never in sessions.db): listed from the cache; no deep link is known for them
const known = new Set(rows.map((r) => String(r.id)));
for (const x of live.values()) {
  if (known.has(x.id) || x.providerId === 'devin-cli') continue;
  const archived = !!(notes.get(x.id)?.archived || notes.get(x.id)?.done || x._meta?.['cognition.ai/isArchived']);
  incoming.push({
    id: `session:${x.id}`, source: 'session', kind: 'session', tool: 'devin', url: null, title: x.title || `Cascade session ${x.id.slice(0, 8)}`,
    cwd: x.workspaceDirs?.[0] || null, model: null, lastActivity: x.updatedAt ? new Date(x.updatedAt).toISOString() : null, devinFolder: null,
    state: archived ? 'done' : x.isWaiting ? 'waiting' : 'idle', created: x._meta?.['cognition.ai/createdAt'] || x.updatedAt || undefined,
    turn: archived ? undefined : x.isWaiting ? 'me' : 'devin', asking: x.isWaiting && !archived ? true : undefined, provider: x.providerId,
  });
}
upsert('session', incoming, { closedStates: ['gone'], owns: (it) => it.tool === 'devin' });
const nArch = incoming.filter((x) => x.state === 'done').length;
console.log(`devin: ${incoming.length} sessions, ${nArch} archived (${notes.size} annotations), ${incoming.filter((x) => x.turn === 'me').length} on your turn`);
if (incoming.length && !notes.size) console.warn('devin: no archive annotations found in the Desktop state; archived sessions will look open');
