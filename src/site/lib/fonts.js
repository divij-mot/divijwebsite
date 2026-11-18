/*
  Faces: Archivo Variable (block wordmarks, self-hosted, needed by the intro),
  Newsreader (serif) and Switzer (sans), loaded without blocking first paint.
*/
let block;
let copy;

// Safari can report a face as loaded a moment before layout sets text in it,
// and a wordmark measured in the fallback comes out far too big. So a face is
// only ready once a sample set in it is wider or narrower than the same sample
// in monospace (its own fallback here). Gives up after 3 s, e.g. if the font
// is blocked, and the wordmarks refit when it does arrive (onFontsChange).
function inUse(family) {
  if (!document.body) return false;
  const css = "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font:900 100px ";
  const a = document.createElement("span");
  const b = document.createElement("span");
  a.textContent = b.textContent = "DIVIJMOTWAN";
  a.style.cssText = `${css}${family}, monospace`;
  b.style.cssText = `${css}monospace`;
  document.body.append(a, b);
  const used = Math.abs(a.getBoundingClientRect().width - b.getBoundingClientRect().width) > 1;
  a.remove();
  b.remove();
  return used;
}
const setIn = (family) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => (inUse(family) || performance.now() - t0 > 3000 ? resolve() : setTimeout(tick, 16));
    tick();
  });

export function blockReady() {
  block ??= document.fonts
    .load('900 100px "Archivo Variable"', "DIVIJMOTWAN")
    .catch(() => {})
    .then(() => setIn('"Archivo Variable"'));
  return block;
}

/** Call `fn` whenever a face finishes loading (a late or swapped font). Returns an unsubscribe. */
export function onFontsChange(fn) {
  const fonts = document.fonts;
  if (!fonts?.addEventListener) return () => {};
  fonts.addEventListener("loadingdone", fn);
  return () => fonts.removeEventListener("loadingdone", fn);
}

function sheetsLoaded() {
  return Promise.all(
    [...document.querySelectorAll('link[rel="stylesheet"][data-fonts]')].map((l) =>
      l.sheet && l.media === "all"
        ? Promise.resolve()
        : new Promise((r) => {
            l.addEventListener("load", r, { once: true });
            setTimeout(r, 2500);
          })
    )
  );
}

export function fontsReady() {
  copy ??= Promise.all([blockReady(), sheetsLoaded()])
    .then(() => Promise.all([document.fonts.load('300 40px "Newsreader"'), document.fonts.load('300 17px "Switzer"')]))
    .catch(() => {})
    .then(() => document.fonts.ready);
  return copy;
}
