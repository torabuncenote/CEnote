/* Service Worker — CEnote PWA */
var CACHE = 'cenote-v4';
var SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg'
];

/* Firebase Messaging バックグラウンド通知 */
try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
  if (!firebase.apps.length) {
    firebase.initializeApp({
      apiKey: 'AIzaSyA3-4YOQxnnlEXtMZXfoAtHUs_ZN3DtG6k',
      authDomain: 'torabunce-ce814.firebaseapp.com',
      databaseURL: 'https://torabunce-ce814-default-rtdb.asia-southeast1.firebasedatabase.app',
      projectId: 'torabunce-ce814',
      storageBucket: 'torabunce-ce814.firebasestorage.app',
      messagingSenderId: '187211496263',
      appId: '1:187211496263:web:7d902d76cbb710ed0a6a62'
    });
  }
  firebase.messaging().onBackgroundMessage(function(payload) {
    var notif = payload.notification || {};
    self.registration.showNotification(notif.title || '分院CE連絡表', {
      body: notif.body || '',
      icon: '/icon-192.svg',
      badge: '/icon-192.svg',
      tag: 'cenote-duty',
      requireInteraction: true,
      data: payload.data || {}
    });
  });
} catch(e) {
  console.warn('[sw] FCM init:', e);
}

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(self.location.origin) === 0) {
          return list[i].focus();
        }
      }
      return clients.openWindow('/');
    })
  );
});

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
