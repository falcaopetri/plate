// "I reviewed your PR" on Teams, opened for you when you archive the Devin review session: a session anchored to a PR that goes to
// `done` between two Devin collector runs opens the Teams chat with the draft message (macOS `open`; PLATE_OPEN_BIN swaps it).
// Nothing is sent: you press Enter in Teams. The author's e-mail is `people:` in sources.md (`- <github login>: <e-mail>`).
//   sources.md: `teams_after_review: off` disables the automatic opening (the "Teams → @autor" chip stays).
import { spawn } from 'node:child_process';
import { readItems, writeItems, readSources } from './store.mjs';
import { log } from './log.mjs';

const emailFor = (login) => (login && (readSources().people || {})[login]) || null;

export const teamsLink = (email, text) => `msteams://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}&message=${encodeURIComponent(text)}`;
const opener = (url) => {
  const bin = process.env.PLATE_OPEN_BIN || (process.platform === 'darwin' ? 'open' : null);
  if (!bin) return false;
  const c = spawn(bin, [url], { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref();
  return true;
};

export const snapshotSessions = () => new Map(readItems().filter((i) => i.tool === 'devin' && i.anchor).map((i) => [i.id, i.state]));
// after a Devin collector run: sessions anchored to a PR that were not done before and are now (archived) get their Teams chat opened
export async function notifyArchived(before) {
  if (String(readSources().teams_after_review ?? '').toLowerCase() === 'off') return 0;
  const items = readItems(), opened = [];
  for (const s of items) {
    if (s.tool !== 'devin' || !s.anchor || s.state !== 'done' || s.teamsNotified || !before.has(s.id) || before.get(s.id) === 'done') continue;
    const pr = items.find((i) => (i.url || '').replace(/[#?].*$/, '') === s.anchor && i.state !== 'gone');
    if (!pr?.author || pr.mineWhy?.includes('author')) continue;
    const email = emailFor(pr.author);
    if (!email) { log.info(`teams: no e-mail for @${pr.author}, chat not opened`); continue; }
    if (opener(teamsLink(email, `Oi! Fiz o review do seu PR "${pr.title}": ${s.anchor}`))) { s.teamsNotified = true; opened.push(pr.author); }
  }
  if (opened.length) { writeItems(items); log.info(`teams: opened a chat draft for ${opened.map((a) => '@' + a).join(', ')} (review archived)`); }
  return opened.length;
}
