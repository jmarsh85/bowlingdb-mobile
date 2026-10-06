/* =====================================================================
   BowlingDB catalog.js  -  NEW-11 Ball Catalog, steps 4-5: cache + picker
   Same-origin module loaded after index.html's main script, like
   devkit.js and report.js.

   Locked design (2026-10-06):
   - The catalog is a PREFILL, never a gate. Nothing here may block,
     delay or fail an app action. Every public call resolves; errors are
     recorded in status, never thrown.
   - Source: the versioned artifact the pipeline publishes on the `dist`
     branch. No third-party API in the runtime path.
   - Refresh: on Balls screen / picker open, at most once per 24h, plus a
     manual "Check for updates" (Settings). Never on app open.
   - Offline first run: no catalog yet -> status 'none'; manual entry is
     unaffected.

   Storage: its OWN IndexedDB database (BowlingDB_Catalog), so the main
   BowlingDB schema/version is untouched. The whole index is stored as ONE
   record, written in ONE transaction together with its meta: an install
   is atomic - a killed app leaves the previous catalog intact, never a
   half-written one. (The 500-per-batch rule is about many puts per
   transaction; this is a single put.)

   Integrity: index.json is checked against manifest.json before install
   (sha256 first-16-hex, same as build_catalog.js sha()), then sanity-gated
   like the pipeline: must be an array of {i,k,m,n} and must not shrink by
   more than 5% versus the installed catalog.

   Public (window): catCheck(opts), catLoad(), catStatus(), catClear()
   Step 5: catPickerMount(b), catPickValue(), catLinkLabel(b), catReviewOpen(),
           catLookup(mfg,name), catSearch(q,n)  (+ inline handlers)
   ===================================================================== */
(function (root) {
'use strict';

var CAT_VERSION  = 'v30.157';
var CAT_BASE     = 'https://raw.githubusercontent.com/jmarsh85/bowlingdb-mobile/dist/';
var CAT_DB       = 'BowlingDB_Catalog';
var CAT_DB_VER   = 1;
var LS_META      = 'bowlingdb_catalog_meta';
var DAY_MS       = 24 * 60 * 60 * 1000;
var RETRY_MS     = 60 * 60 * 1000;      // after a failed check, wait 1h
var SHRINK_LIMIT = 0.95;                // mirror of the pipeline's 5% gate

var _rows = null;       // in-memory index, loaded lazily
var _inflight = null;   // single in-flight check

/* ---------- environment (injectable for the Node harness) ---------- */
var env = {
  fetch: function (u, o) { return root.fetch(u, o); },
  idb:   function () { return root.indexedDB; },
  ls:    function () { return root.localStorage; },
  subtle: function () { return root.crypto && root.crypto.subtle; },
  now:   function () { return Date.now(); },
};

/* ---------- meta mirror (sync, for Settings display) ---------- */
function readMeta() {
  try { return JSON.parse(env.ls().getItem(LS_META) || '{}') || {}; }
  catch (e) { return {}; }
}
function writeMeta(patch) {
  var m = readMeta();
  for (var k in patch) m[k] = patch[k];
  try { env.ls().setItem(LS_META, JSON.stringify(m)); } catch (e) {}
  return m;
}

/* ---------- pure helpers (tested in Node) ---------- */
function shouldCheck(meta, now, force) {
  if (force) return true;
  var last = meta.lastAttemptAt || 0;
  var wait = meta.lastError ? RETRY_MS : DAY_MS;
  return !last || (now - last) >= wait;
}

function hex16(buf) {
  var b = new Uint8Array(buf), s = '';
  for (var i = 0; i < b.length && s.length < 16; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s.slice(0, 16);
}

/* text -> { ok, rows, err }. Never throws. */
function verifyAndParse(text, bytesHash, fileMeta, prevCount) {
  if (!fileMeta || !fileMeta.hash) return { ok: false, err: 'manifest has no index.json entry' };
  if (bytesHash !== fileMeta.hash) return { ok: false, err: 'index.json hash mismatch (' + bytesHash + ' vs ' + fileMeta.hash + ')' };
  var rows;
  try { rows = JSON.parse(text); } catch (e) { return { ok: false, err: 'index.json is not valid JSON' }; }
  if (!Array.isArray(rows) || !rows.length) return { ok: false, err: 'index.json is empty' };
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || typeof r.i !== 'string' || typeof r.k !== 'string' || !r.m || !r.n)
      return { ok: false, err: 'index.json row ' + i + ' is malformed' };
  }
  if (prevCount > 0 && rows.length < Math.floor(prevCount * SHRINK_LIMIT))
    return { ok: false, err: 'catalog shrank from ' + prevCount + ' to ' + rows.length + ' (>5%), kept existing' };
  return { ok: true, rows: rows };
}

function sha16(text) {
  var subtle = env.subtle();
  if (!subtle) return Promise.resolve(null);
  return subtle.digest('SHA-256', new TextEncoder().encode(text)).then(hex16);
}

/* ---------- IndexedDB (own database) ---------- */
function openDB() {
  return new Promise(function (resolve, reject) {
    var idb = env.idb();
    if (!idb) return reject(new Error('IndexedDB unavailable'));
    var req = idb.open(CAT_DB, CAT_DB_VER);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror   = function () { reject(req.error || new Error('catalog DB open failed')); };
  });
}

function kvGet(key) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('kv', 'readonly');
      var rq = tx.objectStore('kv').get(key);
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror   = function () { reject(rq.error); };
      tx.oncomplete = function () { db.close(); };
    });
  });
}

