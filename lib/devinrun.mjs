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
const promptMany = (urls) => (readSources().devin_review_multi_prompt || 'Review these related PRs together, as one change: check each one, and also how they fit (ordering, shared contracts, anything one breaks in another). One consolidated review.\n{urls}').replace('{urls}', urls.join('\n'));
const reviewDir = () => { const d = readSources().devin_review_dir; return d ? String(d).replace(/^~(?=$|\/)/, os.homedir()) : null; };

export const runs = {}; // key -> {state: running|done|failed, dir, started, ended?, msg?, session?}; key = PR url (review) or `close:<ticket url>`

const MODEL = /^[\w.:@-]{1,60}$/;
export function startReview(url, model) {
  const m = String(url || '').match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i);
  if (!m) throw new BadRequest('not a GitHub PR url');
  return startRun(`https://github.com/${m[1]}/pull/${m[2]}`, `https://github.com/${m[1]}/pull/${m[2]}`, m, model, 'review');
}
// One session for several PRs ("Review N PRs in Devin"): same CLI run with a multi-PR prompt (`devin_review_multi_prompt`, `{urls}`).
// The run is keyed by the first PR (the session anchors to it); every PR gets the same run state, so each card shows it.
export function startReviewMany(urls, model) {
  const list = [...new Set((Array.isArray(urls) ? urls : []).map((u) => String(u || '').trim().replace(/[#?].*$/, '')))];
  if (list.length < 2) throw new BadRequest('pick at least two PRs');
  if (list.length > 10) throw new BadRequest('at most 10 PRs in one review');
  const ms = list.map((u) => u.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/i) || null);
  if (ms.includes(null)) throw new BadRequest('not a GitHub PR url');
  const busy = list.find((u) => runs[u]?.state === 'running');
  if (busy) throw new BadRequest('a Devin run on one of these PRs is already running');
  const r = startRun(list[0], list[0], ms[0], model, 'review', list);
  for (const u of list.slice(1)) runs[u] = runs[list[0]];
  return { ...r, urls: list };
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

function startRun(target, key, m, model, kind, many) {
  if (runs[key]?.state === 'running') throw new BadRequest('a Devin run on this ticket is already running');
  const dir = reviewDir();
  if (!dir || !fs.existsSync(dir)) throw new BadRequest(dir ? `devin_review_dir not found: ${dir}` : 'set devin_review_dir (the folder you run Devin in) in Settings or sources.md');
  const logDir = path.join(process.env.PLATE_CACHE_DIR || path.join(root, '.cache'), 'devin-runs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `${kind}-${m[1].replace('/', '_')}-${m[2]}-${Date.now()}.log`);
  const out = fs.openSync(log, 'a');
  const started = Date.now();
  const src = readSources();
  model = String(model || '').trim() || (kind === 'close' && src.devin_close_model) || src.devin_review_model || '';
  if (model && !MODEL.test(model)) throw new BadRequest('bad model name');
  const prompt = many ? promptMany(many) : promptFor(target, kind);
  const child = spawn(devinBin(), [...(model ? ['--model', model] : []), '-p', prompt], { cwd: dir, stdio: ['ignore', out, out] });
  runs[key] = { state: 'running', dir, model: model || null, started: new Date(started).toISOString(), log };
  logger.info(`devin ${kind} started on ${target} (${model || 'default model'})`);
  // tie the session to the PR as soon as Devin creates it, not when the run ends (a review takes minutes, meanwhile it sat in the Inbox)
  let linking = false;
  const early = setInterval(async () => {
    if (linking || runs[key].session) return clearInterval(early);
    linking = true;
    try { await collectNow(['devin']); await withLock(() => linkSession(target, dir, started, kind === 'close' ? 'Fechar' : many ? `Review ${many.length} PRs` : 'Review', key), `link ${kind} session`); }
    catch (e) { logger.warn(`devin ${kind}: early link failed: ${e.message}`); }
    finally { linking = false; }
  }, 4000);
  const finish = async (ok, msg) => {
    clearInterval(early);
    fs.closeSync(out);
    await collectNow(['devin']);
    await withLock(() => linkSession(target, dir, started, kind === 'close' ? 'Fechar' : many ? `Review ${many.length} PRs` : 'Review', key), `link ${kind} session`);
    // a non-zero exit with the session already created is not a failed run: a tool call inside it (a pre-hook, a denied command)
    // can exit the headless CLI with 1 while the session lives on, and the user carries on in it from the Desktop
    const sessionOk = !ok && !!runs[key].session;
    Object.assign(runs[key], { state: ok || sessionOk ? 'done' : 'failed', ended: new Date().toISOString(), msg: sessionOk ? `session created; the CLI exited early (${msg})` : msg, warn: sessionOk || undefined });
    (ok ? logger.info : sessionOk ? logger.warn : logger.error)(`devin ${kind} on ${target} ${ok ? 'done' : sessionOk ? 'ended early, session kept' : 'failed'}: ${msg}`);
  };
  child.on('error', (e) => finish(false, e.code === 'ENOENT' ? `devin CLI not found (${devinBin()}); set DEVIN_BIN` : e.message));
  child.on('exit', (code) => {
    const tail = fs.readFileSync(log, 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 300);
    if (code !== 0 && /login/i.test(tail)) return finish(false, 'Devin CLI is not logged in: run `devin auth login` once on this machine');
    finish(code === 0, code === 0 ? tail : `exit ${code}: ${tail}`);
  });
  return { dir, model: model || null, prompt };
}

const realDir = (d) => { try { return fs.realpathSync(String(d || '')).replace(/\/+$/, '').toLowerCase(); } catch { return String(d || '').replace(/\/+$/, '').toLowerCase(); } };
const sameDir = (a, b) => !!a && realDir(a) === realDir(b);

// newest Devin session in `dir` created after the run started -> anchor it to the PR
function linkSession(pr, dir, started, label, key) {
  const items = readItems();
  const fresh = items.filter((i) => i.tool === 'devin' && i.created && Date.parse(i.created) >= started - 5000).sort((a, b) => b.created.localeCompare(a.created));
  // same folder by real path (a symlink, a trailing slash or a different case would miss `===`); else the only session born in the window
  const here = fresh.filter((i) => sameDir(i.cwd, dir));
  const s = here[0] || (fresh.length === 1 ? fresh[0] : null);
  if (!s) return;
  const prItem = pr && items.find((i) => (i.url || '').replace(/[#?].*$/, '') === pr && i.state !== 'gone');
  if (pr) s.anchor = pr; // pr = null for the setup run: no ticket to tie it to, `label` is the whole alias
  if (!s.alias) s.alias = (pr ? `${label}: ${prItem?.title || pr.replace('https://github.com/', '')}` : label).slice(0, 120); // Devin titles these "Greeting"-style
  if (!s.workstream && prItem?.workstream) s.workstream = prItem.workstream;
  s.updated = new Date().toISOString();
  writeItems(items);
  runs[key].session = s.id;
}

// "Setup pending" badge: apply the CHANGELOG entries this machine hasn't (AGENTS.md, "After every pull") in an agent session.
// `setup_agent` in sources.md: claude (default) = a claude:// deep link that opens the Code tab on this repo with the prompt filled in
// (the browser opens it); devin = `devin -p "/plate-changelog"` in this repo, so the session lands in Devin Desktop and the Plate
// opens its deep link once it exists (`runs.setup.session`). The Devin run is headless: it stops to ask, and you answer in the Desktop.
export function startSetup(pending) {
  if (!pending) throw new BadRequest('no setup pending: the CHANGELOG is already applied here');
  const agent = readSources().setup_agent === 'devin' ? 'devin' : 'claude';
  const range = pending.seen + 1 === pending.latest ? `#${pending.latest}` : `#${pending.seen + 1}-${pending.latest}`;
  if (agent === 'claude') {
    const q = '/plate-changelog'; // the project skill in .claude/skills (a copy of the Devin one in .devin/skills)
    return { agent, range, url: `claude://code/new?folder=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}` };
  }
  if (runs.setup?.state === 'running') throw new BadRequest('a Devin setup run is already running');
  const logDir = path.join(process.env.PLATE_CACHE_DIR || path.join(root, '.cache'), 'devin-runs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `setup-${Date.now()}.log`), out = fs.openSync(log, 'a'), started = Date.now();
  const src = readSources(), model = String(src.devin_review_model || '').trim();
  const child = spawn(devinBin(), [...(model && MODEL.test(model) ? ['--model', model] : []), '-p', '/plate-changelog'], { cwd: root, stdio: ['ignore', out, out] });
  runs.setup = { state: 'running', dir: root, started: new Date(started).toISOString(), log };
  logger.info(`devin setup started (changelog ${range})`);
  const label = `Setup: CHANGELOG ${range}`;
  let linking = false;
  const early = setInterval(async () => {
    if (linking || runs.setup.session) return clearInterval(early);
    linking = true;
    try { await collectNow(['devin']); await withLock(() => linkSession(null, root, started, label, 'setup'), 'link setup session'); }
    catch (e) { logger.warn(`devin setup: early link failed: ${e.message}`); }
    finally { linking = false; }
  }, 3000);
  const finish = async (ok, msg) => {
    clearInterval(early);
    fs.closeSync(out);
    await collectNow(['devin']);
    await withLock(() => linkSession(null, root, started, label, 'setup'), 'link setup session');
    const sessionOk = !ok && !!runs.setup.session;
    Object.assign(runs.setup, { state: ok || sessionOk ? 'done' : 'failed', ended: new Date().toISOString(), msg: sessionOk ? `session created; the CLI exited early (${msg})` : msg, warn: sessionOk });
    (ok ? logger.info : sessionOk ? logger.warn : logger.error)(`devin setup ${ok ? 'done' : sessionOk ? 'ended early, session kept' : 'failed'}: ${msg}`);
  };
  child.on('error', (e) => finish(false, e.code === 'ENOENT' ? `devin CLI not found (${devinBin()}); set DEVIN_BIN` : e.message));
  child.on('exit', (code) => {
    const tail = fs.readFileSync(log, 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 300);
    if (code !== 0 && /login/i.test(tail)) return finish(false, 'Devin CLI is not logged in: run `devin auth login` once on this machine');
    finish(code === 0, code === 0 ? tail : `exit ${code}: ${tail}`);
  });
  return { agent, range };
}
