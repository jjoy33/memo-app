// 오프라인에서도 앱이 열리도록 화면 파일을 보관합니다.
// 인터넷이 되면 항상 최신 파일을 받아오고, 안 되면 보관본을 씁니다.
const CACHE = "memo-shell-v22";
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "config.js",
  "lib/supabase.js", "lib/591.supabase.js", "lib/purify.min.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Supabase 요청은 건드리지 않음
  e.respondWith(
    fetch(req, { cache: "no-cache" }).then((res) => {   // 항상 서버에 최신본 확인
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
  );
});
