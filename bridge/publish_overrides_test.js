/* v30.170: corrections from the app (corrections/overrides.json) applied at publish. */
'use strict';
const assert = require('assert');
const P = require('./publish.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const row = (id, extra) => Object.assign({ url: 'https://t/' + id, catalogId: id, decision: 'auto', fetched: '2026-10-10',
  specs: { coverName: 'LMP Gen1T Solid', coverType: null, finish: '2000', core: 'Track Symmetric', coreType: null, released: null,
           weights: { 16: { RG: 2.58, Diff: 0.023 }, 15: { RG: 2.57, Diff: null }, 14: { RG: 2.56, Diff: 0.036 } } } }, extra || {});
/* without a correction 15 lb is dropped (no Diff) */
let r = P.publish([row('a')], [], {});
ok(!r.specs.a.SpecsByWeight['15'] && r.specs.a.SpecsByWeight['16'], 'no correction: 15 lb not published');
/* maker correction fills it and is marked */
r = P.publish([row('a')], [], { a: { weights: { 15: { Diff: 0.029 } }, coreType: 'Symmetrical', source: 'maker', at: '2026-10-10' } });
ok(r.specs.a.SpecsByWeight['15'].Diff === 0.029 && r.specs.a.SpecsByWeight['15'].RG === 2.57, 'correction fills 15 lb, keeps RG');
ok(r.specs.a.Core.Type === 'Symmetrical' && r.specs.a.Corrected.source === 'maker' && r.report.corrected === 1, 'core type + Corrected marker + count');
ok(r.specs.a.SpecsByWeight['16'].Diff === 0.023, 'untouched weights unchanged');
/* bowwwl corrections are never published */
r = P.publish([row('a')], [], { a: { weights: { 15: { Diff: 0.029 } }, source: 'bowwwl' } });
ok(!r.specs.a.SpecsByWeight['15'] && !r.specs.a.Corrected && r.report.correctionsNotPublished[0] === 'a', 'bowwwl correction skipped and reported');
/* a correction alone never publishes a ball that is not auto/approved */
r = P.publish([row('b', { decision: 'pending' })], [], { b: { weights: { 15: { Diff: 0.029 } }, source: 'maker' } });
ok(!r.specs.b, 'pending ball stays unpublished');
/* approved via the issue: correction applies to the approved row */
r = P.publish([row('c', { decision: 'pending' })], [{ url: 'https://t/c', catalogId: 'c', action: 'approve' }], { c: { weights: { 15: { Diff: 0.029 } }, source: 'other' } });
ok(r.specs.c.SpecsByWeight['15'].Diff === 0.029 && r.specs.c.Corrected.source === 'other', 'approved + corrected');
/* staged row object is not modified */
const st = row('d'); P.publish([st], [], { d: { weights: { 15: { Diff: 0.029 } }, source: 'maker' } });
ok(st.specs.weights[15].Diff === null, 'staging rows left as read');
/* old two-argument call still works (publish_test.js) */
ok(P.publish([row('e')], []).specs.e && P.publish([row('e')]).report.corrected === 0, 'backward compatible');
console.log('publish_overrides_test: ' + n + ' checks passed');
