#!/usr/bin/env node
// GitHub Projects (v2) collector: issues + PRs (+ drafts) of project boards -> items.jsonl.
//
//   node collectors/github.mjs                                 live: every board in sources.md `github_projects: [owner/N, …]`
//   node collectors/github.mjs --owner <owner> --project <N>   live: one board
//   ... [--query "assignee:@me -status:Done"]                  live only: Projects filter syntax
//   node collectors/github.mjs --file dump.json                dump: `gh project item-list N --owner O --format json` (no parent info)
//
// `repo:<owner/name>` anchors on workstreams are a source too: open issues and PRs of each anchored repo are pulled and routed to
// its workstream, with or without a board. A board item wins over the same url pulled from the repo (dedupe by url); items already
// known (collected, or a pasted `ghref`) from an anchored repo are re-fetched whatever their state, so a merged PR stays current
// and nothing closed is imported that wasn't already here.
// `PLATE_GH_BIN` swaps the `gh` binary (tests use a stub).
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
import { readWorkstreams, readItems, writeItems, readSources, repoAnchors } from '../lib/store.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };

// `owner/repo#N`, `issue:` prefix or a full url -> canonical issue url
const issueUrl = (s) => {
  const m = String(s).replace(/^issue:/, '').match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/issues\/)(\d+)/);
  return m ? `https://github.com/${m[1]}/issues/${m[2]}` : null;
};
const epicWs = new Map(), wsAll = readWorkstreams(), repoWs = repoAnchors(wsAll); // repoWs: lowercase owner/name -> slug
for (const w of wsAll) for (const a of w.github) if (typeof a === 'string' && a.startsWith('issue:') && issueUrl(a)) epicWs.set(issueUrl(a), w.slug);

