import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { createSim } from "./pusht-sim.js";
import { token } from "../../lib/palette.js";

/*
  Causal Video Generation as a Policy

  The push-T task on a physical flip-disc display: every disc is a pixel of
  the frame the model is generating. The T is white; the goal is an orange
  outline; where the T covers the goal its discs turn orange. A blue puck —
  the policy — pushes. The discs
  flip a beat behind the T as it moves.
*/

// ── board ────────────────────────────────────────────────────
const COLS = 72;
const ROWS = 56;
const FRONT = 24; // rows nearer the camera than the workspace centre
const N = COLS * ROWS;
const UNIT = 6.3; // discs per env unit

// faces
const BG = 0;
const WHITE = 1;
const ORANGE = 2;
const FACE = [new THREE.Color("#0c0c0c"), new THREE.Color("#f3f1ec"), new THREE.Color("#ff5a1f")];

// T outline in env units, centre of mass at the origin
const S = 0.8;
const T_PTS = [
  [-2, 1.36], [2, 1.36], [2, 0.36], [0.5, 0.36],
  [0.5, -2.64], [-0.5, -2.64], [-0.5, 0.36], [-2, 0.36],
].map(([x, y]) => [x * S, y * S]);
const T_R = 2.7 * S; // bounding radius

// Is (x, y), in the T's own frame, inside the T? The T is two half-open
// rectangles stacked in y, the bar and the stem: the same answer an even-odd
// polygon test on T_PTS gives, without the loop.
const [BAR_X0, BAR_Y1] = T_PTS[0];
const [BAR_X1, BAR_Y0] = T_PTS[2];
const [STEM_X1, STEM_Y0] = T_PTS[4];
const STEM_X0 = T_PTS[5][0];
function inT(x, y) {
  if (y >= BAR_Y0) return y < BAR_Y1 && x >= BAR_X0 && x < BAR_X1;
  return y >= STEM_Y0 && x >= STEM_X0 && x < STEM_X1;
}
const clamp = (a, b, v) => Math.min(b, Math.max(a, v));
const smooth = (t) => t * t * (3 - 2 * t);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const backOut = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
const lerpAng = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// ── the rollout ──────────────────────────────────────────────
// the goal stands upright on screen; every episode starts on the left
const GOAL = [0.7, 0.1, Math.PI];
const LOOP = 8.3;
const R_AGENT = 1.3 / UNIT;


function studioEnvironment(renderer) {
  // a dark room with two long strip lights: sharp, travelling highlights
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x020202);
  const strip = new THREE.BoxGeometry(14, 0.25, 1.2);
  const hot = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(7, 7, 7) });
  const warm = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(3.0, 3.0, 3.0) });
  const a = new THREE.Mesh(strip, hot);
  a.position.set(0, 6, -6);
  a.rotation.x = 0.5;
  const b = new THREE.Mesh(strip, warm);
  b.position.set(-4, 3, 7);
  b.rotation.set(-0.4, 0.6, 0);
  env.add(a, b);
  const pmrem = new THREE.PMREMGenerator(renderer);
  return pmrem.fromScene(env, 0.02).texture;
}

