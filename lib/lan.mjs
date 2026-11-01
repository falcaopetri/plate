// Access from other devices (a phone on the same wifi). Off by default: the server listens on 127.0.0.1 only. With `lan: on` in
// sources.md it listens on all interfaces, and every request that does not come from this machine needs the access token
// (`<cache>/lan-token`, created on first use) — in `?t=<token>` once (it becomes a cookie) or in the cookie afterwards. Plate has no
// login and its routes write files and run Devin, so the token is what stands between the wifi and the data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const cacheDir = () => process.env.PLATE_CACHE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache');
export const COOKIE = 'plate_t';

export function lanToken() {
  const f = path.join(cacheDir(), 'lan-token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t.length >= 32) return t; } catch {}
  fs.mkdirSync(cacheDir(), { recursive: true });
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t + '\n', { mode: 0o600 });
  return t;
}
export const isLocal = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export const cookieOf = (req) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE)?.[1] || '';
export const lanUrls = (port) => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${port}/?t=${lanToken()}`);

// The token travels three ways, because some phone browsers (in-app browsers, private tabs) drop the cookie: `?t=` on the first page
// load (the page keeps it and sends it as `X-Plate-Token` on every fetch), that header, and the cookie it also sets.
// 'ok' = serve it; 'login' = valid ?t= (serve it and set the cookie); 'deny' = 401, with the reason for the log
export function check(req, url) {
  if (isLocal(req.socket.remoteAddress)) return 'ok';
  if (url.pathname.startsWith('/vendor/')) return 'ok'; // an open-source library, no data
  const tok = lanToken();
  if (url.searchParams.has('t') && same(url.searchParams.get('t'), tok)) return 'login';
  if (same(req.headers['x-plate-token'] || '', tok) || same(cookieOf(req), tok)) return 'ok';
  return 'deny';
}
export const whyDenied = (req, url) => url.searchParams.has('t') ? 'wrong ?t=' : req.headers['x-plate-token'] ? 'wrong header token' : cookieOf(req) ? 'wrong cookie' : 'no token (no ?t=, header or cookie)';
