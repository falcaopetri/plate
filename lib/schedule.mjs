// Periodic collection inside the server, plus the write lock that keeps it from racing UI writes.
// Collectors rewrite items.jsonl whole, so a collector run and a drag in the UI must never overlap:
// every POST handler and every collector run goes through `withLock`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log } from './log.mjs';
import { snapshotSessions, notifyArchived } from './teamsnotify.mjs';
import { DATA_DIR, readSources, applyRules, repoAnchors, tasknotesDir } from './store.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let chain = Promise.resolve();
// `busy` = what holds the lock right now (shown in /api/state; a write that waits >5s logs it), so a stuck write is diagnosable
export const busy = { what: null, since: null };
export const withLock = (fn, what = 'write') => {
  const queued = Date.now();
  // say who holds the lock while we wait, not after (by then it has been released)
  const nag = setTimeout(() => log.warn(`lock: "${what}" has waited 5s for "${busy.what}" (held since ${busy.since})`), 5000);
  const run = chain.then(async () => {
    clearTimeout(nag);
    busy.what = what; busy.since = new Date().toISOString();
    const t0 = Date.now();
    try { return await fn(); } finally { const ms = Date.now() - t0; if (ms > 2000 || t0 - queued > 5000) log.warn(`lock: "${what}" waited ${((t0 - queued) / 1000).toFixed(1)}s, then held it for ${(ms / 1000).toFixed(1)}s`); busy.what = busy.since = null; }
  });
  chain = run.catch(() => {});
  return run;
};

// interval in minutes: `<name>_every_minutes` in sources.md (read each tick, no restart), else the PLATE_EVERY_<NAME> env var, else the default
const min = (env, def) => def;
// enabled() is checked at every tick, so adding a board to sources.md or a token turns a job on without a restart
const JOBS = [
  { name: 'devin', script: 'collectors/devin.mjs', every: min('PLATE_EVERY_DEVIN', 1), enabled: () => true },
  { name: 'github', net: true, script: 'collectors/github.mjs', every: min('PLATE_EVERY_GITHUB', 10), enabled: () => readSources().github_projects.length > 0 || repoAnchors().size > 0 }, // a board, or any workstream with a repo: anchor
  { name: 'mine', net: true, slow: true, script: 'collectors/mine.mjs', every: min('PLATE_EVERY_MINE', 5), enabled: () => readSources().github_mine !== 'off' },
  { name: 'reviews', net: true, script: 'collectors/reviews.mjs', every: min('PLATE_EVERY_REVIEWS', 10), enabled: () => readSources().github_reviews !== 'off' },
  { name: 'tasknotes', script: 'collectors/tasknotes.mjs', every: min('PLATE_EVERY_TASKNOTES', 5), enabled: () => tasknotesDir() !== null },
  { name: 'todoist', net: true, script: 'collectors/todoist.mjs', every: min('PLATE_EVERY_TODOIST', 15), enabled: () => !!process.env.TODOIST_API_TOKEN },
];
export const status = {}; // name -> {at, ok, msg}

