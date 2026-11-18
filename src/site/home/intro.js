import { gsap } from "gsap";

/*
  Intro
  ─────
  1. Wake      A dark flip-disc board, seen low and at an angle. An orange cube
               tumbles in from the lower left along the word's own diagonal:
               a heavy roll or two, then quicker and quicker until it streaks
               off the top-right. Every disc it passes flips, and the flipping
               runs out from its path in a tight V behind it — one thin orange
               seam at the front — turning the board to the scene: a blue field,
               DIVIJ cut out of it in black, D first. The camera settles flat.
  2. Resolve   The discs flip away onto the crisp scene, out from where the
               cube came in.
  3. Sweep     Black bands run diagonally across the word, inverting it to
               white, each led by a hairline of orange. The last one covers it.
  4. Settle    Straight off the last band, the word swings level and lands as
               the hero wordmark.
*/

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgb3 = (n) => css(n).split(/[\s,]+/).map(Number);
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// disc faces
const EMPTY = 0;
const FIELD = 2;
const LETTER = 3;
const EDGE = 4;

const HOLD = 0.05; // first paint → the cube, at the soonest

// ── the tumble ────────────────────────────────────────────────
const R0 = 0.17; // the first roll
const Q = 0.65; // each roll Q× the one before…
const FLOOR = 0.0036; // …down to this: a streak
const SLOW = 0.1; // rolls this long or longer land with weight

// ── the wake ──────────────────────────────────────────────────
// The front runs at KAPPA × the cube's speed, so the cube is always at its tip
// and the wake trails it in a V of half-angle asin(KAPPA). Once the cube is
// gone the front keeps gathering pace until the board is turned.
const KAPPA = 0.22;
const V_MIN = 3; // cells per second: the first heavy rolls still stir the board
const V_MAX = 1.5; // screen diagonals per second
const GROW = 2; // e-folds per second, after the cube is gone

// a disc meeting the front: a glint edge-on, then it opens onto the scene
const GLINT = [1 / 60, 0.045]; // ~one cell of front
const OPEN = [0.035, 0.15]; // ~three cells of front, with grain
const HG = 0.24; // the glint, as a fraction of a disc
const FLIP = 0.1; // a disc turning over as the word drifts
const GONE = 0.16; // a disc flipping away onto the crisp scene

// ── the camera ────────────────────────────────────────────────
// It starts low and askew at first paint and comes down flat as the wake
// passes; the dark board is the establishing shot while the fonts arrive.
const CAM = { rotationX: 24, rotationZ: -4, scale: 1.15 };
const CAM_T = 2.1;
const camEase = gsap.parseEase("power2.out");

