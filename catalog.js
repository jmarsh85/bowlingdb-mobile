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

var CAT_VERSION  = 'v30.159';
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
function catDetail(entry) {
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
  return normTxt(a) === normTxt(c);
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
    return e ? catDetail(e) : null;
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
function addRowHTML(e, owned) {
  var mine = owned && (owned.linked[e.i] || owned.keyed[e.k]);
  var meta = [esc(e.m)]; if (e.y) meta.push('USBC ' + esc(e.y));
  return '<div class="cat-add-row" onclick="catAddDetail(\'' + esc(e.i) + '\')" style="display:flex;align-items:center;gap:12px;padding:10px 2px;border-bottom:1px solid var(--border1);cursor:pointer">' +
    thumbHTML(e, 40) +
    '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:600;color:var(--t1)">' + esc(cleanName(e.n)) +
      (mine ? '<span style="' + CHIP_T + '">IN YOUR ARSENAL</span>' : '') +
      (/-u13$/.test(e.i) ? '<span style="' + CHIP_G + '">UNDER 13 LB</span>' : '') + '</div>' +
    '<div style="font-size:12px;color:var(--t2);margin-top:2px">' + meta.join(' · ') +
      (e.s ? ' · <span style="color:var(--teal)">● specs</span>' : '') + '</div></div></div>';
}
function sectionHTML(title, body) {
  return '<div style="font-size:13px;font-weight:700;color:var(--t2);text-transform:uppercase;letter-spacing:0.5px;margin:16px 2px 4px">' + title + '</div>' + body;
}
function emptyStateHTML(rows, owned) {
  ensureMaps(rows);
  var h = '';
  var brands = {}; appBalls().forEach(function (b) { if (b.MFG) brands[canonicalMfg(b.MFG)] = 1; });
  var bl = Object.keys(brands).sort();
  if (bl.length) h += sectionHTML('Your brands', '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 4px">' +
    bl.map(function (b) { return '<button class="ball-filter-chip" onclick="catAddBrand(\'' + esc(b).replace(/&#39;/g, "\\'") + '\')">' + esc(b) + '</button>'; }).join('') + '</div>');
  var rec = readRecent().map(function (id) { return byIdIn(rows, id); }).filter(Boolean);
  if (rec.length) h += sectionHTML('Recently viewed', rec.map(function (e) { return addRowHTML(e, owned); }).join(''));
  h += sectionHTML('New on the USBC list', newest(rows, 20).map(function (e) { return addRowHTML(e, owned); }).join(''));
  return h;
}
function addListHTML(rows, q, owned) {
  if (!q || q.replace(/\s/g, '').length < 2) return emptyStateHTML(rows, owned);
  var list = addSearchIn(rows, q, 60);
  if (!list.length) return '<div style="font-size:13px;color:var(--t2);padding:16px 2px;line-height:1.6">No match in the USBC list.<br>Use <b>Enter manually</b> below.</div>';
  return list.map(function (e) { return addRowHTML(e, owned); }).join('');
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
  var ov = overlay('cat-search-ov', 900);
  ov.innerHTML =
    '<div style="padding:12px 16px 4px"><button onclick="catCloseAddSearch()" style="' + BACK + '" aria-label="Back">‹</button></div>' +
    '<div style="padding:4px 16px 0;font-size:30px;font-weight:800;color:var(--t1)">Add a Ball</div>' +
    '<div style="padding:10px 16px 4px"><input id="cat-add-q" class="bdet-field-input" type="search" placeholder="Search brands, names…"' +
      ' autocomplete="off" autocorrect="off" autocapitalize="off" oninput="catAddSearch(this.value)" style="width:100%;font-size:16px">' +
      '<div style="font-size:11px;color:var(--t3);margin-top:5px">' + esc(s.count.toLocaleString()) + ' USBC-approved balls · list ' + esc(s.listVersion || '') + '</div></div>' +
    '<div id="cat-add-results" style="flex:1;overflow-y:auto;padding:0 16px 12px;-webkit-overflow-scrolling:touch"><div style="font-size:12px;color:var(--t3);padding:14px 2px">Loading…</div></div>' +
    '<div style="padding:10px 16px;border-top:1px solid var(--border1)">' +
      '<button onclick="catAddManual()" style="' + BTN_G + 'width:100%;padding:11px;font-size:13px">Can\'t find it? Enter manually</button></div>';
  document.body.appendChild(ov);
  catAddSearch('');
  return true;
}
function catCloseAddSearch() {
  if (typeof document === 'undefined') return;
  ['cat-sheet-ov', 'cat-search-ov'].forEach(function (id) { var el = document.getElementById(id); if (el) el.parentNode.removeChild(el); });
}
function catAddSearch(q) {
  catLoad().then(function (rows) {
    var box = document.getElementById('cat-add-results');
    if (box) box.innerHTML = addListHTML(rows, q, ownedIndex(rows));
  });
}
function catAddBrand(b) {
  var q = document.getElementById('cat-add-q');
  if (q) q.value = b;
  catAddSearch(b);
}
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
    ['Coverstock', f(s.coverName)], ['Cover type', f(s.coverType)], ['Factory finish', f(s.finish)],
    ['Core', f(s.coreName)], ['Core type', f(s.coreType)],
    ['RG', f(s.rg, 3)], ['Differential', f(s.diff, 3)], ['Int. Diff', f(s.intDiff, 3)],
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
  var owned = ownedFor(e);
  var chips = '';
  if (e.y) chips += '<span style="' + CHIP_G + '">USBC APPROVED ' + esc(e.d ? (monthYear(e.d) || e.y).toUpperCase() : e.y) + '</span>';
  if (/-u13$/.test(e.i)) chips += '<span style="' + CHIP_G + '">UNDER 13 LB</span>';
  if (owned.length) chips += '<span style="' + CHIP_T + '">IN YOUR ARSENAL' + (owned.length > 1 ? ' ×' + owned.length : '') + '</span>';
  var body;
  if (!_sheet.loaded) body = '<div style="font-size:12px;color:var(--t3);padding:10px 0">Loading specs…</div>';
  else if (!hasAnySpec(s)) body = '<div style="font-size:13px;color:var(--t2);padding:6px 0 10px;line-height:1.55">Specs aren\'t in the catalog for this ball yet. You can add them after adding it.</div>';
  else {
    body = specRows(e, s).map(function (r) {
      return '<div style="display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--border1);font-size:14px">' +
        '<span style="color:var(--t2)">' + r[0] + '</span><span style="color:var(--t1);text-align:right">' + r[1] + '</span></div>';
    }).join('');
    var wt = _sheet.weight || 15;
    body += '<div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.5">RG and Diff shown for ' + wt + ' lb' +
      (s.weights.length && s.weights.indexOf(wt) < 0 ? ' (not published for this weight)' : '') + '.' +
      (s.src ? ' Specs: ' + (/^https?:|^manufacturer$/.test(s.src) ? 'manufacturer' : esc(s.src)) + (s.checked ? ', checked ' + esc(s.checked) : '') + '.' : '') + '</div>';
    var met = metricScore(ballFromSpecs(s), parseFinish(s.finish));
    if (met) body += '<div style="margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--bg3);font-size:13px;color:var(--t1)">' +
      'Strength <b>' + met.strength + '</b> · Shape <b>' + signed(met.shape) + '</b><span style="color:var(--t3);font-size:11px"> · factory finish</span></div>';
  }
  var w = _sheet.weight;
  return '<div style="padding:12px 16px 4px;display:flex"><button onclick="catSheetClose()" style="' + BACK + '" aria-label="Back">‹</button></div>' +
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
    catDetail(e).then(function (d) {
      if (_sheet.id !== e.i) return;
      _sheet.detail = d; _sheet.loaded = true; renderSheet();
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
    var rec = buildOwnedBall(e, _sheet.detail, _sheet.weight, id);
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
    return catDetail(e);
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
  catLoad().then(function (rows) { return catDetail(byIdIn(rows, _pick.id)); }).then(function (d) {
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
  }).catch(function (e) {
    var l = apLS(), c = null; try { c = JSON.parse((l && l.getItem(AP_CACHE_KEY)) || 'null'); } catch (x) {}
    if (c) { _ap.issue = c.number; _ap.body = c.body; _ap.fromCache = true; }
    _ap.err = e.status === 401 ? 'GitHub rejected the token (401). Check it or make a new one.'
      : e.status === 403 || e.status === 404 ? 'The token cannot read this repo\'s issues (' + e.status + '). Check its repo and Issues permission.'
      : (e.message || String(e));
  }).then(function () {
    apBuildPages(true); _ap.busy = false; apRender();
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
      '<div style="font-size:16px;font-weight:800;color:var(--t1);margin:5px 0 3px">' + esc(b.specs) + '</div>' +
      '<div style="font-size:11px;color:var(--t3);line-height:1.45">' + esc(b.reason) + '</div>' +
      (b.url ? '<a href="' + esc(b.url) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="font-size:12px;color:var(--teal);display:inline-block;margin-top:5px">Open source page ↗</a>' : '') +
      '</div>';
  }).join('');
  var warn = apConflict(p.boxes) ? '<div style="font-size:12px;color:var(--gold);margin-top:10px;line-height:1.45">These approvals disagree, so neither will publish. Keep one.</div>' : '';
  ov.innerHTML = apHeader(sub) + status + filt +
    '<div style="flex:1;overflow-y:auto;padding:4px 16px 12px">' + head + mineH + cards + warn + '</div>' + apFooter(true);
  catLoad().then(function (rows) {
    var e = byIdIn(rows, p.catalogId), el = document.getElementById('ap-entry');
    if (e && el && _ap.pages[_ap.idx] === p) el.innerHTML = entryLine(e);
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
    return apGH('').then(function (repo) {
      return apGH('/actions/workflows/specs-publish.yml/dispatches', { method: 'POST', body: { ref: repo.default_branch || 'main' } });
    }).then(function () {
      if (root.toast) root.toast('specs-publish started. The catalog updates when it finishes (a few minutes).');
    }).catch(function (e) {
      if (root.toast) root.toast(e.status === 403 || e.status === 404 ? 'Token needs Actions read and write to publish' : ('Publish failed: ' + (e.status ? 'GitHub ' + e.status : 'offline')));
    });
  };
  var q = Object.keys(apQueue()).length;
  return (q ? apFlush() : Promise.resolve(0)).then(go, go);
}
if (typeof root.addEventListener === 'function') root.addEventListener('online', function () { apFlush().catch(function () {}); });

root.catPickerMount = catPickerMount;
root.catApprovalsOpen = catApprovalsOpen; root.catApprovalsClose = catApprovalsClose; root.catApprovalsSaveToken = catApprovalsSaveToken;
root.catApprovalsForgetToken = catApprovalsForgetToken; root.catApprovalsChangeToken = catApprovalsChangeToken; root.catApprovalsPage = catApprovalsPage; root.catApprovalsFilter = catApprovalsFilter;
root.catApprovalsTick = catApprovalsTick; root.catApprovalsSend = catApprovalsSend; root.catApprovalsPublish = catApprovalsPublish; root.catPickerSearch = catPickerSearch;
root.catPick = catPick; root.catUnlink = catUnlink; root.catPickValue = catPickValue;
root.catLinkLabel = catLinkLabel; root.catReviewOpen = catReviewOpen;
root.catReviewLink = catReviewLink; root.catReviewSkip = catReviewSkip;
root.catReviewResetSkips = catReviewResetSkips;
root.catOpenAddSearch = catOpenAddSearch; root.catCloseAddSearch = catCloseAddSearch;
root.catAddSearch = catAddSearch; root.catAddManual = catAddManual; root.catAddBrand = catAddBrand;
root.catAddDetail = catAddDetail; root.catSheetClose = catSheetClose; root.catSheetWeight = catSheetWeight;
root.catAddToArsenal = catAddToArsenal; root.catFillFromCatalog = catFillFromCatalog;
root.catSpecSource = catSpecSource; root.catDetail = catDetail;
root.catSpecUnverified = catSpecUnverified; root.catUnverifiedTag = catUnverifiedTag;
root.catAutoVerify = catAutoVerify; root.catAutoVerifyAll = catAutoVerifyAll;
root.catMetric = catMetric; root.catRGBand = catRGBand; root.catMetricChip = catMetricChip; root.catMetricHTML = catMetricHTML;
root.catIdentityLocked = catIdentityLocked; root.catAuditOpen = catAuditOpen;
root.catLookup = function (mfg, name) { return catLoad().then(function (rows) { return lookupIn(rows, mfg, name); }); };
root.catSearch = function (q, n) { return catLoad().then(function (rows) { return searchIn(rows, q, n); }); };
root._catStep5 = { norm: norm, modelKey: modelKey, lookupIn: lookupIn, searchIn: searchIn, reviewModel: reviewModel,
                   pickerBodyHTML: pickerBodyHTML, reviewHTML: reviewHTML, resultsHTML: resultsHTML,
                   setPick: function (p) { _pick = p; }, auditModel: auditModel, auditHTML: auditHTML,
                   addListHTML: addListHTML, addSearchIn: addSearchIn, newest: newest,
                   specsOf: specsOf, shardMap: shardMap, shardKeyFor: shardKeyFor, detailFiles: detailFiles,
                   buildOwnedBall: buildOwnedBall, ballFromSpecs: ballFromSpecs, fillPlan: fillPlan,
                   catSpecSource: catSpecSource, setFilled: function (f) { _filled = f; },
                   apParseIssue: apParseIssue, apPages: apPages, apApplyTicks: apApplyTicks, apConflict: apConflict, apNums: apNums,
                   verifyPlan: verifyPlan, specMatch: specMatch, metricUnverified: metricUnverified, catSpecUnverified: catSpecUnverified,
                   metricScore: metricScore, parseFinish: parseFinish, rgBand: rgBand, diffBand: diffBand, coverClass: coverClass,
                   catMetric: catMetric, sheetHTML: sheetHTML, setSheet: function (x) { _sheet = x; } };

root.catCheck = catCheck;
root.catLoad = catLoad;
root.catStatus = catStatus;
root.catClear = catClear;
root._catInternals = { env: env, shouldCheck: shouldCheck, verifyAndParse: verifyAndParse,
                       hex16: hex16, readMeta: readMeta, CAT_BASE: CAT_BASE,
                       reset: function () { _rows = null; _inflight = null; } };

})(typeof window !== 'undefined' ? window : globalThis);
