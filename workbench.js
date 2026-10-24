/* BowlingDB Catalog workbench (v30.204 WB-3, dev mode). Loaded on first use by catalog.js
   (catWorkbenchOpen). v30.213: three tabs, Triage / Waiting / Status. Waiting (WAIT-1) replaces the
   Specs, Pictures, Release and Review tabs below (their code stays, reached only from Waiting):
     Specs    held balls that need specs; per row Find (maker / bowwwl), Paste, PDF; what was read shows
              on the row (Review / ✕); several PDFs at once are matched to their balls; Save all found.
     Pictures balls with no cover picture saved on this phone; opens the picture tool for the work.
     Status   current / discontinued / rejected; bulk discontinue, reject, restore with a preview.
     Release  held balls; ready = complete specs + a cover picture; Release ticked.
   Rows open Correct specs; saving opens the next ball in the list (Save & next).
   Uses catalog.js through root._catAPI only. Design: DESIGN_add_ball_flow sections 50-55. */
(function (root) {
  'use strict';
  var WB_VERSION = 'v30.222';
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
  var _wb = { tab: 'waiting', bucket: '', group: '', brand: '', year: '', state: '', q: '', page: 0, sel: {}, found: {}, det: {}, staged: null, busy: '' };

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
    if (_wb.tab === 'review') return [['', 'Any'], ['complete', 'Complete'], ['specs', 'Specs, no picture'], ['picture', 'Picture, specs short'], ['some', 'Some found'], ['none', 'Nothing yet'], ['unchecked', 'Not checked yet']];
    return [['', 'Any']];
  }
  function passState(e) {
    var s = _wb.state; if (!s) return true;
    if (_wb.tab === 'specs') return specState(e) === s;
    if (_wb.tab === 'status') return statusOf(e) === s;
    if (_wb.tab === 'release') { var d = _wb.det[e.i]; return s === 'ready' ? readyOf(e) : s === 'specs' ? !d || d.miss.length > 0 : !A.catImageStored(e.i); }
    if (_wb.tab === 'review') return rvStage(e) === s;
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
      if (!_wb.bucket && focusOn() && (_wb.tab === 'specs' || _wb.tab === 'pictures' || _wb.tab === 'release' || _wb.tab === 'review') && !inQueue(e)) return false;
      if (_wb.region) { var rg = A.regionOf(e); if (_wb.region === 'us' ? !!rg : _wb.region === 'intl' ? !rg : rg !== _wb.region) return false; }
      return passState(e);
    });
    if (_wb.tab === 'review') { var rk = { complete: 0, specs: 1, picture: 2, some: 3, none: 4, unchecked: 5 }; return list.sort(function (a, b) { return rk[rvStage(a)] - rk[rvStage(b)] || String(b.y || '').localeCompare(String(a.y || '')) || String(a.m).localeCompare(String(b.m)); }); }
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
          if (!b && _wb.loose && _wb.loose[e.i] && !_wb.found[e.i] && !_wb.looseDone[e.i]) { _wb.found[e.i] = looseFound(_wb.loose[e.i]); _wb.looseDone[e.i] = 1; }   // v30.213 LOOSE-1
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
    } else if (_wb.tab === 'review') {
      var rs = rvStage(e), mg = rvMerged(e), rpic = rvPicOf(e);
      extra = '<div style="font-size:12px;margin-top:4px;color:' + ({ complete: 'var(--teal)', specs: 'var(--gold)', picture: 'var(--gold)' }[rs] || 'var(--t3)') + '">' + esc(RV_STAGE[rs]) +
        (mg && mg.miss.length && rs !== 'unchecked' ? ' \u00b7 needs ' + esc(mg.miss.join(', ')) : '') + (rpic && !A.catImageStored(e.i) ? ' \u00b7 picture found, not saved' : '') + (_wb.found[e.i] ? ' \u00b7 specs read, not saved' : '') + (rvBridge(e) ? ' \u00b7 specs from the bridge, ' + (rvBridge(e).decision === 'auto' ? 'auto' : 'waiting approval') : '') + '</div>';
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
      var tab = function (k, t) { return '<button onclick="wbTab(\'' + k + '\')" style="' + (_wb.tab === k ? A.BTN_P : A.BTN_G) + 'flex:1;min-width:0;padding:8px 2px;font-size:12px">' + t + '</button>'; };
      var brands = {}; tabRows(rows).forEach(function (e) { if (!_wb.group || groupOf(e.m) === _wb.group) brands[e.m] = 1; });
      var groups = {}; tabRows(rows).forEach(function (e) { groups[groupOf(e.m)] = 1; });
      var years = {}; tabRows(rows).forEach(function (e) { if (parseInt(e.y, 10) >= 2021) years[e.y] = 1; });
      var nSel = Object.keys(_wb.sel).length, nFound = Object.keys(_wb.found).filter(function (id) { return _wb.found[id].nameSeen !== false; }).length;
      var bar = '';
      if (_wb.tab === 'specs') bar = '<button onclick="wbPdfs()" style="' + A.BTN_G + 'flex:1;padding:10px;font-size:13px">Pick PDFs</button><button id="wb-saveall" onclick="wbSaveAll()" ' + (nFound ? '' : 'disabled ') + 'style="' + A.BTN_P + 'flex:1;padding:10px;font-size:13px;' + (nFound ? '' : 'opacity:.45') + '">Save all found (' + nFound + ')</button>';
      else if (_wb.tab === 'pictures') bar = '<button onclick="wbCheckLinks()" style="' + A.BTN_G + 'flex:1;padding:10px;font-size:13px">Check picture links</button><button onclick="wbPictureTool()" style="' + A.BTN_P + 'flex:1;padding:10px;font-size:13px">Open the picture tool</button>';
      else if (_wb.tab === 'status') bar = '<button onclick="wbRegionAsk()" ' + (nSel ? '' : 'disabled ') + 'style="' + A.BTN_G + 'flex:1;padding:10px 4px;font-size:12px;' + (nSel ? '' : 'opacity:.45') + '">Region</button>' + ['discontinue', 'reject', 'restore'].map(function (k) { return '<button onclick="wbStatus(\'' + k + '\')" ' + (nSel ? '' : 'disabled ') + 'style="' + (k === 'reject' ? A.BTN_G + 'color:var(--red);' : A.BTN_G) + 'flex:1;padding:10px 4px;font-size:12px;' + (nSel ? '' : 'opacity:.45') + '">' + { discontinue: 'Discontinue', reject: 'Reject', restore: 'Restore' }[k] + ' ' + nSel + '</button>'; }).join('');
      else if (_wb.tab === 'review') bar = (_rv.fetch && !_rv.fetch.end ? '<button onclick="wbRvFetchStop()" style="' + A.BTN_G + 'flex:1;padding:10px 4px;font-size:12px">Stop (' + _rv.fetch.done + '/' + _rv.fetch.total + ')</button>' : '<button onclick="wbRvFetch()" style="' + A.BTN_G + 'flex:1;padding:10px 4px;font-size:12px">Fetch for these</button>') +
        '<button onclick="wbRvOpen()" style="' + A.BTN_G + 'flex:1;padding:10px 4px;font-size:12px">One by one</button><button onclick="wbRvAcceptAll()" style="' + A.BTN_P + 'flex:1;padding:10px 4px;font-size:12px">Accept all complete</button>';
      else bar = '<button onclick="wbSelectReady()" style="' + A.BTN_G + 'flex:1;padding:10px;font-size:13px">Tick all ready</button><button onclick="wbRelease()" ' + (nSel ? '' : 'disabled ') + 'style="' + A.BTN_P + 'flex:1;padding:10px;font-size:13px;' + (nSel ? '' : 'opacity:.45') + '">Release ' + nSel + '</button>';
      if (_wb.tab === 'triage') { ov.innerHTML = triageHTML(rows, c, stat, tab); return; }
      if (_wb.tab === 'waiting') { ov.innerHTML = waitingHTML(rows); return; }   // v30.213 WAIT-1
      var rvSum = '';
      if (_wb.tab === 'review') {
        var chk = list.filter(function (e) { return _wb.det[e.i]; }), nC = 0, nBr = 0, nPic = 0, nCore = 0;
        chk.forEach(function (e) { if (rvStage(e) === 'complete') nC++; if (rvBridge(e)) nBr++; if (_rv.pic[e.i] && !A.catImageStored(e.i)) nPic++; });
        nCore = Object.keys(_rv.core).length;
        var lf = _rv.last, when = lf ? new Date(lf.at).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + new Date(lf.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        rvSum = '<div style="margin:0 16px 8px;padding:8px 10px;border-radius:10px;background:var(--bg2);border:1px solid var(--border1);font-size:12px;color:var(--t1);line-height:1.5">' +
          (lf ? '<b>Last fetch ' + esc(when) + '</b>' + (lf.stopped ? ' (stopped)' : '') + ': ' + lf.checked + ' checked \u00b7 ' : '<b>Not fetched yet.</b> ') +
          'found, not saved: ' + nPic + ' cover' + (nPic === 1 ? '' : 's') + ', ' + nCore + ' core picture' + (nCore === 1 ? '' : 's') + '<br>' +
          chk.length + ' of ' + list.length + ' checked \u00b7 <span onclick="wbState(\'complete\')" style="color:var(--teal);cursor:pointer">' + nC + ' complete</span> \u00b7 ' + nBr + ' with specs from the bridge (not published yet)</div>';
      }
      var qline = rvSum + (_wb.bucket ? '<div style="padding:0 16px 6px;font-size:12px;color:var(--t2)">Bucket: <b>' + esc(bucketName(_wb.bucket)) + '</b> \u00b7 <span onclick="wbBucket(\'\')" style="color:var(--teal);cursor:pointer">clear</span></div>' :
        (_wb.tab === 'specs' || _wb.tab === 'pictures' || _wb.tab === 'release' || _wb.tab === 'review') ? '<div style="padding:0 16px 6px;font-size:12px;color:var(--t2)">' + (focusOn() ? 'Work queue: current US balls and ones not out yet \u00b7 <span onclick="wbFocus(false)" style="color:var(--teal);cursor:pointer">Show all</span>' : 'Showing every ball \u00b7 <span onclick="wbFocus(true)" style="color:var(--teal);cursor:pointer">Work queue only</span>') + '</div>' : '');
      var help = { specs: 'Held balls that still need specs. Paste or PDF on a row reads a page for that ball; <b>Pick PDFs</b> takes several saved pages at once and puts each on its ball. Check a row\u2019s read with Review, then <b>Save all found</b>. Tap a ball to edit it; saving opens the next one.',
        pictures: 'Balls with no cover picture saved on this phone. The picture tool does the work (Find, Paste, Photo, Check bowwwl for all, Save all found). <b>Check picture links</b> loads every saved link and offers to clear the ones that no longer load.',
        status: 'Tick balls to discontinue, reject (needs a reason), restore, or set their <b>Region</b>. You see what will change before it does; balls you own are never changed in bulk. Every change can be undone: More \u203a Change log.',
        review: 'One ball at a time: what is known and what was found, with Paste and PDF for specs and Paste or Photo for pictures. <b>Fetch for these</b> reads what the bridge found and looks on bowwwl for cover and core pictures (nothing is saved until you accept). <b>Accept all complete</b> saves and releases every ball with complete specs and a picture, after a count to confirm. Undo: More \u203a Change log.',
        release: 'Held balls. A ball is ready with complete specs and a cover picture on this phone. Released balls show in Add a Ball here at once, and for everyone after the next catalog refresh.' }[_wb.tab];
      ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 6px"><button style="' + A.BACK + '" onclick="wbClose()">\u2039</button>' +
        '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Catalog workbench</div><div style="font-size:11px;color:var(--t3)">2021 and newer, plus yours \u00b7 ' + esc(_wb.busy || 'dev mode') + '</div></div>' +
        '<button onclick="catUpdateOpen()" style="' + A.BTN_P + 'padding:7px 10px;font-size:12px">Update</button><button onclick="wbMore()" style="' + A.BTN_G + 'padding:7px 10px;font-size:12px">More</button></div>' + updLine() +
        '<div style="display:flex;gap:6px;padding:0 16px 8px">' + tab('triage', 'Triage') + tab('waiting', 'Waiting') + tab('status', 'Status') + '</div>' +
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
      if (_wb.tab === 'specs' || _wb.tab === 'release' || _wb.tab === 'review') loadDetails(shown).then(function (n) { if (n) paint(); });
    });
  }

  /* ---------- actions ---------- */
  function wbOpen(opt) {
    if (typeof document === 'undefined') return;
    var mb = document.getElementById('modal-bg'); if (mb && mb.classList.contains('open') && root.closeModal) root.closeModal();
    wbClose(); opt = opt || {}; if (opt.tab) _wb.tab = opt.tab;   // remembers the last tab; Triage the first time _wb.page = 0; _wb.sel = {};
    document.body.appendChild(A.overlay('wb-ov', 905)); paint();
    _wb.stagedP = Promise.resolve();
    if (A.apToken()) {
      A.apReadOverrides().then(paint, function () {});
      /* v30.213: Waiting waits for the staged rows (bridge reads and near matches) before sorting balls into groups */
      _wb.stagedP = A.apReadStaged().then(function (st) { var w = {}; (st || []).forEach(function (r) { if (r.decision === 'pending') { if (r.catalogId) w[r.catalogId] = 1; (r.candidates || []).forEach(function (id) { w[id] = 1; }); } }); _wb.staged = w; _wb.stagedRows = st;
        return A.catLoad().then(function (rows) { var h = wtHeld(rows).filter(function (e) { return !A.srvStagedRow(st, e.i); }); _wb.loose = looseMap(st, h); _wb.looseDone = _wb.looseDone || {}; paint(); }); }, function () {});
      bwResume();
      if (runGet()) setTimeout(wtRunPaint, 600);   // v30.222: the saving run you left
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
    if (_wb.tab === 'review') return wbRvOpen(id);   // v30.210: the review card
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
      if (_rv.after && document.getElementById('rv-ov')) { _rv.after = null; if (n) { _rv.ids.splice(_rv.idx, 1); if (_rv.idx >= _rv.ids.length) _rv.idx = Math.max(0, _rv.ids.length - 1); } if (!_rv.ids.length) wbRvClose(); else rvPaint(); }
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

  /* ---------- v30.210: batch review ----------
     Review tab: held balls in the work queue, complete ones first. Fetch for these loads every ball's
     details (published + your corrections + what the bridge read) and looks on bowwwl for cover and core
     pictures; finds are kept here (this session) until you accept. One by one: a card per ball with
     Paste / PDF / Edit for specs, Paste / Photo for the cover and core pictures, and Accept and release,
     Accept, Discontinued, Reject, Skip. Accept all complete: every ball with complete specs and a cover
     picture, after a count. Each run writes one Change log entry per kind (specs, pictures, release). */
  var _rv = { pic: {}, core: {}, idx: 0, ids: [], fetch: null, miss: {}, coreMiss: {}, last: null };
  /* v30.212: picture finds (links), misses and the last fetch survive closing the app (pasted files do not) */
  var FINDS_KEY = 'bowlingdb_wb_finds', MISS_DAYS = 14;
  function rvLoadFinds() {
    try { var o = JSON.parse(localStorage.getItem(FINDS_KEY) || 'null'); if (!o) return;
      _rv.pic = o.pic || {}; _rv.core = o.core || {}; _rv.miss = o.miss || {}; _rv.coreMiss = o.coreMiss || {}; _rv.last = o.last || null; } catch (e) {}
  }
  function rvSaveFinds() {
    var keep = function (m) { var o = {}; Object.keys(m).forEach(function (k) { var x = m[k]; if (x && x.link && !x.blob) o[k] = { url: x.url, how: x.how, link: true, brand: x.brand, name: x.name }; }); return o; };
    try { localStorage.setItem(FINDS_KEY, JSON.stringify({ pic: keep(_rv.pic), core: keep(_rv.core), miss: _rv.miss, coreMiss: _rv.coreMiss, last: _rv.last })); } catch (e) {}
  }
  function missFresh(d) { return d && (Date.now() - Date.parse(d)) < MISS_DAYS * 864e5; }
  rvLoadFinds();
  /* v30.212: specs that came from a bridge read not yet published: 'auto' publishes with the next Publish, 'pending' needs its box ticked */
  function rvBridge(e) { var d = _wb.det[e.i]; return d && !e.s && d.base && (d.base.decision === 'auto' || d.base.decision === 'pending') ? d.base : null; }
  var RV_STAGE = { complete: 'complete: ready to accept and release', specs: 'specs complete, no picture', picture: 'picture, specs short', some: 'some specs found', none: 'nothing found yet', unchecked: 'not checked yet' };
  /* a read (Paste / PDF) laid over what is known */
  function mergeFound(sp, f) {
    var out = cp(sp || {}) || {}; out.weights = out.weights || {}; if (!f) return out;
    var fm = formFrom(f);
    ['coverName', 'coverType', 'finish', 'core', 'coreType', 'released'].forEach(function (k) { if (fm[k]) out[k] = fm[k]; });
    Object.keys(fm.weights || {}).forEach(function (w) { var x = fm.weights[w], o = out.weights[w] = Object.assign({}, out.weights[w] || {});
      ['RG', 'Diff', 'IntDiff'].forEach(function (k) { if (x[k] !== '' && x[k] != null) o[k] = +x[k]; }); });
    return out;
  }
  function rvMerged(e) { var d = _wb.det[e.i]; if (!d) return null; var sp = mergeFound(d.sp, _wb.found[e.i]); return { sp: sp, miss: missingOf(sp) }; }
  function rvPicOf(e) { return (_rv.pic[e.i] && _rv.pic[e.i].url) || A.catImageStored(e.i) || null; }
  function rvCoreKey(e, sp) { return sp && sp.core ? A.coreKeyOf(e.m, sp.core) : null; }
  function rvCorePic(e, sp) { var k = rvCoreKey(e, sp); return k ? ((_rv.core[k] && _rv.core[k].url) || A.catCoreImageFor(e.m, sp.core) || null) : null; }   // v30.215: a find shows over the saved one
  function rvStage(e) {
    var m = rvMerged(e); if (!m) return 'unchecked';
    var pic = !!rvPicOf(e), full = !m.miss.length, any = Object.keys(m.sp.weights || {}).length > 0 || REQ.some(function (r) { return m.sp[r[0]]; });
    return full && pic ? 'complete' : full ? 'specs' : pic ? 'picture' : any ? 'some' : 'none';
  }
  function rvList(cb) { if (_wb.fetchList) { var fl = _wb.fetchList; _wb.fetchList = null; return A.catLoad().then(function (rows) { cb(fl, rows); }); }   // v30.213: Waiting's Find pictures
    A.catLoad().then(function (rows) { var t = _wb.tab; _wb.tab = 'review'; var l = filtered(rows); _wb.tab = t; cb(l, rows); }); }
  function probeFirst(c) { var next = function (i) { return i >= c.length ? Promise.resolve(null) : A.imgProbe(c[i], 6000).then(function (u) { return u || next(i + 1); }); }; return next(0); }
  function wbRvFetch() {
    rvList(function (list) {
      if (!list.length) return;
      var f = _rv.fetch = { total: list.length, done: 0, pics: 0, cores: 0, stop: false }; _wb.busy = 'checking ' + list.length; paint();
      loadDetails(list).then(function () {
        var i = 0, last = 0;
        var tick = function () { var t = Date.now(); if (t - last > 800) { last = t; _wb.busy = 'fetching ' + f.done + ' of ' + f.total; paint(); rvPaint(); } };
        var one = function () {
          if (f.stop || i >= list.length) return Promise.resolve();
          var e = list[i++], nm = cleanName(e.n), m = rvMerged(e);
          var day = new Date().toISOString().slice(0, 10);
          var cov = A.catImageStored(e.i) || _rv.pic[e.i] || missFresh(_rv.miss[e.i]) ? Promise.resolve() : probeFirst(A.bowwwlImgCandidates(e.m, nm)).then(function (u) { if (u) { _rv.pic[e.i] = { url: u, how: 'bowwwl', link: true }; delete _rv.miss[e.i]; f.pics++; } else _rv.miss[e.i] = day; });
          var ck = m && rvCoreKey(e, m.sp);
          var cor = !ck || rvCorePic(e, m.sp) || missFresh(_rv.coreMiss[ck]) ? Promise.resolve() : probeFirst(A.bowwwlCoreCandidates(e.m, m.sp.core)).then(function (u) { if (u) { _rv.core[ck] = { url: u, how: 'bowwwl', link: true, brand: e.m, name: m.sp.core }; delete _rv.coreMiss[ck]; f.cores++; } else _rv.coreMiss[ck] = day; });
          return Promise.all([cov, cor]).then(function () { f.done++; if (f.done % 20 === 0) rvSaveFinds(); tick(); return one(); });
        };
        return Promise.all([one(), one(), one(), one()]);
      }).then(function () {
        f.end = true; _wb.busy = ''; _rv.last = { at: new Date().toISOString(), checked: f.done, pics: f.pics, cores: f.cores, stopped: !!f.stop }; rvSaveFinds();
        if (root.toast) root.toast((f.stop ? 'Stopped. ' : '') + 'Found ' + f.pics + ' cover and ' + f.cores + ' core picture' + (f.cores === 1 ? '' : 's') + ' (not saved yet)');
        paint(); rvPaint();
      });
    });
  }
  function wbRvFetchStop() { if (_rv.fetch) _rv.fetch.stop = true; }
  /* saves one ball's finds; returns log items; release only when complete */
  function rvAcceptOne(e, release, rows, force) {   // v30.217 force: release even with gaps (you confirmed)
    var out = { specs: null, pic: null, rel: null, core: null, ticks: null }, d = _wb.det[e.i], f = _wb.found[e.i];
    var sp0 = d ? d.sp : null;
    var specs = !f ? Promise.resolve() : (function () {
      var form = formFrom(f), store = form.source === 'bowwwl' ? 'phone' : 'repo';
      var before = cp(store === 'phone' ? A.localOverrides()[e.i] : A.repoOverride(e.i));
      return A.catSaveCorrection(e.i, form, d ? d.base : null).then(function (r) {
        if (r.ok) out.specs = { id: e.i, n: cleanName(e.n), store: store, before: before };
        if (r.ok || r.msg === 'Nothing changed.') delete _wb.found[e.i]; else throw new Error(r.msg || 'not saved');
      });
    })();
    var br = rvBridge(e);
    var tick = !br || br.decision !== 'pending' ? Promise.resolve() : rvBoxes().then(function (boxes) {
      var mine = boxes.filter(function (b) { return b.catalogId === e.i; }), byUrl = mine.filter(function (b) { return br.url && b.url === br.url; });
      var pick = byUrl.length ? byUrl : mine; if (!pick.length) return;
      var q = A.apQueue(), before = {}; pick.forEach(function (b) { before[b.tok] = (b.tok in q) ? q[b.tok] : null; q[b.tok] = true; }); A.apSetQueue(q);
      out.ticks = { id: e.i, n: cleanName(e.n), before: before };
    }, function () {});
    return specs.then(function () { return tick; }).then(function () {
      var pf = _rv.pic[e.i];
      return pf && !A.catImageStored(e.i) ? A.catSaveCover(e.i, pf).then(function (b) { out.pic = { id: e.i, url: b.url, file: b.file }; delete _rv.pic[e.i]; }) : null;
    }).then(function () {
      var sp = mergeFound(sp0, null), k = rvCoreKey(e, d ? mergeFound(d.sp, f) : sp), cf = k && _rv.core[k];
      if (!cf) return null;
      return A.catSaveCore(cf.brand, cf.name, cf).then(function () { out.core = cf; delete _rv.core[k]; });
    }).then(function () {
      delete _wb.det[e.i];
      return loadDetails([e]);
    }).then(function () {
      if (!release) return out;
      var m = rvMerged(e), o = A.rlLocal();
      if (!m || o.all[e.i] || (!force && (m.miss.length || !A.catImageStored(e.i)))) return out;
      o.all[e.i] = { at: A.stToday(), n: cleanName(e.n), m: e.m }; o.pending[e.i] = Date.now() + Math.random(); A.rlSaveLocal(o);
      out.rel = { id: e.i, n: cleanName(e.n) }; return out;
    }).then(function (r) { rvSaveFinds(); return r; });
  }
  var _rvBoxP = null;
  function rvBoxes() {
    if (!_rvBoxP) _rvBoxP = A.apFetchIssue().then(function (is) { return A.apParseIssue(is.body); }).catch(function (er) { _rvBoxP = null; throw er; });
    return _rvBoxP;
  }
  function rvLog(results, label) {
    var sp = [], pc = [], rl = [], tk = [];
    results.forEach(function (r) { if (r.specs) sp.push(r.specs); if (r.pic) pc.push(r.pic); if (r.rel) rl.push(r.rel); if (r.ticks) tk.push(r.ticks); });
    logAdd('specs', label + ': specs ' + sp.length, sp); logAdd('pictures', label + ': cover pictures ' + pc.length, pc); logAdd('release', label + ': released ' + rl.length, rl);
    logAdd('ticks', label + ': ticked in Spec approvals ' + tk.length, tk);
    if (rl.length) A.rlQueueSync();
    return { specs: sp.length, pics: pc.length, rel: rl.length, ticks: tk.length };
  }
  function wbRvAcceptAll() {
    rvList(function (list) {
      loadDetails(list).then(function () {
        var go = list.filter(function (e) { return rvStage(e) === 'complete'; });
        if (!go.length) { if (root.toast) root.toast('Nothing complete yet. Fetch for these, or review one by one.'); paint(); return; }
        if (root.confirm && !root.confirm('Accept and release ' + go.length + ' complete ball' + (go.length === 1 ? '' : 's') + '? Found specs and pictures are saved, then each ball shows in Add a Ball. Undo from the Change log.')) return;
        var res = [], bad = []; _wb.busy = 'accepting ' + go.length; paint();
        go.reduce(function (p, e) { return p.then(function () { return rvAcceptOne(e, true).then(function (r) { res.push(r); }, function (er) { bad.push(cleanName(e.n) + ': ' + (er && er.message)); }); }); }, Promise.resolve())
          .then(function () {
            var n = rvLog(res, 'Accept all'); _wb.busy = ''; paint();
            if (root.toast) root.toast('Released ' + n.rel + (n.specs ? ' \u00b7 specs saved ' + n.specs : '') + (n.pics ? ' \u00b7 pictures ' + n.pics : '') + (n.ticks ? ' \u00b7 ticked ' + n.ticks + ' in Spec approvals: Publish to finish' : '') + (bad.length ? ' \u00b7 ' + bad.length + ' not saved' : ''), 6000);
            if (bad.length && root.openModal) root.openModal('<div class="modal-title">Not saved</div><div style="font-size:13px;color:var(--t2);line-height:1.5">' + bad.map(esc).join('<br>') + '</div><button class="btn btn-secondary" style="width:100%;margin-top:10px" onclick="closeModal()">OK</button>');
          });
      });
    });
  }
  /* ---------- the card ---------- */
  function wbRvOpen(id) {
    rvList(function (list) {
      _rv.ids = list.map(function (e) { return e.i; }); _rv.idx = Math.max(0, id ? _rv.ids.indexOf(id) : 0);
      if (!_rv.ids.length) { if (root.toast) root.toast('Nothing to review here'); return; }
      var el = document.getElementById('rv-ov'); if (el) el.parentNode.removeChild(el);
      document.body.appendChild(A.overlay('rv-ov', 912)); rvPaint();
    });
  }
  function wbRvClose() { var el = document.getElementById('rv-ov'); if (el) el.parentNode.removeChild(el); paint(); }
  function wbRvNext(step) { _rv.idx = Math.min(_rv.ids.length - 1, Math.max(0, _rv.idx + (step || 1))); rvPaint(); }
  function rvCur(cb) { A.catLoad().then(function (rows) { var e = A.byIdIn(rows, _rv.ids[_rv.idx]); if (e) cb(e, rows); }); }
  function rvPaint() {
    var ov = document.getElementById('rv-ov'); if (!ov) return;
    rvCur(function (e) {
      if (!_wb.det[e.i]) { loadDetails([e]).then(rvPaint); ov.innerHTML = '<div style="padding:40px;text-align:center;color:var(--t3)">Loading\u2026</div>'; return; }
      var m = rvMerged(e), sp = m.sp, f = _wb.found[e.i], d = _wb.det[e.i], own = ownedMap();
      var stored = A.catImageStored(e.i), found = _rv.pic[e.i], cpic = rvCorePic(e, sp), ck = rvCoreKey(e, sp), cfound = ck && _rv.core[ck];
      var srcOf = function (k) { return f && formFrom(f)[k] ? 'read, not saved' : d.sp[k] ? 'saved' : ''; };
      var fld = function (t, k) { var v = sp[k], s2 = srcOf(k); return '<div onclick="wtEdit(\'' + idq + '\',\'' + k + '\')" style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border1);font-size:13px;cursor:pointer"><div style="flex:0 0 34%;color:var(--t3)">' + t + '</div>' +
        '<div style="flex:1;min-width:0;color:' + (v ? 'var(--t1)' : 'var(--gold)') + '">' + (v ? esc(v) : 'missing') + (s2 === 'read, not saved' ? ' <span style="font-size:10px;color:#7aa7ff">NEW</span>' : '') + '</div></div>'; };
      var ws = Object.keys(sp.weights || {}).sort(function (a, b) { return b - a; });
      var wtab = ws.length ? '<div style="font-size:12px;color:var(--t2);margin-top:6px">' + ws.map(function (w) { var x = sp.weights[w] || {}, fw = f && f.weights && f.weights[w];
        return '<div onclick="wtEditW(\'' + idq + '\',\'' + w + '\')" style="display:flex;gap:8px;padding:3px 0;cursor:pointer' + (fw ? ';color:#7aa7ff' : '') + '"><span style="flex:0 0 46px">' + w + ' lb</span><span>RG ' + (x.RG != null ? Number(x.RG).toFixed(3) : '\u2014') + '</span><span>Diff ' + (x.Diff != null ? Number(x.Diff).toFixed(3) : '\u2014') + '</span>' + (x.IntDiff != null ? '<span>Int ' + Number(x.IntDiff).toFixed(3) + '</span>' : '') + '</div>'; }).join('') + '<div onclick="wtEditW(\'' + idq + '\',\'\')" style="color:var(--teal);cursor:pointer;padding:3px 0">+ add a weight</div></div>' : '<div onclick="wtEditW(\'' + idq + '\',\'\')" style="font-size:12px;color:var(--gold);margin-top:6px;cursor:pointer">No RG / Diff yet \u00b7 <span style="color:var(--teal)">+ add a weight</span></div>';
      var picBox = function (u, lab, note, slot) { return '<div style="flex:1;min-width:0;text-align:center"><div style="height:124px;border-radius:12px;background:var(--bg2);border:1px solid var(--border1);display:flex;align-items:center;justify-content:center;overflow:hidden">' +
        (u ? '<img src="' + esc(u) + '" referrerpolicy="no-referrer" style="width:116px;height:116px;border-radius:50%;object-fit:contain;background:#fff">' : '<span style="font-size:12px;color:var(--t3)">no ' + lab + '</span>') + '</div><div style="font-size:11px;color:' + (note === 'found, not saved' ? '#7aa7ff' : 'var(--t3)') + ';margin-top:3px">' + lab + (note ? ' \u00b7 ' + note : '') +
        (u && slot ? ' \u00b7 <span onclick="wtPicClear(\'' + idq + '\',\'' + slot + '\')" style="color:var(--red);cursor:pointer">\u2715 ' + (note === 'found, not saved' ? 'drop' : 'remove') + '</span>' : '') + '</div></div>'; };
      var stg = rvStage(e), canRel = !m.miss.length && !!(stored || found), br = rvBridge(e);
      var brNote = br ? '<div style="font-size:12px;color:#7aa7ff;margin:-2px 0 8px;line-height:1.4">Specs from a bridge read' + (br.url ? ' (' + esc(String(br.url).replace(/^https?:\/\/(www\.)?/, '').split('/')[0]) + ')' : '') + ', not published yet: ' +
        (br.decision === 'auto' ? 'auto-matched, publishes with the next Publish.' : 'Accept ticks it in Spec approvals; Publish to finish.') + '</div>' : '';
      var k = A.triageOf(e), chip = k === 'upcoming' ? 'NOT OUT YET' : k === 'likely' ? 'LIKELY DISC.' : k === 'discontinued' ? 'DISCONTINUED' : '';
      var b = function (t, js, p, dis) { return '<button onclick="' + js + '" ' + (dis ? 'disabled ' : '') + 'style="' + (p ? A.BTN_P : A.BTN_G) + 'flex:1;padding:9px 4px;font-size:12px' + (dis ? ';opacity:.45' : '') + '">' + t + '</button>'; };
      var idq = jsq(e.i), bw = A.bowwwlLinks(e.m, cleanName(e.n));
      ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 6px"><button style="' + A.BACK + '" onclick="wbRvClose()">\u2039</button>' +
        '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(cleanName(e.n)) + '</div>' +
        '<div style="font-size:11px;color:var(--t3)">' + esc(e.m) + (e.y ? ' \u00b7 ' + esc(e.y) : '') + ' \u00b7 ' + (_rv.idx + 1) + ' of ' + _rv.ids.length + (own[e.i] ? ' \u00b7 yours' : '') + (chip ? ' \u00b7 ' + chip : '') + '</div></div>' +
        '<button style="' + A.BTN_G + 'padding:7px 10px;font-size:12px" onclick="wbRvNext(-1)" ' + (_rv.idx ? '' : 'disabled') + '>\u2039 Prev</button></div>' +
        '<div style="flex:1;overflow-y:auto;padding:0 16px 10px">' +
          '<div style="font-size:12px;margin-bottom:8px;color:' + (stg === 'complete' ? 'var(--teal)' : 'var(--gold)') + '">' + esc(RV_STAGE[stg]) + (m.miss.length ? ' \u00b7 needs ' + esc(m.miss.join(', ')) : '') + '</div>' +
          '<div style="margin:-4px 0 8px">' + confChip('specs', specConf(e)) + confChip('picture', picConf(e)) + '</div>' +
          brNote + '<div style="display:flex;gap:10px">' + picBox((found && found.url) || stored, 'cover', found ? 'found, not saved' : stored ? 'saved' : '', 'cover') + picBox(cpic, 'core', sp.core ? (cfound ? 'found, not saved' : cpic ? 'saved' : '') : 'core name unknown', 'core') + '</div>' +
          '<div style="display:flex;gap:6px;margin-top:6px">' + b('Paste cover', "wbRvPastePic('" + idq + "','cover')") + b('Photo', "wbRvPhoto('" + idq + "','cover')") + b('Paste core', "wbRvPastePic('" + idq + "','core')") + b('Photo', "wbRvPhoto('" + idq + "','core')") + '</div>' +
          '<div style="font-size:11px;font-weight:700;color:var(--t3);letter-spacing:.5px;margin:14px 0 2px">SPECS</div>' +
          fld('Coverstock', 'coverName') + fld('Cover type', 'coverType') + fld('Finish', 'finish') + fld('Core', 'core') + fld('Core type', 'coreType') + fld('Released', 'released') + wtab +
          (f ? '<div style="font-size:12px;color:#7aa7ff;margin-top:6px">' + esc(foundLine(f)) + (f.warn ? '<div style="color:var(--gold)">' + esc(f.warn) + '</div>' : f.nameSeen === false ? '<div style="color:var(--gold)">The page doesn\u2019t name this ball: check it is the right one.</div>' : '') +
            (f.retired && A.triageOf(e) !== 'discontinued' ? '<div style="color:var(--gold)">The page says it\u2019s discontinued \u00b7 <span onclick="wtPageDisc(\'' + idq + '\')" style="color:var(--teal);cursor:pointer">Mark discontinued</span></div>' : '') +
            (f.region && A.regionOf(e) !== f.region ? '<div style="color:#7aa7ff">The page says ' + esc(f.region) + ' release \u00b7 <span onclick="wtPageRegion(\'' + idq + '\',\'' + jsq(f.region) + '\')" style="color:var(--teal);cursor:pointer">Tag it</span></div>' : '') + '</div>' : '') +
          '<div style="display:flex;gap:6px;margin-top:8px">' + b(_bw[e.i] ? 'Reading\u2026' : 'Read bowwwl', "wbBwRead('" + idq + "')", !_bw[e.i] && !f, !!_bw[e.i]) + b('Paste specs', "wbRvPasteSpecs('" + idq + "')") + b('PDF', "wbRvPdf('" + idq + "')") + b('Edit', "wbRvEdit('" + idq + "')") + '</div>' +
          '<div style="display:flex;gap:6px;margin-top:6px">' + b('Copy specs from another color or ball\u2026', "wtCopyOpen('" + idq + "')") + '</div>' +
          (_bw[e.i] ? '<div style="font-size:11px;color:#7aa7ff;margin-top:4px">Reading the bowwwl page on GitHub (about a minute). You can move on; it lands here when done.</div>' : '') +
          '<div style="font-size:11px;color:var(--t3);margin-top:8px">Look it up: ' + a2(webSearch(e), 'search \u2197') + ' \u00b7 <a href="' + esc(bw.maker || bw.search) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal)">maker \u2197</a> \u00b7 <a href="' + esc(bw.page) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal)">bowwwl \u2197</a> \u00b7 copy the page or picture there, then Paste here. Paste also takes a PDF (Share \u203a Options \u203a PDF \u203a Copy). Tap any spec or weight to type it in.</div>' +
        '</div>' +
        '<div style="padding:8px 16px;border-top:1px solid var(--border1)"><div style="display:flex;gap:6px">' + b(canRel ? 'Accept and release' : 'Release with gaps\u2026', "wbRvAccept('" + idq + "',true)", canRel, !!A.rlLocal().all[e.i]) + b('Accept', "wbRvAccept('" + idq + "',false)", false, !(f || found || cfound || (br && br.decision === 'pending'))) + '</div>' +
          '<div style="display:flex;gap:6px;margin-top:6px">' + b('Mark\u2026', "wtMarkAsk(null,'" + idq + "')") + b('Skip \u203a', 'wbRvNext(1)') + '</div></div>';
    });
  }
  function wbRvPastePic(id, slot) { wtKeep(id);
    A.catPastePicture(function (f) { rvSetPic(id, slot, f); });
  }
  function rvSetPic(id, slot, f) {
    A.catLoad().then(function (rows) { var e = A.byIdIn(rows, id); if (!e) return;
      if (slot === 'cover') _rv.pic[id] = f;
      else { var m = rvMerged(e), k = m && rvCoreKey(e, m.sp);
        /* v30.220: no core name yet: keep the picture and ask for the name, then file it under that core */
        if (!k) { _wt.pendCore = _wt.pendCore || {}; _wt.pendCore[id] = f; if (root.toast) root.toast('Which core is it? Type its name.'); wtEdit(id, 'core'); return; }
        f.brand = e.m; f.name = m.sp.core; _rv.core[k] = f; }
      rvPaint(); paint(); });
  }
  function wbRvPhoto(id, slot) { wtKeep(id);
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
    inp.addEventListener('change', function () { var fl = inp.files && inp.files[0]; if (inp.parentNode) inp.parentNode.removeChild(inp); if (!fl) return;
      A.imgShrink(fl).then(function (bl) { rvSetPic(id, slot, { blob: bl, url: URL.createObjectURL(bl), how: 'photo' }); }); });
    document.body.appendChild(inp); inp.click();
  }
  function wtKeep(id) { if (_wt.open && !document.getElementById('rv-ov')) (_wt.keep = _wt.keep || {})[_wt.open + '|' + id] = 1; }
  function wbRvPasteSpecs(id) { wtKeep(id);
    A.catLoad().then(function (rows) { var e = A.byIdIn(rows, id); if (!e) return;
      A.spReadClipboard(function (text) { var r = A.parseSpecText(text, 15, cleanName(e.n)); if (!r || (!Object.keys(r.fields || {}).length && !Object.keys(r.weights || {}).length)) { if (root.toast) root.toast('No specs found in what was pasted'); return; } _wb.found[id] = r; rvPaint(); paint(); wtCompare(id); }); });   // v30.219: show what changes
  }
  function wbRvPdf(id) { wtKeep(id);
    A.catLoad().then(function (rows) { var e = A.byIdIn(rows, id); if (!e) return;
      pickPdfs(false, function (fs) { if (root.toast) root.toast('Reading the PDF\u2026');
        A.spPdfFileText(fs[0]).then(function (t) { if (!t) { if (root.toast) root.toast('No text in that PDF'); return; } _wb.found[id] = A.parseSpecText(t, 15, cleanName(e.n)); rvPaint(); paint(); wtCompare(id); }, function () { if (root.toast) root.toast('Could not read the PDF'); }); }); });
  }
  function wbRvEdit(id) {
    if (_wb.found[id]) A.catCorrectWithParsed(id, _wb.found[id], function () { delete _wb.found[id]; delete _wb.det[id]; rvPaint(); });
    else A.catCorrectFor(id, function () { delete _wb.det[id]; rvPaint(); });
  }
  function wbRvAccept(id, release) {
    rvCur(function (e) {
      if (e.i !== id) return;
      /* v30.217: with gaps, ask instead of refusing (plastic balls have no RG / Diff; some pages give no date) */
      var m = rvMerged(e), gaps = m ? m.miss.slice() : [], force = false;
      if (release && !rvPicOf(e)) gaps.push('a cover picture');
      if (release && gaps.length) {
        if (root.confirm && !root.confirm('Release ' + cleanName(e.n) + ' into Add a Ball without ' + gaps.join(', ') + '?\n\nIt shows with those blank; you can fill them in later and they update.')) return;
        force = true;
      }
      rvAcceptOne(e, release, null, force).then(function (r) {
        rvLog([r], cleanName(e.n));
        var bits = [r.specs && 'specs', r.ticks && 'ticked in Spec approvals', r.pic && 'picture', r.core && 'core picture', r.rel && 'released'].filter(Boolean);
        if (root.toast) root.toast(bits.length ? 'Saved: ' + bits.join(', ') : 'Nothing new to save');
        if (r.core) A.catCoreShareOffer(r.core.brand, r.core.name, r.core); else if (r.specs) cpOfferAfter(e);   // v30.218
        if (r.rel) { _rv.ids.splice(_rv.idx, 1); if (_rv.idx >= _rv.ids.length) _rv.idx = Math.max(0, _rv.ids.length - 1); if (!_rv.ids.length) return wbRvClose(); }
        rvPaint(); paint();
      }, function (er) { if (root.toast) root.toast('Not saved: ' + (er && er.message)); });
    });
  }
  function wbRvDisc(id) {
    rvCur(function (e) {
      var before = cp(A.stEntry(id));
      A.stSet(id, { status: 'retired', reason: 'manual', at: A.stToday(), n: cleanName(e.n), m: e.m }, false); A.stSaveLocal(A.stLocal()); A.stQueueSync();
      logAdd('status', 'Marked discontinued ' + cleanName(e.n), [{ id: id, n: cleanName(e.n), before: before }]);
      if (root.toast) root.toast('Marked discontinued: ' + cleanName(e.n));
      wbRvNext(1);
    });
  }
  function wbRvReject(id) { _wb.sel = {}; _wb.sel[id] = 1; _rv.after = 'reject'; wbStatus('reject'); }

  /* ---------- v30.213 WAIT-1: Waiting for Add a Ball (replaces Specs, Pictures, Release, Review) ----------
     One screen for the held balls: each is put in one group by what is known (full / partial / no specs,
     cover picture, core picture), with a plain count per group and one action per group. Confidence:
       specs   high = published, your own correction, or a bridge auto-match;
               med  = a bridge read that names the ball, a bowwwl page read, or a paste naming the ball;
               low  = a bridge candidate only, a loose name match, or a paste that doesn't name the ball.
       picture high = saved on this phone; med = bowwwl's file for this ball's name; low = pasted / photo.
     The work queue is current US balls; balls marked not out yet sit on their own line ("parked").
     Design: DESIGN_add_ball_flow section 64. */
  var GRP = [
    ['ready', 'Ready to approve', 'Full specs and a cover picture.'],
    ['specs', 'Specs, no picture', 'Full specs; needs a cover picture.'],
    ['pBoth', 'Partial specs, both pictures', 'Some specs missing; cover and core pictures known.'],
    ['pCover', 'Partial specs, cover picture', 'Some specs missing; no core picture.'],
    ['pCore', 'Partial specs, core picture', 'Some specs missing; no cover picture.'],
    ['pNone', 'Partial specs, no pictures', 'Some specs, nothing else.'],
    ['both', 'Both pictures, no specs', ''],
    ['cover', 'Cover picture, no specs', 'bowwwl has a page for most of these: Read bowwwl on the card.'],
    ['core', 'Core picture, no specs', ''],
    ['none', 'Nothing yet', 'No specs or pictures anywhere. Search, or mark discontinued / international.']];
  var _wt = { open: '', brand: '', q: '', page: 0, scope: 'queue', ready: false, loading: false };
  function wtQueue(e) { return A.triageOf(e) === 'current'; }
  function wtParked(e) { return A.triageOf(e) === 'upcoming'; }
  function wtHeld(rows) { return wbScope(rows).filter(function (e) { return A.catIsHeld(e) && !A.catIsRejected(e); }); }
  function specConf(e) {
    var d = _wb.det[e.i], f = _wb.found[e.i]; if (!d) return null;
    if (f) return f.how === 'hand' ? 'high' : f.loose || f.nameSeen === false ? 'low' : 'med';
    var ov = A.overrideFor(e.i), b = d.base;
    if (e.s || (ov && A.hlHasSpecs({}, ov))) return 'high';
    if (b && b.decision === 'auto') return 'high';
    if (b && b.decision === 'pending') return b.catalogId === e.i ? 'med' : 'low';
    return d.any || ov ? 'high' : null;   // your own partial entry
  }
  function picConf(e) { if (A.catImageStored(e.i)) return 'high'; var p = _rv.pic[e.i]; return !p ? null : /bowwwl/.test(p.how || '') ? 'med' : 'low'; }
  function grpOf(e) {
    var m = rvMerged(e); if (!m) return null;
    var full = !m.miss.length, any = Object.keys(m.sp.weights || {}).length > 0 || REQ.some(function (r) { return m.sp[r[0]]; });
    var cov = !!rvPicOf(e), cor = !!rvCorePic(e, m.sp);
    if (full) return cov ? 'ready' : 'specs';
    if (any) return cov && cor ? 'pBoth' : cov ? 'pCover' : cor ? 'pCore' : 'pNone';
    return cov && cor ? 'both' : cov ? 'cover' : cor ? 'core' : 'none';
  }
  var CONF_C = { high: 'var(--teal)', med: '#7aa7ff', low: 'var(--gold)' };
  function confChip(t, c) { return c ? '<span style="' + A.CHIP + 'color:' + CONF_C[c] + ';border:1px solid ' + CONF_C[c] + '">' + t + ' ' + c.toUpperCase() + '</span>' : ''; }
  function wtBrandOk(e) { var b = _wt.brand; if (!b) return true; return b.slice(0, 2) === 'g:' ? groupOf(e.m) === b.slice(2) : e.m === b.slice(2); }
  function wtGroupList(rows, gk) {
    var q = norm(_wt.q || '');
    return wtHeld(rows).filter(function (e) {
      if (gk === 'parked') { if (!wtParked(e)) return false; } else if (!(_wt.scope === 'all' ? !wtParked(e) : wtQueue(e)) || (grpOf(e) !== gk && !(_wt.keep && _wt.keep[gk + '|' + e.i]))) return false;
      return wtBrandOk(e) && (!q || norm(e.m + ' ' + e.n).indexOf(q) >= 0);
    }).sort(function (a, b) { return String(b.y || '').localeCompare(String(a.y || '')) || String(a.m).localeCompare(String(b.m)) || cleanName(a.n).localeCompare(cleanName(b.n)); });
  }
  /* every held ball's details, once (published shards are cached by catalog.js) */
  function wtLoad(rows) {
    if (_wt.loading) return; _wt.loading = true; _wb.busy = 'checking what is known';
    (_wb.stagedP || Promise.resolve()).then(function () { return loadDetails(wtHeld(rows)); }).then(function () { _wt.ready = true; _wt.loading = false; _wb.busy = ''; paint(); }, function () { _wt.loading = false; _wb.busy = ''; paint(); });
  }
  function webSearch(e) { return 'https://www.google.com/search?q=' + encodeURIComponent(e.m + ' ' + cleanName(e.n) + ' bowling ball'); }
  function a2(u, t) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal);text-decoration:none">' + t + '</a>'; }
  function waitingHTML(rows) {
    var held = wtHeld(rows), inQ = held.filter(wtQueue), parked = held.filter(wtParked), other = held.length - inQ.length - parked.length;
    var head = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 6px"><button style="' + A.BACK + '" onclick="' + (_wt.open ? "wtShow('')" : 'wbClose()') + '">\u2039</button>' +
      '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">' + (_wt.open ? esc(wtName(_wt.open)) : 'Waiting for Add a Ball') + '</div><div style="font-size:11px;color:var(--t3)">' + esc(_wb.busy || 'catalog workbench \u00b7 dev mode') + (_rv.fetch && !_rv.fetch.end ? ' \u00b7 <span onclick="wbRvFetchStop()" style="color:var(--teal);cursor:pointer">stop</span>' : '') + '</div></div>' +
      '<button onclick="catUpdateOpen()" style="' + A.BTN_P + 'padding:7px 10px;font-size:12px">Update</button><button onclick="wbMore()" style="' + A.BTN_G + 'padding:7px 10px;font-size:12px">More</button></div>' + updLine();
    var tabs = '<div style="display:flex;gap:6px;padding:0 16px 8px">' + ['triage:Triage', 'waiting:Waiting', 'status:Status'].map(function (x) { var k = x.split(':'); return '<button onclick="wbTab(\'' + k[0] + '\')" style="' + (_wb.tab === k[0] ? A.BTN_P : A.BTN_G) + 'flex:1;padding:8px 2px;font-size:12px">' + k[1] + '</button>'; }).join('') + '</div>';
    /* every held ball needs its details for the groups; an undo or a save clears some, so check each time */
    var missing = held.filter(function (e) { return !_wb.det[e.i]; }).length;
    if (missing) { wtLoad(rows); return head + tabs + '<div style="padding:30px 16px;text-align:center;color:var(--t2);font-size:13px">Checking ' + missing + ' held ball' + (missing === 1 ? '' : 's') + '\u2026</div>'; }
    if (_wt.open) return head + wtListHTML(rows);
    var pool = _wt.scope === 'all' ? held.filter(function (e) { return !wtParked(e); }) : inQ, by = {}, cf = {};
    GRP.forEach(function (g) { by[g[0]] = 0; cf[g[0]] = { high: 0, med: 0, low: 0 }; });
    pool.forEach(function (e) { var g = grpOf(e); if (!g) return; by[g]++; var c = /^(ready|specs|p)/.test(g) ? specConf(e) : picConf(e); if (c) cf[g][c]++; });
    var line = function (g) {
      var n = by[g[0]]; if (!n) return '';
      var c = cf[g[0]], cc = ['high', 'med', 'low'].filter(function (k) { return c[k]; }).map(function (k) { return '<span style="color:' + CONF_C[k] + '">' + c[k] + ' ' + k + '</span>'; }).join(' \u00b7 ');
      var act = g[0] === 'ready' ? '<button style="' + A.BTN_P + 'padding:6px 10px;font-size:12px" onclick="wtApprove()">Approve all ' + n + '</button>' :
        g[0] === 'specs' || g[0] === 'none' ? '<button style="' + A.BTN_G + 'padding:6px 10px;font-size:12px" onclick="wtFetch(\'' + g[0] + '\')">Find pictures</button>' : '';
      return '<div style="padding:10px 12px;border:1px solid var(--border1);border-radius:12px;background:var(--bg2);margin-bottom:8px">' +
        '<div onclick="wtShow(\'' + g[0] + '\')" style="display:flex;align-items:baseline;gap:8px;cursor:pointer"><div style="flex:1;font-size:14px;font-weight:700;color:var(--t1)">' + esc(g[1]) + '</div><div style="font-size:17px;font-weight:800;color:var(--t1)">' + n + ' \u203a</div></div>' +
        (g[2] ? '<div style="font-size:12px;color:var(--t3);margin-top:2px;line-height:1.4">' + esc(g[2]) + '</div>' : '') +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap"><span style="flex:1;font-size:11px">' + (cc ? (/^(ready|specs|p)/.test(g[0]) ? 'specs ' : 'picture ') + cc : '') + '</span>' +
        '<button style="' + A.BTN_G + 'padding:6px 10px;font-size:12px" onclick="wtCard(\'' + g[0] + '\')">One by one</button>' + (g[0] === 'ready' || g[0] === 'specs' ? '' : '<button style="' + A.BTN_G + 'padding:6px 10px;font-size:12px" onclick="wtRunStart(\'' + g[0] + '\')">Saving run</button>') + act +
        '<button style="' + A.BTN_G + 'padding:6px 10px;font-size:12px" onclick="wtMarkAsk(\'' + g[0] + '\')">Mark\u2026</button></div></div>';
    };
    var total = pool.length;
    return head + tabs + '<div style="padding:0 16px 8px"><button onclick="wtImportPdfs()" style="' + A.BTN_P + 'width:100%;padding:10px;font-size:13px">Import PDFs (pick many from Files)</button></div>' + '<div style="flex:1;overflow-y:auto;padding:0 16px 16px">' +
      '<div style="font-size:13px;color:var(--t1);line-height:1.5;margin-bottom:8px"><b>' + held.length + '</b> balls are waiting to get into Add a Ball. ' +
        (_wt.scope === 'all' ? 'Showing <b>' + total + '</b>: every held ball except those not out yet \u00b7 <span onclick="wtScope(\'queue\')" style="color:var(--teal);cursor:pointer">Current US only</span>' :
          '<b>' + inQ.length + '</b> are current US balls (below) \u00b7 <span onclick="wtScope(\'all\')" style="color:var(--teal);cursor:pointer">Show all ' + (held.length - parked.length) + '</span>') + '</div>' +
      GRP.map(line).join('') +
      (parked.length ? '<div onclick="wtShow(\'parked\')" style="display:flex;gap:8px;padding:10px 12px;border:1px dashed var(--border1);border-radius:12px;margin-bottom:8px;cursor:pointer"><div style="flex:1;font-size:13px;color:var(--t2)">Not out yet (parked)</div><div style="font-size:15px;font-weight:800;color:var(--t2)">' + parked.length + ' \u203a</div></div>' : '') +
      (_wt.scope !== 'all' && other ? '<div style="font-size:12px;color:var(--t3);line-height:1.5;margin-top:4px">' + other + ' more are likely discontinued or international: settle them in Triage, or Show all.</div>' : '') +
      '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:10px">Confidence: <span style="color:var(--teal)">high</span> = published, yours or a maker auto-match \u00b7 <span style="color:#7aa7ff">med</span> = a read that names the ball \u00b7 <span style="color:var(--gold)">low</span> = a near match to check. <b>Approve all</b> saves what was found and puts each ball in Add a Ball. Every change can be undone: More \u203a Change log.</div></div>';
  }
  function wtName(gk) { if (gk === 'parked') return 'Not out yet'; var g = GRP.filter(function (x) { return x[0] === gk; })[0]; return g ? g[1] : gk; }
  function wtListHTML(rows) {
    var list = wtGroupList(rows, _wt.open), pages = Math.max(1, Math.ceil(list.length / PAGE)); if (_wt.page >= pages) _wt.page = pages - 1;
    var shown = list.slice(_wt.page * PAGE, (_wt.page + 1) * PAGE), fams = {}, brands = {};
    wtHeld(rows).forEach(function (e) { fams[groupOf(e.m)] = 1; brands[e.m] = 1; });
    var opts = [['', 'All brands']];
    Object.keys(fams).sort().forEach(function (g) { var inF = Object.keys(brands).filter(function (b) { return groupOf(b) === g; }); if (inF.length > 1) opts.push(['g:' + g, g + ' family (' + inF.length + ' brands)']); });
    Object.keys(brands).sort().forEach(function (b) { opts.push(['b:' + b, b]); });
    var row = function (e) {
      var m = rvMerged(e) || { miss: [], sp: {} }, sc = specConf(e), pc = picConf(e), k = A.triageOf(e), idq = jsq(e.i), bw = A.bowwwlLinks(e.m, cleanName(e.n)), ck = rvCoreKey(e, m.sp);
      var pill = function (t, js) { return '<button style="' + A.BTN_G + 'padding:5px 9px;font-size:12px" onclick="' + js + '">' + t + '</button>'; };
      var rowLine = function (lab, inner) { return '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:6px"><span style="width:38px;font-size:11px;font-weight:700;color:var(--t3)">' + lab + '</span>' + inner + '</div>'; };
      var picSt = function (found, saved, miss, clr) { return found ? '<span style="font-size:12px;color:#7aa7ff">found</span> <span onclick="' + clr + '" style="color:var(--red);font-size:12px;cursor:pointer">\u2715</span>' : saved ? '<span style="font-size:12px;color:var(--teal)">\u2713 saved</span>' : miss ? '<span style="font-size:11px;color:var(--gold)">not on bowwwl</span>' : ''; };
      var cpic = rvCorePic(e, m.sp);
      var th = function (u) { return '<img src="' + esc(u) + '" referrerpolicy="no-referrer" style="width:40px;height:40px;border-radius:50%;object-fit:contain;background:#fff;flex-shrink:0">'; };
      return '<div style="padding:9px 2px;border-bottom:1px solid var(--border1)"><div onclick="wtCard(\'' + jsq(_wt.open) + '\',\'' + idq + '\')" style="display:flex;gap:10px;align-items:center;cursor:pointer">' + (_rv.pic[e.i] ? th(_rv.pic[e.i].url) : A.thumbHTML(e, 40)) + (cpic ? th(cpic) : '') +
        '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;color:var(--t1)">' + esc(cleanName(e.n)) + (k === 'upcoming' ? '<span style="' + A.CHIP_G + '">NOT OUT YET</span>' : '') + '</div>' +
        '<div style="font-size:12px;color:var(--t2)">' + esc(e.m) + (e.y ? ' \u00b7 ' + esc(e.y) : '') + '</div>' +
        '<div style="margin-top:3px">' + confChip('specs', sc) + confChip('picture', pc) + '</div></div></div>' +
        (m.miss.length ? '<div style="font-size:12px;color:var(--gold);margin-top:4px">needs ' + esc(m.miss.join(', ')) + (rvPicOf(e) ? '' : ', a cover picture') + '</div>' : !rvPicOf(e) ? '<div style="font-size:12px;color:var(--gold);margin-top:4px">needs a cover picture</div>' : '') +
        (_wb.found[e.i] ? '<div style="font-size:12px;color:#7aa7ff;margin-top:4px">read, not saved: ' + esc(foundLine(_wb.found[e.i])) + '</div>' : '') +
        rowLine('Specs', pill('Paste', "wbRvPasteSpecs('" + idq + "')") + pill('PDF', "wbRvPdf('" + idq + "')") + pill('Copy', "wtCopyOpen('" + idq + "')") +
          (_wb.found[e.i] ? pill('Changes', "wtCompare('" + idq + "')") : '')) +
        rowLine('Ball', picSt(_rv.pic[e.i], A.catImageStored(e.i), missFresh(_rv.miss[e.i]), "wtPicClear('" + idq + "','cover')") + pill('bowwwl', "wtBwPic('" + idq + "')") + pill('Paste', "wbRvPastePic('" + idq + "','cover')") + pill('Photo', "wbRvPhoto('" + idq + "','cover')")) +
        rowLine('Core', (ck ? picSt(_rv.core[ck], A.catCoreImageFor(e.m, m.sp.core), missFresh(_rv.coreMiss[ck]), "wtPicClear('" + idq + "','core')") + pill('bowwwl', "wtBwPic('" + idq + "')") :
            '<span onclick="wtEdit(\'' + idq + '\',\'core\')" style="font-size:11px;color:var(--teal);cursor:pointer">name?</span>') +
          pill('Paste', "wbRvPastePic('" + idq + "','core')") + pill('Photo', "wbRvPhoto('" + idq + "','core')")) +
        (_wb.found[e.i] && _wb.found[e.i].region && A.regionOf(e) !== _wb.found[e.i].region ? '<div style="font-size:12px;color:#7aa7ff;margin-top:4px">The page says ' + esc(_wb.found[e.i].region) + ' release \u00b7 <span onclick="wtPageRegion(\'' + idq + '\',\'' + jsq(_wb.found[e.i].region) + '\')" style="color:var(--teal);cursor:pointer">Tag it</span></div>' : '') +
        '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">' +
          (_wb.found[e.i] || _rv.pic[e.i] || (ck && _rv.core[ck]) ? '<button style="' + A.BTN_G + 'padding:6px 12px;font-size:12px" onclick="wtRowAccept(\'' + idq + '\')">Accept</button>' : '') +
          '<button style="' + (!m.miss.length && rvPicOf(e) ? A.BTN_P : A.BTN_G) + 'padding:6px 12px;font-size:12px" onclick="wtRowRelease(\'' + idq + '\')">' + (!m.miss.length && rvPicOf(e) ? 'Accept &amp; release' : 'Release with gaps\u2026') + '</button></div>' +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap"><button style="' + A.BTN_G + 'padding:5px 9px;font-size:12px" onclick="wtCard(\'' + jsq(_wt.open) + '\',\'' + idq + '\')">Open</button>' +
        '<button style="' + A.BTN_G + 'padding:5px 9px;font-size:12px" onclick="wtMarkAsk(null,\'' + idq + '\')">Mark\u2026</button>' +
        '<span style="font-size:11px;color:var(--t3)">' + a2(webSearch(e), 'search \u2197') + ' \u00b7 ' + a2(bw.page, 'bowwwl \u2197') + ' \u00b7 ' + a2(bw.maker || bw.search, 'maker \u2197') + '</span></div></div>';
    };
    return '<div style="display:flex;gap:6px;padding:0 16px 6px">' + sel('wt-b', _wt.brand, opts, 'wtBrand') +
        '<input class="bdet-field-input" type="search" placeholder="Search name" value="' + esc(_wt.q) + '" oninput="wtQ(this.value)" style="flex:1;min-width:0;box-sizing:border-box;font-size:15px"></div>' +
      '<div style="padding:0 16px 4px;font-size:12px;color:var(--t2)">' + list.length + ' ball' + (list.length === 1 ? '' : 's') + (_wt.open !== 'parked' ? ' \u00b7 ' + (_wt.scope === 'all' ? 'all held' : 'current US') : '') + '</div>' +
      '<div id="wb-list" style="flex:1;overflow-y:auto;padding:0 16px 10px">' + (shown.length ? shown.map(row).join('') : '<div style="padding:30px 0;text-align:center;color:var(--t2);font-size:13px">Nothing here.</div>') + '</div>' +
      (pages > 1 ? '<div style="display:flex;gap:8px;align-items:center;padding:6px 16px 0"><button style="' + A.BTN_G + 'flex:1;padding:9px" ' + (_wt.page ? '' : 'disabled ') + 'onclick="wtPage(-1)">\u2039 Prev</button><span style="font-size:12px;color:var(--t2);min-width:70px;text-align:center">' + (_wt.page + 1) + ' of ' + pages + '</span><button style="' + A.BTN_G + 'flex:1;padding:9px" ' + (_wt.page < pages - 1 ? '' : 'disabled ') + 'onclick="wtPage(1)">Next \u203a</button></div>' : '') +
      '<div style="display:flex;gap:8px;padding:10px 16px 0;margin-top:6px;border-top:1px solid var(--border1)"><button onclick="wtRunStart(\'' + jsq(_wt.open) + '\')" style="' + A.BTN_P + 'flex:1;padding:10px;font-size:13px">Saving run: one page after another</button></div>' +
      '<div style="display:flex;gap:8px;padding:8px 16px 10px"><button onclick="wtImportPdfs()" style="' + A.BTN_G + 'flex:1;padding:10px;font-size:13px">Import PDFs</button><button onclick="wtCard(\'' + jsq(_wt.open) + '\')" style="' + A.BTN_G + 'flex:1;padding:10px;font-size:13px">One by one</button>' +
        (_wt.open === 'ready' ? '<button onclick="wtApprove()" style="' + A.BTN_P + 'flex:1;padding:10px;font-size:13px">Approve all ' + list.length + '</button>' : '<button onclick="wtMarkAsk(\'' + jsq(_wt.open) + '\')" style="' + A.BTN_G + 'flex:1;padding:10px;font-size:13px">Mark all ' + list.length + '\u2026</button>') + '</div>';
  }
  function wtShow(gk) { _wt.open = gk || ''; _wt.page = 0; _wt.keep = {}; paint(); var l = document.getElementById('wb-list'); if (l) l.scrollTop = 0; }
  function wtScope(s) { _wt.scope = s; paint(); }
  function wtBrand(v) { _wt.brand = v; _wt.page = 0; paint(); }
  function wtQ(v) { _wt.q = v; _wt.page = 0; clearTimeout(_wt.t); _wt.t = setTimeout(function () { paint(); setTimeout(function () { var i = document.querySelector('#wb-ov input[type=search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }, 250); }
  function wtPage(d) { _wt.page += d; paint(); var l = document.getElementById('wb-list'); if (l) l.scrollTop = 0; }
  /* the card, over one group (or from one ball in it) */
  function wtCard(gk, id) {
    A.catLoad().then(function (rows) {
      var l = wtGroupList(rows, gk); _rv.ids = l.map(function (e) { return e.i; }); _rv.grp = gk;
      _rv.idx = Math.max(0, id ? _rv.ids.indexOf(id) : 0);
      if (!_rv.ids.length) { if (root.toast) root.toast('Nothing in this group'); return; }
      var el = document.getElementById('rv-ov'); if (el) el.parentNode.removeChild(el);
      document.body.appendChild(A.overlay('rv-ov', 912)); rvPaint();
    });
  }
  function wtApprove() {
    A.catLoad().then(function (rows) {
      var go = wtGroupList(rows, 'ready');
      if (!go.length) { if (root.toast) root.toast('Nothing ready yet'); return; }
      var low = go.filter(function (e) { return specConf(e) === 'low'; }).length;
      if (root.confirm && !root.confirm('Approve ' + go.length + ' ball' + (go.length === 1 ? '' : 's') + ' into Add a Ball?' + (low ? '\n\n' + low + ' have LOW confidence specs (a near match): open them one by one first if unsure.' : '') + '\n\nUndo from the Change log.')) return;
      var res = [], bad = []; _wb.busy = 'approving ' + go.length; paint();
      go.reduce(function (p, e) { return p.then(function () { return rvAcceptOne(e, true).then(function (r) { res.push(r); }, function (er) { bad.push(cleanName(e.n) + ': ' + (er && er.message)); }); }); }, Promise.resolve())
        .then(function () { var n = rvLog(res, 'Approve all'); _wb.busy = ''; paint();
          if (root.toast) root.toast('In Add a Ball: ' + n.rel + (n.ticks ? ' \u00b7 ticked ' + n.ticks + ' in Spec approvals: Publish to finish' : '') + (bad.length ? ' \u00b7 ' + bad.length + ' not saved' : ''), 6000); });
    });
  }
  /* bowwwl picture files for a group (the existing Fetch, over this group) */
  function wtFetch(gk) {
    A.catLoad().then(function (rows) { var l = wtGroupList(rows, gk); if (!l.length) return; _wb.fetchList = l; wbRvFetch(); });
  }
  /* status in place: one ball (id) or a whole group (gk) */
  function wtMarkAsk(gk, id) {
    if (!root.openModal) return;
    A.catLoad().then(function (rows) {
      var ids = id ? [id] : wtGroupList(rows, gk).map(function (e) { return e.i; }); if (!ids.length) return;
      _wt.mark = ids;
      var b = function (k, t, sub) { return '<button class="btn btn-ghost" style="width:100%;text-align:left;margin-top:6px;padding:10px" onclick="wtMark(\'' + k + '\')"><div style="font-size:14px;font-weight:700;color:var(--t1)">' + t + '</div><div style="font-size:12px;color:var(--t3)">' + sub + '</div></button>'; };
      root.openModal('<div class="modal-title">Mark ' + (ids.length === 1 ? esc(cleanName((A.byIdIn(rows, ids[0]) || {}).n || '')) : ids.length + ' balls') + '</div>' +
        b('disc', 'Discontinued', 'Stays out of Add a Ball unless you show discontinued') + b('intl', 'International', 'An overseas release (leaves the work queue)') +
        b('upcoming', 'Not out yet', 'Parked until it comes out') + b('reject', 'Reject\u2026', 'Not a real ball, or a duplicate (asks for a reason)') +
        (ids.length === 1 ? b('clear', 'Back to current', 'Remove my not-out-yet / region marks') : '') +
        '<div style="font-size:11px;color:var(--t3);margin-top:8px">Balls you own are never changed in bulk. Undo: More \u203a Change log.</div>' +
        '<button class="btn btn-secondary" style="width:100%;margin-top:10px" onclick="closeModal()">Cancel</button>');
    });
  }
  function wtMark(kind) {
    var ids = _wt.mark || []; if (!ids.length) return;
    A.catLoad().then(function (rows) {
      var own = ownedMap(), many = ids.length > 1, go = ids.filter(function (id) { return !(many && own[id]); });
      if (kind === 'disc' || kind === 'reject') { if (root.closeModal) root.closeModal(); _wb.sel = {}; go.forEach(function (id) { _wb.sel[id] = 1; }); if (document.getElementById('rv-ov') && ids.length === 1) _rv.after = 'reject'; setTimeout(function () { wbStatus(kind === 'disc' ? 'discontinue' : 'reject'); }, 300); return; }
      if (kind === 'intl') tagRegion(go, 'International', rows);
      if (kind === 'upcoming' || kind === 'clear') {
        var tg = A.triageGet(), items = go.map(function (id) { var e = A.byIdIn(rows, id); return { id: id, n: e ? cleanName(e.n) : id, had: !!tg.upcoming[id] }; });
        go.forEach(function (id) { if (kind === 'upcoming') tg.upcoming[id] = 1; else delete tg.upcoming[id]; }); A.triageSave(tg);
        logAdd('upcoming', (kind === 'upcoming' ? 'Not out yet ' : 'Back to current ') + go.length, items);
        if (kind === 'clear') tagRegion(go, undefined, rows);
      }
      if (root.closeModal) root.closeModal();
      if (root.toast) root.toast({ intl: 'International: ', upcoming: 'Not out yet: ', clear: 'Back to current: ' }[kind] + go.length + (go.length < ids.length ? ' (yours left alone)' : ''));
      rvAfterMark(go); paint();
    });
  }
  /* the card moves on when the ball it shows was marked */
  function rvAfterMark(ids) {
    if (!document.getElementById('rv-ov') || ids.indexOf(_rv.ids[_rv.idx]) < 0) return;
    _rv.ids.splice(_rv.idx, 1); if (_rv.idx >= _rv.ids.length) _rv.idx = Math.max(0, _rv.ids.length - 1);
    if (!_rv.ids.length) wbRvClose(); else rvPaint();
  }

  /* ---------- v30.213 LOOSE-1: maker pages the bridge couldn't place, matched to held balls by name ----------
     Same words in another order ("Raw Hammer - Blue / Black / Orange" = "Raw Hammer Black/Blue/Orange"),
     a short form ("Game Breaker 5" = "GB5 (Game Breaker 5)"), or extra colour words only. Anything else
     (a different model word: "Black Pearl Urethane" vs "Black Widow Urethane Black Pearl") is no match.
     A match is offered as a read with LOW confidence; Accept saves it as your correction. */
  var LZ_COLOURS = {}; 'black white red blue green yellow orange purple pink teal navy grey gray silver gold lime sky smoke charcoal bronze copper ruby sapphire emerald jade maroon burgundy aqua cyan violet magenta crimson scarlet ivory cream tan brown dark light neon royal electric frost ice clear translucent'.split(' ').forEach(function (w) { LZ_COLOURS[w] = 1; });
  var LZ_STOP = { bowling: 1, ball: 1, the: 1, and: 1 };
  function lzToks(t) { return String(t || '').toLowerCase().replace(/[\u2122\u00ae]/g, '').replace(/[^a-z0-9.]+/g, ' ').replace(/(\d)\.0\b/g, '$1').replace(/\./g, ' ').split(/\s+/).filter(function (w) { return w && !LZ_STOP[w]; }); }
  function lzAcr(ts) { var k = -1; for (var i = 0; i < ts.length; i++) if (/^\d+$/.test(ts[i])) { k = i; break; } if (k < 2) return null; var a = ts.slice(0, k); return a.every(function (w) { return /^[a-z]/.test(w); }) ? a.map(function (w) { return w[0]; }).join('') + ts[k] : null; }
  function lzBrand(b) { return String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(inc|bowling|global)$/, ''); }
  function looseMatch(row, held) {
    var t = lzToks(row.title); if (!t.length) return null; var ts = {}, ac = lzAcr(t); t.forEach(function (w) { ts[w] = 1; });
    var out = [];
    held.forEach(function (h) {
      if (lzBrand(h.m) !== lzBrand(row.brand)) return;
      var ns = {}; lzToks(h.n).forEach(function (w) { ns[w] = 1; });
      if (!Object.keys(ts).every(function (w) { return ns[w] || (ac && w === ac); })) return;
      var extra = Object.keys(ns).filter(function (w) { return !ts[w] && w !== ac; });
      if (extra.every(function (w) { return LZ_COLOURS[w]; })) out.push({ id: h.i, kind: extra.length ? 'colour' : 'same' });
    });
    return out.length ? { ids: out.map(function (x) { return x.id; }), kind: out.length === 1 && out[0].kind === 'same' ? 'same' : 'colour' } : null;
  }
  /* staged rows -> { heldId: row } for pending pages with no catalog id */
  function looseMap(staged, held) {
    var m = {};
    (staged || []).forEach(function (r) { if (r.decision !== 'pending' || r.catalogId || !r.specs) return; var x = looseMatch(r, held); if (!x) return; x.ids.forEach(function (id) { if (!m[id]) m[id] = { row: r, kind: x.kind, n: x.ids.length }; }); });
    return m;
  }
  function looseFound(L) {
    var s = L.row.specs || {}, fx = {};
    ['coverName', 'coverType', 'finish', 'core', 'coreType', 'released'].forEach(function (k) { if (s[k]) fx[k] = s[k]; });
    return { fields: fx, weights: cp(s.weights || {}) || {}, source: 'maker', host: String(L.row.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0], url: L.row.url, loose: true, nameSeen: false,
      warn: 'Near match: the maker page is \u201c' + L.row.title + '\u201d' + (L.n > 1 ? ' (fits ' + L.n + ' balls)' : '') + '. Check it is this ball.' };
  }

  /* ---------- v30.213 BW-1: Read bowwwl (one page, on your tap, kept on this phone) ----------
     The phone can't load bowwwl pages (the browser blocks it), so a tap starts the bowwwl-read workflow
     for that one page. It seals what it read with this phone's public key and leaves it on the repo's
     inbox branch; the phone fetches it, opens it with its private key (kept here as bdbgh_bwkey), deletes
     the file, and shows it as a read (source bowwwl, so Accept stores it on this phone only). */
  var BW_KEY = 'bdbgh_bwkey', BW_PEND = 'bdbgh_bwreads', _bw = {};
  function b64(buf) { var s = '', u = new Uint8Array(buf); for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
  function unb64(t) { var s = atob(String(t || '').replace(/\s/g, '')), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function bwKeys() {
    var S = root.crypto && root.crypto.subtle; if (!S) return Promise.reject(new Error('no WebCrypto'));
    var k = null; try { k = JSON.parse(localStorage.getItem(BW_KEY) || 'null'); } catch (e) {}
    if (k && k.pub && k.priv) return S.importKey('jwk', k.priv, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']).then(function (pk) { return { pub: k.pub, priv: pk }; });
    return S.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']).then(function (kp) {
      return Promise.all([S.exportKey('spki', kp.publicKey), S.exportKey('jwk', kp.privateKey)]).then(function (x) {
        var o = { pub: b64(x[0]), priv: x[1] }; localStorage.setItem(BW_KEY, JSON.stringify(o)); return { pub: o.pub, priv: kp.privateKey };
      });
    });
  }
  function bwOpen(box, priv) {
    var S = root.crypto.subtle;
    return S.decrypt({ name: 'RSA-OAEP' }, priv, unb64(box.k)).then(function (raw) { return S.importKey('raw', raw, 'AES-GCM', false, ['decrypt']); })
      .then(function (aes) { return S.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, aes, unb64(box.d)); })
      .then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }
  /* the page address: from the bowwwl picture saved for this ball when there is one, else from the name */
  function bwPageUrl(e) {
    var links = A.bowwwlLinks(e.m, cleanName(e.n)), brand = String(links.page).split('/')[4] || '';
    var pic = A.catImageStored(e.i) || (_rv.pic[e.i] && _rv.pic[e.i].url) || '', mm = /bowwwl\.com\/sites\/default\/files\/(?:styles\/[^/]+\/public\/)?balls\/([a-z0-9-]+)\.(?:png|jpe?g)/i.exec(pic);
    if (mm && brand && mm[1].indexOf(brand + '-') === 0) return 'https://www.bowwwl.com/bowling-ball-database/' + brand + '/' + mm[1].slice(brand.length + 1);
    return links.page;
  }
  function bwPend(o) { if (o === undefined) { try { return JSON.parse(localStorage.getItem(BW_PEND) || '{}') || {}; } catch (e) { return {}; } } try { localStorage.setItem(BW_PEND, JSON.stringify(o)); } catch (e) {} }
  function wbBwRead(id) {
    if (!A.apToken()) { if (root.toast) root.toast('Add your GitHub token first (More \u203a Spec approvals)'); return; }
    var p = bwPend(); if (p[id]) { if (root.toast) root.toast('Already reading this one'); return; }
    A.catLoad().then(function (rows) {
      var e = A.byIdIn(rows, id); if (!e) return;
      var url = bwPageUrl(e), nonce = 'bw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      _bw[id] = 'starting'; rvPaint();
      bwKeys().then(function (k) {
        return A.apGH('').then(function (repo) { return A.apGH('/actions/workflows/bowwwl-read.yml/dispatches', { method: 'POST', body: { ref: repo.default_branch || 'main', inputs: { url: url, key: k.pub, nonce: nonce } } }); });
      }).then(function () {
        p = bwPend(); p[id] = { nonce: nonce, url: url, at: Date.now() }; bwPend(p); _bw[id] = 'reading'; rvPaint(); bwPoll(id);
      }, function (er) { delete _bw[id]; rvPaint(); if (root.toast) root.toast('Could not start the read: ' + (er && er.status === 404 ? 'bowwwl-read.yml isn\u2019t in the repo yet' : er && er.message), 6000); });
    });
  }
  function bwPoll(id, tries) {
    tries = tries || 0; var p = bwPend(), r = p[id]; if (!r) return;
    var stop = function (msg) { var q = bwPend(); delete q[id]; bwPend(q); delete _bw[id]; rvPaint(); paint(); if (msg && root.toast) root.toast(msg, 6000); };
    if (Date.now() - r.at > 6 * 60000) return stop('No answer from bowwwl-read after 6 minutes: check GitHub Actions');
    A.apGH('/contents/bw/' + r.nonce + '.json?ref=inbox').then(function (f) {
      var o = JSON.parse(decodeURIComponent(escape(atob(String(f.content || '').replace(/\s/g, '')))));
      A.apGH('/contents/bw/' + r.nonce + '.json', { method: 'DELETE', body: { message: 'read ' + r.nonce, sha: f.sha, branch: 'inbox' } }).catch(function () {});
      if (o.err) return stop('bowwwl: ' + (o.err === 'HTTP 404' ? 'no page at ' + r.url.replace(/^https:\/\/www\./, '') + ': use the bowwwl \u2197 link to find it' : o.err));
      return bwKeys().then(function (k) { return bwOpen(o.sealed, k.priv); }).then(function (got) { stop(); bwApply(id, got); }, function () { stop('Could not open the read (a different phone\u2019s key?)'); });
    }, function (er) {
      if (er && er.status && er.status !== 404) return stop('GitHub ' + er.status + ' while reading');
      var next = function () { setTimeout(function () { bwPoll(id, tries + 1); }, 6000); };
      if (tries % 4 !== 3) return next();
      A.apGH('/actions/workflows/bowwwl-read.yml/runs?per_page=10').then(function (j) {
        var run = (j.workflow_runs || []).filter(function (x) { return String(x.display_title || x.name || '').indexOf(r.nonce) >= 0; })[0];
        if (run && run.status === 'completed' && run.conclusion !== 'success') stop('bowwwl-read ' + run.conclusion + ': see GitHub Actions'); else next();
      }, next);
    });
  }
  function bwResume() { Object.keys(bwPend()).forEach(function (id) { if (!_bw[id]) { _bw[id] = 'reading'; bwPoll(id); } }); }
  function bwFile(u) { var m = /^(https:\/\/www\.bowwwl\.com\/sites\/default\/files\/)styles\/[^/]+\/public\/(.+?)(\?.*)?$/.exec(u || ''); return m ? m[1] + m[2] : u; }
  function bwApply(id, got) {
    A.catLoad().then(function (rows) {
      var e = A.byIdIn(rows, id), pg = (got && got.page) || {}; if (!e) return;
      var fx = {}; ['coverName', 'coverType', 'finish', 'core', 'coreType', 'released'].forEach(function (k) { if (pg[k]) fx[k] = pg[k]; });
      var a = lzToks(pg.name), b = lzToks(cleanName(e.n)), seen = !!a.length && (a.every(function (w) { return b.indexOf(w) >= 0; }) || b.every(function (w) { return a.indexOf(w) >= 0; }));
      if (!Object.keys(fx).length && !Object.keys(pg.weights || {}).length) { if (root.toast) root.toast('bowwwl page read, but no specs on it'); return; }
      _wb.found[id] = { fields: fx, weights: pg.weights || {}, source: 'bowwwl', host: 'bowwwl.com', how: 'bowwwl-read', url: got.url, nameSeen: seen,
        region: pg.international || pg.country ? (pg.country || 'International') : null, retired: !!pg.discontinued, warn: seen ? null : 'The page is \u201c' + (pg.name || '?') + '\u201d: check it is this ball.' };
      if (pg.ballImg && !A.catImageStored(id)) _rv.pic[id] = { url: bwFile(pg.ballImg), how: 'bowwwl', link: true };
      if (pg.coreImg && pg.core) { var ck = A.coreKeyOf(e.m, pg.core); if (ck && !A.catCoreImageFor(e.m, pg.core)) _rv.core[ck] = { url: bwFile(pg.coreImg), how: 'bowwwl', link: true, brand: e.m, name: pg.core }; }
      rvSaveFinds(); rvPaint(); paint(); wtCompare(id);
    });
  }


  /* ---------- v30.215 EDIT-1: type a value straight into the card (any field, any weight) ----------
     What you type goes into this ball's read (as if read from a page), shown NEW, and saves with Accept.
     With no read yet you say where it came from; bowwwl stays on this phone, maker / other go to the repo. */
  var ED_LAB = { coverName: 'Coverstock', coverType: 'Cover type', finish: 'Factory finish', core: 'Core', coreType: 'Core type', released: 'Release date' };
  function edFound(id, src) { var f = _wb.found[id]; if (!f) f = _wb.found[id] = { fields: {}, weights: {}, source: src || 'bowwwl', host: '', how: 'hand', nameSeen: true }; return f; }
  function edSrcSel(id) { return _wb.found[id] ? '' : '<label style="display:block;font-size:12px;color:var(--t3);margin-top:10px">Where is this from?</label><select id="ed-src" class="bdet-field-input" style="width:100%;font-size:15px"><option value="bowwwl">bowwwl (kept on this phone)</option><option value="maker">Maker spec sheet / page</option><option value="other">Other</option></select>'; }
  function wtEdit(id, k) {
    if (!root.openModal) return;
    A.catLoad().then(function (rows) {
      var e = A.byIdIn(rows, id); if (!e || !_wb.det[id]) return;
      var m = rvMerged(e), v = m.sp[k] || '';
      var inp = k === 'coreType' ? '<select id="ed-v" class="bdet-field-input" style="width:100%;font-size:15px"><option value="">\u2014</option>' + ['Asymmetrical', 'Symmetrical'].map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select>' :
        '<input id="' + (/^(coverName|coverType|finish|core)$/.test(k) ? 'wt-ed-' + k : 'ed-v') + '" data-brand="' + esc(e.m) + '" class="bdet-field-input" value="' + esc(v) + '" placeholder="' + (k === 'released' ? 'any format: 7/23/2025, July 2025\u2026' : '') + '" autocomplete="off" autocorrect="off" style="width:100%;box-sizing:border-box;font-size:16px">';
      root.openModal('<div class="modal-title">' + esc(ED_LAB[k]) + '</div><div style="font-size:12px;color:var(--t3);margin-bottom:8px">' + esc(cleanName(e.n)) + '</div>' + inp + edSrcSel(id) +
        '<div id="ed-err" style="font-size:12px;color:var(--red);margin-top:6px"></div>' +
        '<button class="btn btn-primary" style="width:100%;margin-top:10px" onclick="wtEditGo(\'' + jsq(id) + '\',\'' + k + '\')">Use this</button>' +
        (_wb.found[id] && _wb.found[id].fields && _wb.found[id].fields[k] ? '<button class="btn btn-ghost" style="width:100%;margin-top:8px" onclick="wtEditGo(\'' + jsq(id) + '\',\'' + k + '\',true)">Undo my change to this field</button>' : '') +
        '<button class="btn btn-secondary" style="width:100%;margin-top:8px" onclick="closeModal()">Cancel</button>');
      setTimeout(function () { var i = document.getElementById('ed-v') || document.getElementById('wt-ed-' + k); if (i && i.focus) i.focus(); }, 300);
    });
  }
  function wtEditGo(id, k, drop) {
    var el = document.getElementById('ed-v') || document.getElementById('wt-ed-' + k), err = document.getElementById('ed-err'), sv = document.getElementById('ed-src');
    if (drop) { var f0 = _wb.found[id]; if (f0) { delete f0.fields[k]; if (!Object.keys(f0.fields).length && !Object.keys(f0.weights || {}).length) delete _wb.found[id]; } if (root.closeModal) root.closeModal(); rvPaint(); paint(); return; }
    var v = el ? String(el.value || '').replace(/\s+/g, ' ').trim() : '';
    if (!v) { if (err) err.textContent = 'Type a value (or Cancel).'; return; }
    if (k === 'released') { var nd = A.normDate(v); if (!nd) { if (err) err.textContent = 'Not a date I can read: try 7/23/2025, July 2025 or 2025-07-23.'; return; } v = nd; }   // v30.216: any format
    var f = edFound(id, sv && sv.value); f.fields = f.fields || {}; f.fields[k] = v; (f.hand = f.hand || {})[k] = 1;
    if (root.closeModal) root.closeModal(); rvPaint(); paint();
    if (k === 'core' && _wt.pendCore && _wt.pendCore[id]) { var pc = _wt.pendCore[id]; delete _wt.pendCore[id]; rvSetPic(id, 'core', pc); }   // v30.220: the picture waiting for this name
  }
  var ED_LIM = { RG: [2.3, 2.9], Diff: [0, 0.08], IntDiff: [0, 0.04] };
  function wtEditW(id, w) {
    if (!root.openModal) return;
    A.catLoad().then(function (rows) {
      var e = A.byIdIn(rows, id); if (!e || !_wb.det[id]) return;
      var m = rvMerged(e), x = (w && m.sp.weights[w]) || {};
      var box = function (k, t) { return '<div style="flex:1;min-width:0"><div style="font-size:11px;color:var(--t3)">' + t + '</div><input id="edw-' + k + '" class="bdet-field-input" inputmode="decimal" value="' + (x[k] != null ? Number(x[k]).toFixed(3) : '') + '" style="width:100%;box-sizing:border-box;font-size:16px"></div>'; };
      root.openModal('<div class="modal-title">' + (w ? w + ' lb' : 'Add a weight') + '</div><div style="font-size:12px;color:var(--t3);margin-bottom:8px">' + esc(cleanName(e.n)) + '</div>' +
        (w ? '' : '<select id="edw-w" class="bdet-field-input" style="width:100%;font-size:15px;margin-bottom:8px">' + ['16', '15', '14', '13', '12', '11', '10'].filter(function (z) { return !m.sp.weights[z]; }).map(function (z) { return '<option value="' + z + '">' + z + ' lb</option>'; }).join('') + '</select>') +
        '<div style="display:flex;gap:6px">' + box('RG', 'RG') + box('Diff', 'Diff') + box('IntDiff', 'Int diff') + '</div>' + edSrcSel(id) +
        '<div id="ed-err" style="font-size:12px;color:var(--red);margin-top:6px"></div>' +
        '<button class="btn btn-primary" style="width:100%;margin-top:10px" onclick="wtEditWGo(\'' + jsq(id) + '\',\'' + (w || '') + '\')">Use these</button>' +
        '<button class="btn btn-secondary" style="width:100%;margin-top:8px" onclick="closeModal()">Cancel</button>');
    });
  }
  function wtEditWGo(id, w) {
    var err = document.getElementById('ed-err'), sv = document.getElementById('ed-src'), ws = document.getElementById('edw-w');
    w = w || (ws && ws.value); if (!w) return;
    var vals = {}, bad = null;
    ['RG', 'Diff', 'IntDiff'].forEach(function (k) { var el = document.getElementById('edw-' + k), t = el ? String(el.value).trim() : ''; if (!t) return;
      var n = Number(t.charAt(0) === '.' ? '0' + t : t); if (!(n >= ED_LIM[k][0] && n <= ED_LIM[k][1])) bad = k + ' should be ' + ED_LIM[k][0] + '\u2013' + ED_LIM[k][1]; else vals[k] = n; });
    if (bad) { if (err) err.textContent = bad + '.'; return; }
    if (vals.RG == null || vals.Diff == null) { if (err) err.textContent = 'RG and Diff are needed.'; return; }
    var f = edFound(id, sv && sv.value); f.weights = f.weights || {}; f.weights[w] = Object.assign({}, f.weights[w] || {}, vals); f.hand = f.hand || {}; f.hand['w' + w] = 1;
    if (root.closeModal) root.closeModal(); rvPaint(); paint();
  }
  /* ---------- v30.215 PIC-1: drop a find, or remove a saved picture ---------- */
  function wtPicClear(id, slot) {
    A.catLoad().then(function (rows) {
      var e = A.byIdIn(rows, id); if (!e) return;
      var m = rvMerged(e), k = slot === 'core' && m ? rvCoreKey(e, m.sp) : null;
      if (slot === 'cover' && _rv.pic[id]) { delete _rv.pic[id]; rvSaveFinds(); rvPaint(); paint(); return; }
      if (slot === 'core' && k && _rv.core[k]) { delete _rv.core[k]; rvSaveFinds(); rvPaint(); paint(); return; }
      var link = slot === 'cover' ? A.imgPicks()[id] : (k ? A.catCoreImageFor(e.m, m.sp.core) : null), isFile = link && /^blob:/.test(link);
      if (!link) return;
      var msg = 'Remove the saved ' + slot + ' picture' + (slot === 'core' ? ' (every ball with the ' + m.sp.core + ' core uses it)' : '') + '?' + (isFile ? '\n\nIt was pasted or photographed, so Undo can\u2019t bring it back.' : '\n\nUndo: More \u203a Change log.');
      if (root.confirm && !root.confirm(msg)) return;
      var job = slot === 'cover' ? A.catImgDel(id).then(function () { A.imgPickSet(id, null); }) : A.catImgDel('core:' + k).then(function () { A.coreLinkSet(k, null); });
      job.then(function () {
        logAdd('picdel', 'Removed ' + slot + ' picture: ' + cleanName(e.n), [{ id: id, n: cleanName(e.n), slot: slot, key: k, link: isFile ? null : link }]);
        rvPaint(); paint(); if (root.toast) root.toast('Removed. Paste, Photo or Find pictures for a new one.');
      });
    });
  }

  /* ---------- v30.218 COPY-1: the same specs on another color of the same ball, or from any ball ----------
     Colorways (plastic / polyester lines, most reactive lines) share coverstock, core and RG / Diff.
     "Same model": same brand and the same first word(s) of the name; a different number ("2.0" / "3.0")
     or cover word (pearl, solid, hybrid, urethane) means a different ball, so those are left out.
     You always pick: copy from one ball into this one (ticked fields only), or after Accept give this
     ball's specs to the other colors still missing them. Copies keep the source's store rule
     (a bowwwl value stays on this phone). */
  var CP_COLOR = {}; ('smoke mint cherry snow midnight sky night haze ink wine berry rose lavender coral plum indigo amber olive sand steel platinum pewter onyx ' +
    'carbon graphite cobalt turquoise lilac peach blush fuchsia tangerine citrus lemon lime aqua sapphire ruby emerald jade gold silver bronze copper ' +
    'charcoal violet magenta crimson scarlet maroon burgundy navy teal royal electric neon frost ice smoke glow camo').split(' ').forEach(function (w) { CP_COLOR[w] = 1; });
  /* the name without "(codes)", as words */
  function cpToks(e) { return lzToks(cleanName(e.n).replace(/\([^)]*\)/g, ' ')); }
  var CP_VERSION = { i: 1, ii: 1, iii: 1, iv: 1, v: 1, vi: 1, vii: 1, viii: 1, ix: 1, x: 1, xi: 1, xii: 1, ex: 1, se: 1, le: 1, ai: 1, xr: 1, xl: 1, xp: 1, xt: 1, hd: 1, sp: 1, ss: 1, us: 1, ur: 1, rg: 1, cs: 1, on: 1, it: 1, of: 1, to: 1, in: 1, my: 1, up: 1, go: 1, no: 1, so: 1, by: 1, at: 1, an: 1, or: 1, me: 1, we: 1, be: 1, do: 1, he: 1, if: 1, is: 1, ok: 1, oh: 1 };   // + short English words ("Lock-On" / "Lock It")
  /* a color word, or a short letter code for colors ("M+M", "BP"); not a version ("II", "EX", "AI") or a number */
  function cpColorish(w) { return LZ_COLOURS[w] || CP_COLOR[w] || (w.length <= 2 && /^[a-z]+$/.test(w) && !CP_VERSION[w]); }
  /* same model = same brand, same leading words, and every other word is a color (or a short color code) */
  function sameModel(a, b) {
    if (a.i === b.i || a.m !== b.m || cleanName(a.n) === cleanName(b.n)) return false;
    var x = cpToks(a), y = cpToks(b), L = 0;
    while (L < x.length && L < y.length && x[L] === y[L]) L++;
    if (!L || cpColorish(x[0])) return false;
    return x.slice(L).concat(y.slice(L)).every(cpColorish);
  }
  function cpSiblings(e, rows) { return rows.filter(function (r) { return !r.a && sameModel(e, r); }); }
  function cpHasSpecs(e) { var d = _wb.det[e.i]; return !!(d && (d.any || _wb.found[e.i])); }
  function cpSpecsOf(e) { var d = _wb.det[e.i]; return d ? mergeFound(d.sp, _wb.found[e.i]) : {}; }
  function cpSourceOf(e) { var f = _wb.found[e.i]; if (f && f.source) return f.source; return A.localOverrides()[e.i] ? 'bowwwl' : 'maker'; }
  function cpSummary(sp) {
    var w = Object.keys(sp.weights || {}).sort(function (a, b) { return b - a; })[0], x = w ? sp.weights[w] : null;
    return [sp.coverName, sp.core, x && x.RG != null ? w + ' lb ' + Number(x.RG).toFixed(3) + (x.Diff != null ? ' / ' + Number(x.Diff).toFixed(3) : '') : null].filter(Boolean).join(' \u00b7 ') || 'no specs';
  }
  var _cp = null;
  function wtCopyOpen(id) { wtKeep(id);
    if (!root.openModal) return;
    A.catLoad().then(function (rows) {
      var e = A.byIdIn(rows, id); if (!e) return;
      var sib = cpSiblings(e, rows);
      _cp = { id: id, rows: rows, q: '', from: null };
      root.openModal('<div class="modal-title">Copy specs into ' + esc(cleanName(e.n)) + '</div><div id="cp-body" style="font-size:13px;color:var(--t3)">Checking ' + sib.length + ' other color' + (sib.length === 1 ? '' : 's') + '\u2026</div>');
      loadDetails(sib.slice(0, 40)).then(function () { _cp.sib = sib.filter(cpHasSpecs); cpPaint(); });
    });
  }
  function cpPaint() {
    var el = document.getElementById('cp-body'); if (!el || !_cp) return;
    var rowsHTML = function (l) { return l.map(function (r) { return '<div onclick="wtCopyPick(\'' + jsq(r.i) + '\')" style="padding:8px 0;border-bottom:1px solid var(--border1);cursor:pointer"><div style="font-size:14px;color:var(--t1)">' + esc(cleanName(r.n)) + ' <span style="color:var(--t3)">\u00b7 ' + esc(r.m) + (r.y ? ' \u00b7 ' + esc(r.y) : '') + '</span></div><div style="font-size:11px;color:var(--t3)">' + esc(cpSummary(cpSpecsOf(r))) + '</div></div>'; }).join(''); };
    var found = _cp.hits || [];
    el.innerHTML = '<div style="font-size:12px;color:var(--t2);margin-bottom:4px">Same model, other colors' + (_cp.sib.length ? '' : ': none with specs yet') + '</div>' + rowsHTML(_cp.sib) +
      '<div style="font-size:12px;color:var(--t2);margin:10px 0 4px">Or any ball (other brands use the same covers and cores)</div>' +
      '<input id="cp-q" class="bdet-field-input" type="search" placeholder="Brand or ball name" value="' + esc(_cp.q) + '" oninput="wtCopySearch(this.value)" autocomplete="off" style="width:100%;box-sizing:border-box;font-size:16px">' +
      '<div id="cp-hits">' + rowsHTML(found) + (_cp.q && !found.length ? '<div style="padding:8px 0;color:var(--t3)">' + (_cp.busy ? 'Looking\u2026' : 'No ball with specs matches') + '</div>' : '') + '</div>' +
      '<button class="btn btn-secondary" style="width:100%;margin-top:10px" onclick="closeModal()">Cancel</button>';
  }
  function wtCopySearch(v) {
    if (!_cp) return; _cp.q = v; clearTimeout(_cp.t);
    _cp.t = setTimeout(function () {
      var q = norm(v || ''); if (q.length < 2) { _cp.hits = []; cpPaintHits(); return; }
      var cand = _cp.rows.filter(function (r) { return !r.a && r.i !== _cp.id && (r.s || A.overrideFor(r.i)) && norm(r.m + ' ' + r.n).indexOf(q) >= 0; }).slice(0, 15);
      _cp.busy = true; cpPaintHits();
      loadDetails(cand).then(function () { _cp.busy = false; _cp.hits = cand.filter(cpHasSpecs); cpPaintHits(); });
    }, 300);
  }
  function cpPaintHits() { var h = document.getElementById('cp-hits'), q = document.getElementById('cp-q'); if (!h) return; var keep = q && document.activeElement === q; var tmp = document.createElement('div'); var save = _cp.q; cpPaint(); var q2 = document.getElementById('cp-q'); if (keep && q2) { q2.focus(); q2.setSelectionRange(save.length, save.length); } }
  var CP_FIELDS = [['coverName', 'Coverstock'], ['coverType', 'Cover type'], ['finish', 'Finish'], ['core', 'Core'], ['coreType', 'Core type'], ['released', 'Release date']];
  function wtCopyPick(fromId) {
    var el = document.getElementById('cp-body'); if (!el || !_cp) return;
    var from = A.byIdIn(_cp.rows, fromId), to = A.byIdIn(_cp.rows, _cp.id); if (!from || !to) return;
    var src = cpSpecsOf(from), cur = (rvMerged(to) || { sp: {} }).sp, ws = Object.keys(src.weights || {}).sort(function (a, b) { return b - a; });
    if (!CP_FIELDS.some(function (f) { return src[f[0]]; }) && !ws.length) { if (root.toast) root.toast(cleanName(from.n) + ' has no specs to copy yet'); return; }
    _cp.from = fromId;
    var line = function (key, lab, val, on) { return '<label style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border1)"><input type="checkbox" data-cp="' + key + '"' + (on ? ' checked' : '') + ' style="width:20px;height:20px;margin-top:2px"><div style="flex:1;min-width:0"><div style="font-size:11px;color:var(--t3)">' + lab + '</div><div style="font-size:14px;color:var(--t1)">' + esc(val) + '</div></div></label>'; };
    el.innerHTML = '<div style="font-size:12px;color:var(--t2);margin-bottom:6px">From ' + esc(cleanName(from.n)) + ' (' + esc(from.m) + '). Ticked: what this ball is missing; the release date is off because colors come out at different times.</div>' +
      CP_FIELDS.filter(function (f) { return src[f[0]]; }).map(function (f) { return line(f[0], f[1] + (cur[f[0]] ? ' (now: ' + cur[f[0]] + ')' : ''), src[f[0]], !cur[f[0]] && f[0] !== 'released'); }).join('') +
      (ws.length ? line('weights', 'RG / Diff (' + ws.length + ' weight' + (ws.length === 1 ? '' : 's') + ')', ws.map(function (w) { var x = src.weights[w]; return w + ': ' + (x.RG != null ? Number(x.RG).toFixed(3) : '\u2014') + ' / ' + (x.Diff != null ? Number(x.Diff).toFixed(3) : '\u2014'); }).join(' \u00b7 '), !Object.keys(cur.weights || {}).length) : '') +
      '<button class="btn btn-primary" style="width:100%;margin-top:10px" onclick="wtCopyGo()">Copy ticked</button><button class="btn btn-secondary" style="width:100%;margin-top:8px" onclick="wtCopyBack()">\u2039 Pick another ball</button>';
  }
  function wtCopyBack() { if (_cp) { _cp.from = null; cpPaint(); } }
  /* copy fields into a ball's read; only: list of keys, or null for "whatever it is missing (not the date)" */
  function cpApply(fromE, toE, only) {
    var src = cpSpecsOf(fromE), cur = (rvMerged(toE) || { sp: {} }).sp, f = _wb.found[toE.i], n = 0;
    if (!f) f = _wb.found[toE.i] = { fields: {}, weights: {}, source: cpSourceOf(fromE), host: '', how: 'copy', nameSeen: true };
    f.fields = f.fields || {}; f.weights = f.weights || {};
    CP_FIELDS.forEach(function (x) { var k = x[0]; if (!src[k]) return; if (only ? only.indexOf(k) < 0 : (cur[k] || k === 'released')) return; f.fields[k] = src[k]; n++; });
    if ((only ? only.indexOf('weights') >= 0 : !Object.keys(cur.weights || {}).length) && src.weights) Object.keys(src.weights).forEach(function (w) { f.weights[w] = Object.assign({}, src.weights[w]); n++; });
    f.from = cleanName(fromE.n); if (!f.warn) f.warn = 'Copied from ' + f.from + ' (same specs, another color): check anything that differs.';
    return n;
  }
  function wtCopyGo() {
    if (!_cp || !_cp.from) return;
    var only = Array.prototype.slice.call(document.querySelectorAll('[data-cp]')).filter(function (x) { return x.checked; }).map(function (x) { return x.getAttribute('data-cp'); });
    var from = A.byIdIn(_cp.rows, _cp.from), to = A.byIdIn(_cp.rows, _cp.id);
    var n = only.length ? cpApply(from, to, only) : 0;
    if (root.closeModal) root.closeModal(); rvPaint(); paint();
    if (root.toast) root.toast(n ? 'Copied from ' + cleanName(from.n) + ' (not saved until Accept)' : 'Nothing ticked');
  }
  /* after Accept: give these specs to the other colors that are missing them */
  function cpOfferAfter(e) {
    if (!root.openModal) return;
    A.catLoad().then(function (rows) {
      var sib = cpSiblings(e, rows).filter(function (r) { return A.catIsHeld(r) && !A.catIsRejected(r); }); if (!sib.length) return;
      loadDetails(sib.concat([e])).then(function () {
        var need = sib.filter(function (r) { var m = rvMerged(r); return m && m.miss.length; }); if (!need.length) return;
        _cp = { id: e.i, rows: rows, give: need.map(function (r) { return r.i; }), on: {} };
        root.openModal('<div class="modal-title">Same specs for the other colors?</div><div style="font-size:12px;color:var(--t2);margin-bottom:6px">' + esc(cleanName(e.n)) + ': ' + esc(cpSummary(cpSpecsOf(e))) + '. Tick the colors that are the same ball; each gets only what it is missing (not the release date), and is saved like an Accept.</div>' +
          need.map(function (r, i) { var m = rvMerged(r); return '<label style="display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border1)"><input type="checkbox" onchange="wtGiveTick(' + i + ',this.checked)" style="width:20px;height:20px"><div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--t1)">' + esc(cleanName(r.n)) + (r.y ? ' <span style="color:var(--t3)">\u00b7 ' + esc(r.y) + '</span>' : '') + '</div><div style="font-size:11px;color:var(--gold)">needs ' + esc(m.miss.join(', ')) + '</div></div></label>'; }).join('') +
          '<button class="btn btn-primary" style="width:100%;margin-top:10px" onclick="wtGiveGo()">Give to ticked</button><button class="btn btn-secondary" style="width:100%;margin-top:8px" onclick="closeModal()">None of these</button>');
      });
    });
  }
  function wtGiveTick(i, on) { if (_cp && _cp.give) { if (on) _cp.on[i] = 1; else delete _cp.on[i]; } }
  function wtGiveGo() {
    if (!_cp || !_cp.give) return;
    var rows = _cp.rows, from = A.byIdIn(rows, _cp.id), ids = Object.keys(_cp.on).map(function (i) { return _cp.give[+i]; });
    if (root.closeModal) root.closeModal(); if (!ids.length) return;
    var res = [];
    ids.reduce(function (p, id) { return p.then(function () { var e = A.byIdIn(rows, id); if (!e || !cpApply(from, e, null)) return; return rvAcceptOne(e, false).then(function (r) { res.push(r); }, function () {}); }); }, Promise.resolve())
      .then(function () { var n = rvLog(res, 'Same specs as ' + cleanName(from.n)); paint(); if (root.toast) root.toast('Specs saved on ' + n.specs + ' more color' + (n.specs === 1 ? '' : 's') + (n.ticks ? '' : '') + ' \u00b7 undo from the Change log'); });
  }

  /* ---------- v30.218 ROW-1: work a ball from the group list without opening its card ---------- */
  function wtRowRelease(id) {
    wtKeep(id);
    A.catLoad().then(function (rows) { var e = A.byIdIn(rows, id); if (!e) return;
      loadDetails([e]).then(function () {
        var m = rvMerged(e), gaps = m ? m.miss.slice() : [];
        if (!rvPicOf(e)) gaps.push('a cover picture');
        if (gaps.length && root.confirm && !root.confirm('Release ' + cleanName(e.n) + ' into Add a Ball without ' + gaps.join(', ') + '?\n\nIt shows with those blank; you can fill them in later and they update.')) return;
        rvAcceptOne(e, true, null, !!gaps.length).then(function (r) { rvLog([r], cleanName(e.n)); paint();
          if (root.toast) root.toast(r.rel ? 'In Add a Ball: ' + cleanName(e.n) : 'Saved' + (r.ticks ? ' (ticked in Spec approvals: Publish to finish)' : ''));
          if (r.core) A.catCoreShareOffer(r.core.brand, r.core.name, r.core); else if (r.specs) cpOfferAfter(e);
        }, function (er) { if (root.toast) root.toast('Not saved: ' + (er && er.message)); });
      });
    });
  }
  function wtRowAccept(id) { wtKeep(id);
    A.catLoad().then(function (rows) { var e = A.byIdIn(rows, id); if (!e) return;
      rvAcceptOne(e, false).then(function (r) { rvLog([r], cleanName(e.n)); paint();
        var bits = [r.specs && 'specs', r.ticks && 'ticked in Spec approvals', r.pic && 'picture', r.core && 'core picture'].filter(Boolean);
        if (root.toast) root.toast(bits.length ? 'Saved: ' + bits.join(', ') : 'Nothing new to save');
        if (r.core) A.catCoreShareOffer(r.core.brand, r.core.name, r.core); else if (r.specs) cpOfferAfter(e);
      }, function (er) { if (root.toast) root.toast('Not saved: ' + (er && er.message)); }); });
  }

  /* ---------- v30.219 CMP-1: what a read changes, before it is kept ----------
     After a PDF, paste or bowwwl read, a box lists every field: what the ball has now, and what the
     page says (editable). Changed rows are ticked. Save ticked = saved like Accept; Keep for later =
     the ticked values stay as the ball's read (not saved); Discard drops the read. */
  var CMP_W = ['16', '15', '14', '13', '12', '11', '10'];
  function wtCompare(id) {
    if (!root.openModal) return;
    A.catLoad().then(function (rows) {
      var e = A.byIdIn(rows, id), d = _wb.det[id], f = _wb.found[id]; if (!e || !f) return;
      if (!d) return loadDetails([e]).then(function () { wtCompare(id); });
      var now = d.sp || {}, nf = f.fields || {}, nw = f.weights || {}, n3 = function (v) { return v == null || v === '' ? '' : Number(v).toFixed(3); };
      var row = function (key, lab, cur, nv, inp) {
        var same = String(cur || '').toLowerCase() === String(nv || '').toLowerCase(), on = !same && nv !== '' && nv != null;
        return '<div style="padding:7px 0;border-bottom:1px solid var(--border1)"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-cmp="' + key + '"' + (on ? ' checked' : '') + (same ? ' disabled' : '') + ' style="width:20px;height:20px">' +
          '<span style="font-size:12px;font-weight:700;color:var(--t2)">' + lab + '</span>' + (same ? '<span style="font-size:11px;color:var(--t3)">same</span>' : !cur ? '<span style="font-size:11px;color:var(--teal)">new</span>' : '<span style="font-size:11px;color:var(--gold)">changes</span>') + '</label>' +
          '<div style="display:flex;gap:8px;margin-top:4px;align-items:center"><div style="flex:1;min-width:0;font-size:13px;color:var(--t3)">now: ' + (cur ? esc(cur) : '<i>empty</i>') + '</div></div>' +
          '<div style="margin-top:4px">' + inp + '</div></div>';
      };
      var tx = function (k) { return '<input id="cmp-' + k + '" class="bdet-field-input" value="' + esc(nf[k] || '') + '" style="width:100%;box-sizing:border-box;font-size:15px">'; };
      var html = CP_FIELDS.filter(function (x) { return nf[x[0]] || now[x[0]]; }).map(function (x) { return row(x[0], x[1], now[x[0]], nf[x[0]], tx(x[0])); }).join('');
      CMP_W.forEach(function (w) {
        var a = (now.weights || {})[w], b = nw[w]; if (!a && !b) return;
        var cur = a ? [n3(a.RG), n3(a.Diff), n3(a.IntDiff)].filter(Boolean).join(' / ') : '', nv = b ? [n3(b.RG), n3(b.Diff), n3(b.IntDiff)].filter(Boolean).join(' / ') : '';
        var box = function (k, t) { return '<div style="flex:1;min-width:0"><div style="font-size:10px;color:var(--t3)">' + t + '</div><input id="cmp-w' + w + '-' + k + '" class="bdet-field-input" inputmode="decimal" value="' + (b && b[k] != null ? n3(b[k]) : '') + '" style="width:100%;box-sizing:border-box;font-size:15px"></div>'; };
        html += row('w' + w, w + ' lb', cur, nv, '<div style="display:flex;gap:6px">' + box('RG', 'RG') + box('Diff', 'Diff') + box('IntDiff', 'Int') + '</div>');
      });
      var rg = f.region && A.regionOf(e) !== f.region ? f.region : null;
      if (rg) html += '<div style="padding:7px 0;border-bottom:1px solid var(--border1)"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="cmp-region" checked style="width:20px;height:20px"><span style="font-size:12px;font-weight:700;color:var(--t2)">Region</span><span style="font-size:11px;color:var(--teal)">page says</span></label>' +
        '<div style="font-size:13px;color:var(--t1);margin-top:4px">Tag as a ' + esc(rg) + ' release (leaves the US work queue)</div><div style="font-size:12px;color:var(--t3)">now: ' + esc(A.regionOf(e) || 'US / none') + '</div></div>';
      var qn = _wt.cqN ? (_wt.cqN - (_wt.cq ? _wt.cq.length : 0)) + ' of ' + _wt.cqN + ' \u00b7 ' : '';
      root.openModal('<div class="modal-title">What this read changes</div><div style="font-size:11px;color:var(--teal)">' + qn + '</div><div style="font-size:12px;color:var(--t3);margin-bottom:6px">' + esc(cleanName(e.n)) + ' \u00b7 from ' + esc(f.host || f.source || 'the page') + '</div>' +
        (f.warn || f.nameSeen === false ? '<div style="font-size:12px;color:var(--gold);margin-bottom:6px">' + esc(f.warn || 'The page doesn\u2019t name this ball: check it is the right one.') + '</div>' : '') +
        '<div style="max-height:56vh;overflow-y:auto">' + html + '</div><div id="cmp-err" style="font-size:12px;color:var(--red);margin-top:6px"></div>' +
        '<button class="btn btn-primary" style="width:100%;margin-top:8px" onclick="wtCompareGo(\'' + jsq(id) + '\',\'save\')">Save ticked</button>' +
        '<div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-ghost" style="flex:1" onclick="wtCompareGo(\'' + jsq(id) + '\',\'keep\')">Keep for later</button><button class="btn btn-secondary" style="flex:1" onclick="wtCompareGo(\'' + jsq(id) + '\',\'drop\')">Discard read</button></div>');
    });
  }
  function wtCompareGo(id, how) {
    var f = _wb.found[id]; if (!f) { if (root.closeModal) root.closeModal(); return; }
    var nxt = function () { if (_wt.cq) setTimeout(wtCompareNext, 350); };   // v30.221: the next imported PDF
    if (how === 'drop') { delete _wb.found[id]; if (root.closeModal) root.closeModal(); rvPaint(); paint(); nxt(); return; }
    var rgOn = document.getElementById('cmp-region'), rgTag = rgOn && rgOn.checked ? f.region : null;   // v30.220
    var err = document.getElementById('cmp-err'), on = {}, bad = null;
    Array.prototype.slice.call(document.querySelectorAll('[data-cmp]')).forEach(function (x) { if (x.checked) on[x.getAttribute('data-cmp')] = 1; });
    var fx = {}, wx = {};
    CP_FIELDS.forEach(function (x) { var k = x[0], el = document.getElementById('cmp-' + k); if (!on[k] || !el) return; var v = String(el.value || '').replace(/\s+/g, ' ').trim(); if (!v) return;
      if (k === 'released') { var nd = A.normDate(v); if (!nd) { bad = 'Release date \u201c' + v + '\u201d: try 7/23/2025 or July 2025'; return; } v = nd; }
      if (k === 'coreType') { v = /asym/i.test(v) ? 'Asymmetrical' : /sym/i.test(v) ? 'Symmetrical' : ''; if (!v) { bad = 'Core type: Symmetrical or Asymmetrical'; return; } }
      fx[k] = v; });
    CMP_W.forEach(function (w) { if (!on['w' + w]) return; var y = {};
      ['RG', 'Diff', 'IntDiff'].forEach(function (k) { var el = document.getElementById('cmp-w' + w + '-' + k), t = el ? String(el.value).trim() : ''; if (!t) return; var n = Number(t.charAt(0) === '.' ? '0' + t : t);
        if (!(n >= ED_LIM[k][0] && n <= ED_LIM[k][1])) bad = w + ' lb ' + k + ' should be ' + ED_LIM[k][0] + '\u2013' + ED_LIM[k][1]; else y[k] = n; });
      if (Object.keys(y).length) wx[w] = y; });
    if (bad) { if (err) err.textContent = bad + '.'; return; }
    if (rgTag) A.catLoad().then(function (rows) { tagRegion([id], rgTag, rows); paint(); });
    if (!Object.keys(fx).length && !Object.keys(wx).length) { if (how === 'keep' || rgTag) { if (root.closeModal) root.closeModal(); if (rgTag && root.toast) root.toast('Tagged ' + rgTag + ' release'); nxt(); return; } if (err) err.textContent = 'Nothing ticked.'; return; }
    f.fields = fx; f.weights = wx;
    if (root.closeModal) root.closeModal();
    if (how === 'keep') { rvPaint(); paint(); if (root.toast && !_wt.cq) root.toast('Kept as a read: not saved until Accept'); nxt(); return; }
    A.catLoad().then(function (rows) { var e = A.byIdIn(rows, id); if (!e) return;
      rvAcceptOne(e, false).then(function (r) { rvLog([r], cleanName(e.n)); rvPaint(); paint();
        if (root.toast) root.toast(r.specs || r.ticks ? 'Saved' + (r.ticks ? ' (ticked in Spec approvals: Publish to finish)' : '') : 'Nothing new to save');
        if (r.specs && !_wt.cq) cpOfferAfter(e);   // in a PDF run the other-colors offer waits (it would interrupt the run)
        nxt();
      }, function (er) { if (root.toast) root.toast('Not saved: ' + (er && er.message)); nxt(); });
    });
  }
  /* ---------- v30.219 ROW-2: bowwwl picture check for one ball, on tap ---------- */
  function wtBwPic(id) {
    A.catLoad().then(function (rows) { var e = A.byIdIn(rows, id); if (!e) return; wtKeep(id);
      delete _rv.miss[id]; var m = rvMerged(e), ck = m && rvCoreKey(e, m.sp); if (ck) delete _rv.coreMiss[ck];
      _wb.fetchList = [e]; wbRvFetch(); });
  }

  /* ---------- v30.221 IMP-1: import many saved PDFs at once, then go through what each changes ----------
     Pick any number of PDFs from Files. Each is matched to a ball by its file name first (Safari names a
     saved bowwwl page "Ebonite_Prime_Angular_One_Bowling_Ball__bowwwl_com.pdf": brand + ball), then by the
     ball name inside the page. Then "What this read changes" opens for each in turn (1 of N). */
  function pdfTitle(fn) {
    return String(fn || '').replace(/\.pdf$/i, '').replace(/\s*\(\d+\)\s*$/, '')
      .replace(/[_\s]+(?:bowling[_\s]+balls?)?[_\s]*(?:free[_\s]+shipping)?[_\s]*(?:bowwwl[_\s]*com|bowlingball[_\s]*com|bowling[_\s]*com|bowlersmart[_\s]*com)?[_\s]*$/i, '')
      .replace(/[_\s]+bowling[_\s]+balls?$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  }
  /* words of a title or page head; "GreenTealBlack" -> green teal black */
  function imWords(t) { return lzToks(String(t || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\([^)]*\)/g, ' ')); }
  function matchByFile(fn, cands) {
    var title = pdfTitle(fn), t = norm(title), tw = imWords(title), best = null; if (t.length < 4) return null;
    cands.forEach(function (e) {
      var nm = norm(cleanName(e.n)), br = norm(e.m), full = br + nm, sc = 0;
      if (t === full) sc = 1000; else if (t === nm) sc = 900; else if (t.indexOf(full) >= 0) sc = 800;
      if (!sc) {   // every word of the ball's name is in the title (any order), the brand counts extra
        var nw = imWords(cleanName(e.n));
        if (nw.length && nm.length >= 4 && nw.every(function (w) { return tw.indexOf(w) >= 0; })) sc = 500 + nw.length * 10 + (tw.indexOf(imWords(e.m)[0]) >= 0 ? 5 : 0) - (tw.length - nw.length);
      }
      if (sc && (!best || sc > best.sc)) best = { e: e, sc: sc };
    });
    return best ? best.e : null;
  }
  /* the ball whose whole name (as words) appears in the page's first lines */
  function matchText(text, cands) {
    var head = ' ' + imWords(String(text || '').split('\n').slice(0, 60).join(' ')).join(' ') + ' ', best = null;
    cands.forEach(function (e) {
      var nw = imWords(cleanName(e.n)), nm = nw.join(' '); if (nm.length < 4) return;
      if (head.indexOf(' ' + nm + ' ') < 0) return;
      var sc = nm.length * 2 + (head.indexOf(' ' + imWords(e.m).join(' ') + ' ') >= 0 ? 1 : 0);
      if (!best || sc > best.sc) best = { e: e, sc: sc };
    });
    return best ? best.e : null;
  }
  function wtImportPdfs() {
    pickPdfs(true, function (fs) {
      A.catLoad().then(function (rows) {
        var held = wtHeld(rows), all = rows.filter(function (e) { return !e.a; }), got = [], miss = [];
        _wb.busy = 'reading ' + fs.length + ' PDF' + (fs.length === 1 ? '' : 's'); paint();
        fs.reduce(function (p, f, i) {
          return p.then(function () { return A.spPdfFileText(f).then(function (t) {
            if (!t) { miss.push(f.name); return; }
            var e = matchByFile(f.name, held) || matchByFile(f.name, all) || matchText(t, held);
            if (!e) { miss.push(f.name); return; }
            var r = A.parseSpecText(t, 15, cleanName(e.n)); if (!Object.keys(r.fields || {}).length && !Object.keys(r.weights || {}).length) { miss.push(f.name + ' (no specs)'); return; }
            _wb.found[e.i] = r; if (got.indexOf(e.i) < 0) got.push(e.i);
            _wb.busy = 'read ' + (i + 1) + ' of ' + fs.length; paint();
          }, function () { miss.push(f.name); }); });
        }, Promise.resolve()).then(function () {
          _wb.busy = ''; paint();
          return loadDetails(got.map(function (id) { return A.byIdIn(rows, id); }).filter(Boolean));
        }).then(function () {
          if (miss.length && root.toast) root.toast('Not matched to a ball: ' + miss.slice(0, 3).join(', ') + (miss.length > 3 ? ' +' + (miss.length - 3) : '') + ' \u00b7 use PDF on that ball\u2019s row', 7000);
          if (!got.length) { if (!miss.length && root.toast) root.toast('No PDFs read'); return; }
          _wt.cq = got.slice(); _wt.cqN = got.length; wtCompareNext();
        });
      });
    });
  }
  function wtCompareNext() {
    if (!_wt.cq || !_wt.cq.length) { if (_wt.cqN && root.toast) root.toast('Done: ' + _wt.cqN + ' PDF' + (_wt.cqN === 1 ? '' : 's') + ' gone through'); _wt.cq = null; _wt.cqN = 0; paint(); return; }
    var id = _wt.cq.shift(); if (!_wb.found[id]) return wtCompareNext();
    wtKeep(id); wtCompare(id);
  }

  /* ---------- v30.222 RUN-1: a saving run: one ball after another, one tap to its page ----------
     For a group: shows one ball, a big button that opens its page (bowwwl, the maker or a web search)
     in Safari; you save the PDF there (Share › Save as PDF shortcut, or Options › PDF › Save to Files),
     come back, and the next ball is up. Nothing is fetched by the app: each page is one you open.
     Then Import PDFs reads the whole batch. The place in the run is kept on this phone. */
  var RUN_KEY = 'bowlingdb_wb_run';
  function runGet() { try { return JSON.parse(localStorage.getItem(RUN_KEY) || 'null'); } catch (e) { return null; } }
  function runSet(r) { try { if (r) localStorage.setItem(RUN_KEY, JSON.stringify(r)); else localStorage.removeItem(RUN_KEY); } catch (e) {} }
  function wtRunStart(gk) {
    A.catLoad().then(function (rows) {
      var l = wtGroupList(rows, gk).filter(function (e) { var m = rvMerged(e); return !_wb.found[e.i] && (!m || m.miss.length); });
      if (!l.length) { if (root.toast) root.toast('Every ball here has a read or full specs'); return; }
      var r = runGet(), site = (r && r.site) || 'bowwwl';
      runSet({ gk: gk, ids: l.map(function (e) { return e.i; }), idx: 0, site: site, opened: {} });
      wtRunPaint();
    });
  }
  function runUrl(e, site) { var bw = A.bowwwlLinks(e.m, cleanName(e.n)); return site === 'maker' ? (bw.maker || bw.search) : site === 'web' ? webSearch(e) : bwPageUrl(e); }
  function wtRunPaint() {
    var r = runGet(); var ov = document.getElementById('run-ov');
    if (!r) { if (ov) ov.parentNode.removeChild(ov); return; }
    if (!ov) { ov = A.overlay('run-ov', 913); document.body.appendChild(ov); }
    A.catLoad().then(function (rows) {
      if (r.idx >= r.ids.length) {
        ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:12px 16px"><button style="' + A.BACK + '" onclick="wtRunEnd()">\u2039</button><div style="font-size:17px;font-weight:800;color:var(--t1)">Run finished</div></div>' +
          '<div style="padding:20px 16px;font-size:14px;color:var(--t1);line-height:1.5">You opened ' + Object.keys(r.opened || {}).length + ' of ' + r.ids.length + ' pages. Now read them all in one go.</div>' +
          '<div style="padding:0 16px"><button style="' + A.BTN_P + 'width:100%;padding:13px;font-size:15px" onclick="wtRunEnd();wtImportPdfs()">Import PDFs</button><button style="' + A.BTN_G + 'width:100%;padding:11px;margin-top:8px" onclick="wtRunGo(-1)">\u2039 Back to the last ball</button></div>';
        return;
      }
      var e = A.byIdIn(rows, r.ids[r.idx]); if (!e) { r.idx++; runSet(r); return wtRunPaint(); }
      var url = runUrl(e, r.site), done = r.opened && r.opened[e.i], has = !!_wb.found[e.i];
      var siteB = function (k, t) { return '<button onclick="wtRunSite(\'' + k + '\')" style="' + (r.site === k ? A.BTN_P : A.BTN_G) + 'flex:1;padding:8px 2px;font-size:12px">' + t + '</button>'; };
      ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:12px 16px"><button style="' + A.BACK + '" onclick="wtRunEnd()">\u2039</button><div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Saving run</div><div style="font-size:11px;color:var(--t3)">' + (r.idx + 1) + ' of ' + r.ids.length + ' \u00b7 ' + esc(wtName(r.gk)) + '</div></div>' +
          '<button onclick="wtRunEnd();wtImportPdfs()" style="' + A.BTN_G + 'padding:7px 10px;font-size:12px">Import PDFs</button></div>' +
        '<div style="display:flex;gap:6px;padding:0 16px 8px">' + siteB('bowwwl', 'bowwwl') + siteB('maker', 'Maker site') + siteB('web', 'Web search') + '</div>' +
        '<div style="flex:1;overflow-y:auto;padding:8px 16px;text-align:center">' +
          '<div style="display:flex;justify-content:center;margin:6px 0 10px">' + (rvPicOf(e) ? '<img src="' + esc(rvPicOf(e)) + '" referrerpolicy="no-referrer" style="width:120px;height:120px;border-radius:50%;object-fit:contain;background:#fff">' : A.thumbHTML(e, 120)) + '</div>' +
          '<div style="font-size:20px;font-weight:800;color:var(--t1)">' + esc(cleanName(e.n)) + '</div><div style="font-size:13px;color:var(--t2)">' + esc(e.m) + (e.y ? ' \u00b7 ' + esc(e.y) : '') + '</div>' +
          (done ? '<div style="font-size:12px;color:var(--teal);margin-top:6px">\u2713 opened' + (has ? ' \u00b7 read' : '') + '</div>' : '') +
          '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" onclick="wtRunOpened()" style="display:block;margin-top:16px;' + A.BTN_P + 'padding:15px;font-size:16px;text-decoration:none">Open ' + (r.site === 'bowwwl' ? 'bowwwl page' : r.site === 'maker' ? 'maker site' : 'web search') + ' \u2197</a>' +
          '<div style="font-size:12px;color:var(--t3);line-height:1.5;margin-top:10px">In Safari: Share \u203a your <b>Save as PDF</b> shortcut (or Options \u203a PDF \u203a Save to Files). Come back here and the next ball is ready.</div></div>' +
        '<div style="display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--border1)"><button style="' + A.BTN_G + 'flex:1;padding:11px" ' + (r.idx ? '' : 'disabled ') + 'onclick="wtRunGo(-1)">\u2039 Back</button><button style="' + A.BTN_G + 'flex:1;padding:11px" onclick="wtRunGo(1)">Skip \u203a</button>' +
          '<button style="' + A.BTN_G + 'flex:1;padding:11px" onclick="wtRunNotThere()">Not there</button></div>';
    });
  }
  function wtRunOpened() { var r = runGet(); if (!r) return; (r.opened = r.opened || {})[r.ids[r.idx]] = 1; r.pend = 1; runSet(r); }
  function wtRunGo(d) { var r = runGet(); if (!r) return; r.idx = Math.max(0, Math.min(r.ids.length, r.idx + d)); r.pend = 0; runSet(r); wtRunPaint(); }
  function wtRunSite(k) { var r = runGet(); if (!r) return; r.site = k; runSet(r); wtRunPaint(); }
  function wtRunEnd() { runSet(null); wtRunPaint(); paint(); }
  /* the page wasn't there: try the next site for this ball, after the last site move on */
  function wtRunNotThere() { var r = runGet(); if (!r) return; var nx = { bowwwl: 'maker', maker: 'web' }[r.site]; if (nx) { r.site = nx; runSet(r); wtRunPaint(); } else { r.site = 'bowwwl'; runSet(r); wtRunGo(1); } }
  /* back from Safari: the next ball */
  document.addEventListener('visibilitychange', function () { if (document.visibilityState !== 'visible') return; var r = runGet(); if (!r || !r.pend || !document.getElementById('run-ov')) return; r.pend = 0; r.idx = Math.min(r.ids.length, r.idx + 1); runSet(r); wtRunPaint(); });

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
      '<div style="display:flex;gap:6px;padding:0 16px 8px">' + tab('triage', 'Triage') + tab('waiting', 'Waiting') + tab('status', 'Status') + '</div>' +
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
    if (en.kind === 'picdel') { en.items.forEach(function (x) { if (!x.link) return; if (x.slot === 'cover') A.imgPickSet(x.id, x.link); else if (x.key) A.coreLinkSet(x.key, x.link); }); return done(); }   // v30.215
    if (en.kind === 'upcoming') { var tu = A.triageGet(); en.items.forEach(function (x) { if (x.had) tu.upcoming[x.id] = 1; else delete tu.upcoming[x.id]; }); A.triageSave(tu); return done(); }   // v30.213
    if (en.kind === 'current') { var tg = A.triageGet(); en.items.forEach(function (x) { if (!x.had) delete tg.current[x.id]; }); A.triageSave(tg); return done(); }
    if (en.kind === 'brandregion') { var tb = A.triageGet(); en.items.forEach(function (x) { if (x.had) tb.brandRegion[x.id] = x.before; else delete tb.brandRegion[x.id]; }); A.triageSave(tb); return done(); }
    if (en.kind === 'ticks') { var qq = A.apQueue(); en.items.forEach(function (x) { Object.keys(x.before || {}).forEach(function (t) { if (x.before[t] == null) delete qq[t]; else qq[t] = x.before[t]; }); }); A.apSetQueue(qq); return done(); }
    if (en.kind === 'pictures') { en.items.forEach(function (x) { if (x.file) A.catImgDel(x.id); A.imgPickSet(x.id, x.url); }); return done(); }
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
  function wtPageDisc(id) { wbMarkDisc(id); rvAfterMark([id]); }
  function wtPageRegion(id, v) { A.catLoad().then(function (rows) { tagRegion([id], v, rows); paint(); rvAfterMark([id]); }); }
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

  root.wbRvFetch = wbRvFetch; root.wbRvFetchStop = wbRvFetchStop; root.wbRvOpen = wbRvOpen; root.wbRvClose = wbRvClose; root.wbRvNext = wbRvNext; root.wbRvAcceptAll = wbRvAcceptAll;
  root.wbRvPastePic = wbRvPastePic; root.wbRvPhoto = wbRvPhoto; root.wbRvPasteSpecs = wbRvPasteSpecs; root.wbRvPdf = wbRvPdf; root.wbRvEdit = wbRvEdit; root.wbRvAccept = wbRvAccept; root.wbRvDisc = wbRvDisc; root.wbRvReject = wbRvReject;
  root._wbt = { mergeFound: mergeFound, rvStage: function (e) { return rvStage(e); }, rv: _rv, wb: _wb };
  root.wtShow = wtShow; root.wtScope = wtScope; root.wtBrand = wtBrand; root.wtQ = wtQ; root.wtPage = wtPage; root.wtCard = wtCard; root.wtApprove = wtApprove;
  root.wtFetch = wtFetch; root.wtMarkAsk = wtMarkAsk; root.wtMark = wtMark; root.wbBwRead = wbBwRead; root.wtCompare = wtCompare; root.wtCompareGo = wtCompareGo; root.wtBwPic = wtBwPic; root.wtCopyOpen = wtCopyOpen; root.wtCopySearch = wtCopySearch; root.wtCopyPick = wtCopyPick; root.wtCopyBack = wtCopyBack; root.wtCopyGo = wtCopyGo; root.wtGiveTick = wtGiveTick; root.wtGiveGo = wtGiveGo; root.wtRowAccept = wtRowAccept; root.wtRunStart = wtRunStart; root.wtRunOpened = wtRunOpened; root.wtRunGo = wtRunGo; root.wtRunSite = wtRunSite; root.wtRunEnd = wtRunEnd; root.wtRunNotThere = wtRunNotThere; root.wtImportPdfs = wtImportPdfs; root.wtRowRelease = wtRowRelease; root.wtEdit = wtEdit; root.wtEditGo = wtEditGo; root.wtEditW = wtEditW; root.wtEditWGo = wtEditWGo; root.wtPicClear = wtPicClear; root.wtPageDisc = wtPageDisc; root.wtPageRegion = wtPageRegion;
  root._wbw = { pdfTitle: pdfTitle, matchByFile: matchByFile, rvSetPic: rvSetPic, sameModel: sameModel, cpApply: cpApply, cpOfferAfter: cpOfferAfter, looseMatch: looseMatch, looseMap: looseMap, grpOf: grpOf, specConf: specConf, picConf: picConf, bwPageUrl: bwPageUrl, bwOpen: bwOpen, bwApply: bwApply, wt: _wt, GRP: GRP };
  root.wbRepaint = function () { if (document.getElementById('wb-ov')) paint(); };
  root.wbOpen = wbOpen; root.wbClose = wbClose; root.wbTab = wbTab; root.wbGroup = wbGroup; root.wbBrand = wbBrand; root.wbYear = wbYear; root.wbState = wbState;
  root.wbQ = wbQ; root.wbPage = wbPage; root.wbSel = wbSel; root.wbSelAll = wbSelAll; root.wbSelNone = wbSelNone; root.wbOpenBall = wbOpenBall; root.wbPaste = wbPaste;
  root.wbPdf = wbPdf; root.wbPdfs = wbPdfs; root.wbDrop = wbDrop; root.wbReview = wbReview; root.wbSaveAll = wbSaveAll; root.wbPictureTool = wbPictureTool;
  root.wbStatus = wbStatus; root.wbStatusGo = wbStatusGo; root.wbSelectReady = wbSelectReady; root.wbRelease = wbRelease; root.wbMore = wbMore; root.wbFromMine = wbFromMine;
  root.wbUndo = wbUndo; root.wbLog = wbLog; root.wbMarkDisc = wbMarkDisc; root.wbTagRegion = wbTagRegion; root.wbRegionAsk = wbRegionAsk; root.wbRegionGo = wbRegionGo;
  root.wbRegion = wbRegion; root.wbBucket = wbBucket; root.wbFocus = wbFocus; root.wbLikely = wbLikely; root.wbBrandRegion = wbBrandRegion; root.wbCheckLinks = wbCheckLinks; root.wbClearBroken = wbClearBroken;
  root._wb = { log: logAll, state: function () { return _wb; }, mineAsRead: mineAsRead, missingOf: missingOf, groupOf: groupOf, matchBall: matchBall, formFrom: formFrom, WB_VERSION: WB_VERSION };
})(typeof window !== 'undefined' ? window : globalThis);
