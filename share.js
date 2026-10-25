/* BowlingDB share cards -- v30.236 SHR-1 slice 1 (design: DESIGN_share_card.md, 2026-10-25).
   A picture of the bowler's own series, made on the phone and handed to the iOS share sheet.
   No account, no server, works offline. Two parts:
     shareFacts(data, id, ctx) -- pure: everything the card says, as one record ("card facts").
                                  The same record becomes the published post later (social layer).
     drawShareCard(facts, opts, colors) -- canvas drawing in the app's theme colours.
   Loaded by index.html as share.js?v=APP_VERSION on first use; require()-able for the Node harness. */
(function (root) {
'use strict';
var SHARE_VERSION = 'v30.236';
var PREFS_KEY = 'bowlingdb_share_prefs';
var DEFAULT_PREFS = { size: 'post', name: true, center: true, league: true, avg: true, hdcp: true };
var SIZES = { post: { w: 1080, h: 1350, label: 'Post 4:5' }, story: { w: 1080, h: 1920, label: 'Story 9:16' } };
var MIN_LEAGUE_GAMES = 9;      // league average going in: this many games in the league before the night
var EST_GAMES = 21;            // established average: the last 21 league games before the night

function floorAvg(sum, n) { return n ? Math.floor(sum / n) : null; }
function byDate(a, b) { return (a || '').localeCompare(b || ''); }

/* ---------------- facts (pure) ----------------
   data: { series, games, leagues, tournaments, centers, bowlers, openSessions }
   ctx:  { hdcpFor(leagueID, seriesID) -> per-game handicap | null, entryAvg: {LeagueID: n}, profileName } */
function shareFacts(data, id, ctx) {
  ctx = ctx || {};
  var open = (data.openSessions || []).filter(function (x) { return x.SessionID === id; })[0] || null;
  var s = open || (data.series || []).filter(function (x) { return x.SeriesID === id; })[0];
  if (!s) return null;
  var L = {}; (data.leagues || []).forEach(function (l) { L[l.LeagueID] = l; });
  var T = {}; (data.tournaments || []).forEach(function (t) { T[t.TournamentID] = t; });
  var lg = open ? null : L[s.LeagueID] || null;
  var tn = !open && s.TournamentID != null ? T[s.TournamentID] || null : null;
  if ((lg && lg.BakerFormat) || (tn && tn.BakerFormat)) return null;          // Baker: not in slice 1
  var all = (data.games || []).filter(function (g) { return g.SeriesID === id && !g.IsTeammate && g.FinalScore != null && g.FinalScore > 0; });
  if (!all.length) return null;
  var ntWhole = !!(s.NoTap || (tn ? tn.NoTap : (!open && s.LeagueID === -1)));   // LeagueID -1 = NoTap Games list, unless it is a tournament's series
  var noTap = ntWhole || all.every(function (g) { return g.NoTap; });
  var games = all.filter(function (g) { return ntWhole || !!g.NoTap === noTap; })
    .sort(function (a, b) { return (a.GameNumber || 0) - (b.GameNumber || 0); });
  if (!games.length) return null;
  var scores = games.map(function (g) { return g.FinalScore; });
  var total = scores.reduce(function (a, b) { return a + b; }, 0);
  var first3 = scores.length >= 3 ? scores[0] + scores[1] + scores[2] : null;
  var level = open ? 'open' : noTap ? 'notap' : tn ? 'tournament' : (lg && lg.LeagueID > 0) ? 'league' : 'open';
  var certified = level === 'league' ? lg.Sanctioned === true : level === 'tournament' ? tn.Sanctioned === true : false;
  var centerID = s.CenterID != null ? s.CenterID : tn ? tn.CenterID : lg ? lg.CenterID : null;
  var center = (data.centers || []).filter(function (c) { return c.CenterID === centerID; })[0];
  var me = (data.bowlers || []).filter(function (b) { return b.IsMe; })[0];

  /* headline pills: never "perfect" wording for No-Tap */
  var pills = [], hi = Math.max.apply(null, scores);
  if (noTap) {
    pills.push({ text: hi === 300 ? 'NO-TAP 300' : 'NO-TAP', tone: 'notap' });
  } else {
    if (scores.indexOf(300) >= 0) pills.push({ text: scores.filter(function (x) { return x === 300; }).length > 1 ? 'TWO 300 GAMES' : '300 GAME', tone: 'gold' });
    if (first3 != null && first3 >= 700) pills.push({ text: (first3 === 900 ? '900' : first3 >= 800 ? '800' : '700') + ' SERIES', tone: 'gold' });
    if (!pills.length && hi >= 298) pills.push({ text: hi + ' GAME', tone: 'gold' });
    if (!pills.length && hi >= 279) pills.push({ text: 'GREAT GAME \u00b7 ' + hi, tone: 'gold' });
  }

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
  var vsAvg = avgIn != null ? total - avgIn * scores.length : null;

  /* handicap: only where the league defines it */
  var hdcpGame = null;
  if (level === 'league' && lg.Handicap !== false && typeof ctx.hdcpFor === 'function') {
    try { hdcpGame = ctx.hdcpFor(s.LeagueID, id); } catch (e) { hdcpGame = null; }
  }
  var hdcpTotal = hdcpGame != null ? total + hdcpGame * scores.length : null;

  return {
    kind: 'series', v: 1, seriesID: id, date: date, level: level, certified: certified, noTap: noTap,
    scores: scores, total: total, best: hi, gameAvg: floorAvg(total, scores.length),
    pills: pills, avgIn: avgIn, avgWhy: avgWhy, vsAvg: vsAvg, hdcpGame: hdcpGame, hdcpTotal: hdcpTotal,
    bowler: (me && me.Name) || ctx.profileName || null,
    league: level === 'tournament' ? tn.TournamentName : level === 'league' ? lg.LeagueName : level === 'notap' ? (tn ? tn.TournamentName : lg && lg.LeagueID > 0 ? lg.LeagueName : null) : null,
    center: center ? center.CenterName : null
  };
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

/* ---------------- drawing ---------------- */
function fitFont(ctx, text, weight, start, maxW, min) {
  var size = start;
  do { ctx.font = weight + ' ' + size + 'px ' + SANS; if (ctx.measureText(text).width <= maxW) break; size -= 2; } while (size > min);
  return size;
}
var SANS = '-apple-system, "SF Pro Display", BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
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

/* opts: { size:'post'|'story', name, center, league, avg, hdcp }  colors: resolved theme colours */
function drawShareCard(f, opts, C, canvas) {
  var sz = SIZES[opts.size] || SIZES.post, W = sz.w, H = sz.h, story = opts.size === 'story';
  var cv = canvas || document.createElement('canvas'); cv.width = W; cv.height = H;
  var ctx = cv.getContext('2d');
  var accent = f.pills.length && f.pills[0].tone === 'gold' ? C.gold : f.noTap ? C.notap : C.teal;
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

  /* body blocks, laid out top-down then centred in the free space */
  var showAvg = opts.avg && f.avgIn != null, showH = opts.hdcp && f.hdcpTotal != null;
  var stats = [];
  if (showAvg) { stats.push({ k: 'AVG GOING IN', v: String(f.avgIn), c: C.t1 }); stats.push({ k: 'VS AVERAGE', v: (f.vsAvg > 0 ? '+' : '') + f.vsAvg, c: f.vsAvg > 0 ? C.teal : f.vsAvg < 0 ? C.red : C.t2 }); }
  if (showH) stats.push({ k: 'HANDICAP', v: String(f.hdcpTotal), c: C.gold, sub: '+' + f.hdcpGame + ' a game' });
  if (!stats.length) stats.push({ k: 'GAME AVERAGE', v: String(f.gameAvg), c: C.t1 });
  var D = story ? { tot: 300, totF: 250, games: 200, gF: 96, stats: 160, gap: 64 } : { tot: 270, totF: 230, games: 180, gF: 88, stats: 150, gap: 32 };
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
  blocks.push({ h: D.games, draw: drawGames });
  blocks.push({ h: D.stats, draw: drawStats });
  var bodyH = blocks.reduce(function (a, b) { return a + b.h; }, 0) + D.gap * (blocks.length - 1);
  var bodyTop = top + 56, bodyBot = idTop - (idLines.length ? 36 : 0);
  var y = bodyTop + Math.max(0, (bodyBot - bodyTop - bodyH) / 2);
  blocks.forEach(function (b) { b.draw(y, b.h); y += b.h + D.gap; });

  function drawPills(y0) {
    var ws = f.pills.map(function (p) { return pillW(ctx, p.text); }), tw = ws.reduce(function (a, b) { return a + b; }, 0) + 20 * (ws.length - 1);
    var x = (W - tw) / 2;
    f.pills.forEach(function (p, i) {
      var col = p.tone === 'notap' ? C.notap : C.gold;
      rr(ctx, x, y0, ws[i], 60, 30); ctx.fillStyle = alpha(col, 0.16); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
      ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.font = '800 30px ' + SANS; ctx.fillText(p.text, x + ws[i] / 2, y0 + 41);
      x += ws[i] + 20;
    });
  }
  function drawTotal(y0) {
    ctx.textAlign = 'center';
    ctx.fillStyle = f.pills.length && f.pills[0].tone === 'gold' ? C.gold : C.t1;
    ctx.font = '900 ' + D.totF + 'px ' + SANS; ctx.fillText(String(f.total), W / 2, y0 + D.totF * 0.88);
    ctx.fillStyle = C.t2; ctx.font = '700 32px ' + SANS;
    ctx.fillText((f.noTap ? 'NO-TAP SERIES' : 'SERIES') + ' \u00b7 ' + f.scores.length + ' GAME' + (f.scores.length === 1 ? '' : 'S'), W / 2, y0 + D.tot - 14);
  }
  function drawGames(y0, h) {
    var n = f.scores.length, m = 72, g = n > 4 ? 14 : 24, w = (W - 2 * m - g * (n - 1)) / n;
    f.scores.forEach(function (sc, i) {
      var x = m + i * (w + g), best = n > 1 && sc === f.best, gold = sc === 300 && !f.noTap;
      rr(ctx, x, y0, w, h, 28); ctx.fillStyle = C.bg3; ctx.fill();
      if (best || gold) { ctx.lineWidth = 4; ctx.strokeStyle = gold ? C.gold : accent === C.gold ? C.gold : C.teal; ctx.stroke(); }
      ctx.textAlign = 'center'; ctx.fillStyle = C.t2; ctx.font = '700 ' + (n > 4 ? 22 : 26) + 'px ' + SANS;
      ctx.fillText('GAME ' + (i + 1), x + w / 2, y0 + h * 0.25);
      ctx.fillStyle = gold ? C.gold : best ? (accent === C.gold ? C.gold : C.teal) : C.t1;
      fitFont(ctx, String(sc), '900', n > 4 ? Math.round(D.gF * 0.75) : D.gF, w - 24, 40); ctx.fillText(String(sc), x + w / 2, y0 + h * 0.8);
    });
  }
  function drawStats(y0, h) {
    var n = stats.length, m = 72, w = (W - 2 * m) / n;
    rr(ctx, m, y0, W - 2 * m, h, 28); ctx.fillStyle = alpha(C.bg3, 0.7); ctx.fill();
    stats.forEach(function (st, i) {
      var cx = m + w * i + w / 2;
      if (i) { ctx.fillStyle = alpha(C.t2, 0.25); ctx.fillRect(m + w * i, y0 + 30, 2, h - 60); }
      ctx.textAlign = 'center'; ctx.fillStyle = C.t2; ctx.font = '700 24px ' + SANS; ctx.fillText(st.k, cx, y0 + h * 0.3);
      ctx.fillStyle = st.c; ctx.font = '900 64px ' + SANS; ctx.fillText(st.v, cx, y0 + h * (st.sub ? 0.7 : 0.76));
      if (st.sub) { ctx.fillStyle = C.t2; ctx.font = '600 22px ' + SANS; ctx.fillText(st.sub, cx, y0 + h * 0.9); }
    });
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
var st = { id: null, facts: null, blob: null, name: '' };
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function show(html) {   /* open directly (closeModal() would clear the sheet 300 ms later); keep the scroll position on re-render */
  var mb = document.getElementById('modal-body'), top = mb ? mb.scrollTop : 0;
  (typeof root.swapModal === 'function' ? root.swapModal : root.openModal)(html);
  if (mb) mb.scrollTop = top;
}
function toggle(key, label, on, avail) {
  if (!avail) return '';
  return '<div onclick="shrSet(\'' + key + '\')" style="display:flex;align-items:center;justify-content:space-between;padding:9px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' +
    '<span style="font-size:14px;color:var(--t1)">' + label + '</span>' +
    '<span style="width:44px;height:26px;border-radius:13px;background:' + (on ? 'var(--teal)' : 'var(--bg4)') + ';position:relative;display:inline-block;transition:background .2s">' +
    '<span style="position:absolute;top:3px;left:' + (on ? '21px' : '3px') + ';width:20px;height:20px;border-radius:50%;background:#fff"></span></span></div>';
}
function render() {
  var p = prefs(), f = st.facts;
  var cv = drawShareCard(f, p, themeColors());
  var url = cv.toDataURL('image/png');
  st.blob = null; cv.toBlob(function (b) { st.blob = b; }, 'image/png');
  st.name = ('BowlingDB ' + (f.noTap ? 'No-Tap ' : '') + 'series ' + f.total + ' ' + f.date).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.png';
  var seg = function (k) { var on = p.size === k; return '<div class="oe-btn' + (on ? ' on' : '') + '" onclick="shrSize(\'' + k + '\')">' + SIZES[k].label + '</div>'; };
  var share = !!(navigator.share && navigator.canShare);
  var html = '<div class="modal-title">\ud83d\udce4 Share card</div>' +
    '<img src="' + url + '" alt="Share card" style="width:' + (p.size === 'story' ? '62%' : '100%') + ';margin:0 auto;border-radius:12px;display:block;box-shadow:0 6px 24px rgba(0,0,0,.45)">' +
    '<div class="odd-even-toggle" style="margin-top:12px">' + seg('post') + seg('story') + '</div>' +
    '<div style="margin-top:6px">' +
    toggle('name', 'Your name', p.name, !!f.bowler) + toggle('league', f.level === 'tournament' ? 'Tournament' : 'League', p.league, !!f.league) +
    toggle('center', 'Center', p.center, !!f.center) + toggle('avg', 'Average comparison', p.avg, f.avgIn != null) +
    toggle('hdcp', 'Handicap total', p.hdcp, f.hdcpTotal != null) + '</div>' +
    '<div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.5">The picture stays on your phone until you send it. Switches are remembered for the next card.' +
    (f.avgIn != null ? ' Average going in: ' + (f.avgWhy === 'league' ? 'this league before the night' : f.avgWhy === 'entering' ? 'the league\u2019s entering average' : 'your last ' + EST_GAMES + ' league games') + '.' : '') + '</div>' +
    (share ? '<button class="btn btn-primary" style="margin-top:12px" onclick="shrShare()">Share or save</button>' :
      '<div style="font-size:12px;color:var(--t3);margin-top:10px;text-align:center">Press and hold the image to save or share it.</div>') +
    '<button class="btn btn-secondary" style="margin-top:8px" onclick="closeModal()">Close</button>';
  show(html);
}
function shrOpen(id) {
  var d = DB();
  var f = shareFacts({ series: d.series, games: d.games, leagues: d.leagues, tournaments: d.tournaments, centers: d.centers, bowlers: d.bowlers, openSessions: d.openSessions }, id, ctxForPage());
  if (!f) { if (root.toast) root.toast('No card for this series'); return; }
  st.id = id; st.facts = f; render();
  var mb = document.getElementById('modal-body'); if (mb) mb.scrollTop = 0;
}
function shrSet(k) { var p = prefs(); p[k] = !p[k]; savePrefs(p); render(); }
function shrSize(k) { var p = prefs(); p.size = k; savePrefs(p); render(); }
function shrShare() {
  if (!st.blob) { setTimeout(shrShare, 150); return; }
  var file = null;
  try { file = new File([st.blob], st.name, { type: 'image/png' }); } catch (e) {}
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file] }).catch(function () {});
  else if (root.toast) root.toast('Press and hold the image to save it');
}

var api = { SHARE_VERSION: SHARE_VERSION, shareFacts: shareFacts, drawShareCard: drawShareCard, levelLabel: levelLabel, DEFAULT_PREFS: DEFAULT_PREFS, SIZES: SIZES };
if (typeof document !== 'undefined') {
  root.shrOpen = shrOpen; root.shrSet = shrSet; root.shrSize = shrSize; root.shrShare = shrShare;
}
root.BDB_SHARE = api;
root.SHARE_JS_VERSION = SHARE_VERSION;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
