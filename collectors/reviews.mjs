#!/usr/bin/env node
// Review requests collector: open PRs that request a review from *me* directly (not through a team), live via `gh`.
//
//   node collectors/reviews.mjs                 search `is:pr is:open user-review-requested:@me archived:false`
//   node collectors/reviews.mjs --query "…"     any other search (testing)
//
// A requested PR already on the plate from another source (board item, pasted ghref) is not duplicated:
// that item just gets `reviewMe: true`. Only PRs found nowhere else become `review:<url>` items.
// `reviewMe` is owned here: set on every requested PR, cleared everywhere else on each run.
// A `review` item whose request went away (reviewed, withdrawn, merged) becomes `gone`.
// Routing on creation: the workstream with a `repo:` anchor for the PR's repo, else the Inbox.
import { execFileSync } from 'node:child_process';
import { upsert } from '../lib/upsert.mjs';
import { readItems, writeItems, readWorkstreams } from '../lib/store.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const q = arg('query') || 'is:pr is:open user-review-requested:@me archived:false';
const query = `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 100, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { ... on PullRequest { url number title isDraft state createdAt updatedAt author { login } repository { nameWithOwner } } } } }`;

const prs = [];
for (let after = null, page = 0; page < 10; page++) {
  const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `q=${q}`, ...(after ? ['-f', `after=${after}`] : [])], { encoding: 'utf8', timeout: 30e3 });
  const s = JSON.parse(out).data.search;
  prs.push(...s.nodes.filter((n) => n.url));
  if (!s.pageInfo.hasNextPage) break;
  after = s.pageInfo.endCursor;
}

const wanted = new Set(prs.map((p) => p.url));
const items = readItems();
const elsewhere = new Set(items.filter((i) => i.source !== 'review' && i.state !== 'gone' && i.url).map((i) => i.url.replace(/[#?].*$/, '')));
let flagged = 0;
for (const i of items) {
  const on = i.state !== 'gone' && !!i.url && wanted.has(i.url.replace(/[#?].*$/, ''));
  if (!!i.reviewMe !== on) { if (on) i.reviewMe = true; else delete i.reviewMe; flagged++; }
}
if (flagged) writeItems(items);

const repoWs = new Map();
for (const w of readWorkstreams()) for (const a of w.github) if (a.startsWith('repo:')) repoWs.set(a.slice(5), w.slug);
const incoming = prs.filter((p) => !elsewhere.has(p.url)).map((p) => ({
  id: `review:${p.url}`, source: 'review', kind: 'pr', url: p.url, title: p.title, repo: p.repository.nameWithOwner, number: p.number,
  author: p.author?.login || null, draft: p.isDraft || undefined, ghState: 'open', status: 'Review requested', reviewMe: true,
  state: 'open', created: p.createdAt, lastActivity: p.updatedAt, workstream: repoWs.get(p.repository.nameWithOwner),
}));
upsert('review', incoming, { closedStates: ['gone'] });
