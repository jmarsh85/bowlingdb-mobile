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
var CAT_VERSION  = 'v30.212';
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
    var _va = vfyActive(), _vmine = !!(e && _va && _va.catalogId === e.i);
    if (e && sourceForBrand(e.m) && (_vmine || SPEC_FIELDS.some(function (f) { return catSpecUnverified(b, f); })))
      el.innerHTML += vfySlotHTML(e.i, '<div><button style="' + BTN_G + 'margin-top:6px;padding:5px 10px;font-size:11px" onclick="catVerifyNow(\'' + esc(e.m) + '\',\'' + esc(e.i) + '\',' + JSON.stringify(b.BallID).replace(/"/g, '&quot;') + ')">Verify now</button> <button style="' + BTN_G + 'margin-top:6px;padding:5px 10px;font-size:11px" onclick="catSpecReviewOpen(' + JSON.stringify(b.BallID).replace(/"/g, '&quot;') + ')">Review specs</button></div>');
    /* v30.175: Look up (split view: bowwwl / maker page above your fields) */
    if (e) el.innerHTML += '<div><button style="' + BTN_G + 'margin-top:6px;padding:5px 10px;font-size:11px" onclick="catLookBall(' + JSON.stringify(b.BallID).replace(/"/g, '&quot;') + ')">Look up</button></div>';
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
function withLocalCorrection(id, d, oIn) {
  var o = oIn !== undefined ? oIn : localOverrides()[id];   // v30.187: the sheet passes repo + device corrections in dev mode
  if (!o) return d;
  var x = JSON.parse(JSON.stringify(d || {}));
  x.Cover = x.Cover || {}; x.Core = x.Core || {}; x.SpecsByWeight = x.SpecsByWeight || {};
  if (o.coverName) x.Cover.Name = o.coverName;   // v30.187: was never applied, so the sheet kept the old coverstock name
  if (o.coverType) x.Cover.Type = o.coverType; if (o.finish) x.Cover.Finish = o.finish;
  if (o.core) x.Core.Name = o.core; if (o.coreType) x.Core.Type = o.coreType;
  if (o.released) x.DateReleased = o.released;
  Object.keys(o.weights || {}).forEach(function (w) { x.SpecsByWeight[w] = Object.assign({}, x.SpecsByWeight[w] || {}, o.weights[w]); });
  x._local = { source: o.source, at: o.at };
  return x;
}
/* v30.187: what the Add a Ball sheet shows. Everyone: catalog + this device's corrections.
   Dev mode: also your saved repo corrections not yet published, so the card matches Correct specs. */
function sheetDetail(id, raw) {
  var loc = localOverrides()[id], rep = catFixAllowed() && _ovr ? _ovr[id] : null;
  var o = rep ? mergeOverrides(rep, loc) : loc;
  if (!raw && !o) return raw;
  var x = withLocalCorrection(id, raw, o || null);
  if (x && x._local && rep) x._local.repo = true;
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
var _af = { brands: [], cover: [], core: [], specs: true, disc: false, show: 'current', extra: [] };
/* v30.209 WB-6: brand families. A family row picks every brand in it; > opens it to pick one. Others stand alone. */
var BRAND_GROUPS = [['Brunswick', /brunswick|dv8|radical|ebonite|hammer|columbia|track/], ['Storm', /storm|roto ?grip|900 ?global/]];
function brandGroupOf(m) { var t = String(m || '').toLowerCase(); for (var i = 0; i < BRAND_GROUPS.length; i++) if (BRAND_GROUPS[i][1].test(t)) return BRAND_GROUPS[i][0]; return m; }
/* Pure: brand -> count of rows, grouped: [{ g, n, brands: [{ m, n }] }], families first, then A-Z */
function brandTree(rows) {
  var g = {};
  (rows || []).forEach(function (e) { var k = brandGroupOf(e.m), x = g[k] = g[k] || { g: k, n: 0, b: {} }; x.n++; x.b[e.m] = (x.b[e.m] || 0) + 1; });
  var fam = BRAND_GROUPS.map(function (x) { return x[0]; });
  return Object.keys(g).sort(function (a, b) { var fa = fam.indexOf(a), fb = fam.indexOf(b); if (fa >= 0 || fb >= 0) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb); return a.localeCompare(b); })
    .map(function (k) { var x = g[k]; return { g: k, n: x.n, brands: Object.keys(x.b).sort(function (a, b) { return x.b[b] - x.b[a] || a.localeCompare(b); }).map(function (m) { return { m: m, n: x.b[m] }; }) }; });
}
var SHOW_OPTS = [['current', 'Current'], ['disc', 'Discontinued'], ['all', 'All']];
var COVER_BUBBLES = [['S', 'Solid'], ['P', 'Pearl'], ['H', 'Hybrid'], ['U', 'Urethane']];
var CORE_BUBBLES = [['a', 'Asym'], ['s', 'Sym']];
function discontinuedOf(e, year) {
  if (!e) return null;
  var _st = stEntry(e.i); if (_st && _st.status === 'retired') return 'retired';   // v30.185: yours (manual or rejected)
  if (e.r === 1) return 'retired';
  if (e.r === 0) return null;
  if (tgFresh().current[e.i]) return null;   // v30.207: you said it's still current
  var y = parseInt(e.y, 10), now = year || new Date().getFullYear();
  return isFinite(y) && y < now - 3 ? 'likely' : null;
}
/* Pure: rows passing the bubbles (no text). */
function bubbleFilter(rows, f, year) {
  var bs = {}; (f.brands || []).forEach(function (b) { bs[norm(b)] = 1; });
  var hasB = (f.brands || []).length, hasC = (f.cover || []).length, hasK = (f.core || []).length;
  return rows.filter(function (e) {
    if (catIsRejected(e)) return false;   // v30.185: rejected balls are never offered
    if (catIsHeld(e)) return false;       // v30.200 HOLD-1: held until you approve it (Review new balls)
    if (e.a) return false;                // v30.202 WB-1: Archived (no specs, approved before 2021): only Enter manually finds it
    if (f.specs && !e.s) return false;
    var show = f.show && !f.disc ? f.show : f.disc ? 'all' : 'current', dc = discontinuedOf(e, year);   // v30.209: Show dropdown
    if (show === 'current' && dc) return false;
    if (show === 'disc' && !dc) return false;
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
/* v30.209 WB-6: Brand / Cover / Core / Show dropdowns (replaces the bubble rows) */
var DD = 'border-radius:10px;padding:7px 10px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;background:var(--bg2);';
function ddStyle(on) { return DD + (on ? 'color:var(--teal);border:1px solid rgba(0,217,217,0.45)' : 'color:var(--t1);border:1px solid var(--border1)'); }
function brandLabel() {
  var b = _af.brands; if (!b.length) return 'All brands';
  if (b.length === 1) return b[0];
  var g = brandGroupOf(b[0]); if (b.every(function (x) { return brandGroupOf(x) === g; }) && _af.brandGroup === g) return g + ' family';
  return b.length + ' brands';
}
function filtersHTML(rows) {
  var hasCv = rows.some(function (e) { return e.cv; }), hasCo = rows.some(function (e) { return e.co; });
  var sel = function (id, cur, opts, js) {
    return '<select id="' + id + '" onchange="' + js + '" style="' + ddStyle(!!cur && cur !== 'current') + 'width:100%;min-width:0">' +
      opts.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === (cur || '') ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
  };
  return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:3px 0">' +
    '<button id="cat-dd-brand" onclick="catAddBrandPick()" style="' + ddStyle(_af.brands.length > 0) + 'width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:left">' + esc(brandLabel()) + ' \u25be</button>' +
    (hasCv ? sel('cat-dd-cover', _af.cover[0], [['', 'Any cover']].concat(COVER_BUBBLES), "catAddSet('c',this.value)") : '') +
    (hasCo ? sel('cat-dd-core', _af.core[0], [['', 'Any core']].concat(CORE_BUBBLES), "catAddSet('k',this.value)") : '') +
    sel('cat-dd-show', _af.show || 'current', SHOW_OPTS, "catAddSet('show',this.value)") + '</div>';
}
function catAddSet(kind, v) {
  if (kind === 'c') _af.cover = v ? [v] : [];
  else if (kind === 'k') _af.core = v ? [v] : [];
  else if (kind === 'show') { _af.show = v || 'current'; _af.disc = false; }
  catAddRefresh();
}
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
    var loose = bubbleFilter(pool, { brands: _af.brands, cover: _af.cover, core: _af.core, specs: false, show: 'all' }).length;
    return '<div style="font-size:13px;color:var(--t2);padding:16px 2px;line-height:1.6">No match' + (text ? ' in the USBC list' : '') + '.' +
      (loose ? ' <a href="#" onclick="event.preventDefault();catAddLoosen()" style="color:var(--teal)">Show ' + loose + ' ' + (_af.show === 'current' ? 'including discontinued and without specs' : 'without specs') + '</a>' : '') + '</div>';
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
function catAddLoosen() { _af.specs = false; _af.disc = false; _af.show = 'all'; catAddRefresh(); }
function catAddRefresh() { var q = document.getElementById('cat-add-q'); catAddSearch(q ? q.value : ''); }
function catAddSpecsOnly(on) { _af.specs = !!on; catAddRefresh(); }   // kept for older callers
/* v30.209 WB-6: the Brand dropdown. Counts follow the other filters (Show Current lists only brands with
   current balls). Families: tap the row for every brand in it, > to open it and pick one. */
var _bp = { open: {} };
function catAddBrandPick() {
  catLoad().then(function (rows) {
    var pool = bubbleFilter(rows, { brands: [], cover: _af.cover, core: _af.core, specs: _af.specs, show: _af.show, disc: _af.disc });
    var tree = brandTree(pool), mine = yourBrands(), cnt = {}; pool.forEach(function (e) { cnt[e.m] = (cnt[e.m] || 0) + 1; });
    var on = function (m) { return _af.brands.indexOf(m) >= 0; };
    var line = function (label, n, js, sel, indent, extra) {
      return '<div style="display:flex;align-items:center;border-bottom:1px solid var(--border1)"><div onclick="' + js + '" style="flex:1;display:flex;justify-content:space-between;padding:11px 2px 11px ' + (indent ? 22 : 2) + 'px;cursor:pointer;font-size:15px;color:' + (sel ? 'var(--teal)' : 'var(--t1)') + '">' +
        '<span>' + (sel ? '\u2713 ' : '') + label + '</span><span style="font-size:12px;color:var(--t3);padding-left:8px">' + n + '</span></div>' + (extra || '') + '</div>';
    };
    var h = line('All brands', pool.length, 'catAddBrandSet(null)', !_af.brands.length);
    var mineH = mine.filter(function (m) { return cnt[m]; }).map(function (m) { return line(esc(m), cnt[m], "catAddBrandSet('b','" + jsq(m) + "')", _af.brands.length === 1 && on(m)); }).join('');
    if (mineH) h += '<div style="font-size:11px;font-weight:700;color:var(--t3);letter-spacing:.5px;margin:14px 2px 2px">YOUR BRANDS</div>' + mineH;
    h += '<div style="font-size:11px;font-weight:700;color:var(--t3);letter-spacing:.5px;margin:14px 2px 2px">ALL BRANDS</div>';
    tree.forEach(function (g) {
      if (g.brands.length === 1 && g.brands[0].m === g.g) { h += line(esc(g.g), g.n, "catAddBrandSet('b','" + jsq(g.g) + "')", _af.brands.length === 1 && on(g.g)); return; }
      var open = !!_bp.open[g.g], famOn = _af.brandGroup === g.g && g.brands.every(function (b) { return on(b.m); });
      h += line('<b>' + esc(g.g) + '</b> <span style="font-size:12px;color:var(--t3)">' + g.brands.length + ' brands</span>', g.n, "catAddBrandSet('g','" + jsq(g.g) + "')", famOn, false,
        '<button onclick="catAddBrandOpen(\'' + jsq(g.g) + '\')" aria-label="Open" style="background:none;border:none;color:var(--t2);font-size:20px;padding:6px 10px;cursor:pointer">' + (open ? '\u02c5' : '\u203a') + '</button>');
      if (open) g.brands.forEach(function (b) { h += line(esc(b.m), b.n, "catAddBrandSet('b','" + jsq(b.m) + "')", _af.brands.length === 1 && on(b.m), true); });
    });
    var ov = document.getElementById('cat-brand-ov'), fresh = !ov;
    if (fresh) ov = overlay('cat-brand-ov', 905);
    ov.innerHTML = '<div style="padding:12px 16px 6px;display:flex;align-items:center;gap:12px"><button onclick="catAddBrandPickClose()" style="' + BACK + '" aria-label="Back">\u2039</button>' +
      '<div style="flex:1"><div style="font-size:18px;font-weight:800;color:var(--t1)">Brand</div><div style="font-size:11px;color:var(--t3)">' + esc((SHOW_OPTS.filter(function (o) { return o[0] === (_af.show || 'current'); })[0] || [0, 'Current'])[1]) + ' balls \u00b7 tap a family for all its brands, \u203a to pick one</div></div></div>' +
      '<div style="flex:1;overflow-y:auto;padding:0 16px 16px;-webkit-overflow-scrolling:touch">' + h + '</div>';
    if (fresh) document.body.appendChild(ov);
  });
}
function catAddBrandOpen(g) { _bp.open[g] = !_bp.open[g]; catAddBrandPick(); }
function catAddBrandSet(kind, v) {
  if (!kind) { _af.brands = []; _af.brandGroup = null; }
  else if (kind === 'b') { _af.brands = [v]; _af.brandGroup = null; }
  else {
    return catLoad().then(function (rows) {
      var b = {}; rows.forEach(function (e) { if (brandGroupOf(e.m) === v) b[e.m] = 1; });
      _af.brands = Object.keys(b).sort(); _af.brandGroup = v; catAddBrandPickClose(); catAddRefresh();
    });
  }
  catAddBrandPickClose(); catAddRefresh();
}
function catAddBrandToggle(b) {   // kept for older callers
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
  _af.specs = true; _af.disc = false; _af.show = 'current'; _af.brands = []; _af.brandGroup = null; _af.cover = []; _af.core = [];   // each visit starts on current balls with specs
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
  ['cat-brand-ov', 'cat-sheet-ov', 'cat-old-ov', 'cat-search-ov'].forEach(function (id) { var el = document.getElementById(id); if (el) el.parentNode.removeChild(el); });
}
function catAddSearch(q) {
  catLoad().then(function (rows) {
    var box = document.getElementById('cat-add-results');
    var bb = document.getElementById('cat-add-bubbles'); if (bb) bb.innerHTML = filtersHTML(rows);
    if (box) { box.innerHTML = addListHTML(rows, q, ownedIndex(rows)); markPartials(box, rows); }
  });
}
function catAddBrand(b) { if (_af.brands.indexOf(b) < 0) _af.brands.push(b); catAddRefresh(); }
function catAddManual() {
  /* v30.202 WB-1: with archived balls in the catalog, Enter manually first offers them as a starting point */
  catLoad().then(function (rows) {
    if (!rows.some(function (e) { return e.a; })) { catAddBlank(); return; }
    var ov = overlay('cat-old-ov', 905);
    ov.innerHTML = '<div style="padding:12px 16px 6px;display:flex;align-items:center;gap:12px"><button onclick="catOldClose()" style="' + BACK + '" aria-label="Back">\u2039</button>' +
      '<div style="flex:1;min-width:0"><div style="font-size:18px;font-weight:800;color:var(--t1)">Enter manually</div><div style="font-size:11px;color:var(--t3)">Older balls (before 2021) without specs are kept here</div></div></div>' +
      '<div style="padding:4px 16px 6px"><input id="cat-old-q" class="bdet-field-input" type="search" placeholder="Find in older catalog: brand or name" autocomplete="off" autocorrect="off" autocapitalize="off" oninput="catOldSearch(this.value)" style="width:100%;box-sizing:border-box;font-size:16px"></div>' +
      '<div id="cat-old-results" style="flex:1;overflow-y:auto;padding:0 16px 12px;-webkit-overflow-scrolling:touch"><div style="font-size:13px;color:var(--t2);padding:14px 2px;line-height:1.5">Type a brand or name to start from an older catalog ball (its name, brand and year are filled in). Or start a blank ball.</div></div>' +
      '<div style="padding:10px 16px;border-top:1px solid var(--border1)"><button onclick="catAddBlank()" style="' + BTN_G + 'width:100%;padding:11px;font-size:13px">Blank ball</button></div>';
    document.body.appendChild(ov);
  });
}
function catOldSearch(q) {
  catLoad().then(function (rows) {
    var box = document.getElementById('cat-old-results'); if (!box) return;
    var t = norm(q || '');
    if (t.replace(/\s/g, '').length < 2) { box.innerHTML = '<div style="font-size:13px;color:var(--t2);padding:14px 2px">Type at least 2 letters.</div>'; return; }
    var hit = rows.filter(function (e) { return e.a && !catIsRejected(e) && norm(e.m + ' ' + e.n).indexOf(t) >= 0; })
      .map(function (e) { return { e: e, sc: oldMatchScore(e, t) }; })
      .sort(function (a, b) { return (b.sc - a.sc) || String(b.e.y || '').localeCompare(String(a.e.y || '')) || cleanName(a.e.n).localeCompare(cleanName(b.e.n)); })
      .map(function (x) { return x.e; });
    box.innerHTML = hit.length ? hit.slice(0, 50).map(function (e) {
      return '<div onclick="catAddDetail(\'' + jsq(e.i) + '\')" style="display:flex;align-items:center;gap:12px;padding:10px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' + thumbHTML(e, 40) +
        '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:600;color:var(--t1)">' + esc(cleanName(e.n)) + '</div><div style="font-size:12px;color:var(--t2)">' + esc(e.m) + (e.y ? ' \u00b7 ' + esc(e.y) : '') + ' \u00b7 older catalog</div></div></div>';
    }).join('') + (hit.length > 50 ? '<div style="font-size:12px;color:var(--t3);padding:12px 2px">' + (hit.length - 50) + ' more \u00b7 type to narrow</div>' : '')
      : '<div style="font-size:13px;color:var(--t2);padding:14px 2px">No older ball matches. Use Blank ball.</div>';
  });
}
/* v30.203 Pure: closest match first. Name is the query (5), starts with it (4), it starts at a word
   in the name (3), brand + name starts with it (2), anywhere else (1, e.g. "t zone" inside "Combat Zone"). */
function oldMatchScore(e, t) {
  var n = norm(cleanName(e.n)), full = norm(e.m + ' ' + cleanName(e.n));
  if (n === t) return 5;
  if (n.indexOf(t) === 0) return 4;
  /* words keep their spaces here (norm drops them): "zone" starts a word in "Combat Zone" */
  var words = cleanName(e.n).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(function (w, i) { return norm(words.slice(i).join(' ')).indexOf(t) === 0; })) return 3;
  if (full.indexOf(t) === 0) return 2;
  return 1;
}
/* v30.204 WB-3: the Catalog workbench lives in workbench.js (dev mode), loaded on first use */
/* v30.204: Correct specs for a ball with a read already in hand (the workbench's Review): the editor opens,
   then the Found on the page preview over it, as Paste page & fill does */
function catCorrectWithParsed(id, parsed, after) {
  return catCorrectFor(id, after).then(function (e) {
    if (!e || !_apEdit) return e;
    var g = function (k) { var el = document.getElementById(k); return el ? el.value : null; };
    var rows = [['coverName', 'Coverstock', 'ape-coverName'], ['coverType', 'Cover type', 'ape-coverType'], ['finish', 'Factory finish', 'ape-finish'], ['core', 'Core', 'ape-core'],
      ['coreType', 'Core type', 'ape-coreType'], ['released', 'Release date', 'ape-released']].map(function (a) { return { k: a[0], label: a[1], inputId: a[2], cur: g(a[2]) }; });
    AP_WEIGHTS.forEach(function (w) { [['RG', 'RG'], ['Diff', 'Diff'], ['IntDiff', 'Int Diff']].forEach(function (a) { rows.push({ w: w, wk: a[0], label: w + ' lb ' + a[1], inputId: 'ape-' + w + '-' + a[0], cur: g('ape-' + w + '-' + a[0]) }); }); });
    spOpen({ name: _apEdit.ballName, title: _apEdit.ballName, catalogId: id, rows: rows, after: function (n, pp) { if (n) { var so = document.getElementById('ape-source'); if (so) so.value = (pp && pp.source) || 'bowwwl'; } } }, parsed);
    return e;
  });
}
function catWorkbenchOpen(opt) {
  if (typeof root.wbOpen === 'function') return root.wbOpen(opt);
  var sc = document.createElement('script'); sc.src = 'workbench.js?v=' + encodeURIComponent(CAT_VERSION);
  sc.onload = function () { if (typeof root.wbOpen === 'function') root.wbOpen(opt); else if (root.toast) root.toast('Workbench did not start'); };
  sc.onerror = function () { if (root.toast) root.toast('Workbench unavailable: upload workbench.js next to index.html'); };
  document.head.appendChild(sc);
}
/* v30.204: one My balls entry in Settings for the three reviews of your own balls */
function catMyBallsOpen() {
  var item = function (t, sub, call) { return '<button class="btn btn-ghost" style="width:100%;text-align:left;margin-top:8px;padding:12px" onclick="' + call + '"><div style="font-size:14px;font-weight:700;color:var(--t1)">' + t + '</div><div style="font-size:12px;color:var(--t3);margin-top:2px">' + sub + '</div></button>'; };
  var bg = document.getElementById('modal-bg'), show = bg && bg.classList.contains('open') && root.swapModal ? root.swapModal : root.openModal;   // from Settings: swap, don't stack
  if (show) show('<div class="modal-title">My balls and the catalog</div>' +
    item('Review suggested matches', 'Link your balls to their catalog entries', 'catReviewOpen()') +
    item('Check linked balls', 'Links that may point at the wrong ball', 'catAuditOpen()') +
    item('Review my specs', 'Your balls\u2019 specs next to the catalog\u2019s', 'closeModal();setTimeout(catSpecReviewOpen,350)') +
    '<button class="btn btn-secondary" style="width:100%;margin-top:12px" onclick="closeModal()">Close</button>');
}
function catOldClose() { var el = document.getElementById('cat-old-ov'); if (el) el.parentNode.removeChild(el); }
function catAddBlank() {
  catOldClose(); catCloseAddSearch();
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
/* v30.174: a spec text field is a short name, not page prose (same rule as
   the bridge's plausibleText). Catalog values that fail it are treated as
   missing everywhere the app offers them: Fill, Apply, Review my specs. */
var TEXT_MAX = { core: 40, coverName: 45, coverType: 30, finish: 40 };
function plausibleText(field, v) {
  if (v == null) return null;
  var s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > (TEXT_MAX[field] || 40) || s.split(' ').length > 6) return null;
  if (/[.!?;]\s+\S|,\s(?!\d)|\s[-\u2013\u2014]\s/.test(s)) return null;
  if (/^(this|that|it|its|our|we|you|your|with|when|while|for|if|from|traditionally|firmly|featuring|introducing|designed|built|created|using|combining)\b/i.test(s)) return null;
  if (/\b(is|are|was|were|has|have|had|will|be|been|that|which|who|ensconced|provides?|delivers?|offers?|gives?)\b/i.test(s)) return null;
  return s;
}
/* Pure: which text fields of a specsOf() result are page prose. */
function proseFields(s) {
  var out = [];
  if (!s) return out;
  [['coverName', 'coverName', 'Coverstock'], ['coreName', 'core', 'Core'], ['finish', 'finish', 'Factory finish'], ['coverType', 'coverType', 'Cover type']].forEach(function (p) {
    if (s[p[0]] != null && s[p[0]] !== '' && !plausibleText(p[1], s[p[0]])) out.push(p[2]);
  });
  return out;
}
function ballFromSpecs(s) {
  var cc = coverClass(s.coverType, s.coverName);
  var coreT = s.coreType ? (/asym/i.test(s.coreType) ? 'Asymmetrical' : /sym/i.test(s.coreType) ? 'Symmetrical' : s.coreType) : null;
  return {
    BoxFinish: plausibleText('finish', s.finish),
    Coverstock: cc ? cc.charAt(0).toUpperCase() + cc.slice(1) : plausibleText('coverType', s.coverType),
    CoverName: plausibleText('coverName', s.coverName), CoreType: coreT, CoreShort: plausibleText('core', s.coreName),
    RG: s.rg, Differential: s.diff, IntDiff: s.intDiff,
    DateReleased: s.released ? String(s.released).slice(0, 10) : null,
  };
}
/* v30.181: the core picture (kept on this device) beside the ball, when there is one */
function sheetCoreHTML(e) {
  var d = _sheet && _sheet.loaded ? _sheet.detail : null, nm = d && d.Core && d.Core.Name;
  var u = (nm ? catCoreImageFor(e.m, nm) : null) || _catImgObj['core:id-' + e.i] || coreLinks()['id-' + e.i] || null;
  return u ? '<img src="' + esc(u) + '" alt="core" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'" style="width:110px;height:110px;border-radius:14px;object-fit:contain;background:#fff">' : '';
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
      (_sheet.detail && _sheet.detail._local ? ' <span style="color:var(--teal)">Includes your corrections' + (_sheet.detail._local.repo ? ' (saved; Publish puts them in the catalog)' : ' (this device' + (_sheet.detail._local.source === 'bowwwl' ? ', from bowwwl' : '') + ')') + '.</span>' : '') + '</div>';
    var met = metricScore(ballFromSpecs(s), parseFinish(s.finish));
    if (met) body += '<div style="margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--bg3);font-size:13px;color:var(--t1)">' +
      'Strength <b>' + met.strength + '</b> · Shape <b>' + signed(met.shape) + '</b><span style="color:var(--t3);font-size:11px"> · factory finish' + (_shownW !== wt ? ', ' + _shownW + ' lb specs' : '') + '</span></div>';
  }
  var w = _sheet.weight;
  return '<div style="padding:12px 16px 4px;display:flex;justify-content:space-between;align-items:center"><button onclick="catSheetClose()" style="' + BACK + '" aria-label="Back">‹</button>' +
    '<div style="display:flex;gap:8px">' + (catFixAllowed() ? '<button onclick="catFixOpen()" style="' + BTN_G + 'padding:8px 14px;font-size:13px;color:var(--gold)">Fix</button>' : '') +   /* v30.185 FIX-1, dev mode */
    '<button onclick="catCompareFromSheet()" style="' + BTN_G + 'padding:8px 14px;font-size:13px">Compare</button></div></div>' +   /* v30.171 MET-2 */
    '<div style="flex:1;overflow-y:auto;padding:0 16px 16px;-webkit-overflow-scrolling:touch">' +
      '<div style="display:flex;justify-content:center;align-items:center;gap:14px;margin:6px 0 12px">' + thumbHTML(e, 150) + sheetCoreHTML(e) + '</div>' +
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
      _sheet.raw = raw; _sheet.detail = sheetDetail(e.i, raw); _sheet.loaded = true; renderSheet();
      /* dev mode: load repo corrections, then show them too */
      if (catFixAllowed() && apToken() && !_ovr) apReadOverrides().then(function () { if (_sheet.id === e.i) { _sheet.detail = sheetDetail(e.i, raw); renderSheet(); } }, function () {});
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
/* v30.174: Fill and Apply open a review list first. Each value can be
   unticked; nothing changes until "Apply". Page prose is never offered. */
var _fr = null;
function catFillFromCatalog(mode) {
  catLoad().then(function (rows) { return catDetailRaw(byIdIn(rows, _pick.id)); }).then(function (d) {
    var wEl = document.getElementById('bef-wt');
    var s = specsOf(d, (wEl && parseInt(wEl.value, 10)) || 15), spec = ballFromSpecs(s);
    var plan = fillPlan(formValues(), (_pick.ball && _pick.ball.SpecSource) || {}, spec);
    var list = mode === 'apply' ? plan.apply : plan.fill, cur = formValues();
    _fr = { mode: mode, spec: spec, list: list, on: list.map(function () { return true; }), prose: proseFields(s) };
    frRender(cur);
  });
}
function frRender(cur) {
  var lbl = function (f) { return (typeof SRV_LABEL !== 'undefined' && SRV_LABEL[f]) || FIELD_LABEL[f] || f; };
  var fmt = function (f, v) { return srvFmt(f, v); };
  var rows = _fr.list.map(function (f, i) {
    return '<label style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border1)">' +
      '<input type="checkbox" ' + (_fr.on[i] ? 'checked' : '') + ' onchange="catFillToggle(' + i + ',this.checked)" style="margin-top:3px;width:18px;height:18px">' +
      '<div style="flex:1"><div style="font-size:12px;font-weight:700;color:var(--t2)">' + esc(lbl(f)) + '</div>' +
      '<div style="font-size:13px;color:var(--t1);margin-top:2px">' + (_fr.mode === 'apply' ? '<span style="color:var(--t3);text-decoration:line-through">' + esc(fmt(f, cur[f])) + '</span> \u2192 ' : '') +
      '<b>' + esc(fmt(f, _fr.spec[f])) + '</b></div></div></label>';
  }).join('');
  var n = _fr.on.filter(Boolean).length;
  var ov = overlay('fr-ov', 935);
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catFillClose()">\u2039</button>' +
    '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">' + (_fr.mode === 'apply' ? 'Review catalog changes' : 'Review catalog values') + '</div>' +
    '<div style="font-size:11px;color:var(--t3)">Untick anything that looks wrong. Values you entered yourself are never offered.</div></div></div>' +
    '<div style="flex:1;overflow-y:auto;padding:0 16px 12px">' + (rows || '<div style="padding:20px 0;color:var(--t3);font-size:13px">Nothing to change.</div>') +
    (_fr.prose.length ? '<div style="font-size:11px;color:var(--gold);margin-top:10px;line-height:1.5">Not offered: ' + esc(_fr.prose.join(', ')) + ' (the catalog holds page text there, not a value). Fix it in Spec approvals.</div>' : '') + '</div>' +
    '<div style="padding:10px 16px;border-top:1px solid var(--border1);display:flex;gap:8px"><button style="' + BTN_G + 'padding:11px" onclick="catFillClose()">Cancel</button>' +
    '<button style="' + BTN_P + 'flex:1;padding:11px" ' + (n ? '' : 'disabled ') + 'onclick="catFillConfirm()">Apply ' + n + '</button></div>';
  var old = document.getElementById('fr-ov'); if (old && old !== ov) old.parentNode.removeChild(old);
  if (!ov.parentNode) document.body.appendChild(ov);
}
function catFillToggle(i, on) { if (_fr) { _fr.on[i] = !!on; frRender(formValues()); } }
function catFillClose() { var el = document.getElementById('fr-ov'); if (el) el.parentNode.removeChild(el); _fr = null; }
function catFillConfirm() {
  if (!_fr) return;
  var n = 0;
  _fr.list.forEach(function (f, i) {
    if (!_fr.on[i]) return;
    var el = document.getElementById(FIELD_INPUT[f]); if (!el) return;
    el.value = _fr.spec[f]; _filled[f] = _fr.spec[f]; n++;
  });
  catFillClose();
  if (root.toast) root.toast(n + ' field' + (n === 1 ? '' : 's') + ' filled from catalog. Save to keep.');
  renderFillRow();
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
  /* v30.174: give up after 25 s so a stalled request cannot hang a caller */
  var ac = typeof AbortController === 'function' ? new AbortController() : null, tm = ac ? setTimeout(function () { ac.abort(); }, 25000) : null;
  return env.fetch(AP_API + path, { method: opt.method || 'GET', headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined, cache: 'no-store', signal: ac ? ac.signal : undefined })
    .then(function (r) { if (tm) clearTimeout(tm); return r; }, function (e) { if (tm) clearTimeout(tm); throw e; })
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
  var all = apPages(boxes).filter(function (p) { return !stIdRejected(p.catalogId); });   // v30.185: rejected balls step out at once
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
    '<div style="flex:1;overflow-y:auto;padding:4px 16px 12px">' + head + mineH + cards + warn + crossCheck + verifyBtn + apRejectHTML(p.catalogId) + '</div>' + apFooter(true);
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
  if (_catImgObj[id]) return _catImgObj[id];            // v30.180: picture file stored on this device
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
var _vfyBusy = false, _vfyBusyAt = 0, _vfyTickId = 0, _vfyTimer = null;
var VFY_BUSY_MAX_MS = 60000;   // v30.174: a request that never answers (phone slept mid-fetch) must not freeze the chain
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
  if (!s || s.done || s.err || !apToken()) return Promise.resolve(s);
  if (_vfyBusy && env.now() - _vfyBusyAt < VFY_BUSY_MAX_MS) return Promise.resolve(s);
  _vfyBusy = true; _vfyBusyAt = env.now(); var myTick = ++_vfyTickId;
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
    if (myTick !== _vfyTickId) return s;                                    // a newer tick took over; drop this late answer
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
function catVerifyRefresh() { var s = vfyActive(); if (s) { delete s.waiting; vfySave(s); } _vfyBusy = false; return vfyTick(); }
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
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && updActive()) updTick(); });
  setTimeout(function () { if (updActive()) { updArm(); updTick(); } }, 1800);
}


/* ---------- v30.210: paste a picture (image on the clipboard, a copied picture address, or a paste box) ----------
   done({ blob, url, how }) once something usable is found; nothing happens when the user backs out. */