/* One transaction: index + its meta land together or not at all. */
function install(rows, manifest) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('kv', 'readwrite');
      var st = tx.objectStore('kv');
      var meta = { build: manifest.build, listVersion: manifest.listVersion || null,
                   generated: manifest.generated || null, count: rows.length,
                   installedAt: env.now() };
      st.put(rows, 'index');
      st.put(meta, 'meta');
      tx.oncomplete = function () { db.close(); resolve(meta); };
      tx.onerror    = function () { db.close(); reject(tx.error || new Error('catalog install failed')); };
      tx.onabort    = function () { db.close(); reject(tx.error || new Error('catalog install aborted')); };
    });
  });
}

/* ---------- public ---------- */

/* Status for display. Sync. */
function catStatus() {
  var m = readMeta();
  return {
    state: m.count ? 'ready' : (m.lastError ? 'error' : 'none'),
    build: m.build || null, listVersion: m.listVersion || null,
    count: m.count || 0, installedAt: m.installedAt || null,
    lastAttemptAt: m.lastAttemptAt || null, lastError: m.lastError || null,
    version: CAT_VERSION,
  };
}

/* Rows for search (step 5). Resolves [] when nothing is installed. */
function catLoad() {
  if (_rows) return Promise.resolve(_rows);
  return kvGet('index').then(function (rows) {
    _rows = Array.isArray(rows) ? rows : [];
    return _rows;
  }).catch(function () { return []; });
}

/* Check the manifest; install a new index if the build changed.
   opts.force skips the 24h throttle (manual "Check for updates").
   Resolves { status: 'skipped'|'current'|'updated'|'error', ... }. Never rejects. */
function catCheck(opts) {
  opts = opts || {};
  if (_inflight) return _inflight;
  var meta = readMeta();
  var now = env.now();
  if (!shouldCheck(meta, now, !!opts.force)) return Promise.resolve({ status: 'skipped' });
  writeMeta({ lastAttemptAt: now });

  _inflight = env.fetch(CAT_BASE + 'manifest.json', { cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('manifest HTTP ' + r.status);
      return r.json();
    })
    .then(function (manifest) {
      if (!manifest || !manifest.build || !manifest.files) throw new Error('manifest is malformed');
      if (manifest.build === meta.build && meta.count > 0) {
        writeMeta({ lastError: null, listVersion: manifest.listVersion || meta.listVersion });
        return { status: 'current', build: manifest.build };
      }
      var fileMeta = manifest.files['index.json'];
      return env.fetch(CAT_BASE + 'index.json', { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('index HTTP ' + r.status);
          return r.text();
        })
        .then(function (text) {
          return sha16(text).then(function (h) {
            if (h === null) throw new Error('cannot verify catalog (no WebCrypto)');
            var v = verifyAndParse(text, h, fileMeta, meta.count || 0);
            if (!v.ok) throw new Error(v.err);
            return install(v.rows, manifest).then(function (m) {
              _rows = v.rows;
              writeMeta({ build: m.build, listVersion: m.listVersion, generated: m.generated,
                          count: m.count, installedAt: m.installedAt, lastError: null });
              return { status: 'updated', build: m.build, count: m.count, from: meta.build || null };
            });
          });
        });
    })
    .catch(function (e) {
      var msg = (e && e.message) || String(e);
      writeMeta({ lastError: msg });
      return { status: 'error', error: msg };
    })
    .then(function (res) { _inflight = null; return res; });

  return _inflight;
}

