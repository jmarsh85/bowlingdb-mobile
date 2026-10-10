/* BowlingDB service worker -- v30.162 OFF-1, v30.167 no-cache shell (design rev 7, sec 14).
   Lets the home-screen app open with no connection. Data is not handled
   here: games, balls and setups already live on the phone (localStorage
   + IndexedDB), and the catalog keeps its own IndexedDB copy.

   App shell (index.html, devkit.js, report.js, catalog.js, manifest,
   icons): NETWORK FIRST. Online always gets the latest and refreshes the
   saved copy; offline -- or a network slower than NET_TIMEOUT -- opens
   the saved copy. So updates still arrive and the app is never pinned to
   an old build.

   Images: CACHE FIRST, any origin. The first load keeps a copy; after
   that it is served from the phone, online or not. Cross-site images
   are stored as opaque responses (the page never reads their bytes), so
   the cache is capped at IMG_MAX entries, oldest out first.

   Everything else (Anthropic API, catalog JSON on raw.githubusercontent)
   passes straight through untouched.

   Bump SHELL_VER only if the shell file list changes; content updates
   need no bump because the shell is network-first. */
var SHELL_VER = 'bdb-shell-v1';
var IMG_CACHE = 'bdb-img-v1';
var IMG_MAX = 150;
var NET_TIMEOUT = 4000;
var SHELL = ['./', './index.html', './devkit.js', './report.js', './catalog.js',
             './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL_VER).then(function (c) {
    /* One missing file must not fail the whole install. */
    return Promise.all(SHELL.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k.indexOf('bdb-') === 0 && k !== SHELL_VER && k !== IMG_CACHE;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function timeout(ms) {
  return new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); });
}
/* v30.167: shell requests skip the browser's HTTP cache. GitHub Pages serves
   files with max-age=600, so a plain fetch could hand back the previous upload
   for up to 10 minutes after a deploy. 'no-cache' revalidates with GitHub
   every online launch (a cheap 304 when nothing changed). */
function freshRequest(req) {
  try { return new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }); } catch (e) { return req; }
}
function networkFirst(req, key) {
  return Promise.race([fetch(freshRequest(req)), timeout(NET_TIMEOUT)]).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(SHELL_VER).then(function (c) { c.put(key || req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.open(SHELL_VER).then(function (c) {
      return c.match(key || req, { ignoreSearch: true }).then(function (hit) {
        return hit || c.match('./index.html').then(function (h2) { return h2 || Response.error(); });
      });
    });
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
  if (req.mode === 'navigate' && sameOrigin) {
    e.respondWith(networkFirst(req, './index.html'));
    return;
  }
  if (req.destination === 'image') {
    e.respondWith(cacheFirstImage(req));
    return;
  }
  if (sameOrigin && /\.(js|json|png)$/.test(url.pathname)) {
    e.respondWith(networkFirst(req));
  }
});
