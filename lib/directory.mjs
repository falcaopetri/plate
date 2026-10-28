// Look a person up in the corporate directory through macOS Directory Services (`dscl`), which a Mac bound to Active Directory
// exposes under /Search. By e-mail only (the unambiguous key). Read-only; no login of our own: it uses what the Mac already has.
//   sources.md: `people_directory: off` disables it; `dscl_node` overrides the search node (default /Search).
//   PLATE_DSCL_BIN swaps the binary (tests use a stub).
// Written against dscl's documented output; the attribute names differ per AD schema mapping, so each field tries the standard
// attribute first, then the raw AD one. Not run against a real directory yet: the work Mac is the test.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSources, BadRequest } from './store.mjs';

const run = promisify(execFile);
const bin = () => process.env.PLATE_DSCL_BIN || 'dscl';
const EMAIL = /^[^\s@/\\]+@[^\s@/\\]+$/;
const first = (rec, ...keys) => { for (const k of keys) { const v = [].concat(rec[k] ?? []).map((x) => String(x).trim()).find(Boolean); if (v) return v; } return null; };

export const directoryEnabled = () => String(readSources().people_directory ?? '').toLowerCase() !== 'off' && (process.platform === 'darwin' || !!process.env.PLATE_DSCL_BIN);

// -> { name, email, role, department, company, photo: Buffer|null } or null when the directory has no such user
export async function lookupByEmail(email) {
  email = String(email || '').trim();
  if (!EMAIL.test(email)) throw new BadRequest('not an e-mail address');
  if (!directoryEnabled()) throw new BadRequest('directory lookup is off here (macOS only; people_directory: off in sources.md)');
  const node = readSources().dscl_node || '/Search';
  let record = null;
  for (const attr of ['EMailAddress', 'dsAttrTypeNative:mail', 'dsAttrTypeNative:userPrincipalName']) {
    try {
      const { stdout } = await run(bin(), [node, '-search', '/Users', attr, email], { timeout: 8e3 });
      record = stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s{2,}|\t/)[0]).find((n) => n && !/^[(\s)]*$/.test(n) && !n.includes('='));
    } catch { /* attribute not mapped on this node: try the next */ }
    if (record) break;
  }
  if (!record) return null;
  const want = ['RealName', 'EMailAddress', 'JobTitle', 'Department', 'Company', 'dsAttrTypeNative:title', 'dsAttrTypeNative:department', 'dsAttrTypeNative:company', 'dsAttrTypeNative:displayName'];
  const { stdout } = await run(bin(), ['-plist', node, '-read', `/Users/${record}`, ...want], { timeout: 8e3 });
  const rec = await plistToObject(stdout);
  return {
    name: first(rec, 'dsAttrTypeStandard:RealName', 'dsAttrTypeNative:displayName'), email: first(rec, 'dsAttrTypeStandard:EMailAddress') || email,
    role: first(rec, 'dsAttrTypeStandard:JobTitle', 'dsAttrTypeNative:title'), department: first(rec, 'dsAttrTypeStandard:Department', 'dsAttrTypeNative:department'),
    company: first(rec, 'dsAttrTypeStandard:Company', 'dsAttrTypeNative:company'), photo: await photoOf(node, record),
  };
}

// dscl -plist output -> JSON through plutil (built into macOS); the stub in tests prints JSON directly
async function plistToObject(text) {
  if (text.trim().startsWith('{')) return JSON.parse(text);
  const child = execFile('plutil', ['-convert', 'json', '-o', '-', '-'], { maxBuffer: 16e6 });
  const out = new Promise((ok, no) => { let b = ''; child.stdout.on('data', (c) => (b += c)); child.on('close', (c) => (c ? no(new Error('plutil failed')) : ok(b))); });
  child.stdin.end(text);
  return JSON.parse(await out);
}
// the photo is a <data> blob (base64) in the plist; plutil can't turn that into JSON, so read it from the XML; best effort
async function photoOf(node, record) {
  try {
    const { stdout } = await run(bin(), ['-plist', node, '-read', `/Users/${record}`, 'JPEGPhoto'], { timeout: 8e3, maxBuffer: 8e6 });
    const m = stdout.match(/<data>([\s\S]*?)<\/data>/);
    const buf = m ? Buffer.from(m[1].replace(/\s+/g, ''), 'base64') : null;
    return buf && buf.length > 100 && buf.length < 4e6 ? buf : null;
  } catch { return null; }
}
