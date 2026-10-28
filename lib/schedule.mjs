// Periodic collection inside the server, plus the write lock that keeps it from racing UI writes.
// Collectors rewrite items.jsonl whole, so a collector run and a drag in the UI must never overlap:
// every POST handler and every collector run goes through `withLock`.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, readSources, applyRules, repoAnchors, tasknotesDir } from './store.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let chain = Promise.resolve();
// `busy` = what holds the lock right now (shown in /api/state; a write that waits >5s logs it), so a stuck write is diagnosable
export const busy = { what: null, since: null };
export const withLock = (fn, what = 'write') => {
  const queued = Date.now();
  const run = chain.then(async () => {
    const wait = Date.now() - queued;
    if (wait > 5000) console.warn(`lock: "${what}" waited ${Math.round(wait / 1000)}s`);
    busy.what = what; busy.since = new Date().toISOString();
    try { return await fn(); } finally { busy.what = busy.since = null; }
  });
  chain = run.catch(() => {});
  return run;
};

// interval in minutes: `<name>_every_minutes` in sources.md (read each tick, no restart), else the PLATE_EVERY_<NAME> env var, else the default
const min = (env, def) => def;
// enabled() is checked at every tick, so adding a board to sources.md or a token turns a job on without a restart
const JOBS = [
  { name: 'devin', script: 'collectors/devin.mjs', every: min('PLATE_EVERY_DEVIN', 1), enabled: () => true },
  { name: 'github', script: 'collectors/github.mjs', every: min('PLATE_EVERY_GITHUB', 10), enabled: () => readSources().github_projects.length > 0 || repoAnchors().size > 0 }, // a board, or any workstream with a repo: anchor
  { name: 'reviews', script: 'collectors/reviews.mjs', every: min('PLATE_EVERY_REVIEWS', 10), enabled: () => readSources().github_reviews !== 'off' },
  { name: 'tasknotes', script: 'collectors/tasknotes.mjs', every: min('PLATE_EVERY_TASKNOTES', 5), enabled: () => tasknotesDir() !== null },
  { name: 'todoist', script: 'collectors/todoist.mjs', every: min('PLATE_EVERY_TODOIST', 15), enabled: () => !!process.env.TODOIST_API_TOKEN },
];
export const status = {}; // name -> {at, ok, msg}

const runOne = (job) => withLock(() => new Promise((done) => {
  // a collector's grandchildren (gh, sqlite3) can keep the pipes open after the kill, so don't wait for 'close' forever
  const guard = setTimeout(() => { status[job.name] = { at: new Date().toISOString(), ok: false, msg: 'timed out' }; console.error(`collect ${job.name}: timed out`); done(status[job.name]); }, 130e3);
  execFile(process.execPath, [job.script], { cwd: root, env: { ...process.env, PLATE_DATA_DIR: DATA_DIR }, timeout: 120e3, killSignal: 'SIGKILL', maxBuffer: 16e6 }, (err, stdout, stderr) => {
    clearTimeout(guard);
    const last = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';
    status[job.name] = { at: new Date().toISOString(), ok: !err, msg: err ? last(stderr) || err.message : last(stdout) };
    if (err) console.error(`collect ${job.name}: ${status[job.name].msg}`);
    try { const n = applyRules(); if (n) console.log(`rules: routed ${n} item(s) after ${job.name}`); } catch (e) { console.error(`rules: ${e.message}`); }
    done(status[job.name]);
  });
}), `collect ${job.name}`);

// names: subset to run now (manual "Sync now"); default = every enabled job
export async function collectNow(names) {
  const jobs = JOBS.filter((j) => (names ? names.includes(j.name) : true) && j.enabled());
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
  setTimeout(beat, 3000); // shortly after start
  setInterval(beat, 20e3).unref();
}
