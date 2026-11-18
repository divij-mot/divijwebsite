import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import STALLS from "../assets/period-stalls.json";

/*
  period — an end-to-end car-parking world model.

  The capture is laid back down as a ground plane (inverse perspective), so it
  can be filmed from a real, moving camera. The car drives the traced
  trajectory — in, a three-point turn, and into its stall. Every beat, the
  world model branches a fan of futures ahead of it in blue; the one it takes
  turns orange and becomes the road.
*/

// ── image → ground plane ─────────────────────────────────────
const IMG_W = 976;
const IMG_H = 506;
const HORIZON = -1.1 * IMG_H; // image-space horizon, above the frame
const K = 27628;
const F = 500;
const ZC = 38;
const ZS = 2.6; // restore the depth the screenshot's camera compressed
function ground(px, py) {
  const Z = K / (py - HORIZON);
  return [((px - IMG_W / 2) * Z) / F, (ZC - Z) * ZS];
}

// ── shaders ──────────────────────────────────────────────────
const POINT_VERT = /* glsl */ `
  uniform float uTime, uSweep, uScan, uScale, uFocus, uAperture;
  uniform vec3 uCar;
  uniform vec2 uDir;
  uniform float uBeam;
  attribute float aSize, aAlpha, aSeed;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    // revealed by a scan plane travelling left → right; a trace of light in its wake
    float d = p.x - uSweep;
    float shown = 1.0 - smoothstep(-0.5, 1.5, d);
    float ds = p.x - uScan;
    float glow = exp(-d * d * 0.35) * 1.6 + exp(-ds * ds * 0.25) * 0.9;
    p.y += (1.0 - shown) * 1.2;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float z = -mv.z;
    float base = aSize * uScale / z;
    float coc = clamp(abs(z - uFocus) * uAperture, 0.0, 9.0);
    // headlights: a soft cone ahead of the car lights the lot as it passes
    vec2 rel = p.xz - uCar.xz;
    float along = dot(rel, uDir);
    float lat = abs(rel.x * uDir.y - rel.y * uDir.x);
    float cone = smoothstep(-0.5, 1.0, along) * (1.0 - smoothstep(along * 0.25, along * 0.9 + 2.2, lat));
    float beam = cone * exp(-along * 0.13) * uBeam * 0.55;
    float size = max(base + coc, 1.6) * (1.0 + beam * 0.5);
    gl_PointSize = size;
    float a = aAlpha * shown * (base * base) / (size * size) * 1.6;
    a *= exp(-0.018 * max(0.0, z - uFocus));
    vAlpha = clamp(a + glow * shown * aAlpha * 2.0 + beam * shown * (0.25 + aAlpha), 0.0, 1.0);
    vColor = mix(aColor, vec3(1.0, 0.94, 0.86), clamp(beam, 0.0, 1.0));
  }
`;
const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    float a = vAlpha * smoothstep(0.5, 0.25, r);
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor * a, a);
    #include <colorspace_fragment>
  }
`;

const GLOW_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float a = exp(-r * r * 5.0) * uStrength;
    gl_FragColor = vec4(uColor * a, a);
    #include <colorspace_fragment>
  }
`;
const GLOW_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const maxBlend = (m) => {
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.MaxEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  m.transparent = true;
  m.depthWrite = false;
  return m;
};

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

const smooth = (t) => t * t * (3 - 2 * t);

