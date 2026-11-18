import { gsap } from "gsap";

/*
  The other palette, through a lens.

  Hovering the word "Berkeley" opens an orb over it: inside, the same part of
  the page in the other palette, a little magnified, following the pointer.
  Clicking (or tapping) the word swells the orb over the whole screen and
  switches the site to that palette for good (it is remembered). On the home
  page the opening then plays again in the new colours.

  Two palettes, defined in site.css: "machine" (the default) and "berkeley".
*/

const KEY = "palette";
const META = { machine: "#373f43", berkeley: "#002676" };
const ICON = { machine: "/favicon.svg", berkeley: "/favicon-berkeley.svg" };

export const currentPalette = () =>
  document.documentElement.getAttribute("data-palette") === "berkeley" ? "berkeley" : "machine";
const otherPalette = () => (currentPalette() === "berkeley" ? "machine" : "berkeley");

export function setPalette(name) {
  const html = document.documentElement;
  if (name === "berkeley") html.setAttribute("data-palette", "berkeley");
  else html.removeAttribute("data-palette");
  try {
    if (name === "berkeley") localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
  } catch {
    // private windows: the switch still holds for this visit
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = META[name];
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) icon.href = ICON[name];
}

const R = () => Math.round(Math.min(150, Math.max(84, Math.min(innerWidth, innerHeight) * 0.13)));
const ZOOM = 1.16;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Wire every [data-swap] word inside `root`.
 *   onSwitch(name) — called once the site has switched (home replays the intro)
 * Returns a function that removes everything it added.
 */
export function attachSwap(root, { onSwitch } = {}) {
  let lens = null; // { el, view, rim, clone, host, word, x, y, tx, ty, r, zoom, closing }
  let busy = false;
  const pointer = { x: -1e4, y: -1e4 };

  function build(word, x, y) {
    const host = word.closest(".hero, .contact, section, footer") || root;
    const el = document.createElement("div");
    el.className = "lens";
    el.setAttribute("aria-hidden", "true");
    const view = document.createElement("div");
    view.className = "lens__view";
    view.setAttribute("data-palette", otherPalette());
    const clone = host.cloneNode(true);
    clone.removeAttribute("id");
    clone.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    clone.classList.add("lens__page");
    clone.style.width = `${host.getBoundingClientRect().width}px`;
    clone.inert = true;
    view.appendChild(clone);
    const rim = document.createElement("div");
    rim.className = "lens__rim";
    el.append(view, rim);
    document.body.appendChild(el);
    lens = { el, view, rim, clone, host, word, x, y, tx: x, ty: y, r: 0, zoom: ZOOM, closing: false };
    gsap.ticker.add(frame);
    frame();
    return lens;
  }

  // the orb stays only while the pointer is near the word; checked every frame,
  // so scrolling the word away closes it too
  const nearWord = (l) => {
    const b = l.word.getBoundingClientRect();
    const dx = Math.max(b.left - pointer.x, 0, pointer.x - b.right);
    const dy = Math.max(b.top - pointer.y, 0, pointer.y - b.bottom);
    return Math.hypot(dx, dy) <= R() * 0.85;
  };

  function frame() {
    if (!lens) return;
    const l = lens;
    if (!l.closing && !busy && !nearWord(l)) close();
    l.x += (l.tx - l.x) * 0.2;
    l.y += (l.ty - l.y) * 0.2;
    if (!l.frozen && l.host.isConnected) {
      const b = l.host.getBoundingClientRect();
      l.clone.style.transform = `translate3d(${b.left}px, ${b.top}px, 0)`;
    }
    // magnify around the centre of the orb; the clip is drawn before the zoom
    l.view.style.transformOrigin = `${l.x}px ${l.y}px`;
    l.view.style.transform = `scale(${l.zoom})`;
    l.view.style.clipPath = `circle(${Math.max(0, l.r / l.zoom)}px at ${l.x}px ${l.y}px)`;
    const d = Math.max(0, l.r) * 2;
    l.rim.style.width = l.rim.style.height = `${d}px`;
    l.rim.style.transform = `translate3d(${l.x - d / 2}px, ${l.y - d / 2}px, 0)`;
  }

  function open(word, x, y) {
    // not while the opening plays over a hidden page
    if (busy || document.documentElement.classList.contains("is-intro")) return;
    if (lens && lens.word === word && !lens.closing) return;
    if (lens) remove();
    const l = build(word, x, y);
    gsap.to(l, { r: R(), duration: 0.6, ease: "expo.out" });
  }

  function close() {
    if (!lens || lens.closing || busy) return;
    const l = lens;
    l.closing = true;
    gsap.to(l, { r: 0, duration: 0.32, ease: "power3.in", onComplete: () => lens === l && remove() });
  }

  function remove() {
    if (!lens) return;
    gsap.killTweensOf(lens);
    gsap.ticker.remove(frame);
    lens.el.remove();
    lens = null;
  }

  function swap(word, x, y) {
    if (busy) return;
    busy = true;
    const name = otherPalette();
    if (reduced()) {
      remove();
      setPalette(name);
      busy = false;
      onSwitch?.(name);
      return;
    }
    const l = lens && !lens.closing && lens.word === word ? lens : (remove(), build(word, x, y));
    l.closing = false;
    l.tx = x;
    l.ty = y;
    const far = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 4;
    gsap.killTweensOf(l);
    gsap.to(l.rim, { opacity: 0, duration: 0.5, ease: "power2.out" });
    gsap.to(l, {
      r: far,
      zoom: 1,
      duration: 0.85,
      ease: "expo.inOut",
      onComplete: () => {
        // the page underneath now matches what the orb shows
        l.frozen = true;
        setPalette(name);
        label();
        onSwitch?.(name);
        gsap.to(l.el, {
          opacity: 0,
          duration: 0.5,
          delay: 0.05,
          ease: "power2.out",
          onComplete: () => {
            if (lens === l) remove();
            busy = false;
          },
        });
      },
    });
  }

  const hit = (e) => e.target.closest?.("[data-swap]");
  const label = () =>
    root.querySelectorAll("[data-swap]").forEach((w) =>
      w.setAttribute(
        "aria-label",
        currentPalette() === "berkeley"
          ? `${w.textContent}: switch the site back to grey`
          : `${w.textContent}: switch the site to Berkeley blue and gold`
      )
    );
  label();

  const onOver = (e) => {
    const w = hit(e);
    if (!w || e.pointerType === "touch") return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    open(w, e.clientX, e.clientY);
  };
  const onMove = (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (!lens || lens.closing || busy) return;
    lens.tx = e.clientX;
    lens.ty = e.clientY;
  };
  const onClick = (e) => {
    const w = hit(e);
    if (!w) return;
    e.preventDefault();
    const b = w.getBoundingClientRect();
    const x = e.detail ? e.clientX : b.left + b.width / 2;
    const y = e.detail ? e.clientY : b.top + b.height / 2;
    swap(w, x, y);
  };
  const onLeave = () => close();

  root.addEventListener("pointerover", onOver);
  root.addEventListener("click", onClick);
  window.addEventListener("pointermove", onMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);

  return () => {
    root.removeEventListener("pointerover", onOver);
    root.removeEventListener("click", onClick);
    window.removeEventListener("pointermove", onMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    // a switch in flight finishes on its own; anything else goes now
    if (!busy) remove();
  };
}
