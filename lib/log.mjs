// One timestamped log for the whole server: stdout/stderr (what `npm start` shows) plus `.cache/plate.log`, which the Settings
// drawer tails. The file is rotated once (plate.log -> plate.log.1) past 1 MB, so it never grows unbounded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.env.PLATE_CACHE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache'); // PLATE_CACHE_DIR: tests keep their lines out of the real log
export const LOG_FILE = path.join(dir, 'plate.log');
const stamp = () => new Date().toLocaleTimeString('en-GB') + '.' + String(new Date().getMilliseconds()).padStart(3, '0');

function write(level, msg) {
  const line = `${stamp()} ${level} ${msg}`;
  (level === 'ERR' ? console.error : console.log)(line);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1e6) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* logging must never break a request */ }
}
export const log = { info: (m) => write('INF', m), warn: (m) => write('WRN', m), error: (m) => write('ERR', m) };

export function tail(n = 200) {
  try { return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; }
}
