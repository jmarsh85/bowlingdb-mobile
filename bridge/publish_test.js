'use strict';
const assert = require('assert'); const P = require('./publish.js'); const B = require('../catalog/build_catalog.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const rec = (o) => Object.assign({ decision: 'auto', catalogId: 'brunswick-combat', url: 'https://b/combat', fetched: '2026-10-07',
  specs: { core: 'Rampart', coverName: 'Alpha Premier Pearl', coverType: 'Pearl Reactive', finish: '500, 1500 Siaair', released: '2025-08-14',
    weights: { 15: { RG: 2.502, Diff: 0.051, IntDiff: 0.019 }, 16: { RG: 2.515, Diff: 0.043, IntDiff: 0.016 } } },
  mfgScales: { brunswickStrength: 94 }, imageUrl: 'https://img' }, o);
let r = P.publish([rec({}), rec({ decision: 'pending', catalogId: 'brunswick-x', url: 'u2' }), rec({ catalogId: 'storm-hy-road', url: 'u3',
  specs: { core: 'Inverted Fe2', coreType: 'Symmetrical', weights: { 16: { RG: 2.52, Diff: 0.058, IntDiff: null } } } })]);
const e = r.specs['brunswick-combat'];
ok(r.report.published === 2 && !r.specs['brunswick-x'], 'auto published, pending not');
ok(e.SpecsByWeight['15'].RG === 2.502 && e.Core.Name === 'Rampart' && e.Cover.Type === 'Pearl Reactive' && e.DateReleased === '2025-08-14', 'shape');
ok(e.Source === 'https://b/combat' && e.Checked === '2026-10-07', 'provenance carried');
ok(!JSON.stringify(r.specs).includes('94') && !JSON.stringify(r.specs).includes('https://img'), 'mfg scales + image never published');
ok(r.specs['storm-hy-road'].Core.Type === 'Symmetrical', 'core type mapped when stated');
{ const rr = P.publish([rec({ rawText: 'Coverstock: SECRET-RAW-LINE' })]); ok(!JSON.stringify(rr.specs).includes('SECRET-RAW-LINE'), 'rawText never published (v30.172)'); }
r = P.publish([rec({ specs: { weights: {} } })]); ok(r.report.skippedNoWeights === 1 && r.report.published === 0, 'no weights -> not published');
r = P.publish([rec({}), rec({ url: 'other', specs: { weights: { 15: { RG: 2.6, Diff: 0.04 } } } })]);
ok(r.report.conflicts[0] === 'brunswick-combat' && !r.specs['brunswick-combat'], 'two sources disagree -> neither published');
r = P.publish([rec({ decision: 'pending', catalogId: null, url: 'v' })], [{ url: 'v', catalogId: 'brunswick-combat', action: 'approve' }]);
ok(r.specs['brunswick-combat'] && r.report.approved === 1, 'ticked box publishes a pending row');
r = P.publish([rec({ decision: 'pending', catalogId: null, url: 'fam', candidates: ['x-black', 'x-cherry'] })],
  [{ url: 'fam', catalogId: 'x-black', action: 'approve' }, { url: 'fam', catalogId: 'x-cherry', action: 'approve' }]);
ok(r.specs['x-black'] && r.specs['x-cherry'], 'one family page, two ticked colourways');
r = P.publish([rec({}), rec({ url: 'mine', decision: 'pending', specs: { weights: { 15: { RG: 2.6, Diff: 0.04 } } } })],
  [{ url: 'mine', catalogId: 'brunswick-combat', action: 'approve' }]);
ok(r.specs['brunswick-combat'].SpecsByWeight['15'].RG === 2.6, 'your approval beats auto');
r = P.publish([rec({})], [{ url: 'https://b/combat', action: 'reject' }]); ok(r.report.published === 0, 'reject wins over auto');
/* end to end through the real build_catalog.js */
const rows = [{ mfg: 'Brunswick', ballName: 'Combat', approvalISO: '2025-08-01', approvalDateOK: true },
              { mfg: 'Brunswick', ballName: 'Zebra', approvalISO: '2024-01-01', approvalDateOK: true }];
const pub = P.publish([rec({})]).specs;
const b = B.build(rows, pub, '2026-10-06');
const shard = b.shards['brunswick'];
const c = shard.find(x => x.CatalogID === 'brunswick-combat'), z = shard.find(x => x.CatalogID === 'brunswick-zebra');
ok(c.SpecsByWeight['15'].Diff === 0.051 && c.Cover.Name === 'Alpha Premier Pearl' && c.DateReleased === '2025-08-14', 'merged into detail shard by build_catalog');
ok(Object.keys(z.SpecsByWeight).length === 0 && b.review.missingSpecs.includes('brunswick-zebra'), 'unmatched ball untouched');
ok(c.USBC.ApprovedDate === '2025-08-01' && c.DateReleased !== c.USBC.ApprovedDate, 'release date is not the approval date');
/* v30.171 CAT-NEW-1/3: status + cover/core codes reach the index */
{ const pubS = P.publish([rec({ status: 'retired' }), rec({ catalogId: 'brunswick-zebra', url: 'z', status: 'unknown' })]).specs;
  ok(pubS['brunswick-combat'].Status === 'retired' && !('Status' in pubS['brunswick-zebra']), 'Status published; unknown left out');
  const bs = B.build(rows, pubS, '2026-10-06'), ix = bs.index.find(x => x.i === 'brunswick-combat'), iz = bs.index.find(x => x.i === 'brunswick-zebra');
  ok(ix.r === 1 && !('r' in iz), 'index r=1 retired; absent when unknown');
  ok(ix.cv === 'P' && iz.cv === 'P', 'cover code from stated type');
  ok(B.build(rows, P.publish([rec({ status: 'current' })]).specs, 'x').index.find(x => x.i === 'brunswick-combat').r === 0, 'current -> r=0');
  ok(B.coverCode({ Type: null, Name: 'Hybrid Reactive' }) === 'H' && B.coverCode({ Type: null, Name: 'Pearl Hybrid' }) === null, 'name only when it names one class');
  ok(B.coverCode({ Type: 'Urethane' }) === 'U' && B.coverCode({ Type: 'Solid Reactive' }) === 'S' && B.coverCode({ Type: 'Polyester' }) === null, 'type classes');
  ok(B.coreCode({ Type: 'Asymmetrical' }) === 'a' && B.coreCode({ Type: 'Symmetrical' }) === 's' && B.coreCode({}) === null, 'core codes'); }
console.log('publish_test: ' + n + ' checks passed');
