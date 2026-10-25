/* BowlingDB awards engine -- v30.226 AWD-1 step 1 (design: DESIGN_awards_2.md, LOCKED 2026-10-24).
   Pure: awardsScan(data, cfg) reads games / series / frames / attempts / leagues / tournaments /
   leaves and returns every award occurrence. Nothing here writes storage or touches the page; the
   trophy case (step 3) caches and draws the result. Loaded by index.html as awards.js?v=APP_VERSION
   (from step 3); also require()-able for the Node harness. */
(function (root) {
'use strict';
var AWD_VERSION = 'v30.227';   // step 1 engine + step 3 trophy case (v30.227: filters, splits, brackets)

/* USBC national brackets (2011-12 adult revision) -- default, editable in Settings (step 6). */
var USBC_BRACKETS = [
  { id: 'g125', kind: 'game',   lo: 125, hi: 149, maxAvg: 100, name: '125 game' },
  { id: 's300', kind: 'series', lo: 300, hi: 399, maxAvg: 90,  name: '300 series' },
  { id: 's400', kind: 'series', lo: 400, hi: 499, maxAvg: 120, name: '400 series' },
  { id: 's500', kind: 'series', lo: 500, hi: 599, maxAvg: 145, name: '500 series' },
  { id: 's600', kind: 'series', lo: 600, hi: 699, maxAvg: 175, name: '600 series' }
];
var DEFAULT_CFG = { brackets: USBC_BRACKETS, poaGame: [75], poaSeries: [140], minGames: 21 };

/* Named leaves (first ball of a fresh rack). Pins standing, sorted. */
var NAMED_LEAVES = {
  '7,10':       { id: 'sp710',   name: '7-10 split' },
  '4,6,7,10':   { id: 'spbig4',  name: 'Big Four (4-6-7-10)' },
  '4,6,7,8,10': { id: 'spgc1',   name: 'Greek Church (4-6-7-8-10)' },
  '4,6,7,9,10': { id: 'spgc2',   name: 'Greek Church (4-6-7-9-10)' },
  '5,7,10':     { id: 'splily',  name: 'Lily / Sour Apple (5-7-10)' }
};

var AWARDS = {
  h300:   { cls: 'honor', name: '300 game' },
  h299:   { cls: 'honor', name: '299 game', app: true },
  h298:   { cls: 'honor', name: '298 game', app: true },
  h700:   { cls: 'honor', name: '700 series' },
  h800:   { cls: 'honor', name: '800 series' },
  h900:   { cls: 'honor', name: '900 series' },
  h11f:   { cls: 'honor', name: '11 in a row (front 11)' },
  h11b:   { cls: 'honor', name: '11 in a row (back 11)' },
  hclean: { cls: 'honor', name: 'Clean game' },
  hcleans:{ cls: 'honor', name: 'Clean series' },
  hspare: { cls: 'honor', name: 'All-spare game' },
  hdutch: { cls: 'honor', name: 'Dutch 200' },
  htrip:  { cls: 'honor', name: 'Triplicate' },
  nt300:  { cls: 'honor', name: 'No-Tap 300' },
  pg:     { cls: 'poa',   name: 'pins over average (game)' },
  ps:     { cls: 'poa',   name: 'pins over average (series)' },
  mhg:    { cls: 'mile',  name: 'New career high game' },
  mhs:    { cls: 'mile',  name: 'New career high series' },
  m250:   { cls: 'mile',  name: 'First 250 game' },
  m275:   { cls: 'mile',  name: 'First 275 game' },
  mrun:   { cls: 'mile',  name: 'Longest strike run' }
};
Object.keys(NAMED_LEAVES).forEach(function (k) {
  var L = NAMED_LEAVES[k];
  AWARDS[L.id + 'c'] = { cls: 'split', name: L.name + ' converted', leave: k };
  AWARDS[L.id + 'l'] = { cls: 'split', name: 'Left the ' + L.name, leave: k, chance: true };
});
USBC_BRACKETS.forEach(function (b) { AWARDS[b.id] = { cls: 'capped', name: b.name }; });
var DESC = {
  h300: 'Twelve strikes in a row: a perfect game.', h299: 'One pin from perfect (app honor; not a current USBC national award).',
  h298: 'Two pins from perfect (app honor; not a current USBC national award).',
  h700: 'A three-game series of 700 to 799. USBC: open to all averages.', h800: 'A three-game series of 800 to 899.', h900: 'A perfect 900 series.',
  h11f: 'The first 11 balls of the game were strikes (not a 300).', h11b: 'The last 11 balls of the game were strikes (not a 300).',
  hclean: 'A strike or spare in every frame.', hcleans: 'Three clean games in one series.', hspare: 'A spare in every frame, no strikes.',
  hdutch: 'Strike and spare alternating every frame, for exactly 200.', htrip: 'All three games of a series with the same score.',
  nt300: 'A perfect No-Tap game (a 9 on the first ball counts as a strike).',
  pg: 'A game at least 75 pins over your average (USBC national: 75).', ps: 'A series at least 140 pins over three times your average (USBC national: 140).',
  mhg: 'A new career high game.', mhs: 'A new career high series.', m250: 'Your first game of 250 or more.', m275: 'Your first game of 275 or more.',
  mrun: 'A new longest run of strikes (6 or more).',
  g125: 'A 125 to 149 game with an average of 100 or below (USBC national).', s300: 'A 300 to 399 series with an average of 90 or below.',
  s400: 'A 400 to 499 series with an average of 120 or below.', s500: 'A 500 to 599 series with an average of 145 or below.',
  s600: 'A 600 to 699 series with an average of 175 or below.'
};
var LEAVE_DESC = {
  '7,10': 'The 7 and 10 pins, the two back corners: the most famous split in bowling.',
  '4,6,7,10': 'The 4, 6, 7 and 10: two pins on each side of the deck.',
  '4,6,7,8,10': 'Three pins on the left, two on the right: one of the two Greek Churches.',
  '4,6,7,9,10': 'Two pins on the left, three on the right: the other Greek Church.',
  '5,7,10': 'The Lily, also called the Sour Apple: the 5 pin with both back corners, usually from a weak, flat hit. One of the rarest leaves, and nearly impossible to convert with a full-weight ball.'
};
Object.keys(AWARDS).forEach(function (k) {
  var a = AWARDS[k];
  if (a.leave) a.desc = (k.slice(-1) === 'c' ? 'Converted: ' : 'Left on the first ball: ') + LEAVE_DESC[a.leave];
  else a.desc = DESC[k] || '';
});

/* 10th frame: the app's own helper when loaded in the page; this copy (identical rule) otherwise. */
function f10Roles(a1, a2, a3, noTap) {
  if (typeof root.f10BallRoles === 'function') return root.f10BallRoles(a1, a2, a3, noTap);
  var out = [], pf = function (a) { return (a && a.Pinfall != null) ? a.Pinfall : null; };
  var X = function (v) { return v === 10 || (!!noTap && v === 9); };
  var p1 = pf(a1), p2 = pf(a2), p3 = pf(a3);
  if (p1 == null) return out;
  out.push({ att: a1, n: 1, role: 'fresh', strike: X(p1), spareOpp: false });
  if (p2 == null) return out;
  if (X(p1)) out.push({ att: a2, n: 2, role: 'fresh', strike: X(p2), spareOpp: false });
  else out.push({ att: a2, n: 2, role: 'spare', strike: false, spareOpp: true, converted: p1 + p2 >= 10, leaveAtt: a1 });
  if (p3 == null) return out;
  if (X(p1) && !X(p2)) { var made = p2 + p3 >= 10; out.push({ att: a3, n: 3, role: 'spare', bonus: true, strike: false, spareOpp: made, converted: made, leaveAtt: a2 }); }
  else if (X(p1) || p1 + p2 >= 10) out.push({ att: a3, n: 3, role: 'fill', strike: X(p3), spareOpp: false });
  return out;
}

function leaveKey(leaf) {
  if (!leaf) return null;
  var p = [];
  for (var i = 1; i <= 10; i++) if (leaf['Pin' + i]) p.push(i);
  return p.join(',');
}
function dateOf(g, S) { return g.DateBowled || (S[g.SeriesID] && S[g.SeriesID].DateBowled) || ''; }

/* Where a game was bowled: kind (league | tournament | open | notap) + certified (true | false | null). */
function levelOf(g, L, T, S) {
  if (g.NoTap) return { kind: 'notap', certified: null };
  var lg = g.LeagueID != null ? L[g.LeagueID] : null;
  var ser = S && S[g.SeriesID];
  var tid = g.TournamentID != null ? g.TournamentID : (ser && ser.TournamentID != null ? ser.TournamentID : null);
  if (g.GameType === 'Tournament' || tid != null) {
    var t = tid != null ? T[tid] : null;
    return { kind: 'tournament', certified: t && t.Sanctioned != null ? !!t.Sanctioned : (lg && lg.Sanctioned != null ? !!lg.Sanctioned : null) };
  }
  if (lg && !lg.IsTeamBowl) return { kind: 'league', certified: lg.Sanctioned == null ? null : !!lg.Sanctioned };
  return { kind: 'open', certified: null };
}
function levelKey(lv) {
  if (lv.kind === 'notap') return 'notap';
  if (lv.kind === 'open') return 'open';
  return lv.certified === true ? 'certified' : lv.certified === false ? 'noncertified' : 'unmarked';
}

/* One game's deliveries and frame facts from frames + attempts. null when there is no frame data. */
function gameDetail(g, frames, attemptsByFrame, leafKeyById) {
  if (!frames || frames.length !== 10) return null;
  var fr = frames.slice().sort(function (a, b) { return a.FrameNumber - b.FrameNumber; });
  var balls = [], marks = [], racks = [];   // balls: strike flags in order; marks: X / S / O per frame
  for (var i = 0; i < 10; i++) {
    var f = fr[i];
    if (f.FrameNumber !== i + 1) return null;
    var at = (attemptsByFrame[f.FrameID] || []).slice().sort(function (a, b) { return a.Attempt - b.Attempt; });
    var a1 = at[0], a2 = at[1], a3 = at[2];
    if (!a1 || a1.Pinfall == null) return null;
    var X = function (v) { return v === 10 || (!!g.NoTap && v === 9); };
    if (i < 9) {
      if (X(a1.Pinfall)) { balls.push(true); marks.push('X'); racks.push({ fresh: a1, next: null }); }
      else {
        if (!a2 || a2.Pinfall == null) return null;
        balls.push(false, false);
        var made = a1.Pinfall + a2.Pinfall >= 10;
        marks.push(made ? 'S' : 'O');
        racks.push({ fresh: a1, next: a2, converted: made });
      }
    } else {
      var roles = f10Roles(a1, a2, a3, g.NoTap);
      roles.forEach(function (r) { balls.push(!!r.strike); });
      var p1 = a1.Pinfall, p2 = a2 ? a2.Pinfall : null;
      marks.push(X(p1) ? 'X' : (p2 != null && p1 + p2 >= 10 ? 'S' : 'O'));
      /* fresh racks in the 10th: ball 1 always; ball 2 after a strike (its leave meets ball 3) */
      roles.forEach(function (r, k) {
        if (r.role !== 'fresh' || r.strike) return;
        var nxt = roles[k + 1];
        racks.push({ fresh: r.att, next: nxt ? nxt.att : null, converted: !!(nxt && nxt.role === 'spare' && nxt.converted) });
      });
    }
  }
  var run = 0, best = 0;
  balls.forEach(function (b) { run = b ? run + 1 : 0; if (run > best) best = run; });
  return { balls: balls, marks: marks, racks: racks.map(function (r) {
    return { leave: r.fresh ? leafKeyById[r.fresh.LeaveID] || null : null, converted: !!r.converted, hasNext: !!r.next };
  }), bestRun: best };
}

function floorAvg(sum, n) { return n ? Math.floor(sum / n) : null; }

function awardsScan(data, cfg) {
  cfg = cfg || DEFAULT_CFG;
  var minG = cfg.minGames || 21;
  var L = {}, T = {}, S = {}, leafKeyById = {};
  (data.leagues || []).forEach(function (l) { L[l.LeagueID] = l; });
  (data.tournaments || []).forEach(function (t) { T[t.TournamentID] = t; });
  (data.series || []).forEach(function (s) { S[s.SeriesID] = s; });
  (data.leaves || []).forEach(function (lf) { leafKeyById[lf.LeaveID] = leaveKey(lf); });
  var framesByGame = {}, attByFrame = {};
  (data.frames || []).forEach(function (f) { (framesByGame[f.GameID] = framesByGame[f.GameID] || []).push(f); });
  (data.attempts || []).forEach(function (a) { (attByFrame[a.FrameID] = attByFrame[a.FrameID] || []).push(a); });

  var games = (data.games || []).filter(function (g) { return g.FinalScore != null; }).map(function (g) {
    return { g: g, date: dateOf(g, S), score: g.FinalScore, level: levelOf(g, L, T, S) };
  });
  games.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.g.SeriesID - b.g.SeriesID) || ((a.g.GameNumber || 0) - (b.g.GameNumber || 0)); });

  /* series: first 3 games */
  var seriesMap = {};
  games.forEach(function (x) { (seriesMap[x.g.SeriesID] = seriesMap[x.g.SeriesID] || []).push(x); });
  var seriesList = Object.keys(seriesMap).map(function (sid) {
    var gs = seriesMap[sid].slice().sort(function (a, b) { return (a.g.GameNumber || 0) - (b.g.GameNumber || 0); });
    return { sid: +sid, games: gs, date: gs[0].date, first3: gs.length >= 3 ? gs.slice(0, 3) : null, level: gs[0].level, leagueID: gs[0].g.LeagueID };
  }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.sid - b.sid; });

  /* league averages as of each session (games before the session only) */
  var leagueRun = {};             // LeagueID -> {sum, n, lastDate, firstDate}
  seriesList.forEach(function (s) {
    if (s.level.kind !== 'league') return;
    var r = leagueRun[s.leagueID] || (leagueRun[s.leagueID] = { sum: 0, n: 0, firstDate: s.date, lastDate: s.date });
    s.leagueAvgBefore = r.n >= minG ? floorAvg(r.sum, r.n) : null;
    s.leagueGamesBefore = r.n;
    s.games.forEach(function (x) { if (!x.g.NoTap) { r.sum += x.score; r.n++; } });
    r.lastDate = s.date;
  });
  function finalAvg(lid) { var r = leagueRun[lid]; return r && r.n >= minG ? floorAvg(r.sum, r.n) : null; }
  function priorSeasonBest(beforeDate, lineageID) {
    /* leagues finished before this date: same lineage first, else the highest of the most recent season */
    var done = Object.keys(leagueRun).map(Number).filter(function (lid) { return leagueRun[lid].lastDate < beforeDate && finalAvg(lid) != null; });
    if (!done.length) return null;
    if (lineageID != null) {
      var same = done.filter(function (lid) { return L[lid] && L[lid].LineageID === lineageID; })
        .sort(function (a, b) { return leagueRun[b].lastDate < leagueRun[a].lastDate ? -1 : 1; });
      if (same.length) return { avg: finalAvg(same[0]), rule: 'last season, same league' };
    }
    var latest = done.reduce(function (m, lid) { return leagueRun[lid].lastDate > m ? leagueRun[lid].lastDate : m; }, '');
    var cutoff = new Date(new Date(latest + 'T12:00:00').getTime() - 400 * 864e5).toISOString().slice(0, 10);
    var recent = done.filter(function (lid) { return leagueRun[lid].lastDate >= cutoff; });
    var best = Math.max.apply(null, recent.map(finalAvg));
    return { avg: best, rule: 'last season, highest in any league' };
  }
  function establishedAvg(date) {
    /* open play / tournaments / No-Tap: the most recent league average of 21+ games before this date */
    var best = null;
    seriesList.forEach(function (s) {
      if (s.level.kind === 'league' && s.date < date && s.leagueAvgBefore != null) best = { avg: s.leagueAvgBefore, rule: 'established league average' };
    });
    return best || priorSeasonBest(date, null);
  }
  function avgFor(s) {
    if (s.level.kind === 'league') {
      if (s.leagueAvgBefore != null) return { avg: s.leagueAvgBefore, rule: 'this league, ' + s.leagueGamesBefore + ' games' };
      var lg = L[s.leagueID];
      var ea = data.entryAvg && data.entryAvg[s.leagueID] != null ? data.entryAvg[s.leagueID] : (lg && lg.EntryAvg != null ? lg.EntryAvg : null);
      if (ea != null) return { avg: Math.floor(ea), rule: 'entering average' };
      return priorSeasonBest(s.date, lg ? lg.LineageID : null);
    }
    return establishedAvg(s.date);
  }

  var out = [];
  function add(id, s, x, extra) {
    var o = { award: id, cls: AWARDS[id].cls, name: AWARDS[id].name, level: levelKey((x || s).level), kind: (x || s).level.kind,
      date: (x || s).date, seriesID: s ? s.sid : (x ? x.g.SeriesID : null), gameID: x ? x.g.GameID : null };
    if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    out.push(o);
  }

  var hiGame = 0, hiSeries = 0, had250 = false, had275 = false, bestRun = 0;
  seriesList.forEach(function (s) {
    var av = avgFor(s);
    s.games.forEach(function (x) {
      var g = x.g, sc = x.score;
      if (g.NoTap) { if (sc === 300) add('nt300', s, x, { value: sc }); return; }
      if (sc === 300) add('h300', s, x, { value: sc });
      else if (sc === 299) add('h299', s, x, { value: sc });
      else if (sc === 298) add('h298', s, x, { value: sc });
      var det = gameDetail(g, framesByGame[g.GameID], attByFrame, leafKeyById);
      if (det) {
        var b = det.balls, all = function (arr) { return arr.length && arr.every(Boolean); };
        if (sc !== 300 && b.length >= 12 && all(b.slice(0, 11)) && !b[11]) add('h11f', s, x, { value: sc });
        if (sc !== 300 && b.length >= 12 && all(b.slice(-11)) && !b[b.length - 12]) add('h11b', s, x, { value: sc });
        if (det.marks.every(function (m) { return m !== 'O'; })) add('hclean', s, x, { value: sc });
        if (det.marks.every(function (m) { return m === 'S'; })) add('hspare', s, x, { value: sc });
        if (sc === 200 && det.marks.every(function (m, i) { return m !== 'O' && (i === 0 || m !== det.marks[i - 1]); })) add('hdutch', s, x, { value: sc });
        det.racks.forEach(function (r) {
          var nl = r.leave && NAMED_LEAVES[r.leave];
          if (!nl || !r.hasNext) return;
          add(nl.id + (r.converted ? 'c' : 'l'), s, x, { leave: r.leave });
        });
        if (det.bestRun > bestRun && det.bestRun >= 6) { bestRun = det.bestRun; add('mrun', s, x, { value: det.bestRun }); }
        x.clean = det.marks.every(function (m) { return m !== 'O'; });
      }
      /* pins over average: game */
      if (av && av.avg != null) cfg.poaGame.forEach(function (n) { if (sc - av.avg >= n) add('pg', s, x, { value: sc, step: n, over: sc - av.avg, avgUsed: av.avg, avgRule: av.rule }); });
      /* capped game brackets */
      cfg.brackets.forEach(function (br) {
        if (br.kind !== 'game' || sc < br.lo || sc > br.hi) return;
        if (!av || av.avg == null) add(br.id, s, x, { value: sc, pending: true });
        else if (av.avg <= br.maxAvg) add(br.id, s, x, { value: sc, avgUsed: av.avg, avgRule: av.rule });
      });
      /* personal milestones (standard games, any level) */
      if (sc > hiGame) { if (hiGame) add('mhg', s, x, { value: sc, previous: hiGame }); hiGame = sc; }
      if (sc >= 250 && !had250) { had250 = true; add('m250', s, x, { value: sc }); }
      if (sc >= 275 && !had275) { had275 = true; add('m275', s, x, { value: sc }); }
    });
    if (!s.first3 || s.first3.some(function (x) { return x.g.NoTap; })) return;
    var tot = s.first3.reduce(function (t, x) { return t + x.score; }, 0);
    if (tot === 900) add('h900', s, null, { value: tot });
    else if (tot >= 800) add('h800', s, null, { value: tot });
    else if (tot >= 700) add('h700', s, null, { value: tot });
    if (s.first3.every(function (x) { return x.clean === true; })) add('hcleans', s, null, { value: tot });
    var sc0 = s.first3[0].score;
    if (sc0 && s.first3.every(function (x) { return x.score === sc0; })) add('htrip', s, null, { value: sc0 });
    if (av && av.avg != null) cfg.poaSeries.forEach(function (n) { if (tot - 3 * av.avg >= n) add('ps', s, null, { value: tot, step: n, over: tot - 3 * av.avg, avgUsed: av.avg, avgRule: av.rule }); });
    cfg.brackets.forEach(function (br) {
      if (br.kind !== 'series' || tot < br.lo || tot > br.hi) return;
      if (!av || av.avg == null) add(br.id, s, null, { value: tot, pending: true });
      else if (av.avg <= br.maxAvg) add(br.id, s, null, { value: tot, avgUsed: av.avg, avgRule: av.rule });
    });
    if (tot > hiSeries) { if (hiSeries) add('mhs', s, null, { value: tot, previous: hiSeries }); hiSeries = tot; }
  });
  /* the bowler's average now: the most recent league with 21+ games (for "locked" explanations) */
  var cur = null;
  Object.keys(leagueRun).forEach(function (lid) { var r = leagueRun[lid]; if (r.n >= minG && (!cur || r.lastDate > cur.lastDate)) cur = { avg: floorAvg(r.sum, r.n), lastDate: r.lastDate, league: L[lid] ? L[lid].LeagueName : '' }; });
  return { version: AWD_VERSION, occurrences: out, currentAvg: cur, scanned: { games: games.length, series: seriesList.length,
    withFrames: games.filter(function (x) { return framesByGame[x.g.GameID] && framesByGame[x.g.GameID].length === 10; }).length } };
}