// wait a frame, then a task: each build step gets its own slice of time
const breathe = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export async function createPushT(host) {
  FACE[BG].set(token("--disc-off", "#0c0c0c"));
  FACE[WHITE].set(token("--disc", "#f3f1ec"));
  FACE[ORANGE].set(token("--orange", "#ff5a1f"));
  const STAGE = new THREE.Color(token("--stage", "#050505"));
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(STAGE, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.environment = studioEnvironment(renderer);
  await breathe();
  scene.environmentIntensity = 0.62;
  scene.fog = new THREE.Fog(STAGE, 70, 125);

  const camera = new THREE.PerspectiveCamera(26, 2, 1, 400);

  const key = new THREE.DirectionalLight("#ffffff", 1.0);
  key.position.set(-40, 60, 30);
  scene.add(key);
  const rim = new THREE.DirectionalLight("#ffffff", 0.8);
  rim.position.set(10, 9, -60);
  scene.add(rim);

  // ── discs ──────────────────────────────────────────────────
  const geo = new THREE.CylinderGeometry(0.42, 0.42, 0.05, host.clientWidth < 760 ? 18 : 30, 1);
  const side = new Float32Array(geo.attributes.position.count);
  const nrm = geo.attributes.normal;
  for (let i = 0; i < side.length; i++) side[i] = nrm.getY(i) > 0.5 ? 1 : nrm.getY(i) < -0.5 ? -1 : 0;
  geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
  const top = new Float32Array(N * 3);
  const bot = new Float32Array(N * 3);
  const iTop = new THREE.InstancedBufferAttribute(top, 3).setUsage(THREE.DynamicDrawUsage);
  const iBot = new THREE.InstancedBufferAttribute(bot, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("iTop", iTop);
  geo.setAttribute("iBot", iBot);

  const mat = new THREE.MeshPhysicalMaterial({
    roughness: 0.42,
    clearcoat: 0.7,
    clearcoatRoughness: 0.22,
    vertexColors: true,
  });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aSide;\nattribute vec3 iTop;\nattribute vec3 iBot;")
      .replace(
        "#include <color_vertex>",
        "#include <color_vertex>\nvColor.rgb = aSide > 0.5 ? iTop : (aSide < -0.5 ? iBot : vec3(0.02));"
      );
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * 0.42;"
    );
  };
  const discs = new THREE.InstancedMesh(geo, mat, N);
  discs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(discs);

  const plate = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ color: STAGE }));
  plate.rotation.x = -Math.PI / 2;
  plate.position.y = -0.45;
  scene.add(plate);

  // per-disc state
  const xs = new Float32Array(N);
  const zs = new Float32Array(N);
  const tiltX = new Float32Array(N);
  const tiltZ = new Float32Array(N);
  const shown = new Uint8Array(N);
  const want = new Uint8Array(N);
  const angle = new Float32Array(N);
  const from = new Float32Array(N);
  const to = new Float32Array(N);
  const t0 = new Float32Array(N).fill(-1);
  const dur = new Float32Array(N);
  const tOn = new Uint8Array(N);
  const goalIn = new Uint8Array(N);
  const goalEdge = new Uint8Array(N);
  const jit = Float32Array.from({ length: N }, (_, k) => hash(k)); // per-disc stagger, fixed

  let facesDirty = true;
  const setFace = (k, faceTop, c) => {
    facesDirty = true;
    const a = faceTop ? top : bot;
    a[k * 3] = c.r;
    a[k * 3 + 1] = c.g;
    a[k * 3 + 2] = c.b;
  };

  const OFF = [-0.375, -0.125, 0.125, 0.375].map((o) => o / UNIT);
  const REACH = (T_R + 0.2) ** 2;
  // c, s: the pose's yaw, rotated once per pose rather than once per sample
  function coverage(k, pose, c, s) {
    const dx0 = xs[k] / UNIT - pose[0];
    const dz0 = zs[k] / UNIT - pose[1];
    if (dx0 * dx0 + dz0 * dz0 > REACH) return 0;
    let n = 0;
    for (const ox of OFF) {
      const dx = dx0 + ox;
      for (const oz of OFF) {
        const dz = dz0 + oz;
        if (inT(dx * c + dz * s, -dx * s + dz * c)) n++;
      }
    }
    return n / 16;
  }
  const GOAL_C = Math.cos(GOAL[2]);
  const GOAL_S = Math.sin(GOAL[2]);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const k = r * COLS + c;
      xs[k] = c - (COLS - 1) / 2;
      zs[k] = r - (ROWS - FRONT) + 0.5;
      tiltX[k] = (hash(k) - 0.5) * 0.042;
      tiltZ[k] = (hash(k + 99) - 0.5) * 0.042;
      setFace(k, true, FACE[BG]);
      setFace(k, false, FACE[BG]);
      goalIn[k] = coverage(k, GOAL, GOAL_C, GOAL_S) >= 0.5 ? 1 : 0;
    }
  }
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const k = r * COLS + c;
      if (!goalIn[k]) continue;
      const out = (dc, dr) => {
        const cc = c + dc;
        const rr = r + dr;
        return cc < 0 || rr < 0 || cc >= COLS || rr >= ROWS || !goalIn[rr * COLS + cc];
      };
      goalEdge[k] = out(1, 0) || out(-1, 0) || out(0, 1) || out(0, -1) ? 1 : 0;
    }
  }

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e3 = new THREE.Euler();
  const v3 = new THREE.Vector3();
  const ONE = new THREE.Vector3(1, 1, 1);
  function writeDisc(k) {
    // discs turn on a side axle, like real flip-dots: mid-turn they show only an edge
    e3.set(tiltX[k], 0, angle[k] + tiltZ[k]);
    q.setFromEuler(e3);
    v3.set(xs[k], Math.abs(Math.sin(angle[k])) * 0.2, zs[k]);
    m4.compose(v3, q, ONE);
    discs.setMatrixAt(k, m4);
  }
  for (let k = 0; k < N; k++) writeDisc(k);

  function flip(k, ci, now, delay = 0) {
    if (t0[k] >= 0 ? want[k] === ci : shown[k] === ci) return;
    const next = (Math.floor(angle[k] / Math.PI + 1e-4) + 1) * Math.PI;
    setFace(k, Math.round(next / Math.PI) % 2 === 0, FACE[ci]);
    from[k] = angle[k];
    to[k] = next;
    t0[k] = now + delay;
    dur[k] = 0.15;
    want[k] = ci;
  }
  // a full turn in place: the disc catches the light and lands on the same face
  function spin(k, now, delay) {
    if (t0[k] >= 0) return;
    setFace(k, true, FACE[shown[k]]);
    setFace(k, false, FACE[shown[k]]);
    from[k] = angle[k];
    to[k] = angle[k] + Math.PI * 2;
    t0[k] = now + delay;
    dur[k] = 0.62;
    want[k] = shown[k];
  }


  // ── the policy: a glossy puck ──────────────────────────────
  const puck = new THREE.Mesh(
    new THREE.CylinderGeometry(1.3, 1.3, 0.5, 64),
    new THREE.MeshPhysicalMaterial({
      color: token("--puck", "#0a2cf0"),
      emissive: token("--puck", "#0a2cf0"),
      emissiveIntensity: 0.5,
      roughness: 0.18,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
    })
  );
  scene.add(puck);
  const puckLight = new THREE.PointLight(token("--puck-light", "#2a4bff"), 3, 4.5, 2);
  scene.add(puckLight);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(5, 5).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "varying vec2 vUv; void main(){ float r = length(vUv - 0.5) * 2.0; gl_FragColor = vec4(0.0, 0.0, 0.0, 0.75 * exp(-r * r * 3.0)); }",
    })
  );
  shadow.position.y = 0.06;
  scene.add(shadow);

  const REST = [-5.4, 0.4];
  let revealT = -1;
  const focus = new THREE.Vector3();

  // the policy and the physics live in the sim; this file only renders them
  const sim = createSim({ pts: T_PTS, radius: R_AGENT, goal: GOAL, rest: REST });
  let rngSeed = 11;
  const rand = () => (rngSeed = (rngSeed * 16807) % 2147483647) / 2147483647;
  const randomStart = () => [-2.9 + rand() * 1.2, -1.5 + rand() * 3.0, Math.PI + (rand() - 0.5) * 5.4];

  const ep = { phase: "hold", t: 0, settleFrom: null };
  sim.reset(randomStart());
  sim.mode = "idle";

  function step(time, dt) {
    ep.t += dt;
    if (ep.phase === "hold") {
      sim.step(dt);
      if (ep.t > 0.6) {
        sim.mode = "push";
        Object.assign(ep, { phase: "push", t: 0 });
      }
    } else if (ep.phase === "push") {
      sim.step(dt);
      const er = sim.error();
      // docked: within tolerance, or a gentle hand-off on the rare slow solve
      if ((er.pos < 0.12 && er.ang < 0.08) || sim.pushTime > 11) {
        sim.mode = "retreat";
        ep.settleFrom = [sim.T.x, sim.T.z, sim.T.th];
        Object.assign(ep, { phase: "settle", t: 0 });
      }
    } else if (ep.phase === "settle") {
      // the last push lands: the T eases the final millimetres onto the goal
      const k = smooth(Math.min(1, ep.t / 0.4));
      const [x0, z0, th0] = ep.settleFrom;
      sim.T.x = x0 + (GOAL[0] - x0) * k;
      sim.T.z = z0 + (GOAL[1] - z0) * k;
      sim.T.th = th0 + Math.atan2(Math.sin(GOAL[2] - th0), Math.cos(GOAL[2] - th0)) * k;
      sim.T.vx = sim.T.vz = sim.T.w = 0;
      sim.step(dt);
      if (ep.t > 0.4) {
        Object.assign(ep, { phase: "celebrate", t: 0 });
        const gx0 = GOAL[0] * UNIT;
        const gz0 = GOAL[1] * UNIT;
        for (let k2 = 0; k2 < N; k2++) {
          if (tOn[k2] && goalIn[k2]) spin(k2, time, Math.hypot(xs[k2] - gx0, zs[k2] - gz0) * 0.018);
        }
      }
    } else if (ep.phase === "celebrate") {
      sim.step(dt);
      if (ep.t > 1.3) Object.assign(ep, { phase: "clear", t: 0 });
    } else if (ep.phase === "clear") {
      sim.mode = "away";
      sim.step(dt);
      if (ep.t > 1.0) {
        sim.reset(randomStart());
        sim.mode = "idle";
        Object.assign(ep, { phase: "hold", t: 0 });
      }
    }

    const pose = ep.phase === "clear" ? null : [sim.T.x, sim.T.z, sim.T.th];
    puck.position.set(sim.P.x * UNIT, 0.62, sim.P.z * UNIT);
    puckLight.position.set(sim.P.x * UNIT, 0.7, sim.P.z * UNIT);
    shadow.position.set(sim.P.x * UNIT, 0.06, sim.P.z * UNIT);

    const reveal = revealT >= 0 && time - revealT < 1.6;
    const clearing = ep.phase === "clear";
    const pc = pose ? Math.cos(pose[2]) : 0;
    const ps = pose ? Math.sin(pose[2]) : 0;
    for (let k = 0; k < N; k++) {
      // coverage with hysteresis: no stair-step flicker on rotated edges
      if (pose) {
        const cv = coverage(k, pose, pc, ps);
        if (cv >= 0.6) tOn[k] = 1;
        else if (cv <= 0.4) tOn[k] = 0;
      } else tOn[k] = 0;

      let ci = BG;
      if (tOn[k]) ci = goalIn[k] ? ORANGE : WHITE;
      else if (goalEdge[k]) ci = ORANGE;

      const col = (k % COLS) / COLS;
      const lag = reveal ? col * 0.9 + jit[k] * 0.08 : clearing ? col * 0.6 + jit[k] * 0.024 : jit[k] * 0.024;
      flip(k, ci, time, lag);
    }

    const fp = pose || GOAL;
    focus.set(((fp[0] + sim.P.x) / 2) * UNIT, 0, ((fp[1] + sim.P.z) / 2) * UNIT);
  }

  function animate(now) {
    let moved = false;
    for (let k = 0; k < N; k++) {
      if (t0[k] < 0 || now < t0[k]) continue;
      const p = Math.min(1, (now - t0[k]) / dur[k]);
      angle[k] = from[k] + (to[k] - from[k]) * backOut(p);
      if (p >= 1) {
        angle[k] = to[k] % (Math.PI * 2);
        shown[k] = want[k];
        t0[k] = -1;
      }
      writeDisc(k);
      moved = true;
    }
    if (moved) discs.instanceMatrix.needsUpdate = true;
    if (facesDirty) {
      iTop.needsUpdate = true;
      iBot.needsUpdate = true;
      facesDirty = false;
    }
  }

  // ── camera, post ───────────────────────────────────────────
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }));
  composer.addPass(new RenderPass(scene, camera));
  const bokeh = new BokehPass(scene, camera, { focus: 70, aperture: 0.0011, maxblur: 0.007 });
  composer.addPass(bokeh);
  composer.addPass(new OutputPass());

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

  let dist = 70;
  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    // frame the T and its goal at about half the width
    const half = Math.tan((camera.fov * Math.PI) / 360);
    dist = Math.max(34 / (half * camera.aspect), 16 / half);
    scene.fog.near = dist * 1.15;
    scene.fog.far = dist * 1.8;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const aim = new THREE.Vector3(-1.0 * UNIT, 0, 0.2 * UNIT);
  let focusDist = 70;
  let raf = 0;
  let last = 0;
  let clock = 0;
  function frame(nowMs) {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.05, (nowMs - last) / 1000) : 0.016;
    last = nowMs;
    clock += dt;
    if (revealT < 0) revealT = clock;

    look.x += (look.tx - look.x) * 0.05;
    look.y += (look.ty - look.y) * 0.05;
    const push = 1 - 0.03 * ((clock % LOOP) / LOOP);
    const yaw = -0.08 + look.x * 0.035 + Math.sin(clock * 1.9) * 0.0007;
    const elev = 0.67 - look.y * 0.02 + Math.cos(clock * 1.7) * 0.0007;
    const d = dist * push;
    camera.position.set(
      aim.x + Math.sin(yaw) * Math.cos(elev) * d,
      Math.sin(elev) * d,
      aim.z + Math.cos(yaw) * Math.cos(elev) * d
    );
    camera.lookAt(aim);

    // the highlight streak travels across the board
    scene.environmentRotation.y = 0.4 + Math.sin(clock * 0.16) * 0.35;

    step(clock, dt);
    animate(clock);
    focusDist += (camera.position.distanceTo(focus) - focusDist) * 0.08;
    bokeh.uniforms.focus.value = focusDist;
    composer.render();
  }
  // compile every shader up front so the first frame doesn't stall, then
  // run immediately — the rollout starts with the page, even while below the fold
  await breathe();
  renderer.setRenderTarget(composer.readBuffer);
  await renderer.compileAsync(scene, camera);
  renderer.setRenderTarget(null);
  await breathe();
  last = 0;
  raf = requestAnimationFrame(frame);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scene.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) [].concat(o.material).forEach((m) => m.dispose());
      });
      composer.dispose?.();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
