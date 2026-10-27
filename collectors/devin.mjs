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
// `devin.desktopShell.localSessionAnnotations.<org>` hold {"devin-acp/devin-cli/<id>": {archived, done, folder, parent}}.
// Mapping: archived or done there -> state `done`; otherwise `idle` (no reliable running/waiting signal).
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

// session id -> {archived, done, folder}; empty when Desktop was never installed on this machine
async function annotations() {
  if (!fs.existsSync(stateDb)) { console.warn(`devin: no Desktop state at ${stateDb}; archived sessions can't be told apart`); return new Map(); }
  const rows = await query(stateDb, "SELECT value FROM ItemTable WHERE key LIKE 'devin.desktopShell.localSessionAnnotations.%'");
  const out = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(JSON.parse(String(r.value)))) out.set(k.split('/').pop(), v);
  }
  return out;
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

const notes = await annotations();
const rows = await query(db, 'SELECT id, title, working_directory, backend_type, model, created_at, last_activity_at, hidden FROM sessions');
const incoming = rows.map((r) => {
  const a = notes.get(r.id) || {};
  return {
    id: `session:${r.id}`, source: 'session', kind: 'session', tool: 'devin', url: link(r),
    title: r.title || `Devin session ${String(r.id).slice(0, 8)}`, cwd: r.working_directory || null,
    model: r.model || null, lastActivity: iso(r.last_activity_at) || null, devinFolder: a.folder || null,
    state: a.archived || a.done || Number(r.hidden) ? 'done' : 'idle', created: iso(r.created_at),
  };
});
upsert('session', incoming, { closedStates: ['gone'], owns: (it) => it.tool === 'devin' });
