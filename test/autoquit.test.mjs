import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PLATE_CACHE_DIR = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/plate-aq-');
process.env.PLATE_AUTOQUIT = '1';
const { ping, bye, enabled } = await import('../lib/autoquit.mjs');

test('autoquit is on only with the env var', () => assert.equal(enabled, true));
test('ping/bye accept ids and ignore empty ones', () => { ping(''); ping('a'); bye('a'); bye('zzz'); });