/* Dev/diagnostic: drop the local catalog. Next check reinstalls. */
function catClear() {
  _rows = null;
  try { env.ls().removeItem(LS_META); } catch (e) {}
  return new Promise(function (resolve) {
    var idb = env.idb();
    if (!idb) return resolve(false);
    var rq = idb.deleteDatabase(CAT_DB);
    rq.onsuccess = function () { resolve(true); };
    rq.onerror = rq.onblocked = function () { resolve(false); };
  });
}

/* =====================================================================
   STEP 5 (v30.157): matcher, picker, link status, legacy-link review.
   Locked: picker on Add Ball and Edit Ball; legacy linking ALWAYS asks
   (no auto-link, no link-all); offline/no-catalog leaves manual entry
   unchanged. CatalogID on the owned ball is nullable; absent == unlinked.

   Prefill rule: on Add, choosing a catalog entry fills Ball Name and
   Manufacturer with USBC's spelling (an explicit user choice on an empty
   form). On Edit, choosing only links: the user's own name/mfg text is
   never overwritten. The index carries no specs and USBC approval year
   is not a release date, so nothing else is prefilled.
   ===================================================================== */

/* ---- Normalizer: VERBATIM port of catalog/normalize.js (modelKey path).
   catalog_test.js asserts parity on all 8,046 index rows. Keep in sync. */
var MFG_ALIASES = {
  track: 'Track Inc.', trackinc: 'Track Inc.', columbia: 'Columbia 300',
  columbia300: 'Columbia 300', rotogrip: 'Roto Grip', '900global': '900 Global',
  storm: 'Storm', brunswick: 'Brunswick', hammer: 'Hammer', radical: 'Radical',
  motiv: 'Motiv', dv8: 'DV8', ebonite: 'Ebonite',
};
var NAME_ALIASES = { 'storm|hyroad': 'Hy-Road', 'brunswick|tzone': 'T Zone' };
var TRANSLIT = [
  [/\u00b2/g, '2'], [/\u00b3/g, '3'], [/\u00b9/g, '1'],
  [/[\u221e\ua70f]/g, 'eight'],
  [/\u03a0|\u03c0/g, 'pi'], [/\u03a9/g, 'omega'],
  [/\+/g, 'plus'], [/&/g, 'and'], [/\u2192|\u2190/g, 'to'],
];
function norm(s) {
  if (s == null) return '';
  var out = String(s);
  for (var i = 0; i < TRANSLIT.length; i++) out = out.replace(TRANSLIT[i][0], TRANSLIT[i][1]);
  return out.toLowerCase().replace(/\(all colors?\)/g, '').replace(/[^a-z0-9]/g, '');
}
function canonicalMfg(raw) {
  return MFG_ALIASES[norm(raw)] || String(raw == null ? '' : raw).trim();
}
function modelKey(mfg, ballName) {
  var m = norm(canonicalMfg(mfg));
  var name = String(ballName == null ? '' : ballName).trim().replace(/^\*+\s*/, '').trim();
  var aliased = NAME_ALIASES[m + '|' + norm(name)];
  return m + '|' + norm(aliased || name);
}

/* ---- lookups over the loaded index ---- */
var _byK = null, _byI = null;
function ensureMaps(rows) {
  if (_byK && _byK._src === rows) return;
  _byK = new Map(); _byI = new Map(); _byK._src = rows;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!_byK.has(r.k)) _byK.set(r.k, []);
    _byK.get(r.k).push(r);
    _byI.set(r.i, r);
  }
}
/* -> { status:'match'|'ambiguous'|'miss', candidates } (exact ModelKey only) */
function lookupIn(rows, mfg, name) {
  ensureMaps(rows);
  var hits = _byK.get(modelKey(mfg, name)) || [];
  return { status: hits.length === 1 ? 'match' : hits.length ? 'ambiguous' : 'miss', candidates: hits };
}
function byIdIn(rows, id) { ensureMaps(rows); return id ? (_byI.get(id) || null) : null; }

