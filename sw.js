/* Service Worker — CEnote PWA */
var CACHE = 'cenote-v1';
var SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) { return c.addAll(SHELL); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

/* ネットワーク優先・失敗時にキャッシュにフォールバック */
self.addEventListener('fetch', function(e) {
  /* Firebase / CDN リクエストはキャッシュしない（認証トークンが絡むため） */
  var url = e.request.url;
  if (url.indexOf('firebaseio.com') !== -1 ||
      url.indexOf('firebase') !== -1 ||
      url.indexOf('googleapis.com') !== -1 ||
      url.indexOf('gstatic.com') !== -1) {
    return;
  }
  e.respondWith(
    fetch(e.request).then(function(res) {
      /* 同一オリジンの成功レスポンスはキャッシュを更新 */
      if (res.ok && e.request.url.indexOf(self.location.origin) === 0) {
        var clone = res.clone();
        caches.open(CACHE).then(function(c){ c.put(e.request, clone); });
      }
      return res;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});