function catPastePicture(done) {
  var take = function (blob, url) {
    if (blob) return imgShrink(blob).then(function (b) { done({ blob: b, url: URL.createObjectURL(b), how: 'pasted picture' }); });
    if (url) return imgProbe(url).then(function (u) { if (u) done({ url: u, how: 'pasted link', link: true }); else if (root.toast) root.toast('That address did not load as a picture'); });
  };
  var cb = typeof navigator !== 'undefined' && navigator.clipboard;
  if (cb && cb.read) return cb.read().then(function (items) {
    for (var i = 0; i < items.length; i++) { var t = items[i].types.filter(function (x) { return /^image\//.test(x); })[0]; if (t) return items[i].getType(t).then(function (b) { return take(b); }); }
    for (var j = 0; j < items.length; j++) if (items[j].types.indexOf('text/plain') >= 0) return items[j].getType('text/plain').then(function (b) { return b.text(); }).then(function (x) { var m = /https?:\/\/\S+/.exec(x || ''); return m ? take(null, m[0]) : ppBox(take); });
    return ppBox(take);
  }, function () { return ppBox(take); });
  return Promise.resolve(ppBox(take));
}
/* fallback: a box to paste into (iPhone: long-press, Paste); takes the first picture or address pasted */
function ppBox(take) {
  if (typeof document === 'undefined') return;
  var old = document.getElementById('ppb-ov'); if (old) old.parentNode.removeChild(old);
  var ov = overlay('ppb-ov', 960);
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catPasteBoxClose()">\u2039</button>' +
    '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Paste the picture</div><div style="font-size:11px;color:var(--t3)">In Safari: long-press the picture, Copy. Here: long-press the box, Paste.</div></div></div>' +
    '<div style="padding:0 16px 16px"><div id="ppb-box" contenteditable="true" style="min-height:180px;border:1px dashed var(--border1);border-radius:12px;padding:10px;color:var(--t2);font-size:14px;background:var(--bg2)"></div></div>';
  document.body.appendChild(ov);
  var box = document.getElementById('ppb-box'), fin = function (blob, url) { catPasteBoxClose(); take(blob, url); };
  box.addEventListener('paste', function (ev) {
    var cd = ev.clipboardData, items = (cd && cd.items) || [];
    for (var i = 0; i < items.length; i++) if (/^image\//.test(items[i].type)) { var f = items[i].getAsFile(); if (f) { ev.preventDefault(); fin(f); return; } }
    var tx = cd && cd.getData && cd.getData('text/plain'), m = /https?:\/\/\S+/.exec(tx || '');
    if (m) { ev.preventDefault(); fin(null, m[0]); return; }
    setTimeout(function () { var im = box.querySelector('img'); if (im && im.src) { if (/^https?:/.test(im.src)) fin(null, im.src); else env.fetch(im.src).then(function (r) { return r.blob(); }).then(function (b) { fin(b); }, function () {}); } }, 60);
  });
  setTimeout(function () { try { box.focus(); } catch (e) {} }, 50);
}
function catPasteBoxClose() { var el = document.getElementById('ppb-ov'); if (el) el.parentNode.removeChild(el); }
/* Saves a picture found or pasted: cover for a catalog ball, or a core picture by core key. Returns what it replaced (for undo). */
function catSaveCover(id, f) {
  var before = imgPicks()[id] || null, hadFile = !!_catImgObj[id];
  var job = f.blob ? catImgPut(id, f.blob).then(function () { imgPickSet(id, null); }) : Promise.resolve(imgPickSet(id, f.url));
  return job.then(function () { imgPersist(); catRecordChanged(id); return { id: id, url: before, hadFile: hadFile, file: !!f.blob }; });
}
function catSaveCore(brand, coreName, f) {
  var k = coreKeyOf(brand, coreName); if (!k) return Promise.resolve(null);
  var job = f.blob ? catImgPut('core:' + k, f.blob).then(function () { coreLinkSet(k, null); }) : Promise.resolve(coreLinkSet(k, f.url));
  return job.then(function () {
    /* your balls with this core and no core picture get it too */
    return Promise.all(appBalls().filter(function (b) { return b.CoreShort && coreKeyOf(b.MFG, b.CoreShort) === k; }).map(function (b) { return miOwnSet(b, 'core', f, false); }))
      .then(function () { if (root.saveDB) root.saveDB(); return k; });
  });
}

/* ---------- v30.210: a core picture, shared with the same core under another spelling or brand ----------
   Balls with the same brand + core name already share one picture (coreKeyOf). This finds the rest:
   the same core name under another brand of the family (Brunswick / Storm / Motiv), and close spellings
   ("Gas Mask" / "GasMask", "Rad X" / "Rad-X 2"). You tick which ones are the same core. */
function levCap(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  var prev = []; for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) { var cur = [i], lo = i;
    for (var k = 1; k <= b.length; k++) { cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1)); if (cur[k] < lo) lo = cur[k]; }
    if (lo > cap) return cap + 1; prev = cur; }
  return prev[b.length];
}
/* Pure: vocab core list [{v, n, b[]}] -> { same: n balls on this key, others: [{key, v, brand, n, why}] } */
function coreShareCandidates(list, brand, coreName, haveFor) {
  var key = coreKeyOf(brand, coreName), fam = familyOf(brand), base = slugBw(coreBase(coreName)), flat = base.replace(/-/g, '');
  var out = [], seen = {}, same = 0;
  (list || []).forEach(function (o) {
    (o.b || [brand]).forEach(function (b) {
      var k2 = coreKeyOf(b, o.v); if (!k2) return;
      if (k2 === key) { same += o.n || 1; return; }
      if (seen[k2] || (fam ? familyOf(b) !== fam : brandSlug(b) !== brandSlug(brand))) return;
      var b2 = slugBw(coreBase(o.v)), f2 = b2.replace(/-/g, ''), why = null;
      if (b2 === base) why = 'same name, ' + b;
      else if (f2 === flat) why = 'same letters';
      else if (flat.length >= 4 && f2.length >= 4 && (b2.indexOf(base + '-') === 0 || base.indexOf(b2 + '-') === 0)) why = 'starts the same';
      else if (flat.length >= 5 && levCap(flat, f2, 1) <= 1) why = 'one letter apart';
      if (!why || (haveFor && haveFor(k2))) return;
      seen[k2] = 1; out.push({ key: k2, v: o.v, brand: b, n: o.n || 1, why: why });
    });
  });
  return { key: key, same: same, others: out.sort(function (a, b) { return b.n - a.n; }).slice(0, 12) };
}
var _cs = null;
function catCoreShareOffer(brand, coreName, f) {
  if (typeof document === 'undefined' || !coreName) return Promise.resolve(null);
  return vocabLoad().then(function (v) {
    var c = coreShareCandidates(v && v.core, brand, coreName, function (k) { return !!(_catImgObj['core:' + k] || coreLinks()[k]); });
    if (!c.others.length) { if (root.toast) root.toast('Core picture saved' + (c.same > 1 ? ': shows on ' + c.same + ' balls with the ' + coreName + ' core' : '')); return c; }
    _cs = { f: f, list: c.others, on: {} };
    var ov = overlay('cs-ov', 955);
    ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catCoreShareClose()">\u2039</button>' +
      '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Same core?</div><div style="font-size:11px;color:var(--t3)">' + esc(coreName) + ' \u00b7 ' + esc(brand) + (c.same ? ' \u00b7 already shows on ' + c.same + ' ball' + (c.same === 1 ? '' : 's') : '') + '</div></div></div>' +
      '<div style="flex:1;overflow-y:auto;padding:0 16px 12px"><div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:6px">These cores have no picture and a name close to this one. Tick the ones that are the same core to give them this picture.</div>' +
      c.others.map(function (o, i) { return '<label style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border1)"><input type="checkbox" onchange="catCoreShareTick(' + i + ',this.checked)" style="width:20px;height:20px">' +
        '<div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--t1)">' + esc(o.v) + ' <span style="color:var(--t3)">\u00b7 ' + esc(o.brand) + '</span></div><div style="font-size:11px;color:var(--t3)">' + o.n + ' ball' + (o.n === 1 ? '' : 's') + ' \u00b7 ' + esc(o.why) + '</div></div></label>'; }).join('') +
      '</div><div style="display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--border1)"><button style="' + BTN_G + 'flex:1;padding:11px" onclick="catCoreShareClose()">None of these</button><button style="' + BTN_P + 'flex:1;padding:11px" onclick="catCoreShareGo()">Use for ticked</button></div>';
    document.body.appendChild(ov);
    return c;
  });
}
function catCoreShareTick(i, on) { if (_cs) { if (on) _cs.on[i] = 1; else delete _cs.on[i]; } }
function catCoreShareGo() {
  if (!_cs) return Promise.resolve(0);
  var pick = Object.keys(_cs.on).map(function (i) { return _cs.list[+i]; }), f = _cs.f;
  return pick.reduce(function (p, o) { return p.then(function () { return catSaveCore(o.brand, o.v, f); }); }, Promise.resolve()).then(function () {
    catCoreShareClose(); if (root.toast) root.toast(pick.length ? 'Core picture also on ' + pick.length + ' more core' + (pick.length === 1 ? '' : 's') : 'Nothing ticked');
    if (typeof root.wbRepaint === 'function') root.wbRepaint(); return pick.length;
  });
}
function catCoreShareClose() { var el = document.getElementById('cs-ov'); if (el) el.parentNode.removeChild(el); _cs = null; }

/* ---------- v30.210: type-ahead for text fields (core, coverstock, cover type, finish) ----------
   Any input listed below shows up to 6 values already in use as you type: the brand's family first,
   names that start with what you typed before ones that contain it, then by how many balls use it.
   Tap one to fill the field; keep typing to ignore. The \u25be pickers still list everything. */
var TA_FIELDS = Object.assign({ 'bef-corename': 'core', 'bef-covername': 'coverName', 'bef-cover': 'coverType', 'bef-finish': 'finish' }, VOCAB_FIELDS);
/* Pure: the suggestions for typed text */
function taSuggest(list, brand, q, cur, max) {
  var qq = vocabKey(q); if (!qq) return [];
  var fam = familyOf(brand), ck = vocabKey(cur);
  return (list || []).map(function (o) {
    var k = vocabKey(o.v), at = k.indexOf(qq); if (at < 0 || k === ck) return null;
    var inFam = fam && (o.b || []).some(function (x) { return familyOf(x) === fam; });
    var word = at === 0 || k.charAt(at - 1) === ' ';
    return { o: o, s: (inFam ? 4 : 0) + (at === 0 ? 2 : word ? 1 : 0) };
  }).filter(Boolean).sort(function (a, b) { return b.s - a.s || (b.o.n || 0) - (a.o.n || 0) || a.o.v.localeCompare(b.o.v); }).slice(0, max || 6).map(function (x) { return x.o; });
}
function taBrandFor(id) {
  if (/^bef-/.test(id)) { var m = document.getElementById('bef-mfg'); return m ? m.value : ''; }
  if (/^lk-/.test(id)) return (_lk && _lk.brand) || '';
  if (/^ape-/.test(id)) return (_apEdit && _apEdit.brand) || '';
  return '';
}
var _ta = { el: null, list: [] };
function taClose() { var b = document.getElementById('ta-box'); if (b) b.parentNode.removeChild(b); _ta.el = null; _ta.list = []; }
function taShow(el) {
  var k = TA_FIELDS[el.id]; if (!k) return;
  vocabLoad().then(function (v) {
    if (document.activeElement !== el) return;
    var list = taSuggest(v && v[k], taBrandFor(el.id), el.value, el.value, 6);
    var b = document.getElementById('ta-box');
    if (!list.length) { if (b) b.parentNode.removeChild(b); return; }
    _ta.el = el; _ta.list = list;
    if (!b) { b = document.createElement('div'); b.id = 'ta-box'; document.body.appendChild(b);
      b.addEventListener('mousedown', function (ev) { ev.preventDefault(); }); b.addEventListener('touchstart', function (ev) { ev.preventDefault(); var t = ev.target.closest && ev.target.closest('[data-ta]'); if (t) taChoose(+t.getAttribute('data-ta')); }, { passive: false }); }
    var r = el.getBoundingClientRect(), vh = (root.visualViewport && root.visualViewport.height) || root.innerHeight || 800, h = Math.min(list.length * 44 + 4, 268);
    var below = r.bottom + 4 + h <= vh;
    b.setAttribute('style', 'position:fixed;z-index:99999;left:' + Math.max(8, r.left) + 'px;width:' + Math.max(220, r.width) + 'px;max-width:calc(100vw - 16px);' +
      (below ? 'top:' + (r.bottom + 4) : 'top:' + Math.max(4, r.top - h - 4)) + 'px;max-height:' + h + 'px;overflow-y:auto;background:var(--bg1, #1b1d22);border:1px solid var(--border1);border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.45)');
    b.innerHTML = list.map(function (o, i) { return '<div data-ta="' + i + '" onclick="taChoose(' + i + ')" style="padding:8px 10px;border-bottom:1px solid var(--border1);cursor:pointer;min-height:26px">' +
      '<div style="font-size:14px;color:var(--t1)">' + esc(o.v) + '</div><div style="font-size:11px;color:var(--t3)">' + (o.n || 1) + ' ball' + ((o.n || 1) === 1 ? '' : 's') + ' \u00b7 ' + esc((o.b || []).slice(0, 3).join(', ')) + '</div></div>'; }).join('');
  });
}
function taChoose(i) {
  var el = _ta.el, o = _ta.list[i]; if (!el || !o) return;
  el.value = o.v; taClose();
  try { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
  el.style.boxShadow = '0 0 0 2px var(--teal)'; setTimeout(function () { el.style.boxShadow = ''; }, 600);
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('input', function (ev) { var t = ev.target; if (t && t.id && TA_FIELDS[t.id] && t.tagName === 'INPUT' && ev.isTrusted !== false) taShow(t); }, true);
  document.addEventListener('focusout', function (ev) { if (_ta.el && ev.target === _ta.el) setTimeout(function () { if (document.activeElement !== _ta.el) taClose(); }, 150); }, true);
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && _ta.el) taClose(); }, true);
}

/* ---------- v30.208 WB-5: Update catalog, one button ----------
   One chain, kept in bdbgh_update so it resumes after the app is closed (polls every 15 s while open):
     send     your status marks and releases go to the repo (status.json, released.json)
     usbc     catalog-refresh: the new USBC list (new balls arrive held)
     makers   specs-extract, one run per maker site you picked (sites with held balls needing specs)
     approve  pauses for you: Spec approvals, then Publish (or Publish now)
     publish  specs-publish (auto-matched + ticked rows, corrections)
     rebuild  the catalog-refresh that publish starts (skipped by GitHub when specs didn't change)
     download this phone downloads the new catalog; a summary of what changed
   Runs are found as in Verify now: the first run of the workflow with an id above the newest one seen
   just before the dispatch. One Update at a time; Verify now keeps its own chain. */
