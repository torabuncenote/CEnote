/* Service Worker — CEnote PWA */
var CACHE = 'cenote-v6';
var SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg'
];
/* 起動に必要な外部の部品（版番号つきのURLなので中身は変わらない）。災害時にネットが無くても
   アプリを開けるよう、入れたときに端末へ保存しておく（2026-10-21 災害モード段2） */
var CDN_SHELL = [
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js',
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/@emailjs/browser@4.4.1/dist/email.min.js'
];
/* 外部の部品（ライブラリ・フォント）。保存してあればそれを使い、無ければ取りに行って保存する */
var CDN_RE = /^https:\/\/(www\.gstatic\.com\/firebasejs\/|cdnjs\.cloudflare\.com\/|cdn\.jsdelivr\.net\/|fonts\.googleapis\.com\/|fonts\.gstatic\.com\/)/;

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
    caches.open(CACHE).then(function(c) {
      /* 外部の部品は1つ取れなくても入れ直しを止めない（scriptタグと同じ no-cors で取って保存） */
      var cdn = CDN_SHELL.map(function(u){
        return fetch(u, { mode: 'no-cors' }).then(function(res){ return c.put(u, res); }).catch(function(){});
      });
      return Promise.all([c.addAll(SHELL)].concat(cdn));
    })
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
  if (e.request.method === 'GET' && CDN_RE.test(url)) {
    e.respondWith(
      caches.match(e.request).then(function(hit) {
        return hit || fetch(e.request).then(function(res) {
          if (res && (res.ok || res.type === 'opaque')) { var cl = res.clone(); caches.open(CACHE).then(function(c){ c.put(e.request, cl); }); }
          return res;
        });
      })
    );
    return;
  }
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
      /* オフライン：保存してある分を返す。?preview=1 などの付いたURLや、ルート（/CEnote/）を開いたときも
         index.html を返せるよう、検索部分を無視し、画面の読み込みなら index.html にする */
      return caches.match(e.request, { ignoreSearch: true }).then(function(hit) {
        if (hit) return hit;
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return undefined;
      });
    })
  );
});
