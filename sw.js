/* BowlingDB service worker -- v30.224 OFF-2 (was v30.162 OFF-1, v30.167 no-cache shell).
   Lets the home-screen app open with no connection. Data is not handled
   here: games, balls and setups live on the phone (localStorage + IndexedDB),
   and the catalog keeps its own IndexedDB copy.

   App files: ONE MATCHING SET PER VERSION (OFF-2).
   index.html names its version (APP_VERSION) and lists its files and the
   version each must carry (<script id="bdb-files">). Every file is loaded as
   name.js?v=APP_VERSION. On each launch:
     1. index.html is fetched from the network (no-cache, NET_TIMEOUT).
     2. If that version's set is not saved yet, every listed file is fetched
        and checked (its *_VERSION line must match the list). Only when ALL
        arrive and match is the set marked complete.
     3. The app opens from a complete set: the new one when it finished in
        time, otherwise the newest complete set saved on the phone. A half-
        arrived update (slow network, GitHub Pages still publishing, a file
        not uploaded) therefore opens the previous version whole, and the new
        set keeps downloading in the background for the next launch.
   Files of a complete set are served from the phone (a version never changes).
   The newest KEEP_SETS complete sets are kept.

   Images: CACHE FIRST, any origin, capped at IMG_MAX (unchanged).
   Everything else (Anthropic API, catalog JSON on raw.githubusercontent,
   GitHub API) passes straight through untouched. */
var SW_VERSION = 'v30.224';
var SET_PREFIX = 'bdb-set-';
var MISC_CACHE = 'bdb-misc-v1';      // manifest + icons
var LEGACY_SHELL = 'bdb-shell-v1';   // v30.162-223 copy: used only until a complete set exists
var IMG_CACHE = 'bdb-img-v1';
var IMG_MAX = 150;
var NET_TIMEOUT = 4000;              // index.html
var SET_TIMEOUT = 9000;              // whole launch, when a complete set is there to fall back on
var KEEP_SETS = 2;
var MARK = './__bdb_set_complete__';
var MISC = ['./manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(MISC_CACHE).then(function (c) {
    return Promise.all(MISC.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k.indexOf('bdb-') === 0 && k.indexOf(SET_PREFIX) !== 0 &&
        [MISC_CACHE, IMG_CACHE, LEGACY_SHELL].indexOf(k) === -1;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function timeout(ms) {
  return new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); });
}
/* GitHub Pages sends max-age=600; 'no-cache' revalidates every launch (a cheap 304). */
function freshRequest(url) {
  try { return new Request(url, { cache: 'no-cache', credentials: 'same-origin' }); } catch (e) { return url; }
}
function reEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* What index.html says about itself, or null for an older build without the list. */
function parseIndex(text) {
  var v = /APP_VERSION\s*=\s*'([^']+)'/.exec(text);
  var m = /<script type="application\/json" id="bdb-files">([\s\S]*?)<\/script>/.exec(text);
  if (!v || !m) return null;
  try { return { v: v[1], files: JSON.parse(m[1]) }; } catch (e) { return null; }
}
function fileUrl(name, v) { return new URL('./' + name + '?v=' + encodeURIComponent(v), self.registration.scope).href; }

function setComplete(c) {
  return c.match(MARK).then(function (r) { return r ? r.json() : null; }).catch(function () { return null; });
}
/* Complete sets on the phone, newest first: [{name, v, at}] */
function completeSets() {
  return caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(SET_PREFIX) === 0; }).map(function (k) {
      return caches.open(k).then(setComplete).then(function (m) { return m ? { name: k, v: m.v, at: m.at || 0 } : null; });
    }));
  }).then(function (list) {
    return list.filter(Boolean).sort(function (a, b) { return b.at - a.at; });
  });
}
/* Keep the newest KEEP_SETS complete sets; drop older and unfinished ones (except `keep`),
   and the pre-v30.224 copy once a complete set exists. */
function prune(keep) {
  return completeSets().then(function (done) {
    var keepNames = done.slice(0, KEEP_SETS).map(function (s) { return s.name; });
    if (keep) keepNames.push(keep);
    return caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return (k.indexOf(SET_PREFIX) === 0 && keepNames.indexOf(k) === -1) || (k === LEGACY_SHELL && done.length);
      }).map(function (k) { return caches.delete(k); }));
    });
  });
}