// Collectors that wait on the network (`net`) run OUTSIDE the write lock: github/mine took 5-10 s each, and every UI write queued behind them
// ("server busy"). They only touch items.jsonl in a synchronous read-modify-write at the end (atomic rename), a window of milliseconds,
// so they stay serialized among themselves (`collectChain`) and re-enter the lock just for `applyRules`. The cheap local ones keep the lock.
let collectChain = Promise.resolve();
const runOne = (job) => {
  if (!job.net) return withLock(() => runJob(job), `collect ${job.name}`);
  const run = collectChain.then(() => runJob(job));
  collectChain = run.catch(() => {});
  return run;
};
const runJob = (job) => new Promise((done) => {
  const before = job.name === 'devin' ? snapshotSessions() : null; // an archived review session opens its Teams draft
  // a collector's grandchildren (gh, sqlite3) can keep the pipes open after the kill, so don't wait for 'close' forever
  const t0 = Date.now();
  const guard = setTimeout(() => { status[job.name] = { at: new Date().toISOString(), ok: false, msg: 'timed out' }; log.error(`collect ${job.name}: timed out`); done(status[job.name]); }, 130e3);
  execFile(process.execPath, [job.script], { cwd: root, env: { ...process.env, PLATE_DATA_DIR: DATA_DIR }, timeout: 120e3, killSignal: 'SIGKILL', maxBuffer: 16e6 }, (err, stdout, stderr) => {
    clearTimeout(guard);
    const last = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';
    status[job.name] = { at: new Date().toISOString(), ok: !err, msg: err ? last(stderr) || err.message : last(stdout) };
    const took = ((Date.now() - t0) / 1000).toFixed(1);
    if (err) log.error(`collect ${job.name} failed after ${took}s: ${status[job.name].msg}`);
    else log.info(`collect ${job.name} ok in ${took}s: ${status[job.name].msg}`);
    const rules = () => { try { const n = applyRules(); if (n) log.info(`rules: routed ${n} item(s) after ${job.name}`); } catch (e) { log.error(`rules: ${e.message}`); } };
    const notify = async () => { if (before && !err) try { await notifyArchived(before); } catch (e) { log.error(`teams: ${e.message}`); } };
    (job.net ? withLock(async () => rules(), `rules after ${job.name}`) : Promise.resolve(rules())).then(notify).then(() => done(status[job.name]));
  });
});

export const enabledJobs = () => JOBS.filter((j) => j.enabled()).map((j) => j.name);

// names: subset to run now (manual "Sync now"); default = every enabled job
export async function collectNow(names) {
  // the slow one (`mine`, ~8 s of GitHub searches) goes last, so the quick ones (Todoist, reviews…) show up first
  const jobs = JOBS.filter((j) => (names ? names.includes(j.name) : true) && j.enabled()).sort((a, b) => (a.slow ? 1 : 0) - (b.slow ? 1 : 0));
  for (const j of jobs) await runOne(j); // one at a time: they share items.jsonl
  return jobs.map((j) => j.name);
}

const everyMs = (job) => Number(readSources()[`${job.name}_every_minutes`] || process.env[`PLATE_EVERY_${job.name.toUpperCase()}`] || job.every) * 60e3;
export function startSchedule() {
  if (process.env.PLATE_NO_SCHEDULE) return;
  const last = {};
  // one 20s heartbeat; each job runs when its own interval has passed. `collect: off` in sources.md stops it (read at every tick);
  // Sync now still runs by hand
  const beat = () => {
    if (readSources().collect === 'off') return;
    for (const job of JOBS) {
      if (Date.now() - (last[job.name] ?? 0) < everyMs(job) - 5e3 || !job.enabled()) continue;
      last[job.name] = Date.now();
      runOne(job);
    }
  };
  watchDevin(last);
  setTimeout(beat, 3000); // shortly after start
  setInterval(beat, 20e3).unref();
}

// Devin writes sessions.db (WAL mode) as a session talks, so a change there is the cheapest "something happened" signal: collect
// Devin shortly after it, instead of waiting for the 1-minute beat. Debounced (3s of quiet) and at most one run per 15s, so a chatty
// session costs a short collector run now and then, not a busy loop. `devin_watch: off` in sources.md disables it.
// The beat stays as the fallback (and is what turns "idle for 2 min" into `waiting`, which no file change signals).
function watchDevin(last) {
  const db = process.env.DEVIN_SESSIONS_DB || path.join(os.homedir(), '.local/share/devin/cli/sessions.db');
  if (!fs.existsSync(path.dirname(db))) return;
  const job = JOBS.find((j) => j.name === 'devin');
  let timer = null;
  const fire = () => {
    timer = null;
    if (readSources().collect === 'off' || readSources().devin_watch === 'off') return;
    const since = Date.now() - (last.devin ?? 0);
    if (since < 15e3) { timer = setTimeout(fire, 15e3 - since + 200); return; }
    last.devin = Date.now(); // the heartbeat then skips its own run
    runOne(job);
  };
  try {
    fs.watch(path.dirname(db), (_ev, name) => { if ((name === path.basename(db) || name === `${path.basename(db)}-wal`) && !timer) timer = setTimeout(fire, 3000); }).unref();
  } catch (e) { log.warn(`devin watch unavailable: ${e.message}`); }
}
