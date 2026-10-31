/* 서비스 워커 — 정적 자원을 캐시해 두 번째 방문부터 오프라인에서도 열리게 한다.
   자원을 수정하면 CACHE 버전을 올려야 새 파일이 반영된다. */
const CACHE = 'problem-rec-v1';

/* 상대 경로로 적어야 GitHub Pages의 하위 경로(/저장소이름/)에서도 동작한다 */
const ASSETS = [
  './',
  './index.html',
  './assets/style.css',
  './assets/data.js',
  './assets/algorithm.js',
  './assets/app.js',
  './icon.svg',
  './manifest.webmanifest'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      /* 하나라도 실패하면 설치가 통째로 깨지므로 개별적으로 담는다 */
      .then(function (c) { return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      ); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;

  /* 웹폰트는 캐시 우선, 실패해도 그냥 넘어간다 (없어도 시스템 폰트로 렌더링됨) */
  if (req.url.indexOf('fonts.googleapis.com') >= 0 || req.url.indexOf('fonts.gstatic.com') >= 0) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        }).catch(function () { return new Response('', { status: 504 }); });
      })
    );
    return;
  }

  /* 자체 자원은 캐시 우선, 없으면 네트워크에서 받아 캐시에 넣는다 */
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        /* 페이지 요청이 실패하면 캐시된 첫 화면으로 대체 */
        return caches.match('./index.html');
      });
    })
  );
});
