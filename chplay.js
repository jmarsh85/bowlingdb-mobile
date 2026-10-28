/* BowlingDB open challenge sessions -- v30.244 SOC-1 step 3a (design: DESIGN_social_1.md 4.0, 7d).
   Games bowled FOR an open challenge live in their own IndexedDB store (challengeSessions), never in
   series / games / frames / attempts, so no stat, average, award, handicap, streak, share card or
   Access export can see them (same separation as Baker and Team Bowl). Test mode covers the store
   because it lives in the BowlingDB database. Pins only: each ball is the list of pins it knocked down.
   You and your opponent share one card (turns frame by frame); an opponent's game can also be typed
   in as a score (score contests only).
   Parts: pure engine (buildFrames, scoreStd, marks, normOpen; require()-able for the Node harness)
   + the Open Bowling > Challenges tab and the challenge scorecard screen (s-chplay).
   Loaded by index.html as chplay.js?v=APP_VERSION with challenge.js. ASCII only. */
(function (root) {
'use strict';
var CHPLAY_VERSION = 'v30.244';
var STORE = 'challengeSessions';
var ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
var FORMATS = { standard: { name: 'Standard scoring', about: 'Ordinary bowling scoring.' },
  lowball: { name: 'Low Ball', about: 'Fewest pins wins; a miss is a strike. Next build.', soon: true } };

/* ---------------- engine (pure) ---------------- */
function minus(rack, knocked) { return rack.filter(function (p) { return knocked.indexOf(p) < 0; }); }
/* balls: [[pins knocked], ...] for one bowler's game, in order. Returns the frames (each ball: pins, knocked,
   leave = standing after it) and where the next ball goes (frame, ball, rack) or done. */
function buildFrames(balls) {
  var frames = [], i = 0, n = (balls || []).length;
  var at = function (f, b, rack) { return { frames: frames, done: false, next: { frame: f, ball: b, rack: rack.slice() }, used: i }; };
  for (var f = 1; f <= 10; f++) {
    var fr = { n: f, balls: [] }; frames.push(fr);
    var rack = ALL.slice();
    if (f < 10) {
      if (i >= n) return at(f, 1, rack);
      var k1 = balls[i++], lv1 = minus(rack, k1); fr.balls.push({ pins: rack.length - lv1.length, knocked: k1.slice(), leave: lv1 });
      if (!lv1.length) continue;
      if (i >= n) return at(f, 2, lv1);
      var k2 = balls[i++], lv2 = minus(lv1, k2); fr.balls.push({ pins: lv1.length - lv2.length, knocked: k2.slice(), leave: lv2 });
      continue;
    }
    /* 10th frame: a strike earns two more balls, a spare one; each fresh rack resets */
    var first = null;
    for (var b = 1; b <= 3; b++) {
      if (b === 3) {
        var b1 = fr.balls[0], b2 = fr.balls[1];
        var earned = b1.pins === 10 || (b1.pins < 10 && !b2.leave.length);
        if (!earned) break;
      }
      if (i >= n) return at(10, b, rack);
      var k = balls[i++], lv = minus(rack, k); fr.balls.push({ pins: rack.length - lv.length, knocked: k.slice(), leave: lv });
      if (b === 1) { first = lv; rack = lv.length ? lv : ALL.slice(); }
      else if (b === 2) {
        if (first.length && lv.length) break;          // open 10th: done after two balls
        rack = lv.length ? lv : ALL.slice();
      }
    }
  }
  return { frames: frames, done: true, next: null, used: i };
}
/* standard running totals from pinfall; null where a bonus ball isn't bowled yet */
function scoreStd(frames) {
  var flat = [], start = [];
  frames.forEach(function (fr) { start.push(flat.length); fr.balls.forEach(function (b) { flat.push(b.pins); }); });
  var tot = 0, out = [];
  for (var f = 0; f < frames.length; f++) {
    var fr = frames[f], b = fr.balls, s = start[f], v = null;
    if (f < 9) {
      if (b.length && b[0].pins === 10) v = flat[s + 1] != null && flat[s + 2] != null ? 10 + flat[s + 1] + flat[s + 2] : null;
      else if (b.length === 2) v = b[0].pins + b[1].pins === 10 ? (flat[s + 2] != null ? 10 + flat[s + 2] : null) : b[0].pins + b[1].pins;
    } else {
      var need = b.length && (b[0].pins === 10 || (b[1] && b[0].pins + b[1].pins === 10)) ? 3 : 2;
      if (b.length === need) v = b.reduce(function (a, x) { return a + x.pins; }, 0);
    }
    if (v == null) { for (; f < frames.length; f++) out.push(null); break; }
    tot += v; out.push(tot);
  }
  return out;
}
function scoreOf(balls, format) { var r = buildFrames(balls), t = scoreStd(r.frames); return { frames: r.frames, totals: t, done: r.done, next: r.next, score: r.done ? t[9] : null, partial: t.filter(function (x) { return x != null; }).pop() || 0 }; }
/* marks for the little scorecard: frames 1-9 [box1, box2], 10th [a, b, c] */
function mk(n) { return n === 10 ? 'X' : n === 0 ? '-' : String(n); }
function marks(fr) {
  var b = fr.balls;
  if (fr.n < 10) {
    if (!b.length) return ['', ''];
    if (b[0].pins === 10) return ['', 'X'];
    return [b[0].pins === 0 ? '-' : String(b[0].pins), b[1] ? (b[0].pins + b[1].pins === 10 ? '/' : b[1].pins === 0 ? '-' : String(b[1].pins)) : ''];
  }
  var o = ['', '', ''];
  if (b[0]) o[0] = mk(b[0].pins);
  if (b[1]) o[1] = b[0].pins === 10 ? mk(b[1].pins) : (b[0].pins + b[1].pins === 10 ? '/' : b[1].pins === 0 ? '-' : String(b[1].pins));
  if (b[2]) o[2] = (b[0].pins === 10 && b[1].pins !== 10) ? (b[1].pins + b[2].pins === 10 ? '/' : b[2].pins === 0 ? '-' : String(b[2].pins)) : mk(b[2].pins);
  return o;
}
/* the challenge engine's game shape: { pid, date, key, gameNo, score, leagueID, tournament, open, frames:[{balls:[{pins, leave}]}] | null } */
function normOpen(sessions, chID) {
  var out = {};
  (sessions || []).forEach(function (s) {
    if (s.challengeID !== chID || (s.format || 'standard') !== 'standard') return;
    (s.games || []).forEach(function (g) {
      (s.bowlers || []).forEach(function (bw, bi) {
        var row = g.rows && g.rows[bi]; if (!row) return;
        var item = { pid: bw.pid, date: s.date || '', key: 'c' + s.id + ':' + g.n, gameNo: g.n, score: null, leagueID: null, tournament: false, open: true, frames: null };
        if (row.typed != null && row.typed !== '') { item.score = +row.typed; item.typed = true; }
        else {
          var r = scoreOf(row.balls || [], s.format);
          if (!r.done) return;
          item.score = r.score;
          item.frames = r.frames.map(function (fr) { return { balls: fr.balls.map(function (x) { return { pins: x.pins, leave: x.leave.slice() }; }) }; });
        }
        if (!(item.score >= 0)) return;
        (out[bw.pid] = out[bw.pid] || []).push(item);
      });
    });
  });
  Object.keys(out).forEach(function (k) { out[k].sort(function (a, b) { return (a.date || '').localeCompare(b.date || '') || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); }); });
  return out;
}
/* whose turn: the bowler with the fewest finished frames (ties: card order); typed / finished rows skipped */
function turnOf(session, gi) {
  var g = session.games[gi]; if (!g) return -1;
  var best = -1, bestN = 99;
  session.bowlers.forEach(function (bw, bi) {
    var row = g.rows[bi]; if (!row || row.typed != null) return;
    var r = buildFrames(row.balls || []); if (r.done) return;
    var n = r.next.frame - 1;
    if (n < bestN) { bestN = n; best = bi; }
  });
  return best;
}
function gameDone(session, gi) {
  var g = session.games[gi]; if (!g) return false;
  return session.bowlers.every(function (bw, bi) { var row = g.rows[bi]; return row && (row.typed != null || buildFrames(row.balls || []).done); });
}

var api = { CHPLAY_VERSION: CHPLAY_VERSION, STORE: STORE, FORMATS: FORMATS, buildFrames: buildFrames, scoreStd: scoreStd, scoreOf: scoreOf, marks: marks, normOpen: normOpen, turnOf: turnOf, gameDone: gameDone };
root.BDB_CHPLAY = api; root.CHPLAY_JS_VERSION = CHPLAY_VERSION;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof document === 'undefined') return;

