/* BowlingDB Connect hub -- v30.240 SOC-1 step 1 (design: DESIGN_social_1.md rev 3).
   Preview on this phone's own data: Feed (you + friends, newest first), You (your posts, visibility,
   hide / take down, quick post), a friend's activity, reactions (fist bump, high five, on fire, strike).
   Friends = Team Bowl teammates (their games are recorded by you); with none, sample people.
   Nothing leaves the phone: no account, no server yet. Posts carry the share card's "card facts".
   Storage: bowlingdb_connect_posts (your posts), bowlingdb_connect_reacts (your reactions).
   Loaded by index.html as connect.js?v=APP_VERSION on first use. */
(function (root) {
'use strict';
var CONNECT_VERSION = 'v30.240';
var POSTS_KEY = 'bowlingdb_connect_posts', REACT_KEY = 'bowlingdb_connect_reacts';
var REACTIONS = [
  { e: '\ud83d\udc4a', name: 'Fist bump' }, { e: '\ud83d\ude4c', name: 'High five' },
  { e: '\ud83d\udd25', name: 'On fire' }, { e: '\ud83c\udfb3', name: 'Strike!' }];
var VIS = { friends: 'Friends', league: 'League', me: 'Only me' };
var cn = { tab: 'feed', filter: 'all', friend: null };

function load(k, fb) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? fb : v; } catch (e) { return fb; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { if (root.toast) root.toast('Could not save on this phone'); return false; } }
function posts() { var p = load(POSTS_KEY, []); return Array.isArray(p) ? p : []; }
function reacts() { var r = load(REACT_KEY, {}); return r && typeof r === 'object' ? r : {}; }
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function DB() { try { return typeof db !== 'undefined' ? db : root.db; } catch (e) { return root.db; } }
function today() { return typeof root.azToday === 'function' ? root.azToday() : new Date().toISOString().slice(0, 10); }
function daysAgo(dateStr) {
  if (!dateStr) return 0;
  var d = new Date(dateStr.length === 10 ? dateStr + 'T12:00:00' : dateStr), t = new Date(today() + 'T12:00:00');
  return Math.max(0, (t - d) / 86400000);
}
function ago(dateStr, exact) {
  if (exact) { var mins = (Date.now() - new Date(dateStr).getTime()) / 60000; if (mins < 60) return mins < 1 ? 'Just now' : Math.floor(mins) + 'm ago'; if (mins < 1440) return Math.floor(mins / 60) + 'h ago'; }
  var d = daysAgo(dateStr);
  if (d < 1) return 'Today'; if (d < 2) return 'Yesterday'; if (d < 7) return Math.floor(d) + 'd ago';
  var p = (dateStr || '').slice(0, 10).split('-'); return +p[1] + '/' + +p[2] + '/' + p[0].slice(2);
}
function profile() {
  var p = typeof root.fsGetProfile === 'function' ? root.fsGetProfile() : { name: 'You', avatar: '\ud83c\udfb3', color: 'var(--teal)' };
  if (p.name === 'You') { var me = (DB().bowlers || []).filter(function (b) { return b.IsMe; })[0]; if (me && me.Name) p = Object.assign({}, p, { name: me.Name }); }   // no Connect name yet: the IsMe bowler
  return p;
}
function avatar(p, size) { return typeof root._fsAvatarHTML === 'function' ? root._fsAvatarHTML(p, size) : ''; }
function friends() { try { return root.fsFriendsSource(); } catch (e) { return []; } }
function usingSample() { try { return root.fsFriendsSource() === root.FS_MOCK_FRIENDS || friends().some(function (f) { return /^f\d$/.test(f.id); }); } catch (e) { return false; } }
function friendPosts() {
  var src = []; try { src = root.fsPostsSource() || []; } catch (e) {}
  return src.map(function (p) {
    var at = p.date || null;
    if (!at) { var d = new Date(today() + 'T12:00:00'); d.setTime(d.getTime() - (p.daysAgo || 0) * 86400000); at = d.toISOString().slice(0, 10); }
    return { id: p.id, who: p.friendId, at: at, exact: false, kind: 'friend', p: p };
  });
}

/* ---------------- posting (also called from the share card sheet) ---------------- */
function refOf(f) { return f.kind === 'game' ? f.gameID : f.kind === 'league' ? f.leagueID : f.kind === 'season' ? f.seasonID : f.seriesID; }
function cnPost(facts, vis) {
  if (!facts) return false;
  var list = posts(), ref = refOf(facts), hit = list.filter(function (p) { return p.kind === facts.kind && p.ref === ref; })[0];
  var snap = JSON.parse(JSON.stringify(facts));
  if (hit) { hit.facts = snap; hit.hidden = false; if (vis) hit.vis = vis; }
  else list.unshift({ id: 'p' + Date.now().toString(36), at: new Date().toISOString(), kind: facts.kind, ref: ref, facts: snap, vis: vis || 'friends', hidden: false });
  if (!save(POSTS_KEY, list)) return false;
  if (root.toast) root.toast(hit ? 'Already posted: updated in Connect' : 'Posted to Connect (' + VIS[vis || 'friends'] + ')');
  return true;
}
function cnSetVis(id, v) { var l = posts(); l.forEach(function (p) { if (p.id === id) p.vis = v; }); save(POSTS_KEY, l); render(); }
function cnHide(id) { var l = posts(); l.forEach(function (p) { if (p.id === id) p.hidden = !p.hidden; }); save(POSTS_KEY, l); render(); }
function cnTakeDown(id) {
  (root.openModal)('<div class="modal-title">Take down this post?</div><div style="font-size:13px;color:var(--t2);margin-bottom:14px;line-height:1.5">It leaves Connect. Your games are not touched.</div>' +
    '<button class="btn" style="background:var(--red);color:#fff;font-weight:700;width:100%;margin-bottom:8px" onclick="cnTakeDownYes(\'' + id + '\')">Take down</button>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>');
}
function cnTakeDownYes(id) {
  save(POSTS_KEY, posts().filter(function (p) { return p.id !== id; }));
  var r = reacts(); delete r[id]; save(REACT_KEY, r);
  if (root.closeModal) root.closeModal(); render();
}
function cnQuickPost(seriesID) {
  var S = root.BDB_SHARE;
  var go = function () {
    var d = DB(), f = root.BDB_SHARE.seriesFacts({ series: d.series, games: d.games, frames: d.frames, attempts: d.attempts, leaves: d.leaves, balls: d.balls, leagues: d.leagues, tournaments: d.tournaments, centers: d.centers, bowlers: d.bowlers, openSessions: d.openSessions }, seriesID, ctx());
    if (!f) { if (root.toast) root.toast('This series has no card'); return; }
    cnPost(f, 'friends'); render();
  };
  if (S) go(); else if (typeof root._shrLoad === 'function') root._shrLoad(go);
}
function ctx() {
  var d = DB(), entry = {};
  try { (d.leagues || []).forEach(function (l) { var c = root.hdcpGet(root.hdcpLeagueKey(l.LeagueID)); if (c && c.entryAvg != null) entry[l.LeagueID] = c.entryAvg; }); } catch (e) {}
  return { hdcpFor: root.hdcpForSeries, entryAvg: entry };
}

/* ---------------- reactions ---------------- */
function cnReact(postId, i) {
  var r = reacts(), e = REACTIONS[i].e;
  if (r[postId] === e) delete r[postId]; else r[postId] = e;
  save(REACT_KEY, r); render();
}
function reactBar(postId, seed) {
  var mine = reacts()[postId] || null, counts = {};
  (seed || []).forEach(function (s) { counts[s] = (counts[s] || 0) + 1; });
  if (mine) counts[mine] = (counts[mine] || 0) + 1;
  return '<div style="display:flex;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border1);flex-wrap:wrap">' +
    REACTIONS.map(function (x, i) {
      var on = mine === x.e, c = counts[x.e] || 0;
      return '<button onclick="cnReact(\'' + postId + '\',' + i + ');event.stopPropagation()" title="' + x.name + '" style="display:flex;align-items:center;gap:4px;background:' + (on ? 'rgba(0,217,217,0.15)' : 'var(--bg3)') +
        ';border:1px solid ' + (on ? 'var(--teal)' : 'var(--border1)') + ';border-radius:20px;padding:4px 10px;cursor:pointer;color:' + (on ? 'var(--teal)' : 'var(--t2)') + ';font-size:13px;font-weight:700">' +
        '<span style="font-size:16px">' + x.e + '</span>' + (c ? c : '') + '</button>';
    }).join('') + '</div>';
}

/* ---------------- post cards (drawn natively from card facts) ---------------- */
function pills(list) {
  return (list || []).length ? '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' + list.map(function (p) {
    return '<span class="pill ' + (p.tone === 'notap' ? '' : 'pill-gold') + '" style="' + (p.tone === 'notap' ? 'color:var(--bar-notap);border-color:var(--bar-notap)' : '') + '">' + esc(p.text) + '</span>'; }).join('') + '</div>' : '';
}
function chips(scores) { return scores.map(function (g) { return '<span style="font-size:12px;font-weight:700;color:var(--t2);background:var(--bg3);padding:3px 8px;border-radius:8px">' + g + '</span>'; }).join(''); }
function bodyFor(f) {
  var big = function (v, lbl, gold) { return '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:8px"><div style="font-size:11px;color:var(--t3);font-weight:700;letter-spacing:.04em">' + lbl + '</div><div style="font-size:26px;font-weight:900;line-height:1;color:' + (gold ? 'var(--gold)' : 'var(--t1)') + '">' + v + '</div></div>'; };
  var gold = f.pills && f.pills.length && f.pills[0].tone === 'gold';
  if (f.kind === 'series') {
    var vs = f.vsAvg != null ? '<div style="font-size:11px;color:' + (f.vsAvg >= 0 ? 'var(--teal)' : 'var(--red)') + ';margin-top:6px">' + (f.vsAvg > 0 ? '+' : '') + f.vsAvg + ' vs ' + f.avgIn + ' average' + (f.hdcpTotal != null ? ' \u00b7 <span style="color:var(--gold)">HDCP ' + f.hdcpTotal + '</span>' : '') + '</div>' : '';
    return '<div style="display:flex;align-items:center;justify-content:space-between"><div style="display:flex;gap:6px;flex-wrap:wrap">' + chips(f.scores) + '</div>' +
      '<div style="font-size:24px;font-weight:900;color:' + (gold ? 'var(--gold)' : 'var(--t1)') + '">' + f.total + '</div></div>' + vs;
  }
  if (f.kind === 'game') {
    var marks = f.frames ? '<div style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--t2);margin-top:6px;letter-spacing:.02em">' + f.frames.map(function (x) { return x.marks.join('') || '-'; }).join(' \u00b7 ') + '</div>' : '';
    return big(f.score, (f.noTap ? 'NO-TAP ' : '') + 'GAME ' + f.gameNumber + (f.gamesInSeries > 1 ? ' OF ' + f.gamesInSeries : ''), gold) + marks;
  }
  if (f.kind === 'league') return big(f.avg, 'LEAGUE AVERAGE \u00b7 ' + f.games + ' GAMES', gold) +
    '<div style="font-size:11px;color:var(--t3);margin-top:6px">High game ' + f.highGame + ' \u00b7 high series ' + f.highSeries + (f.strikePct != null ? ' \u00b7 strikes ' + f.strikePct + '%' : '') + '</div>';
  if (f.kind === 'season') return big(f.avg, 'SEASON AVERAGE \u00b7 ' + f.games + ' GAMES', gold) +
    '<div style="margin-top:6px">' + f.rows.slice(0, 3).map(function (r) { return '<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--t2);padding:2px 0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.name) + '</span><b style="color:var(--t1);margin-left:8px">' + r.avg + '</b></div>'; }).join('') + (f.rows.length > 3 ? '<div style="font-size:11px;color:var(--t3)">+' + (f.rows.length - 3) + ' more</div>' : '') + '</div>';
  return '';
}
function whereOf(f) {
  var w = f.kind === 'season' ? f.seasonLabel : f.league || (f.level === 'open' ? 'Open play' : f.level === 'notap' ? 'No-Tap' : '');
  return w + (f.center ? ' \u00b7 ' + f.center : '');
}
function openFacts(post) {
  var f = post.facts;
  if (f.kind === 'game') return 'shrLaunchGame(' + f.gameID + ')';
  if (f.kind === 'league') return 'shrLaunchLeague(' + f.leagueID + ')';
  if (f.kind === 'season') return '_shrLoad(function(){shrOpenSeason(' + f.seasonID + ')})';
  return 'shrLaunch(' + f.seriesID + ')';
}
function myCard(post, manage) {
  var me = profile(), f = post.facts;
  var visPill = '<span style="font-size:10px;font-weight:700;color:var(--t3);border:1px solid var(--border2);border-radius:8px;padding:1px 6px;margin-left:6px">' + VIS[post.vis] + (post.hidden ? ' \u00b7 hidden' : '') + '</span>';
  var mg = manage ? '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">' +
    Object.keys(VIS).map(function (k) { return '<div class="btn-pill' + (post.vis === k ? ' btn-pill-sel' : '') + '" onclick="cnSetVis(\'' + post.id + '\',\'' + k + '\')">' + VIS[k] + '</div>'; }).join('') +
    '<div class="btn-pill" onclick="cnHide(\'' + post.id + '\')">' + (post.hidden ? 'Show' : 'Hide') + '</div>' +
    '<div class="btn-pill" style="color:var(--red)" onclick="cnTakeDown(\'' + post.id + '\')">Take down</div></div>' : '';
  return '<div class="card ' + (f.pills && f.pills.length ? 'card-best' : 'card-complete') + '" style="margin-bottom:12px' + (post.hidden ? ';opacity:.55' : '') + '">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' + avatar(me, 38) +
    '<div style="min-width:0;flex:1"><div style="font-weight:700;font-size:14px;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(me.name) + visPill + '</div>' +
    '<div style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(whereOf(f)) + '</div></div>' +
    '<div style="font-size:11px;color:var(--t3);flex-shrink:0">' + ago(post.at, true) + '</div></div>' +
    pills(f.pills) + '<div onclick="' + openFacts(post) + '" style="cursor:pointer">' + bodyFor(f) + '</div>' +
    reactBar(post.id) + mg + '</div>';
}
function friendCard(item) {
  var p = item.p, fr = friends().filter(function (x) { return x.id === p.friendId; })[0] || { name: 'Friend', avatar: '\ud83c\udfb3', color: 'var(--teal)' };
  var total = p.games.reduce(function (a, b) { return a + b; }, 0);
  var seed = (p.acks || []).filter(function (a) { return a !== 'me'; }).map(function () { return '\ud83d\ude4c'; });
  return '<div class="card ' + (p.headline ? 'card-best' : 'card-complete') + '" style="margin-bottom:12px">' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><div onclick="cnFriend(\'' + p.friendId + '\')" style="cursor:pointer">' + avatar(fr, 38) + '</div>' +
    '<div style="min-width:0;flex:1" onclick="cnFriend(\'' + p.friendId + '\')"><div style="font-weight:700;font-size:14px;color:var(--t1)">' + esc(fr.name) + '</div>' +
    '<div style="font-size:11px;color:var(--t3)">' + esc(p.league || '') + (p.center ? ' \u00b7 ' + esc(p.center) : '') + '</div></div>' +
    '<div style="font-size:11px;color:var(--t3);flex-shrink:0">' + ago(item.at) + '</div></div>' +
    (p.headline ? '<div style="margin-bottom:8px"><span class="pill pill-gold">' + esc(p.headline) + '</span></div>' : '') +
    '<div style="display:flex;align-items:center;justify-content:space-between"><div style="display:flex;gap:6px;flex-wrap:wrap">' + chips(p.games) + '</div>' +
    '<div style="font-size:22px;font-weight:900;color:' + (p.headline ? 'var(--gold)' : 'var(--t1)') + '">' + total + '</div></div>' +
    reactBar(p.id, seed) + '</div>';
}

/* ---------------- screens ---------------- */
function tabs() {
  var t = function (k, l) { var on = cn.tab === k && !cn.friend; return '<div onclick="cnTab(\'' + k + '\')" style="flex:1;text-align:center;padding:9px 0;font-size:13px;font-weight:800;cursor:pointer;border-bottom:2px solid ' + (on ? 'var(--teal)' : 'transparent') + ';color:' + (on ? 'var(--teal)' : 'var(--t2)') + '">' + l + '</div>'; };
  return '<div style="display:flex;margin:0 0 14px;border-bottom:1px solid var(--border1)">' + t('feed', 'Feed') + t('you', 'You') + t('challenges', 'Challenges') + '</div>';
}
function banner() {
  return '<div style="background:rgba(0,217,217,0.06);border:1px solid rgba(0,217,217,0.2);border-radius:12px;padding:9px 12px;margin-bottom:14px;font-size:11px;color:var(--t2);line-height:1.5">' +
    '\ud83d\udee0\ufe0f <b>Preview on this phone.</b> Posts and reactions stay here until accounts and friends by invite arrive. ' +
    (usingSample() ? 'The other people are sample bowlers.' : 'Friends are your Team Bowl teammates; their games are the ones you recorded.') + '</div>';
}
function feedHTML() {
  var mine = posts().filter(function (p) { return !p.hidden && p.vis !== 'me'; }).map(function (p) { return { id: p.id, who: 'me', at: p.at, exact: true, kind: 'mine', post: p }; });
  var theirs = friendPosts();
  var items = cn.filter === 'you' ? mine : cn.filter === 'friends' ? theirs : mine.concat(theirs);
  items.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });   // newest first
  var chip = function (k, l) { return '<div class="btn-pill' + (cn.filter === k ? ' btn-pill-sel' : '') + '" onclick="cnFilter(\'' + k + '\')">' + l + '</div>'; };
  return '<div style="display:flex;gap:6px;margin-bottom:12px">' + chip('all', 'All') + chip('friends', 'Friends') + chip('you', 'You') + '</div>' +
    (items.length ? items.map(function (it) { return it.kind === 'mine' ? myCard(it.post, false) : friendCard(it); }).join('') :
      '<div class="empty-state"><div class="empty-icon">\ud83e\udd1d</div><div class="empty-label">Nothing here yet</div><div class="empty-sub">Post a night from the You tab or any Share sheet</div></div>');
}
function recentUnposted(n) {
  var d = DB(), posted = {}; posts().forEach(function (p) { if (p.kind === 'series') posted[p.ref] = 1; });
  var bySeries = {};
  (d.games || []).forEach(function (g) { if (g.FinalScore > 0 && !g.IsTeammate) (bySeries[g.SeriesID] = bySeries[g.SeriesID] || []).push(g); });
  return (d.series || []).filter(function (s) { return bySeries[s.SeriesID] && !posted[s.SeriesID] && (typeof root.shrEligible !== 'function' || root.shrEligible(s.SeriesID)); })
    .sort(function (a, b) { return String(b.DateBowled || '').localeCompare(String(a.DateBowled || '')); }).slice(0, n)
    .map(function (s) {
      var lg = (d.leagues || []).filter(function (l) { return l.LeagueID === s.LeagueID; })[0], tn = s.TournamentID != null ? (d.tournaments || []).filter(function (t) { return t.TournamentID === s.TournamentID; })[0] : null;
      var gs = bySeries[s.SeriesID].sort(function (a, b) { return (a.GameNumber || 0) - (b.GameNumber || 0); }).map(function (g) { return g.FinalScore; });
      return { id: s.SeriesID, date: s.DateBowled, where: tn ? tn.TournamentName : lg && lg.LeagueID > 0 ? lg.LeagueName : (s.NoTap || s.LeagueID === -1 ? 'No-Tap' : 'Open play'), games: gs };
    });
}
function youHTML() {
  var me = profile(), list = posts();
  var head = '<div class="stat-card" style="margin-bottom:14px"><div style="display:flex;align-items:center;gap:12px">' +
    '<div onclick="openBowlerProfile(\'me\')" style="cursor:pointer">' + avatar(me, 48) + '</div>' +
    '<div style="flex:1;min-width:0"><div onclick="fsEditProfileName()" style="font-size:16px;font-weight:800;color:var(--t1);cursor:pointer">' + esc(me.name) + ' <span style="font-size:11px;color:var(--t3);font-weight:500">\u270f\ufe0f</span></div>' +
    '<div style="font-size:11px;color:var(--t3);margin-top:2px">' + list.length + ' post' + (list.length === 1 ? '' : 's') + ' \u00b7 ' + friends().length + ' friend' + (friends().length === 1 ? '' : 's') + '</div></div>' +
    '<button class="btn btn-ghost btn-sm" style="width:auto" onclick="cnInvite()">+ Invite</button></div></div>';
  var rec = '<div class="stat-card" style="margin-bottom:14px"><div style="font-size:11px;font-weight:700;color:var(--t3);letter-spacing:.8px;text-transform:uppercase;margin-bottom:6px">Challenge record</div>' +
    '<div style="font-size:20px;font-weight:900;color:var(--t1)">0 \u2013 0 \u2013 0</div><div style="font-size:11px;color:var(--t3);margin-top:2px">Wins \u2013 losses \u2013 ties. Challenges arrive in the next build.</div></div>';
  var quick = recentUnposted(5);
  var q = quick.length ? '<div class="sec-header" style="margin-top:6px"><span class="sec-title" style="font-size:15px">Post a recent night</span></div>' +
    quick.map(function (x) {
      return '<div class="list-row" style="padding:10px 12px;margin-bottom:8px"><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(x.where) + '</div>' +
        '<div style="font-size:11px;color:var(--t3)">' + ago(x.date) + ' \u00b7 ' + x.games.join(' \u00b7 ') + ' = ' + x.games.reduce(function (a, b) { return a + b; }, 0) + '</div></div>' +
        '<button class="btn btn-ghost btn-sm" style="width:auto;padding:5px 12px" onclick="cnQuickPost(' + x.id + ')">Post</button></div>';
    }).join('') : '';
  var mine = '<div class="sec-header" style="margin-top:10px"><span class="sec-title" style="font-size:15px">Your posts</span></div>' +
    (list.length ? list.map(function (p) { return myCard(p, true); }).join('') : '<div style="font-size:12px;color:var(--t3);margin-bottom:14px">No posts yet. Post a recent night above, or use \u201cPost to Connect\u201d on any share card.</div>');
  return head + rec + q + mine;
}
function friendHTML(id) {
  var fr = friends().filter(function (x) { return x.id === id; })[0];
  if (!fr) { cn.friend = null; return feedHTML(); }
  var theirs = friendPosts().filter(function (x) { return x.who === id; }).sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
  return '<div onclick="cnBack()" style="font-size:13px;color:var(--teal);font-weight:700;cursor:pointer;margin-bottom:10px">\u2039 Feed</div>' +
    '<div class="stat-card" style="margin-bottom:14px;text-align:center">' + '<div style="display:inline-block">' + avatar(fr, 64) + '</div>' +
    '<div style="font-size:20px;font-weight:900;color:var(--t1);margin-top:8px">' + esc(fr.name) + '</div>' +
    '<div style="font-size:11px;color:var(--t3);margin-top:2px">' + theirs.length + ' post' + (theirs.length === 1 ? '' : 's') + ' \u00b7 head-to-head 0 \u2013 0 \u2013 0</div>' +
    '<div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-ghost btn-sm" style="flex:1" onclick="openBowlerProfile(\'' + id + '\')">Profile</button>' +
    '<button class="btn btn-ghost btn-sm" style="flex:1" onclick="fsOpenComparison(\'' + id + '\')">\u2696\ufe0f Compare</button></div></div>' +
    (theirs.length ? theirs.map(friendCard).join('') : '<div style="font-size:12px;color:var(--t3)">No activity yet.</div>');
}
function challengesHTML() {
  return '<div class="stat-card" style="margin-bottom:14px"><div style="font-size:16px;font-weight:800;color:var(--t1);margin-bottom:6px">\ud83c\udfc1 Challenges are next</div>' +
    '<div style="font-size:12px;color:var(--t2);line-height:1.6"><b>League challenges</b> read the league and tournament games you already record. <b>Open challenges</b> are bowled as their own sessions, kept out of your stats: Low Ball, spare golf and other fun formats live there. ' +
    'Presets (high series, first to 700, spare shootout\u2026), accept or suggest changes, your record and the fun awards come with the challenge build.</div></div>';
}
function render() {
  var el = document.getElementById('friend-feed-content');
  if (!el) return;
  var body = cn.friend ? friendHTML(cn.friend) : cn.tab === 'you' ? youHTML() : cn.tab === 'challenges' ? challengesHTML() : feedHTML();
  el.innerHTML = '<div class="sec-header"><span class="sec-title">Connect</span></div>' + tabs() + (cn.tab === 'feed' || cn.friend ? banner() : '') + body;
}
function cnTab(t) { cn.tab = t; cn.friend = null; render(); }
function cnFilter(f) { cn.filter = f; render(); }
function cnFriend(id) { cn.friend = id; render(); var s = document.querySelector('#s-friend-feed'); if (s) s.scrollTop = 0; }
function cnBack() { cn.friend = null; render(); }
function cnInvite() {
  (root.openModal)('<div class="modal-title">+ Invite a friend</div><div style="font-size:13px;color:var(--t2);line-height:1.6;margin-bottom:12px">Invites need the Connect server, which isn\u2019t built yet. When it is, you\u2019ll share an invite code or QR here and your friend joins from their own phone. Until then, Team Bowl teammates appear as your friends.</div>' +
    '<button class="btn btn-secondary" onclick="closeModal()">OK</button>');
}
function cnOpen(tab) { if (tab) { cn.tab = tab; cn.friend = null; } render(); }

var api = { CONNECT_VERSION: CONNECT_VERSION, REACTIONS: REACTIONS };
root.cnRender = render; root.cnOpen = cnOpen; root.cnPost = cnPost; root.cnTab = cnTab; root.cnFilter = cnFilter; root.cnFriend = cnFriend; root.cnBack = cnBack;
root.cnReact = cnReact; root.cnSetVis = cnSetVis; root.cnHide = cnHide; root.cnTakeDown = cnTakeDown; root.cnTakeDownYes = cnTakeDownYes;
root.cnQuickPost = cnQuickPost; root.cnInvite = cnInvite;
root.BDB_CONNECT = api; root.CONNECT_JS_VERSION = CONNECT_VERSION;
})(typeof window !== 'undefined' ? window : globalThis);
