// Read-only transcript of a local Devin session, from Devin's own sessions.db (`message_nodes` is a forest; the session's
// `main_chain_id` is the head of the chain Devin shows, so walking parents from it skips abandoned branches).
// Only user/assistant text is returned: system prompts, tool payloads and reasoning stay out. Needs `node:sqlite` (Node >= 22.5).
import os from 'node:os';
import path from 'node:path';
import { BadRequest } from './store.mjs';

const db = () => process.env.DEVIN_SESSIONS_DB || path.join(os.homedir(), '.local/share/devin/cli/sessions.db');
const text = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : '';

export async function transcript(id) {
  if (!/^[\w.-]+$/.test(String(id || ''))) throw new BadRequest('bad session id');
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { throw new BadRequest('transcripts need Node >= 22.5 (node:sqlite)'); }
  const h = new DatabaseSync(db(), { readOnly: true });
  try {
    const s = h.prepare('SELECT id, title, model, working_directory, main_chain_id FROM sessions WHERE id = ?').get(id);
    if (!s) throw new BadRequest('session not found in Devin\'s local store (cloud sessions have no local transcript)');
    const nodes = new Map(h.prepare('SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ?').all(id).map((r) => [r.node_id, r]));
    const chain = [];
    for (let n = nodes.get(s.main_chain_id), guard = 0; n && guard < 100000; n = nodes.get(n.parent_node_id), guard++) chain.push(n);
    const messages = chain.reverse().flatMap((n) => {
      let m; try { m = JSON.parse(n.chat_message); } catch { return []; }
      const t = text(m.content).trim();
      return (m.role === 'user' || m.role === 'assistant') && t ? [{ role: m.role, text: t, at: m.metadata?.created_at || new Date(n.created_at * 1000).toISOString() }] : [];
    });
    return { id: s.id, title: s.title, model: s.model, cwd: s.working_directory, messages };
  } finally { h.close(); }
}
