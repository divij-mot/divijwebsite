/*
  Block wordmarks (DIVIJ, MOTWANI): Archivo Variable, Black, expanded.

  Splitting a word into letters drops the font's kerning, so every gap is set
  by eye-rules instead: measure each pair's ink gap and size it by the shapes
  that meet there (straight sides need the most air, round less, diagonals and
  the T's overhang least). Words then run edge to edge on their ink, not their
  box.
*/

export const BLOCK_FONT = '900 100px "Archivo Variable"';

const probe = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;

function setProbe() {
  probe.font = BLOCK_FONT;
  if ("fontStretch" in probe) probe.fontStretch = "expanded";
}

export function ink(ch) {
  if (!probe || !("fontStretch" in probe)) return { l: 0, r: 0 };
  setProbe();
  const m = probe.measureText(ch);
  return { l: -m.actualBoundingBoxLeft / 100, r: (m.width - m.actualBoundingBoxRight) / 100 };
}

const SIDE = {
  D: [1, 0.7], I: [1, 1], V: [0.35, 0.35], J: [0.55, 1], M: [1, 1],
  O: [0.7, 0.7], T: [0.3, 0.3], W: [0.35, 0.35], A: [0.35, 0.35], N: [1, 1],
};
const GAP = 0.07; // em, between two straight stems

/** Wrap each letter of a [data-word] element in a span. */
export function splitWord(el) {
  el.innerHTML = [...el.dataset.word].map((ch) => `<span class="ch">${ch}</span>`).join("");
}

export function kernWord(el) {
  if (!probe || !("fontStretch" in probe)) return;
  setProbe();
  const w = el.dataset.word;
  const cs = getComputedStyle(el);
  const ls = parseFloat(cs.letterSpacing) / parseFloat(cs.fontSize) || 0;
  const sb = [...w].map((c) => {
    const m = probe.measureText(c);
    return { lsb: -m.actualBoundingBoxLeft / 100, rsb: (m.width - m.actualBoundingBoxRight) / 100 };
  });
  [...el.children].forEach((ch, i) => {
    const b = w[i + 1];
    if (!b) return;
    const target = (GAP * ((SIDE[w[i]]?.[1] ?? 1) + (SIDE[b]?.[0] ?? 1))) / 2;
    ch.style.marginRight = `${target - sb[i].rsb - ls - sb[i + 1].lsb}em`;
  });
}

/** Size a wordmark so its ink spans `target` px exactly. Returns a restore fn for --wdth. */
export function fitWord(el, target) {
  const prev = el.style.getPropertyValue("--wdth");
  el.style.setProperty("--wdth", "125");
  el.style.marginLeft = "0px";
  el.style.fontSize = "100px";
  const box = el.getBoundingClientRect().width / 100;
  const ls = parseFloat(getComputedStyle(el).letterSpacing) / 100;
  const word = el.dataset.word;
  const l = ink(word[0]).l;
  const r = ink(word[word.length - 1]).r;
  el.style.fontSize = `${target / (box - l - r - ls)}px`;
  el.style.marginLeft = `${-l}em`;
  return () => (prev ? el.style.setProperty("--wdth", prev) : el.style.removeProperty("--wdth"));
}

export function gutter() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--gutter-px")) || Math.min(32, Math.max(16, window.innerWidth * 0.02));
}

/**
 * The page grid hangs off the first I of DIVIJ: the second column starts at
 * its stem. Measured on the hero wordmark when there is one, otherwise on a
 * hidden copy, so every page shares the same axis.
 */
export function setAxis(heroWord) {
  const root = document.documentElement;
  if (window.innerWidth <= 760) {
    root.style.removeProperty("--axis");
    return;
  }
  let el = heroWord;
  let tmp = null;
  if (!el) {
    tmp = document.createElement("span");
    tmp.className = "word";
    tmp.dataset.word = "DIVIJ";
    tmp.setAttribute("aria-hidden", "true");
    tmp.style.cssText = "position:absolute;left:0;top:-9999px;visibility:hidden;pointer-events:none";
    splitWord(tmp);
    document.body.appendChild(tmp);
    kernWord(tmp);
    el = tmp;
  }
  const inner = root.clientWidth - 2 * gutter();
  const restore = fitWord(el, inner);
  const elLeft = tmp ? -tmp.getBoundingClientRect().left + gutter() : 0;
  const x = el.children[1].getBoundingClientRect().left + elLeft;
  const size = parseFloat(getComputedStyle(el).fontSize);
  root.style.setProperty("--axis", `${x + ink("I").l * size}px`);
  restore();
  tmp?.remove();
}
