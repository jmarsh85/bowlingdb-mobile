/* BowlingDB challenges -- v30.241 SOC-1 step 2 (design: DESIGN_social_1.md rev 3, sections 4-5).
   League challenges: read games already recorded (your league / tournament series; a friend's Team Bowl
   nights) inside a window, score them by a contest, and keep a record. Pure engine + page screens.
   v30.244: open challenges -- games bowled for the challenge in their own sessions (chplay.js, store
   challengeSessions), kept out of every stat; source 'open', params.where 'open', format 'standard'.
   Storage: bowlingdb_challenges. Loaded by index.html as challenge.js?v=APP_VERSION on first use;
   require()-able for the Node harness (engine only). */
(function (root) {
'use strict';
var CHALLENGE_VERSION = 'v30.245';
var KEY = 'bowlingdb_challenges';
var EST_GAMES = 21, MIN_GAMES = 9;

/* ---------------- contests ---------------- */
var CONTESTS = {
  hgame:   { name: 'High game', dir: 'high', unit: 'game', fmt: 'n', about: 'Best single game in the window.' },
  hseries: { name: 'High series', dir: 'high', unit: 'series', fmt: 'n', about: 'Best series (first 3 games of a night).' },
  pins:    { name: 'Total pins', dir: 'high', unit: 'game', fmt: 'n', score: true, about: 'Pins added up over the games that count.' },
  avg:     { name: 'Average', dir: 'high', unit: 'game', fmt: 'n', score: true, about: 'Average over the games that count (minimum games set below).' },
  poa:     { name: 'Pins over average', dir: 'high', unit: 'game', fmt: 'signed', about: 'Each game minus your own average going in, added up. Fair across averages.' },
  beatavg: { name: 'Beat your average', dir: 'high', unit: 'game', fmt: 'n', about: 'Games bowled above your own average going in.' },
  strike:  { name: 'Strike %', dir: 'high', unit: 'game', fmt: 'pct', needs: 'frames', about: 'Strikes out of strike chances (fills included).' },
  spare:   { name: 'Spare %', dir: 'high', unit: 'game', fmt: 'pct', needs: 'frames', about: 'Spares converted out of spare chances.' },
  single:  { name: 'Single-pin spares', dir: 'high', unit: 'game', fmt: 'pct', needs: 'leaves', about: 'Single-pin spares made out of single pins left.' },
  leave:   { name: 'Chosen leave', dir: 'high', unit: 'game', fmt: 'pct', needs: 'leaves', param: 'leave', about: 'Conversions of the leave you choose (e.g. 10, 7, 3-6-10).' },
  sgolf:   { name: 'Spare golf', dir: 'low', unit: 'game', fmt: 'signed', needs: 'leaves', about: '+2 per missed single pin, +1 per missed makeable spare, \u22121 per converted split. Lowest wins.' },
  opens:   { name: 'Fewest open frames', dir: 'low', unit: 'game', fmt: 'dec', needs: 'frames', about: 'Open frames per game over the games that count. Lowest wins.' },
  f_game:  { name: 'First to a game', first: true, unit: 'game', param: 'target', about: 'First to bowl a game at or above the target.' },
  f_series:{ name: 'First to a series', first: true, unit: 'series', param: 'target', about: 'First to a series (first 3 games) at or above the target.' },
  f_300:   { name: 'First to 300', first: true, unit: 'game', about: 'First to bowl a standard 300.' },
  f_run:   { name: 'First to strikes in a row', first: true, unit: 'game', needs: 'frames', param: 'target', about: 'First to the number of strikes in a row in one game.' },
  f_leave: { name: 'First to N conversions', first: true, unit: 'game', needs: 'leaves', param: 'leaveN', about: 'First to convert the chosen leave the set number of times.' }
};
var PRESETS = [
  { id: 'week_hg', name: 'Best game this week', contest: 'hgame', days: 7, count: 'all' },
  { id: 'series2', name: 'High series showdown', contest: 'hseries', days: 14, count: 'all' },
  { id: 'pinrace', name: 'Pin race, 9 games', contest: 'pins', days: 28, count: 'first', n: 9 },
  { id: 'beatavg', name: 'Beat your average, 4 weeks', contest: 'beatavg', days: 28, count: 'all' },
  { id: 'poa', name: 'Pins over average (fair)', contest: 'poa', days: 28, count: 'first', n: 9 },
  { id: 'spare', name: 'Spare shootout', contest: 'spare', days: 28, count: 'all', min: 20 },
  { id: 'tenpin', name: '10-pin duel', contest: 'leave', leave: '10', days: 56, count: 'all', min: 5 },
  { id: 'golf', name: 'Spare golf', contest: 'sgolf', days: 28, count: 'first', n: 9 },
  { id: 'opens', name: 'Fewest opens', contest: 'opens', days: 28, count: 'first', n: 9 },
  { id: 'f700', name: 'First to 700', contest: 'f_series', target: 700, days: 90 },
  { id: 'f250', name: 'First to a 250 game', contest: 'f_game', target: 250, days: 60 },
  { id: 'f300', name: 'First to 300', contest: 'f_300', days: 180 },
  { id: 'frun', name: 'First to 6 in a row', contest: 'f_run', target: 6, days: 60 },
  { id: 'f10', name: 'First to ten 10-pins', contest: 'f_leave', leave: '10', target: 10, days: 60 }
];

function floorAvg(sum, n) { return n ? Math.floor(sum / n) : null; }
function byDate(a, b) { return (a || '').localeCompare(b || ''); }
function addDays(d, n) { var x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }

/* ---------------- split rule (same as the app's leave table) ---------------- */
var ADJ = { 1: [2, 3, 5], 2: [1, 4, 5, 8], 3: [1, 5, 6, 9], 4: [2, 7, 8], 5: [1, 2, 3, 8, 9], 6: [3, 9, 10], 7: [4], 8: [2, 4, 5], 9: [3, 5, 6], 10: [6] };
function isSplit(pins) {
  if (!pins || pins.length < 2 || pins.indexOf(1) >= 0) return false;
  var seen = {}, groups = 0;
  pins.forEach(function (p) {
    if (seen[p]) return; groups++; var st = [p];
    while (st.length) { var n = st.pop(); if (seen[n]) continue; seen[n] = true; ADJ[n].forEach(function (a) { if (pins.indexOf(a) >= 0 && !seen[a]) st.push(a); }); }
  });
  return groups > 1;
}
function leaveKey(pins) { return pins ? pins.slice().sort(function (a, b) { return a - b; }).join(',') : null; }
function normLeaveParam(s) { return leaveKey(String(s || '').split(/[^0-9]+/).filter(Boolean).map(Number).filter(function (n) { return n >= 1 && n <= 10; })); }

/* ---------------- normalised games ----------------
   { pid, date, key (series key), gameNo, score, leagueID, tournament, frames: [ { balls: [ {pins, leave:[..]|null} ] } ] | null } */
/* pins standing after a ball from PinStart / PinDelta (same rule as the app's getLeaveFromAtt) when LeaveID is missing */
function standingOf(a) {
  var has = false, st = [];
  for (var p = 1; p <= 10; p++) { if (a['PinStart' + p] != null) has = true; if (a['PinStart' + p] === 1 && a['PinDelta' + p] !== 1) st.push(p); }
  if (has) return st.length ? st : null;
  var bsk = a.BSK_Progressive;                       // live entry: S = standing after the ball
  if (typeof bsk === 'string' && bsk.length === 10) { for (var i = 0; i < 10; i++) if (bsk[i] === 'S') st.push(i + 1); return st.length ? st : null; }
  return null;
}
function normMe(data) {
  var S = {}, L = {}, T = {}, leafPins = {};
  (data.series || []).forEach(function (s) { S[s.SeriesID] = s; });
  (data.leagues || []).forEach(function (l) { L[l.LeagueID] = l; });
  (data.tournaments || []).forEach(function (t) { T[t.TournamentID] = t; });
  (data.leaves || []).forEach(function (l) { var p = []; for (var i = 1; i <= 10; i++) if (l['Pin' + i]) p.push(i); leafPins[l.LeaveID] = p; });
  var fBy = {}, aBy = {};
  (data.frames || []).forEach(function (f) { (fBy[f.GameID] = fBy[f.GameID] || []).push(f); });
  (data.attempts || []).forEach(function (a) { (aBy[a.FrameID] = aBy[a.FrameID] || []).push(a); });
  var out = [];
  (data.games || []).forEach(function (g) {
    var s = S[g.SeriesID];
    if (!s || g.IsTeammate || g.NoTap || s.NoTap || !(g.FinalScore > 0)) return;
    var lg = L[s.LeagueID], tn = s.TournamentID != null ? T[s.TournamentID] : null;
    if (tn ? (tn.BakerFormat || tn.NoTap) : !(lg && lg.LeagueID > 0 && !lg.BakerFormat)) return;   // league / tournament series only
    var fr = (fBy[g.GameID] || []).slice().sort(function (a, b) { return a.FrameNumber - b.FrameNumber; }), frames = null;
    if (fr.length === 10) {
      frames = fr.map(function (f) {
        return { balls: (aBy[f.FrameID] || []).filter(function (a) { return a.Pinfall != null; }).sort(function (a, b) { return a.Attempt - b.Attempt; })
          .map(function (a) { return { pins: a.Pinfall, leave: a.LeaveID != null && leafPins[a.LeaveID] ? leafPins[a.LeaveID] : (a.Pinfall === 10 ? [] : standingOf(a)) }; }) };
      });
      if (frames.some(function (f) { return !f.balls.length; })) frames = null;
    }
    out.push({ pid: 'me', date: s.DateBowled || '', key: 's' + s.SeriesID, gameNo: g.GameNumber || 0, score: g.FinalScore,
      leagueID: tn ? null : s.LeagueID, tournament: !!tn, frames: frames });
  });
  return out.sort(function (a, b) { return byDate(a.date, b.date) || a.gameNo - b.gameNo; });
}
/* a friend's games: Team Bowl nights you recorded (league nights; No-Tap nights left out) */
function normTeam(sessions, bowlerID) {
  var out = [];
  (sessions || []).forEach(function (sess) {
    if (sess.noTap) return;
    var idx = -1; (sess.bowlers || []).forEach(function (b, i) { if (b.BowlerID === bowlerID && !b.isMe) idx = i; });
    if (idx < 0) return;
    (sess.games || []).forEach(function (g, gi) {
      var sc = g.finalScores ? g.finalScores[idx] : null;
      if (!(sc > 0)) return;
      var fr = (g.frames || []).filter(function (f) { return f.bowlerIdx === idx; }).sort(function (a, b) { return a.frameNum - b.frameNum; });
      var frames = fr.length === 10 ? fr.map(function (f) { return { balls: (f.att || []).filter(function (a) { return a && a.pins != null; }).map(function (a) { return { pins: a.pins, leave: Array.isArray(a.leave) ? a.leave : null }; }) }; }) : null;
      out.push({ pid: 'tb' + bowlerID, sessId: sess.id, idx: idx, date: sess.date || '', key: 'g' + sess.id, gameNo: g.gameNum || gi + 1, score: sc, leagueID: sess.leagueID != null ? sess.leagueID : null, tournament: false, frames: frames, entryAvg: sess.bowlers[idx].entryAvg });
    });
  });
  return out.sort(function (a, b) { return byDate(a.date, b.date) || a.gameNo - b.gameNo; });
}
/* the Team Bowl nights both bowlers bowled: same-night head-to-head (yours from the same session) */
function sameNight(sessions, bowlerID) {
  var res = { games: 0, w: 0, l: 0, t: 0, nights: 0, nw: 0, nl: 0, nt: 0, myPins: 0, theirPins: 0 };
  (sessions || []).forEach(function (sess) {
    if (sess.noTap) return;
    var me = -1, th = -1; (sess.bowlers || []).forEach(function (b, i) { if (b.isMe) me = i; if (b.BowlerID === bowlerID && !b.isMe) th = i; });
    if (me < 0 || th < 0) return;
    var a = 0, b = 0, n = 0;
    (sess.games || []).forEach(function (g) {
      var x = g.finalScores && g.finalScores[me], y = g.finalScores && g.finalScores[th];
      if (!(x > 0 && y > 0)) return;
      n++; res.games++; a += x; b += y; if (x > y) res.w++; else if (x < y) res.l++; else res.t++;
    });
    if (!n) return;
    res.nights++; res.myPins += a; res.theirPins += b; if (a > b) res.nw++; else if (a < b) res.nl++; else res.nt++;
  });
  return res;
}

/* ---------------- per-game reading ---------------- */
function f10Roles(b) {
  var X = function (v) { return v === 10; }, out = [], p1 = b[0] && b[0].pins, p2 = b[1] && b[1].pins, p3 = b[2] && b[2].pins;
  if (p1 == null) return out;
  out.push({ ball: b[0], role: 'fresh', strike: X(p1) });
  if (p2 == null) return out;
  if (X(p1)) out.push({ ball: b[1], role: 'fresh', strike: X(p2) }); else out.push({ ball: b[1], role: 'spare', made: p1 + p2 >= 10, of: b[0] });
  if (p3 == null) return out;
  if (X(p1) && !X(p2)) out.push({ ball: b[2], role: 'spare', made: p2 + p3 >= 10, of: b[1] });
  else if (X(p1) || p1 + p2 >= 10) out.push({ ball: b[2], role: 'fill', strike: X(p3) });
  return out;
}
var GM = typeof WeakMap === 'function' ? new WeakMap() : null;
function gameStats(g) {
  if (!g.frames) return null;
  if (GM && GM.has(g)) return GM.get(g);
  var r = { strikes: 0, strikeOpps: 0, spares: 0, spareOpps: 0, singles: 0, singlesMade: 0, opens: 0, run: 0, golf: 0, leaves: {}, leavesKnown: 0 };
  var cur = 0;
  var strikeBall = function (hit) { r.strikeOpps++; if (hit) { r.strikes++; cur++; if (cur > r.run) r.run = cur; } else cur = 0; };
  var rack = function (fresh, next, made) {
    if (!next) return;
    r.spareOpps++; if (made) r.spares++;
    var lv = fresh.leave;
    if (lv && lv.length) {
      r.leavesKnown++;
      var k = leaveKey(lv), e = r.leaves[k] || (r.leaves[k] = { n: 0, made: 0 }); e.n++; if (made) e.made++;
      if (lv.length === 1) { r.singles++; if (made) r.singlesMade++; }
      if (!made) r.golf += lv.length === 1 ? 2 : isSplit(lv) ? 0 : 1;
      else if (isSplit(lv)) r.golf -= 1;
    }
  };
  for (var i = 0; i < 10; i++) {
    var b = g.frames[i].balls;
    if (i < 9) {
      var s = b[0].pins === 10; strikeBall(s);
      if (!s) { var made = b[1] && b[0].pins + b[1].pins >= 10; rack(b[0], b[1], made); if (!made) r.opens++; cur = 0; }
    } else {
      var roles = f10Roles(b), open = true;
      roles.forEach(function (x, k) {
        if (x.role === 'fresh' || x.role === 'fill') strikeBall(x.strike);
        if (x.role === 'fresh' && !x.strike) { var nx = roles[k + 1]; rack(x.ball, nx && nx.role === 'spare' ? nx.ball : null, !!(nx && nx.role === 'spare' && nx.made)); }
      });
      if (roles[0] && (roles[0].strike || (roles[1] && roles[1].role === 'spare' && roles[1].made))) open = false;
      if (open) r.opens++;
    }
  }
  if (GM) GM.set(g, r);
  return r;
}

/* ---------------- evaluation ----------------
   ch: { contest, params: { start, end, count:'all'|'first'|'best', n, min, target, leave, where:'any'|'league'|'tournament', leagueID,
         scoring:'scratch'|'handicap', basis, pct, tie:'shared'|'pins' }, people: ['me','tb18'] }
   games: { pid: [normalised games, all dates] }   avgs: { pid: average going in | null }   today: 'YYYY-MM-DD' */
function inWindow(g, p) {
  if (byDate(g.date, p.start) < 0 || (p.end && byDate(g.date, p.end) > 0)) return false;
  if (p.where === 'open') return !!g.open;          // open challenge: only its own session games
  if (g.open) return false;
  if (p.where === 'tournament') return g.tournament;
  if (p.where === 'league') return !g.tournament && g.leagueID != null && (p.leagueID == null || g.leagueID === p.leagueID);
  return true;
}
function averageBefore(list, start, entry) {
  var prior = list.filter(function (g) { return byDate(g.date, start) < 0 && !g.tournament; }).slice(-EST_GAMES);
  if (prior.length >= MIN_GAMES) return floorAvg(prior.reduce(function (a, g) { return a + g.score; }, 0), prior.length);
  return entry != null ? entry : null;
}
function seriesOf(list) {
  var by = {}, order = [];
  list.forEach(function (g) { if (!by[g.key]) { by[g.key] = []; order.push(g.key); } by[g.key].push(g); });
  return order.map(function (k) { var gs = by[k].sort(function (a, b) { return a.gameNo - b.gameNo; }), f3 = gs.slice(0, 3); return { key: k, date: gs[0].date, games: f3, score: f3.length === 3 ? f3[0].score + f3[1].score + f3[2].score : null }; })
    .filter(function (s) { return s.score != null; });
}
/* v30.245: the night in progress (fewer than 3 games) for series contests, so standings show something mid-series */
function partialSeries(list, val) {
  var by = {}, order = [];
  list.forEach(function (g) { if (!by[g.key]) { by[g.key] = []; order.push(g.key); } by[g.key].push(g); });
  for (var i = order.length - 1; i >= 0; i--) {
    var gs = by[order[i]]; if (gs.length < 3) return { games: gs.length, score: gs.reduce(function (a, g) { return a + val(g); }, 0), date: gs[0].date };
  }
  return null;
}
/* handicap (v30.242): scratch | formula (basis, %, optional cap, from the chosen average) | league (each game uses the
   handicap of the league night it was bowled in) | fixed (typed per bowler, per game). Old challenges: scoring 'handicap' = formula. */
function hcMode(p) { return p.hcMode || (p.scoring === 'handicap' ? 'formula' : 'scratch'); }
function makeHc(p, pid, avg, ctx) {
  var mode = hcMode(p);
  if (mode === 'formula') { var h = avg == null ? 0 : Math.max(0, Math.floor(((p.basis || 220) - avg) * (p.pct || 90) / 100)); if (p.hcCap != null && p.hcCap !== '' && h > +p.hcCap) h = +p.hcCap; return function () { return h; }; }
  if (mode === 'fixed') { var f = p.fixed && p.fixed[pid] != null ? +p.fixed[pid] || 0 : 0; return function () { return f; }; }
  if (mode === 'league') return function (g) { try { return ctx && ctx.leagueHdcp ? (+ctx.leagueHdcp(g) || 0) : 0; } catch (e) { return 0; } };
  return function () { return 0; };
}
/* the average going in each bowler is measured from: established (last 21 league games before the start),
   one league's average before the start, or typed per bowler */
function averagesFor(ch, games) {
  var p = ch.params, o = {};
  ch.people.forEach(function (pid) {
    var l = games[pid] || [], entry = l[0] && l[0].entryAvg != null ? l[0].entryAvg : null;
    if (p.avgSource === 'manual') o[pid] = p.avgs && p.avgs[pid] != null && p.avgs[pid] !== '' ? +p.avgs[pid] : null;
    else if (p.avgSource === 'league' && p.avgLeagueID != null) o[pid] = averageBefore(l.filter(function (g) { return g.leagueID === p.avgLeagueID; }), p.start, entry);
    else o[pid] = averageBefore(l, p.start, entry);
  });
  return o;
}
function evaluate(ch, games, avgs, today, ctx) {
  var c = CONTESTS[ch.contest], p = ch.params, rows = [];
  var leaveK = normLeaveParam(p.leave);
  ch.people.forEach(function (pid) {
    var all = games[pid] || [], avg = avgs[pid] != null ? avgs[pid] : null, hcG = makeHc(p, pid, avg, ctx), mode = hcMode(p);
    var hcU = function (u) { return u.games ? u.games.reduce(function (a, g) { return a + hcG(g); }, 0) : hcG(u); };
    var pool = all.filter(function (g) { return inWindow(g, p); });
    if (c.needs) pool = pool.filter(function (g) { return !!g.frames; });
    var row = { pid: pid, avgIn: avg, hdcp: mode === 'scratch' ? 0 : mode === 'league' ? 'league' : hcG({}), value: null, display: '\u2014', counted: [], chances: null, reached: null, games: pool.length };
    if (c.first) {
      var tgt = ch.contest === 'f_300' ? 300 : +p.target || 0, prog = 0, hit = null;
      if (c.unit === 'series') {
        seriesOf(pool).forEach(function (s) { var v = s.score + hcU(s); if (v > prog) prog = v; if (!hit && v >= tgt) hit = { date: s.date, key: s.key, value: v }; });
      } else if (ch.contest === 'f_run') {
        pool.forEach(function (g) { var st = gameStats(g); if (st.run > prog) prog = st.run; if (!hit && st.run >= tgt) hit = { date: g.date, key: g.key, gameNo: g.gameNo, value: st.run }; });
      } else if (ch.contest === 'f_leave') {
        pool.forEach(function (g) { var e = gameStats(g).leaves[leaveK]; if (e) prog += e.made; if (!hit && prog >= tgt) hit = { date: g.date, key: g.key, gameNo: g.gameNo, value: prog }; });
      } else {
        pool.forEach(function (g) { var v = g.score + (ch.contest === 'f_300' ? 0 : hcG(g)); if (v > prog) prog = v; if (!hit && v >= tgt) hit = { date: g.date, key: g.key, gameNo: g.gameNo, value: v }; });
      }
      row.value = prog; row.reached = hit; row.target = tgt;
      if (c.unit === 'series' && !hit) row.partial = partialSeries(pool, function (g) { return g.score + hcG(g); });
      row.display = hit ? '\u2713 ' + hit.date : prog ? String(prog) + ' / ' + tgt : row.partial ? row.partial.score + ' after ' + row.partial.games + ' of 3' : '\u2014';
      rows.push(row); return;
    }
    /* which games count */
    var units = c.unit === 'series' ? seriesOf(pool) : pool.slice();
    var val = function (u) { return u.score + hcU(u); };
    if (p.count === 'first' && p.n) units = units.slice(0, p.n);
    else if (p.count === 'best' && p.n) units = units.slice().sort(function (a, b) { return c.dir === 'low' ? metricOne(a) - metricOne(b) : val(b) - val(a); }).slice(0, p.n);
    row.counted = units.map(function (u) { return { date: u.date, key: u.key, gameNo: u.gameNo || null, score: u.score }; });
    if (c.unit === 'series') row.partial = partialSeries(pool, function (g) { return g.score + hcG(g); });
    if (!units.length) { if (row.partial) row.display = row.partial.score + ' after ' + row.partial.games + ' of 3'; rows.push(row); return; }
    var gamesList = c.unit === 'series' ? [].concat.apply([], units.map(function (u) { return u.games; })) : units;
    var sum = function (k) { return gamesList.reduce(function (a, g) { return a + gameStats(g)[k]; }, 0); };
    switch (ch.contest) {
      case 'hgame': case 'hseries': row.value = Math.max.apply(null, units.map(val)); break;
      case 'pins': row.value = units.reduce(function (a, u) { return a + val(u); }, 0); break;
      case 'avg': row.value = units.length >= (p.min || 1) ? floorAvg(units.reduce(function (a, u) { return a + val(u); }, 0), units.length) : null; break;
      case 'poa': row.value = avg == null ? null : units.reduce(function (a, u) { return a + u.score - avg; }, 0); break;
      case 'beatavg': row.value = avg == null ? null : units.filter(function (u) { return u.score > avg; }).length; break;
      case 'strike': row.chances = sum('strikeOpps'); row.value = row.chances ? Math.floor(sum('strikes') / row.chances * 1000) / 10 : null; break;
      case 'spare': row.chances = sum('spareOpps'); row.value = row.chances >= (p.min || 1) ? Math.floor(sum('spares') / row.chances * 1000) / 10 : null; break;
      case 'single': row.chances = sum('singles'); row.value = row.chances >= (p.min || 1) ? Math.floor(sum('singlesMade') / row.chances * 1000) / 10 : null; break;
      case 'leave':
        var n = 0, m = 0; gamesList.forEach(function (g) { var e = gameStats(g).leaves[leaveK]; if (e) { n += e.n; m += e.made; } });
        row.chances = n; row.made = m; row.value = n >= (p.min || 1) ? Math.floor(m / n * 1000) / 10 : null; break;
      case 'sgolf': row.value = sum('golf'); break;
      case 'opens': row.value = Math.floor(sum('opens') / gamesList.length * 100) / 100; break;
    }
    row.display = row.value == null ? (avg == null && (ch.contest === 'poa' || ch.contest === 'beatavg') ? 'no average' : row.chances != null ? 'not enough (' + row.chances + ')' : '\u2014')
      : c.fmt === 'pct' ? row.value + '%' + (row.chances != null ? ' of ' + row.chances : '') : c.fmt === 'signed' ? (row.value > 0 ? '+' : '') + row.value : String(row.value);
    rows.push(row);
    function metricOne(u) { return u.score; }
  });
  /* order and result */
  var ended = !!(p.end && byDate(today, p.end) > 0), status, winners = [];
  if (c.first) {
    var hits = rows.filter(function (r) { return r.reached; }).sort(function (a, b) { return byDate(a.reached.date, b.reached.date) || (a.reached.gameNo || 0) - (b.reached.gameNo || 0); });
    rows.sort(function (a, b) { return (a.reached ? 0 : 1) - (b.reached ? 0 : 1) || (a.reached && b.reached ? byDate(a.reached.date, b.reached.date) : (b.value || 0) - (a.value || 0)); });
    if (hits.length) {
      winners = hits.filter(function (r) { return r.reached.date === hits[0].reached.date && (r.reached.gameNo || 0) === (hits[0].reached.gameNo || 0); }).map(function (r) { return r.pid; });
      status = 'final';
    } else status = ended ? 'final' : 'running';
  } else {
    rows.sort(function (a, b) {
      if (a.value == null || b.value == null) return (a.value == null) - (b.value == null);
      return c.dir === 'low' ? a.value - b.value : b.value - a.value;
    });
    var has = rows.filter(function (r) { return r.value != null; });
    status = ended ? 'final' : 'running';
    if (status === 'final' && has.length) {
      var best = has[0].value;
      winners = has.filter(function (r) { return r.value === best; }).map(function (r) { return r.pid; });
      if (winners.length > 1 && p.tie === 'pins') {
        var tp = function (pid) { var r = rows.filter(function (x) { return x.pid === pid; })[0]; return r.counted.reduce(function (a, u) { return a + u.score; }, 0); };
        var bp = Math.max.apply(null, winners.map(tp)); winners = winners.filter(function (pid) { return tp(pid) === bp; });
      }
    }
  }
  var margin = null;
  if (!c.first && rows.length > 1 && rows[0].value != null && rows[1].value != null) margin = Math.abs(rows[0].value - rows[1].value);
  return { status: status, rows: rows, winners: winners, margin: margin, contest: c };
}
/* W-L-T for one person over finished challenges (solo challenges excluded) */
function record(list, pid, vs) {
  var r = { w: 0, l: 0, t: 0 };
  (list || []).forEach(function (ch) {
    if (!ch.result || ch.people.length < 2 || ch.people.indexOf(pid) < 0) return;
    if (vs && ch.people.indexOf(vs) < 0) return;
    var w = ch.result.winners || [];
    if (!w.length) return;
    if (w.indexOf(pid) >= 0) { if (w.length > 1) r.t++; else r.w++; } else r.l++;
  });
  return r;
}

var api = { CHALLENGE_VERSION: CHALLENGE_VERSION, CONTESTS: CONTESTS, PRESETS: PRESETS, normMe: normMe, normTeam: normTeam, sameNight: sameNight, gameStats: gameStats,
  evaluate: evaluate, averageBefore: averageBefore, averagesFor: averagesFor, hcMode: hcMode, record: record, isSplit: isSplit, normLeaveParam: normLeaveParam, addDays: addDays };

/* ================= page screens (browser only) ================= */
var FIELD_LABELS = { contest: 'Contest', start: 'Start', end: 'End', count: 'Games that count', n: 'Number', min: 'Minimum', target: 'Target', leave: 'Leave',
  where: 'Where', leagueID: 'League', hcMode: 'Handicap', basis: 'Handicap basis', pct: 'Handicap %', hcCap: 'Handicap cap', avgSource: 'Average from', avgLeagueID: 'Average league',
  avgs: 'Typed averages', fixed: 'Fixed handicaps', tie: 'Tie', proof: 'Proof', note: 'Note' };
var HC_LABEL = { scratch: 'Scratch', formula: 'Handicap: formula', league: 'Handicap: each league\u2019s own', fixed: 'Handicap: fixed per bowler' };
var AVG_LABEL = { established: 'Last 21 league games before the start', league: 'One league\u2019s average', manual: 'Typed per bowler' };
var HC_CONTESTS = ['hgame', 'hseries', 'pins', 'avg', 'f_game', 'f_series'];
var PROOF = { none: 'None', photo: 'Photo per entry', confirm: 'Opponent confirms each entry' };
function DBp() { try { return typeof db !== 'undefined' ? db : root.db; } catch (e) { return root.db; } }
function todayStr() { return typeof root.azToday === 'function' ? root.azToday() : new Date().toISOString().slice(0, 10); }
function escH(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function chList() { try { var v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function chSaveAll(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (e) { if (root.toast) root.toast('Could not save on this phone'); return false; } }
function chGet(id) { return chList().filter(function (c) { return c.id === id; })[0] || null; }
function chPut(ch) { var l = chList(), i = -1; l.forEach(function (c, k) { if (c.id === ch.id) i = k; }); if (i >= 0) l[i] = ch; else l.unshift(ch); chSaveAll(l); }
function friendsList() { try { return root.fsFriendsSource() || []; } catch (e) { return []; } }
function meInfo() {
  var p = typeof root.fsGetProfile === 'function' ? root.fsGetProfile() : { name: 'You', avatar: '\ud83c\udfb3', color: 'var(--teal)' };
  if (p.name === 'You') { var b = (DBp().bowlers || []).filter(function (x) { return x.IsMe; })[0]; if (b && b.Name) p = Object.assign({}, p, { name: b.Name }); }
  return p;
}
function person(pid) { return pid === 'me' ? meInfo() : friendsList().filter(function (f) { return f.id === pid; })[0] || { name: 'Friend', avatar: '\ud83c\udfb3', color: 'var(--teal)' }; }
function first(pid) { var n = person(pid).name || ''; return pid === 'me' ? 'You' : n.split(' ')[0]; }
function av(pid, size) { return typeof root._fsAvatarHTML === 'function' ? root._fsAvatarHTML(person(pid), size || 34) : ''; }
var cache = { n: -1, me: null };
function gamesFor(people) {
  var d = DBp(), out = {};
  if (cache.n !== (d.games || []).length + (d.attempts || []).length) { cache.me = normMe(d); cache.n = (d.games || []).length + (d.attempts || []).length; }
  var grp = typeof root.grpLoadAll === 'function' ? root.grpLoadAll() : [];
  people.forEach(function (pid) { out[pid] = pid === 'me' ? cache.me : /^tb\d+$/.test(pid) ? normTeam(grp, +pid.slice(2)) : []; });
  return out;
}
function avgsFor(people, games, start) {
  var o = {};
  people.forEach(function (pid) { var l = games[pid] || []; o[pid] = averageBefore(l, start, l[0] && l[0].entryAvg != null ? l[0].entryAvg : null); });
  return o;
}
/* the state a challenge is in now */
function phase(ch) {
  if (ch.state === 'sent' || ch.state === 'countered' || ch.state === 'declined' || ch.state === 'cancelled') return ch.state;
  if (ch.result) return 'final';
  if (byDate(todayStr(), ch.params.start) < 0) return 'upcoming';
  return 'running';
}
/* each league night's own handicap: yours from the series' handicap snapshot; a friend's from the league's
   handicap setup applied to their Team Bowl entering average */
function leagueHdcp(g) {
  if (g.leagueID == null) return 0;
  var lg = (DBp().leagues || []).filter(function (l) { return l.LeagueID === g.leagueID; })[0];
  if (!lg || lg.Handicap === false) return 0;
  if (g.pid === 'me') { var h = typeof root.hdcpForSeries === 'function' ? root.hdcpForSeries(g.leagueID, +String(g.key).slice(1)) : null; return h || 0; }
  if (g.entryAvg == null || typeof root.hdcpGet !== 'function') return 0;
  var cfg = root.hdcpGet(root.hdcpLeagueKey(g.leagueID));
  return Math.max(0, Math.floor(((cfg.baseScore || 230) - g.entryAvg) * (cfg.pct || 90) / 100));
}
function openGames(ch) {
  var o = {}, got = typeof root.cpGamesFor === 'function' ? root.cpGamesFor(ch) || {} : {};
  ch.people.forEach(function (pid) { o[pid] = got[pid] || []; });
  return o;
}
function evalNow(ch) {
  var lg = gamesFor(ch.people), g = ch.source === 'open' ? openGames(ch) : lg;
  var r = evaluate(ch, g, averagesFor(ch, lg), todayStr(), { leagueHdcp: leagueHdcp });   // averages going in always from league games
  if (r.status === 'final' && !ch.result && ch.state === 'accepted') {
    ch.result = { winners: r.winners, at: todayStr(), margin: r.margin, rows: r.rows.map(function (x) { return { pid: x.pid, display: x.display, value: x.value }; }) };
    chPut(ch);
  }
  return r;
}
function chRecordFor(pid, vs) { return record(chList(), pid || 'me', vs); }
function recStr(r) { return r.w + ' \u2013 ' + r.l + ' \u2013 ' + r.t; }
function contestLine(ch) {
  var c = CONTESTS[ch.contest], p = ch.params, bits = [c.name];
  if (p.target && c.param && c.param !== 'leave') bits[0] = c.name.replace(' a game', ' ' + p.target + ' game').replace(' a series', ' ' + p.target + ' series').replace('strikes in a row', p.target + ' in a row').replace('N conversions', p.target + ' conversions');
  if (p.leave && (ch.contest === 'leave' || ch.contest === 'f_leave')) bits.push('leave ' + p.leave.replace(/,/g, '-'));
  if (!c.first) bits.push(p.count === 'first' ? 'first ' + p.n + (c.unit === 'series' ? ' nights' : ' games') : p.count === 'best' ? 'best ' + p.n : 'all ' + (c.unit === 'series' ? 'nights' : 'games'));
  var hm = hcMode(p); if (hm !== 'scratch' && HC_CONTESTS.indexOf(ch.contest) >= 0) bits.push(hm === 'formula' ? 'handicap ' + (p.pct || 90) + '% of ' + (p.basis || 220) : hm === 'league' ? 'each league\u2019s handicap' : 'fixed handicaps');
  return bits.join(' \u00b7 ');
}
function whenLine(p) {
  var f = function (d) { if (!d) return 'open-ended'; var x = d.split('-'); return +x[1] + '/' + +x[2] + '/' + x[0].slice(2); };
  return f(p.start) + ' \u2013 ' + f(p.end) + (p.where === 'open' ? ' \u00b7 open challenge games (not in stats)' : p.where === 'league' ? ' \u00b7 ' + leagueName(p.leagueID) : p.where === 'tournament' ? ' \u00b7 tournaments' : ' \u00b7 league & tournament games');
}
function leagueName(id) { if (id == null) return 'any league'; var l = (DBp().leagues || []).filter(function (x) { return x.LeagueID === id; })[0]; return l ? l.LeagueName : 'a league'; }
function vsLine(ch) { return ch.people.length < 2 ? 'Solo challenge' : ch.people.filter(function (p) { return p !== 'me'; }).map(function (p) { return person(p).name; }).join(', '); }

/* ---------------- the Challenges tab ---------------- */
var PHASE = { sent: ['Waiting on them', 'var(--t2)'], countered: ['Your move', 'var(--gold)'], upcoming: ['Starts soon', 'var(--t2)'], running: ['Running', 'var(--teal)'],
  final: ['Finished', 'var(--t2)'], declined: ['Declined', 'var(--t3)'], cancelled: ['Cancelled', 'var(--t3)'] };
function rowCard(ch) {
  var ph = phase(ch), lab = PHASE[ph], tail = '';
  if (ph === 'running' || ph === 'final') {
    var r = evalNow(ch); ph = phase(ch); lab = PHASE[ph];
    tail = '<div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap">' + r.rows.slice(0, 3).map(function (x) {
      var win = (ch.result ? ch.result.winners : []).indexOf(x.pid) >= 0;
      return '<span style="font-size:12px;color:' + (win ? 'var(--gold)' : 'var(--t2)') + ';font-weight:700">' + (win ? '\ud83c\udfc6 ' : '') + escH(first(x.pid)) + ' ' + escH(x.display) + '</span>'; }).join('') + '</div>';
  }
  return '<div class="card" onclick="chOpen(\'' + ch.id + '\')" style="margin-bottom:10px;cursor:pointer">' +
    '<div style="display:flex;align-items:center;gap:10px"><div style="display:flex">' + ch.people.filter(function (p) { return p !== 'me'; }).slice(0, 3).map(function (p) { return av(p, 34); }).join('') + (ch.people.length < 2 ? av('me', 34) : '') + '</div>' +
    '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:800;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escH(ch.name || CONTESTS[ch.contest].name) + '</div>' +
    '<div style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escH(vsLine(ch)) + ' \u00b7 ' + escH(whenLine(ch.params)) + '</div></div>' +
    '<span style="font-size:10px;font-weight:800;color:' + lab[1] + ';border:1px solid ' + lab[1] + ';border-radius:8px;padding:2px 7px;flex-shrink:0">' + lab[0] + '</span></div>' + tail + '</div>';
}
function chTabHTML() {
  var list = chList(), rec = chRecordFor('me');
  var groups = [['Your move', function (c) { return phase(c) === 'countered'; }], ['Running', function (c) { var p = phase(c); return p === 'running' || p === 'upcoming'; }],
    ['Waiting on them', function (c) { return phase(c) === 'sent'; }], ['Finished', function (c) { var p = phase(c); return p === 'final' || p === 'declined' || p === 'cancelled'; }]];
  var h = '<div class="stat-card" style="margin-bottom:12px;display:flex;align-items:center;gap:12px"><div style="flex:1"><div style="font-size:11px;font-weight:700;color:var(--t3);letter-spacing:.8px;text-transform:uppercase">Your challenge record</div>' +
    '<div style="font-size:22px;font-weight:900;color:var(--t1)">' + recStr(rec) + '</div><div style="font-size:11px;color:var(--t3)">wins \u2013 losses \u2013 ties</div></div>' +
    '<button class="btn btn-primary btn-sm" style="width:auto;padding:8px 14px" onclick="chNew()">+ New challenge</button></div>' +
    '<div style="font-size:11px;color:var(--t3);margin:-4px 0 12px;line-height:1.5">League challenges read the league and tournament games you already record (a friend\u2019s from Team Bowl nights you scored). Open challenges are bowled as their own games (Open Bowling \u203a Challenges) and stay out of your stats. Answers from friends are simulated on this phone until accounts exist.</div>';
  var any = false;
  groups.forEach(function (g) {
    var items = list.filter(g[1]); if (!items.length) return; any = true;
    h += '<div class="sec-header" style="margin-top:4px"><span class="sec-title" style="font-size:15px">' + g[0] + '</span></div>' + items.map(rowCard).join('');
  });
  if (!any) h += '<div class="empty-state"><div class="empty-icon">\ud83c\udfc1</div><div class="empty-label">No challenges yet</div><div class="empty-sub">Start one: pick a friend and a preset</div></div>';
  return h;
}

/* ---------------- one challenge ---------------- */
function diffLines(a, b) {
  var out = [];
  Object.keys(FIELD_LABELS).forEach(function (k) {
    var x = k === 'contest' ? a.contest : a.params[k], y = k === 'contest' ? b.contest : b.params[k];
    var str = function (v) { return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); };
    if (k === 'hcMode') { x = hcMode(a.params); y = hcMode(b.params); }
    if ((k === 'avgs' || k === 'fixed') && !Object.keys(x || {}).length && !Object.keys(y || {}).length) return;
    if (str(x) !== str(y)) out.push(FIELD_LABELS[k] + ': ' + show(k, x) + ' \u2192 ' + show(k, y));
  });
  return out;
  function show(k, v) { if (v == null || v === '') return '\u2014'; if (k === 'contest') return CONTESTS[v].name; if (k === 'leagueID' || k === 'avgLeagueID') return leagueName(v); if (k === 'proof') return PROOF[v];
    if (k === 'hcMode') return HC_LABEL[v]; if (k === 'avgSource') return AVG_LABEL[v]; if (typeof v === 'object') { var ks = Object.keys(v); return ks.length ? ks.map(function (pid) { return first(pid) + ' ' + v[pid]; }).join(', ') : '\u2014'; } return String(v); }
}
function chDetailHTML(id) {
  var ch = chGet(id); if (!ch) return '<div style="color:var(--t3)">Challenge not found.</div>';
  var ph = phase(ch), them = ch.people.filter(function (p) { return p !== 'me'; }), r = null;
  if (ph === 'running' || ph === 'final' || ph === 'upcoming') { r = evalNow(ch); ph = phase(ch); }
  var lab = PHASE[ph];
  var h = '<div onclick="chBack()" style="font-size:13px;color:var(--teal);font-weight:700;cursor:pointer;margin-bottom:10px">\u2039 Challenges</div>' +
    '<div class="stat-card" style="margin-bottom:12px"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><div style="font-size:18px;font-weight:900;color:var(--t1)">' + escH(ch.name || CONTESTS[ch.contest].name) + '</div>' +
    '<span style="font-size:10px;font-weight:800;color:' + lab[1] + ';border:1px solid ' + lab[1] + ';border-radius:8px;padding:2px 7px">' + lab[0] + '</span></div>' +
    '<div style="font-size:12px;color:var(--t2);margin-top:4px">' + escH(contestLine(ch)) + '</div>' +
    '<div style="font-size:12px;color:var(--t3);margin-top:2px">' + escH(whenLine(ch.params)) + '</div>' +
    '<div style="font-size:12px;color:var(--t3);margin-top:2px">' + escH(vsLine(ch)) + ' \u00b7 proof: ' + PROOF[ch.params.proof || 'none'] + (ch.params.tie === 'pins' ? ' \u00b7 tie: total pins' : '') + '</div>' +
    (ch.params.note ? '<div style="font-size:12px;color:var(--t2);margin-top:6px;font-style:italic">\u201c' + escH(ch.params.note) + '\u201d</div>' : '') +
    '<div style="font-size:11px;color:var(--t3);margin-top:6px">' + escH(CONTESTS[ch.contest].about) + '</div></div>';
  /* result / standings */
  if (r) {
    if (ph === 'final') {
      var w = ch.result.winners;
      h += '<div class="card card-best" style="margin-bottom:12px;text-align:center"><div style="font-size:12px;font-weight:800;color:var(--gold);letter-spacing:.06em">' +
        (!w.length ? 'NO WINNER' : w.length > 1 ? 'TIE' : w[0] === 'me' ? (ch.people.length < 2 ? 'DONE' : 'YOU WON') : first(w[0]).toUpperCase() + ' WON') + '</div>' +
        (ch.result.margin != null && w.length === 1 && ch.people.length > 1 ? '<div style="font-size:11px;color:var(--t3)">by ' + ch.result.margin + '</div>' : '') + '</div>';
    }
    h += '<div class="sec-header"><span class="sec-title" style="font-size:15px">' + (ph === 'upcoming' ? 'Starts ' + ch.params.start : 'Standings') + '</span></div>';
    h += r.rows.map(function (x, i) {
      var win = ch.result && ch.result.winners.indexOf(x.pid) >= 0;
      var games = x.counted.length ? x.counted.map(function (u) { var d = u.date.split('-'); return '<span style="font-size:11px;color:var(--t2);background:var(--bg3);border-radius:6px;padding:2px 6px">' + (+d[1]) + '/' + (+d[2]) + ' ' + u.score + '</span>'; }).join(' ') :
        x.reached ? '<span style="font-size:11px;color:var(--teal)">reached ' + x.reached.date + ' (' + x.reached.value + ')</span>' : '<span style="font-size:11px;color:var(--t3)">' + (x.partial ? 'series in progress: ' + x.partial.games + ' of 3 games, ' + x.partial.score + ' so far' : x.games ? x.games + ' games so far' : 'no games in the window yet') + '</span>';
      return '<div class="card" style="margin-bottom:8px' + (win ? ';border:1px solid var(--gold)' : '') + '"><div style="display:flex;align-items:center;gap:10px">' +
        '<div style="font-size:14px;font-weight:900;color:var(--t3);width:16px">' + (i + 1) + '</div>' + av(x.pid, 34) +
        '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:800;color:var(--t1)">' + escH(person(x.pid).name) + (win ? ' \ud83c\udfc6' : '') + '</div>' +
        '<div style="font-size:11px;color:var(--t3)">' + (x.avgIn != null ? 'avg going in ' + x.avgIn : 'no average yet') + (x.hdcp === 'league' ? ' \u00b7 league handicap' : x.hdcp ? ' \u00b7 +' + x.hdcp + ' a game' : '') + '</div></div>' +
        '<div style="font-size:20px;font-weight:900;color:' + (win ? 'var(--gold)' : 'var(--t1)') + ';text-align:right">' + escH(x.display) + '</div></div>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px">' + games + '</div></div>';
    }).join('');
  }
  /* rounds */
  if (ch.rounds && ch.rounds.length) {
    h += '<div class="sec-header" style="margin-top:8px"><span class="sec-title" style="font-size:15px">History</span></div><div class="stat-card" style="margin-bottom:12px">' +
      ch.rounds.map(function (rd, i) {
        var who = rd.by === 'me' ? 'You' : first(rd.by), what = { sent: 'sent the challenge', counter: 'suggested changes', accept: 'accepted', decline: 'declined', cancel: 'cancelled' }[rd.act] || rd.act;
        var lines = rd.act === 'counter' && rd.before ? diffLines(rd.before, rd.after) : [];
        return '<div style="padding:6px 0;' + (i ? 'border-top:1px solid var(--border1)' : '') + '"><div style="font-size:12px;color:var(--t1)"><b>' + escH(who) + '</b> ' + what + ' <span style="color:var(--t3)">' + escH(rd.at ? new Date(rd.at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) : '') + '</span></div>' +
          lines.map(function (l) { return '<div style="font-size:11px;color:var(--t2);margin-left:8px">\u2022 ' + escH(l) + '</div>'; }).join('') + '</div>';
      }).join('') + '</div>';
  }
  /* actions */
  var acts = '';
  if (ph === 'sent') {
    acts += '<div style="font-size:11px;color:var(--t3);margin:4px 0 6px">Preview: answer as ' + escH(person(them[0]).name) + ' (until friends answer from their own phones)</div>' +
      '<div style="display:flex;gap:8px"><button class="btn btn-ghost btn-sm" style="flex:1" onclick="chAnswer(\'' + id + '\',\'accept\',\'' + them[0] + '\')">Accept</button>' +
      '<button class="btn btn-ghost btn-sm" style="flex:1" onclick="chCounter(\'' + id + '\',\'' + them[0] + '\')">Suggest changes</button>' +
      '<button class="btn btn-ghost btn-sm" style="flex:1;color:var(--red)" onclick="chAnswer(\'' + id + '\',\'decline\',\'' + them[0] + '\')">Decline</button></div>';
  }
  if (ph === 'countered') {
    acts += '<div style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" style="flex:1" onclick="chAnswer(\'' + id + '\',\'accept\',\'me\')">Accept</button>' +
      '<button class="btn btn-ghost btn-sm" style="flex:1" onclick="chCounter(\'' + id + '\',\'me\')">Suggest changes</button>' +
      '<button class="btn btn-ghost btn-sm" style="flex:1;color:var(--red)" onclick="chAnswer(\'' + id + '\',\'decline\',\'me\')">Decline</button></div>';
  }
  if (ph === 'final') acts += '<button class="btn btn-ghost" style="margin-top:8px" onclick="chPostResult(\'' + id + '\')">\ud83e\udd1d Post the result to Connect</button>' +
    '<button class="btn btn-ghost" style="margin-top:8px" onclick="chRematch(\'' + id + '\')">\ud83d\udd01 Rematch</button>';
  if (ch.source === 'open') {
    var ss = typeof root.cpSessionsFor === 'function' ? root.cpSessionsFor(id) : [];
    if (ss.length) acts += '<div class="sec-header" style="margin-top:8px"><span class="sec-title" style="font-size:15px">Challenge games</span></div><div class="stat-card" style="margin-bottom:8px">' +
      ss.map(function (x) { var d = (x.date || '').split('-'); return '<div onclick="_cpLoad(function(){cpResume(\'' + x.id + '\')})" style="display:flex;justify-content:space-between;padding:6px 0;cursor:pointer;font-size:12px;color:var(--t2)"><span>' + (+d[1]) + '/' + (+d[2]) + ' \u00b7 ' + x.games.length + ' game' + (x.games.length === 1 ? '' : 's') + '</span><span style="color:var(--teal)">Open \u203a</span></div>'; }).join('') + '</div>';
    if (ph === 'running') acts += '<button class="btn btn-primary" style="margin-top:8px" onclick="chAddGames(\'' + id + '\')">\ud83c\udfb3 Bowl a challenge game</button>' +
      '<div style="font-size:11px;color:var(--t3);margin-top:6px;line-height:1.5">Opens the challenge card in Open Bowling \u203a Challenges. These games never go into your stats, averages, awards or exports. Your opponent bowls on the same card, or you type their score in afterwards (typed scores count in score contests only).</div>';
    else if (ph === 'upcoming') acts += '<div style="font-size:11px;color:var(--t3);margin-top:8px">Bowling opens on ' + escH(ch.params.start) + '.</div>';
  } else if (ph === 'running' || ph === 'upcoming') acts += '<button class="btn btn-primary" style="margin-top:8px" onclick="chAddGames(\'' + id + '\')">\ud83c\udfb3 Bowl / enter games for this</button>' +
    '<div style="font-size:11px;color:var(--t3);margin-top:6px;line-height:1.5">Games are entered the usual way (league night, tournament round); they count here automatically. A friend\u2019s games come from the Team Bowl nights you record.' +
    (CONTESTS[ch.contest].needs ? ' This contest needs pin-by-pin games: nights saved as scores only don\u2019t count.' : ' Scores-only nights count.') + '</div>';
  if (ph === 'sent' || ph === 'upcoming' || ph === 'running' || ph === 'countered') acts += '<button class="btn btn-ghost" style="margin-top:8px;color:var(--red)" onclick="chCancel(\'' + id + '\')">Cancel challenge</button>';
  if (ph === 'final' || ph === 'declined' || ph === 'cancelled') acts += '<button class="btn btn-ghost" style="margin-top:8px;color:var(--t3)" onclick="chDelete(\'' + id + '\')">Delete from the list</button>';
  return h + acts;
}
function rerender() { if (typeof root.cnRender === 'function') root.cnRender(); }
function chOpen(id) { root._chDetail = id; if (typeof root.cnTab === 'function') { root.cnTab('challenges'); root._chDetail = id; rerender(); } var s = document.getElementById('s-friend-feed'); if (s) s.scrollTop = 0; }
function chBack() { root._chDetail = null; rerender(); }
function stamp(ch, by, act, extra) { ch.rounds = ch.rounds || []; ch.rounds.push(Object.assign({ by: by, act: act, at: new Date().toISOString() }, extra || {})); }
function chAnswer(id, act, by) {
  var ch = chGet(id); if (!ch) return;
  if (act === 'accept') { ch.state = 'accepted'; stamp(ch, by, 'accept'); }
  else { ch.state = 'declined'; stamp(ch, by, 'decline'); }
  chPut(ch); if (root.closeModal) root.closeModal(); rerender();
}
function chCancel(id) { var ch = chGet(id); if (!ch) return; ch.state = 'cancelled'; stamp(ch, 'me', 'cancel'); chPut(ch); rerender(); }
function chDelete(id) { chSaveAll(chList().filter(function (c) { return c.id !== id; })); root._chDetail = null; rerender(); }
function chPostResult(id) {
  var ch = chGet(id); if (!ch || !ch.result) return;
  var w = ch.result.winners, rows = ch.result.rows.map(function (x) { return { name: person(x.pid).name, display: x.display, won: w.indexOf(x.pid) >= 0 }; });
  var facts = { kind: 'challenge', v: 1, challengeID: ch.id, name: ch.name || CONTESTS[ch.contest].name, line: contestLine(ch), date: ch.result.at, rows: rows,
    pills: [{ text: w.length === 1 && w[0] === 'me' && ch.people.length > 1 ? 'CHALLENGE WON' : w.length > 1 ? 'CHALLENGE TIED' : 'CHALLENGE', tone: 'gold' }], level: 'challenge' };
  if (typeof root.cnPost === 'function') root.cnPost(facts, 'friends');
}

/* ---------------- new challenge / suggest changes ---------------- */
var nx = null;   // { mode:'new'|'counter', id, by, source, preset, opponent }
function chNew(opts) { nx = Object.assign({ mode: 'new', source: null }, opts || {}); if (nx.source) stepPreset(); else stepSource(); }
function chRematch(id) { var ch = chGet(id); if (!ch) return; nx = { mode: 'new', source: ch.source || 'league', base: ch }; stepForm(); }
function chCounter(id, by) { var ch = chGet(id); if (!ch) return; nx = { mode: 'counter', id: id, by: by, source: ch.source || 'league', base: ch }; stepForm(); }
function sheet(html) { (root.openModal)(html); var mb = document.getElementById('modal-body'); if (mb) mb.scrollTop = 0; }
function stepSource() {
  sheet('<div class="modal-title">\ud83c\udfc1 New challenge</div><div style="font-size:12px;color:var(--t3);margin:-4px 0 12px">Where do the games come from?</div>' +
    '<div class="card" style="margin-bottom:10px;cursor:pointer" onclick="chPickSource(\'league\')"><div style="font-size:15px;font-weight:800;color:var(--t1)">\ud83c\udfb3 League challenge</div>' +
    '<div style="font-size:12px;color:var(--t2);margin-top:4px;line-height:1.5">Reads the league and tournament games you already record. They stay in your stats as usual.</div></div>' +
    '<div class="card" style="margin-bottom:10px;cursor:pointer" onclick="chPickSource(\'open\')"><div style="font-size:15px;font-weight:800;color:var(--t1)">\ud83c\udfaf Open challenge</div>' +
    '<div style="font-size:12px;color:var(--t2);margin-top:4px;line-height:1.5">Bowled as its own games (Open Bowling \u203a Challenges) and kept out of your stats. You and your opponent on one card, or type their scores in. Low Ball comes next.</div></div>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>');
}
function chPickSource(s) { nx.source = s; stepPreset(); }
function stepPreset() {
  sheet('<div class="modal-title">Pick a starting point</div><div style="font-size:12px;color:var(--t3);margin:-4px 0 10px">Presets fill the form; everything stays editable.</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' + PRESETS.map(function (p) {
      return '<div class="card" style="cursor:pointer;padding:10px 12px;margin:0" onclick="chPickPreset(\'' + p.id + '\')"><div style="font-size:13px;font-weight:800;color:var(--t1)">' + escH(p.name) + '</div>' +
        '<div style="font-size:10px;color:var(--t3);margin-top:3px;line-height:1.4">' + escH(CONTESTS[p.contest].about) + '</div></div>'; }).join('') +
    '<div class="card" style="cursor:pointer;padding:10px 12px;margin:0;border-style:dashed" onclick="chPickPreset(null)"><div style="font-size:13px;font-weight:800;color:var(--teal)">\u2795 Custom</div><div style="font-size:10px;color:var(--t3);margin-top:3px">Start from a blank form</div></div></div>' +
    '<button class="btn btn-secondary" style="margin-top:12px" onclick="chBackSource()">\u2039 Back</button>');
}
function chPickPreset(id) { nx.preset = id ? PRESETS.filter(function (p) { return p.id === id; })[0] : null; stepForm(); }
function defaults() {
  var t = todayStr(), p = nx.preset, b = nx.base;
  if (b) return { contest: b.contest, name: b.name, format: b.format || 'standard', params: JSON.parse(JSON.stringify(b.params)), opponent: b.people.filter(function (x) { return x !== 'me'; })[0] || 'solo' };
  return { contest: p ? p.contest : 'hgame', name: p ? p.name : '', format: 'standard', opponent: nx.opponent || (friendsList()[0] ? friendsList()[0].id : 'solo'),
    params: { start: t, end: addDays(t, (p && p.days) || 14), count: (p && p.count) || 'all', n: (p && p.n) || 9, min: (p && p.min) || '', target: (p && p.target) || '', leave: (p && p.leave) || '',
      where: nx.source === 'open' ? 'open' : 'any', leagueID: null, scoring: 'scratch', hcMode: 'scratch', basis: 220, pct: 90, hcCap: '', avgSource: 'established', avgLeagueID: null, avgs: {}, fixed: {}, tie: 'shared', proof: 'none', note: '' } };
}
function sel(id, opts, cur) { return '<select class="finput" id="' + id + '" onchange="chFormSync()">' + opts.map(function (o) { return '<option value="' + escH(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + escH(o[1]) + '</option>'; }).join('') + '</select>'; }
function fg(label, inner, id) { return '<div class="fgroup"' + (id ? ' id="' + id + '"' : '') + '><label class="flabel">' + label + '</label>' + inner + '</div>'; }
function stepForm() {
  var d = defaults(), p = d.params, counter = nx.mode === 'counter';
  var leagues = (DBp().leagues || []).filter(function (l) { return l.LeagueID > 0 && !l.BakerFormat && !l.Archived; });
  var opp = [['solo', 'Just me (solo)']].concat(friendsList().map(function (f) { return [f.id, f.name]; }));
  var isOpen = nx.source === 'open';
  var fmts = root.BDB_CHPLAY ? root.BDB_CHPLAY.FORMATS : { standard: { name: 'Standard scoring' } };
  sheet('<div class="modal-title">' + (counter ? 'Suggest changes' : isOpen ? '\ud83c\udfaf Open challenge' : '\ud83c\udfc1 League challenge') + '</div>' +
    (counter ? '<div style="font-size:12px;color:var(--t3);margin:-4px 0 10px">' + (nx.by === 'me' ? 'Your changes go back to ' + escH(person(nx.base.people.filter(function (x) { return x !== 'me'; })[0]).name) : 'As ' + escH(person(nx.by).name) + ' (preview): the changes go back to you') + '.</div>' : '') +
    fg('Name', '<input class="finput" id="cf-name" type="text" value="' + escH(d.name) + '" placeholder="' + escH(CONTESTS[d.contest].name) + '">') +
    (counter ? '' : fg('Opponent', sel('cf-opp', opp, d.opponent))) +
    (isOpen ? fg('Format', '<select class="finput" id="cf-format">' + Object.keys(fmts).map(function (k) { return '<option value="' + k + '"' + (fmts[k].soon ? ' disabled' : '') + (k === (d.format || 'standard') ? ' selected' : '') + '>' + escH(fmts[k].name) + (fmts[k].soon ? ' (next build)' : '') + '</option>'; }).join('') + '</select>') +
      '<div style="font-size:11px;color:var(--t3);margin:-6px 0 10px">Games are bowled for this challenge only and never enter your stats.</div>' : '') +
    fg('Contest', sel('cf-contest', Object.keys(CONTESTS).map(function (k) { return [k, (CONTESTS[k].first ? 'First to: ' : '') + CONTESTS[k].name]; }), d.contest)) +
    '<div id="cf-about" style="font-size:11px;color:var(--t3);margin:-6px 0 10px">' + escH(CONTESTS[d.contest].about) + '</div>' +
    fg('Target', '<input class="finput" id="cf-target" type="number" value="' + escH(p.target) + '" placeholder="e.g. 700">', 'cf-g-target') +
    fg('Leave (pins standing)', '<input class="finput" id="cf-leave" type="text" value="' + escH(p.leave) + '" placeholder="e.g. 10, 7 or 3-6-10">', 'cf-g-leave') +
    '<div style="display:flex;gap:8px">' + fg('Start', '<input class="finput" id="cf-start" type="date" value="' + escH(p.start) + '">') + fg('End', '<input class="finput" id="cf-end" type="date" value="' + escH(p.end || '') + '">') + '</div>' +
    '<div style="display:flex;gap:8px" id="cf-g-count">' + fg('Games that count', sel('cf-count', [['all', 'All in the window'], ['first', 'First N'], ['best', 'Best N']], p.count)) + fg('N', '<input class="finput" id="cf-n" type="number" value="' + escH(p.n) + '">', 'cf-g-n') + '</div>' +
    fg('Minimum games / chances', '<input class="finput" id="cf-min" type="number" value="' + escH(p.min) + '" placeholder="optional">', 'cf-g-min') +
    (isOpen ? '<input type="hidden" id="cf-where" value="open">' : fg('Where', sel('cf-where', [['any', 'Any league or tournament'], ['league', 'One league'], ['tournament', 'Tournaments only']], p.where))) +
    fg('League', sel('cf-league', leagues.map(function (l) { return [l.LeagueID, l.LeagueName]; }), p.leagueID), 'cf-g-league') +
    '<div id="cf-g-scoring">' + fg('Scoring', sel('cf-hc', Object.keys(HC_LABEL).filter(function (k) { return !isOpen || k !== 'league'; }).map(function (k) { return [k, HC_LABEL[k]]; }), hcMode(p))) +
    '<div id="cf-hc-about" style="font-size:11px;color:var(--t3);margin:-6px 0 10px"></div>' +
    '<div style="display:flex;gap:8px" id="cf-g-hc">' + fg('Basis', '<input class="finput" id="cf-basis" type="number" value="' + escH(p.basis) + '">') + fg('%', '<input class="finput" id="cf-pct" type="number" value="' + escH(p.pct) + '">') +
    fg('Cap', '<input class="finput" id="cf-cap" type="number" value="' + escH(p.hcCap == null ? '' : p.hcCap) + '" placeholder="none">') + '</div></div>' +
    '<div id="cf-g-avg">' + fg('Average going in from', sel('cf-avgsrc', Object.keys(AVG_LABEL).map(function (k) { return [k, AVG_LABEL[k]]; }), p.avgSource || 'established')) +
    fg('Average league', sel('cf-avgleague', leagues.map(function (l) { return [l.LeagueID, l.LeagueName]; }), p.avgLeagueID), 'cf-g-avgleague') + '</div>' +
    '<div id="cf-per" data-avgs="' + escH(JSON.stringify(p.avgs || {})) + '" data-fixed="' + escH(JSON.stringify(p.fixed || {})) + '"></div>' +
    fg('Tie', sel('cf-tie', [['shared', 'Shared win'], ['pins', 'Most total pins wins the tie']], p.tie), 'cf-g-tie') +
    fg('Proof', sel('cf-proof', [['none', PROOF.none], ['photo', PROOF.photo], ['confirm', PROOF.confirm]], p.proof)) +
    fg('Note', '<input class="finput" id="cf-note" type="text" value="' + escH(p.note) + '" placeholder="loser buys the first pitcher">') +
    '<div id="cf-err" style="font-size:12px;color:var(--red);margin-bottom:8px"></div>' +
    '<button class="btn btn-primary" onclick="chSubmit()">' + (counter ? 'Send changes' : 'Send challenge') + '</button>' +
    '<button class="btn btn-secondary" onclick="' + (counter || nx.base ? 'closeModal()' : 'stepPresetBack()') + '">' + (counter || nx.base ? 'Cancel' : '\u2039 Back') + '</button>');
  chFormSync();
}
function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }
function showEl(id, on) { var e = document.getElementById(id); if (e) e.style.display = on ? '' : 'none'; }
function chFormSync() {
  var k = val('cf-contest'), c = CONTESTS[k] || {};
  var a = document.getElementById('cf-about'); if (a) a.textContent = c.about || '';
  showEl('cf-g-target', !!c.first && k !== 'f_300');
  showEl('cf-g-leave', k === 'leave' || k === 'f_leave');
  showEl('cf-g-count', !c.first); showEl('cf-g-n', val('cf-count') !== 'all');
  showEl('cf-g-min', ['avg', 'spare', 'single', 'leave'].indexOf(k) >= 0);
  showEl('cf-g-league', val('cf-where') === 'league');
  var hcOn = HC_CONTESTS.indexOf(k) >= 0, hm = hcOn ? val('cf-hc') : 'scratch', needAvg = (hcOn && hm === 'formula') || k === 'poa' || k === 'beatavg';
  showEl('cf-g-scoring', hcOn); showEl('cf-g-hc', hm === 'formula');
  var ha = document.getElementById('cf-hc-about');
  if (ha) ha.textContent = { scratch: 'Raw scores.', formula: 'Each bowler gets (basis \u2212 average going in) \u00d7 % a game, rounded down, up to the cap. Works across leagues.',
    league: 'Each game takes the handicap of the league night it was bowled in (your series\u2019 handicap; a friend\u2019s from that league\u2019s setup). Leagues without handicap add 0.',
    fixed: 'Type each bowler\u2019s handicap a game below.' }[hm] || '';
  showEl('cf-g-avg', needAvg); showEl('cf-g-avgleague', needAvg && val('cf-avgsrc') === 'league');
  /* per-bowler inputs: typed averages or fixed handicaps */
  var per = document.getElementById('cf-per');
  if (per) {
    var keep = function (attr, cls) { var o = {}; try { o = JSON.parse(per.getAttribute(attr) || '{}'); } catch (e) {} per.querySelectorAll('.' + cls).forEach(function (i) { o[i.getAttribute('data-pid')] = i.value; }); per.setAttribute(attr, JSON.stringify(o)); return o; };
    var avgs = keep('data-avgs', 'cf-pa'), fixed = keep('data-fixed', 'cf-pf');
    var people = nx.mode === 'counter' && nx.base ? nx.base.people : ['me'].concat(val('cf-opp') && val('cf-opp') !== 'solo' ? [val('cf-opp')] : []);
    var kind = needAvg && val('cf-avgsrc') === 'manual' ? 'pa' : hcOn && hm === 'fixed' ? 'pf' : null;
    per.innerHTML = kind ? '<div class="flabel" style="margin-bottom:6px">' + (kind === 'pa' ? 'Average going in' : 'Handicap a game') + '</div><div style="display:flex;gap:8px;margin-bottom:10px">' + people.map(function (pid) {
      var v = (kind === 'pa' ? avgs : fixed)[pid]; return '<div style="flex:1"><div style="font-size:11px;color:var(--t3);margin-bottom:3px">' + escH(person(pid).name) + '</div><input class="finput cf-p' + (kind === 'pa' ? 'a' : 'f') + '" data-pid="' + pid + '" type="number" value="' + escH(v == null ? '' : v) + '"></div>'; }).join('') + '</div>' : '';
  }
  showEl('cf-g-tie', !c.first);
  var cnt = document.getElementById('cf-count'); if (cnt && c.dir === 'low' && cnt.value === 'best') cnt.value = 'first';
}
function perVals(cls) { var o = {}; document.querySelectorAll('#cf-per .' + cls).forEach(function (i) { if (i.value !== '') o[i.getAttribute('data-pid')] = +i.value; }); return o; }
function readForm() {
  var k = val('cf-contest'), c = CONTESTS[k], num = function (id) { var v = val(id); return v === '' ? null : +v; };
  var p = { start: val('cf-start'), end: val('cf-end') || null, count: c.first ? 'all' : val('cf-count'), n: num('cf-n'), min: num('cf-min'), target: c.first && k !== 'f_300' ? num('cf-target') : null,
    leave: (k === 'leave' || k === 'f_leave') ? normLeaveParam(val('cf-leave')) : '', where: val('cf-where'), leagueID: val('cf-where') === 'league' ? num('cf-league') : null,
    hcMode: HC_CONTESTS.indexOf(k) >= 0 ? val('cf-hc') : 'scratch', basis: num('cf-basis') || 220, pct: num('cf-pct') || 90, hcCap: num('cf-cap'),
    avgSource: val('cf-avgsrc') || 'established', avgLeagueID: val('cf-avgsrc') === 'league' ? num('cf-avgleague') : null, avgs: perVals('cf-pa'), fixed: perVals('cf-pf'),
    tie: c.first ? 'shared' : val('cf-tie'), proof: val('cf-proof'), note: val('cf-note').trim() };
  p.scoring = p.hcMode === 'scratch' ? 'scratch' : 'handicap';
  var err = !p.start ? 'Pick a start date' : (p.end && p.end < p.start) ? 'The end is before the start' : (c.first && k !== 'f_300' && !(p.target > 0)) ? 'Set a target' :
    ((k === 'leave' || k === 'f_leave') && !p.leave) ? 'Type the leave (pins standing), e.g. 10 or 3-6-10' : (p.count !== 'all' && !(p.n > 0)) ? 'Set how many games count' : (!c.first && !p.end) ? 'Set an end date' : '';
  return { contest: k, name: val('cf-name').trim(), opponent: val('cf-opp'), format: val('cf-format') || 'standard', params: p, err: err };
}
function chSubmit() {
  var f = readForm(); if (f.err) { var e = document.getElementById('cf-err'); if (e) e.textContent = f.err; return; }
  if (nx.mode === 'counter') {
    var ch = chGet(nx.id); if (!ch) return;
    var before = { contest: ch.contest, params: JSON.parse(JSON.stringify(ch.params)) };
    ch.contest = f.contest; ch.params = f.params; if (f.name) ch.name = f.name; if (ch.source === 'open') ch.format = f.format;
    stamp(ch, nx.by, 'counter', { before: before, after: { contest: f.contest, params: f.params } });
    ch.state = nx.by === 'me' ? 'sent' : 'countered';
    chPut(ch); root.closeModal(); chOpen(ch.id); return;
  }
  var solo = f.opponent === 'solo' || !f.opponent;
  var ch2 = { id: 'c' + Date.now().toString(36), created: new Date().toISOString(), source: nx.source === 'open' ? 'open' : 'league', contest: f.contest, name: f.name, params: f.params,
    people: solo ? ['me'] : ['me', f.opponent], state: solo ? 'accepted' : 'sent', rounds: [], result: null };
  stamp(ch2, 'me', solo ? 'accept' : 'sent');
  if (ch2.source === 'open') ch2.format = f.format;
  chPut(ch2); root.closeModal(); chOpen(ch2.id);
  if (root.toast) root.toast(solo ? 'Solo challenge started' : 'Challenge sent (preview: answer it as your friend on the next screen)');
}
function stepPresetBack() { stepPreset(); }
function chBackSource() { stepSource(); }

/* ---------------- entering games from a challenge: through the normal screens ---------------- */
function chAddGames(id) {
  var ch = chGet(id); if (!ch) return;
  if (ch.source === 'open') { root._cpLoad(function () { root.cpBowl(id); }); return; }   // its own card, never the league screens
  var p = ch.params;
  if (p.where === 'league' && p.leagueID != null && typeof root.selectLeague === 'function') root.selectLeague(p.leagueID);
  else if (p.where === 'tournament') root.navTo('s-tournaments');
  else root.navTo('s-leagues');
  if (root.toast) root.toast('Start or open the night as usual: it counts toward \u201c' + (ch.name || CONTESTS[ch.contest].name) + '\u201d', 4000);
}
/* ---------------- the push: after a game is saved, which running challenges it counts toward ---------------- */
function chGameBannerHTML(gameID) {
  var d = DBp(), g0 = (d.games || []).filter(function (x) { return x.GameID === gameID; })[0];
  if (!g0) return '';
  var list = chList().filter(function (ch) { return ch.source !== 'open' && ch.state === 'accepted' && !ch.result && phase(ch) === 'running'; });
  if (!list.length) return '';
  var games = gamesFor(['me']).me, mine = games.filter(function (x) { return x.key === 's' + g0.SeriesID && x.gameNo === (g0.GameNumber || 0); })[0];
  if (!mine) return '';
  var lines = [];
  list.forEach(function (ch) {
    if (!inWindow(mine, ch.params) || (CONTESTS[ch.contest].needs && !mine.frames)) return;
    var r = evalNow(ch), i = -1; r.rows.forEach(function (x, k) { if (x.pid === 'me') i = k; });
    var me = r.rows[i], solo = ch.people.length < 2;
    var where = solo ? (me ? me.display : '') : (i === 0 ? 'you lead' : 'you\u2019re ' + (i + 1) + (i === 1 ? 'nd' : i === 2 ? 'rd' : 'th')) + ' \u00b7 ' + r.rows.map(function (x) { return first(x.pid) + ' ' + x.display; }).join(' \u00b7 ');
    lines.push('<div onclick="openChallengeFromBanner(\'' + ch.id + '\')" style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer"><span style="font-size:18px">\ud83c\udfc1</span>' +
      '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:700">' + escH(ch.name || CONTESTS[ch.contest].name) + (solo ? '' : ' vs ' + escH(vsLine(ch))) + '</div>' +
      '<div style="font-size:12px;color:var(--t3)">Counts \u00b7 ' + escH(where) + '</div></div><span style="color:var(--t3)">\u203a</span></div>');
  });
  return lines.length ? '<div class="card" style="margin-bottom:10px;border:1px solid rgba(0,217,217,0.35)"><div style="font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--teal);margin-bottom:4px">\ud83c\udfc1 Challenges</div>' + lines.join('') + '</div>' : '';
}

/* v30.244: standings strip for the open challenge card (chplay.js) */
function chMiniStandingsHTML(id) {
  var ch = chGet(id); if (!ch) return '';
  var r = evalNow(ch);
  return '<div class="card" style="margin-top:8px"><div style="font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--teal);margin-bottom:4px">\ud83c\udfc1 ' + escH(CONTESTS[ch.contest].name) + (r.status === 'final' ? ' \u00b7 final' : '') + '</div>' +
    r.rows.map(function (x, i) { var win = (ch.result ? ch.result.winners : []).indexOf(x.pid) >= 0; return '<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;color:' + (i === 0 || win ? 'var(--t1)' : 'var(--t2)') + '"><span>' + (i + 1) + '. ' + escH(person(x.pid).name) + (win ? ' \ud83c\udfc6' : '') + '</span><b>' + escH(x.display) + '</b></div>'; }).join('') + '</div>';
}
function chStandingsLine(id) {
  var ch = chGet(id); if (!ch) return '';
  var r = evalNow(ch);
  return r.rows.map(function (x) { var win = (ch.result ? ch.result.winners : []).indexOf(x.pid) >= 0; return '<span style="font-weight:700;color:' + (win ? 'var(--gold)' : 'var(--t1)') + '">' + (win ? '\ud83c\udfc6 ' : '') + escH(first(x.pid)) + ' <span style="color:var(--t2);font-weight:600">' + escH(x.display) + '</span></span>'; }).join('<span style="color:var(--t3)">\u00b7</span>');
}
/* ---------------- head-to-head (bowler menu) ---------------- */
function chHeadToHeadHTML(pid) {
  var grp = typeof root.grpLoadAll === 'function' ? root.grpLoadAll() : [];
  var h = /^tb\d+$/.test(pid) ? sameNight(grp, +pid.slice(2)) : null, rec = chRecordFor('me', pid), nm = first(pid);
  var row = function (k, v) { return '<div class="stat-row" style="border:none;padding:4px 0"><span>' + k + '</span><span class="sval">' + v + '</span></div>'; };
  return '<div class="stat-card" style="margin-bottom:10px"><div style="font-size:11px;font-weight:700;color:var(--t3);letter-spacing:.8px;text-transform:uppercase;margin-bottom:6px">Challenges</div>' +
    row('You vs ' + escH(nm), recStr(rec)) + '</div>' +
    '<div class="stat-card" style="margin-bottom:10px"><div style="font-size:11px;font-weight:700;color:var(--t3);letter-spacing:.8px;text-transform:uppercase;margin-bottom:6px">Same nights (Team Bowl)</div>' +
    (h && h.games ? row('Games', h.w + ' \u2013 ' + h.l + ' \u2013 ' + h.t) + row('Nights (series)', h.nw + ' \u2013 ' + h.nl + ' \u2013 ' + h.nt) +
      row('Average on those nights', Math.floor(h.myPins / h.games) + ' vs ' + Math.floor(h.theirPins / h.games)) + row('Total pins', h.myPins + ' vs ' + h.theirPins) :
      '<div style="font-size:12px;color:var(--t3)">No Team Bowl nights together yet.</div>') + '</div>';
}

api.chTabHTML = chTabHTML;
if (typeof document !== 'undefined') {
  root.chTabHTML = chTabHTML; root.chDetailHTML = chDetailHTML; root.chOpen = chOpen; root.chBack = chBack; root.chNew = chNew; root.chPickSource = chPickSource; root.chPickPreset = chPickPreset;
  root.chFormSync = chFormSync; root.chSubmit = chSubmit; root.chAnswer = chAnswer; root.chCounter = chCounter; root.chCancel = chCancel; root.chDelete = chDelete;
  root.chRematch = chRematch; root.chPostResult = chPostResult; root.chRecordFor = chRecordFor; root.chHeadToHeadHTML = chHeadToHeadHTML; root.stepPresetBack = stepPresetBack; root.chBackSource = chBackSource; root.chAddGames = chAddGames; root.chGameBannerHTML = chGameBannerHTML;
  root.chPerson = person; root.chPhase = phase; root.chMiniStandingsHTML = chMiniStandingsHTML; root.chStandingsLine = chStandingsLine;
}

root.BDB_CHALLENGE = api;
root.CHALLENGE_JS_VERSION = CHALLENGE_VERSION;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
