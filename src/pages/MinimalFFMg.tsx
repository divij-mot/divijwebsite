import React, { useEffect, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';

function MinimalFFmpegLoader() {
  const [message, setMessage] = useState('Initializing...');
  const ffmpegRef = useRef(new FFmpeg());
  const loadingStarted = useRef(false);

  useEffect(() => {
    const load = async () => {
      if (loadingStarted.current) {
          console.log("Minimal Load: Already started, skipping.");
          return;
      }
      loadingStarted.current = true;

      setMessage('Minimal: Attempting to load FFmpeg (using ESM core)...');
      const ffmpeg = ffmpegRef.current;

      const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
      const coreURL = `${baseURL}/ffmpeg-core.js`;
      const wasmURL = `${baseURL}/ffmpeg-core.wasm`;
      const workerURL = `${baseURL}/ffmpeg-core.worker.js`;

      console.log("Minimal Load: Core URL", coreURL);
      console.log("Minimal Load: Wasm URL", wasmURL);
      console.log("Minimal Load: Worker URL", workerURL);
      console.log('Minimal Load: crossOriginIsolated:', self.crossOriginIsolated);

      try {
        await ffmpeg.load({ coreURL, wasmURL, workerURL });

        setMessage('Minimal: FFmpeg loaded successfully!');
        console.log("Minimal Load: Success");
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        setMessage(`Minimal: FFmpeg load failed: ${errorMsg}`);
        console.error("Minimal Load: Error Object", e);
        if (e instanceof Error && e.stack) {
            console.error("Minimal Load: Error Stack", e.stack);
        }
      }
    };

    load();

  }, []);

  return (
      <div style={{ padding: '20px', fontFamily: 'sans-serif', border: '2px solid blue', margin: '10px' }}>
          <h1>Minimal FFmpeg Loader Test (ESM Core)</h1>
          <p>Status: <strong>{message}</strong></p>
          <p>Check the browser console and Network tab for detailed logs.</p>
          <p><code>crossOriginIsolated</code> is: <strong>{String(self.crossOriginIsolated)}</strong></p>
      </div>
  );
}

export default MinimalFFmpegLoader;