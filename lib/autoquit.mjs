// `PLATE_AUTOQUIT=1` (set by the Mac app, scripts/build-app.sh): the server exits once no browser page is open.
// Each page pings /api/ping?p=<id> every 30 s and sends /api/bye?p=<id> on pagehide. A reload sends bye and then pings again
// within the grace, so it doesn't count. A page that stops pinging (browser killed, tab frozen) expires after EXPIRE_MS.
import { log } from './log.mjs';

const GRACE_MS = 8_000, EXPIRE_MS = 180_000, START_MS = 90_000;
const pages = new Map(); // page id -> last ping
let emptySince = null, seen = false;
const t0 = Date.now();

export const enabled = process.env.PLATE_AUTOQUIT === '1';
export function ping(id) { if (!id) return; pages.set(id, Date.now()); seen = true; emptySince = null; }
export function bye(id) { if (pages.delete(id) && !pages.size) emptySince = Date.now(); }
export function startAutoquit(exit = () => process.exit(0)) {
  if (!enabled) return;
  setInterval(() => {
    const now = Date.now();
    for (const [id, at] of pages) if (now - at > EXPIRE_MS) { pages.delete(id); if (!pages.size) emptySince = now; }
    const idle = pages.size === 0 && (seen ? emptySince != null && now - emptySince > GRACE_MS : now - t0 > START_MS);
    if (idle) { log.info('autoquit: no page open, stopping'); exit(); }
  }, 2000).unref();
}
