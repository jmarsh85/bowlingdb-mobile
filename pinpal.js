/* pinpal.js -- v30.190 PP-1: read a PinPal backup (.pinpal) and compare it with this app's games.
   READ ONLY: this file never writes app data. It is step 1 of the PinPal importer; the import step
   (fill / add, with a Full Snapshot first) builds on the report it produces.

   File: a 4 KB block of PinPal settings (an XML plist), then a SQLite database. Tables:
   house, league (pk -1 = open bowling), week (one session; date = Unix seconds, UTC), game,
   frame (12 rows per game: 0-9 plus 10-11 for 10th-frame bonus balls), ball, pattern.
   frame.pins: bits 0-9 = pins standing after the frame's first ball, bits 10-19 after its second
   (pin n = bit n-1). frame.scores: low nibble = pins down on ball 1, high nibble = pins down after
   ball 2; a 10 on ball 1 is a strike whatever the flags say. flags & 2 = a second ball was thrown.
   frame.ballFk is the FIRST ball's equipment only (spare balls are not recorded), so equipment is
   compared on ball 1 only and spare balls are never judged.

   A small SQLite reader is built in (rowid tables, overflow pages) so this works offline with no
   library. Loaded on demand from Settings > Data & app. */
(function (root) {
'use strict';
var PP_VERSION = 'v30.191';

/* ---------- SQLite (read only) ---------- */
function ppFindDb(buf) {
  var b = new Uint8Array(buf), sig = 'SQLite format 3';
  for (var off = 0; off <= Math.min(b.length - 16, 65536); off += (off < 4096 ? 512 : 4096)) {
    var ok = true; for (var i = 0; i < sig.length; i++) if (b[off + i] !== sig.charCodeAt(i)) { ok = false; break; }
    if (ok && b[off + 15] === 0) return off;
  }
  return -1;
}
function sqliteTables(buf) {
  var off = ppFindDb(buf);
  if (off < 0) throw new Error('This file has no SQLite database in it. Is it a PinPal backup?');
  var dv = new DataView(buf, off), u8 = new Uint8Array(buf, off);
  var P = dv.getUint16(16); if (P === 1) P = 65536;
  var U = P - u8[20], npages = Math.floor(u8.length / P);
  var td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  var text = function (a, s, n) { var x = u8.subarray(s, s + n); return td ? td.decode(x) : String.fromCharCode.apply(null, x); };
  var varint = function (p) {
    var v = 0;
    for (var i = 0; i < 8; i++) { var c = u8[p + i]; v = v * 128 + (c & 0x7f); if (!(c & 0x80)) return [v, i + 1]; }
    return [v * 256 + u8[p + 8], 9];
  };
  var pageBase = function (n) { return (n - 1) * P; };
  /* payload (with overflow) of a leaf cell -> Uint8Array */
  var payload = function (p, size) {
    var X = U - 35;
    if (size <= X) return u8.slice(p, p + size);
    var M = Math.floor((U - 12) * 32 / 255) - 23, K = M + ((size - M) % (U - 4)), local = K <= X ? K : M;
    var out = new Uint8Array(size); out.set(u8.subarray(p, p + local), 0);
    var got = local, next = dv.getUint32(p + local);
    while (next && got < size) {
      var b0 = pageBase(next), n = Math.min(U - 4, size - got);
      out.set(u8.subarray(b0 + 4, b0 + 4 + n), got); got += n; next = dv.getUint32(b0);
    }
    return out;
  };
  var record = function (pl) {
    var pdv = new DataView(pl.buffer, pl.byteOffset, pl.byteLength);
    var hv = (function (p) { var v = 0; for (var i = 0; i < 9; i++) { var c = pl[p + i]; v = v * 128 + (c & 0x7f); if (!(c & 0x80)) return [v, i + 1]; } return [v, 9]; });
    var h = hv(0), hs = h[0], p = h[1], types = [];
    while (p < hs) { var t = hv(p); types.push(t[0]); p += t[1]; }
    var q = hs, out = [];
    types.forEach(function (t) {
      var v = null, n = 0;
      if (t === 0) v = null;
      else if (t === 1) { v = pdv.getInt8(q); n = 1; }
      else if (t === 2) { v = pdv.getInt16(q); n = 2; }
      else if (t === 3) { v = (pdv.getInt8(q) * 65536) + pdv.getUint16(q + 1); n = 3; }
      else if (t === 4) { v = pdv.getInt32(q); n = 4; }
      else if (t === 5) { v = pdv.getInt16(q) * 4294967296 + pdv.getUint32(q + 2); n = 6; }
      else if (t === 6) { v = pdv.getInt32(q) * 4294967296 + pdv.getUint32(q + 4); n = 8; }
      else if (t === 7) { v = pdv.getFloat64(q); n = 8; }
      else if (t === 8) v = 0; else if (t === 9) v = 1;
      else if (t >= 12 && t % 2 === 0) { n = (t - 12) / 2; v = pl.slice(q, q + n); }
      else if (t >= 13) { n = (t - 13) / 2; var x = pl.subarray(q, q + n); v = td ? td.decode(x) : String.fromCharCode.apply(null, x); }
      out.push(v); q += n;
    });
    return out;
  };
  /* walk a table b-tree -> [[rowid, values]] */
  var walk = function (root, out, depth) {
    if (depth > 40 || root < 1 || root > npages) return out;
    var base = pageBase(root), h = base + (root === 1 ? 100 : 0), type = u8[h], cells = dv.getUint16(h + 3);
    var ptrs = h + (type === 0x05 || type === 0x02 ? 12 : 8);
    for (var i = 0; i < cells; i++) {
      var c = base + dv.getUint16(ptrs + 2 * i);
      if (type === 0x0d) {
        var s = varint(c), r = varint(c + s[1]);
        out.push([r[0], record(payload(c + s[1] + r[1], s[0]))]);
      } else if (type === 0x05) walk(dv.getUint32(c), out, depth + 1);
    }
    if (type === 0x05) walk(dv.getUint32(h + 8), out, depth + 1);
    return out;
  };
  var tables = {};
  walk(1, [], 0).forEach(function (row) {
    var v = row[1]; if (v[0] !== 'table' || /^sqlite_/.test(v[1])) return;
    var cols = sqlCols(v[4] || '');
    tables[v[1]] = walk(v[3], [], 0).map(function (r) {
      var o = {}; cols.names.forEach(function (c, i) { o[c] = (i === cols.pk && r[1][i] == null) ? r[0] : (r[1][i] === undefined ? null : r[1][i]); });
      return o;
    });
  });
  return tables;
}
/* column names (and the INTEGER PRIMARY KEY column) from CREATE TABLE */
function sqlCols(sql) {
  var body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')')), names = [], pk = -1, depth = 0, cur = '', parts = [];
  for (var i = 0; i < body.length; i++) { var ch = body[i]; if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { parts.push(cur); cur = ''; } else cur += ch; }
  if (cur.trim()) parts.push(cur);
  parts.forEach(function (p) {
    p = p.trim(); if (/^(primary|unique|check|foreign|constraint)\b/i.test(p)) return;
    var m = /^(?:'([^']*)'|"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|(\S+))\s*(.*)$/.exec(p); if (!m) return;
    var name = m[1] || m[2] || m[3] || m[4] || m[5];
    if (/^integer\s+primary\s+key/i.test(m[6] || '')) pk = names.length;
    names.push(name);
  });
  return { names: names, pk: pk };
}

