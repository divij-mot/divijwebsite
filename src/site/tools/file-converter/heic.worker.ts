/* HEIC decoding off the main thread, so a batch of photos never freezes the page. */
import { heicTo } from 'heic-to/next';

const scope = self as unknown as Worker;

scope.onmessage = async (e: MessageEvent<{ id: number; blob: Blob }>) => {
  const { id, blob } = e.data;
  try {
    const bitmap = await heicTo({ blob, type: 'bitmap' });
    scope.postMessage({ id, bitmap }, [bitmap]);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
