// Periodic collection inside the server, plus the write lock that keeps it from racing UI writes.
// Collectors rewrite items.jsonl whole, so a collector run and a drag in the UI must never overlap:
// every POST handler and every collector run goes through `withLock`.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, readSources } from './store.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let chain = Promise.resolve();
export const withLock = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

const min = (env, def) => Number(process.env[env] || def) * 60e3;
// enabled() is checked at every tick, so adding a board to sources.md or a token turns a job on without a restart
const JOBS = [
  { name: 'devin', script: 'collectors/devin.mjs', every: min('PLATE_EVERY_DEVIN', 2), enabled: () => true },
  { name: 'github', script: 'collectors/github.mjs', every: min('PLATE_EVERY_GITHUB', 15), enabled: () => readSources().github_projects.length > 0 },
  { name: 'todoist', script: 'collectors/todoist.mjs', every: min('PLATE_EVERY_TODOIST', 15), enabled: () => !!process.env.TODOIST_API_TOKEN },
];
export const status = {}; // name -> {at, ok, msg}

const runOne = (job) => withLock(() => new Promise((done) => {
  execFile(process.execPath, [job.script], { cwd: root, env: { ...process.env, PLATE_DATA_DIR: DATA_DIR }, timeout: 120e3, maxBuffer: 16e6 }, (err, stdout, stderr) => {
    const last = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';
    status[job.name] = { at: new Date().toISOString(), ok: !err, msg: err ? last(stderr) || err.message : last(stdout) };
    if (err) console.error(`collect ${job.name}: ${status[job.name].msg}`);
    done(status[job.name]);
  });
}));

// names: subset to run now (manual "Sync now"); default = every enabled job
export async function collectNow(names) {
  const jobs = JOBS.filter((j) => (names ? names.includes(j.name) : true) && j.enabled());
  for (const j of jobs) await runOne(j); // one at a time: they share items.jsonl
  return jobs.map((j) => j.name);
}

export function startSchedule() {
  if (process.env.PLATE_NO_SCHEDULE) return;
  for (const job of JOBS) {
    const tick = () => { if (job.enabled()) runOne(job); };
    setTimeout(tick, 3000); // shortly after start
    setInterval(tick, job.every).unref();
  }
}
