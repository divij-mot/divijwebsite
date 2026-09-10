import React, { useEffect, useRef } from 'react';

interface DotsLandscapeProps {
  isDark?: boolean;
}

function hash(x: number, y: number) {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

export const DotsLandscape: React.FC<DotsLandscapeProps> = ({ isDark = false }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let time = 0;
    let lastFrame = 0;
    let color = isDarkRef.current
      ? { r: 200, g: 200, b: 200 }
      : { r: 50, g: 50, b: 50 };

    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth || window.innerWidth));
      const h = Math.max(1, Math.round(canvas.clientHeight || window.innerHeight * 0.2));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    const draw = (now: number) => {
      animationRef.current = requestAnimationFrame(draw);
      if (document.hidden) return;

      const coarse = window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
      if (now - lastFrame < (coarse ? 80 : 50)) return;
      lastFrame = now;

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      const target = isDarkRef.current
        ? { r: 200, g: 200, b: 200 }
        : { r: 50, g: 50, b: 50 };
      color.r += (target.r - color.r) * 0.15;
      color.g += (target.g - color.g) * 0.15;
      color.b += (target.b - color.b) * 0.15;

      const spacing = coarse ? 11 : 8;
      const dotSize = coarse ? 1.7 : 1.5;
      const cols = Math.ceil(width / spacing) + 1;
      const rows = Math.ceil(height / spacing) + 1;
      const startRow = Math.floor(rows * 0.7);
      const span = Math.max(1, rows - startRow);

      for (let y = startRow; y < rows; y++) {
        const normY = (y - startRow) / span;
        for (let x = 0; x < cols; x++) {
          const normX = cols <= 1 ? 0 : x / (cols - 1);
          const wave1 = Math.sin(normX * Math.PI * 4 + time * 0.5) * 0.1;
          const wave2 = Math.sin(normX * Math.PI * 2 - time * 0.3) * 0.15;
          const wave3 = Math.cos(normX * Math.PI * 6 + time * 0.7) * 0.05;
          const mountain = Math.sin(normX * Math.PI * 2) * 0.3 * (1 - normY);
          const elevation = wave1 + wave2 + wave3 + mountain;
          const threshold = normY - 0.5 + elevation;
          if (threshold <= 0) continue;

          const jitter = hash(x, y);
          const depthFactor = 1 - normY * 0.7;
          const size = dotSize * depthFactor * (0.8 + jitter * 0.4);
          const dark = isDarkRef.current;
          const opacity = dark
            ? 0.3 + normY * 0.5 + elevation * 0.2
            : 0.4 + normY * 0.4 + elevation * 0.2;

          ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.min(opacity, dark ? 0.9 : 0.8)})`;
          ctx.beginPath();
          ctx.arc(x * spacing, y * spacing, size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      time += coarse ? 0.018 : 0.01;
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener('resize', resize);
    animationRef.current = requestAnimationFrame(draw);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  return <canvas ref={canvasRef} className="landing-landscape" />;
};