/* Search: every query token must appear in norm(mfg)+norm(name).
   Rank: name starts with first token, then shorter name, then newer. */
function searchIn(rows, q, limit) {
  var toks = String(q || '').split(/\s+/).map(norm).filter(Boolean);
  if (!toks.length || toks.join('').length < 2) return [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var hay = r._h || (r._h = norm(r.m) + '|' + norm(r.n));
    var okAll = true;
    for (var j = 0; j < toks.length; j++) if (hay.indexOf(toks[j]) < 0) { okAll = false; break; }
    if (okAll) out.push(r);
  }
  var t0 = toks[0];
  out.sort(function (a, b) {
    var sa = norm(a.n).indexOf(t0) === 0 ? 0 : 1, sb = norm(b.n).indexOf(t0) === 0 ? 0 : 1;
    if (sa !== sb) return sa - sb;
    if (a.n.length !== b.n.length) return a.n.length - b.n.length;
    return (b.y || '').localeCompare(a.y || '');
  });
  return out.slice(0, limit || 25);
}

/* Legacy-link review model. Pure. */
function reviewModel(balls, rows, skips) {
  var skip = {}; (skips || []).forEach(function (id) { skip[id] = 1; });
  var suggest = [], ambiguous = [], miss = [], linked = 0, skipped = 0;
  (balls || []).forEach(function (b) {
    if (b.CatalogID) { linked++; return; }
    if (skip[b.BallID]) { skipped++; return; }
    var L = lookupIn(rows, b.MFG, b.BallName);
    if (L.status === 'match') suggest.push({ ball: b, entry: L.candidates[0] });
    else if (L.status === 'ambiguous') ambiguous.push({ ball: b, candidates: L.candidates });
    else miss.push({ ball: b });
  });
  return { suggest: suggest, ambiguous: ambiguous, miss: miss, linked: linked, skipped: skipped };
}

/* ---- presentation helpers ---- */
function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function entryLine(e) {
  var tags = [];
  if (e.y) tags.push('USBC ' + e.y);
  if (/-u13$/.test(e.i)) tags.push('under 13 lb');
  return '<b>' + esc(e.m) + '</b> ' + esc(e.n) +
    (tags.length ? ' <span style="color:var(--t3);font-size:11px">· ' + esc(tags.join(' · ')) + '</span>' : '');
}
var BTN = 'padding:6px 10px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;';
var BTN_P = BTN + 'background:rgba(0,217,217,0.12);color:var(--teal);border:1px solid rgba(0,217,217,0.3);';
var BTN_G = BTN + 'background:var(--bg3);color:var(--t2);border:1px solid var(--border1);';
var LS_SKIPS = 'bowlingdb_catalog_skips';
function readSkips() { try { return JSON.parse(env.ls().getItem(LS_SKIPS) || '[]') || []; } catch (e) { return []; } }
function writeSkips(a) { try { env.ls().setItem(LS_SKIPS, JSON.stringify(a)); } catch (e) {} }

/* ---- picker (lives at the top of the ball edit form) ---- */
var _pick = { ball: null, isNew: true, touched: false, id: null };

/* Only meaningful while this picker is on screen: a stale pick from an
   earlier form must never be applied to a different ball. */
function catPickValue() {
  var live = typeof document !== 'undefined' && !!document.getElementById('cat-pick-group');
  return { touched: live && _pick.touched, id: _pick.id };
}

function pickerBodyHTML(rows) {
  if (!rows.length) {
    return '<div style="font-size:12px;color:var(--t3);line-height:1.5">Catalog not downloaded yet. ' +
      'Enter details below as usual, or download it in Settings → Ball Catalog.</div>';
  }
  var cur = byIdIn(rows, _pick.id);
  if (_pick.id) {
    return '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:0;font-size:13px;color:var(--t1)">✓ ' +
        (cur ? entryLine(cur) : '<span style="color:var(--t3)">' + esc(_pick.id) + ' (not in current catalog)</span>') + '</div>' +
      '<button style="' + BTN_G + '" onclick="catUnlink()">Unlink</button></div>';
  }
  var sug = '';
  if (!_pick.isNew && _pick.ball) {
    var L = lookupIn(rows, _pick.ball.MFG, _pick.ball.BallName);
    if (L.status === 'match') {
      sug = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px;border-radius:9px;background:var(--bg3)">' +
        '<div style="flex:1;min-width:0;font-size:12px;color:var(--t2)">Suggested: ' + entryLine(L.candidates[0]) + '</div>' +
        '<button style="' + BTN_P + '" onclick="catPick(\'' + esc(L.candidates[0].i) + '\')">Link</button></div>';
    }
  }
  return sug +
    '<input class="bdet-field-input" id="cat-pick-q" type="search" placeholder="Search USBC list, e.g. storm hy-road"' +
    ' autocomplete="off" autocorrect="off" autocapitalize="off" oninput="catPickerSearch(this.value)">' +
    '<div id="cat-pick-results" style="margin-top:6px"></div>';
}

