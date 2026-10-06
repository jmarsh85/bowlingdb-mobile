/* =====================================================================
   BowlingDB report.js  -  RPT-1 Game & Series Print / Export  (v30.156)
   Same-origin module loaded after index.html's main script, like devkit.js.

   Locked design (2026-10-06):
   - Output: print-ready page inside the app -> Print (share sheet / print
     dialog). Share exports the same page as a standalone .html file.
   - Scope: whole series by default; a game chip narrows to one game.
   - Entry points: series / round / open-session edit modal (the card's ...),
     and a Print chip on each Games-list row.
   - Page: Letter, landscape by default (portrait toggle), light print theme,
     one game per scorecard row; a game never breaks across rows or pages.
   - Extras: running totals, HC score when the league has a handicap, ball
     used per game, series total; per-frame leaves can be switched off.
   - Coverage: League, Open, Tournament. NoTap and Baker are phase 2.
   - Splits: circled from buildFreshRackScan()'s ledger (isSplitLeave on
     every fresh rack, frame 10 fill balls included) so the circles match
     the app's own split population. Nothing here re-derives a split.
   Reads only shared helpers: db, computeRunningTotals, buildFreshRackScan,
   hdcpForSeries, formatLanePairWithStart, fmtDate, getPrefs, savePrefs.
   ===================================================================== */
