/* =====================================================================
   BowlingDB catalog.js  -  NEW-11 Ball Catalog, step 4: manifest + cache
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

root.catCheck = catCheck;
root.catLoad = catLoad;
root.catStatus = catStatus;
root.catClear = catClear;
root._catInternals = { env: env, shouldCheck: shouldCheck, verifyAndParse: verifyAndParse,
                       hex16: hex16, readMeta: readMeta, CAT_BASE: CAT_BASE,
                       reset: function () { _rows = null; _inflight = null; } };

})(typeof window !== 'undefined' ? window : globalThis);