var UPD_KEY = 'bdbgh_update';
var UPD_STEPS = ['send', 'usbc', 'makers', 'approve', 'publish', 'rebuild', 'download'];
var UPD_LABEL = { send: 'Send your changes', usbc: 'New USBC list', makers: 'Read maker sites', approve: 'Approve specs', publish: 'Publish', rebuild: 'Rebuild the catalog', download: 'Download to this phone' };
var _updBusy = false, _updBusyAt = 0, _updTimer = null;
function updState() { var l = apLS(); try { return JSON.parse((l && l.getItem(UPD_KEY)) || 'null'); } catch (e) { return null; } }
function updSave(st) { var l = apLS(); if (l) { if (st) l.setItem(UPD_KEY, JSON.stringify(st)); else l.removeItem(UPD_KEY); } updPaint(); }
function updActive() { var st = updState(); return st && st.v === 1 ? st : null; }
/* Pure: maker sites worth reading: sources of in-scope held balls (not rejected) without RG / Diff, most first */
function updSourcesFrom(rows, isHeld, hasSpecs, src) {
  var n = {};
  (rows || []).forEach(function (e) { if (e.a || !isHeld(e) || hasSpecs(e)) return; var s = src(e.m); if (s) n[s] = (n[s] || 0) + 1; });
  return Object.keys(n).sort(function (a, b) { return n[b] - n[a] || a.localeCompare(b); }).map(function (k) { return { src: k, n: n[k] }; });
}
/* Pure: counts for the before / after summary */
function updCounts(rows) {
  var c = { total: 0, held: 0, fresh: 0, specs: 0 };
  (rows || []).forEach(function (e) { if (e.a) return; c.total++; if (e.h) { c.held++; if (e.h === 2) c.fresh++; } if (e.s) c.specs++; });
  return c;
}
function catUpdateOpen() {
  if (typeof document === 'undefined') return;
  if (!apToken()) { if (root.toast) root.toast('Add the GitHub token first (More \u203a Spec approvals)'); return; }
  var el = document.getElementById('upd-ov'); if (el) el.parentNode.removeChild(el);
  document.body.appendChild(overlay('upd-ov', 930));
  if (updActive() && !updActive().done) { updPaint(); updTick(); return; }
  catLoad().then(function (rows) {
    _updPick = { srcs: updSourcesFrom(rows, catIsHeld, function (e) { return catIsRejected(e) || hlHasSpecs(e, overrideFor(e.i)); }, sourceForBrand), on: {} };
    _updPick.srcs.slice(0, 3).forEach(function (x) { _updPick.on[x.src] = 1; });
    updPaint();
  });
}
var _updPick = null;
function updPickToggle(src, on) { if (!_updPick) return; if (on) _updPick.on[src] = 1; else delete _updPick.on[src]; updPaint(); }
function catUpdateStart() {
  var srcs = _updPick ? _updPick.srcs.filter(function (x) { return _updPick.on[x.src]; }).map(function (x) { return x.src; }) : [];
  catLoad().then(function (rows) {
    updSave({ v: 1, at: env.now(), step: 'send', srcs: srcs, log: {}, urls: {}, before: updCounts(rows) });
    _updPick = null; updArm(); updTick();
  });
}
function catUpdateStop() {
  var st = updActive();
  if (st && !st.done && root.confirm && !root.confirm('Stop following this update? Runs already started on GitHub keep going.')) return;
  clearInterval(_updTimer); _updTimer = null; updSave(null);
  var el = document.getElementById('upd-ov'); if (el && !st) el.parentNode.removeChild(el);
}
function catUpdateClose() { var el = document.getElementById('upd-ov'); if (el) el.parentNode.removeChild(el); if (typeof root.wbRepaint === 'function') root.wbRepaint(); }
function catUpdatePublish() {   // from the approve step: send ticks, then publish
  var st = updActive(); if (!st || st.step !== 'approve') return;
  var q = Object.keys(apQueue()).length;
  (q ? apFlush() : Promise.resolve(0)).catch(function () {}).then(function () {
    var pb = 0, rb = 0;
    return vfyLatestId('specs-publish.yml').then(function (id) { pb = id; return vfyLatestId('catalog-refresh.yml'); }).then(function (id) { rb = id; return apGH(''); })
      .then(function (repo) { return apGH('/actions/workflows/specs-publish.yml/dispatches', { method: 'POST', body: { ref: repo.default_branch || 'main' } }); })
      .then(function () { var s2 = updActive(); s2.pub = { base: pb, refreshBase: rb, at: env.now() }; s2.step = 'publish'; delete s2.waiting; updSave(s2); updTick(); });
  }).catch(function (e) { var s2 = updActive(); if (s2) { s2.err = 'Publish did not start: ' + (e && e.status ? 'GitHub ' + e.status : 'offline'); s2.retry = 'approve'; updSave(s2); } });
}
function catUpdateRetry() {
  var st = updActive(); if (!st) return;
  if (st.retry === 'usbc') delete st.usbc; if (st.retry === 'makers') { delete st.mk; st.mkSelf = true; } if (st.retry === 'approve') st.step = 'approve'; if (st.retry === 'rebuild') delete st.rebuildRun;
  delete st.err; delete st.retry; updSave(st); updTick();
}
function updDispatch(wf, inputs) {
  var base = 0;
  return vfyLatestId(wf).then(function (id) { base = id; return apGH(''); }).then(function (repo) {
    return apGH('/actions/workflows/' + wf + '/dispatches', { method: 'POST', body: Object.assign({ ref: repo.default_branch || 'main' }, inputs ? { inputs: inputs } : {}) });
  }).then(function () { return { base: base, at: env.now() }; });
}
/* follow one run: resolves 'wait' | 'done' | 'failed:<conclusion>' and notes its link */
function updFollow(wf, run0, st, key, event) {
  return vfyFindRun(wf, run0.base, event).then(function (run) {
    if (!run) return env.now() - run0.at > VFY_START_GRACE_MS ? 'failed:did not start' : 'wait';
    st.urls[key] = run.html_url;
    if (run.status !== 'completed') return 'wait';
    return run.conclusion === 'success' ? 'done' : 'failed:' + (run.conclusion || 'failed');
  });
}
function updTick() {
  var st = updActive();
  if (!st || st.done || st.err || st.waiting === 'approve' && st.step === 'approve' || !apToken()) { updPaint(); return Promise.resolve(st); }
  if (_updBusy && env.now() - _updBusyAt < VFY_BUSY_MAX_MS) return Promise.resolve(st);
  _updBusy = true; _updBusyAt = env.now();
  var go = function () {
    if (st.step === 'send') {
      return Promise.all([stSync().catch(function () { return {}; }), rlSync().catch(function () { return {}; })]).then(function (r) {
        st.log.send = ((r[0] && r[0].sent) || 0) + ((r[1] && r[1].sent) || 0); st.step = 'usbc'; return true; });
    }
    if (st.step === 'usbc') {
      /* v30.212: catalog-refresh starts the maker-site read itself (then_extract), so that part runs on GitHub
         without the app open. An older workflow without that input answers 422: dispatch plain, and the app starts the read. */
      if (!st.usbc) return vfyLatestId('specs-extract.yml').then(function (id) {
        st.mkBase = id; var inp = (st.srcs || []).length ? { then_extract: st.srcs.join(',') } : null;
        return updDispatch('catalog-refresh.yml', inp).catch(function (e) { if (inp && e && e.status === 422) { st.mkSelf = true; return updDispatch('catalog-refresh.yml'); } throw e; });
      }).then(function (r) { st.usbc = r; return false; });
      return updFollow('catalog-refresh.yml', st.usbc, st, 'usbc', 'workflow_dispatch').then(function (k) {
        if (k === 'wait') return false;
        if (k !== 'done') { st.err = 'catalog-refresh ' + k.slice(7) + '. Open it on GitHub for the reason, then Retry.'; st.retry = 'usbc'; return false; }
        return catCheck({ force: true }).catch(function () {}).then(function () { return catLoad(); }).then(function (rows) { st.afterUsbc = updCounts(rows); st.step = 'makers'; return true; });
      });
    }
    if (st.step === 'makers') {
      /* v30.212: one specs-extract run for every ticked site (only = comma list) */
      if (!(st.srcs || []).length) { st.step = 'approve'; return Promise.resolve(true); }
      if (!st.mk) {
        if (st.mkSelf) return updDispatch('specs-extract.yml', { only: st.srcs.join(','), limit: '0', since: '2021' }).then(function (r) { st.mk = r; return false; });
        st.mk = { base: st.mkBase || 0, at: env.now() }; return Promise.resolve(false);
      }
      return updFollow('specs-extract.yml', st.mk, st, 'makers', 'workflow_dispatch').then(function (k) {
        if (k === 'wait') return false;
        if (k === 'failed:did not start' && !st.mkSelf) { st.mkSelf = true; delete st.mk; return true; }   // the refresh didn't start it: the app does
        if (k !== 'done') { st.err = 'specs-extract ' + k.slice(7) + '. Open it on GitHub for the reason, then Retry.'; st.retry = 'makers'; return false; }
        st.log.makers = 'done'; st.step = 'approve'; return true;
      });
    }
    if (st.step === 'approve') {
      return apFetchIssue().then(function (is) { return apParseIssue(is.body); }, function () { return []; }).then(function (boxes) {
        var q = apQueue(); st.boxes = boxes.length; st.ticked = boxes.filter(function (b) { return (b.tok in q) ? !!q[b.tok] : b.ticked; }).length;
        st.waiting = 'approve'; return false;
      });
    }
    if (st.step === 'publish') {
      return updFollow('specs-publish.yml', st.pub, st, 'publish', 'workflow_dispatch').then(function (k) {
        if (k === 'wait') return false;
        if (k !== 'done') { st.err = 'specs-publish ' + k.slice(7) + '.'; st.retry = 'approve'; return false; }
        return vfyFindRun('specs-publish.yml', st.pub.base, 'workflow_dispatch').then(function (run) { return apGH('/actions/runs/' + run.id + '/jobs'); }).then(function (j) {
          var sx = []; ((j && j.jobs) || []).forEach(function (x) { sx = sx.concat(x.steps || []); });
          var re = sx.filter(function (x) { return /catalog-refresh/i.test(x.name || ''); })[0];
          st.unchanged = !!(re && re.conclusion === 'skipped');
        }, function () {}).then(function () { st.step = 'rebuild'; return true; });
      });
    }
    if (st.step === 'rebuild') {
      if (st.unchanged) { st.log.rebuild = 'not needed'; st.step = 'download'; return Promise.resolve(true); }
      return vfyFindRun('catalog-refresh.yml', st.pub.refreshBase, null).then(function (run) {
        if (!run) { if (env.now() - st.pub.at > VFY_START_GRACE_MS) { st.log.rebuild = 'not started (nothing changed)'; st.step = 'download'; return true; } return false; }
        st.urls.rebuild = run.html_url;
        if (run.status !== 'completed') return false;
        if (run.conclusion !== 'success') { st.err = 'catalog-refresh ' + (run.conclusion || 'failed') + ' after publish.'; st.retry = 'rebuild'; return false; }
        st.step = 'download'; return true;
      });
    }
    if (st.step === 'download') {
      return catCheck({ force: true }).catch(function () {}).then(function () { return catLoad(); }).then(function (rows) { st.after = updCounts(rows); st.done = env.now(); return false; });
    }
    return Promise.resolve(false);
  };
  var loop = function () { return go().then(function (more) { return more && !st.done && !st.err ? loop() : null; }); };
  return loop().catch(function (e) {
    if (e && (e.status === 401 || e.status === 403 || e.status === 404)) st.err = 'GitHub ' + e.status + ': the token needs Actions read and write.';
    else st.note = 'Offline or GitHub busy; trying again.';
  }).then(function () {
    var cur = updActive(); if (cur && cur.at === st.at) { if (!st.err && st.note && st.step !== cur.step) delete st.note; updSave(st); }
    _updBusy = false; if (st.done && _updTimer) { clearInterval(_updTimer); _updTimer = null; }
    return st;
  });
}
function updArm() {
  if (_updTimer || typeof setInterval !== 'function') return;
  _updTimer = setInterval(function () { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return; var st = updActive(); if (!st || st.done) { clearInterval(_updTimer); _updTimer = null; return; } updTick(); }, VFY_POLL_MS);
}
/* one line for the workbench header; '' when nothing is running */
function catUpdateLine() {
  var st = updActive(); if (!st) return '';
  if (st.done) return 'Update finished';
  if (st.err) return 'Update stopped: ' + UPD_LABEL[st.step];
  return (st.waiting === 'approve' ? 'Update waiting for you: ' : 'Updating: ') + UPD_LABEL[st.step] + (st.step === 'makers' ? ' (' + st.srcs.length + ' site' + (st.srcs.length === 1 ? '' : 's') + ')' : '');
}
function updPaint() {
  if (typeof root.wbRepaint === 'function') try { root.wbRepaint(); } catch (e) {}
  var ov = typeof document !== 'undefined' && document.getElementById('upd-ov'); if (!ov) return;
  var st = updActive(), head = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catUpdateClose()">\u2039</button>' +
    '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Update catalog</div><div style="font-size:11px;color:var(--t3)">USBC list, maker sites, publish, rebuild \u00b7 keeps going if you close this</div></div></div>';
  if (!st) {
    var p = _updPick;
    ov.innerHTML = head + '<div style="flex:1;overflow-y:auto;padding:4px 16px 12px;font-size:13px;color:var(--t2);line-height:1.5">' +
      '<div>One tap runs the whole update on GitHub and follows it here:</div><ol style="margin:6px 0 10px 18px;padding:0">' + UPD_STEPS.map(function (k) { return '<li>' + UPD_LABEL[k] + (k === 'approve' ? ' <span style="color:var(--t3)">(waits for you)</span>' : '') + '</li>'; }).join('') + '</ol>' +
      '<div style="font-size:12px;font-weight:700;color:var(--t1);margin-top:6px">Maker sites to read</div><div style="font-size:12px;color:var(--t3)">Sites with held balls still needing specs (ball count). Read together in one GitHub run started by the USBC step, so it keeps going with the app closed; untick to skip.</div>' +
      (p ? (p.srcs.length ? p.srcs.map(function (x) { return '<label style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border1)"><input type="checkbox" ' + (p.on[x.src] ? 'checked ' : '') + 'onchange="updPickToggle(\'' + jsq(x.src) + '\',this.checked)" style="width:20px;height:20px"><span style="flex:1;color:var(--t1)">' + esc(x.src) + '</span><span style="color:var(--t3)">' + x.n + '</span></label>'; }).join('') : '<div style="padding:8px 0">None: no held ball needing specs has a maker site in the bridge.</div>') : '<div style="padding:8px 0">Loading\u2026</div>') +
      '</div><div style="padding:10px 16px;border-top:1px solid var(--border1)"><button style="' + BTN_P + 'width:100%;padding:12px" onclick="catUpdateStart()">Start update' + (p ? ' (' + Object.keys(p.on).length + ' site' + (Object.keys(p.on).length === 1 ? '' : 's') + ')' : '') + '</button></div>';
    return;
  }
  var ix = UPD_STEPS.indexOf(st.step);
  var link = function (u) { return u ? ' \u00b7 <a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal)">on GitHub \u2197</a>' : ''; };
  var row = function (k, i) {
    var state = st.done || i < ix ? 'done' : i === ix ? (st.err ? 'err' : st.waiting === 'approve' && k === 'approve' ? 'you' : 'run') : 'todo';
    var ic = { done: '<span style="color:var(--teal)">\u2713</span>', run: '<span style="color:var(--gold)">\u25cf</span>', you: '<span style="color:#7aa7ff">\u23f8</span>', err: '<span style="color:var(--red)">\u2715</span>', todo: '<span style="color:var(--t3)">\u25cb</span>' }[state];
    var sub = '';
    if (k === 'send' && st.log.send != null) sub = st.log.send + ' change' + (st.log.send === 1 ? '' : 's') + ' sent';
    if (k === 'usbc') sub = (st.afterUsbc ? (st.afterUsbc.fresh - (st.before.fresh || 0) > 0 ? (st.afterUsbc.fresh - st.before.fresh) + ' new balls held for review' : 'no new balls') : state === 'run' ? 'running' : '') + link(st.urls.usbc);
    if (k === 'makers') sub = (st.srcs.length ? st.srcs.map(function (x) { return esc(x) + (st.log.makers === 'done' ? ' \u2713' : ''); }).join(' \u00b7 ') + (state === 'run' ? ' \u00b7 one run on GitHub, you can leave the app' : '') : 'skipped') + link(st.urls.makers);
    if (k === 'approve' && state === 'you') sub = (st.boxes || 0) + ' waiting in Spec approvals, ' + (st.ticked || 0) + ' ticked. Auto-matched rows and your corrections publish too.';
    if (k === 'publish') sub = link(st.urls.publish);
    if (k === 'rebuild') sub = (st.log.rebuild || '') + link(st.urls.rebuild);
    return '<div style="display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--border1)"><div style="width:16px;text-align:center;font-size:14px">' + ic + '</div><div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;color:' + (state === 'todo' ? 'var(--t3)' : 'var(--t1)') + '">' + UPD_LABEL[k] + '</div>' +
      (sub ? '<div style="font-size:12px;color:var(--t2);margin-top:2px;line-height:1.4">' + sub + '</div>' : '') + '</div></div>';
  };
  var sum = st.done && st.after ? '<div style="margin-top:10px;padding:10px;border-radius:10px;background:var(--bg2);border:1px solid var(--border1);font-size:13px;color:var(--t1);line-height:1.6">Done. ' +
    'Catalog ' + st.before.total + ' \u2192 ' + st.after.total + ' balls \u00b7 held ' + st.before.held + ' \u2192 ' + st.after.held + ' \u00b7 with specs ' + st.before.specs + ' \u2192 ' + st.after.specs + '.</div>' : '';
  var acts = st.err ? '<button style="' + BTN_P + 'flex:1;padding:11px" onclick="catUpdateRetry()">Retry</button>' :
    st.waiting === 'approve' && st.step === 'approve' ? '<button style="' + BTN_G + 'flex:1;padding:11px" onclick="catUpdateClose();catApprovalsOpen()">Spec approvals</button><button style="' + BTN_P + 'flex:1;padding:11px" onclick="catUpdatePublish()">Publish now</button>' : '';
  ov.innerHTML = head + '<div style="flex:1;overflow-y:auto;padding:0 16px 12px">' + UPD_STEPS.map(row).join('') +
    (st.err ? '<div style="font-size:13px;color:var(--red);margin-top:8px">' + esc(st.err) + '</div>' : st.note ? '<div style="font-size:12px;color:var(--t3);margin-top:8px">' + esc(st.note) + '</div>' : '') + sum + '</div>' +
    '<div style="display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--border1)">' + acts +
    '<button style="' + BTN_G + 'flex:' + (acts ? '0 0 auto' : '1') + ';padding:11px" onclick="' + (st.done ? 'updSave(null);catUpdateClose()' : 'catUpdateStop()') + '">' + (st.done ? 'Close' : 'Stop following') + '</button></div>';
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
  var balls = appBalls().filter(function (b) { return b.BallID != null; });   // v30.206: every ball in your arsenal, linked or not, retired too
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
          var rws = e ? srvRows(b, pub, pend) : [];
          var catHas = SRV_ORDER.some(function (f) { return pub[f] != null && pub[f] !== '' || pend[f] != null && pend[f] !== ''; });
          acc.push({ ball: b, entry: e, weight: w, pubWeights: d ? Object.keys(d.SpecsByWeight || {}) : [], rows: rws, pub: pub, pend: pend, catHas: catHas });
          return acc;
        });
      });
    }, Promise.resolve([]));
  }).then(function (pages) {
    pages.sort(function (a, b) { return ((a.ball.Archived ? 1 : 0) - (b.ball.Archived ? 1 : 0)) || String(a.ball.BallName).localeCompare(String(b.ball.BallName)); });
    _srv.pages = pages; _srv.idx = 0; _srv.err = null;
    if (_srv.focus != null) { var i = pages.map(function (p) { return p.ball.BallID; }).indexOf(_srv.focus); if (i >= 0) { _srv.idx = i; _srv.view = 'ball'; } _srv.focus = null; }
  }).catch(function (e) { _srv.err = e.message || String(e); }).then(function () { _srv.busy = false; srvRender(); });
}
function catSpecReviewOpen(ballId) {
  if (typeof document === 'undefined') return;
  var mb = document.getElementById('modal-bg');
  if (mb && mb.classList.contains('open') && typeof root.closeModal === 'function') root.closeModal();
  catSpecReviewClose();
  document.body.appendChild(overlay('srv-ov', 906));
  _srv.focus = ballId == null ? null : ballId; _srv.tab = 'mine'; _srv.view = 'list'; _ms.page = 0;
  catLoad().then(function (rows) { var mine = {}; appBalls().forEach(function (b) { if (b.CatalogID && !b.Archived) mine[b.CatalogID] = 1; });
    _ms.count = msRows(rows, { mine: mine, rejected: catIsRejected, ovr: overrideFor }).length; if (!_srv.busy) srvRender(); });
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
/* Pure: an edited value for a field -> {v} or {err}. */
function srvEditValue(f, raw) {
  var t = String(raw == null ? '' : raw).trim();
  if (!t) return { err: 'Enter a value, or Cancel' };
  var lim = { RG: [2.30, 2.90], Differential: [0, 0.060], IntDiff: [0, 0.040] }[f];
  if (lim) { var n = Number(t); if (!isFinite(n)) return { err: 'Enter a number' }; if (n < lim[0] || n > lim[1]) return { err: (SRV_LABEL[f] || f) + ' must be ' + lim[0] + '\u2013' + lim[1] }; return { v: n }; }
  if (f === 'CoreType') { if (/asym/i.test(t)) return { v: 'Asymmetrical' }; if (/sym/i.test(t)) return { v: 'Symmetrical' }; return { err: 'Symmetrical or Asymmetrical' }; }
  if (f === 'DateReleased') { var r = tagValueFor('ape-released', t); return r.v ? { v: r.v } : { err: 'Use a date like 2025-10 or October 2025' }; }
  return { v: t };
}
function catSpecReviewAct(i, action) {
  var p = _srv.pages[_srv.idx]; if (!p) return;
  var r = p.rows[i]; if (!r) return;
  if (action === 'edit') { _srv.editing = i; _srv.editErr = null; srvRender(); var el = document.getElementById('srv-edit'); if (el) el.focus(); return; }
  if (action === 'editcancel') { _srv.editing = null; _srv.editErr = null; srvRender(); return; }
  if (action === 'editsave') {
    var ed = document.getElementById('srv-edit'), res = srvEditValue(r.f, ed && ed.value);
    if (res.err) { _srv.editErr = res.err; srvRender(); var e2 = document.getElementById('srv-edit'); if (e2) e2.value = ed.value; return; }
    p.ball[r.f] = res.v; p.ball.SpecSource = p.ball.SpecSource || {}; p.ball.SpecSource[r.f] = 'user';
    _srv.editing = null; _srv.editErr = null; srvRecount(p); srvCommit('Saved as verified by you'); return;
  }
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
function catSpecReviewPage(d) { _srv.editing = null; _srv.editErr = null;
  _srv.idx = Math.max(0, Math.min(_srv.pages.length - 1, _srv.idx + d)); srvRender(); }
function srvRender() {
  var ov = typeof document !== 'undefined' && document.getElementById('srv-ov'); if (!ov) return;
  var head = function (sub) { return '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catSpecReviewClose()">\u2039</button>' +
    '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Review my specs</div><div style="font-size:11px;color:var(--t3)">' + sub + '</div></div></div>' + srvTabs(); };
  if (_srv.tab === 'missing') { msRender(ov, head); return; }
  if (_srv.busy) { ov.innerHTML = head('Loading\u2026') + '<div style="padding:30px;text-align:center;color:var(--t3);font-size:13px">Comparing your balls with the catalog\u2026</div>'; return; }
  var pending = _srv.pages.filter(function (p) { return p.rows.length; });
  if (_srv.view !== 'ball') { ov.innerHTML = head(_srv.pages.length + ' ball' + (_srv.pages.length === 1 ? '' : 's') + (pending.length ? ' \u00b7 ' + pending.length + ' to review' : '')) + srvListHTML(); return; }
  var allMatches = 0; _srv.pages.forEach(function (p) { p.rows.forEach(function (r) { if (r.kind === 'match') allMatches++; }); });
  var p = _srv.pages[_srv.idx];
  var note = (_srv.err ? '<div style="font-size:12px;color:var(--red);margin:0 16px 8px">' + esc(_srv.err) + '</div>' : '') +
    (_srv.noStaged ? '<div style="font-size:11px;color:var(--t3);margin:0 16px 6px">Published catalog only (pending specs need the GitHub token).</div>' : '');
  if (!p) { _srv.view = 'list'; srvRender(); return; }
  var b = p.ball;
  var rowsH = p.rows.length ? p.rows.map(function (r, i) {
    var chip = r.kind === 'match' ? '<span style="color:var(--teal)">\u2713 same</span>' : r.kind === 'differ' ? '<span style="color:var(--gold)">differs</span>' :
      r.kind === 'fill' ? '<span style="color:var(--t3)">you have none</span>' : '<span style="color:var(--t3)">no catalog value</span>';
    var pendTag = r.cat && r.cat.src === 'pending' ? ' <span style="font-size:9px;font-weight:800;color:var(--gold);border:1px solid rgba(214,169,76,0.45);border-radius:3px;padding:0 3px">PENDING</span>' : '';
    var btn = function (lbl, act, primary) { return '<button style="' + (primary ? BTN_P : BTN_G) + 'padding:6px 10px;font-size:12px" onclick="catSpecReviewAct(' + i + ',\'' + act + '\')">' + lbl + '</button>'; };
    var acts = btn('Edit', 'edit') + (r.kind === 'match' ? btn('Confirm', 'use', true) : r.kind === 'differ' ? btn('Keep mine', 'keep') + btn('Use catalog', 'use', true) :
      r.kind === 'fill' ? btn('Use catalog', 'use', true) : btn('Keep mine', 'keep'));
    /* v30.176: Edit -> your own value in place (starts from the catalog's, else yours) */
    if (_srv.editing === i) {
      var start = r.cat ? srvFmt(r.f, r.cat.v) : srvFmt(r.f, r.mine); if (start === '\u2014') start = '';
      var isNum = r.f === 'RG' || r.f === 'Differential' || r.f === 'IntDiff';
      acts = '<input id="srv-edit" class="bdet-field-input" value="' + esc(start) + '"' + (isNum ? ' inputmode="decimal"' : r.f === 'DateReleased' ? ' placeholder="YYYY-MM-DD"' : '') + ' style="flex:1;min-width:0;font-size:15px">' +
        btn('Cancel', 'editcancel') + btn('Save', 'editsave', true);
    }
    return '<div style="padding:9px 0;border-bottom:1px solid var(--border1)">' +
      '<div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:var(--t2)"><span>' + SRV_LABEL[r.f] + '</span>' + chip + '</div>' +
      '<div style="display:flex;gap:10px;font-size:13px;color:var(--t1);margin:3px 0 6px"><div style="flex:1"><div style="font-size:10px;color:var(--t3)">Yours</div>' + esc(srvFmt(r.f, r.mine)) + '</div>' +
      '<div style="flex:1"><div style="font-size:10px;color:var(--t3)">Catalog' + pendTag + '</div>' + esc(srvFmt(r.f, r.cat && r.cat.v)) + '</div></div>' +
      '<div style="display:flex;gap:6px;justify-content:flex-end;align-items:stretch">' + acts + '</div>' + (_srv.editing === i && _srv.editErr ? '<div style="font-size:12px;color:var(--red);margin-top:4px">' + esc(_srv.editErr) + '</div>' : '') + '</div>';
  }).join('') : srvSummaryHTML(p);
  var nM = p.rows.filter(function (r) { return r.kind === 'match'; }).length, nD = p.rows.filter(function (r) { return r.kind === 'differ' || r.kind === 'fill'; }).length;
  var wNote = p.pubWeights.length && p.pubWeights.indexOf(String(p.weight)) < 0 ? '<div style="font-size:11px;color:var(--gold);margin-top:2px">Catalog has no ' + p.weight + ' lb numbers (published: ' + esc(p.pubWeights.join(', ')) + ' lb), so RG / Diff are not compared.</div>' : '';
  ov.innerHTML = head(pending.length + ' ball' + (pending.length === 1 ? '' : 's') + ' to review') + note +
    '<div style="flex:1;overflow-y:auto;padding:4px 16px 12px">' +
    '<div onclick="catSpecReviewList()" style="font-size:13px;color:var(--teal);cursor:pointer;margin-bottom:6px">\u2039 All my balls</div>' +
    '<div style="font-size:15px;font-weight:700;color:var(--t1)">' + esc(b.BallName) + (b.Archived ? ' <span style="' + CHIP_G + '">RETIRED</span>' : '') + '</div>' +
    '<div style="font-size:11px;color:var(--t3)">' + (p.entry ? entryLine(p.entry) : b.CatalogID ? 'USBC ' + esc(b.CatalogID) + ' (not in the catalog now)' : 'not linked to the catalog') + ' \u00b7 your ' + esc(p.weight) + ' lb</div>' + wNote +
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

/* ---------- v30.201 MS-1: Review my specs > Missing specs ----------
   Every catalog ball with no specs (none published, and no correction with RG and Diff for a weight),
   your own balls first, then newest. Tap a ball for Correct specs (Paste page, Read a saved page (PDF)
   from bowwwl or the maker's site); a ball drops off the list once it has RG and Diff. Rejected balls
   are left out. The same balls show in Review new balls under Needs specs once the hold has started. */
var _ms = { q: '', page: 0, count: null };
var MS_PAGE = 30;
/* Pure: rows missing specs, yours first, then newest, then brand and name */
function msRows(rows, opt) {
  opt = opt || {};
  var mine = opt.mine || {};
  return (rows || []).filter(function (e) { return !(e.a && !mine[e.i]) && !(opt.rejected && opt.rejected(e)) && !hlHasSpecs(e, opt.ovr ? opt.ovr(e.i) : null); })   // v30.202: archived only when yours
    .sort(function (a, b) { return ((mine[b.i] ? 1 : 0) - (mine[a.i] ? 1 : 0)) || String(b.y || '').localeCompare(String(a.y || '')) || String(a.m).localeCompare(String(b.m)) || cleanName(a.n).localeCompare(cleanName(b.n)); });
}
function srvTabs() {
  var n1 = (_srv.pages || []).length;   // v30.206: the whole arsenal
  var chip = function (k, t) { return '<button onclick="catSpecReviewTab(\'' + k + '\')" style="' + ((_srv.tab || 'mine') === k ? BTN_P : BTN_G) + 'flex:1;padding:9px;font-size:13px">' + t + '</button>'; };
  return '<div style="display:flex;gap:8px;padding:0 16px 8px">' + chip('mine', 'My balls' + (_srv.busy ? '' : ' (' + n1 + ')')) + chip('missing', 'Missing specs' + (_ms.count == null ? '' : ' (' + _ms.count + ')')) + '</div>';
}
/* ---------- v30.206 WB-4: regions ----------
   USBC has no region field. A ball's region comes from its name ("... Overseas", "(Korea)", "Int'l") or
   from your tag on this phone (bowlingdb_catalog_region_local, in catalog backups). Your tag wins; an empty
   tag means a US release even when the name says otherwise. */
var REGION_KEY = 'bowlingdb_catalog_region_local';
var REGION_WORDS = [['Overseas', /\boverseas\b/i], ['International', /\b(?:international|int'?l|intl|export)\b/i], ['Japan', /\b(?:japan|jpn)\b/i], ['Korea', /\b(?:korea|kor)\b/i],
  ['Asia', /\basia(?:n)?\b/i], ['Europe', /\b(?:europe|european|euro)\b/i], ['Australia', /\baustralia\b/i]];
function regionFromText(t) { t = String(t || ''); for (var i = 0; i < REGION_WORDS.length; i++) if (REGION_WORDS[i][1].test(t)) return REGION_WORDS[i][0]; return null; }
var _rgC = null;
var _rgRaw = null;   // parsed once per change (the raw string is compared: cheap, and safe if something else writes it)
function rgFresh() { var l = apLS(), raw = (l && l.getItem(REGION_KEY)) || '{}'; if (_rgC && raw === _rgRaw) return _rgC; try { _rgC = JSON.parse(raw) || {}; } catch (e) { _rgC = {}; } _rgRaw = raw; return _rgC; }
function regionTags() { return Object.assign({}, rgFresh()); }
function regionTagSet(id, v) { var l = apLS(); if (!l) return; var m = regionTags(); if (v === undefined) delete m[id]; else m[id] = v; _rgC = null; l.setItem(REGION_KEY, JSON.stringify(m)); }
function regionOf(e) { if (!e) return null; var m = rgFresh(); if (e.i in m) return m[e.i] || null;
  var br = tgFresh().brandRegion[e.m]; if (br) return br;   // v30.207: a brand you set as a region's
  return regionFromText(e.n + ' ' + (e.c || '')); }
/* ---------- v30.207 triage ----------
   bowlingdb_catalog_triage_local (this phone, in catalog backups):
     current     { id: 1 }        balls you said are still made (no "likely discontinued")
     brandRegion { brand: region } every ball of the brand is that region's release
   Buckets (first that applies): discontinued (maker retired, or yours) > international > upcoming
   (no specs yet, and approved in the last 4 months or a release date still ahead) > likely discontinued (approved
   over 3 years ago, maker status unknown) > current. */
var TRIAGE_KEY = 'bowlingdb_catalog_triage_local';
var _tgC = null;   // read once: discontinuedOf / regionOf run for every row of a search
var _tgRaw = null;
function tgFresh() { var l = apLS(), raw = (l && l.getItem(TRIAGE_KEY)) || '{}'; if (_tgC && raw === _tgRaw) return _tgC; var o = {}; try { o = JSON.parse(raw) || {}; } catch (e) {} o.current = o.current || {}; o.brandRegion = o.brandRegion || {}; _tgC = o; _tgRaw = raw; return o; }
function triageGet() { return JSON.parse(JSON.stringify(tgFresh())); }
function triageSave(o) { var l = apLS(); _tgC = null; if (l) l.setItem(TRIAGE_KEY, JSON.stringify(o)); }
/* Pure: months from 'YYYY-MM' to today's 'YYYY-MM' */
function monthsSince(ym, today) { var a = /^(\d{4})-(\d{2})/.exec(ym || ''), b = /^(\d{4})-(\d{2})/.exec(today || ''); if (!a || !b) return null; return (+b[1] - +a[1]) * 12 + (+b[2] - +a[2]); }
function upcomingOf(e, today, released) {
  if (e.s) return false;   // v30.209: specs already out means it is out, whatever the dates say
  today = today || new Date().toISOString().slice(0, 10);
  var m = e.d ? monthsSince(e.d, today) : null, recent = m != null && m >= 0 && m < 4;
  if (!recent && !released && !e.h) return false;   // cheap exit: only recent or held balls can be upcoming
  var ov = overrideFor(e.i);
  if (hlHasSpecs(e, ov)) return false;   // read from bowwwl or a maker page, or yours
  var rel = released || ((ov || {}).released) || null;
  if (rel && String(rel).slice(0, 10) > today) return true;
  return recent && !rel;
}
function triageOf(e, today, released) {
  if (catIsRejected(e)) return 'rejected';
  var d = discontinuedOf(e);
  if (d === 'retired') return 'discontinued';
  if (regionOf(e)) return 'international';
  if (upcomingOf(e, today, released)) return 'upcoming';
  if (d === 'likely') return 'likely';
  return 'current';
}
/* v30.206: My balls lists your whole arsenal
/* v30.206: My balls lists your whole arsenal (it showed only balls with fields left to review, so usually none) */
function srvStateOf(p) {
  if (!p.entry) return { t: 'not linked to the catalog', c: 'var(--gold)' };
  if (p.rows.length) return { t: p.rows.length + ' field' + (p.rows.length === 1 ? '' : 's') + ' to review', c: 'var(--teal)' };
  if (!p.catHas) return { t: 'catalog has no specs for it', c: 'var(--t3)' };
  return { t: '\u2713 checked against the catalog', c: 'var(--t2)' };
}
function srvListHTML() {
  var dev = catFixAllowed(), act = 0;
  var row = function (p, i) {
    var b = p.ball, st = srvStateOf(p), f = function (x, d) { return x == null || x === '' ? null : d ? Number(x).toFixed(3) : String(x); };
    var sum = [f(b.RG, 1) && 'RG ' + f(b.RG, 1), f(b.Differential, 1) && 'Diff ' + f(b.Differential, 1), f(b.CoreType), f(b.CoverName)].filter(Boolean).join(' \u00b7 ');
    var extra = !p.entry ? '<button style="' + BTN_G + 'padding:5px 9px;font-size:12px;margin-top:6px" onclick="event.stopPropagation();catSpecReviewClose();catReviewOpen()">Link</button>' :
      dev && !p.catHas && sum ? '<button style="' + BTN_P + 'padding:5px 9px;font-size:12px;margin-top:6px" onclick="event.stopPropagation();srvShareMine(' + i + ')">Give the catalog my specs</button>' : '';
    return '<div onclick="catSpecReviewGo(' + i + ')" style="padding:10px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' +
      '<div style="display:flex;justify-content:space-between;gap:8px"><div style="font-size:14px;font-weight:600;color:var(--t1)">' + esc(b.BallName) + '</div><div style="font-size:12px;color:' + st.c + ';text-align:right">' + esc(st.t) + '</div></div>' +
      '<div style="font-size:12px;color:var(--t2)">' + esc(b.MFG || '') + (b.Weight ? ' \u00b7 ' + esc(b.Weight) + ' lb' : '') + (p.entry ? ' \u00b7 ' + esc(cleanName(p.entry.n)) + (p.entry.y ? ' (' + esc(p.entry.y) + ')' : '') : '') + '</div>' +
      '<div style="font-size:11px;color:var(--t3);margin-top:2px">' + (sum ? 'yours: ' + esc(sum) : 'you have no specs on it') + '</div>' + extra + '</div>';
  };
  var active = [], retired = [];
  _srv.pages.forEach(function (p, i) { (p.ball.Archived ? retired : active).push(row(p, i)); act++; });
  var allMatches = 0; _srv.pages.forEach(function (p) { p.rows.forEach(function (r) { if (r.kind === 'match') allMatches++; }); });
  return '<div style="flex:1;overflow-y:auto;padding:0 16px 12px">' +
    (active.length ? '<div style="font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin:6px 0 2px">In your bag (' + active.length + ')</div>' + active.join('') : '') +
    (retired.length ? '<div style="font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 2px">Retired (' + retired.length + ')</div>' + retired.join('') : '') +
    (!act ? '<div style="padding:30px 0;text-align:center;color:var(--t2);font-size:13px">No balls in your arsenal yet.</div>' : '') +
    '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:10px">Tap a ball to see your specs next to the catalog\u2019s and confirm, keep or edit each one.' + (dev ? ' \u201cGive the catalog my specs\u201d opens Correct specs with your values filled in, to check and save.' : '') + '</div></div>' +
    (allMatches ? '<div style="padding:10px 16px;border-top:1px solid var(--border1)"><button style="' + BTN_P + 'width:100%;padding:10px" onclick="catSpecReviewBulk(\'all\',\'matches\')">Confirm all ' + allMatches + ' matches on every ball</button></div>' : '');
}
/* every field, yours next to the catalog's, when nothing is left to review */
function srvSummaryHTML(p) {
  var b = p.ball, has = function (v) { return v != null && v !== ''; };
  var line = function (f) { var cv = has(p.pub[f]) ? p.pub[f] : has(p.pend[f]) ? p.pend[f] : null;
    return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border1);font-size:13px"><div style="flex:0 0 90px;color:var(--t3);font-size:12px">' + SRV_LABEL[f] + '</div><div style="flex:1;color:var(--t1)">' + esc(srvFmt(f, has(b[f]) ? b[f] : null)) + '</div><div style="flex:1;color:var(--t2)">' + esc(srvFmt(f, cv)) + '</div></div>'; };
  return '<div style="padding:10px 0 4px;color:var(--teal);font-size:13px">' + (p.entry ? '\u2713 Nothing left to review on this ball.' : 'Not linked to the catalog, so there is nothing to compare.') + '</div>' +
    '<div style="display:flex;gap:10px;font-size:10px;color:var(--t3);padding:4px 0"><div style="flex:0 0 90px"></div><div style="flex:1">Yours</div><div style="flex:1">Catalog</div></div>' + SRV_ORDER.map(line).join('');
}
function catSpecReviewGo(i) { _srv.idx = i; _srv.view = 'ball'; _srv.editing = null; srvRender(); }
function catSpecReviewList() { _srv.view = 'list'; _srv.editing = null; srvRender(); }
/* Pure: your ball's specs as a read for its catalog entry (also the workbench's Use my ball's specs) */
function catMineAsRead(b, all) {
  var ct = String(b.CoreType || ''), w = parseInt(b.Weight, 10) || 15, x = {};
  if (b.RG != null && b.RG !== '') x.RG = Number(b.RG); if (b.Differential != null && b.Differential !== '') x.Diff = Number(b.Differential); if (b.IntDiff != null && b.IntDiff !== '') x.IntDiff = Number(b.IntDiff);
  var f = { fields: {}, weights: {}, source: 'other', host: 'your ' + b.BallName, nameSeen: true };
  [['coverName', b.CoverName], ['coverType', b.Coverstock], ['finish', b.BoxFinish], ['core', b.CoreShort], ['released', b.DateReleased]].forEach(function (q) { if (q[1]) f.fields[q[0]] = String(q[1]); });
  if (/^a/i.test(ct)) f.fields.coreType = 'Asymmetrical'; else if (/^s/i.test(ct)) f.fields.coreType = 'Symmetrical';
  if (/^(symm?|asymm?|symmetrical|asymmetrical)$/i.test(f.fields.core || '')) delete f.fields.core;
  if (Object.keys(x).length) f.weights[w] = x;
  var twin = (all || []).filter(function (o) { return o !== b && o.RG != null && Number(o.RG) === Number(b.RG) && Number(o.Differential) === Number(b.Differential); })[0];
  if (twin) f.warn = 'same RG / Diff as your ' + twin.BallName + ': check before saving';
  return f;
}
function srvShareMine(i) {
  var p = _srv.pages[i]; if (!p || !p.entry) return;
  var read = catMineAsRead(p.ball, appBalls());
  if (read.warn && root.toast) root.toast(read.warn, 5000);
  catCorrectWithParsed(p.entry.i, read, function () { srvLoad(); });
}
function catSpecReviewTab(k) { _srv.tab = k; _ms.page = 0; srvRender(); }
function msRender(ov, head) {
  catLoad().then(function (rows) {
    if (!document.getElementById('srv-ov') || _srv.tab !== 'missing') return;
    var mine = {}; appBalls().forEach(function (b) { if (b.CatalogID && !b.Archived) mine[b.CatalogID] = 1; });
    var all = msRows(rows, { mine: mine, rejected: catIsRejected, ovr: overrideFor });
    _ms.count = all.length;
    var q = norm(_ms.q || ''), list = q ? all.filter(function (e) { return norm(e.m + ' ' + e.n).indexOf(q) >= 0; }) : all;
    var pages = Math.max(1, Math.ceil(list.length / MS_PAGE)); if (_ms.page >= pages) _ms.page = pages - 1;
    var shown = list.slice(_ms.page * MS_PAGE, (_ms.page + 1) * MS_PAGE);
    var row = function (e) {
      var o = overrideFor(e.i), part = o && ['coverName', 'coverType', 'finish', 'core', 'coreType'].some(function (k) { return o[k]; });
      return '<div onclick="catMissingCorrect(\'' + jsq(e.i) + '\')" style="display:flex;gap:10px;align-items:center;padding:9px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' + thumbHTML(e, 40) +
        '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;color:var(--t1)">' + esc(cleanName(e.n)) + (mine[e.i] ? '<span style="' + CHIP_T + '">YOURS</span>' : '') + (catIsHeld(e) ? '<span style="' + CHIP_G + '">HELD</span>' : '') + '</div>' +
        '<div style="font-size:12px;color:var(--t2)">' + esc(e.m) + (e.y ? ' \u00b7 ' + esc(e.y) : '') + (part ? ' \u00b7 <span style="color:var(--gold)">some specs, no RG / Diff</span>' : ' \u00b7 no specs') + '</div></div>' +
        '<span style="color:var(--t3);font-size:18px">\u203a</span></div>';
    };
    ov.innerHTML = head(all.length + ' ball' + (all.length === 1 ? '' : 's') + ' with no specs') +
      '<div style="padding:0 16px 6px"><input class="bdet-field-input" type="search" placeholder="Filter by brand or name" value="' + esc(_ms.q) + '" oninput="catMissingFilter(this.value)" style="width:100%;box-sizing:border-box;font-size:15px"></div>' +
      '<div id="ms-list" style="flex:1;overflow-y:auto;padding:0 16px 10px">' + (shown.length ? shown.map(row).join('') : '<div style="padding:30px 0;text-align:center;color:var(--t2);font-size:13px">' + (all.length ? 'No match.' : 'Every catalog ball has specs.') + '</div>') +
      '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:10px">Tap a ball to fill in its specs: <b>Paste page &amp; fill</b>, or <b>Read a saved page (PDF)</b> from bowwwl or the maker\u2019s site (Hammer, Radical, MOTIV and others). A ball leaves this list once it has RG and Diff for a weight.</div></div>' +
      (pages > 1 ? '<div style="padding:10px 16px;border-top:1px solid var(--border1);display:flex;gap:8px;align-items:center"><button style="' + BTN_G + 'flex:1;padding:11px" ' + (_ms.page ? '' : 'disabled ') + 'onclick="catMissingPage(-1)">\u2039 Prev</button>' +
        '<span style="font-size:12px;color:var(--t2);min-width:70px;text-align:center">' + (_ms.page + 1) + ' of ' + pages + '</span>' +
        '<button style="' + BTN_G + 'flex:1;padding:11px" ' + (_ms.page < pages - 1 ? '' : 'disabled ') + 'onclick="catMissingPage(1)">Next \u203a</button></div>' : '');
  });
}
function catMissingCorrect(id) { return catCorrectFor(id, srvRender); }
function catMissingFilter(v) { _ms.q = v; _ms.page = 0; clearTimeout(_ms.t); _ms.t = setTimeout(function () { srvRender(); setTimeout(function () { var i = document.querySelector('#srv-ov input[type=search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }, 250); }
function catMissingPage(d) { _ms.page += d; srvRender(); var l = document.getElementById('ms-list'); if (l) l.scrollTop = 0; }

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
/* v30.205 Pure: a release date as YYYY-MM-DD or YYYY-MM ("06-05-2024", "6/5/2024", "06-2021" were saved as typed) */
function normReleased(v) {
  var t = String(v || '').trim(), m;
  if ((m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(t))) return m[1] + '-' + ('0' + m[2]).slice(-2) + (m[3] ? '-' + ('0' + m[3]).slice(-2) : '');
  if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(t))) return m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
  if ((m = /^(\d{1,2})[\/\-.](\d{4})$/.exec(t))) return m[2] + '-' + ('0' + m[1]).slice(-2);
  return t;
}
function apOverrideFrom(form) {
  var o = {}, err = [];
  ['coverName', 'coverType', 'finish', 'core', 'coreType', 'released'].forEach(function (k) { var v = String(form[k] || '').trim(); if (k === 'released') v = normReleased(v); if (v) o[k] = v; });
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
/* ---------- v30.185 REJ-1 / DISC-1: reject balls, mark discontinued (LOCKED 2026-10-12) ----------
   Your list lives in corrections/status.json on the specs branch, beside overrides.json:
     { "<catalogId>": { status: "retired", rejected: true?, reason: "cant-verify" | "not-made" | "manual", at, n, m } }
   Rejected (can't verify / no longer made): always discontinued, hidden from Add a Ball entirely,
   and skipped by every later extract and publish (the bridge reads the same file).
   Discontinued (manual): shown only with the Discontinued bubble, like a maker's retired ball.
   Both apply on this device at once (bowlingdb_catalog_status_local, kept in backups); the
   catalog follows after Publish (specs-publish -> catalog-refresh; index r 1 / x 1).
   A ball you own stays linked and keeps its catalog specs. */
var ST_PATH = '/contents/corrections/status.json';
var ST_LOCAL_KEY = 'bowlingdb_catalog_status_local';
var ST_REASONS = { 'cant-verify': 'Can\u2019t verify', 'not-made': 'No longer made', manual: 'Marked by you' };
var _stc = null, _stBusy = null, _stTimer = null, _stErr = null;
function stToday() { return new Date(env.now()).toISOString().slice(0, 10); }
/* { all: {id: entry}, pending: {id: stamp}, cleared: {id: {at, rejected}} } */
function stLocal() {
  if (_stc) return _stc;
  var l = apLS(), o = null;
  try { o = JSON.parse((l && l.getItem(ST_LOCAL_KEY)) || 'null'); } catch (e) {}
  o = o && typeof o === 'object' ? o : {};
  o.all = o.all || {}; o.pending = o.pending || {}; o.cleared = o.cleared || {};
  _stc = o; return o;
}
function stSaveLocal(o) { _stc = o; var l = apLS(); if (l) try { l.setItem(ST_LOCAL_KEY, JSON.stringify(o)); } catch (e) {} }
function stEntry(id) { return id ? (stLocal().all[id] || null) : null; }
/* Rejected: your entry decides; with none, the catalog's x flag (unless you restored it here). */
function catIsRejected(e) {
  if (!e) return false;
  var o = stLocal(), st = o.all[e.i];
  if (st) return !!st.rejected;
  if (o.cleared[e.i]) return false;
  return e.x === 1;
}
function stIdRejected(id) { var st = stEntry(id); return !!(st && st.rejected); }
/* entry null clears it. Several at once: pass save=false and call stSaveLocal(stLocal()). */
function stSet(id, entry, save) {
  var o = stLocal();
  if (entry) { o.all[id] = entry; delete o.cleared[id]; }
  else { var was = o.all[id]; delete o.all[id]; o.cleared[id] = { at: stToday(), rejected: was ? !!was.rejected : true }; }
  o.pending[id] = env.now() + Math.random();
  if (save !== false) stSaveLocal(o);
}
/* Pure: repo map + this device's pending changes -> the map to write (keys sorted). */
function stMerge(repo, local) {
  var next = Object.assign({}, repo || {});
  Object.keys((local && local.pending) || {}).forEach(function (id) {
    var e = local.all[id];
    if (e) next[id] = e; else delete next[id];
  });
  var out = {}; Object.keys(next).sort().forEach(function (k) { out[k] = next[k]; });
  return out;
}
function stReadRepo() {
  return apGH(ST_PATH + '?ref=specs').then(function (f) {
    var j = {}; try { j = JSON.parse(b64d(f.content) || '{}') || {}; } catch (e) {}
    return { sha: f.sha, map: j };
  }).catch(function (e) { if (e.status === 404) return { sha: null, map: {} }; throw e; });
}
/* Reads the repo copy, writes your pending changes, then mirrors the result here. */
function stSync() {
  if (_stBusy) return _stBusy;
  if (!apToken()) return Promise.resolve({ sent: 0, noToken: true });
  if (root.navigator && root.navigator.onLine === false) return Promise.resolve({ sent: 0, offline: true });
  var o = stLocal(), stamps = Object.assign({}, o.pending), ids = Object.keys(stamps);
  _stBusy = stReadRepo().then(function (repo) {
    var next = stMerge(repo.map, o);
    var put = !ids.length ? Promise.resolve() : apGH(ST_PATH, { method: 'PUT', body: Object.assign({
      message: 'catalog status: ' + ids.length + ' ball' + (ids.length === 1 ? '' : 's') + ' (rejected / discontinued)',
      content: b64e(JSON.stringify(next, null, 1) + '\n'), branch: 'specs' }, repo.sha ? { sha: repo.sha } : {}) });
    return put.then(function () {
      var cur = stLocal(), all = {};
      ids.forEach(function (id) { if (cur.pending[id] === stamps[id]) delete cur.pending[id]; });   // taps made while sending stay pending
      Object.keys(next).forEach(function (id) { all[id] = next[id]; });
      Object.keys(cur.pending).forEach(function (id) { if (cur.all[id]) all[id] = cur.all[id]; else delete all[id]; });
      cur.all = all; stSaveLocal(cur); _stErr = null;
      return { sent: ids.length };
    });
  }).then(function (r) { _stBusy = null; return r; }, function (e) {
    _stBusy = null;
    _stErr = e.status === 401 ? 'GitHub rejected the token (401).' : e.status === 403 || e.status === 404 ? 'The token needs Contents read and write on this repo (' + e.status + ').'
      : e.status === 409 || e.status === 422 ? 'GitHub copy changed while sending; it will retry.' : 'Not sent yet (' + (e.status ? 'GitHub ' + e.status : 'offline') + ').';
    throw e;
  });
  return _stBusy;
}
function stQueueSync() {
  clearTimeout(_stTimer);
  _stTimer = setTimeout(function () { stSync().then(dcPaintIfOpen, dcPaintIfOpen); }, 1200);
}
/* Restored balls: forget the local override once the catalog no longer flags them. */
function stPrune(rows) {
  var o = stLocal(), ch = false;
  Object.keys(o.cleared).forEach(function (id) { var e = byIdIn(rows, id); if (!e || e.x !== 1) { delete o.cleared[id]; ch = true; } });
  if (ch) stSaveLocal(o);
}

/* --- approvals: Reject this ball --- */
function apRejectHTML(id) {
  if (_ap.rejAsk !== id) return '<button style="' + BTN_G + 'margin-top:12px;width:100%;padding:10px;color:var(--red)" onclick="catApprovalsRejectAsk(true)">Reject this ball\u2026</button>';
  return '<div style="margin-top:12px;padding:12px;border-radius:12px;border:1px solid var(--red)">' +
    '<div style="font-size:14px;font-weight:700;color:var(--t1)">Reject this ball?</div>' +
    '<div style="font-size:12px;color:var(--t2);line-height:1.5;margin:4px 0 10px">It is marked discontinued, hidden from Add a Ball, and never comes back in a new extract. Restore it any time in Settings \u203a Discontinued &amp; rejected.</div>' +
    '<div style="display:flex;gap:8px"><button style="' + BTN_G + 'flex:1;padding:10px;color:var(--red)" onclick="catApprovalsReject(\'cant-verify\')">Can\u2019t verify</button>' +
    '<button style="' + BTN_G + 'flex:1;padding:10px;color:var(--red)" onclick="catApprovalsReject(\'not-made\')">No longer made</button></div>' +
    '<button style="' + BTN_G + 'width:100%;margin-top:8px;padding:9px" onclick="catApprovalsRejectAsk(false)">Cancel</button></div>';
}
function catApprovalsRejectAsk(on) {
  var p = _ap.pages[_ap.idx]; _ap.rejAsk = on && p ? p.catalogId : null; apRender();
  if (on) { var sc = document.querySelector('#ap-ov [style*="overflow-y:auto"]'); if (sc) sc.scrollTop = sc.scrollHeight; }
}
function catApprovalsReject(reason) {
  var p = _ap.pages[_ap.idx]; if (!p) return;
  var e = _ap._rows ? byIdIn(_ap._rows, p.catalogId) : null;
  stSet(p.catalogId, { status: 'retired', rejected: true, reason: reason, at: stToday(), n: e ? cleanName(e.n) : p.boxes[0].title, m: e ? e.m : null });
  var q = apQueue(), unt = false;
  p.boxes.forEach(function (b) { if (b.ticked) { q[b.tok] = false; unt = true; } });
  if (unt) { apSetQueue(q); clearTimeout(_apSendTimer); _apSendTimer = setTimeout(function () { catApprovalsSend(true); }, 1500); }
  _ap.rejAsk = null;
  _ap.pages.splice(_ap.idx, 1);
  _ap.idx = Math.max(0, Math.min(_ap.idx, _ap.pages.length - 1));
  apBuildPages(false); apRender();
  if (root.haptic) try { root.haptic('light'); } catch (x) {}
  if (root.toast) root.toast('Rejected. It won\u2019t come back in new extracts.');
  stQueueSync();
}

/* --- Settings > Balls & catalog > Discontinued & rejected --- */
var _dc = { tab: 'mark', brand: '', q: '', hide: true, open: {}, sel: {}, rows: null, groups: [] };
/* Pure: rows -> [{y, rows}] newest USBC year first ('\u2014' = no year, last).
   f: {brand ('*' = all), q, hide (skip balls already discontinued)}; rej(e) -> rejected?; st: your entries. */
function dcGroups(rows, f, rej, st) {
  st = st || {}; f = f || {};
  var q = foldName(f.q || ''), by = {}, keys = [];
  (rows || []).forEach(function (e) {
    if (rej && rej(e)) return;
    if (f.brand && f.brand !== '*' && norm(e.m) !== norm(f.brand)) return;
    if (q && foldName(e.m + ' ' + e.n).indexOf(q) < 0) return;
    var s = st[e.i];
    if (f.hide && ((s && s.status === 'retired') || e.r === 1)) return;
    var y = e.y || '\u2014';
    if (!by[y]) { by[y] = []; keys.push(y); }
    by[y].push(e);
  });
  keys.sort(function (a, b) { return a === '\u2014' ? 1 : b === '\u2014' ? -1 : String(b).localeCompare(String(a)); });
  return keys.map(function (y) {
    return { y: y, rows: by[y].sort(function (a, b) { return String(a.m).localeCompare(String(b.m)) || cleanName(a.n).localeCompare(cleanName(b.n)); }) };
  });
}
function catDiscOpen() {
  if (typeof document === 'undefined') return;
  var mb = document.getElementById('modal-bg');
  if (mb && mb.classList.contains('open') && typeof root.closeModal === 'function') root.closeModal();
  catDiscClose();
  var ov = overlay('dc-ov', 906); document.body.appendChild(ov);
  _dc.sel = {}; _dc.open = {}; _dc.q = ''; _dc.tab = 'mark';
  if (!_dc.brand) { var yb = yourBrands(); _dc.brand = yb[0] || '*'; }
  ov.innerHTML = '<div style="padding:30px;text-align:center;color:var(--t3)">Loading\u2026</div>';
  catLoad().then(function (rows) { _dc.rows = rows; stPrune(rows); dcRender(); });
  stSync().then(dcPaintIfOpen, dcPaintIfOpen);
}
function catDiscClose() { var el = document.getElementById('dc-ov'); if (el) el.parentNode.removeChild(el); }
function dcRejectedList() {
  var all = stLocal().all;
  return Object.keys(all).filter(function (id) { return all[id] && all[id].rejected; })
    .sort(function (a, b) { return String(all[b].at || '').localeCompare(String(all[a].at || '')) || a.localeCompare(b); });
}
function dcRender() {
  var ov = document.getElementById('dc-ov'); if (!ov || !_dc.rows) return;
  var nRej = dcRejectedList().length;
  var tab = function (k, label) {
    var on = _dc.tab === k;
    return '<button onclick="catDiscTab(\'' + k + '\')" style="flex:1;padding:8px;font-size:13px;font-weight:700;border-radius:9px;border:1px solid ' + (on ? 'var(--teal)' : 'var(--border1)') +
      ';background:' + (on ? 'rgba(0,217,217,0.12)' : 'transparent') + ';color:' + (on ? 'var(--teal)' : 'var(--t2)') + '">' + label + '</button>';
  };
  var brands = {}; _dc.rows.forEach(function (e) { if (e.m) brands[e.m] = 1; });
  var yb = yourBrands(), others = Object.keys(brands).filter(function (b) { return yb.indexOf(b) < 0; }).sort();
  var opt = function (v, l) { return '<option value="' + esc(v) + '"' + (_dc.brand === v ? ' selected' : '') + '>' + esc(l) + '</option>'; };
  var filters = _dc.tab !== 'mark' ? '' :
    '<div style="padding:0 16px 6px;display:flex;gap:8px"><select class="bdet-field-input" style="flex:0 0 42%;font-size:15px" onchange="catDiscBrand(this.value)">' +
      opt('*', 'All brands') + (yb.length ? '<optgroup label="Your brands">' + yb.map(function (b) { return opt(b, b); }).join('') + '</optgroup>' : '') +
      '<optgroup label="Others">' + others.map(function (b) { return opt(b, b); }).join('') + '</optgroup></select>' +
      '<input class="bdet-field-input" type="search" placeholder="Narrow by name" value="' + esc(_dc.q) + '" autocomplete="off" autocorrect="off" autocapitalize="off" oninput="catDiscSearch(this.value)" style="flex:1;min-width:0;font-size:15px"></div>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--t2);padding:0 16px 6px"><input type="checkbox" ' + (_dc.hide ? 'checked ' : '') +
      'onchange="catDiscHide(this.checked)"> Hide balls already discontinued</label>';
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catDiscClose()">\u2039</button>' +
    '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Discontinued &amp; rejected</div>' +
    '<div style="font-size:11px;color:var(--t3)">By USBC approval year, newest first</div></div></div>' +
    '<div style="display:flex;gap:8px;padding:0 16px 8px">' + tab('mark', 'Discontinue') + tab('rej', 'Rejected' + (nRej ? ' (' + nRej + ')' : '')) + '</div>' + filters +
    '<div id="dc-list" style="flex:1;overflow-y:auto;padding:0 16px 12px;-webkit-overflow-scrolling:touch;min-height:0"></div>' +
    '<div id="dc-foot" style="padding:10px 16px;border-top:1px solid var(--border1)"></div>';
  dcPaint();
}
function dcPaintIfOpen() { if (typeof document !== 'undefined' && document.getElementById('dc-ov')) dcPaint(); }
function dcSyncLine() {
  var np = Object.keys(stLocal().pending).length;
  if (!apToken()) return np ? '<div style="font-size:11px;color:var(--gold);line-height:1.45">On this phone now. Add your GitHub token in Spec approvals to save ' + np + ' change' + (np === 1 ? '' : 's') + ' to the catalog.</div>' : '';
  if (np) return '<div style="display:flex;gap:8px;align-items:center"><div style="flex:1;font-size:11px;color:var(--gold);line-height:1.45">' + np + ' change' + (np === 1 ? '' : 's') + ' waiting to send' +
    (_stErr ? ': ' + esc(_stErr) : '') + '</div><button style="' + BTN_G + 'padding:8px 12px;font-size:12px" onclick="catDiscSend()">Send now</button></div>';
  return '<div style="display:flex;gap:8px;align-items:center"><div style="flex:1;font-size:11px;color:var(--t3);line-height:1.45">Saved. This phone shows it now; Publish updates the catalog itself (a few minutes).</div>' +
    '<button style="' + BTN_G + 'padding:8px 12px;font-size:12px" onclick="catDiscPublish()">Publish</button></div>';
}
function dcPaint() {
  var box = document.getElementById('dc-list'), foot = document.getElementById('dc-foot'); if (!box || !_dc.rows) return;
  var all = stLocal().all, owned = ownedIndex(_dc.rows);
  if (_dc.tab === 'rej') {
    var ids = dcRejectedList();
    box.innerHTML = ids.length ? ids.map(function (id) {
      var s = all[id], e = byIdIn(_dc.rows, id);
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 2px;border-bottom:1px solid var(--border1)"><div style="flex:1;min-width:0">' +
        '<div style="font-size:14px;font-weight:600;color:var(--t1)">' + esc(e ? cleanName(e.n) : (s.n || id)) + '</div>' +
        '<div style="font-size:12px;color:var(--t2)">' + esc(e ? e.m : (s.m || '')) + (e && e.y ? ' \u00b7 ' + esc(e.y) : '') + ' \u00b7 ' + esc(ST_REASONS[s.reason] || s.reason || '') + ' \u00b7 ' + esc(s.at || '') + '</div></div>' +
        '<button style="' + BTN_G + 'padding:8px 12px;font-size:12px" onclick="catDiscRestore(\'' + esc(id) + '\')">Restore</button></div>';
    }).join('') : '<div style="font-size:13px;color:var(--t2);padding:24px 2px;line-height:1.6">Nothing rejected. Use <b>Reject this ball</b> on a Spec approvals card for a ball you can\u2019t verify or that is no longer made.</div>';
    foot.innerHTML = dcSyncLine(); return;
  }
  _dc.groups = dcGroups(_dc.rows, { brand: _dc.brand, q: _dc.q, hide: _dc.hide }, catIsRejected, all);
  var multi = _dc.brand === '*';
  box.innerHTML = _dc.groups.length ? _dc.groups.map(function (g, gi) {
    var nSel = g.rows.filter(function (e) { return _dc.sel[e.i]; }).length, open = _dc.open[g.y] || !!_dc.q;
    var head = '<div style="display:flex;align-items:center;gap:10px;padding:11px 2px;border-bottom:1px solid var(--border1);position:sticky;top:0;background:var(--bg0);z-index:1">' +
      '<input type="checkbox" ' + (nSel && nSel === g.rows.length ? 'checked ' : '') + 'onchange="catDiscYear(' + gi + ',this.checked)" aria-label="Select all ' + esc(g.y) + '" style="width:20px;height:20px">' +
      '<div onclick="catDiscToggle(' + gi + ')" style="flex:1;display:flex;align-items:center;gap:8px;cursor:pointer">' +
      '<span style="font-size:16px;font-weight:800;color:var(--t1)">' + esc(g.y) + '</span><span style="font-size:12px;color:var(--t3)">' + g.rows.length + ' ball' + (g.rows.length === 1 ? '' : 's') +
      (nSel ? ' \u00b7 <span style="color:var(--teal)">' + nSel + ' selected</span>' : '') + '</span><span style="margin-left:auto;color:var(--t3)">' + (open ? '\u25be' : '\u25b8') + '</span></div></div>';
    if (!open) return head;
    return head + g.rows.map(function (e) {
      var s = all[e.i], dc = discontinuedOf(e), mine = owned && (owned.linked[e.i] || owned.keyed[e.k]);
      var tag = s && s.status === 'retired' ? '<span style="color:var(--gold)">marked by you</span>' : dc === 'retired' ? '<span style="color:var(--t3)">retired</span>' : dc === 'likely' ? '<span style="color:var(--t3)">likely retired</span>' : '';
      return '<label style="display:flex;align-items:center;gap:10px;padding:9px 2px 9px 4px;border-bottom:1px solid var(--border1);cursor:pointer">' +
        '<input type="checkbox" ' + (_dc.sel[e.i] ? 'checked ' : '') + 'onchange="catDiscPick(\'' + esc(e.i) + '\',this.checked)" style="width:18px;height:18px">' +
        '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;color:var(--t1)">' + esc(cleanName(e.n)) + (mine ? '<span style="' + CHIP_T + '">IN YOUR ARSENAL</span>' : '') + '</div>' +
        '<div style="font-size:12px;color:var(--t2)">' + [multi ? esc(e.m) : '', e.s ? 'specs' : '', tag].filter(Boolean).join(' \u00b7 ') + '</div></div></label>';
    }).join('');
  }).join('') : '<div style="font-size:13px;color:var(--t2);padding:24px 2px">No balls match.</div>';
  var sel = Object.keys(_dc.sel), mark = sel.filter(function (id) { var s = all[id]; return !(s && s.status === 'retired'); }).length;
  var unmark = sel.filter(function (id) { var s = all[id]; return s && !s.rejected && s.reason === 'manual'; }).length;
  foot.innerHTML = (sel.length ? '<div style="display:flex;gap:8px;margin-bottom:8px">' +
      (mark ? '<button style="' + BTN_P + 'flex:1;padding:11px" onclick="catDiscMark(true)">Mark ' + mark + ' discontinued</button>' : '') +
      (unmark ? '<button style="' + BTN_G + 'flex:1;padding:11px" onclick="catDiscMark(false)">Unmark ' + unmark + '</button>' : '') +
      '<button style="' + BTN_G + 'padding:11px" onclick="catDiscClear()">Clear</button></div>' : '') + dcSyncLine();
}
function catDiscTab(k) { _dc.tab = k; dcRender(); }
function catDiscBrand(v) { _dc.brand = v; _dc.open = {}; dcPaint(); }
function catDiscSearch(v) { _dc.q = String(v || ''); dcPaint(); }
function catDiscHide(on) { _dc.hide = !!on; dcPaint(); }
function catDiscToggle(gi) { var g = _dc.groups[gi]; if (!g) return; _dc.open[g.y] = !_dc.open[g.y]; dcPaint(); }
function catDiscYear(gi, on) { var g = _dc.groups[gi]; if (!g) return; g.rows.forEach(function (e) { if (on) _dc.sel[e.i] = 1; else delete _dc.sel[e.i]; }); dcPaint(); }
function catDiscPick(id, on) { if (on) _dc.sel[id] = 1; else delete _dc.sel[id]; dcPaint(); }
function catDiscClear() { _dc.sel = {}; dcPaint(); }
function catDiscMark(on) {
  var all = stLocal().all, d = stToday(), n = 0;
  Object.keys(_dc.sel).forEach(function (id) {
    var s = all[id];
    if (on) {
      if (s && s.status === 'retired') return;
      var e = byIdIn(_dc.rows, id);
      stSet(id, { status: 'retired', reason: 'manual', at: d, n: e ? cleanName(e.n) : null, m: e ? e.m : null }, false); n++;
    } else if (s && !s.rejected && s.reason === 'manual') { stSet(id, null, false); n++; }
  });
  stSaveLocal(stLocal());
  _dc.sel = {}; dcPaint();
  if (root.toast) root.toast(n + ' ball' + (n === 1 ? '' : 's') + (on ? ' marked discontinued' : ' unmarked'));
  stQueueSync();
}
function catDiscRestore(id) {
  stSet(id, null); dcRender();
  if (root.toast) root.toast('Restored. It can come back in the next extract.');
  stQueueSync();
}
function catDiscSend() { stSync().then(function (r) { if (r && r.sent && root.toast) root.toast(r.sent + ' change' + (r.sent === 1 ? '' : 's') + ' saved to GitHub'); dcPaintIfOpen(); }, dcPaintIfOpen); }
function catDiscPublish() {
  stSync().catch(function () {}).then(function () { return vfyDispatchPublish(); }).then(function () {
    if (root.toast) root.toast('specs-publish started. The catalog updates when it finishes (a few minutes).');
  }).catch(function (e) {
    if (root.toast) root.toast(e && (e.status === 403 || e.status === 404) ? 'Token needs Actions read and write to publish' : ('Publish failed: ' + (e && e.status ? 'GitHub ' + e.status : 'offline')));
  });
}
if (typeof root.addEventListener === 'function') root.addEventListener('online', function () { if (Object.keys(stLocal().pending).length) stSync().catch(function () {}); });

/* ---------- v30.185 FIX-1: Fix a catalog ball from its card (dev mode only, LOCKED 2026-10-12) ----------
   A "Fix" button beside Compare on the Add a Ball sheet, shown only while dev mode is on
   (bowlingdb_devkit.enabled), so it never reaches end users. Correct specs (the same sheet as
   approvals, compared against the staged row, else the published entry), Verify now, Mark
   discontinued / Unmark, Reject / Restore. A ball the bridge never read publishes from a
   correction alone once it has RG + Diff for a weight (publish.js). */
var _fix = null;
function catFixAllowed() {
  try { if (typeof root.dkIsEnabled === 'function') return !!root.dkIsEnabled(); } catch (e) {}
  try { var l = apLS(); return !!(JSON.parse((l && l.getItem('bowlingdb_devkit')) || '{}').enabled); } catch (e) { return false; }
}
/* Pure: published catalog entry -> the staged-row shape the correction sheet compares against. */
function detAsStaged(d) {
  if (!d) return null;
  var w = {}, sbw = d.SpecsByWeight || {};
  Object.keys(sbw).forEach(function (k) { var x = sbw[k] || {}; w[k] = { RG: x.RG == null ? null : x.RG, Diff: x.Diff == null ? null : x.Diff, IntDiff: x.IntDiff == null ? null : x.IntDiff }; });
  var co = d.Core || {}, cv = d.Cover || {};
  return { specs: { coverName: cv.Name || null, coverType: cv.Type || null, finish: cv.Finish || null, core: co.Name || null, coreType: co.Type || null,
    released: d.DateReleased || null, weights: w }, url: d.Source || null, title: null };
}
function catFixOpen() {
  if (!_sheet || !_sheet.id || typeof document === 'undefined') return;
  catLoad().then(function (rows) {
    var e = byIdIn(rows, _sheet.id); if (!e) return;
    _fix = { id: e.i, e: e, ask: false, bridge: apToken() ? 'loading' : 'notoken', row: null };
    catFixClose();
    document.body.appendChild(overlay('fix-ov', 915)); fixRender();
    if (!apToken()) return;
    apReadOverrides().catch(function () {});
    apReadStaged().then(function (st) {
      if (!_fix || _fix.id !== e.i) return;
      var r = srvStagedRow(st, e.i); _fix.row = r;
      _fix.bridge = !r ? 'none' : r.decision === 'auto' ? 'auto' : 'pending'; fixRender();
    }, function () { if (_fix) { _fix.bridge = 'error'; fixRender(); } });
  });
}
function catFixClose() { var el = document.getElementById('fix-ov'); if (el) el.parentNode.removeChild(el); }
function fixRender() {
  var ov = document.getElementById('fix-ov'); if (!ov || !_fix) return;
  var e = _fix.e, st = stEntry(e.i), dc = discontinuedOf(e), rej = catIsRejected(e);
  var line = function (k, v) { return '<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border1);font-size:13px"><span style="color:var(--t2)">' + k + '</span><span style="color:var(--t1);text-align:right">' + v + '</span></div>'; };
  var bridge = { loading: 'checking\u2026', notoken: '<span style="color:var(--gold)">add your GitHub token in Spec approvals</span>', error: 'couldn\u2019t read staging',
    auto: 'read and auto-published', pending: 'read, waiting for approval',
    none: 'not read \u00b7 a correction with RG + Diff publishes on its own' }[_fix.bridge] || '';
  var status = rej ? '<span style="color:var(--red)">rejected</span>' : st && st.status === 'retired' ? '<span style="color:var(--gold)">discontinued (marked by you)</span>'
    : dc === 'retired' ? 'retired (maker)' : dc === 'likely' ? 'likely retired (age)' : e.r === 0 ? 'current (maker)' : 'unknown';
  var src = sourceForBrand(e.m);
  var btn = function (label, js, primary, extra) { return '<button style="' + (primary ? BTN_P : BTN_G) + 'width:100%;padding:12px;margin-top:8px;' + (extra || '') + '" onclick="' + js + '">' + label + '</button>'; };
  var statusBtns = rej ? btn('Restore (un-reject)', 'catFixMark(\'restore\')')
    : st && st.status === 'retired' ? btn('Unmark discontinued', 'catFixMark(\'off\')') : btn('Mark discontinued', 'catFixMark(\'on\')');
  var reject = rej ? '' : !_fix.ask ? btn('Reject this ball\u2026', 'catFixRejectAsk(true)', false, 'color:var(--red)') :
    '<div style="margin-top:8px;padding:12px;border-radius:12px;border:1px solid var(--red)"><div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:8px">Marked discontinued, hidden from Add a Ball, never back in a new extract.</div>' +
    '<div style="display:flex;gap:8px"><button style="' + BTN_G + 'flex:1;padding:10px;color:var(--red)" onclick="catFixReject(\'cant-verify\')">Can\u2019t verify</button>' +
    '<button style="' + BTN_G + 'flex:1;padding:10px;color:var(--red)" onclick="catFixReject(\'not-made\')">No longer made</button></div>' +
    '<button style="' + BTN_G + 'width:100%;margin-top:8px;padding:9px" onclick="catFixRejectAsk(false)">Cancel</button></div>';
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catFixClose()">\u2039</button>' +
    '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Fix \u00b7 ' + esc(cleanName(e.n)) + '</div>' +
    '<div style="font-size:11px;color:var(--t3)">' + esc(e.m) + ' \u00b7 USBC ' + esc(e.i) + ' \u00b7 dev mode</div></div></div>' +
    '<div style="flex:1;overflow-y:auto;padding:0 16px 16px">' +
      line('Catalog specs', e.s ? 'published' : 'none') + line('Status', status) + line('Bridge', bridge) +
      btn('Correct specs', 'catFixCorrect()', true) +
      (src ? vfySlotHTML(e.i, btn('Verify now: re-read the ' + esc(src) + ' site', 'catVerifyNow(\'' + esc(e.m) + '\',\'' + esc(e.i) + '\')')) : '') +
      statusBtns + reject + fixPicHTML(e) +
      '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:14px">Changes save to GitHub; this phone shows status changes at once. Publish rebuilds the catalog for everyone.</div>' +
      btn('Publish', 'catDiscPublish()') + btn('Check for catalog update', 'catFixRefresh()') +
      '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:6px">After Publish finishes (a few minutes), Check pulls the rebuilt catalog onto this phone; otherwise it updates on the next daily check.</div>' +
    '</div>';
}
/* --- v30.187 FIX-2: pictures on the Fix screen (this device only, like every catalog picture) ---
   Ball picture: per catalog ball (bdb_catimg[id], or a link in bdbimg_pick). Core picture: per core
   (brand + core name, shared by every ball with that core), or per ball when the core name is unknown. */
function fixCoreKey(e) {
  var d = _sheet && _sheet.id === e.i ? (_sheet.detail || _sheet.raw) : null, nm = d && d.Core && d.Core.Name;
  var k = nm ? coreKeyOf(e.m, nm) : null;
  return { key: k || ('id-' + e.i), name: k ? nm : null };
}
function fixPicHTML(e) {
  var ck = fixCoreKey(e), cover = catImageFor(e.i), core = _catImgObj['core:' + ck.key] || coreLinks()[ck.key] || null;
  var row = function (part, label, url, note) {
    var b = function (t, js) { return '<button style="' + BTN_G + 'flex:1;padding:9px 0;font-size:12px" onclick="' + js + '">' + t + '</button>'; };
    return '<div style="display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border1)">' +
      '<div style="flex:0 0 64px;height:64px;border-radius:12px;background:#fff;overflow:hidden;display:flex;align-items:center;justify-content:center">' +
        (url ? '<img src="' + esc(url) + '" referrerpolicy="no-referrer" alt="" style="width:100%;height:100%;object-fit:contain">' : '<span style="font-size:11px;color:#888">none</span>') + '</div>' +
      '<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:var(--t1)">' + label + '</div>' +
        (note ? '<div style="font-size:11px;color:var(--t3);margin:2px 0 6px">' + note + '</div>' : '<div style="height:6px"></div>') +
        '<div style="display:flex;gap:6px">' + b('bowwwl', 'catFixPic(\'' + part + '\',\'bowwwl\')') + b('Paste', 'catFixPic(\'' + part + '\',\'paste\')') + b('Camera', 'catFixPic(\'' + part + '\',\'camera\')') + b('File', 'catFixPic(\'' + part + '\',\'file\')') +
        (url ? b('Remove', 'catFixPic(\'' + part + '\',\'remove\')') : '') + '</div>' + fixFindHTML(e, part, ck) + '</div></div>';
  };
  return '<div style="font-size:11px;font-weight:700;color:var(--t3);margin:16px 0 2px;text-transform:uppercase;letter-spacing:.5px">Pictures (this phone)</div>' +
    row('ball', 'Ball', cover, null) +
    row('core', 'Core', core, ck.name ? 'Shared by every ' + esc(e.m) + ' ball with the ' + esc(ck.name) + ' core' : 'Core name unknown: kept for this ball only');
}
/* Clipboard -> {blob} | {url} | null */
/* v30.187: Find links, same as the Ball images screen: bowwwl page, maker (catalog source page, else a site
   search), web image search; the ball row adds a core image search when the core is known. Open in Safari,
   long-press the picture, Copy, come back, Paste. */
function fixFindHTML(e, part, ck) {
  var name = cleanName(e.n), raw = _sheet && _sheet.id === e.i ? _sheet.raw : null, site = MAKER_SITE[brandSlug(e.m)];
  var a = function (u, t) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal);text-decoration:none">' + t + '</a>'; };
  var g = function (q) { return 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(q); };
  var core = part === 'core', coreQ = ck.name ? coreBase(ck.name) + ' core' : name + ' core';
  var maker = !core && raw && /^https:/.test(raw.Source || '') ? raw.Source
    : site ? 'https://www.google.com/search?q=' + encodeURIComponent('site:' + site + ' ' + (core ? coreQ : name)) : null;
  return '<div style="font-size:11px;margin-top:6px;color:var(--t3)">Find: ' + a(bowwwlLinks(e.m, name).page, 'bowwwl \u2197') + ' \u00b7 ' +
    (maker ? a(maker, 'maker \u2197') + ' \u00b7 ' : '') + a(g(e.m + ' ' + (core ? coreQ : name + ' bowling ball')), 'web \u2197') +
    (!core && ck.name ? ' \u00b7 ' + a(g(e.m + ' ' + coreQ), 'core web \u2197') : '') + '</div>';
}
/* bowwwl picture addresses for this ball or core, tried in order (only when you tap). */
function fixTryBowwwl(e, part, ck) {
  var list = part === 'ball' ? bowwwlImgCandidates(e.m, cleanName(e.n)) : (ck.name ? bowwwlCoreCandidates(e.m, ck.name) : []);
  var i = 0, next = function () { if (i >= list.length) return Promise.resolve(null); return imgProbe(list[i++]).then(function (u) { return u || next(); }); };
  return next();
}
function fixClipImage() {
  var cb = typeof navigator !== 'undefined' && navigator.clipboard;
  if (cb && cb.read) return cb.read().then(function (items) {
    for (var i = 0; i < items.length; i++) { var t = items[i].types.filter(function (x) { return /^image\//.test(x); })[0]; if (t) return items[i].getType(t).then(function (b) { return { blob: b }; }); }
    for (var j = 0; j < items.length; j++) if (items[j].types.indexOf('text/plain') >= 0)
      return items[j].getType('text/plain').then(function (b) { return b.text(); }).then(function (s) { var m = /https?:\/\/\S+/.exec(s || ''); return m ? { url: m[0] } : null; });
    return null;
  });
  if (cb && cb.readText) return cb.readText().then(function (s) { var m = /https?:\/\/\S+/.exec(s || ''); return m ? { url: m[0] } : null; });
  return Promise.reject(new Error('no clipboard'));
}
function fixPickFile(camera) {
  return new Promise(function (res) {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
    if (camera) inp.setAttribute('capture', 'environment');
    inp.addEventListener('change', function () { var f = inp.files && inp.files[0]; if (inp.parentNode) inp.parentNode.removeChild(inp); res(f ? { blob: f } : null); });
    document.body.appendChild(inp); inp.click();
  });
}
function catImgDel(id) {
  if (_catImgObj[id]) { try { URL.revokeObjectURL(_catImgObj[id]); } catch (e) {} delete _catImgObj[id]; }
  return catImgDB().then(function (db) { return new Promise(function (res) {
    var t = db.transaction('img', 'readwrite'); t.objectStore('img').delete(id); t.oncomplete = function () { res(true); }; t.onerror = function () { res(false); }; }); }).catch(function () { return false; });
}
function catFixPic(part, how) {
  if (!_fix) return; var e = _fix.e, ck = fixCoreKey(e);
  var idKey = part === 'ball' ? e.i : 'core:' + ck.key;
  var clearLink = function () { if (part === 'ball') imgPickSet(e.i, null); else coreLinkSet(ck.key, null); };
  var done = function (msg) { fixRender(); if (document.getElementById('cat-sheet-ov')) renderSheet(); if (msg && root.toast) root.toast(msg); };
  if (how === 'remove') { clearLink(); catImgDel(idKey).then(function () { done('Picture removed'); }); return; }
  if (how === 'bowwwl') {
    if (part === 'core' && !ck.name) { if (root.toast) root.toast('Core name unknown: use Find, then Paste'); return; }
    if (root.toast) root.toast('Checking bowwwl\u2026');
    fixTryBowwwl(e, part, ck).then(function (u) {
      if (!u) { if (root.toast) root.toast('Not found on bowwwl: try Find, then Paste'); return; }
      return catImgDel(idKey).then(function () { if (part === 'ball') imgPickSet(e.i, u); else coreLinkSet(ck.key, u); done((part === 'ball' ? 'Ball' : 'Core') + ' picture found on bowwwl'); });
    });
    return;
  }
  var get = how === 'paste' ? fixClipImage() : fixPickFile(how === 'camera');
  get.then(function (got) {
    if (!got) { if (how === 'paste' && root.toast) root.toast('Copy the picture first (long-press it in Safari, Copy)'); return; }
    if (got.blob) return imgShrink(got.blob).then(function (b) { return catImgPut(idKey, b); }).then(function () { clearLink(); done((part === 'ball' ? 'Ball' : 'Core') + ' picture saved'); });
    return imgProbe(got.url).then(function (u) {
      if (!u) { if (root.toast) root.toast('That address did not load as a picture'); return; }
      return catImgDel(idKey).then(function () { if (part === 'ball') imgPickSet(e.i, u); else coreLinkSet(ck.key, u); done((part === 'ball' ? 'Ball' : 'Core') + ' picture link saved'); });
    });
  }, function () { if (root.toast) root.toast('Paste is not available here; use Camera or File'); });
}
function catFixRefresh() {
  if (root.toast) root.toast('Checking the catalog\u2026');
  catCheck({ force: true }).then(function (r) {
    if (root.toast) root.toast(r && r.status === 'updated' ? 'Catalog updated' : r && r.status === 'current' ? 'Catalog is up to date (Publish may still be running)' : 'Catalog check failed');
    if (!_fix) return;
    return catLoad().then(function (rows) {
      var e = byIdIn(rows, _fix.id); if (e) _fix.e = e;
      if (_sheet && _sheet.id === _fix.id) return catDetailRaw(_fix.e).then(function (raw) { _sheet.raw = raw; _sheet.detail = sheetDetail(_fix.id, raw); renderSheet(); fixRender(); });
      fixRender();
    });
  });
}
function catFixCorrect() {
  if (!_fix) return;
  var e = _fix.e, raw = _sheet && _sheet.id === e.i ? _sheet.raw : null;
  var go = function () {
    /* v30.189: from the card, compare with what the card shows (the published catalog). The staged row
       (what the bridge read) was used before, so its values showed "same as now" and were never saved,
       though the card did not have them. A ball not yet published falls back to the staged row. */
    var base0 = raw ? detAsStaged(raw) : (_fix.row || null);
    apEditOpen({ catalogId: e.i, title: cleanName(e.n), entry: e, base0: base0, origin: 'sheet' });
  };
  (apToken() ? apReadOverrides().catch(function () {}) : Promise.resolve()).then(go);
}
/* v30.201 MS-1: Correct specs for any catalog ball, from a list (Review new balls, Review my specs >
   Missing specs). Compared against the published entry, else what the bridge read, like the card. */
function catCorrectFor(id, after) {
  return catLoad().then(function (rows) {
    var e = byIdIn(rows, id); if (!e) return null;
    var raw = e.s ? catDetailRaw(e).catch(function () { return null; }) : Promise.resolve(null);
    var st = apToken() ? apReadStaged().then(function (x) { return srvStagedRow(x, id); }, function () { return null; }) : Promise.resolve(null);
    var ov = apToken() ? apReadOverrides().catch(function () {}) : Promise.resolve();
    return Promise.all([raw, st, ov]).then(function (r) {
      apEditOpen({ catalogId: id, title: cleanName(e.n), entry: e, base0: r[0] ? detAsStaged(r[0]) : r[1], baseKind: r[0] ? 'published' : 'bridge', origin: 'list', after: after || null });
      return e;
    });
  });
}
function fixAfterEdit() {
  if (_sheet && _sheet.id && document.getElementById('cat-sheet-ov')) { _sheet.detail = sheetDetail(_sheet.id, _sheet.raw); renderSheet(); }
  fixRender();
}
function catFixMark(how) {
  if (!_fix) return; var e = _fix.e;
  if (how === 'on') stSet(e.i, { status: 'retired', reason: 'manual', at: stToday(), n: cleanName(e.n), m: e.m });
  else stSet(e.i, null);
  fixRender(); stQueueSync();
  if (root.toast) root.toast(how === 'on' ? 'Marked discontinued' : how === 'off' ? 'Unmarked' : 'Restored');
}
function catFixRejectAsk(on) { if (_fix) { _fix.ask = !!on; fixRender(); } }
function catFixReject(reason) {
  if (!_fix) return; var e = _fix.e;
  stSet(e.i, { status: 'retired', rejected: true, reason: reason, at: stToday(), n: cleanName(e.n), m: e.m });
  stQueueSync(); catFixClose(); catSheetClose();
  if (root.toast) root.toast('Rejected. It won\u2019t come back in new extracts.');
}

/* ---------- v30.200 HOLD-1: Review new balls (dev mode; decisions LOCKED 2026-10-17) ----------
   The weekly build holds balls (index h: 1 first pass, 2 new; kept in dist/hold.json): once, every ball that had no
   published specs (first pass); after that only balls new in a USBC refresh. A held ball is not
   offered in Add a Ball until you Approve it here. Approve needs specs (published, or a saved
   correction with RG and Diff for a weight); approving writes it to corrections/released.json on
   the specs branch (read-merge-PUT, like status.json) and the next build drops it from the hold for
   good. On this phone it shows in Add a Ball at once. Spec and picture automation are unchanged.
   Released list mirrored in bowlingdb_catalog_released_local { all: {id: {at, n, m}}, pending }. */
var RL_PATH = '/contents/corrections/released.json', RL_LOCAL_KEY = 'bowlingdb_catalog_released_local';
var _rlc = null, _rlBusy = null, _rlTimer = null, _rlErr = null;
function rlLocal() {
  if (_rlc) return _rlc;
  var l = apLS(), o = null; try { o = JSON.parse((l && l.getItem(RL_LOCAL_KEY)) || 'null'); } catch (e) {}
  o = o && typeof o === 'object' ? o : {}; o.all = o.all || {}; o.pending = o.pending || {}; _rlc = o; return o;
}
function rlSaveLocal(o) { _rlc = o; var l = apLS(); if (l) try { l.setItem(RL_LOCAL_KEY, JSON.stringify(o)); } catch (e) {} }
function catIsReleased(id) { return !!rlLocal().all[id]; }
function catIsHeld(e) { return !!e && !!e.h && !catIsReleased(e.i); }   // index h: 1 first pass, 2 new in a refresh
/* Pure: does this ball have specs to approve? published (s 1) or a correction with RG + Diff for a weight */
function hlHasSpecs(e, ovr) {
  if (e && e.s) return true;
  var w = (ovr && ovr.weights) || {};
  return Object.keys(w).some(function (k) { return w[k] && w[k].RG != null && w[k].Diff != null; });
}
/* Pure: repo map + pending approvals -> map to write (keys sorted) */
function rlMerge(repo, local) {
  var next = Object.assign({}, repo || {});
  Object.keys((local && local.pending) || {}).forEach(function (id) { if (local.all[id]) next[id] = local.all[id]; else delete next[id]; });   // v30.206: undo removes
  var out = {}; Object.keys(next).sort().forEach(function (k) { out[k] = next[k]; }); return out;
}
function rlSync() {
  if (_rlBusy) return _rlBusy;
  if (!apToken()) return Promise.resolve({ sent: 0, noToken: true });
  if (root.navigator && root.navigator.onLine === false) return Promise.resolve({ sent: 0, offline: true });
  var o = rlLocal(), stamps = Object.assign({}, o.pending), ids = Object.keys(stamps);
  if (!ids.length) return Promise.resolve({ sent: 0 });
  _rlBusy = apGH(RL_PATH + '?ref=specs').then(function (f) { var j = {}; try { j = JSON.parse(b64d(f.content) || '{}') || {}; } catch (e) {} return { sha: f.sha, map: j }; },
    function (e) { if (e.status === 404) return { sha: null, map: {} }; throw e; }).then(function (repo) {
    var next = rlMerge(repo.map, o);
    return apGH(RL_PATH, { method: 'PUT', body: Object.assign({ message: 'catalog: released ' + ids.length + ' ball' + (ids.length === 1 ? '' : 's') + ' from review',
      content: b64e(JSON.stringify(next, null, 1) + '\n'), branch: 'specs' }, repo.sha ? { sha: repo.sha } : {}) }).then(function () {
      var cur = rlLocal(); ids.forEach(function (id) { if (cur.pending[id] === stamps[id]) delete cur.pending[id]; });
      Object.keys(next).forEach(function (id) { if (!cur.all[id]) cur.all[id] = next[id]; });
      rlSaveLocal(cur); _rlErr = null; return { sent: ids.length };
    });
  }).then(function (r) { _rlBusy = null; return r; }, function (e) {
    _rlBusy = null; _rlErr = e.status === 401 ? 'GitHub rejected the token (401).' : e.status === 403 || e.status === 404 ? 'The token needs Contents read and write (' + e.status + ').' : 'Not sent yet (' + (e.status ? 'GitHub ' + e.status : 'offline') + ').';
    throw e;
  });
  return _rlBusy;
}
function rlQueueSync() { clearTimeout(_rlTimer); _rlTimer = setTimeout(function () { rlSync().then(hlPaint, hlPaint); }, 1200); }
/* Pure: held rows for the screen, newest first (new before first pass), with their state */
function hlRows(rows, opt) {
  opt = opt || {};
  return (rows || []).filter(function (e) { return !!e.h && !(opt.released && opt.released[e.i]) && !(opt.rejected && opt.rejected(e)); }).map(function (e) {
    var ov = opt.ovr ? opt.ovr(e.i) : null;
    return { e: e, why: e.h === 2 ? 'new' : 'first', specs: e.s ? 'published' : hlHasSpecs(e, ov) ? 'corrected' : opt.waiting && opt.waiting[e.i] ? 'waiting' : 'none',
      ready: hlHasSpecs(e, ov) };
  }).sort(function (a, b) { return (a.why === b.why ? 0 : a.why === 'new' ? -1 : 1) || String(b.e.y || '').localeCompare(String(a.e.y || '')) || String(a.e.m).localeCompare(String(b.e.m)) || cleanName(a.e.n).localeCompare(cleanName(b.e.n)); });
}
var _hl = { show: 'all', q: '', page: 0, sel: {}, waiting: null };
var HL_PAGE = 30;
function catHoldOpen() {
  if (typeof document === 'undefined') return;
  var mb = document.getElementById('modal-bg'); if (mb && mb.classList.contains('open') && root.closeModal) root.closeModal();
  catHoldClose(); _hl.page = 0; _hl.sel = {};
  document.body.appendChild(overlay('hold-ov', 905)); hlPaint();
  if (apToken()) {
    apReadOverrides().then(hlPaint, function () {});
    apReadStaged().then(function (st) { var w = {}; (st || []).forEach(function (r) { if (r.decision === 'pending') { if (r.catalogId) w[r.catalogId] = 1; (r.candidates || []).forEach(function (id) { w[id] = 1; }); } }); _hl.waiting = w; hlPaint(); }, function () {});
    if (Object.keys(rlLocal().pending).length) rlSync().then(hlPaint, hlPaint);
  }
}
function catHoldClose() { var el = document.getElementById('hold-ov'); if (el) el.parentNode.removeChild(el); }
function hlList(rows) {
  var all = hlRows(rows, { released: rlLocal().all, rejected: catIsRejected, ovr: overrideFor, waiting: _hl.waiting });
  var q = norm(_hl.q || ''), list = all.filter(function (r) {
    if (_hl.show === 'ready' && !r.ready) return false;
    if (_hl.show === 'none' && r.ready) return false;
    if (_hl.show === 'new' && r.why !== 'new') return false;
    return !q || norm(r.e.m + ' ' + r.e.n).indexOf(q) >= 0;
  });
  return { all: all, list: list };
}
function hlPaint() {
  var ov = typeof document !== 'undefined' && document.getElementById('hold-ov'); if (!ov) return;
  catLoad().then(function (rows) {
    var L = hlList(rows), list = L.list, pages = Math.max(1, Math.ceil(list.length / HL_PAGE));
    if (_hl.page >= pages) _hl.page = pages - 1;
    var shown = list.slice(_hl.page * HL_PAGE, (_hl.page + 1) * HL_PAGE), nSel = Object.keys(_hl.sel).length;
    var cnt = function (f) { return L.all.filter(f).length; };
    var chip = function (k, t, n) { return '<button onclick="catHoldShow(\'' + k + '\')" style="' + (_hl.show === k ? BTN_P : BTN_G) + 'padding:6px 10px;font-size:12px;white-space:nowrap">' + t + ' ' + n + '</button>'; };
    var specTxt = { published: 'specs published', corrected: 'your correction', waiting: 'read, waiting in Spec approvals', none: 'no specs yet' };
    var row = function (r) {
      var e = r.e, pic = !!catImageFor(e.i), on = !!_hl.sel[e.i];
      return '<div style="display:flex;gap:10px;align-items:center;padding:9px 2px;border-bottom:1px solid var(--border1)">' +
        '<input type="checkbox" ' + (on ? 'checked ' : '') + (r.ready ? '' : 'disabled ') + 'onchange="catHoldSel(\'' + jsq(e.i) + '\',this.checked)" style="width:20px;height:20px;flex-shrink:0">' +
        '<div onclick="' + (r.ready ? 'catAddDetail' : 'catHoldCorrect') + '(\'' + jsq(e.i) + '\')" style="display:flex;gap:10px;align-items:center;flex:1;min-width:0;cursor:pointer">' + thumbHTML(e, 40) +
        '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;color:var(--t1)">' + esc(cleanName(e.n)) + (r.why === 'new' ? '<span style="' + CHIP_T + '">NEW</span>' : '') + '</div>' +
        '<div style="font-size:12px;color:' + (r.ready ? 'var(--t2)' : 'var(--gold)') + '">' + esc(e.m) + (e.y ? ' \u00b7 ' + esc(e.y) : '') + ' \u00b7 ' + specTxt[r.specs] + (pic ? '' : ' \u00b7 no picture') + '</div></div></div>' +
        '<button onclick="catHoldApprove([\'' + jsq(e.i) + '\'])" ' + (r.ready ? '' : 'disabled ') + 'style="' + (r.ready ? BTN_P : BTN_G) + 'padding:7px 10px;font-size:12px;' + (r.ready ? '' : 'opacity:.45;') + '">Approve</button></div>';
    };
    var sync = Object.keys(rlLocal().pending).length;
    ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catHoldClose()">\u2039</button>' +
      '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Review new balls</div>' +
      '<div style="font-size:11px;color:var(--t3)">' + L.all.length + ' held \u00b7 not in Add a Ball until you approve them</div></div></div>' +
      '<div style="display:flex;gap:6px;overflow-x:auto;padding:0 16px 8px">' + chip('all', 'All', L.all.length) + chip('ready', 'Ready', cnt(function (r) { return r.ready; })) +
        chip('none', 'Needs specs', cnt(function (r) { return !r.ready; })) + chip('new', 'New', cnt(function (r) { return r.why === 'new'; })) + '</div>' +
      '<div style="padding:0 16px 6px"><input class="bdet-field-input" type="search" placeholder="Filter by brand or name" value="' + esc(_hl.q) + '" oninput="catHoldFilter(this.value)" style="width:100%;box-sizing:border-box;font-size:15px"></div>' +
      '<div style="flex:1;overflow-y:auto;padding:0 16px 10px">' + (shown.length ? shown.map(row).join('') : '<div style="padding:30px 0;text-align:center;color:var(--t2);font-size:13px">' + (L.all.length ? 'No match.' : 'Nothing held. New balls appear here after the weekly refresh.') + '</div>') +
      (pages > 1 ? '<div style="display:flex;gap:8px;align-items:center;justify-content:center;margin-top:10px"><button ' + (_hl.page ? '' : 'disabled ') + 'onclick="catHoldPage(-1)" style="' + BTN_G + 'padding:7px 12px">\u2039</button><span style="font-size:12px;color:var(--t2)">' + (_hl.page + 1) + ' of ' + pages + '</span><button ' + (_hl.page < pages - 1 ? '' : 'disabled ') + 'onclick="catHoldPage(1)" style="' + BTN_G + 'padding:7px 12px">\u203a</button></div>' : '') +
      '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:10px">Tap a ball with no specs to fill them in (Paste page, or Read a saved page (PDF) from bowwwl or the maker\u2019s site). Tap any other ball for its card: pictures, Verify now, Reject. <b>Approve</b> needs specs: published, or your correction with RG and Diff. Approved balls show in Add a Ball here at once, and for everyone after the next catalog refresh. Specs that are read but waiting go through Spec approvals first.</div></div>' +
      '<div style="padding:10px 16px;border-top:1px solid var(--border1);display:flex;gap:8px;align-items:center">' +
        '<div style="flex:1;font-size:11px;color:' + (_rlErr ? 'var(--gold)' : 'var(--t3)') + '">' + (sync ? sync + ' approval' + (sync === 1 ? '' : 's') + ' to send' + (_rlErr ? ': ' + esc(_rlErr) : apToken() ? '' : ' (add the token in Spec approvals)') : 'All approvals sent') + '</div>' +
        (sync && apToken() ? '<button onclick="catHoldSend()" style="' + BTN_G + 'padding:9px 12px;font-size:12px">Send now</button>' : '') +
        '<button id="hold-go" onclick="catHoldApprove()" ' + (nSel ? '' : 'disabled ') + 'style="' + BTN_P + 'padding:9px 14px;font-size:13px;' + (nSel ? '' : 'opacity:.45;') + '">Approve ' + nSel + '</button></div>';
  });
}
/* v30.201: a ball with no specs opens straight into Correct specs (Paste page, Read a saved page (PDF)) */
function catHoldCorrect(id) { return catCorrectFor(id, hlPaint); }
function catHoldShow(k) { _hl.show = k; _hl.page = 0; hlPaint(); }
function catHoldFilter(v) { _hl.q = v; _hl.page = 0; clearTimeout(_hl.t); _hl.t = setTimeout(function () { hlPaint(); setTimeout(function () { var i = document.querySelector('#hold-ov input[type=search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }, 250); }
function catHoldPage(d) { _hl.page += d; hlPaint(); var sc = document.querySelector('#hold-ov > div:nth-child(4)'); if (sc) sc.scrollTop = 0; }
function catHoldSel(id, on) { if (on) _hl.sel[id] = 1; else delete _hl.sel[id]; var n = Object.keys(_hl.sel).length, b = document.getElementById('hold-go'); if (b) { b.textContent = 'Approve ' + n; b.disabled = !n; b.style.opacity = n ? '' : '.45'; } }
function catHoldApprove(ids) {
  ids = ids || Object.keys(_hl.sel); if (!ids.length) return Promise.resolve(0);
  return catLoad().then(function (rows) {
    var o = rlLocal(), n = 0, today = stToday();
    ids.forEach(function (id) { var e = byIdIn(rows, id); if (!e || !hlHasSpecs(e, overrideFor(id)) || o.all[id]) return; o.all[id] = { at: today, n: cleanName(e.n), m: e.m }; o.pending[id] = env.now() + Math.random(); delete _hl.sel[id]; n++; });
    rlSaveLocal(o); if (n) rlQueueSync(); hlPaint();
    if (root.toast) root.toast(n ? 'Approved ' + n + ' ball' + (n === 1 ? '' : 's') + ': now in Add a Ball' : 'Nothing to approve (needs specs)');
    return n;
  });
}
function catHoldSend() { rlSync().then(hlPaint, hlPaint); }

/* ---------- v30.189 COV-1: Coverage (Settings > Balls & catalog) ----------
   From the catalog on this phone: per maker, USBC balls, balls with published specs, and the gaps
   that matter (approved since the chosen year, not discontinued or rejected, no specs). With the
   GitHub token, "waiting" counts gaps the bridge has read but you haven't approved. Tap a gap to
   open its card (Fix in dev mode). Bridge makers first, then everything else as "Other makers". */
var COV_BRANDS = ['Storm', 'Roto Grip', '900 Global', 'Brunswick', 'Hammer', 'DV8', 'Radical', 'Track', 'Ebonite', 'Columbia 300', 'Motiv'];
var _cov = { since: null, open: {}, waiting: null };
function covBrandOf(m) { var n = norm(canonicalMfg(m)); for (var i = 0; i < COV_BRANDS.length; i++) if (norm(COV_BRANDS[i]) === n || n.indexOf(norm(COV_BRANDS[i])) === 0) return COV_BRANDS[i]; return 'Other makers'; }
/* Pure: rows -> [{brand, all, specs, recent, recentSpecs, gaps:[row]}]; skip(e) leaves a row out (rejected),
   gone(e) marks it discontinued (not a gap); waiting = {catalogId: 1} read by the bridge, not approved. */
function covRows(rows, since, skip, gone, waiting) {
  var by = {};
  (rows || []).forEach(function (e) {
    if (skip && skip(e)) return;
    var b = covBrandOf(e.m), o = by[b] = by[b] || { brand: b, all: 0, specs: 0, recent: 0, recentSpecs: 0, gaps: [], waiting: 0 };
    o.all++; if (e.s) o.specs++;
    if (+(e.y || 0) >= since) {
      o.recent++; if (e.s) o.recentSpecs++;
      else if (!(gone && gone(e))) { o.gaps.push(e); if (waiting && waiting[e.i]) o.waiting++; }
    }
  });
  var order = COV_BRANDS.concat(['Other makers']);
  return order.filter(function (b) { return by[b]; }).map(function (b) {
    by[b].gaps.sort(function (x, y) { return String(y.y || '').localeCompare(String(x.y || '')) || cleanName(x.n).localeCompare(cleanName(y.n)); });
    return by[b];
  });
}
function catCovOpen() {
  if (typeof document === 'undefined') return;
  var mb = document.getElementById('modal-bg');
  if (mb && mb.classList.contains('open') && typeof root.closeModal === 'function') root.closeModal();
  catCovClose();
  if (_cov.since == null) _cov.since = new Date(env.now()).getFullYear() - 3;
  _cov.open = {};
  document.body.appendChild(overlay('cov-ov', 905));
  covRender();
  if (apToken()) apReadStaged().then(function (st) {
    var w = {}; (st || []).forEach(function (r) { if (r.decision === 'pending') { if (r.catalogId) w[r.catalogId] = 1; (r.candidates || []).forEach(function (id) { w[id] = 1; }); } });
    _cov.waiting = w; covRender();
  }, function () {});
}
function catCovClose() { var el = document.getElementById('cov-ov'); if (el) el.parentNode.removeChild(el); }
function covRender() {
  var ov = document.getElementById('cov-ov'); if (!ov) return;
  catLoad().then(function (rows) {
    var list = covRows(rows, _cov.since, catIsRejected, function (e) { return !!discontinuedOf(e); }, _cov.waiting);
    var tot = list.reduce(function (a, o) { a.all += o.all; a.specs += o.specs; a.gaps += o.gaps.length; return a; }, { all: 0, specs: 0, gaps: 0 });
    var pct = function (a, b) { return b ? Math.floor(a * 100 / b) + '%' : '\u2014'; };
    var yr = new Date(env.now()).getFullYear(), years = [yr - 1, yr - 2, yr - 3, yr - 5];
    var chip = function (y) { var on = _cov.since === y; return '<button onclick="catCovSince(' + y + ')" style="' + (on ? BTN_P : BTN_G) + 'padding:6px 10px;font-size:12px">' + y + '+</button>'; };
    var body = list.map(function (o, i) {
      var open = !!_cov.open[o.brand];
      var head = '<div onclick="catCovToggle(\'' + jsq(o.brand) + '\')" style="display:flex;align-items:center;gap:8px;padding:11px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' +
        '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:700;color:var(--t1)">' + esc(o.brand) + '</div>' +
        '<div style="font-size:12px;color:var(--t2)">' + o.specs + ' of ' + o.all + ' with specs (' + pct(o.specs, o.all) + ') \u00b7 ' + _cov.since + '+: ' + o.recentSpecs + ' of ' + o.recent + ' (' + pct(o.recentSpecs, o.recent) + ')</div></div>' +
        '<div style="text-align:right"><div style="font-size:15px;font-weight:800;color:' + (o.gaps.length ? 'var(--gold)' : 'var(--teal)') + '">' + (o.gaps.length || '\u2713') + '</div>' +
        '<div style="font-size:10px;color:var(--t3)">' + (o.gaps.length ? 'gap' + (o.gaps.length === 1 ? '' : 's') + (o.waiting ? ' \u00b7 ' + o.waiting + ' waiting' : '') : 'no gaps') + '</div></div>' +
        (o.gaps.length ? '<span style="color:var(--t3)">' + (open ? '\u25be' : '\u25b8') + '</span>' : '') + '</div>';
      if (!open || !o.gaps.length) return head;
      return head + o.gaps.map(function (e) {
        var w = _cov.waiting && _cov.waiting[e.i];
        return '<div onclick="catAddDetail(\'' + esc(e.i) + '\')" style="display:flex;gap:10px;align-items:center;padding:9px 2px 9px 12px;border-bottom:1px solid var(--border1);cursor:pointer">' +
          '<div style="flex:1;min-width:0;font-size:14px;color:var(--t1)">' + esc(cleanName(e.n)) + (o.brand === 'Other makers' ? '<span style="font-size:12px;color:var(--t3)"> \u00b7 ' + esc(e.m) + '</span>' : '') + '</div>' +
          '<span style="font-size:12px;color:var(--t3)">' + esc(e.y || '') + '</span>' + (w ? '<span style="' + CHIP_G + '">WAITING</span>' : '') + '</div>';
      }).join('');
    }).join('');
    ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catCovClose()">\u2039</button>' +
      '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Coverage</div>' +
      '<div style="font-size:11px;color:var(--t3)">' + tot.specs + ' of ' + tot.all + ' balls have specs (' + pct(tot.specs, tot.all) + ') \u00b7 ' + tot.gaps + ' gap' + (tot.gaps === 1 ? '' : 's') + ' since ' + _cov.since + '</div></div></div>' +
      '<div style="display:flex;gap:6px;align-items:center;padding:0 16px 8px"><span style="font-size:12px;color:var(--t2);margin-right:4px">Gaps approved</span>' + years.map(chip).join('') + '</div>' +
      '<div style="flex:1;overflow-y:auto;padding:0 16px 12px">' + body +
      '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:10px">A gap is a ball approved since the year chosen, not discontinued or rejected, with no published specs. ' +
      (_cov.waiting ? '\u201cWaiting\u201d: the bridge read it; approve it in Spec approvals.' : 'Add the GitHub token to see which gaps are waiting for your approval.') + ' Tap a gap to open its card.</div></div>';
  });
}
function catCovSince(y) { _cov.since = y; covRender(); }
function catCovToggle(b) { _cov.open[b] = !_cov.open[b]; covRender(); }

/* bowwwl.com page for a ball (personal-use lookup only; never fetched by the app). */
function bowwwlSlug(t) { return String(t || '').toLowerCase().replace(/\+/g, ' plus').replace(/\binc\b\.?/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function bowwwlLinks(brand, name) {
  var q = encodeURIComponent('site:bowwwl.com ' + brand + ' ' + name);
  /* v30.204: the search link goes to the maker's own site (as Ball images' "maker" link), else the web */
  var site = MAKER_SITE[brandSlug(brand)];
  return { page: 'https://www.bowwwl.com/bowling-ball-database/' + bowwwlSlug(brand) + '/' + bowwwlSlug(name), search: 'https://www.google.com/search?q=' + q,
    maker: 'https://www.google.com/search?q=' + encodeURIComponent(site ? 'site:' + site + ' ' + name : brand + ' ' + name + ' bowling ball specs'), makerSite: site || null };
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
var VOCAB_FIELDS = { 'ape-core': 'core', 'ape-coverName': 'coverName', 'ape-coverType': 'coverType', 'ape-finish': 'finish',
  'lk-CoreShort': 'core', 'lk-CoverName': 'coverName', 'lk-Coverstock': 'coverType', 'lk-BoxFinish': 'finish' };
var _vocab = null, _vocabP = null;
function vocabKey(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
/* Pure: merge lists of {v, n, b[]} by folded value; extra = [{field, v, brand}]. */
function vocabMerge(dist, extra) {
  var out = {};
  ['core', 'coverName', 'coverType', 'finish'].forEach(function (k) {
    var m = {}, order = [];
    var add = function (v, n, brands) {
      var key = vocabKey(v); if (!key || !plausibleText(k === 'core' ? 'core' : k, v)) return;   // v30.174: no page prose in lists
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
  _vp = { field: fieldId, brand: /^lk-/.test(fieldId) ? _lk.brand : (e ? e.m : null) };
  var ov = overlay('vp-ov', 950);
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
/* ---------- Look up (Ball Detail) ----------
   v30.175's in-app split view (frame + draggable divider) was retired in v30.176
   (sites refuse to be framed) and its code removed in v30.185. lkTabs still gives
   the maker page for the Look up buttons; lkPasteValue stays for its tests. */
var _lk = { tabs: [], active: 0, mode: null, ballId: null, brand: null, timer: null };
/* Pure: tab list for a ball (bowwwl page, maker page when known). */
function lkTabs(brand, name, makerUrl) {
  var bw = bowwwlLinks(brand || '', name || ''), out = [{ k: 'bowwwl', label: 'bowwwl', url: bw.page }];
  if (makerUrl && /^https:\/\//.test(makerUrl)) out.push({ k: 'maker', label: 'Maker page', url: makerUrl });
  out.push({ k: 'search', label: 'Search', url: bw.search, safariOnly: true });
  return out;
}
/* Pure: tidy a pasted value for a field kind. */
function lkPasteValue(kind, t) {
  var s = String(t || '').replace(/\s+/g, ' ').trim();
  if (kind === 'num') { var m = /(?:^|[^\d.])((?:[0-2])?\.\d{2,3})(?!\d)/.exec(' ' + s); return m ? (m[1].charAt(0) === '.' ? '0' + m[1] : m[1]) : null; }
  if (kind === 'date') { var r = tagValueFor('ape-released', s); return r.v || null; }
  return pgvClean(s) || null;
}
/* --- Ball Detail: Look up over your ball's spec fields --- */
var LK_FIELDS = [['CoverName', 'Coverstock', 'text', 'coverName'], ['Coverstock', 'Cover type', 'text', 'coverType'], ['BoxFinish', 'Factory finish', 'text', 'finish'],
  ['CoreShort', 'Core', 'text', 'core'], ['CoreType', 'Core type', 'core', null], ['RG', 'RG', 'num', null], ['Differential', 'Diff', 'num', null], ['IntDiff', 'Int Diff', 'num', null],
  ['DateReleased', 'Release date', 'date', null]];
var LK_RANGE = { RG: [2.30, 2.90], Differential: [0, 0.060], IntDiff: [0, 0.040] };
function catLookBall(ballId) {
  var b = appBalls().filter(function (x) { return x.BallID == ballId; })[0]; if (!b) return;
  var name = b.BallName, brand = b.MFG;
  catLoad().then(function (rows) { var e = b.CatalogID ? byIdIn(rows, b.CatalogID) : null; if (e) { name = cleanName(e.n); brand = e.m; } return e ? catDetailRaw(e) : null; }, function () { return null; })
  .then(function (d) {
    _lk = { tabs: lkTabs(brand, name, d && /^https:/.test(d.Source || '') ? d.Source : null), active: 0, mode: 'ball', ballId: b.BallID, brand: brand, name: name, ok: {} };
    var ov = overlay('lk-ov', 940);
    var row = function (f) {
      var id = 'lk-' + f[0], v = b[f[0]], ver = (v == null || v === '' || catSpecUnverified(b, f[0])) ? '' : '<span style="font-size:10px;color:var(--teal);margin-left:6px">\u2713 verified</span>';
      var input = f[2] === 'core' ? '<select id="' + id + '" class="bdet-field-input" style="flex:1;font-size:15px"><option value=""' + (!v ? ' selected' : '') + '>\u2014</option><option' + (/^sym/i.test(v || '') ? ' selected' : '') + '>Symmetrical</option><option' + (/asym/i.test(v || '') ? ' selected' : '') + '>Asymmetrical</option></select>' :
        '<input id="' + id + '" class="bdet-field-input" value="' + esc(v == null ? '' : (f[2] === 'num' && isFinite(parseFloat(v)) ? parseFloat(v).toFixed(3).replace(/0$/, '') : v)) + '"' + (f[2] === 'num' ? ' inputmode="decimal"' : '') + (f[2] === 'date' ? ' placeholder="YYYY-MM-DD"' : '') + ' style="flex:1;min-width:0;box-sizing:border-box;font-size:15px">';
      return '<div style="padding:6px 0"><div style="font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">' + f[1] + ver + '</div>' +
        '<div style="display:flex;gap:6px;align-items:stretch">' + input +
        (f[3] ? '<button style="' + BTN_G + 'padding:0 10px;font-size:13px" onclick="catPickOpen(\'' + id + '\')" aria-label="Pick">\u25be</button>' : '') +
        '<button id="lk-ok-' + f[0] + '" style="' + BTN_G + 'padding:0 10px;font-size:13px" onclick="catLookOk(\'' + f[0] + '\')" aria-label="Correct as is">\u2713</button></div></div>';
    };
    ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 6px"><button style="' + BACK + '" onclick="catLookClose()">\u2039</button>' +
      '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Look up</div><div style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(b.BallName) + ' \u00b7 ' + esc(brand || '') + ' \u00b7 your ' + esc(b.Weight || 15) + ' lb</div></div></div>' +
      '<div data-lk-body style="flex:1;overflow-y:auto;padding:4px 16px 12px;min-height:0">' +
        spButtonsHTML(bowwwlLinks(brand || '', name), 'catSpBall()', _lk.tabs[1] && _lk.tabs[1].k === 'maker' ? _lk.tabs[1].url : null) +
        '<div style="font-size:11px;color:var(--t3);line-height:1.45;margin:8px 0 4px">\u2713 marks a value correct as it is. Saved values count as verified by you.</div>' +
        LK_FIELDS.map(row).join('') + '<div id="lk-err" style="font-size:12px;color:var(--red);min-height:16px;margin-top:6px"></div></div>' +
      '<div style="padding:10px 16px;border-top:1px solid var(--border1);display:flex;gap:8px"><button style="' + BTN_G + 'padding:11px" onclick="catLookClose()">Cancel</button>' +
      '<button style="' + BTN_P + 'flex:1;padding:11px" onclick="catLookSave()">Save to ball</button></div>';
    document.body.appendChild(ov);
  });
}
function catLookOk(f) {
  _lk.ok[f] = !_lk.ok[f];
  var bt = document.getElementById('lk-ok-' + f);
  if (bt) { bt.style.background = _lk.ok[f] ? 'rgba(0,217,217,0.18)' : ''; bt.style.color = _lk.ok[f] ? 'var(--teal)' : ''; bt.style.borderColor = _lk.ok[f] ? 'var(--teal)' : ''; }
}
/* Pure: form values -> {changes:{field:value}, err} against the ball, range-checked. */
function lkBallChanges(b, form, ok) {
  var ch = {}, err = null;
  LK_FIELDS.forEach(function (f) {
    var k = f[0], raw = String(form[k] == null ? '' : form[k]).trim(), cur = b[k];
    if (f[2] === 'num') {
      if (raw === '') { if (cur != null && cur !== '') ch[k] = null; return; }
      var n = Number(raw), lim = LK_RANGE[k];
      if (!isFinite(n)) { err = err || (f[1] + ' must be a number'); return; }
      if (n < lim[0] || n > lim[1]) { err = err || (f[1] + ' must be ' + lim[0] + '\u2013' + lim[1]); return; }
      if (cur == null || cur === '' || Math.abs(Number(cur) - n) > 1e-9) ch[k] = n;
    } else if (raw !== String(cur == null ? '' : cur)) ch[k] = raw || null;
  });
  var verify = Object.keys(ok || {}).filter(function (k) { return ok[k] && !(k in ch) && b[k] != null && b[k] !== ''; });
  return { changes: ch, verify: verify, err: err };
}
function catLookSave() {
  var b = appBalls().filter(function (x) { return x.BallID == _lk.ballId; })[0]; if (!b) return;
  var form = {}; LK_FIELDS.forEach(function (f) { var el = document.getElementById('lk-' + f[0]); form[f[0]] = el ? el.value : b[f[0]]; });
  var r = lkBallChanges(b, form, _lk.ok), errEl = document.getElementById('lk-err');
  if (r.err) { if (errEl) errEl.textContent = r.err; return; }
  b.SpecSource = b.SpecSource || {};
  Object.keys(r.changes).forEach(function (k) { b[k] = r.changes[k]; if (r.changes[k] == null) delete b.SpecSource[k]; else b.SpecSource[k] = 'user'; });
  r.verify.forEach(function (k) { b.SpecSource[k] = 'user'; });
  var n = Object.keys(r.changes).length + r.verify.length;
  if (root.saveDB) root.saveDB();
  catLookClose();
  if (root.toast) root.toast(n ? n + ' field' + (n === 1 ? '' : 's') + ' saved as verified by you' : 'Nothing changed');
  if (typeof root._bdetRenderSpecs === 'function') try { root._bdetRenderSpecs(); } catch (x) {}
}
/* Open-page + paste buttons, shared by Correct specs and Look up. */
function spButtonsHTML(bw, pasteCall, makerUrl) {
  var pdfCall = pasteCall === 'catSpAp()' ? 'catSpApPdf()' : 'catSpBallPdf()';
  return '<div style="display:flex;gap:6px"><a href="' + esc(bw.page) + '" target="_blank" rel="noopener noreferrer" style="' + BTN_G + 'flex:1;padding:10px;text-align:center;text-decoration:none;font-size:13px">1. Open bowwwl \u2197</a>' +
    '<button style="' + BTN_P + 'flex:1;padding:10px;font-size:13px" onclick="' + pasteCall + '">2. Paste page &amp; fill</button></div>' +
    '<div style="font-size:11px;color:var(--t3);margin-top:4px;line-height:1.45">In Safari: long-press the page text, <b>Select All</b>, <b>Copy</b>, come back and tap 2. ' +
    (makerUrl ? '<a href="' + esc(makerUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal)">Maker page \u2197</a> \u00b7 ' : '') +
    '<a href="' + esc(bw.maker || bw.search) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal)">' + (bw.makerSite ? 'Maker site' : 'Search the web') + ' \u2197</a> \u00b7 ' +
    '<span onclick="catShortcutHelp()" style="color:var(--teal);cursor:pointer">Faster: the Shortcut</span></div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-top:6px"><button style="' + BTN_G + 'flex:1;padding:9px;font-size:12px" onclick="' + pdfCall + '">Read a saved page (PDF)</button>' +
    '<span onclick="catPdfHelp()" style="font-size:12px;color:var(--teal);cursor:pointer;white-space:nowrap">How?</span></div>';
}
/* v30.177: "Copy page text" Shortcut. Run from Safari's Share sheet, it reads the
   whole page (including collapsed tabs and accordions that Select All misses),
   marks the title, adds the page's structured data and image, and copies it all.
   The app shows the steps and copies this script for pasting into the Shortcut. */
var SHORTCUT_JS = "var c=document.body.cloneNode(true);\nc.querySelectorAll('script,style,noscript,svg,iframe,nav,header,footer').forEach(function(e){e.remove()});\nc.querySelectorAll('br').forEach(function(e){e.replaceWith('\\n')});\nc.querySelectorAll('td,th').forEach(function(e){e.prepend('\\t')});\nc.querySelectorAll('h1').forEach(function(e){e.prepend('\\n#H1 ')});\nc.querySelectorAll('p,div,li,tr,dt,dd,h1,h2,h3,h4,h5,h6,section,article').forEach(function(e){e.append('\\n')});\nvar ld=[];document.querySelectorAll('script[type=\"application/ld+json\"]').forEach(function(s){ld.push(s.textContent.replace(/\\s+/g,' '))});\nvar m=document.querySelector('meta[property=\"og:image\"]');\ncompletion('BDB-PAGE '+location.href+'\\n'+c.textContent.replace(/[ \\u00a0]*\\n\\s*/g,'\\n')+'\\n#LD '+ld.join('\\n#LD ')+(m?'\\n#IMG '+m.content:''));";
function catShortcutHelp() {
  var ov = overlay('sch-ov', 1050);   // above Settings (modal 1010)
  var step = function (n, t) { return '<div style="display:flex;gap:10px;padding:7px 0"><div style="flex:0 0 22px;height:22px;border-radius:11px;background:var(--teal);color:#000;font-weight:800;font-size:12px;display:flex;align-items:center;justify-content:center">' + n + '</div><div style="flex:1;font-size:13px;color:var(--t1);line-height:1.5">' + t + '</div></div>'; };
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catShortcutClose()">\u2039</button>' +
    '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Copy page text Shortcut</div><div style="font-size:11px;color:var(--t3)">One-time setup, about a minute</div></div></div>' +
    '<div style="flex:1;overflow-y:auto;padding:0 16px 16px">' +
    step(1, 'In the Shortcuts app, open your <b>Copy Page Text</b> shortcut (or make a new one). Delete <b>Get text from Current App</b>: it only reads what is on screen.') +
    step(2, 'Tap <b>\u24d8</b> at the bottom, turn on <b>Show in Share Sheet</b>, and set what it receives to <b>Safari web pages</b> only.') +
    step(3, 'Add the action <b>Run JavaScript on Web Page</b> (input: Shortcut Input). Select all the sample code in it, delete it, and paste the script (button below).') +
    step(4, 'Keep <b>Copy to Clipboard</b> after it, copying the <b>JavaScript Result</b>.') +
    step(5, 'In the Settings app: <b>Apps \u203a Shortcuts \u203a Advanced</b>, turn on <b>Allow Running Scripts</b>.') +
    step(6, 'Use it: on the ball\u2019s page in Safari tap <b>Share \u203a Copy Page Text</b>, come back here, tap <b>Paste page &amp; fill</b>.') +
    '<button style="' + BTN_P + 'width:100%;padding:11px;margin-top:10px" onclick="catShortcutCopy()">Copy the script</button>' +
    '<pre style="margin-top:10px;padding:10px;border-radius:10px;background:var(--bg2);font-size:10px;line-height:1.4;white-space:pre-wrap;word-break:break-all;color:var(--t2);-webkit-user-select:text;user-select:text">' + esc(SHORTCUT_JS) + '</pre></div>';
  document.body.appendChild(ov);
}
function catShortcutCopy() {
  var ok = function () { if (root.toast) root.toast('Script copied. Paste it into Run JavaScript on Web Page.'); };
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(SHORTCUT_JS).then(ok, function () { if (root.toast) root.toast('Long-press the script below and Copy'); });
  else if (root.toast) root.toast('Long-press the script below and Copy');
}
function catShortcutClose() { var el = document.getElementById('sch-ov'); if (el) el.parentNode.removeChild(el); }
function catLookClose() { var el = document.getElementById('lk-ov'); if (el) el.parentNode.removeChild(el); }

/* ---------- v30.176: Paste page & fill ----------
   In-app frames are refused by the spec sites, and picking words one at a
   time on iOS is slow. Instead: open the ball's page in Safari, Select All,
   Copy, come back, tap "Paste page & fill". The app reads the whole copied
   page, finds the spec labels it knows (bowwwl, maker and review-site
   layouts), and shows what it found in a review list: tick, edit, apply.
   The app still never fetches a site itself. */
var SP_LABELS = [
  ['intDiff', /^(?:int(?:ermediate)?\.?\s*diff(?:erential)?\.?|mass\s*bias(?:\s*diff(?:erential)?)?|mb\s*diff\.?|psa)/i],
  ['diff', /^(?:total\s*diff(?:erential)?\.?|max(?:imum)?\s*diff(?:erential)?\.?|differential|diff\.?)/i],   // v30.201: MOTIV "MAX DIFFERENTIAL"
  ['rg', /^(?:rg|radius\s*of\s*gyration)/i],
  ['coverType', /^(?:cover\s*type|coverstock\s*type|cover\s*stock\s*type|type(?=\s*(?:[:|]|$)))/i],   // bowwwl: "Type" under the coverstock
  ['coverName', /^(?:cover\s*name|coverstock(?:\s*name)?|cover\s*stock|cover)/i],
  ['finish', /^(?:box\s*finish|factory\s*finish|out[\s-]*of[\s-]*(?:the[\s-]*)?box\s*finish|finish)/i],
  ['coreType', /^(?:core\s*type|core\s*symmetry|symmetry)/i],
  ['core', /^(?:core\s*name|weight\s*block|core)/i],
  ['released', /^(?:release\s*date|released|launch\s*date)/i]];
var SP_NUM = /(?:^|[^\d.])([0-2]?\.\d{2,3})(?!\d)/;
/* v30.201 maker pages: a label followed by a rating ("CORE (2)", Hammer) or a heading word ("CORE NUMBERS", Radical) is not a value */
var SP_NOT_VALUE = /^(?:\(?\s*\d+(?:\.\d+)?\s*\)?|numbers|specs?|specifications|details|technology|info(?:rmation)?|stock|rating|shape|name|type|bowling ball)$/i;   // v30.204: + BowlersMart's split labels
/* v30.201: a weight-column table ("16 lb 15 lb 14 lb ..." then "RG 2.498 2.488 ...", Radical / Brunswick) */
var SP_WCOL = /\b(1[0-6])\s*(?:#|lbs?\.?|pounds?)(?![a-z])/gi;
/* v30.204 Pure: retailer spec tables whose label cell wraps around its value (BowlersMart):
   "BOWLING BALL / Asymmetrical Core / CORE SHAPE", "RADIUS OF / GYRATION: RG | 2.50 / (15LB)",
   "DIFFERENTIAL: DIFF / .058 / (15LB)", "MASS BIAS / .020 / STRENGTH". Rebuilt as plain "Label | value"
   lines in the parser's own words, put first so they win; anything not a spec label is dropped. */
function spCanon(t) { var L = String(t).toLowerCase(); return /core\s*(?:shape|type|symmetry|name)|weight\s*block|^core$|cover(?:stock)?(?:\s*(?:type|name))?$|mass\s*bias|int(?:ermediate)?\.?\s*diff|radius\s*of\s*gyration|\brg\b|diff|finish|release/.test(L); }
function spWrappedRows(lines) {
  /* only on a page laid out this way: labels split around values leave bare label pieces behind
     ("BOWLING BALL", "RADIUS OF", "(15LB)"); a page with labels above values (Radical) never shows them */
  var sig = lines.filter(function (l) { return /^(?:BOWLING BALL|BALL|RADIUS OF|\((?:1[0-6])\s*LBS?\))$/.test(l); }).length;
  if (sig < 2) return [];
  var caps = function (t) { return /[A-Z]/.test(t) && !/[a-z]/.test(t) && t.length <= 40 && !/^[\d.\s]+$/.test(t); };
  var rows = [], P = [], V = [], emit = function (lab, vals) { rows.push({ lab: lab.join(' ').replace(/\s+/g, ' ').trim(), val: vals.join(' ').trim() }); P = []; V = []; };
  lines.forEach(function (l) {
    l = l.replace(/^BOWLING BALL\s*(?:\|\s*)?/, '').replace(/^BALL$/, '').trim(); if (!l) return;
    var parts = l.split(/\s+\|\s+/), lab = null, val = null;
    if (parts.length > 1 && caps(parts[0])) { lab = parts[0]; val = parts.slice(1).join(' '); }
    else if (caps(l)) lab = l; else val = l;
    if (lab && val != null) { if (P.length) emit(P.concat([lab]), V.concat([val])); else emit([lab], V.concat([val])); return; }
    if (lab) {
      if (/^\(.*\)$/.test(lab) && !P.length && !V.length && rows.length) { rows[rows.length - 1].lab += ' ' + lab; return; }
      /* label above its value (Radical "COVERSTOCK / HK22C ... / COVER TYPE"): the label already reads whole */
      if (P.length && V.length) { if (!/^\(.*\)$/.test(lab) && spCanon(P.join(' '))) { emit(P, V); P = [lab]; return; } emit(P.concat([lab]), V); return; }
      if (!P.length && V.length) { emit([lab], V); return; }
      P.push(lab); return;
    }
    V.push(val); if (V.length > 3) { P = []; V = []; }   // prose, not a table
  });
  var brand = (rows.filter(function (r) { return /^brand$/i.test(r.lab); })[0] || {}).val || '';
  var strip = function (v) { var b = brand ? new RegExp('^' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i') : null; return b ? v.replace(b, '') : v; };
  var out = [];
  rows.forEach(function (r) {
    var L = r.lab.toLowerCase(), v = r.val, w = /\((1[0-6])\s*lbs?\)/i.exec(r.lab), wp = w ? w[1] + ' lb ' : '';
    if (!v) return;
    if (/core\s*(?:shape|type|symmetry)/.test(L)) out.push('Core Type | ' + v);
    else if (/core\s*name|weight\s*block/.test(L)) out.push('Core | ' + strip(v).replace(/\s+core$/i, ''));
    else if (/cover(?:stock)?\s*type/.test(L)) out.push('Cover Type | ' + v);
    else if (/cover(?:stock)?\s*name/.test(L)) out.push('Coverstock | ' + strip(v));
    else if (/mass\s*bias|int(?:ermediate)?\.?\s*diff|psa/.test(L)) out.push(wp + 'Int Diff | ' + v);
    else if (/radius\s*of\s*gyration|\brg\b/.test(L)) out.push(wp + 'RG | ' + v);
    else if (/diff/.test(L)) out.push(wp + 'Diff | ' + v);
    else if (/(?:surface|factory|box)\s*finish/.test(L)) out.push('Finish | ' + v);
    else if (/release/.test(L)) out.push('Release Date | ' + v);
  });
  return out.length >= 3 ? out : [];   // a real spec table, not stray caps
}
function spWeightColumns(lines, out) {
  for (var i = 0; i < lines.length; i++) {
    var hd = lines[i].match(SP_WCOL);
    if (!hd || hd.length < 2 || lines[i].replace(SP_WCOL, '').replace(/[|\s]/g, '') !== '') continue;
    var cols = hd.map(function (x) { return parseInt(x, 10); });
    for (var j = i + 1; j < Math.min(lines.length, i + 7); j++) {
      var m = /^(int(?:ermediate)?\.?\s*diff(?:erential)?|mass\s*bias(?:\s*diff(?:erential)?)?|psa|total\s*diff(?:erential)?|differential|diff|rg|radius\s*of\s*gyration)\.?\s*[:|]?\s*(.*)$/i.exec(lines[j]);
      if (!m) continue;
      var nums = m[2].match(/(?:^|[^\d.])[0-2]?\.\d{2,3}(?!\d)/g); if (!nums || nums.length !== cols.length) continue;
      var key = /^(int|mass|psa)/i.test(m[1]) ? 'IntDiff' : /diff/i.test(m[1]) ? 'Diff' : 'RG', fk = { RG: 'rg', Diff: 'diff', IntDiff: 'intDiff' }[key];
      var lim = { RG: [2.30, 2.90], Diff: [0, 0.080], IntDiff: [0, 0.040] }[key];
      nums.forEach(function (v, ix) {
        var t = v.replace(/^[^\d.]/, ''), n = Number(t.charAt(0) === '.' ? '0' + t : t); if (!(n >= lim[0] && n <= lim[1])) return;
        var slot = out.weights[cols[ix]] = out.weights[cols[ix]] || {}; if (slot[key] == null) slot[key] = n;
        if (out.found.indexOf(fk) < 0) out.found.push(fk);
      });
    }
  }
}
var SP_WT = /\b(1[0-6])\s*(?:#|lbs?\.?|pounds?)(?![a-z])/i;
/* Pure: whole copied page -> {fields, weights, found[], nameSeen}. weight = the ball's weight for unlabelled numbers. */
/* v30.177: the "Copy page text" Shortcut adds a header (BDB-PAGE url), marks the
   page title (#H1), and appends the page's structured data (#LD json) and image
   (#IMG url). Structured data name/value pairs become "name: value" lines. */
function spLdLines(json) {
  var out = [];
  var walk = function (o, d) {
    if (!o || typeof o !== 'object' || d > 8) return;
    if (Array.isArray(o)) { o.forEach(function (x) { walk(x, d + 1); }); return; }
    if (typeof o.name === 'string' && (typeof o.value === 'string' || typeof o.value === 'number')) out.push(o.name + ': ' + o.value);
    Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === 'object') walk(o[k], d + 1); });
  };
  try { walk(JSON.parse(json), 0); } catch (e) {}
  return out;
}
/* v30.201 Pure: a maker's own page, from its copyright footer or brand mark (never when the text is a bowwwl page) */
var SP_MAKERS = [[/\bhammer\s*bowling\b/i, 'hammerbowling.com'], [/\bradical\s*bowling\b/i, 'radicalbowling.com'], [/\bmotiv\s*bowling\b/i, 'motivbowling.com'],
  [/\bstorm\s*(?:bowling|products)\b/i, 'stormbowling.com'], [/\broto\s*grip\b.*\u00a9|\u00a9.*\broto\s*grip\b/i, 'rotogrip.com'], [/\bbrunswick\s*bowling\b/i, 'brunswickbowling.com'],
  [/\bdv8\s*bowling\b/i, 'dv8bowling.com'], [/\bebonite\b.*\u00a9|\u00a9.*\bebonite\b/i, 'ebonite.com'], [/\b900\s*global\b.*\u00a9|\u00a9.*\b900\s*global\b/i, '900global.com'], [/\bcolumbia\s*300\b.*\u00a9|\u00a9.*\bcolumbia\s*300\b/i, 'columbia300.com'], [/\btrack\s*(?:inc|bowling)\b/i, 'trackbowling.com']];
function spMakerOf(text) {
  var t = String(text || ''); if (/bowwwl/i.test(t)) return null;
  var foot = t.split('\n').filter(function (l) { return /\u00a9|copyright|all rights reserved/i.test(l); }).join('\n');
  for (var i = 0; i < SP_MAKERS.length; i++) if (SP_MAKERS[i][0].test(foot)) return SP_MAKERS[i][1];
  for (var j = 0; j < 3; j++) if (SP_MAKERS[j][0].test(t)) return SP_MAKERS[j][1];
  return null;
}
function parseSpecText(text, weight, name) {
  var out = { fields: {}, weights: {}, found: [], nameSeen: null, url: null, image: null };
  var raw = String(text || '').replace(/\r/g, '').replace(/\u00a0/g, ' ');
  var hm = /^BDB-PAGE (\S+)/.exec(raw); if (hm) { out.url = hm[1]; raw = raw.slice(hm[0].length); }
  if (/^BDB-PDF\n/.test(raw)) { out.pdf = true; raw = raw.slice(8); }   // v30.201: text read from a saved page PDF
  var extra = [];
  raw = raw.replace(/^#LD (.*)$/gm, function (m, j) { extra = extra.concat(spLdLines(j)); return ''; })
           .replace(/^#IMG (\S+).*$/gm, function (m, u) { if (/^https:\/\//.test(u)) out.image = u; return ''; });
  /* start at the page title: menus and "related balls" before it are not this ball */
  var h1 = raw.search(/^#H1 /m);
  if (h1 >= 0) raw = raw.slice(h1).replace(/^#H1 /m, '');
  else if (name) {
    var fl = foldName(name), ls = raw.split('\n'), at = 0;
    for (var q = 0; q < ls.length; q++) { var t = ls[q].trim(); if (t.length < 90 && fl && foldName(t).indexOf(fl) >= 0) { at = q; break; } }
    raw = ls.slice(at).join('\n');
  }
  raw = raw + '\n' + extra.join('\n');
  var lines = raw.split('\n')
    .map(function (l) { return l.replace(/\t+/g, ' | ').replace(/^[\s\u2022\u00b7*\-\u2013|]+/, '').replace(/\s+/g, ' ').trim(); })
    .filter(Boolean);
  var w0 = parseInt(weight, 10) || 15;
  var setF = function (k, v) {
    if (k in out.fields || v == null) return;
    v = String(v).replace(/[\u2122\u00ae]/g, '').replace(/^[:|#\-\s]+/, '').replace(/\s*\|\s*$/, '').trim();
    if (k === 'released') { var r = tagValueFor('ape-released', v.split(/\s+\|\s+|\s{2,}/)[0]); if (!r.v) return; v = r.v; }
    else if (k === 'coreType') { if (/asym/i.test(v)) v = 'Asymmetrical'; else if (/sym/i.test(v)) v = 'Symmetrical'; else return; }
    else { v = v.split(/\s+\|\s+/)[0]; if (SP_NOT_VALUE.test(v) || !plausibleText(k === 'core' ? 'core' : k, v)) return; }
    out.fields[k] = v; out.found.push(k);
  };
  var setN = function (k, raw, line) {
    var m = SP_NUM.exec(' ' + raw); if (!m) return;
    var n = Number(m[1].charAt(0) === '.' ? '0' + m[1] : m[1]);
    var lim = { rg: [2.30, 2.90], diff: [0, 0.080], intDiff: [0, 0.040] }[k];
    if (!(n >= lim[0] && n <= lim[1])) return;
    var wm = SP_WT.exec(line), w = wm ? +wm[1] : (curW || w0);
    var slot = out.weights[w] = out.weights[w] || {};
    var key = { rg: 'RG', diff: 'Diff', intDiff: 'IntDiff' }[k];
    if (slot[key] == null) { slot[key] = n; if (out.found.indexOf(k) < 0) out.found.push(k); }
  };
  spWeightColumns(lines, out);
  lines = spWrappedRows(lines).concat(lines);   // v30.204
  var curW = null;   // v30.178: a "16 pounds" heading applies to the numbers under it (bowwwl)
  lines.forEach(function (l, i) {
    var wh = /^(1[0-6])\s*(?:#|lbs?\.?|pounds?)\s*(?:ball)?$/i.exec(l); if (wh) { curW = +wh[1]; return; }
    var lab = l.replace(/^(1[0-6])\s*(?:#|lbs?\.?|pounds?)\s*[|:\-\u2013]?\s*(?=[a-z])/i, '');   // v30.201: "16 lb - RG (2.610)" (Hammer)   // "16 lbs RG 2.48 ...": the label follows the weight
    var matched = false;
    for (var j = 0; j < SP_LABELS.length; j++) {
      var m = SP_LABELS[j][1].exec(lab); if (!m) continue;
      if (/[a-z]/.test(lab.charAt(m[0].length))) continue;            // "Coreless", "Finished": not a label (a capital may follow: "Cover NameR2S")
      var k = SP_LABELS[j][0], rest = lab.slice(m[0].length).replace(/^\s*[:|#\-\u2013]?\s*/, '');
      if (!rest && lines[i + 1] && !SP_LABELS.some(function (x) { return x[1].test(lines[i + 1]); })) rest = lines[i + 1];   // value on the next line
      if (k === 'rg' || k === 'diff' || k === 'intDiff') {
        /* "16 lb RG 2.48 Diff 0.051 Int 0.012" on one line: read each label's own number */
        setN(k, rest, l);
        var dm = /\b(?:total\s*)?diff(?:erential)?\.?\s*[:|]?\s*\(?\s*([0-2]?\.\d{2,3})/i.exec(rest); if (k === 'rg' && dm) setN('diff', dm[1], l);
        var im = /\b(?:int(?:ermediate)?\.?\s*diff\.?|psa|mass\s*bias|mb)\s*[:|]?\s*\(?\s*([0-2]?\.\d{2,3})/i.exec(rest); if (k !== 'intDiff' && im) setN('intDiff', im[1], l);
      } else setF(k, rest);
      matched = true; break;
    }
    /* v30.178 bowwwl headings: "HK22C2 - Alpha Premier Solid Coverstock", "Rampart Core" */
    if (!matched && /^(?:a)?symmetric(?:al)?$/i.test(l)) { setF('coreType', l); matched = true; }   // v30.201: MOTIV "HALOGEN / SYMMETRICAL"
    if (!matched && !/^[a-z]/.test(l)) {   // v30.201: a heading starts with a capital ("both coverstock and core" is prose)
      var ch = /^(.{2,60}?)\s+cover\s*stock$/i.exec(l);
      if (ch) setF('coverName', ch[1].replace(/\s+[-\u2013\u2014]\s+/g, ' '));
      var co = /^(.{1,40}?)\s+core$/i.exec(l);
      if (co && !/^(?:a)?symmetr/i.test(co[1])) setF('core', co[1]);
    }
    /* weight table rows without a label first: "15 lb | 2.48 | 0.051 | 0.012" */
    var wr = /^(1[0-6])\s*(?:#|lbs?\.?|pounds?)\s*[|:]?\s*([0-2]?\.\d{2,3})\s*\|?\s*([0-2]?\.\d{2,3})(?:\s*\|?\s*([0-2]?\.\d{2,3}))?/i.exec(l);
    if (wr) { var ww = +wr[1], s = out.weights[ww] = out.weights[ww] || {};
      var a = Number(wr[2]), b = Number(wr[3]);
      if (s.RG == null && a >= 2.3 && a <= 2.9) s.RG = a; if (s.Diff == null && b <= 0.08) s.Diff = b;
      if (wr[4] != null && s.IntDiff == null && Number(wr[4]) <= 0.04) s.IntDiff = Number(wr[4]);
      ['rg', 'diff'].forEach(function (k) { if (out.found.indexOf(k) < 0) out.found.push(k); }); }
  });
  if (!out.fields.coreType && out.fields.core && /asym|sym/i.test(out.fields.core)) out.fields.coreType = /asym/i.test(out.fields.core) ? 'Asymmetrical' : 'Symmetrical';
  if (name) { var f = foldName(name), all = foldName(text); out.nameSeen = !!f && all.indexOf(f) >= 0; }
  if (out.url) { var hst = ''; try { hst = new URL(out.url).host.replace(/^www\./, ''); } catch (e) {} out.host = hst;
    out.source = /bowwwl\.com$/.test(hst) ? 'bowwwl' : /storm|rotogrip|900global|brunswick|dv8|radical|hammer|ebonite|track|columbia300|motiv/.test(hst) ? 'maker' : 'other'; }
  else if (out.pdf) {   // only a saved page: a pasted bowwwl excerpt may name a maker
    var rt = /\u00a9\s*bowlersmart|bowlersmart\.com|\bbowlingball\.com\b|\bbowling\.com\b/i.exec(text);   // v30.204: retailers are "other", named
    if (rt && !/bowwwl/i.test(text)) { out.source = 'other'; out.host = /bowlersmart/i.test(rt[0]) ? 'bowlersmart.com' : /bowlingball/i.test(rt[0]) ? 'bowlingball.com' : 'bowling.com'; }
    else { var mk = spMakerOf(text); if (mk) { out.source = 'maker'; out.host = mk; } }
  }
  /* v30.206 WB-4: what the page says about the ball itself: discontinued, or a region release */
  if (/\b(?:retired|discontinued|no longer (?:available|made|produced))\b|bowling ball archives/i.test(text)) out.retired = true;
  var rgHead = regionFromText(lines.slice(0, 40).join(' ')); if (rgHead) out.region = rgHead;
  /* v30.203 WB-2: a value the page wrapped onto the next line ("500, 1000, 1500 Siaair / Factory" + "Compound").
     Only when it ends on a joiner and the next line is one or two plain words that are not a label. */
  ['finish', 'coverName', 'core'].forEach(function (k) {
    var v = out.fields[k]; if (!v || !/(?:[\/,&+]|\band)\s*\S*$/i.test(v)) return;
    for (var i = 0; i < lines.length - 1; i++) {
      if (lines[i].replace(/\s+/g, ' ').slice(-v.length).toLowerCase() !== v.toLowerCase()) continue;
      var nx = lines[i + 1];
      if (/^[A-Za-z][A-Za-z\-]*(?: [A-Za-z][A-Za-z\-]*)?$/.test(nx) && !SP_LABELS.some(function (x) { return x[1].test(nx); }) &&
          !/^(weights?|warranty|level|colou?r|reaction|performance|lane|downloads|resources|retired|specifications)$/i.test(nx)) out.fields[k] = v + ' ' + nx;
      break;
    }
  });   // only a saved page: a pasted bowwwl excerpt may name a maker   // v30.201: a saved maker page (PDF) has no address; its footer names the maker
  return out;
}
/* Clipboard read with a manual fallback box. done(text) */
function spReadClipboard(done) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(function (t) { if (t && t.trim()) done(t); else spManual(done); }, function () { spManual(done); });
  } else spManual(done);
}
var _spDone = null;
function spManual(done) {
  _spDone = done;
  var ov = overlay('spm-ov', 945);
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catSpManualClose()">\u2039</button>' +
    '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Paste the page</div><div style="font-size:11px;color:var(--t3)">Long-press the box and tap Paste.</div></div></div>' +
    '<div style="flex:1;padding:0 16px 16px"><textarea id="spm-txt" class="bdet-field-input" style="width:100%;height:60%;box-sizing:border-box;font-size:14px"></textarea></div>' +
    '<div style="padding:10px 16px;border-top:1px solid var(--border1)"><button style="' + BTN_P + 'width:100%;padding:11px" onclick="catSpManualGo()">Read it</button></div>';
  document.body.appendChild(ov);
}
function catSpManualGo() { var el = document.getElementById('spm-txt'), t = el ? el.value : '', d = _spDone; catSpManualClose(); if (d && t.trim()) d(t); }
function catSpManualClose() { var el = document.getElementById('spm-ov'); if (el) el.parentNode.removeChild(el); }
/* Review list. target: { name, weight, rows:[{k, label, cur, inputId, num?}] , apply(values), title } */
var _sp = null;
function spOpen(target, parsed) {
  var rows = [];
  target.rows.forEach(function (r) {
    var v = r.w != null ? ((parsed.weights[r.w] || {})[r.wk]) : parsed.fields[r.k];
    if (v == null || v === '') return;
    var vs = r.wk ? Number(v).toFixed(3) : String(v);
    var same = r.cur != null && String(r.cur).trim() !== '' && (r.wk ? Math.abs(Number(r.cur) - Number(v)) < 1e-9 : foldName(r.cur) === foldName(vs));
    rows.push({ r: r, v: vs, on: !same, same: same });
  });
  /* page image: shown for this ball on this device only (never published) */
  if (parsed.image && target.catalogId) rows.push({ r: { k: 'image', label: 'Image (this device only)', inputId: null, img: true }, v: parsed.image, on: !imgPicks()[target.catalogId], same: imgPicks()[target.catalogId] === parsed.image });
  _sp = { target: target, rows: rows, parsed: parsed };
  spRender();
}
function spRender() {
  var t = _sp.target, p = _sp.parsed;
  var from = p.host ? '<div style="font-size:11px;color:var(--t3);margin:2px 0 6px">From ' + esc(p.host) + '</div>' : '';
  var warn = p.nameSeen === false ? '<div style="font-size:12px;color:var(--gold);line-height:1.5;margin:4px 0 8px">\u201c' + esc(t.name) + '\u201d does not appear in what you copied. Check it is the right ball\u2019s page.</div>' : '';
  var list = _sp.rows.map(function (x, i) {
    if (x.r.img) return '<div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border1)">' +
      '<input type="checkbox" data-sp-cb="' + i + '" ' + (x.on ? 'checked' : '') + ' onchange="catSpToggle(' + i + ',this.checked)" style="width:18px;height:18px">' +
      '<img src="' + esc(x.v) + '" referrerpolicy="no-referrer" style="width:56px;height:56px;object-fit:contain;border-radius:8px;background:var(--bg3)" onerror="this.style.display=\'none\'">' +
      '<div style="flex:1;font-size:12px;font-weight:700;color:var(--t2)">' + esc(x.r.label) + (x.same ? '<div style="color:var(--teal);font-weight:600">\u2713 in use</div>' : '') + '</div></div>';
    return '<div style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border1)">' +
      '<input type="checkbox" data-sp-cb="' + i + '" ' + (x.on ? 'checked' : '') + ' onchange="catSpToggle(' + i + ',this.checked)" style="margin-top:22px;width:18px;height:18px">' +
      '<div style="flex:1;min-width:0"><div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:var(--t2)"><span>' + esc(x.r.label) + '</span>' +
      (x.same ? '<span style="color:var(--teal);font-weight:600">\u2713 same as now</span>' : x.r.cur != null && String(x.r.cur) !== '' ? '<span style="color:var(--t3);font-weight:600">now: ' + esc(String(x.r.cur)) + '</span>' : '<span style="color:var(--t3);font-weight:600">empty now</span>') + '</div>' +
      '<input id="sp-v-' + i + '" class="bdet-field-input" value="' + esc(x.v) + '" oninput="catSpEdit(' + i + ',this.value)"' + (x.r.wk ? ' inputmode="decimal"' : '') + ' style="width:100%;box-sizing:border-box;font-size:15px;margin-top:4px"></div></div>';
  }).join('');
  var n = _sp.rows.filter(function (x) { return x.on; }).length;
  var ov = document.getElementById('sp-ov') || overlay('sp-ov', 945);
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catSpClose()">\u2039</button>' +
    '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Found on the page</div><div style="font-size:11px;color:var(--t3)">' + esc(t.title || '') + '</div></div></div>' +
    (list ? (function () {
      var nSame = _sp.rows.filter(function (x) { return x.same; }).length, ch = function (t, h) { return '<button onclick="catSpAll(\'' + h + '\')" style="' + BTN_G + 'padding:6px 10px;font-size:12px">' + t + '</button>'; };
      return '<div style="display:flex;align-items:center;gap:8px;padding:0 16px 8px;border-bottom:1px solid var(--border1)">' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--t1);flex:1"><input id="sp-all" type="checkbox" ' + (_sp.rows.every(function (x) { return x.on; }) ? 'checked ' : '') +
        'onchange="catSpAll(this.checked ? \'all\' : \'none\')" style="width:20px;height:20px"> Select all ' + _sp.rows.length + '</label>' +
        (nSame ? ch('Changed only', 'changed') : '') + '</div>';
    })() : '') +
    '<div style="flex:1;overflow-y:auto;padding:0 16px 12px">' + from + warn +
    (list || '<div style="padding:24px 0;color:var(--t2);font-size:13px;line-height:1.6">No specs found in what you copied. In Safari, long-press the page text, tap <b>Select All</b>, then <b>Copy</b>, and try again.</div>') +
    (list ? '<div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.45">Edit any value before applying. Unticked rows are left alone. \u201cSame as now\u201d compares with the form you came from.</div>' : '') + '</div>' +
    '<div style="padding:10px 16px;border-top:1px solid var(--border1);display:flex;gap:8px"><button style="' + BTN_G + 'padding:11px" onclick="catSpClose()">Cancel</button>' +
    '<button id="sp-apply" style="' + BTN_P + 'flex:1;padding:11px" ' + (n ? '' : 'disabled ') + 'onclick="catSpApply()">Apply ' + n + '</button></div>';
  if (!ov.parentNode) document.body.appendChild(ov);
}
/* v30.189: ticking updates in place (re-rendering scrolled the list back to the top) */
function spCount() {
  var n = _sp.rows.filter(function (x) { return x.on; }).length, b = document.getElementById('sp-apply');
  if (b) { b.textContent = 'Apply ' + n; b.disabled = !n; }
  var sa = document.getElementById('sp-all'); if (sa) sa.checked = n === _sp.rows.length;
}
function catSpToggle(i, on) { if (_sp && _sp.rows[i]) { _sp.rows[i].on = !!on; spCount(); } }
/* v30.189: All (including "same as now", to re-assert them), None, or Changed only */
function catSpAll(how) {
  if (!_sp) return;
  _sp.rows.forEach(function (x) { x.on = how === 'all' ? true : how === 'none' ? false : !x.same; });
  var cbs = document.querySelectorAll('#sp-ov [data-sp-cb]');
  for (var i = 0; i < cbs.length; i++) { var x = _sp.rows[+cbs[i].getAttribute('data-sp-cb')]; if (x) cbs[i].checked = x.on; }
  spCount();
}
function catSpEdit(i, v) { if (_sp && _sp.rows[i]) { _sp.rows[i].v = v; if (!_sp.rows[i].on) { _sp.rows[i].on = true; var cb = document.querySelector('#sp-ov [data-sp-cb="' + i + '"]'); if (cb) cb.checked = true; spCount(); } } }
function catSpClose() { var el = document.getElementById('sp-ov'); if (el) el.parentNode.removeChild(el); _sp = null; }
function catSpApply() {
  if (!_sp) return;
  var n = 0, t = _sp.target;
  _sp.rows.forEach(function (x) {
    if (!x.on) return;
    if (x.r.img) { if (t.catalogId) { imgPickSet(t.catalogId, x.v); n++; } return; }
    var el = document.getElementById(x.r.inputId); if (!el) return;
    var v = String(x.v).trim();
    if (el.tagName === 'SELECT') { if (/asym/i.test(v)) v = 'Asymmetrical'; else if (/sym/i.test(v)) v = 'Symmetrical'; }
    el.value = v; el.style.boxShadow = '0 0 0 2px var(--teal)'; (function (e) { setTimeout(function () { e.style.boxShadow = ''; }, 900); })(el); n++;
  });
  if (t.after) t.after(n, _sp.parsed);
  catSpClose();
  if (root.toast) root.toast(n + ' field' + (n === 1 ? '' : 's') + ' filled. Check, then save.');
}
/* Correct specs sheet */
function catSpAp() {
  if (!_apEdit) return;
  var g = function (id) { var el = document.getElementById(id); return el ? el.value : null; };
  var rows = [['coverName', 'Coverstock', 'ape-coverName'], ['coverType', 'Cover type', 'ape-coverType'], ['finish', 'Factory finish', 'ape-finish'], ['core', 'Core', 'ape-core'],
    ['coreType', 'Core type', 'ape-coreType'], ['released', 'Release date', 'ape-released']].map(function (a) { return { k: a[0], label: a[1], inputId: a[2], cur: g(a[2]) }; });
  AP_WEIGHTS.forEach(function (w) { [['RG', 'RG'], ['Diff', 'Diff'], ['IntDiff', 'Int Diff']].forEach(function (a) {
    rows.push({ w: w, wk: a[0], label: w + ' lb ' + a[1], inputId: 'ape-' + w + '-' + a[0], cur: g('ape-' + w + '-' + a[0]) }); }); });
  (_spReader === 'pdf' ? spReadPdf : spReadClipboard)(function (text) {
    spOpen({ name: _apEdit.ballName, title: _apEdit.ballName, catalogId: _apEdit.catalogId, rows: rows, after: function (n, pp) {
      /* source follows the copied page's site (Shortcut adds it); a plain paste is assumed bowwwl, as button 1 opens bowwwl */
      if (n) { var so = document.getElementById('ape-source'); if (so) so.value = (pp && pp.source) || 'bowwwl'; }
    } }, parseSpecText(text, 15, _apEdit.ballName));
  });
}
var _spFrom = 'bowwwl';
/* Ball Detail Look up sheet */
function catSpBall() {
  var b = appBalls().filter(function (x) { return x.BallID == _lk.ballId; })[0]; if (!b) return;
  var g = function (id) { var el = document.getElementById(id); return el ? el.value : null; };
  var w = parseInt(b.Weight, 10) || 15;
  var rows = [['coverName', 'Coverstock', 'lk-CoverName'], ['coverType', 'Cover type', 'lk-Coverstock'], ['finish', 'Factory finish', 'lk-BoxFinish'], ['core', 'Core', 'lk-CoreShort'],
    ['coreType', 'Core type', 'lk-CoreType'], ['released', 'Release date', 'lk-DateReleased']].map(function (a) { return { k: a[0], label: a[1], inputId: a[2], cur: g(a[2]) }; });
  [['RG', 'RG', 'lk-RG'], ['Diff', 'Diff', 'lk-Differential'], ['IntDiff', 'Int Diff', 'lk-IntDiff']].forEach(function (a) { rows.push({ w: w, wk: a[0], label: a[1] + ' (' + w + ' lb)', inputId: a[2], cur: g(a[2]) }); });
  (_spReader === 'pdf' ? spReadPdf : spReadClipboard)(function (text) {
    var p = parseSpecText(text, w, _lk.name || b.BallName);
    /* your own ball's Cover type is a class (Solid / Pearl / Hybrid / Urethane) */
    if (p.fields.coverType || p.fields.coverName) { var cc = coverClass(p.fields.coverType, p.fields.coverName); if (cc) p.fields.coverType = cc.charAt(0).toUpperCase() + cc.slice(1); }
    spOpen({ name: _lk.name || b.BallName, title: b.BallName, catalogId: b.CatalogID, rows: rows }, p);
  });
}

/* ---------- v30.179: read a saved page PDF ----------
   For when the Shortcut can't run: in Safari take a screenshot, choose
   Full Page, Save PDF to Files; then pick the PDF here. iOS full-page
   screenshots and Print-to-PDF keep the page's real text, so pdf.js (loaded
   from cdnjs only when used) reads it back into lines for parseSpecText. */
var PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
var _pdfjsP = null;
function pdfLib() {
  if (!_pdfjsP) _pdfjsP = import(PDFJS_URL).then(function (m) { m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; return m; }, function (e) { _pdfjsP = null; throw e; });
  return _pdfjsP;
}
/* Pure: pdf.js text items of one page -> lines in reading order. Items on the same baseline join;
   a wide gap becomes " | " so "Coverstock      R2S Pearl" reads as label | value. */
function pdfItemsToLines(items) {
  var it = (items || []).filter(function (x) { return x && typeof x.str === 'string' && x.str.trim() !== ''; })
    .map(function (x) { return { s: x.str, x: x.transform[4], y: x.transform[5], w: x.width || 0 }; })
    .sort(function (a, b) { return Math.abs(b.y - a.y) > 2.5 ? b.y - a.y : a.x - b.x; });
  var lines = [], cur = null;
  it.forEach(function (x) {
    if (cur && Math.abs(cur.y - x.y) <= 2.5) {
      var gap = x.x - cur.end;
      cur.t += (gap > 24 ? ' | ' : gap > 1 ? ' ' : '') + x.s;
      cur.end = x.x + x.w;
    } else { if (cur) lines.push(cur.t); cur = { y: x.y, t: x.s, end: x.x + x.w }; }
  });
  if (cur) lines.push(cur.t);
  return lines.map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
}
function pdfToText(buf) {
  return pdfLib().then(function (lib) { return lib.getDocument({ data: new Uint8Array(buf) }).promise; }).then(function (doc) {
    var pages = [], n = Math.min(doc.numPages, 12);
    var next = function (i) {
      if (i > n) return Promise.resolve(pages.join('\n'));
      return doc.getPage(i).then(function (pg) { return pg.getTextContent(); }).then(function (tc) { pages.push(pdfItemsToLines(tc.items).join('\n')); return next(i + 1); });
    };
    return next(1);
  });
}
/* Opens the file picker (must run inside the tap), reads the PDF, hands back its text. */
function spReadPdf(done) {
  var inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/pdf,.pdf'; inp.style.display = 'none';
  inp.addEventListener('change', function () {
    var f = inp.files && inp.files[0]; inp.parentNode && inp.parentNode.removeChild(inp);
    if (!f) return;
    if (!/pdf/i.test(f.type) && !/\.pdf$/i.test(f.name)) { if (root.toast) root.toast('Pick a PDF (a screenshot saved as Full Page is a PDF)'); return; }
    if (root.toast) root.toast('Reading the PDF\u2026');
    f.arrayBuffer().then(pdfToText).then(function (t) {
      if (!t.trim()) { if (root.toast) root.toast('No text in that PDF. Use Full Page (not a photo) when saving.'); return; }
      done('BDB-PDF\n' + t);   // v30.201: marks a saved page, so a maker's own page is recognised by its footer
    }, function (e) { if (root.toast) root.toast('Could not read the PDF' + (typeof navigator !== 'undefined' && navigator.onLine === false ? ' (offline: the reader loads once online)' : '')); });
  });
  document.body.appendChild(inp);
  inp.click();
}
/* v30.204 WB-3: one file -> 'BDB-PDF\n' + text (the workbench picks several at once) */
function spPdfFileText(f) { return f.arrayBuffer().then(pdfToText).then(function (t) { return t && t.trim() ? 'BDB-PDF\n' + t : ''; }); }
var _spReader = null;   // null = clipboard; 'pdf' = saved page PDF
function catSpApPdf() { _spReader = 'pdf'; try { catSpAp(); } finally { _spReader = null; } }
function catSpBallPdf() { _spReader = 'pdf'; try { catSpBall(); } finally { _spReader = null; } }
function catPdfHelp() {
  var ov = overlay('pdh-ov', 1050);
  var step = function (n, t) { return '<div style="display:flex;gap:10px;padding:7px 0"><div style="flex:0 0 22px;height:22px;border-radius:11px;background:var(--teal);color:#000;font-weight:800;font-size:12px;display:flex;align-items:center;justify-content:center">' + n + '</div><div style="flex:1;font-size:13px;color:var(--t1);line-height:1.5">' + t + '</div></div>'; };
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="var e=document.getElementById(\'pdh-ov\');e.parentNode.removeChild(e)">\u2039</button>' +
    '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Save the page as a PDF</div><div style="font-size:11px;color:var(--t3)">No setup needed</div></div></div>' +
    '<div style="flex:1;overflow-y:auto;padding:0 16px 16px">' +
    step(1, 'On the ball\u2019s page in Safari, take a screenshot (side button + volume up).') +
    step(2, 'Tap the screenshot preview, then <b>Full Page</b> at the top.') +
    step(3, 'Tap <b>Done</b> \u203a <b>Save PDF to Files</b>.') +
    step(4, 'Back here, tap <b>Read a saved page (PDF)</b> and pick it.') +
    '<div style="font-size:12px;color:var(--t3);line-height:1.5;margin-top:8px">A Full Page screenshot keeps the page\u2019s text, so the app can read it. A normal (photo) screenshot has no text to read.</div></div>';
  document.body.appendChild(ov);
}

/* ---------- v30.180/181: Ball images (catch-up), covers and cores ----------
   Lists balls with no picture: your own balls first, then the catalog. A
   Cover / Core switch picks which picture. Per row, three ways in, all kept on
   this device only:
     bowwwl  - tries bowwwl's picture file (named after the ball, or for cores
               after the core); only when you tap, never in the background
     Paste   - a copied picture (Safari: long-press, Copy) or its address
     Photo   - a picture from Photos / Files
   Nothing is stored until "Use" (or "Use all found").
   Cores are kept per core (brand + core name), so one picture serves every
   ball with that core, in the catalog and in your arsenal.
   Storage: links in localStorage (bdbimg_pick for covers, bdbimg_core for
   cores), files shrunk to 480 px JPEG in IndexedDB "bdb_catimg" (keys:
   catalog id, or "core:<key>"). Kept until you remove them; the app asks iOS
   to keep its storage, and Save / Restore moves them to a file you keep.
   Your own balls: the existing picture store (ImagePath / CoreImagePath,
   ballImages). A stored picture never replaces one a ball already has. */
var BW_FILES = 'https://www.bowwwl.com/sites/default/files/';
var BW_IMG_BASE = BW_FILES + 'balls/';
var CORE_LINKS_KEY = 'bdbimg_core';
var _catImgObj = {};   // catalogId or "core:<key>" -> object URL of a stored file
var _mi = { tab: 'mine', slot: 'cover', page: 0, q: '', found: {}, busy: {}, all: null, coreAll: null, scan: null };
/* v30.182: bowwwl finds (links) and misses survive closing the app, so a long scan is never lost and never repeated */
var SCAN_KEY = 'bdbimg_scan';
function scanMem() { var l = apLS(); try { var o = JSON.parse((l && l.getItem(SCAN_KEY)) || 'null'); return o && o.found ? o : { found: {}, miss: {} }; } catch (e) { return { found: {}, miss: {} }; } }
function scanSave(m) { var l = apLS(); if (l) try { l.setItem(SCAN_KEY, JSON.stringify(m)); } catch (e) {} }
function scanNote(fk, url) { var m = scanMem(); if (url) { m.found[fk] = url; delete m.miss[fk]; } else if (url === null) { m.miss[fk] = 1; delete m.found[fk]; } else { delete m.found[fk]; } scanSave(m); }
function slugBw(t) {
  return String(t || '').toLowerCase().replace(/^\*+\s*/, '').replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/['\u2019\u00ae\u2122"]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
/* Pure: bowwwl image addresses to try for a ball, most likely first. */
function bowwwlImgCandidates(brand, name) {
  var b = brandSlug(brand), n = slugBw(name); if (!b || !n) return [];
  var bases = [b + '-' + n];
  var n2 = n.replace(/-(\d+)-0$/, '-$1');                       // "Black Widow 2.0" -> black-widow-2
  if (n2 !== n) bases.push(b + '-' + n2);
  var out = [];
  bases.forEach(function (x) { ['.png', '.jpg'].forEach(function (e) { out.push(BW_IMG_BASE + x + e); }); });
  return out;
}
/* Pure: a core's name without "core"/"weight block" and symmetry words. */
function coreBase(name) {
  return String(name || '').replace(/[\u2122\u00ae]/g, '').replace(/\b(?:a?symmetric(?:al)?|weight\s*block|mass\s*bias|core)\b/ig, ' ').replace(/\s+/g, ' ').trim();
}
/* Pure: one key per core (brand + core name), so balls sharing a core share its picture. */
function brandSlug(brand) { return slugBw(brand).replace(/-(?:inc|bowling|international|industries|co)$/, ''); }   // "Track Inc" = "Track"
function coreKeyOf(brand, coreName) { var b = brandSlug(brand), c = slugBw(coreBase(coreName)); return b && c ? b + '|' + c : null; }
/* Pure: bowwwl core picture addresses ("brunswick-rampart-core.png"). */
function bowwwlCoreCandidates(brand, coreName) {
  var b = brandSlug(brand); if (!b) return [];
  /* bowwwl core titles carry extras ("Centrex Symmetrical Mass Bias Core"); try the
     full name, the name without symmetry / mass-bias / core words, and its first word */
  var raw = String(coreName || '').replace(/[\u2122\u00ae]/g, '');
  var full = slugBw(raw.replace(/\bcore\b/ig, ' '));
  var base = slugBw(coreBase(raw).replace(/\bmass\s*bias\b|\bmb\b/ig, ' '));
  var first = base.split('-')[0];
  var names = [base, full, first].filter(function (x, i, a) { return x && a.indexOf(x) === i && !(x === first && x.length < 3); });
  var out = [];
  names.forEach(function (c) { [b + '-' + c + '-core', b + '-' + c].forEach(function (x) { out.push(BW_FILES + 'cores/' + x + '.png'); }); });
  names.forEach(function (c) { out.push(BW_FILES + 'cores/' + b + '-' + c + '-core.jpg'); });
  return out.slice(0, 9);
}
function coreLinks() { var l = apLS(); try { return JSON.parse((l && l.getItem(CORE_LINKS_KEY)) || '{}') || {}; } catch (e) { return {}; } }
function coreLinkSet(k, url) { var l = apLS(); if (!l) return; var m = coreLinks(); if (url) m[k] = url; else delete m[k]; l.setItem(CORE_LINKS_KEY, JSON.stringify(m)); }
function catCoreImageFor(brand, coreName) {
  var k = coreKeyOf(brand, coreName); if (!k) return null;
  return _catImgObj['core:' + k] || coreLinks()[k] || null;
}
function catImgDB() {
  return new Promise(function (res, rej) {
    var idb = env.idb(); if (!idb) return rej(new Error('no IndexedDB'));
    var r = idb.open('bdb_catimg', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('img'); };
    r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
  });
}
function imgPersist() { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {} }
function catImgPut(id, blob) {
  imgPersist();
  return catImgDB().then(function (db) { return new Promise(function (res, rej) {
    var t = db.transaction('img', 'readwrite'); t.objectStore('img').put({ blob: blob, at: env.now() }, id);
    t.oncomplete = function () { res(true); }; t.onerror = function () { rej(t.error); }; }); })
    .then(function () { if (_catImgObj[id]) try { URL.revokeObjectURL(_catImgObj[id]); } catch (e) {} _catImgObj[id] = URL.createObjectURL(blob); });
}
function catImgAll() {
  return catImgDB().then(function (db) { return new Promise(function (res) {
    var out = [], rq = db.transaction('img', 'readonly').objectStore('img').openCursor();
    rq.onsuccess = function () { var c = rq.result; if (!c) return res(out); out.push({ key: c.key, value: c.value }); c.continue(); };
    rq.onerror = function () { res(out); }; }); });
}
function catImgWarm() {
  return catImgAll().then(function (all) { all.forEach(function (x) { if (x.value && x.value.blob) _catImgObj[x.key] = URL.createObjectURL(x.value.blob); }); }).catch(function () {});
}
if (typeof document !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) setTimeout(catImgWarm, 800);
/* Loads an image address; resolves with it when it shows, else null. */
function imgProbe(url, ms) {
  return new Promise(function (res) {
    var im = new Image(), done = false, fin = function (v) { if (!done) { done = true; res(v); } };
    im.referrerPolicy = 'no-referrer';
    im.onload = function () { fin(im.naturalWidth > 40 ? url : null); }; im.onerror = function () { fin(null); };
    setTimeout(function () { fin(null); }, ms || 8000);
    im.src = url;
  });
}
/* Shrinks a picture to at most 480 px (JPEG on white) so hundreds fit on the phone. */
function imgShrink(blob) {
  return new Promise(function (res) {
    var u = URL.createObjectURL(blob), im = new Image();
    im.onload = function () {
      var k = Math.min(1, 480 / Math.max(im.naturalWidth, im.naturalHeight)), w = Math.round(im.naturalWidth * k), h = Math.round(im.naturalHeight * k);
      var c = document.createElement('canvas'); c.width = w; c.height = h; var x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(im, 0, 0, w, h); URL.revokeObjectURL(u);
      c.toBlob(function (b) { res(b || blob); }, 'image/jpeg', 0.86);
    };
    im.onerror = function () { URL.revokeObjectURL(u); res(blob); };
    im.src = u;
  });
}
function ownPic(b, slot) { try { return typeof root.getBallImgSrc === 'function' ? root.getBallImgSrc(b.BallID, slot) : (slot === 'cover' ? b.ImagePath : b.CoreImagePath); } catch (e) { return null; } }
/* Rows. Cover: your balls without a cover picture; catalog balls with specs and no picture.
   Core: your balls without a core picture; catalog cores (brand + core name) with no picture. */
function catImageStored(id) { return id ? (_catImgObj[id] || imgPicks()[id] || null) : null; }
/* v30.200 IMG-2: pictures already at hand are offered ready to save (maker picture links; for your
   own balls, the linked catalog ball's saved picture). Checked on the row; nothing stored until Use. */
function miPrefill(set) {
  if (!set) return 0;
  var mk = imgMap(), n = 0, put = function (r, u, how) { if (!u || /^blob:/.test(u) || _mi.found[r.key]) return; _mi.found[r.key] = { url: u, how: how, link: true }; n++; };
  set.mine.forEach(function (r) { if (!r.catId) return; var st = imgPicks()[r.catId]; put(r, st || mk[r.catId], st ? 'catalog picture' : 'maker picture'); });
  set.cat.forEach(function (r) { put(r, mk[r.catId], 'maker picture'); });
  return n;
}
function miCoverRows(rows) {
  var mine = appBalls().filter(function (b) { return !b.Archived && b.BallID != null && !ownPic(b, 'cover'); })
    .map(function (b) { var e = b.CatalogID ? byIdIn(rows, b.CatalogID) : null;
      return { key: 'b' + b.BallID, ballId: b.BallID, catId: b.CatalogID || null, brand: e ? e.m : b.MFG, name: e ? cleanName(e.n) : b.BallName, year: e ? e.y : '', coreName: b.CoreShort || null }; });
  /* v30.200 IMG-2: a ball is listed until a picture is saved on this phone; a maker picture that is
     only shown (Manufacturer images on this device) doesn't count, it is offered ready to save */
  /* v30.201: balls without specs are listed too (James: every ball with no picture, in one place) */
  var own = {}; appBalls().forEach(function (b) { if (b.CatalogID && !b.Archived) own[b.CatalogID] = 1; });
  var cat = (rows || []).filter(function (e) { return !catImageStored(e.i) && !catIsRejected(e) && !(e.a && !own[e.i]); })   // v30.202: archived only when yours
    .sort(function (a, b) { return String(b.y || '').localeCompare(String(a.y || '')) || String(a.m).localeCompare(String(b.m)); })
    .map(function (e) { return { key: 'c' + e.i, ballId: null, catId: e.i, brand: e.m, name: cleanName(e.n), year: e.y }; });
  return { mine: mine, cat: cat };
}
function miCoreRows(rows) {
  var spec = (rows || []).filter(function (e) { return e.s; });
  var cores = {};
  return spec.reduce(function (p, e) {
    return p.then(function () { return catDetailRaw(e).catch(function () { return null; }).then(function (d) {
      var nm = d && d.Core && d.Core.Name; var k = nm && plausibleText('core', nm) ? coreKeyOf(e.m, nm) : null; if (!k) return;
      var c = cores[k] = cores[k] || { key: 'k' + k, coreKey: k, brand: e.m, name: coreBase(nm) || nm, balls: [], year: '' };
      c.balls.push(e.i); if (String(e.y || '') > c.year) c.year = String(e.y || ''); }); });
  }, Promise.resolve()).then(function () {
    var cat = Object.keys(cores).map(function (k) { return cores[k]; }).filter(function (c) { return !catCoreImageFor(c.brand, c.name); })
      .sort(function (a, b) { return b.year.localeCompare(a.year) || String(a.brand).localeCompare(String(b.brand)); })
      .map(function (c) { c.sub = c.balls.length + ' ball' + (c.balls.length === 1 ? '' : 's'); return c; });
    var mine = appBalls().filter(function (b) { return !b.Archived && b.BallID != null && !ownPic(b, 'core'); }).map(function (b) {
      var e = b.CatalogID ? byIdIn(rows, b.CatalogID) : null, brand = e ? e.m : b.MFG;
      var nm = b.CoreShort, k = null;
      if (!nm && b.CatalogID) { var hit = Object.keys(cores).filter(function (x) { return cores[x].balls.indexOf(b.CatalogID) >= 0; })[0]; if (hit) nm = cores[hit].name; }
      if (nm && plausibleText('core', nm)) k = coreKeyOf(brand, nm);
      return { key: 'b' + b.BallID, ballId: b.BallID, catId: b.CatalogID || null, coreKey: k, brand: brand, name: b.BallName, sub: nm ? coreBase(nm) + ' core' : 'core name unknown', coreName: nm || null };
    });
    /* a core picture already kept on this phone is offered straight away */
    mine.forEach(function (r) { var u = r.coreKey ? (_catImgObj['core:' + r.coreKey] || coreLinks()[r.coreKey]) : null; if (u) _mi.found['core' + r.key] = { url: u, how: 'saved core picture', link: !/^blob:/.test(u) }; });
    return { mine: mine, cat: cat };
  });
}
function miSet() { return _mi.slot === 'core' ? _mi.coreAll : _mi.all; }
function miFk(k) { return (_mi.slot === 'core' ? 'core' : '') + k; }
/* v30.184: in Cover mode a row also carries its core picture ("ball" / "core" parts). */
function fkFor(k, part) { return part === 'core' && _mi.slot === 'cover' ? 'rc' + k : miFk(k); }
function rowCoreKey(r) { return r.coreKey || (r.coreName && plausibleText('core', r.coreName) ? coreKeyOf(r.brand, r.coreName) : null); }
function coreRowOf(r) {
  var k = rowCoreKey(r) || 'id-' + (r.catId || ('b' + r.ballId));
  return { coreKey: k, ballId: r.ballId, catId: r.catId, balls: r.catId ? [r.catId] : null, brand: r.brand, coreName: r.coreName };
}
/* core name + whether a core picture is already kept, for a Cover row (loads its catalog detail once) */
function miEnsureCore(r) {
  if (r.coreTried) return Promise.resolve(r);
  var e = r.catId && _mi.rows ? byIdIn(_mi.rows, r.catId) : null;
  return (e ? catDetailRaw(e).catch(function () { return null; }) : Promise.resolve(null)).then(function (d) {
    r.coreTried = true;
    if (!r.coreName && d && d.Core && d.Core.Name && plausibleText('core', d.Core.Name)) r.coreName = d.Core.Name;
    var ck = rowCoreKey(r); if (ck) r.coreKey = ck;
    var have = ck ? (_catImgObj['core:' + ck] || coreLinks()[ck]) : null;
    var b = r.ballId != null ? appBalls().filter(function (x) { return x.BallID == r.ballId; })[0] : null;
    if (!have && b) have = ownPic(b, 'core');
    r.coreHave = have || null;
    return r;
  });
}
function catImagesOpen() {
  var mb = document.getElementById('modal-bg');
  if (mb && mb.classList.contains('open') && typeof root.closeModal === 'function') root.closeModal();
  var ov = overlay('mi-ov', 906); document.body.appendChild(ov);
  _mi.page = 0; _mi.found = {}; _mi.busy = {}; _mi.all = null; _mi.coreAll = null; _mi.slot = 'cover';
  var sm = scanMem(); Object.keys(sm.found).forEach(function (fk) { _mi.found[fk] = { url: sm.found[fk], how: 'bowwwl', link: true }; });
  ov.innerHTML = '<div style="padding:30px;text-align:center;color:var(--t3)">Loading\u2026</div>';
  catLoad().then(function (rows) { _mi.rows = rows; _mi.all = miCoverRows(rows); miPrefill(_mi.all); miRender(); });
}
function catImagesClose() { var el = document.getElementById('mi-ov'); if (el) el.parentNode.removeChild(el); }
function catImagesSlot(s) {
  _mi.slot = s; _mi.page = 0;
  if (s === 'core' && !_mi.coreAll) { miRender(); miCoreRows(_mi.rows).then(function (c) { _mi.coreAll = c; miRender(); }); return; }
  miRender();
}
function miList() {
  var set = miSet(); if (!set) return [];
  var l = _mi.tab === 'mine' ? set.mine : set.cat, q = foldName(_mi.q);
  return q ? l.filter(function (r) { return foldName(r.brand + ' ' + r.name + ' ' + (r.sub || '')).indexOf(q) >= 0; }) : l;
}
var MI_PAGE = 20;
function miRender() {
  var ov = document.getElementById('mi-ov'); if (!ov || !_mi.all) return;
  var set = miSet(), loading = !set;
  var list = miList(), pages = Math.max(1, Math.ceil(list.length / MI_PAGE)); _mi.page = Math.min(_mi.page, pages - 1);
  var sm = scanMem(); list.forEach(function (r) { if (sm.miss[miFk(r.key)] && !_mi.found[miFk(r.key)]) r.miss = true; });
  var shown = list.slice(_mi.page * MI_PAGE, _mi.page * MI_PAGE + MI_PAGE);
  miSrcLoad(shown);
  var seg = function (k, t, on, call) { return '<button onclick="' + call + '(\'' + k + '\')" style="flex:1;padding:8px;border-radius:9px;font-size:13px;font-weight:700;border:1px solid ' + (on ? 'var(--teal)' : 'var(--border1)') + ';background:' + (on ? 'rgba(0,217,217,0.12)' : 'transparent') + ';color:' + (on ? 'var(--teal)' : 'var(--t2)') + '">' + t + '</button>'; };
  list.forEach(function (r) { if (_mi.slot === 'cover' && sm.miss[fkFor(r.key, 'core')] && !_mi.found[fkFor(r.key, 'core')]) r.coreMiss = true; });
  var nFound = list.filter(function (r) { return _mi.found[miFk(r.key)] || (_mi.slot === 'cover' && _mi.found[fkFor(r.key, 'core')]); }).length;
  var todo = list.filter(miNeedsCheck).length;
  var row = function (r) {
    if (_mi.slot === 'cover') return rowCover(r);
    var f = _mi.found[miFk(r.key)], busy = _mi.busy[miFk(r.key)];
    var pic = f ? '<img src="' + esc(f.url) + '" referrerpolicy="no-referrer" style="width:52px;height:52px;border-radius:' + (_mi.slot === 'core' ? '10px' : '50%') + ';object-fit:contain;background:#fff;flex-shrink:0">' :
      '<div style="width:52px;height:52px;border-radius:' + (_mi.slot === 'core' ? '10px' : '50%') + ';flex-shrink:0;background:var(--bg3);display:flex;align-items:center;justify-content:center;color:var(--t3);font-size:11px">' + (busy ? '\u2026' : r.miss ? 'none' : '') + '</div>';
    var canBw = _mi.slot === 'cover' || r.coreKey;
    var acts = f ? '<button style="' + BTN_P + 'padding:6px 10px;font-size:12px" onclick="catImagesUse(\'' + r.key + '\')">Use</button><button style="' + BTN_G + 'padding:6px 10px;font-size:12px" onclick="catImagesDrop(\'' + r.key + '\')">\u2715</button>' :
      (canBw ? '<button style="' + BTN_G + 'padding:6px 8px;font-size:12px" onclick="catImagesTry(\'' + r.key + '\')">bowwwl</button>' : '') +
      '<button style="' + BTN_G + 'padding:6px 8px;font-size:12px" onclick="catImagesPaste(\'' + r.key + '\')">Paste</button>' +
      '<button style="' + BTN_G + 'padding:6px 8px;font-size:12px" onclick="catImagesPhoto(\'' + r.key + '\')">Photo</button>';
    var sub = esc(r.brand || '') + (r.sub ? ' \u00b7 ' + esc(r.sub) : r.year ? ' \u00b7 ' + esc(r.year) : '');
    var fl = f ? '' : miFindLinks(r);
    return '<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border1)">' + pic +
      '<div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(r.name) + (_mi.slot === 'core' && _mi.tab === 'cat' ? ' core' : '') + '</div>' +
      '<div style="font-size:11px;color:var(--t3)">' + sub + (r.miss ? ' \u00b7 <span style="color:var(--gold)">not on bowwwl under this name</span>' : f ? ' \u00b7 <span style="color:var(--teal)">' + esc(f.how) + '</span>' : '') + '</div>' + fl + '</div>' +
      '<div style="display:flex;gap:4px;flex-shrink:0">' + acts + '</div></div>';
  };
  var hint = _mi.slot === 'core' ? 'Core pictures are kept per core: one picture covers every ball with that core, yours and the catalog\u2019s.' :
    'Each ball takes its picture and its core picture here: copy one, Paste it on its line, copy the other, Paste, then Use. A core picture is kept per core, so other balls with that core get it too.';
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 6px"><button style="' + BACK + '" onclick="catImagesClose()">\u2039</button>' +
    '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Ball images</div><div style="font-size:11px;color:var(--t3)">Missing pictures \u00b7 kept on this device</div></div></div>' +
    '<div style="display:flex;gap:6px;padding:0 16px 6px">' + seg('cover', 'Cover', _mi.slot === 'cover', 'catImagesSlot') + seg('core', 'Core', _mi.slot === 'core', 'catImagesSlot') + '</div>' +
    '<div style="display:flex;gap:6px;padding:0 16px 8px">' + seg('mine', 'My balls' + (set ? ' (' + set.mine.length + ')' : ''), _mi.tab === 'mine', 'catImagesTab') +
      seg('cat', (_mi.slot === 'core' ? 'Catalog cores' : 'Catalog') + (set ? ' (' + set.cat.length + ')' : ''), _mi.tab === 'cat', 'catImagesTab') + '</div>' +
    '<div style="padding:0 16px 6px"><input class="bdet-field-input" type="search" placeholder="Filter by brand or name" value="' + esc(_mi.q) + '" oninput="catImagesFilter(this.value)" style="width:100%;box-sizing:border-box;font-size:15px"></div>' +
    '<div style="flex:1;overflow-y:auto;padding:0 16px 10px">' +
      /* v30.200 IMG-2: one obvious action when pictures are already at hand */
      (!loading && nFound ? '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;margin:2px 0 8px;border-radius:12px;border:1px solid rgba(0,217,217,0.3);background:rgba(0,217,217,0.08)">' +
        '<div style="flex:1;min-width:0;font-size:13px;color:var(--t1);line-height:1.4"><b>' + nFound + ' ready to save</b><div style="font-size:11px;color:var(--t2)">Maker pictures and bowwwl finds. Tap \u2715 on any that look wrong, then save.</div></div>' +
        '<button style="' + BTN_P + 'padding:9px 12px;font-size:13px;white-space:nowrap" onclick="catImagesUseAll()">Save all ' + nFound + '</button></div>' : '') +
      (loading ? '<div style="padding:30px 0;text-align:center;color:var(--t3);font-size:13px">Reading core names from the catalog\u2026</div>' : shown.length ? shown.map(row).join('') :
      '<div style="padding:30px 0;text-align:center;color:var(--t2);font-size:13px">' + (_mi.q ? 'No match.' : 'Nothing missing here.') + '</div>') +
    (hint ? '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:10px">' + hint + '</div>' : '') +
    '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:8px"><b>Find</b> opens the ball on bowwwl, the maker\u2019s site or a web image search; long-press the picture there, tap Copy, come back and tap <b>Paste</b>. <b>Photo</b>: a picture saved to Photos or Files. <b>bowwwl</b> / <b>Check bowwwl for all</b> look for bowwwl\u2019s picture files; only when you tap.</div>' +
    '<div style="display:flex;gap:6px;margin-top:12px"><button style="' + BTN_G + 'flex:1;padding:9px;font-size:12px" onclick="catBackupOpen()">Catalog backup</button>' +
      '<button style="' + BTN_G + 'flex:1;padding:9px;font-size:12px" onclick="catBackupRestore()">Restore from a file</button></div></div>' +
    '<div style="padding:10px 16px;border-top:1px solid var(--border1);display:flex;flex-direction:column;gap:8px">' +
      (_mi.scan ? '<div style="font-size:12px;color:var(--t2)">Checking bowwwl: ' + _mi.scan.done + ' of ' + _mi.scan.total + ' \u00b7 found ' + _mi.scan.found +
        '<div style="height:5px;border-radius:3px;background:var(--bg3);margin-top:5px"><div style="height:5px;border-radius:3px;background:var(--teal);width:' + Math.round(100 * _mi.scan.done / Math.max(1, _mi.scan.total)) + '%"></div></div></div>' : '') +
      '<div style="display:flex;gap:6px">' + (_mi.scan ? '<button style="' + BTN_G + 'flex:1;padding:10px;font-size:13px" onclick="catImagesScanStop()">Stop</button>' :
        todo ? '<button style="' + BTN_G + 'flex:1;padding:10px;font-size:13px" onclick="catImagesScanAll()">Check bowwwl for all ' + todo + '</button>' : '') +
      (nFound ? '<button style="' + BTN_P + 'flex:1;padding:10px;font-size:13px" onclick="catImagesUseAll()">Use all found (' + nFound + ')</button>' : '') + '</div>' +
      '<div style="display:flex;gap:8px;align-items:center"><button style="' + BTN_G + 'flex:1;padding:9px" ' + (_mi.page > 0 ? '' : 'disabled ') + 'onclick="catImagesPage(-1)">\u2039 Prev</button>' +
      '<span style="font-size:12px;color:var(--t2);min-width:70px;text-align:center">' + (_mi.page + 1) + ' of ' + pages + '</span>' +
      '<button style="' + BTN_G + 'flex:1;padding:9px" ' + (_mi.page < pages - 1 ? '' : 'disabled ') + 'onclick="catImagesPage(1)">Next \u203a</button></div></div>';
}
/* v30.182: check bowwwl for every ball in the list (not just the page): two at a time with a
   short pause, stoppable; finds and misses are remembered (bdbimg_scan) so nothing is asked twice. */
function miNeedsCheck(r) {
  var ball = !_mi.found[miFk(r.key)] && !r.miss && (_mi.slot === 'cover' || r.coreKey);
  if (_mi.slot !== 'cover') return ball;
  var core = !r.coreHave && !_mi.found[fkFor(r.key, 'core')] && !r.coreMiss && !scanMem().miss[fkFor(r.key, 'core')] && (!r.coreTried || r.coreKey);
  return ball || core;
}
function catImagesScanAll() {
  if (_mi.scan) return Promise.resolve();
  var list = miList().filter(miNeedsCheck);
  if (!list.length) return Promise.resolve();
  var mins = Math.max(1, Math.round(list.length * 1.2 / 60));
  if (root.confirm && !root.confirm('Check bowwwl for ' + list.length + ' picture' + (list.length === 1 ? '' : 's') + '? About ' + mins + ' min; keep the app open. You can stop any time, and what is found is kept for review.')) return Promise.resolve();
  var scan = _mi.scan = { total: list.length, done: 0, found: 0, stop: false }, i = 0, last = 0;
  var tick = function () { var t = env.now(); if (t - last > 700) { last = t; miRender(); } };
  var worker = function () {
    if (scan.stop || i >= list.length) return Promise.resolve();
    var r = list[i++];
    var ball = !_mi.found[miFk(r.key)] && !r.miss && (_mi.slot === 'cover' || r.coreKey);
    return (ball ? catImagesTry(r.key) : Promise.resolve(null)).then(function (u) {
      if (_mi.slot !== 'cover') return [u];
      return miEnsureCore(r).then(function () {
        var want = r.coreKey && !r.coreHave && !_mi.found[fkFor(r.key, 'core')] && !r.coreMiss && !scanMem().miss[fkFor(r.key, 'core')];
        return want ? catImagesTry(r.key, 'core').then(function (c) { return [u, c]; }) : [u];
      });
    }).then(function (us) { scan.done++; us.forEach(function (u) { if (u) scan.found++; }); tick(); })
      .then(function () { return new Promise(function (res) { setTimeout(res, 200); }); }).then(worker);
  };
  return Promise.all([worker(), worker()]).then(function () {
    _mi.scan = null; miRender();
    if (root.toast) root.toast((scan.stop ? 'Stopped: ' : 'Done: ') + scan.found + ' found of ' + scan.done + ' checked');
  });
}
function catImagesScanStop() { if (_mi.scan) _mi.scan.stop = true; }
/* Find links: the ball on bowwwl, the maker's page (or a maker-site search), a web image search. */
var MAKER_SITE = { storm: 'stormbowling.com', 'roto-grip': 'rotogrip.com', '900-global': '900global.com', brunswick: 'brunswickbowling.com', dv8: 'dv8bowling.com',
  radical: 'radicalbowling.com', hammer: 'hammerbowling.com', ebonite: 'ebonite.com', track: 'trackbowling.com', columbia: 'columbia300.com', 'columbia-300': 'columbia300.com',
  motiv: 'motivbowling.com', swag: 'swagbowling.com', 'lord-field': 'lordfield.com', 'global-900': '900global.com' };
function miFindLinks(r) {
  var isCore = _mi.slot === 'core', ballName = r.ballName || r.name;
  var bw = bowwwlLinks(r.brand || '', isCore && _mi.tab === 'cat' ? (r.firstBall || '') : ballName);
  var q = (r.brand || '') + ' ' + (isCore ? (r.coreName || (_mi.tab === 'cat' ? r.name : '')) + ' core' : ballName) + ' bowling ball';
  var site = MAKER_SITE[brandSlug(r.brand)];
  var maker = r.src || (site ? 'https://www.google.com/search?q=' + encodeURIComponent('site:' + site + ' ' + (isCore ? (r.coreName || r.name) + ' core' : ballName)) : null);
  var a = function (u, t) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" style="color:var(--teal);text-decoration:none">' + t + '</a>'; };
  var coreWeb = !isCore && r.coreName ? ' \u00b7 ' + a('https://www.google.com/search?tbm=isch&q=' + encodeURIComponent((r.brand || '') + ' ' + coreBase(r.coreName) + ' core'), 'core web \u2197') : '';
  return '<div style="font-size:11px;margin-top:4px;color:var(--t3)">Find: ' + ((!isCore || _mi.tab === 'mine' || r.firstBall) ? a(bw.page, 'bowwwl \u2197') + ' \u00b7 ' : '') +
    (maker ? a(maker, 'maker \u2197') + ' \u00b7 ' : '') + a('https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(q), 'web \u2197') + coreWeb + '</div>';
}
/* Loads the maker page address (catalog Source) and, for catalog cores, a ball name, for the rows on screen. */
function miSrcLoad(rows) {
  var need = rows.filter(function (r) { return !r.srcTried; }); if (!need.length || !_mi.rows) return;
  need.forEach(function (r) { r.srcTried = true; });
  Promise.all(need.map(function (r) {
    var id = r.catId || (r.balls && r.balls[0]); var e = id ? byIdIn(_mi.rows, id) : null; if (!e) return Promise.resolve(null);
    if (r.balls && !r.firstBall) r.firstBall = cleanName(e.n);
    return catDetailRaw(e).then(function (d) { if (d && /^https:\/\//.test(d.Source || '')) r.src = d.Source; }, function () {});
  }).concat(_mi.slot === 'cover' ? need.map(miEnsureCore) : [])).then(function () { if (!_mi.scan) miRender(); });
}
/* v30.184: a Cover-mode row = the ball picture and its core picture, each with its own bowwwl / Paste / Photo,
   one Use for both. A core already kept for that core (or on your ball) shows as done. */
function rowCover(r) {
  var k = r.key, fb = _mi.found[miFk(k)], fc = _mi.found[fkFor(k, 'core')];
  var bb = _mi.busy[miFk(k)], bc = _mi.busy[fkFor(k, 'core')];
  var pill = function (t, call, on) { return '<button style="' + (on ? BTN_P : BTN_G) + 'padding:5px 9px;font-size:12px" onclick="' + call + '">' + t + '</button>'; };
  var thumb = function (url, round, busy, miss) {
    return url ? '<img src="' + esc(url) + '" referrerpolicy="no-referrer" style="width:48px;height:48px;border-radius:' + (round ? '50%' : '10px') + ';object-fit:contain;background:#fff;flex-shrink:0">' :
      '<div style="width:48px;height:48px;border-radius:' + (round ? '50%' : '10px') + ';flex-shrink:0;background:var(--bg3);display:flex;align-items:center;justify-content:center;color:var(--t3);font-size:10px">' + (busy ? '\u2026' : miss ? 'none' : round ? 'ball' : 'core') + '</div>';
  };
  var q = function (s2) { return '\'' + k + '\'' + (s2 ? ',\'' + s2 + '\'' : ''); };
  var line = function (label, part, f, have, miss, canBw) {
    var st = f ? '<span style="color:var(--teal);font-size:12px">' + esc(f.how) + '</span> ' + pill('\u2715', 'catImagesDrop(' + q(part) + ')') :
      have ? '<span style="color:var(--teal);font-size:12px">\u2713 kept' + (part === 'core' && r.coreName ? ' (' + esc(coreBase(r.coreName)) + ')' : '') + '</span>' :
      (canBw ? pill('bowwwl', 'catImagesTry(' + q(part) + ')') : '') + pill('Paste', 'catImagesPaste(' + q(part) + ')') + pill('Photo', 'catImagesPhoto(' + q(part) + ')') +
      (miss ? '<span style="color:var(--gold);font-size:11px">not on bowwwl</span>' : '');
    return '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:5px"><span style="width:34px;font-size:11px;font-weight:700;color:var(--t3)">' + label + '</span>' + st + '</div>';
  };
  var coreSub = r.coreName ? coreBase(r.coreName) + ' core' : (r.coreTried ? 'core name unknown' : '');
  return '<div style="padding:9px 0;border-bottom:1px solid var(--border1)">' +
    '<div style="display:flex;gap:8px;align-items:center">' + thumb(fb && fb.url, true, bb, r.miss) + thumb((fc && fc.url) || r.coreHave, false, bc, r.coreMiss) +
      '<div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(r.name) + '</div>' +
      '<div style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(r.brand || '') + (r.year ? ' \u00b7 ' + esc(r.year) : '') + (coreSub ? ' \u00b7 ' + esc(coreSub) : '') + '</div></div>' +
      (fb || fc ? pill('Use', 'catImagesUse(' + q() + ')', true) : '') + '</div>' +
    line('Ball', 'ball', fb, false, r.miss, true) +
    line('Core', 'core', fc, r.coreHave && !fc, r.coreMiss, !!rowCoreKey(r) || !r.coreTried) +
    (fb && (fc || r.coreHave) ? '' : miFindLinks(r)) + '</div>';
}
function miByKey(k) { var set = miSet(); if (!set) return null; var l = set.mine.concat(set.cat); for (var i = 0; i < l.length; i++) if (l[i].key === k) return l[i]; return null; }
function catImagesTab(k) { _mi.tab = k; _mi.page = 0; miRender(); }
function catImagesFilter(q) { _mi.q = q; _mi.page = 0; miRender(); var el = document.querySelector('#mi-ov input[type=search]'); if (el) { el.focus(); el.setSelectionRange(q.length, q.length); } }
function catImagesPage(d) { _mi.page += d; miRender(); var b = document.querySelector('#mi-ov > div[style*="overflow-y"]'); if (b) b.scrollTop = 0; }
function catImagesTry(k, part) {
  var r = miByKey(k), fk = fkFor(k, part); if (!r || _mi.busy[fk]) return Promise.resolve(null);
  var coreOf = _mi.slot === 'core' || part === 'core';
  var pre = part === 'core' && _mi.slot === 'cover' ? miEnsureCore(r) : Promise.resolve(r);
  return pre.then(function () {
  var c = coreOf ? (rowCoreKey(r) ? bowwwlCoreCandidates(r.brand, r.coreName || r.name) : []) : bowwwlImgCandidates(r.brand, r.name);
  if (!c.length) { if (part === 'core' && root.toast && !_mi.scan) root.toast('Core name unknown: use Paste or Photo for the core'); return null; }
  _mi.busy[fk] = true; if (!_mi.scan) miRender();
  var next = function (i) { return i >= c.length ? Promise.resolve(null) : imgProbe(c[i]).then(function (u) { return u || next(i + 1); }); };
  return next(0).then(function (u) {
    delete _mi.busy[fk];
    var mk = part === 'core' && _mi.slot === 'cover' ? 'coreMiss' : 'miss';
    if (u) { _mi.found[fk] = { url: u, how: 'bowwwl', link: true }; delete r[mk]; } else r[mk] = true;
    scanNote(fk, u || null);
    if (!_mi.scan) miRender(); return u;
  });
  });
}
function catImagesTryPage() {
  var list = miList().slice(_mi.page * MI_PAGE, _mi.page * MI_PAGE + MI_PAGE).filter(function (r) { return !_mi.found[miFk(r.key)] && !r.miss; });
  return list.reduce(function (p, r) { return p.then(function () { return catImagesTry(r.key); }); }, Promise.resolve());
}
function catImagesPaste(k, part) {
  var fk = fkFor(k, part);
  var take = function (blob, url) { if (blob) return imgShrink(blob).then(function (b) { _mi.found[fk] = { blob: b, url: URL.createObjectURL(b), how: 'pasted picture' }; miRender(); });
    if (url) return imgProbe(url).then(function (u) { if (u) { _mi.found[fk] = { url: u, how: 'pasted link', link: true }; miRender(); } else if (root.toast) root.toast('That address did not load as a picture'); }); };
  var cb = typeof navigator !== 'undefined' && navigator.clipboard;
  if (cb && cb.read) return cb.read().then(function (items) {
    for (var i = 0; i < items.length; i++) { var t = items[i].types.filter(function (x) { return /^image\//.test(x); })[0]; if (t) return items[i].getType(t).then(function (b) { return take(b); }); }
    for (var j = 0; j < items.length; j++) if (items[j].types.indexOf('text/plain') >= 0) return items[j].getType('text/plain').then(function (b) { return b.text(); }).then(function (s) { var m = /https?:\/\/\S+/.exec(s); return m ? take(null, m[0]) : (root.toast && root.toast('Copy the picture first (long-press it in Safari, Copy)')); });
    if (root.toast) root.toast('Copy the picture first (long-press it in Safari, Copy)');
  }, function () { if (root.toast) root.toast('Allow paste, or use Photo instead'); });
  if (cb && cb.readText) return cb.readText().then(function (s) { var m = /https?:\/\/\S+/.exec(s || ''); return m ? take(null, m[0]) : (root.toast && root.toast('Copy the picture\u2019s address first')); });
  if (root.toast) root.toast('Paste is not available here; use Photo');
  return Promise.resolve();
}
function catImagesPhoto(k, part) {
  var fk = fkFor(k, part);
  var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
  inp.addEventListener('change', function () {
    var f = inp.files && inp.files[0]; if (inp.parentNode) inp.parentNode.removeChild(inp); if (!f) return;
    imgShrink(f).then(function (b) { _mi.found[fk] = { blob: b, url: URL.createObjectURL(b), how: 'photo' }; miRender(); });
  });
  document.body.appendChild(inp); inp.click();
}
function catImagesDrop(k, part) {
  var parts = part ? [part] : ['ball', 'core'];
  parts.forEach(function (p) { var fk = fkFor(k, p); delete _mi.found[fk]; scanNote(fk, undefined); });
  miRender();
}
/* Puts a picture on one of your balls (cover or core slot) unless it already has one there (or force). */
function miOwnSet(b, slot, f, force) {
  if (!force && ownPic(b, slot)) return Promise.resolve();
  if (f.blob && typeof root.idbSaveBallImages === 'function') {
    return Promise.resolve(typeof root.idbGetBallImages === 'function' ? root.idbGetBallImages(b.BallID) : null).then(function (rec) {
      rec = rec ? Object.assign({}, rec) : { BallID: Number(b.BallID), coverBlob: null, coreBlob: null };
      rec[slot === 'cover' ? 'coverBlob' : 'coreBlob'] = f.blob;
      return root.idbSaveBallImages(rec).then(function () { if (typeof root._ballImgCacheSet === 'function') root._ballImgCacheSet(Number(b.BallID), slot, f.blob); });
    });
  }
  if (!f.blob && !/^blob:/.test(f.url)) { if (slot === 'cover') b.ImagePath = f.url; else b.CoreImagePath = f.url; }
  return Promise.resolve();
}
/* Stores one found picture. */
function miStore(r, f, slot) {
  var jobs = [], balls = appBalls();
  if ((slot || _mi.slot) === 'cover') {
    if (r.catId) jobs.push(f.blob ? catImgPut(r.catId, f.blob).then(function () { imgPickSet(r.catId, null); }) : Promise.resolve(imgPickSet(r.catId, f.url)));
    balls.filter(function (b) { return r.ballId != null ? b.BallID == r.ballId : (r.catId && b.CatalogID === r.catId); })
      .forEach(function (b) { jobs.push(miOwnSet(b, 'cover', f, r.ballId != null)); });
  } else {
    if (r.coreKey) jobs.push(f.blob ? catImgPut('core:' + r.coreKey, f.blob).then(function () { coreLinkSet(r.coreKey, null); }) : Promise.resolve(coreLinkSet(r.coreKey, f.url)));
    if (r.coreKey && !_mi.bulk && r.brand && r.coreName && !/^id-/.test(r.coreKey)) setTimeout(function () { catCoreShareOffer(r.brand, r.coreName, f); }, 300);   // v30.210
    /* the ball listed, and every ball of yours with this core that has no core picture */
    balls.forEach(function (b) {
      var mine = r.ballId != null && b.BallID == r.ballId;
      var same = r.coreKey && b.CoreShort && coreKeyOf(b.MFG, b.CoreShort) === r.coreKey;
      var linked = r.balls && b.CatalogID && r.balls.indexOf(b.CatalogID) >= 0;
      if (mine || same || linked) jobs.push(miOwnSet(b, 'core', f, mine));
    });
  }
  imgPersist();
  return Promise.all(jobs).then(function () { if (!_mi.bulk && root.saveDB) root.saveDB(); });
}
function miAfterStore(keys) {
  var set = miSet();
  keys.forEach(function (k) { delete _mi.found[miFk(k)]; scanNote(miFk(k), undefined); });
  if (_mi.slot === 'core') {
    var done = {}; keys.forEach(function (k) { var r = miByKey(k); if (r && r.coreKey) done[r.coreKey] = 1; });
    set.mine = set.mine.filter(function (r) { return keys.indexOf(r.key) < 0 && !(r.coreKey && done[r.coreKey]); });
    set.cat = set.cat.filter(function (r) { return keys.indexOf(r.key) < 0 && !done[r.coreKey]; });
  } else {
    set.mine = set.mine.filter(function (r) { return keys.indexOf(r.key) < 0; });
    set.cat = set.cat.filter(function (r) { return keys.indexOf(r.key) < 0 && !(r.catId && catImageFor(r.catId)); });
  }
  miRender();
}
/* Stores what a row has found: in Cover mode the ball and/or its core. Resolves true when the row's main picture was stored. */
function miUseRow(k) {
  var r = miByKey(k); if (!r) return Promise.resolve(false);
  var fb = _mi.found[miFk(k)], fc = _mi.slot === 'cover' ? _mi.found[fkFor(k, 'core')] : null;
  /* one after the other: both write the same picture record of your ball */
  var first = fb ? miStore(r, fb, _mi.slot) : Promise.resolve(), jobs = [first];
  if (fc) jobs.push(first.then(function () { return miStore(coreRowOf(r), fc, 'core'); }).then(function () {
    r.coreHave = fc.url; delete _mi.found[fkFor(k, 'core')]; scanNote(fkFor(k, 'core'), undefined);
    /* every other row with the same core now has it too */
    var ck = rowCoreKey(r), set = miSet();
    if (ck && set) set.mine.concat(set.cat).forEach(function (x) { if (x !== r && rowCoreKey(x) === ck && !_mi.found[fkFor(x.key, 'core')]) x.coreHave = fc.url; });
  }));
  return Promise.all(jobs).then(function () { return !!fb; });
}
function catImagesUse(k) {
  return miUseRow(k).then(function (main) {
    if (main) miAfterStore([k]); else miRender();
    if (root.toast) root.toast('Saved on this device');
  }, function () { if (root.toast) root.toast('Could not save that picture'); });
}
function catImagesUseAll() {
  var rows = miList().filter(function (r) { return _mi.found[miFk(r.key)] || (_mi.slot === 'cover' && _mi.found[fkFor(r.key, 'core')]); });
  var done = [], n = 0;
  _mi.bulk = true;
  return rows.reduce(function (p, r) { return p.then(function () {
    n += (_mi.found[miFk(r.key)] ? 1 : 0) + (_mi.slot === 'cover' && _mi.found[fkFor(r.key, 'core')] ? 1 : 0);
    return miUseRow(r.key).then(function (main) { if (main) done.push(r.key); }); }); }, Promise.resolve())
    .then(function () { _mi.bulk = false; if (root.saveDB) root.saveDB(); miAfterStore(done); if (root.toast) root.toast(n + ' picture' + (n === 1 ? '' : 's') + ' saved on this device'); });
}
/* Save / Restore: every stored catalog and core picture (files and links) in one file you keep. */
function blobToData(b) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { res(null); }; r.readAsDataURL(b); }); }
function dataToBlob(d) { var m = /^data:([^;]+);base64,(.*)$/.exec(d || ''); if (!m) return null; var bin = atob(m[2]), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: m[1] }); }
function catImagesExport() {
  return catImgAll().catch(function () { return []; }).then(function (all) {
    return all.reduce(function (p, x) { return p.then(function (acc) { return x.value && x.value.blob ? blobToData(x.value.blob).then(function (d) { if (d) acc[x.key] = d; return acc; }) : acc; }); }, Promise.resolve({}));
  }).then(function (files) {
    var out = { kind: 'bowlingdb-pictures', v: 1, at: new Date().toISOString(), covers: imgPicks(), cores: coreLinks(), files: files };
    var blob = new Blob([JSON.stringify(out)], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'BowlingDB_pictures_' + out.at.slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.parentNode.removeChild(a);
    if (root.toast) root.toast(Object.keys(files).length + ' files and ' + (Object.keys(out.covers).length + Object.keys(out.cores).length) + ' links saved');
    return out;
  });
}
/* Pure-ish: merges a pictures file; never removes or replaces what is already here. */
function catImagesMerge(o) {
  if (!o || o.kind !== 'bowlingdb-pictures') return Promise.reject(new Error('Not a BowlingDB pictures file'));
  var n = 0, pk = imgPicks(), cl = coreLinks();
  Object.keys(o.covers || {}).forEach(function (k) { if (!pk[k] && !_catImgObj[k]) { imgPickSet(k, o.covers[k]); n++; } });
  Object.keys(o.cores || {}).forEach(function (k) { if (!cl[k] && !_catImgObj['core:' + k]) { coreLinkSet(k, o.cores[k]); n++; } });
  return Object.keys(o.files || {}).reduce(function (p, k) {
    return p.then(function () { if (_catImgObj[k]) return; var b = dataToBlob(o.files[k]); if (b) { n++; return catImgPut(k, b); } });
  }, Promise.resolve()).then(function () { return n; });
}
function catImagesImport() {
  var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json'; inp.style.display = 'none';
  inp.addEventListener('change', function () {
    var f = inp.files && inp.files[0]; if (inp.parentNode) inp.parentNode.removeChild(inp); if (!f) return;
    f.text().then(function (t) { return catImagesMerge(JSON.parse(t)); }).then(function (n) {
      if (root.toast) root.toast(n + ' picture' + (n === 1 ? '' : 's') + ' restored');
      if (_mi.rows) { _mi.all = miCoverRows(_mi.rows); _mi.coreAll = null; if (_mi.slot === 'core') catImagesSlot('core'); else miRender(); }
    }, function (e) { if (root.toast) root.toast(e.message || 'Could not read that file'); });
  });
  document.body.appendChild(inp); inp.click();
}

/* ---------- v30.200 CB-1: Catalog backup, kept on this device (LOCKED 2026-10-17) ----------
   One file, BowlingDB_catalog_<date>.json, saved with the share sheet (Save to Files, iCloud
   Drive). Nothing goes to GitHub (James: picture links stay off the public repo). It holds:
   picture links (bdbimg_pick, bdbimg_core) and picture files (bdb_catimg), the bowwwl check
   memory (bdbimg_scan), the manufacturer image links (bdbimg_links), this phone's spec
   corrections and status list, and, with the token, a copy of the repo's corrections/
   overrides.json and status.json. Restore merges: nothing already on the phone is replaced or
   removed; the repo copies are kept in the file for recovery and never written back from here.
   Making the file is two taps: iOS only opens the share sheet straight from a tap, so the file
   is built first, then "Save the file" shares it. "Restore from a file" also takes the older
   BowlingDB_pictures files. */
var CB_AT_KEY = 'bowlingdb_catalog_backup_at', CB_REMIND_DAYS = 30, _cb = null;
function cbLSGet(k, d) { var l = apLS(); try { var v = l && l.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function catBackupStatus() {
  var l = apLS(), at = l ? l.getItem(CB_AT_KEY) : null, days = at ? Math.floor((env.now() - new Date(at).getTime()) / 864e5) : null;
  return { at: at, days: days, due: days == null || days >= CB_REMIND_DAYS };
}
/* builds the backup object (reads picture files and, with the token, the repo copies) */
function catBackupBuild() {
  var repo = Promise.resolve(null);
  if (apToken() && !(root.navigator && root.navigator.onLine === false)) {
    repo = Promise.all([apReadOverrides(true), stReadRepo(), apGH(RL_PATH + '?ref=specs').then(function (f) { return JSON.parse(b64d(f.content) || '{}') || {}; }, function (e) { return e.status === 404 ? {} : null; })])
      .then(function (r) { return { overrides: r[0] || {}, status: (r[1] && r[1].map) || {}, released: r[2] || {}, at: new Date(env.now()).toISOString() }; },
      function (e) { return { error: (e && e.message) || 'could not read the repo' }; });
  }
  var files = catImgAll().catch(function () { return []; }).then(function (all) {
    return all.reduce(function (p, x) { return p.then(function (acc) { return x.value && x.value.blob ? blobToData(x.value.blob).then(function (d) { if (d) acc[x.key] = d; return acc; }) : acc; }); }, Promise.resolve({}));
  });
  return Promise.all([files, repo]).then(function (r) {
    var st = stLocal(), rp = r[1];
    return { kind: 'bowlingdb-catalog-backup', v: 1, at: new Date(env.now()).toISOString(), app: (typeof APP_VERSION !== 'undefined' ? APP_VERSION : null), catalogJs: CAT_VERSION,
      covers: imgPicks(), cores: coreLinks(), files: r[0], scan: cbLSGet(SCAN_KEY, {}), makerLinks: cbLSGet(IMG_LINKS_KEY, null),
      deviceCorrections: localOverrides(), status: { all: st.all, pending: st.pending, cleared: st.cleared }, released: rlLocal().all, regions: regionTags(), triage: triageGet(),
      repo: rp && !rp.error ? rp : null, repoNote: !apToken() ? 'no token on this phone' : rp && rp.error ? rp.error : null };
  });
}
/* Pure: counts for the summary line */
function cbCounts(o) {
  var n = function (x) { return Object.keys(x || {}).length; };
  return { files: n(o.files), links: n(o.covers) + n(o.cores), corrections: n(o.deviceCorrections) + (o.repo ? n(o.repo.overrides) : 0),
    status: n(o.status && o.status.all) + (o.repo ? n(o.repo.status) : 0), repo: !!o.repo };
}
function cbHTML() {
  var b = catBackupStatus(), st = _cb && _cb.state, c = _cb && _cb.obj ? cbCounts(_cb.obj) : null;
  var when = b.at ? new Date(b.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' (' + (b.days === 0 ? 'today' : b.days + ' day' + (b.days === 1 ? '' : 's') + ' ago') + ')' : 'never';
  var mb = _cb && _cb.size ? (_cb.size / 1048576).toFixed(1) + ' MB' : '';
  return '<div class="modal-title">Catalog backup</div>' +
    '<div style="font-size:13px;color:var(--t2);line-height:1.55;margin-bottom:10px">One file with your ball and core pictures (links and picture files), your spec corrections, your rejected, discontinued and released balls, and a copy of the repo\u2019s corrections. It stays on your device: choose <b>Save to Files</b> and pick iCloud Drive. Nothing is sent to GitHub.</div>' +
    '<div style="font-size:13px;color:' + (b.due ? 'var(--gold)' : 'var(--t2)') + ';margin-bottom:12px">Last backup: ' + when + (b.due ? ' \u00b7 due' : '') + '</div>' +
    (st === 'building' ? '<div style="font-size:13px;color:var(--t2);padding:10px 0">Gathering pictures and corrections\u2026</div>' :
     st === 'ready' ? '<div style="font-size:13px;color:var(--t1);line-height:1.5;margin-bottom:8px">Ready: ' + c.files + ' picture file' + (c.files === 1 ? '' : 's') + ', ' + c.links + ' link' + (c.links === 1 ? '' : 's') + ', ' + c.corrections + ' correction' + (c.corrections === 1 ? '' : 's') + ', ' + c.status + ' status entr' + (c.status === 1 ? 'y' : 'ies') + (mb ? ' \u00b7 ' + mb : '') + '</div>' +
       (c.repo ? '' : '<div style="font-size:12px;color:var(--gold);margin-bottom:8px">Repo copies not included (' + esc(_cb.obj.repoNote || 'offline') + '). Your phone\u2019s copies are in the file.</div>') +
       '<button class="btn btn-primary" style="width:100%" onclick="catBackupShare()">Save the file</button>' :
     '<button class="btn btn-primary" style="width:100%" onclick="catBackupMake()">Make backup</button>') +
    '<button class="btn btn-ghost" style="width:100%;margin-top:8px" onclick="catBackupRestore()">Restore from a file</button>' +
    '<div style="font-size:11px;color:var(--t3);line-height:1.5;margin-top:8px">Restore adds what this phone is missing and never replaces or removes anything. It also reads older picture files (BowlingDB_pictures).</div>' +
    '<button class="btn btn-secondary" style="width:100%;margin-top:10px" onclick="closeModal()">Close</button>';
}
function cbShow() { var html = cbHTML(), bg = document.getElementById('modal-bg'); if (bg && bg.classList.contains('open') && root.swapModal) root.swapModal(html); else if (root.openModal) root.openModal(html); }
function catBackupOpen() { _cb = null; cbShow(); }
function catBackupMake() {
  _cb = { state: 'building' }; cbShow();
  return catBackupBuild().then(function (o) {
    var text = JSON.stringify(o); _cb = { state: 'ready', obj: o, text: text, size: text.length, name: 'BowlingDB_catalog_' + o.at.slice(0, 10) + '.json' }; cbShow(); return o;
  }, function (e) { _cb = null; cbShow(); if (root.toast) root.toast('Backup failed: ' + ((e && e.message) || e)); });
}
function cbDone() {
  var l = apLS(); if (l) try { l.setItem(CB_AT_KEY, _cb.obj.at); } catch (e) {}
  var c = cbCounts(_cb.obj); _cb = null; cbShow();
  if (root.toast) root.toast('Catalog backup saved: ' + c.files + ' files, ' + c.links + ' links');
}
/* runs straight from the tap so iOS opens the share sheet */
function catBackupShare() {
  if (!_cb || !_cb.text) return;
  var blob = new Blob([_cb.text], { type: 'application/json' }), file = typeof File === 'function' ? new File([blob], _cb.name, { type: 'application/json' }) : null;
  var nav = root.navigator;
  if (file && nav && nav.canShare && nav.canShare({ files: [file] })) {
    nav.share({ files: [file], title: _cb.name }).then(cbDone, function (e) { if (e && e.name === 'AbortError') return; cbDownload(blob); });
    return;
  }
  cbDownload(blob);
}
function cbDownload(blob) {
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = _cb.name; document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
  cbDone();
}
/* Merges a catalog backup (or an older pictures file). Never replaces or removes what is here. */
function catBackupMerge(o) {
  if (o && o.kind === 'bowlingdb-pictures') return catImagesMerge(o).then(function (n) { return { pictures: n, corrections: 0, status: 0, scan: 0 }; });
  if (!o || o.kind !== 'bowlingdb-catalog-backup') return Promise.reject(new Error('Not a BowlingDB catalog backup'));
  var l = apLS(), out = { pictures: 0, corrections: 0, status: 0, scan: 0 };
  return catImagesMerge({ kind: 'bowlingdb-pictures', covers: o.covers, cores: o.cores, files: o.files }).then(function (n) {
    out.pictures = n;
    if (!l) return out;
    var sc = cbLSGet(SCAN_KEY, {}); Object.keys(o.scan || {}).forEach(function (k) { if (!(k in sc)) { sc[k] = o.scan[k]; out.scan++; } });
    if (out.scan) l.setItem(SCAN_KEY, JSON.stringify(sc));
    if (o.makerLinks && !l.getItem(IMG_LINKS_KEY)) l.setItem(IMG_LINKS_KEY, JSON.stringify(o.makerLinks));
    var dc = localOverrides(); Object.keys(o.deviceCorrections || {}).forEach(function (id) { if (!dc[id]) { dc[id] = o.deviceCorrections[id]; out.corrections++; } });
    if (out.corrections) l.setItem(LOCAL_OVR_KEY, JSON.stringify(dc));
    var st = stLocal(), sa = (o.status && o.status.all) || {};
    Object.keys(sa).forEach(function (id) { if (!st.all[id] && !st.cleared[id]) { st.all[id] = sa[id]; out.status++; } });
    if (out.status) stSaveLocal(st);
    var rl = rlLocal(); Object.keys(o.released || {}).forEach(function (id) { if (!rl.all[id]) { rl.all[id] = o.released[id]; out.status++; } });
    rlSaveLocal(rl);
    var rg = regionTags(), rgn = 0; Object.keys(o.regions || {}).forEach(function (id) { if (!(id in rg)) { rg[id] = o.regions[id]; rgn++; } });   // v30.206
    if (rgn) { _rgC = null; l.setItem(REGION_KEY, JSON.stringify(rg)); }
    if (o.triage) { var tg = triageGet(); Object.keys(o.triage.current || {}).forEach(function (id) { tg.current[id] = 1; });
      Object.keys(o.triage.brandRegion || {}).forEach(function (b) { if (!(b in tg.brandRegion)) tg.brandRegion[b] = o.triage.brandRegion[b]; }); triageSave(tg); }
    return out;
  });
}
function catBackupRestore() {
  var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json'; inp.style.display = 'none';
  inp.addEventListener('change', function () {
    var f = inp.files && inp.files[0]; if (inp.parentNode) inp.parentNode.removeChild(inp); if (!f) return;
    f.text().then(function (t) { return catBackupMerge(JSON.parse(t)); }).then(function (r) {
      if (root.toast) root.toast('Restored ' + r.pictures + ' picture' + (r.pictures === 1 ? '' : 's') + ', ' + r.corrections + ' correction' + (r.corrections === 1 ? '' : 's') + ', ' + r.status + ' status entr' + (r.status === 1 ? 'y' : 'ies'));
      if (_mi.rows) { _mi.all = miCoverRows(_mi.rows); _mi.coreAll = null; if (_mi.slot === 'core') catImagesSlot('core'); else miRender(); }
    }, function (e) { if (root.toast) root.toast(e.message || 'Could not read that file'); });
  });
  document.body.appendChild(inp); inp.click();
}

/* ---------- v30.174: bowwwl first in "Correct specs" ----------
   The maker page the bridge matched is sometimes a sibling in the lineage
   (e.g. "Jackal" read for Jackal Fury). bowwwl lists each ball on its own
   page. The app still never fetches bowwwl (permission pending): you open
   it in Safari, copy the specs, and paste here. The paste opens in the same
   Page view (select text or tap a number, then a field). A value used from
   a paste sets the correction's source to bowwwl, so it stays on this device. */
function foldName(t) { return String(t || '').toLowerCase().replace(/^\*+\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
/* Pure: the page title names a different ball than the USBC entry (null = fine or unknown). */
function pageMismatch(title, name) {
  var a = foldName(title), b = foldName(name);
  if (!a || !b || a === b) return null;
  return { page: String(title).trim(), ball: String(name).trim() };
}
/* Pure: pasted text -> snapshot lines ("Label<TAB>Value" -> "Label | Value"). */
function pasteLines(t) {
  var seen = {}, out = [];
  String(t || '').split(/\r?\n/).forEach(function (l) {
    var x = l.replace(/\t+/g, ' | ').replace(/\s+/g, ' ').trim();
    if (!x || x.length > 200 || seen[x.toLowerCase()] || x === 'BDB-PDF') return;
    seen[x.toLowerCase()] = 1; out.push(x);
  });
  return out.slice(0, 400);
}
function catPasteOpen() {
  var ov = overlay('pst-ov', 925);
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catPasteClose()">\u2039</button>' +
    '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Paste from bowwwl</div>' +
    '<div style="font-size:11px;color:var(--t3)">In Safari: select the specs on the ball\u2019s page, Copy, then paste below.</div></div></div>' +
    '<div style="flex:1;overflow-y:auto;padding:0 16px 16px">' +
    '<textarea id="pst-txt" class="bdet-field-input" rows="12" placeholder="Long-press here and tap Paste" style="width:100%;box-sizing:border-box;font-size:14px;line-height:1.45"></textarea>' +
    (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText ? '<button style="' + BTN_G + 'width:100%;padding:10px;margin-top:8px" onclick="catPasteClip()">Paste from clipboard</button>' : '') + '</div>' +
    '<div style="padding:10px 16px;border-top:1px solid var(--border1)"><button style="' + BTN_P + 'width:100%;padding:11px" onclick="catPasteShow()">Show and tag \u203a</button></div>';
  document.body.appendChild(ov);
}
function catPasteClip() {
  navigator.clipboard.readText().then(function (t) { var el = document.getElementById('pst-txt'); if (el) el.value = t; }, function () { if (root.toast) root.toast('Long-press the box and tap Paste instead'); });
}
function catPasteClose() { var el = document.getElementById('pst-ov'); if (el) el.parentNode.removeChild(el); }
function catPasteShow() {
  var el = document.getElementById('pst-txt'), lines = pasteLines(el && el.value);
  if (!lines.length) { if (root.toast) root.toast('Nothing pasted yet'); return; }
  catPasteClose();
  pgvOpenSnap({ title: 'Pasted from bowwwl', url: null, lines: lines, images: [], src: 'bowwwl' });
}
function catPageOpen() {
  if (!_apEdit || !_apEdit.page) return;
  pgvShell();
  apReadPage(_apEdit.page).then(function (snap) { _pgSnap = snap; pgvRender(); }, function (e) {
    var b = document.getElementById('pgv-body'); if (b) b.innerHTML = '<div style="padding:30px 0;text-align:center;color:var(--red);font-size:13px;line-height:1.5">' + esc(e.message || String(e)) + '</div>';
    var s = document.getElementById('pgv-sub'); if (s) s.textContent = '';
  });
}
function pgvOpenSnap(snap) { pgvShell(); _pgSnap = snap; pgvRender(); }
function pgvShell() {
  var ov = overlay('pgv-ov', 925);
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catPageClose()">\u2039</button>' +
    '<div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800;color:var(--t1)">Page</div><div id="pgv-sub" style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Loading\u2026</div></div></div>' +
    '<div id="pgv-body" style="flex:1;overflow-y:auto;padding:0 16px 16px"></div>' +
    '<div id="pgv-bar" style="display:none;padding:10px 16px;border-top:1px solid var(--border1);gap:8px;align-items:center"></div>';
  document.body.appendChild(ov);
  _pgSel = '';
}
function pgvRender() {
  var snap = _pgSnap, b = document.getElementById('pgv-body'); if (!b || !snap) return;
  var sub = document.getElementById('pgv-sub');
  var mm = snap.src !== 'bowwwl' && _apEdit ? pageMismatch(snap.title, _apEdit.ballName) : null;
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
  b.innerHTML = (mm ? '<div style="font-size:12px;color:var(--gold);line-height:1.5;margin:2px 0 10px">This page is for \u201c' + esc(mm.page) + '\u201d, not \u201c' + esc(mm.ball) + '\u201d. It may be a sibling ball; check bowwwl.</div>' : '') +
    (imgs ? '<div style="font-size:11px;font-weight:700;color:var(--t3);margin:4px 0 6px;text-transform:uppercase;letter-spacing:.5px">Images \u00b7 tap to use on this device</div>' +
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
  var src = _pgSnap && _pgSnap.src;
  catPageClose();
  _tag.val = t; _tag.key = null; _tag.src = src || null; tagPaint();
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
    m = /^([A-Za-z]+)\.?\s+(?:\d{1,2},?\s+)?(\d{4})$/.exec(s);
    var mn = m && (MONTH_N[m[1].toLowerCase()] || MONTH_N[Object.keys(MONTH_N).filter(function (k) { return m[1].length >= 3 && k.indexOf(m[1].toLowerCase()) === 0; })[0]]);
    if (mn) return { v: m[2] + '-' + ('0' + mn).slice(-2) };
    m = /^(\d{4})$/.exec(s); if (m) return { v: m[1] };
    return { err: 'Release date needs a date, e.g. October 2022' };
  }
  if (/^ape-(coverName|coverType|finish|core|note)$/.test(fieldId)) return { v: s.replace(/[\u2122\u00ae]/g, '').trim() };
  return { err: 'That field does not take tapped values' };
}
function tagPanelHTML(raw, page) {
  _tag = { lines: tagLines(raw), val: null, key: null, row: null };
  var bar = '<div id="ape-tagbar" style="display:none;position:sticky;top:0;z-index:2;margin-top:6px;padding:8px 10px;border-radius:10px;background:var(--bg2);border:1px solid var(--teal);font-size:12px;color:var(--t1)"></div>';
  var pageBtn = page ? '<button style="' + BTN_G + 'width:100%;padding:10px;margin-top:6px" onclick="catPageOpen()">Maker page: select text or pick an image \u203a</button>' : '';
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
  /* a value taken from a bowwwl paste: the correction's source becomes bowwwl (kept on this device) */
  if (_tag.src === 'bowwwl') { var so = document.getElementById('ape-source'); if (so && so.value !== 'bowwwl') { so.value = 'bowwwl'; if (root.toast) root.toast('Source set to bowwwl: this correction stays on this device'); } }
  _tag.val = null; _tag.key = null; _tag.src = null; tagPaint();
}
function catApprovalsEdit(i) {
  var p = _ap.pages[_ap.idx]; if (!p) return;
  var b = p.boxes[i];
  apEditOpen({ catalogId: p.catalogId, i: i, title: b.title, entry: _ap._rows ? byIdIn(_ap._rows, p.catalogId) : null,
    base0: _staged ? apStagedFor(_staged, b, p.catalogId) : null, origin: 'ap' });
}
/* v30.185 FIX-1: the correction sheet for any catalog ball. ctx: {catalogId, title, entry (index row),
   base0 (what the values are compared against: the staged row, or the published entry), origin 'ap' | 'sheet'}. */
function apEditOpen(ctx) {
  var r = apApplyOverride(ctx.base0, overrideFor(ctx.catalogId));
  var sp = (r && r.specs) || {};
  var _ee = ctx.entry, _bn = _ee ? cleanName(_ee.n) : ctx.title;
  _apEdit = { brand: _ee ? _ee.m : (r && r.brand) || '', catalogId: ctx.catalogId, i: ctx.i, page: (r && r.page) || null, ballName: _bn, url: (r && r.url) || null, base0: ctx.base0 || null, origin: ctx.origin || 'ap', after: ctx.after || null };
  var _bw = bowwwlLinks(_ee ? _ee.m : (r && r.brand) || '', _bn), _mm = (r && r.title) ? pageMismatch(r.title, _bn) : null;
  var inp = function (id, v, ph) { return '<div class="ape-f"><input id="' + id + '" class="bdet-field-input" value="' + esc(v == null ? '' : v) + '" placeholder="' + esc(ph || '') + '" style="width:100%;box-sizing:border-box;font-size:15px"></div>'; };
  /* v30.173 CAT-NEW-7: type, or pick a value already in use */
  var inpP = function (id, v, ph) { return '<div style="display:flex;gap:6px;align-items:stretch"><div class="ape-f" style="flex:1">' + inp(id, v, ph).replace(/^<div class="ape-f">|<\/div>$/g, '') + '</div>' +
    '<button style="' + BTN_G + 'padding:0 12px;font-size:13px" onclick="catPickOpen(\'' + id + '\')" aria-label="Pick">\u25be</button></div>'; };
  var lab = function (t, k) { var sc = k ? apFieldSource(ctx.catalogId, ctx.base0, ctx.baseKind || (ctx.origin === 'ap' ? 'bridge' : 'published'), k) : '';
    return '<div style="display:flex;align-items:baseline;gap:8px;margin:10px 0 4px"><div style="font-size:11px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.5px">' + t + '</div>' +
      (sc ? '<div style="font-size:11px;color:var(--t3)">' + esc(sc) + '</div>' : '') + '</div>'; };
  var ws = AP_WEIGHTS;
  var wrow = function (w) { var x = (sp.weights || {})[w] || {};
    var c = function (k) { return '<input id="ape-' + w + '-' + k + '" inputmode="decimal" class="bdet-field-input" value="' + esc(x[k] == null ? '' : x[k]) + '" style="width:100%;box-sizing:border-box;font-size:14px;padding:6px">'; };
    var wsrc = apFieldSource(ctx.catalogId, ctx.base0, ctx.baseKind || (ctx.origin === 'ap' ? 'bridge' : 'published'), 'w', w);
    return '<tr data-w="' + w + '"><td style="color:var(--t2);font-size:13px;padding:3px 4px 3px 0;white-space:nowrap">' + w + ' lb' + (wsrc ? '<div style="font-size:10px;color:var(--t3)">' + esc(wsrc) + '</div>' : '') + '</td><td class="ape-f" style="padding:3px">' + c('RG') + '</td><td class="ape-f" style="padding:3px">' + c('Diff') + '</td><td class="ape-f" style="padding:3px">' + c('IntDiff') + '</td></tr>'; };
  var ov = overlay('ap-edit-ov', 920);
  ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px 8px"><button style="' + BACK + '" onclick="catApprovalsEditClose()">‹</button>' +
    '<div style="flex:1"><div style="font-size:17px;font-weight:800;color:var(--t1)">Correct specs</div><div style="font-size:11px;color:var(--t3)">' + esc(ctx.title) + ' · USBC ' + esc(ctx.catalogId) + '</div></div></div>' +
    '<div data-lk-body style="flex:1;overflow-y:auto;padding:0 16px 16px;min-height:0">' +
    '<div style="font-size:12px;color:var(--t2);line-height:1.5">Change or fill any field. Values shown are what the bridge read; edit them in place.</div>' +
    '<div style="font-size:11px;font-weight:700;color:var(--t3);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.5px">Look it up on bowwwl</div>' +
    spButtonsHTML(_bw, 'catSpAp()') +
    '<div style="font-size:11px;color:var(--t3);margin-top:4px;line-height:1.45">Values filled from a paste make this a bowwwl correction (kept on this device). <span onclick="catPasteOpen()" style="color:var(--teal);cursor:pointer">Pick by hand instead</span></div>' +
    (_mm ? '<div style="font-size:12px;color:var(--gold);line-height:1.5;margin-top:10px">The maker page read was \u201c' + esc(_mm.page) + '\u201d, not \u201c' + esc(_mm.ball) + '\u201d: it may be a sibling ball, so its values may be wrong.</div>' : '') +
    tagPanelHTML(r && r.rawText, r && r.page) +
    lab('Coverstock', 'coverName') + inpP('ape-coverName', sp.coverName, 'e.g. R2S Pearl Reactive') +
    lab('Cover type', 'coverType') + inpP('ape-coverType', sp.coverType, 'e.g. Solid Reactive') +
    lab('Factory finish', 'finish') + inpP('ape-finish', sp.finish, 'e.g. 2000 Abralon') +
    lab('Core', 'core') + inpP('ape-core', sp.core) +
    lab('Core type', 'coreType') + '<div class="ape-f"><select id="ape-coreType" class="bdet-field-input" style="width:100%;font-size:15px"><option value=""' + (!sp.coreType ? ' selected' : '') + '>—</option><option' + (/^sym/i.test(sp.coreType || '') ? ' selected' : '') + '>Symmetrical</option><option' + (/asym/i.test(sp.coreType || '') ? ' selected' : '') + '>Asymmetrical</option></select></div>' +
    lab('Release date', 'released') + inp('ape-released', sp.released ? String(sp.released).slice(0, 10) : '', 'YYYY-MM-DD') +
    lab('RG / Diff / Int Diff by weight') +
    '<table style="width:100%;border-collapse:collapse"><tr style="font-size:11px;color:var(--t3)"><td></td><td>RG</td><td>Diff</td><td>Int</td></tr>' + ws.map(wrow).join('') + '</table>' +
    '<button style="' + BTN_G + 'width:100%;padding:10px;font-size:13px;margin-top:6px" onclick="catPasteWeights()">Paste weights</button>' +
    '<div style="font-size:11px;color:var(--t3);margin-top:4px;line-height:1.45">Copy a weight table (from a page, or from a picture: open it, long-press the text, Copy), then tap Paste weights. You see what it read before anything fills in.</div>' +
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
function apEditDone(msg) {
  var origin = _apEdit && _apEdit.origin, after = _apEdit && _apEdit.after, rid = _apEdit && _apEdit.catalogId;
  catApprovalsEditClose();
  if (rid) catRecordChanged(rid);
  if (origin === 'sheet') { fixAfterEdit(); } else if (origin === 'list') { if (after) try { after(); } catch (e) {} } else apRender();
  if (msg && root.toast) root.toast(msg);
}
function catApprovalsEditClose() { var el = document.getElementById('ap-edit-ov'); if (el) el.parentNode.removeChild(el); _apEdit = null; }
var AP_WEIGHTS = [16, 15, 14, 13, 12, 11, 10];   // v30.203 WB-2: every weight the card shows
/* v30.203 WB-2 Pure-ish: where a field's value comes from, for the editor's labels. A correction on this
   phone wins over one in the repo, which wins over the base (published, or what the bridge read). */
function apFieldSource(id, base0, baseKind, k, w) {
  var loc = localOverrides()[id] || null, rep = (_ovr && _ovr[id]) || null;
  var has = function (o) { if (!o) return false; if (k === 'w') { var x = (o.weights || {})[w]; return !!x && Object.keys(x).some(function (q) { return x[q] != null && x[q] !== ''; }); } return o[k] != null && o[k] !== ''; };
  var who = function (o) { return o.source === 'bowwwl' ? 'bowwwl' : o.source === 'maker' ? 'maker' : 'you'; };
  if (has(loc)) return who(loc) + ' \u00b7 this phone';
  if (has(rep)) return who(rep) + ' \u00b7 repo';
  var sp = (base0 && base0.specs) || {};
  if (has(sp)) return baseKind === 'bridge' ? 'read by the bridge' : 'published';
  return '';
}
/* v30.203 WB-2 Pure: weights from any pasted table: labelled rows, column tables (the spec parser), and
   bare rows from Live Text ("16 lb 2.510 0.048 0.015", or a weight row over RG / Diff / Int rows) */
function parseWeightsText(text) {
  var p = { weights: {} }, lines = String(text || '').replace(/\r/g, '').split('\n').map(function (l) { return l.replace(/\t/g, ' ').trim(); }).filter(Boolean);
  var put = function (w, k, v) { var lim = { RG: [2.30, 2.90], Diff: [0, DIFF_MAX], IntDiff: [0, 0.040] }[k]; if (!(v >= lim[0] && v <= lim[1])) return;
    var sl = p.weights[w] = p.weights[w] || {}; if (sl[k] == null) sl[k] = v; };
  var num = function (t) { return Number(t.charAt(0) === '.' ? '0' + t : t); };
  var classify = function (ns, w) {   // one weight's numbers in order: the RG, then Diff, then Int Diff
    var rg = ns.filter(function (n) { return n >= 2.30 && n <= 2.90; })[0], rest = ns.filter(function (n) { return n < 1; });
    if (rg != null) put(w, 'RG', rg); if (rest[0] != null) put(w, 'Diff', rest[0]); if (rest[1] != null) put(w, 'IntDiff', rest[1]);
  };
  lines.forEach(function (l) {   // "16 lb 2.510 0.048 0.015" or "16 | 2.51 | .048"
    var m = /^(1[0-6])\s*(?:#|lbs?\.?|pounds?)?\s*[|:\-\u2013]?\s*((?:[0-2]?\.\d{2,3}[\s|,]*){2,3})$/i.exec(l);
    if (m) classify((m[2].match(/[0-2]?\.\d{2,3}/g) || []).map(num), parseInt(m[1], 10));
  });
  for (var i = 0; i < lines.length; i++) {   // "16 15 14 13 12" then rows of numbers, one per column
    var ws = lines[i].replace(/^(?:weights?|lbs?|pounds)\b\s*[:|]?\s*/i, '').split(/[\s|,]+/).filter(Boolean);
    if (ws.length < 2 || !ws.every(function (x) { return /^(1[0-6])(?:#|lbs?\.?)?$/i.test(x); })) continue;
    var cols = ws.map(function (x) { return parseInt(x, 10); }), rowsN = [];
    for (var j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      var ns = (lines[j].replace(/^[a-z][a-z ]*\.?\s*[:|]?/i, '').match(/[0-2]?\.\d{2,3}/g) || []).map(num);
      if (ns.length === cols.length) rowsN.push({ label: lines[j], ns: ns });
    }
    rowsN.forEach(function (r, ri) {
      var k = /int|mass|psa/i.test(r.label) ? 'IntDiff' : /diff/i.test(r.label) ? 'Diff' : /rg|radius/i.test(r.label) ? 'RG' : null;
      if (!k) k = r.ns.every(function (n) { return n >= 2.30; }) ? 'RG' : rowsN.filter(function (x, xi) { return xi < ri && x.ns.every(function (n) { return n < 1; }); }).length ? 'IntDiff' : 'Diff';
      r.ns.forEach(function (n, ci) { put(cols[ci], k, n); });
    });
  }
  /* nothing in those shapes: the spec parser (labelled rows, "16 lb 15 lb" tables, per-weight lines) */
  if (!Object.keys(p.weights).length) p.weights = parseSpecText(text, 15, '').weights || {};
  return { fields: {}, weights: p.weights, found: Object.keys(p.weights).length ? ['rg'] : [], source: null };
}
function catPasteWeights() {
  if (!_apEdit) return;
  var g = function (id) { var el = document.getElementById(id); return el ? el.value : null; }, rows = [];
  AP_WEIGHTS.forEach(function (w) { [['RG', 'RG'], ['Diff', 'Diff'], ['IntDiff', 'Int Diff']].forEach(function (a) {
    rows.push({ w: w, wk: a[0], label: w + ' lb ' + a[1], inputId: 'ape-' + w + '-' + a[0], cur: g('ape-' + w + '-' + a[0]) }); }); });
  spReadClipboard(function (text) {
    var p = parseWeightsText(text);
    if (!Object.keys(p.weights).length) { if (root.toast) root.toast('No weights found in what you copied'); return; }
    spOpen({ name: _apEdit.ballName, title: _apEdit.ballName + ' \u00b7 weights', catalogId: _apEdit.catalogId, rows: rows }, p);
  });
}
/* v30.203 WB-2: after a correction is saved, every open view of that ball shows it */
function catRecordChanged(id) {
  if (typeof document === 'undefined') return;
  try { if (_sheet && _sheet.id === id && document.getElementById('cat-sheet-ov')) { _sheet.detail = sheetDetail(id, _sheet.raw); renderSheet(); } } catch (e) {}
  try { if (document.getElementById('hold-ov')) hlPaint(); } catch (e) {}
  try { if (document.getElementById('srv-ov')) srvRender(); } catch (e) {}
  try { var q = document.getElementById('cat-add-q'); if (document.getElementById('cat-add-results') && typeof catAddSearch === 'function') catAddSearch(q ? q.value : ''); } catch (e) {}
}
/* v30.206 WB-4: put a correction back as it was (undo). store 'phone' | 'repo'; prev null removes it. */
function catRestoreCorrection(cid, store, prev) {
  if (store === 'phone') { var l = apLS(); if (!l) return Promise.resolve(false); var all = localOverrides(); if (prev) all[cid] = prev; else delete all[cid]; l.setItem(LOCAL_OVR_KEY, JSON.stringify(all)); catRecordChanged(cid); return Promise.resolve(true); }
  return apReadOverrides(true).then(function (all) {
    var next = Object.assign({}, all); if (prev) next[cid] = prev; else delete next[cid];
    var body = { message: 'spec correction undone: ' + cid, content: b64e(JSON.stringify(next, null, 1)), branch: 'specs' }; if (_ovrSha) body.sha = _ovrSha;
    return apGH(OVR_PATH, { method: 'PUT', body: body }).then(function (res) { _ovr = next; _ovrSha = res && res.content ? res.content.sha : null; catRecordChanged(cid); return true; });
  });
}
/* v30.204 WB-3: the save without the form, for the workbench's Save all found. form = the editor's
   fields (coverName ... released, source, note, weights {lb: {RG, Diff, IntDiff}}); base0 = published
   (as staged) or the bridge's row. Resolves { ok, msg } or { ok: false, msg }. */
function catSaveCorrection(cid, form, base0) {
  form = JSON.parse(JSON.stringify(form)); form.weights = form.weights || {};
  AP_WEIGHTS.forEach(function (w) { form.weights[w] = form.weights[w] || {}; });
  var staged0 = base0 || null;
  var other = form.source === 'bowwwl' ? (_ovr && _ovr[cid]) : localOverrides()[cid];
  var base = apApplyOverride(staged0, other), bs = (base && base.specs) || {};
  ['coverName', 'coverType', 'finish', 'core', 'coreType', 'released'].forEach(function (k) { if (String(form[k] == null ? '' : form[k]).trim() === String(bs[k] == null ? '' : bs[k]).slice(0, k === 'released' ? 10 : 999)) form[k] = ''; });
  var prevO = form.source === 'bowwwl' ? localOverrides()[cid] : (_ovr && _ovr[cid]), prevW = (prevO && prevO.weights) || {};
  Object.keys(form.weights).forEach(function (w) { var x = form.weights[w], y = (bs.weights || {})[w] || {}, pw = prevW[w];
    var same = function (k) { return String(x[k] == null ? '' : x[k]).trim() === '' || (y[k] != null && Number(x[k]) === Number(y[k])); };
    var half = pw && (pw.RG == null || pw.Diff == null);
    if (!half && ['RG', 'Diff', 'IntDiff'].every(same)) ['RG', 'Diff', 'IntDiff'].forEach(function (k) { x[k] = ''; }); });
  var res = apOverrideFrom(form);
  if (res.errors.length) return Promise.resolve({ ok: false, msg: res.errors.join('. ') });
  var o = res.override;
  if (!o.weights && !['coverName', 'coverType', 'finish', 'core', 'coreType', 'released'].some(function (k) { return o[k]; })) return Promise.resolve({ ok: false, msg: 'Nothing changed.' });
  if (o.source === 'bowwwl') { o.at = new Date().toISOString().slice(0, 10); saveLocalOverride(cid, mergeOverrides(localOverrides()[cid], o)); catRecordChanged(cid); return Promise.resolve({ ok: true, msg: 'Saved on this phone (bowwwl)' }); }
  var keep = (_ovr && _ovr[cid]) || null;   // v30.206: merged, so a read that lacks a field never wipes an earlier repo correction
  return apSaveOverride(cid, keep ? Object.assign(mergeOverrides(keep, o), { source: o.source, note: o.note || keep.note }) : o).then(function () { catRecordChanged(cid); return { ok: true, msg: 'Saved to the repo' }; },
    function (e) { return { ok: false, msg: e.status ? 'GitHub ' + e.status : 'offline' }; });
}
function catApprovalsEditSave() {
  if (!_apEdit) return;
  var g = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
  var form = { coverName: g('ape-coverName'), coverType: g('ape-coverType'), finish: g('ape-finish'), core: g('ape-core'), coreType: g('ape-coreType'), released: g('ape-released'),
               source: g('ape-source'), note: g('ape-note'), weights: {} };
  AP_WEIGHTS.forEach(function (w) { form.weights[w] = { RG: g('ape-' + w + '-RG'), Diff: g('ape-' + w + '-Diff'), IntDiff: g('ape-' + w + '-IntDiff') }; });
  /* Only what differs from the baseline is stored. The baseline includes the
     OTHER store's corrections, so a bowwwl value shown in the form is never
     saved to the repo as a maker correction, and repo values are not copied
     into the device store (v30.170). */
  var cid = _apEdit.catalogId, staged0 = _apEdit.base0 || null;   // v30.185: set when the sheet opened
  var other = form.source === 'bowwwl' ? (_ovr && _ovr[cid]) : localOverrides()[cid];
  var base = apApplyOverride(staged0, other), bs = (base && base.specs) || {};
  ['coverName', 'coverType', 'finish', 'core', 'coreType', 'released'].forEach(function (k) { if (String(form[k]).trim() === String(bs[k] == null ? '' : bs[k]).slice(0, k === 'released' ? 10 : 999)) form[k] = ''; });
  /* v30.187: a weight is kept or dropped as a whole row. Storing only the changed cell (e.g. Diff)
     left RG out, and over a catalog entry without that weight the card showed Diff with no RG.
     A row is kept when any cell differs, or when the saved correction already has a half row. */
  var prevO = form.source === 'bowwwl' ? localOverrides()[cid] : (_ovr && _ovr[cid]), prevW = (prevO && prevO.weights) || {};
  Object.keys(form.weights).forEach(function (w) { var x = form.weights[w], y = (bs.weights || {})[w] || {}, pw = prevW[w];
    var same = function (k) { return String(x[k]).trim() === '' || (y[k] != null && Number(x[k]) === Number(y[k])); };
    var half = pw && (pw.RG == null || pw.Diff == null);
    if (!half && ['RG', 'Diff', 'IntDiff'].every(same)) ['RG', 'Diff', 'IntDiff'].forEach(function (k) { x[k] = ''; }); });
  var res = apOverrideFrom(form), err = document.getElementById('ape-err');
  if (res.errors.length) { if (err) err.textContent = res.errors.join('. '); return; }
  var o = res.override;
  if (!o.weights && !['coverName', 'coverType', 'finish', 'core', 'coreType', 'released'].some(function (k) { return o[k]; })) { if (err) err.textContent = 'Nothing changed.'; return; }
  if (o.source === 'bowwwl') {
    /* personal-use data: this device only, never committed */
    o.at = new Date().toISOString().slice(0, 10);
    saveLocalOverride(_apEdit.catalogId, mergeOverrides(localOverrides()[_apEdit.catalogId], o));
    apEditDone('Saved on this device only (bowwwl values are not published)');
    return;
  }
  if (err) err.textContent = 'Saving…';
  var _fromSheet = _apEdit.origin === 'sheet' || _apEdit.origin === 'list';   // v30.201: lists open it the way the card does
  apSaveOverride(_apEdit.catalogId, o).then(function (all) {
    /* v30.185: a ball the bridge never read publishes from the correction alone, which needs RG + Diff for a weight */
    var full = apApplyOverride(staged0, all && all[cid]), fw = ((full && full.specs) || {}).weights || {};
    var nums = Object.keys(fw).some(function (w) { return fw[w] && fw[w].RG != null && fw[w].Diff != null; });
    apEditDone(_fromSheet ? (nums ? 'Correction saved. Publish to update the catalog.' : 'Saved. It publishes once it has RG and Diff for at least one weight.') : 'Correction saved');
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
root.catPasteWeights = catPasteWeights; root.catRecordChanged = catRecordChanged; root._wb2 = { parseWeightsText: parseWeightsText, apFieldSource: apFieldSource };
root.catWorkbenchOpen = catWorkbenchOpen; root.catUpdateOpen = catUpdateOpen; root.catUpdateStart = catUpdateStart; root.catUpdateStop = catUpdateStop; root.catUpdateClose = catUpdateClose;
root.catUpdatePublish = catUpdatePublish; root.catUpdateRetry = catUpdateRetry; root.updPickToggle = updPickToggle; root.updSave = updSave; root.updTick = updTick; root._upd = { sourcesFrom: updSourcesFrom, counts: updCounts, state: updActive }; root._srvState = function () { return _srv; }; root.catSpecReviewGo = catSpecReviewGo; root.catSpecReviewList = catSpecReviewList; root.srvShareMine = srvShareMine; root.catCorrectWithParsed = catCorrectWithParsed;
/* v30.204 WB-3: what workbench.js uses (one place, so the internals stay private elsewhere) */
root._catAPI = { catLoad: catLoad, byIdIn: byIdIn, cleanName: cleanName, esc: esc, jsq: jsq, norm: norm, thumbHTML: thumbHTML, overlay: overlay,
  BTN_P: BTN_P, BTN_G: BTN_G, BACK: BACK, CHIP: CHIP, CHIP_T: CHIP_T, CHIP_G: CHIP_G,
  catIsRejected: catIsRejected, catIsHeld: catIsHeld, catIsReleased: catIsReleased, rlLocal: rlLocal, rlSaveLocal: rlSaveLocal, rlQueueSync: rlQueueSync,
  hlHasSpecs: hlHasSpecs, overrideFor: overrideFor, catImageStored: catImageStored, discontinuedOf: discontinuedOf,
  stEntry: stEntry, stSet: stSet, stSaveLocal: stSaveLocal, stLocal: stLocal, stQueueSync: stQueueSync, stToday: stToday,
  parseSpecText: parseSpecText, spReadClipboard: spReadClipboard, spPdfFileText: spPdfFileText, bowwwlLinks: bowwwlLinks, appBalls: appBalls,
  apToken: apToken, apReadOverrides: apReadOverrides, apReadStaged: apReadStaged, srvStagedRow: srvStagedRow, catDetailRaw: catDetailRaw, detAsStaged: detAsStaged,
  apApplyOverride: apApplyOverride, catCorrectFor: catCorrectFor, catCorrectWithParsed: catCorrectWithParsed, catSaveCorrection: catSaveCorrection,
  brandSlug: brandSlug, catAddDetail: catAddDetail, normReleased: normReleased, catMineAsRead: catMineAsRead,
  catRestoreCorrection: catRestoreCorrection, catUpdateLine: catUpdateLine,
  apFetchIssue: apFetchIssue, apParseIssue: apParseIssue, apQueue: apQueue, apSetQueue: apSetQueue,
  catPastePicture: catPastePicture, catSaveCover: catSaveCover, catSaveCore: catSaveCore, catCoreShareOffer: catCoreShareOffer, coreShareCandidates: coreShareCandidates, taSuggest: taSuggest,
  imgProbe: imgProbe, imgShrink: imgShrink, catImgDel: catImgDel, bowwwlImgCandidates: bowwwlImgCandidates, bowwwlCoreCandidates: bowwwlCoreCandidates, coreKeyOf: coreKeyOf, catCoreImageFor: catCoreImageFor, coreLinkSet: coreLinkSet, scanMem: scanMem, vocabLoad: vocabLoad, triageGet: triageGet, triageSave: triageSave, triageOf: triageOf, upcomingOf: upcomingOf, monthsSince: monthsSince, localOverrides: localOverrides, repoOverride: function (id) { return (_ovr && _ovr[id]) || null; },
  regionOf: regionOf, regionTags: regionTags, regionTagSet: regionTagSet, regionFromText: regionFromText, imgPicks: imgPicks, imgPickSet: imgPickSet, REGIONS: REGION_WORDS.map(function (r) { return r[0]; }), AP_WEIGHTS: AP_WEIGHTS, version: CAT_VERSION }; root.catMyBallsOpen = catMyBallsOpen; root.catSaveCorrection = catSaveCorrection;
root.catOldSearch = catOldSearch; root.catOldClose = catOldClose; root.catAddBlank = catAddBlank; root.catAddManual = catAddManual;
root.catSpecReviewTab = catSpecReviewTab; root.catMissingCorrect = catMissingCorrect; root.catMissingFilter = catMissingFilter; root.catMissingPage = catMissingPage; root._ms = { msRows: msRows, oldMatchScore: oldMatchScore };
root.catHoldCorrect = catHoldCorrect; root.catCorrectFor = catCorrectFor;
root.catHoldOpen = catHoldOpen; root.catHoldClose = catHoldClose; root.catHoldShow = catHoldShow; root.catHoldFilter = catHoldFilter; root.catHoldPage = catHoldPage; root.catHoldSel = catHoldSel; root.catHoldApprove = catHoldApprove; root.catHoldSend = catHoldSend; root.catIsHeld = catIsHeld; root._hold = { hlRows: hlRows, hlHasSpecs: hlHasSpecs, rlMerge: rlMerge };
root.catBackupOpen = catBackupOpen; root.catBackupMake = catBackupMake; root.catBackupShare = catBackupShare; root.catBackupRestore = catBackupRestore; root.catBackupStatus = catBackupStatus; root.catBackupBuild = catBackupBuild; root.catBackupMerge = catBackupMerge;
root.catPickerMount = catPickerMount;
root.catApprovalsOpen = catApprovalsOpen; root.catImagesScanAll = catImagesScanAll; root.catImagesScanStop = catImagesScanStop; root.catImagesSlot = catImagesSlot; root.catImagesExport = catImagesExport; root.catImagesImport = catImagesImport; root.catCoreImageFor = catCoreImageFor; root.catImagesOpen = catImagesOpen; root.catImagesClose = catImagesClose; root.catImagesTab = catImagesTab; root.catImagesFilter = catImagesFilter; root.catImagesPage = catImagesPage; root.catImagesTry = catImagesTry; root.catImagesTryPage = catImagesTryPage; root.catImagesPaste = catImagesPaste; root.catImagesPhoto = catImagesPhoto; root.catImagesDrop = catImagesDrop; root.catImagesUse = catImagesUse; root.catImagesUseAll = catImagesUseAll; root.catSpApPdf = catSpApPdf; root.catSpBallPdf = catSpBallPdf; root.catPdfHelp = catPdfHelp; root.catShortcutHelp = catShortcutHelp; root.catShortcutCopy = catShortcutCopy; root.catShortcutClose = catShortcutClose; root.catSpAp = catSpAp; root.catSpBall = catSpBall; root.catSpToggle = catSpToggle; root.catSpAll = catSpAll; root.catSpEdit = catSpEdit; root.catSpClose = catSpClose; root.catSpApply = catSpApply; root.catSpManualGo = catSpManualGo; root.catSpManualClose = catSpManualClose; root.catLookBall = catLookBall; root.catLookOk = catLookOk; root.catLookSave = catLookSave; root.catLookClose = catLookClose; root.catPasteOpen = catPasteOpen; root.catPasteClose = catPasteClose; root.catPasteClip = catPasteClip; root.catPasteShow = catPasteShow; root.catFillToggle = catFillToggle; root.catFillClose = catFillClose; root.catFillConfirm = catFillConfirm; root.catPageOpen = catPageOpen; root.catPageClose = catPageClose; root.catPageUseSel = catPageUseSel; root.catPageUseVal = catPageUseVal; root.catPageImg = catPageImg; root.catPickOpen = catPickOpen; root.catPickFilter = catPickFilter; root.catPickChoose = catPickChoose; root.catPickClose = catPickClose; root.catSpecReviewOpen = catSpecReviewOpen; root.catSpecReviewClose = catSpecReviewClose; root.catSpecReviewAct = catSpecReviewAct; root.catSpecReviewBulk = catSpecReviewBulk; root.catSpecReviewPage = catSpecReviewPage; root.catTagPick = catTagPick; root.catTagCancel = catTagCancel; root.catVerifyRefresh = catVerifyRefresh; root.catVerifyDismiss = catVerifyDismiss; root.catVerifyRetry = catVerifyRetry; root.catVerifyOpenApprovals = catVerifyOpenApprovals; root.catVerifyPublish = catVerifyPublish; root.catVerifyApply = catVerifyApply; root.catVerifyTick = vfyTick; root.catVerifyState = vfyActive; root.catApprovalsRetryStaged = catApprovalsRetryStaged; root.apStagedErrText = apStagedErrText; root.catApprovalsClose = catApprovalsClose; root.catApprovalsSaveToken = catApprovalsSaveToken;
root.catApprovalsForgetToken = catApprovalsForgetToken; root.catApprovalsChangeToken = catApprovalsChangeToken; root.catApprovalsPage = catApprovalsPage; root.catApprovalsFilter = catApprovalsFilter;
root.catApprovalsTick = catApprovalsTick; root.catApprovalsEdit = catApprovalsEdit; root.catApprovalsEditClose = catApprovalsEditClose; root.catApprovalsEditSave = catApprovalsEditSave; root.catAddSpecsOnly = catAddSpecsOnly; root.catVerifyNow = catVerifyNow; root.catImagesSet = catImagesSet;
root.catImagesRefresh = catImagesRefresh; root.catImagesStatus = catImagesStatus; root.catImageFor = catImageFor; root.catApprovalsSend = catApprovalsSend; root.catApprovalsPublish = catApprovalsPublish; root.catPickerSearch = catPickerSearch;
root.catPick = catPick; root.catUnlink = catUnlink; root.catPickValue = catPickValue;
root.catApprovalsRejectAsk = catApprovalsRejectAsk; root.catApprovalsReject = catApprovalsReject; root.catDiscOpen = catDiscOpen; root.catDiscClose = catDiscClose; root.catDiscTab = catDiscTab;
root.catDiscBrand = catDiscBrand; root.catDiscSearch = catDiscSearch; root.catDiscHide = catDiscHide; root.catDiscToggle = catDiscToggle; root.catDiscYear = catDiscYear; root.catDiscPick = catDiscPick;
root.catFixOpen = catFixOpen; root.catFixPic = catFixPic; root.catFixRefresh = catFixRefresh; root.catFixClose = catFixClose; root.catFixCorrect = catFixCorrect; root.catFixMark = catFixMark; root.catFixRejectAsk = catFixRejectAsk; root.catFixReject = catFixReject;
root.catCovOpen = catCovOpen; root.catCovClose = catCovClose; root.catCovSince = catCovSince; root.catCovToggle = catCovToggle;
root.catDiscClear = catDiscClear; root.catDiscMark = catDiscMark; root.catDiscRestore = catDiscRestore; root.catDiscSend = catDiscSend; root.catDiscPublish = catDiscPublish; root.catIsRejected = catIsRejected;
root.catLinkLabel = catLinkLabel; root.catReviewOpen = catReviewOpen;
root.catReviewLink = catReviewLink; root.catReviewSkip = catReviewSkip;
root.catReviewResetSkips = catReviewResetSkips;
root.catOpenAddSearch = catOpenAddSearch; root.catCloseAddSearch = catCloseAddSearch;
root.catAddSearch = catAddSearch; root.catAddManual = catAddManual; root.catAddBrand = catAddBrand;
root.catAddBubble = catAddBubble; root.catPasteBoxClose = catPasteBoxClose; root.catCoreShareTick = catCoreShareTick; root.catCoreShareGo = catCoreShareGo; root.catCoreShareClose = catCoreShareClose; root.taChoose = taChoose; root.catCoreShareOffer = catCoreShareOffer; root.catAddSet = catAddSet; root.catAddBrandSet = catAddBrandSet; root.catAddBrandOpen = catAddBrandOpen; root.catAddLoosen = catAddLoosen; root.catAddBrandPick = catAddBrandPick; root.catAddBrandToggle = catAddBrandToggle; root.catAddBrandPickClose = catAddBrandPickClose;
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
                   addListHTML: addListHTML, addSearchIn: addSearchIn, newest: newest, bubbleFilter: bubbleFilter, discontinuedOf: discontinuedOf, dcGroups: dcGroups, covRows: covRows, covBrandOf: covBrandOf, detAsStaged: detAsStaged, sheetDetail: sheetDetail, withLocalCorrection: withLocalCorrection, catFixAllowed: catFixAllowed, stMerge: stMerge, catIsRejected: catIsRejected, stSet: stSet, stLocal: stLocal, stReset: function () { _stc = null; }, addFilters: function () { return _af; }, brandTree: brandTree, brandGroupOf: brandGroupOf,
                   specsOf: specsOf, shardMap: shardMap, shardKeyFor: shardKeyFor, detailFiles: detailFiles,
                   buildOwnedBall: buildOwnedBall, ballFromSpecs: ballFromSpecs, fillPlan: fillPlan,
                   catSpecSource: catSpecSource, setFilled: function (f) { _filled = f; },
                   imgLinksFrom: imgLinksFrom, sheetState: function () { return _sheet; }, mergeOverrides: mergeOverrides, withLocalCorrection: withLocalCorrection, apApplyOverride: apApplyOverride, apOverrideFrom: apOverrideFrom, bowwwlLinks: bowwwlLinks, apStagedFor: apStagedFor, apAsDetail: apAsDetail, apRangeNotes: apRangeNotes, derivedCoverType: derivedCoverType, specGaps: specGaps, nearestWeight: nearestWeight, addListHTML: addListHTML, sourceForBrand: sourceForBrand, apParseIssue: apParseIssue, apPages: apPages, apApplyTicks: apApplyTicks, apConflict: apConflict, apNums: apNums,
                   verifyPlan: verifyPlan, coreKeyOf: coreKeyOf, coreBase: coreBase, bowwwlCoreCandidates: bowwwlCoreCandidates, bowwwlImgCandidates: bowwwlImgCandidates, slugBw: slugBw, pdfItemsToLines: pdfItemsToLines, spMakerOf: spMakerOf, spWeightColumns: spWeightColumns, spWrappedRows: spWrappedRows, spLdLines: spLdLines, SHORTCUT_JS: SHORTCUT_JS, srvEditValue: srvEditValue, parseSpecText: parseSpecText, lkTabs: lkTabs, lkPasteValue: lkPasteValue, lkBallChanges: lkBallChanges, pageMismatch: pageMismatch, pasteLines: pasteLines, plausibleText: plausibleText, proseFields: proseFields, pgvClean: pgvClean, vocabMerge: vocabMerge, vocabSplit: vocabSplit, familyOf: familyOf, srvRows: srvRows, srvApply: srvApply, srvStagedRow: srvStagedRow, vfyPagesFor: vfyPagesFor, vfyEstimateFrom: vfyEstimateFrom, tagLine: tagLine, tagLines: tagLines, tagValueFor: tagValueFor, vfyPickRun: vfyPickRun, vfyClassify: vfyClassify, vfyCardHTML: vfyCardHTML, specMatch: specMatch, coreNameMatch: coreNameMatch, DIFF_MAX: DIFF_MAX, metricUnverified: metricUnverified, catSpecUnverified: catSpecUnverified,
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
