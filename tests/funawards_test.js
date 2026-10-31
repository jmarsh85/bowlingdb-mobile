// usage: node funawards_test.js <snapshot> <app dir>
const path = require('path'), fs = require('fs');
const APP = process.argv[3];
const E = require(path.join(APP, 'chplay.js')), C = require(path.join(APP, 'challenge.js'));
let ok = 0, fail = 0; const t = (n, c, i) => { if (c) { ok++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, i === undefined ? '' : JSON.stringify(i)); } };
const ALL = [1,2,3,4,5,6,7,8,9,10];
const gut = n => Array.from({ length: n }, () => []);
const ids = occ => occ.map(o => o.id + ':' + o.pid).sort();
/* Low Ball balls */
const lb300 = gut(21);                                   // every ball a miss: 9 X + 10th X X X
t('engine: all misses = 300', E.scoreOf(lb300, 'lowball').score === 300, E.scoreOf(lb300, 'lowball').score);
const lb20 = []; for (let f = 0; f < 10; f++) { lb20.push([1]); lb20.push([2]); }
t('engine: one pin a ball = 20', E.scoreOf(lb20, 'lowball').score === 20, E.scoreOf(lb20, 'lowball').score);
const lbReal3 = [ALL, ALL, ALL].concat(lb20.slice(6));   // three real strikes, then single pins
const r3 = E.scoreOf(lbReal3, 'lowball'); t('engine: 3 real strikes game done', r3.done, r3.score);
const S = (id, ch, fmt, date, rows, bowlers) => ({ id, challengeID: ch, format: fmt, date, created: date + 'T10', bowlers: bowlers || [{ pid: 'me' }, { pid: 'tb18' }], games: rows.map((r, i) => ({ n: i + 1, rows: r })) });
const sessions = [
  S('s1', 'cLB', 'lowball', '2026-10-01', [[{ balls: lb300 }, { balls: lb20 }], [{ balls: lbReal3 }, { balls: [], typed: 35 }]]),
  S('s2', 'cLB', 'lowball', '2026-10-02', [[{ balls: lb20 }, { balls: lb300 }]]),
  S('s3', 'cGut', 'standard', '2026-10-03', [[{ balls: [[1,2,3]].concat(gut(1), [ALL], [[1]], gut(1)).concat(Array(16).fill([1])).slice(0, 21) }, { balls: [ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL] }]])
];
const fin = (id, contest, people, winners, rows, margin, at, extra) => Object.assign({ id, contest, people, state: 'accepted', source: 'league', params: { start: at, end: at }, result: { winners, margin, at, rows: rows.map(p => ({ pid: p })) } }, extra || {});
const list = [
  Object.assign(fin('cLB', 'lb_game', ['me', 'tb18'], ['tb18'], ['tb18', 'me'], 5, '2026-10-02'), { source: 'open' }),
  Object.assign(fin('cGut', 'hgame', ['me', 'tb18'], ['tb18'], ['tb18', 'me'], 100, '2026-10-03'), { source: 'open' }),
  fin('p1', 'hgame', ['me', 'tb18'], ['me'], ['me', 'tb18'], 1, '2026-10-04'),
  fin('p2', 'hgame', ['me', 'tb18'], ['me'], ['me', 'tb18'], 0, '2026-10-05'),
  fin('p3', 'spare', ['me', 'tb18'], ['me'], ['me', 'tb18'], 0.5, '2026-10-06'),     // % contest: no Photo Finish
  fin('w3', 'hgame', ['me', 'tb18'], ['me'], ['me', 'tb18'], 20, '2026-10-07'),
  fin('w4', 'hgame', ['me', 'tb18'], ['me'], ['me', 'tb18'], 20, '2026-10-08'),
  fin('w5', 'hgame', ['me', 'tb18'], ['me'], ['me', 'tb18'], 20, '2026-10-09')
];
const occ1 = C.funScan(list, sessions, { engine: E });
const has = (id, pid) => occ1.filter(o => o.id === id && o.pid === pid).length;
t('Perfectly Terrible: me and tb18 once each', has('lb300', 'me') === 1 && has('lb300', 'tb18') === 1, ids(occ1));
t('Featherweight: tb18 and me', has('lb20', 'tb18') === 1 && has('lb20', 'me') === 1);
t('Low Expectations: once per bowler (first under 40)', has('lb40', 'me') === 1 && has('lb40', 'tb18') === 1);
t('Low Expectations: me on 10/2 (first under 40)', occ1.find(o => o.id === 'lb40' && o.pid === 'me').date === '2026-10-02');
t('typed Low Ball score earns nothing', occ1.every(o => !(o.pid === 'tb18' && o.note.indexOf('35') >= 0)));
t('Butterfingers: me once (3 real strikes game)', has('butter', 'me') === 1);
t('Oops, All Strikes: me once', has('oops', 'me') === 1 && has('oops', 'tb18') === 0);
t('Gutter Gourmet: me (2 gutters) not tb18', has('gutter', 'me') === 1 && has('gutter', 'tb18') === 0, occ1.filter(o => o.id === 'gutter'));
t('Photo Finish: margin 1 and tiebreak, not the % contest', has('photo', 'me') === 2, occ1.filter(o => o.id === 'photo'));
t('Bridesmaid: 2 losses only, none yet', has('brides', 'me') === 0);
t('Sore Winner: 6 straight wins -> 1', has('sore', 'me') === 1, occ1.filter(o => o.id === 'sore'));
t('Old Rivals: 8 challenges -> 1 each', has('rivals', 'me') === 1 && has('rivals', 'tb18') === 1);
/* Bridesmaid with three straight second places, a three-way */
const b3 = [1, 2, 3].map(i => fin('b' + i, 'hgame', ['me', 'tb18', 'tb19'], ['tb19'], ['tb19', 'me', 'tb18'], 10, '2026-09-0' + i));
const ob = C.funScan(b3, [], { engine: E });
t('Bridesmaid: three 2nds in a row', ob.filter(o => o.id === 'brides' && o.pid === 'me').length === 1 && ob.filter(o => o.id === 'brides' && o.pid === 'tb18').length === 0, ob);
const b3x = b3.slice(); b3x.splice(1, 0, fin('bx', 'hgame', ['me', 'tb18'], ['me'], ['me', 'tb18'], 10, '2026-09-01T'));
t('Bridesmaid: a win breaks the run', C.funScan(b3x, [], { engine: E }).filter(o => o.id === 'brides' && o.pid === 'me').length === 0);
/* first-to: Ice Cold / Fashionably Late via evalFn */
const ft = [fin('f1', 'f_game', ['me', 'tb18'], ['me'], ['me', 'tb18'], null, '2026-08-20', { params: { start: '2026-08-01', end: '2026-08-31' } }),
            fin('f2', 'f_game', ['me', 'tb18'], ['tb18'], ['tb18', 'me'], null, '2026-08-31', { params: { start: '2026-08-01', end: '2026-08-31' } })];
