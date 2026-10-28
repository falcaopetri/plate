// `npm start` runs this first: stops a Plate server already listening on PORT (default 4173) so the new one can bind.
// Only kills a process whose command line runs server.mjs; anything else on the port is left alone (the start then fails loudly).
import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.PORT) || 4173;
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

for (const pid of run('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN']).split('\n').filter(Boolean)) {
  if (!/server\.mjs/.test(run('ps', ['-o', 'command=', '-p', pid]))) { console.log(`port ${PORT} is held by pid ${pid} (not Plate); leaving it`); continue; }
  process.kill(Number(pid), 'SIGTERM');
  console.log(`stopped the Plate server on :${PORT} (pid ${pid})`);
  for (let n = 0; n < 20 && run('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN']); n++) run('sleep', ['0.15']);
}
