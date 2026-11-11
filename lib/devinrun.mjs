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
import { readItems, writeItems, readSources, readWorkstreams, BadRequest } from './store.mjs';
import { herdrOn, openInHerdr } from './herdr.mjs';
import { withLock, collectNow } from './schedule.mjs';
import { log as logger } from './log.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_BIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin';
const devinBin = () => process.env.DEVIN_BIN || readSources().devin_bin || (fs.existsSync(APP_BIN) ? APP_BIN : 'devin');
const promptFor = (url, kind) => (kind === 'close' ? readSources().devin_close_prompt || 'What is still missing for us to close this ticket? Check the code, its linked PRs and the discussion, and list what is left. {url}' : readSources().devin_review_prompt || '/code-review {url}').replace('{url}', url);
const promptMany = (urls) => (readSources().devin_review_multi_prompt || 'Review these related PRs together, as one change: check each one, and also how they fit (ordering, shared contracts, anything one breaks in another). One consolidated review.\n{urls}').replace('{urls}', urls.join('\n'));
const expand = (d) => String(d).replace(/^~(?=$|\/)/, os.homedir());
// `herdr_dir`: where the sessions opened in Herdr start (default: devin_review_dir)
const herdrDir = () => { const d = readSources().herdr_dir; return d && fs.existsSync(expand(d)) ? expand(d).replace(/\/+$/, '') : null; };
const reviewDir = () => { const d = readSources().devin_review_dir; return d ? String(d).replace(/^~(?=$|\/)/, os.homedir()) : null; };

export const runs = {}; // key -> {state: running|done|failed, dir, started, ended?, msg?, session?}; key = PR url (review) or `close:<ticket url>`

const MODEL = /^[\w.:@-]{1,60}$/;
// `devin -p` cannot ask for approval: in the CLI's default mode (auto = read-only tools) every other command is rejected with
// "Running in non-interactive mode". `devin_permission_mode` (default smart) is passed through; empty keeps the CLI's own default.
const MODES = ['auto', 'accept-edits', 'smart', 'dangerous'];
const permissionArgs = () => { const m = String(readSources().devin_permission_mode ?? 'smart').trim(); return MODES.includes(m) ? ['--permission-mode', m] : []; };
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
  const started = Date.now();
  const src = readSources();
  model = String(model || '').trim() || (kind === 'close' && src.devin_close_model) || src.devin_review_model || '';
  if (model && !MODEL.test(model)) throw new BadRequest('bad model name');
  const prompt = many ? promptMany(many) : promptFor(target, kind);
  const label = kind === 'close' ? 'Fechar' : many ? `Review ${many.length} PRs` : 'Review';
  let runDir = dir; // where the session starts: the Herdr folder when the run goes through Herdr, else devin_review_dir
  runs[key] = { state: 'running', dir, model: model || null, started: new Date(started).toISOString(), log };
  // tie the session to the PR as soon as Devin creates it, not when the run ends (a review takes minutes, meanwhile it sat in the Inbox)
  let linking = false, early = null;
  const tryLink = async () => {
    if (linking || runs[key].session) return clearInterval(early);
    linking = true;
    try { await collectNow(['devin']); await withLock(() => linkSession(target, runDir, started, label, key), `link ${kind} session`); }
    catch (e) { logger.warn(`devin ${kind}: early link failed: ${e.message}`); }
    finally { linking = false; }
  };
  const headless = () => {
    runDir = dir;
    const out = fs.openSync(log, 'a');
    const child = spawn(devinBin(), [...permissionArgs(), ...(model ? ['--model', model] : []), '-p', prompt], { cwd: dir, stdio: ['ignore', out, out] });
    logger.info(`devin ${kind} started on ${target} (${model || 'default model'})`);
    early = setInterval(tryLink, 4000);
    const finish = async (ok, msg) => {
      clearInterval(early);
      fs.closeSync(out);
      await collectNow(['devin']);
      await withLock(() => linkSession(target, runDir, started, label, key), `link ${kind} session`);
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
  };
  if (herdrOn()) { runDir = herdrDir() || dir; runs[key].dir = runDir; }
  if (herdrOn()) viaHerdr({ key, target, kind, label, started, tryLink, ws: wsNameOf(target), folder: runDir, tab: `${label}: ${titleOf(target)}`, argv: [devinBin(), ...(model ? ['--model', model] : []), '--', prompt], fallback: headless, setEarly: (t) => { early = t; } });
  else headless();
  return { dir, model: model || null, prompt };
}

