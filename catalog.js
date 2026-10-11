/* =====================================================================
   BowlingDB catalog.js  -  NEW-11 Ball Catalog: cache, picker, linking,
   v30.158: Add a Ball (search -> detail sheet -> Add to Arsenal), detail
   shards (CAT-6), Fill from catalog, MET-1 Strength/Shape.
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

/* v30.169: shown in the app header when it differs from the build's EXPECTED_CATALOG_JS */
var CAT_VERSION  = 'v30.173';
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
      writeMeta({ files: detailFiles(manifest) });   /* CAT-6: shard hashes for catDetail() */
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
      '<button style="' + BTN_G + '" onclick="catUnlink()">Unlink</button></div>' +
      '<div id="cat-fill-row"></div>';
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
  catLoad().then(function (rows) { body.innerHTML = pickerBodyHTML(rows); renderFillRow(); });
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
  _filled = {};
  renderPicker();
}

/* v30.158: CAT-5d (search-first into the old form + automatic AI fetch) removed;
   Add a Ball lives in the ADD-1..3 block below. */
/* While a USBC entry is chosen on a NEW ball, name/mfg come from the
   catalog and AI spec fills must not overwrite them. */
function catIdentityLocked() {
  var live = typeof document !== 'undefined' && !!document.getElementById('cat-pick-group');
  return live && _pick.isNew && !!_pick.id;
}

function ownedIndex(rows) {
  var linked = {}, keyed = {};
  appBalls().forEach(function (b) {
    if (b.CatalogID) linked[b.CatalogID] = 1;
    keyed[modelKey(b.MFG, b.BallName)] = 1;
  });
  return { linked: linked, keyed: keyed };
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
    /* APP-2: only offered while something is still unverified */
    /* v30.172 CAT-NEW-4: the progress card replaces the button while a check runs for this ball */
    var _va = vfyActive(), _vmine = _va && _va.catalogId === e.i;
    if (e && sourceForBrand(e.m) && (_vmine || SPEC_FIELDS.some(function (f) { return catSpecUnverified(b, f); })))
      el.innerHTML += vfySlotHTML(e.i, '<div><button style="' + BTN_G + 'margin-top:6px;padding:5px 10px;font-size:11px" onclick="catVerifyNow(\'' + esc(e.m) + '\',\'' + esc(e.i) + '\',' + JSON.stringify(b.BallID).replace(/"/g, '&quot;') + ')">Verify now</button> <button style="' + BTN_G + 'margin-top:6px;padding:5px 10px;font-size:11px" onclick="catSpecReviewOpen(' + JSON.stringify(b.BallID).replace(/"/g, '&quot;') + ')">Review specs</button></div>');
    /* DATA-2: confirm matching legacy specs; a second render finds nothing left, so no loop */
    catAutoVerify(b).then(function (n) {
      if (n && typeof root._bdetRenderSpecs === 'function' && document.getElementById(slot)) root._bdetRenderSpecs();
    });
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

/* ---- accuracy check: every owned ball vs the catalog. Pure model. ---- */
function yearOf(d) { var m = /^(\d{4})/.exec(String(d || '')); return m ? +m[1] : null; }
function auditModel(balls, rows) {
  ensureMaps(rows);
  var byEntry = {};
  balls.forEach(function (b) { if (b.CatalogID) (byEntry[b.CatalogID] = byEntry[b.CatalogID] || []).push(b); });
  var items = balls.map(function (b) {
    var flags = [], e = null, status;
    if (b.CatalogID) {
      e = byIdIn(rows, b.CatalogID);
      if (!e) { status = 'stale'; flags.push('Linked entry is not in the current catalog'); }
      else {
        status = 'linked';
        if (modelKey(b.MFG, b.BallName) !== e.k) flags.push('Your name differs from USBC\'s (fine if intended)');
        var yb = yearOf(b.DateReleased), ye = e.y ? +e.y : null;
        if (yb && ye && Math.abs(yb - ye) > 1) flags.push('Release ' + yb + ' vs USBC ' + ye + ': check generation, or fix the date');
        if (byEntry[b.CatalogID].length > 1) flags.push('Same entry linked by ' + byEntry[b.CatalogID].length + ' of your balls (duplicate record?)');
      }
    } else {
      var L = lookupIn(rows, b.MFG, b.BallName);
      status = L.status === 'match' ? 'suggest' : L.status === 'ambiguous' ? 'ambiguous' : 'unmatched';
      if (L.status === 'match') e = L.candidates[0];
    }
    return { ball: b, entry: e, status: status, flags: flags };
  });
  var c = { linked: 0, flagged: 0, suggest: 0, ambiguous: 0, unmatched: 0, stale: 0 };
  items.forEach(function (it) { c[it.status]++; if (it.flags.length) c.flagged++; });
  return { items: items, counts: c };
}
function auditHTML(model) {
  var c = model.counts;
  var order = { stale: 0, linked: 1, suggest: 2, ambiguous: 3, unmatched: 4 };
  var items = model.items.slice().sort(function (a, b) {
    return (b.flags.length ? 1 : 0) - (a.flags.length ? 1 : 0) || order[a.status] - order[b.status];
  });
  var label = { linked: 'Linked', stale: 'Linked', suggest: 'Not linked · suggestion waiting', ambiguous: 'Not linked · several matches', unmatched: 'Not linked · no USBC match' };
  var h = '<div style="font-size:16px;font-weight:700;color:var(--t1);margin-bottom:4px">Check linked balls</div>' +
    '<div style="font-size:12px;color:var(--t2);margin-bottom:12px;line-height:1.6">' +
      c.linked + ' linked · ' + c.flagged + ' flagged · ' + c.suggest + ' suggestion' + (c.suggest === 1 ? '' : 's') + ' waiting · ' +
      (c.unmatched + c.ambiguous) + ' without a single match</div>';
  items.forEach(function (it) {
    var b = it.ball, e = it.entry;
    h += '<div style="padding:9px 0;border-bottom:1px solid var(--border1)">' +
      '<div style="font-size:11px;color:var(--t3)">' + esc(label[it.status]) + '</div>' +
      '<div style="font-size:13px;color:var(--t1);margin-top:2px">Yours: ' + esc(b.MFG) + ' · ' + esc(b.BallName) +
        (b.DateReleased ? ' · ' + esc(String(b.DateReleased).slice(0, 10)) : '') + '</div>' +
      (e ? '<div style="font-size:13px;color:var(--t2)">USBC: ' + entryLine(e) + '</div>' : '') +
      it.flags.map(function (f) { return '<div style="font-size:11px;color:var(--gold);margin-top:3px">⚠ ' + esc(f) + '</div>'; }).join('') +
      '</div>';
  });
  h += '<button class="btn btn-secondary" style="margin-top:12px" onclick="closeModal()">Done</button>';
  return h;
}
function catAuditOpen() {
  catLoad().then(function (rows) {
    if (!rows.length) { if (root.toast) root.toast('Download the catalog first (Check for updates)'); return; }
    var html = auditHTML(auditModel(appBalls(), rows));
    var bg = document.getElementById('modal-bg');
    if (bg && bg.classList.contains('open') && root.swapModal) root.swapModal(html); else if (root.openModal) root.openModal(html);
  });
}

/* =====================================================================
   v30.158 NEW-11: ADD-1..3 standalone Add a Ball, CAT-6 detail shards,
   MET-1 Strength/Shape. Locked: DESIGN_add_ball_flow.md rev 5.
   - Search -> detail sheet -> Add to Arsenal. Replaces CAT-5d (the
     search-into-old-form path and its automatic AI spec fetch).
   - The old form is Edit Ball + "Enter manually" only.
   - Specs come only from the published catalog shards. Nothing here
     guesses: a missing value is shown as a dash and stored as null.
   ===================================================================== */

/* ---------- CAT-6: detail shards ---------- */
function detailFiles(manifest) {
  var out = {};
  var f = (manifest && manifest.files) || {};
  for (var k in f) if (/^detail\//.test(k) && f[k] && f[k].hash) out[k] = { hash: f[k].hash };
  return out;
}
/* manufacturer -> shard key, matched on the normalized file stem */
function shardKeyFor(files, mfg) {
  var want = norm(canonicalMfg(mfg));
  for (var k in files) {
    var stem = k.replace(/^detail\//, '').replace(/\.json$/i, '');
    if (norm(stem) === want) return k;
  }
  return null;
}
/* tolerant shard shape: [entries] | {balls:[...]} | {id: entry} -> {id: entry} */
function shardMap(data) {
  var m = {};
  var arr = Array.isArray(data) ? data : (data && Array.isArray(data.balls)) ? data.balls : null;
  if (arr) { arr.forEach(function (e) { var id = e && (e.CatalogID || e.i); if (id) m[id] = e; }); return m; }
  if (data && typeof data === 'object') { for (var k in data) if (data[k] && typeof data[k] === 'object') m[k] = data[k]; }
  return m;
}
function kvPut(key, val) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = function () { db.close(); resolve(true); };
      tx.onerror = tx.onabort = function () { db.close(); reject(tx.error || new Error('kv put failed')); };
    });
  });
}
var _shards = {};          // key -> {hash, map}
var _manifestOnce = null;  // one manifest fetch per session when meta predates v30.158
function filesKnown() {
  var m = readMeta();
  if (m.files) return Promise.resolve(m.files);
  if (_manifestOnce) return _manifestOnce;
  _manifestOnce = env.fetch(CAT_BASE + 'manifest.json', { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('manifest HTTP ' + r.status); return r.json(); })
    .then(function (mf) { var f = detailFiles(mf); writeMeta({ files: f }); return f; })
    .catch(function () { _manifestOnce = null; return {}; });
  return _manifestOnce;
}
/* Resolves the detail entry for a CatalogID, or null. Never rejects. */
/* v30.170: this device's own corrections (bowwwl-sourced) layered over a catalog
   record, display only. Marked _local so the sheet can say so. */
function withLocalCorrection(id, d) {
  var o = localOverrides()[id];
  if (!o) return d;
  var x = JSON.parse(JSON.stringify(d || {}));
  x.Cover = x.Cover || {}; x.Core = x.Core || {}; x.SpecsByWeight = x.SpecsByWeight || {};
  if (o.coverType) x.Cover.Type = o.coverType; if (o.finish) x.Cover.Finish = o.finish;
  if (o.core) x.Core.Name = o.core; if (o.coreType) x.Core.Type = o.coreType;
  if (o.released) x.DateReleased = o.released;
  Object.keys(o.weights || {}).forEach(function (w) { x.SpecsByWeight[w] = Object.assign({}, x.SpecsByWeight[w] || {}, o.weights[w]); });
  x._local = { source: o.source, at: o.at };
  return x;
}
function catDetail(entry) {
  return catDetailRaw(entry).then(function (d) { return entry && (d || localOverrides()[entry.i]) ? withLocalCorrection(entry.i, d) : d; });
}
function catDetailRaw(entry) {
  if (!entry) return Promise.resolve(null);
  return filesKnown().then(function (files) {
    var key = shardKeyFor(files, entry.m);
    if (!key) return null;
    var want = files[key].hash;
    var mem = _shards[key];
    if (mem && mem.hash === want) return mem.map[entry.i] || null;
    return kvGet('detail:' + key).catch(function () { return null; }).then(function (cached) {
      if (cached && cached.hash === want && cached.map) { _shards[key] = cached; return cached.map[entry.i] || null; }
      return env.fetch(CAT_BASE + key, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('shard HTTP ' + r.status); return r.text(); })
        .then(function (text) {
          return sha16(text).then(function (h) {
            if (h !== want) throw new Error('shard hash mismatch');
            var rec = { hash: want, map: shardMap(JSON.parse(text)) };
            _shards[key] = rec;
            kvPut('detail:' + key, rec).catch(function () {});
            return rec.map[entry.i] || null;
          });
        })
        .catch(function () {
          /* degrade: a stale cached shard beats nothing; none -> index-level only */
          if (cached && cached.map) { _shards[key] = cached; return cached.map[entry.i] || null; }
          return null;
        });
    });
  }).catch(function () { return null; });
}

