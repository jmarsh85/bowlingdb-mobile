/* BowlingDB share cards -- SHR-1 (design: DESIGN_share_card.md, 2026-10-25).
   v30.236 slice 1: series card. v30.237 slice 2: game card (scorecard strip) + optional detail
   (strikes, spares, splits, balls with pictures) on Story cards.
   A picture of the bowler's own play, made on the phone and handed to the iOS share sheet.
   No account, no server, works offline. Parts:
     seriesFacts / gameFacts (data, id, ctx) -- pure: everything the card says ("card facts").
                                                The same record becomes the published post later.
     drawShareCard(facts, opts, colors, canvas, imgs) -- canvas drawing in the app's theme colours.
   Loaded by index.html as share.js?v=APP_VERSION on first use; require()-able for the Node harness. */
(function (root) {
'use strict';
var SHARE_VERSION = 'v30.237';
var PREFS_KEY = 'bowlingdb_share_prefs';
var DEFAULT_PREFS = { size: 'post', name: true, center: true, league: true, avg: true, hdcp: true, detail: true };
var SIZES = { post: { w: 1080, h: 1350, label: 'Post 4:5' }, story: { w: 1080, h: 1920, label: 'Story 9:16' } };
var MIN_LEAGUE_GAMES = 9;      // league average going in: this many games in the league before the night
var EST_GAMES = 21;            // established average: the last 21 league games before the night
var MAX_BALLS = 4;             // balls shown on the detail row

function floorAvg(sum, n) { return n ? Math.floor(sum / n) : null; }
function byDate(a, b) { return (a || '').localeCompare(b || ''); }
function pf(a) { return a && a.Pinfall != null ? a.Pinfall : null; }

/* ---------------- indexes (built once per data object) ---------------- */
var IDX = typeof WeakMap === 'function' ? new WeakMap() : null;
function idx(data) {
  var key = data.attempts || data;
  var hit = IDX && IDX.get(key);
  if (hit && hit.frames === data.frames) return hit;
  var x = { frames: data.frames, fByGame: {}, aByFrame: {}, leaf: {}, ball: {} };
  (data.frames || []).forEach(function (f) { (x.fByGame[f.GameID] = x.fByGame[f.GameID] || []).push(f); });
  (data.attempts || []).forEach(function (a) { (x.aByFrame[a.FrameID] = x.aByFrame[a.FrameID] || []).push(a); });
  (data.leaves || []).forEach(function (l) { x.leaf[l.LeaveID] = l; });
  (data.balls || []).forEach(function (b) { x.ball[b.BallID] = b; });
  if (IDX) IDX.set(key, x);
  return x;
}
/* the 10th frame's ball roles (same rules as the app's f10BallRoles) */
function f10Roles(a1, a2, a3, noTap) {
  if (typeof root.f10BallRoles === 'function') return root.f10BallRoles(a1, a2, a3, noTap);
  var out = [], X = function (v) { return v === 10 || (!!noTap && v === 9); };
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

/* One game read from frames + attempts: marks per frame for the strip, and the counts for the detail.
   null when the game has no complete frame data (score-only games). */
function readGame(data, g) {
  var x = idx(data), fr = (x.fByGame[g.GameID] || []).slice().sort(function (a, b) { return a.FrameNumber - b.FrameNumber; });
  if (fr.length !== 10) return null;
  var nt = !!g.NoTap, X = function (v) { return v === 10 || (nt && v === 9); };
  var sym = function (v) { return v === 0 ? '-' : String(v); };
  var isSplit = function (a) { var l = a && a.LeaveID != null ? x.leaf[a.LeaveID] : null; return l ? !!l.IsSplit : null; };
  var rolls = [], fStart = [];                    // pin values for scoring (a No-Tap strike counts 10)
  var out = { frames: [], strikes: 0, strikeOpps: 0, spares: 0, spareOpps: 0, splits: 0, splitsMade: 0, leavesKnown: false, leavesMissing: 0, balls: {} };
  for (var i = 0; i < 10; i++) {
    var f = fr[i];
    if (f.FrameNumber !== i + 1) return null;
    var at = (x.aByFrame[f.FrameID] || []).filter(function (a) { return a.Pinfall != null; }).sort(function (a, b) { return a.Attempt - b.Attempt; });
    var a1 = at[0], a2 = at[1], a3 = at[2];
    if (!a1) return null;
    at.forEach(function (a) { if (a.BallID != null) out.balls[a.BallID] = (out.balls[a.BallID] || 0) + 1; });
    var marks = [], circ = [];
    var rack = function (fresh, next) {            // a non-strike fresh rack: spare chance, maybe a split
      var sp = isSplit(fresh);
      if (sp == null) out.leavesMissing++; else out.leavesKnown = true;
      if (!next) return;
      var made = pf(fresh) + pf(next) >= 10;
      out.spareOpps++; if (made) out.spares++;
      if (sp) { out.splits++; if (made) out.splitsMade++; }
    };
    fStart.push(rolls.length);
    if (i < 9) {
      rolls.push(X(a1.Pinfall) ? 10 : a1.Pinfall); if (!X(a1.Pinfall) && a2) rolls.push(a1.Pinfall + a2.Pinfall >= 10 ? 10 - a1.Pinfall : a2.Pinfall);
      out.strikeOpps++;
      if (X(a1.Pinfall)) { out.strikes++; marks = ['', 'X']; circ = [false, false]; }
      else {
        if (!a2) return null;
        rack(a1, a2);
        marks = [sym(a1.Pinfall), a1.Pinfall + a2.Pinfall >= 10 ? '/' : sym(a2.Pinfall)];
        circ = [!!isSplit(a1), false];
      }
    } else {
      var roles = f10Roles(a1, a2, a3, nt);
      roles.forEach(function (r) { rolls.push(r.strike ? 10 : pf(r.att)); });
      roles.forEach(function (r, k) {
        if (r.role === 'fresh' || r.role === 'fill') { out.strikeOpps++; if (r.strike) out.strikes++; }
        if (r.role === 'fresh' && !r.strike) { var nx = roles[k + 1]; rack(r.att, nx && nx.role === 'spare' ? nx.att : null); }
        var p = pf(r.att), m;
        if (r.strike) m = 'X';
        else if (r.role === 'spare') m = pf(r.leaveAtt) + p >= 10 ? '/' : sym(p);
        else m = sym(p);
        marks.push(m); circ.push(r.role === 'fresh' && !r.strike && !!isSplit(r.att));
      });
    }
    var tot = nt ? (f.NoTapCumulativeScore != null ? f.NoTapCumulativeScore : f.CumulativeScore) : (f.CumulativeScore != null ? f.CumulativeScore : f.RunningTotal);
    out.frames.push({ marks: marks, circled: circ, total: tot != null ? tot : null, mark: marks.indexOf('X') >= 0 && i < 9 ? 'X' : marks.indexOf('/') >= 0 ? 'S' : (i === 9 && marks[0] === 'X') ? 'X' : 'O' });
  }
  /* running totals from the pins (stored frame totals can be stale after a repair); stored ones if the pins don't add up */
  var run = 0, calc = [];
  for (var j = 0; j < 10; j++) {
    var st0 = fStart[j], r0 = rolls[st0], r1 = rolls[st0 + 1], r2 = rolls[st0 + 2];
    if (j === 9) run += rolls.slice(st0).reduce(function (a, b) { return a + b; }, 0);
    else if (r0 === 10) run += 10 + (r1 || 0) + (r2 || 0);
    else if (r0 + r1 === 10) run += 10 + (r2 || 0);
    else run += r0 + (r1 || 0);
    calc.push(run);
  }
  out.totalsFrom = 'pins';
  if (run === g.FinalScore) out.frames.forEach(function (fz, k) { fz.total = calc[k]; });
  else if (out.frames[9].total !== g.FinalScore) { out.totalsFrom = 'none'; out.frames.forEach(function (fz) { fz.total = null; }); }
  else out.totalsFrom = 'stored';
  out.clean = out.frames.every(function (fz, i) { return i < 9 ? fz.mark !== 'O' : (fz.marks[0] === 'X' || fz.marks[1] === '/'); });
  return out;
}
/* detail for a set of games (series or one game); null when none has frame data */
function detailFor(data, games) {
  var x = idx(data), d = { games: games.length, withFrames: 0, strikes: 0, strikeOpps: 0, spares: 0, spareOpps: 0, splits: 0, splitsMade: 0, leavesKnown: false, leavesMissing: 0, balls: [] };
  var bc = {};
  games.forEach(function (g) {
    var r = readGame(data, g);
    if (!r) return;
    d.withFrames++;
    ['strikes', 'strikeOpps', 'spares', 'spareOpps', 'splits', 'splitsMade'].forEach(function (k) { d[k] += r[k]; });
    if (r.leavesKnown) d.leavesKnown = true; d.leavesMissing += r.leavesMissing;
    Object.keys(r.balls).forEach(function (b) { bc[b] = (bc[b] || 0) + r.balls[b]; });
  });
  if (!d.withFrames) return null;
  d.balls = Object.keys(bc).map(function (b) { var ball = x.ball[b]; return { id: +b, count: bc[b], name: ball ? ball.BallName || '' : '' }; })
    .sort(function (a, b) { return b.count - a.count; });
  return d;
}

/* ---------------- shared context for a series ---------------- */
function seriesContext(data, id, ctx) {
  var open = (data.openSessions || []).filter(function (x) { return x.SessionID === id; })[0] || null;
  var s = open || (data.series || []).filter(function (x) { return x.SeriesID === id; })[0];
  if (!s) return null;
  var L = {}; (data.leagues || []).forEach(function (l) { L[l.LeagueID] = l; });
  var T = {}; (data.tournaments || []).forEach(function (t) { T[t.TournamentID] = t; });
  var lg = open ? null : L[s.LeagueID] || null;
  var tn = !open && s.TournamentID != null ? T[s.TournamentID] || null : null;
  if ((lg && lg.BakerFormat) || (tn && tn.BakerFormat)) return null;          // Baker: no cards yet
  var all = (data.games || []).filter(function (g) { return g.SeriesID === id && !g.IsTeammate && g.FinalScore != null && g.FinalScore > 0; });
  if (!all.length) return null;
  var ntWhole = !!(s.NoTap || (tn ? tn.NoTap : (!open && s.LeagueID === -1)));   // LeagueID -1 = NoTap Games list, unless it is a tournament's series
  var noTap = ntWhole || all.every(function (g) { return g.NoTap; });
  var games = all.filter(function (g) { return ntWhole || !!g.NoTap === noTap; })
    .sort(function (a, b) { return (a.GameNumber || 0) - (b.GameNumber || 0); });
  if (!games.length) return null;
  var level = open ? 'open' : noTap ? 'notap' : tn ? 'tournament' : (lg && lg.LeagueID > 0) ? 'league' : 'open';
  var certified = level === 'league' ? lg.Sanctioned === true : level === 'tournament' ? tn.Sanctioned === true : false;
  var centerID = s.CenterID != null ? s.CenterID : tn ? tn.CenterID : lg ? lg.CenterID : null;
  var center = (data.centers || []).filter(function (c) { return c.CenterID === centerID; })[0];
  var me = (data.bowlers || []).filter(function (b) { return b.IsMe; })[0];
  /* average going in (never including this night); none for No-Tap */
  var avgIn = null, avgWhy = null, date = s.DateBowled || '';
  if (!noTap) {
    var S = {}; (data.series || []).forEach(function (x) { S[x.SeriesID] = x; });
    var openIDs = {}; (data.openSessions || []).forEach(function (x) { openIDs[x.SessionID] = true; });
    var before = (data.games || []).filter(function (g) {
      var gs = S[g.SeriesID];
      return gs && !openIDs[g.SeriesID] && gs.SeriesID !== id && byDate(gs.DateBowled, date) < 0 &&
        gs.LeagueID > 0 && gs.TournamentID == null && !gs.NoTap && !g.NoTap && !g.IsTeammate && g.FinalScore > 0 &&
        !(L[gs.LeagueID] && L[gs.LeagueID].BakerFormat);
    });
    if (level === 'league') {
      var mine = before.filter(function (g) { return S[g.SeriesID].LeagueID === s.LeagueID; });
      if (mine.length >= MIN_LEAGUE_GAMES) { avgIn = floorAvg(mine.reduce(function (a, g) { return a + g.FinalScore; }, 0), mine.length); avgWhy = 'league'; }
      else if (ctx.entryAvg && ctx.entryAvg[s.LeagueID] != null) { avgIn = ctx.entryAvg[s.LeagueID]; avgWhy = 'entering'; }
    }
    if (avgIn == null) {
      var last = before.slice().sort(function (a, b) { return byDate(S[a.SeriesID].DateBowled, S[b.SeriesID].DateBowled) || (a.GameNumber || 0) - (b.GameNumber || 0); }).slice(-EST_GAMES);
      if (last.length >= MIN_LEAGUE_GAMES) { avgIn = floorAvg(last.reduce(function (a, g) { return a + g.FinalScore; }, 0), last.length); avgWhy = 'established'; }
    }
  }
  /* handicap: only where the league defines it */
  var hdcpGame = null;
  if (level === 'league' && lg.Handicap !== false && typeof ctx.hdcpFor === 'function') {
    try { hdcpGame = ctx.hdcpFor(s.LeagueID, id); } catch (e) { hdcpGame = null; }
  }
  return {
    s: s, games: games, seriesID: id, date: date, level: level, certified: certified, noTap: noTap, avgIn: avgIn, avgWhy: avgWhy, hdcpGame: hdcpGame,
    bowler: (me && me.Name) || ctx.profileName || null,
    league: level === 'tournament' ? tn.TournamentName : level === 'league' ? lg.LeagueName : level === 'notap' ? (tn ? tn.TournamentName : lg && lg.LeagueID > 0 ? lg.LeagueName : null) : null,
    center: center ? center.CenterName : null
  };
}
function base(c, kind) {
  return { kind: kind, v: 1, seriesID: c.seriesID, date: c.date, level: c.level, certified: c.certified, noTap: c.noTap,
    avgIn: c.avgIn, avgWhy: c.avgWhy, hdcpGame: c.hdcpGame, bowler: c.bowler, league: c.league, center: c.center };
}

/* ---------------- facts (pure) ----------------
   data: { series, games, frames, attempts, leaves, balls, leagues, tournaments, centers, bowlers, openSessions }
   ctx:  { hdcpFor(leagueID, seriesID) -> per-game handicap | null, entryAvg: {LeagueID: n}, profileName } */
function seriesFacts(data, id, ctx) {
  ctx = ctx || {};
  var c = seriesContext(data, id, ctx);
  if (!c) return null;
  var scores = c.games.map(function (g) { return g.FinalScore; });
  var total = scores.reduce(function (a, b) { return a + b; }, 0);
  var first3 = scores.length >= 3 ? scores[0] + scores[1] + scores[2] : null;
  /* headline pills: never "perfect" wording for No-Tap */
  var pills = [], hi = Math.max.apply(null, scores);
  if (c.noTap) {
    pills.push({ text: hi === 300 ? 'NO-TAP 300' : 'NO-TAP', tone: 'notap' });
  } else {
    if (scores.indexOf(300) >= 0) pills.push({ text: scores.filter(function (x) { return x === 300; }).length > 1 ? 'TWO 300 GAMES' : '300 GAME', tone: 'gold' });
    if (first3 != null && first3 >= 700) pills.push({ text: (first3 === 900 ? '900' : first3 >= 800 ? '800' : '700') + ' SERIES', tone: 'gold' });
    if (!pills.length && hi >= 298) pills.push({ text: hi + ' GAME', tone: 'gold' });
    if (!pills.length && hi >= 279) pills.push({ text: 'GREAT GAME \u00b7 ' + hi, tone: 'gold' });
  }
  var f = base(c, 'series');
  f.scores = scores; f.total = total; f.best = hi; f.gameAvg = floorAvg(total, scores.length); f.pills = pills;
  f.vsAvg = c.avgIn != null ? total - c.avgIn * scores.length : null;
  f.hdcpTotal = c.hdcpGame != null ? total + c.hdcpGame * scores.length : null;
  f.detail = data.frames ? detailFor(data, c.games) : null;
  return f;
}
var shareFacts = seriesFacts;   // v30.236 name

function gameFacts(data, gameID, ctx) {
  ctx = ctx || {};
  var g0 = (data.games || []).filter(function (g) { return g.GameID === gameID; })[0];
  if (!g0) return null;
  var c = seriesContext(data, g0.SeriesID, ctx);
  if (!c) return null;
  var pos = -1; c.games.forEach(function (g, i) { if (g.GameID === gameID) pos = i; });
  if (pos < 0) return null;                                          // e.g. a teammate's game
  var g = c.games[pos], score = g.FinalScore, rd = data.frames ? readGame(data, g) : null;
  var pills = [];
  if (c.noTap) pills.push({ text: score === 300 ? 'NO-TAP 300' : 'NO-TAP', tone: 'notap' });
  else {
    if (score === 300) pills.push({ text: '300 GAME', tone: 'gold' });
    else if (score >= 298) pills.push({ text: score + ' GAME', tone: 'gold' });
    else if (score >= 279) pills.push({ text: 'GREAT GAME', tone: 'gold' });
    if (rd && rd.clean && score !== 300) pills.push({ text: 'CLEAN GAME', tone: pills.length ? 'gold' : 'accent' });
  }
  var f = base(c, 'game');
  f.gameID = gameID; f.gameNumber = pos + 1; f.gamesInSeries = c.games.length; f.score = score;
  f.seriesTotal = c.games.reduce(function (a, x) { return a + x.FinalScore; }, 0);
  f.pills = pills; f.frames = rd ? rd.frames : null; f.clean = rd ? rd.clean : null;
  f.vsAvg = c.avgIn != null ? score - c.avgIn : null;
  f.hdcpTotal = c.hdcpGame != null ? score + c.hdcpGame : null;
  f.detail = data.frames ? detailFor(data, [g]) : null;
  return f;
}

function levelLabel(f) {
  if (f.level === 'notap') return 'NO-TAP';
  if (f.level === 'open') return 'OPEN PLAY';
  if (f.level === 'tournament') return f.certified ? 'USBC-CERTIFIED TOURNAMENT' : 'TOURNAMENT';
  return f.certified ? 'USBC-CERTIFIED LEAGUE' : 'LEAGUE';
}
function longDate(d) {
  if (!d) return '';
  var p = d.split('-'), dt = new Date(+p[0], +p[1] - 1, +p[2]);
  var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return W[dt.getDay()] + ' \u00b7 ' + M[dt.getMonth()] + ' ' + dt.getDate() + ', ' + p[0];
}
/* the detail block is drawn only on Story cards, when the switch is on and data exists */
function detailShown(f, opts) { return !!(f.detail && opts.detail && opts.size === 'story'); }

/* ---------------- drawing ---------------- */
var SANS = '-apple-system, "SF Pro Display", BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
function fitFont(ctx, text, weight, start, maxW, min) {
  var size = start;
  do { ctx.font = weight + ' ' + size + 'px ' + SANS; if (ctx.measureText(text).width <= maxW) break; size -= 2; } while (size > min);
  return size;
}
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
}
function alpha(color, a) {
  var m = /rgba?\(([^)]+)\)/.exec(color);
  if (m) { var p = m[1].split(',').map(function (x) { return x.trim(); }); return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')'; }
  var h = /^#([0-9a-f]{6})$/i.exec(color);
  if (h) { var n = parseInt(h[1], 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }
  return color;
}
function pillW(ctx, text) { ctx.font = '800 30px ' + SANS; return ctx.measureText(text).width + 64; }
function pct(a, b) { return b ? Math.floor(a / b * 100) + '%' : ''; }

/* opts: { size, name, center, league, avg, hdcp, detail }  C: resolved theme colours  imgs: {BallID: image | null} */
function drawShareCard(f, opts, C, canvas, imgs) {
  imgs = imgs || {};
  var sz = SIZES[opts.size] || SIZES.post, W = sz.w, H = sz.h, story = opts.size === 'story';
  var cv = canvas || document.createElement('canvas'); cv.width = W; cv.height = H;
  var ctx = cv.getContext('2d');
  var gold = f.pills.length && f.pills[0].tone === 'gold';
  var accent = gold ? C.gold : f.noTap ? C.notap : C.teal;
  var hiCol = accent === C.gold ? C.gold : f.noTap ? C.notap : C.teal;
  /* background */
  var bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, C.bg2); bg.addColorStop(1, C.bg0);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  var glow = ctx.createRadialGradient(W * 0.85, H * 0.08, 0, W * 0.85, H * 0.08, W * 0.9);
  glow.addColorStop(0, alpha(accent, 0.22)); glow.addColorStop(1, alpha(accent, 0));
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = accent; ctx.fillRect(0, 0, W, 10);
  ctx.textBaseline = 'alphabetic';
  /* header (pinned) */
  var top = story ? 150 : 96;
  ctx.textAlign = 'left'; ctx.fillStyle = C.teal; ctx.font = '800 30px ' + SANS;
  ctx.fillText('B O W L I N G D B', 72, top);
  ctx.textAlign = 'right'; ctx.fillStyle = C.t2; ctx.font = '600 30px ' + SANS; ctx.fillText(longDate(f.date), W - 72, top);

  var game = f.kind === 'game', n = game ? 1 : f.scores.length;
  var showAvg = opts.avg && f.avgIn != null, showH = opts.hdcp && f.hdcpTotal != null, det = detailShown(f, opts);
  var stats = [];
  if (showAvg) { stats.push({ k: 'AVG GOING IN', v: String(f.avgIn), c: C.t1 }); stats.push({ k: 'VS AVERAGE', v: (f.vsAvg > 0 ? '+' : '') + f.vsAvg, c: f.vsAvg > 0 ? C.teal : f.vsAvg < 0 ? C.red : C.t2 }); }
  if (showH) stats.push({ k: 'HANDICAP', v: String(f.hdcpTotal), c: C.gold, sub: game ? '+' + f.hdcpGame : '+' + f.hdcpGame + ' a game' });
  if (!stats.length && !game) stats.push({ k: 'GAME AVERAGE', v: String(f.gameAvg), c: C.t1 });
  var D = story ? { tot: det ? 270 : 300, totF: det ? 220 : 250, games: det ? 180 : 200, gF: 96, strip: 196, stats: det ? 150 : 160, gap: det ? 40 : 64 }
                : { tot: game ? 250 : 270, totF: game ? 210 : 230, games: 180, gF: 88, strip: 176, stats: 150, gap: 32 };
  /* identity + badge, laid out bottom-up so they never overlap */
  var by = H - (story ? 230 : 170);
  var idLines = [];
  if (opts.name && f.bowler) idLines.push({ t: f.bowler, w: '800', s: 64, min: 36, c: C.t1, h: 74 });
  if (opts.league && f.league) idLines.push({ t: f.league, w: '600', s: 36, min: 24, c: C.t2, h: 52 });
  if (opts.center && f.center) idLines.push({ t: '\ud83d\udccd ' + f.center, w: '500', s: 32, min: 22, c: C.t2, h: 48 });
  var idH = idLines.reduce(function (a, l) { return a + l.h; }, 0), idTop = by - 34 - idH;
  var blocks = [];
  if (f.pills.length) blocks.push({ h: 60, draw: drawPills });
  blocks.push({ h: D.tot, draw: drawTotal });
  if (game) { if (f.frames) blocks.push({ h: D.strip, draw: drawStrip }); }
  else blocks.push({ h: D.games, draw: drawGames });
  if (stats.length) blocks.push({ h: D.stats, draw: drawStats });
  if (det) blocks.push({ h: f.detail.balls.length ? 290 : 150, draw: drawDetail });
  var bodyH = blocks.reduce(function (a, b) { return a + b.h; }, 0) + D.gap * (blocks.length - 1);
  var bodyTop = top + 56, bodyBot = idTop - (idLines.length ? 36 : 0);
  var y = bodyTop + Math.max(0, (bodyBot - bodyTop - bodyH) / 2);
  blocks.forEach(function (b) { b.draw(y, b.h); y += b.h + D.gap; });

  function drawPills(y0) {
    var ws = f.pills.map(function (p) { return pillW(ctx, p.text); }), tw = ws.reduce(function (a, b) { return a + b; }, 0) + 20 * (ws.length - 1);
    var x = (W - tw) / 2;
    f.pills.forEach(function (p, i) {
      var col = p.tone === 'notap' ? C.notap : p.tone === 'accent' ? C.teal : C.gold;
      rr(ctx, x, y0, ws[i], 60, 30); ctx.fillStyle = alpha(col, 0.16); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
      ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.font = '800 30px ' + SANS; ctx.fillText(p.text, x + ws[i] / 2, y0 + 41);
      x += ws[i] + 20;
    });
  }
  function drawTotal(y0) {
    ctx.textAlign = 'center';
    ctx.fillStyle = gold ? C.gold : C.t1;
    ctx.font = '900 ' + D.totF + 'px ' + SANS; ctx.fillText(String(game ? f.score : f.total), W / 2, y0 + D.totF * 0.88);
    ctx.fillStyle = C.t2; ctx.font = '700 32px ' + SANS;
    var lab = game ? ((f.noTap ? 'NO-TAP ' : '') + 'GAME ' + f.gameNumber + (f.gamesInSeries > 1 ? ' OF ' + f.gamesInSeries + ' \u00b7 SERIES ' + f.seriesTotal : ''))
                   : (f.noTap ? 'NO-TAP SERIES' : 'SERIES') + ' \u00b7 ' + n + ' GAME' + (n === 1 ? '' : 'S');
    ctx.fillText(lab, W / 2, y0 + D.tot - 14);
  }
  function drawGames(y0, h) {
    var m = 72, g = n > 4 ? 14 : 24, w = (W - 2 * m - g * (n - 1)) / n;
    f.scores.forEach(function (sc, i) {
      var x = m + i * (w + g), best = n > 1 && sc === f.best, g300 = sc === 300 && !f.noTap;
      rr(ctx, x, y0, w, h, 28); ctx.fillStyle = C.bg3; ctx.fill();
      if (best || g300) { ctx.lineWidth = 4; ctx.strokeStyle = g300 ? C.gold : hiCol; ctx.stroke(); }
      ctx.textAlign = 'center'; ctx.fillStyle = C.t2; ctx.font = '700 ' + (n > 4 ? 22 : 26) + 'px ' + SANS;
      ctx.fillText('GAME ' + (i + 1), x + w / 2, y0 + h * 0.25);
      ctx.fillStyle = g300 ? C.gold : best ? hiCol : C.t1;
      fitFont(ctx, String(sc), '900', n > 4 ? Math.round(D.gF * 0.75) : D.gF, w - 24, 40); ctx.fillText(String(sc), x + w / 2, y0 + h * 0.8);
    });
  }
  /* the scorecard strip: frame numbers, ball marks (split balls circled), running totals */
  function drawStrip(y0, h) {
    var m = 40, u = (W - 2 * m) / 10.6, numH = 34, boxY = y0 + numH, boxH = h - numH, markH = boxH * 0.46;
    rr(ctx, m, boxY, W - 2 * m, boxH, 18); ctx.fillStyle = C.bg3; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = alpha(C.t2, 0.35); ctx.stroke();
    var x = m;
    f.frames.forEach(function (fr, i) {
      var fw = i < 9 ? u : W - 2 * m - 9 * u, cells = i < 9 ? 2 : 3, cw = fw / (i < 9 ? 2 : 3);
      ctx.textAlign = 'center'; ctx.fillStyle = C.t2; ctx.font = '700 22px ' + SANS; ctx.fillText(String(i + 1), x + fw / 2, y0 + 24);
      if (i) { ctx.fillStyle = alpha(C.t2, 0.35); ctx.fillRect(x - 1, boxY, 2, boxH); }
      ctx.fillStyle = alpha(C.t2, 0.25); ctx.fillRect(x + (i < 9 ? cw : 0), boxY + markH, fw - (i < 9 ? cw : 0), 2);
      for (var k = 1; k < cells; k++) if (i === 9 || k === 1) { ctx.fillRect(x + cw * k - 1, boxY, 2, markH); }
      for (var c = 0; c < cells; c++) {
        var mk = fr.marks[c] || '', cx = x + cw * c + cw / 2, cy = boxY + markH / 2;
        if (!mk) continue;
        ctx.fillStyle = mk === 'X' ? hiCol : mk === '/' ? C.t1 : C.t1;
        ctx.font = '800 ' + (mk === 'X' ? 36 : 32) + 'px ' + SANS; ctx.fillText(mk, cx, cy + 12);
        if (fr.circled[c]) { ctx.beginPath(); ctx.arc(cx, cy, Math.min(cw, markH) / 2 - 3, 0, Math.PI * 2); ctx.lineWidth = 3; ctx.strokeStyle = C.red; ctx.stroke(); }
      }
      if (fr.total != null) { ctx.fillStyle = C.t1; fitFont(ctx, String(fr.total), '800', 40, fw - 10, 24); ctx.fillText(String(fr.total), x + fw / 2, boxY + markH + (boxH - markH) / 2 + 14); }
      x += fw;
    });
  }
  function drawStats(y0, h) {
    var k = stats.length, m = 72, w = (W - 2 * m) / k;
    rr(ctx, m, y0, W - 2 * m, h, 28); ctx.fillStyle = alpha(C.bg3, 0.7); ctx.fill();
    stats.forEach(function (st, i) {
      var cx = m + w * i + w / 2;
      if (i) { ctx.fillStyle = alpha(C.t2, 0.25); ctx.fillRect(m + w * i, y0 + 30, 2, h - 60); }
      ctx.textAlign = 'center'; ctx.fillStyle = C.t2; ctx.font = '700 24px ' + SANS; ctx.fillText(st.k, cx, y0 + h * 0.3);
      ctx.fillStyle = st.c; ctx.font = '900 64px ' + SANS; ctx.fillText(st.v, cx, y0 + h * (st.sub ? 0.7 : 0.76));
      if (st.sub) { ctx.fillStyle = C.t2; ctx.font = '600 22px ' + SANS; ctx.fillText(st.sub, cx, y0 + h * 0.9); }
    });
  }
  /* detail: strikes, spares, splits (when leaves are logged), then the balls thrown with counts */
  function drawDetail(y0, h) {
    var d = f.detail, m = 72, cells = [
      { k: 'STRIKES', v: d.strikes + '/' + d.strikeOpps, sub: pct(d.strikes, d.strikeOpps) },
      { k: 'SPARES', v: d.spares + '/' + d.spareOpps, sub: pct(d.spares, d.spareOpps) }];
    if (d.leavesKnown) cells.push({ k: 'SPLITS', v: d.splits ? d.splitsMade + '/' + d.splits : '0', sub: d.splits ? 'converted' : 'none left' });
    var rowH = 150, w = (W - 2 * m) / cells.length;
    rr(ctx, m, y0, W - 2 * m, h, 28); ctx.fillStyle = alpha(C.bg3, 0.7); ctx.fill();
    cells.forEach(function (c, i) {
      var cx = m + w * i + w / 2;
      if (i) { ctx.fillStyle = alpha(C.t2, 0.25); ctx.fillRect(m + w * i, y0 + 28, 2, rowH - 50); }
      ctx.textAlign = 'center'; ctx.fillStyle = C.t2; ctx.font = '700 24px ' + SANS; ctx.fillText(c.k, cx, y0 + 46);
      ctx.fillStyle = C.t1; ctx.font = '900 56px ' + SANS; ctx.fillText(c.v, cx, y0 + 106);
      ctx.fillStyle = C.t2; ctx.font = '600 22px ' + SANS; ctx.fillText(c.sub, cx, y0 + 136);
    });
    if (d.withFrames < d.games) { ctx.fillStyle = C.t2; ctx.font = '500 20px ' + SANS; ctx.fillText(d.withFrames + ' of ' + d.games + ' games have frame data', W / 2, y0 + rowH - 2); }
    if (!d.balls.length) return;
    ctx.fillStyle = alpha(C.t2, 0.25); ctx.fillRect(m + 30, y0 + rowH, W - 2 * m - 60, 2);
    var list = d.balls.slice(0, MAX_BALLS), more = d.balls.length - list.length, r = 40, slot = 170;
    var total = list.length * slot + (more ? 90 : 0), x0 = (W - total) / 2 + slot / 2, cy = y0 + rowH + 62;
    list.forEach(function (b, i) {
      var cx = x0 + i * slot, im = imgs[b.id];
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath();
      if (im) { ctx.clip(); try { ctx.drawImage(im, cx - r, cy - r, r * 2, r * 2); } catch (e) {} }
      else { ctx.fillStyle = alpha(C.teal, 0.25); ctx.fill(); ctx.fillStyle = C.t1; ctx.textAlign = 'center'; ctx.font = '800 26px ' + SANS;
        ctx.fillText((b.name || '?').split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase(), cx, cy + 9); }
      ctx.restore();
      ctx.lineWidth = 2; ctx.strokeStyle = alpha(C.t2, 0.5); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = C.t1; ctx.font = '800 28px ' + SANS; ctx.fillText('\u00d7' + b.count, cx, cy + r + 36);
    });
    if (more) { ctx.fillStyle = C.t2; ctx.font = '700 28px ' + SANS; ctx.fillText('+' + more, x0 + list.length * slot - slot / 2 + 45, cy + 10); }
  }

  /* identity (above the badge) */
  var iy = idTop;
  ctx.textAlign = 'center';
  idLines.forEach(function (l) { ctx.fillStyle = l.c; fitFont(ctx, l.t, l.w, l.s, W - 160, l.min); ctx.fillText(l.t, W / 2, iy + l.h - 18); iy += l.h; });
  /* level badge + footer (pinned bottom) */
  var lab = levelLabel(f); ctx.font = '800 26px ' + SANS;
  var bw = ctx.measureText(lab).width + 60, bx = (W - bw) / 2;
  var bcol = f.level === 'notap' ? C.notap : f.certified ? C.gold : C.t2;
  rr(ctx, bx, by, bw, 54, 27); ctx.fillStyle = alpha(bcol, 0.12); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = alpha(bcol, 0.8); ctx.stroke();
  ctx.fillStyle = bcol; ctx.fillText(lab, W / 2, by + 37);
  ctx.fillStyle = alpha(C.t2, 0.8); ctx.font = '500 24px ' + SANS;
  ctx.fillText('Personal stats recorded in BowlingDB', W / 2, H - (story ? 120 : 70));
  return cv;
}

/* ---------------- page glue (browser only) ---------------- */
function DB() { try { return typeof db !== 'undefined' ? db : root.db; } catch (e) { return root.db; } }
function prefs() {
  try { var p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); return Object.assign({}, DEFAULT_PREFS, p || {}); } catch (e) { return Object.assign({}, DEFAULT_PREFS); }
}
function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {} }
function themeColors() {
  var probe = document.createElement('span'); probe.style.display = 'none'; document.body.appendChild(probe);
  var get = function (v, fb) { probe.style.color = fb; probe.style.color = 'var(' + v + ')'; var c = getComputedStyle(probe).color; return c && c !== 'rgba(0, 0, 0, 0)' ? c : fb; };
  var C = { bg0: get('--bg0', '#0E0F11'), bg2: get('--bg2', '#1A1B1E'), bg3: get('--bg3', '#202124'), teal: get('--teal', '#00D9D9'), gold: get('--gold', '#FFD700'),
    red: get('--red', '#E85D4C'), notap: get('--bar-notap', '#B08AFF'), t1: get('--t1', '#ECF0FA'), t2: get('--t2', '#7B88A8') };
  probe.remove();
  return C;
}
function ctxForPage() {
  var d = DB(), entry = {};
  try { (d.leagues || []).forEach(function (l) { var c = typeof root.hdcpGet === 'function' ? root.hdcpGet(root.hdcpLeagueKey(l.LeagueID)) : null; if (c && c.entryAvg != null) entry[l.LeagueID] = c.entryAvg; }); } catch (e) {}
  var prof = null; try { prof = typeof root.fsGetProfile === 'function' ? root.fsGetProfile().name : null; } catch (e) {}
  return { hdcpFor: typeof root.hdcpForSeries === 'function' ? root.hdcpForSeries : null, entryAvg: entry, profileName: prof && prof !== 'You' ? prof : null };
}
function pageData() {
  var d = DB();
  return { series: d.series, games: d.games, frames: d.frames, attempts: d.attempts, leaves: d.leaves, balls: d.balls,
    leagues: d.leagues, tournaments: d.tournaments, centers: d.centers, bowlers: d.bowlers, openSessions: d.openSessions };
}
/* ball pictures: the phone's own picture first (blob URL), else the catalog / repo picture (CORS);
   anything that fails or would taint the canvas falls back to initials */
