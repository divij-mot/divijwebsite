import React, { useEffect, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg'; // Make sure this import is correct

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

      // --- Use the ESM core from CDN ---
      // Note: @ffmpeg/core (single-thread) is generally fine even with crossOriginIsolated=true
      const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm'; // <-- Changed to esm
      const coreURL = `${baseURL}/ffmpeg-core.js`;
      const wasmURL = `${baseURL}/ffmpeg-core.wasm`;
      const workerURL = `${baseURL}/ffmpeg-core.worker.js`; // <-- Added worker URL
      // --- End ESM URLs ---

      console.log("Minimal Load: Core URL", coreURL);
      console.log("Minimal Load: Wasm URL", wasmURL);
      console.log("Minimal Load: Worker URL", workerURL); // Log the worker URL too
      console.log('Minimal Load: crossOriginIsolated:', self.crossOriginIsolated);

      try {
        // Load using ESM core, wasm, and worker URLs
        await ffmpeg.load({ coreURL, wasmURL, workerURL }); // <-- Pass all three URLs

        setMessage('Minimal: FFmpeg loaded successfully!');
        console.log("Minimal Load: Success");
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        setMessage(`Minimal: FFmpeg load failed: ${errorMsg}`);
        console.error("Minimal Load: Error Object", e);
        // Add more detailed logging if possible
        if (e instanceof Error && e.stack) {
            console.error("Minimal Load: Error Stack", e.stack);
        }
      }
    };

    // Removed the setTimeout, usually not necessary and can hide other timing issues
    load();

    // No cleanup needed for this load pattern unless you were adding event listeners

  }, []); // Empty dependency array

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