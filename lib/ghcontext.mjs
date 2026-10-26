// Ticket context: one GitHub issue/PR with its relationships, fetched live through `gh api graphql`
// (works for any ticket the token can read, on a board or not).
//   issue -> ancestors (parent chain), sub-issues (+ progress), siblings (parent's other sub-issues),
//            blocked by / blocking, PRs that close it
//   PR    -> the issues it closes, and the context of the first one's parent chain
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BadRequest } from './store.mjs';

const execFileP = promisify(execFile);
const T = 'url number title state repository { nameWithOwner }'; // ticket header
const ISSUE_T = `${T} stateReason subIssuesSummary { total completed }`;
const PARENTS = `parent { ${ISSUE_T} parent { ${ISSUE_T} parent { ${ISSUE_T} parent { ${ISSUE_T} } } } }`;
const ISSUE = `${ISSUE_T} assignees(first: 10) { nodes { login } } labels(first: 10) { nodes { name } }
  ${PARENTS}
  subIssues(first: 50) { nodes { ${ISSUE_T} assignees(first: 3) { nodes { login } } } }
  blockedBy(first: 20) { nodes { ${ISSUE_T} } }
  blocking(first: 20) { nodes { ${ISSUE_T} } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { ${T} isDraft } }`;
const SIBLINGS = `parent { subIssues(first: 50) { nodes { ${ISSUE_T} } } }`;

const URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/i;

export async function ticketContext(url) {
  const m = String(url || '').match(URL_RE);
  if (!m) throw new BadRequest('not a GitHub issue or PR url');
  const [, owner, name, type, num] = m;
  const node = type === 'pull'
    ? `pullRequest(number: ${num}) { ${T} isDraft assignees(first: 10) { nodes { login } } closingIssuesReferences(first: 10) { nodes { ${ISSUE} ${SIBLINGS} } } }`
    : `issue(number: ${num}) { ${ISSUE} ${SIBLINGS} }`;
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${node} } }`;
  let res;
  try {
    const { stdout } = await execFileP('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`], { timeout: 15000, maxBuffer: 16e6 });
    res = JSON.parse(stdout).data.repository;
  } catch (e) { throw new BadRequest(`GitHub lookup failed: ${String(e.stderr || e.message).trim().split('\n').pop()}`); }
  const flat = (n) => n && { url: n.url, number: n.number, title: n.title, repo: n.repository?.nameWithOwner, state: n.isDraft && n.state === 'OPEN' ? 'DRAFT' : n.state,
    ...(n.subIssuesSummary?.total ? { subs: n.subIssuesSummary } : {}), ...(n.assignees ? { assignees: n.assignees.nodes.map((a) => a.login) } : {}) };
  const issueCtx = (i) => {
    const ancestors = []; for (let p = i.parent; p; p = p.parent) ancestors.unshift(flat(p)); // root first
    return {
      ticket: { ...flat(i), kind: 'issue', labels: i.labels.nodes.map((l) => l.name) },
      ancestors, subIssues: i.subIssues.nodes.map(flat),
      siblings: (i.parent?.subIssues.nodes || []).filter((s) => s.url !== i.url).map(flat),
      blockedBy: i.blockedBy.nodes.map(flat), blocking: i.blocking.nodes.map(flat),
      prs: i.closedByPullRequestsReferences.nodes.map(flat),
    };
  };
  if (type === 'pull') {
    const pr = res.pullRequest, closes = pr.closingIssuesReferences.nodes;
    const base = closes.length ? issueCtx(closes[0]) : { ancestors: [], subIssues: [], siblings: [], blockedBy: [], blocking: [], prs: [] };
    return { ...base, ticket: { ...flat(pr), kind: 'pr' }, closes: closes.map(flat), via: closes[0] ? flat(closes[0]) : null };
  }
  return issueCtx(res.issue);
}