/* ---------------- v30.226 AWD-1 step 3: trophy case + award detail (page only) ----------------
   Drawn in the app's modal sheet. Uses the app's db, openModal / swapModal / closeModal, navTo, G.
   Seen markers: localStorage bowlingdb_awards_seen = { awardId: count seen }. */
var SEEN_KEY = 'bowlingdb_awards_seen';
var LEVELS = {
  certified:    { label: 'USBC-certified',   short: 'Certified',  color: 'var(--gold)' },
  noncertified: { label: 'Not certified',    short: 'League',     color: 'var(--teal)' },
  unmarked:     { label: 'Not marked',       short: 'Not marked', color: 'var(--t3)' },
  open:         { label: 'Open / practice',  short: 'Open',       color: 'var(--lilac, #b18cfe)' },
  notap:        { label: 'No-Tap',           short: 'No-Tap',     color: 'var(--gold)' }
};
var FILTERS = [['all', 'All'], ['league', 'League'], ['tournament', 'Tournament'], ['open', 'Open'], ['notap', 'No-Tap']];
var SECTIONS = [
  { cls: 'honor',  title: 'Honor scores',             note: 'Any average.' },
  { cls: 'poa',    title: 'Pins over average',        note: 'Against your average going into that session.' },
  { cls: 'capped', title: 'Achievements',             note: 'Average-capped, USBC national brackets.' },
  { cls: 'split',  title: 'Split conversions',        note: 'Unlocked by picking the split up. Locked ones show how many chances you have had.' },
  { cls: 'mile',   title: 'Personal milestones',      note: 'Against your own history; not USBC awards.' }
];
var ICON = { honor: '\ud83c\udfc6', poa: '\ud83d\udcc8', capped: '\ud83c\udf96\ufe0f', split: '\ud83c\udfaf', mile: '\u2b50' };
var ui = { filter: 'all', certOnly: false, res: null };
/* the app's db and G are top-level const/let in index.html: global, but not window properties */
function DB() { try { return typeof db !== 'undefined' ? db : (root.db || {}); } catch (e) { return root.db || {}; } }
function GS() { try { return typeof G !== 'undefined' ? G : root.G; } catch (e) { return root.G; } }

