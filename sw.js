/* Офлайн-режим гида: в части залов Эрмитажа нет связи.
   Страница — сначала из сети (чтобы правки доезжали), а если сети нет или она висит — сохранённая копия.
   Шрифты и картинки — из кэша, если уже есть, иначе из сети с сохранением.
   Аудио попадает в кэш только по кнопке «Скачать гид» (это делает сама страница);
   плееру отдаём куски файла ответом 206 — без этого Safari не играет запись из кэша.
   Имена кэшей те же, что в index.html. Если файл заменили под тем же именем (перезаписали
   аудио, перегенерили картинку) — поднять версию FILES в обоих местах: старый кэш удалится,
   и гид придётся скачать заново. */
var PAGES = "guide-pages-v1", FILES = "guide-files-v1";
var SCOPE = self.registration.scope;
var NET_WAIT = 4000; /* сколько ждём сеть, прежде чем показать сохранённую страницу */

/* страницу и шрифты сохраняем сразу: даже без кнопки гид откроется в зале без сети
   (с текстами, планом и уже просмотренными картинками — только без аудио) */
self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(Promise.all([
    caches.open(PAGES).then(function (c) { return c.add(SCOPE); }),
    caches.open(FILES).then(function (c) {
      return c.addAll(["fonts/manrope-cyrillic.woff2", "fonts/manrope-latin.woff2", "fonts/unbounded-cyrillic.woff2", "fonts/unbounded-latin.woff2"]);
    })
  ]).catch(function () {}));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k.indexOf("guide-") === 0 && k !== PAGES && k !== FILES;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  var path = url.href.split(/[?#]/)[0], isPage = path === SCOPE || path === SCOPE + "index.html";
  if (req.mode === "navigate") { if (isPage) e.respondWith(page(e)); return; }
  if (isPage) return; /* страница сама скачивает себя кнопкой — пусть берёт свежую из сети, не из кэша */
  if (/\/audio\/[^/]+$/.test(url.pathname)) { e.respondWith(audio(req)); return; }
  e.respondWith(file(req));
});

function page(e) {
  return caches.open(PAGES).then(function (c) {
    var net = fetch(e.request).then(function (r) {
      if (r.ok) return c.put(SCOPE, r.clone()).then(function () { return r; }, function () { return r; });
      return r;
    });
    e.waitUntil(net.catch(function () {}));
    var wait = new Promise(function (res) { setTimeout(res, NET_WAIT); });
    return Promise.race([net.catch(function () {}), wait]).then(function (r) {
      return r || c.match(SCOPE).then(function (hit) { return hit || net; });
    });
  });
}

function file(req) {
  return caches.open(FILES).then(function (c) {
    return c.match(req, { ignoreVary: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (r) {
        if (r.ok && r.status === 200) c.put(req, r.clone()).catch(function () {});
        return r;
      }, function (err) {
        return similar(c, req.url).then(function (alt) { if (alt) return alt; throw err; });
      });
    });
  });
}

/* без сети нужного размера картинки нет — отдаём тот, что сохранён (например, увеличение → карточка).
   Миниатюру ленты (s) вместо картины не подставляем: она обрезана */
var SIZES = { works: ["l", "m", "z"], hero: ["m", "d", "lo"] };
function similar(c, href) {
  var m = /\/images\/(works|hero)\/(\d+)-(\w+)\.webp$/.exec(href);
  if (!m) return Promise.resolve();
  return SIZES[m[1]].filter(function (s) { return s !== m[3]; }).reduce(function (p, s) {
    return p.then(function (hit) {
      return hit || c.match(href.replace(/-\w+\.webp$/, "-" + s + ".webp"), { ignoreVary: true });
    });
  }, Promise.resolve());
}

function audio(req) {
  return caches.open(FILES).then(function (c) {
    return c.match(req.url, { ignoreVary: true });
  }).then(function (hit) {
    if (!hit) return fetch(req);
    var range = req.headers.get("range");
    if (!range) return hit;
    return hit.blob().then(function (blob) {
      var size = blob.size, m = /bytes=(\d*)-(\d*)/.exec(range) || [], start, end;
      if (m[1]) { start = +m[1]; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; }
      else if (m[2]) { start = Math.max(0, size - m[2]); end = size - 1; } /* bytes=-500: последние 500 байт */
      else { start = 0; end = size - 1; }
      if (start >= size || start > end) {
        return new Response("", { status: 416, headers: { "Content-Range": "bytes */" + size } });
      }
      return new Response(blob.slice(start, end + 1), {
        status: 206,
        statusText: "Partial Content",
        headers: {
          "Content-Type": hit.headers.get("Content-Type") || "audio/mpeg",
          "Content-Range": "bytes " + start + "-" + end + "/" + size,
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes"
        }
      });
    });
  });
}
