import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import Lenis from "lenis";
import Snap from "lenis/snap";
import { runIntro } from "./intro.js";
import { splitWord, kernWord, fitWord, setAxis, gutter } from "../lib/wordmark.js";
import { flipify } from "../lib/flip.js";
import { fontsReady as copyFontsReady, blockReady } from "../lib/fonts.js";

gsap.registerPlugin(ScrollTrigger, SplitText);

/**
 * Mount the home page into `root` (which already holds its markup).
 *   playIntro  — run the opening (first visit to "/" only)
 *   section    — "work" | "contact": land there instead of the top
 *   navigate   — SPA navigation for internal links
 * Returns a destroy() that tears down everything it created.
 */
export function initHome(root, { playIntro = false, section = null, navigate } = {}) {
  const html = document.documentElement;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const intro = playIntro && !reduced && !section;
  const cleanups = [];
  let dead = false;

  const ctx = gsap.context(() => {}, root);
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];

  if (!intro) $(".intro")?.remove();
  html.classList.toggle("is-intro", intro);
  html.classList.add("reveals-pending");

  // ── markup ────────────────────────────────────────────────
  $$("[data-word]").forEach(splitWord);
  $$("[data-flip]").forEach(flipify);

  // internal links stay in the app
  const onClick = (e) => {
    const a = e.target.closest("a[href]");
    if (!a || !navigate || e.metaKey || e.ctrlKey || e.shiftKey || a.target === "_blank") return;
    const href = a.getAttribute("href");
    if (href.startsWith("/") && !href.startsWith("//") && !/\.[a-z0-9]+$/i.test(href)) {
      e.preventDefault();
      navigate(href);
    }
  };
  root.addEventListener("click", onClick);
  cleanups.push(() => root.removeEventListener("click", onClick));

  // ── fitting ───────────────────────────────────────────────
  const heroWord = $(".hero__word");
  const footWord = $(".contact__word");
  function fitAll() {
    if (dead) return;
    $$("[data-word]").forEach(kernWord);
    const inner = html.clientWidth - 2 * gutter();
    const restore = fitWord(heroWord, inner);
    setAxis(heroWord);
    restore();
    fitWord(footWord, inner)();
  }
  const blockIn = blockReady().then(fitAll);
  const allIn = Promise.all([blockIn, copyFontsReady()]).then(fitAll);

  // ── smooth scroll ─────────────────────────────────────────
  const lenis = new Lenis({ lerp: 0.075, wheelMultiplier: 0.95 });
  lenis.on("scroll", ScrollTrigger.update);
  const raf = (t) => lenis.raf(t * 1000);
  gsap.ticker.add(raf);
  gsap.ticker.lagSmoothing(0);
  lenis.stop();
  cleanups.push(() => {
    gsap.ticker.remove(raf);
    lenis.destroy();
  });

  // ── reveals: lines rise out of their own mask ─────────────
  const splits = [];
  function lines(el) {
    el.classList.add("is-revealing");
    const split = SplitText.create(el, { type: "lines", mask: "lines" });
    splits.push(split);
    gsap.set(split.lines, { yPercent: 108 });
    return {
      lines: split.lines,
      done: () => {
        split.revert();
        el.classList.remove("is-revealing");
      },
    };
  }
  const RISE = { yPercent: 0, duration: 1.25, ease: "expo.out" };
  const statement = $(".hero__statement");
  const aside = $(".hero__aside");
  const heroFoot = $$(".hero__foot > *");

  function reveal() {
    if (dead) return;
    ctx.add(() => {
      const a = lines(statement);
      const b = lines(aside);
      gsap.set([statement, aside], { opacity: 1 });
      gsap
        .timeline({ onComplete: () => (a.done(), b.done()) })
        .to(a.lines, { ...RISE, duration: 1.4, stagger: 0.075 }, 0)
        .to(b.lines, { ...RISE, duration: 1.4, stagger: 0.06 }, 0.32)
        .to(heroFoot, { opacity: 1, duration: 1.4, ease: "power2.out" }, 0.7);
    });
  }

  function prepareReveals() {
    if (dead) return;
    html.classList.remove("reveals-pending");
    ctx.add(() => {
      $$(".work").forEach((work) => {
        const t = lines(work.querySelector(".work__title"));
        const n = lines(work.querySelector(".note"));
        gsap
          .timeline({ scrollTrigger: { trigger: work, start: "top 82%" }, onComplete: () => (t.done(), n.done()) })
          .to(t.lines, { ...RISE, stagger: 0.08 }, 0)
          .to(n.lines, { ...RISE, stagger: 0.05 }, 0.12);
        const media = work.querySelector(".work__media");
        gsap.fromTo(media, { scale: 0.9 }, {
          scale: 1,
          ease: "none",
          scrollTrigger: { trigger: work, start: "top bottom", end: "center center", scrub: 0.8 },
        });
        gsap.to(media, {
          scale: 0.95,
          opacity: 0.55,
          ease: "none",
          scrollTrigger: { trigger: work, start: "center center", end: "bottom top", scrub: 0.8 },
        });
      });

      const rows = $$(".tool__name").map(lines);
      const tl = gsap.timeline({
        scrollTrigger: { trigger: $(".tools__list"), start: "top 82%" },
        onComplete: () => rows.forEach((r) => r.done()),
      });
      rows.forEach((r, i) => tl.to(r.lines, { ...RISE }, i * 0.075));

      const mail = lines($(".contact__mail"));
      gsap.to(mail.lines, { ...RISE, stagger: 0.08, scrollTrigger: { trigger: $(".contact__mail"), start: "top 85%" }, onComplete: mail.done });
    });
  }

  // ── scroll scenes and the two project visuals ─────────────
  const scenes = [];
  function scrollScenes() {
    ctx.add(() => {
      const heroLetters = heroWord.querySelectorAll(".ch");
      gsap
        .timeline({ scrollTrigger: { trigger: $(".hero"), start: "top top", end: "bottom top", scrub: 0.6 } })
        .to(heroWord, { "--wdth": 90, ease: "none" }, 0)
        .to(heroLetters, { yPercent: (i) => -12 - i * 9, ease: "none" }, 0);

      const footLetters = footWord.querySelectorAll(".ch");
      gsap
        .timeline({ scrollTrigger: { trigger: $(".contact"), start: "top bottom", end: "bottom-=160 bottom", scrub: 0.6 } })
        .fromTo(footWord, { "--wdth": 62 }, { "--wdth": 125, ease: "none" }, 0)
        .fromTo(footLetters, { yPercent: (i) => 40 + i * 12 }, { yPercent: 0, ease: "none" }, 0);
    });

    const near = (el, load) => {
      const io = new IntersectionObserver(
        ([e]) => {
          if (!e.isIntersecting) return;
          io.disconnect();
          load();
        },
        { rootMargin: "120% 0px" }
      );
      io.observe(el);
      cleanups.push(() => io.disconnect());
    };

    const periodHost = $(".work__media--period");
    const pushtHost = $(".work__media--pusht");
    near(periodHost, async () => {
      const [{ createPeriod }, { default: src }] = await Promise.all([
        import("./work/period.js"),
        import("./assets/period-trajectories.webp"),
      ]);
      if (dead) return;
      const field = await createPeriod(periodHost, src);
      if (dead) return field.dispose();
      scenes.push(field);
      ctx.add(() =>
        ScrollTrigger.create({
          trigger: periodHost,
          start: "top 78%",
          once: true,
          onEnter: () => gsap.to(field.uniforms.uReveal, { value: 1, duration: 2.6, ease: "power2.inOut" }),
        })
      );
    });
    near(pushtHost, async () => {
      const { createPushT } = await import("./work/pusht.js");
      if (dead) return;
      scenes.push(createPushT(pushtHost));
      ctx.add(() =>
        gsap.from(pushtHost, {
          clipPath: "inset(0 100% 0 0)",
          duration: 1.4,
          ease: "expo.inOut",
          scrollTrigger: { trigger: pushtHost, start: "top 80%" },
        })
      );
    });
  }

  // ── detents: name, period, Causal Video Generation; free below ──
  let snap = null;
  let lastDetent = 0;
  const detentY = () =>
    $$(".work").map((w) => {
      const vh = window.innerHeight;
      const r = w.getBoundingClientRect();
      const top = r.top + window.scrollY;
      return Math.max(0, Math.round(r.height < vh ? top - (vh - r.height) / 2 : top - vh * 0.06));
    });
  function setDetents() {
    snap?.destroy();
    snap = new Snap(lenis, {
      type: "lock",
      distanceThreshold: "125%",
      debounce: 90,
      duration: 0.95,
      easing: (t) => 1 - Math.pow(1 - t, 4),
    });
    snap.add(0);
    lastDetent = 0;
    detentY().forEach((y) => {
      snap.add(y);
      lastDetent = Math.max(lastDetent, y);
    });
  }
  lenis.on("scroll", ({ scroll }) => {
    if (!snap) return;
    const free = scroll > lastDetent + window.innerHeight * 0.32;
    if (free && !snap.isStopped) snap.stop();
    else if (!free && snap.isStopped) snap.start();
  });
  cleanups.push(() => snap?.destroy());

  let lastW = window.innerWidth;
  const onResize = () => {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    fitAll();
    ScrollTrigger.refresh();
    if (snap) setDetents();
  };
  window.addEventListener("resize", onResize);
  cleanups.push(() => window.removeEventListener("resize", onResize));

  function finish() {
    if (dead) return;
    html.classList.remove("is-intro");
    lenis.start();
    scrollScenes();
    ScrollTrigger.refresh();
    setDetents();
    if (section) {
      const target = section === "contact" ? $(".contact") : section === "work" ? detentY()[0] : 0;
      lenis.scrollTo(target, { immediate: true, force: true });
      ScrollTrigger.update();
    }
  }

  // ── boot ──────────────────────────────────────────────────
  window.scrollTo(0, 0);
  if (!intro) {
    allIn.then(() => {
      if (dead) return;
      heroWord.style.visibility = "visible";
      if (!reduced) prepareReveals();
      else html.classList.remove("reveals-pending");
      if (reduced || section) gsap.set([statement, aside, ...heroFoot], { opacity: 1 });
      else reveal();
      finish();
    });
  } else {
    gsap.set([statement, aside, ...heroFoot], { opacity: 0 });
    const armed = allIn.then(prepareReveals);
    runIntro({ heroWord, fontsReady: blockIn, onReveal: () => allIn.then(reveal) })
      .then(() => armed)
      .then(finish);
  }

  return function destroy() {
    dead = true;
    cleanups.forEach((fn) => fn());
    scenes.forEach((s) => s.dispose?.());
    splits.forEach((s) => s.revert());
    ctx.revert();
    html.classList.remove("is-intro", "reveals-pending");
    document.querySelector(".intro")?.remove();
  };
}
