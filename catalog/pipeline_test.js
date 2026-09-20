/* catalog/pipeline_test.js — end-to-end: parse -> build -> review
 *
 *   node pipeline_test.js                     # fixtures only
 *   node pipeline_test.js --preseed p.json    # + legacy link check
 *
 * Runs against fixtures/usbc_sample.txt, which holds one line of every
 * awkward shape found in the real list. Add a line here whenever the
 * real run surprises you — this file is the regression record.
 *
 * Design ref: DESIGN_ball_catalog.md §9
 */

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const N = require('./normalize');
const B = require('./build_catalog');

const HERE = __dirname;
const FIXTURE = path.join(HERE, 'fixtures', 'usbc_sample.txt');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || detail == null ? '' : '  -> ' + JSON.stringify(detail)}`);
}

/* -------------------------------------------------------------- *
 * 1. Parse
 * -------------------------------------------------------------- */
console.log('parse');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
const rowsJSON = execFileSync('node', [path.join(HERE, 'parse_usbc.js'), FIXTURE],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rows = JSON.parse(rowsJSON);

const byName = n => rows.find(r => r.ballName === n);

ok('every fixture line parsed', rows.length === fs.readFileSync(FIXTURE, 'utf8')
   .split(/\r?\n/).filter(l => l.trim() && !/^(Page \d|Brand Ball Name|\*\* Denotes|USBC Approved|Since all|House Balls|\d{1,2}\/\d{1,2}\/\d{4}$)/.test(l.trim())).length,
   rows.length);
ok('multi-word brand split', byName('Bulldog Blue') && byName('Bulldog Blue').mfg === 'Bulldog Bowling Products');
ok('Columbia 300 beats Columbia', byName('Blue Dot') && byName('Blue Dot').mfg === 'Columbia 300');
ok('Track -> Track Inc.', byName('Precision') && byName('Precision').mfg === 'Track Inc.');
ok('** captured as weight limit', byName('Mission X Wine') &&
   byName('Mission X Wine').weightLimit === N.WEIGHT_LIMIT_UNDER_13);
ok('name kept verbatim with colourway', !!byName('Fury Orange/Red'));
ok('(All Colors) kept in BallName', !!byName('T Zone (All Colors)'));
ok('(All Colors) folded in ModelKey',
   byName('T Zone (All Colors)').modelKey === N.modelKey('Brunswick', 'Tzone'));
ok('year 3024 flagged, row kept',
   byName('Super Cuda PowerCOR') &&
   byName('Super Cuda PowerCOR').approvalDateOK === false &&
   byName('Super Cuda PowerCOR').approvalISO === null);
ok('prefix does not bleed',
   byName('Hitman').modelKey !== byName('Hitman Enforcer').modelKey);

/* -------------------------------------------------------------- *
 * 2. Build
 * -------------------------------------------------------------- */
console.log('build');
const { entries, index, shards, usbc, review } = B.build(rows, {}, '2026-09-15');

ok('one entry per row', entries.length === rows.length, { entries: entries.length, rows: rows.length });
ok('no id collisions', review.idCollisions.length === 0, review.idCollisions);
ok('CatalogID is a pure function of identity (no year appended)',
   entries.filter(e => !/-\d+$/.test(e.CatalogID) || !review.idCollisions.some(c => c.assigned === e.CatalogID))
     .every(e => e.CatalogID === B.catalogID({
       mfg: e.MFG, ballName: e.BallName, colorway: e.Colorway,
       weightLimit: e.WeightLimit })));

/* --- collision causes, all four found in the 2026-09-20 real run ----- */
const cid = (m, n, w) => B.catalogID({ mfg: m, ballName: n, colorway: null, weightLimit: w || null });
ok('superscript survives (X vs X-squared)',
   cid('900 Global','X') !== cid('900 Global','X\u00b2'), cid('900 Global','X\u00b2'));
ok('505C vs 505C-squared distinct',
   cid('Track Inc.','505C') !== cid('Track Inc.','505C\u00b2'));
ok('plus survives (Results vs Results+)',
   cid('Radical','Results') !== cid('Radical','Results+'));
ok('(All Colors) kept in CatalogID',
   cid('Roto Grip','Cosmos') !== cid('Roto Grip','Cosmos (All Colors)'));
ok('** entry distinct from full-weight entry',
   cid('Ebonite','Wolf') !== cid('Ebonite','Wolf', N.WEIGHT_LIMIT_UNDER_13));
ok('** suffix is u13',
   cid('Ebonite','Wolf', N.WEIGHT_LIMIT_UNDER_13).endsWith('-u13'));
ok('(All Colors) still folded in ModelKey (legacy matching)',
   N.modelKey('Roto Grip','Cosmos') === N.modelKey('Roto Grip','Cosmos (All Colors)'));

/* --- no row may ever be dropped -------------------------------------- */
{
  const dupes = [
    { mfg:'Ebonite', ballName:'Turbo X', colorway:null, modelKey:'ebonite|turbox' },
    { mfg:'Ebonite', ballName:'Turbo X', colorway:null, modelKey:'ebonite|turbox' },
    { mfg:'Ebonite', ballName:'Turbo X', colorway:null, modelKey:'ebonite|turbox' },
    { mfg:'Brunswick', ballName:'(Danger) Zone', colorway:null, modelKey:'brunswick|dangerzone' },
    { mfg:'Brunswick', ballName:'Danger Zone', colorway:null, modelKey:'brunswick|dangerzone' },
  ];
  const r2 = B.build(dupes, {}, '2026-09-20');
  ok('every colliding row still published', r2.entries.length === dupes.length,
     { got: r2.entries.length, want: dupes.length });
  ok('assigned IDs unique',
     new Set(r2.entries.map(e => e.CatalogID)).size === dupes.length);
  ok('collisions reported with base and assigned',
     r2.review.idCollisions.every(c => c.base && c.assigned));
  ok('identical-name dupes flagged',
     r2.review.idCollisions.filter(c => c.identical).length === 2);
}
ok('CatalogIDs unique', new Set(entries.map(e => e.CatalogID)).size === entries.length);
ok('bad date surfaced in review', review.badDates.length === 1, review.badDates);
ok('weight limits surfaced', review.weightLimited.length >= 1);
ok('shard per manufacturer',
   Object.keys(shards).length === new Set(entries.map(e => e.MFG)).size);
ok('index is search-level only',
   Object.keys(index[0]).sort().join(',') === 'c,i,k,m,n,t,y');
ok('usbc.json versioned', usbc.ListVersion === '2026-09-15');
ok('every entry carries ListVersion',
   entries.every(e => e.USBC.ListVersion === '2026-09-15'));
ok('specs absent -> empty, not guessed',
   entries.every(e => typeof e.SpecsByWeight === 'object'));
ok('FieldSources marks USBC-sourced name',
   entries.every(e => e.FieldSources.BallName === 'usbc'));

/* -------------------------------------------------------------- *
 * 3. Determinism — the change-detection guarantee (§7)
 * -------------------------------------------------------------- */
console.log('determinism');
const a = B.stable(B.build(rows, {}, '2026-09-15').index);
const shuffled = rows.slice().reverse();
const b = B.stable(B.build(shuffled, {}, '2026-09-15').index);
ok('row order does not change output', a === b);
ok('same input -> same hash', B.sha(a) === B.sha(b));
const c = B.stable(B.build(rows, {}, '2026-09-22').index);
ok('index unaffected by list version bump', a === c);

/* -------------------------------------------------------------- *
 * 4. Legacy linking (optional)
 * -------------------------------------------------------------- */
const pi = process.argv.indexOf('--preseed');
if (pi > 0) {
  console.log('legacy link');
  const doc = JSON.parse(fs.readFileSync(process.argv[pi + 1], 'utf8'));
  const balls = doc.balls || doc;
  const idx = N.buildIndex(rows, r => r.modelKey);
  const brands = new Set(rows.map(r => N.norm(N.canonicalMfg(r.mfg))));
  /* Balls proven to match against real USBC rows. This list is the
   * gate; it only grows once a real row has been seen. Everything
   * else is reported, not asserted, because the fixture is a sample
   * and a miss may simply mean "that row isn't in the fixture". */
  const EXPECT_MATCH = [
    'Brunswick Quantum Fire Pearl',
    'Brunswick Tzone',
    'DV8 Hitman',
    '900 Global Reality',
    'Storm Hyroad',
  ];
  const res = { match: 0, ambiguous: 0, miss: 0, skipped: 0, misses: [] };
  const status = {};
  for (const bl of balls) {
    const label = `${bl.MFG} ${bl.BallName}`;
    const mk = N.modelKey(bl.MFG, bl.BallName);
    if (!brands.has(mk.split('|')[0])) { res.skipped++; status[label] = 'skip'; continue; }
    const hits = idx.get(mk) || [];
    if (hits.length === 1)      { res.match++;     status[label] = 'match'; }
    else if (hits.length)       { res.ambiguous++; status[label] = 'ambiguous'; }
    else { res.miss++; res.misses.push(label);     status[label] = 'miss'; }
  }
  const regressed = EXPECT_MATCH.filter(l => status[l] !== 'match');
  ok(`verified balls still match (${EXPECT_MATCH.length} expected)`,
     regressed.length === 0, regressed);
  ok('no silent ambiguity', res.ambiguous === 0);
  console.log(`  --   ${res.match} matched, ${res.miss} not in fixture, ${res.skipped} brand absent`);
  if (res.misses.length) console.log(`  --   not in fixture: ${res.misses.join(', ')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
