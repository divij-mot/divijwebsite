/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless = true;
if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", (e) => {
    if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
    e.respondWith(
      fetch(e.request).then((r) => {
        if (r.status === 0 || r.status === 204 || r.status === 304) return r;
        const headers = new Headers(r.headers);
        headers.set("Cross-Origin-Embedder-Policy", coepCredentialless ? "credentialless" : "require-corp");
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
      }).catch((err) => { console.error(err); return new Response("Service Worker fetch error", { status: 500 }); })
    );
  });
} else {
  (() => {
    if (window.crossOriginIsolated) return;
    navigator.serviceWorker
      .register(window.document.currentScript.src)
      .then((r) =>
        new Promise((resolve) => {
          const worker = r.installing || r.waiting || r.active;
          if (worker.state === "activated") resolve();
          else worker.addEventListener("statechange", () => { if (worker.state === "activated") resolve(); });
        })
      )
      .then(() => { if (!window.crossOriginIsolated) window.location.reload(); });
  })();
}