export function runIntro({ heroWord, fontsReady, onReveal }) {
  return new Promise((resolve) => {
    const root = document.querySelector(".intro");
    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      onReveal?.();
    };
    let ended = false;
    let tl = null;
    const $ = (s) => root.querySelector(s);
    const $$ = (s) => [...root.querySelectorAll(s)];

    $(".intro__bar")?.remove();
    const board = $(".intro__board");
    const stage = $(".intro__stage");
    const bg = $(".intro__bg");
    const sliver = $(".intro__sliver");
    const bands = $(".intro__bands");
    const rigs = $$(".intro__rig");
    const words = $$(".intro__word");
    const [rigA] = rigs;

    const INK = css("--ink");
    const WHITE = css("--white");
    const BLUE = css("--blue");
    const ORANGE = css("--orange");
    const COL = [INK, WHITE, BLUE, INK, ORANGE];
    const CUBE_LIT = rgb3("--cube-lit").join(",");
    const CUBE_SHADE = rgb3("--cube-shade").join(",");

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Everything below is laid out for this width. If it changes mid-intro (an
    // in-app browser handing the page over, a window still settling), the word
    // would play at the wrong size and off screen: cut straight to the page.
    function end() {
      if (ended) return;
      ended = true;
      window.removeEventListener("resize", onWidth);
      heroWord.style.visibility = "visible";
      root.remove();
      if (import.meta.env.DEV && window.__intro) window.__intro.doneAt = performance.now();
      resolve();
    }
    function onWidth() {
      if (ended || Math.abs(window.innerWidth - vw) < 8) return;
      gsap.ticker.remove(tick);
      load.kill();
      camIn.kill();
      breath.kill();
      tl?.kill();
      reveal();
      end();
    }
    window.addEventListener("resize", onWidth);
    board.width = Math.round(vw * dpr);
    board.height = Math.round(vh * dpr);
    const ctx = board.getContext("2d");

    // one camera over the board and the crisp scene beneath it, so the
    // resolve lines up whatever the angle
    const cam = document.createElement("div");
    cam.style.cssText = "position:absolute;inset:0;transform-origin:50% 50%;will-change:transform";
    root.insertBefore(cam, stage);
    cam.append(stage, board);
    const persp = Math.round(Math.max(vw, vh) * 1.5);
    root.style.perspective = `${persp}px`;
    // the smallest opening scale that keeps the frame covered once the wake
    // is out (before that the dark board is vignetted, so its edges never show)
    const covered = (s1) => {
      for (let r = 0.05; r <= 0.6; r += 0.05) {
        const ax = rad(CAM.rotationX * r);
        const az = rad(CAM.rotationZ * r);
        const sc = 1 + (s1 - 1) * r;
        const quad = [
          [-vw / 2, -vh / 2],
          [vw / 2, -vh / 2],
          [vw / 2, vh / 2],
          [-vw / 2, vh / 2],
        ].map(([x, y]) => {
          x *= sc;
          y *= sc;
          const z = y * Math.sin(ax);
          y *= Math.cos(ax);
          [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
          const f = persp / (persp - z);
          return [x * f, y * f];
        });
        // every corner of the frame inside the projected board
        for (const [px, py] of quad.map((_, i) => [(i % 3 ? 1 : -1) * vw * 0.5, (i < 2 ? -1 : 1) * vh * 0.5])) {
          for (let i = 0; i < 4; i++) {
            const [ax2, ay2] = quad[i];
            const [bx, by] = quad[(i + 1) % 4];
            if ((bx - ax2) * (py - ay2) - (by - ay2) * (px - ax2) < 0) return false;
          }
        }
      }
      return true;
    };
    let camS = CAM.scale;
    while (!covered(camS) && camS < 1.6) camS += 0.01;
    const camP = { p: 0 };
    const shoot = () => {
      const r = 1 - camEase(camP.p);
      gsap.set(cam, { rotationX: CAM.rotationX * r, rotationZ: CAM.rotationZ * r, scale: 1 + (camS - 1) * r });
    };
    shoot();

    // ── board geometry ───────────────────────────────────────
    const C = Math.round(gsap.utils.clamp(vh > vw ? 9 : 16, 30, Math.min(vw, vh * 1.6) / 46));
    const I = Math.ceil((vw / 2 - C / 2) / C);
    const J = Math.ceil((vh / 2 - C / 2) / C);
    const cols = 2 * I + 1;
    const rows = 2 * J + 1;
    const N = cols * rows;
    const X0 = vw / 2 - C / 2 - I * C;
    const Y0 = vh / 2 - C / 2 - J * C;
    const G0 = Math.max(2, Math.round(C * 0.09));
    let G = G0; // the gap between discs: it closes just before the resolve
    let S = C - G; // a disc

    const face = new Uint8Array(N); // a disc's settled face
    const next = new Uint8Array(N);
    const target = new Uint8Array(N); // the scene behind it, sampled
    const live = new Uint8Array(N); // 0 dark · 1 meeting the front · 2 turned
    const fT = new Float32Array(N).fill(-1);
    const fD = new Float32Array(N);
    const wake = new Float32Array(N).fill(Infinity); // when the front reaches it
    const glint = new Float32Array(N);
    const opn = new Float32Array(N);
    const gone = new Float32Array(N).fill(-1); // when it flips away to the crisp scene


    // the dark faces, barely there: enough to show the board and its angle
    const lit = { a: 0 };
    const [o0, o1, o2] = rgb3("--board-off");
    const [w0, w1, w2] = rgb3("--glow-dim");
    const OFF = `rgb(${o0},${o1},${o2})`;
    // the cube lights the dark discs around it
    const glow = { x: -1e4, y: -1e4, r: C * 5 };
    const WARM = Array.from({ length: 9 }, (_, i) => {
      const f = (i / 8) ** 1.4;
      return `rgb(${Math.round(o0 + (w0 - o0) * f)},${Math.round(o1 + (w1 - o1) * f)},${Math.round(o2 + (w2 - o2) * f)})`;
    });
    const vig = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      const dx = (X0 + (n % cols) * C + C / 2 - vw / 2) / (vw / 2);
      const dy = (Y0 + ((n / cols) | 0) * C + C / 2 - vh / 2) / (vh / 2);
      const d = Math.hypot(dx * 0.85, dy) / 1.25;
      vig[n] = 1 - clamp01((d - 0.45) / 0.55) ** 1.5;
    }

    // a soft bloom for the seam
    const BR = C * 1.6;
    const bloom = document.createElement("canvas");
    bloom.width = bloom.height = Math.ceil(BR * 2 * dpr);
    {
      const b = bloom.getContext("2d");
      const r = bloom.width / 2;
      const g = b.createRadialGradient(r, r, 0, r, r, r);
      const [g0, g1, g2] = rgb3("--glow");
      g.addColorStop(0, `rgba(${g0},${g1},${g2},0.55)`);
      g.addColorStop(0.35, `rgba(${g0},${Math.round(g1 * 0.82)},${Math.round(g2 * 0.78)},0.16)`);
      g.addColorStop(1, `rgba(${g0},${Math.round(g1 * 0.82)},${Math.round(g2 * 0.78)},0)`);
      b.fillStyle = g;
      b.fillRect(0, 0, bloom.width, bloom.height);
    }
    const seam = [];

    function paint(now) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = INK;
      ctx.fillRect(0, 0, vw, vh);
      seam.length = 0;
      for (let k = 0; k < N; k++) {
        const cx = X0 + (k % cols) * C;
        const cy = Y0 + ((k / cols) | 0) * C;
        let f;
        let h = 1;
        if (gone[k] >= 0 && now >= gone[k]) {
          // flipping away: the cell opens onto the scene beneath
          if (live[k] < 2) {
            live[k] = 2;
            face[k] = target[k];
          }
          ctx.clearRect(cx, cy, C, C);
          const p = (now - gone[k]) / GONE;
          if (p >= 0.5) continue;
          h = Math.cos(p * Math.PI);
          f = face[k];
        } else if (live[k] < 2) {
          const q = now - wake[k];
          if (!(q >= 0)) {
            if (lit.a > 0) {
              const dx = cx + C / 2 - glow.x;
              const dy = cy + C / 2 - glow.y;
              const w = 1 - Math.sqrt(dx * dx + dy * dy) / glow.r;
              ctx.globalAlpha = w > 0 ? Math.max(lit.a * vig[k], w) : lit.a * vig[k];
              ctx.fillStyle = w > 0 ? WARM[Math.round(w * w * 8)] : OFF;
              ctx.fillRect(cx + G / 2, cy + G / 2, S, S);
              ctx.globalAlpha = 1;
            }
            continue;
          }
          if (!live[k]) {
            live[k] = 1;
            next[k] = target[k];
          }
          if (q < glint[k]) {
            // edge-on: the dark face has turned away, the scene not yet round
            f = EDGE;
            h = HG;
            seam.push(k);
          } else if (q < glint[k] + opn[k]) {
            const x = (q - glint[k]) / opn[k];
            h = HG + (1 - HG) * (1 - (1 - x) ** 3);
            f = next[k];
          } else {
            live[k] = 2;
            face[k] = f = next[k];
          }
        } else {
          f = face[k];
          if (fT[k] >= 0) {
            const p = (now - fT[k]) / fD[k];
            if (p >= 1) {
              face[k] = f = next[k];
              fT[k] = -1;
            } else if (p > 0) {
              h = Math.abs(Math.cos(p * Math.PI));
              f = p < 0.5 ? face[k] : next[k];
              if (h < 0.42) f = EDGE;
            }
          }
        }
        if (f === EMPTY || (f === LETTER && G > 0.5)) continue;
        ctx.fillStyle = COL[f];
        ctx.fillRect(cx + G / 2, cy + G / 2 + (S * (1 - h)) / 2, S, S * h);
      }
      if (seam.length) {
        ctx.globalCompositeOperation = "lighter";
        for (const k of seam) {
          const cx = X0 + (k % cols) * C + C / 2;
          const cy = Y0 + ((k / cols) | 0) * C + C / 2;
          ctx.drawImage(bloom, cx - BR, cy - BR, BR * 2, BR * 2);
        }
        ctx.globalCompositeOperation = "source-over";
      }
    }


    // ── before the fonts: the dark board, the camera already moving ──
    // (if they are slow, the board breathes)
    let pre = true;
    const tick = () => {
      if (pre) paint(-1);
    };
    gsap.ticker.add(tick);
    gsap.to(lit, { a: 1, duration: 0.18, ease: "sine.out" });
    const camIn = gsap.to(camP, { p: 1, duration: CAM_T, ease: "none", onUpdate: shoot });
    const breath = gsap.to(lit, { a: 0.45, duration: 0.7, ease: "sine.inOut", repeat: -1, yoyo: true, paused: true });

    let fontsIn = false;
    fontsReady.then(() => (fontsIn = true));
    const load = gsap.timeline({ onUpdate: tick });
    load.to({}, { duration: HOLD }).add(() => {
      if (!fontsIn) gsap.delayedCall(0.6, () => !fontsIn && breath.play());
    });
    if (import.meta.env.DEV) {
      window.__intro = { load, gsap, t0: performance.now() };
      fontsReady.then(() => (window.__intro.fontsAt = performance.now()));
    }

    Promise.all([load.then(), fontsReady]).then(() => !ended && open());

    // ─────────────────────────────────────────────────────────
    // 1–4 · Wake → scene → settle
    // ─────────────────────────────────────────────────────────
    function open() {
      const portrait = vh > vw;
      const theta = gsap.utils.clamp(11, 38, deg(Math.atan2(vh, vw)) * 0.55);
      const co = Math.cos(rad(theta));
      const si = Math.sin(rad(theta));

      // fit the word along the diagonal
      words.forEach((w) => (w.style.fontSize = "100px"));
      const w100 = words[0].offsetWidth;
      const h100 = words[0].offsetHeight;
      const F =
        100 *
        Math.min((vw * (portrait ? 0.96 : 0.9)) / (w100 * co + h100 * si), (vh * 0.84) / (w100 * si + h100 * co));
      words.forEach((w) => (w.style.fontSize = `${F}px`));

      const SKEW = -9;
      gsap.set(rigs, { xPercent: -50, yPercent: -50, rotation: -theta });
      gsap.set(words, { skewX: SKEW });

      // letter geometry, read from layout (transform-free)
      const w0 = words[0];
      const W = w0.offsetWidth;
      const H = w0.offsetHeight;
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      w0.appendChild(probe);
      const base = probe.offsetTop;
      probe.remove();
      const chars = [...w0.children];
      const ls = parseFloat(getComputedStyle(w0).letterSpacing) || 0;

      // offscreen scene, sampled once per disc
      const SS = 3;
      const off = document.createElement("canvas");
      off.width = cols * SS;
      off.height = rows * SS;
      const o2 = off.getContext("2d", { willReadFrequently: true });
      o2.font = `900 ${F}px "Archivo Variable"`;
      if ("fontStretch" in o2) o2.fontStretch = "expanded";
      const glyphs = chars.map((el) => ({
        ch: el.textContent,
        x: el.offsetLeft,
        sx: (el.offsetWidth - ls) / o2.measureText(el.textContent).width,
      }));
      const k = SS / C;
      const sk = Math.tan(rad(SKEW));

      // shared state → DOM and board read the same numbers
      const D = vw * 0.03;
      const sc = { x: -D * co, y: D * si };
      const sync = () => gsap.set(rigs, { x: sc.x, y: sc.y });

      let sampled = "";
      function sample() {
        const key = `${sc.x},${sc.y}`;
        if (key === sampled) return;
        sampled = key;
        // a black-on-white mask, whatever the palette: dark pixels are letters
        o2.setTransform(1, 0, 0, 1, 0, 0);
        o2.fillStyle = "#ffffff";
        o2.fillRect(0, 0, off.width, off.height);
        o2.setTransform(k, 0, 0, k, -X0 * k, -Y0 * k);
        o2.translate(vw / 2 + sc.x, vh / 2 + sc.y);
        o2.rotate(rad(-theta));
        o2.transform(1, 0, sk, 1, 0, 0);
        o2.fillStyle = "#000000";
        glyphs.forEach((gl) => {
          o2.save();
          o2.translate(gl.x - W / 2, base - H / 2);
          o2.scale(gl.sx, 1);
          o2.fillText(gl.ch, 0, 0);
          o2.restore();
        });
        const px = o2.getImageData(0, 0, off.width, off.height).data;
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const p = ((j * SS + 1) * off.width + (i * SS + 1)) * 4;
            // a cell is a letter once the glyph covers about half of it (as before, on blue and black)
            target[j * cols + i] = px[p] + px[p + 1] + px[p + 2] < 398 ? LETTER : FIELD;
          }
        }
      }

      // ── the cube's path: through the middle of the word, D to J ──
      const L = Math.max(S, vw * 0.024, 12); // the cube
      const ux = co; // along the word, up and to the right
      const uy = -si;
      const nx = si; // across it, downward
      const ny = co;
      const cap = o2.measureText(w0.dataset.word || "DIVIJ").actualBoundingBoxAscent || F * 0.7;
      const floor = base - H / 2 - cap / 2 + L / 2;
      const ox = vw / 2 + sc.x + nx * floor;
      const oy = vh / 2 + sc.y + ny * floor;
      // the stretch of the floor line inside the frame, inset by pad
      const span = (pad) => {
        let lo = -Infinity;
        let hi = Infinity;
        for (const [o, d, max] of [
          [ox, ux, vw],
          [oy, uy, vh],
        ]) {
          if (Math.abs(d) < 1e-6) continue;
          let a = (pad - o) / d;
          let b = (max - pad - o) / d;
          if (a > b) [a, b] = [b, a];
          lo = Math.max(lo, a);
          hi = Math.min(hi, b);
        }
        return [lo, hi];
      };
      // enter just outside what the low camera sees; leave well clear
      const s0 = span(Math.min(vw, vh) * 0.07)[0] + L * 0.4;
      const sEnd = span(-2 * L)[1];
      const sOut = span(-L)[1];

      const rolls = [];
      for (let kk = 0, t = 0; s0 + kk * L < sEnd; kk++) {
        const d = Math.max(FLOOR, R0 * Q ** kk);
        rolls.push({ t, d, w: clamp01((d - FLOOR) / (SLOW - FLOOR)) ** 0.8 });
        t += d;
      }
      const last = rolls[rolls.length - 1];
      const tGone = last.t + last.d;
      const kExit = Math.max(0, rolls.findIndex((_, kk) => s0 + kk * L >= sOut));
      const tExit = kExit > 0 ? rolls[kExit].t : tGone;

      const heavy = (u) => u * u * (3 - 2 * u);
      function rollAt(t) {
        if (t <= 0) return { k: 0, e: 0 };
        if (t >= tGone) return { k: rolls.length, e: 0 };
        let kk = 0;
        while (kk < rolls.length - 1 && t >= rolls[kk + 1].t) kk++;
        const r = rolls[kk];
        const u = (t - r.t) / r.d;
        return { k: kk, e: r.w * heavy(u) + (1 - r.w) * u };
      }

      // where the cube is, for its light
      function cubeAt(t) {
        if (t < 0 || t >= tGone) return { x: -1e4, y: -1e4 };
        const { k: kk, e } = rollAt(t);
        const s = s0 + L * (kk + e + 0.5);
        return { x: ox + ux * s - nx * (L / 2), y: oy + uy * s - ny * (L / 2) };
      }

      function block(s, e, a) {
        ctx.globalAlpha = a;
        ctx.save();
        ctx.translate(ox + ux * s, oy + uy * s);
        ctx.rotate(rad(-theta));
        if (e) {
          // over the leading bottom edge
          ctx.translate(L, 0);
          ctx.rotate((e * Math.PI) / 2);
          ctx.translate(-L, 0);
        }
        ctx.fillRect(0, -L, L, L);
        if (a === 1) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = `rgba(${CUBE_LIT},0.85)`;
          ctx.fillRect(0, -L, L, L * 0.16);
          ctx.fillStyle = `rgba(${CUBE_SHADE},0.35)`;
          ctx.fillRect(L * 0.84, -L, L * 0.16, L);
          ctx.fillStyle = ORANGE;
        }
        ctx.restore();
      }

      function drawCube(t) {
        if (t < 0 || t >= tGone) return;
        const { k: kk, e } = rollAt(t);
        const v = L / rolls[kk].d;
        ctx.save();
        ctx.fillStyle = ORANGE;
        ctx.shadowColor = ORANGE;
        ctx.shadowBlur = C * 0.7 * dpr;
        // motion blur: the poses it passed through during the last frame
        const travel = v / 60;
        if (travel > L * 0.35) {
          const n = Math.min(16, Math.ceil(travel / (L * 0.25)));
          for (let i = n; i >= 1; i--) {
            const g = rollAt(t - i / (60 * n));
            block(s0 + g.k * L, g.e, 0.4 * (1 - i / (n + 1)) ** 1.5);
          }
        }
        block(s0 + kk * L, e, 1);
        ctx.restore();
      }

      // ── the wake: when the front reaches each disc ──────────
      // An odometer for the front: it advances at KAPPA × the cube's speed
      // while it rolls, then keeps gathering pace. A disc turns once, for some
      // point the cube passed, odometer(then) + distance has been covered.
      const DT = 1 / 240;
      const vmax = V_MAX * Math.hypot(vw, vh);
      const vmin = V_MIN * C;
      const speed = new Float32Array(Math.ceil(5 / DT));
      const odo = new Float32Array(speed.length);
      const vOut = Math.min(vmax, Math.max(vmin, (KAPPA * L) / rolls[Math.min(kExit, rolls.length - 1)].d));
      for (let i = 0; i < odo.length; i++) {
        const t = i * DT;
        const v = t < tExit ? (KAPPA * L) / rolls[rollAt(t).k].d : vOut * Math.exp(GROW * (t - tExit));
        speed[i] = Math.min(vmax, Math.max(vmin, v));
        if (i) odo[i] = odo[i - 1] + speed[i] * DT;
      }
      const lerpAt = (arr, t) => {
        const f = Math.max(0, t / DT);
        const i = Math.min(arr.length - 2, f | 0);
        return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
      };
      const timeAt = (u) => {
        let lo = 0;
        let hi = odo.length - 1;
        while (hi - lo > 1) {
          const m = (lo + hi) >> 1;
          if (odo[m] < u) lo = m;
          else hi = m;
        }
        return (lo + (u - odo[lo]) / Math.max(1e-6, odo[hi] - odo[lo])) * DT;
      };

      // the trail: the middle of the cube, a little behind its leading edge
      const trail = [];
      rolls.forEach((r, kk) => {
        for (let j = 0; j < 4; j++) {
          const t = r.t + (r.d * j) / 4;
          const s = s0 + L * (kk + rollAt(t).e + 0.3);
          trail.push({ x: ox + ux * s - nx * (L / 2), y: oy + uy * s - ny * (L / 2), w: lerpAt(odo, t) });
        }
      });

      const FOOT = 0.6 * C;
      let wakeEnd = 0;
      for (let n = 0; n < N; n++) {
        const cx = X0 + (n % cols) * C + C / 2;
        const cy = Y0 + ((n / cols) | 0) * C + C / 2;
        let u = Infinity;
        for (const p of trail) {
          const dx = cx - p.x;
          const dy = cy - p.y;
          // measured from the cube's body, not its centre: every disc under it
          // turns as it leaves
          const v = p.w + Math.max(0, Math.sqrt(dx * dx + dy * dy) - FOOT);
          if (v < u) u = v;
        }
        const t = timeAt(u);
        const v = lerpAt(speed, t);
        const g = gsap.utils.clamp(GLINT[0], GLINT[1], (1.1 * C) / v);
        glint[n] = g;
        // grain lives behind the seam: discs open at their own pace
        opn[n] = gsap.utils.clamp(OPEN[0], OPEN[1], (3 * C) / v) * (0.7 + 0.6 * hash(n + 11));
        wake[n] = t + (hash(n) - 0.5) * 0.3 * g;
        if (cx > -C && cx < vw + C && cy > -C && cy < vh + C) wakeEnd = Math.max(wakeEnd, wake[n] + g + opn[n] * 0.5);
      }

      // resolve: the discs flip away onto the crisp scene, out from where the
      // cube came in, D first, chasing the last of the wake
      const ex = ox + ux * s0;
      const ey = oy + uy * s0;
      const proj = new Float32Array(N);
      let pMin = Infinity;
      let pMax = -Infinity;
      for (let n = 0; n < N; n++) {
        const cx = X0 + (n % cols) * C + C / 2;
        const cy = Y0 + ((n / cols) | 0) * C + C / 2;
        proj[n] = Math.hypot(cx - ex, cy - ey);
        pMin = Math.min(pMin, proj[n]);
        pMax = Math.max(pMax, proj[n]);
      }
      const RESOLVE = wakeEnd + 0.05;
      let boardOff = 0;
      for (let n = 0; n < N; n++) {
        const u = (proj[n] - pMin) / (pMax - pMin);
        gone[n] = Math.max(RESOLVE + 0.4 * u ** 0.85 + hash(n + 7) * 0.08, wake[n] + glint[n] + opn[n] + 0.04);
        boardOff = Math.max(boardOff, gone[n] + GONE * 0.5);
      }

      // ── bands: diagonal, perpendicular to the baseline ──────
      const slant = -vh * Math.tan(rad(theta));
      const START = -24 - Math.max(0, slant);
      const END = vw + 24 - Math.min(0, slant);
      const B = [0, 1, 2].map(() => ({ a: START, b: START }));
      const LEAD = 4;
      const drawBands = () => {
        const p = [];
        const o = [];
        for (const q of B) {
          p.push(`${q.a}px ${vh}px`, `${q.a + slant}px 0px`, `${q.b + slant}px 0px`, `${q.b}px ${vh}px`);
          o.push(`${q.b}px ${vh}px`, `${q.b + slant}px 0px`, `${q.b + slant + LEAD}px 0px`, `${q.b + LEAD}px ${vh}px`);
        }
        bands.style.clipPath = `polygon(${p.join(",")})`;
        sliver.style.clipPath = `polygon(${o.join(",")})`;
      };
      drawBands();

      let boardOn = true;
      const OPEN_AT = 0.02;
      function step() {
        sync();
        if (!boardOn) return;
        const now = tl.time() - OPEN_AT;
        sample();
        for (let n = 0; n < N; n++) {
          if (live[n] === 2 && fT[n] < 0 && face[n] !== target[n] && now < gone[n]) {
            next[n] = target[n];
            fT[n] = now;
            fD[n] = FLIP;
          }
        }
        const c = cubeAt(now);
        glow.x = c.x;
        glow.y = c.y;
        paint(now);
        drawCube(now);
      }

      // hand over from the loader
      pre = false;
      gsap.ticker.remove(tick);
      breath.kill();
      const p0 = camP.p;
      camIn.kill();

      tl = gsap.timeline({
        onUpdate() {
          step();
          drawBands();
        },
      });
      if (import.meta.env.DEV)
        Object.assign(window.__intro, { tl, wakeEnd, tExit, RESOLVE, boardOff, p0, camS, openAt: performance.now() });

      const at = (dt) => `open+=${RESOLVE + dt}`;
      tl.addLabel("open", OPEN_AT)
        .set(stage, { visibility: "visible" }, 0)
        .to(lit, { a: 1, duration: 0.3, overwrite: true }, 0)
        .to({}, { duration: tGone }, "open")

        // the camera comes down flat as the wake goes through
        .fromTo(
          camP,
          { p: p0 },
          {
            p: 1,
            duration: CAM_T * (1 - p0),
            ease: "none",
            onUpdate: shoot,
            onComplete: () => gsap.set(cam, { clearProps: "transform,willChange" }),
          },
          0
        )

        // once the cube is through, the word drifts along its diagonal, right
        // up to the landing
        .to(sc, { x: D * co, y: -D * si, duration: RESOLVE + 0.78 - tExit, ease: "none" }, `open+=${tExit}`)
        .add(() => {
          boardOn = false;
          board.style.display = "none";
        }, `open+=${boardOff}`)

        // the gaps close: the pixel board becomes solid blue and black, so the
        // crisp scene it resolves onto is already the same picture
        .to({ g: G0 }, {
          g: 0,
          duration: 0.24,
          ease: "power2.inOut",
          onUpdate() {
            G = this.targets()[0].g;
            S = C - G;
          },
        }, `open+=${RESOLVE - 0.26}`)

        // bands: thin · wide · cover, chasing the resolve, an orange hairline on each
        .to(B[0], { b: END, duration: 0.7, ease: "power3.inOut" }, `open+=${RESOLVE + 0.15}`)
        .to(B[0], { a: END, duration: 0.7, ease: "power3.inOut" }, `open+=${RESOLVE + 0.19}`)
        .to(B[1], { b: END, duration: 0.72, ease: "power3.inOut" }, `open+=${RESOLVE + 0.27}`)
        .to(B[1], { a: END, duration: 0.72, ease: "power3.inOut" }, `open+=${RESOLVE + 0.41}`)
        .to(B[2], { b: END, duration: 0.6, ease: "expo.inOut" }, `open+=${RESOLVE + 0.4}`)
        .add(() => gsap.set([bg, sliver, rigA], { visibility: "hidden" }), `open+=${RESOLVE + 1.0}`)
        .addLabel("settle", `open+=${RESOLVE + 0.78}`);

      // ── settle into the hero ───────────────────────────────
      tl.add(() => {
        bands.style.background = "transparent";
        root.style.background = "transparent";
        root.style.pointerEvents = "none";
      }, `open+=${RESOLVE + 1.0}`);

      // read when the settle starts, so a late refit of the hero is honoured
      const hero = () => {
        const hr = heroWord.getBoundingClientRect();
        return {
          f: parseFloat(getComputedStyle(heroWord).fontSize),
          x: hr.left + hr.width / 2 - vw / 2,
          y: hr.top + hr.height / 2 - vh / 2,
        };
      };

      // the word swings level in space — a little tilt through the turn — and
      // lands exactly on the hero wordmark
      gsap.set(stage, { transformPerspective: persp, transformOrigin: "50% 50%" });
      const SETTLE = 0.95;
      const land = "power2.inOut";
      tl.to(sc, { x: () => hero().x, y: () => hero().y, duration: SETTLE, ease: land }, "settle")
        .to(rigs, { rotation: 0, scale: () => hero().f / F, duration: SETTLE, ease: land }, "settle")
        .to(words, { skewX: 0, duration: SETTLE, ease: land }, "settle")
        .to(stage, {
          keyframes: [
            { rotationX: 7, rotationY: -4, duration: SETTLE * 0.45, ease: "power2.inOut" },
            { rotationX: 0, rotationY: 0, duration: SETTLE * 0.55, ease: "power2.out" },
          ],
        }, "settle")
        .call(reveal, null, "settle+=0.5")
        .add(end, `settle+=${SETTLE + 0.02}`);

      sample();
      step();
    }
  });
}