// ---------- live: GraphQL ----------
const PARENTS = 'parent { url parent { url parent { url parent { url } } } }'; // 4 levels of epics
const ISSUE_PR = `... on Issue { id url number title state author { login } repository { nameWithOwner } assignees(first: 10) { nodes { login } } ${PARENTS} }
  ... on PullRequest { id url number title state isDraft author { login } repository { nameWithOwner } assignees(first: 10) { nodes { login } }
    closingIssuesReferences(first: 5) { nodes { url ${PARENTS} } } }`;
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
  return JSON.parse(execFileSync(process.env.PLATE_GH_BIN || 'gh', args, { encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'] }));
};
const chain = (n) => { const out = []; for (let p = n?.parent; p; p = p.parent) out.push(p.url); return out; };

function fetchBoard(owner, number) {
  const q = arg('query') || readSources().github_query || '';
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
// open issues + PRs of one repo (search returns both), paginated
function fetchRepoOpen(repo) {
  let cursor = null, nodes = [];
  for (;;) {
    const query = `query($q: String!, $cursor: String) { search(query: $q, type: ISSUE, first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${ISSUE_PR} } } }`;
    const res = gqlSafe(query, { q: `repo:${repo} is:open`, cursor });
    const page = res.data.search;
    nodes = nodes.concat(page.nodes.filter((c) => c && c.url));
    if (!page.pageInfo.hasNextPage) return nodes;
    cursor = page.pageInfo.endCursor;
  }
}
// items we already hold, by url, in chunks of 25 aliases; a url that no longer resolves just doesn't come back
function fetchKnown(urls) {
  const out = [];
  for (let n = 0; n < urls.length; n += 25) {
    const chunk = urls.slice(n, n + 25);
    const query = `query { ${chunk.map((u, k) => `r${k}: resource(url: ${JSON.stringify(u)}) { ${ISSUE_PR} }`).join(' ')} }`;
    const res = gqlSafe(query, {});
    out.push(...Object.values(res.data || {}).filter((c) => c && c.url));
  }
  return out;
}
// a missing url is a partial error: gh exits non-zero but still prints the data, so keep it
const gqlSafe = (query, vars) => {
  try { return gql(query, vars); } catch (e) {
    try { const j = JSON.parse(String(e.stdout || '')); if (j.data) return j; } catch { /* fall through */ }
    throw new Error(`github: ${String(e.stderr || e.message).trim()}`);
  }
};
const fromGraphql = (n) => fromContent(n.content || {}, n.fieldValues?.nodes || [], n.id);
function fromContent(c, fv, id) {
  const status = fv.find((v) => v.field?.name === 'Status')?.name || null;
  const iteration = fv.find((v) => 'title' in v)?.title || null;
  const isPr = 'closingIssuesReferences' in c, isIssue = !isPr && 'number' in c;
  const closes = isPr ? c.closingIssuesReferences.nodes : [];
  return {
    id, kind: isPr ? 'pr' : isIssue ? 'issue' : 'draft', url: c.url || null, title: c.title, repo: c.repository?.nameWithOwner || null,
    number: c.number ?? null, author: c.author?.login || undefined, status, iteration, assignees: c.assignees?.nodes.map((a) => a.login), closed: /^(closed|merged)$/i.test(c.state || ''), ghState: c.state ? c.state.toLowerCase() : null,
    parent: isIssue ? c.parent?.url || null : undefined, closes: isPr ? closes.map((x) => x.url) : undefined,
    lineage: isIssue ? chain(c) : closes.flatMap((x) => [x.url, ...chain(x)]), // the epics this item could belong to, nearest first
  };
}
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

const oneBoard = arg('owner') && arg('project');
const boards = oneBoard ? [`${arg('owner')}/${arg('project')}`] : arg('file') ? [] : readSources().github_projects;
const repos = oneBoard || arg('file') ? [] : [...repoWs.keys()];
let raw = [];
if (boards.length) {
  raw = boards.flatMap((b) => {
    const m = String(b).match(/^([\w.-]+)\/(\d+)$/);
    if (!m) throw new Error(`github: bad board "${b}" in sources.md (want owner/N)`);
    return fetchBoard(m[1], m[2]).map(fromGraphql);
  });
} else if (!repos.length) {
  const file = arg('file') || path.join(root, '.cache/github.json');
  raw = (JSON.parse(fs.readFileSync(file, 'utf8')).items || []).map(fromItemList);
}
// repo anchors: board items (and their url) win; then the repo's open issues/PRs; then what we already hold from those repos
const canon = (u) => String(u || '').replace(/[#?].*$/, '').replace(/\/$/, '');
const heldBefore = readItems();
const known = new Map(heldBefore.filter((x) => x.source === 'github' && x.url).map((x) => [canon(x.url), x]));
const repoRaw = [];
if (repos.length) {
  const have = new Set(raw.map((r) => canon(r.url)));
  const add = (c) => { const r = fromContent(c, [], c.id); if (have.has(canon(r.url))) return; have.add(canon(r.url)); r.id = known.get(canon(r.url))?.id?.replace(/^github:/, '') ?? r.id; r.fromRepo = true; repoRaw.push(r); };
  for (const repo of repos) fetchRepoOpen(repo).forEach(add);
  const inRepos = (x) => { const m = String(x.url).match(/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/\d+/i); return !!m && repoWs.has(m[1].toLowerCase()); };
  const stale = heldBefore.filter((x) => (x.source === 'github' || x.source === 'ghref') && x.state !== 'gone' && x.url && inRepos(x) && !have.has(canon(x.url)));
  const keepStatus = new Map(stale.map((x) => [canon(x.url), x]));
  fetchKnown([...new Set(stale.map((x) => canon(x.url)))]).forEach((c) => {
    add(c);
    const r = repoRaw.at(-1), old = r && keepStatus.get(canon(r.url)); // a board item that left the board keeps its Status/iteration
    if (r && old?.source === 'github') { r.status = old.status ?? null; r.iteration = old.iteration ?? null; }
  });
  raw = raw.concat(repoRaw);
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
    status: r.status, iteration: r.iteration, author: r.author, assignees: r.assignees, parent: r.parent, closes: r.closes, ghState: r.ghState,
    state: DONE.test(r.status || '') || r.closed ? 'done' : 'open',
    workstream: (epic && epicWs.get(epic)) ?? repoWs.get(String(r.repo).toLowerCase()) ?? undefined,
  });
}

// A pasted link (`ghref`) or a my-tickets item (`mine`, collectors/mine.mjs) for an item now collected here is replaced by the
// collected item, keeping its workstream (the next mine run puts its flags on the new one).
const all = readItems(), refs = new Map(all.filter((x) => x.source === 'ghref' || x.source === 'mine').map((x) => [canon(x.url), x]));
const absorbed = incoming.filter((x) => refs.has(canon(x.url)));
for (const x of absorbed) x.workstream = refs.get(canon(x.url)).workstream ?? x.workstream;
if (absorbed.length) writeItems(all.filter((x) => !((x.source === 'ghref' || x.source === 'mine') && absorbed.some((a) => canon(a.url) === canon(x.url)))));
upsert('github', incoming, { closedStates: ['gone'] });