/* ---------- PinPal -> sessions, games, frames ---------- */
var ALL30 = 1073741823;
function bitsToPins(v) { var a = []; for (var i = 0; i < 10; i++) if ((v >> i) & 1) a.push(i + 1); return a; }
function localDate(sec) { var d = new Date(sec * 1000); var p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
/* Pure: frame rows of one game -> 10 frames of balls {down, standing:[pins], eq}; 10th has up to 3 balls. */
function ppFrames(rows) {
  var byN = {}; (rows || []).forEach(function (r) { byN[r.frameNum] = r; });
  var ballsOf = function (r) {
    if (!r || (r.pins === ALL30 && !r.scores)) return [];
    var b1 = r.scores & 15, out = [{ down: b1, standing: bitsToPins(r.pins & 1023), eq: r.ballFk || null }];
    if (b1 < 10 && (r.flags & 2)) out.push({ down: (r.scores >> 4) - b1, standing: bitsToPins((r.pins >> 10) & 1023), eq: null });
    return out;
  };
  var frames = [];
  for (var n = 0; n < 9; n++) frames.push(ballsOf(byN[n]));
  var tenth = ballsOf(byN[9]).concat(ballsOf(byN[10]), ballsOf(byN[11]));
  frames.push(tenth.slice(0, 3));
  return frames;
}
/* Pure: frames -> total (standard ten-pin scoring) */
function ppScore(frames) {
  var rolls = [], idx = [];
  frames.forEach(function (f, n) { if (n < 10) idx.push(rolls.length); f.forEach(function (b) { rolls.push(b.down); }); });
  var t = 0;
  idx.forEach(function (i) {
    var r = function (k) { return rolls[i + k] || 0; };
    if (r(0) === 10) t += 10 + r(1) + r(2); else if (r(0) + r(1) === 10) t += 10 + r(2); else t += r(0) + r(1);
  });
  return t;
}
/* Pure: no-tap score (9 on a full rack counts as a strike). PinPal has no no-tap mode, so no-tap
   nights were logged there as regular games; this rescoring is what the app shows for them. */
function ppNoTapRolls(frames) {
  return frames.map(function (f, n) {
    var r = [];
    if (n < 9) { if (f[0] && f[0].down >= 9) r.push(10); else f.forEach(function (b) { r.push(b.down); }); }
    else { var fresh = true; f.forEach(function (b) { if (fresh && b.down >= 9) { r.push(10); return; } r.push(b.down); fresh = fresh ? b.down === 10 : true; }); }
    return r;
  });
}
function ppNoTapScore(frames) { return ppScore(ppNoTapRolls(frames).map(function (r) { return r.map(function (d) { return { down: d, standing: [] }; }); })); }
/* PinPal frames as the app stores a no-tap game: a 9 on ball 1 is the frame's only ball (PinPal
   adds "then 0"). The 10th keeps its first ball only, since PinPal's later 10th balls can't be
   mapped onto no-tap racks reliably. */
function ppNoTapFrames(frames) {
  return frames.map(function (f, n) {
    if (n === 9) return f.slice(0, 1);
    return f[0] && f[0].down >= 9 ? [f[0]] : f;
  });
}
/* Pure: tables -> { sessions:[{key,date,league,house,pattern,games:[{num,score,frames,ballName,pk}]}], names } */
function ppRead(t) {
  var by = function (rows) { var m = {}; (rows || []).forEach(function (r) { m[r.pk] = r; }); return m; };
  var L = by(t.league), H = by(t.house), B = by(t.ball), PT = by(t.pattern), W = by(t.week);
  var framesBy = {}; (t.frame || []).forEach(function (f) { (framesBy[f.gameFk] = framesBy[f.gameFk] || []).push(f); });
  var sess = {}, order = [];
  (t.game || []).slice().sort(function (a, b) { var wa = W[a.weekFk], wb = W[b.weekFk]; return ((wa && wa.date) || 0) - ((wb && wb.date) || 0) || a.pk - b.pk; }).forEach(function (g) {
    var w = W[g.weekFk]; if (!w) return;
    var fr = framesBy[g.pk] || [];
    var hasFrames = fr.some(function (r) { return !(r.pins === ALL30 && !r.scores); });
    if ((!hasFrames && !g.score) || (!g.flags && !g.score)) return;   // empty or unplayed shell (a stray first-ball row is not a game)
    var date = localDate(w.date), lg = L[w.leagueFk], key = date + '|' + w.leagueFk;   // weeks of one league on one day are one session
    var s = sess[key];
    if (!s) { s = sess[key] = { key: key, date: date, leaguePk: w.leagueFk, league: lg ? lg.name : null, open: !lg, house: (H[w.houseFk] || H[g.houseFk] || {}).name || null,
      pattern: (PT[w.patternFk] || PT[g.patternFk] || {}).name || null, games: [] }; order.push(s); }
    var frames = hasFrames ? ppFrames(fr) : null;
    frames && frames.forEach(function (f) { f.forEach(function (b) { if (b.eq != null) b.eqName = (B[b.eq] || {}).name || null; }); });
    s.games.push({ pk: g.pk, num: s.games.length + 1, score: g.score, frames: frames, calc: frames ? ppScore(frames) : null, ntScore: frames ? ppNoTapScore(frames) : null,
      ballName: (B[g.ballFk] || {}).name || null, notes: g.notes || '' });
  });
  return { sessions: order, names: { houses: (t.house || []).map(function (h) { return h.name; }), leagues: (t.league || []).map(function (l) { return l.name; }),
    balls: (t.ball || []).map(function (b) { return b.name; }), patterns: (t.pattern || []).map(function (p) { return p.name; }) } };
}

/* ---------- name matching (centers, leagues, balls) ---------- */
function ppNorm(s) { return String(s || '').toLowerCase().replace(/[\u2018\u2019']/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim(); }
var PP_STOP = { lanes: 1, bowl: 1, bowling: 1, center: 1, centre: 1, the: 1, league: 1, and: 1, presented: 1, by: 1, amf: 1, bowlero: 1, storm: 1, roto: 1, grip: 1, hammer: 1, brunswick: 1, motiv: 1, track: 0 };
function ppTokens(s) { return ppNorm(s).split(' ').filter(function (w) { return w && !PP_STOP[w]; }); }
/* Pure: best app name for a PinPal name: {name, how: 'same'|'close'|null} */
function ppMatchName(name, list) {
  var n = ppNorm(name); if (!n) return { name: null, how: null };
  for (var i = 0; i < list.length; i++) if (ppNorm(list[i]) === n) return { name: list[i], how: 'same' };
  var tight = function (x) { return ppNorm(x).replace(/ /g, ''); };   // Hy-Road = Hyroad
  for (var j = 0; j < list.length; j++) if (tight(list[j]) === tight(name)) return { name: list[j], how: 'same' };
  var a = ppTokens(name), best = null, bs = 0;
  list.forEach(function (x) {
    var b = ppTokens(x); if (!a.length || !b.length) return;
    var hit = a.filter(function (w) { return b.indexOf(w) >= 0; }).length;
    /* close: every word of the shorter name is in the longer one (AMF McRay / AMF McRay Plaza Lanes),
       or at least half the words match. One shared word between two-word names (Hy-Road / Night Road) is not enough. */
    var mn = Math.min(a.length, b.length), sc = hit === mn ? 1 : hit / Math.max(a.length, b.length);
    if (hit === 1 && mn >= 2) sc = 0;   // a single shared word between multi-word names is chance
    if (hit && sc > bs) { bs = sc; best = x; }
  });
  return bs >= 0.5 ? { name: best, how: 'close' } : { name: null, how: null };
}

/* ---------- app side ---------- */
/* Pure: app data -> games by date [{gameID, seriesID, num, score, date, league, center, noTap, frames|null, broken}] */
function appGames(doc) {
  var se = {}, lg = {}, ce = {}, bl = {};
  (doc.series || []).forEach(function (s) { se[s.SeriesID] = s; });
  (doc.leagues || []).forEach(function (l) { lg[l.LeagueID] = l.LeagueName; });
  (doc.centers || []).forEach(function (c) { ce[c.CenterID] = c.CenterName; });
  (doc.balls || []).forEach(function (b) { bl[b.BallID] = b.BallName; });
  var fBy = {}; (doc.frames || []).forEach(function (f) { (fBy[f.GameID] = fBy[f.GameID] || []).push(f); });
  var aBy = {}; (doc.attempts || []).forEach(function (a) { (aBy[a.FrameID] = aBy[a.FrameID] || []).push(a); });
  return (doc.games || []).map(function (g) {
    var s = se[g.SeriesID] || {}, fs = (fBy[g.GameID] || []).slice().sort(function (a, b) { return a.FrameNumber - b.FrameNumber; });
    var frames = null, broken = false;
    if (fs.length) {
      frames = [];
      for (var n = 1; n <= 10; n++) {
        var f = fs.filter(function (x) { return x.FrameNumber === n; })[0];
        var at = f ? (aBy[f.FrameID] || []).filter(function (a) { return a.Pinfall != null; }).sort(function (a, b) { return a.Attempt - b.Attempt; }) : [];
        frames.push(at);
      }
      /* Two conventions are in the data. The app's own scoring records the pins each ball
         KNOCKED DOWN (att.PinN = knocked; the leave lives in LeaveID). Games imported long ago
         record the pins LEFT STANDING. Decide per game from the first balls, then turn every
         ball into "pins left standing" so both compare with PinPal the same way. */
      var vk = 0, vs = 0;
      frames.forEach(function (at) { var a = at[0]; if (!a || a.Attempt !== 1 || !(a.Pinfall > 0 && a.Pinfall < 10)) return;
        var c = 0; for (var i = 1; i <= 10; i++) if (a['Pin' + i]) c++;
        if (c === a.Pinfall && c !== 10 - a.Pinfall) vk++; else if (c === 10 - a.Pinfall && c !== a.Pinfall) vs++; });
      var knocked = vk > vs;
      frames = frames.map(function (at) {
        var prev = null;
        return at.map(function (a) {
          var on = []; for (var i = 1; i <= 10; i++) if (a['Pin' + i]) on.push(i);
          var st;
          if (!knocked) st = on;
          else {
            var start = []; for (var j = 1; j <= 10; j++) if (a['PinStart' + j]) start.push(j);
            if (!start.length) start = a.Attempt === 1 || !prev ? [1,2,3,4,5,6,7,8,9,10] : prev;
            st = start.filter(function (x) { return on.indexOf(x) < 0; });
          }
          prev = st;
          return { down: a.Pinfall, standing: st, eq: a.BallID, eqName: bl[a.BallID] || null };
        });
      });
      var nt = !!(g.NoTap || s.NoTap), f10 = fs.filter(function (x) { return x.FrameNumber === 10; })[0];
      var score = g.FinalScore != null ? g.FinalScore : g.GameTotal;
      broken = fs.length !== 10 || !f10 || !(f10.RunningTotal === score || (nt && f10.NoTapRunningTotal === score));
    }
    return { gameID: g.GameID, seriesID: g.SeriesID, num: g.GameNumber, score: g.FinalScore != null ? g.FinalScore : g.GameTotal,
      date: s.DateBowled || g.DateBowled || '', league: lg[g.LeagueID || s.LeagueID] || null, center: ce[g.CenterID || s.CenterID] || null,
      noTap: !!(g.NoTap || s.NoTap), frames: frames, broken: broken };
  });
}

/* ---------- compare ---------- */
var PP_CATS = [
  ['same', 'Identical', 'Same score, and every frame\u2019s first-ball leave and spare result match.'],
  ['detail', 'Same score, frames differ', 'Scores agree but at least one frame\u2019s leave or second ball differs.'],
  ['score', 'Different score', 'Paired by date and order, but the scores differ. Check these by hand.'],
  ['fillScore', 'App has score only', 'Your game has no frames; PinPal has them.'],
  ['fillBroken', 'App frames don\u2019t add up', 'Your frame 10 total isn\u2019t the saved score; PinPal\u2019s frames are complete.'],
  ['ppOnly', 'Only in PinPal', 'Not in the app at all.'],
  ['appOnly', 'Only in the app', 'Not in this PinPal backup (logged elsewhere or after it was made).']
];
function sameSet(a, b) { return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); }
function eqSame(pp, app) {
  if (!pp || !app) return true;   // unknown on either side is not a difference
  var a = ppTokens(pp), b = ppTokens(app); if (!a.length || !b.length) return ppNorm(pp) === ppNorm(app);
  return a.some(function (w) { return b.indexOf(w) >= 0; });
}
/* Pure: frame-by-frame differences between a PinPal game and an app game. */
function ppFrameDiffs(pf, af) {
  var out = [];
  for (var n = 0; n < 10; n++) {
    var p = pf[n] || [], a = af[n] || [], d = [];
    if (!a.length) { if (p.length) d.push('missing in app'); }
    else if (!p.length) d.push('missing in PinPal');
    else {
      var lim = n === 9 ? Math.min(p.length, a.length) : Math.min(2, p.length, a.length);
      for (var k = 0; k < lim; k++) {
        if (p[k].down !== a[k].down) d.push('ball ' + (k + 1) + ': ' + p[k].down + ' vs ' + a[k].down);
        else if (!(n === 9 && k > 0) && !sameSet(p[k].standing, a[k].standing)) d.push('ball ' + (k + 1) + ' leave: ' + (p[k].standing.join('-') || 'none') + ' vs ' + (a[k].standing.join('-') || 'none'));
      }
      if (p.length !== a.length) d.push(p.length + ' balls vs ' + a.length);
    }
    var eq = p[0] && a[0] && !eqSame(p[0].eqName, a[0].eqName) ? (p[0].eqName + ' vs ' + a[0].eqName) : null;
    if (d.length || eq) out.push({ frame: n + 1, diffs: d, ball1: eq });
  }
  return out;
}
/* Same score by chance? Two games with frames that disagree on the first ball in 6+ frames are
   not the same game (9/23/26: a PinPal open 190 and an unrelated league 190). */
function ppUnlike(g, a) {
  if (!g.frames || !a.frames || a.broken) return false;
  var pf = a.noTap ? ppNoTapFrames(g.frames) : g.frames, af = a.noTap ? ppNoTapFrames(a.frames) : a.frames, n = 0;
  for (var i = 0; i < 9; i++) if (pf[i] && af[i] && pf[i][0] && af[i][0] && pf[i][0].down !== af[i][0].down) n++;
  return n >= 6;
}
/* PinPal's score as the app would show it: the no-tap rescore when the app's game is no-tap. */
function ppScoreFor(g, a) { return a && a.noTap && g.ntScore != null ? g.ntScore : g.score; }
/* Pure: PinPal read + app games -> { rows:[{cat, date, pp, app, diffs, ball1Diffs}], counts, range } */
function ppCompare(pp, app) {
  var byDate = function (list, k) { var m = {}; list.forEach(function (x) { (m[x[k]] = m[x[k]] || []).push(x); }); return m; };
  var ppGames = []; pp.sessions.forEach(function (s) { s.games.forEach(function (g) { ppGames.push({ s: s, g: g, date: s.date }); }); });
  var P = byDate(ppGames, 'date'), A = byDate(app, 'date'), rows = [];
  var dates = Object.keys(P).concat(Object.keys(A).filter(function (d) { return !P[d]; })).sort();
  var first = ppGames.length ? ppGames[0].date : null, last = ppGames.length ? ppGames[ppGames.length - 1].date : null;
  dates.forEach(function (d) {
    var ps = (P[d] || []).slice(), as = (A[d] || []).slice().sort(function (a, b) { return a.seriesID - b.seriesID || a.num - b.num; }), pairs = [];
    /* 1. same score */
    ps.slice().forEach(function (p) {
      var i = -1; for (var k = 0; k < as.length; k++) if (as[k].score === ppScoreFor(p.g, as[k]) && !ppUnlike(p.g, as[k])) { i = k; break; }
      if (i >= 0) { pairs.push([p, as[i]]); as.splice(i, 1); ps.splice(ps.indexOf(p), 1); }
    });
    /* 2. what is left pairs by order only when it is one session against one series with the same game count */
    var sess = ps.map(function (p) { return p.s.key; }).filter(function (k, i, a) { return a.indexOf(k) === i; });
    var ser = as.map(function (a) { return a.seriesID; }).filter(function (k, i, a) { return a.indexOf(k) === i; });
    if (sess.length === 1 && ser.length === 1 && ps.length === as.length) { ps.forEach(function (p, i) { pairs.push([p, as[i]]); }); ps = []; as = []; }
    pairs.forEach(function (pr) {
      var p = pr[0], a = pr[1], cat, diffs = [], b1 = [], ps = ppScoreFor(p.g, a), pfr = p.g.frames && a.noTap ? ppNoTapFrames(p.g.frames) : p.g.frames;
      if (!p.g.frames) cat = ps === a.score ? 'same' : 'score';
      else if (!a.frames) cat = ps === a.score ? 'fillScore' : 'score';
      else if (ps !== a.score) cat = a.broken ? 'fillBroken' : 'score';
      else if (a.broken) cat = 'fillBroken';
      else {
        var fd = ppFrameDiffs(pfr, a.noTap ? ppNoTapFrames(a.frames) : a.frames);
        diffs = fd.filter(function (x) { return x.diffs.length; }); b1 = fd.filter(function (x) { return x.ball1; });
        cat = diffs.length ? 'detail' : 'same';
      }
      if (cat === 'fillBroken' || cat === 'score') { var fd2 = p.g.frames && a.frames ? ppFrameDiffs(pfr, a.noTap ? ppNoTapFrames(a.frames) : a.frames) : []; diffs = fd2.filter(function (x) { return x.diffs.length; }); }
      rows.push({ cat: cat, date: d, pp: p, app: a, diffs: diffs, ball1: b1, ppScore: ps, noTap: a.noTap });
    });
    ps.forEach(function (p) { rows.push({ cat: 'ppOnly', date: d, pp: p, app: null, diffs: [], ball1: [] }); });
    as.forEach(function (a) { rows.push({ cat: 'appOnly', date: d, pp: null, app: a, diffs: [], ball1: [], outside: !first || d < first || d > last }); });
  });
  /* a same-day leftover on both sides is a discrepancy to check, not two separate games */
  rows.forEach(function (r) { if ((r.cat === 'ppOnly' || r.cat === 'appOnly') && rows.some(function (o) { return o.date === r.date && o !== r && (o.cat === 'ppOnly' || o.cat === 'appOnly') && o.cat !== r.cat; })) r.sameDay = true; });
  var counts = {}; PP_CATS.forEach(function (c) { counts[c[0]] = 0; }); rows.forEach(function (r) { counts[r.cat]++; });
  return { rows: rows, counts: counts, range: [first, last] };
}
/* Pure: PinPal names -> app names */
function ppMapping(pp, doc) {
  var list = function (arr, k) { return (arr || []).map(function (x) { return x[k]; }).filter(Boolean); };
  var m = function (names, appNames) { return names.filter(Boolean).map(function (n) { var r = ppMatchName(n, appNames); return { pp: n, app: r.name, how: r.how }; }); };
  var lgUsed = {}; pp.sessions.forEach(function (s) { if (s.league) lgUsed[s.league] = 1; });
  return { centers: m(pp.names.houses, list(doc.centers, 'CenterName')),
    leagues: m(pp.names.leagues.filter(function (n) { return lgUsed[n]; }), list(doc.leagues, 'LeagueName')),
    balls: m(pp.names.balls, list(doc.balls, 'BallName')) };
}
/* Pure: report -> CSV */
function ppCsv(rep) {
  var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  var lab = {}; PP_CATS.forEach(function (c) { lab[c[0]] = c[1]; });
  var lines = [['Category', 'Date', 'PinPal league', 'PinPal game', 'PinPal score', 'App league', 'App game', 'App score', 'App GameID', 'Frame differences', 'Ball 1 differences'].join(',')];
  rep.rows.forEach(function (r) {
    lines.push([lab[r.cat], r.date, r.pp ? (r.pp.s.league || 'Open') : '', r.pp ? r.pp.g.num : '', r.pp ? r.pp.g.score : '',
      r.app ? (r.app.league || '') : '', r.app ? r.app.num : '', r.app ? r.app.score : '', r.app ? r.app.gameID : '',
      r.diffs.map(function (x) { return 'F' + x.frame + ' ' + x.diffs.join('; '); }).join(' | '),
      r.ball1.map(function (x) { return 'F' + x.frame + ' ' + x.ball1; }).join(' | ')].map(q).join(','));
  });
  return lines.join('\n') + '\n';
}

/* ---------- screen ---------- */
var _pp = { rep: null, map: null, open: {}, game: null, file: '' };
function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
var BTN = 'border-radius:10px;border:1px solid var(--border1);background:var(--bg2);color:var(--t1);font-weight:700;cursor:pointer;';
var BTNP = 'border-radius:10px;border:1px solid var(--teal);background:rgba(0,217,217,0.12);color:var(--teal);font-weight:700;cursor:pointer;';
function ppOverlay() {
  var ov = el('pp-ov');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'pp-ov';
    ov.style.cssText = 'position:fixed;inset:0;z-index:905;background:var(--bg0);display:flex;flex-direction:column;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
    document.body.appendChild(ov);
  }
  return ov;
}
function ppOpen() {
  var mb = el('modal-bg'); if (mb && mb.classList.contains('open') && typeof root.closeModal === 'function') root.closeModal();
  _pp.open = {}; _pp.game = null; ppRender();
}
function ppClose() { var o = el('pp-ov'); if (o) o.parentNode.removeChild(o); }
function ppPick() {
  var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.pinpal,application/octet-stream,*/*'; inp.style.display = 'none';
  inp.addEventListener('change', function () {
    var f = inp.files && inp.files[0]; if (inp.parentNode) inp.parentNode.removeChild(inp); if (!f) return;
    _pp.file = f.name; ppBusy('Reading ' + f.name + '\u2026');
    f.arrayBuffer().then(ppLoadBuffer).catch(function (e) { ppBusy(null); if (root.toast) root.toast('Could not read it: ' + (e && e.message || e)); });
  });
  document.body.appendChild(inp); inp.click();
}
function ppBusy(msg) { var o = ppOverlay(); if (msg) o.innerHTML = '<div style="margin:auto;color:var(--t2);font-size:14px">' + esc(msg) + '</div>'; else ppRender(); }
function ppLoadBuffer(buf) {
  var tables = sqliteTables(buf);
  if (!tables.game || !tables.frame || !tables.week) throw new Error('No PinPal game tables in this file');
  var pp = ppRead(tables);
  /* the app's `let db` and loadScoringData live in the shared global scope of classic scripts */
  var load = typeof loadScoringData === 'function' ? loadScoringData() : Promise.resolve();
  return Promise.resolve(load).then(function () {
    var doc = (typeof db !== 'undefined' && db) || root.db || {};
    _pp.rep = ppCompare(pp, appGames(doc)); _pp.map = ppMapping(pp, doc); _pp.pp = pp; _pp.open = {}; _pp.game = null;
    ppRender();
  });
}
function ppRender() {
  var ov = ppOverlay(), r = _pp.rep;
  var head = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BTN + 'width:40px;height:40px;border-radius:20px" onclick="' + (_pp.game ? 'ppBack()' : 'ppClose()') + '">\u2039</button>' +
    '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">' + (_pp.game ? 'Game comparison' : 'Compare a PinPal backup') + '</div>' +
    '<div style="font-size:11px;color:var(--t3)">' + (r ? esc(_pp.file) + ' \u00b7 ' + esc(r.range[0] || '') + ' to ' + esc(r.range[1] || '') : 'Read only: nothing in the app changes') + '</div></div></div>';
  if (_pp.game) { ov.innerHTML = head + '<div style="flex:1;overflow-y:auto;padding:0 16px 16px">' + ppGameHTML(_pp.game) + '</div>'; return; }
  if (!r) {
    ov.innerHTML = head + '<div style="flex:1;overflow-y:auto;padding:4px 16px 16px;font-size:13px;color:var(--t2);line-height:1.6">' +
      '<p>In PinPal, make a backup and save it to Files. Then choose it here. The app reads it on this phone and lists where PinPal and the app agree or differ, game by game.</p>' +
      '<p style="color:var(--t3)">PinPal records the pins left after each ball, but the equipment only for the first ball of a frame, so spare balls are never compared. Speed, boards and other details only the app has are never touched.</p>' +
      '<button style="' + BTNP + 'width:100%;padding:13px;margin-top:8px;font-size:15px" onclick="ppPick()">Choose PinPal backup</button></div>';
    return;
  }
  var lab = {}; PP_CATS.forEach(function (c) { lab[c[0]] = c; });
  var body = PP_CATS.map(function (c) {
    var list = r.rows.filter(function (x) { return x.cat === c[0]; }), n = list.length, open = !!_pp.open[c[0]];
    var col = c[0] === 'same' ? 'var(--teal)' : c[0] === 'appOnly' ? 'var(--t3)' : 'var(--gold)';
    var h = '<div onclick="ppToggle(\'' + c[0] + '\')" style="display:flex;align-items:center;gap:10px;padding:12px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' +
      '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:700;color:var(--t1)">' + c[1] + '</div><div style="font-size:11px;color:var(--t3);line-height:1.4">' + c[2] + '</div></div>' +
      '<div style="font-size:17px;font-weight:800;color:' + (n ? col : 'var(--t3)') + '">' + n + '</div>' + (n ? '<span style="color:var(--t3)">' + (open ? '\u25be' : '\u25b8') + '</span>' : '') + '</div>';
    if (!open || !n) return h;
    if (c[0] === 'appOnly') {
      var inside = list.filter(function (x) { return !x.outside; }), outside = list.length - inside.length;
      list = inside;
      h += outside ? '<div style="font-size:12px;color:var(--t3);padding:8px 2px 4px 12px">' + outside + ' game' + (outside === 1 ? '' : 's') + ' outside the backup\u2019s dates (not listed)</div>' : '';
    }
    return h + list.map(function (x) {
      var i = r.rows.indexOf(x), p = x.pp, a = x.app;
      var left = p ? (esc(p.s.league || 'Open') + ' G' + p.g.num + ' \u00b7 <b>' + p.g.score + '</b>') : '\u2014';
      var right = a ? (esc(a.league || 'no league') + ' G' + a.num + ' \u00b7 <b>' + a.score + '</b>') : '\u2014';
      var note = x.diffs.length ? x.diffs.length + ' frame' + (x.diffs.length === 1 ? '' : 's') + ' differ' : '';
      if (x.ball1.length) note += (note ? ' \u00b7 ' : '') + 'ball 1 differs in ' + x.ball1.length;
      if (x.sameDay) note += (note ? ' \u00b7 ' : '') + '<span style="color:var(--gold)">other side has games that day</span>';
      return '<div onclick="ppShow(' + i + ')" style="padding:9px 2px 9px 12px;border-bottom:1px solid var(--border1);cursor:pointer;font-size:13px;color:var(--t1)">' +
        '<div style="display:flex;justify-content:space-between;gap:8px"><span style="color:var(--t2)">' + esc(x.date) + '</span><span style="color:var(--t3);font-size:11px">PinPal \u2192 App</span></div>' +
        '<div>' + left + ' \u2192 ' + right + '</div>' + (note ? '<div style="font-size:11px;color:var(--t3)">' + note + '</div>' : '') + '</div>';
    }).join('');
  }).join('');
  var mapH = ['centers', 'leagues', 'balls'].map(function (k) {
    var l = _pp.map[k], miss = l.filter(function (x) { return !x.app; }).length, close = l.filter(function (x) { return x.how === 'close'; }).length, open = !!_pp.open['map-' + k];
    var h = '<div onclick="ppToggle(\'map-' + k + '\')" style="display:flex;gap:10px;align-items:center;padding:10px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' +
      '<div style="flex:1;font-size:14px;color:var(--t1);text-transform:capitalize">' + k + '</div><div style="font-size:12px;color:var(--t2)">' + (l.length - miss) + ' of ' + l.length + ' found' + (close ? ' \u00b7 ' + close + ' close' : '') + '</div>' +
      '<span style="color:var(--t3)">' + (open ? '\u25be' : '\u25b8') + '</span></div>';
    if (!open) return h;
    return h + l.map(function (x) {
      return '<div style="display:flex;gap:8px;padding:7px 2px 7px 12px;border-bottom:1px solid var(--border1);font-size:12px"><span style="flex:1;color:var(--t1)">' + esc(x.pp) + '</span><span style="flex:1;text-align:right;color:' +
        (x.how === 'same' ? 'var(--teal)' : x.how === 'close' ? 'var(--gold)' : 'var(--t3)') + '">' + (x.app ? esc(x.app) + (x.how === 'close' ? ' ?' : '') : 'not in app') + '</span></div>';
    }).join('');
  }).join('');
  ov.innerHTML = head + '<div style="flex:1;overflow-y:auto;padding:0 16px 16px">' + body +
    '<div style="font-size:11px;font-weight:700;color:var(--t3);margin:18px 0 2px;text-transform:uppercase;letter-spacing:.5px">Names</div>' + mapH +
    '<div style="display:flex;gap:8px;margin-top:16px"><button style="' + BTN + 'flex:1;padding:11px" onclick="ppDownload()">Download report (CSV)</button><button style="' + BTN + 'flex:1;padding:11px" onclick="ppPick()">Choose another</button></div>' +
    '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:10px">Games pair up by date: same score first; what is left pairs by order only when there is one session against one series. Read only. Filling and adding games is the next step.</div></div>';
}
function ballRow(f, k) { var b = f[k]; if (!b) return '<span style="color:var(--t3)">\u2014</span>'; return b.down === 10 && k === 0 ? 'X' : b.down + (b.standing.length && b.standing.length < 10 ? ' <span style="color:var(--t3)">(' + b.standing.join('-') + ')</span>' : ''); }
function ppGameHTML(x) {
  var p = x.pp, a = x.app, pf = p && p.g.frames, af = a && a.frames, dset = {};
  x.diffs.forEach(function (d) { dset[d.frame] = d; }); x.ball1.forEach(function (d) { dset[d.frame] = Object.assign({}, dset[d.frame] || { diffs: [] }, { ball1: d.ball1 }); });
  var top = '<div style="font-size:13px;color:var(--t2);line-height:1.6;margin-bottom:8px">' + esc(x.date) + '<br>PinPal: ' + (p ? esc(p.s.league || 'Open') + ' \u00b7 ' + esc(p.s.house || '') + ' \u00b7 G' + p.g.num + ' \u00b7 <b>' + p.g.score + '</b>' : 'not in backup') +
    '<br>App: ' + (a ? esc(a.league || 'no league') + ' \u00b7 ' + esc(a.center || '') + ' \u00b7 G' + a.num + ' \u00b7 <b>' + a.score + '</b>' + (a.noTap ? ' \u00b7 NoTap' : '') + ' \u00b7 GameID ' + a.gameID : 'not in app') + '</div>';
  if (!pf && !af) return top + '<div style="color:var(--t3);font-size:13px">No frames on either side.</div>';
  var rows = '';
  for (var n = 0; n < 10; n++) {
    var d = dset[n + 1], P = pf ? pf[n] : [], A = af ? af[n] : [];
    var cell = function (f) { if (!f || !f.length) return '<span style="color:var(--t3)">\u2014</span>'; return f.map(function (b, k) { return ballRow(f, k); }).join(' / '); };
    rows += '<tr style="border-bottom:1px solid var(--border1);' + (d ? 'background:rgba(255,190,60,0.08)' : '') + '"><td style="padding:6px 4px;color:var(--t2)">' + (n + 1) + '</td><td style="padding:6px 4px">' + cell(P) + '</td><td style="padding:6px 4px">' + cell(A) + '</td></tr>' +
      (d ? '<tr><td></td><td colspan="2" style="padding:0 4px 6px;font-size:11px;color:var(--gold)">' + esc((d.diffs || []).join('; ')) + (d.ball1 ? ((d.diffs || []).length ? ' \u00b7 ' : '') + 'ball 1: ' + esc(d.ball1) : '') + '</td></tr>' : '');
  }
  var eq = function (f) { return f ? (f.map(function (fr) { return fr[0] && fr[0].eqName; }).filter(Boolean)[0] || '') : ''; };
  return top + '<div style="font-size:11px;color:var(--t3);margin-bottom:6px">Pins down per ball; (pins left standing). Ball 1: PinPal ' + esc(eq(pf) || '\u2014') + ' \u00b7 App ' + esc(eq(af) || '\u2014') + '</div>' +
    '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px;color:var(--t1)"><tr style="color:var(--t3);font-size:11px;text-align:left"><th style="padding:4px">Fr</th><th style="padding:4px">PinPal</th><th style="padding:4px">App</th></tr>' + rows + '</table></div>';
}
function ppToggle(k) { _pp.open[k] = !_pp.open[k]; ppRender(); }
function ppShow(i) { _pp.game = _pp.rep.rows[i]; _pp.scroll = (el('pp-ov').querySelector('[style*="overflow-y:auto"]') || {}).scrollTop || 0; ppRender(); }
function ppBack() { _pp.game = null; ppRender(); var sc = el('pp-ov').querySelector('[style*="overflow-y:auto"]'); if (sc) sc.scrollTop = _pp.scroll || 0; }
function ppDownload() {
  var csv = ppCsv(_pp.rep), name = 'PinPal_compare_' + new Date().toISOString().slice(0, 10) + '.csv';
  var blob = new Blob([csv], { type: 'text/csv' }), file = typeof File === 'function' ? new File([blob], name, { type: 'text/csv' }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(function () {}); return; }
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

root.PINPAL_JS_VERSION = PP_VERSION;
root.ppOpen = ppOpen; root.ppClose = ppClose; root.ppPick = ppPick; root.ppToggle = ppToggle; root.ppShow = ppShow; root.ppBack = ppBack; root.ppDownload = ppDownload;
root.ppLoadBuffer = ppLoadBuffer;
root._pinpal = { sqliteTables: sqliteTables, sqlCols: sqlCols, ppRead: ppRead, ppFrames: ppFrames, ppScore: ppScore, appGames: appGames, ppCompare: ppCompare,
  ppFrameDiffs: ppFrameDiffs, ppNoTapScore: ppNoTapScore, ppUnlike: ppUnlike, ppNoTapFrames: ppNoTapFrames, ppMatchName: ppMatchName, ppMapping: ppMapping, ppCsv: ppCsv, PP_CATS: PP_CATS };
})(typeof window !== 'undefined' ? window : globalThis);
