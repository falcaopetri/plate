#!/usr/bin/env node
// Stand-in for `gh api graphql` (PLATE_GH_BIN): answers from the JSON file in $STUB_GH. Shape:
//   { board: [<content>…], repos: { "owner/name": [<content>…] open items }, known: { "<url>": <content> } }
// <content> = what the collector's GraphQL fragments return for an Issue / PullRequest (PRs carry closingIssuesReferences).
import fs from 'node:fs';
const args = process.argv.slice(2);
const val = (k) => (args.find((a) => a.startsWith(`${k}=`)) || '').slice(k.length + 1);
const fx = JSON.parse(fs.readFileSync(process.env.STUB_GH, 'utf8'));
const q = val('query'), out = (data) => console.log(JSON.stringify({ data }));
if (q.includes('projectV2')) out({ organization: { projectV2: { items: { pageInfo: { hasNextPage: false }, nodes: (fx.board || []).map((c, n) => ({ id: `PVTI_${n}`, fieldValues: { nodes: [{ name: c.status || 'In progress', field: { name: 'Status' } }] }, content: c })) } } } });
else if (q.includes('search(')) out({ search: { pageInfo: { hasNextPage: false }, nodes: fx.repos[val('q').replace(/^repo:|\s.*$/g, '')] || [] } });
else if (q.includes('resource(')) out(Object.fromEntries([...q.matchAll(/(r\d+): resource\(url: ("[^"]+")\)/g)].map(([, a, u]) => [a, fx.known[JSON.parse(u)] ?? null])));
else { console.error('stub gh: unexpected query'); process.exit(1); }