/* ================= page (browser only) ================= */
var cp = { list: null, loading: null, sid: null, gi: 0, bi: -1, sel: [], tab: null };
function escH(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function today() { return typeof root.azToday === 'function' ? root.azToday() : new Date().toISOString().slice(0, 10); }
function toast(t, ms) { if (root.toast) root.toast(t, ms); }
function sheet(html) { root.openModal(html); var mb = document.getElementById('modal-body'); if (mb) mb.scrollTop = 0; }
function chs() { try { var v = JSON.parse(localStorage.getItem('bowlingdb_challenges') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function chOf(id) { return chs().filter(function (c) { return c.id === id; })[0] || null; }
function openChs() { return chs().filter(function (c) { return c.source === 'open'; }); }
function nameOf(pid) { try { return root.chPerson(pid).name; } catch (e) { return pid === 'me' ? 'You' : 'Friend'; } }
function firstOf(pid) { return pid === 'me' ? 'You' : String(nameOf(pid)).split(' ')[0]; }
function avOf(pid, size) { try { return root._fsAvatarHTML(root.chPerson(pid), size || 30); } catch (e) { return ''; } }
function chName(ch) { return ch ? (ch.name || (root.BDB_CHALLENGE && root.BDB_CHALLENGE.CONTESTS[ch.contest] ? root.BDB_CHALLENGE.CONTESTS[ch.contest].name : 'Challenge')) : 'Challenge'; }
function phaseOf(ch) { try { return root.chPhase(ch); } catch (e) { return 'running'; } }

/* ---- storage ---- */
function load() {
  if (cp.list) return Promise.resolve(cp.list);
  if (cp.loading) return cp.loading;
  cp.loading = root.idbGetAll(STORE).then(function (l) { cp.list = l || []; cp.loading = null; return cp.list; }, function () { cp.list = []; cp.loading = null; return cp.list; });
  return cp.loading;
}
function all() { return cp.list || []; }
function sess(id) { return all().filter(function (s) { return s.id === id; })[0] || null; }
function put(s) {
  s.updated = new Date().toISOString();
  var l = all(), i = -1; l.forEach(function (x, k) { if (x.id === s.id) i = k; }); if (i >= 0) l[i] = s; else l.unshift(s);
  return root.idbPutAll(STORE, [JSON.parse(JSON.stringify(s))]).catch(function () { toast('Could not save on this phone'); });
}
function del(id) { cp.list = all().filter(function (s) { return s.id !== id; }); return root.idbDeleteKeys(STORE, [id]); }
function sessionsFor(chID) { return all().filter(function (s) { return s.challengeID === chID; }).sort(function (a, b) { return (b.date || '').localeCompare(a.date || '') || (b.created || '').localeCompare(a.created || ''); }); }
/* what challenge.js reads for an open challenge */
function cpGamesFor(ch) { return normOpen(all(), ch.id); }

/* ---- CSS ---- */
function css() {
  if (document.getElementById('cp-css')) return;
  var st = document.createElement('style'); st.id = 'cp-css';
  st.textContent = [
    '.cp-tabs{display:flex;gap:6px;margin:0 0 12px}',
    '.cp-row{background:var(--bg2);border:1px solid var(--border1);border-radius:12px;padding:8px 10px;margin-bottom:8px;cursor:pointer}',
    '.cp-row.on{border-color:var(--teal);box-shadow:0 0 0 1px rgba(0,217,217,.35)}',
    '.cp-row.done{opacity:.85}',
    '.cp-card{display:grid;grid-template-columns:repeat(9,1fr) 1.45fr;border:1px solid var(--border2);border-radius:8px;overflow:hidden;margin-top:6px}',
    '.cp-f{border-left:1px solid var(--border1);min-width:0}', '.cp-f:first-child{border-left:none}',
    '.cp-f.cur{background:rgba(0,217,217,.10)}',
    '.cp-bx{display:flex;justify-content:flex-end;height:16px;font:800 11px ui-monospace,Menlo,monospace;color:var(--t1)}',
    '.cp-bx span{width:13px;text-align:center;border-left:1px solid var(--border1);border-bottom:1px solid var(--border1);line-height:15px}',
    '.cp-tt{text-align:center;font:800 12px -apple-system,system-ui,sans-serif;color:var(--t2);height:17px;line-height:17px}',
    '.cp-deck{display:flex;flex-direction:column;align-items:center;gap:10px;margin:12px 0 10px}',
    '.cp-deck div{display:flex;gap:14px}',
    '.cp-pin{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:800 15px -apple-system,system-ui,sans-serif;cursor:pointer;user-select:none;-webkit-user-select:none;transition:all .1s}',
    '.cp-pin.st{background:rgba(255,255,255,.08);border:1.5px solid var(--pin-border-stand,#9AAAC8);color:var(--t1)}',
    '.cp-pin.kn{background:rgba(0,217,217,.18);border:1.5px solid var(--teal);color:var(--teal);box-shadow:0 0 14px rgba(0,217,217,.35)}',
    '.cp-pin.gone{background:transparent;border:1.5px dashed var(--border1);color:var(--t3);opacity:.35;cursor:default}',
    '.cp-acts{display:grid;grid-template-columns:1fr 1.2fr 1fr;gap:8px}',
    '.cp-acts button{padding:14px 6px;border-radius:12px;font:800 15px -apple-system,system-ui,sans-serif;border:1px solid var(--border2);background:var(--bg3);color:var(--t1);cursor:pointer}',
    '.cp-acts .go{background:linear-gradient(90deg,var(--teal),var(--purple,#9d4edd));color:#0b0c0e;border:none}',
    '.cp-acts .mark{color:var(--gold);border-color:rgba(255,215,0,.35)}'
  ].join('\n');
  document.head.appendChild(st);
}

/* ---------------- Open Bowling > Challenges tab ---------------- */
function tabsHTML(on) {
  var b = function (k, l) { return '<div class="btn-pill' + (on === k ? ' btn-pill-sel' : '') + '" onclick="openBowlTab(\'' + k + '\')">' + l + '</div>'; };
  return '<div class="cp-tabs">' + b('sessions', 'Sessions') + b('ch', '\ud83c\udfc1 Challenges') + '</div>';
}
function cpRenderOpenTab(el) {
  css();
  el = el || document.getElementById('open-list'); if (!el) return;
  load().then(function () {
    var list = openChs().filter(function (c) { var p = phaseOf(c); return p !== 'declined' && p !== 'cancelled'; });
    var live = list.filter(function (c) { var p = phaseOf(c); return p === 'running' || p === 'upcoming'; });
    var other = list.filter(function (c) { return live.indexOf(c) < 0; });
    var h = '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-bottom:12px">Open challenge games are bowled here and kept out of every stat, average, award and export. Your opponent goes on the same card, or type their score in afterwards.</div>' +
      '<button class="btn btn-primary" style="margin-bottom:12px" onclick="cpNewOpenChallenge()">+ New open challenge</button>';
    if (!list.length) h += '<div class="empty-state"><div class="empty-icon">\ud83c\udfc1</div><div class="empty-label">No open challenges yet</div><div class="empty-sub">Start one, then bowl its games here</div></div>';
    var card = function (ch) {
      var ss = sessionsFor(ch.id), p = phaseOf(ch), can = p === 'running';
      var games = 0; ss.forEach(function (s) { games += (s.games || []).length; });
      var lab = { running: 'Running', upcoming: 'Starts ' + ch.params.start, sent: 'Waiting on them', countered: 'Your move', final: 'Finished' }[p] || p;
      return '<div class="card" style="margin-bottom:10px"><div style="display:flex;align-items:center;gap:10px" onclick="cpOpenChallenge(\'' + ch.id + '\')">' +
        '<div style="display:flex">' + ch.people.filter(function (x) { return x !== 'me'; }).map(function (x) { return avOf(x, 32); }).join('') + (ch.people.length < 2 ? avOf('me', 32) : '') + '</div>' +
        '<div style="flex:1;min-width:0;cursor:pointer"><div style="font-size:14px;font-weight:800;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escH(chName(ch)) + '</div>' +
        '<div style="font-size:11px;color:var(--t3)">' + escH(ch.people.length < 2 ? 'Solo' : 'vs ' + ch.people.filter(function (x) { return x !== 'me'; }).map(nameOf).join(', ')) + ' \u00b7 ' + escH(FORMATS[ch.format || 'standard'].name) + ' \u00b7 ' + games + ' game' + (games === 1 ? '' : 's') + '</div></div>' +
        '<span style="font-size:10px;font-weight:800;color:' + (can ? 'var(--teal)' : 'var(--t3)') + ';border:1px solid currentColor;border-radius:8px;padding:2px 7px;flex-shrink:0">' + escH(lab) + '</span></div>' +
        (ss.length ? '<div style="margin-top:8px">' + ss.slice(0, 4).map(sessLine).join('') + '</div>' : '') +
        (can ? '<button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="cpBowl(\'' + ch.id + '\')">\ud83c\udfb3 Bowl a challenge game</button>' :
          p === 'sent' || p === 'countered' ? '<div style="font-size:11px;color:var(--t3);margin-top:6px">Bowling opens once the challenge is accepted.</div>' : '') + '</div>';
    };
    if (live.length) h += '<div class="sec-header"><span class="sec-title" style="font-size:15px">Running</span></div>' + live.map(card).join('');
    if (other.length) h += '<div class="sec-header" style="margin-top:6px"><span class="sec-title" style="font-size:15px">Waiting / finished</span></div>' + other.map(card).join('');
    el.innerHTML = h;
  });
}
function sessLine(s) {
  var d = (s.date || '').split('-'), when = d.length === 3 ? +d[1] + '/' + +d[2] : '';
  var bits = (s.games || []).map(function (g) {
    return s.bowlers.map(function (bw, bi) { var row = g.rows[bi]; if (!row) return '\u2014'; if (row.typed != null) return row.typed + '*'; var r = scoreOf(row.balls || [], s.format); return r.done ? r.score : r.partial + '\u2026'; }).join('-');
  });
  return '<div onclick="cpResume(\'' + s.id + '\')" style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--t2);padding:5px 0;border-top:1px solid var(--border1);cursor:pointer">' +
    '<span>' + escH(when) + ' \u00b7 ' + escH(s.bowlers.map(function (b) { return firstOf(b.pid); }).join(' v ')) + '</span><span style="font-weight:700;color:var(--t1)">' + escH(bits.join(' \u00b7 ') || 'not started') + ' \u203a</span></div>';
}
function cpNewOpenChallenge() { root._chLoad(function () { root.chNew({ source: 'open' }); }); }
function cpOpenChallenge(id) { root._chLoad(function () { root._cnStartTab = 'challenges'; root._chDetail = id; root.navTo('s-friend-feed'); }); }

/* ---------------- start / continue a session ---------------- */
/* from Connect or the Open Bowling tab: continue today's unfinished session for this challenge, else start one */
function cpBowl(chID) {
  load().then(function () {
    var ch = chOf(chID); if (!ch) { toast('Challenge not found'); return; }
    if (phaseOf(ch) !== 'running') { toast(phaseOf(ch) === 'upcoming' ? 'This challenge starts ' + ch.params.start : 'This challenge isn\u2019t running'); return; }
    var open = sessionsFor(chID).filter(function (s) { return s.date === today(); })[0];
    if (open) return cpResume(open.id);
    startSheet(ch);
  });
}
function startSheet(ch) {
  var d = typeof db !== 'undefined' ? db : root.db, cOpts = (d.centers || []).map(function (c) { return '<option value="' + c.CenterID + '">' + escH(c.CenterName) + '</option>'; }).join('');
  sheet('<div class="modal-title">\ud83c\udfc1 Challenge session</div><div style="font-size:12px;color:var(--t3);margin:-4px 0 12px">' + escH(chName(ch)) + ' \u00b7 ' + escH(FORMATS[ch.format || 'standard'].name) + '. Kept out of your stats.</div>' +
    '<div class="fgroup"><label class="flabel">Date</label><input class="finput" id="cps-date" type="date" value="' + today() + '"></div>' +
    '<div class="fgroup"><label class="flabel">Center</label><select class="finput" id="cps-center"><option value="">\u2014</option>' + cOpts + '</select></div>' +
    '<div class="fgroup"><label class="flabel">Lane</label><input class="finput" id="cps-lane" type="number" min="1" max="99" placeholder="optional"></div>' +
    (ch.people.length > 1 ? '<div class="fgroup"><label class="flabel">Your opponent</label><div class="odd-even-toggle"><div class="oe-btn on" id="cps-with" onclick="cpWith(true)">On this card</div><div class="oe-btn" id="cps-without" onclick="cpWith(false)">Type their scores later</div></div></div>' : '') +
    '<button class="btn btn-primary" onclick="cpStart(\'' + ch.id + '\')">Start bowling \u2192</button><button class="btn btn-secondary" onclick="closeModal()">Cancel</button>');
}
function cpWith(on) { var a = document.getElementById('cps-with'), b = document.getElementById('cps-without'); if (a) a.classList.toggle('on', on); if (b) b.classList.toggle('on', !on); }
function newGame(s, n) { return { n: n, rows: s.bowlers.map(function (bw) { return bw.later ? { balls: [], typed: null, later: true } : { balls: [], typed: null }; }) }; }
function cpStart(chID) {
  var ch = chOf(chID); if (!ch) return;
  var v = function (id) { var e = document.getElementById(id); return e ? e.value : ''; };
  var withEl = document.getElementById('cps-with'), together = !withEl || withEl.classList.contains('on');
  var s = { id: 'cs' + Date.now().toString(36), challengeID: chID, format: ch.format || 'standard', date: v('cps-date') || today(), centerID: v('cps-center') ? +v('cps-center') : null,
    lane: v('cps-lane') ? +v('cps-lane') : null, created: new Date().toISOString(),
    bowlers: ch.people.map(function (pid) { return { pid: pid, name: nameOf(pid), later: pid !== 'me' && !together }; }), games: [] };
  s.games.push(newGame(s, 1));
  put(s).then(function () { root.closeModal(); openScorer(s.id, 0); });
}
function cpResume(id) {
  load().then(function () {
    var s = sess(id); if (!s) return;
    var gi = s.games.length - 1; if (gi < 0) { s.games.push(newGame(s, 1)); gi = 0; put(s); }
    openScorer(id, gi);
  });
}
function openScorer(id, gi) { cp.sid = id; cp.gi = gi; cp.bi = -1; cp.sel = []; root.navTo('s-chplay'); }

/* ---------------- the scorecard screen ---------------- */
function cur() { return sess(cp.sid); }
function rowState(s, gi, bi) { var row = s.games[gi].rows[bi]; return row.typed != null ? { typed: row.typed } : scoreOf(row.balls || [], s.format); }
function cpRenderScorer() {
  css();
  var el = document.getElementById('cp-root'); if (!el) return;
  load().then(function () {
    var s = cur(); if (!s) { el.innerHTML = '<div style="color:var(--t3)">Session not found.</div>'; return; }
    var ch = chOf(s.challengeID), g = s.games[cp.gi];
    if (!g) { cp.gi = s.games.length - 1; g = s.games[cp.gi]; }
    var done = gameDone(s, cp.gi);
    if (cp.bi < 0 || !g.rows[cp.bi] || g.rows[cp.bi].typed != null || g.rows[cp.bi].later || rowState(s, cp.gi, cp.bi).done) cp.bi = turnOfLive(s, cp.gi);
    var h = (root.bdbTestGcHTML ? root.bdbTestGcHTML() : '') +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><div style="flex:1;min-width:0"><div style="font-size:16px;font-weight:900;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\ud83c\udfc1 ' + escH(chName(ch)) + '</div>' +
      '<div style="font-size:11px;color:var(--t3)">Game ' + g.n + ' \u00b7 ' + escH(FORMATS[s.format || 'standard'].name) + ' \u00b7 not in your stats</div></div>' +
      '<div style="display:flex;gap:4px">' + s.games.map(function (x, i) { return '<div class="btn-pill' + (i === cp.gi ? ' btn-pill-sel' : '') + '" onclick="cpGame(' + i + ')">G' + x.n + '</div>'; }).join('') + '</div></div>';
    s.bowlers.forEach(function (bw, bi) { h += rowHTML(s, cp.gi, bi); });
    if (done) h += doneHTML(s, ch);
    else if (cp.bi >= 0) h += deckHTML(s, cp.gi, cp.bi);
    else h += '<div class="card" style="font-size:13px;color:var(--t2)">Your game is in. Type your opponent\u2019s score now (tap \u22ef on their row) or later from this session.' +
      '<button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="cpNextGame()">Next game</button></div>';
    h += '<div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-ghost btn-sm" style="flex:1" onclick="cpBackToChallenge()">\u2039 Challenge</button>' +
      '<button class="btn btn-ghost btn-sm" style="flex:1" onclick="cpSessionMenu()">\u22ef Session</button></div>';
    el.innerHTML = h;
  });
}
function turnOfLive(s, gi) {
  var g = s.games[gi], best = -1, bestN = 99;
  s.bowlers.forEach(function (bw, bi) { var row = g.rows[bi]; if (!row || row.typed != null || row.later) return; var r = buildFrames(row.balls || []); if (r.done) return; var n = r.next.frame - 1; if (n < bestN) { bestN = n; best = bi; } });
  return best;
}
function rowHTML(s, gi, bi) {
  var bw = s.bowlers[bi], row = s.games[gi].rows[bi], on = bi === cp.bi, st = rowState(s, gi, bi);
  var head = '<div style="display:flex;align-items:center;gap:8px">' + avOf(bw.pid, 26) + '<div style="flex:1;min-width:0;font-size:13px;font-weight:800;color:var(--t1)">' + escH(bw.name || nameOf(bw.pid)) + '</div>' +
    '<div style="font-size:18px;font-weight:900;color:' + (st.done || st.typed != null ? 'var(--gold)' : 'var(--t1)') + '">' + (st.typed != null ? escH(st.typed) : st.done ? st.score : st.partial || '') + '</div>' +
    (bw.pid !== 'me' ? '<div onclick="cpRowMenu(' + bi + ');event.stopPropagation()" style="padding:2px 6px;color:var(--t3);cursor:pointer;font-weight:900">\u22ef</div>' : '') + '</div>';
  if (st.typed != null) return '<div class="cp-row done">' + head + '<div style="font-size:11px;color:var(--t3);margin-top:4px">Typed score: counts in score contests, not pin contests.</div></div>';
  if (row.later && !(row.balls || []).length) return '<div class="cp-row done">' + head + '<div style="font-size:11px;color:var(--t3);margin-top:4px">Score to be typed in: tap \u22ef.</div></div>';
  var frames = st.frames, next = st.next ? st.next.frame : 0;
  var cells = '';
  for (var f = 1; f <= 10; f++) {
    var fr = frames[f - 1] || { n: f, balls: [] }, m = marks(fr), t = st.totals[f - 1];
    cells += '<div class="cp-f' + (on && next === f ? ' cur' : '') + '"><div class="cp-bx">' + m.map(function (x) { return '<span>' + escH(x) + '</span>'; }).join('') + '</div><div class="cp-tt">' + (t != null ? t : '') + '</div></div>';
  }
  return '<div class="cp-row' + (on ? ' on' : '') + (st.done ? ' done' : '') + '" onclick="cpPick(' + bi + ')">' + head + '<div class="cp-card">' + cells + '</div></div>';
}
function deckHTML(s, gi, bi) {
  var st = rowState(s, gi, bi), nx = st.next, rack = nx.rack, sel = cp.sel;
  var pin = function (p) { var inR = rack.indexOf(p) >= 0, k = sel.indexOf(p) >= 0; return '<div class="cp-pin ' + (!inR ? 'gone' : k ? 'kn' : 'st') + '"' + (inR ? ' onclick="cpTap(' + p + ')"' : '') + '>' + p + '</div>'; };
  var fresh = rack.length === 10, all = fresh ? 'Strike X' : 'Spare /';
  return '<div class="card" style="margin-top:4px;padding:12px">' +
    '<div style="font-size:12px;color:var(--t2);text-align:center"><b style="color:var(--t1)">' + escH(firstOf(s.bowlers[bi].pid)) + '</b> \u00b7 frame ' + nx.frame + ' \u00b7 ball ' + nx.ball + ' \u00b7 tap the pins knocked down</div>' +
    '<div class="cp-deck"><div>' + [7, 8, 9, 10].map(pin).join('') + '</div><div>' + [4, 5, 6].map(pin).join('') + '</div><div>' + [2, 3].map(pin).join('') + '</div><div>' + pin(1) + '</div></div>' +
    '<div class="cp-acts"><button onclick="cpBall(\'miss\')">Gutter \u2014</button><button class="go" onclick="cpBall(\'sel\')">Enter ' + sel.length + ' \u2192</button><button class="mark" onclick="cpBall(\'all\')">' + all + '</button></div>' +
    '<div style="display:flex;justify-content:center;margin-top:10px"><div class="btn-pill" onclick="cpUndo()">\u21b6 Undo last ball</div></div></div>';
}
function doneHTML(s, ch) {
  var g = s.games[cp.gi], sc = s.bowlers.map(function (bw, bi) { var st = rowState(s, cp.gi, bi); return { pid: bw.pid, v: st.typed != null ? +st.typed : st.score }; });
  var best = Math.max.apply(null, sc.map(function (x) { return x.v; }));
  var stand = '';
  try { stand = root.chMiniStandingsHTML ? root.chMiniStandingsHTML(s.challengeID) : ''; } catch (e) { stand = ''; }
  return '<div class="card card-best" style="margin-top:6px;text-align:center"><div style="font-size:12px;font-weight:800;color:var(--gold);letter-spacing:.06em">GAME ' + g.n + ' DONE</div>' +
    '<div style="display:flex;justify-content:center;gap:18px;margin-top:6px">' + sc.map(function (x) { return '<div><div style="font-size:11px;color:var(--t3)">' + escH(firstOf(x.pid)) + '</div><div style="font-size:24px;font-weight:900;color:' + (x.v === best && sc.length > 1 ? 'var(--gold)' : 'var(--t1)') + '">' + x.v + '</div></div>'; }).join('') + '</div></div>' +
    stand +
    '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-primary" style="flex:1" onclick="cpNextGame()">Next game</button><button class="btn btn-secondary" style="flex:1" onclick="cpBackToChallenge()">Done</button></div>';
}
function cpPick(bi) { var s = cur(); if (!s) return; var row = s.games[cp.gi].rows[bi]; if (!row || row.typed != null) return; if (row.later && !(row.balls || []).length) return cpRowMenu(bi); if (buildFrames(row.balls || []).done) return; cp.bi = bi; cp.sel = []; cpRenderScorer(); }
function cpTap(p) { var i = cp.sel.indexOf(p); if (i >= 0) cp.sel.splice(i, 1); else cp.sel.push(p); cpRenderScorer(); }
function cpBall(how) {
  var s = cur(); if (!s || cp.bi < 0) return;
  var row = s.games[cp.gi].rows[cp.bi], st = buildFrames(row.balls || []); if (st.done) return;
  var rack = st.next.rack, k = how === 'all' ? rack.slice() : how === 'miss' ? [] : cp.sel.filter(function (p) { return rack.indexOf(p) >= 0; });
  k.sort(function (a, b) { return a - b; });
  row.balls = (row.balls || []).concat([k]); row.later = false; cp.sel = [];
  var after = buildFrames(row.balls), frameEnded = after.done || after.next.frame !== st.next.frame;
  if (frameEnded) cp.bi = turnOfLive(s, cp.gi);
  put(s); cpRenderScorer();
}
function cpUndo() {
  var s = cur(); if (!s) return;
  var g = s.games[cp.gi], bi = cp.bi;
  if (bi < 0 || !(g.rows[bi].balls || []).length) {   // nothing on the active row: undo the last ball bowled on the card
    var last = -1, lastN = -1; g.rows.forEach(function (r, i) { var n = (r.balls || []).length; if (r.typed == null && n && n >= lastN) { last = i; lastN = n; } }); bi = last;
  }
  if (bi < 0) return;
  g.rows[bi].balls.pop(); cp.bi = bi; cp.sel = []; put(s); cpRenderScorer();
}
function cpGame(i) { cp.gi = i; cp.bi = -1; cp.sel = []; cpRenderScorer(); }
function cpNextGame() { var s = cur(); if (!s) return; s.games.push(newGame(s, s.games.length + 1)); cp.gi = s.games.length - 1; cp.bi = -1; cp.sel = []; put(s); cpRenderScorer(); }
function cpBackToChallenge() { var s = cur(); if (!s) return; cpOpenChallenge(s.challengeID); }
/* opponent row: type a score instead of bowling it here */
function cpRowMenu(bi) {
  var s = cur(); if (!s) return; var row = s.games[cp.gi].rows[bi], bw = s.bowlers[bi];
  sheet('<div class="modal-title">' + escH(bw.name || nameOf(bw.pid)) + ' \u00b7 game ' + s.games[cp.gi].n + '</div>' +
    '<div style="font-size:12px;color:var(--t3);margin:-4px 0 10px;line-height:1.5">Type the score if they bowled it without this card. A typed score counts in score contests (high game, total pins, average, first to a score), not in pin contests.</div>' +
    '<div class="fgroup"><label class="flabel">Score</label><input class="finput" id="cpt-score" type="number" min="0" max="300" value="' + (row.typed != null ? escH(row.typed) : '') + '"></div>' +
    '<div id="cpt-err" style="font-size:12px;color:var(--red);margin-bottom:8px"></div>' +
    '<button class="btn btn-primary" onclick="cpTypeSave(' + bi + ')">Save score</button>' +
    (row.typed != null ? '<button class="btn btn-ghost" style="margin-top:8px" onclick="cpTypeClear(' + bi + ')">Bowl it on the card instead</button>' : '') +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>');
}
function cpTypeSave(bi) {
  var v = (document.getElementById('cpt-score') || {}).value, n = parseInt(v, 10), e = document.getElementById('cpt-err');
  if (!(n >= 0 && n <= 300)) { if (e) e.textContent = 'Type a score from 0 to 300'; return; }
  var s = cur(); var row = s.games[cp.gi].rows[bi]; row.typed = n; row.balls = []; row.later = false;
  put(s); root.closeModal(); cp.bi = -1; cpRenderScorer();
}
function cpTypeClear(bi) { var s = cur(); var row = s.games[cp.gi].rows[bi]; row.typed = null; row.later = false; put(s); root.closeModal(); cp.bi = bi; cpRenderScorer(); }
function cpSessionMenu() {
  var s = cur(); if (!s) return;
  sheet('<div class="modal-title">Challenge session</div><div style="font-size:12px;color:var(--t3);margin:-4px 0 12px">' + escH(s.date) + ' \u00b7 ' + s.games.length + ' game' + (s.games.length === 1 ? '' : 's') + '</div>' +
    (s.games.length > 1 || (s.games[0] && s.games[0].rows.some(function (r) { return (r.balls || []).length || r.typed != null; })) ? '<button class="btn btn-ghost" onclick="cpDelGameAsk()">Delete game ' + s.games[cp.gi].n + '</button>' : '') +
    '<button class="btn btn-ghost" style="margin-top:8px;color:var(--red)" onclick="cpDelSessAsk()">Delete this session</button>' +
    '<button class="btn btn-secondary" style="margin-top:8px" onclick="closeModal()">Close</button>');
}
function cpDelGameAsk() { sheet('<div class="modal-title">Delete game ' + cur().games[cp.gi].n + '?</div><div style="font-size:13px;color:var(--t2);margin-bottom:14px">Its balls are removed from this challenge. Nothing else is touched.</div><button class="btn" style="background:var(--red);color:#fff;font-weight:700;width:100%;margin-bottom:8px" onclick="cpDelGame()">Delete game</button><button class="btn btn-secondary" onclick="closeModal()">Cancel</button>'); }
function cpDelGame() {
  var s = cur(); s.games.splice(cp.gi, 1); s.games.forEach(function (g, i) { g.n = i + 1; });
  if (!s.games.length) s.games.push(newGame(s, 1));
  cp.gi = Math.min(cp.gi, s.games.length - 1); cp.bi = -1; put(s); root.closeModal(); cpRenderScorer();
}
function cpDelSessAsk() { sheet('<div class="modal-title">Delete this session?</div><div style="font-size:13px;color:var(--t2);margin-bottom:14px">Every game in it leaves the challenge. Your stats are not affected (these games were never in them).</div><button class="btn" style="background:var(--red);color:#fff;font-weight:700;width:100%;margin-bottom:8px" onclick="cpDelSess()">Delete session</button><button class="btn btn-secondary" onclick="closeModal()">Cancel</button>'); }
function cpDelSess() { var s = cur(), ch = s.challengeID; del(s.id).then(function () { root.closeModal(); cp.sid = null; root._openTab = 'ch'; root.navTo('s-open'); }); }

root.cpRenderOpenTab = cpRenderOpenTab; root.cpTabsHTML = tabsHTML; root.cpRenderScorer = cpRenderScorer; root.cpLoadSessions = load; root.cpGamesFor = cpGamesFor;
root.cpSessionsFor = sessionsFor; root.cpBowl = cpBowl; root.cpResume = cpResume; root.cpStart = cpStart; root.cpWith = cpWith; root.cpPick = cpPick; root.cpTap = cpTap; root.cpBall = cpBall; root.cpUndo = cpUndo;
root.cpGame = cpGame; root.cpNextGame = cpNextGame; root.cpBackToChallenge = cpBackToChallenge; root.cpRowMenu = cpRowMenu; root.cpTypeSave = cpTypeSave; root.cpTypeClear = cpTypeClear;
root.cpSessionMenu = cpSessionMenu; root.cpDelGameAsk = cpDelGameAsk; root.cpDelGame = cpDelGame; root.cpDelSessAsk = cpDelSessAsk; root.cpDelSess = cpDelSess;
root.cpNewOpenChallenge = cpNewOpenChallenge; root.cpOpenChallenge = cpOpenChallenge; root._cp = cp;
})(typeof window !== 'undefined' ? window : globalThis);
