import React, { useEffect, useRef } from 'react';

interface SimpleDitherProps {
  isDark?: boolean;
}

export const SimpleDither: React.FC<SimpleDitherProps> = ({ isDark = false }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let time = 0;
    let imageData: ImageData | null = null;
    let color = isDarkRef.current
      ? { r: 45, g: 45, b: 45 }
      : { r: 238, g: 229, b: 213 };
    let lastFrame = 0;
    let width = 0;
    let height = 0;

    const bayerMatrix = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];

    const resize = () => {
      const cssW = Math.max(1, window.innerWidth);
      const cssH = Math.max(1, window.innerHeight);
      const coarse = window.matchMedia('(pointer: coarse)').matches || cssW < 768;
      const maxPixels = coarse ? 48_000 : 140_000;
      const scale = Math.max(1, Math.sqrt((cssW * cssH) / maxPixels));
      width = Math.max(1, Math.floor(cssW / scale));
      height = Math.max(1, Math.floor(cssH / scale));
      canvas.width = width;
      canvas.height = height;
      imageData = ctx.createImageData(width, height);
    };

    const draw = (now: number) => {
      animationRef.current = requestAnimationFrame(draw);
      if (document.hidden) return;

      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const interval = coarse ? 70 : 42;
      if (now - lastFrame < interval) return;
      lastFrame = now;

      if (!imageData) return;

      const target = isDarkRef.current
        ? { r: 45, g: 45, b: 45 }
        : { r: 238, g: 229, b: 213 };
      color.r += (target.r - color.r) * 0.15;
      color.g += (target.g - color.g) * 0.15;
      color.b += (target.b - color.b) * 0.15;

      const data = imageData.data;
      const t = time;

      for (let y = 0; y < height; y++) {
        const ny = y / height;
        const row = y * width;
        const bayerY = y & 3;
        for (let x = 0; x < width; x++) {
          const i = (row + x) * 4;
          const nx = x / width;
          const wave =
            Math.sin(nx * Math.PI * 2 + t * 0.5) * 0.5 +
            Math.cos(ny * Math.PI * 2 - t * 0.3) * 0.5 +
            Math.sin((nx + ny) * Math.PI * 4 + t * 0.7) * 0.3;
          const variation = wave * 3 + (bayerMatrix[bayerY][x & 3] / 16) * 8 - 4;
          data[i] = color.r + variation;
          data[i + 1] = color.g + variation;
          data[i + 2] = color.b + variation;
          data[i + 3] = 255;
        }
      }

      ctx.putImageData(imageData, 0, 0);
      time += coarse ? 0.012 : 0.005;
    };

    resize();
    window.addEventListener('resize', resize);
    animationRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', resize);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 h-full w-full"
      style={{ zIndex: -2, imageRendering: 'pixelated' }}
    />
  );
};
