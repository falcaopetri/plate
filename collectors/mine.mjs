#!/usr/bin/env node
// My-tickets collector: open issues and PRs that I opened, am assigned to, or was mentioned in, live via `gh` (no board needed),
// plus "someone else commented since I last looked" as `activity`.
//
//   node collectors/mine.mjs                 the three searches below
//   node collectors/mine.mjs --query "…"     one other search (testing), counted as `author`
//
// Like reviews.mjs, an item already on the plate from another source (board item, pasted ghref, repo anchor) is not duplicated:
// it just gets the flags. Only tickets found nowhere else become `mine:<url>` items (state open; `gone` when they stop matching).
// Owned fields here, set on every match and cleared everywhere else on each run: `mineWhy` (author|assignee|mention) and `activity`
// ({at, by, what, text}: the newest comment or review by someone other than me, at most `mine_days` old, default 7).
// "Needs you" = activity newer than the item's `activitySeen` (the UI sets it when you open the ticket or tick it off).
// Routing on creation: the workstream with a `repo:` anchor for the ticket's repo, else the Inbox.
import { execFileSync } from 'node:child_process';
import { upsert } from '../lib/upsert.mjs';
import { readItems, writeItems, repoAnchors, readSources } from '../lib/store.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const SEARCHES = arg('query') ? [['author', arg('query')]] : [
  ['author', 'is:open author:@me archived:false'],
  ['assignee', 'is:open assignee:@me archived:false'],
  ['mention', 'is:open mentions:@me archived:false'],
];
const DAYS = Number(readSources().mine_days) || 7;
const COMMENT = 'comments(last: 3) { nodes { author { login } createdAt bodyText } }';
const query = `query($q: String!, $after: String) { viewer { login } search(query: $q, type: ISSUE, first: 50, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes {
    ... on Issue { __typename url number title createdAt updatedAt author { login } repository { nameWithOwner } ${COMMENT} }
    ... on PullRequest { __typename url number title isDraft createdAt updatedAt author { login } repository { nameWithOwner } ${COMMENT}
      reviews(last: 3) { nodes { author { login } createdAt bodyText state } } } } } }`;

let me = null;
const found = new Map(); // url -> {node, why: Set}
for (const [why, q] of SEARCHES) {
  for (let after = null, page = 0; page < 4; page++) { // 200 per search is plenty; a mention search in a big repo could be endless
    const out = execFileSync(process.env.PLATE_GH_BIN || 'gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `q=${q}`, ...(after ? ['-f', `after=${after}`] : [])], { encoding: 'utf8', timeout: 45e3 });
    const j = JSON.parse(out).data;
    me = j.viewer.login;
    for (const n of j.search.nodes.filter((x) => x && x.url)) {
      const cur = found.get(n.url) || { node: n, why: new Set() };
      cur.why.add(why); found.set(n.url, cur);
    }
    if (!j.search.pageInfo.hasNextPage) break;
    after = j.search.pageInfo.endCursor;
  }
}

const cutoff = Date.now() - DAYS * 864e5;
const activityOf = (n) => {
  const evs = [...(n.comments?.nodes || []).map((c) => ({ ...c, what: 'comment' })), ...(n.reviews?.nodes || []).map((c) => ({ ...c, what: 'review' }))]
    .filter((c) => c.author?.login && c.author.login !== me && Date.parse(c.createdAt) >= cutoff)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const e = evs[0];
  return e ? { at: e.createdAt, by: e.author.login, what: e.what, text: String(e.bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 140) } : undefined;
};
const flags = new Map([...found].map(([url, { node, why }]) => [canon(url), { why: [...why], activity: activityOf(node) }]));
function canon(u) { return String(u || '').replace(/[#?].*$/, '').replace(/\/$/, ''); }

const items = readItems();
const elsewhere = new Set(items.filter((i) => i.source !== 'mine' && i.state !== 'gone' && i.url).map((i) => canon(i.url)));
let flagged = 0;
for (const i of items) {
  if (i.source === 'mine') continue; // its own fields come from the upsert below
  const f = i.state !== 'gone' && i.url ? flags.get(canon(i.url)) : null;
  const same = JSON.stringify(i.mineWhy) === JSON.stringify(f?.why) && JSON.stringify(i.activity) === JSON.stringify(f?.activity);
  if (same) continue;
  if (f) { i.mineWhy = f.why; if (f.activity) i.activity = f.activity; else delete i.activity; } else { delete i.mineWhy; delete i.activity; }
  flagged++;
}
if (flagged) writeItems(items);

// github_query "-status:Cancelled,Done,Stale": a board item the board collector dropped (state gone) with such a Status is not
// "already on the plate", but must not come back here as `mine:` either. Other terms (-label:) are not mirrored.
const excluded = new Set(String(readSources().github_query || '').split(/\s+/).filter((t) => /^-status:/i.test(t))
  .flatMap((t) => t.replace(/^-status:/i, '').replace(/^"|"$/g, '').split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean));
const dropped = new Set(items.filter((i) => i.source === 'github' && i.state === 'gone' && i.url && excluded.has(String(i.status || '').toLowerCase())).map((i) => canon(i.url)));
const repoWs = repoAnchors();
const incoming = [...found].filter(([url]) => !elsewhere.has(canon(url)) && !dropped.has(canon(url))).map(([url, { node: n, why }]) => ({
  id: `mine:${url}`, source: 'mine', kind: n.__typename === 'PullRequest' ? 'pr' : 'issue', url, title: n.title, repo: n.repository.nameWithOwner, number: n.number,
  author: n.author?.login || null, draft: n.isDraft || undefined, ghState: 'open', status: 'Mine', state: 'open', mineWhy: [...why],
  activity: activityOf(n), created: n.createdAt, lastActivity: n.updatedAt, workstream: repoWs.get(n.repository.nameWithOwner.toLowerCase()),
}));
upsert('mine', incoming, { closedStates: ['gone'] });
console.log(`mine: ${found.size} tickets as ${me}, ${flagged} flagged on existing items`);
