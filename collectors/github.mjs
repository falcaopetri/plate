#!/usr/bin/env node
// GitHub Projects (v2) collector: issues + PRs (+ drafts) of project boards -> items.jsonl.
//
//   node collectors/github.mjs                                 live: every board in sources.md `github_projects: [owner/N, …]`
//   node collectors/github.mjs --owner <owner> --project <N>   live: one board
//   ... [--query "assignee:@me -status:Done"]                  live only: Projects filter syntax
//   node collectors/github.mjs --file dump.json                dump: `gh project item-list N --owner O --format json` (no parent info)
//
// Live goes through `gh api graphql` (needs `gh auth refresh -s read:project`), because item-list has no parent issue.
//
// Mapping: kind = issue | pr | draft. `status` / `iteration` = the board's Status single-select and iteration field.
// state: `open`; `done` when Status is Done/Closed/Merged or the issue/PR is closed/merged; `gone` when it left every board.
// Routing on creation (one board mixes workstreams):
//   1. a workstream anchor `issue:<owner/repo>#<N>` (an epic) claims the epic, its sub-issues at any depth,
//      and PRs that close any of those;
//   2. else a `repo:<owner/name>` anchor; 3. else the Inbox.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upsert } from '../lib/upsert.mjs';
import { readWorkstreams, readItems, writeItems, readSources } from '../lib/store.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };

// `owner/repo#N`, `issue:` prefix or a full url -> canonical issue url
const issueUrl = (s) => {
  const m = String(s).replace(/^issue:/, '').match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/issues\/)(\d+)/);
  return m ? `https://github.com/${m[1]}/issues/${m[2]}` : null;
};
const repoWs = new Map(), epicWs = new Map();
for (const w of readWorkstreams()) for (const a of w.github) {
  if (a.startsWith('repo:')) repoWs.set(a.slice(5), w.slug);
  if (a.startsWith('issue:') && issueUrl(a)) epicWs.set(issueUrl(a), w.slug);
}

// ---------- live: GraphQL ----------
const PARENTS = 'parent { url parent { url parent { url parent { url } } } }'; // 4 levels of epics
const ITEMS = `items(first: 100, after: $cursor, query: $q) {
  pageInfo { hasNextPage endCursor }
  nodes { id
    fieldValues(first: 30) { nodes {
      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldIterationValue { title }
    } }
    content {
      ... on DraftIssue { title }
      ... on Issue { url number title state repository { nameWithOwner } assignees(first: 10) { nodes { login } } ${PARENTS} }
      ... on PullRequest { url number title state isDraft repository { nameWithOwner } assignees(first: 10) { nodes { login } }
        closingIssuesReferences(first: 5) { nodes { url ${PARENTS} } } }
    }
  }
}`;
const gql = (query, vars) => {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) if (v != null) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'] }));
};
const chain = (n) => { const out = []; for (let p = n?.parent; p; p = p.parent) out.push(p.url); return out; };

