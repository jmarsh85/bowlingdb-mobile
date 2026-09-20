
/* catalog/normalize_test.js — self-test + preseed acceptance run
 *
 *   node normalize_test.js                      # self-tests only
 *   node normalize_test.js rows.json preseed.json   # + acceptance run
 *
 * rows.json: [{ mfg, ballName, approvalDate }] as emitted by parse_usbc.js
 * preseed.json: the PWA backup/preseed object (uses .balls)
 *
 * Design ref: DESIGN_ball_catalog.md §4, §9 step 3
 */

'use strict';
const N = require('./normalize');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}

console.log('normalize.js self-tests');

/* --- norm ------------------------------------------------------ */
eq('norm strips punctuation',   N.norm('Hy-Road'),               'hyroad');
eq('norm folds T Zone',         N.norm('T Zone'),                'tzone');
eq('norm drops (All Colors)',   N.norm('T Zone (All Colors)'),   'tzone');
eq('norm drops (All Color)',    N.norm('Pow (All Color)'),       'pow');
eq('norm keeps digits',         N.norm('Columbia 300'),          'columbia300');
eq('norm null-safe',            N.norm(null),                    '');

/* --- ** weight marker ------------------------------------------ */
eq('** stripped, captured',     N.cleanBallName('**Wolf Gold'),
   { name: 'Wolf Gold', weightLimit: N.WEIGHT_LIMIT_UNDER_13 });
eq('** with space',             N.cleanBallName('** Mission X Wine'),
   { name: 'Mission X Wine', weightLimit: N.WEIGHT_LIMIT_UNDER_13 });
eq('no ** -> null limit',       N.cleanBallName('Hitman'),
   { name: 'Hitman', weightLimit: null });

/* --- MFG aliases ----------------------------------------------- */
eq('Track -> Track Inc.',       N.canonicalMfg('Track'),         'Track Inc.');
eq('Track Inc. stable',         N.canonicalMfg('Track Inc.'),    'Track Inc.');
eq('Columbia 300 folds',        N.canonicalMfg('Columbia'),      'Columbia 300');
eq('unknown MFG passes through',N.canonicalMfg('Seismic'),       'Seismic');

/* --- keys ------------------------------------------------------ */
eq('modelKey basic',   N.modelKey('DV8', 'Hitman'),                    'dv8|hitman');
eq('Track keys align', N.modelKey('Track', 'Precision'),
                       N.modelKey('Track Inc.', 'Precision'));
eq('name alias Hyroad',N.modelKey('Storm', 'Hyroad'),                  'storm|hyroad');
eq('Hy-Road same key', N.modelKey('Storm', 'Hy-Road'),                 'storm|hyroad');
eq('Tzone == T Zone',  N.modelKey('Brunswick', 'Tzone'),
                       N.modelKey('Brunswick', 'T Zone (All Colors)'));
eq('colourway in key', N.matchKey('Brunswick', 'Fury', 'Orange/Red'),  'brunswick|fury|orangered');
eq('no colourway ok',  N.matchKey('DV8', 'Hitman', null),              'dv8|hitman|');
eq('colourways differ',
   N.matchKey('Brunswick','Fury','Purple/Blue') !== N.matchKey('Brunswick','Fury','Orange/Red'),
   true);

/* --- dates ----------------------------------------------------- */
eq('long form',   N.parseApprovalDate('September 30, 2016'), { iso:'2016-09-30', precision:'day',   ok:true, raw:'September 30, 2016' });
eq('short form',  N.parseApprovalDate('Oct-13'),             { iso:'2013-10',    precision:'month', ok:true, raw:'Oct-13' });
eq('apostrophe',  N.parseApprovalDate("Jan-'04"),            { iso:'2004-01',    precision:'month', ok:true, raw:"Jan-'04" });
eq('no separator',N.parseApprovalDate("Jun'00"),             { iso:'2000-06',    precision:'month', ok:true, raw:"Jun'00" });
eq('1900s rollover', N.parseApprovalDate('Nov-97').iso,      '1997-11');
eq('year 3024 rejected, raw kept',
   N.parseApprovalDate('September 3, 3024'),
   { iso:null, precision:null, ok:false, raw:'September 3, 3024' });
eq('NaT rejected',   N.parseApprovalDate('NaT').ok,          false);
eq('null safe',      N.parseApprovalDate(null).ok,           false);

/* --- lookup semantics ------------------------------------------ */
{
  const rows = [
    { mfg:'DV8', ballName:'Hitman' },
    { mfg:'DV8', ballName:'Hitman Enforcer' },
    { mfg:'Brunswick', ballName:'Fury Orange/Red' },
    { mfg:'Brunswick', ballName:'Fury Orange/Red' },   // deliberate dupe
  ];
  const idx = N.buildIndex(rows, r => N.matchKey(r.mfg, r.ballName, null));
  eq('exact match only',  N.lookup(idx,'DV8','Hitman',null).status,            'match');
  eq('no prefix bleed',   N.lookup(idx,'DV8','Hitman',null).candidates[0].ballName, 'Hitman');
  eq('enforcer distinct', N.lookup(idx,'DV8','Hitman Enforcer',null).status,   'match');
  eq('miss is a miss',    N.lookup(idx,'DV8','Hitman Enforcers',null).status,  'miss');
  eq('dupes -> ambiguous',N.lookup(idx,'Brunswick','Fury Orange/Red',null).status, 'ambiguous');
}

console.log(`  ${pass} passed, ${fail} failed\n`);

/* ==============================================================
 * Acceptance run — §9 step 3
 * ============================================================ */
const [rowsPath, preseedPath] = process.argv.slice(2);
if (rowsPath && preseedPath) {
  const fs   = require('fs');
  const rows = JSON.parse(fs.readFileSync(rowsPath, 'utf8'));
  const doc  = JSON.parse(fs.readFileSync(preseedPath, 'utf8'));
  const balls = doc.balls || doc;

  // USBC names carry the colourway inline, so index on ModelKey and
  // let the caller disambiguate. See §4 "Legacy linking".
  const idx = N.buildIndex(rows, r => N.modelKey(r.mfg, r.ballName));
  const brands = new Set(rows.map(r => N.norm(N.canonicalMfg(r.mfg))));

  console.log('Acceptance run against preseed');
  const tally = { match:0, ambiguous:0, miss:0, skipped:0 };

  for (const b of balls) {
    const mk = N.modelKey(b.MFG, b.BallName);
    if (!brands.has(mk.split('|')[0])) {
      tally.skipped++;
      console.log(`  SKIP  ${b.MFG} ${b.BallName} — brand not in rows`);
      continue;
    }
    const hits = idx.get(mk) || [];
    const status = hits.length === 1 ? 'match' : hits.length ? 'ambiguous' : 'miss';
    tally[status]++;
    const detail = hits.length
      ? hits.map(h => h.ballName).join(' | ')
      : '';
    console.log(`  ${status.toUpperCase().padEnd(9)} ${(b.MFG+' '+b.BallName).padEnd(34)} ${detail}`);
  }

  console.log(`\n  match ${tally.match}  ambiguous ${tally.ambiguous}  miss ${tally.miss}  skipped ${tally.skipped}`);
  if (tally.miss) console.log('  MISSES are the gate: each needs a NAME_ALIASES entry or a data fix.');
}

process.exit(fail ? 1 : 0);
