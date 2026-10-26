// Shared collector upsert: items are matched by id; `workstream` is only taken from the
// incoming record when the item is created (drags always win afterwards).
import { readItems, writeItems, appendEvent, DATA_DIR } from './store.mjs';

const FIELDS_KEPT = new Set(['id', 'workstream', 'created', 'updated']);

// incoming: [{id, source, url, title, state, created?, workstream?, ...extras}]
// A previously seen item of `source` that is missing from `incoming` and not in `closedStates` becomes `gone`.
export function upsert(source, incoming, { closedStates = ['gone'] } = {}) {
  const now = new Date().toISOString();
  const items = readItems();
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set();
  let added = 0, updated = 0, gone = 0;

  for (const inc of incoming) {
    seen.add(inc.id);
    const { workstream, created, ...fresh } = inc;
    const cur = byId.get(inc.id);
    if (!cur) {
      items.push({ ...fresh, workstream: workstream ?? null, created: created || now, updated: now });
      appendEvent({ source, workstream: workstream ?? null, type: 'item.new', title: inc.title, ref: inc.id });
      added++;
      continue;
    }
    const changed = Object.keys(fresh).some((k) => !FIELDS_KEPT.has(k) && JSON.stringify(cur[k]) !== JSON.stringify(fresh[k]));
    if (changed) {
      if (cur.state !== fresh.state) {
        appendEvent({ source, workstream: cur.workstream, type: 'item.state', title: inc.title, ref: inc.id, from: cur.state, to: fresh.state });
      }
      Object.assign(cur, fresh, { updated: now });
      updated++;
    }
  }
  for (const i of items) {
    if (i.source === source && !seen.has(i.id) && !closedStates.includes(i.state)) {
      i.state = 'gone'; i.updated = now; gone++;
      appendEvent({ source, workstream: i.workstream, type: 'item.gone', title: i.title, ref: i.id });
    }
  }
  writeItems(items);
  console.log(`${source}: ${incoming.length} pulled, ${added} new, ${updated} updated, ${gone} gone -> ${DATA_DIR}/items.jsonl`);
}
