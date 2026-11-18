// Decodes the capture and samples its points off the main thread, so building
// the parking lot never stalls scrolling.
import { IMG_W, IMG_H, samplePoints } from "./period-points.js";

self.onmessage = async ({ data: { src } }) => {
  try {
    const blob = await (await fetch(src)).blob();
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(IMG_W, IMG_H);
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0, IMG_W, IMG_H);
    bmp.close?.();
    const pts = samplePoints(cx.getImageData(0, 0, IMG_W, IMG_H).data);
    self.postMessage({ pts }, Object.values(pts).map((a) => a.buffer));
  } catch (e) {
    self.postMessage({ error: String(e) });
  }
};