/* Fetch and check every file of one version; mark the set complete only if all pass. */
function buildSet(info, indexText, indexHeaders) {
  var name = SET_PREFIX + info.v;
  return caches.open(name).then(function (c) {
    return setComplete(c).then(function (m) {
      if (m) return name;
      return Promise.all(Object.keys(info.files).map(function (f) {
        var url = fileUrl(f, info.v);
        return fetch(freshRequest(url)).then(function (res) {
          if (!res || !res.ok) throw new Error(f + ': HTTP ' + (res && res.status));
          var want = info.files[f];
          if (!want) return c.put(url, res);
          return res.clone().text().then(function (t) {
            if (!new RegExp("_VERSION\\s*=\\s*'" + reEsc(want) + "'").test(t)) throw new Error(f + ' on the server is not ' + want + ' yet');
            return c.put(url, res);
          });
        });
      })).then(function () {
        return c.put('./index.html', new Response(indexText, { headers: indexHeaders }));
      }).then(function () {
        return c.put(MARK, new Response(JSON.stringify({ v: info.v, at: Date.now(), sw: SW_VERSION }), { headers: { 'Content-Type': 'application/json' } }));
      }).then(function () { return prune(name); }).then(function () { return name; });
    });
  });
}
function indexFrom(name) {
  return caches.open(name).then(function (c) { return c.match('./index.html'); });
}
function htmlHeaders(res) {
  var h = new Headers();
  h.set('Content-Type', (res && res.headers.get('Content-Type')) || 'text/html; charset=utf-8');
  return h;
}

function handleNavigate(e) {
  var req = e.request;
  var fresh = completeSets().then(function (done) {
    var latest = done[0] || null;
    var net = Promise.race([fetch(freshRequest(req.url)), timeout(NET_TIMEOUT)]).then(function (res) {
      if (!res || !res.ok) throw new Error('index HTTP ' + (res && res.status));
      return res.text().then(function (text) { return { res: res, text: text, info: parseIndex(text) }; });
    });
    /* The new set, fully checked, or a rejection. Runs on after the reply. */
    var built = net.then(function (n) {
      if (!n.info) return { raw: n };                          // an older build: no list to check
      return buildSet(n.info, n.text, htmlHeaders(n.res)).then(function (name) { return { name: name, raw: n }; });
    });
    e.waitUntil(built.catch(function () {}));

    function fromLatest() {
      return latest ? indexFrom(latest.name).then(function (r) { if (r) return r; throw new Error('no index in set'); }) : Promise.reject(new Error('no complete set'));
    }
    function raw(n) { return new Response(n.text, { status: n.res.status, headers: htmlHeaders(n.res) }); }

    if (latest) {
      /* Something whole to fall back on: wait a while for the new set, else open the saved one. */
      return Promise.race([built, timeout(SET_TIMEOUT)]).then(function (b) {
        return b.name ? indexFrom(b.name) : raw(b.raw);
      }).catch(fromLatest);
    }
    /* First launch with OFF-2 (or after Fresh files): nothing complete yet. Open what the
       network gives, as v30.223 did; the set finishes in the background. Offline: the old copy. */
    return net.then(raw).catch(function () {
      return caches.open(LEGACY_SHELL).then(function (c) {
        return c.match('./index.html').then(function (h) { return h || Response.error(); });
      });
    });
  });
  e.respondWith(fresh.catch(function () { return Response.error(); }));
}

/* name.js?v=X: from set X when saved (complete or filling), else network, else anything saved. */
function handleVersioned(req, v) {
  var name = SET_PREFIX + v;
  return caches.open(name).then(function (c) {
    return c.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(freshRequest(req.url)).then(function (res) {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (h) { return h || Response.error(); });
      });
    });
  });
}

/* Unversioned same-origin files (manifest, icons, an older page's plain script tags). */
function networkFirst(req, cacheName) {
  return Promise.race([fetch(freshRequest(req.url)), timeout(NET_TIMEOUT)]).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(cacheName).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || Response.error(); });
  });
}

function trimImages(c) {
  return c.keys().then(function (keys) {
    if (keys.length <= IMG_MAX) return;
    return Promise.all(keys.slice(0, keys.length - IMG_MAX).map(function (k) { return c.delete(k); }));
  });
}
function cacheFirstImage(req) {
  return caches.open(IMG_CACHE).then(function (c) {
    return c.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        /* ok for same-site / CORS; type 'opaque' (status 0) for other sites */
        if (res && (res.ok || res.type === 'opaque')) {
          c.put(req, res.clone()).then(function () { return trimImages(c); });
        }
        return res;
      });
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  var sameOrigin = url.origin === self.location.origin;
  if (req.mode === 'navigate' && sameOrigin) { handleNavigate(e); return; }
  if (req.destination === 'image') { e.respondWith(cacheFirstImage(req)); return; }
  if (sameOrigin && /\.js$/.test(url.pathname) && url.searchParams.get('v')) {
    e.respondWith(handleVersioned(req, url.searchParams.get('v')));
    return;
  }
  if (sameOrigin && /\.(js|json|png)$/.test(url.pathname)) {
    e.respondWith(networkFirst(req, /\.js$/.test(url.pathname) ? LEGACY_SHELL : MISC_CACHE));
  }
});
