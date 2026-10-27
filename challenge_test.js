/* SOC-1 challenge engine harness: node tests/challenge_test.js <snapshot.json> */
const fs = require('fs'), path = require('path');
const C = require(path.join(__dirname, '..', 'challenge.js'));
const S = require(path.join(__dirname, '..', 'share.js'));
const snap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), d = snap.doc, grp = JSON.parse(snap.localStorage.grp_sessions || '[]');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const me = C.normMe(d);
console.log('my league/tournament games', me.length, 'with frames', me.filter(g => g.frames).length);
ok(me.every(g => g.score > 0), 'scores > 0');
ok(!me.some(g => d.games.find(x => x.GameID && x.SeriesID === +g.key.slice(1) && x.NoTap)), 'no No-Tap');
const team = {}; [18, 19, 20, 21].forEach(id => team['tb' + id] = C.normTeam(grp, id));
console.log('teammates', Object.keys(team).map(k => k + ':' + team[k].length).join(' '));
/* 1 game stats agree with the share card detail (same counting rules) */
const data = { series: d.series, games: d.games, frames: d.frames, attempts: d.attempts, leaves: d.leaves, balls: d.balls, leagues: d.leagues, tournaments: d.tournaments, centers: d.centers, bowlers: d.bowlers, openSessions: d.openSessions };
let cmp = 0, diff = 0;
me.filter(g => g.frames).forEach(g => {
  const gid = d.games.find(x => x.SeriesID === +g.key.slice(1) && (x.GameNumber || 0) === g.gameNo && !x.IsTeammate).GameID;
  const f = S.gameFacts(data, gid, {}); if (!f || !f.detail) return; cmp++;
  const st = C.gameStats(g), dd = f.detail;
  if (st.strikes !== dd.strikes || st.strikeOpps !== dd.strikeOpps || st.spares !== dd.spares || st.spareOpps !== dd.spareOpps || (dd.leavesKnown && st.leaves && Object.keys(st.leaves).length && false)) { diff++; if (diff < 4) console.log('diff', gid, st, dd); }
});
ok(cmp > 600 && diff === 0, `gameStats = share detail on ${cmp} games (diff ${diff})`);
/* 2 300 games: 12/12, run 12, 0 opens */
me.filter(g => g.score === 300 && g.frames).forEach(g => { const s = C.gameStats(g); ok(s.strikes === 12 && s.run === 12 && s.opens === 0 && s.golf === 0, '300 stats'); });
/* 3 opens = 0 exactly for clean games (awards: 152 standard clean) */
const clean = me.filter(g => g.frames && C.gameStats(g).opens === 0).length; console.log('clean (0 opens) league/tournament games', clean);
/* 4 split rule */
ok(C.isSplit([7, 10]) && C.isSplit([4, 6, 7, 10]) && !C.isSplit([2, 4, 5, 8]) && !C.isSplit([1, 2, 10]) && C.isSplit([5, 7, 10]) && !C.isSplit([3, 6, 10]), 'split rule');
ok(C.normLeaveParam('3-6-10') === '3,6,10' && C.normLeaveParam('10') === '10', 'leave param');
/* 5 a real window: Virtue Fun Spring 2026 Team Bowl nights, me vs Adam */
const games = Object.assign({ me }, team), win = { start: '2026-03-25', end: '2026-04-29', count: 'all', where: 'any' };
const avgs = { me: C.averageBefore(me, win.start), tb18: C.averageBefore(team.tb18, win.start, team.tb18[0] && team.tb18[0].entryAvg) };
console.log('avgs going in', avgs);
const run = (contest, extra) => C.evaluate({ contest, params: Object.assign({}, win, extra || {}), people: ['me', 'tb18'] }, games, avgs, '2026-10-25');
['hgame', 'hseries', 'pins', 'avg', 'poa', 'beatavg', 'strike', 'spare', 'single', 'sgolf', 'opens'].forEach(k => {
  const r = run(k, k === 'pins' ? { count: 'first', n: 9 } : {});
  console.log(k.padEnd(8), r.status, r.rows.map(x => x.pid + '=' + x.display + '(' + x.counted.length + 'g)').join('  '), 'win', r.winners.join(','));
  ok(r.status === 'final' && r.rows.length === 2, k + ' evaluates');
});
const hg = run('hgame'); const myHi = Math.max(...me.filter(g => g.date >= win.start && g.date <= win.end).map(g => g.score));
ok(hg.rows.find(r => r.pid === 'me').value === myHi, 'high game = my best in window');
const pinsR = run('pins', { count: 'first', n: 9 }); ok(pinsR.rows.every(r => r.counted.length <= 9), 'first 9 games only');
const lv = run('leave', { leave: '10', min: 1 }); console.log('10-pin', lv.rows.map(r => r.pid + '=' + r.display).join(' '));
/* 6 first-to */
const f = C.evaluate({ contest: 'f_game', params: { start: '2026-03-25', end: '2026-04-29', target: 240 }, people: ['me', 'tb18', 'tb19'] }, games, avgs, '2026-10-25');
console.log('first to 240', f.rows.map(r => r.pid + '=' + r.display).join('  '), 'win', f.winners);
ok(f.winners.length >= 1 && f.rows[0].reached, 'first-to winner is the earliest');
const f300 = C.evaluate({ contest: 'f_300', params: { start: '2024-01-01', end: '2025-12-31' }, people: ['me'] }, games, avgs, '2026-10-25');
ok(f300.rows[0].reached && f300.rows[0].reached.date === '2024-07-14', 'first 300 = 7/14/24');
const f700 = C.evaluate({ contest: 'f_series', params: { start: '2024-01-01', end: null, target: 700 }, people: ['me'] }, games, avgs, '2026-10-25');
console.log('first 700 since 2024', JSON.stringify(f700.rows[0].reached));
/* 7 running vs final, handicap */
const rn = C.evaluate({ contest: 'hgame', params: { start: '2026-10-01', end: '2026-10-31', count: 'all', where: 'any' }, people: ['me', 'tb18'] }, games, avgs, '2026-10-25');
ok(rn.status === 'running' && rn.winners.length === 0, 'running window has no winner yet');
const hc = run('hgame', { scoring: 'handicap', basis: 220, pct: 90 }); const r18 = hc.rows.find(r => r.pid === 'tb18');
ok(r18.hdcp === Math.max(0, Math.floor((220 - avgs.tb18) * 0.9)), 'handicap per game');
/* 8 tie rule and record */
const tieGames = { a: [{ pid: 'a', date: '2026-01-01', key: 'x', gameNo: 1, score: 200 }, { pid: 'a', date: '2026-01-02', key: 'y', gameNo: 1, score: 150 }], b: [{ pid: 'b', date: '2026-01-01', key: 'z', gameNo: 1, score: 200 }, { pid: 'b', date: '2026-01-02', key: 'w', gameNo: 1, score: 180 }] };
const t1 = C.evaluate({ contest: 'hgame', params: { start: '2026-01-01', end: '2026-01-05', count: 'all', tie: 'shared' }, people: ['a', 'b'] }, tieGames, {}, '2026-02-01');
const t2 = C.evaluate({ contest: 'hgame', params: { start: '2026-01-01', end: '2026-01-05', count: 'all', tie: 'pins' }, people: ['a', 'b'] }, tieGames, {}, '2026-02-01');
ok(t1.winners.length === 2 && t2.winners.join() === 'b', 'tie shared vs total-pins tiebreak');
const rec = C.record([{ people: ['me', 'tb18'], result: { winners: ['me'] } }, { people: ['me', 'tb18'], result: { winners: ['tb18'] } }, { people: ['me', 'tb19'], result: { winners: ['me', 'tb19'] } }, { people: ['me'], result: { winners: ['me'] } }], 'me');
ok(rec.w === 1 && rec.l === 1 && rec.t === 1, 'record W-L-T, solo excluded');
/* 9 same-night head-to-head */
const h = C.sameNight(grp, 18); console.log('same night vs Adam', JSON.stringify(h)); ok(h.games > 0 && h.w + h.l + h.t === h.games, 'same-night head-to-head');
/* 10 spare golf: synthetic */
const G = (frames) => ({ frames: frames.map(b => ({ balls: b })) });
const fr = []; for (let i = 0; i < 9; i++) fr.push([{ pins: 9, leave: [10] }, { pins: 0, leave: [10] }]); fr.push([{ pins: 8, leave: [7, 10] }, { pins: 2, leave: [] }, { pins: 5, leave: null }]);
const gs = C.gameStats(G(fr)); ok(gs.golf === 9 * 2 - 1 && gs.opens === 9 && gs.singles === 9 && gs.spareOpps === 10, 'spare golf: +2 per missed single, -1 converted split');
/* 11 v30.242 handicap modes + average sources */
const base = { start: '2026-03-25', end: '2026-04-29', count: 'all', where: 'any' };
const ev = (params, ctx) => { const ch = { contest: 'hgame', params: Object.assign({}, base, params), people: ['me', 'tb18'] }; return C.evaluate(ch, games, C.averagesFor(ch, games), '2026-10-25', ctx); };
const sc = ev({}), r0 = pid => sc.rows.find(r => r.pid === pid).value;
const fx = ev({ hcMode: 'fixed', fixed: { me: 0, tb18: 30 } }); ok(fx.rows.find(r => r.pid === 'tb18').value === r0('tb18') + 30 && fx.rows.find(r => r.pid === 'me').value === r0('me'), 'fixed handicap per bowler');
const fo = ev({ hcMode: 'formula', basis: 230, pct: 100, hcCap: 20 }); ok(fo.rows.find(r => r.pid === 'tb18').hdcp === 20, 'formula handicap capped at 20');
const lg = ev({ hcMode: 'league' }, { leagueHdcp: g => g.pid === 'me' ? 5 : 12 }); ok(lg.rows.find(r => r.pid === 'tb18').value === r0('tb18') + 12 && lg.rows.find(r => r.pid === 'me').hdcp === 'league', 'league handicap per game');
const old = ev({ scoring: 'handicap', basis: 220, pct: 90 }); ok(old.rows.find(r => r.pid === 'tb18').hdcp === Math.floor((220 - 186) * 0.9), 'old challenges: scoring handicap = formula');
const man = C.averagesFor({ params: Object.assign({}, base, { avgSource: 'manual', avgs: { me: 210, tb18: 175 } }), people: ['me', 'tb18'] }, games); ok(man.me === 210 && man.tb18 === 175, 'typed averages');
const la = C.averagesFor({ params: Object.assign({}, base, { avgSource: 'league', avgLeagueID: 21 }), people: ['me'] }, games); console.log('avg from NFL 25-26 before 3/25/26', la.me); ok(la.me > 150, 'one league average');
const hs = C.evaluate({ contest: 'hseries', params: Object.assign({}, base, { hcMode: 'fixed', fixed: { tb18: 10 } }), people: ['me', 'tb18'] }, games, {}, '2026-10-25');
const hs0 = C.evaluate({ contest: 'hseries', params: base, people: ['me', 'tb18'] }, games, {}, '2026-10-25');
ok(hs.rows.find(r => r.pid === 'tb18').value === hs0.rows.find(r => r.pid === 'tb18').value + 30, 'series handicap = 3 games');
console.log(`challenge_test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