function resultsHTML(list, q) {
  if (!q || q.replace(/\s/g, '').length < 2) return '';
  if (!list.length) return '<div style="font-size:12px;color:var(--t3);padding:4px 2px">No match in the USBC list. Enter details below as usual.</div>';
  return list.map(function (e) {
    return '<div onclick="catPick(\'' + esc(e.i) + '\')" style="padding:8px 6px;border-bottom:1px solid var(--border1);font-size:13px;color:var(--t1);cursor:pointer">' +
      entryLine(e) + '</div>';
  }).join('');
}

function renderPicker() {
  var body = document.getElementById('cat-pick-body');
  if (!body) return;
  catLoad().then(function (rows) { body.innerHTML = pickerBodyHTML(rows); });
}

/* Called by index.html right after the edit form renders. b is null on Add. */
function catPickerMount(b) {
  var pane = document.getElementById('bdet-pane-specs');
  if (!pane || document.getElementById('cat-pick-group')) return;
  _pick = { ball: b || null, isNew: !b, touched: false, id: (b && b.CatalogID) || null };
  var g = document.createElement('div');
  g.className = 'bdet-field-group';
  g.id = 'cat-pick-group';
  g.innerHTML = '<div class="bdet-field-label">USBC Catalog</div><div id="cat-pick-body"></div>';
  pane.insertBefore(g, pane.firstChild);
  renderPicker();
}

function catPickerSearch(q) {
  var box = document.getElementById('cat-pick-results');
  if (!box) return;
  catLoad().then(function (rows) { box.innerHTML = resultsHTML(searchIn(rows, q, 25), q); });
}

function catPick(id) {
  catLoad().then(function (rows) {
    var e = byIdIn(rows, id);
    if (!e) return;
    _pick.touched = true; _pick.id = e.i;
    if (_pick.isNew) {
      var n = document.getElementById('bef-name'), m = document.getElementById('bef-mfg');
      if (n) n.value = e.n;
      if (m) m.value = e.m;
    }
    renderPicker();
  });
}

function catUnlink() { _pick.touched = true; _pick.id = null; renderPicker(); }

/* Read-view label for Ball Detail. Sync placeholder, filled after load. */
function catLinkLabel(b) {
  if (!b || !b.CatalogID) return '<span style="color:var(--t3)">Not linked</span>';
  var slot = 'cat-lbl-' + String(b.BallID).replace(/[^0-9a-z_-]/gi, '');
  catLoad().then(function (rows) {
    var el = document.getElementById(slot);
    if (!el) return;
    var e = byIdIn(rows, b.CatalogID);
    el.innerHTML = e ? entryLine(e) : (rows.length ? 'Linked (not in current catalog)' : 'Linked');
  });
  return '<span id="' + slot + '">Linked</span>';
}

/* ---- legacy-link review (modal, from Settings) ---- */
/* index.html declares `let db` (global lexical, not a window property),
   so it is reached by bare name, like report.js does. */
