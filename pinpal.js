/* pinpal.js -- v30.190 PP-1: read a PinPal backup (.pinpal) and compare it with this app's games.
   The report is read only. Import (v30.192) fills score-only / broken games, adds PinPal-only
   sessions, or swaps one game's frames for PinPal's, with Undo last import.

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
var PP_VERSION = 'v30.197';
/* v30.193: options and your name choices, kept on this phone.
   noTap (off by default): read PinPal games as no-tap where the app's game is no-tap, and send
   "No Tap" leagues to NoTap Games. PinPal has no no-tap mode, so this only fits someone who logged
   no-tap nights in PinPal the way James did; it is a personal sanity check, not the import path. */
var PP_OPT_KEY = 'bowlingdb_pp_options', PP_NAMES_KEY = 'bowlingdb_pp_names';
function ppLoadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } }
var PP_OPT = { noTap: false };   // v30.197: no-tap matching removed (too personal a recording method to import)
/* v30.195: your per-game decisions, kept on this phone: { 'g<app GameID>': 'app' (keep the app's
   version), 'p<PinPal game pk>': 'skip' (don't import) }. Import never touches a reviewed game.
   No-tap is compare-only: PinPal can't record no-tap, and how someone works around that (9-0, or
   X X X with the real leaves in notes) is personal, so a no-tap game in the app is never rewritten
   from PinPal and nothing is imported as no-tap. */
var PP_REV_KEY = 'bowlingdb_pp_reviews';

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
  /* names with different years are different things (Virtue Fun Spring 2024 is not ... 2026) */
  var years = function (x) { return (String(x).match(/\b(?:19|20)\d{2}\b/g) || []).concat((String(x).match(/\b\d{2}\s*[\/-]\s*\d{2}\b/g) || []).map(function (y) { return y.replace(/\s/g, ''); })); };
  var ny = years(name);
  list = list.filter(function (x) { var y = years(x); return !ny.length || !y.length || ny.some(function (v) { return y.indexOf(v) >= 0; }); });
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
      frames.forEach(function (at) { var a = at[0]; if (!a || a.Attempt !== 1 || a.Pinfall == null) return;
        var c = 0; for (var i = 1; i <= 10; i++) if (a['Pin' + i]) c++;
        if (a.Pinfall === 10) { if (c === 10) vk += 0.5; else if (c === 0) vs += 0.5; return; }   // strikes decide a 300
        if (a.Pinfall === 0) return;
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
  ['kept', 'Reviewed: left as is', 'You chose to keep the app\u2019s version, or not to import. Import leaves these alone; open one to review it again.'],
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
  var nt = PP_OPT.noTap && a.noTap, pf = nt ? ppNoTapFrames(g.frames) : g.frames, af = nt ? ppNoTapFrames(a.frames) : a.frames, n = 0;
  for (var i = 0; i < 9; i++) if (pf[i] && af[i] && pf[i][0] && af[i][0] && pf[i][0].down !== af[i][0].down) n++;
  return n >= 6;
}
/* PinPal's score as the app would show it: the no-tap rescore when the app's game is no-tap. */
function ppScoreFor(g, a) { return PP_OPT.noTap && a && a.noTap && g.ntScore != null ? g.ntScore : g.score; }
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
      var p = pr[0], a = pr[1], cat, diffs = [], b1 = [], ps = ppScoreFor(p.g, a), ntv = PP_OPT.noTap && a.noTap, pfr = p.g.frames && ntv ? ppNoTapFrames(p.g.frames) : p.g.frames;
      if (!p.g.frames) cat = ps === a.score ? 'same' : 'score';
      else if (!a.frames) cat = ps === a.score ? 'fillScore' : 'score';
      else if (ps !== a.score) cat = a.broken ? 'fillBroken' : 'score';
      else if (a.broken) cat = 'fillBroken';
      else {
        var fd = ppFrameDiffs(pfr, ntv ? ppNoTapFrames(a.frames) : a.frames);
        diffs = fd.filter(function (x) { return x.diffs.length; }); b1 = fd.filter(function (x) { return x.ball1; });
        cat = diffs.length ? 'detail' : 'same';
      }
      if (cat === 'fillBroken' || cat === 'score') { var fd2 = p.g.frames && a.frames ? ppFrameDiffs(pfr, ntv ? ppNoTapFrames(a.frames) : a.frames) : []; diffs = fd2.filter(function (x) { return x.diffs.length; }); }
      rows.push({ cat: cat, date: d, pp: p, app: a, diffs: diffs, ball1: b1, ppScore: ps, noTap: ntv });
    });
    ps.forEach(function (p) { rows.push({ cat: 'ppOnly', date: d, pp: p, app: null, diffs: [], ball1: [] }); });
    as.forEach(function (a) { rows.push({ cat: 'appOnly', date: d, pp: null, app: a, diffs: [], ball1: [], outside: !first || d < first || d > last }); });
  });
  /* a same-day leftover on both sides is a discrepancy to check, not two separate games */
  rows.forEach(function (r) { if ((r.cat === 'ppOnly' || r.cat === 'appOnly') && rows.some(function (o) { return o.date === r.date && o !== r && (o.cat === 'ppOnly' || o.cat === 'appOnly') && o.cat !== r.cat; })) r.sameDay = true; });
  var rev = typeof localStorage !== 'undefined' ? ppLoadJSON(PP_REV_KEY, {}) : {};
  rows.forEach(function (r) {
    if (r.app && r.pp && rev['g' + r.app.gameID] === 'app' && r.cat !== 'same') { r.prevCat = r.cat; r.cat = 'kept'; r.review = 'app'; }
    else if (r.cat === 'ppOnly' && rev['p' + r.pp.g.pk] === 'skip') { r.prevCat = r.cat; r.cat = 'kept'; r.review = 'skip'; }
  });
  var counts = {}; PP_CATS.forEach(function (c) { counts[c[0]] = 0; }); rows.forEach(function (r) { counts[r.cat]++; });
  return { rows: rows, counts: counts, range: [first, last] };
}
/* v30.193: your choice for a PinPal name overrides the automatic match:
   an app name (link to it), '__new' (create it), '__none' (no center / no ball), '__skip' (league: don't import). */