// the item behind a url -> its workstream's name (the Herdr space) and its title (the tab)
const itemOf = (url) => readItems().find((i) => (i.url || '').replace(/[#?].*$/, '') === url && i.state !== 'gone');
const wsNameOf = (url) => { const slug = itemOf(url)?.workstream; return slug ? readWorkstreams().find((w) => w.slug === slug)?.name || null : null; };
const titleOf = (url) => itemOf(url)?.title || String(url).replace('https://github.com/', '');

// `herdr: on`: the same run as an interactive agent in a Herdr tab (the space is the PR's workstream). There is no child to wait
// for, so the run is "done" as soon as its session is linked to the ticket; no session in 3 minutes = failed. If Herdr can't be
// reached (app closed, herdr-app missing) the headless run starts instead, so the button still works.
function viaHerdr({ key, target, kind, started, tryLink, ws, folder, tab, argv, task, fallback, setEarly }) {
  openInHerdr({ workstream: ws, folder, tab, argv, task }).then((h) => {
    Object.assign(runs[key], { herdr: h });
    logger.info(`devin ${kind} on ${target} opened in Herdr (space "${h.space}"${h.created ? ', new' : ''}, terminal ${h.terminal})`);
    const t = setInterval(async () => {
      await tryLink();
      const r = runs[key];
      if (r.session) { clearInterval(t); Object.assign(r, { state: 'done', ended: new Date().toISOString(), msg: `in Herdr: ${h.space}` }); }
      else if (Date.now() - started > 180000) { clearInterval(t); Object.assign(r, { state: 'failed', ended: new Date().toISOString(), msg: 'no Devin session appeared from the Herdr tab (is the CLI logged in?)' }); logger.error(`devin ${kind} on ${target}: no session from Herdr`); }
    }, 4000);
    setEarly(t);
  }).catch((e) => { logger.warn(`herdr: ${e.message}; running ${kind} headless instead`); fallback(); });
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
export async function startSetup(pending) {
  if (!pending) throw new BadRequest('no setup pending: the CHANGELOG is already applied here');
  const agent = readSources().setup_agent === 'devin' ? 'devin' : 'claude';
  const range = pending.seen + 1 === pending.latest ? `#${pending.latest}` : `#${pending.seen + 1}-${pending.latest}`;
  const label = `Setup: CHANGELOG ${range}`;
  const model = String(readSources().devin_review_model || '').trim();
  if (agent === 'devin' && runs.setup?.state === 'running') throw new BadRequest('a Devin setup run is already running');
  // `herdr: on`: an interactive agent in a Herdr tab (space "Plate": the setup belongs to no workstream)
  if (herdrOn()) {
    // Devin takes its first prompt after `--` (a positional would be refused); Claude takes it as the task
    const argv = agent === 'claude' ? ['claude'] : [devinBin(), ...(model && MODEL.test(model) ? ['--model', model] : []), '--', '/plate-changelog'];
    const task = agent === 'claude' ? '/plate-changelog' : undefined;
    try {
      if (agent === 'claude') return { agent, range, herdr: await openInHerdr({ workstream: null, folder: root, tab: label, argv, task, reuseFolder: root }) };
      const started = Date.now();
      runs.setup = { state: 'running', dir: root, started: new Date(started).toISOString() };
      const h = await openInHerdr({ workstream: null, folder: root, tab: label, argv, task, reuseFolder: root });
      Object.assign(runs.setup, { herdr: h });
      logger.info(`devin setup opened in Herdr (changelog ${range})`);
      const t = setInterval(async () => {
        try { await collectNow(['devin']); await withLock(() => linkSession(null, root, started, label, 'setup'), 'link setup session'); } catch (e) { logger.warn(`devin setup: link failed: ${e.message}`); }
        if (runs.setup.session) { clearInterval(t); Object.assign(runs.setup, { state: 'done', ended: new Date().toISOString(), msg: `in Herdr: ${h.space}` }); }
        else if (Date.now() - started > 180000) { clearInterval(t); Object.assign(runs.setup, { state: 'failed', ended: new Date().toISOString(), msg: 'no Devin session appeared from the Herdr tab (is the CLI logged in?)' }); }
      }, 3000);
      return { agent, range, herdr: h };
    } catch (e) { logger.warn(`herdr: ${e.message}; opening the setup the usual way`); delete runs.setup; }
  }
  if (agent === 'claude') {
    const q = '/plate-changelog'; // the project skill in .claude/skills (a copy of the Devin one in .devin/skills)
    return { agent, range, url: `claude://code/new?folder=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}` };
  }
  const logDir = path.join(process.env.PLATE_CACHE_DIR || path.join(root, '.cache'), 'devin-runs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `setup-${Date.now()}.log`), out = fs.openSync(log, 'a'), started = Date.now();
  const child = spawn(devinBin(), [...permissionArgs(), ...(model && MODEL.test(model) ? ['--model', model] : []), '-p', '/plate-changelog'], { cwd: root, stdio: ['ignore', out, out] });
  runs.setup = { state: 'running', dir: root, started: new Date(started).toISOString(), log };
  logger.info(`devin setup started (changelog ${range})`);
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