function appBalls() {
  try { return (typeof db !== 'undefined' && db && db.balls) || []; } catch (e) { return []; }
}
function reviewHTML(model) {
  var h = '<div style="font-size:16px;font-weight:700;color:var(--t1);margin-bottom:4px">Suggested catalog matches</div>' +
    '<div style="font-size:12px;color:var(--t3);margin-bottom:12px;line-height:1.5">Exact name matches against the USBC list. ' +
    'Check each one is the right generation before linking; nothing is linked automatically. Your own ball names are not changed.</div>';
  if (!model.suggest.length) h += '<div style="font-size:13px;color:var(--t2);margin-bottom:10px">No suggestions waiting.</div>';
  model.suggest.forEach(function (s) {
    var b = s.ball;
    h += '<div style="padding:10px 0;border-bottom:1px solid var(--border1)">' +
      '<div style="font-size:12px;color:var(--t3)">Your ball: ' + esc(b.MFG) + ' · ' + esc(b.BallName) +
        (b.DateReleased ? ' · ' + esc(String(b.DateReleased).slice(0, 10)) : '') + (b.Archived ? ' · archived' : '') + '</div>' +
      '<div style="font-size:13px;color:var(--t1);margin:3px 0 6px">→ ' + entryLine(s.entry) + '</div>' +
      '<div style="display:flex;gap:6px"><button style="' + BTN_P + 'flex:1" onclick="catReviewLink(' + Number(b.BallID) + ',\'' + esc(s.entry.i) + '\')">Link</button>' +
      '<button style="' + BTN_G + '" onclick="catReviewSkip(' + Number(b.BallID) + ')">Skip</button></div></div>';
  });
  var notes = [];
  if (model.ambiguous.length) notes.push(model.ambiguous.length + ' with several possible matches (link from Edit Ball)');
  if (model.miss.length) notes.push(model.miss.length + ' with no catalog match: ' + model.miss.map(function (x) { return esc(x.ball.BallName); }).join(', '));
  if (model.linked) notes.push(model.linked + ' already linked');
  if (model.skipped) notes.push(model.skipped + ' skipped (<span style="color:var(--teal);cursor:pointer" onclick="catReviewResetSkips()">show again</span>)');
  if (notes.length) h += '<div style="font-size:11px;color:var(--t3);margin-top:10px;line-height:1.6">' + notes.join('<br>') + '</div>';
  h += '<button class="btn btn-secondary" style="margin-top:12px" onclick="closeModal()">Done</button>';
  return h;
}

function catReviewOpen() {
  catLoad().then(function (rows) {
    if (!rows.length) { if (root.toast) root.toast('Download the catalog first (Check for updates)'); return; }
    var balls = appBalls();
    var html = reviewHTML(reviewModel(balls, rows, readSkips()));
    if (document.getElementById('modal-bg') && document.getElementById('modal-bg').classList.contains('open') && root.swapModal) root.swapModal(html);
    else if (root.openModal) root.openModal(html);
  });
}
function catReviewLink(ballID, id) {
  var b = appBalls().find(function (x) { return x.BallID == ballID; });
  if (!b) return;
  b.CatalogID = id;
  if (root.saveDB) root.saveDB();
  catReviewOpen();
}
function catReviewSkip(ballID) {
  var s = readSkips(); if (s.indexOf(ballID) < 0) s.push(ballID); writeSkips(s); catReviewOpen();
}
function catReviewResetSkips() { writeSkips([]); catReviewOpen(); }

root.catPickerMount = catPickerMount; root.catPickerSearch = catPickerSearch;
root.catPick = catPick; root.catUnlink = catUnlink; root.catPickValue = catPickValue;
root.catLinkLabel = catLinkLabel; root.catReviewOpen = catReviewOpen;
root.catReviewLink = catReviewLink; root.catReviewSkip = catReviewSkip;
root.catReviewResetSkips = catReviewResetSkips;
root.catLookup = function (mfg, name) { return catLoad().then(function (rows) { return lookupIn(rows, mfg, name); }); };
root.catSearch = function (q, n) { return catLoad().then(function (rows) { return searchIn(rows, q, n); }); };
root._catStep5 = { norm: norm, modelKey: modelKey, lookupIn: lookupIn, searchIn: searchIn, reviewModel: reviewModel,
                   pickerBodyHTML: pickerBodyHTML, reviewHTML: reviewHTML, resultsHTML: resultsHTML,
                   setPick: function (p) { _pick = p; } };

root.catCheck = catCheck;
root.catLoad = catLoad;
root.catStatus = catStatus;
root.catClear = catClear;
root._catInternals = { env: env, shouldCheck: shouldCheck, verifyAndParse: verifyAndParse,
                       hex16: hex16, readMeta: readMeta, CAT_BASE: CAT_BASE,
                       reset: function () { _rows = null; _inflight = null; } };

})(typeof window !== 'undefined' ? window : globalThis);
