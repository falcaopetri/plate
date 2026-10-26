// Run a Devin skill on a PR headlessly: `devin -p "/code-review <url>"` in the review folder (`devin_review_dir` in
// sources.md: one workspace holding clones of every repo). The Desktop has no deep link that starts a session with a
// prompt, so this goes through the CLI (which must be logged in: `devin auth login`). The new session lands in
// sessions.db; when the run ends we collect Devin and tie that session to the PR (`anchor` = PR url, and the PR's
// workstream if the session has none).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readItems, writeItems, readSources, BadRequest } from './store.mjs';
import { withLock, collectNow } from './schedule.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_BIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin';
const devinBin = () => process.env.DEVIN_BIN || readSources().devin_bin || (fs.existsSync(APP_BIN) ? APP_BIN : 'devin');
const promptFor = (url) => (readSources().devin_review_prompt || '/code-review {url}').replace('{url}', url);
const reviewDir = () => { const d = readSources().devin_review_dir; return d ? String(d).replace(/^~(?=$|\/)/, os.homedir()) : null; };

export const runs = {}; // pr url -> {state: running|done|failed, dir, started, ended?, msg?, session?}

export function startReview(url) {
  const m = String(url || '').match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i);
  if (!m) throw new BadRequest('not a GitHub PR url');
  const pr = `https://github.com/${m[1]}/pull/${m[2]}`;
  if (runs[pr]?.state === 'running') throw new BadRequest('a Devin review of this PR is already running');
  const dir = reviewDir();
  if (!dir || !fs.existsSync(dir)) throw new BadRequest(dir ? `devin_review_dir not found: ${dir}` : 'set devin_review_dir (the folder you run code reviews in) in sources.md');
  const logDir = path.join(root, '.cache/devin-runs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `${m[1].replace('/', '_')}-${m[2]}-${Date.now()}.log`);
  const out = fs.openSync(log, 'a');
  const started = Date.now();
  const child = spawn(devinBin(), ['-p', promptFor(pr)], { cwd: dir, stdio: ['ignore', out, out] });
  runs[pr] = { state: 'running', dir, started: new Date(started).toISOString(), log };
  const finish = async (ok, msg) => {
    fs.closeSync(out);
    Object.assign(runs[pr], { state: ok ? 'done' : 'failed', ended: new Date().toISOString(), msg });
    await collectNow(['devin']);
    await withLock(() => linkSession(pr, dir, started));
  };
  child.on('error', (e) => finish(false, e.code === 'ENOENT' ? `devin CLI not found (${devinBin()}); set DEVIN_BIN` : e.message));
  child.on('exit', (code) => {
    const tail = fs.readFileSync(log, 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 300);
    if (code !== 0 && /login/i.test(tail)) return finish(false, 'Devin CLI is not logged in: run `devin auth login` once on this machine');
    finish(code === 0, code === 0 ? tail : `exit ${code}: ${tail}`);
  });
  return { dir, prompt: promptFor(pr) };
}

// newest Devin session in `dir` created after the run started -> anchor it to the PR
function linkSession(pr, dir, started) {
  const items = readItems();
  const s = items.filter((i) => i.tool === 'devin' && i.cwd === dir && i.created && Date.parse(i.created) >= started - 5000)
    .sort((a, b) => b.created.localeCompare(a.created))[0];
  if (!s) return;
  const prItem = items.find((i) => (i.url || '').replace(/[#?].*$/, '') === pr && i.state !== 'gone');
  s.anchor = pr;
  if (!s.workstream && prItem?.workstream) s.workstream = prItem.workstream;
  s.updated = new Date().toISOString();
  writeItems(items);
  runs[pr].session = s.id;
}