function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmtDate(d) { if (!d) return ''; var p = d.split('-'); return +p[1] + '/' + +p[2] + '/' + p[0].slice(2); }
function seen() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch (e) { return {}; } }
function markSeen(id, n) { try { var s = seen(); s[id] = n; localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch (e) {} }
function passFilter(o) {
  if (ui.certOnly && o.level !== 'certified') return false;
  return ui.filter === 'all' || o.kind === ui.filter;
}
function scanNow() {
  var d = DB();
  var ea = {};
  try { (d.leagues || []).forEach(function (l) { var c = typeof root.hdcpGet === 'function' ? root.hdcpGet(root.hdcpLeagueKey(l.LeagueID)) : null; if (c && c.entryAvg != null) ea[l.LeagueID] = c.entryAvg; }); } catch (e) {}
  ui.res = awardsScan({ games: d.games, series: d.series, frames: d.frames, attempts: d.attempts, leagues: d.leagues,
    tournaments: d.tournaments, leaves: d.leaves, entryAvg: ea }, cfgNow());
  return ui.res;
}
function cfgNow() {
  try { var c = JSON.parse(localStorage.getItem('bowlingdb_awards_cfg') || 'null'); if (c && c.brackets) return Object.assign({}, DEFAULT_CFG, c); } catch (e) {}
  return DEFAULT_CFG;
}
function groupOcc(list) {
  var by = {};
  list.forEach(function (o) { (by[o.award] = by[o.award] || []).push(o); });
  return by;
}
function unmarkedLists() {
  var d = DB(), used = {};
  (d.games || []).forEach(function (g) { if (g.LeagueID != null) used['L' + g.LeagueID] = 1; });
  (d.series || []).forEach(function (s) { if (s.TournamentID != null) used['T' + s.TournamentID] = 1; });
  var out = [];
  (d.leagues || []).forEach(function (l) { if (l.Sanctioned == null && used['L' + l.LeagueID] && !l.IsTeamBowl) out.push({ type: 'L', id: l.LeagueID, name: l.LeagueName }); });
  (d.tournaments || []).forEach(function (t) { if (t.Sanctioned == null && used['T' + t.TournamentID]) out.push({ type: 'T', id: t.TournamentID, name: t.TournamentName }); });
  return out;
}

function chip(label, on, js, color) {
  return '<button onclick="' + js + '" style="padding:6px 12px;border-radius:16px;font-size:13px;font-weight:600;border:1px solid ' + (on ? color : 'var(--border1, #2a3340)') + ';background:' + (on ? 'rgba(0,217,217,0.14)' : 'transparent') + ';color:' + (on ? color : 'var(--t2)') + '">' + label + '</button>';
}
function levelLine(occ) {
  var n = {}; occ.forEach(function (o) { n[o.level] = (n[o.level] || 0) + 1; });
  return ['certified', 'noncertified', 'unmarked', 'open', 'notap'].filter(function (l) { return n[l]; }).map(function (l) {
    return '<span style="font-size:10px;font-weight:700;color:' + LEVELS[l].color + ';white-space:nowrap">\u25cf ' + LEVELS[l].short + ' ' + n[l] + '</span>';
  }).join(' ');
}
function tileHtml(o) {
  return '<div onclick="' + o.js + '" style="position:relative;padding:10px;border-radius:12px;background:var(--bg2, #161b22);border:1px ' + (o.locked ? 'dashed' : 'solid') + ' var(--border1, #2a3340);cursor:pointer;min-width:0;' + (o.locked ? 'opacity:.62' : '') + '">' +
    (o.isNew ? '<span style="position:absolute;top:6px;right:8px;font-size:10px;font-weight:800;color:var(--gold)">NEW</span>' : '') +
    '<div style="font-size:22px">' + o.icon + '</div>' +
    '<div style="font-size:13px;font-weight:700;margin-top:4px;line-height:1.25;padding-right:18px">' + esc(o.title) + '</div>' +
    '<div style="font-size:12px;color:var(--t2);margin-top:4px;line-height:1.35">' + o.sub + '</div>' +
    (o.levels ? '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' + o.levels + '</div>' : '') + '</div>';
}
var GRID = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">';
function sectionHead(sec) {
  return '<div style="margin:16px 0 4px;font-size:13px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--t2)">' + ICON[sec.cls] + ' ' + sec.title + '</div>' +
    '<div style="font-size:11px;color:var(--t3);margin-bottom:8px">' + sec.note + '</div>';
}
function countLine(occ) {
  var first = occ[0], last = occ[occ.length - 1];
  return '<b>' + occ.length + '\u00d7</b> \u00b7 first ' + fmtDate(first.date) + (occ.length > 1 ? '<br>latest ' + fmtDate(last.date) : '');
}
var LOCK = '\ud83d\udd12';
function caseHtml() {
  var res = ui.res, sn = seen();
  var list = res.occurrences.filter(passFilter);
  var real = list.filter(function (o) { return !o.pending; });
  var by = groupOcc(real), pending = list.filter(function (o) { return o.pending; });
  var allCount = function (k) { return res.occurrences.filter(function (o) { return o.award === k && !o.pending; }).length; };
  var isNew = function (k) { var n = allCount(k); return n > 0 && (sn[k] || 0) < n; };
  var h = '<div class="modal-title">\ud83c\udfc6 Trophy case</div>';
  h += '<div style="font-size:12px;color:var(--t3);margin:-4px 0 10px">Personal awards from your own games. Official USBC awards need USBC-certified competition and an application at bowl.com.</div>';
  h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">' + FILTERS.map(function (f) { return chip(f[1], ui.filter === f[0], "awFilter('" + f[0] + "')", 'var(--teal)'); }).join('') + '</div>';
  h += '<div style="margin-bottom:12px">' + chip((ui.certOnly ? '\u2713 ' : '') + 'USBC-certified only', ui.certOnly, 'awCert()', 'var(--gold)') + '</div>';
  var um = unmarkedLists();
  if (um.length) h += '<div class="card" style="font-size:12px;margin-bottom:12px;cursor:pointer" onclick="awMarkList()"><b>' + um.length + ' league' + (um.length === 1 ? '' : 's') + ' or tournament' + (um.length === 1 ? '' : 's') + ' not marked</b> as certified or not. <span style="color:var(--teal)">Mark \u203a</span></div>';
  SECTIONS.forEach(function (sec) {
    if (sec.cls === 'split') {
      h += sectionHead(sec) + GRID;
      Object.keys(NAMED_LEAVES).forEach(function (lv) {
        var L = NAMED_LEAVES[lv], conv = by[L.id + 'c'] || [], left = by[L.id + 'l'] || [];
        var chances = conv.length + left.length;
        if (conv.length) h += tileHtml({ js: "awDetail('" + L.id + "c')", icon: ICON.split, title: L.name, isNew: isNew(L.id + 'c'),
          sub: '<b>Converted ' + conv.length + '\u00d7</b> of ' + chances + ' chance' + (chances === 1 ? '' : 's') + '<br>first ' + fmtDate(conv[0].date), levels: levelLine(conv) });
        else h += tileHtml({ js: "awDetail('" + L.id + "c')", icon: LOCK, title: L.name, locked: true,
          sub: chances ? 'Not converted yet<br>left ' + chances + '\u00d7 \u00b7 latest ' + fmtDate(left[left.length - 1].date) : 'Not left yet' });
      });
      h += '</div>';
      return;
    }
    if (sec.cls === 'capped') {
      h += sectionHead(sec) + GRID;
      var cur = res.currentAvg;
      cfgNow().brackets.forEach(function (br) {
        var occ = by[br.id] || [];
        if (occ.length) h += tileHtml({ js: "awDetail('" + br.id + "')", icon: ICON.capped, title: br.name, isNew: isNew(br.id), sub: countLine(occ) + '<br><span style="color:var(--t3)">avg ' + br.maxAvg + ' or below</span>', levels: levelLine(occ) });
        else h += tileHtml({ js: "awDetail('" + br.id + "')", icon: LOCK, title: br.name, locked: true,
          sub: br.lo + '\u2013' + br.hi + ' at an average of ' + br.maxAvg + ' or below' + (cur && cur.avg > br.maxAvg ? '<br><span style="color:var(--t3)">yours is ' + cur.avg + '</span>' : '') });
      });
      h += '</div>';
      if (pending.length) h += '<div onclick="awPending()" style="margin-top:8px;font-size:12px;color:var(--t2);cursor:pointer;line-height:1.45">\u23f3 <b>' + pending.length + ' score' + (pending.length === 1 ? '' : 's') + ' can\u2019t be checked</b>: bowled before the app had 21 of your league games, so there is no average to compare with the cap. <span style="color:var(--teal)">See which \u203a</span></div>';
      return;
    }
    var ids = Object.keys(by).filter(function (k) { return AWARDS[k].cls === sec.cls; });
    if (!ids.length) return;
    ids.sort(function (a, b) { return by[a][0].date < by[b][0].date ? -1 : 1; });
    h += sectionHead(sec) + GRID;
    ids.forEach(function (k) {
      var occ = by[k], a = AWARDS[k], last = occ[occ.length - 1];
      var title = k === 'pg' ? 'Game over average' : k === 'ps' ? 'Series over average' : a.name;
      var sub = (k === 'mrun' || k === 'mhg' || k === 'mhs') ? '<b>' + occ.length + '\u00d7</b> \u00b7 now ' + last.value + (k === 'mrun' ? ' in a row' : '') + '<br>since ' + fmtDate(last.date) : countLine(occ);
      h += tileHtml({ js: "awDetail('" + k + "')", icon: ICON[a.cls], title: title, isNew: isNew(k), sub: sub, levels: levelLine(occ) });
    });
    h += '</div>';
  });
  var earned = {}; real.forEach(function (o) { earned[o.award] = 1; });
  var notYet = Object.keys(AWARDS).filter(function (k) { return AWARDS[k].cls === 'honor' && !earned[k]; });
  if (notYet.length) h += '<details style="margin-top:16px"><summary style="font-size:13px;color:var(--t2);cursor:pointer">Honor scores not yet earned' + (ui.filter !== 'all' || ui.certOnly ? ' here' : '') + ' (' + notYet.length + ')</summary><div style="font-size:12px;color:var(--t3);line-height:1.7;margin-top:6px">' +
    notYet.map(function (k) { return esc(AWARDS[k].name); }).join(' \u00b7 ') + '</div></details>';
  h += '<div style="font-size:11px;color:var(--t3);margin-top:14px">Counts are every time it happened in the games the filter shows. Checked ' + res.scanned.games.toLocaleString() + ' games (' + res.scanned.withFrames.toLocaleString() + ' with frames; score-only games count for score awards only).</div>';
  h += '<button class="btn btn-secondary" style="margin-top:12px" onclick="closeModal()">Close</button>';
  return h;
}
function lineFor(o) {
  var d = DB(), g = o.gameID != null ? (d.games || []).find(function (x) { return x.GameID === o.gameID; }) : null;
  var s = (d.series || []).find(function (x) { return x.SeriesID === o.seriesID; });
  var lg = s && s.LeagueID != null ? (d.leagues || []).find(function (l) { return l.LeagueID === s.LeagueID; }) : null;
  var t = s && s.TournamentID != null ? (d.tournaments || []).find(function (x) { return x.TournamentID === s.TournamentID; }) : null;
  var where = t ? t.TournamentName : lg ? lg.LeagueName : 'Open play';
  var what = o.value != null ? (o.award === 'mrun' ? o.value + ' strikes' : String(o.value)) : '';
  if (g && g.GameNumber && o.gameID != null && o.award !== 'mrun') what += (what ? ' \u00b7 ' : '') + 'G' + g.GameNumber;
  if (o.over != null) what += ' \u00b7 +' + o.over;
  if (o.previous != null) what += ' (was ' + o.previous + ')';
  return { where: where, what: what };
}
function detailHtml(id) {
  var a = AWARDS[id], res = ui.res;
  var occ = res.occurrences.filter(function (o) { return o.award === id && !o.pending && passFilter(o); }).slice().reverse();
  var isSplit = !!a.leave, isBracket = a.cls === 'capped';
  var left = isSplit ? res.occurrences.filter(function (o) { return o.award === id.slice(0, -1) + 'l' && passFilter(o); }).slice().reverse() : [];
  var title = isSplit ? NAMED_LEAVES[a.leave].name : a.name;
  var lockIcon = '\ud83d\udd12 ';
  var h = '<div class="modal-title">' + (isSplit ? (occ.length ? ICON.split + ' ' : lockIcon) : (isBracket && !occ.length ? lockIcon : ICON[a.cls] + ' ')) + esc(title) + '</div>';
  h += '<div style="font-size:13px;color:var(--t2);line-height:1.5;margin-bottom:12px">' + esc(a.desc) + (a.app ? '' : '') + '</div>';
  if (occ.length) {
    var first = occ[occ.length - 1];
    h += '<div class="card" style="font-size:13px;margin-bottom:10px"><b>' + (occ.length === 1 ? 'Earned ' : 'First earned ') + fmtDate(first.date) + '</b>' + (occ.length > 1 ? ' \u00b7 ' + occ.length + ' times' : '') +
      (first.avgUsed != null ? '<br><span style="color:var(--t3);font-size:12px">Average used: ' + first.avgUsed + ' (' + esc(first.avgRule) + ')</span>' : '') + '</div>';
  }
  h += occ.map(function (o) {
    var ln = lineFor(o), L = LEVELS[o.level];
    return '<div onclick="awOpenSeries(' + o.seriesID + ')" style="display:flex;align-items:center;gap:10px;padding:10px 4px;border-bottom:1px solid var(--border1, #2a3340);cursor:pointer">' +
      '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600">' + fmtDate(o.date) + (ln.what ? ' \u00b7 ' + esc(ln.what) : '') + '</div>' +
      '<div style="font-size:12px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(ln.where) + (o.avgUsed != null ? ' \u00b7 avg ' + o.avgUsed : '') + '</div></div>' +
      '<span style="font-size:11px;font-weight:700;color:' + L.color + ';white-space:nowrap">' + L.short + '</span><span style="color:var(--t3)">\u203a</span></div>';
  }).join('');
  if (!occ.length) h += '<div class="card" style="font-size:13px">' + (isSplit ? 'Not converted yet' + (ui.filter !== 'all' || ui.certOnly ? ' in this filter' : '') + '.' : isBracket ? lockedWhy(id) : 'None for this filter.') + '</div>';
  if (isSplit) {
    h += '<div style="margin:16px 0 4px;font-size:12px;font-weight:800;color:var(--t2);text-transform:uppercase;letter-spacing:.04em">Left ' + left.length + '\u00d7 (chances)</div>';
    h += left.length ? left.map(function (o) { var ln = lineFor(o); return '<div onclick="awOpenSeries(' + o.seriesID + ')" style="display:flex;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border1, #2a3340);cursor:pointer"><div style="flex:1;min-width:0"><div style="font-size:13px">' + fmtDate(o.date) + (ln.what ? ' \u00b7 ' + esc(ln.what) : '') + '</div><div style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(ln.where) + '</div></div><span style="font-size:11px;font-weight:700;color:' + LEVELS[o.level].color + '">' + LEVELS[o.level].short + '</span></div>'; }).join('')
      : '<div style="font-size:12px;color:var(--t3)">You have never left it.</div>';
  }
  h += '<button class="btn btn-secondary" style="margin-top:14px" onclick="awBack()">\u2039 Trophy case</button>';
  return h;
}
function lockedWhy(id) {
  var br = cfgNow().brackets.filter(function (b) { return b.id === id; })[0], cur = ui.res.currentAvg;
  if (!br) return 'Not earned yet.';
  return 'A ' + br.lo + '\u2013' + br.hi + ' ' + br.kind + ' earns this when your average going into that session is ' + br.maxAvg + ' or below.' + (cur ? ' Your current average is ' + cur.avg + ' (' + esc(cur.league) + ').' : '');
}
function pendingHtml() {
  var occ = ui.res.occurrences.filter(function (o) { return o.pending && passFilter(o); });
  var h = '<div class="modal-title">\u23f3 Scores that can\u2019t be checked</div><div style="font-size:13px;color:var(--t2);line-height:1.5;margin-bottom:12px">Average-capped awards need your average at the time. A league average counts once you have 21 games in it; before that, last season\u2019s. These scores are from your first weeks in the app, when neither existed, so the app can\u2019t tell whether you were under the cap.<br><br>If you know your average back then, enter it as the <b>entering average</b> in that league\u2019s Handicap setup, and these are decided either way. Otherwise they stay unchecked; nothing is lost.</div>';
  h += occ.map(function (o) {
    var ln = lineFor(o);
    return '<div onclick="awOpenSeries(' + o.seriesID + ')" style="padding:10px 4px;border-bottom:1px solid var(--border1, #2a3340);cursor:pointer"><div style="font-size:14px;font-weight:600">' + esc(AWARDS[o.award].name) + ' \u00b7 ' + o.value + '</div><div style="font-size:12px;color:var(--t3)">' + fmtDate(o.date) + ' \u00b7 ' + esc(ln.where) + '</div></div>';
  }).join('');
  h += '<button class="btn btn-secondary" style="margin-top:14px" onclick="awBack()">\u2039 Trophy case</button>';
  return h;
}
function markHtml() {
  var um = unmarkedLists();
  var h = '<div class="modal-title">Mark leagues and tournaments</div><div style="font-size:13px;color:var(--t2);margin-bottom:12px">Certified means USBC-certified (sanctioned). It decides which shelf their awards sit on.</div>';
  if (!um.length) h += '<div class="card" style="font-size:13px">Everything is marked.</div>';
  h += um.map(function (x) {
    var b = 'padding:7px 10px;border-radius:10px;font-size:12px;font-weight:700;border:1px solid var(--border1, #2a3340);background:transparent;color:var(--t2)';
    return '<div style="padding:10px 0;border-bottom:1px solid var(--border1, #2a3340)"><div style="font-size:14px;font-weight:600;margin-bottom:6px">' + (x.type === 'T' ? '\ud83c\udfc5 ' : '') + esc(x.name) + '</div>' +
      '<button style="' + b + ';color:var(--gold)" onclick="awMark(\'' + x.type + '\',' + x.id + ',true)">Certified</button> ' +
      '<button style="' + b + '" onclick="awMark(\'' + x.type + '\',' + x.id + ',false)">Not certified</button></div>';
  }).join('');
  h += '<button class="btn btn-secondary" style="margin-top:14px" onclick="awBack()">\u2039 Trophy case</button>';
  return h;
}
function show(html) { (typeof root.swapModal === 'function' ? root.swapModal : root.openModal)(html); var mb = document.getElementById('modal-body'); if (mb && mb.scrollTo) mb.scrollTo(0, 0); }

async function awOpen() {
  try { if (typeof root.loadScoringData === 'function') await root.loadScoringData(); } catch (e) {}
  scanNow();
  root.openModal(caseHtml());
}
function awFilter(f) { ui.filter = f; show(caseHtml()); }
function awCert() { ui.certOnly = !ui.certOnly; show(caseHtml()); }
function awBack() { scanNow(); show(caseHtml()); }
function awDetail(id) {
  markSeen(id, ui.res.occurrences.filter(function (o) { return o.award === id && !o.pending; }).length);
  show(detailHtml(id));
}
function awPending() { show(pendingHtml()); }
function awMarkList() { show(markHtml()); }
function awMark(type, id, val) {
  var d = DB();
  var row = type === 'T' ? (d.tournaments || []).find(function (t) { return t.TournamentID === id; }) : (d.leagues || []).find(function (l) { return l.LeagueID === id; });
  if (!row) return;
  row.Sanctioned = !!val;
  if (typeof root.saveDB === 'function') root.saveDB();
  scanNow();
  show(markHtml());
}
function awOpenSeries(sid) {
  var d = DB(), s = (d.series || []).find(function (x) { return x.SeriesID === sid; });
  var G = GS();
  if (!s || !G || typeof root.navTo !== 'function') { if (root.toast) root.toast('That series is not on this phone'); return; }
  if (typeof root.closeModal === 'function') root.closeModal();
  G.seriesID = sid;
  if (s.TournamentID != null) { G.leagueID = -1; G.tournamentID = s.TournamentID; G.noTap = !!s.NoTap; }
  else if (s.LeagueID != null && s.LeagueID > 0) { G.leagueID = s.LeagueID; G.noTap = !!s.NoTap; }
  else { if (root.toast) root.toast(fmtDate(s.DateBowled) + ': open play; find it in Open Bowl'); return; }
  root.navTo('s-game-select');
}
if (typeof document !== 'undefined') {
  root.awOpen = awOpen; root.awFilter = awFilter; root.awCert = awCert; root.awBack = awBack; root.awDetail = awDetail; root.awPending = awPending;
  root.awMarkList = awMarkList; root.awMark = awMark; root.awOpenSeries = awOpenSeries;
}

var api = { AWD_VERSION: AWD_VERSION, USBC_BRACKETS: USBC_BRACKETS, DEFAULT_CFG: DEFAULT_CFG, AWARDS: AWARDS, NAMED_LEAVES: NAMED_LEAVES,
  awardsScan: awardsScan, levelOf: levelOf, levelKey: levelKey };
root.BDB_AWARDS = api;
root.AWARDS_JS_VERSION = AWD_VERSION;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