var imgCache = {};
function loadImg(src) {
  return new Promise(function (res) {
    var im = new Image(), done = false, fin = function (v) { if (!done) { done = true; res(v); } };
    if (!/^(blob:|data:)/.test(src)) im.crossOrigin = 'anonymous';
    im.onload = function () {
      try { var t = document.createElement('canvas'); t.width = t.height = 2; var c = t.getContext('2d'); c.drawImage(im, 0, 0, 2, 2); c.getImageData(0, 0, 1, 1); fin(im); }
      catch (e) { fin(null); }
    };
    im.onerror = function () { fin(null); };
    setTimeout(function () { fin(null); }, 3000);
    im.src = src;
  });
}
function ballImages(f) {
  if (!f.detail || !f.detail.balls.length) return Promise.resolve({});
  var list = f.detail.balls.slice(0, MAX_BALLS);
  var warm = (typeof root.warmBallImgCache === 'function' && !st.warmed) ? root.warmBallImgCache().catch(function () {}) : Promise.resolve();
  st.warmed = true;
  return warm.then(function () {
    return Promise.all(list.map(function (b) {
      if (b.id in imgCache) return imgCache[b.id];
      var src = typeof root.getBallImgSrc === 'function' ? root.getBallImgSrc(b.id, 'cover') : null;
      return (src ? loadImg(src) : Promise.resolve(null)).then(function (im) { imgCache[b.id] = im; return im; });
    }));
  }).then(function (arr) { var o = {}; list.forEach(function (b, i) { o[b.id] = arr[i]; }); return o; });
}
var st = { kind: null, id: null, facts: null, blob: null, name: '', warmed: false, imgs: {} };
function show(html) {   /* open directly (closeModal() would clear the sheet 300 ms later); keep the scroll position on re-render */
  var mb = document.getElementById('modal-body'), top = mb ? mb.scrollTop : 0;
  (typeof root.swapModal === 'function' ? root.swapModal : root.openModal)(html);
  if (mb) mb.scrollTop = top;
}
function toggle(key, label, on, avail) {
  if (!avail) return '';
  return '<div onclick="shrSet(\'' + key + '\')" style="display:flex;align-items:center;justify-content:space-between;padding:9px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' +
    '<span style="font-size:14px;color:var(--t1)">' + label + '</span>' +
    '<span style="width:44px;height:26px;border-radius:13px;background:' + (on ? 'var(--teal)' : 'var(--bg4)') + ';position:relative;display:inline-block;flex-shrink:0;transition:background .2s">' +
    '<span style="position:absolute;top:3px;left:' + (on ? '21px' : '3px') + ';width:20px;height:20px;border-radius:50%;background:#fff"></span></span></div>';
}
function render() {
  var p = prefs(), f = st.facts;
  var cv = drawShareCard(f, p, themeColors(), null, st.imgs);
  var url = cv.toDataURL('image/png');
  st.blob = null; cv.toBlob(function (b) { st.blob = b; }, 'image/png');
  var what = f.kind === 'game' ? 'game ' + f.score : 'series ' + f.total;
  st.name = ('BowlingDB ' + (f.noTap ? 'No-Tap ' : '') + what + ' ' + f.date).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.png';
  var seg = function (k) { var on = p.size === k; return '<div class="oe-btn' + (on ? ' on' : '') + '" onclick="shrSize(\'' + k + '\')">' + SIZES[k].label + '</div>'; };
  var share = !!(navigator.share && navigator.canShare);
  var detLabel = 'Detail: strikes, spares' + (f.detail && f.detail.leavesKnown ? ', splits' : '') + (f.detail && f.detail.balls.length ? ', balls' : '');
  var html = '<div class="modal-title">\ud83d\udce4 ' + (f.kind === 'game' ? 'Game card' : 'Series card') + '</div>' +
    '<img src="' + url + '" alt="Share card" style="width:' + (p.size === 'story' ? '62%' : '100%') + ';margin:0 auto;border-radius:12px;display:block;box-shadow:0 6px 24px rgba(0,0,0,.45)">' +
    '<div class="odd-even-toggle" style="margin-top:12px">' + seg('post') + seg('story') + '</div>' +
    '<div style="margin-top:6px">' +
    toggle('detail', detLabel, p.detail, !!f.detail && p.size === 'story') +
    toggle('name', 'Your name', p.name, !!f.bowler) + toggle('league', f.level === 'tournament' ? 'Tournament' : 'League', p.league, !!f.league) +
    toggle('center', 'Center', p.center, !!f.center) + toggle('avg', 'Average comparison', p.avg, f.avgIn != null) +
    toggle('hdcp', 'Handicap total', p.hdcp, f.hdcpTotal != null) + '</div>' +
    '<div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.5">The picture stays on your phone until you send it. Switches are remembered for the next card.' +
    (f.detail && p.size !== 'story' ? ' Story size can add strikes, spares, splits and balls.' : '') +
    (f.kind === 'game' && !f.frames ? ' This game was saved as a score only, so there is no scorecard.' : '') +
    (f.avgIn != null ? ' Average going in: ' + (f.avgWhy === 'league' ? 'this league before the night' : f.avgWhy === 'entering' ? 'the league\u2019s entering average' : 'your last ' + EST_GAMES + ' league games') + '.' : '') + '</div>' +
    (share ? '<button class="btn btn-primary" style="margin-top:12px" onclick="shrShare()">Share or save</button>' :
      '<div style="font-size:12px;color:var(--t3);margin-top:10px;text-align:center">Press and hold the image to save or share it.</div>') +
    '<button class="btn btn-secondary" style="margin-top:8px" onclick="closeModal()">Close</button>';
  show(html);
}
function renderWithImages() {
  var p = prefs(), f = st.facts;
  if (!detailShown(f, p)) { render(); return Promise.resolve(); }
  return ballImages(f).then(function (o) { st.imgs = o; if (st.facts === f) render(); });
}
function openFacts(kind, id, f) {
  if (!f) { if (root.toast) root.toast('No card for this ' + kind); return Promise.resolve(); }
  st.kind = kind; st.id = id; st.facts = f; st.imgs = {};
  return renderWithImages().then(function () { var mb = document.getElementById('modal-body'); if (mb) mb.scrollTop = 0; });
}
function shrOpen(id) { return openFacts('series', id, seriesFacts(pageData(), id, ctxForPage())); }
function shrOpenGame(gameID) { return openFacts('game', gameID, gameFacts(pageData(), gameID, ctxForPage())); }
function shrSet(k) { var p = prefs(); p[k] = !p[k]; savePrefs(p); renderWithImages(); }
function shrSize(k) { var p = prefs(); p.size = k; savePrefs(p); renderWithImages(); }
function shrShare() {
  if (!st.blob) { setTimeout(shrShare, 150); return; }
  var file = null;
  try { file = new File([st.blob], st.name, { type: 'image/png' }); } catch (e) {}
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file] }).catch(function () {});
  else if (root.toast) root.toast('Press and hold the image to save it');
}

var api = { SHARE_VERSION: SHARE_VERSION, shareFacts: shareFacts, seriesFacts: seriesFacts, gameFacts: gameFacts, readGame: readGame, detailFor: detailFor,
  drawShareCard: drawShareCard, levelLabel: levelLabel, detailShown: detailShown, DEFAULT_PREFS: DEFAULT_PREFS, SIZES: SIZES };
if (typeof document !== 'undefined') {
  root.shrOpen = shrOpen; root.shrOpenGame = shrOpenGame; root.shrSet = shrSet; root.shrSize = shrSize; root.shrShare = shrShare;
}
root.BDB_SHARE = api;
root.SHARE_JS_VERSION = SHARE_VERSION;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
