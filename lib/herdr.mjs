// Herdr (https://herdr.dev) integration, behind the `herdr: on` toggle in sources.md. Off (default): the Devin runs are headless
// child processes and nobody sees them in Herdr. On: each run is an interactive agent in a Herdr tab, so it shows up in the
// agents list with its status. One Herdr *space* per workstream (named like it; sessions without a workstream share a space
// called "Plate"), one *tab* per session, so a workstream can hold several. Needs the Herdr app open (`herdr-app do …` talks to
// its window); any failure throws and the caller falls back to the headless run.
import { execFile } from 'node:child_process';
import { readSources } from './store.mjs';

export const herdrOn = () => ['on', 'true', '1'].includes(String(readSources().herdr ?? '').trim().toLowerCase());
const bin = () => process.env.HERDR_APP_BIN || readSources().herdr_bin || 'herdr-app';
const INBOX_SPACE = 'Plate';

const call = (args) => new Promise((ok, no) => {
  execFile(bin(), args, { timeout: 15000, maxBuffer: 4 << 20 }, (err, out, errOut) => {
    if (err) return no(new Error(err.code === 'ENOENT' ? `herdr-app not found (${bin()}); set herdr_bin` : (String(errOut || out || err.message).trim().split('\n')[0] || err.message)));
    try { const j = JSON.parse(out); j?.error ? no(new Error(j.error)) : ok(j); } catch { no(new Error(`herdr-app answered something unreadable: ${String(out).slice(0, 120)}`)); }
  });
});

// Opens run at a time: two sessions of a new workstream would otherwise both see "no such space" and create it twice
let chain = Promise.resolve();
// {workstream: name | null, folder, tab, argv: [program, …args], task?: first message} -> {space, tab, terminal, created: bool}
// `reuseFolder`: for work that belongs to no workstream, an existing space opened on that folder (the repo's own space) is used
// before a new "Plate" one is made
export function openInHerdr({ workstream, folder, tab, argv, task, reuseFolder }) {
  const job = chain.then(async () => {
    const space = String(workstream || '').trim() || INBOX_SPACE;
    const spaces = (await call(['ls'])).spaces || [];
    const same = (a, b) => String(a || '').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\/+$/, '').toLowerCase();
    const mine = spaces.filter((s) => !s.machine);
    const have = mine.find((s) => s.name === space) || mine.find((s) => same(s.name, space)) || (reuseFolder && mine.find((s) => same(s.folder, reuseFolder))) || null;
    const body = { folder, argv, ...(task ? { task } : {}) };
    const tabName = String(tab || '').slice(0, 40);
    const r = have
      ? await call(['do', 'tab.new', JSON.stringify({ space: have.id, name: tabName, ...body })])
      : await call(['do', 'space.new', JSON.stringify({ name: space, tab: tabName, ...body })]);
    return { space: have?.name || space, spaceId: r.space, tab: r.tab, terminal: r.terminal, created: !have };
  });
  chain = job.catch(() => {});
  return job;
}
