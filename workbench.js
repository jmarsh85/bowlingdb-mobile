/* BowlingDB Catalog workbench (v30.204 WB-3, dev mode). Loaded on first use by catalog.js
   (catWorkbenchOpen). One screen from USBC intake to a finished card in Add a Ball:
     Specs    held balls that need specs; per row Find (maker / bowwwl), Paste, PDF; what was read shows
              on the row (Review / ✕); several PDFs at once are matched to their balls; Save all found.
     Pictures balls with no cover picture saved on this phone; opens the picture tool for the work.
     Status   current / discontinued / rejected; bulk discontinue, reject, restore with a preview.
     Release  held balls; ready = complete specs + a cover picture; Release ticked.
   Rows open Correct specs; saving opens the next ball in the list (Save & next).
   Uses catalog.js through root._catAPI only. Design: DESIGN_add_ball_flow sections 50-55. */
(function (root) {
  'use strict';
  var WB_VERSION = 'v30.209';
  var A = root._catAPI;
  if (!A) { if (root.toast) root.toast('Workbench needs catalog.js ' + WB_VERSION); return; }
  var esc = A.esc, jsq = A.jsq, norm = A.norm, cleanName = A.cleanName;
  var PAGE = 25;
  /* brands grouped by parent company (researched 10/18/26); the rest are their own group */
  var GROUPS = [['Brunswick', ['Brunswick', 'DV8', 'Radical', 'Ebonite', 'Hammer', 'Columbia 300', 'Track']], ['Storm', ['Storm', 'Roto Grip', '900 Global']]];
  var REQ = [['coverName', 'coverstock'], ['coverType', 'cover type'], ['finish', 'finish'], ['core', 'core'], ['coreType', 'core type'], ['released', 'release date']];
  /* v30.207 triage: the work queue (Specs, Pictures, Release) is current US balls plus upcoming ones,
     unless you choose Show all; Triage sorts the rest into buckets you can confirm in bulk */
  var BUCKETS = [['current', 'Current, US', 'The work queue: approved in the last 3 years (or confirmed current by you or the maker), no region.'],
    ['upcoming', 'Not out yet', 'No specs anywhere yet, and approved by USBC in the last 4 months (no release date) or a release date still ahead. A ball with specs counts as out.'],
    ['international', 'International', 'An Overseas / Japan / Korea / Int\u2019l\u2026 name, your region tag, or a brand you set as a region\u2019s.'],
    ['likely', 'Likely discontinued', 'Approved over 3 years ago and the maker\u2019s site hasn\u2019t said either way. Confirm by brand below.'],
    ['discontinued', 'Discontinued', 'The maker\u2019s site says retired, or you marked it.']];
  var FOCUS_KEY = 'bowlingdb_wb_focus';
  function focusOn() { try { return localStorage.getItem(FOCUS_KEY) !== 'all'; } catch (e) { return true; } }
  function inQueue(e) { var b = A.triageOf(e); return b === 'current' || b === 'upcoming'; }
  var _wb = { tab: 'triage', bucket: '', group: '', brand: '', year: '', state: '', q: '', page: 0, sel: {}, found: {}, det: {}, staged: null, busy: '' };

  /* ---------- v30.206 WB-4: change log with undo (this phone; the newest 60 changes) ----------
     Each bulk change records what it replaced: status entries, releases, corrections (phone or repo),
     region tags, picture links. Undo puts those back (and syncs, as the change did). */
  var LOG_KEY = 'bowlingdb_catalog_log';
  function logAll() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]') || []; } catch (e) { return []; } }
  function logSave(l) { try { localStorage.setItem(LOG_KEY, JSON.stringify(l.slice(0, 60))); } catch (e) {} }
  function logAdd(kind, label, items) { if (!items.length) return; var l = logAll(); l.unshift({ id: String(Date.now()) + Math.floor(Math.random() * 1000), at: new Date().toISOString(), kind: kind, label: label, items: items }); logSave(l); }
  function cp(x) { return x == null ? null : JSON.parse(JSON.stringify(x)); }

  /* ---------- pure ---------- */
  function groupOf(m) {
    var b = norm(m || '');
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i][1].some(function (x) { return b.indexOf(norm(x)) === 0; })) return GROUPS[i][0];
    return m || 'Other';
  }
  /* specs object -> what is missing for a complete card */
  function missingOf(sp) {
    sp = sp || {}; var miss = REQ.filter(function (r) { return !sp[r[0]]; }).map(function (r) { return r[1]; });
    var ws = sp.weights || {}, asym = /asym/i.test(sp.coreType || '');
    var okW = Object.keys(ws).some(function (w) { var x = ws[w] || {}; return x.RG != null && x.Diff != null && (!asym || x.IntDiff != null); });
    if (!okW) miss.push(asym ? 'RG / Diff / Int Diff' : 'RG / Diff');
    return miss;
  }
  function wbScope(rows) { return rows.filter(function (e) { return !e.a; }); }
  function ownedMap() { var m = {}; A.appBalls().forEach(function (b) { if (b.CatalogID && !b.Archived) m[b.CatalogID] = 1; }); return m; }
  function specState(e) {
    var d = _wb.det[e.i];
    if (d) return d.miss.length ? (d.any ? 'partial' : 'none') : 'complete';
    if (!e.s && !A.overrideFor(e.i)) return _wb.staged && _wb.staged[e.i] ? 'waiting' : 'none';
    return 'partial';
  }
  function statusOf(e) { if (A.catIsRejected(e)) return 'rejected'; var d = A.discontinuedOf(e); return d === 'retired' ? 'discontinued' : d === 'likely' ? 'likely' : 'current'; }
  /* the tab's list before the filters */
  function tabRows(rows) {
    var sc = wbScope(rows);
    if (_wb.tab === 'specs') return sc.filter(function (e) { return A.catIsHeld(e) && !A.catIsRejected(e) && specState(e) !== 'complete'; });
    if (_wb.tab === 'pictures') return sc.filter(function (e) { return !A.catIsRejected(e) && !A.catImageStored(e.i); });
    if (_wb.tab === 'status') return sc;
    return sc.filter(function (e) { return A.catIsHeld(e) && !A.catIsRejected(e); });
  }
  function readyOf(e) { var d = _wb.det[e.i]; return !!d && !d.miss.length && !!A.catImageStored(e.i); }
  function stateOptions() {
    if (_wb.tab === 'specs') return [['', 'Any state'], ['none', 'No specs'], ['partial', 'Partial'], ['waiting', 'Read, waiting']];
    if (_wb.tab === 'status') return [['', 'Any status'], ['current', 'Current'], ['likely', 'Likely discontinued'], ['discontinued', 'Discontinued'], ['rejected', 'Rejected']];
    if (_wb.tab === 'release') return [['', 'Any'], ['ready', 'Ready'], ['specs', 'Needs specs'], ['picture', 'Needs a cover picture']];
    return [['', 'Any']];
  }
  function passState(e) {
    var s = _wb.state; if (!s) return true;
    if (_wb.tab === 'specs') return specState(e) === s;
    if (_wb.tab === 'status') return statusOf(e) === s;
    if (_wb.tab === 'release') { var d = _wb.det[e.i]; return s === 'ready' ? readyOf(e) : s === 'specs' ? !d || d.miss.length > 0 : !A.catImageStored(e.i); }
    return true;
  }
  function filtered(rows) {
    var q = norm(_wb.q || ''), own = ownedMap();
    var list = tabRows(rows).filter(function (e) {
      if (_wb.tab === 'status' && !_wb.state && A.catIsRejected(e)) return false;
      if (_wb.group && groupOf(e.m) !== _wb.group) return false;
      if (_wb.brand && e.m !== _wb.brand) return false;
      if (_wb.year && (_wb.year === 'older' ? parseInt(e.y, 10) >= 2021 : String(e.y) !== _wb.year)) return false;
      if (q && norm(e.m + ' ' + e.n).indexOf(q) < 0) return false;
      if (_wb.bucket && A.triageOf(e) !== _wb.bucket) return false;
      if (!_wb.bucket && focusOn() && (_wb.tab === 'specs' || _wb.tab === 'pictures' || _wb.tab === 'release') && !inQueue(e)) return false;
      if (_wb.region) { var rg = A.regionOf(e); if (_wb.region === 'us' ? !!rg : _wb.region === 'intl' ? !rg : rg !== _wb.region) return false; }
      return passState(e);
    });
    return list.sort(function (a, b) { return ((own[b.i] ? 1 : 0) - (own[a.i] ? 1 : 0)) || ((b.h === 2 ? 1 : 0) - (a.h === 2 ? 1 : 0)) || String(b.y || '').localeCompare(String(a.y || '')) || String(a.m).localeCompare(String(b.m)) || cleanName(a.n).localeCompare(cleanName(b.n)); });
  }

  /* ---------- details (exact completeness) ---------- */
  function loadDetails(list) {
    var todo = list.filter(function (e) { return !_wb.det[e.i]; });
    if (!todo.length) return Promise.resolve(0);
    return todo.reduce(function (p, e) {
      return p.then(function () {
        var base = e.s ? A.catDetailRaw(e).then(function (r) { return r ? A.detAsStaged(r) : null; }, function () { return null; }) : Promise.resolve(_wb.stagedRows ? A.srvStagedRow(_wb.stagedRows, e.i) : null);
        return base.then(function (b) {
          var sp = ((A.apApplyOverride(b, A.overrideFor(e.i)) || {}).specs) || {};
          var any = REQ.some(function (r) { return sp[r[0]]; }) || Object.keys(sp.weights || {}).length > 0;
          _wb.det[e.i] = { miss: missingOf(sp), any: any, base: b, sp: sp };
        });
      });
    }, Promise.resolve()).then(function () { return todo.length; });
  }

  /* ---------- render ---------- */
  function sel(id, val, opts, call) { return '<select id="' + id + '" onchange="' + call + '(this.value)" class="bdet-field-input" style="flex:1;min-width:0;font-size:13px;padding:7px 6px">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === val ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'; }
  function dot(t, c) { return '<span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:' + c + ';margin-right:3px"></span>' + t; }
  function rowHTML(e, own) {
    var st = specState(e), pic = !!A.catImageStored(e.i), stat = statusOf(e), d = _wb.det[e.i], f = _wb.found[e.i], on = !!_wb.sel[e.i];
    var sc = { complete: 'var(--teal)', partial: 'var(--gold)', waiting: '#7aa7ff', none: 'var(--t3)' }[st];
    var meta = '<div style="font-size:11px;color:var(--t3);margin-top:2px">' + dot('specs ' + st, sc) + ' \u00b7 ' + dot(pic ? 'picture' : 'no picture', pic ? 'var(--teal)' : 'var(--t3)') + ' \u00b7 ' + esc(stat) + '</div>';
    var rgn = A.regionOf(e);
    var chips = (own[e.i] ? '<span style="' + A.CHIP_T + '">YOURS</span>' : '') + (A.catIsHeld(e) ? '<span style="' + A.CHIP_G + '">' + (e.h === 2 ? 'NEW' : 'HELD') + '</span>' : '') +
      (rgn ? '<span style="' + A.CHIP + 'color:#7aa7ff;border:1px solid rgba(122,167,255,0.45)">' + esc(rgn.toUpperCase()) + '</span>' : '') +
      (function () { var k = A.triageOf(e); return k === 'upcoming' ? '<span style="' + A.CHIP_G + '">NOT OUT YET</span>' : k === 'likely' ? '<span style="' + A.CHIP_G + '">LIKELY DISC.</span>' : k === 'discontinued' ? '<span style="' + A.CHIP_G + '">DISCONTINUED</span>' : ''; })();
    var extra = '';
    if (_wb.tab === 'specs') {
      var bw = A.bowwwlLinks(e.m, cleanName(e.n)), a = function (u, t) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal);text-decoration:none">' + t + '</a>'; };
      extra = (d && d.miss.length ? '<div style="font-size:12px;color:var(--gold);margin-top:4px">needs ' + esc(d.miss.join(', ')) + '</div>' : '') +
        (f ? '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;padding:7px 9px;border-radius:9px;background:var(--bg2);border:1px solid ' + (f.nameSeen === false ? 'var(--gold)' : 'rgba(0,217,217,0.3)') + '">' +
          '<div style="flex:1;min-width:0;font-size:12px;color:var(--t1);line-height:1.4">' + esc(foundLine(f)) + (f.warn ? '<div style="color:var(--gold)">' + esc(f.warn) + '</div>' : '') +
          (f.retired && statusOf(e) !== 'discontinued' && !f.retiredDone ? '<div style="color:var(--gold)">the page says it\u2019s discontinued \u00b7 <span onclick="wbMarkDisc(\'' + jsq(e.i) + '\')" style="color:var(--teal);cursor:pointer">Mark discontinued</span></div>' : '') +
          (f.region && rgn !== f.region ? '<div style="color:#7aa7ff">the page says ' + esc(f.region) + ' release \u00b7 <span onclick="wbTagRegion(\'' + jsq(e.i) + '\',\'' + jsq(f.region) + '\')" style="color:var(--teal);cursor:pointer">Tag it</span></div>' : '') + (f.nameSeen === false ? '<div style="color:var(--gold)">the page doesn\u2019t name this ball: check it (not in Save all)</div>' : '') + '</div>' +
          '<button style="' + A.BTN_P + 'padding:6px 9px;font-size:12px" onclick="wbReview(\'' + jsq(e.i) + '\')">Review</button><button style="' + A.BTN_G + 'padding:6px 9px;font-size:12px" onclick="wbDrop(\'' + jsq(e.i) + '\')">\u2715</button></div>' : '') +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap"><button style="' + A.BTN_G + 'padding:6px 10px;font-size:12px" onclick="wbPaste(\'' + jsq(e.i) + '\')">Paste</button>' +
        '<button style="' + A.BTN_G + 'padding:6px 10px;font-size:12px" onclick="wbPdf(\'' + jsq(e.i) + '\')">PDF</button>' +
        (own[e.i] && !f ? '<button style="' + A.BTN_P + 'padding:6px 10px;font-size:12px" onclick="wbFromMine(\'' + jsq(e.i) + '\')">Use my ball\u2019s specs</button>' : '') +
        '<span style="font-size:11px;color:var(--t3)">Find: ' + a(bw.maker || bw.search, 'maker \u2197') + ' \u00b7 ' + a(bw.page, 'bowwwl \u2197') + '</span></div>';
    } else if (_wb.tab === 'release') {
      extra = '<div style="font-size:12px;margin-top:4px;color:' + (readyOf(e) ? 'var(--teal)' : 'var(--gold)') + '">' + (!d ? 'checking\u2026' : readyOf(e) ? 'ready to release' : 'needs ' + esc((d.miss.length ? d.miss : []).concat(pic ? [] : ['a cover picture']).join(', '))) + '</div>';
    }
    var canTick = _wb.tab === 'release' ? readyOf(e) : _wb.tab === 'status';
    return '<div style="padding:9px 2px;border-bottom:1px solid var(--border1)"><div style="display:flex;gap:10px;align-items:center">' +
      (canTick || _wb.tab === 'status' ? '<input type="checkbox" ' + (on ? 'checked ' : '') + (canTick ? '' : 'disabled ') + 'onchange="wbSel(\'' + jsq(e.i) + '\',this.checked)" style="width:20px;height:20px;flex-shrink:0">' : '') +
      '<div onclick="wbOpenBall(\'' + jsq(e.i) + '\')" style="display:flex;gap:10px;align-items:center;flex:1;min-width:0;cursor:pointer">' + A.thumbHTML(e, 40) +
      '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;color:var(--t1)">' + esc(cleanName(e.n)) + chips + '</div>' +
      '<div style="font-size:12px;color:var(--t2)">' + esc(e.m) + (e.y ? ' \u00b7 ' + esc(e.y) : '') + '</div>' + meta + '</div></div></div>' + extra + '</div>';
  }
  function foundLine(f) {
    var fx = f.fields || {}, parts = [];
    if (fx.core) parts.push(fx.core); if (fx.coreType) parts.push(fx.coreType); if (fx.coverName) parts.push(fx.coverName); if (fx.finish) parts.push(fx.finish);
    var ws = Object.keys(f.weights || {}).sort().reverse(), w0 = ws[0] && f.weights[ws[0]];
    if (w0) parts.push(ws[0] + ' lb ' + [w0.RG, w0.Diff, w0.IntDiff].filter(function (x) { return x != null; }).map(function (x) { return Number(x).toFixed(3); }).join(' / '));
    var n = Object.keys(fx).length + ws.reduce(function (t, w) { return t + Object.keys(f.weights[w]).length; }, 0);
    return 'found ' + n + ': ' + parts.join(' \u00b7 ') + (ws.length > 1 ? ' (+' + (ws.length - 1) + ' weight' + (ws.length > 2 ? 's' : '') + ')' : '') + (f.host ? ' \u2014 ' + f.host : f.source ? ' \u2014 ' + f.source : '');
  }
  function counts(rows) {
    var sc = wbScope(rows).filter(function (e) { return !A.catIsRejected(e); }), held = sc.filter(A.catIsHeld);
    var noSpecs = held.filter(function (e) { return !A.hlHasSpecs(e, A.overrideFor(e.i)); }).length;
    var noPic = sc.filter(function (e) { return !A.catImageStored(e.i); }).length;
    var checked = held.filter(function (e) { return _wb.det[e.i]; }), ready = checked.filter(readyOf).length;
    return { scope: sc.length, held: held.length, noSpecs: noSpecs, noPic: noPic, ready: ready, checked: checked.length };
  }
  function paint() {
    var ov = document.getElementById('wb-ov'); if (!ov) return;
    A.catLoad().then(function (rows) {
      var own = ownedMap(), list = filtered(rows), pages = Math.max(1, Math.ceil(list.length / PAGE));
      if (_wb.page >= pages) _wb.page = pages - 1;
      var shown = list.slice(_wb.page * PAGE, (_wb.page + 1) * PAGE), c = counts(rows);
      var stat = function (n, t, call) { return '<div onclick="' + call + '" style="flex:1;min-width:0;padding:6px 4px;border-radius:9px;background:var(--bg2);border:1px solid var(--border1);text-align:center;cursor:pointer"><div style="font-size:15px;font-weight:800;color:var(--t1)">' + n + '</div><div style="font-size:10px;color:var(--t3)">' + t + '</div></div>'; };
      var tab = function (k, t) { return '<button onclick="wbTab(\'' + k + '\')" style="' + (_wb.tab === k ? A.BTN_P : A.BTN_G) + 'flex:1;padding:8px 4px;font-size:13px">' + t + '</button>'; };
      var brands = {}; tabRows(rows).forEach(function (e) { if (!_wb.group || groupOf(e.m) === _wb.group) brands[e.m] = 1; });
      var groups = {}; tabRows(rows).forEach(function (e) { groups[groupOf(e.m)] = 1; });
      var years = {}; tabRows(rows).forEach(function (e) { if (parseInt(e.y, 10) >= 2021) years[e.y] = 1; });
      var nSel = Object.keys(_wb.sel).length, nFound = Object.keys(_wb.found).filter(function (id) { return _wb.found[id].nameSeen !== false; }).length;
      var bar = '';
      if (_wb.tab === 'specs') bar = '<button onclick="wbPdfs()" style="' + A.BTN_G + 'flex:1;padding:10px;font-size:13px">Pick PDFs</button><button id="wb-saveall" onclick="wbSaveAll()" ' + (nFound ? '' : 'disabled ') + 'style="' + A.BTN_P + 'flex:1;padding:10px;font-size:13px;' + (nFound ? '' : 'opacity:.45') + '">Save all found (' + nFound + ')</button>';
      else if (_wb.tab === 'pictures') bar = '<button onclick="wbCheckLinks()" style="' + A.BTN_G + 'flex:1;padding:10px;font-size:13px">Check picture links</button><button onclick="wbPictureTool()" style="' + A.BTN_P + 'flex:1;padding:10px;font-size:13px">Open the picture tool</button>';
      else if (_wb.tab === 'status') bar = '<button onclick="wbRegionAsk()" ' + (nSel ? '' : 'disabled ') + 'style="' + A.BTN_G + 'flex:1;padding:10px 4px;font-size:12px;' + (nSel ? '' : 'opacity:.45') + '">Region</button>' + ['discontinue', 'reject', 'restore'].map(function (k) { return '<button onclick="wbStatus(\'' + k + '\')" ' + (nSel ? '' : 'disabled ') + 'style="' + (k === 'reject' ? A.BTN_G + 'color:var(--red);' : A.BTN_G) + 'flex:1;padding:10px 4px;font-size:12px;' + (nSel ? '' : 'opacity:.45') + '">' + { discontinue: 'Discontinue', reject: 'Reject', restore: 'Restore' }[k] + ' ' + nSel + '</button>'; }).join('');
      else bar = '<button onclick="wbSelectReady()" style="' + A.BTN_G + 'flex:1;padding:10px;font-size:13px">Tick all ready</button><button onclick="wbRelease()" ' + (nSel ? '' : 'disabled ') + 'style="' + A.BTN_P + 'flex:1;padding:10px;font-size:13px;' + (nSel ? '' : 'opacity:.45') + '">Release ' + nSel + '</button>';
      if (_wb.tab === 'triage') { ov.innerHTML = triageHTML(rows, c, stat, tab); return; }
      var qline = _wb.bucket ? '<div style="padding:0 16px 6px;font-size:12px;color:var(--t2)">Bucket: <b>' + esc(bucketName(_wb.bucket)) + '</b> \u00b7 <span onclick="wbBucket(\'\')" style="color:var(--teal);cursor:pointer">clear</span></div>' :
        (_wb.tab === 'specs' || _wb.tab === 'pictures' || _wb.tab === 'release') ? '<div style="padding:0 16px 6px;font-size:12px;color:var(--t2)">' + (focusOn() ? 'Work queue: current US balls and ones not out yet \u00b7 <span onclick="wbFocus(false)" style="color:var(--teal);cursor:pointer">Show all</span>' : 'Showing every ball \u00b7 <span onclick="wbFocus(true)" style="color:var(--teal);cursor:pointer">Work queue only</span>') + '</div>' : '';
      var help = { specs: 'Held balls that still need specs. Paste or PDF on a row reads a page for that ball; <b>Pick PDFs</b> takes several saved pages at once and puts each on its ball. Check a row\u2019s read with Review, then <b>Save all found</b>. Tap a ball to edit it; saving opens the next one.',
        pictures: 'Balls with no cover picture saved on this phone. The picture tool does the work (Find, Paste, Photo, Check bowwwl for all, Save all found). <b>Check picture links</b> loads every saved link and offers to clear the ones that no longer load.',
        status: 'Tick balls to discontinue, reject (needs a reason), restore, or set their <b>Region</b>. You see what will change before it does; balls you own are never changed in bulk. Every change can be undone: More \u203a Change log.',
        release: 'Held balls. A ball is ready with complete specs and a cover picture on this phone. Released balls show in Add a Ball here at once, and for everyone after the next catalog refresh.' }[_wb.tab];
      ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 6px"><button style="' + A.BACK + '" onclick="wbClose()">\u2039</button>' +
        '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Catalog workbench</div><div style="font-size:11px;color:var(--t3)">2021 and newer, plus yours \u00b7 ' + esc(_wb.busy || 'dev mode') + '</div></div>' +
        '<button onclick="catUpdateOpen()" style="' + A.BTN_P + 'padding:7px 10px;font-size:12px">Update</button><button onclick="wbMore()" style="' + A.BTN_G + 'padding:7px 10px;font-size:12px">More</button></div>' + updLine() +
        '<div style="display:flex;gap:5px;padding:0 16px 8px">' + stat(c.scope, 'in scope', "wbTab('status')") + stat(c.held, 'held', "wbTab('release')") + stat(c.noSpecs, 'need specs', "wbTab('specs')") + stat(c.noPic, 'need picture', "wbTab('pictures')") + stat(c.ready + (c.checked < c.held ? '+' : ''), 'ready', "wbTab('release','ready')") + '</div>' +
        '<div style="display:flex;gap:6px;padding:0 16px 8px">' + tab('triage', 'Triage') + tab('specs', 'Specs') + tab('pictures', 'Pictures') + tab('status', 'Status') + tab('release', 'Release') + '</div>' +
        '<div style="display:flex;gap:6px;padding:0 16px 6px">' + sel('wb-g', _wb.group, [['', 'All brands']].concat(Object.keys(groups).sort().map(function (g) { return [g, g]; })), 'wbGroup') +
          sel('wb-b', _wb.brand, [['', _wb.group ? 'All ' + _wb.group : 'Brand']].concat(Object.keys(brands).sort().map(function (b) { return [b, b]; })), 'wbBrand') + '</div>' +
        '<div style="display:flex;gap:6px;padding:0 16px 6px">' + sel('wb-y', _wb.year, [['', 'Any year']].concat(Object.keys(years).sort().reverse().map(function (y) { return [y, y]; })).concat(_wb.tab === 'status' || _wb.tab === 'pictures' ? [['older', 'Before 2021 (yours)']] : []), 'wbYear') +
          sel('wb-s', _wb.state, stateOptions(), 'wbState') + '</div>' +
        '<div style="display:flex;gap:6px;padding:0 16px 6px">' + '<div style="flex:0 0 38%;display:flex">' + sel('wb-r', _wb.region || '', [['', 'Any region'], ['us', 'US releases'], ['intl', 'International (any)']].concat(A.REGIONS.map(function (r) { return [r, r]; })), 'wbRegion') + '</div>' +
          '<input class="bdet-field-input" type="search" placeholder="Search brand or name" value="' + esc(_wb.q) + '" oninput="wbQ(this.value)" style="flex:1;min-width:0;box-sizing:border-box;font-size:15px"></div>' +
        qline + '<div style="padding:0 16px 4px;font-size:12px;color:var(--t2);display:flex;align-items:center;gap:8px"><span style="flex:1">' + list.length + ' ball' + (list.length === 1 ? '' : 's') + (_wb.tab === 'release' || _wb.tab === 'status' ? ' \u00b7 ' + nSel + ' ticked' : '') + '</span>' +
          (_wb.tab === 'status' ? '<span onclick="wbSelAll()" style="color:var(--teal);cursor:pointer">Select all ' + list.length + '</span> \u00b7 <span onclick="wbSelNone()" style="color:var(--teal);cursor:pointer">None</span>' : '') + '</div>' +
        '<div id="wb-list" style="flex:1;overflow-y:auto;padding:0 16px 10px">' + (shown.length ? shown.map(function (e) { return rowHTML(e, own); }).join('') : '<div style="padding:30px 0;text-align:center;color:var(--t2);font-size:13px">Nothing here with these filters.</div>') +
          '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:10px">' + help + '</div></div>' +
        (pages > 1 ? '<div style="display:flex;gap:8px;align-items:center;padding:6px 16px 0"><button style="' + A.BTN_G + 'flex:1;padding:9px" ' + (_wb.page ? '' : 'disabled ') + 'onclick="wbPage(-1)">\u2039 Prev</button><span style="font-size:12px;color:var(--t2);min-width:70px;text-align:center">' + (_wb.page + 1) + ' of ' + pages + '</span><button style="' + A.BTN_G + 'flex:1;padding:9px" ' + (_wb.page < pages - 1 ? '' : 'disabled ') + 'onclick="wbPage(1)">Next \u203a</button></div>' : '') +
        '<div style="display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--border1);margin-top:6px">' + bar + '</div>';
      if (_wb.tab === 'specs' || _wb.tab === 'release') loadDetails(shown).then(function (n) { if (n) paint(); });
    });
  }

  /* ---------- actions ---------- */
  function wbOpen(opt) {
    if (typeof document === 'undefined') return;
    var mb = document.getElementById('modal-bg'); if (mb && mb.classList.contains('open') && root.closeModal) root.closeModal();
    wbClose(); opt = opt || {}; if (opt.tab) _wb.tab = opt.tab;   // remembers the last tab; Triage the first time _wb.page = 0; _wb.sel = {};
    document.body.appendChild(A.overlay('wb-ov', 905)); paint();
    if (A.apToken()) {
      A.apReadOverrides().then(paint, function () {});
      A.apReadStaged().then(function (st) { var w = {}; (st || []).forEach(function (r) { if (r.decision === 'pending') { if (r.catalogId) w[r.catalogId] = 1; (r.candidates || []).forEach(function (id) { w[id] = 1; }); } }); _wb.staged = w; _wb.stagedRows = st; paint(); }, function () {});
    }
  }
  function wbClose() { var el = document.getElementById('wb-ov'); if (el) el.parentNode.removeChild(el); }
  function wbTab(k, st) { _wb.tab = k; _wb.state = st || ''; _wb.bucket = ''; _wb.page = 0; _wb.sel = {}; paint(); }
  function wbGroup(v) { _wb.group = v; _wb.brand = ''; _wb.page = 0; paint(); }
  function wbBrand(v) { _wb.brand = v; _wb.page = 0; paint(); }
  function wbYear(v) { _wb.year = v; _wb.page = 0; paint(); }
  function wbState(v) { _wb.state = v; _wb.page = 0; paint(); }
  function wbRegion(v) { _wb.region = v; _wb.page = 0; paint(); }
  function wbQ(v) { _wb.q = v; _wb.page = 0; clearTimeout(_wb.t); _wb.t = setTimeout(function () { paint(); setTimeout(function () { var i = document.querySelector('#wb-ov input[type=search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }, 250); }
  function wbPage(d) { _wb.page += d; paint(); var l = document.getElementById('wb-list'); if (l) l.scrollTop = 0; }
  function wbSel(id, on) { if (on) _wb.sel[id] = 1; else delete _wb.sel[id]; paint(); }
  function wbSelAll() { A.catLoad().then(function (rows) { filtered(rows).forEach(function (e) { _wb.sel[e.i] = 1; }); paint(); }); }
  function wbSelNone() { _wb.sel = {}; paint(); }
  /* Save & next: saving a ball opens the next one in the list as it stands */
  function wbOpenBall(id) {
    A.catCorrectFor(id, function () {
      delete _wb.det[id]; delete _wb.found[id];
      A.catLoad().then(function (rows) {
        var list = filtered(rows), ix = -1; list.forEach(function (e, i) { if (e.i === id) ix = i; });
        var next = list[ix >= 0 ? ix + 1 : 0] || null;
        paint(); if (next && next.i !== id) wbOpenBall(next.i);
      });
    });
  }
  function wbPaste(id) {
    A.catLoad().then(function (rows) { var e = A.byIdIn(rows, id); if (!e) return;
      A.spReadClipboard(function (text) { _wb.found[id] = A.parseSpecText(text, 15, cleanName(e.n)); paint(); }); });
  }
  function pickPdfs(multi, done) {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/pdf,.pdf'; inp.multiple = !!multi; inp.style.display = 'none';
    inp.addEventListener('change', function () { var fs = Array.prototype.slice.call(inp.files || []); if (inp.parentNode) inp.parentNode.removeChild(inp); if (fs.length) done(fs); });
    document.body.appendChild(inp); inp.click();
  }
  function wbPdf(id) {
    A.catLoad().then(function (rows) { var e = A.byIdIn(rows, id); if (!e) return;
      pickPdfs(false, function (fs) { if (root.toast) root.toast('Reading the PDF\u2026');
        A.spPdfFileText(fs[0]).then(function (t) { if (!t) { if (root.toast) root.toast('No text in that PDF'); return; } _wb.found[id] = A.parseSpecText(t, 15, cleanName(e.n)); paint(); }, function () { if (root.toast) root.toast('Could not read the PDF'); }); }); });
  }
  /* Pure: which ball a page is about: the longest ball name that appears in it, brand on the page breaking ties */
  function matchBall(text, cands) {
    var t = norm(text), best = null;   // norm keeps letters and digits only, so the longest name wins ("Code Crush" over "Code")
    cands.forEach(function (e) {
      var nm = norm(cleanName(e.n)); if (nm.length < 3 || t.indexOf(nm) < 0) return;
      var sc = nm.length * 2 + (t.indexOf(norm(e.m)) >= 0 ? 1 : 0);
      if (!best || sc > best.sc) best = { e: e, sc: sc };
    });
    return best ? best.e : null;
  }
  function wbPdfs() {
    pickPdfs(true, function (fs) {
      A.catLoad().then(function (rows) {
        var cands = tabRows(rows), got = 0, miss = [];
        _wb.busy = 'reading ' + fs.length + ' PDF' + (fs.length === 1 ? '' : 's'); paint();
        fs.reduce(function (p, f) {
          return p.then(function () { return A.spPdfFileText(f).then(function (t) {
            var e = t ? matchBall(t, cands) : null;
            if (!e) { miss.push(f.name); return; }
            _wb.found[e.i] = A.parseSpecText(t, 15, cleanName(e.n)); got++;
          }, function () { miss.push(f.name); }); });
        }, Promise.resolve()).then(function () {
          _wb.busy = ''; paint();
          if (root.toast) root.toast(got + ' of ' + fs.length + ' matched to a ball' + (miss.length ? ' \u00b7 not matched: ' + miss.slice(0, 3).join(', ') + (miss.length > 3 ? '\u2026' : '') : ''), 5000);
        });
      });
    });
  }
  /* v30.205: your arsenal ball's own specs as a read for its catalog entry (checked on the row, saved with Save all found) */
  function mineAsRead(b, all) {
    var ct = String(b.CoreType || ''), w = parseInt(b.Weight, 10) || 15, x = {};
    if (b.RG != null && b.RG !== '') x.RG = Number(b.RG); if (b.Differential != null && b.Differential !== '') x.Diff = Number(b.Differential); if (b.IntDiff != null && b.IntDiff !== '') x.IntDiff = Number(b.IntDiff);
    var f = { fields: {}, weights: {}, source: 'other', host: 'your ' + b.BallName, nameSeen: true };
    [['coverName', b.CoverName], ['coverType', b.Coverstock], ['finish', b.BoxFinish], ['core', b.CoreShort], ['released', b.DateReleased]].forEach(function (p) { if (p[1]) f.fields[p[0]] = String(p[1]); });
    if (/^a/i.test(ct)) f.fields.coreType = 'Asymmetrical'; else if (/^s/i.test(ct)) f.fields.coreType = 'Symmetrical';
    if (/^(symm?|asymm?|symmetrical|asymmetrical)$/i.test(f.fields.core || '')) delete f.fields.core;   // "Symm" in the core name is the core type
    if (Object.keys(x).length) f.weights[w] = x;
    var twin = (all || []).filter(function (o) { return o !== b && o.RG != null && Number(o.RG) === Number(b.RG) && Number(o.Differential) === Number(b.Differential); })[0];
    if (twin) f.warn = 'same RG / Diff as your ' + twin.BallName + ': check before saving';
    return f;
  }
  function wbFromMine(id) {
    var bs = A.appBalls(), b = bs.filter(function (x) { return x.CatalogID === id && !x.Archived; })[0] || bs.filter(function (x) { return x.CatalogID === id; })[0];
    if (!b) return; _wb.found[id] = (A.catMineAsRead || mineAsRead)(b, bs); paint();
  }
  function wbDrop(id) { delete _wb.found[id]; paint(); }
  function wbReview(id) { var f = _wb.found[id]; if (!f) return; A.catCorrectWithParsed(id, f, function () { delete _wb.found[id]; delete _wb.det[id]; paint(); }); }
  /* Pure: a read -> the editor's form */
  function formFrom(f) {
    var fx = f.fields || {}, form = { coverName: fx.coverName || '', coverType: fx.coverType || '', finish: fx.finish || '', core: fx.core || '', coreType: fx.coreType || '', released: fx.released || '', source: f.source || 'bowwwl', note: f.host ? 'from ' + f.host : '', weights: {} };
    Object.keys(f.weights || {}).forEach(function (w) { var x = f.weights[w]; form.weights[w] = { RG: x.RG == null ? '' : x.RG, Diff: x.Diff == null ? '' : x.Diff, IntDiff: x.IntDiff == null ? '' : x.IntDiff }; });
    return form;
  }
  function wbSaveAll() {
    var ids = Object.keys(_wb.found).filter(function (id) { return _wb.found[id].nameSeen !== false; }); if (!ids.length) return;
    A.catLoad().then(function (rows) {
      var ok = 0, bad = [], items = [];
      _wb.busy = 'saving ' + ids.length; paint();
      ids.reduce(function (p, id) {
        return p.then(function () {
          var e = A.byIdIn(rows, id); if (!e) return;
          var base = e.s ? A.catDetailRaw(e).then(function (r) { return r ? A.detAsStaged(r) : null; }, function () { return null; }) : Promise.resolve(_wb.stagedRows ? A.srvStagedRow(_wb.stagedRows, id) : null);
          var form = formFrom(_wb.found[id]), store = form.source === 'bowwwl' ? 'phone' : 'repo';
          var before = cp(store === 'phone' ? A.localOverrides()[id] : A.repoOverride(id));
          return base.then(function (b) { return A.catSaveCorrection(id, form, b); }).then(function (r) {
            if (r.ok) items.push({ id: id, n: cleanName(e.n), store: store, before: before });
            if (r.ok || r.msg === 'Nothing changed.') { ok++; delete _wb.found[id]; delete _wb.det[id]; } else bad.push(cleanName(e.n) + ': ' + r.msg);
            _wb.busy = 'saving ' + (ok + bad.length) + ' of ' + ids.length; paint();
          });
        });
      }, Promise.resolve()).then(function () { logAdd('specs', 'Saved specs for ' + items.length, items); _wb.busy = ''; paint(); if (root.toast) root.toast('Saved ' + ok + (bad.length ? ' \u00b7 not saved: ' + bad.slice(0, 2).join('; ') : ''), 5000); });
    });
  }
  function wbPictureTool() { if (typeof root.catImagesOpen === 'function') root.catImagesOpen(); }
  /* Status: preview, then change. Never a ball you own; reject needs a reason, a second confirm over 25 */
  function wbStatus(kind) {
    A.catLoad().then(function (rows) {
      var own = ownedMap(), ids = Object.keys(_wb.sel), list = ids.map(function (id) { return A.byIdIn(rows, id); }).filter(Boolean);
      var skip = kind === 'restore' ? [] : list.filter(function (e) { return own[e.i]; }), go = list.filter(function (e) { return skip.indexOf(e) < 0; });
      var verb = { discontinue: 'Mark discontinued', reject: 'Reject', restore: 'Restore' }[kind];
      var names = function (l) { return l.slice(0, 8).map(function (e) { return esc(cleanName(e.n)); }).join(', ') + (l.length > 8 ? ' and ' + (l.length - 8) + ' more' : ''); };
      if (!root.openModal) return;
      root.openModal('<div class="modal-title">' + verb + ' ' + go.length + ' ball' + (go.length === 1 ? '' : 's') + '?</div>' +
        '<div style="font-size:13px;color:var(--t2);line-height:1.5">' + (go.length ? names(go) : 'Nothing to change.') + '</div>' +
        (skip.length ? '<div style="font-size:12px;color:var(--gold);margin-top:8px">Left alone (yours): ' + names(skip) + '</div>' : '') +
        (kind === 'reject' ? '<label style="display:block;font-size:12px;color:var(--t3);margin-top:10px">Reason</label><select id="wb-reason" class="bdet-field-input" style="width:100%;font-size:15px"><option value="">Choose a reason</option><option value="cant-verify">Can\u2019t verify it exists</option><option value="duplicate">Duplicate entry</option><option value="not-a-ball">Not a bowling ball</option><option value="other">Other</option></select>' +
          (go.length > 25 ? '<label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--t1);margin-top:10px"><input id="wb-sure" type="checkbox" style="width:20px;height:20px"> Yes, reject all ' + go.length + '</label>' : '') : '') +
        '<div id="wb-err" style="font-size:12px;color:var(--red);margin-top:8px"></div>' +
        '<button class="btn btn-primary" style="width:100%;margin-top:10px" ' + (go.length ? '' : 'disabled ') + 'onclick="wbStatusGo(\'' + kind + '\')">' + verb + ' ' + go.length + '</button>' +
        '<button class="btn btn-secondary" style="width:100%;margin-top:8px" onclick="closeModal()">Cancel</button>');
      _wb.pending = go.map(function (e) { return e.i; });
    });
  }
  function wbStatusGo(kind) {
    var r = document.getElementById('wb-reason'), sure = document.getElementById('wb-sure'), err = document.getElementById('wb-err');
    if (kind === 'reject' && r && !r.value) { if (err) err.textContent = 'Choose a reason.'; return; }
    if (kind === 'reject' && sure && !sure.checked) { if (err) err.textContent = 'Tick the box to reject this many.'; return; }
    A.catLoad().then(function (rows) {
      var n = 0, items = [];
      (_wb.pending || []).forEach(function (id) {
        var e = A.byIdIn(rows, id); if (!e) return;
        items.push({ id: id, n: cleanName(e.n), before: cp(A.stEntry(id)) });
        if (kind === 'restore') A.stSet(id, null, false);
        else A.stSet(id, { status: 'retired', rejected: kind === 'reject', reason: kind === 'reject' ? r.value : 'manual', at: A.stToday(), n: cleanName(e.n), m: e.m }, false);
        n++;
      });
      A.stSaveLocal(A.stLocal()); A.stQueueSync(); _wb.sel = {}; _wb.pending = null;
      logAdd('status', { discontinue: 'Marked discontinued', reject: 'Rejected', restore: 'Restored' }[kind] + ' ' + n, items);
      if (root.closeModal) root.closeModal(); paint();
      if (root.toast) root.toast({ discontinue: 'Marked discontinued: ', reject: 'Rejected: ', restore: 'Restored: ' }[kind] + n);
    });
  }
  function wbSelectReady() { A.catLoad().then(function (rows) { var l = filtered(rows); _wb.busy = 'checking ' + l.length; paint();
    loadDetails(l).then(function () { l.forEach(function (e) { if (readyOf(e)) _wb.sel[e.i] = 1; }); _wb.busy = ''; paint(); }); }); }
  function wbRelease() {
    A.catLoad().then(function (rows) {
      var o = A.rlLocal(), n = 0, today = A.stToday();
      var items = [];
      Object.keys(_wb.sel).forEach(function (id) { var e = A.byIdIn(rows, id); if (!e || !readyOf(e) || o.all[id]) return; o.all[id] = { at: today, n: cleanName(e.n), m: e.m }; o.pending[id] = Date.now() + Math.random(); n++; items.push({ id: id, n: cleanName(e.n) }); });
      A.rlSaveLocal(o); if (n) A.rlQueueSync(); _wb.sel = {}; logAdd('release', 'Released ' + n, items); paint();
      if (root.toast) root.toast(n ? 'Released ' + n + ': now in Add a Ball' : 'Nothing ready to release');
    });
  }
  function updLine() { var t = A.catUpdateLine ? A.catUpdateLine() : ''; return t ? '<div onclick="catUpdateOpen()" style="margin:0 16px 8px;padding:7px 10px;border-radius:9px;background:var(--bg2);border:1px solid rgba(0,217,217,0.3);font-size:12px;color:var(--t1);cursor:pointer">' + esc(t) + ' \u203a</div>' : ''; }
  function bucketName(k) { var b = BUCKETS.filter(function (x) { return x[0] === k; })[0]; return b ? b[1] : k; }
  function triageHTML(rows, c, stat, tab) {
    var own = ownedMap(), sc = wbScope(rows).filter(function (e) { return !A.catIsRejected(e); }), by = {}, held = {}, brands = {};
    BUCKETS.forEach(function (b) { by[b[0]] = 0; held[b[0]] = 0; });
    sc.forEach(function (e) { var k = A.triageOf(e); if (!(k in by)) return; by[k]++; if (A.catIsHeld(e)) held[k]++; if (k === 'likely') { var m = brands[e.m] = brands[e.m] || { n: 0, mine: 0 }; m.n++; if (own[e.i]) m.mine++; } });
    var noD = !sc.some(function (e) { return e.d; });
    var card = function (b) {
      return '<div style="padding:10px 12px;border:1px solid var(--border1);border-radius:12px;background:var(--bg2);margin-bottom:8px"><div style="display:flex;align-items:baseline;gap:8px"><div style="flex:1;font-size:14px;font-weight:700;color:var(--t1)">' + esc(b[1]) + '</div>' +
        '<div style="font-size:16px;font-weight:800;color:var(--t1)">' + by[b[0]] + '</div></div>' +
        '<div style="font-size:12px;color:var(--t3);margin-top:2px;line-height:1.4">' + esc(b[2]) + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:6px"><span style="flex:1;font-size:12px;color:var(--t2)">' + held[b[0]] + ' held for review</span>' +
        '<button style="' + A.BTN_G + 'padding:6px 10px;font-size:12px" onclick="wbBucket(\'' + b[0] + '\')">Show</button></div>' +
        (b[0] === 'upcoming' && noD ? '<div style="font-size:11px;color:var(--gold);margin-top:4px">Approval months arrive with the next catalog refresh; until then only release dates count.</div>' : '') + '</div>';
    };
    var bl = Object.keys(brands).sort(function (a, b) { return brands[b].n - brands[a].n; });
    var brandRows = bl.map(function (m) { var x = brands[m];
      return '<div style="display:flex;align-items:center;gap:6px;padding:7px 0;border-bottom:1px solid var(--border1)"><div style="flex:1;min-width:0;font-size:13px;color:var(--t1)">' + esc(m) + ' <span style="color:var(--t3)">' + x.n + (x.mine ? ' \u00b7 ' + x.mine + ' yours (left alone)' : '') + '</span></div>' +
        '<button style="' + A.BTN_G + 'padding:5px 8px;font-size:11px" onclick="wbLikely(\'' + jsq(m) + '\',\'disc\')">Discontinued</button><button style="' + A.BTN_G + 'padding:5px 8px;font-size:11px" onclick="wbLikely(\'' + jsq(m) + '\',\'current\')">Still made</button></div>'; }).join('');
    var tg = A.triageGet(), rules = Object.keys(tg.brandRegion);
    var allBrands = {}; sc.forEach(function (e) { allBrands[e.m] = 1; });
    return '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 6px"><button style="' + A.BACK + '" onclick="wbClose()">\u2039</button>' +
        '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Catalog workbench</div><div style="font-size:11px;color:var(--t3)">Triage \u00b7 ' + sc.length + ' balls in scope' + (_wb.busy ? ' \u00b7 ' + esc(_wb.busy) : '') + '</div></div>' +
        '<button onclick="catUpdateOpen()" style="' + A.BTN_P + 'padding:7px 10px;font-size:12px">Update</button><button onclick="wbMore()" style="' + A.BTN_G + 'padding:7px 10px;font-size:12px">More</button></div>' + updLine() +
      '<div style="display:flex;gap:6px;padding:0 16px 8px">' + tab('triage', 'Triage') + tab('specs', 'Specs') + tab('pictures', 'Pictures') + tab('status', 'Status') + tab('release', 'Release') + '</div>' +
      '<div style="flex:1;overflow-y:auto;padding:0 16px 16px">' +
        '<div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:8px">Every ball sits in one bucket (the first that fits, top to bottom of the list below). Specs, Pictures and Release work only on <b>Current, US</b> and <b>Not out yet</b> unless you choose Show all there.</div>' +
        ['current', 'upcoming', 'international', 'likely', 'discontinued'].map(function (k) { return card(BUCKETS.filter(function (b) { return b[0] === k; })[0]); }).join('') +
        '<div style="font-size:13px;font-weight:700;color:var(--t1);margin:14px 0 2px">Likely discontinued, by brand</div>' +
        '<div style="font-size:12px;color:var(--t3);line-height:1.4">One tap settles a whole brand: <b>Discontinued</b> marks them (as your manual mark, synced with the GitHub token); <b>Still made</b> moves them to Current. Your own balls are never changed. Undo: More \u203a Change log.</div>' +
        (brandRows || '<div style="font-size:12px;color:var(--t2);padding:8px 0">Nothing likely discontinued.</div>') +
        '<div style="font-size:13px;font-weight:700;color:var(--t1);margin:16px 0 2px">Brands that are a region\u2019s</div>' +
        '<div style="font-size:12px;color:var(--t3);line-height:1.4">For a brand that only sells outside the US: every one of its balls counts as that region\u2019s release.</div>' +
        rules.map(function (b) { return '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border1)"><div style="flex:1;font-size:13px;color:var(--t1)">' + esc(b) + ' \u2192 ' + esc(tg.brandRegion[b]) + '</div><button style="' + A.BTN_G + 'padding:5px 9px;font-size:11px" onclick="wbBrandRegion(\'' + jsq(b) + '\',null)">Remove</button></div>'; }).join('') +
        '<div style="display:flex;gap:6px;margin-top:8px"><select id="wb-br-b" class="bdet-field-input" style="flex:1;min-width:0;font-size:13px;padding:7px 6px"><option value="">Brand</option>' + Object.keys(allBrands).sort().map(function (b) { return '<option>' + esc(b) + '</option>'; }).join('') + '</select>' +
        '<select id="wb-br-r" class="bdet-field-input" style="flex:1;min-width:0;font-size:13px;padding:7px 6px">' + A.REGIONS.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') + '</select>' +
        '<button style="' + A.BTN_P + 'padding:7px 10px;font-size:12px" onclick="wbBrandRegion(document.getElementById(\'wb-br-b\').value,document.getElementById(\'wb-br-r\').value)">Set</button></div>' +
      '</div>';
  }
  function wbBucket(k) { _wb.bucket = k; if (k) { if (_wb.tab === 'triage') _wb.tab = 'status'; } _wb.page = 0; _wb.sel = {}; paint(); }
  function wbFocus(on) { try { localStorage.setItem(FOCUS_KEY, on ? 'queue' : 'all'); } catch (e) {} _wb.page = 0; paint(); }
  /* a whole brand of likely-discontinued balls, one way or the other (never yours) */
  function wbLikely(brand, how) {
    A.catLoad().then(function (rows) {
      var own = ownedMap(), list = wbScope(rows).filter(function (e) { return e.m === brand && !own[e.i] && A.triageOf(e) === 'likely'; });
      if (!list.length) return;
      if (list.length > 25 && root.confirm && !root.confirm((how === 'disc' ? 'Mark ' : 'Keep ') + list.length + ' ' + brand + ' balls ' + (how === 'disc' ? 'discontinued' : 'as still made') + '?')) return;
      if (how === 'disc') {
        var items = list.map(function (e) { return { id: e.i, n: cleanName(e.n), before: cp(A.stEntry(e.i)) }; });
        list.forEach(function (e) { A.stSet(e.i, { status: 'retired', reason: 'manual', at: A.stToday(), n: cleanName(e.n), m: e.m }, false); });
        A.stSaveLocal(A.stLocal()); A.stQueueSync(); logAdd('status', 'Marked discontinued ' + list.length + ' (' + brand + ')', items);
      } else {
        var tg = A.triageGet(), it2 = list.map(function (e) { return { id: e.i, n: cleanName(e.n), had: !!tg.current[e.i] }; });
        list.forEach(function (e) { tg.current[e.i] = 1; }); A.triageSave(tg); logAdd('current', 'Still made ' + list.length + ' (' + brand + ')', it2);
      }
      paint(); if (root.toast) root.toast((how === 'disc' ? 'Discontinued: ' : 'Still made: ') + list.length + ' ' + brand);
    });
  }
  function wbBrandRegion(brand, region) {
    if (!brand) { if (root.toast) root.toast('Choose a brand'); return; }
    var tg = A.triageGet(), had = brand in tg.brandRegion, before = tg.brandRegion[brand];
    if (region) tg.brandRegion[brand] = region; else delete tg.brandRegion[brand];
    A.triageSave(tg); logAdd('brandregion', region ? brand + ' \u2192 ' + region : brand + ': region rule removed', [{ id: brand, n: brand, had: had, before: before }]); paint();
  }
  function wbUndo(lid) {
    var l = logAll(), en = l.filter(function (x) { return x.id === lid; })[0]; if (!en || en.undone) return;
    var done = function () { en.undone = new Date().toISOString(); logSave(l); _wb.det = {}; wbLogPaint(); paint(); if (root.toast) root.toast('Undone: ' + en.label); };
    if (en.kind === 'status') { en.items.forEach(function (x) { A.stSet(x.id, x.before || null, false); }); A.stSaveLocal(A.stLocal()); A.stQueueSync(); return done(); }
    if (en.kind === 'release') { var o = A.rlLocal(); en.items.forEach(function (x) { delete o.all[x.id]; o.pending[x.id] = Date.now() + Math.random(); }); A.rlSaveLocal(o); A.rlQueueSync(); return done(); }
    if (en.kind === 'region') { en.items.forEach(function (x) { A.regionTagSet(x.id, x.had ? x.before : undefined); }); return done(); }
    if (en.kind === 'current') { var tg = A.triageGet(); en.items.forEach(function (x) { if (!x.had) delete tg.current[x.id]; }); A.triageSave(tg); return done(); }
    if (en.kind === 'brandregion') { var tb = A.triageGet(); en.items.forEach(function (x) { if (x.had) tb.brandRegion[x.id] = x.before; else delete tb.brandRegion[x.id]; }); A.triageSave(tb); return done(); }
    if (en.kind === 'pictures') { en.items.forEach(function (x) { A.imgPickSet(x.id, x.url); }); return done(); }
    if (en.kind === 'specs') {
      en.items.reduce(function (p, x) { return p.then(function () { return A.catRestoreCorrection(x.id, x.store, x.before); }); }, Promise.resolve())
        .then(done, function (e) { if (root.toast) root.toast('Undo stopped: ' + (e && e.status ? 'GitHub ' + e.status : 'offline')); });
    }
  }
  function wbLog() { var el = document.getElementById('wbl-ov'); if (el) el.parentNode.removeChild(el); document.body.appendChild(A.overlay('wbl-ov', 925)); wbLogPaint(); }
  function wbLogPaint() {
    var ov = document.getElementById('wbl-ov'); if (!ov) return;
    var l = logAll(), when = function (t) { var d = new Date(t); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
    var row = function (x) {
      var names = x.items.slice(0, 6).map(function (i) { return i.n || i.id; }).join(', ') + (x.items.length > 6 ? ' and ' + (x.items.length - 6) + ' more' : '');
      return '<div style="padding:10px 0;border-bottom:1px solid var(--border1)"><div style="display:flex;gap:8px;align-items:center"><div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;color:var(--t1)">' + esc(x.label) + '</div>' +
        '<div style="font-size:11px;color:var(--t3)">' + esc(when(x.at)) + (x.undone ? ' \u00b7 undone ' + esc(when(x.undone)) : '') + '</div></div>' +
        (x.undone ? '<span style="font-size:12px;color:var(--t3)">undone</span>' : '<button style="' + A.BTN_G + 'padding:6px 12px;font-size:12px" onclick="wbUndo(\'' + jsq(x.id) + '\')">Undo</button>') + '</div>' +
        '<div style="font-size:12px;color:var(--t2);margin-top:3px;line-height:1.4">' + esc(names) + '</div></div>';
    };
    ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + A.BACK + '" onclick="var e=document.getElementById(\'wbl-ov\');e.parentNode.removeChild(e)">\u2039</button>' +
      '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Change log</div><div style="font-size:11px;color:var(--t3)">Workbench changes on this phone \u00b7 newest first</div></div></div>' +
      '<div style="flex:1;overflow-y:auto;padding:0 16px 16px">' + (l.length ? l.map(row).join('') : '<div style="padding:30px 0;text-align:center;color:var(--t2);font-size:13px">No changes yet.</div>') +
      '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:10px">Undo puts back what the change replaced: statuses, releases, corrections (on this phone or in the repo), region tags and picture links. Changes made outside the workbench aren\u2019t listed.</div></div>';
  }
  /* page notes on a read: discontinued, a region release */
  function wbMarkDisc(id) {
    A.catLoad().then(function (rows) { var e = A.byIdIn(rows, id); if (!e) return;
      logAdd('status', 'Marked discontinued 1 (the page said so)', [{ id: id, n: cleanName(e.n), before: cp(A.stEntry(id)) }]);
      A.stSet(id, { status: 'retired', reason: 'manual', at: A.stToday(), n: cleanName(e.n), m: e.m }); A.stQueueSync(); if (_wb.found[id]) _wb.found[id].retiredDone = true; paint(); });
  }
  function tagRegion(ids, v, rows) {
    var items = [], m = A.regionTags();
    ids.forEach(function (id) { var e = A.byIdIn(rows, id); items.push({ id: id, n: e ? cleanName(e.n) : id, had: id in m, before: m[id] }); A.regionTagSet(id, v); });
    logAdd('region', (v ? 'Tagged ' + v : v === '' ? 'Tagged US release' : 'Region from the name') + ' \u00b7 ' + ids.length, items);
  }
  function wbTagRegion(id, v) { A.catLoad().then(function (rows) { tagRegion([id], v, rows); paint(); }); }
  function wbRegionAsk() {
    var n = Object.keys(_wb.sel).length; if (!n || !root.openModal) return;
    var b = function (v, t) { return '<button class="btn btn-ghost" style="width:100%;text-align:left;margin-top:6px;padding:10px" onclick="wbRegionGo(' + (v === null ? 'null' : '\'' + v + '\'') + ')">' + t + '</button>'; };
    root.openModal('<div class="modal-title">Region for ' + n + ' ball' + (n === 1 ? '' : 's') + '</div>' + A.REGIONS.map(function (r) { return b(r, r + ' release'); }).join('') +
      b('', 'US release (even if the name says otherwise)') + b(null, 'Go by the name (remove my tag)') + '<button class="btn btn-secondary" style="width:100%;margin-top:10px" onclick="closeModal()">Cancel</button>');
  }
  function wbRegionGo(v) { A.catLoad().then(function (rows) { tagRegion(Object.keys(_wb.sel), v === null ? undefined : v, rows); _wb.sel = {}; if (root.closeModal) root.closeModal(); paint(); }); }
  /* picture-link checker: every saved cover link is loaded; the broken ones can be cleared (undo in the log) */
  function wbCheckLinks() {
    var m = A.imgPicks(), ids = Object.keys(m).filter(function (id) { return /^https?:/i.test(m[id]); }), bad = [], done = 0, next = 0;
    if (!ids.length) { if (root.toast) root.toast('No picture links saved on this phone'); return; }
    _wb.busy = 'checking ' + ids.length + ' picture links'; paint();
    var one = function () {
      if (next >= ids.length) return Promise.resolve();
      var id = ids[next++];
      return new Promise(function (res) {
        var im = new Image(), t = setTimeout(function () { im.src = ''; bad.push(id); res(); }, 10000);
        im.onload = function () { clearTimeout(t); res(); }; im.onerror = function () { clearTimeout(t); bad.push(id); res(); };
        im.src = m[id];
      }).then(function () { done++; if (done % 25 === 0) { _wb.busy = 'checked ' + done + ' of ' + ids.length; paint(); } return one(); });
    };
    Promise.all([one(), one(), one(), one(), one(), one()]).then(function () { _wb.busy = ''; _wb.broken = bad; paint(); wbBrokenShow(ids.length); });
  }
  function wbBrokenShow(total) {
    A.catLoad().then(function (rows) {
      var bad = _wb.broken || [], names = bad.slice(0, 15).map(function (id) { var e = A.byIdIn(rows, id); return esc(e ? e.m + ' ' + cleanName(e.n) : id); }).join(', ') + (bad.length > 15 ? ' and ' + (bad.length - 15) + ' more' : '');
      if (root.openModal) root.openModal('<div class="modal-title">Picture links checked</div><div style="font-size:13px;color:var(--t2);line-height:1.5">' + total + ' links \u00b7 ' + (bad.length ? bad.length + ' don\u2019t load: ' + names : 'all load') + '</div>' +
        (bad.length ? '<button class="btn btn-primary" style="width:100%;margin-top:12px" onclick="wbClearBroken()">Clear ' + bad.length + ' broken link' + (bad.length === 1 ? '' : 's') + '</button><div style="font-size:11px;color:var(--t3);margin-top:6px">Those balls go back to needing a picture. Undo is in the Change log.</div>' : '') +
        '<button class="btn btn-secondary" style="width:100%;margin-top:8px" onclick="closeModal()">Close</button>');
    });
  }
  function wbClearBroken() {
    A.catLoad().then(function (rows) { var m = A.imgPicks(), items = (_wb.broken || []).map(function (id) { var e = A.byIdIn(rows, id); return { id: id, n: e ? cleanName(e.n) : id, url: m[id] }; });
      items.forEach(function (x) { A.imgPickSet(x.id, null); }); logAdd('pictures', 'Cleared ' + items.length + ' broken picture links', items); _wb.broken = null; if (root.closeModal) root.closeModal(); paint(); });
  }
  function wbMore() {
    var it = function (t, sub, call) { return '<button class="btn btn-ghost" style="width:100%;text-align:left;margin-top:8px;padding:11px" onclick="closeModal();setTimeout(function(){' + call + '},350)"><div style="font-size:14px;font-weight:700;color:var(--t1)">' + t + '</div><div style="font-size:12px;color:var(--t3);margin-top:2px">' + sub + '</div></button>'; };
    if (root.openModal) root.openModal('<div class="modal-title">More catalog tools</div>' +
      it('Change log', 'Your workbench changes, with Undo', 'wbLog()') +
      it('Spec approvals', 'What the bridge read from maker sites, to approve and publish', 'catApprovalsOpen()') +
      it('Discontinued & rejected lists', 'Everything you marked, and the repo copy', 'catDiscOpen()') +
      it('Coverage', 'Specs by brand and year', 'catCovOpen()') +
      it('Copy page text Shortcut', 'Faster pastes from Safari', 'catShortcutHelp()') +
      it('Catalog backup', 'Save or restore pictures, corrections and lists', 'catBackupOpen()') +
      '<button class="btn btn-secondary" style="width:100%;margin-top:12px" onclick="closeModal()">Close</button>');
  }

  root.wbRepaint = function () { if (document.getElementById('wb-ov')) paint(); };
  root.wbOpen = wbOpen; root.wbClose = wbClose; root.wbTab = wbTab; root.wbGroup = wbGroup; root.wbBrand = wbBrand; root.wbYear = wbYear; root.wbState = wbState;
  root.wbQ = wbQ; root.wbPage = wbPage; root.wbSel = wbSel; root.wbSelAll = wbSelAll; root.wbSelNone = wbSelNone; root.wbOpenBall = wbOpenBall; root.wbPaste = wbPaste;
  root.wbPdf = wbPdf; root.wbPdfs = wbPdfs; root.wbDrop = wbDrop; root.wbReview = wbReview; root.wbSaveAll = wbSaveAll; root.wbPictureTool = wbPictureTool;
  root.wbStatus = wbStatus; root.wbStatusGo = wbStatusGo; root.wbSelectReady = wbSelectReady; root.wbRelease = wbRelease; root.wbMore = wbMore; root.wbFromMine = wbFromMine;
  root.wbUndo = wbUndo; root.wbLog = wbLog; root.wbMarkDisc = wbMarkDisc; root.wbTagRegion = wbTagRegion; root.wbRegionAsk = wbRegionAsk; root.wbRegionGo = wbRegionGo;
  root.wbRegion = wbRegion; root.wbBucket = wbBucket; root.wbFocus = wbFocus; root.wbLikely = wbLikely; root.wbBrandRegion = wbBrandRegion; root.wbCheckLinks = wbCheckLinks; root.wbClearBroken = wbClearBroken;
  root._wb = { log: logAll, state: function () { return _wb; }, mineAsRead: mineAsRead, missingOf: missingOf, groupOf: groupOf, matchBall: matchBall, formFrom: formFrom, WB_VERSION: WB_VERSION };
})(typeof window !== 'undefined' ? window : globalThis);