function ppApplyChoices(m, choices) {
  ['centers', 'leagues', 'balls'].forEach(function (k) {
    var ch = (choices && choices[k]) || {};
    m[k].forEach(function (x) {
      x.auto = x.app; x.autoHow = x.how;
      var c = ch[x.pp];
      if (c == null) { x.choice = x.app ? x.app : '__new'; if (!x.app) x.how = 'new'; return; }   // v30.196: an unmatched ball is created too
      x.choice = c;
      if (c === '__new' || c === '__none' || c === '__skip') { x.app = null; x.how = c.slice(2); }
      else { x.app = c; x.how = c === x.auto ? x.autoHow : 'you'; }
    });
  });
  return m;
}
/* Pure: PinPal names -> app names */
function ppMapping(pp, doc) {
  var list = function (arr, k) { return (arr || []).map(function (x) { return x[k]; }).filter(Boolean); };
  var m = function (names, appNames) { return names.filter(Boolean).map(function (n) { var r = ppMatchName(n, appNames); return { pp: n, app: r.name, how: r.how }; }); };
  var lgUsed = {}; pp.sessions.forEach(function (s) { if (s.league) lgUsed[s.league] = 1; });
  return ppApplyChoices({ centers: m(pp.names.houses, list(doc.centers, 'CenterName')),
    leagues: m(pp.names.leagues.filter(function (n) { return lgUsed[n]; }), list(doc.leagues, 'LeagueName')),
    balls: m(pp.names.balls, list(doc.balls, 'BallName')) }, ppLoadJSON(PP_NAMES_KEY, {}));
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

/* ---------- v30.192 PP-2: import (fill / add / use PinPal's frames), with undo ----------
   Writes games in the shape live scoring makes them: frames 1-9 with two attempts (a strike's
   second is blank), the 10th with three; attempt PinN / PinDeltaN = pins that ball KNOCKED DOWN,
   PinStartN = pins standing before it, LeaveID on ball 1 from db.leaves. A no-tap 9 on ball 1 is
   a strike and the frame's only ball. Equipment: PinPal's first-ball ball only, matched by name;
   spare balls stay empty. Every game is scored by the app's own scorer (calculateScores /
   calculateNoTapScores). A fill or replace whose score does not come out as PinPal's is rolled
   back; an added no-tap game keeps the app's score and is flagged when PinPal's 10th is ambiguous.
   A league or center the app doesn't have is created (for someone new to the app); balls are only
   linked by name, never created. Open-bowling sessions are not added (the app keeps those apart).
   Before writing, the records touched are kept in bowlingdb_ppimport_undo (Undo last import). */
var PP_UNDO_KEY = 'bowlingdb_ppimport_undo';
function ppAppDb() { return (typeof db !== 'undefined' && db) || root.db; }
var FULL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
/* Pure: PinPal frames -> [[{down, start, standing, eqName}]] in the app's frame shape (no-tap aware) */
function ppToAppBalls(frames, noTap) {
  return frames.map(function (f, n) {
    var balls = noTap && n < 9 && f[0] && f[0].down >= 9 ? [f[0]] : f.slice(0, n < 9 ? 2 : 3), prev = null;
    return balls.map(function (b, k) {
      var start = k === 0 || !prev || !prev.standing.length || (n === 9 && prev.down === 10) ? FULL.slice() : prev.standing.slice();
      prev = b;
      return { down: b.down, start: start, standing: b.standing.slice(), eqName: b.eqName || null };
    });
  });
}
function ppBallID(name, ballMap) { if (!name) return null; var m = ballMap[name]; return m || null; }
/* Pure: the scorecard's pin string for one ball, as live scoring's buildBSK makes it. start = pins standing
   before the ball, standing = pins left after. B = not in play (down before, or knocked on a fresh rack;
   a strike is all B), K = knocked on a spare ball, S = left standing. Matches every live-scored ball. */
function ppBSK(start, standing) {
  var fresh = start.length === 10, out = '';   // a strike = all B, as live scoring stores it today
  for (var p = 1; p <= 10; p++) {
    var up = start.indexOf(p) >= 0, knocked = up && standing.indexOf(p) < 0;
    out += !up ? 'B' : (fresh && knocked) ? 'B' : !knocked ? 'S' : 'K';
  }
  return out;
}
/* writes frames + attempts for one game into db; returns { frames, attempts } created */
function ppWriteFrames(D, gameID, gameNum, appBalls, noTap, ballMap) {
  var made = { frames: [], attempts: [] };
  appBalls.forEach(function (balls, n) {
    var fn = n + 1, fid = D.ids.frame++, b1 = balls[0], b2 = balls[1];
    var strike = !!b1 && (b1.down === 10 || (noTap && fn <= 9 && b1.down === 9));
    var spare = fn <= 9 && !strike && !!b2 && b1.down + b2.down === 10;
    var fr = { FrameID: fid, GameID: gameID, FrameNumber: fn, Strike: fn <= 9 ? strike : false, Spare: spare, FrameScore: null, RunningTotal: null };
    D.frames.push(fr); made.frames.push(fr);
    var count = fn === 10 ? 3 : 2;
    for (var an = 1; an <= count; an++) {
      var a = typeof blankAttempt === 'function' ? blankAttempt(D.ids.attempt++, fid, fn, gameNum, gameID, an)
        : (function (id) { var o = { AttemptID: id, FrameID: fid, FrameNumber: fn, GameNumber: gameNum, GameID: gameID, Attempt: an, Pinfall: null, LeaveID: null, BallID: null, AttemptNotes: '', ShotDetailLogged: false };
            for (var p = 1; p <= 10; p++) { o['Pin' + p] = null; o['PinStart' + p] = null; o['PinDelta' + p] = null; } return o; })(D.ids.attempt++);
      var b = balls[an - 1];
      if (b && !(fn <= 9 && an === 2 && strike)) {
        a.Pinfall = b.down;
        /* v30.197: exactly as live scoring writes them: PinStart / PinDelta are 1 / 0 (several readers test
           === 1), Pin is true / false, and BSK_Progressive is the scorecard's pin string (buildBSK). Without
           it the app rebuilt one on load with the legacy reading of PinStart, drawing pins swapped. */
        a.BSK_Progressive = ppBSK(b.start, b.standing);
        for (var p = 1; p <= 10; p++) {
          var st = b.start.indexOf(p) >= 0, left = b.standing.indexOf(p) >= 0, down = st && !left;
          a['PinStart' + p] = st ? 1 : 0; a['Pin' + p] = down; a['PinDelta' + p] = down ? 1 : 0;
        }
        if (an === 1) {
          a.BallID = ppBallID(b.eqName, ballMap);
          if (b.standing.length && b.standing.length < 10 && typeof detectLeaveID === 'function') { var sm = {}; b.standing.forEach(function (x) { sm[x] = true; }); a.LeaveID = detectLeaveID(sm); }
        }
      }
      D.attempts.push(a); made.attempts.push(a);
    }
  });
  return made;
}
/* scores one game with the app's scorer; returns the total */
function ppRescore(D, gameID, noTap) {
  var keep = typeof G !== 'undefined' ? G.gameID : null, game = D.games.filter(function (g) { return g.GameID === gameID; })[0];
  try {
    if (typeof G !== 'undefined') G.gameID = gameID;
    var frames = D.frames.filter(function (f) { return f.GameID === gameID; }).sort(function (a, b) { return a.FrameNumber - b.FrameNumber; });
    frames.forEach(function (f) { f.RunningTotal = null; f.FrameScore = null; });
    calculateScores();
    noTap = noTap || !!game.NoTap;
    if (noTap) { frames.forEach(function (f) { f.NoTapFrameScore = null; f.NoTapRunningTotal = null; }); calculateNoTapScores(frames); }
    var f10 = frames.filter(function (f) { return f.FrameNumber === 10; })[0], tot = f10 ? (noTap ? f10.NoTapRunningTotal : f10.RunningTotal) : null;
    frames.forEach(function (f) { f.CumulativeScore = f.RunningTotal; if (noTap) f.NoTapCumulativeScore = f.NoTapRunningTotal; });
    return tot;
  } finally { if (typeof G !== 'undefined') G.gameID = keep; }
}
/* Pure: what an import would do -> [{id, kind:'fill'|'add', label, note, on, rows|row, session}] */
/* Pure: what an import would do, in sections -> [{id, sec, kind, label, note, on, disabled, row|rows, session}]
   fill: frames for score-only or broken games (on) · add: PinPal-only sessions (on) ·
   replace: same score, frames differ (off) · rescore: different score, the game takes PinPal's (off).
   A no-tap game in the app is never offered (PinPal can't record no-tap). */
var PP_SECS = [['fill', 'Fill missing or broken frames'], ['add', 'Add sessions not in the app'], ['replace', 'Use PinPal\u2019s frames where they differ (same score)'], ['rescore', 'Use PinPal\u2019s frames and score (different score)']];
function ppPlan(rep, map) {
  var out = [], nt = 'no-tap game in the app: kept as recorded (PinPal can\u2019t record no-tap)';
  var gl = function (r) { return r.date + ' \u00b7 ' + (r.app.league || 'no league') + ' G' + r.app.num + ' \u00b7 ' + r.app.score; };
  rep.rows.forEach(function (r, i) {
    var sec = r.cat === 'fillScore' || r.cat === 'fillBroken' ? 'fill' : r.cat === 'detail' ? 'replace' : r.cat === 'score' ? 'rescore' : null;
    if (!sec || !r.pp.g.frames) return;
    var off = !!r.app.noTap;
    out.push({ id: sec + i, sec: sec, kind: sec === 'fill' ? 'fill' : 'replace', on: sec === 'fill' && !off, disabled: off, row: r, label: gl(r),
      note: off ? nt : sec === 'fill' ? (r.cat === 'fillScore' ? 'add PinPal\u2019s frames to the score-only game' : 'replace the frames that don\u2019t add up')
        : sec === 'replace' ? r.diffs.length + ' frame' + (r.diffs.length === 1 ? '' : 's') + ' differ; the score stays ' + r.app.score
        : 'the game\u2019s score becomes PinPal\u2019s ' + r.pp.g.score });
  });
  var bySess = {}, skipped = {};
  rep.rows.forEach(function (r) {
    if (r.cat === 'ppOnly') { var k = r.pp.s.key; (bySess[k] = bySess[k] || []).push(r); }
    if (r.review === 'skip') skipped[r.pp.s.key] = (skipped[r.pp.s.key] || 0) + 1;
  });
  Object.keys(bySess).forEach(function (k) {
    var rows = bySess[k], s = rows[0].pp.s, lg = s.league ? map.leagueOf[s.league] : null, ce = s.house ? map.centerOf[s.house] : null;
    var skip = s.league && map.skipLeague && map.skipLeague[s.league];
    var whole = rows.length + (skipped[k] || 0) === s.games.length, can = whole && !s.open && !skip;
    var why = skip ? 'you chose not to import this league (Names)' : !whole ? 'the app has some of this session\u2019s games' : s.open ? 'open bowling: add it in the app if you want it' : '';
    out.push({ id: 's' + k, sec: 'add', kind: 'add', on: !!can, disabled: !can, rows: rows, session: s, noTap: false,
      label: s.date + ' \u00b7 ' + (s.league || 'Open') + ' \u00b7 ' + rows.length + ' game' + (rows.length === 1 ? '' : 's') + ' (' + rows.map(function (r) { return r.pp.g.score; }).join(', ') + ')' + (skipped[k] ? ' \u00b7 ' + skipped[k] + ' left out by you' : ''),
      note: can ? ('to ' + (lg ? lg : 'new league \u201c' + s.league + '\u201d') + (ce ? ' at ' + ce : s.house && !(map.noCenter && map.noCenter[s.house]) ? ' \u00b7 new center \u201c' + s.house + '\u201d' : ' \u00b7 no center')) : why });
  });
  return out;
}
function ppIsNoTapLeague(s) { return false; }   // v30.195: nothing is imported as no-tap
function ppLookups(D, map) {
  var leagueOf = {}, centerOf = {}, ballMap = {}, lgID = {}, ceID = {}, skipLeague = {}, noCenter = {};
  (map.leagues || []).forEach(function (x) { if (x.how === 'skip') skipLeague[x.pp] = 1; });
  (map.centers || []).forEach(function (x) { if (x.how === 'none') noCenter[x.pp] = 1; });
  var newBall = {}; (map.balls || []).forEach(function (x) { if (x.how === 'new') newBall[x.pp] = 1; });
  (map.leagues || []).forEach(function (x) { if (x.app) leagueOf[x.pp] = x.app; });
  (map.centers || []).forEach(function (x) { if (x.app) centerOf[x.pp] = x.app; });
  (D.leagues || []).forEach(function (l) { lgID[l.LeagueName] = l.LeagueID; });
  (D.centers || []).forEach(function (c) { ceID[c.CenterName] = c.CenterID; });
  (map.balls || []).forEach(function (x) { if (x.app) { var b = (D.balls || []).filter(function (y) { return y.BallName === x.app; })[0]; if (b) ballMap[x.pp] = b.BallID; } });
  return { leagueOf: leagueOf, centerOf: centerOf, ballMap: ballMap, lgID: lgID, ceID: ceID, skipLeague: skipLeague, noCenter: noCenter, newBall: newBall };
}
/* Runs the chosen actions. Returns [{label, ok, msg}]. */
function ppRunImport(actions) {
  var D = ppAppDb(), L = ppLookups(D, _pp.map), results = [];
  /* v30.196: create a PinPal ball the first time an imported game uses it (it was linked by name only,
     so on a new install every throw lost its ball). Brand split off a leading maker name; active when
     used within 180 days of the last ball use in the backup; weight and specs left for the bowler or the catalog. */
  var lastUse = {}; (_pp.pp ? _pp.pp.sessions : []).forEach(function (se) { se.games.forEach(function (g) { (g.frames || []).forEach(function (f) { var e = f[0] && f[0].eqName; if (e && (!lastUse[e] || lastUse[e] < se.date)) lastUse[e] = se.date; }); }); });
  /* active = used within 180 days of the last time ANY ball was used (the bowler's recent arsenal),
     so a backup from someone who stopped logging months ago still comes in with an arsenal */
  var endDate = Object.keys(lastUse).reduce(function (m, k) { return lastUse[k] > m ? lastUse[k] : m; }, ''), cutoff = endDate ? new Date(new Date(endDate).getTime() - 180 * 864e5).toISOString().slice(0, 10) : '';
  var MAKERS = ['Roto Grip', '900 Global', 'Columbia 300', 'Brunswick', 'Hammer', 'Storm', 'Motiv', 'Track', 'Ebonite', 'Radical', 'DV8', 'Global'];
  var makeBall = function (name) {
    var mfg = '', nm = name;
    MAKERS.some(function (m) { if (name.toLowerCase().indexOf(m.toLowerCase() + ' ') === 0) { mfg = m; nm = name.slice(m.length + 1); return true; } return false; });
    var id = D.ids.ball++;
    D.balls.push({ BallID: id, BallName: nm, Weight: null, MFG: mfg, Active: !!(lastUse[name] && lastUse[name] >= cutoff), PerfectScaleVal: null, HookRating: null, BoxFinish: '',
      CoreType: '', CoreShort: '', Coverstock: '', CoverName: '', RG: null, Differential: null, RGDiff: '', DateReleased: null, ImagePath: null, CoreImagePath: null, SpecsURL: null, Notes: 'Imported from PinPal' });
    undo.created.balls = (undo.created.balls || []).concat([id]);
    L.ballMap[name] = id; return id;
  };
  var origBallMap = L.ballMap;
  L.ballMap = new Proxy(origBallMap, { get: function (t, k) { if (typeof k === 'string' && t[k] == null && L.newBall[k]) return makeBall(k); return t[k]; } });
  var copy = function (o) { return JSON.parse(JSON.stringify(o)); };
  var undo = { at: new Date().toISOString(), created: { series: [], games: [], frames: [], attempts: [] }, replaced: { games: [], frames: [], attempts: [] }, series: [] };
  var replaceFrames = function (r, label) {
    var a = r.app, g = D.games.filter(function (x) { return x.GameID === a.gameID; })[0];
    if (!g) { results.push({ label: label, ok: false, msg: 'game not found' }); return; }
    var gs = D.series.filter(function (x) { return x.SeriesID === g.SeriesID; })[0];
    if (g.NoTap || (gs && gs.NoTap)) { results.push({ label: label, ok: false, msg: 'no-tap game: kept as recorded' }); return; }
    var oldF = D.frames.filter(function (f) { return f.GameID === g.GameID; }), fids = oldF.map(function (f) { return f.FrameID; });
    var oldA = D.attempts.filter(function (x) { return fids.indexOf(x.FrameID) >= 0; }), keepG = copy(g);
    D.frames = D.frames.filter(function (f) { return f.GameID !== g.GameID; });
    D.attempts = D.attempts.filter(function (x) { return fids.indexOf(x.FrameID) < 0; });
    var nt = !!g.NoTap || !!a.noTap;
    var made = ppWriteFrames(D, g.GameID, g.GameNumber, ppToAppBalls(r.pp.g.frames, nt), nt, L.ballMap);
    var want = ppScoreFor(r.pp.g, a), got = ppRescore(D, g.GameID, nt);
    if (got !== want) {   // roll back this game
      var newF = made.frames.map(function (f) { return f.FrameID; });
      D.frames = D.frames.filter(function (f) { return newF.indexOf(f.FrameID) < 0; }).concat(oldF);
      D.attempts = D.attempts.filter(function (x) { return newF.indexOf(x.FrameID) < 0; }).concat(oldA);
      Object.assign(g, keepG);
      results.push({ label: label, ok: false, msg: 'scored ' + got + ', PinPal says ' + want + ': left as it was' }); return;
    }
    undo.replaced.games.push(keepG); undo.replaced.frames.push.apply(undo.replaced.frames, copy(oldF)); undo.replaced.attempts.push.apply(undo.replaced.attempts, copy(oldA));
    undo.created.frames.push.apply(undo.created.frames, made.frames.map(function (f) { return f.FrameID; }));
    undo.created.attempts.push.apply(undo.created.attempts, made.attempts.map(function (x) { return x.AttemptID; }));
    undo.removedFrames = (undo.removedFrames || []).concat(fids); undo.removedAttempts = (undo.removedAttempts || []).concat(oldA.map(function (x) { return x.AttemptID; }));
    g.FinalScore = got; g.GameTotal = got;
    results.push({ label: label, ok: true, msg: 'frames from PinPal \u00b7 ' + got });
  };
  actions.forEach(function (act) {
    if (act.kind === 'fill' || act.kind === 'replace') { replaceFrames(act.row, act.label); return; }
    /* add a session */
    var s = act.session, noTap = act.noTap, lgName = noTap ? null : L.leagueOf[s.league], leagueID = noTap ? -1 : L.lgID[lgName];
    var centerID = s.house && L.centerOf[s.house] ? L.ceID[L.centerOf[s.house]] : null;
    if (s.house && centerID == null && !L.noCenter[s.house]) {
      centerID = D.ids.center++;
      D.centers.push({ CenterID: centerID, CenterName: s.house, Address: '', City: '', State: '', Zip: '', Lanes: null, LaneSurface: '', HouseFriction: null, Website: '', ProShop: false, Notes: 'Imported from PinPal' });
      L.centerOf[s.house] = s.house; L.ceID[s.house] = centerID; undo.created.centers = (undo.created.centers || []).concat([centerID]);
    }
    if (!noTap && leagueID == null) {
      leagueID = D.ids.league++;
      /* v30.196: the fields a league made in the app carries; dates span the league's PinPal sessions */
      var ls = (_pp.pp ? _pp.pp.sessions : []).filter(function (x) { return x.league === s.league; }).map(function (x) { return x.date; }).sort();
      D.leagues.push({ LeagueID: leagueID, LeagueName: s.league, TeamName: '', CenterID: centerID, GamesPerSeries: s.games.length, DayOfBowling: '', Weeks: ls.length, WeeklyDues: 0, Active: false,
        DefaultBallID: null, DefaultSpareBallID: null, Handicap: false, Sport: false, Sanctioned: false, StartDate: ls[0] || s.date, EndDate: ls[ls.length - 1] || s.date,
        SeasonID: null, SeasonSource: null, LineageID: null, LineageSource: null, Notes: 'Imported from PinPal', Archived: false });
      L.leagueOf[s.league] = s.league; L.lgID[s.league] = leagueID; undo.created.leagues = (undo.created.leagues || []).concat([leagueID]);
    }
    var sid = D.ids.series++, first = {};
    act.rows.forEach(function (r) { var e = r.pp.g.frames && r.pp.g.frames[0] && r.pp.g.frames[0][0] && r.pp.g.frames[0][0].eqName; if (e) first[e] = (first[e] || 0) + 1; });
    var topBall = Object.keys(first).sort(function (a, b) { return first[b] - first[a]; })[0];
    var series = { SeriesID: sid, LeagueID: leagueID, CenterID: centerID, DateBowled: s.date, LanePair: null, LaneStart: null, BallID: ppBallID(topBall, L.ballMap),
      Notes: 'Imported from PinPal' + (s.notes ? ' \u00b7 ' + s.notes : ''), NoTap: noTap, GamesPerSeries: act.rows.length };
    D.series.push(series); undo.created.series.push(sid);
    act.rows.forEach(function (r, k) {
      var g = r.pp.g, gid = D.ids.game++;
      var game = { GameID: gid, SeriesID: sid, GameNumber: k + 1, LeagueID: leagueID, CenterID: centerID, DateBowled: s.date, FinalScore: null, GameTotal: null,
        LanePair: null, LaneStart: null, NoTap: noTap, BallID: ppBallID(g.ballName, L.ballMap), Notes: g.notes || '' };
      D.games.push(game); undo.created.games.push(gid);
      var made = ppWriteFrames(D, gid, k + 1, ppToAppBalls(g.frames, noTap), noTap, L.ballMap);
      undo.created.frames.push.apply(undo.created.frames, made.frames.map(function (f) { return f.FrameID; }));
      undo.created.attempts.push.apply(undo.created.attempts, made.attempts.map(function (x) { return x.AttemptID; }));
      var got = ppRescore(D, gid, noTap), want = noTap ? g.ntScore : g.score;
      game.FinalScore = got; game.GameTotal = got;
      var tenth = noTap && g.frames[9] && g.frames[9].some(function (b, j) { return j > 0 && b.down < 10 && g.frames[9][j - 1].down === 9; });
      results.push({ label: s.date + ' ' + (s.league || 'Open') + ' G' + (k + 1), ok: true,
        msg: 'added \u00b7 ' + got + (got !== want ? ' (PinPal\u2019s no-tap reading ' + want + (tenth ? ': check the 10th frame' : '') + ')' : '') });
    });
  });
  return { results: results, undo: undo };
}
function ppImportOpen() { _pp.plan = ppPlan(_pp.rep, ppLookups(ppAppDb(), _pp.map)); _pp.view = 'import'; _pp.results = null; ppRender(); }
function ppPlanToggle(i, on) { if (i >= 0 && _pp.plan[i] && !_pp.plan[i].disabled) _pp.plan[i].on = !!on; var b = el('pp-go'); var n = ppPlanGames(); if (b) { b.textContent = 'Import ' + n + ' game' + (n === 1 ? '' : 's'); b.disabled = !n; } }
function ppPlanSection(sec, on) {
  (_pp.plan || []).forEach(function (a, i) { if (a.sec === sec && !a.disabled) { a.on = !!on; var cb = document.querySelector('#pp-ov [data-pp-plan="' + i + '"]'); if (cb) cb.checked = !!on; } });
  ppPlanToggle(-1);
}
function ppPlanGames() { return (_pp.plan || []).filter(function (a) { return a.on && !a.disabled; }).reduce(function (t, a) { return t + (a.kind === 'add' ? a.rows.length : 1); }, 0); }
function ppGo(actions) {
  var n = actions.reduce(function (t, a) { return t + (a.kind === 'add' ? a.rows.length : 1); }, 0);
  if (!n) return;
  if (typeof confirm === 'function' && !confirm('Import ' + n + ' game' + (n === 1 ? '' : 's') + ' from PinPal?\n\nA copy of everything changed is kept for Undo last import. A Full Snapshot first is still a good idea.')) return;
  ppBusy('Importing ' + n + ' game' + (n === 1 ? '' : 's') + '\u2026');
  var D = ppAppDb(), keepIds = JSON.parse(JSON.stringify(D.ids));
  var run;
  try { run = ppRunImport(actions); } catch (e) { if (root.toast) root.toast('Import failed: ' + (e && e.message || e)); ppRender(); return; }
  try { localStorage.setItem(PP_UNDO_KEY, JSON.stringify(run.undo)); } catch (e) {}
  var del = function (store, keys) { return typeof idbDeleteKeys === 'function' && keys && keys.length ? idbDeleteKeys(store, keys) : Promise.resolve(); };
  Promise.resolve(del('attempts', run.undo.removedAttempts)).then(function () { return del('frames', run.undo.removedFrames); })
    .then(function () { return typeof saveAll === 'function' ? saveAll() : null; })
    .then(function () {
      _pp.results = run.results; _pp.view = 'done'; ppRender();
      var okN = run.results.filter(function (r) { return r.ok; }).length;
      if (root.toast) root.toast('Imported ' + okN + ' of ' + run.results.length);
    });
}
function ppGoPlan() { ppGo((_pp.plan || []).filter(function (a) { return a.on && !a.disabled; })); }
function ppReplaceThis() {
  var r = _pp.game; if (!r || !r.pp || !r.app || !r.pp.g.frames) return;
  ppGo([{ kind: 'replace', row: r, label: r.date + ' ' + (r.app.league || '') + ' G' + r.app.num }]);
}
/* Undo last import: remove what it created, put back what it replaced. */
function ppUndo() {
  var u; try { u = JSON.parse(localStorage.getItem(PP_UNDO_KEY) || 'null'); } catch (e) {}
  if (!u) { if (root.toast) root.toast('Nothing to undo'); return; }
  if (typeof confirm === 'function' && !confirm('Undo the PinPal import from ' + u.at.slice(0, 16).replace('T', ' ') + '?')) return;
  ppBusy('Undoing the import\u2026 (saving can take a few seconds)');
  var D = ppAppDb(), c = u.created, has = function (arr, v) { return arr.indexOf(v) >= 0; };
  D.attempts = D.attempts.filter(function (a) { return !has(c.attempts, a.AttemptID); }).concat(u.replaced.attempts);
  D.frames = D.frames.filter(function (f) { return !has(c.frames, f.FrameID); }).concat(u.replaced.frames);
  D.games = D.games.filter(function (g) { return !has(c.games, g.GameID); });
  u.replaced.games.forEach(function (g) { var cur = D.games.filter(function (x) { return x.GameID === g.GameID; })[0]; if (cur) Object.assign(cur, g); });
  D.series = D.series.filter(function (s) { return !has(c.series, s.SeriesID); });
  if (c.leagues) D.leagues = D.leagues.filter(function (l) { return !has(c.leagues, l.LeagueID); });
  if (c.centers) D.centers = D.centers.filter(function (x) { return !has(c.centers, x.CenterID); });
  if (c.balls) D.balls = D.balls.filter(function (x) { return !has(c.balls, x.BallID); });
  var del = function (store, keys) { return typeof idbDeleteKeys === 'function' && keys.length ? idbDeleteKeys(store, keys) : Promise.resolve(); };
  del('attempts', c.attempts).then(function () { return del('frames', c.frames); }).then(function () { return del('games', c.games); }).then(function () { return del('series', c.series); })
    .then(function () { return typeof saveAll === 'function' ? saveAll() : null; })
    .then(function () { localStorage.removeItem(PP_UNDO_KEY); if (root.toast) root.toast('PinPal import undone'); _pp.view = null; ppRecompare(); });
}
function ppRecompare() {
  if (!_pp.pp) { ppRender(); return; }
  var D = ppAppDb(); _pp.rep = ppCompare(_pp.pp, appGames(D)); _pp.map = ppMapping(_pp.pp, D); _pp.view = null; _pp.game = null; ppRender();
}
function ppImportHTML() {
  if (_pp.view === 'done') {
    return '<div style="font-size:13px;color:var(--t2);margin-bottom:8px">Import finished.</div>' + _pp.results.map(function (r) {
      return '<div style="padding:9px 2px;border-bottom:1px solid var(--border1);font-size:13px"><div style="color:var(--t1)">' + (r.ok ? '\u2713 ' : '\u2717 ') + esc(r.label) + '</div><div style="font-size:12px;color:' + (r.ok && !/check/.test(r.msg) ? 'var(--t3)' : 'var(--gold)') + '">' + esc(r.msg) + '</div></div>';
    }).join('') + '<button style="' + BTNP + 'width:100%;padding:12px;margin-top:14px" onclick="ppRecompare()">Compare again</button>' +
      '<button style="' + BTN + 'width:100%;padding:11px;margin-top:8px" onclick="ppUndo()">Undo this import</button>';
  }
  var n = ppPlanGames();
  if (!_pp.plan.length) return '<div style="font-size:13px;color:var(--t2);line-height:1.6">Nothing to import: every PinPal game is already in the app. To swap one game\u2019s frames for PinPal\u2019s, open it from the report.</div>';
  var item = function (a) {
    var i = _pp.plan.indexOf(a);
    return '<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 2px 10px 6px;border-bottom:1px solid var(--border1);' + (a.disabled ? 'opacity:.55' : 'cursor:pointer') + '">' +
      '<input type="checkbox" data-pp-plan="' + i + '" ' + (a.on ? 'checked ' : '') + (a.disabled ? 'disabled ' : '') + 'onchange="ppPlanToggle(' + i + ',this.checked)" style="width:18px;height:18px;margin-top:2px">' +
      '<div style="flex:1;min-width:0"><div style="font-size:13px;color:var(--t1)">' + esc(a.label) + '</div><div style="font-size:12px;color:var(--t3)">' + esc(a.note) + '</div></div></label>';
  };
  var secs = PP_SECS.map(function (sc) {
    var list = _pp.plan.filter(function (a) { return a.sec === sc[0]; }); if (!list.length) return '';
    var live = list.filter(function (a) { return !a.disabled; }).length;
    var b = function (t, on) { return '<button onclick="ppPlanSection(\'' + sc[0] + '\',' + on + ')" style="' + BTN + 'padding:5px 10px;font-size:12px">' + t + '</button>'; };
    return '<div style="display:flex;align-items:center;gap:6px;margin:16px 0 2px"><div style="flex:1;font-size:12px;font-weight:800;color:var(--t2);text-transform:uppercase;letter-spacing:.4px">' + sc[1] + ' \u00b7 ' + list.length + '</div>' +
      (live ? b('All', true) + b('None', false) : '') + '</div>' + list.map(item).join('');
  }).join('');
  return '<div style="font-size:12px;color:var(--t3);line-height:1.5;margin-bottom:6px">Ticked items are imported; each section has All / None. Games are scored by the app; a filled game that doesn\u2019t come out at PinPal\u2019s score is left alone. Equipment: first ball only; a PinPal ball not in the app is created (Names \u203a balls to change). Speed, boards and notes in the app are never touched. Games you reviewed (left as is) are not listed.</div>' +
    secs + '<button id="pp-go" style="' + BTNP + 'width:100%;padding:12px;margin-top:16px" ' + (n ? '' : 'disabled ') + 'onclick="ppGoPlan()">Import ' + n + ' game' + (n === 1 ? '' : 's') + '</button>';
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
  _pp.open = {}; _pp.game = null; _pp.view = null; ppRender();
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
/* v30.197: opening a section, a picker or a tick re-renders the screen; keep the reader where they were
   (only a change of screen, list -> game -> import, starts at the top) */
function ppScroller() { return el('pp-sc'); }
function ppRender() {
  var view = _pp.view ? 'v:' + _pp.view : _pp.game ? 'game' : 'list', sc0 = ppScroller(), keep = sc0 && _pp._lastView === view ? sc0.scrollTop : 0;
  ppRenderInner();
  _pp._lastView = view;
  var sc1 = ppScroller(); if (sc1 && keep) sc1.scrollTop = keep;
}
function ppRenderInner() {
  var ov = ppOverlay(), r = _pp.rep;
  var head = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BTN + 'width:40px;height:40px;border-radius:20px" onclick="' + (_pp.game ? 'ppBack()' : _pp.view ? 'ppRecompare()' : 'ppClose()') + '">\u2039</button>' +
    '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">' + (_pp.view ? 'Import from PinPal' : _pp.game ? 'Game comparison' : 'Compare a PinPal backup') + '</div>' +
    '<div style="font-size:11px;color:var(--t3)">' + (r ? esc(_pp.file) + ' \u00b7 ' + esc(r.range[0] || '') + ' to ' + esc(r.range[1] || '') : 'Read only: nothing in the app changes') + '</div></div></div>';
  if (_pp.view === 'import' || _pp.view === 'done') { ov.innerHTML = head + '<div id="pp-sc" style="scroll-behavior:auto;flex:1;overflow-y:auto;padding:0 16px 16px">' + ppImportHTML() + '</div>'; return; }
  if (_pp.game) { ov.innerHTML = head + '<div id="pp-sc" style="scroll-behavior:auto;flex:1;overflow-y:auto;padding:0 16px 16px">' + ppGameHTML(_pp.game) +
    ppDecideHTML(_pp.game) + '</div>'; return; }
  if (!r) {
    ov.innerHTML = head + '<div id="pp-sc" style="scroll-behavior:auto;flex:1;overflow-y:auto;padding:4px 16px 16px;font-size:13px;color:var(--t2);line-height:1.6">' +
      '<p>In PinPal, make a backup and save it to Files. Then choose it here. The app reads it on this phone and lists where PinPal and the app agree or differ, game by game.</p>' +
      '<p style="color:var(--t3)">PinPal records the pins left after each ball, but the equipment only for the first ball of a frame, so spare balls are never compared. Speed, boards and other details only the app has are never touched.</p>' +
      '<button style="' + BTNP + 'width:100%;padding:13px;margin-top:8px;font-size:15px" onclick="ppPick()">Choose PinPal backup</button></div>';
    return;
  }
  var lab = {}; PP_CATS.forEach(function (c) { lab[c[0]] = c; });
  var body = PP_CATS.map(function (c) {
    var list = r.rows.filter(function (x) { return x.cat === c[0]; }), n = list.length, open = !!_pp.open[c[0]];
    if (!n) return '';   // v30.197: only sections that hold games
    var col = c[0] === 'same' || c[0] === 'kept' ? 'var(--teal)' : c[0] === 'appOnly' ? 'var(--t3)' : 'var(--gold)';
    var h = '<div onclick="ppToggle(\'' + c[0] + '\')" style="display:flex;align-items:center;gap:10px;padding:12px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' +
      '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:700;color:var(--t1)">' + c[1] + '</div><div style="font-size:11px;color:var(--t3);line-height:1.4">' + c[2] + '</div></div>' +
      '<div style="font-size:17px;font-weight:800;color:' + (n ? col : 'var(--t3)') + '">' + n + '</div>' + (n ? '<span style="color:var(--t3)">' + (open ? '\u25be' : '\u25b8') + '</span>' : '') + '</div>';
    if (!open || !n) return h;
    var bulk = { detail: 'Keep the app\u2019s version for all', score: 'Keep the app\u2019s version for all', fillScore: 'Keep the app\u2019s version for all', fillBroken: 'Keep the app\u2019s version for all', ppOnly: 'Don\u2019t import any of these' }[c[0]];
    if (bulk) h += '<button onclick="ppReviewCat(\'' + c[0] + '\')" style="' + BTN + 'width:100%;padding:9px;margin:8px 0 2px;font-size:12px">' + bulk + ' ' + n + '</button>';
    if (c[0] === 'kept') h += '<button onclick="ppReviewCatUndo()" style="' + BTN + 'width:100%;padding:9px;margin:8px 0 2px;font-size:12px">Review all ' + n + ' again</button>';
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
    var D = ppAppDb() || {}, names = (k === 'centers' ? (D.centers || []).map(function (c) { return c.CenterName; }) : k === 'leagues' ? (D.leagues || []).map(function (c) { return c.LeagueName; }) : (D.balls || []).map(function (c) { return c.BallName; }))
      .filter(Boolean).sort(function (a, b) { return a.localeCompare(b); });
    var specials = k === 'centers' ? [['__new', 'Create new center'], ['__none', 'No center']] : k === 'leagues' ? [['__new', 'Create new league'], ['__skip', 'Don\u2019t import this league']] : [['__new', 'Create new ball'], ['__none', 'Don\u2019t link a ball']];
    return h + '<div style="font-size:11px;color:var(--t3);padding:6px 2px 4px 12px;line-height:1.45">Your choice is used by Import and kept on this phone. \u201c?\u201d marks a close guess to check.</div>' + l.map(function (x, i) {
      var col = x.how === 'same' ? 'var(--teal)' : x.how === 'close' ? 'var(--gold)' : x.how === 'skip' || x.how === 'none' ? 'var(--t3)' : 'var(--t1)';
      var opts = specials.map(function (o) { return '<option value="' + o[0] + '"' + (x.choice === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '<optgroup label="In the app">' + names.map(function (nm) { return '<option value="' + esc(nm) + '"' + (x.choice === nm ? ' selected' : '') + '>' + esc(nm) + (nm === x.auto && x.autoHow === 'close' ? ' ?' : '') + '</option>'; }).join('') + '</optgroup>';
      return '<div style="display:flex;gap:8px;align-items:center;padding:7px 2px 7px 12px;border-bottom:1px solid var(--border1);font-size:12px"><span style="flex:1;min-width:0;color:var(--t1)">' + esc(x.pp) + '</span>' +
        '<select data-pp-name="' + k + ':' + i + '" onchange="ppNameSet(\'' + k + '\',' + i + ',this.value)" style="flex:1;min-width:0;max-width:55%;font-size:12px;padding:6px;border-radius:8px;border:1px solid var(--border1);background:var(--bg2);color:' + col + '">' + opts + '</select></div>';
    }).join('');
  }).join('');
  ov.innerHTML = head + '<div id="pp-sc" style="scroll-behavior:auto;flex:1;overflow-y:auto;padding:0 16px 16px">' + body +
    '<div style="font-size:11px;font-weight:700;color:var(--t3);margin:18px 0 2px;text-transform:uppercase;letter-spacing:.5px">Names</div>' + mapH +

    '<button style="' + BTNP + 'width:100%;padding:12px;margin-top:16px" onclick="ppImportOpen()">Import from PinPal\u2026</button>' +
    (ppHasUndo() ? '<button style="' + BTN + 'width:100%;padding:10px;margin-top:8px" onclick="ppUndo()">Undo last import</button>' : '') +
    '<div style="display:flex;gap:8px;margin-top:8px"><button style="' + BTN + 'flex:1;padding:11px" onclick="ppDownload()">Download report (CSV)</button><button style="' + BTN + 'flex:1;padding:11px" onclick="ppPick()">Choose another</button></div>' +
    '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:10px">Games pair up by date: same score first; what is left pairs by order only when there is one session against one series. The report changes nothing; Import asks first.</div></div>';
}
/* v30.195: decide for this game: keep the app's version, use PinPal's frames, don't import, or review again */
function ppDecideHTML(r) {
  var bp = function (t, js, primary) { return '<button style="' + (primary ? BTNP : BTN) + 'width:100%;padding:11px;margin-top:10px" onclick="' + js + '">' + t + '</button>'; };
  var note = function (t) { return '<div style="font-size:11px;color:var(--t3);margin-top:6px;line-height:1.5">' + t + '</div>'; };
  if (r.cat === 'kept') return '<div style="margin-top:14px;font-size:13px;color:var(--teal)">' + (r.review === 'app' ? 'You kept the app\u2019s version of this game.' : 'You chose not to import this game.') + '</div>' + bp('Review again', 'ppReview(\'undo\')');
  if (r.cat === 'same' || r.cat === 'appOnly') return '';
  if (r.pp && !r.app) return '<div style="margin-top:14px"></div>' + bp('Don\u2019t import this game', 'ppReview(\'skip\')') + note('Leaves it out of Import; the rest of its session can still be added.');
  var h = '<div style="margin-top:14px"></div>' + bp('Keep the app\u2019s version', 'ppReview(\'app\')', true) + note('Marks this game reviewed: Import leaves it alone and it moves to \u201cReviewed: left as is\u201d.');
  if (r.app.noTap) return h + note('No-tap game in the app: PinPal can\u2019t record no-tap, so its frames aren\u2019t offered for it.');
  if (r.pp.g.frames) h += bp('Use PinPal\u2019s frames for this game', 'ppReplaceThis()') + note('Replaces this game\u2019s frames and pins (and first-ball equipment) with PinPal\u2019s' + (r.cat === 'score' ? '; its score becomes PinPal\u2019s ' + r.pp.g.score : ', only if they score the same') + '. Undo last import puts it back.');
  return h;
}
function ballRow(f, k) { var b = f[k]; if (!b) return '<span style="color:var(--t3)">\u2014</span>'; return b.down === 10 ? 'X' : b.down + (b.standing.length && b.standing.length < 10 ? ' <span style="color:var(--t3)">(' + b.standing.join('-') + ')</span>' : ''); }
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
function ppNameSet(kind, i, val) {
  var x = _pp.map && _pp.map[kind] && _pp.map[kind][i]; if (!x) return;
  var ch = ppLoadJSON(PP_NAMES_KEY, {}); ch[kind] = ch[kind] || {};
  ch[kind][x.pp] = val;
  try { localStorage.setItem(PP_NAMES_KEY, JSON.stringify(ch)); } catch (e) {}
  _pp.map = ppMapping(_pp.pp, ppAppDb()); ppRender();
}
function ppNoTapSet(on) {
  PP_OPT.noTap = !!on; try { localStorage.setItem(PP_OPT_KEY, JSON.stringify(PP_OPT)); } catch (e) {}
  if (_pp.pp) ppRecompare(); else ppRender();
}
function ppReviewSet(keys, val) {
  var rv = ppLoadJSON(PP_REV_KEY, {});
  keys.forEach(function (k) { if (val) rv[k] = val; else delete rv[k]; });
  try { localStorage.setItem(PP_REV_KEY, JSON.stringify(rv)); } catch (e) {}
}
function ppRowKey(r) { return r.app && r.pp ? 'g' + r.app.gameID : r.pp ? 'p' + r.pp.g.pk : null; }
/* this game: keep the app's version / don't import / review again */
function ppReview(how) {
  var r = _pp.game; if (!r) return; var k = ppRowKey(r); if (!k) return;
  ppReviewSet([k], how === 'undo' ? null : how);
  var sc = _pp.scroll; ppRecompare(); _pp.scroll = sc;
  if (root.toast) root.toast(how === 'undo' ? 'Back in the report for review' : how === 'app' ? 'Keeping the app\u2019s version' : 'Won\u2019t import this game');
}
/* a whole report section at once */
function ppReviewCat(cat) {
  var list = _pp.rep.rows.filter(function (r) { return r.cat === cat; });
  var val = cat === 'ppOnly' ? 'skip' : 'app', keys = list.map(ppRowKey).filter(Boolean);
  if (typeof confirm === 'function' && !confirm((val === 'app' ? 'Keep the app\u2019s version of all ' : 'Don\u2019t import any of the ') + keys.length + ' games in this section?\n\nYou can review any of them again later.')) return;
  ppReviewSet(keys, val); ppRecompare();
}
function ppReviewCatUndo() {
  var keys = _pp.rep.rows.filter(function (r) { return r.cat === 'kept'; }).map(ppRowKey).filter(Boolean);
  ppReviewSet(keys, null); ppRecompare();
}
function ppHasUndo() { try { return !!localStorage.getItem(PP_UNDO_KEY); } catch (e) { return false; } }
function ppToggle(k) { _pp.open[k] = !_pp.open[k]; ppRender(); }
function ppShow(i) { _pp.game = _pp.rep.rows[i]; _pp.scroll = (ppScroller() || {}).scrollTop || 0; ppRender(); }
function ppBack() { _pp.game = null; ppRender(); var sc = ppScroller(); if (sc) sc.scrollTop = _pp.scroll || 0; }
function ppDownload() {
  var csv = ppCsv(_pp.rep), name = 'PinPal_compare_' + new Date().toISOString().slice(0, 10) + '.csv';
  var blob = new Blob([csv], { type: 'text/csv' }), file = typeof File === 'function' ? new File([blob], name, { type: 'text/csv' }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(function () {}); return; }
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

root.PINPAL_JS_VERSION = PP_VERSION;
root.ppOpen = ppOpen; root.ppClose = ppClose; root.ppPick = ppPick; root.ppToggle = ppToggle; root.ppShow = ppShow; root.ppBack = ppBack; root.ppDownload = ppDownload;
root.ppLoadBuffer = ppLoadBuffer; root.ppReview = ppReview; root.ppReviewCat = ppReviewCat; root.ppReviewCatUndo = ppReviewCatUndo; root.ppPlanSection = ppPlanSection; root.ppNameSet = ppNameSet; root.ppNoTapSet = ppNoTapSet; root.ppImportOpen = ppImportOpen; root.ppPlanToggle = ppPlanToggle; root.ppGoPlan = ppGoPlan; root.ppReplaceThis = ppReplaceThis; root.ppUndo = ppUndo; root.ppRecompare = ppRecompare;
root._pinpal = { sqliteTables: sqliteTables, sqlCols: sqlCols, ppRead: ppRead, ppFrames: ppFrames, ppScore: ppScore, appGames: appGames, ppCompare: ppCompare,
  ppFrameDiffs: ppFrameDiffs, ppNoTapScore: ppNoTapScore, ppUnlike: ppUnlike, ppNoTapFrames: ppNoTapFrames, ppMatchName: ppMatchName, ppMapping: ppMapping, ppCsv: ppCsv, PP_CATS: PP_CATS, ppToAppBalls: ppToAppBalls, ppBSK: ppBSK, ppPlan: ppPlan, ppLookups: ppLookups, ppRunImport: ppRunImport, ppApplyChoices: ppApplyChoices, opt: PP_OPT };
})(typeof window !== 'undefined' ? window : globalThis);
