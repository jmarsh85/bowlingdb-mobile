'use strict';
const assert = require('assert'); const A = require('./approvals.js'); const P = require('./publish.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const w = { 15: { RG: 2.49, Diff: 0.05, IntDiff: null } };
const staged = [
  { decision: 'pending', reason: 'variant', source: 'columbia', title: 'Messenger', url: 'https://c/messenger', candidates: ['columbia-300-messenger-black', 'columbia-300-messenger-cherry'], specs: { weights: w } },
  { decision: 'pending', reason: 'conflicting-sources', source: 'ebonite', title: 'Tornado - Hot Pink', url: 'https://e/t1', catalogId: 'ebonite-tornado', specs: { weights: w } },
  { decision: 'pending', reason: 'out-of-range:16:IntDiff=0.2', source: 'storm', title: 'MONSOON', url: 'https://s/m', catalogId: 'storm-monsoon', specs: { weights: { 16: { RG: 2.53, Diff: 0.042, IntDiff: null } } } },
  { decision: 'pending', reason: 'no-usbc', source: 'storm', title: 'ONYX POLYESTER', url: 'https://s/o', candidates: [], specs: { weights: w } },
  { decision: 'pending', reason: 'no-weight-specs', source: 'hammer', title: 'Absolut Curve', url: 'https://h/a', catalogId: 'hammer-x', specs: { weights: {} } },
  { decision: 'auto', catalogId: 'brunswick-combat', url: 'https://b/c', specs: { weights: w } }];
let body = A.render(staged, '');
ok((body.match(/- \[ \]/g) || []).length === 4, 'boxes: 2 colourways + conflict + out-of-range');
ok(!/ONYX|Absolut/.test(body.split('---')[0]) && /no-usbc 1/.test(body) && /no-weight-specs 1/.test(body), 'unpublishable rows counted, not boxed');
ok(/RG 2.53 \/ Diff 0.042 @16 lb/.test(body) && /\[source\]\(https:\/\/s\/m\)/.test(body), 'specs + source link shown');
const tickedBody = body.replace('- [ ] **Messenger** → `columbia-300-messenger-black`', '- [x] **Messenger** → `columbia-300-messenger-black`');
const d = A.parse(tickedBody);
ok(d.length === 1 && d[0].url === 'https://c/messenger' && d[0].catalogId === 'columbia-300-messenger-black', 'parse ticked box');
const again = A.render(staged, tickedBody);
ok(A.parse(again).length === 1, 're-render keeps your ticks');
ok(A.parse(A.render(staged.slice(1), tickedBody)).length === 0, 'tick for a page no longer staged drops out of the body');
const pub = P.publish(staged, d);
ok(pub.specs['columbia-300-messenger-black'] && pub.specs['brunswick-combat'] && !pub.specs['columbia-300-messenger-cherry'], 'publish honours the tick');
const big = []; for (let i = 0; i < 600; i++) big.push({ decision: 'pending', reason: 'variant', source: 's', title: 'Ball ' + i, url: 'https://x/' + i, candidates: ['a-' + i, 'b-' + i], specs: { weights: w } });
const bb = A.render(big, ''); ok(bb.length <= 65536 && /truncated/.test(bb), 'stays under GitHub body limit');
console.log('approvals_test: ' + n + ' checks passed');