function fetchBoard(owner, number) {
  const q = arg('query') || '';
  let kind = 'organization', cursor = null, nodes = [];
  for (;;) {
    const query = `query($owner: String!, $number: Int!, $cursor: String, $q: String) { ${kind}(login: $owner) { projectV2(number: $number) { ${ITEMS} } } }`;
    let res;
    try { res = gql(query, { owner, number: Number(number), cursor, q }); }
    catch (e) {
      if (kind === 'organization' && !cursor && /Could not resolve to an Organization/i.test(String(e.stderr))) { kind = 'user'; continue; }
      throw new Error(`github: ${owner}/${number}: ${String(e.stderr || e.message).trim()}`);
    }
    const page = res.data[kind].projectV2.items;
    nodes = nodes.concat(page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    cursor = page.pageInfo.endCursor;
  }
}
const fromGraphql = (n) => {
  const c = n.content || {}, fv = n.fieldValues?.nodes || [];
  const status = fv.find((v) => v.field?.name === 'Status')?.name || null;
  const iteration = fv.find((v) => 'title' in v)?.title || null;
  const isPr = 'closingIssuesReferences' in c, isIssue = !isPr && 'number' in c;
  const closes = isPr ? c.closingIssuesReferences.nodes : [];
  return {
    id: n.id, kind: isPr ? 'pr' : isIssue ? 'issue' : 'draft', url: c.url || null, title: c.title, repo: c.repository?.nameWithOwner || null,
    number: c.number ?? null, status, iteration, assignees: c.assignees?.nodes.map((a) => a.login), closed: /^(closed|merged)$/i.test(c.state || ''), ghState: c.state ? c.state.toLowerCase() : null,
    parent: isIssue ? c.parent?.url || null : undefined, closes: isPr ? closes.map((x) => x.url) : undefined,
    lineage: isIssue ? chain(c) : closes.flatMap((x) => [x.url, ...chain(x)]), // the epics this item could belong to, nearest first
  };
};
// item-list dump shape: no parents, so only repo routing applies
const fromItemList = (it) => {
  const c = it.content || {};
  return {
    id: it.id, kind: c.type === 'PullRequest' ? 'pr' : c.type === 'Issue' ? 'issue' : 'draft', url: c.url || null, title: it.title || c.title,
    repo: (typeof c.repository === 'string' ? c.repository : typeof it.repository === 'string' ? it.repository : '').replace(/^https:\/\/github.com\//, '') || null,
    number: c.number ?? null, status: it.status || null, iteration: (it.iteration && typeof it.iteration === 'object' ? it.iteration.title : it.iteration) || null,
    assignees: Array.isArray(it.assignees) ? it.assignees : undefined, closed: /^(closed|merged)$/i.test(c.state || ''), ghState: c.state ? c.state.toLowerCase() : null, lineage: [],
  };
};

const boards = arg('owner') && arg('project') ? [`${arg('owner')}/${arg('project')}`] : arg('file') ? [] : readSources().github_projects;
let raw;
if (boards.length) {
  raw = boards.flatMap((b) => {
    const m = String(b).match(/^([\w.-]+)\/(\d+)$/);
    if (!m) throw new Error(`github: bad board "${b}" in sources.md (want owner/N)`);
    return fetchBoard(m[1], m[2]).map(fromGraphql);
  });
} else {
  const file = arg('file') || path.join(root, '.cache/github.json');
  raw = (JSON.parse(fs.readFileSync(file, 'utf8')).items || []).map(fromItemList);
}

const DONE = /^(done|closed|merged|shipped)$/i;
const incoming = [], seen = new Set();
for (const r of raw) {
  if (!r.url && r.kind !== 'draft') continue; // redacted / inaccessible content
  if (seen.has(r.id)) continue;
  seen.add(r.id);
  const epic = [r.url, ...r.lineage].find((u) => epicWs.has(u));
  incoming.push({
    id: `github:${r.id}`, source: 'github', kind: r.kind, url: r.url, title: r.title, repo: r.repo, number: r.number,
    status: r.status, iteration: r.iteration, assignees: r.assignees, parent: r.parent, closes: r.closes, ghState: r.ghState,
    state: DONE.test(r.status || '') || r.closed ? 'done' : 'open',
    workstream: (epic && epicWs.get(epic)) ?? repoWs.get(r.repo) ?? undefined,
  });
}

// A pasted link (`ghref`) for an item now on a board is replaced by the collected item, keeping its workstream.
const all = readItems(), refs = new Map(all.filter((x) => x.source === 'ghref').map((x) => [x.url, x]));
const absorbed = incoming.filter((x) => refs.has(x.url));
for (const x of absorbed) x.workstream = refs.get(x.url).workstream ?? x.workstream;
if (absorbed.length) writeItems(all.filter((x) => !(x.source === 'ghref' && absorbed.some((a) => a.url === x.url))));
upsert('github', incoming, { closedStates: ['gone'] });