export async function createPeriod(host, src) {
  // ── sample the capture ─────────────────────────────────────
  const img = await loadImage(src);
  const cv = document.createElement("canvas");
  cv.width = IMG_W;
  cv.height = IMG_H;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(img, 0, 0, IMG_W, IMG_H);
  const px = cx.getImageData(0, 0, IMG_W, IMG_H).data;

  const BONE = new THREE.Color("#f2efe8");
  const ORANGE = new THREE.Color("#ff5a1f");
  const pos = [];
  const col = [];
  const size = [];
  const alpha = [];
  const seed = [];
  for (let j = 0; j < IMG_H; j++) {
    for (let i = 0; i < IMG_W; i++) {
      const k = (j * IMG_W + i) * 4;
      const r = px[k];
      const g = px[k + 1];
      const b = px[k + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0;
      const lum = (r + g + b) / 765;
      const [x, z] = ground(i + Math.random() - 0.5, j + Math.random() - 0.5);
      if (sat > 0.42 && mx > 80) {
        // every past drive, kept as a faint orange record on the ground
        pos.push(x, 0.03, z);
        col.push(ORANGE.r, ORANGE.g, ORANGE.b);
        size.push(1.4);
        alpha.push(0.12);
        seed.push(Math.random());
      } else if (lum > 0.11) {
        const t = Math.min(1, (lum - 0.11) / 0.55);
        if (t < 0.08 && Math.random() > 0.5) continue;
        // stall paint reads bright, the rest of the ground stays quiet
        pos.push(x, Math.random() * 0.06, z);
        col.push(BONE.r, BONE.g, BONE.b);
        size.push(1.5 + t * 1.5);
        alpha.push(0.08 + Math.pow(t, 1.4) * 0.92);
        seed.push(Math.random());
      }
    }
  }

  const pointUniforms = {
    uTime: { value: 0 },
    uSweep: { value: -80 },
    uScan: { value: -999 },
    uCar: { value: new THREE.Vector3(999, 0, 999) },
    uDir: { value: new THREE.Vector2(1, 0) },
    uBeam: { value: 0 },
    uScale: { value: 60 },
    uFocus: { value: 40 },
    uAperture: { value: 0.09 },
  };
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  pgeo.setAttribute("aColor", new THREE.Float32BufferAttribute(col, 3));
  pgeo.setAttribute("aSize", new THREE.Float32BufferAttribute(size, 1));
  pgeo.setAttribute("aAlpha", new THREE.Float32BufferAttribute(alpha, 1));
  pgeo.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 1));
  const points = new THREE.Points(
    pgeo,
    maxBlend(new THREE.ShaderMaterial({ uniforms: pointUniforms, vertexShader: POINT_VERT, fragmentShader: POINT_FRAG }))
  );

  const scene = new THREE.Scene();
  scene.add(points);

  // ── the lot: bays found in the capture (paint dividers → rows → bays) ─
  const lotC = new THREE.Vector3();
  STALLS.forEach((b) => lotC.add(new THREE.Vector3(b.cx, 0, b.cz)));
  lotC.divideScalar(STALLS.length);
  const widths = STALLS.map((b) => b.w).sort((a, b) => a - b);
  const CAR_W = widths[widths.length >> 1] * 0.58;
  const CAR_L = CAR_W * 1.95;
  const bays = STALLS.map((b) => {
    const c = new THREE.Vector3(b.cx, 0.05, b.cz);
    const u = new THREE.Vector3(b.ux, 0, b.uz).normalize();
    if (c.clone().sub(lotC).dot(u) < 0) u.negate(); // u points into the bay, away from the aisle
    return { c, u, w: b.w, d: b.d, park: c.clone().addScaledVector(u, CAR_L * 0.12) };
  });

  // car: an orange body under a dark glasshouse and a lit roof, dark tyres at
  // the corners, white headlamps throwing beams, tail lamps that go white in reverse
  const car = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: "#ff5a1f",
    roughness: 0.42,
    metalness: 0.15,
    emissive: "#ff5a1f",
    emissiveIntensity: 0.04,
    transparent: true,
  });
  const H = CAR_W * 0.3;
  const body = new THREE.Mesh(new RoundedBoxGeometry(CAR_L, H, CAR_W, 4, CAR_W * 0.06), bodyMat);
  body.position.y = H / 2 + CAR_W * 0.1;
  car.add(body);
  const glass = new THREE.Mesh(
    new RoundedBoxGeometry(CAR_L * 0.5, CAR_W * 0.24, CAR_W * 0.84, 4, CAR_W * 0.1),
    new THREE.MeshStandardMaterial({ color: "#0d0705", roughness: 0.15, metalness: 0.4, transparent: true })
  );
  glass.position.set(-CAR_L * 0.06, H + CAR_W * 0.1 + CAR_W * 0.1, 0);
  car.add(glass);
  const roof = new THREE.Mesh(new RoundedBoxGeometry(CAR_L * 0.36, CAR_W * 0.04, CAR_W * 0.7, 3, CAR_W * 0.02), bodyMat);
  roof.position.set(-CAR_L * 0.08, H + CAR_W * 0.1 + CAR_W * 0.23, 0);
  car.add(roof);
  const tyreMat = new THREE.MeshStandardMaterial({ color: "#0b0b0b", roughness: 0.9, transparent: true });
  const tyreGeo = new THREE.CylinderGeometry(CAR_W * 0.17, CAR_W * 0.17, CAR_W * 0.13, 20).rotateX(Math.PI / 2);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const tyre = new THREE.Mesh(tyreGeo, tyreMat);
      tyre.position.set(sx * CAR_L * 0.31, CAR_W * 0.17, sz * CAR_W * 0.47);
      car.add(tyre);
    }
  }
  const lampMat = new THREE.MeshBasicMaterial({ color: "#fff4e6", toneMapped: false, transparent: true });
  const tailMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#ff1a0a"), toneMapped: false, transparent: true });
  // lamps sit flush in the flat front and rear faces, at the body's mid-height
  const lampY = CAR_W * 0.1 + H * 0.58;
  for (const sgn of [-1, 1]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.04, H * 0.22, CAR_W * 0.2), lampMat);
    lamp.position.set(CAR_L / 2 + 0.005, lampY, sgn * CAR_W * 0.3);
    car.add(lamp);
  }
  // one red light bar across the back
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.04, H * 0.2, CAR_W * 0.84), tailMat);
  tail.position.set(-CAR_L / 2 - 0.005, lampY, 0);
  car.add(tail);
  // the beams on the ground: a soft fan ahead of the bumper
  const beamGeo = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0).rotateX(-Math.PI / 2);
  const beams = new THREE.Mesh(
    beamGeo,
    maxBlend(
      new THREE.ShaderMaterial({
        uniforms: { uStrength: { value: 0.32 } },
        vertexShader: GLOW_VERT,
        fragmentShader: /* glsl */ `
          uniform float uStrength;
          varying vec2 vUv;
          void main() {
            float x = vUv.x;
            float y = (vUv.y - 0.5) * 2.0;
            float width = 0.22 + x * 0.78;
            float a = (1.0 - smoothstep(width * 0.1, width, abs(y))) * smoothstep(0.0, 0.12, x) * pow(1.0 - x, 2.2) * uStrength;
            gl_FragColor = vec4(vec3(1.0, 0.92, 0.8) * a, a);
            #include <colorspace_fragment>
          }
        `,
      })
    )
  );
  beams.scale.set(CAR_L * 2.4, 1, CAR_W * 4.2);
  beams.position.set(CAR_L / 2, 0.04, 0);
  car.add(beams);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(CAR_L * 1.6, CAR_L * 1.6),
    maxBlend(
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: ORANGE.clone() }, uStrength: { value: 0.3 } },
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
      })
    )
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.02;
  car.add(glow);
  // red tail glow on the ground behind
  const tailGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(CAR_W * 1.0, CAR_W * 1.7),
    maxBlend(
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color("#ff1a0a") }, uStrength: { value: 0.2 } },
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
      })
    )
  );
  tailGlow.rotation.x = -Math.PI / 2;
  tailGlow.position.set(-CAR_L / 2 - CAR_W * 0.32, 0.03, 0);
  car.add(tailGlow);
  // soft contact shadow so it sits on the ground
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(CAR_L * 1.35, CAR_W * 1.6).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: GLOW_VERT,
      fragmentShader: "varying vec2 vUv; void main(){ vec2 d = (vUv - 0.5) * 2.0; float a = 0.7 * (1.0 - smoothstep(0.35, 1.0, length(d))); gl_FragColor = vec4(0.0, 0.0, 0.0, a); }",
    })
  );
  contact.position.y = 0.045;
  contact.renderOrder = 2;
  car.add(contact);
  scene.add(car);
  scene.add(new THREE.HemisphereLight("#ffffff", "#141414", 0.75));
  const sun = new THREE.DirectionalLight("#ffffff", 1.25);
  sun.position.set(-20, 40, 25);
  scene.add(sun);
  const carMats = [bodyMat, glass.material, tyreMat, lampMat, tailMat];

  // the bay being aimed for: its outline lights up on the ground
  const bayLine = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([0, 1, 2, 3].map(() => new THREE.Vector3())),
    new THREE.LineBasicMaterial({ color: ORANGE, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  scene.add(bayLine);
  function outline(b) {
    const side = new THREE.Vector3(-b.u.z, 0, b.u.x);
    const hw = b.w * 0.46;
    const hd = CAR_L * 0.62;
    const c = b.park.clone().setY(0.05);
    const pts = [
      c.clone().addScaledVector(b.u, hd).addScaledVector(side, hw),
      c.clone().addScaledVector(b.u, hd).addScaledVector(side, -hw),
      c.clone().addScaledVector(b.u, -hd).addScaledVector(side, -hw),
      c.clone().addScaledVector(b.u, -hd).addScaledVector(side, hw),
    ];
    bayLine.geometry.setFromPoints(pts);
  }

  // ── routes: reverse out, swing toward the next bay, drive the aisle, nose in ─
  const easeIO = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
  let rngSeed = 7;
  const rand = () => ((rngSeed = (rngSeed * 16807) % 2147483647) / 2147483647);
  function routeBetween(A, B) {
    const out = A.park.clone().addScaledVector(A.u, -(CAR_L * 1.35 + 1.0));
    const entry = B.park.clone().addScaledVector(B.u, -CAR_L * 1.7);
    const h1 = entry.clone().sub(out).setY(0).normalize();
    const rev = new THREE.CubicBezierCurve3(
      A.park.clone(),
      A.park.clone().addScaledVector(A.u, -CAR_L * 0.95),
      out.clone().addScaledVector(h1, CAR_L * 0.85),
      out.clone()
    );
    const d = out.distanceTo(B.park);
    const fwd = new THREE.CubicBezierCurve3(
      out.clone(),
      out.clone().addScaledVector(h1, d * 0.38),
      B.park.clone().addScaledVector(B.u, -Math.max(CAR_L * 2.4, d * 0.42)),
      B.park.clone()
    );
    const legs = [
      { curve: rev, reverse: true },
      { curve: fwd, reverse: false },
    ];
    let t = 1.4; // a moment parked before pulling out
    for (const l of legs) {
      l.len = l.curve.getLength();
      l.dur = 0.9 + l.len / (l.reverse ? 4.2 : 7.2);
      l.t0 = t;
      t += l.dur + 0.32; // a breath at each change of gear
    }
    return { A, B, legs, total: t };
  }
  function pickNext(A) {
    const options = bays.filter((b) => b !== A && b.c.distanceTo(A.c) > CAR_L * 2.2);
    return options[Math.floor(rand() * options.length)];
  }
  function stateAt(route, t) {
    const { legs } = route;
    if (t < legs[0].t0) return { p: route.A.park.clone(), heading: route.A.u.clone(), motion: route.A.u.clone(), moving: false, reverse: false };
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      const endT = l.t0 + l.dur;
      const nextT = i + 1 < legs.length ? legs[i + 1].t0 : Infinity;
      if (t <= endT || t < nextT) {
        const u = easeIO(Math.min(1, Math.max(0, (t - l.t0) / l.dur)));
        const p = l.curve.getPointAt(u);
        const tan = l.curve.getTangentAt(Math.min(0.999, Math.max(0.001, u)));
        return { p, heading: l.reverse ? tan.clone().negate() : tan, motion: tan, moving: t < endT, reverse: l.reverse };
      }
    }
    const last = legs[legs.length - 1];
    return { p: route.B.park.clone(), heading: route.B.u.clone(), motion: last.curve.getTangentAt(0.999), moving: false, reverse: false };
  }

  let A0 = bays[0];
  bays.forEach((b) => {
    if (b.c.length() < A0.c.length()) A0 = b;
  });
  let route = routeBetween(A0, pickNext(A0));
  let routeT = 0;

  // the road taken: an orange trace that fades behind the car
  const TRAIL = 420;
  const trailPos = new Float32Array(TRAIL * 3);
  const trailCol = new Float32Array(TRAIL * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 3));
  trailGeo.setDrawRange(0, 0);
  scene.add(
    new THREE.Line(
      trailGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    )
  );
  const trail = [];

  // predicted futures: a fan of rollouts every beat while driving
  const FUT = 8;
  const FUT_PTS = 48;
  const futures = Array.from({ length: FUT }, (_, i) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(FUT_PTS * 3), 3));
    g.setDrawRange(0, 0);
    const m = new THREE.LineBasicMaterial({
      color: i === 0 ? ORANGE : new THREE.Color("#5a74ff"),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.Line(g, m);
    scene.add(line);
    return { line, born: -10 };
  });
  function branch(now) {
    const st = stateAt(route, routeT);
    const dir = st.motion.clone().setY(0).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    futures.forEach((f, i) => {
      const arr = f.line.geometry.attributes.position.array;
      const spread = i === 0 ? 0 : (i - FUT / 2 + 0.5) * 0.7 + (rand() - 0.5) * 0.5;
      for (let n = 0; n < FUT_PTS; n++) {
        const h = n / (FUT_PTS - 1);
        const ahead = stateAt(route, routeT + h * 2.4).p;
        const lateral = spread * h * h * 3;
        arr[n * 3] = ahead.x + side.x * lateral;
        arr[n * 3 + 1] = 0.06;
        arr[n * 3 + 2] = ahead.z + side.z * lateral;
      }
      f.line.geometry.attributes.position.needsUpdate = true;
      f.born = now;
    });
  }

  // ── renderer, camera ───────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(32, 2, 0.5, 400);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    pointUniforms.uScale.value = 64 * dpr * (h / 690);
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  host.addEventListener("pointermove", (e) => {
    const b = host.getBoundingClientRect();
    look.tx = ((e.clientX - b.left) / b.width) * 2 - 1;
    look.ty = ((e.clientY - b.top) / b.height) * 2 - 1;
  });
  host.addEventListener("pointerleave", () => {
    look.tx = 0;
    look.ty = 0;
  });

  const target = A0.park.clone();
  const lead = new THREE.Vector3();
  const reveal = { value: 0 };
  let visible = false;
  let raf = 0;
  let last = 0;
  let clock = 0;
  let nextBranch = 0;
  let bayGlow = 0;
  let carIn = 0;

  function frame(nowMs) {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.05, (nowMs - last) / 1000) : 0.016;
    last = nowMs;
    clock += dt;
    pointUniforms.uTime.value = clock;

    // scan: the reveal on entry, then a slow pass every few seconds
    const sweepSpan = 150;
    pointUniforms.uSweep.value = -75 + reveal.value * sweepSpan;
    const idle = clock > 4 ? ((clock - 4) % 8) / 8 : 1;
    pointUniforms.uScan.value = idle < 0.55 ? -75 + (idle / 0.55) * sweepSpan : -999;

    // the drive never ends: park, wait, pull out, find the next bay
    // the car appears only once the scan has laid the lot down, then starts to drive
    const lotIn = reveal.value >= 0.98;
    if (lotIn) carIn = Math.min(1, carIn + dt / 0.9);
    const ap = carIn * carIn * (3 - 2 * carIn);
    car.visible = ap > 0;
    carMats.forEach((m) => (m.opacity = ap));
    if (carIn >= 1) routeT += dt;
    if (routeT >= route.total + 1.4) {
      route = routeBetween(route.B, pickNext(route.B));
      routeT = 0;
    }
    const st = stateAt(route, routeT);
    car.position.copy(st.p);
    car.rotation.y = Math.atan2(-st.heading.z, st.heading.x);
    // tail lights always red; a touch brighter while reversing, like brakes
    tailMat.color.set("#ff1a0a").multiplyScalar(st.reverse && st.moving ? 1.35 : 1);
    glow.material.uniforms.uStrength.value = (st.moving ? 0.14 : 0.08) * ap;
    tailGlow.material.uniforms.uStrength.value = (st.reverse && st.moving ? 0.3 : 0.2) * ap;
    contact.material.opacity = ap;
    // headlights: soft and wide, brighter under way, low when parked
    const beamWant = (st.moving && !st.reverse ? 1 : 0.4) * ap;
    pointUniforms.uBeam.value += (beamWant - pointUniforms.uBeam.value) * 0.06;
    beams.material.uniforms.uStrength.value = 0.16 * pointUniforms.uBeam.value;
    const fwd = st.heading.clone().setY(0).normalize();
    pointUniforms.uCar.value.copy(st.p).addScaledVector(fwd, CAR_L * 0.5);
    pointUniforms.uDir.value.set(fwd.x, fwd.z);

    // the target bay: lights as the car commits to it, settles once parked
    outline(route.B);
    const committed = routeT > route.legs[1].t0 - 0.2;
    const parked = routeT > route.legs[1].t0 + route.legs[1].dur;
    const want = parked ? Math.max(0, 0.9 - (routeT - route.legs[1].t0 - route.legs[1].dur) * 0.6) : committed ? 0.75 : 0;
    bayGlow += (want - bayGlow) * 0.08;
    bayLine.material.opacity = bayGlow;

    // trail
    if (carIn >= 1 && st.moving && (!trail.length || trail[trail.length - 1].distanceTo(st.p) > 0.2)) {
      trail.push(st.p.clone());
      if (trail.length > TRAIL) trail.shift();
    }
    for (let i = 0; i < trail.length; i++) {
      trailPos[i * 3] = trail[i].x;
      trailPos[i * 3 + 1] = 0.05;
      trailPos[i * 3 + 2] = trail[i].z;
      const v = Math.max(0.0, 1 - (trail.length - i) / 150);
      trailCol[i * 3] = ORANGE.r * v;
      trailCol[i * 3 + 1] = ORANGE.g * v;
      trailCol[i * 3 + 2] = ORANGE.b * v;
    }
    trailGeo.setDrawRange(0, trail.length);
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.attributes.color.needsUpdate = true;

    // futures: only while the car is under way forward
    if (carIn >= 1 && st.moving && !st.reverse && clock >= nextBranch) {
      branch(clock);
      nextBranch = clock + 1.5;
    }
    futures.forEach((f, i) => {
      const age = clock - f.born;
      const e = 1 - Math.pow(1 - Math.min(1, age / 0.4), 4);
      f.line.geometry.setDrawRange(0, Math.floor(e * FUT_PTS));
      const life = 1 - smooth(Math.min(1, Math.max(0, (age - (i === 0 ? 0.9 : 0.5)) / 0.6)));
      f.line.material.opacity = Math.max(0, life) * (i === 0 ? 1 : 0.85);
    });

    // camera: long lens, trucking with the car and leading it gently
    lead.copy(st.p).addScaledVector(st.motion.clone().setY(0).normalize(), st.moving ? 5 : 0);
    target.lerp(lead, 0.022);
    look.x += (look.tx - look.x) * 0.05;
    look.y += (look.ty - look.y) * 0.05;
    const yaw = -0.16 + look.x * 0.035;
    const elev = 0.74 - look.y * 0.02;
    const dist = 52;
    camera.position.set(
      target.x + Math.sin(yaw) * Math.cos(elev) * dist,
      Math.sin(elev) * dist,
      target.z + Math.cos(yaw) * Math.cos(elev) * dist
    );
    camera.lookAt(target);
    pointUniforms.uFocus.value = camera.position.distanceTo(st.p);

    renderer.render(scene, camera);
  }

  const io = new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !visible) {
      visible = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    } else if (!e.isIntersecting && visible) {
      visible = false;
      cancelAnimationFrame(raf);
    }
  });
  io.observe(host);

  function dispose() {
    cancelAnimationFrame(raf);
    io.disconnect();
    ro.disconnect();
    scene.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach((m) => m.dispose());
    });
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  }

  return { uniforms: { uReveal: reveal }, dispose };
}
