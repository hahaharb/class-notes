/* 서비스 워커: 한 번 열어 두면 인터넷이 없어도 필기 페이지가 열리게 파일을 저장해 둔다.
   파일을 고친 뒤에는 아래 VERSION 숫자를 올려야 기기에 새 파일이 반영된다. */
const VERSION = "notes-v6";
const FILES = [
  "notes.html", "notes.css", "notes.js", "sync.js", "manifest.json",
  "vendor/pdf.min.js", "vendor/pdf.worker.min.js",
  "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.includes("/api/")) return;   // 서버 API는 캐시하지 않는다
  // 캐시 우선. 없으면 네트워크.
  e.respondWith(caches.match(req, {ignoreSearch: true}).then(hit => hit || fetch(req)));
});
