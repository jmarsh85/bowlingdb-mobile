/* bridge/bwread_test.js -- node bwread_test.js (no network) */
'use strict';
const B = require('./bwread.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b));

/* fixture shaped like the Absolute Reign page (2026-10-21): Drupal fields, h5 cover/core, h6 weights */
const W = (lb, rg, d, mb) => `<h6>${lb} pounds</h6><div class="field"><div class="field__label">RG</div><div class="field__item">${rg}</div></div><div class="field"><div class="field__label">Diff</div><div class="field__item">${d}</div></div><div class="field"><div class="field__label">MB Diff</div><div class="field__item">${mb}</div></div>`;
const HTML = `<html><head><meta property="og:image" content="https://www.bowwwl.com/sites/default/files/styles/ball_image_main/public/balls/storm-absolute-reign.png?itok=P_wc8Pgs"><script>var x='<h1>no</h1>';</script></head><body>
<nav><ul><li><a href="/bowling-ball-database">Bowling Ball Database</a></li></ul></nav>
<h1 class="title">Absolute Reign</h1><img src="https://www.bowwwl.com/sites/default/files/styles/ball_grid/public/balls/storm-absolute-reign.png?itok=N">
<div class="field"><div class="field__label">Release Date</div><div class="field__item">Jan 2026</div></div>
<div><strong>Overseas/International Release</strong></div><p>Translated from Japanese: STORM&#039;s confident work &quot;Absolute&quot;.</p>
<div class="field__label">Factory Finish</div><div class="field__item">Power Edge</div>
<h5><a href="/x/coverstocks/r2s-deep-solid">R2S DEEP Solid Coverstock</a></h5><div class="field__label">Type</div><div>Solid Reactive</div><p>Introduced in the United States in 2023.</p>
<h5><a href="/x/cores/sentinel">Sentinel Core</a></h5><img src="https://www.bowwwl.com/sites/default/files/styles/ball_image_main/public/cores/storm-sentinel-core.png?itok=z"><p>In most cases&nbsp;an extra slug.</p>
<div class="field__label">Core Type</div><div>Asymmetric</div>
${W(16, '2.480', '0.048', '0.020')}${W(15, '2.480', '0.050', '0.021')}${W(12, '2.590', '0.029', '0.008')}
<h5>Shop Coolwick Apparel at BowlersMart</h5><div>RG</div><div>9.99</div></body></html>`;

const lines = B.htmlToLines(HTML), p = B.parseLines(lines);
eq(p.name, 'Absolute Reign', 'name from h1 (not the script text)');
eq(p.released, '2026-01', 'release month');
ok(p.international, 'overseas flag');
ok(!p.discontinued, 'not discontinued');
eq(p.finish, 'Power Edge', 'finish');
eq([p.coverName, p.coverType], ['R2S DEEP Solid', 'Solid Reactive'], 'cover');
eq([p.core, p.coreType], ['Sentinel', 'Asymmetrical'], 'core');
ok(/cores\/storm-sentinel-core\.png/.test(p.coreImg || ''), 'core picture');
eq(p.weights['16'], { RG: 2.48, Diff: 0.048, IntDiff: 0.02 }, '16 lb');
eq(p.weights['12'], { RG: 2.59, Diff: 0.029, IntDiff: 0.008 }, '12 lb');
eq(Object.keys(p.weights).sort(), ['12', '15', '16'], 'shop section after weights is not a weight');
ok(/balls\/storm-absolute-reign\.png/.test(B.ogImage(HTML) || ''), 'og:image');
ok(lines.some(l => /STORM\u2019s confident/.test(l)), 'entities decoded');

/* discontinued + symmetric + no international */
const p2 = B.parseLines(B.htmlToLines('<h1>Phaze II</h1><div>Discontinued</div><div>Release Date</div><div>Sept 2015</div><h5>Velocity Core</h5><div>Core Type</div><div>Symmetric</div><h6>15 pounds</h6><div>RG</div><div>2.480</div><div>Diff</div><div>0.051</div>'));
ok(p2.discontinued && !p2.international, 'discontinued flag');
eq(p2.released, '2015-09', 'Sept month');
eq(p2.coreType, 'Symmetrical', 'symmetric');
eq(p2.weights['15'], { RG: 2.48, Diff: 0.051 }, 'no MB diff for sym');

/* addresses */
ok(B.URL_OK.test('https://www.bowwwl.com/bowling-ball-database/storm/absolute-reign'), 'url ok');
ok(!B.URL_OK.test('https://www.bowwwl.com/bowling-ball-database/storm'), 'brand page refused');
ok(!B.URL_OK.test('https://evil.example/bowling-ball-database/storm/x'), 'other host refused');
ok(!B.URL_OK.test('https://www.bowwwl.com/bowling-ball-database/storm/x?y=1'), 'query refused');

/* seal -> open with WebCrypto, exactly as the phone does */
(async () => {
  const s = require('crypto').webcrypto.subtle;
  const kp = await s.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const spki = Buffer.from(await s.exportKey('spki', kp.publicKey)).toString('base64');
  const box = B.seal({ page: p, hi: 'caf\u00e9' }, spki);
  const b = x => Uint8Array.from(Buffer.from(x, 'base64'));
  const raw = await s.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, b(box.k));
  const aes = await s.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const txt = new TextDecoder().decode(await s.decrypt({ name: 'AES-GCM', iv: b(box.iv) }, aes, b(box.d)));
  const back = JSON.parse(txt);
  eq(back.page.core, 'Sentinel', 'sealed round trip'); eq(back.hi, 'caf\u00e9', 'utf-8 survives');
  ok(!JSON.stringify(box).includes('Sentinel'), 'nothing readable in the sealed box');
  ok(spki.length >= 200 && spki.length <= 1200, 'key length passes the workflow check (' + spki.length + ')');
  console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
