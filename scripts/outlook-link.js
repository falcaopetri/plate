// Outlook on the web: build a link to the open e-mail and test which form really reopens it.
// Paste in the browser console (F12) of the Outlook tab with ONE e-mail open (the URL has .../id/<long id>). No extension needed.
// It opens each candidate in a new tab (allow pop-ups for outlook.office.com), waits, and reports whether the tab kept the
// e-mail (the URL still carries the id) or got bounced to the app's home. The first one that holds is copied to the clipboard.
(async () => {
  const m = location.pathname.match(/\/id\/([^/?#]+)/);
  if (!m) return console.error('No /id/<id> in this URL: open one e-mail (click it in the list) and run again.');
  const id = decodeURIComponent(m[1]), enc = encodeURIComponent(id), o = location.origin;
  const subject = document.title.split(' - ')[0];
  const cands = {
    'owa ItemID': `${o}/owa/?ItemID=${enc}&exvsurl=1&viewmodel=ReadMessageItem`,
    'mail/deeplink/read': `${o}/mail/deeplink/read/${enc}`,
    'mail/id': `${o}/mail/id/${enc}`,
    'as in the address bar': location.href,
  };
  const key = id.slice(0, 24), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = []; let winner = null;
  for (const [name, url] of Object.entries(cands)) {
    const w = window.open(url, '_blank');
    if (!w) { rows.push({ form: name, result: 'pop-up blocked: allow pop-ups and rerun' }); continue; }
    await sleep(9000); // the app redirects client-side after loading
    let href = '', title = '';
    try { href = w.location.href; title = w.document.title; } catch { href = '(cross-origin: sent to a login page?)'; }
    const kept = href.includes(key) || decodeURIComponent(href).includes(key);
    rows.push({ form: name, kept, 'final url': href.slice(0, 90), title: title.slice(0, 50), sameSubject: !!subject && title.includes(subject) });
    try { w.close(); } catch {}
    if (kept && !winner && name !== 'as in the address bar') winner = url;
  }
  console.table(rows);
  if (winner) { try { await navigator.clipboard.writeText(winner); console.log('Copied:', winner); } catch { console.log('Link (copy it):', winner); } }
  else console.warn('None of the generated forms held. Send the table above to the Plate session.');
})();