(function () {
'use strict';

var RPT_VERSION = 'v30.156';
var _rpt = null;   // { seriesID, gameID, model }

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- model ---------------------------------------------------- */

function rptKind(id) {
  var open = (db.openSessions || []).find(function (s) { return s.SessionID === id; });
  if (open) return { kind: 'open', rec: open };
  var s = (db.series || []).find(function (x) { return x.SeriesID === id; });
  if (!s) return null;
  if (s.TournamentID != null && s.TournamentID !== '') return { kind: 'tournament', rec: s };
  return { kind: 'league', rec: s };
}

/* Marks follow attBoxHTML()'s rules (frames 1-9 use the frame's Spare flag;
   frame 10 reads pinfall pairs). '-' is a miss / gutter, as on a paper sheet. */
function mk(n) { return n === 10 ? 'X' : n === 0 ? '-' : String(n); }
function frameMarks(fr, atts) {
  var a1 = atts.find(function (a) { return a.Attempt === 1; });
  var a2 = atts.find(function (a) { return a.Attempt === 2; });
  var a3 = atts.find(function (a) { return a.Attempt === 3; });
  var has = function (a) { return a && a.Pinfall != null; };
  var out = [];
  if (fr.FrameNumber <= 9) {
    if (!has(a1)) return [null, null];
    if (a1.Pinfall === 10) return [null, { d: 'X', att: a1 }];   // strike sits in the box
    out.push({ d: a1.Pinfall === 0 ? '-' : String(a1.Pinfall), att: a1 });
    if (has(a2)) out.push({ d: fr.Spare ? '/' : (a2.Pinfall === 0 ? '-' : String(a2.Pinfall)), att: a2 });
    else out.push(null);
    return out;
  }
  var p1 = has(a1) ? a1.Pinfall : null, p2 = has(a2) ? a2.Pinfall : null;
  out.push(has(a1) ? { d: mk(p1), att: a1 } : null);
  if (has(a2)) {
    var d2 = p1 === 10 ? mk(p2) : ((p1 || 0) + p2 >= 10 ? '/' : (p2 === 0 ? '-' : String(p2)));
    out.push({ d: d2, att: a2 });
  } else out.push(null);
  if (has(a3)) {
    var p3 = a3.Pinfall, d3;
    if (p1 === 10 && p2 === 10) d3 = mk(p3);
    else if (p1 === 10 && p2 != null) d3 = (p2 + p3 >= 10) ? '/' : (p3 === 0 ? '-' : String(p3));
    else d3 = mk(p3);
    out.push({ d: d3, att: a3 });
  } else out.push(null);
  return out;
}

function spareLeft(pins, nx, converted) {
  if (!nx || nx.Pinfall == null) return pins.slice();          // no spare ball thrown
  if (converted === true) return [];
  var b = nx.BSK_Progressive;
  if (b && b.length === 10) {
    var left = pins.filter(function (p) { return b[p - 1] === 'S'; });
    if (pins.length - left.length === nx.Pinfall) return left;   // BSK agrees with pinfall
  }
  var hasDelta = pins.some(function (p) { return nx['PinDelta' + p] != null; });
  if (hasDelta) {
    var l2 = pins.filter(function (p) { return nx['PinDelta' + p] !== 1; });
    if (pins.length - l2.length === nx.Pinfall) return l2;
  }
  return nx.Pinfall === 0 ? pins.slice() : null;                 // unknown which pins fell
}
/* Every ball thrown as the first ball of a frame, with its frame count.
   Most frames first; a tie goes to the ball used earlier in the game.
   Spare balls are not counted. Any number of balls is listed. */
function gameBalls(frames) {
  var frameNo = {}; frames.forEach(function (f) { frameNo[f.FrameID] = f.FrameNumber; });
  var tally = {};
  (db.attempts || []).forEach(function (a) {
    if (a.Attempt !== 1 || !a.BallID || frameNo[a.FrameID] == null) return;
    var k = String(a.BallID), n = frameNo[a.FrameID];
    if (!tally[k]) tally[k] = { id: k, count: 0, first: n };
    tally[k].count++;
    if (n < tally[k].first) tally[k].first = n;
  });
  return Object.keys(tally).map(function (k) { return tally[k]; })
    .sort(function (x, y) { return (y.count - x.count) || (x.first - y.first); })
    .map(function (e) {
      var b = (db.balls || []).find(function (x) { return String(x.BallID) === e.id; });
      return { name: b ? b.BallName : 'Unknown ball', count: e.count };
    });
}

function rptBuildModel(seriesID) {
  var k = rptKind(seriesID);
  if (!k) return null;
  var rec = k.rec, title = '', sub = '', leagueID = null;
  if (k.kind === 'open') { title = 'Open bowling'; }
  else if (k.kind === 'tournament') {
    var t = (db.tournaments || []).find(function (x) { return x.TournamentID === rec.TournamentID; });
    title = t ? t.TournamentName : 'Tournament';
    if (typeof bakerRoundLabelForSeries === 'function') {
      var rl = bakerRoundLabelForSeries(rec);
      var rn = parseInt(String(rl).replace(/\D+/g, ''), 10);
      if (rn) sub = 'Round ' + rn;
    }
  } else {
    var l = (db.leagues || []).find(function (x) { return x.LeagueID === rec.LeagueID; });
    title = l ? l.LeagueName : 'League';
    sub = l && l.TeamName ? l.TeamName : '';
    leagueID = rec.LeagueID;
  }
  var center = (db.centers || []).find(function (c) { return c.CenterID === rec.CenterID; });
  var lanes = rec.LanePair && rec.LanePair !== 'null'
    ? (typeof formatLanePairWithStart === 'function' ? formatLanePairWithStart(rec.LanePair, rec.LaneStart) : esc(rec.LanePair))
    : (rec.Lane ? esc(rec.Lane) : '');

  var hdcp = null;
  if (k.kind === 'league' && typeof hdcpForSeries === 'function') {
    try { hdcp = hdcpForSeries(leagueID, seriesID); } catch (e) { hdcp = null; }
    if (!hdcp) hdcp = null;   // a 0 handicap would only repeat the scratch column
  }

  var games = (db.games || [])
    .filter(function (g) { return g.SeriesID === seriesID && !g.IsTeammate; })
    .sort(function (a, b) { return (a.GameNumber || 0) - (b.GameNumber || 0); });

  var gm = games.map(function (g, gi) {
    var frames = (db.frames || []).filter(function (f) { return f.GameID === g.GameID; })
      .sort(function (a, b) { return a.FrameNumber - b.FrameNumber; });
    var fids = new Set(frames.map(function (f) { return f.FrameID; }));
    var row = {
      gameID: g.GameID, num: g.GameNumber || gi + 1, score: g.FinalScore,
      complete: g.FinalScore != null, scoreOnly: !frames.length,
      balls: frames.length ? gameBalls(frames) : [], frames: []
    };
    if (!frames.length) return row;
    computeRunningTotals(frames, g.GameID);
    var ledger = buildFreshRackScan([g.GameID]).ledger || [];
    var byAtt = {};
    ledger.forEach(function (e) { if (e.attemptID != null) byAtt[e.attemptID] = e; });
    var attsByFrame = {};
    (db.attempts || []).forEach(function (a) {
      if (fids.has(a.FrameID)) (attsByFrame[a.FrameID] = attsByFrame[a.FrameID] || []).push(a);
    });
    for (var n = 1; n <= 10; n++) {
      var fr = frames.find(function (f) { return f.FrameNumber === n; });
      if (!fr) { row.frames.push({ n: n, marks: n === 10 ? [null, null, null] : [null, null], total: null, leaves: [] }); continue; }
      var atts = (attsByFrame[fr.FrameID] || []).slice().sort(function (a, b) { return a.Attempt - b.Attempt; });
      var marks = frameMarks(fr, atts).map(function (m) {
        if (!m) return null;
        var e = byAtt[m.att.AttemptID];
        return { d: m.d, split: !!(e && e.isSplit) };
      });
      /* Per-pin spare result, read from the spare ball itself (same source the
         app's K/S triangle uses): BSK 'S' = still standing after the spare
         ball, 'K' = knocked by it. No spare ball (F10 fill) = all left. */
      var leaves = atts.map(function (a) {
        var e = byAtt[a.AttemptID];
        if (!e) return null;
        var nx = atts.find(function (x) { return x.Attempt === a.Attempt + 1; });
        return { pins: e.pins, text: e.pins.join('-'), converted: e.converted, split: e.isSplit,
                 left: spareLeft(e.pins, nx, e.converted) };
      }).filter(Boolean);
      row.frames.push({ n: n, marks: marks, total: fr.RunningTotal != null ? fr.RunningTotal : null, leaves: leaves });
    }
    if (row.score == null) {
      var last = row.frames.filter(function (f) { return f.total != null; }).pop();
      row.partial = last ? last.total : null;
    }
    if (hdcp != null && row.score != null) row.hc = row.score + hdcp;
    return row;
  });

  var done = gm.filter(function (r) { return r.score != null; });
  var total = done.reduce(function (a, r) { return a + r.score; }, 0);
  return {
    seriesID: seriesID, kind: k.kind, title: title, sub: sub,
    date: rec.DateBowled || '', center: center ? center.CenterName : '', lanes: lanes,
    hdcp: hdcp, games: gm, total: done.length ? total : null,
    hcTotal: (hdcp != null && done.length) ? total + hdcp * done.length : null
  };
}

/* ---------- render --------------------------------------------------- */

var SHEET_CSS = [
'.rpt-sheet{color-scheme:light;background:#fff;color:#151515;font-family:"Avenir Next Condensed","Avenir Next","Helvetica Neue",Arial,sans-serif;font-size:11pt;line-height:1.2;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
'.rpt-sheet.portrait{font-size:8.6pt}',
'.rpt-head{display:flex;justify-content:space-between;align-items:flex-end;gap:2em;padding-bottom:.55em;border-bottom:2.5px solid #151515;margin-bottom:.9em}',
'.rpt-title{font-size:2em;font-weight:700;letter-spacing:-.01em;line-height:1.05}',
'.rpt-sub{font-size:1em;color:#555;margin-top:.15em}',
'.rpt-fields{display:flex;gap:1.8em;text-align:right}',
'.rpt-f > span{display:block;font-size:.72em;color:#777}',
'.rpt-f b{font-size:1.15em;font-weight:600;white-space:nowrap}',
'.rpt-f.tot b{font-size:1.7em;font-weight:700}',
'.rpt-game{display:grid;grid-template-columns:6.4em repeat(9,minmax(0,1fr)) minmax(0,1.45fr) 4.2em var(--hc-col,0);border:1.5px solid #151515;margin-bottom:.75em;break-inside:avoid;page-break-inside:avoid}',
'.rpt-h{font-size:.75em;font-weight:600;text-align:center;padding:.18em 0;border-bottom:1px solid #151515;border-left:1px solid #151515;background:#efefec}',
'.rpt-h:first-child{border-left:none;text-align:left;padding-left:.6em}',
'.rpt-lbl{padding:.35em .6em;display:flex;flex-direction:column;justify-content:center;gap:.2em}',
'.rpt-lbl b{font-size:.9em;font-weight:600;line-height:1.15}',
'.rpt-lbl i{font-style:normal;font-size:.72em;color:#666;line-height:1.15}',
'.rpt-balls-list{display:flex;flex-direction:column;gap:.15em;font-size:.74em;line-height:1.15}',
'.rpt-balls-list div{display:flex;justify-content:space-between;gap:.4em;min-width:0}',
'.rpt-balls-list span{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
'.rpt-balls-list em{font-style:normal;font-weight:700;font-variant-numeric:tabular-nums;color:#555;flex-shrink:0}',
'.rpt-fr{border-left:1px solid #151515;display:flex;flex-direction:column;min-width:0}',
'.rpt-balls{display:grid;grid-template-columns:1fr 1fr;height:1.6em}',
'.rpt-balls.f10{grid-template-columns:1fr 1fr 1fr}',
'.rpt-b{display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.92em;line-height:1}',
'.rpt-b.box{border-left:1px solid #151515;border-bottom:1px solid #151515}',
'.rpt-balls.f10 .rpt-b.box:first-child{border-left:none}',
'.rpt-b.first{}',
'.rpt-sp{display:inline-flex;align-items:center;justify-content:center;width:1.12em;height:1.12em;border:1.3px solid #d0312d;border-radius:50%;box-sizing:border-box}',
'.rpt-tot{flex:1;display:flex;align-items:center;justify-content:center;font-size:1.15em;font-weight:600;font-variant-numeric:tabular-nums;padding:.2em 0 .15em;min-height:1.45em}',
'.rpt-lv{display:flex;justify-content:center;align-items:center;gap:.3em;border-top:1px dotted #b8b8b8;padding:.25em .1em;height:2.9em;box-sizing:border-box}',
'.rpt-lv svg{height:100%;width:auto;display:block}',
'.rpt-sum{border-left:1.5px solid #151515;display:flex;align-items:center;justify-content:center;font-size:1.6em;font-weight:700;font-variant-numeric:tabular-nums}',
'.rpt-sum.hc{border-left:1px solid #151515;font-size:1.25em;font-weight:600;color:#444}',
'.rpt-sum.pend{color:#999;font-size:1em;font-weight:600}',
'.rpt-empty{grid-column:2 / span 10;display:flex;align-items:center;justify-content:center;color:#888;font-size:.85em;border-left:1px solid #151515;background:repeating-linear-gradient(135deg,#fff 0 6px,#f3f3f1 6px 7px)}',
'.rpt-foot{display:flex;justify-content:space-between;gap:2em;font-size:.72em;color:#777;margin-top:.4em}',
'.rpt-foot .rpt-sp{color:#151515}',
'.rpt-foot svg{height:1.9em;width:auto;vertical-align:middle;margin-right:.25em}',
'.rpt-key{display:inline-flex;align-items:center;margin-right:1.4em}'
].join('\n');

function pageCSS(orient) {
  return '@page{size:letter ' + (orient === 'portrait' ? 'portrait' : 'landscape') + ';margin:.4in}';
}

function fmtD(d) {
  if (!d) return '';
  try { return fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
  catch (e) { return esc(d); }
}

/* Simplified rack, bowler's view (7-10 at the back, head pin at the front).
   Leave pins: solid = left open, ring = converted. Other pins: faint dots. */
var PIN_XY = { 7:[0,0], 8:[1,0], 9:[2,0], 10:[3,0], 4:[.5,1], 5:[1.5,1], 6:[2.5,1], 2:[1,2], 3:[2,2], 1:[1.5,3] };
/* left: pins still standing after the spare ball (solid). Leave pins not in
   left were converted (ring). left === null: spare-ball pins unknown, the
   leave is drawn grey-filled so it never claims a result it can't show. */
function pinDiagram(pins, left) {
  var on = {}; (pins || []).forEach(function (p) { on[p] = true; });
  var stand = {}; (left || []).forEach(function (p) { stand[p] = true; });
  var s = 6, pad = 2.6, w = 3 * s + 2 * pad, hgt = 3 * s * 0.87 + 2 * pad;
  var dots = '';
  for (var p = 1; p <= 10; p++) {
    var x = (pad + PIN_XY[p][0] * s).toFixed(2), y = (pad + PIN_XY[p][1] * s * 0.87).toFixed(2);
    if (on[p] && left === null) dots += '<circle cx="' + x + '" cy="' + y + '" r="2.1" fill="#7a7a76"/>';
    else if (on[p]) dots += stand[p]
      ? '<circle cx="' + x + '" cy="' + y + '" r="2.3" fill="#151515"/>'
      : '<circle cx="' + x + '" cy="' + y + '" r="1.85" fill="#fff" stroke="#151515" stroke-width="1"/>';
    else dots += '<circle cx="' + x + '" cy="' + y + '" r="1.25" fill="#bdbdb9"/>';
  }
  return '<svg viewBox="0 0 ' + w.toFixed(1) + ' ' + hgt.toFixed(1) + '" xmlns="http://www.w3.org/2000/svg">' + dots + '</svg>';
}
function markHTML(m, cls) {
  if (!m) return '<div class="rpt-b ' + cls + '"></div>';
  var d = esc(m.d);
  return '<div class="rpt-b ' + cls + '">' + (m.split ? '<span class="rpt-sp">' + d + '</span>' : d) + '</div>';
}

function rptRenderSheet(model, opts) {
  var o = opts || {};
  var showLeaves = o.leaves !== false;
  var hasHC = model.hdcp != null;
  var games = o.gameID ? model.games.filter(function (g) { return g.gameID === o.gameID; }) : model.games;
  var single = !!o.gameID && games.length === 1;

  var fields = [];
  fields.push('<div class="rpt-f"><span>Date</span><b>' + esc(fmtD(model.date)) + '</b></div>');
  if (model.center) fields.push('<div class="rpt-f"><span>Center</span><b>' + esc(model.center) + '</b></div>');
  if (model.lanes) fields.push('<div class="rpt-f"><span>Lanes</span><b>' + model.lanes + '</b></div>');
  if (single) {
    var g0 = games[0];
    if (g0.score != null) fields.push('<div class="rpt-f tot"><span>Game ' + g0.num + (hasHC ? ' · HC ' + g0.hc : '') + '</span><b>' + g0.score + '</b></div>');
  } else if (model.total != null) {
    fields.push('<div class="rpt-f tot"><span>Series' + (hasHC ? ' · HC ' + model.hcTotal : '') + '</span><b>' + model.total + '</b></div>');
  }

  var h = '<div class="rpt-sheet ' + (o.orient === 'portrait' ? 'portrait' : 'landscape') + '">';
  h += '<div class="rpt-head"><div><div class="rpt-title">' + esc(model.title) + '</div>' +
       (model.sub ? '<div class="rpt-sub">' + esc(model.sub) + '</div>' : '') + '</div>' +
       '<div class="rpt-fields">' + fields.join('') + '</div></div>';

  games.forEach(function (g) {
    h += '<div class="rpt-game" style="' + (hasHC ? '--hc-col:4.2em' : '') + '">';
    h += '<div class="rpt-h">Game ' + g.num + '</div>';
    for (var n = 1; n <= 10; n++) h += '<div class="rpt-h">' + n + '</div>';
    h += '<div class="rpt-h">Total</div>' + (hasHC ? '<div class="rpt-h">HC</div>' : '<div></div>');
    var bl = g.balls || [];
    h += '<div class="rpt-lbl">' + (bl.length === 1 ? '<b>' + esc(bl[0].name) + '</b>'
      : bl.length > 1 ? '<div class="rpt-balls-list">' + bl.map(function (x) {
          return '<div><span>' + esc(x.name) + '</span><em>' + x.count + '</em></div>';
        }).join('') + '</div>' : '') +
         (g.scoreOnly ? '<i>Score only</i>' : (!g.complete ? '<i>In progress</i>' : '')) + '</div>';
    if (g.scoreOnly) {
      h += '<div class="rpt-empty">No frame data recorded for this game</div>';
    } else {
      g.frames.forEach(function (f) {
        h += '<div class="rpt-fr"><div class="rpt-balls' + (f.n === 10 ? ' f10' : '') + '">';
        if (f.n < 10) h += markHTML(f.marks[0], 'first') + markHTML(f.marks[1], 'box');
        else h += markHTML(f.marks[0], 'box') + markHTML(f.marks[1], 'box') + markHTML(f.marks[2], 'box');
        h += '</div><div class="rpt-tot">' + (f.total != null ? f.total : '') + '</div>';
        if (showLeaves) {
          h += '<div class="rpt-lv">' + f.leaves.map(function (lv) { return pinDiagram(lv.pins, lv.left); }).join('') + '</div>';
        }
        h += '</div>';
      });
    }
    var sumVal = g.score != null ? g.score : (g.partial != null ? g.partial : '');
    h += '<div class="rpt-sum' + (g.score == null ? ' pend' : '') + '">' + sumVal + '</div>';
    h += hasHC ? '<div class="rpt-sum hc">' + (g.hc != null ? g.hc : '') + '</div>' : '<div></div>';
    h += '</div>';
  });

  h += '<div class="rpt-foot"><div><span class="rpt-key"><span class="rpt-sp">7</span>&nbsp; split on a fresh rack</span>' +
       (showLeaves ? '<span class="rpt-key">' + pinDiagram([4, 7, 10], [7]) + 'solid left standing, ring knocked on the spare ball</span>' : '') +
       (hasHC ? '<span class="rpt-key">HC +' + model.hdcp + ' per game</span>' : '') + '</div>' +
       '<div>BowlingDB ' + RPT_VERSION + '</div></div>';
  h += '</div>';
  return h;
}

/* ---------- in-app overlay ------------------------------------------- */

var UI_CSS = [
'#rpt-root{position:fixed;inset:0;z-index:100000;background:#2a2c30;overflow:auto;-webkit-overflow-scrolling:touch}',
'#rpt-root .rpt-bar{position:sticky;top:0;z-index:2;background:var(--bg1,#141517);border-bottom:1px solid var(--border2,rgba(255,255,255,.1));padding:calc(env(safe-area-inset-top,0px) + 8px) 12px 8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
'#rpt-root .rpt-btn{padding:7px 12px;border-radius:10px;font-size:12px;font-weight:700;border:1px solid var(--border2,rgba(255,255,255,.12));background:var(--bg2,#1a1b1e);color:var(--t2,#9aa);cursor:pointer;font-family:inherit}',
'#rpt-root .rpt-btn.on{color:var(--teal,#0dd);border-color:rgba(0,217,217,.45);background:rgba(0,217,217,.08)}',
'#rpt-root .rpt-btn.go{color:#0e0f11;background:var(--teal,#0dd);border-color:var(--teal,#0dd)}',
'#rpt-root .rpt-grp{display:flex;gap:4px}',
'#rpt-root .rpt-sp-gap{flex:1}',
'#rpt-root .rpt-paper{margin:14px auto calc(env(safe-area-inset-bottom,0px) + 24px);background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.45);padding:.4in;box-sizing:border-box;transform-origin:top left}',
'#rpt-root .rpt-paper.landscape{width:11in;min-height:8.5in}',
'#rpt-root .rpt-paper.portrait{width:8.5in;min-height:11in}',
'@media print{',
'  body > *:not(#rpt-root){display:none!important}',
'  :root{color-scheme:light!important}',
'  html,body{height:auto!important;overflow:visible!important;background:#fff!important}',
'  #rpt-root{position:static!important;overflow:visible!important;background:#fff!important;inset:auto!important}',
'  #rpt-root .rpt-bar{display:none!important}',
'  #rpt-root .rpt-paper{zoom:1!important;width:auto!important;min-height:0!important;margin:0!important;padding:0!important;box-shadow:none!important}',
'}'
].join('\n');

function ensureStyles(orient) {
  var st = document.getElementById('rpt-style');
  if (!st) {
    st = document.createElement('style'); st.id = 'rpt-style';
    st.textContent = SHEET_CSS + '\n' + UI_CSS;
    document.head.appendChild(st);
  }
  var pg = document.getElementById('rpt-page-style');
  if (!pg) { pg = document.createElement('style'); pg.id = 'rpt-page-style'; document.head.appendChild(pg); }
  pg.textContent = pageCSS(orient);
}

function prefs() {
  var p = (typeof getPrefs === 'function') ? getPrefs() : {};
  return { leaves: p.rptLeaves !== false, orient: p.rptOrient === 'portrait' ? 'portrait' : 'landscape' };
}

function fitPaper() {
  var paper = document.querySelector('#rpt-root .rpt-paper');
  if (!paper) return;
  paper.style.zoom = '';
  var avail = document.getElementById('rpt-root').clientWidth - 16;
  var w = paper.offsetWidth;
  if (w > avail) paper.style.zoom = String(avail / w);
}

function renderOverlay() {
  if (!_rpt) return;
  var p = prefs();
  ensureStyles(p.orient);
  var root = document.getElementById('rpt-root');
  if (!root) { root = document.createElement('div'); root.id = 'rpt-root'; document.body.appendChild(root); }
  var m = _rpt.model;
  var chips = m.games.length > 1
    ? '<div class="rpt-grp"><div class="rpt-btn' + (!_rpt.gameID ? ' on' : '') + '" onclick="rptScope(null)">Series</div>' +
      m.games.map(function (g) {
        return '<div class="rpt-btn' + (_rpt.gameID === g.gameID ? ' on' : '') + '" onclick="rptScope(' + g.gameID + ')">G' + g.num + '</div>';
      }).join('') + '</div>'
    : '';
  root.innerHTML =
    '<div class="rpt-bar">' +
      '<div class="rpt-btn" onclick="rptClose()">Close</div>' + chips +
      '<div class="rpt-btn' + (p.leaves ? ' on' : '') + '" onclick="rptToggleLeaves()">Leaves</div>' +
      '<div class="rpt-grp"><div class="rpt-btn' + (p.orient === 'landscape' ? ' on' : '') + '" onclick="rptOrient(\'landscape\')">Landscape</div>' +
      '<div class="rpt-btn' + (p.orient === 'portrait' ? ' on' : '') + '" onclick="rptOrient(\'portrait\')">Portrait</div></div>' +
      '<div class="rpt-sp-gap"></div>' +
      '<div class="rpt-btn" onclick="rptShare()">Share</div>' +
      '<div class="rpt-btn go" onclick="rptPrint()">Print</div>' +
    '</div>' +
    '<div class="rpt-paper ' + p.orient + '">' + rptRenderSheet(m, { leaves: p.leaves, orient: p.orient, gameID: _rpt.gameID }) + '</div>';
  requestAnimationFrame(fitPaper);
}

async function rptOpen(seriesID, opts) {
  if (typeof loadScoringData === 'function') await loadScoringData();
  var model = rptBuildModel(seriesID);
  if (!model) { if (typeof toast === 'function') toast('Series not found'); return; }
  if (!model.games.length) { if (typeof toast === 'function') toast('No games in this series yet'); return; }
  var gid = opts && opts.gameID ? opts.gameID : null;
  if (gid && !model.games.some(function (g) { return g.gameID === gid; })) gid = null;
  _rpt = { seriesID: seriesID, gameID: gid, model: model };
  renderOverlay();
  window.addEventListener('resize', fitPaper);
}

function rptClose() {
  var root = document.getElementById('rpt-root');
  if (root) root.remove();
  window.removeEventListener('resize', fitPaper);
  _rpt = null;
}
function rptScope(gameID) { if (_rpt) { _rpt.gameID = gameID; renderOverlay(); } }
function rptToggleLeaves() { savePrefs({ rptLeaves: !prefs().leaves }); renderOverlay(); }
function rptOrient(o) { savePrefs({ rptOrient: o }); renderOverlay(); }
function rptPrint() {
  var paper = document.querySelector('#rpt-root .rpt-paper');
  if (paper) paper.style.zoom = '';
  setTimeout(function () {
    try { window.print(); }
    catch (e) { if (typeof toast === 'function') toast('Print is not available here. Use Share instead.'); }
    setTimeout(fitPaper, 300);
  }, 50);
}

function fileName() {
  var m = _rpt.model;
  var base = (m.title || 'Series').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  var g = _rpt.gameID ? m.games.find(function (x) { return x.gameID === _rpt.gameID; }) : null;
  return 'BowlingDB_' + base + '_' + (m.date || '') + (g ? '_G' + g.num : '') + '.html';
}
function standaloneHTML() {
  var p = prefs();
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(_rpt.model.title) + '</title><style>' + pageCSS(p.orient) +
    '\nbody{margin:0;background:#fff}\n@media screen{body{padding:.4in}}\n' + SHEET_CSS + '</style></head><body>' +
    rptRenderSheet(_rpt.model, { leaves: p.leaves, orient: p.orient, gameID: _rpt.gameID }) + '</body></html>';
}
async function rptShare() {
  if (!_rpt) return;
  var name = fileName();
  var file;
  try { file = new File([standaloneHTML()], name, { type: 'text/html' }); } catch (e) { file = null; }
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: _rpt.model.title }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  var blob = new Blob([standaloneHTML()], { type: 'text/html' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
}

var api = { rptBuildModel: rptBuildModel, rptRenderSheet: rptRenderSheet, SHEET_CSS: SHEET_CSS, pageCSS: pageCSS };
if (typeof window !== 'undefined') {
  window.rptOpen = rptOpen; window.rptClose = rptClose; window.rptScope = rptScope;
  window.rptToggleLeaves = rptToggleLeaves; window.rptOrient = rptOrient;
  window.rptPrint = rptPrint; window.rptShare = rptShare; window.RPT = api;
}
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