/* Normalized specs for one weight. Never borrows another weight's numbers. */
function numOrNull(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
function specsOf(d, weight) {
  var out = { coverName: null, coverType: null, finish: null, coreName: null, coreType: null,
              rg: null, diff: null, intDiff: null, released: null, src: null, checked: null, weights: [] };
  if (!d) return out;
  var cv = d.Cover || {}, co = d.Core || {};
  out.coverName = cv.Name || null; out.coverType = cv.Type || null; out.finish = cv.Finish || null;
  out.coreName = co.Name || null; out.coreType = co.Type || null;
  out.released = d.DateReleased || null;
  var sbw = d.SpecsByWeight || {};
  out.weights = Object.keys(sbw).map(Number).filter(isFinite).sort(function (a, b) { return b - a; });
  var w = sbw[String(weight)];
  if (w) { out.rg = numOrNull(w.RG); out.diff = numOrNull(w.Diff); out.intDiff = numOrNull(w.IntDiff); }
  var fs = d.FieldSources || d.Sources || {};
  out.src = d.Source || fs.src || fs.RG || null;
  if (out.src === 'mfg') out.src = 'manufacturer';
  out.checked = d.Checked || fs.checked || null;
  return out;
}
/* v30.167 (locked 2026-10-09): cover type may be read from the coverstock
   name, but only Pearl, Hybrid and Solid, and only when the name names
   exactly one of them. Shown as "from name"; never stored as a stated value. */
function derivedCoverType(name) {
  var t = String(name || ''), hit = [];
  if (/\bpearl/i.test(t)) hit.push('Pearl');
  if (/\bhybrid/i.test(t)) hit.push('Hybrid');
  if (/\bsolid/i.test(t)) hit.push('Solid');
  return hit.length === 1 ? hit[0] : null;
}
/* Pure: what a catalog record is missing. RG/Diff count at ANY weight;
   Int Diff is only expected for an asymmetric core. */
function specGaps(d) {
  if (!d) return null;
  var s = specsOf(d, 15), g = [], w = d.SpecsByWeight || {}, rd = false, idf = false;
  for (var k in w) { if (w[k] && numOrNull(w[k].RG) != null && numOrNull(w[k].Diff) != null) rd = true; if (w[k] && numOrNull(w[k].IntDiff) != null) idf = true; }
  if (!s.coverType && !derivedCoverType(s.coverName)) g.push('cover type');
  if (!s.finish) g.push('finish');
  if (!s.coreType) g.push('core type');
  if (!rd) g.push('RG / Diff');
  if (/asym/i.test(s.coreType || '') && !idf) g.push('Int Diff');
  return g;
}
/* Pure: nearest published weight that has RG and Diff (ties go heavier), or null. */
function nearestWeight(d, wt) {
  var w = (d && d.SpecsByWeight) || {}, best = null;
  Object.keys(w).map(Number).filter(function (k) { return isFinite(k) && numOrNull(w[k].RG) != null && numOrNull(w[k].Diff) != null; })
    .forEach(function (k) { if (best == null || Math.abs(k - wt) < Math.abs(best - wt) || (Math.abs(k - wt) === Math.abs(best - wt) && k > best)) best = k; });
  return best;
}
function hasAnySpec(s) {
  return !!(s.coverName || s.coverType || s.finish || s.coreName || s.coreType || s.weights.length || s.released);
}

/* ---------- MET-1: Strength 0-100, Shape -50..+50 (facts only) ---------- */
var MET_W  = { cover: 0.30, diff: 0.30, surface: 0.20, rg: 0.20 };
var MET_SW = { surface: 0.35, rg: 0.25, asym: 0.20, pearl: 0.20 };
var MET_COVER = { solid: 1.0, hybrid: 0.9, reactive: 0.85, pearl: 0.85, urethane: 0.4, plastic: 0.05 };
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function coverClass(type, name) {
  var t = ((type || '') + ' ' + (name || '')).toLowerCase();
  if (/polyester|plastic|spare/.test(t)) return 'plastic';
  if (/urethane/.test(t) && !/reactive/.test(t)) return 'urethane';
  if (/hybrid/.test(t)) return 'hybrid';
  if (/pearl/.test(t)) return 'pearl';
  if (/solid/.test(t)) return 'solid';
  if (/reactive/.test(t)) return 'reactive';
  return null;
}
/* "500/1000 Polished", "4K Fast", "Reacta Gloss" -> {grit, polished}; unparseable -> null */
function parseFinish(s) {
  if (s == null || s === '') return null;
  var t = String(s).toLowerCase(), nums = [], re = /(\d+(?:\.\d+)?)\s*(k)?/g, m;
  while ((m = re.exec(t))) { var n = +m[1] * (m[2] ? 1000 : 1); if (n >= 100 && n <= 30000) nums.push(n); }
  var polished = /polish|gloss|compound|crown|shine/.test(t);
  var grit = nums.length ? nums[nums.length - 1] : (polished ? 1500 : null);
  return grit == null ? null : { grit: grit, polished: polished };
}
function surfaceFriction(f) {
  if (!f) return null;
  var x = clamp((Math.log(6000) - Math.log(f.grit)) / (Math.log(6000) - Math.log(360)), 0, 1);
  return f.polished ? x * 0.6 : x;
}
/* ball: owned-ball fields (Coverstock, CoverName, RG, Differential, IntDiff, CoreType); fin: {grit,polished}|null */
function metricScore(ball, fin) {
  var cc = coverClass(ball.Coverstock, ball.CoverName);
  var S = surfaceFriction(fin), C = cc ? MET_COVER[cc] : null;
  if (C == null || S == null) return null;
  var D = ball.Differential != null && ball.Differential !== '' ? clamp(+ball.Differential / 0.060, 0, 1) : null;
  var R = ball.RG != null && ball.RG !== '' ? clamp((2.60 - +ball.RG) / 0.14, 0, 1) : null;
  /* v30.163 MET-3 (locked 2026-10-09): James's bands feed Strength as half of
     the RG and Diff parts. Band scores: Diff Low 0 / Med .5 / High 1; RG Low 1 /
     Med .5 / High 0 (earlier hook = stronger, MET-1's direction). Rank check vs
     Perfect Scale on 20 owned balls: raw 0.69, bands only 0.62, blend 0.70
     (met3_check.js). Shape stays on the raw numbers. */
  var Db = MET3_DIFF[diffBand(ball.Differential)], Rb = MET3_RG[rgBand(ball.RG)];
  var Ds = D == null ? null : (Db == null ? D : (D + Db) / 2);
  var Rs = R == null ? null : (Rb == null ? R : (R + Rb) / 2);
  var asym = ball.IntDiff != null && ball.IntDiff !== '' ? clamp(+ball.IntDiff / 0.020, 0, 1)
           : (/asym/i.test(ball.CoreType || '') ? 0.5 : (ball.CoreType ? 0 : null));
  var parts = { cover: C, surface: S, diff: Ds, rg: Rs }, num = 0, den = 0, k;
  for (k in MET_W) if (parts[k] != null) { num += MET_W[k] * parts[k]; den += MET_W[k]; }
  var pearl = cc === 'pearl' ? 1 : cc === 'hybrid' ? 0.5 : (cc === 'urethane' || cc === 'plastic') ? 0 : 0.2;
  var sp = { surface: 1 - S, rg: R == null ? null : 1 - R, asym: asym, pearl: pearl }, sn = 0, sd = 0;
  for (k in MET_SW) if (sp[k] != null) { sn += MET_SW[k] * sp[k]; sd += MET_SW[k]; }
  return { strength: Math.floor(100 * num / den), shape: Math.floor(100 * (sn / sd) - 50) };
}
var MET3_DIFF = { Low: 0, Med: 0.5, High: 1 };
var MET3_RG   = { Low: 1, Med: 0.5, High: 0 };
/* Latest surfacing record for an owned ball (ties on date -> highest id). */
function latestSurface(ballID) {
  var list = [];
  try { list = ((typeof db !== 'undefined' && db && db.surfaceDetails) || []).filter(function (s) { return s.BallID == ballID; }); } catch (e) {}
  list.sort(function (a, b) {
    var da = String(a.DateSurfaced || ''), dbb = String(b.DateSurfaced || '');
    return da < dbb ? 1 : da > dbb ? -1 : (b.SurfacedDetailID || 0) - (a.SurfacedDetailID || 0);
  });
  var s = list[0];
  return s && s.GritSimple ? { grit: +s.GritSimple, polished: !!s.Polished } : null;
}
/* -> { strength, shape, factory:{strength,shape}|null, current:boolean } | null */
function catMetric(ball) {
  if (!ball) return null;
  var fac = metricScore(ball, parseFinish(ball.BoxFinish));
  var surf = ball.BallID != null ? latestSurface(ball.BallID) : null;
  var cur = surf ? metricScore(ball, surf) : null;
  var use = cur || fac;
  if (!use) return null;
  return { strength: use.strength, shape: use.shape, factory: fac, current: !!cur, approx: metricUnverified(ball) };
}
/* ---------- DATA-2: legacy spec provenance (locked 2026-10-09) ----------
   An owned ball's spec field is UNVERIFIED when it has a value but no
   SpecSource tag ('catalog' or 'user'): Access import or a pre-v30.158 AI
   fetch. Catalog-only balls (no BallID) are the catalog itself. */
var MET_FIELDS = ['Coverstock', 'CoverName', 'BoxFinish', 'RG', 'Differential', 'IntDiff', 'CoreType'];
function catSpecUnverified(ball, f) {
  if (!ball || ball.BallID == null) return false;
  var v = ball[f];
  if (v == null || v === '') return false;
  var t = (ball.SpecSource || {})[f];
  return t !== 'catalog' && t !== 'user';
}
function metricUnverified(ball) {
  return MET_FIELDS.some(function (f) { return catSpecUnverified(ball, f); });
}
/* Within rounding (R3): RG 0.002, Diff / Int Diff 0.001; text after normalising. */
function normTxt(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function specMatch(f, owned, cat) {
  var a = owned[f], c = cat[f];
  if (a == null || a === '' || c == null || c === '') return false;
  if (f === 'RG') return Math.abs(+a - +c) <= 0.002 + 1e-9;
  if (f === 'Differential' || f === 'IntDiff') return Math.abs(+a - +c) <= 0.001 + 1e-9;
  if (f === 'Coverstock') { var x = coverClass(a, owned.CoverName), y = coverClass(c, cat.CoverName); return !!x && x === y; }
  if (f === 'CoreType') { var k = function (t) { return /asym/i.test(t) ? 'a' : /sym/i.test(t) ? 's' : normTxt(t); }; return k(a) === k(c); }
  if (f === 'BoxFinish') {
    var pa = parseFinish(a), pc = parseFinish(c);
    if (pa && pc) return pa.grit === pc.grit && pa.polished === pc.polished;
    return normTxt(a) === normTxt(c);
  }
  if (f === 'DateReleased') return String(a).slice(0, 7) === String(c).slice(0, 7);
  if (f === 'CoreShort') return coreNameMatch(a, c);
  return normTxt(a) === normTxt(c);
}
/* v30.171 CAT-NEW-5: core names match when one contains the other as whole
   words ("Atomic" in "Atomic Asymmetric Core"). Generic words (core, sym/asym,
   weight block...) are ignored, so "Asymmetric" alone never matches a name. */
var CORE_GENERIC = /^(core|cores|weight|block|engine|sym|asym|symmetric|symmetrical|asymmetric|asymmetrical|low|high|med|medium|rg|diff|the|tm)$/;
function coreWords(t) {
  return String(t == null ? '' : t).toLowerCase().replace(/[\u2122\u00ae\u00a9]/g, ' ').replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(function (w) { return w && !CORE_GENERIC.test(w); });
}
function coreNameMatch(a, c) {
  var x = coreWords(a), y = coreWords(c);
  if (!x.length || !y.length) return normTxt(a) === normTxt(c) && normTxt(a) !== '';
  var s = x.length <= y.length ? x : y, l = s === x ? y : x;
  for (var i = 0; i + s.length <= l.length; i++) {
    var ok = true;
    for (var j = 0; j < s.length; j++) if (l[i + j] !== s[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}
/* Pure: the tag changes auto-verify would make. Only untagged fields that
   match move to 'catalog'; 'user' and 'catalog' tags are never touched,
   and a mismatch stays unverified (Apply is offered in Edit Ball). */
function verifyPlan(ball, spec) {
  var out = [];
  SPEC_FIELDS.forEach(function (f) {
    if (catSpecUnverified(ball, f) && specMatch(f, ball, spec)) out.push(f);
  });
  return out;
}
/* Resolves to the number of fields newly verified. Never rejects. */
function catAutoVerify(ball) {
  if (!ball || !ball.CatalogID || ball.BallID == null) return Promise.resolve(0);
  if (!SPEC_FIELDS.some(function (f) { return catSpecUnverified(ball, f); })) return Promise.resolve(0);
  return catLoad().then(function (rows) {
    var e = byIdIn(rows, ball.CatalogID);
    return e ? catDetailRaw(e) : null;   /* catalog only: device corrections never mark a field 'catalog' */
  }).then(function (d) {
    if (!d) return 0;
    var s = specsOf(d, parseInt(ball.Weight, 10) || 15);
    if (!hasAnySpec(s)) return 0;
    var f = verifyPlan(ball, ballFromSpecs(s));
    if (!f.length) return 0;
    ball.SpecSource = ball.SpecSource || {};
    f.forEach(function (k) { ball.SpecSource[k] = 'catalog'; });
    if (root.saveDB) root.saveDB();
    return f.length;
  }).catch(function () { return 0; });
}
var _verifyAllOnce = null;
function catAutoVerifyAll() {
  if (_verifyAllOnce) return _verifyAllOnce;
  var list = appBalls().filter(function (b) { return b.CatalogID; });
  _verifyAllOnce = list.reduce(function (p, b) {
    return p.then(function (n) { return catAutoVerify(b).then(function (k) { return n + k; }); });
  }, Promise.resolve(0)).then(function (n) { _verifyAllOnce = null; return n; });
  return _verifyAllOnce;
}
var UNVERIFIED_TAG = '<span title="Not confirmed by the catalog or by you" style="font-size:9px;font-weight:700;color:var(--gold);border:1px solid rgba(214,169,76,0.45);border-radius:3px;padding:0 3px;margin-left:5px;vertical-align:1px">unverified</span>';
function catUnverifiedTag(ball, f) { return catSpecUnverified(ball, f) ? UNVERIFIED_TAG : ''; }
function signed(n) { return (n > 0 ? '+' : '') + n; }
function catMetricChip(ball) {
  var m = catMetric(ball);
  return m ? 'S' + (m.approx ? '~' : '') + m.strength + ' · ' + signed(m.shape) : '';
}
function catMetricHTML(ball) {
  var m = catMetric(ball);
  if (!m) return '<span style="color:var(--t3)">Not enough specs</span>';
  var h = 'Strength <b>' + (m.approx ? '~' : '') + m.strength + '</b> · Shape <b>' + signed(m.shape) + '</b>';
  if (m.current && m.factory && (m.factory.strength !== m.strength || m.factory.shape !== m.shape))
    h += '<div style="font-size:11px;color:var(--t3);margin-top:2px">Current surface · factory ' + m.factory.strength + ' · ' + signed(m.factory.shape) + '</div>';
  if (m.approx) h += '<div style="font-size:11px;color:var(--t3);margin-top:2px">~ built on unverified specs</div>';
  return h;
}

/* ---------- MET-3: RG / Diff bands (James's ranges, locked 2026-10-06) ----------
   RG   Low 2.460-<2.570 (earlier hook) | Med 2.570-<2.680 | High >=2.680 (more length)
   Diff Low <=.025 (low flare) | Med .026-.050 | High >=.051 (high flare). Boundaries go to the higher band. */
function rgBand(rg) { var v = parseFloat(rg); if (!isFinite(v)) return null; return v < 2.570 ? 'Low' : v < 2.680 ? 'Med' : 'High'; }
function diffBand(d) { var v = parseFloat(d); if (!isFinite(v)) return null; v = Math.round(v * 1000) / 1000; return v <= 0.025 ? 'Low' : v <= 0.050 ? 'Med' : 'High'; }
function catRGBand(rg, diff) { var a = rgBand(rg), b = diffBand(diff); return a && b ? a + '/' + b : null; }

/* ---------- presentation helpers for the add flow ---------- */
var BRAND_COLORS = ['#e2504c', '#3a7bd5', '#8e44ad', '#16a085', '#d35400', '#2c3e50', '#c0392b', '#27ae60', '#b7950b', '#5d6d7e'];
function brandColor(m) { var s = norm(m), h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return BRAND_COLORS[h % BRAND_COLORS.length]; }
function ownedFor(e) {
  return appBalls().filter(function (b) { return b.CatalogID === e.i; });
}
function thumbHTML(e, size) {
  var px = size || 40;
  var mine = ownedFor(e)[0], src = null;
  try { if (mine && typeof root.getBallImgSrc === 'function') src = root.getBallImgSrc(mine.BallID, 'cover'); } catch (x) {}
  if (src) return '<img src="' + esc(src) + '" alt="" style="width:' + px + 'px;height:' + px + 'px;border-radius:50%;object-fit:cover;flex-shrink:0">';
  var c = brandColor(e.m), ini = esc(String(e.m || '?').trim().charAt(0).toUpperCase());
  /* IMG-1: manufacturer image on this device only; falls back to the initial if it fails to load */
  var dev = catImageFor(e.i);
  if (dev) return '<span style="position:relative;display:inline-flex;width:' + px + 'px;height:' + px + 'px;flex-shrink:0">' +
    '<img src="' + esc(dev) + '" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'flex\'" ' +
    'style="width:' + px + 'px;height:' + px + 'px;border-radius:50%;object-fit:contain;background:#fff;flex-shrink:0">' +
    '<div style="display:none;width:' + px + 'px;height:' + px + 'px;border-radius:50%;flex-shrink:0;align-items:center;justify-content:center;' +
    'background:radial-gradient(circle at 32% 28%,rgba(255,255,255,0.35),' + c + ' 45%,rgba(0,0,0,0.55));color:#fff;font-weight:800;font-size:' + Math.round(px * 0.4) + 'px">' + ini + '</div></span>';
  return '<div style="width:' + px + 'px;height:' + px + 'px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;' +
    'background:radial-gradient(circle at 32% 28%,rgba(255,255,255,0.35),' + c + ' 45%,rgba(0,0,0,0.55));color:#fff;font-weight:800;font-size:' + Math.round(px * 0.4) + 'px">' + ini + '</div>';
}
function cleanName(n) { return String(n == null ? '' : n).replace(/^\*+\s*/, '').trim(); }
function monthYear(d) {
  var m = /^(\d{4})-(\d{2})/.exec(String(d || ''));
  if (!m) return d ? esc(String(d)) : null;
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2] - 1] + ' ' + m[1];
}
var CHIP = 'font-size:10px;font-weight:700;border-radius:6px;padding:1px 6px;margin-left:4px;';
var CHIP_T = CHIP + 'color:var(--teal);border:1px solid rgba(0,217,217,0.35)';
var CHIP_G = CHIP + 'color:var(--t2);border:1px solid var(--border1)';

/* ---------- ADD-1: search screen ---------- */
var LS_RECENT = 'bowlingdb_catalog_recent';
function readRecent() { try { return JSON.parse(env.ls().getItem(LS_RECENT) || '[]') || []; } catch (e) { return []; } }
function pushRecent(id) {
  var a = readRecent().filter(function (x) { return x !== id; }); a.unshift(id);
  try { env.ls().setItem(LS_RECENT, JSON.stringify(a.slice(0, 10))); } catch (e) {}
}
function newest(rows, n) {
  return rows.slice().sort(function (a, b) {
    return String(b.d || b.y || '').localeCompare(String(a.d || a.y || '')) || a.n.localeCompare(b.n);
  }).slice(0, n);
}
/* brand-only query ("storm") -> that brand, newest first; otherwise normal search */
function addSearchIn(rows, q, limit) {
  var qn = norm(q);
  if (qn.length >= 2) {
    var brandRows = rows.filter(function (r) { return norm(r.m) === qn || norm(canonicalMfg(q)) === norm(r.m); });
    if (brandRows.length) return newest(brandRows, limit || 60);
  }
  return searchIn(rows, q, limit || 60);
}
/* ---------- v30.171 CAT-NEW-3 + CAT-NEW-1: Add a Ball bubbles, discontinued (LOCKED 2026-10-10) ----------
   Bubble rows: Brand (your brands + any you add), Cover, Core, then Specs and
   Discontinued. Within a row bubbles OR; across rows AND; typed search narrows
   on top. Cover/Core rows show only once the index carries them (cv/co, from
   build_catalog); Discontinued uses r (1 retired, 0 current from the maker's
   site). Unknown status: likely discontinued when USBC-approved over 3 years
   ago (year precision: approved before this year minus 3). */
var _af = { brands: [], cover: [], core: [], specs: true, disc: false, extra: [] };
var COVER_BUBBLES = [['S', 'Solid'], ['P', 'Pearl'], ['H', 'Hybrid'], ['U', 'Urethane']];
var CORE_BUBBLES = [['a', 'Asym'], ['s', 'Sym']];
function discontinuedOf(e, year) {
  if (!e) return null;
  if (e.r === 1) return 'retired';
  if (e.r === 0) return null;
  var y = parseInt(e.y, 10), now = year || new Date().getFullYear();
  return isFinite(y) && y < now - 3 ? 'likely' : null;
}
/* Pure: rows passing the bubbles (no text). */
function bubbleFilter(rows, f, year) {
  var bs = {}; (f.brands || []).forEach(function (b) { bs[norm(b)] = 1; });
  var hasB = (f.brands || []).length, hasC = (f.cover || []).length, hasK = (f.core || []).length;
  return rows.filter(function (e) {
    if (f.specs && !e.s) return false;
    if (!f.disc && discontinuedOf(e, year)) return false;
    if (hasB && !bs[norm(e.m)]) return false;
    if (hasC && f.cover.indexOf(e.cv) < 0) return false;
    if (hasK && f.core.indexOf(e.co) < 0) return false;
    return true;
  });
}
function yourBrands() {
  var b = {}; appBalls().forEach(function (x) { if (x.MFG) b[canonicalMfg(x.MFG)] = 1; });
  return Object.keys(b).sort();
}
function addRowHTML(e, owned, showBrand) {
  var mine = owned && (owned.linked[e.i] || owned.keyed[e.k]);
  var meta = []; if (showBrand) meta.push(esc(e.m)); if (e.y) meta.push(esc(e.y));
  var dc = discontinuedOf(e);
  if (dc) meta.push('<span style="color:var(--t3)">' + (dc === 'retired' ? 'retired' : 'likely retired') + '</span>');
  return '<div class="cat-add-row" onclick="catAddDetail(\'' + esc(e.i) + '\')" style="display:flex;align-items:center;gap:12px;padding:10px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' +
    thumbHTML(e, 40) +
    '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:600;color:var(--t1)">' + esc(cleanName(e.n)) +
      (mine ? '<span style="' + CHIP_T + '">IN YOUR ARSENAL</span>' : '') +
      (/-u13$/.test(e.i) ? '<span style="' + CHIP_G + '">UNDER 13 LB</span>' : '') + '</div>' +
    '<div style="font-size:12px;color:var(--t2);margin-top:2px">' + meta.join(' · ') +
      (e.s ? '<span data-spec-id="' + esc(e.i) + '" style="color:var(--gold)"></span>' : '') + '</div></div></div>';
}
var BUB = 'border-radius:16px;padding:5px 11px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;';
function bubble(on, label, js) {
  return '<button onclick="' + js + '" style="' + BUB + (on ? 'background:rgba(0,217,217,0.14);color:var(--teal);border:1px solid rgba(0,217,217,0.45)' : 'background:var(--bg2);color:var(--t2);border:1px solid var(--border1)') + '">' + label + '</button>';
}
function jsq(s) { return esc(s).replace(/&#39;/g, "\\'"); }
function bubblesHTML(rows) {
  var row = function (h) { return '<div style="display:flex;gap:6px;overflow-x:auto;padding:3px 0;-webkit-overflow-scrolling:touch;scrollbar-width:none">' + h + '</div>'; };
  var brands = yourBrands(); _af.extra.concat(_af.brands).forEach(function (b) { if (brands.indexOf(b) < 0) brands.push(b); });
  var h = row(brands.map(function (b) { return bubble(_af.brands.indexOf(b) >= 0, esc(b), "catAddBubble('b','" + jsq(b) + "')"); }).join('') +
    bubble(false, '+ brand', 'catAddBrandPick()'));
  var hasCv = rows.some(function (e) { return e.cv; }), hasCo = rows.some(function (e) { return e.co; });
  if (hasCv || hasCo) h += row((hasCv ? COVER_BUBBLES.map(function (c) { return bubble(_af.cover.indexOf(c[0]) >= 0, c[1], "catAddBubble('c','" + c[0] + "')"); }).join('') : '') +
    (hasCo ? CORE_BUBBLES.map(function (c) { return bubble(_af.core.indexOf(c[0]) >= 0, c[1], "catAddBubble('k','" + c[0] + "')"); }).join('') : ''));
  h += row(bubble(_af.specs, 'Specs', "catAddBubble('s')") + bubble(_af.disc, 'Discontinued', "catAddBubble('d')"));
  return h;
}
function addListHTML(rows, q, owned) {
  var text = q && q.replace(/\s/g, '').length >= 2;
  var pool = text ? addSearchIn(rows, q, 2000) : newest(rows, rows.length);
  var list = bubbleFilter(pool, _af);
  var oneBrand = _af.brands.length === 1 || (list.length && list.every(function (e) { return e.m === list[0].m; }));
  if (!list.length) {
    var loose = bubbleFilter(pool, { brands: _af.brands, cover: _af.cover, core: _af.core, specs: false, disc: true }).length;
    return '<div style="font-size:13px;color:var(--t2);padding:16px 2px;line-height:1.6">No match' + (text ? ' in the USBC list' : '') + '.' +
      (loose ? ' <a href="#" onclick="event.preventDefault();catAddLoosen()" style="color:var(--teal)">Show ' + loose + ' without specs or discontinued</a>' : '') + '</div>';
  }
  var cap = 100, more = list.length - cap;
  return list.slice(0, cap).map(function (e) { return addRowHTML(e, owned, !oneBrand); }).join('') +
    (more > 0 ? '<div style="font-size:12px;color:var(--t3);padding:12px 2px">' + more + ' more \u00b7 type to narrow</div>' : '');
}
function catAddBubble(kind, v) {
  if (kind === 's') _af.specs = !_af.specs;
  else if (kind === 'd') _af.disc = !_af.disc;
  else {
    var a = kind === 'b' ? _af.brands : kind === 'c' ? _af.cover : _af.core, i = a.indexOf(v);
    if (i >= 0) a.splice(i, 1); else a.push(v);
  }
  catAddRefresh();
}
function catAddLoosen() { _af.specs = false; _af.disc = true; catAddRefresh(); }
function catAddRefresh() { var q = document.getElementById('cat-add-q'); catAddSearch(q ? q.value : ''); }
function catAddSpecsOnly(on) { _af.specs = !!on; catAddRefresh(); }   // kept for older callers
/* "+ brand": every catalog brand, tap to add it as a bubble (selected). */
function catAddBrandPick() {
  catLoad().then(function (rows) {
    var n = {}; rows.forEach(function (e) { n[e.m] = (n[e.m] || 0) + 1; });
    var ov = overlay('cat-brand-ov', 905);
    ov.innerHTML = '<div style="padding:12px 16px 6px;display:flex;align-items:center;gap:12px"><button onclick="catAddBrandPickClose()" style="' + BACK + '" aria-label="Back">\u2039</button>' +
      '<div style="font-size:18px;font-weight:800;color:var(--t1)">Brands</div></div>' +
      '<div style="flex:1;overflow-y:auto;padding:0 16px 16px;-webkit-overflow-scrolling:touch">' +
      Object.keys(n).sort(function (a, b) { return a.localeCompare(b); }).map(function (b) {
        var on = _af.brands.indexOf(b) >= 0;
        return '<div onclick="catAddBrandToggle(\'' + jsq(b) + '\')" style="display:flex;justify-content:space-between;padding:11px 2px;border-bottom:1px solid var(--border1);cursor:pointer;font-size:15px;color:' + (on ? 'var(--teal)' : 'var(--t1)') + '">' +
          '<span>' + (on ? '\u2713 ' : '') + esc(b) + '</span><span style="font-size:12px;color:var(--t3)">' + n[b] + '</span></div>';
      }).join('') + '</div>';
    document.body.appendChild(ov);
  });
}
function catAddBrandToggle(b) {
  var i = _af.brands.indexOf(b);
  if (i >= 0) _af.brands.splice(i, 1); else { _af.brands.push(b); if (_af.extra.indexOf(b) < 0) _af.extra.push(b); }
  catAddBrandPickClose(); catAddRefresh();
}
function catAddBrandPickClose() { var el = document.getElementById('cat-brand-ov'); if (el) el.parentNode.removeChild(el); }
/* Marks listed rows whose record is missing key fields; shards load once per brand. */
function markPartials(box, rows) {
  var els = box.querySelectorAll('[data-spec-id]');
  Array.prototype.forEach.call(els, function (el) {
    var e = byIdIn(rows, el.getAttribute('data-spec-id'));
    catDetail(e).then(function (d) {
      var g = specGaps(d);
      if (g && g.length && el.isConnected) { el.textContent = ' \u00b7 \u25D0'; el.title = 'Missing ' + g.join(', '); }
    });
  });
}
function overlay(id, z) {
  var ov = document.createElement('div');
  ov.id = id;
  ov.setAttribute('style', 'position:fixed;inset:0;z-index:' + z + ';background:var(--bg0);display:flex;flex-direction:column;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)');
  return ov;
}
var BACK = 'background:var(--bg2);border:1px solid var(--border1);color:var(--t1);width:40px;height:40px;border-radius:50%;font-size:20px;cursor:pointer;flex-shrink:0';

/* Opens Add a Ball. Returns false (caller opens the plain form) with no catalog. */
function catOpenAddSearch() {
  if (typeof document === 'undefined') return false;
  var s = catStatus();
  if (!(s.count > 0)) return false;
  catCloseAddSearch();
  _af.specs = true; _af.disc = false; _af.brands = []; _af.cover = []; _af.core = [];   // each visit starts on specs only, current balls
  var ov = overlay('cat-search-ov', 900);
  ov.innerHTML =
    '<div style="padding:12px 16px 4px"><button onclick="catCloseAddSearch()" style="' + BACK + '" aria-label="Back">‹</button></div>' +
    '<div style="padding:4px 16px 0;font-size:30px;font-weight:800;color:var(--t1)">Add a Ball</div>' +
    '<div style="padding:10px 16px 2px"><input id="cat-add-q" class="bdet-field-input" type="search" placeholder="Search brands, names…"' +
      ' autocomplete="off" autocorrect="off" autocapitalize="off" oninput="catAddSearch(this.value)" style="width:100%;font-size:16px">' +
      '<div id="cat-add-bubbles" style="margin-top:6px"></div></div>' +
    '<div id="cat-add-results" style="flex:1;overflow-y:auto;padding:0 16px 12px;-webkit-overflow-scrolling:touch"><div style="font-size:12px;color:var(--t3);padding:14px 2px">Loading…</div></div>' +
    '<div style="padding:10px 16px;border-top:1px solid var(--border1)">' +
      '<button onclick="catAddManual()" style="' + BTN_G + 'width:100%;padding:11px;font-size:13px">Enter manually</button></div>';
  document.body.appendChild(ov);
  catAddSearch('');
  return true;
}
function catCloseAddSearch() {
  if (typeof document === 'undefined') return;
  ['cat-brand-ov', 'cat-sheet-ov', 'cat-search-ov'].forEach(function (id) { var el = document.getElementById(id); if (el) el.parentNode.removeChild(el); });
}
function catAddSearch(q) {
  catLoad().then(function (rows) {
    var box = document.getElementById('cat-add-results');
    var bb = document.getElementById('cat-add-bubbles'); if (bb) bb.innerHTML = bubblesHTML(rows);
    if (box) { box.innerHTML = addListHTML(rows, q, ownedIndex(rows)); markPartials(box, rows); }
  });
}
function catAddBrand(b) { if (_af.brands.indexOf(b) < 0) _af.brands.push(b); catAddRefresh(); }
function catAddManual() {
  catCloseAddSearch();
  if (root.navToBall) root.navToBall(null);
}

/* ---------- ADD-2: detail sheet ---------- */
var _sheet = { id: null, weight: null, detail: null, loaded: false };
var WEIGHTS = [16, 15, 14, 13, 12, 11, 10];

function specRows(e, s) {
  var dash = '<span style="color:var(--t3)">—</span>';
  var f = function (v, d) { return v != null && v !== '' ? esc(d != null ? Number(v).toFixed(d) : v) : dash; };
  return [
    ['Coverstock', f(s.coverName)],
    ['Cover type', s.coverType ? f(s.coverType) : (derivedCoverType(s.coverName) ? esc(derivedCoverType(s.coverName)) + ' <span style="font-size:10px;color:var(--t3)">from name</span>' : dash)],
    ['Factory finish', f(s.finish)],
    ['Core', f(s.coreName)], ['Core type', f(s.coreType)],
    ['RG', f(s.rg, 3) + (s._wNote && s.rg != null ? s._wNote : '')], ['Differential', f(s.diff, 3) + (s._wNote && s.diff != null ? s._wNote : '')],
    ['Int. Diff', f(s.intDiff, 3) + (s._wNote && s.intDiff != null ? s._wNote : '')],
    ['RG / Diff band', catRGBand(s.rg, s.diff) ? esc(catRGBand(s.rg, s.diff)) : dash],
    ['Release date', s.released ? (monthYear(s.released) || dash) : dash],
  ];
}
/* owned-ball shape of the catalog specs (also used by Add to Arsenal and Fill) */
function ballFromSpecs(s) {
  var cc = coverClass(s.coverType, s.coverName);
  var coreT = s.coreType ? (/asym/i.test(s.coreType) ? 'Asymmetrical' : /sym/i.test(s.coreType) ? 'Symmetrical' : s.coreType) : null;
  return {
    BoxFinish: s.finish || null,
    Coverstock: cc ? cc.charAt(0).toUpperCase() + cc.slice(1) : (s.coverType || null),
    CoverName: s.coverName || null, CoreType: coreT, CoreShort: s.coreName || null,
    RG: s.rg, Differential: s.diff, IntDiff: s.intDiff,
    DateReleased: s.released ? String(s.released).slice(0, 10) : null,
  };
}
function sheetHTML(e, rows) {
  var s = specsOf(_sheet.detail, _sheet.weight || 15);
  /* v30.167 (locked): your weight not published -> show the nearest published
     weight's RG/Diff, labelled. Display only; Add to Arsenal and Fill still use
     the ball's own weight, so a 15 lb ball never stores 16 lb numbers. */
  var _wt = _sheet.weight || 15, _shownW = _wt;
  if (s.rg == null && s.diff == null) {
    var _nw = nearestWeight(_sheet.detail, _wt);
    if (_nw != null) { var _s2 = specsOf(_sheet.detail, _nw); s.rg = _s2.rg; s.diff = _s2.diff; s.intDiff = _s2.intDiff; _shownW = _nw;
      s._wNote = ' <span style="font-size:10px;font-weight:700;color:var(--gold)">' + _nw + ' LB</span>'; }
  }
  var _gaps = _sheet.loaded ? specGaps(_sheet.detail) : null;
  var owned = ownedFor(e);
  var chips = '';
  if (e.y) chips += '<span style="' + CHIP_G + '">USBC APPROVED ' + esc(e.d ? (monthYear(e.d) || e.y).toUpperCase() : e.y) + '</span>';
  if (/-u13$/.test(e.i)) chips += '<span style="' + CHIP_G + '">UNDER 13 LB</span>';
  if (owned.length) chips += '<span style="' + CHIP_T + '">IN YOUR ARSENAL' + (owned.length > 1 ? ' ×' + owned.length : '') + '</span>';
  var body;
  if (!_sheet.loaded) body = '<div style="font-size:12px;color:var(--t3);padding:10px 0">Loading specs…</div>';
  else if (!hasAnySpec(s)) body = '<div style="font-size:13px;color:var(--t2);padding:6px 0 10px;line-height:1.55">Specs aren\'t in the catalog for this ball yet. You can add them after adding it.</div>';
  else {
    body = (_gaps && _gaps.length ? '<div style="font-size:12px;color:var(--gold);padding:2px 0 8px;line-height:1.45">Incomplete \u2014 missing ' + esc(_gaps.join(', ')) + '. Verify now on a linked ball re-reads the site.</div>' : '') +
      specRows(e, s).map(function (r) {
      return '<div style="display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--border1);font-size:14px">' +
        '<span style="color:var(--t2)">' + r[0] + '</span><span style="color:var(--t1);text-align:right">' + r[1] + '</span></div>';
    }).join('');
    var wt = _sheet.weight || 15;
    body += '<div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.5">RG and Diff shown for ' + _shownW + ' lb' +
      (_shownW !== wt ? ' \u2014 <b style="color:var(--gold)">' + wt + ' lb is not published</b>' : (s.weights.length && s.weights.indexOf(wt) < 0 ? ' (not published for this weight)' : '')) + '.' +
      (s.src ? ' Specs: ' + (/^https?:|^manufacturer$/.test(s.src) ? 'manufacturer' : esc(s.src)) + (s.checked ? ', checked ' + esc(s.checked) : '') + '.' : '') +
      (_sheet.detail && _sheet.detail._local ? ' <span style="color:var(--teal)">Includes your corrections (this device' + (_sheet.detail._local.source === 'bowwwl' ? ', from bowwwl' : '') + ').</span>' : '') + '</div>';
    var met = metricScore(ballFromSpecs(s), parseFinish(s.finish));
    if (met) body += '<div style="margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--bg3);font-size:13px;color:var(--t1)">' +
      'Strength <b>' + met.strength + '</b> · Shape <b>' + signed(met.shape) + '</b><span style="color:var(--t3);font-size:11px"> · factory finish' + (_shownW !== wt ? ', ' + _shownW + ' lb specs' : '') + '</span></div>';
  }
  var w = _sheet.weight;
  return '<div style="padding:12px 16px 4px;display:flex;justify-content:space-between;align-items:center"><button onclick="catSheetClose()" style="' + BACK + '" aria-label="Back">‹</button>' +
    '<button onclick="catCompareFromSheet()" style="' + BTN_G + 'padding:8px 14px;font-size:13px">Compare</button></div>' +   /* v30.171 MET-2 */
    '<div style="flex:1;overflow-y:auto;padding:0 16px 16px;-webkit-overflow-scrolling:touch">' +
      '<div style="display:flex;justify-content:center;margin:6px 0 12px">' + thumbHTML(e, 150) + '</div>' +
      '<div style="text-align:center;font-size:26px;font-weight:800;color:var(--t1)">' + esc(cleanName(e.n)) + '</div>' +
      '<div style="text-align:center;font-size:17px;color:var(--t2);margin-top:2px">' + esc(e.m) + '</div>' +
      '<div style="text-align:center;margin-top:8px">' + chips + '</div>' +
      '<div style="background:var(--bg2);border-radius:14px;padding:14px 16px;margin-top:16px">' +
        '<div style="font-size:18px;font-weight:700;color:var(--t1);margin-bottom:4px">Specifications</div>' + body + '</div>' +
    '</div>' +
    '<div style="padding:12px 16px;border-top:1px solid var(--border1);background:var(--bg1)">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
        '<span style="font-size:16px;font-weight:700;color:var(--t1)">Weight</span>' +
        '<span id="cat-sheet-wt" style="font-size:15px;font-weight:600;color:' + (w ? 'var(--t1)' : 'var(--red)') + '">' + (w ? w + ' lb' : 'Not set') + '</span></div>' +
      '<div style="display:flex;gap:6px;overflow-x:auto;margin-bottom:10px">' +
        WEIGHTS.map(function (x) {
          return '<button onclick="catSheetWeight(' + x + ')" style="' + (x === w ? BTN_P : BTN_G) + 'flex:1;min-width:38px;padding:8px 0;font-size:13px">' + x + '</button>';
        }).join('') + '</div>' +
      '<button id="cat-sheet-add" onclick="catAddToArsenal()" ' + (w ? '' : 'disabled ') +
        'style="width:100%;padding:13px;border-radius:12px;border:none;font-size:16px;font-weight:800;cursor:pointer;' +
        (w ? 'background:var(--teal);color:#001314' : 'background:var(--bg3);color:var(--t3)') + '">Add to Arsenal</button>' +
    '</div>';
}
function renderSheet() {
  var ov = document.getElementById('cat-sheet-ov');
  if (!ov) return;
  catLoad().then(function (rows) {
    var e = byIdIn(rows, _sheet.id);
    if (!e) return;
    var sc = ov.querySelector('[style*="overflow-y:auto"]'), top = sc ? sc.scrollTop : 0;
    ov.innerHTML = sheetHTML(e, rows);
    var sc2 = ov.querySelector('[style*="overflow-y:auto"]'); if (sc2) sc2.scrollTop = top;
  });
}
function catAddDetail(id) {
  if (typeof document === 'undefined') return;
  catLoad().then(function (rows) {
    var e = byIdIn(rows, id);
    if (!e) return;
    pushRecent(e.i);
    var old = document.getElementById('cat-sheet-ov'); if (old) old.parentNode.removeChild(old);
    _sheet = { id: e.i, weight: null, detail: null, loaded: false };
    document.body.appendChild(overlay('cat-sheet-ov', 910));
    renderSheet();
    catDetailRaw(e).then(function (raw) {
      if (_sheet.id !== e.i) return;
      /* shown with this device's corrections; Add to Arsenal stores only catalog values */
      _sheet.raw = raw; _sheet.detail = (raw || localOverrides()[e.i]) ? withLocalCorrection(e.i, raw) : raw; _sheet.loaded = true; renderSheet();
    });
  });
}
function catSheetClose() {
  var el = document.getElementById('cat-sheet-ov'); if (el) el.parentNode.removeChild(el);
  var q = document.getElementById('cat-add-q'); if (q) catAddSearch(q.value);   // refresh arsenal tags / recents
}
function catSheetWeight(w) { _sheet.weight = w; renderSheet(); }

/* ---------- ADD-3: Add to Arsenal ---------- */
var SPEC_FIELDS = ['BoxFinish', 'Coverstock', 'CoverName', 'CoreType', 'CoreShort', 'RG', 'Differential', 'IntDiff', 'DateReleased'];
/* Pure: the owned-ball record. Exposed for the harness. */
function buildOwnedBall(e, detail, weight, id) {
  var s = specsOf(detail, weight), spec = ballFromSpecs(s), src = {};
  SPEC_FIELDS.forEach(function (f) { if (spec[f] != null && spec[f] !== '') src[f] = 'catalog'; });
  return {
    BallID: id, ImagePath: null, CoreImagePath: null,
    BallName: cleanName(e.n), MFG: e.m, Weight: weight,
    HookRating: null, PerfectScaleVal: null,
    BoxFinish: spec.BoxFinish || '', Coverstock: spec.Coverstock || '', CoverName: spec.CoverName || '',
    CoreType: spec.CoreType || '', CoreShort: spec.CoreShort || '',
    RG: spec.RG, Differential: spec.Differential, IntDiff: spec.IntDiff,
    RGDiff: catRGBand(spec.RG, spec.Differential) || '', DateReleased: spec.DateReleased,      // never the USBC approval date
    SpecsURL: null, Active: true, CatalogID: e.i, SpecSource: src,
  };
}
function catAddToArsenal() {
  if (!_sheet.weight) { if (root.toast) root.toast('Choose a weight first'); return; }
  catLoad().then(function (rows) {
    var e = byIdIn(rows, _sheet.id);
    if (!e || typeof db === 'undefined' || !db || !Array.isArray(db.balls)) return;
    var dup = ownedFor(e);
    if (dup.length && !(root.confirm ? root.confirm('You already have ' + (dup.length > 1 ? dup.length + ' of these' : 'one') + '. Add another?') : true)) return;
    if (!db.ids) db.ids = {};
    /* never reuse an id: the counter is trusted only if it is past every existing BallID */
    var maxId = db.balls.reduce(function (m, b) { return Math.max(m, +b.BallID || 0); }, 0);
    if (!(db.ids.ball > maxId)) db.ids.ball = maxId + 1;
    var id = db.ids.ball++;
    var rec = buildOwnedBall(e, _sheet.raw !== undefined ? _sheet.raw : _sheet.detail, _sheet.weight, id);
    db.balls.push(rec);
    if (root.saveDB) root.saveDB();
    catCloseAddSearch();
    if (root.navToBall) root.navToBall(id);
    if (root.toast) root.toast('Added to your arsenal');
  });
}

/* ---------- Edit Ball: Fill from catalog / Apply updates (SRC-3, D6) ---------- */
var FIELD_INPUT = { BoxFinish: 'bef-finish', Coverstock: 'bef-cover', CoverName: 'bef-covername', CoreType: 'bef-coretype',
                    CoreShort: 'bef-corename', RG: 'bef-rg', Differential: 'bef-diff', IntDiff: 'bef-intdiff', DateReleased: 'bef-released' };
var _filled = {};     // field -> value written by Fill/Apply during this form session
function sameVal(a, b) {
  var e = function (v) { return v == null || v === ''; };
  if (e(a) && e(b)) return true;
  if (e(a) || e(b)) return false;
  var na = parseFloat(a), nb = parseFloat(b);
  if (isFinite(na) && isFinite(nb) && /^[\d.\s-]+$/.test(String(a)) && /^[\d.\s-]+$/.test(String(b))) return Math.abs(na - nb) < 1e-9;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
/* Pure: what Fill and Apply would do. owned = current form values, tags = SpecSource. */
function fillPlan(owned, tags, spec) {
  var fill = [], apply = [];
  SPEC_FIELDS.forEach(function (f) {
    var c = spec[f];
    if (c == null || c === '') return;
    var cur = owned[f];
    if (cur == null || cur === '') fill.push(f);
    /* DATA-2: untagged (unverified) values are offered too; 'user' never is */
    else if ((!tags || tags[f] !== 'user') && !sameVal(cur, c)) apply.push(f);
  });
  return { fill: fill, apply: apply };
}
function formValues() {
  var o = {};
  for (var f in FIELD_INPUT) { var el = document.getElementById(FIELD_INPUT[f]); o[f] = el ? el.value : null; }
  return o;
}
function renderFillRow() {
  var slot = document.getElementById('cat-fill-row');
  if (!slot || !_pick.id) { if (slot) slot.innerHTML = ''; return; }
  var want = _pick.id;
  catLoad().then(function (rows) {
    var e = byIdIn(rows, want);
    if (!e) return null;
    return catDetailRaw(e);
  }).then(function (d) {
    if (_pick.id !== want || !document.getElementById('cat-fill-row')) return;
    var wEl = document.getElementById('bef-wt');
    var wt = (wEl && parseInt(wEl.value, 10)) || 15;
    var s = specsOf(d, wt);
    if (!hasAnySpec(s)) { slot.innerHTML = ''; return; }
    var plan = fillPlan(formValues(), (_pick.ball && _pick.ball.SpecSource) || {}, ballFromSpecs(s));
    var h = '';
    if (plan.fill.length) h += '<button style="' + BTN_P + '" onclick="catFillFromCatalog(\'fill\')">Fill from catalog (' + plan.fill.length + ')</button> ';
    if (plan.apply.length) h += '<button style="' + BTN_G + '" onclick="catFillFromCatalog(\'apply\')">Catalog has updated specs → Apply (' + plan.apply.length + ')</button>';
    slot.innerHTML = h ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' + h + '</div>' : '';
  }).catch(function () {});
}
function catFillFromCatalog(mode) {
  catLoad().then(function (rows) { return catDetailRaw(byIdIn(rows, _pick.id)); }).then(function (d) {
    var wEl = document.getElementById('bef-wt');
    var s = specsOf(d, (wEl && parseInt(wEl.value, 10)) || 15), spec = ballFromSpecs(s);
    var plan = fillPlan(formValues(), (_pick.ball && _pick.ball.SpecSource) || {}, spec);
    var list = mode === 'apply' ? plan.apply : plan.fill;
    if (mode === 'apply' && list.length && root.confirm && !root.confirm('Replace ' + list.length + ' value(s) with the catalog\'s current specs? Values you entered yourself are never replaced.')) return;
    list.forEach(function (f) {
      var el = document.getElementById(FIELD_INPUT[f]);
      if (!el) return;
      el.value = spec[f]; _filled[f] = spec[f];
    });
    if (root.toast) root.toast(list.length + ' field' + (list.length === 1 ? '' : 's') + ' filled from catalog. Save to keep.');
    renderFillRow();
  });
}
/* Called by _bdetSave. Tiers only move up: a value the user changes becomes 'user';
   one written by Fill/Apply and saved unchanged is 'catalog'; untouched keeps its tag. */
function catSpecSource(oldBall, fields) {
  var live = typeof document !== 'undefined' && !!document.getElementById('cat-pick-group');
  var filled = live ? _filled : {};
  var src = {}, k;
  var prev = (oldBall && oldBall.SpecSource) || {};
  for (k in prev) src[k] = prev[k];
  SPEC_FIELDS.forEach(function (f) {
    if (!(f in fields)) return;
    var nv = fields[f], empty = nv == null || nv === '';
    if (f in filled && sameVal(nv, filled[f])) { src[f] = 'catalog'; return; }
    if (!oldBall) { if (!empty) src[f] = 'user'; return; }
    if (!sameVal(oldBall[f], nv)) { if (empty) delete src[f]; else src[f] = 'user'; }
  });
  return src;
}


/* ---------- APP-1: in-app spec approvals (design rev 7, sec 15) ----------
   Pages through the open "Spec approvals" issue one USBC ball at a time.
   Tapping a source ticks its box in the SAME issue through the GitHub API,
   so D8, the R1-R4 auto rules and specs-publish are unchanged; the app is a
   front end to the checklist, not a second approval store.

   Box line format (bridge/approvals.js render):
     - [ ] **Title** -> `catalogId` . RG x / Diff y @15 lb . [source](url) <!--a:url|catalogId-->
   under "### <source> -- <reason label> (n)" headings.

   Token: fine-grained, this repo only (Issues read/write; Actions read/write
   for Publish). Kept in localStorage 'bdbgh_token' -- outside the bowlingdb_
   prefix, so snapshots never include it. Ticks made offline queue in
   'bdbgh_ap_queue' and are sent when the app is next online. */
var AP_REPO = 'jmarsh85/bowlingdb-mobile';
var AP_API = 'https://api.github.com/repos/' + AP_REPO;
var AP_TOKEN_KEY = 'bdbgh_token', AP_QUEUE_KEY = 'bdbgh_ap_queue', AP_CACHE_KEY = 'bdbgh_ap_cache';
var AP_LINE = /^(\s*-\s*\[)([ xX])(\]\s*\*\*(.*?)\*\*\s*\S+\s*`([^`]+)`\s*·\s*(.*?)(?:\s*·\s*\[source\]\(([^)]*)\))?\s*<!--a:([^>]*?)-->)\s*$/;

/* Pure: issue body -> boxes, in issue order. */
function apParseIssue(body) {
  var out = [], src = '', label = '';
  String(body || '').split('\n').forEach(function (line) {
    var h = /^###\s+(.*?)\s+—\s+(.*?)\s+\(\d+\)\s*$/.exec(line);
    if (h) { src = h[1]; label = h[2]; return; }
    var m = AP_LINE.exec(line);
    if (!m) return;
    out.push({ tok: m[8], ticked: m[2] !== ' ', title: m[4], catalogId: m[5], specs: m[6], url: m[7] || null, source: src, reason: label });
  });
  return out;
}
/* Pure: boxes -> pages, one per USBC ball, first-seen order. */
function apPages(boxes) {
  var by = {}, order = [];
  boxes.forEach(function (b) {
    if (!by[b.catalogId]) { by[b.catalogId] = []; order.push(b.catalogId); }
    by[b.catalogId].push(b);
  });
  return order.map(function (id) { return { catalogId: id, boxes: by[id] }; });
}
/* Pure: apply {tok: true|false} to the body. Lines are found by their hidden
   token, so a body re-rendered by specs-extract in between still matches. */
function apApplyTicks(body, changes) {
  return String(body || '').split('\n').map(function (line) {
    var m = AP_LINE.exec(line);
    if (!m || !(m[8] in changes)) return line;
    return m[1] + (changes[m[8]] ? 'x' : ' ') + m[3];
  }).join('\n');
}
/* Pure: numbers from "RG 2.49 / Diff 0.050 / Int 0.016 @15 lb" */
function apNums(specs) {
  var g = function (k) { var m = new RegExp(k + '\\s+([0-9.]+)').exec(specs || ''); return m ? +m[1] : null; };
  return { rg: g('RG'), diff: g('Diff'), int: g('Int') };
}
/* Pure: ticked boxes on one ball that disagree publish nothing (D8). R3 tolerance. */
function apConflict(boxes) {
  var t = boxes.filter(function (b) { return b.ticked; }).map(function (b) { return apNums(b.specs); });
  for (var i = 1; i < t.length; i++) {
    var a = t[0], b = t[i];
    var off = function (x, y, tol) { return x != null && y != null && Math.abs(x - y) > tol + 1e-9; };
    if (off(a.rg, b.rg, 0.002) || off(a.diff, b.diff, 0.001) || off(a.int, b.int, 0.001)) return true;
  }
  return false;
}

var _ap = { body: null, issue: null, pages: [], idx: 0, uncheckedOnly: true, busy: false, err: null, fromCache: false };
function apLS() { try { return env.ls(); } catch (e) { return null; } }
function apToken() { var l = apLS(); return l ? (l.getItem(AP_TOKEN_KEY) || '') : ''; }
function apQueue() { var l = apLS(); try { return JSON.parse((l && l.getItem(AP_QUEUE_KEY)) || '{}'); } catch (e) { return {}; } }
function apSetQueue(q) { var l = apLS(); if (l) l.setItem(AP_QUEUE_KEY, JSON.stringify(q)); }
function apGH(path, opt) {
  opt = opt || {};
  var h = { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + apToken(), 'X-GitHub-Api-Version': '2022-11-28' };
  if (opt.body) h['Content-Type'] = 'application/json';
  return env.fetch(AP_API + path, { method: opt.method || 'GET', headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined, cache: 'no-store' })
    .then(function (r) {
      if (r.status === 204) return null;
      if (!r.ok) return r.text().then(function (t) { var e = new Error('GitHub ' + r.status); e.status = r.status; e.detail = t; throw e; });
      return r.json();
    });
}
function apFetchIssue() {
  return apGH('/issues?labels=spec-approvals&state=open&per_page=1').then(function (list) {
    var is = list && list[0];
    if (!is) throw new Error('No open "Spec approvals" issue. Run specs-extract first.');
    var l = apLS(); if (l) l.setItem(AP_CACHE_KEY, JSON.stringify({ number: is.number, body: is.body, at: Date.now() }));
    return { number: is.number, body: is.body || '' };
  });
}
/* Sends queued ticks: re-reads the issue first, applies, writes back. */
function apFlush() {
  var q = apQueue();
  if (!Object.keys(q).length || !apToken()) return Promise.resolve(0);
  if (root.navigator && root.navigator.onLine === false) return Promise.resolve(0);
  return apFetchIssue().then(function (is) {
    var nb = apApplyTicks(is.body, q);
    var n = Object.keys(q).length;
    if (nb === is.body) { apSetQueue({}); return n; }
    return apGH('/issues/' + is.number, { method: 'PATCH', body: { body: nb } }).then(function () {
      var l = apLS(); if (l) l.setItem(AP_CACHE_KEY, JSON.stringify({ number: is.number, body: nb, at: Date.now() }));
      apSetQueue({});
      return n;
    });
  });
}
function apLoad() {
  _ap.busy = true; _ap.err = null; apRender();
  return apFlush().catch(function () {}).then(apFetchIssue).then(function (is) {
    _ap.issue = is.number; _ap.body = is.body; _ap.fromCache = false;
    apExtractStatus().then(function (run) { _ap.run = run; if (run) apRender(); });
    /* v30.172: a failed staging read used to be swallowed, leaving every card on the
       one-line summary with "Full specs load..." forever. Keep the reason and show it. */
    _ap.stagedErr = null;
    apReadStaged().then(function () { _ap.stagedErr = null; apRender(); }, function (e) { _ap.stagedErr = apStagedErrText(e); apRender(); });
    apReadOverrides().then(function () { apRender(); }).catch(function () {});
  }).catch(function (e) {
    var l = apLS(), c = null; try { c = JSON.parse((l && l.getItem(AP_CACHE_KEY)) || 'null'); } catch (x) {}
    if (c) { _ap.issue = c.number; _ap.body = c.body; _ap.fromCache = true; }
    _ap.err = e.status === 401 ? 'GitHub rejected the token (401). Check it or make a new one.'
      : e.status === 403 || e.status === 404 ? 'The token cannot read this repo\'s issues (' + e.status + '). Check its repo and Issues permission.'
      : (e.message || String(e));
  }).then(function () {
    if (_ap.focus) _ap.uncheckedOnly = false;
    apBuildPages(true);
    if (_ap.focus) { var fi = _ap.pages.map(function (p) { return p.catalogId; }).indexOf(_ap.focus); if (fi >= 0) _ap.idx = fi; _ap.focus = null; }
    _ap.busy = false; apRender();
  });
}
/* Merges queued ticks into the view so offline taps show immediately. */
function apBuildPages(reset) {
  var q = apQueue();
  var boxes = apParseIssue(_ap.body).map(function (b) { if (b.tok in q) b.ticked = !!q[b.tok]; return b; });
  var all = apPages(boxes);
  _ap.allCount = all.length;
  _ap.doneCount = all.filter(function (p) { return p.boxes.some(function (b) { return b.ticked; }); }).length;
  var keep = _ap.pages[_ap.idx] && _ap.pages[_ap.idx].catalogId;
  _ap.pages = _ap.uncheckedOnly && reset ? all.filter(function (p) { return !p.boxes.some(function (b) { return b.ticked; }); }) : (reset ? all : _ap.pages.map(function (p) {
    return all.filter(function (x) { return x.catalogId === p.catalogId; })[0] || p;
  }));
  if (reset) _ap.idx = 0;
  else if (keep) { var i = _ap.pages.map(function (p) { return p.catalogId; }).indexOf(keep); if (i >= 0) _ap.idx = i; }
}

/* ---------- UI ---------- */
function catApprovalsOpen() {
  if (typeof document === 'undefined') return;
  /* v30.166: Settings is a modal (.modal-bg, z-index 1010) and this screen is
     905, so opening from Settings drew it BEHIND the sheet -- the tap looked
     like it did nothing. Close the modal first. */
  var mb = document.getElementById('modal-bg');
  if (mb && mb.classList.contains('open') && typeof root.closeModal === 'function') root.closeModal();
  catApprovalsClose();
  document.body.appendChild(overlay('ap-ov', 905));
  _ap.idx = 0; _ap.pages = []; _ap.body = null;
  if (!apToken()) { apRender(); return; }
  apLoad();
}
function catApprovalsClose() { var el = document.getElementById('ap-ov'); if (el) el.parentNode.removeChild(el); }
function apHeader(sub) {
  return '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px">' +
    '<button style="' + BACK + '" onclick="catApprovalsClose()">‹</button>' +
    '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Spec approvals</div>' +
    '<div style="font-size:11px;color:var(--t3)">' + sub + '</div></div></div>';
}
function apTokenHTML() {
  return apHeader('Connect to GitHub') +
    '<div style="padding:8px 16px;overflow-y:auto;flex:1;font-size:13px;color:var(--t2);line-height:1.55">' +
    '<p style="margin:0 0 10px">The app ticks boxes in your <b>Spec approvals</b> issue, so it needs a GitHub token for this one repo.</p>' +
    '<p style="margin:0 0 10px">GitHub → Settings → Developer settings → Fine-grained tokens → Generate. Repository: <b>bowlingdb-mobile</b> only. Permissions: <b>Issues</b> read and write; <b>Actions</b> read and write (for Publish).</p>' +
    '<p style="margin:0 0 12px;color:var(--t3);font-size:12px">Stored on this device only and never included in backups.</p>' +
    '<input id="ap-token" class="bdet-field-input" type="password" autocomplete="off" placeholder="github_pat_…" style="width:100%;box-sizing:border-box">' +
    '<button style="' + BTN_P + 'width:100%;margin-top:10px;padding:11px" onclick="catApprovalsSaveToken()">Save and load</button>' +
    '</div>';
}
function catApprovalsSaveToken() {
  var el = document.getElementById('ap-token'); var v = el ? el.value.trim() : '';
  if (!v) return;
  var l = apLS(); if (l) l.setItem(AP_TOKEN_KEY, v);
  apLoad();
}
function catApprovalsChangeToken() {
  if (root.confirm && !root.confirm('Remove the GitHub token from this device? You can paste a new one next.')) return;
  catApprovalsForgetToken();
}
function catApprovalsForgetToken() {
  var l = apLS(); if (l) { l.removeItem(AP_TOKEN_KEY); l.removeItem(AP_CACHE_KEY); }
  _ap.body = null; _ap.pages = []; apRender();
}
function apRender() {
  var ov = document.getElementById('ap-ov');
  if (!ov) return;
  if (!apToken()) { ov.innerHTML = apTokenHTML(); return; }
  if (_ap.busy && _ap.body == null) { ov.innerHTML = apHeader('Loading…') + '<div style="padding:30px;text-align:center;color:var(--t3);font-size:13px">Reading the approvals issue…</div>'; return; }
  var qn = Object.keys(apQueue()).length;
  var status = (_ap.err ? '<div style="font-size:12px;color:var(--red);margin:0 16px 8px;line-height:1.45">' + esc(_ap.err) + '</div>' : '') +
    (_ap.fromCache ? '<div style="font-size:11px;color:var(--gold);margin:0 16px 6px">Offline copy. Ticks are saved and sent when you are back online.</div>' : '');
  var p = _ap.pages[_ap.idx];
  var sub = _ap.body == null ? '' : (_ap.doneCount + ' of ' + _ap.allCount + ' balls approved' + (qn ? ' · ' + qn + ' waiting to send' : ''));
  if (_ap.run) status += '<div style="font-size:11px;color:var(--t3);margin:0 16px 6px">Last extract: ' + esc(_ap.run.status === 'completed' ? (_ap.run.conclusion === 'success' ? 'finished' : (_ap.run.conclusion || 'finished')) : _ap.run.status === 'in_progress' ? 'running' : _ap.run.status) +
    ' · ' + esc(String(_ap.run.at || '').slice(0, 16).replace('T', ' ')) + ' UTC</div>';
  var filt = '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--t2);margin:0 16px 8px">' +
    '<input type="checkbox" ' + (_ap.uncheckedOnly ? 'checked ' : '') + 'onchange="catApprovalsFilter(this.checked)"> Only balls with nothing approved</label>';
  if (!p) {
    ov.innerHTML = apHeader(sub) + status + filt + '<div style="padding:30px 16px;text-align:center;color:var(--t2);font-size:13px;line-height:1.6">' +
      (_ap.body == null ? 'Nothing loaded.' : 'Nothing left to review here.') + '</div>' + apFooter(false);
    return;
  }
  var head = '<div id="ap-entry" style="font-size:15px;font-weight:700;color:var(--t1);margin-bottom:2px">' + esc(p.boxes[0].title) + '</div>' +
    '<div style="font-size:11px;color:var(--t3);margin-bottom:4px">USBC ' + esc(p.catalogId) + '</div>';
  var mine = appBalls().filter(function (b) { return b.CatalogID === p.catalogId; });
  var mineH = mine.length ? '<div style="font-size:12px;color:var(--t2);margin:6px 0 4px;padding:8px;border-radius:9px;background:var(--bg3)">Your ball: RG ' +
    esc(mine[0].RG != null ? mine[0].RG : '–') + ' / Diff ' + esc(mine[0].Differential != null ? mine[0].Differential : '–') + ' @' + esc(mine[0].Weight || '?') + ' lb</div>' : '';
  var cards = p.boxes.map(function (b, i) {
    var on = b.ticked;
    return '<div onclick="catApprovalsTick(' + i + ')" style="cursor:pointer;margin-top:8px;padding:11px 12px;border-radius:12px;border:1px solid ' +
      (on ? 'var(--teal)' : 'var(--border1)') + ';background:' + (on ? 'rgba(0,217,217,0.08)' : 'var(--bg2)') + '">' +
      '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center">' +
      '<span style="font-size:12px;font-weight:700;color:var(--t2)">' + esc(b.source) + '</span>' +
      '<span style="font-size:12px;font-weight:800;color:' + (on ? 'var(--teal)' : 'var(--t3)') + '">' + (on ? '✓ Approved' : 'Tap to approve') + '</span></div>' +
      '<div style="font-size:11px;color:var(--t3);line-height:1.45;margin-top:3px">' + esc(b.reason) + '</div>' +
      /* v30.168: the full staged record, close to the maker's spec sheet */
      (_staged ? apSheetHTML(apApplyOverride(apStagedFor(_staged, b, p.catalogId), overrideFor(p.catalogId))) : '<div style="font-size:16px;font-weight:800;color:var(--t1);margin:5px 0 3px">' + esc(b.specs) + '</div>' + apSheetHTML(null)) +
      '<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:6px">' +
      (b.url ? '<a href="' + esc(b.url) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="font-size:12px;color:var(--teal)">Open source page ↗</a>' : '') +
      '<a href="#" onclick="event.preventDefault();event.stopPropagation();catApprovalsEdit(' + i + ')" style="font-size:12px;color:var(--teal);font-weight:700">Correct / fill gaps</a>' +
      '</div></div>';
  }).join('');
  var _vb = (function () { var r = _ap._rows, e = r ? byIdIn(r, p.catalogId) : null; return e ? e.m : null; })();
  /* bowwwl.com cross-check: a link only (personal-use reading); the app never fetches it */
  var _ve = _ap._rows ? byIdIn(_ap._rows, p.catalogId) : null;
  var _bl = bowwwlLinks(_ve ? _ve.m : (_vb || ''), _ve ? cleanName(_ve.n) : p.boxes[0].title);
  var crossCheck = '<div style="margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--bg3);font-size:12px;color:var(--t2);line-height:1.5">' +
    'Second opinion: <a href="' + esc(_bl.page) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal)">bowwwl page ↗</a> · ' +
    '<a href="' + esc(_bl.search) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal)">search ↗</a>' +
    '<div style="font-size:11px;color:var(--t3)">For your own check only. If you use a value from it, choose bowwwl as the correction source.</div></div>';
  var verifyBtn = sourceForBrand(_vb) ? vfySlotHTML(p.catalogId, '<button style="' + BTN_G + 'margin-top:12px;width:100%;padding:10px" onclick="catVerifyNow(\'' + esc(_vb) + '\',\'' + esc(p.catalogId) + '\')">Verify now: re-read the ' + esc(sourceForBrand(_vb)) + ' site</button>') : '';
  var warn = apConflict(p.boxes) ? '<div style="font-size:12px;color:var(--gold);margin-top:10px;line-height:1.45">These approvals disagree, so neither will publish. Keep one.</div>' : '';
  ov.innerHTML = apHeader(sub) + status + filt +
    '<div style="flex:1;overflow-y:auto;padding:4px 16px 12px">' + head + mineH + cards + warn + crossCheck + verifyBtn + '</div>' + apFooter(true);
  catLoad().then(function (rows) {
    var first = !_ap._rows; _ap._rows = rows;
    var e = byIdIn(rows, p.catalogId), el = document.getElementById('ap-entry');
    if (e && el && _ap.pages[_ap.idx] === p) el.innerHTML = entryLine(e);
    if (first && _ap.pages[_ap.idx] === p) apRender();   // once, so Verify now knows the brand
  });
}
function apFooter(paging) {
  var n = _ap.pages.length, qn = Object.keys(apQueue()).length;
  return '<div style="padding:10px 16px;border-top:1px solid var(--border1);display:flex;flex-direction:column;gap:8px">' +
    (paging ? '<div style="display:flex;gap:8px;align-items:center">' +
      '<button style="' + BTN_G + 'flex:1;padding:11px" ' + (_ap.idx > 0 ? '' : 'disabled ') + 'onclick="catApprovalsPage(-1)">‹ Prev</button>' +
      '<span style="font-size:12px;color:var(--t2);min-width:70px;text-align:center">' + (_ap.idx + 1) + ' of ' + n + '</span>' +
      '<button style="' + BTN_G + 'flex:1;padding:11px" ' + (_ap.idx < n - 1 ? '' : 'disabled ') + 'onclick="catApprovalsPage(1)">Next ›</button></div>' : '') +
    '<div style="display:flex;gap:8px">' +
      (qn ? '<button style="' + BTN_P + 'flex:1;padding:10px" onclick="catApprovalsSend()">Send ' + qn + ' now</button>' : '') +
      '<button style="' + BTN_P + 'flex:1;padding:10px" onclick="catApprovalsPublish()">Publish approvals</button>' +
      '<button style="' + BTN_G + 'padding:10px" onclick="catApprovalsChangeToken()">Change token</button></div></div>';
}
function catApprovalsPage(d) {
  _ap.idx = Math.max(0, Math.min(_ap.pages.length - 1, _ap.idx + d));
  apRender();
  var sc = document.querySelector('#ap-ov [style*="overflow-y:auto"]'); if (sc) sc.scrollTop = 0;
}
function catApprovalsFilter(on) { _ap.uncheckedOnly = !!on; apBuildPages(true); apRender(); }
var _apSendTimer = null;
function catApprovalsTick(i) {
  var p = _ap.pages[_ap.idx]; if (!p) return;
  var b = p.boxes[i]; if (!b) return;
  var q = apQueue(); q[b.tok] = !b.ticked; apSetQueue(q);
  if (root.haptic) try { root.haptic('light'); } catch (e) {}
  apBuildPages(false); apRender();
  /* v30.172: a running Verify chain waiting on this ball moves on at once */
  var _vs = vfyActive(); if (_vs && _vs.step === 'approve' && _vs.catalogId === p.catalogId) setTimeout(vfyTick, 300);
  clearTimeout(_apSendTimer);
  _apSendTimer = setTimeout(function () { catApprovalsSend(true); }, 1500);
}
function catApprovalsSend(quiet) {
  return apFlush().then(function (n) {
    if (n && !quiet && root.toast) root.toast(n + ' approval change' + (n === 1 ? '' : 's') + ' sent');
    if (n) { _ap.err = null; _ap.fromCache = false; var l = apLS(); try { var c = JSON.parse(l.getItem(AP_CACHE_KEY)); if (c) _ap.body = c.body; } catch (e) {} }
    apBuildPages(false); apRender();
  }).catch(function (e) {
    _ap.err = 'Not sent yet (' + (e.status ? 'GitHub ' + e.status : 'offline') + '). Saved on this device; it will retry.';
    apRender();
  });
}
/* Runs the specs-publish workflow on the repo's default branch. */
function catApprovalsPublish() {
  var go = function () {
    return vfyDispatchPublish().then(function () {
      if (root.toast) root.toast('specs-publish started. The catalog updates when it finishes (a few minutes).');
    }).catch(function (e) {
      if (root.toast) root.toast(e.status === 403 || e.status === 404 ? 'Token needs Actions read and write to publish' : ('Publish failed: ' + (e.status ? 'GitHub ' + e.status : 'offline')));
    });
  };
  var q = Object.keys(apQueue()).length;
  return (q ? apFlush() : Promise.resolve(0)).then(go, go);
}
if (typeof root.addEventListener === 'function') root.addEventListener('online', function () { apFlush().catch(function () {}); });

/* ---------- IMG-1: manufacturer images on this device (design rev 7, sec 15) ----------
   The bridge already records each page's image link (staging `imageUrl`,
   never published to the catalog). With the toggle on, this device reads
   those links from staging/specs_staging.json on the `specs` branch (GitHub
   API, the APP-1 token) and shows the image straight from the
   manufacturer's site; sw.js keeps a copy for offline. Nothing is copied
   into the repo or the catalog, and other users never see these images.
   Links and the toggle live under the bdbimg_ prefix, outside backups. */
var IMG_ON_KEY = 'bdbimg_on', IMG_LINKS_KEY = 'bdbimg_links';
var _imgMap = null;
function imgOn() { var l = apLS(); return !!(l && l.getItem(IMG_ON_KEY) === '1'); }
function imgMap() {
  if (_imgMap) return _imgMap;
  var l = apLS(); try { var o = JSON.parse((l && l.getItem(IMG_LINKS_KEY)) || 'null'); _imgMap = (o && o.map) || {}; } catch (e) { _imgMap = {}; }
  return _imgMap;
}
/* Pure: staged rows -> {catalogId: imageUrl}. Only a row that names ONE USBC
   ball counts (catalogId, or a single candidate): a colourway family page's
   image shows a different colour, so it is not used for its siblings.
   Published-tier rows (auto) win over pending ones. */
function imgLinksFrom(staged) {
  var out = {}, rank = {};
  var tier = function (d) { return d === 'auto' || d === 'approved' ? 2 : d === 'pending' ? 1 : 0; };
  (staged || []).forEach(function (r) {
    var u = r && r.imageUrl; if (!u) return;
    u = String(u); if (u.indexOf('//') === 0) u = 'https:' + u;
    if (!/^https:\/\//.test(u)) return;
    var ids = r.catalogId ? [r.catalogId] : ((r.candidates || []).length === 1 ? r.candidates : []);
    var t = tier(r.decision);
    ids.forEach(function (id) { if (!(id in rank) || t > rank[id]) { out[id] = u; rank[id] = t; } });
  });
  return out;
}
/* The full staged records (every field and weight the bridge read), read once
   per session with the APP-1 token. Shared by IMG-1 and the approval cards. */
var _staged = null, _stagedP = null;
function apReadStaged(force) {
  if (_staged && !force) return Promise.resolve(_staged);
  if (_stagedP && !force) return _stagedP;
  if (!apToken()) return Promise.reject(new Error('Add the GitHub token in Spec approvals first'));
  var h = { 'Accept': 'application/vnd.github.raw+json', 'Authorization': 'Bearer ' + apToken(), 'X-GitHub-Api-Version': '2022-11-28' };
  _stagedP = env.fetch(AP_API + '/contents/staging/specs_staging.json?ref=specs', { headers: h, cache: 'no-store' }).then(function (r) {
    if (!r.ok) { var e = new Error('GitHub ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }).then(function (rows) { _staged = rows || []; _stagedP = null; return _staged; }, function (e) { _stagedP = null; throw e; });
  return _stagedP;
}
/* Pure: the staged record behind one checklist box (same page, same USBC ball). */
function apStagedFor(staged, box, catalogId) {
  var hit = null;
  (staged || []).forEach(function (r) {
    if (hit) return;
    var sameBall = r.catalogId === catalogId || (r.candidates || []).indexOf(catalogId) >= 0;
    var samePage = box.url ? r.url === box.url : (!r.url && r.title === box.title);
    if (sameBall && samePage) hit = r;
  });
  return hit;
}
/* Pure: staged record -> catalog-detail shape, so specGaps() judges it the same way. */
function apAsDetail(r) {
  var sp = (r && r.specs) || {}, sbw = {};
  Object.keys(sp.weights || {}).forEach(function (w) { var x = sp.weights[w] || {}; sbw[w] = { RG: x.RG, Diff: x.Diff, IntDiff: x.IntDiff }; });
  return { Cover: { Name: sp.coverName || null, Type: sp.coverType || null, Finish: sp.finish || null },
           Core: { Name: sp.core || null, Type: sp.coreType || null }, DateReleased: sp.released || null, SpecsByWeight: sbw };
}
/* Pure: "out-of-range:15:Diff=0.54" -> readable notes (the value itself was dropped by the bridge). */
function apRangeNotes(flags) {
  return (flags || []).map(function (f) {
    var m = /^out-of-range:(\d+):(\w+)=(.+)$/.exec(f);
    return m ? (m[2] === 'IntDiff' ? 'Int Diff' : m[2]) + ' ' + m[1] + ' lb read as ' + m[3] + ' \u2014 outside the allowed range, dropped' : null;
  }).filter(Boolean);
}
/* Pure: why the staging file did not load, in plain words. */
function apStagedErrText(e) {
  var st = e && e.status;
  if (st === 401) return 'Full specs did not load: GitHub rejected the token (401).';
  if (st === 403) return 'Full specs did not load: the token cannot read repo files (403). Give it Contents: Read-only.';
  if (st === 404) return 'Full specs did not load: no staging file on the specs branch (404), or the token lacks Contents: Read-only. Run specs-extract, or check the token.';
  if (root.navigator && root.navigator.onLine === false) return 'Full specs did not load: you are offline.';
  return 'Full specs did not load: ' + ((e && e.message) || String(e));
}
function catApprovalsRetryStaged() {
  _ap.stagedErr = null; apRender();
  return apReadStaged(true).then(function () { apRender(); }, function (e) { _ap.stagedErr = apStagedErrText(e); apRender(); });
}
function apSheetHTML(r) {
  if (!r && _ap.stagedErr) return '<div style="font-size:11px;color:var(--red);margin-top:6px;line-height:1.45">' + esc(_ap.stagedErr) +
    ' <span onclick="event.stopPropagation();catApprovalsRetryStaged()" style="color:var(--teal);font-weight:700;cursor:pointer;white-space:nowrap">Retry</span></div>';
  if (!r && _staged) return '<div style="font-size:11px;color:var(--t3);margin-top:6px">Not in the current staging file (a newer extract may have replaced it).</div>';
  if (!r) return '<div style="font-size:11px;color:var(--t3);margin-top:6px">Full specs load with the staging file\u2026</div>';
  var d = apAsDetail(r), sp = r.specs || {}, gaps = specGaps(d) || [];
  var ed = r._edited || {}, edw = ed.weights || {};
  var tag = '<span style="font-size:9px;font-weight:800;color:var(--teal);margin-left:4px">EDITED</span>';
  var dash = '<span style="color:var(--gold)">missing</span>';
  var row = function (k, v) { return '<div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid var(--border1);font-size:12px">' +
    '<span style="color:var(--t3)">' + k + '</span><span style="color:var(--t1);text-align:right">' + v + '</span></div>'; };
  var dct = derivedCoverType(sp.coverName);
  var h = '<div style="margin-top:8px">' +
    row('Coverstock', sp.coverName ? esc(sp.coverName) + (ed.coverName ? tag : '') : dash) +
    row('Cover type', sp.coverType ? esc(sp.coverType) + (ed.coverType ? tag : '') : (dct ? esc(dct) + ' <span style="font-size:10px;color:var(--t3)">from name</span>' : dash)) +
    row('Factory finish', sp.finish ? esc(sp.finish) + (ed.finish ? tag : '') : dash) +
    row('Core', sp.core ? esc(sp.core) + (ed.core ? tag : '') : dash) +
    row('Core type', sp.coreType ? esc(sp.coreType) + (ed.coreType ? tag : '') : dash) +
    row('Release date', sp.released ? esc(String(sp.released).slice(0, 10)) + (ed.released ? tag : '') : '<span style="color:var(--t3)">\u2014</span>');
  var ws = Object.keys(sp.weights || {}).map(Number).filter(isFinite).sort(function (a, b) { return b - a; });
  var f3 = function (v) { return v != null ? Number(v).toFixed(3) : '<span style="color:var(--gold)">\u2013</span>'; };
  h += '<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:12px"><tr style="color:var(--t3)"><td>Weight</td><td style="text-align:right">RG</td><td style="text-align:right">Diff</td><td style="text-align:right">Int</td></tr>' +
    (ws.length ? ws.map(function (w) { var x = sp.weights[w] || {};
      var e = edw[w] || {}, mk = function (k) { return f3(x[k]) + (e[k] != null ? '<span style="color:var(--teal)">*</span>' : ''); };
      return '<tr><td style="color:var(--t2)">' + w + ' lb</td><td style="text-align:right">' + mk('RG') + '</td><td style="text-align:right">' + mk('Diff') + '</td><td style="text-align:right">' + mk('IntDiff') + '</td></tr>'; }).join('')
      : '<tr><td colspan="4" style="color:var(--gold)">No weights read</td></tr>') + '</table>';
  if (ws.length && ws.indexOf(15) < 0) h += '<div style="font-size:11px;color:var(--gold);margin-top:4px">15 lb not on this page</div>';
  /* a range failure that has since been corrected is shown as resolved */
  var rn = apRangeNotes((r.flags || []).filter(function (f) { var m = /^out-of-range:(\d+):(\w+)=/.exec(f); return !(m && edw[m[1]] && edw[m[1]][m[2]] != null); }));
  if (Object.keys(edw).length || Object.keys(ed).some(function (k) { return ['coverName','coverType','finish','core','coreType','released'].indexOf(k) >= 0; }))
    h += '<div style="font-size:11px;color:var(--teal);margin-top:6px">* corrected by you \u00b7 source: ' + esc(ed.source === 'bowwwl' ? 'bowwwl.com (personal use)' : ed.source === 'other' ? 'other' : 'maker sheet') + (ed.note ? ' \u00b7 ' + esc(ed.note) : '') + '</div>';
  if (rn.length) h += '<div style="font-size:11px;color:var(--red);margin-top:6px;line-height:1.45">' + rn.map(esc).join('<br>') + '</div>';
  var sc = r.mfgScales || {}, scs = Object.keys(sc).map(function (k) { return esc(k.replace(/([A-Z])/g, ' $1').toLowerCase()) + ' ' + esc(sc[k]); });
  if (scs.length) h += '<div style="font-size:11px;color:var(--t3);margin-top:6px">Maker scale: ' + scs.join(' \u00b7 ') + '</div>';
  h += '<div style="font-size:12px;font-weight:700;margin-top:8px;color:' + (gaps.length ? 'var(--gold)' : 'var(--teal)') + '">' +
    (gaps.length ? 'Missing: ' + esc(gaps.join(', ')) : '\u2713 Complete') + '</div></div>';
  return h;
}
function catImagesRefresh() {
  return apReadStaged(true).then(function (staged) {
    var map = imgLinksFrom(staged);
    var l = apLS(); if (l) l.setItem(IMG_LINKS_KEY, JSON.stringify({ at: Date.now(), map: map }));
    _imgMap = map;
    return Object.keys(map).length;
  });
}
function catImagesSet(on) {
  var l = apLS(); if (!l) return Promise.resolve(0);
  if (!on) { l.setItem(IMG_ON_KEY, '0'); return Promise.resolve(0); }
  /* No token yet: take the bowler to the token screen instead of failing quietly. */
  if (!apToken() && !Object.keys(imgMap()).length) {
    catApprovalsOpen();
    return Promise.reject(new Error('Add your GitHub token here first, then turn images on'));
  }
  l.setItem(IMG_ON_KEY, '1');
  return Object.keys(imgMap()).length ? Promise.resolve(Object.keys(imgMap()).length) : catImagesRefresh();
}
function catImagesStatus() {
  var l = apLS(), at = null; try { at = (JSON.parse(l.getItem(IMG_LINKS_KEY)) || {}).at || null; } catch (e) {}
  return { on: imgOn(), count: Object.keys(imgMap()).length, at: at, token: !!apToken() };
}
/* Image for a catalog entry on this device, or null. */
function catImageFor(id) {
  if (!id) return null;
  var pk = imgPicks()[id]; if (pk) return pk;          // v30.173: picked in Page view, this device only
  return imgOn() ? (imgMap()[id] || null) : null;
}

/* ---------- APP-2: Verify now (design rev 7, sec 15) ----------
   Starts specs-extract for the ball's manufacturer site (the workflow's
   `only` input takes a source id; a single-page run would need a workflow
   change). Results land in the Spec approvals issue; auto rows reach the
   catalog after Publish. */
var VERIFY_KEY = 'bdbgh_verify';
var BRAND_SOURCE = [[/storm|roto ?grip|900 ?global/, 'storm'], [/brunswick/, 'brunswick'], [/dv8/, 'dv8'], [/radical/, 'radical'], [/hammer/, 'hammer'],
                    [/track/, 'track'], [/ebonite/, 'ebonite'], [/columbia/, 'columbia'], [/motiv/, 'motiv']];
/* Pure: manufacturer name -> bridge source id, or null. */
function sourceForBrand(m) {
  var t = String(m || '').toLowerCase();
  for (var i = 0; i < BRAND_SOURCE.length; i++) if (BRAND_SOURCE[i][0].test(t)) return BRAND_SOURCE[i][1];
  return null;
}
/* ---------- v30.172 CAT-NEW-4: Verify now, end to end ----------
   One chain at a time, kept in bdbgh_verify so it resumes after the app is
   closed. Steps: extract -> results -> approve -> publish -> rebuild -> recheck.
   A run is found as the first run of that workflow with an id above the
   newest id seen just before the dispatch (ids only grow; the dispatch API
   returns no run id, and the phone clock can drift from GitHub's).
   Polls every 15 s while the app is visible. Publish is always a tap. */
var VFY_STEPS = ['extract', 'results', 'approve', 'publish', 'rebuild', 'recheck'];
var VFY_LABEL = { extract: 'Re-read the maker\u2019s site', results: 'Results for this ball', approve: 'Approve',
  publish: 'Publish', rebuild: 'Catalog rebuild', recheck: 'Re-check this ball' };
var VFY_POLL_MS = 15000, VFY_START_GRACE_MS = 10 * 60000, VFY_REFRESH_GRACE_MS = 6 * 60000;
var _vfyBusy = false, _vfyTimer = null;
function vfyState() { var l = apLS(); try { return JSON.parse((l && l.getItem(VERIFY_KEY)) || 'null'); } catch (e) { return null; } }
function vfySave(s) { var l = apLS(); if (l) { if (s) l.setItem(VERIFY_KEY, JSON.stringify(s)); else l.removeItem(VERIFY_KEY); } vfyPaint(); }
/* old v30.165 record {src, at} has no step: treat as nothing running */
function vfyActive() { var s = vfyState(); return s && s.v === 2 ? s : null; }
function vfyLatestId(wf) {
  return apGH('/actions/workflows/' + wf + '/runs?per_page=1').then(function (r) {
    var run = r && r.workflow_runs && r.workflow_runs[0]; return run ? run.id : 0;
  });
}
/* Pure: the run this chain started, from a runs list (newest first). */
function vfyPickRun(runs, baseId, event) {
  var hit = null;
  (runs || []).forEach(function (r) { if (r.id > (baseId || 0) && (!event || r.event === event) && (!hit || r.id < hit.id)) hit = r; });
  return hit;
}
function vfyFindRun(wf, baseId, event) {
  return apGH('/actions/workflows/' + wf + '/runs?per_page=10').then(function (r) { return vfyPickRun(r && r.workflow_runs, baseId, event); });
}
/* Pure: what the extract left for this ball. rows = staging, boxes = issue boxes. */
function vfyClassify(rows, boxes, id) {
  var mine = (rows || []).filter(function (r) { return r.catalogId === id || (r.candidates || []).indexOf(id) >= 0; });
  var bx = (boxes || []).filter(function (b) { return b.catalogId === id; });
  var srcs = mine.map(function (r) { return r.source; }).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
  if (mine.some(function (r) { return r.decision === 'auto' && r.catalogId === id; })) return { kind: 'auto', sources: srcs };
  if (bx.length) return { kind: 'approve', boxes: bx.length, ticked: bx.some(function (b) { return b.ticked; }), sources: srcs };
  if (mine.length) return { kind: 'nospecs', reasons: mine.map(function (r) { return r.reason; }).filter(Boolean), sources: srcs };
  return { kind: 'missing' };
}
/* v30.173: pages already known for this ball (staging rows naming it, this source). */
function vfyPagesFor(rows, id, src) {
  var out = [];
  (rows || []).forEach(function (r) {
    if (!r.url || (src && r.source !== src)) return;
    if (r.catalogId === id || (r.candidates || []).indexOf(id) >= 0) { if (out.indexOf(r.url) < 0) out.push(r.url); }
  });
  return out.slice(0, 5);
}
/* Pure: minutes a past whole-site run took, from a runs list (run-name "specs-extract <src>"). */
function vfyEstimateFrom(runs, src) {
  var dur = function (r) { var a = Date.parse(r.run_started_at || r.created_at), b = Date.parse(r.updated_at); return isFinite(a) && isFinite(b) && b > a ? Math.round((b - a) / 60000) : null; };
  var ok = (runs || []).filter(function (r) { return r.status === 'completed' && r.conclusion === 'success'; });
  var mine = ok.filter(function (r) { return r.display_title === 'specs-extract ' + src; })[0];
  if (mine && dur(mine) != null) return { min: Math.max(1, dur(mine)), basis: src };
  var all = ok.filter(function (r) { return r.display_title === 'specs-extract all'; })[0];
  if (all && dur(all) != null) return { min: Math.max(1, dur(all)), basis: 'all' };
  return null;
}
function vfyEstimate(src) {
  return apGH('/actions/workflows/specs-extract.yml/runs?per_page=30').then(function (r) { return vfyEstimateFrom(r && r.workflow_runs, src); }, function () { return null; });
}
function catVerifyNow(brand, catalogId, ballId) {
  var src = sourceForBrand(brand);
  if (!src) { if (root.toast) root.toast('No manufacturer site in the bridge for ' + (brand || 'this brand') + ' yet'); return Promise.resolve(null); }
  if (!apToken()) { catApprovalsOpen(); return Promise.resolve(null); }
  var cur = vfyActive();
  if (cur && !cur.done && cur.catalogId !== catalogId && root.confirm &&
      !root.confirm('A check for ' + (cur.title || cur.catalogId) + ' is still running. Replace it with this one?')) return Promise.resolve(null);
  var base = 0, title = null, pages = [], est = null;
  return catLoad().then(function (rows) { var e = byIdIn(rows, catalogId); title = e ? cleanName(e.n) : null; }, function () {})
  .then(function () { return apReadStaged().then(function (rows) { pages = vfyPagesFor(rows, catalogId, src); }, function () {}); })
  .then(function () {
    if (pages.length) return true;
    /* no page known: only a whole-site run can look for it, which is slow */
    return vfyEstimate(src).then(function (e) {
      est = e;
      var t = e ? 'about ' + e.min + ' min' + (e.basis === 'all' ? ' (last full run; one site is usually shorter)' : '') : 'up to 30 min or more';
      return !root.confirm || root.confirm('No page is known for ' + (title || 'this ball') + ' yet, so this re-reads the whole ' + src + ' site. Last time that took ' + t + '. Start it?');
    });
  }).then(function (go) {
    if (!go) return null;
    return vfyLatestId('specs-extract.yml').then(function (id) { base = id; return apGH(''); }).then(function (repo) {
      var inputs = { only: src, limit: '0', since: '2023' };
      if (pages.length) inputs.pages = pages.join(',');
      return apGH('/actions/workflows/specs-extract.yml/dispatches', { method: 'POST', body: { ref: repo.default_branch || 'main', inputs: inputs } });
    }).then(function () {
      vfySave({ v: 2, src: src, brand: brand, catalogId: catalogId || null, ballId: ballId == null ? null : ballId,
        title: title, step: 'extract', at: env.now(), base: base, log: {}, mode: pages.length ? 'pages' : 'site', pages: pages.length, est: est ? est.min : null });
      if (root.toast) root.toast(pages.length ? 'Re-reading this ball\u2019s page (1\u20133 min).' : 'Re-reading the ' + src + ' site. Progress shows on this ball.');
      vfyArm(); return src;
    });
  }).catch(function (e) {
    if (root.toast) root.toast(e.status === 422 ? 'Upload the new specs-extract.yml (it adds the pages input)' :
      e.status === 403 || e.status === 404 ? 'Token needs Actions read and write' : ('Verify failed: ' + (e.status ? 'GitHub ' + e.status : 'offline')));
    return null;
  });
}
/* One poll. Advances as far as it can, then saves. Never rejects. */
function vfyTick() {
  var s = vfyActive();
  if (!s || s.done || s.err || _vfyBusy || !apToken()) return Promise.resolve(s);
  _vfyBusy = true;
  var go = function () {
    if (s.step === 'extract') {
      return vfyFindRun('specs-extract.yml', s.base, 'workflow_dispatch').then(function (run) {
        if (!run) { if (env.now() - s.at > VFY_START_GRACE_MS) s.err = 'The extract run did not start. Check Actions on GitHub, then retry.'; return false; }
        s.runUrl = run.html_url;
        if (run.status !== 'completed') { s.log.extract = 'running'; return false; }
        if (run.conclusion !== 'success') { s.err = 'specs-extract ' + (run.conclusion || 'failed') + '.'; s.retry = 'extract'; return false; }
        s.log.extract = 'done'; s.step = 'results'; return true;
      });
    }
    if (s.step === 'results') {
      return apReadStaged(true).then(function (rows) {
        return apFetchIssue().then(function (is) { return apParseIssue(is.body); }, function () { return []; }).then(function (boxes) {
          var c = vfyClassify(rows, boxes, s.catalogId);
          s.result = c;
          if (c.kind === 'missing' || c.kind === 'nospecs') { s.done = true; s.stopped = c.kind; return false; }
          s.step = c.kind === 'auto' ? 'publish' : 'approve';
          if (c.kind === 'auto') s.approve = 'auto';
          return true;
        });
      });
    }
    if (s.step === 'approve') {
      return apFetchIssue().then(function (is) {
        var q = apQueue();
        var bx = apParseIssue(is.body).filter(function (b) { return b.catalogId === s.catalogId; })
          .map(function (b) { if (b.tok in q) b.ticked = !!q[b.tok]; return b; });
        var t = bx.filter(function (b) { return b.ticked; });
        if (t.length && !apConflict(bx)) { s.approve = 'ticked'; s.step = 'publish'; return true; }
        s.waiting = t.length ? 'conflict' : 'approve'; return false;
      });
    }
    if (s.step === 'publish') {
      if (!s.pub) { s.waiting = 'publish'; return Promise.resolve(false); }
      return vfyFindRun('specs-publish.yml', s.pub.base, 'workflow_dispatch').then(function (run) {
        if (!run) { if (env.now() - s.pub.at > VFY_START_GRACE_MS) { s.err = 'The publish run did not start.'; s.retry = 'publish'; } return false; }
        s.pubUrl = run.html_url;
        if (run.status !== 'completed') return false;
        if (run.conclusion !== 'success') { s.err = 'specs-publish ' + (run.conclusion || 'failed') + '.'; s.retry = 'publish'; return false; }
        s.pub.done = env.now();
        /* specs.json unchanged -> the workflow skips "Re-run catalog-refresh" */
        return apGH('/actions/runs/' + run.id + '/jobs').then(function (j) {
          var st = []; ((j && j.jobs) || []).forEach(function (x) { st = st.concat(x.steps || []); });
          var re = st.filter(function (x) { return /catalog-refresh/i.test(x.name || ''); })[0];
          s.unchanged = !!(re && re.conclusion === 'skipped');
        }, function () {}).then(function () { s.step = 'rebuild'; return true; });
      });
    }
    if (s.step === 'rebuild') {
      var finish = function () { return catCheck({ force: true }).then(function (r) { s.rebuilt = r && r.status; s.step = 'recheck'; return true; }, function () { s.step = 'recheck'; return true; }); };
      if (s.unchanged) return finish();
      return vfyFindRun('catalog-refresh.yml', s.pub.refreshBase, null).then(function (run) {
        if (!run) { if (env.now() - (s.pub.done || s.pub.at) > VFY_REFRESH_GRACE_MS) { s.unchanged = true; return finish(); } return false; }
        s.refreshUrl = run.html_url;
        if (run.status !== 'completed') return false;
        if (run.conclusion !== 'success') { s.err = 'catalog-refresh ' + (run.conclusion || 'failed') + '.'; s.retry = 'rebuild'; return false; }
        return finish();
      });
    }
    if (s.step === 'recheck') {
      return vfyRecheck(s).then(function () { s.done = true; return false; });
    }
    return Promise.resolve(false);
  };
  var loop = function () { return go().then(function (more) { s.waiting = more ? null : s.waiting; return more && !s.done && !s.err ? loop() : null; }); };
  return loop().catch(function (e) {
    if (e && (e.status === 401 || e.status === 403)) s.err = 'GitHub ' + e.status + ': check the token (Actions, Contents, Issues).';
    else s.note = 'Offline or GitHub busy; trying again.';
  }).then(function () {
    var cur = vfyActive();
    if (cur && cur.at === s.at) { if (!s.err) delete s.note; vfySave(s); }   // never overwrite a newer chain
    _vfyBusy = false; vfyArm(); return s;
  });
}
/* Step 6: re-run auto-verify for the owned ball(s) linked to this USBC ball. */
function vfyRecheck(s) {
  var mine = appBalls().filter(function (b) { return b.CatalogID === s.catalogId && (s.ballId == null || b.BallID == s.ballId); });
  return catLoad().then(function (rows) { var e = byIdIn(rows, s.catalogId); return e ? catDetailRaw(e) : null; }).then(function (d) {
    s.catSpecs = !!(d && Object.keys(d.SpecsByWeight || {}).length);
    return mine.reduce(function (p, b) {
      return p.then(function () {
        return catAutoVerify(b).then(function () {
          var sp = d ? ballFromSpecs(specsOf(d, parseInt(b.Weight, 10) || 15)) : {};
          var ver = SPEC_FIELDS.filter(function (f) { return (b.SpecSource || {})[f] === 'catalog' && b[f] != null && b[f] !== ''; });
          var dif = SPEC_FIELDS.filter(function (f) { return catSpecUnverified(b, f) && sp[f] != null && sp[f] !== '' && !specMatch(f, b, sp); });
          var none = SPEC_FIELDS.filter(function (f) { return catSpecUnverified(b, f) && (sp[f] == null || sp[f] === ''); });
          s.check = s.check || {}; s.check[b.BallID] = { name: b.BallName, verified: ver, differ: dif, nocat: none };
        });
      });
    }, Promise.resolve());
  }).catch(function () {});
}
function vfyArm() {
  if (_vfyTimer || typeof setInterval !== 'function') return;
  var s = vfyActive(); if (!s || s.done) return;
  _vfyTimer = setInterval(function () {
    var c = vfyActive();
    if (!c || c.done) { clearInterval(_vfyTimer); _vfyTimer = null; return; }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    vfyTick();
  }, VFY_POLL_MS);
}
var FIELD_LABEL = { BoxFinish: 'Factory finish', Coverstock: 'Cover type', CoverName: 'Coverstock', CoreType: 'Core type', CoreShort: 'Core',
  RG: 'RG', Differential: 'Diff', IntDiff: 'Int Diff', DateReleased: 'Release date' };
/* Pure: the progress card. */
function vfyCardHTML(s) {
  if (!s) return '';
  var at = VFY_STEPS.indexOf(s.step), stop = s.stopped;
  var line = function (k, i) {
    var done = s.done && !stop ? true : i < at, cur = i === at && !(s.done && !stop);
    var mark = done ? '<span style="color:var(--teal)">\u2713</span>' : cur ? (s.err ? '<span style="color:var(--red)">!</span>' : '<span style="color:var(--gold)">\u25cf</span>') : '<span style="color:var(--t3)">\u25cb</span>';
    var sub = '';
    if (k === 'extract') sub = (s.mode === 'pages' ? 'This ball\u2019s page' + (s.pages > 1 ? 's (' + s.pages + ')' : '') + (cur && !s.err ? ' \u00b7 1\u20133 min' : '') :
      'Whole ' + s.src + ' site' + (cur && !s.err ? ' \u00b7 ' + (s.est ? 'about ' + s.est + ' min' : 'up to 30 min or more') : '')) + (s.runUrl ? ' \u00b7 <a href="' + esc(s.runUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal)">run \u2197</a>' : '');
    if (k === 'results' && s.result) sub = s.result.kind === 'auto' ? 'Matched, publishes without approval' : s.result.kind === 'approve' ? s.result.boxes + ' to review' :
      s.result.kind === 'nospecs' ? 'Page found, but no usable specs' + (s.result.reasons && s.result.reasons.length ? ' (' + esc(s.result.reasons.join(', ')) + ')' : '') : 'Not found on the maker\u2019s site';
    if (k === 'approve' && i < at) sub = s.approve === 'auto' ? 'Not needed' : 'Approved';
    if (k === 'approve' && cur && s.waiting === 'conflict') sub = 'Your approvals disagree; keep one';
    if (k === 'publish' && cur && s.pub && !s.err) sub = 'Running' + (s.pubUrl ? ' \u00b7 <a href="' + esc(s.pubUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal)">run \u2197</a>' : '');
    if (k === 'rebuild' && (cur || done) && s.unchanged) sub = 'Specs unchanged, no rebuild';
    if (k === 'rebuild' && cur && !s.unchanged && !s.err) sub = 'Waiting for catalog-refresh';
    return '<div style="display:flex;gap:8px;padding:3px 0;font-size:12px;color:' + (done || cur ? 'var(--t1)' : 'var(--t3)') + '"><span style="width:12px;text-align:center">' + mark + '</span>' +
      '<div style="flex:1">' + VFY_LABEL[k] + (sub ? '<div style="font-size:11px;color:var(--t3)">' + sub + '</div>' : '') + '</div></div>';
  };
  var h = '<div style="margin-top:10px;padding:10px 12px;border-radius:12px;border:1px solid var(--border1);background:var(--bg2);text-align:left">' +
    '<div style="font-size:12px;font-weight:800;color:var(--t2);margin-bottom:4px">Verify now' + (s.title ? ' \u00b7 ' + esc(s.title) : '') + '</div>' +
    VFY_STEPS.map(line).join('');
  if (s.err) h += '<div style="font-size:11px;color:var(--red);margin-top:6px;line-height:1.45">' + esc(s.err) + '</div>';
  else if (s.note) h += '<div style="font-size:11px;color:var(--t3);margin-top:6px">' + esc(s.note) + '</div>';
  if (s.done && s.check) Object.keys(s.check).forEach(function (id) {
    var c = s.check[id], L = function (a) { return a.map(function (f) { return FIELD_LABEL[f] || f; }).join(', '); };
    h += '<div style="font-size:11px;margin-top:6px;line-height:1.5">' +
      (c.verified.length ? '<div style="color:var(--teal)">Verified: ' + esc(L(c.verified)) + '</div>' : '') +
      (c.differ.length ? '<div style="color:var(--gold)">Still differs from the catalog: ' + esc(L(c.differ)) + '</div>' : '') +
      (c.nocat.length ? '<div style="color:var(--t3)">No catalog value yet: ' + esc(L(c.nocat)) + '</div>' : '') +
      (!c.differ.length && !c.nocat.length ? '<div style="color:var(--teal)">Nothing left unverified.</div>' : '') + '</div>' +
      (c.differ.length ? '<button style="' + BTN_P + 'margin-top:6px;padding:8px 10px" onclick="catVerifyApply(' + esc(JSON.stringify(id)).replace(/"/g, '&quot;') + ')">Review and Apply in Edit</button>' : '');
  });
  if (s.done && !s.check && !stop) h += '<div style="font-size:11px;color:var(--t3);margin-top:6px">' + (s.catSpecs ? 'The catalog now has specs for this ball.' : 'The catalog has no specs for this ball yet.') + '</div>';
  var btns = [];
  if (!s.done && !s.err && s.step === 'approve') btns.push('<button style="' + BTN_P + 'flex:1;padding:9px" onclick="catVerifyOpenApprovals()">Open in Spec approvals</button>');
  if (!s.done && !s.err && s.step === 'publish' && !s.pub) btns.push('<button style="' + BTN_P + 'flex:1;padding:9px" onclick="catVerifyPublish()">Publish</button>');
  if (s.err) btns.push('<button style="' + BTN_P + 'flex:1;padding:9px" onclick="catVerifyRetry()">Retry</button>');
  if (!s.done && !s.err) btns.push('<button style="' + BTN_G + 'padding:9px" onclick="catVerifyRefresh()">Check now</button>');
  btns.push('<button style="' + BTN_G + 'padding:9px" onclick="catVerifyDismiss()">' + (s.done ? 'Done' : 'Stop') + '</button>');
  return h + '<div style="display:flex;gap:6px;margin-top:8px">' + btns.join('') + '</div></div>';
}
/* Fills every on-screen slot for the active chain's ball. */
function vfyPaint() {
  if (typeof document === 'undefined') return;
  var s = vfyActive();
  Array.prototype.forEach.call(document.querySelectorAll('.vfy-slot'), function (el) {
    el.innerHTML = s && el.getAttribute('data-cat') === s.catalogId ? vfyCardHTML(s) : (el.getAttribute('data-idle') || '');
  });
}
/* Slot markup: idle = what to show when no chain runs for this ball (the Verify now button). */
function vfySlotHTML(catalogId, idle) {
  var s = vfyActive();
  return '<div class="vfy-slot" data-cat="' + esc(catalogId) + '" data-idle="' + esc(idle || '') + '">' + (s && s.catalogId === catalogId ? vfyCardHTML(s) : (idle || '')) + '</div>';
}
function catVerifyRefresh() { var s = vfyActive(); if (s) { delete s.waiting; vfySave(s); } return vfyTick(); }
function catVerifyDismiss() {
  var s = vfyActive();
  if (s && !s.done && root.confirm && !root.confirm('Stop following this check? Runs already started on GitHub keep going.')) return;
  clearInterval(_vfyTimer); _vfyTimer = null; vfySave(null);
}
function catVerifyRetry() {
  var s = vfyActive(); if (!s) return Promise.resolve(null);
  if (s.retry === 'extract' || (!s.retry && s.step === 'extract')) return catVerifyNow(s.brand, s.catalogId, s.ballId);
  if (s.retry === 'publish') s.pub = null;
  delete s.err; delete s.retry; vfySave(s); return vfyTick();
}
function catVerifyOpenApprovals() { var s = vfyActive(); if (!s) return; _ap.focus = s.catalogId; catApprovalsOpen(); }
/* Publish from the card or the approvals footer: note the newest ids first so the chain can find its runs. */
function vfyDispatchPublish() {
  var pb = 0, rb = 0;
  /* a baseline we cannot read is null: publish still goes, the chain just cannot follow it */
  return vfyLatestId('specs-publish.yml').catch(function () { return null; }).then(function (id) { pb = id; return vfyLatestId('catalog-refresh.yml').catch(function () { return null; }); })
    .then(function (id) { rb = id; return apGH(''); })
    .then(function (repo) { return apGH('/actions/workflows/specs-publish.yml/dispatches', { method: 'POST', body: { ref: repo.default_branch || 'main' } }); })
    .then(function () {
      var s = vfyActive();
      if (s && !s.done && !s.err && s.step === 'publish' && !s.pub && pb != null && rb != null) { s.pub = { base: pb, refreshBase: rb, at: env.now() }; delete s.waiting; vfySave(s); vfyArm(); }
      return true;
    });
}
function catVerifyPublish() {
  var q = Object.keys(apQueue()).length;
  return (q ? apFlush() : Promise.resolve(0)).catch(function () {}).then(vfyDispatchPublish).then(function () {
    if (root.toast) root.toast('specs-publish started. Progress shows on the ball.');
  }, function (e) {
    if (root.toast) root.toast(e.status === 403 || e.status === 404 ? 'Token needs Actions read and write to publish' : ('Publish failed: ' + (e.status ? 'GitHub ' + e.status : 'offline')));
  });
}
function catVerifyApply(ballId) {
  catApprovalsClose();
  var p = typeof root.navToBall === 'function' ? Promise.resolve(root.navToBall(isFinite(+ballId) ? +ballId : ballId)) : Promise.resolve();
  return p.then(function () {
    var btn = document.getElementById('bdet-edit-toggle-btn');
    if (btn && /Edit/.test(btn.textContent) && !/Cancel/.test(btn.textContent) && typeof root._bdetToggleEdit === 'function') root._bdetToggleEdit();
  });
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && vfyActive()) vfyTick(); });
  setTimeout(function () { if (vfyActive()) { vfyPaint(); vfyArm(); vfyTick(); } }, 1500);
}

/* ---------- v30.173 CAT-NEW-8: Review my specs ----------
   Pages through owned, catalog-linked balls with unverified (or empty) spec
   fields. Each field: your value beside the catalog's (published, or pending
   from staging, labelled), with Keep mine / Use catalog, per ball and in bulk.
   No extract run. Tags: Keep mine -> 'user'; Use catalog -> 'catalog' when the
   value is published, 'user' when it is pending (you vouched for it). Numbers
   only at the ball's own weight (never the nearest published weight). */
var SRV_LABEL = { CoverName: 'Coverstock', Coverstock: 'Cover type', BoxFinish: 'Factory finish', CoreShort: 'Core', CoreType: 'Core type',
  RG: 'RG', Differential: 'Diff', IntDiff: 'Int Diff', DateReleased: 'Release date' };
var SRV_ORDER = ['CoverName', 'Coverstock', 'BoxFinish', 'CoreShort', 'CoreType', 'RG', 'Differential', 'IntDiff', 'DateReleased'];
var _srv = { pages: [], idx: 0, busy: false, err: null, focus: null, noStaged: false };
/* Pure: best staging row for a USBC ball (auto, then pending naming it, then a colourway family). */
function srvStagedRow(rows, id) {
  var pick = function (f) { return (rows || []).filter(f)[0] || null; };
  return pick(function (r) { return r.decision === 'auto' && r.catalogId === id; }) ||
    pick(function (r) { return r.decision === 'pending' && r.catalogId === id; }) ||
    pick(function (r) { return r.decision === 'pending' && (r.candidates || []).indexOf(id) >= 0; });
}
/* Pure: review rows for one ball. pub / pend are ballFromSpecs() shapes (or {}). */
function srvRows(ball, pub, pend) {
  var out = [], has = function (v) { return v != null && v !== ''; };
  var tagOf = function (f) { return (ball.SpecSource || {})[f]; };
  var catObj = {};
  SRV_ORDER.forEach(function (f) { catObj[f] = has(pub[f]) ? pub[f] : has(pend[f]) ? pend[f] : null; });
  SRV_ORDER.forEach(function (f) {
    var mine = ball[f], t = tagOf(f);
    if (t === 'user' || t === 'catalog') return;                     // already verified
    var cv = has(pub[f]) ? { v: pub[f], src: 'published' } : has(pend[f]) ? { v: pend[f], src: 'pending' } : null;
    if (!has(mine) && !cv) return;                                    // nothing either side
    var kind = !has(mine) ? 'fill' : !cv ? 'nocat' : specMatch(f, ball, catObj) ? 'match' : 'differ';
    out.push({ f: f, mine: has(mine) ? mine : null, cat: cv, kind: kind });
  });
  return out;
}
/* Mutates the ball. action: 'keep' | 'use'. Returns true when something changed. */
function srvApply(ball, row, action) {
  ball.SpecSource = ball.SpecSource || {};
  if (action === 'keep' && row.mine != null) { ball.SpecSource[row.f] = 'user'; return true; }
  if (action === 'use' && row.cat) { ball[row.f] = row.cat.v; ball.SpecSource[row.f] = row.cat.src === 'published' ? 'catalog' : 'user'; return true; }
  return false;
}
function srvFmt(f, v) {
  if (v == null) return '\u2014';
  if (f === 'RG' || f === 'Differential' || f === 'IntDiff') { var n = parseFloat(v); return isFinite(n) ? n.toFixed(3) : String(v); }
  return String(v);
}
function srvLoad() {
  _srv.busy = true; srvRender();
  var balls = appBalls().filter(function (b) { return b.CatalogID && b.BallID != null && !b.Archived; });
  var staged = null;
  var stP = apToken() ? apReadStaged().then(function (r) { staged = r; }, function () { _srv.noStaged = true; }) : Promise.resolve(_srv.noStaged = true);
  return Promise.all([catLoad(), stP]).then(function (res) {
    var rows = res[0];
    return balls.reduce(function (p, b) {
      return p.then(function (acc) {
        var e = byIdIn(rows, b.CatalogID), w = parseInt(b.Weight, 10) || 15;
        return (e ? catDetailRaw(e) : Promise.resolve(null)).catch(function () { return null; }).then(function (d) {
          var pub = d ? ballFromSpecs(specsOf(d, w)) : {};
          var sr = staged ? srvStagedRow(staged, b.CatalogID) : null;
          var pend = sr ? ballFromSpecs(specsOf(apAsDetail(apApplyOverride(sr, overrideFor(b.CatalogID))), w)) : {};
          var rws = srvRows(b, pub, pend);
          if (rws.length) acc.push({ ball: b, entry: e, weight: w, pubWeights: d ? Object.keys(d.SpecsByWeight || {}) : [], rows: rws, pub: pub, pend: pend });
          return acc;
        });
      });
    }, Promise.resolve([]));
  }).then(function (pages) {
    pages.sort(function (a, b) { return String(a.ball.BallName).localeCompare(String(b.ball.BallName)); });
    _srv.pages = pages; _srv.idx = 0; _srv.err = null;
    if (_srv.focus != null) { var i = pages.map(function (p) { return p.ball.BallID; }).indexOf(_srv.focus); if (i >= 0) _srv.idx = i; _srv.focus = null; }
  }).catch(function (e) { _srv.err = e.message || String(e); }).then(function () { _srv.busy = false; srvRender(); });
}
function catSpecReviewOpen(ballId) {
  if (typeof document === 'undefined') return;
  var mb = document.getElementById('modal-bg');
  if (mb && mb.classList.contains('open') && typeof root.closeModal === 'function') root.closeModal();
  catSpecReviewClose();
  document.body.appendChild(overlay('srv-ov', 906));
  _srv.focus = ballId == null ? null : ballId;
  return srvLoad();
}
function catSpecReviewClose() {
  var el = document.getElementById('srv-ov'); if (el) el.parentNode.removeChild(el);
  if (typeof root._bdetRenderSpecs === 'function' && document.getElementById('bdet-pane-specs')) try { root._bdetRenderSpecs(); } catch (e) {}
}
function srvRecount(p) {
  var b = p.ball; p.rows = srvRows(b, p.pub, p.pend);
}
function srvCommit(msg) { if (root.saveDB) root.saveDB(); if (msg && root.toast) root.toast(msg); srvRender(); }
function catSpecReviewAct(i, action) {
  var p = _srv.pages[_srv.idx]; if (!p) return;
  var r = p.rows[i]; if (!r) return;
  if (srvApply(p.ball, r, action)) { srvRecount(p); srvCommit(null); }
}
/* scope: 'ball' (this page) or 'all'; what: 'matches' | 'differences' */
function catSpecReviewBulk(scope, what) {
  var list = scope === 'all' ? _srv.pages : [_srv.pages[_srv.idx]].filter(Boolean);
  var n = 0;
  if (what === 'differences' && root.confirm && !root.confirm('Replace ' + (scope === 'all' ? 'every' : 'this ball\u2019s') + ' differing value with the catalog\u2019s?')) return;
  list.forEach(function (p) {
    p.rows.forEach(function (r) {
      if (what === 'matches' && r.kind === 'match') n += srvApply(p.ball, r, 'use') ? 1 : 0;
      if (what === 'differences' && (r.kind === 'differ' || r.kind === 'fill')) n += srvApply(p.ball, r, 'use') ? 1 : 0;
    });
    srvRecount(p);
  });
  srvCommit(n + ' field' + (n === 1 ? '' : 's') + ' confirmed');
}
function catSpecReviewPage(d) { _srv.idx = Math.max(0, Math.min(_srv.pages.length - 1, _srv.idx + d)); srvRender(); }
function srvRender() {
  var ov = typeof document !== 'undefined' && document.getElementById('srv-ov'); if (!ov) return;
  var head = function (sub) { return '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catSpecReviewClose()">\u2039</button>' +
    '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Review my specs</div><div style="font-size:11px;color:var(--t3)">' + sub + '</div></div></div>'; };
  if (_srv.busy) { ov.innerHTML = head('Loading\u2026') + '<div style="padding:30px;text-align:center;color:var(--t3);font-size:13px">Comparing your balls with the catalog\u2026</div>'; return; }
  var pending = _srv.pages.filter(function (p) { return p.rows.length; });
  var allMatches = 0; _srv.pages.forEach(function (p) { p.rows.forEach(function (r) { if (r.kind === 'match') allMatches++; }); });
  var p = _srv.pages[_srv.idx];
  var note = (_srv.err ? '<div style="font-size:12px;color:var(--red);margin:0 16px 8px">' + esc(_srv.err) + '</div>' : '') +
    (_srv.noStaged ? '<div style="font-size:11px;color:var(--t3);margin:0 16px 6px">Published catalog only (pending specs need the GitHub token).</div>' : '');
  if (!p) { ov.innerHTML = head('Nothing to review') + note + '<div style="padding:30px 16px;text-align:center;color:var(--t2);font-size:13px;line-height:1.6">Every linked ball\u2019s specs are verified, or the catalog has nothing to compare yet.</div>'; return; }
  var b = p.ball;
  var rowsH = p.rows.length ? p.rows.map(function (r, i) {
    var chip = r.kind === 'match' ? '<span style="color:var(--teal)">\u2713 same</span>' : r.kind === 'differ' ? '<span style="color:var(--gold)">differs</span>' :
      r.kind === 'fill' ? '<span style="color:var(--t3)">you have none</span>' : '<span style="color:var(--t3)">no catalog value</span>';
    var pendTag = r.cat && r.cat.src === 'pending' ? ' <span style="font-size:9px;font-weight:800;color:var(--gold);border:1px solid rgba(214,169,76,0.45);border-radius:3px;padding:0 3px">PENDING</span>' : '';
    var btn = function (lbl, act, primary) { return '<button style="' + (primary ? BTN_P : BTN_G) + 'padding:6px 10px;font-size:12px" onclick="catSpecReviewAct(' + i + ',\'' + act + '\')">' + lbl + '</button>'; };
    var acts = r.kind === 'match' ? btn('Confirm', 'use', true) : r.kind === 'differ' ? btn('Keep mine', 'keep') + btn('Use catalog', 'use', true) :
      r.kind === 'fill' ? btn('Use catalog', 'use', true) : btn('Keep mine', 'keep');
    return '<div style="padding:9px 0;border-bottom:1px solid var(--border1)">' +
      '<div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:var(--t2)"><span>' + SRV_LABEL[r.f] + '</span>' + chip + '</div>' +
      '<div style="display:flex;gap:10px;font-size:13px;color:var(--t1);margin:3px 0 6px"><div style="flex:1"><div style="font-size:10px;color:var(--t3)">Yours</div>' + esc(srvFmt(r.f, r.mine)) + '</div>' +
      '<div style="flex:1"><div style="font-size:10px;color:var(--t3)">Catalog' + pendTag + '</div>' + esc(srvFmt(r.f, r.cat && r.cat.v)) + '</div></div>' +
      '<div style="display:flex;gap:6px;justify-content:flex-end">' + acts + '</div></div>';
  }).join('') : '<div style="padding:16px 0;color:var(--teal);font-size:13px">\u2713 All reviewed for this ball.</div>';
  var nM = p.rows.filter(function (r) { return r.kind === 'match'; }).length, nD = p.rows.filter(function (r) { return r.kind === 'differ' || r.kind === 'fill'; }).length;
  var wNote = p.pubWeights.length && p.pubWeights.indexOf(String(p.weight)) < 0 ? '<div style="font-size:11px;color:var(--gold);margin-top:2px">Catalog has no ' + p.weight + ' lb numbers (published: ' + esc(p.pubWeights.join(', ')) + ' lb), so RG / Diff are not compared.</div>' : '';
  ov.innerHTML = head(pending.length + ' ball' + (pending.length === 1 ? '' : 's') + ' to review') + note +
    '<div style="flex:1;overflow-y:auto;padding:4px 16px 12px">' +
    '<div style="font-size:15px;font-weight:700;color:var(--t1)">' + esc(b.BallName) + '</div>' +
    '<div style="font-size:11px;color:var(--t3)">' + (p.entry ? entryLine(p.entry) : 'USBC ' + esc(b.CatalogID)) + ' \u00b7 your ' + esc(p.weight) + ' lb</div>' + wNote +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 2px">' +
      (nM ? '<button style="' + BTN_P + 'padding:8px 10px;font-size:12px" onclick="catSpecReviewBulk(\'ball\',\'matches\')">Confirm ' + nM + ' match' + (nM === 1 ? '' : 'es') + '</button>' : '') +
      (nD ? '<button style="' + BTN_G + 'padding:8px 10px;font-size:12px" onclick="catSpecReviewBulk(\'ball\',\'differences\')">Use catalog for ' + nD + '</button>' : '') + '</div>' +
    rowsH + '</div>' +
    '<div style="padding:10px 16px;border-top:1px solid var(--border1);display:flex;flex-direction:column;gap:8px">' +
      '<div style="display:flex;gap:8px;align-items:center"><button style="' + BTN_G + 'flex:1;padding:11px" ' + (_srv.idx > 0 ? '' : 'disabled ') + 'onclick="catSpecReviewPage(-1)">\u2039 Prev</button>' +
      '<span style="font-size:12px;color:var(--t2);min-width:70px;text-align:center">' + (_srv.idx + 1) + ' of ' + _srv.pages.length + '</span>' +
      '<button style="' + BTN_G + 'flex:1;padding:11px" ' + (_srv.idx < _srv.pages.length - 1 ? '' : 'disabled ') + 'onclick="catSpecReviewPage(1)">Next \u203a</button></div>' +
      (allMatches ? '<button style="' + BTN_P + 'padding:10px" onclick="catSpecReviewBulk(\'all\',\'matches\')">Confirm all ' + allMatches + ' matches on every ball</button>' : '') + '</div>';
}

/* ---------- v30.169 APP-3: corrections during review ----------
   A correction is saved to staging/overrides.json on the `specs` branch
   (GitHub contents API, the APP-1 token; needs Contents read and write):
     { "<catalogId>": { coverType, finish, core, coreType, released,
                        weights: { "15": { "Diff": 0.029 } },
                        source: "maker" | "bowwwl" | "other", note, at } }
   Only fields the bowler fills are stored; a blank input means "no change".
   The source is kept per correction so bowwwl-sourced values can be credited
   or removed before anything is shared. The publish step must merge this
   file (bridge change, separate). */
/* v30.170: corrections/ (not staging/), because specs-extract replaces staging/
   on every run. Values sourced from bowwwl.com never go to the repo (public):
   they stay on this device in LOCAL_OVR_KEY (bowlingdb_ prefix, so backups keep
   them) and are merged into what this device shows. */
var OVR_PATH = '/contents/corrections/overrides.json';
var LOCAL_OVR_KEY = 'bowlingdb_spec_corrections_local';
function localOverrides() { var l = apLS(); try { return JSON.parse((l && l.getItem(LOCAL_OVR_KEY)) || '{}') || {}; } catch (e) { return {}; } }
function saveLocalOverride(id, o) { var l = apLS(); if (!l) return; var all = localOverrides(); all[id] = o; l.setItem(LOCAL_OVR_KEY, JSON.stringify(all)); }
/* Pure: repo correction then this device's correction (device wins field by field). */
function mergeOverrides(a, b) {
  if (!a) return b || null; if (!b) return a;
  var o = Object.assign({}, a, b); o.weights = {};
  [a.weights || {}, b.weights || {}].forEach(function (ws) { Object.keys(ws).forEach(function (w) { o.weights[w] = Object.assign({}, o.weights[w] || {}, ws[w]); }); });
  return o;
}
function overrideFor(id) { return mergeOverrides(_ovr && _ovr[id], localOverrides()[id]); }
var _ovr = null, _ovrSha = null;
function b64e(t) { return root.btoa(unescape(encodeURIComponent(t))); }
function b64d(t) { return decodeURIComponent(escape(root.atob(String(t || '').replace(/\s/g, '')))); }
function apReadOverrides(force) {
  if (_ovr && !force) return Promise.resolve(_ovr);
  return apGH(OVR_PATH + '?ref=specs').then(function (f) {
    _ovrSha = f.sha; _ovr = JSON.parse(b64d(f.content) || '{}'); return _ovr;
  }).catch(function (e) {
    if (e.status === 404) { _ovr = {}; _ovrSha = null; return _ovr; }
    throw e;
  });
}
/* Pure: merge a correction over a staged record (returns a new record). */
function apApplyOverride(r, o) {
  if (!o) return r;
  var sp = JSON.parse(JSON.stringify((r && r.specs) || {}));
  ['coverType', 'finish', 'core', 'coreType', 'released', 'coverName'].forEach(function (k) { if (o[k] != null && o[k] !== '') sp[k] = o[k]; });
  sp.weights = sp.weights || {};
  Object.keys(o.weights || {}).forEach(function (w) {
    sp.weights[w] = Object.assign({}, sp.weights[w] || {}, o.weights[w]);
  });
  return Object.assign({}, r || {}, { specs: sp, _edited: o });
}
/* Pure: form values -> correction object (blank = no change; numbers checked). */
/* v30.171 (locked 2026-10-10): Diff gate = USBC's 0.060 maximum (was 0.080).
   No approved ball can exceed it, so a higher value is a source error
   (e.g. Track 300T 15 lb 0.090). Same value as the bridge GATES. */
var DIFF_MAX = 0.060;
function apOverrideFrom(form) {
  var o = {}, err = [];
  ['coverName', 'coverType', 'finish', 'core', 'coreType', 'released'].forEach(function (k) { var v = String(form[k] || '').trim(); if (v) o[k] = v; });
  var w = {};
  Object.keys(form.weights || {}).forEach(function (lb) {
    var x = form.weights[lb] || {}, y = {};
    [['RG', 2.30, 2.90], ['Diff', 0, DIFF_MAX], ['IntDiff', 0, 0.040]].forEach(function (g) {
      var v = String(x[g[0]] == null ? '' : x[g[0]]).trim();
      if (!v) return;
      var n = Number(v);
      if (!isFinite(n) || n < g[1] || n > g[2]) err.push(g[0] + ' ' + lb + ' lb must be ' + g[1] + '\u2013' + g[2]);
      else y[g[0]] = n;
    });
    if (Object.keys(y).length) w[lb] = y;
  });
  if (Object.keys(w).length) o.weights = w;
  o.source = form.source || 'maker';
  if (String(form.note || '').trim()) o.note = String(form.note).trim();
  return { override: o, errors: err };
}
function apSaveOverride(catalogId, o) {
  return apReadOverrides(true).then(function (all) {
    var next = Object.assign({}, all);
    o.at = new Date().toISOString().slice(0, 10);
    next[catalogId] = o;
    var body = { message: 'spec correction: ' + catalogId + ' (' + o.source + ')', content: b64e(JSON.stringify(next, null, 1)), branch: 'specs' };
    if (_ovrSha) body.sha = _ovrSha;
    return apGH(OVR_PATH, { method: 'PUT', body: body }).then(function (res) {
      _ovr = next; _ovrSha = res && res.content ? res.content.sha : null; return next;
    });
  });
}
/* bowwwl.com page for a ball (personal-use lookup only; never fetched by the app). */
function bowwwlSlug(t) { return String(t || '').toLowerCase().replace(/\+/g, ' plus').replace(/\binc\b\.?/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function bowwwlLinks(brand, name) {
  var q = encodeURIComponent('site:bowwwl.com ' + brand + ' ' + name);
  return { page: 'https://www.bowwwl.com/bowling-ball-database/' + bowwwlSlug(brand) + '/' + bowwwlSlug(name), search: 'https://www.google.com/search?q=' + q };
}

/* ---------- correction sheet UI ---------- */
var _apEdit = null;
/* ---------- v30.173 CAT-NEW-7: pick lists for reusable spec values ----------
   Values already in use for core, coverstock, cover type and finish: the
   catalog's vocab.json (every published value, count, makers), plus staging
   rows and your own balls, so lists work before the next catalog-refresh.
   The ball's brand family is listed first: cores and covers are shared
   inside a family (same parent company), rarely across. */
var FAMILY = [[/storm|roto ?grip|900 ?global/i, 'Storm \u00b7 Roto Grip \u00b7 900 Global'],
  [/brunswick|dv8|radical|ebonite|hammer|track|columbia/i, 'Brunswick \u00b7 DV8 \u00b7 Radical \u00b7 Ebonite \u00b7 Hammer \u00b7 Track \u00b7 Columbia 300'],
  [/motiv/i, 'Motiv']];
function familyOf(m) { var t = String(m || ''); for (var i = 0; i < FAMILY.length; i++) if (FAMILY[i][0].test(t)) return FAMILY[i][1]; return null; }
var VOCAB_FIELDS = { 'ape-core': 'core', 'ape-coverName': 'coverName', 'ape-coverType': 'coverType', 'ape-finish': 'finish' };
var _vocab = null, _vocabP = null;
function vocabKey(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
/* Pure: merge lists of {v, n, b[]} by folded value; extra = [{field, v, brand}]. */
function vocabMerge(dist, extra) {
  var out = {};
  ['core', 'coverName', 'coverType', 'finish'].forEach(function (k) {
    var m = {}, order = [];
    var add = function (v, n, brands) {
      var key = vocabKey(v); if (!key) return;
      if (!m[key]) { m[key] = { v: String(v).trim(), n: 0, b: [] }; order.push(key); }
      m[key].n += n; (brands || []).forEach(function (x) { if (x && m[key].b.indexOf(x) < 0) m[key].b.push(x); });
    };
    ((dist && dist[k]) || []).forEach(function (o) { add(o.v, o.n || 1, o.b); });
    (extra || []).forEach(function (o) { if (o.field === k) add(o.v, 1, [o.brand]); });
    out[k] = order.map(function (x) { return m[x]; }).sort(function (a, b) { return b.n - a.n || a.v.localeCompare(b.v); });
  });
  return out;
}
/* Pure: split a list by the brand's family, filtered by typed text. */
function vocabSplit(list, brand, q) {
  var fam = familyOf(brand), qq = vocabKey(q), same = [], other = [];
  (list || []).forEach(function (o) {
    if (qq && vocabKey(o.v).indexOf(qq) < 0) return;
    (fam && o.b.some(function (x) { return familyOf(x) === fam; }) ? same : other).push(o);
  });
  return { family: fam, same: same, other: other };
}
function vocabLoad() {
  if (_vocab) return Promise.resolve(_vocab);
  if (_vocabP) return _vocabP;
  var extra = [];
  appBalls().forEach(function (b) {
    [['CoreShort', 'core'], ['CoverName', 'coverName'], ['Coverstock', 'coverType'], ['BoxFinish', 'finish']].forEach(function (p) { if (b[p[0]]) extra.push({ field: p[1], v: b[p[0]], brand: b.MFG }); });
  });
  (_staged || []).forEach(function (r) { var sp = r.specs || {};
    [['core', 'core'], ['coverName', 'coverName'], ['coverType', 'coverType'], ['finish', 'finish']].forEach(function (p) { if (sp[p[0]]) extra.push({ field: p[1], v: sp[p[0]], brand: r.brand }); }); });
  _vocabP = env.fetch(CAT_BASE + 'vocab.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
    .then(function (dist) { _vocab = vocabMerge(dist, extra); _vocabP = null; return _vocab; });
  return _vocabP;
}
var _vp = { field: null, brand: null };
function catPickOpen(fieldId) {
  var k = VOCAB_FIELDS[fieldId]; if (!k) return;
  var p = _ap.pages[_ap.idx], e = p && _ap._rows ? byIdIn(_ap._rows, p.catalogId) : null;
  _vp = { field: fieldId, brand: e ? e.m : null };
  var ov = overlay('vp-ov', 930);
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catPickClose()">\u2039</button>' +
    '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">' + ({ core: 'Core', coverName: 'Coverstock', coverType: 'Cover type', finish: 'Factory finish' }[k]) + '</div>' +
    '<div style="font-size:11px;color:var(--t3)">Values already in use</div></div></div>' +
    '<div style="padding:0 16px 8px"><input id="vp-q" class="bdet-field-input" type="search" placeholder="Filter" autocomplete="off" autocorrect="off" autocapitalize="off" oninput="catPickFilter(this.value)" style="width:100%;box-sizing:border-box;font-size:15px"></div>' +
    '<div id="vp-list" style="flex:1;overflow-y:auto;padding:0 16px 16px"><div style="color:var(--t3);font-size:13px;padding:20px 0;text-align:center">Loading\u2026</div></div>';
  document.body.appendChild(ov);
  vocabLoad().then(function () { catPickFilter(''); });
}
function catPickFilter(q) {
  var el = document.getElementById('vp-list'); if (!el || !_vocab) return;
  var sp = vocabSplit(_vocab[VOCAB_FIELDS[_vp.field]], _vp.brand, q);
  var item = function (o) { return '<div onclick="catPickChoose(' + esc(JSON.stringify(o.v)).replace(/"/g, '&quot;') + ')" style="padding:10px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' +
    '<div style="font-size:14px;color:var(--t1)">' + esc(o.v) + '</div><div style="font-size:11px;color:var(--t3)">' + o.n + ' ball' + (o.n === 1 ? '' : 's') + ' \u00b7 ' + esc(o.b.slice(0, 4).join(', ')) + (o.b.length > 4 ? '\u2026' : '') + '</div></div>'; };
  var sec = function (t, list) { return list.length ? '<div style="font-size:11px;font-weight:700;color:var(--t3);margin:12px 0 2px;text-transform:uppercase;letter-spacing:.5px">' + esc(t) + '</div>' + list.slice(0, 150).map(item).join('') : ''; };
  var h = (sp.family ? sec(sp.family, sp.same) + sec('Other makers', sp.other) : sec('All makers', sp.other));
  el.innerHTML = h || '<div style="color:var(--t3);font-size:13px;padding:20px 0;text-align:center">' + (q ? 'No match. Close and type it in.' : 'No values yet.') + '</div>';
}
function catPickChoose(v) {
  var el = document.getElementById(_vp.field); if (el) { el.value = v; el.style.boxShadow = '0 0 0 2px var(--teal)'; setTimeout(function () { el.style.boxShadow = ''; }, 700); }
  catPickClose();
}
function catPickClose() { var el = document.getElementById('vp-ov'); if (el) el.parentNode.removeChild(el); }

/* ---------- v30.173 CAT-NEW-6: Page view (bridge snapshot) ----------
   The bridge keeps each page's short text lines and product image links in
   staging/pages/<key>.json (never published). The correction sheet opens it
   full screen: select any text (long-press, like Safari) or tap a number,
   then "Use" -> tap the field. Tap an image to show it for this ball on this
   device only (bdbimg_pick, outside backups, like IMG-1). */
var IMG_PICK_KEY = 'bdbimg_pick';
var _pages = {}, _pgSel = '', _pgSnap = null;
function imgPicks() { var l = apLS(); try { return JSON.parse((l && l.getItem(IMG_PICK_KEY)) || '{}') || {}; } catch (e) { return {}; } }
function imgPickSet(id, url) { var l = apLS(); if (!l) return; var m = imgPicks(); if (url) m[id] = url; else delete m[id]; l.setItem(IMG_PICK_KEY, JSON.stringify(m)); }
function apReadPage(key) {
  if (_pages[key]) return Promise.resolve(_pages[key]);
  if (!apToken()) return Promise.reject(new Error('Add the GitHub token in Spec approvals first'));
  var h = { 'Accept': 'application/vnd.github.raw+json', 'Authorization': 'Bearer ' + apToken(), 'X-GitHub-Api-Version': '2022-11-28' };
  return env.fetch(AP_API + '/contents/staging/pages/' + encodeURIComponent(key) + '.json?ref=specs', { headers: h, cache: 'no-store' }).then(function (r) {
    if (!r.ok) { var e = new Error(r.status === 404 ? 'No snapshot for this page yet (it appears after the next specs-extract).' : 'GitHub ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }).then(function (j) { _pages[key] = j; return j; });
}
function catPageOpen() {
  if (!_apEdit || !_apEdit.page) return;
  var ov = overlay('pgv-ov', 925);
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catPageClose()">\u2039</button>' +
    '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Page</div><div id="pgv-sub" style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Loading\u2026</div></div></div>' +
    '<div id="pgv-body" style="flex:1;overflow-y:auto;padding:0 16px 16px"></div>' +
    '<div id="pgv-bar" style="display:none;padding:10px 16px;border-top:1px solid var(--border1);gap:8px;align-items:center"></div>';
  document.body.appendChild(ov);
  _pgSel = '';
  apReadPage(_apEdit.page).then(function (snap) { _pgSnap = snap; pgvRender(); }, function (e) {
    var b = document.getElementById('pgv-body'); if (b) b.innerHTML = '<div style="padding:30px 0;text-align:center;color:var(--red);font-size:13px;line-height:1.5">' + esc(e.message || String(e)) + '</div>';
    var s = document.getElementById('pgv-sub'); if (s) s.textContent = '';
  });
}
function pgvRender() {
  var snap = _pgSnap, b = document.getElementById('pgv-body'); if (!b || !snap) return;
  var sub = document.getElementById('pgv-sub');
  if (sub) sub.innerHTML = esc(snap.title || '') + (snap.url ? ' \u00b7 <a href="' + esc(snap.url) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal)">open on site \u2197</a>' : '');
  var cur = _apEdit ? imgPicks()[_apEdit.catalogId] : null;
  var imgs = (snap.images || []).map(function (u, i) {
    var on = cur === u;
    return '<div onclick="catPageImg(' + i + ')" style="position:relative;flex:0 0 31%;aspect-ratio:1;border-radius:10px;overflow:hidden;background:var(--bg3);border:2px solid ' + (on ? 'var(--teal)' : 'transparent') + ';cursor:pointer">' +
      '<img src="' + esc(u) + '" referrerpolicy="no-referrer" loading="lazy" onerror="this.parentNode.style.display=\'none\'" style="width:100%;height:100%;object-fit:contain">' +
      (on ? '<span style="position:absolute;top:4px;right:4px;font-size:10px;font-weight:800;color:#000;background:var(--teal);border-radius:6px;padding:1px 5px">IN USE</span>' : '') + '</div>';
  }).join('');
  var lines = (snap.lines || []).map(function (l) {
    return '<div style="padding:3px 0;line-height:1.7">' + tagLine(l).map(function (p) {
      if (!p.tok || p.tok.kind !== 'num') return esc(p.t);   // numbers only: a weight is not a field value
      return '<span onclick="catPageUseVal(' + esc(JSON.stringify(p.tok.v)).replace(/"/g, '&quot;') + ')" style="color:' + (p.tok.kind === 'wt' ? 'var(--gold)' : 'var(--teal)') + ';font-weight:700;text-decoration:underline;cursor:pointer">' + esc(p.t) + '</span>';
    }).join('') + '</div>';
  }).join('');
  b.innerHTML = (imgs ? '<div style="font-size:11px;font-weight:700;color:var(--t3);margin:4px 0 6px;text-transform:uppercase;letter-spacing:.5px">Images \u00b7 tap to use on this device</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' + imgs + '</div>' : '') +
    '<div style="font-size:11px;font-weight:700;color:var(--t3);margin:14px 0 4px;text-transform:uppercase;letter-spacing:.5px">Text \u00b7 select any of it, or tap a number</div>' +
    '<div id="pgv-text" style="font-size:13px;color:var(--t1);-webkit-user-select:text;user-select:text;padding:6px 10px;border-radius:10px;background:var(--bg2)">' +
      (lines || '<span style="color:var(--t3)">No text kept for this page.</span>') + '</div>';
}
function pgvBar() {
  var bar = document.getElementById('pgv-bar'); if (!bar) return;
  if (!_pgSel) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  bar.innerHTML = '<div style="flex:1;min-width:0;font-size:12px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\u201c' + esc(_pgSel) + '\u201d</div>' +
    '<button style="' + BTN_P + 'padding:9px 14px" onpointerdown="event.preventDefault()" onmousedown="event.preventDefault()" onclick="catPageUseSel()">Use</button>';
}
/* Pure: tidy a selection into a field value (one line, trimmed, capped). */
function pgvClean(t) { return String(t || '').replace(/\s+/g, ' ').replace(/^[\s:|,;\-\u2013]+|[\s:|,;\-\u2013]+$/g, '').slice(0, 80); }
if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('selectionchange', function () {
  var box = document.getElementById('pgv-text'); if (!box) return;
  var sel = root.getSelection && root.getSelection(), t = sel ? pgvClean(sel.toString()) : '';
  if (t && sel.anchorNode && box.contains(sel.anchorNode)) { _pgSel = t; pgvBar(); }
  else if (!t && _pgSel) { /* keep the last selection until Use or a new one: a tap on Use can collapse it first */ }
});
function catPageUseSel() { if (_pgSel) catPageUseVal(_pgSel); }
function catPageUseVal(v) {
  var t = pgvClean(v); if (!t) return;
  catPageClose();
  _tag.val = t; _tag.key = null; tagPaint();
  var bar = document.getElementById('ape-tagbar'); if (bar && bar.scrollIntoView) bar.scrollIntoView({ block: 'nearest' });
}
function catPageImg(i) {
  if (!_apEdit || !_pgSnap) return;
  var u = (_pgSnap.images || [])[i]; if (!u) return;
  var cur = imgPicks()[_apEdit.catalogId];
  if (cur === u) { if (!root.confirm || root.confirm('Stop using this image for this ball?')) imgPickSet(_apEdit.catalogId, null); }
  else if (!root.confirm || root.confirm('Use this image for this ball on this device? It is never published.')) { imgPickSet(_apEdit.catalogId, u); if (root.toast) root.toast('Image set on this device'); }
  pgvRender();
}
function catPageClose() { var el = document.getElementById('pgv-ov'); if (el) el.parentNode.removeChild(el); _pgSel = ''; _pgSnap = null; if (root.getSelection) try { root.getSelection().removeAllRanges(); } catch (e) {} }

/* ---------- v30.172 CAT-NEW-2: tap-to-tag (LOCKED: value first, then field) ----------
   The bridge keeps the spec lines it read (staging rawText, never published).
   The correction sheet shows them with tappable values: numbers, weights and
   short phrases (the text after "Label:" or "Label |"). Tap a value, then the
   field it belongs to. Numbers are range-checked like typed ones. A weight
   tap marks that row of the table, as a place marker only. */
var TAG_NUM = /(^|[^\d.])((?:[0-2])?\.\d{2,3})(?![\d])/g;
var TAG_WT = /\b(1[0-6])\s*(?:lbs?\.?|#|pounds?)(?![a-z])/gi;
var _tag = { lines: [], val: null, key: null, row: null };
/* Pure: one line -> parts [{t}|{t, tok:{kind, v}}], tokens in reading order. */
function tagLine(line) {
  var hits = [], m;
  TAG_NUM.lastIndex = 0; while ((m = TAG_NUM.exec(line))) hits.push({ i: m.index + m[1].length, t: m[2], kind: 'num', v: m[2].charAt(0) === '.' ? '0' + m[2] : m[2] });
  TAG_WT.lastIndex = 0; while ((m = TAG_WT.exec(line))) hits.push({ i: m.index, t: m[0], kind: 'wt', v: m[1] });
  /* phrase = value after the first "Label:" / "Label |", when short and not just a number */
  var sep = /^([A-Za-z][A-Za-z .()\/-]{1,28}?)\s*(?::|\s\|)\s*(.+)$/.exec(line);
  if (sep) {
    var val = sep[2].replace(/\s*\|.*$/, '').trim(), at = line.indexOf(val, sep[1].length);
    var overlaps = hits.some(function (h) { return h.i >= at && h.i < at + val.length; });
    if (val && val.length <= 40 && !/^[\d.\s]+$/.test(val) && !overlaps) hits.push({ i: at, t: val, kind: 'phrase', v: val });
  }
  hits.sort(function (a, b) { return a.i - b.i; });
  var out = [], pos = 0;
  hits.forEach(function (h) { if (h.i < pos) return; if (h.i > pos) out.push({ t: line.slice(pos, h.i) }); out.push({ t: h.t, tok: { kind: h.kind, v: h.v } }); pos = h.i + h.t.length; });
  if (pos < line.length) out.push({ t: line.slice(pos) });
  return out;
}
function tagLines(raw) { return String(raw || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(tagLine); }
var MONTH_N = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
/* Pure: what a tapped value becomes in a field, or why it cannot go there. */
function tagValueFor(fieldId, v) {
  var s = String(v == null ? '' : v).trim(), w = /^ape-(\d+)-(RG|Diff|IntDiff)$/.exec(fieldId);
  if (w) {
    var lim = { RG: [2.30, 2.90], Diff: [0, DIFF_MAX], IntDiff: [0, 0.040] }[w[2]], n = Number(s);
    if (!/^\d*\.?\d+$/.test(s) || !isFinite(n)) return { err: 'Pick a number for ' + (w[2] === 'IntDiff' ? 'Int Diff' : w[2]) };
    if (n < lim[0] || n > lim[1]) return { err: (w[2] === 'IntDiff' ? 'Int Diff' : w[2]) + ' ' + w[1] + ' lb must be ' + lim[0] + '\u2013' + lim[1] + ' (read ' + s + ')' };
    return { v: s.charAt(0) === '.' ? '0' + s : s };
  }
  if (fieldId === 'ape-coreType') {
    if (/asym/i.test(s)) return { v: 'Asymmetrical' };
    if (/sym/i.test(s)) return { v: 'Symmetrical' };
    return { err: 'Core type takes Symmetrical or Asymmetrical' };
  }
  if (fieldId === 'ape-released') {
    var m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(s); if (m) return { v: m[0] };
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); if (m) return { v: m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2) };
    m = /^([A-Za-z]+)\.?\s+(\d{4})$/.exec(s); if (m && MONTH_N[m[1].toLowerCase()]) return { v: m[2] + '-' + ('0' + MONTH_N[m[1].toLowerCase()]).slice(-2) };
    m = /^(\d{4})$/.exec(s); if (m) return { v: m[1] };
    return { err: 'Release date needs a date, e.g. October 2022' };
  }
  if (/^ape-(coverName|coverType|finish|core|note)$/.test(fieldId)) return { v: s.replace(/[\u2122\u00ae]/g, '').trim() };
  return { err: 'That field does not take tapped values' };
}
function tagPanelHTML(raw, page) {
  _tag = { lines: tagLines(raw), val: null, key: null, row: null };
  var bar = '<div id="ape-tagbar" style="display:none;position:sticky;top:0;z-index:2;margin-top:6px;padding:8px 10px;border-radius:10px;background:var(--bg2);border:1px solid var(--teal);font-size:12px;color:var(--t1)"></div>';
  var pageBtn = page ? '<button style="' + BTN_P + 'width:100%;padding:10px;margin-top:6px" onclick="catPageOpen()">Open the page: select text or pick an image \u203a</button>' : '';
  if (!_tag.lines.length) return page ? '<div style="font-size:11px;font-weight:700;color:var(--t3);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.5px">From the page</div>' + pageBtn + bar : '';
  var body = _tag.lines.map(function (parts, i) {
    return '<div style="padding:3px 0;line-height:1.9">' + parts.map(function (p, j) {
      if (!p.tok) return '<span style="color:var(--t3)">' + esc(p.t) + '</span>';
      var col = p.tok.kind === 'wt' ? 'var(--gold)' : 'var(--teal)';
      return '<span data-tag="' + i + '-' + j + '" onclick="catTagPick(' + i + ',' + j + ')" style="cursor:pointer;padding:2px 6px;border-radius:7px;border:1px solid ' + col +
        ';color:' + col + ';font-weight:700;white-space:nowrap">' + esc(p.t) + '</span>';
    }).join('') + '</div>';
  }).join('');
  return '<div style="font-size:11px;font-weight:700;color:var(--t3);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.5px">From the page</div>' +
    '<div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:4px">Tap a value, then the field it belongs to.</div>' +
    '<div id="ape-tags" style="max-height:190px;overflow-y:auto;padding:6px 10px;border-radius:10px;background:var(--bg3);font-size:12px">' + body + '</div>' + pageBtn + bar;
}
function tagPaint() {
  var ov = document.getElementById('ap-edit-ov'); if (!ov) return;
  ov.classList.toggle('tagging', !!_tag.val);
  Array.prototype.forEach.call(ov.querySelectorAll('[data-tag]'), function (el) { el.style.background = el.getAttribute('data-tag') === _tag.key ? 'rgba(0,217,217,0.18)' : 'transparent'; });
  Array.prototype.forEach.call(ov.querySelectorAll('tr[data-w]'), function (tr) { tr.style.background = tr.getAttribute('data-w') === _tag.row ? 'rgba(214,169,76,0.14)' : ''; });
  var bar = document.getElementById('ape-tagbar');
  if (bar) { bar.style.display = _tag.val ? 'block' : 'none';
    bar.innerHTML = _tag.val ? 'Tap a field for <b>' + esc(_tag.val) + '</b> <span onclick="catTagCancel()" style="float:right;color:var(--teal);font-weight:700;cursor:pointer">Cancel</span>' : ''; }
}
function catTagPick(i, j) {
  var p = (_tag.lines[i] || [])[j]; if (!p || !p.tok) return;
  if (p.tok.kind === 'wt') { _tag.row = _tag.row === p.tok.v ? null : p.tok.v; tagPaint(); return; }
  var key = i + '-' + j;
  if (_tag.key === key) { _tag.val = null; _tag.key = null; } else { _tag.val = p.tok.v; _tag.key = key; }
  tagPaint();
}
function catTagCancel() { _tag.val = null; _tag.key = null; tagPaint(); }
/* Field tap while a value is picked (inputs ignore pointer events then, so no keyboard). */
function tagFieldTap(ev) {
  if (!_tag.val) return;
  var box = ev.target && ev.target.closest ? ev.target.closest('.ape-f') : null; if (!box) return;
  var el = box.querySelector('input,select'); if (!el) return;
  ev.preventDefault(); ev.stopPropagation();
  var r = tagValueFor(el.id, _tag.val), err = document.getElementById('ape-err');
  if (r.err) { if (err) err.textContent = r.err; return; }
  el.value = el.id === 'ape-note' && el.value ? el.value + '; ' + r.v : r.v;
  if (err) err.textContent = '';
  el.style.boxShadow = '0 0 0 2px var(--teal)'; setTimeout(function () { el.style.boxShadow = ''; }, 700);
  if (root.haptic) try { root.haptic('light'); } catch (x) {}
  _tag.val = null; _tag.key = null; tagPaint();
}
function catApprovalsEdit(i) {
  var p = _ap.pages[_ap.idx]; if (!p) return;
  var b = p.boxes[i];
  var r = apApplyOverride(_staged ? apStagedFor(_staged, b, p.catalogId) : null, overrideFor(p.catalogId));
  var sp = (r && r.specs) || {};
  _apEdit = { catalogId: p.catalogId, i: i, page: (r && r.page) || null };
  var inp = function (id, v, ph) { return '<div class="ape-f"><input id="' + id + '" class="bdet-field-input" value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(ph || '') + '" style="width:100%;box-sizing:border-box;font-size:15px"></div>'; };
  /* v30.173 CAT-NEW-7: type, or pick a value already in use */
  var inpP = function (id, v, ph) { return '<div style="display:flex;gap:6px;align-items:stretch"><div class="ape-f" style="flex:1">' + inp(id, v, ph).replace(/^<div class="ape-f">|<\/div>$/g, '') + '</div>' +
    '<button style="' + BTN_G + 'padding:0 12px;font-size:13px" onclick="catPickOpen(\'' + id + '\')" aria-label="Pick">\u25be</button></div>'; };
  var lab = function (t) { return '<div style="font-size:11px;font-weight:700;color:var(--t3);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.5px">' + t + '</div>'; };
  var ws = [16, 15, 14, 13, 12];
  var wrow = function (w) { var x = (sp.weights || {})[w] || {};
    var c = function (k) { return '<input id="ape-' + w + '-' + k + '" inputmode="decimal" class="bdet-field-input" value="' + esc(x[k] == null ? '' : x[k]) + '" style="width:100%;box-sizing:border-box;font-size:14px;padding:6px">'; };
    return '<tr data-w="' + w + '"><td style="color:var(--t2);font-size:13px;padding:3px 4px 3px 0">' + w + ' lb</td><td class="ape-f" style="padding:3px">' + c('RG') + '</td><td class="ape-f" style="padding:3px">' + c('Diff') + '</td><td class="ape-f" style="padding:3px">' + c('IntDiff') + '</td></tr>'; };
  var ov = overlay('ap-edit-ov', 920);
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catApprovalsEditClose()">‹</button>' +
    '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Correct specs</div><div style="font-size:11px;color:var(--t3)">' + esc(b.title) + ' · USBC ' + esc(p.catalogId) + '</div></div></div>' +
    '<div style="flex:1;overflow-y:auto;padding:0 16px 16px">' +
    '<div style="font-size:12px;color:var(--t2);line-height:1.5">Change or fill any field. Values shown are what the bridge read; edit them in place.</div>' +
    tagPanelHTML(r && r.rawText, r && r.page) +
    lab('Coverstock') + inpP('ape-coverName', sp.coverName, 'e.g. R2S Pearl Reactive') +
    lab('Cover type') + inpP('ape-coverType', sp.coverType, 'e.g. Solid Reactive') +
    lab('Factory finish') + inpP('ape-finish', sp.finish, 'e.g. 2000 Abralon') +
    lab('Core') + inpP('ape-core', sp.core) +
    lab('Core type') + '<div class="ape-f"><select id="ape-coreType" class="bdet-field-input" style="width:100%;font-size:15px"><option value=""' + (!sp.coreType ? ' selected' : '') + '>—</option><option' + (/^sym/i.test(sp.coreType || '') ? ' selected' : '') + '>Symmetrical</option><option' + (/asym/i.test(sp.coreType || '') ? ' selected' : '') + '>Asymmetrical</option></select></div>' +
    lab('Release date') + inp('ape-released', sp.released ? String(sp.released).slice(0, 10) : '', 'YYYY-MM-DD') +
    lab('RG / Diff / Int Diff by weight') +
    '<table style="width:100%;border-collapse:collapse"><tr style="font-size:11px;color:var(--t3)"><td></td><td>RG</td><td>Diff</td><td>Int</td></tr>' + ws.map(wrow).join('') + '</table>' +
    lab('Source of this correction') + '<select id="ape-source" class="bdet-field-input" style="width:100%;font-size:15px">' +
      '<option value="maker">Maker spec sheet / page</option><option value="bowwwl">bowwwl.com (personal use)</option><option value="other">Other</option></select>' +
    lab('Note') + inp('ape-note', '', 'e.g. site shows 0.090, sheet PDF says 0.029') +
    '<div style="font-size:11px;color:var(--t3);margin-top:6px;line-height:1.45">Maker / other corrections are saved to the repo and published with the ball. bowwwl values stay on this device and are never published.</div>' +
    '<div id="ape-err" style="font-size:12px;color:var(--red);margin-top:8px;line-height:1.45"></div>' +
    '</div><div style="padding:10px 16px;border-top:1px solid var(--border1)"><button style="' + BTN_P + 'width:100%;padding:12px" onclick="catApprovalsEditSave()">Save correction</button></div>';
  document.body.appendChild(ov);
  if (!document.getElementById('ape-tag-css')) { var st = document.createElement('style'); st.id = 'ape-tag-css';
    st.textContent = '#ap-edit-ov.tagging .ape-f input,#ap-edit-ov.tagging .ape-f select{pointer-events:none;outline:1px dashed var(--teal);outline-offset:1px}';
    document.head.appendChild(st); }
  ov.addEventListener('click', tagFieldTap, true);
}
function catApprovalsEditClose() { var el = document.getElementById('ap-edit-ov'); if (el) el.parentNode.removeChild(el); _apEdit = null; }
function catApprovalsEditSave() {
  if (!_apEdit) return;
  var g = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
  var form = { coverName: g('ape-coverName'), coverType: g('ape-coverType'), finish: g('ape-finish'), core: g('ape-core'), coreType: g('ape-coreType'), released: g('ape-released'),
               source: g('ape-source'), note: g('ape-note'), weights: {} };
  [16, 15, 14, 13, 12].forEach(function (w) { form.weights[w] = { RG: g('ape-' + w + '-RG'), Diff: g('ape-' + w + '-Diff'), IntDiff: g('ape-' + w + '-IntDiff') }; });
  /* Only what differs from the baseline is stored. The baseline includes the
     OTHER store's corrections, so a bowwwl value shown in the form is never
     saved to the repo as a maker correction, and repo values are not copied
     into the device store (v30.170). */
  var p = _ap.pages[_ap.idx], staged0 = (_staged && p) ? apStagedFor(_staged, p.boxes[_apEdit.i] || p.boxes[0], p.catalogId) : null;
  var other = form.source === 'bowwwl' ? (_ovr && _ovr[p.catalogId]) : localOverrides()[p.catalogId];
  var base = apApplyOverride(staged0, other), bs = (base && base.specs) || {};
  ['coverName', 'coverType', 'finish', 'core', 'coreType', 'released'].forEach(function (k) { if (String(form[k]).trim() === String(bs[k] == null ? '' : bs[k]).slice(0, k === 'released' ? 10 : 999)) form[k] = ''; });
  Object.keys(form.weights).forEach(function (w) { var x = form.weights[w], y = (bs.weights || {})[w] || {};
    ['RG', 'Diff', 'IntDiff'].forEach(function (k) { if (x[k] !== '' && y[k] != null && Number(x[k]) === Number(y[k])) x[k] = ''; }); });
  var res = apOverrideFrom(form), err = document.getElementById('ape-err');
  if (res.errors.length) { if (err) err.textContent = res.errors.join('. '); return; }
  var o = res.override;
  if (!o.weights && !['coverName', 'coverType', 'finish', 'core', 'coreType', 'released'].some(function (k) { return o[k]; })) { if (err) err.textContent = 'Nothing changed.'; return; }
  if (o.source === 'bowwwl') {
    /* personal-use data: this device only, never committed */
    o.at = new Date().toISOString().slice(0, 10);
    saveLocalOverride(_apEdit.catalogId, mergeOverrides(localOverrides()[_apEdit.catalogId], o));
    catApprovalsEditClose(); apRender(); if (root.toast) root.toast('Saved on this device only (bowwwl values are not published)');
    return;
  }
  if (err) err.textContent = 'Saving…';
  apSaveOverride(_apEdit.catalogId, o).then(function () {
    catApprovalsEditClose(); apRender(); if (root.toast) root.toast('Correction saved');
  }).catch(function (e) {
    if (err) err.textContent = e.status === 403 || e.status === 404 ? 'The token needs Contents: Read and write for this repo (GitHub → token → Permissions).' : ('Not saved: ' + (e.status ? 'GitHub ' + e.status : 'offline'));
  });
}

/* Latest specs-extract run, for the status line in Spec approvals. */
function apExtractStatus() {
  return apGH('/actions/workflows/specs-extract.yml/runs?per_page=1').then(function (r) {
    var run = r && r.workflow_runs && r.workflow_runs[0];
    if (!run) return null;
    return { status: run.status, conclusion: run.conclusion, at: run.created_at, url: run.html_url };
  }).catch(function () { return null; });
}

/* ---------- MET-2: ball comparison (design LOCKED 2026-10-09, built v30.171) ----------
   Entry points: Compare on Balls (pick 2-4), on Ball Detail, on the catalog
   detail sheet. One column per ball, labels pinned left, horizontal scroll
   past two columns. Rows that differ are highlighted; a '--' never counts.
   Owned balls: Strength on the current surface (factory noted, MET-1) and
   DATA-2 markers. Catalog balls: factory specs at the chosen weight (15 lb
   if unset, labelled), nearest published weight shown when it is missing. */
var CMP_MAX = 4;
var _cmp = { cols: [], details: {}, pending: {} };
function cmpCell(txt, key, extra) {
  var c = { txt: txt == null || txt === '' ? null : String(txt), key: key == null || key === '' ? null : String(key) };
  if (extra) for (var k in extra) c[k] = extra[k];
  return c;
}
function n3(v) { var n = parseFloat(v); return isFinite(n) ? n.toFixed(3) : null; }
function finishKey(v) { var p = parseFinish(v); return p ? p.grit + (p.polished ? 'p' : '') : (v ? normTxt(v) : null); }
function coreKey(t) { return !t ? null : /asym/i.test(t) ? 'a' : /sym/i.test(t) ? 's' : normTxt(t); }
/* Pure: one column from an owned ball. */
function cmpColOwned(b) {
  var m = catMetric(b), uv = function (f) { return catSpecUnverified(b, f); };
  var fac = m && m.factory, cur = m && m.current && fac && (fac.strength !== m.strength || fac.shape !== m.shape);
  var cc = coverClass(b.Coverstock, b.CoverName), band = catRGBand(b.RG, b.Differential);
  return { kind: 'owned', id: b.BallID, name: b.BallName || '', mfg: b.MFG || '', cells: {
    weight: cmpCell(b.Weight ? b.Weight + ' lb' : null, b.Weight),
    strength: cmpCell(m ? (m.approx ? '~' : '') + m.strength : null, m ? m.strength : null,
      { note: cur ? 'current \u00b7 factory ' + fac.strength : (m ? 'factory finish' : null), approx: m && m.approx }),
    shape: cmpCell(m ? signed(m.shape) : null, m ? m.shape : null, { note: cur ? 'factory ' + signed(fac.shape) : null }),
    band: cmpCell(band, band),
    cover: cmpCell(b.Coverstock || (cc ? cc.charAt(0).toUpperCase() + cc.slice(1) : null), cc || normTxt(b.Coverstock), { uv: uv('Coverstock') }),
    finish: cmpCell(b.BoxFinish, finishKey(b.BoxFinish), { uv: uv('BoxFinish') }),
    rg: cmpCell(n3(b.RG), n3(b.RG), { uv: uv('RG') }),
    diff: cmpCell(n3(b.Differential), n3(b.Differential), { uv: uv('Differential') }),
    intDiff: cmpCell(n3(b.IntDiff), n3(b.IntDiff), { uv: uv('IntDiff') }),
    coreType: cmpCell(b.CoreType, coreKey(b.CoreType), { uv: uv('CoreType') }),
  } };
}
/* Pure: one column from a catalog entry + detail record at a weight (null = 15, labelled). */
function cmpColCatalog(e, d, weight) {
  var wt = weight || 15, s = specsOf(d, wt), shownW = wt;
  if (d && s.rg == null && s.diff == null) {
    var nw = nearestWeight(d, wt);
    if (nw != null) { var s2 = specsOf(d, nw); s.rg = s2.rg; s.diff = s2.diff; s.intDiff = s2.intDiff; shownW = nw; }
  }
  var wNote = shownW !== wt ? shownW + ' lb specs' : null;
  var spec = ballFromSpecs(s), met = d ? metricScore(spec, parseFinish(s.finish)) : null;
  var cc = coverClass(s.coverType, s.coverName), dct = s.coverType ? null : derivedCoverType(s.coverName);
  var band = catRGBand(s.rg, s.diff);
  return { kind: 'catalog', id: e.i, name: cleanName(e.n), mfg: e.m || '', loaded: !!d, weight: weight || null, cells: {
    weight: cmpCell(wt + ' lb', wt, { note: weight ? null : 'default' }),
    strength: cmpCell(met ? met.strength : null, met ? met.strength : null, { note: met ? 'factory' + (wNote ? ', ' + wNote : '') : null }),
    shape: cmpCell(met ? signed(met.shape) : null, met ? met.shape : null),
    band: cmpCell(band, band, { note: band && wNote ? wNote : null }),
    cover: cmpCell(s.coverType || dct, cc || (dct ? dct.toLowerCase() : null), { note: dct ? 'from name' : null }),
    finish: cmpCell(s.finish, finishKey(s.finish)),
    rg: cmpCell(n3(s.rg), n3(s.rg), { note: wNote && s.rg != null ? wNote : null }),
    diff: cmpCell(n3(s.diff), n3(s.diff), { note: wNote && s.diff != null ? wNote : null }),
    intDiff: cmpCell(n3(s.intDiff), n3(s.intDiff)),
    coreType: cmpCell(spec.CoreType, coreKey(spec.CoreType)),
  } };
}
var CMP_ROWS = [['weight', 'Weight'], ['strength', 'Strength'], ['shape', 'Shape'], ['band', 'RG / Diff band'], ['cover', 'Cover type'],
  ['finish', 'Factory finish'], ['rg', 'RG'], ['diff', 'Differential'], ['intDiff', 'Int. Diff'], ['coreType', 'Core type']];
/* Pure: rows with a differ flag. Only cells with a value count; needs two or more. */
function cmpRows(cols) {
  return CMP_ROWS.map(function (r) {
    var cells = cols.map(function (c) { return c.cells[r[0]] || cmpCell(null, null); });
    var keys = cells.map(function (c) { return c.key; }).filter(function (k) { return k != null; });
    var differ = keys.length >= 2 && keys.some(function (k) { return k !== keys[0]; });
    return { id: r[0], label: r[1], cells: cells, differ: differ };
  });
}
function cmpBuildCols(rows) {
  return _cmp.cols.map(function (c) {
    if (c.t === 'o') { var b = appBalls().filter(function (x) { return x.BallID == c.id; })[0]; return b ? cmpColOwned(b) : null; }
    var e = byIdIn(rows, c.id); if (!e) return null;
    var col = cmpColCatalog(e, _cmp.details[c.id] || null, c.w);
    col.loaded = Object.prototype.hasOwnProperty.call(_cmp.details, c.id);
    return col;
  }).filter(Boolean);
}
var CMP_HI = 'rgba(214,169,76,0.13)';
function cmpHTML(rows) {
  var cols = cmpBuildCols(rows), body = cmpRows(cols);
  var lw = 88, aw = 52, fit = cols.length <= 2;
  var stick = 'position:sticky;left:0;z-index:1;background:var(--bg0);';
  var td = 'padding:9px 6px;border-bottom:1px solid var(--border1);vertical-align:top;font-size:13px;color:var(--t1);overflow-wrap:anywhere;min-width:' + (fit ? '0' : '124px') + ';';
  var head = '<tr><th style="' + stick + 'width:' + lw + 'px;min-width:' + lw + 'px"></th>' + cols.map(function (c, i) {
    var thumb;
    if (c.kind === 'owned') {
      var src = null; try { if (typeof root.getBallImgSrc === 'function') src = root.getBallImgSrc(c.id, 'cover'); } catch (x) {}
      var ph = '<div style="width:36px;height:36px;border-radius:50%;background:var(--bg3);display:' + (src ? 'none' : 'flex') + ';align-items:center;justify-content:center;font-size:18px">\uD83C\uDFB3</div>';
      thumb = src ? '<span style="display:inline-flex"><img src="' + esc(src) + '" alt="" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'flex\'" style="width:36px;height:36px;border-radius:50%;object-fit:cover">' + ph + '</span>' : ph;
    } else thumb = thumbHTML({ i: c.id, m: c.mfg }, 36);
    return '<th style="padding:6px 8px 10px;text-align:left;vertical-align:top;font-weight:400;border-bottom:1px solid var(--border2);overflow-wrap:anywhere;min-width:' + (fit ? '0' : '124px') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start">' + thumb +
      '<button onclick="catCompareRemove(' + i + ')" aria-label="Remove" style="background:none;border:none;color:var(--t3);font-size:18px;padding:0 2px;cursor:pointer">\u00d7</button></div>' +
      '<div style="font-size:14px;font-weight:700;color:var(--t1);margin-top:6px;line-height:1.25">' + esc(c.name) + '</div>' +
      '<div style="font-size:11px;color:var(--t2);margin-top:2px">' + esc(c.mfg) + '</div>' +
      '<div style="margin-top:4px"><span style="' + (c.kind === 'owned' ? CHIP_T : CHIP_G) + ';margin-left:0">' + (c.kind === 'owned' ? 'ARSENAL' : 'CATALOG') + '</span></div></th>';
  }).join('') + (cols.length < CMP_MAX ? '<th style="padding:6px 0 6px 4px;vertical-align:top;width:' + aw + 'px;min-width:' + aw + 'px;border-bottom:1px solid var(--border2)"><button onclick="catComparePick()" aria-label="Add ball" style="width:100%;min-height:84px;border:1px dashed var(--border2);border-radius:12px;background:none;color:var(--teal);font-size:12px;font-weight:700;cursor:pointer;padding:0">+<br>Add</button></th>' : '') + '</tr>';
  var anyUv = false;
  var trs = body.map(function (r) {
    var hi = r.differ ? 'background:' + CMP_HI + ';' : '';
    return '<tr><td style="' + stick + td + 'font-size:12px;color:' + (r.differ ? 'var(--gold)' : 'var(--t2)') + ';font-weight:' + (r.differ ? '700' : '500') + ';min-width:' + lw + 'px">' + r.label + '</td>' +
      r.cells.map(function (cell, i) {
        var col = cols[i], v;
        if (r.id === 'weight' && col.kind === 'catalog') {
          v = '<select onchange="catCompareWeight(' + i + ',this.value)" style="font-size:13px;background:var(--bg2);color:var(--t1);border:1px solid var(--border1);border-radius:8px;padding:3px 4px">' +
            WEIGHTS.map(function (w) { return '<option value="' + w + '"' + (w === (col.weight || 15) ? ' selected' : '') + '>' + w + ' lb</option>'; }).join('') + '</select>';
        } else if (col.kind === 'catalog' && !col.loaded && r.id !== 'weight') v = '<span style="color:var(--t3)">\u2026</span>';
        else v = cell.txt == null ? '<span style="color:var(--t3)">--</span>' : esc(cell.txt);
        if (cell.approx) anyUv = true;
        if (cell.uv && cell.txt != null) { anyUv = true; v += '<span style="font-size:9px;font-weight:700;color:var(--gold);margin-left:4px;white-space:nowrap;display:inline-block">unv</span>'; }
        if (cell.note) v += '<div style="font-size:10px;color:var(--t3);margin-top:2px">' + esc(cell.note) + '</div>';
        return '<td style="' + td + hi + '">' + v + '</td>';
      }).join('') + (cols.length < CMP_MAX ? '<td style="' + td + '"></td>' : '') + '</tr>';
  }).join('');
  var nDiff = body.filter(function (r) { return r.differ; }).length;
  return '<div style="padding:12px 16px 6px;display:flex;align-items:center;gap:12px"><button onclick="catCompareClose()" style="' + BACK + '" aria-label="Back">\u2039</button>' +
      '<div><div style="font-size:20px;font-weight:800;color:var(--t1)">Compare</div><div style="font-size:12px;color:var(--t3)">' +
      (cols.length < 2 ? 'Add a ball to compare' : nDiff + ' row' + (nDiff === 1 ? '' : 's') + ' differ \u00b7 highlighted') + '</div></div></div>' +
    '<div style="flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:0 16px 16px">' +
      '<table style="border-collapse:separate;border-spacing:0;' + (fit ? 'width:100%;table-layout:fixed' : '') + '">' +
        (fit ? '<colgroup><col style="width:' + lw + 'px">' + cols.map(function () { return '<col>'; }).join('') + (cols.length < CMP_MAX ? '<col style="width:' + aw + 'px">' : '') + '</colgroup>' : '') + head + trs + '</table>' +
      '<div style="font-size:11px;color:var(--t3);margin-top:10px;line-height:1.5">Strength 0\u2013100 and Shape \u221250\u2026+50 are this app\'s own measures (MET-1). Owned balls use their latest surface; catalog balls use factory finish at the weight shown.' +
      (anyUv ? ' <b style="color:var(--gold)">unv</b> = not yet confirmed by the catalog or by you; ~ = Strength built on such a value.' : '') + '</div>' +
    '</div>';
}
function cmpRender() {
  var ov = document.getElementById('cmp-ov'); if (!ov) return;
  catLoad().then(function (rows) {
    rows = rows || [];
    var sc = ov.querySelector('[style*="overflow:auto"]'), top = sc ? sc.scrollTop : 0, left = sc ? sc.scrollLeft : 0;
    ov.innerHTML = cmpHTML(rows);
    var sc2 = ov.querySelector('[style*="overflow:auto"]'); if (sc2) { sc2.scrollTop = top; sc2.scrollLeft = left; }
    _cmp.cols.forEach(function (c) {
      if (c.t !== 'c' || Object.prototype.hasOwnProperty.call(_cmp.details, c.id)) return;
      var e = byIdIn(rows, c.id); if (!e) return;
      if (_cmp.pending[c.id]) return; _cmp.pending[c.id] = 1;
      catDetail(e).then(function (d) { _cmp.details[c.id] = d || null; delete _cmp.pending[c.id]; cmpRender(); });
    });
  });
}
function cmpParse(x) {
  var m = /^([oc]):(.+)$/.exec(String(x || '')); if (!m) return null;
  return m[1] === 'o' ? { t: 'o', id: +m[2] } : { t: 'c', id: m[2], w: null };
}
function cmpHas(c) { return _cmp.cols.some(function (x) { return x.t === c.t && String(x.id) === String(c.id) && (x.t === 'o' || x.w === c.w); }); }
/* list: ['o:12', 'c:storm-phaze-ii', ...]; opens with those columns (max 4). */
function catCompareOpen(list) {
  if (typeof document === 'undefined') return;
  _cmp.cols = []; _cmp.details = {}; _cmp.pending = {};
  (list || []).forEach(function (x) { var c = typeof x === 'object' ? x : cmpParse(x); if (c && _cmp.cols.length < CMP_MAX && !cmpHas(c)) _cmp.cols.push(c); });
  var old = document.getElementById('cmp-ov'); if (old) old.parentNode.removeChild(old);
  document.body.appendChild(overlay('cmp-ov', 920));
  cmpRender();
  if (_cmp.cols.length < 2) catComparePick();
}
function catCompareFromSheet() { catCompareOpen([{ t: 'c', id: _sheet.id, w: _sheet.weight || null }]); }
function catCompareClose() { ['cmp-pick-ov', 'cmp-ov'].forEach(function (id) { var el = document.getElementById(id); if (el) el.parentNode.removeChild(el); }); }
function catCompareRemove(i) { _cmp.cols.splice(i, 1); cmpRender(); }
function catCompareWeight(i, w) { var c = _cmp.cols[i]; if (c && c.t === 'c') { c.w = parseInt(w, 10) || null; cmpRender(); } }
/* Add a column: Arsenal (owned, not archived) or Catalog search. */
var _cmpPickTab = 'o';
function cmpPickBody(rows, q) {
  if (_cmpPickTab === 'o') {
    var list = appBalls().filter(function (b) { return !b.Archived && !cmpHas({ t: 'o', id: b.BallID }); })
      .sort(function (a, b) { return String(a.BallName).localeCompare(String(b.BallName)); });
    if (!list.length) return '<div style="font-size:13px;color:var(--t3);padding:16px 2px">Every ball is already in the comparison.</div>';
    return list.map(function (b) {
      return '<div onclick="catCompareAdd(\'o:' + b.BallID + '\')" style="padding:11px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' +
        '<div style="font-size:15px;font-weight:600;color:var(--t1)">' + esc(b.BallName) + '</div>' +
        '<div style="font-size:12px;color:var(--t2);margin-top:2px">' + esc(b.MFG || '') + (b.Weight ? ' \u00b7 ' + b.Weight + ' lb' : '') + (catMetricChip(b) ? ' \u00b7 ' + esc(catMetricChip(b)) : '') + '</div></div>';
    }).join('');
  }
  if (!rows || !rows.length) return '<div style="font-size:13px;color:var(--t3);padding:16px 2px">The catalog isn\'t installed on this device yet.</div>';
  if (!q || q.replace(/\s/g, '').length < 2) return '<div style="font-size:13px;color:var(--t3);padding:16px 2px">Type a ball or brand name.</div>';
  var hits = addSearchIn(rows, q, 40);
  if (!hits.length) return '<div style="font-size:13px;color:var(--t3);padding:16px 2px">No match in the USBC list.</div>';
  return hits.map(function (e) {
    return '<div onclick="catCompareAdd(\'c:' + esc(e.i) + '\')" style="display:flex;align-items:center;gap:10px;padding:10px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' + thumbHTML(e, 32) +
      '<div style="min-width:0"><div style="font-size:15px;font-weight:600;color:var(--t1)">' + esc(cleanName(e.n)) + '</div>' +
      '<div style="font-size:12px;color:var(--t2);margin-top:2px">' + esc(e.m) + (e.y ? ' \u00b7 USBC ' + esc(e.y) : '') + (e.s ? ' \u00b7 <span style="color:var(--teal)">\u25cf specs</span>' : '') + '</div></div></div>';
  }).join('');
}
function catComparePick() {
  if (_cmp.cols.length >= CMP_MAX) { if (root.toast) root.toast('Up to ' + CMP_MAX + ' balls'); return; }
  var old = document.getElementById('cmp-pick-ov'); if (old) old.parentNode.removeChild(old);
  var ov = overlay('cmp-pick-ov', 925);
  var tab = function (t, l) { return '<button onclick="catComparePickTab(\'' + t + '\')" style="' + (_cmpPickTab === t ? BTN_P : BTN_G) + 'flex:1;padding:8px 0;font-size:13px">' + l + '</button>'; };
  ov.innerHTML = '<div style="padding:12px 16px 6px;display:flex;align-items:center;gap:12px"><button onclick="catComparePickClose()" style="' + BACK + '" aria-label="Back">\u2039</button>' +
      '<div style="font-size:18px;font-weight:800;color:var(--t1)">Add a ball</div></div>' +
    '<div style="padding:4px 16px 8px;display:flex;gap:6px">' + tab('o', 'Arsenal') + tab('c', 'Catalog') + '</div>' +
    (_cmpPickTab === 'c' ? '<div style="padding:0 16px 6px"><input id="cmp-pick-q" class="finput" placeholder="Search the USBC list" autocomplete="off" autocorrect="off" oninput="catComparePickSearch(this.value)" style="width:100%;box-sizing:border-box"></div>' : '') +
    '<div id="cmp-pick-list" style="flex:1;overflow-y:auto;padding:0 16px 16px;-webkit-overflow-scrolling:touch"></div>';
  document.body.appendChild(ov);
  catComparePickSearch('');
  var q = document.getElementById('cmp-pick-q'); if (q) q.focus();
}
function catComparePickTab(t) { _cmpPickTab = t === 'c' ? 'c' : 'o'; catComparePick(); }
function catComparePickSearch(q) {
  catLoad().then(function (rows) { var box = document.getElementById('cmp-pick-list'); if (box) box.innerHTML = cmpPickBody(rows, q); });
}
function catComparePickClose() { var el = document.getElementById('cmp-pick-ov'); if (el) el.parentNode.removeChild(el); }
function catCompareAdd(x) {
  var c = cmpParse(x);
  if (c && !cmpHas(c) && _cmp.cols.length < CMP_MAX) _cmp.cols.push(c);
  catComparePickClose(); cmpRender();
}


root.CATALOG_JS_VERSION = CAT_VERSION;
root.catPickerMount = catPickerMount;
root.catApprovalsOpen = catApprovalsOpen; root.catPageOpen = catPageOpen; root.catPageClose = catPageClose; root.catPageUseSel = catPageUseSel; root.catPageUseVal = catPageUseVal; root.catPageImg = catPageImg; root.catPickOpen = catPickOpen; root.catPickFilter = catPickFilter; root.catPickChoose = catPickChoose; root.catPickClose = catPickClose; root.catSpecReviewOpen = catSpecReviewOpen; root.catSpecReviewClose = catSpecReviewClose; root.catSpecReviewAct = catSpecReviewAct; root.catSpecReviewBulk = catSpecReviewBulk; root.catSpecReviewPage = catSpecReviewPage; root.catTagPick = catTagPick; root.catTagCancel = catTagCancel; root.catVerifyRefresh = catVerifyRefresh; root.catVerifyDismiss = catVerifyDismiss; root.catVerifyRetry = catVerifyRetry; root.catVerifyOpenApprovals = catVerifyOpenApprovals; root.catVerifyPublish = catVerifyPublish; root.catVerifyApply = catVerifyApply; root.catVerifyTick = vfyTick; root.catVerifyState = vfyActive; root.catApprovalsRetryStaged = catApprovalsRetryStaged; root.apStagedErrText = apStagedErrText; root.catApprovalsClose = catApprovalsClose; root.catApprovalsSaveToken = catApprovalsSaveToken;
root.catApprovalsForgetToken = catApprovalsForgetToken; root.catApprovalsChangeToken = catApprovalsChangeToken; root.catApprovalsPage = catApprovalsPage; root.catApprovalsFilter = catApprovalsFilter;
root.catApprovalsTick = catApprovalsTick; root.catApprovalsEdit = catApprovalsEdit; root.catApprovalsEditClose = catApprovalsEditClose; root.catApprovalsEditSave = catApprovalsEditSave; root.catAddSpecsOnly = catAddSpecsOnly; root.catVerifyNow = catVerifyNow; root.catImagesSet = catImagesSet;
root.catImagesRefresh = catImagesRefresh; root.catImagesStatus = catImagesStatus; root.catImageFor = catImageFor; root.catApprovalsSend = catApprovalsSend; root.catApprovalsPublish = catApprovalsPublish; root.catPickerSearch = catPickerSearch;
root.catPick = catPick; root.catUnlink = catUnlink; root.catPickValue = catPickValue;
root.catLinkLabel = catLinkLabel; root.catReviewOpen = catReviewOpen;
root.catReviewLink = catReviewLink; root.catReviewSkip = catReviewSkip;
root.catReviewResetSkips = catReviewResetSkips;
root.catOpenAddSearch = catOpenAddSearch; root.catCloseAddSearch = catCloseAddSearch;
root.catAddSearch = catAddSearch; root.catAddManual = catAddManual; root.catAddBrand = catAddBrand;
root.catAddBubble = catAddBubble; root.catAddLoosen = catAddLoosen; root.catAddBrandPick = catAddBrandPick; root.catAddBrandToggle = catAddBrandToggle; root.catAddBrandPickClose = catAddBrandPickClose;
root.catAddDetail = catAddDetail; root.catSheetClose = catSheetClose; root.catSheetWeight = catSheetWeight;
root.catAddToArsenal = catAddToArsenal; root.catFillFromCatalog = catFillFromCatalog;
root.catSpecSource = catSpecSource; root.catDetail = catDetail;
root.catSpecUnverified = catSpecUnverified; root.catUnverifiedTag = catUnverifiedTag;
root.catAutoVerify = catAutoVerify; root.catAutoVerifyAll = catAutoVerifyAll;
root.catCompareOpen = catCompareOpen; root.catCompareFromSheet = catCompareFromSheet; root.catCompareClose = catCompareClose; root.catCompareRemove = catCompareRemove;
root.catCompareWeight = catCompareWeight; root.catComparePick = catComparePick; root.catComparePickTab = catComparePickTab; root.catComparePickSearch = catComparePickSearch;
root.catComparePickClose = catComparePickClose; root.catCompareAdd = catCompareAdd;
root.catMetric = catMetric; root.catRGBand = catRGBand; root.catMetricChip = catMetricChip; root.catMetricHTML = catMetricHTML;
root.catIdentityLocked = catIdentityLocked; root.catAuditOpen = catAuditOpen;
root.catLookup = function (mfg, name) { return catLoad().then(function (rows) { return lookupIn(rows, mfg, name); }); };
root.catSearch = function (q, n) { return catLoad().then(function (rows) { return searchIn(rows, q, n); }); };
root._catStep5 = { norm: norm, modelKey: modelKey, lookupIn: lookupIn, searchIn: searchIn, reviewModel: reviewModel,
                   pickerBodyHTML: pickerBodyHTML, reviewHTML: reviewHTML, resultsHTML: resultsHTML,
                   setPick: function (p) { _pick = p; }, auditModel: auditModel, auditHTML: auditHTML,
                   addListHTML: addListHTML, addSearchIn: addSearchIn, newest: newest, bubbleFilter: bubbleFilter, discontinuedOf: discontinuedOf, addFilters: function () { return _af; },
                   specsOf: specsOf, shardMap: shardMap, shardKeyFor: shardKeyFor, detailFiles: detailFiles,
                   buildOwnedBall: buildOwnedBall, ballFromSpecs: ballFromSpecs, fillPlan: fillPlan,
                   catSpecSource: catSpecSource, setFilled: function (f) { _filled = f; },
                   imgLinksFrom: imgLinksFrom, sheetState: function () { return _sheet; }, mergeOverrides: mergeOverrides, withLocalCorrection: withLocalCorrection, apApplyOverride: apApplyOverride, apOverrideFrom: apOverrideFrom, bowwwlLinks: bowwwlLinks, apStagedFor: apStagedFor, apAsDetail: apAsDetail, apRangeNotes: apRangeNotes, derivedCoverType: derivedCoverType, specGaps: specGaps, nearestWeight: nearestWeight, addListHTML: addListHTML, sourceForBrand: sourceForBrand, apParseIssue: apParseIssue, apPages: apPages, apApplyTicks: apApplyTicks, apConflict: apConflict, apNums: apNums,
                   verifyPlan: verifyPlan, pgvClean: pgvClean, vocabMerge: vocabMerge, vocabSplit: vocabSplit, familyOf: familyOf, srvRows: srvRows, srvApply: srvApply, srvStagedRow: srvStagedRow, vfyPagesFor: vfyPagesFor, vfyEstimateFrom: vfyEstimateFrom, tagLine: tagLine, tagLines: tagLines, tagValueFor: tagValueFor, vfyPickRun: vfyPickRun, vfyClassify: vfyClassify, vfyCardHTML: vfyCardHTML, specMatch: specMatch, coreNameMatch: coreNameMatch, DIFF_MAX: DIFF_MAX, metricUnverified: metricUnverified, catSpecUnverified: catSpecUnverified,
                   metricScore: metricScore, parseFinish: parseFinish, rgBand: rgBand, diffBand: diffBand, coverClass: coverClass,
                   catMetric: catMetric, sheetHTML: sheetHTML, cmpColOwned: cmpColOwned, cmpColCatalog: cmpColCatalog, cmpRows: cmpRows,
                   cmpHTML: cmpHTML, cmpState: function () { return _cmp; }, setSheet: function (x) { _sheet = x; } };

root.catCheck = catCheck;
root.catLoad = catLoad;
root.catStatus = catStatus;
root.catClear = catClear;
root._catInternals = { env: env, shouldCheck: shouldCheck, verifyAndParse: verifyAndParse,
                       hex16: hex16, readMeta: readMeta, CAT_BASE: CAT_BASE,
                       reset: function () { _rows = null; _inflight = null; } };

})(typeof window !== 'undefined' ? window : globalThis);
