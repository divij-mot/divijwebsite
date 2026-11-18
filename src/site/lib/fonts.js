/*
  Faces: Archivo Variable (block wordmarks, self-hosted, needed by the intro),
  Newsreader (serif) and Switzer (sans), loaded without blocking first paint.
*/
let block;
let copy;

export function blockReady() {
  block ??= document.fonts
    .load('900 100px "Archivo Variable"', "DIVIJMOTWAN")
    .catch(() => {});
  return block;
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
