#!/usr/bin/env node
// Stand-in for macOS `dscl` (PLATE_DSCL_BIN): knows one user, jdoe <jdoe@corp.com>.
const a = process.argv.slice(2);
if (a.includes('-search')) {
  if (a[3] === 'EMailAddress' && a[4] === 'jdoe@corp.com') console.log('jdoe                    EMailAddress = ("jdoe@corp.com")');
} else if (a.includes('JPEGPhoto')) {
  console.log(`<plist><dict><key>dsAttrTypeStandard:JPEGPhoto</key><array><data>${Buffer.alloc(300, 7).toString('base64')}</data></array></dict></plist>`);
} else if (a.includes('-read') && a.includes('/Users/jdoe')) {
  console.log(JSON.stringify({ 'dsAttrTypeStandard:RealName': ['Jane Doe'], 'dsAttrTypeStandard:EMailAddress': ['jdoe@corp.com'], 'dsAttrTypeNative:title': ['Staff Engineer'], 'dsAttrTypeNative:department': ['Platform'], 'dsAttrTypeNative:company': ['Corp'] }));
}
