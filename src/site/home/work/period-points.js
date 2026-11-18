// The capture, laid back down as a ground plane (inverse perspective): every
// lit pixel becomes a point. Shared by the worker and the main-thread fallback.

export const IMG_W = 976;
export const IMG_H = 506;
const HORIZON = -1.1 * IMG_H; // image-space horizon, above the frame
const K = 27628;
const F = 500;
const ZC = 38;
const ZS = 2.6; // restore the depth the screenshot's camera compressed
function ground(px, py) {
  const Z = K / (py - HORIZON);
  return [((px - IMG_W / 2) * Z) / F, (ZC - Z) * ZS];
}

// the same sRGB → linear conversion three.js applies to THREE.Color("#…")
const lin = (c) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));
const hex = (h) => [0, 2, 4].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
const BONE_DEFAULT = "#f2efe8";
const ORANGE_DEFAULT = "#ff5a1f";

// colours arrive as "#rrggbb" from the page's tokens (see lib/palette.js)
export function samplePoints(px, colors = {}) {
  const BONE = hex((colors.points || BONE_DEFAULT).slice(1));
  const ORANGE = hex((colors.accent || ORANGE_DEFAULT).slice(1));
  const cap = IMG_W * IMG_H;
  const pos = new Float32Array(cap * 3);
  const col = new Float32Array(cap * 3);
  const size = new Float32Array(cap);
  const alpha = new Float32Array(cap);
  const seed = new Float32Array(cap);
  let n = 0;
  const put = (x, y, z, c, s, a) => {
    pos[n * 3] = x;
    pos[n * 3 + 1] = y;
    pos[n * 3 + 2] = z;
    col[n * 3] = c[0];
    col[n * 3 + 1] = c[1];
    col[n * 3 + 2] = c[2];
    size[n] = s;
    alpha[n] = a;
    seed[n] = Math.random();
    n++;
  };
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
        put(x, 0.03, z, ORANGE, 1.4, 0.12);
      } else if (lum > 0.11) {
        const t = Math.min(1, (lum - 0.11) / 0.55);
        if (t < 0.08 && Math.random() > 0.5) continue;
        // stall paint reads bright, the rest of the ground stays quiet
        put(x, Math.random() * 0.06, z, BONE, 1.5 + t * 1.5, 0.08 + Math.pow(t, 1.4) * 0.92);
      }
    }
  }
  return {
    pos: pos.slice(0, n * 3),
    col: col.slice(0, n * 3),
    size: size.slice(0, n),
    alpha: alpha.slice(0, n),
    seed: seed.slice(0, n),
  };
}