const g = (pid, date) => ({ pid, date, key: 's' + date, gameNo: 1, score: 200 });
const evalFn = ch => ch.id === 'f1'
  ? { r: { rows: [{ pid: 'me', reached: { date: '2026-08-05', value: 250 } }, { pid: 'tb18' }] }, games: { me: [g('me', '2026-07-30'), g('me', '2026-08-05'), g('me', '2026-08-12')], tb18: [] } }
  : { r: { rows: [{ pid: 'tb18', reached: { date: '2026-08-31', value: 251 } }, { pid: 'me' }] }, games: { tb18: [g('tb18', '2026-08-10'), g('tb18', '2026-08-31')], me: [] } };
const of = C.funScan(ft, [], { engine: E, evalFn });
t('Ice Cold: reached on first night in window (7/30 is outside)', of.some(o => o.id === 'icecold' && o.pid === 'me'), of);
t('Fashionably Late: reached on the end date', of.some(o => o.id === 'late' && o.pid === 'tb18') && !of.some(o => o.id === 'late' && o.pid === 'me'));
/* Split Personality: three converted splits in counted spare-golf games */
const splitGame = []; for (let f = 0; f < 9; f++) { if (f < 3) { splitGame.push([1,2,3,4,5,6,8,9]); splitGame.push([7,10]); } else { splitGame.push(ALL); } } splitGame.push([1,2,3,4,5,6,7,8,9]); splitGame.push([10]); splitGame.push(ALL);
const bf = E.buildFrames(splitGame); t('split game builds', bf.done);
const gm = { pid: 'me', date: '2026-07-01', key: 'c1', gameNo: 1, score: 0, frames: bf.frames.map(fr => ({ balls: fr.balls.map(x => ({ pins: x.pins, leave: x.leave.slice() })) })) };
t('gameStats: splitsMade 3', C.gameStats(gm).splitsMade === 3, C.gameStats(gm));
const sg = [fin('g1', 'sgolf', ['me', 'tb18'], ['me'], ['me', 'tb18'], 3, '2026-07-02')];
const os = C.funScan(sg, [], { engine: E, evalFn: () => ({ r: { rows: [{ pid: 'me', counted: [{ key: 'c1', gameNo: 1 }] }, { pid: 'tb18', counted: [] }] }, games: { me: [gm], tb18: [] } }) });
t('Split Personality: me', os.some(o => o.id === 'splitp' && o.pid === 'me'), os);
/* real snapshot: no throw, nothing unexpected, league challenge evaluation unchanged */
const snap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const real = JSON.parse(snap.localStorage.bowlingdb_challenges || '[]');
let ro; try { ro = C.funScan(real, snap.idb.challengeSessions || [], { engine: E }); t('real data: scans', Array.isArray(ro), ro); } catch (e) { t('real data: scans', false, e.message); }
t('FUN_AWARDS lists 15', C.FUN_AWARDS.length === 15);
t('version', C.CHALLENGE_VERSION === 'v30.250');
console.log(`funawards_test: ${ok} passed, ${fail} failed`);
