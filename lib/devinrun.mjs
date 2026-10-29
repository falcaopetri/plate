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
import { log as logger } from './log.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_BIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin';
const devinBin = () => process.env.DEVIN_BIN || readSources().devin_bin || (fs.existsSync(APP_BIN) ? APP_BIN : 'devin');
const promptFor = (url, kind) => (kind === 'close' ? readSources().devin_close_prompt || 'What is still missing for us to close this ticket? Check the code, its linked PRs and the discussion, and list what is left. {url}' : readSources().devin_review_prompt || '/code-review {url}').replace('{url}', url);
const reviewDir = () => { const d = readSources().devin_review_dir; return d ? String(d).replace(/^~(?=$|\/)/, os.homedir()) : null; };

export const runs = {}; // key -> {state: running|done|failed, dir, started, ended?, msg?, session?}; key = PR url (review) or `close:<ticket url>`

const MODEL = /^[\w.:@-]{1,60}$/;
export function startReview(url, model) {
  const m = String(url || '').match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i);
  if (!m) throw new BadRequest('not a GitHub PR url');
  return startRun(`https://github.com/${m[1]}/pull/${m[2]}`, `https://github.com/${m[1]}/pull/${m[2]}`, m, model, 'review');
}
// "What is missing to close this ticket?" on an issue or PR: same CLI run, its own prompt (`devin_close_prompt`, e.g. a skill)
// and model (`devin_close_model`, else the review one)
export function startClose(url, model) {
  const m = String(url || '').match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/i);
  if (!m) throw new BadRequest('not a GitHub issue or PR url');
  const t = String(url).match(/\/(issues|pull)\//i)[1].toLowerCase();
  const ticket = `https://github.com/${m[1]}/${t}/${m[2]}`;
  return startRun(ticket, `close:${ticket}`, m, model, 'close');
}

function startRun(target, key, m, model, kind) {
  if (runs[key]?.state === 'running') throw new BadRequest('a Devin run on this ticket is already running');
  const dir = reviewDir();
  if (!dir || !fs.existsSync(dir)) throw new BadRequest(dir ? `devin_review_dir not found: ${dir}` : 'set devin_review_dir (the folder you run Devin in) in Settings or sources.md');
  const logDir = path.join(root, '.cache/devin-runs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `${kind}-${m[1].replace('/', '_')}-${m[2]}-${Date.now()}.log`);
  const out = fs.openSync(log, 'a');
  const started = Date.now();
  const src = readSources();
  model = String(model || '').trim() || (kind === 'close' && src.devin_close_model) || src.devin_review_model || '';
  if (model && !MODEL.test(model)) throw new BadRequest('bad model name');
  const prompt = promptFor(target, kind);
  const child = spawn(devinBin(), [...(model ? ['--model', model] : []), '-p', prompt], { cwd: dir, stdio: ['ignore', out, out] });
  runs[key] = { state: 'running', dir, model: model || null, started: new Date(started).toISOString(), log };
  logger.info(`devin ${kind} started on ${target} (${model || 'default model'})`);
  // tie the session to the PR as soon as Devin creates it, not when the run ends (a review takes minutes, meanwhile it sat in the Inbox)
  let linking = false;
  const early = setInterval(async () => {
    if (linking || runs[key].session) return clearInterval(early);
    linking = true;
    try { await collectNow(['devin']); await withLock(() => linkSession(target, dir, started, kind === 'close' ? 'Fechar' : 'Review', key), `link ${kind} session`); }
    catch (e) { logger.warn(`devin ${kind}: early link failed: ${e.message}`); }
    finally { linking = false; }
  }, 4000);
  const finish = async (ok, msg) => {
    clearInterval(early);
    fs.closeSync(out);
    Object.assign(runs[key], { state: ok ? 'done' : 'failed', ended: new Date().toISOString(), msg });
    (ok ? logger.info : logger.error)(`devin ${kind} on ${target} ${ok ? 'done' : 'failed'}: ${msg}`);
    await collectNow(['devin']);
    await withLock(() => linkSession(target, dir, started, kind === 'close' ? 'Fechar' : 'Review', key), `link ${kind} session`);
  };
  child.on('error', (e) => finish(false, e.code === 'ENOENT' ? `devin CLI not found (${devinBin()}); set DEVIN_BIN` : e.message));
  child.on('exit', (code) => {
    const tail = fs.readFileSync(log, 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 300);
    if (code !== 0 && /login/i.test(tail)) return finish(false, 'Devin CLI is not logged in: run `devin auth login` once on this machine');
    finish(code === 0, code === 0 ? tail : `exit ${code}: ${tail}`);
  });
  return { dir, model: model || null, prompt };
}

// newest Devin session in `dir` created after the run started -> anchor it to the PR
function linkSession(pr, dir, started, label, key) {
  const items = readItems();
  const s = items.filter((i) => i.tool === 'devin' && i.cwd === dir && i.created && Date.parse(i.created) >= started - 5000)
    .sort((a, b) => b.created.localeCompare(a.created))[0];
  if (!s) return;
  const prItem = items.find((i) => (i.url || '').replace(/[#?].*$/, '') === pr && i.state !== 'gone');
  s.anchor = pr;
  if (!s.alias) s.alias = `${label}: ${prItem?.title || pr.replace('https://github.com/', '')}`.slice(0, 120); // Devin titles these "Greeting"-style
  if (!s.workstream && prItem?.workstream) s.workstream = prItem.workstream;
  s.updated = new Date().toISOString();
  writeItems(items);
  runs[key].session = s.id;
}
