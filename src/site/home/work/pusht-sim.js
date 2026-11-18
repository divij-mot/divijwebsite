/*
  push-T, simulated.

  The T is a rigid body sliding on a high-friction table: it moves only while
  something pushes it. The puck is the policy — kinematic, it chooses where on
  the T's outline to push so the T's motion heads for the goal pose, gets
  there without touching the T, then pushes. Contacts are resolved with
  impulses, so the T translates and turns exactly as the push dictates.

  Coordinates: env units, plane (x, z), yaw θ. A local T point (u, v) sits at
  world (x + u·cosθ − v·sinθ, z + u·sinθ + v·cosθ).
*/

const clamp = (a, b, v) => Math.min(b, Math.max(a, v));
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export function createSim({ pts, radius, goal, rest }) {
  const R = radius;

  // ── body properties (two rectangles: bar + stem) ───────────
  // derived from the outline: bar = top edge to bar underside, stem below
  const ys = pts.map((p) => p[1]);
  const top = Math.max(...ys);
  const barLow = pts[2][1];
  const barW = pts[1][0] - pts[0][0];
  const stemW = pts[3][0] - pts[6][0];
  const bot = Math.min(...ys);
  const aBar = barW * (top - barLow);
  const aStem = stemW * (barLow - bot);
  const M = 1;
  const mBar = (M * aBar) / (aBar + aStem);
  const mStem = M - mBar;
  const yBar = (top + barLow) / 2;
  const yStem = (barLow + bot) / 2;
  const I =
    (mBar * (barW * barW + (top - barLow) ** 2)) / 12 + mBar * yBar * yBar +
    (mStem * (stemW * stemW + (barLow - bot) ** 2)) / 12 + mStem * yStem * yStem;

  // outline samples with outward normals (outline is clockwise in u, v)
  const edge = [];
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const len = Math.hypot(bx - ax, by - ay);
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const n = Math.max(2, Math.round(len / 0.05));
    for (let j = 1; j < n; j++) edge.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n, nx, ny]);
  }

  function inPoly(u, v) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  const T = { x: 0, z: 0, th: 0, vx: 0, vz: 0, w: 0 };
  const P = { x: rest[0], z: rest[1] };

  // signed distance from a world point to the T (+ outside), outward normal, closest point
  function sd(x, z) {
    const c = Math.cos(T.th);
    const s = Math.sin(T.th);
    const dx = x - T.x;
    const dz = z - T.z;
    const u = dx * c + dz * s;
    const v = -dx * s + dz * c;
    let best = Infinity;
    let bu = 0;
    let bv = 0;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const ex = bx - ax;
      const ey = by - ay;
      const h = clamp(0, 1, ((u - ax) * ex + (v - ay) * ey) / (ex * ex + ey * ey));
      const qx = ax + ex * h;
      const qy = ay + ey * h;
      const d = Math.hypot(u - qx, v - qy);
      if (d < best) {
        best = d;
        bu = qx;
        bv = qy;
      }
    }
    const inside = inPoly(u, v);
    let gu = u - bu;
    let gv = v - bv;
    const gl = Math.hypot(gu, gv) || 1;
    gu /= gl;
    gv /= gl;
    if (inside) {
      gu = -gu;
      gv = -gv;
    }
    return {
      d: inside ? -best : best,
      nx: gu * c - gv * s,
      nz: gu * s + gv * c,
      cx: T.x + bu * c - bv * s,
      cz: T.z + bu * s + bv * c,
    };
  }

  // ── contact physics ────────────────────────────────────────
  function contact(pvx, pvz, h) {
    const k = sd(P.x, P.z);
    if (k.d >= R) return false;
    const pen = R - k.d;
    const nx = -k.nx; // push direction, into the T
    const nz = -k.nz;
    const rx = k.cx - T.x;
    const rz = k.cz - T.z;
    // velocity of the T's surface at the contact
    const sx = T.vx - T.w * rz;
    const sz = T.vz + T.w * rx;
    const vn = (pvx - sx) * nx + (pvz - sz) * nz + (0.35 * pen) / h;
    if (vn <= 0) return true;
    const rn = rx * nz - rz * nx;
    const j = vn / (1 / M + (rn * rn) / I);
    T.vx += (nx * j) / M;
    T.vz += (nz * j) / M;
    T.w += (rn * j) / I;
    // a little friction at the contact makes off-centre pushes turn the T
    const tx = -nz;
    const tz = nx;
    const vt = (pvx - sx) * tx + (pvz - sz) * tz;
    const rt = rx * tz - rz * tx;
    const jt = clamp(-0.25 * j, 0.25 * j, vt / (1 / M + (rt * rt) / I));
    T.vx += (tx * jt) / M;
    T.vz += (tz * jt) / M;
    T.w += (rt * jt) / I;
    return true;
  }

  // ── the policy ─────────────────────────────────────────────
  let current = -1;
  function choose() {
    const ex = goal[0] - T.x;
    const ez = goal[1] - T.z;
    const eth = angDiff(goal[2], T.th);
    const dist = Math.hypot(ex, ez);
    const sp = Math.min(2.0, 0.3 + dist * 2.0);
    const vdx = dist > 1e-6 ? (ex / dist) * sp : 0;
    const vdz = dist > 1e-6 ? (ez / dist) * sp : 0;
    const wd = clamp(-1.3, 1.3, eth * (dist < 0.8 ? 2.4 : 1.4));
    const dn = Math.hypot(vdx, vdz, wd);
    if (dn < 1e-4) return { idx: -1, need: 0 };
    const c = Math.cos(T.th);
    const s = Math.sin(T.th);
    let best = -1;
    let bestS = -Infinity;
    const scores = new Float32Array(edge.length);
    for (let i = 0; i < edge.length; i++) {
      const [u, v, nu, nv] = edge[i];
      const rx = u * c - v * s;
      const rz = u * s + v * c;
      const nx = nu * c - nv * s;
      const nz = nu * s + nv * c;
      // pre-contact spot must be free of the T
      const qx = T.x + rx + nx * (R + 0.004);
      const qz = T.z + rz + nz * (R + 0.004);
      if (sd(qx, qz).d < R * 0.97) {
        scores[i] = -Infinity;
        continue;
      }
      // motion produced by a unit push into the T here
      const gx = -nx / M;
      const gz = -nz / M;
      const gw = (rx * -nz - rz * -nx) / I;
      const gn = Math.hypot(gx, gz, gw);
      const score = (gx * vdx + gz * vdz + gw * wd) / (gn * dn);
      scores[i] = score;
      if (score > bestS) {
        bestS = score;
        best = i;
      }
    }
    // stay with the current spot unless another is clearly better
    if (current >= 0 && scores[current] > bestS - 0.1 && scores[current] > 0.35) best = current;
    current = best;
    return { idx: best, need: dn, score: bestS };
  }

  function spot(i) {
    const [u, v, nu, nv] = edge[i];
    const c = Math.cos(T.th);
    const s = Math.sin(T.th);
    const nx = nu * c - nv * s;
    const nz = nu * s + nv * c;
    return {
      x: T.x + u * c - v * s + nx * (R + 0.004),
      z: T.z + u * s + v * c + nz * (R + 0.004),
      nx,
      nz,
    };
  }

  const T_R = Math.max(...pts.map(([u, v]) => Math.hypot(u, v)));
  function blocked(ax, az, bx, bz, clear) {
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.05);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (sd(ax + (bx - ax) * t, az + (bz - az) * t).d < clear) return true;
    }
    return false;
  }
  // approach a push spot straight down its normal; circle the T only if the way is blocked
  function route(tx, tz, nx, nz) {
    const px = P.x - tx;
    const pz = P.z - tz;
    const along = px * nx + pz * nz;
    const lateral = Math.abs(-px * nz + pz * nx);
    if (along > -0.02 && along < 0.95 && lateral < 0.09) return [tx, tz, true];
    let L = 0.9;
    while (L > 0.3 && sd(tx + nx * L, tz + nz * L).d < R + 0.04) L -= 0.1;
    const ax = tx + nx * L;
    const az = tz + nz * L;
    if (!blocked(P.x, P.z, ax, az, R + 0.04)) return [ax, az, false];
    const a0 = Math.atan2(P.z - T.z, P.x - T.x);
    const a1 = Math.atan2(az - T.z, ax - T.x);
    const da = angDiff(a1, a0);
    if (Math.abs(da) < 0.3) return [ax, az, false]; // close in angle: slide the rest
    const r = Math.max(T_R + R + 0.35, Math.hypot(P.x - T.x, P.z - T.z));
    const a = a0 + clamp(-0.6, 0.6, da);
    return [T.x + Math.cos(a) * r, T.z + Math.sin(a) * r, false];
  }

  // move the puck toward a point, sliding around the T instead of into it
  function steer(tx, tz, speed, h, allowTouch) {
    let dx = tx - P.x;
    let dz = tz - P.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return [0, 0];
    dx /= d;
    dz /= d;
    const v0 = Math.min(speed, d / h);
    if (!allowTouch) {
      // slide round the T only when the next step would actually touch it
      const nx0 = P.x + dx * v0 * h;
      const nz0 = P.z + dz * v0 * h;
      const k = sd(nx0, nz0);
      if (k.d < R + 0.03) {
        let tgx = -k.nz;
        let tgz = k.nx;
        if (tgx * dx + tgz * dz < 0) {
          tgx = -tgx;
          tgz = -tgz;
        }
        dx = tgx + k.nx * Math.max(0, R + 0.05 - k.d) * 8;
        dz = tgz + k.nz * Math.max(0, R + 0.05 - k.d) * 8;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l;
        dz /= l;
      }
    }
    const v = Math.min(speed, d / h);
    return [dx * v, dz * v];
  }

  // ── episode ────────────────────────────────────────────────
  let mode = "idle";
  let pushTime = 0;
  function reset(start) {
    T.x = start[0];
    T.z = start[1];
    T.th = start[2];
    T.vx = T.vz = T.w = 0;
    current = -1;
    mode = "push";
    pushTime = 0;
  }

  const SUB = 4;
  function step(dt) {
    const h = dt / SUB;
    let touching = false;
    for (let n = 0; n < SUB; n++) {
      let pvx = 0;
      let pvz = 0;
      if (mode === "push") {
        pushTime += h;
        const { idx, need, score } = choose();
        if (idx >= 0) {
          const q = spot(idx);
          const gap = Math.hypot(q.x - P.x, q.z - P.z);
          if (gap < 0.05) {
            // on the spot: push into the T, as hard as the error and the alignment warrant
            const speed = clamp(0.4, 2.5, need * 1.4 * Math.max(0.25, score));
            pvx = -q.nx * speed + (q.x - P.x) * 6;
            pvz = -q.nz * speed + (q.z - P.z) * 6;
          } else {
            const [wx, wz, final] = route(q.x, q.z, q.nx, q.nz);
            [pvx, pvz] = steer(wx, wz, final ? 3.0 : 5.6, h, final);
          }
        }
      } else if (mode === "retreat") {
        [pvx, pvz] = steer(rest[0], rest[1], 2.4, h, false);
      }
      P.x += pvx * h;
      P.z += pvz * h;
      if (mode !== "away") touching = contact(pvx, pvz, h) || touching;
      // table friction: the T only moves while it's pushed
      const f = Math.exp(-11 * h);
      T.vx *= f;
      T.vz *= f;
      T.w *= f;
      T.x += T.vx * h;
      T.z += T.vz * h;
      T.th += T.w * h;
      // never leave the puck inside the T
      if (mode !== "away") {
        const k = sd(P.x, P.z);
        if (k.d < R) {
          P.x += k.nx * (R - k.d);
          P.z += k.nz * (R - k.d);
        }
      }
    }
    return touching;
  }

  function error() {
    return {
      pos: Math.hypot(goal[0] - T.x, goal[1] - T.z),
      ang: Math.abs(angDiff(goal[2], T.th)),
    };
  }

  return {
    T,
    P,
    reset,
    step,
    error,
    sd,
    get mode() {
      return mode;
    },
    set mode(m) {
      mode = m;
    },
    get pushTime() {
      return pushTime;
    },
  };
}
