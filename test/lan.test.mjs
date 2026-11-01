// `lan: on`: other devices need the token, this machine never does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-lan-'));
process.env.PLATE_CACHE_DIR = cache;
const { check, lanToken, isLocal } = await import('../lib/lan.mjs');
const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
const u = (q = '') => new URL(`http://x/${q}`);

test('token is created once, 48 hex chars, private file', () => {
  const t = lanToken();
  assert.match(t, /^[0-9a-f]{48}$/);
  assert.equal(lanToken(), t);
  assert.equal(fs.statSync(path.join(cache, 'lan-token')).mode & 0o077, 0);
});
test('this machine passes, others need ?t= (login) or the cookie', () => {
  const t = lanToken();
  assert.ok(isLocal('::ffff:127.0.0.1'));
  assert.equal(check(req('127.0.0.1'), u()), 'ok');
  assert.equal(check(req('192.168.1.20'), u()), 'deny');
  assert.equal(check(req('192.168.1.20'), u('?t=wrong')), 'deny');
  assert.equal(check(req('192.168.1.20'), u(`?t=${t}`)), 'login');
  assert.equal(check(req('192.168.1.20', { cookie: `a=b; plate_t=${t}` }), u()), 'ok');
  assert.equal(check(req('192.168.1.20', { cookie: 'plate_t=nope' }), u()), 'deny');
  assert.equal(check(req('192.168.1.20', { 'x-plate-token': t }), u()), 'ok'); // phone browsers that drop the cookie
  assert.equal(check(req('192.168.1.20', { 'x-plate-token': 'no' }), u()), 'deny');
  assert.equal(check(req('192.168.1.20'), new URL('http://x/vendor/qrcode.js')), 'ok');
});
