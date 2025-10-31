import React, { useEffect, useRef } from 'react';

interface SimpleDitherProps {
  isDark?: boolean;
}

export const SimpleDither: React.FC<SimpleDitherProps> = ({ isDark = false }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let time = 0;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    const draw = () => {
      const width = canvas.width;
      const height = canvas.height;

      // Base color - brighter in dark mode
      const baseColor = isDark 
        ? { r: 45, g: 45, b: 45 }
        : { r: 238, g: 229, b: 213 };

      // Create image data
      const imageData = ctx.createImageData(width, height);
      const data = imageData.data;

      // Bayer matrix for dithering
      const bayerMatrix = [
        [0, 8, 2, 10],
        [12, 4, 14, 6],
        [3, 11, 1, 9],
        [15, 7, 13, 5]
      ];

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          
          // Normalized coordinates
          const nx = x / width;
          const ny = y / height;
          
          // Create subtle wave patterns
          const wave1 = Math.sin(nx * Math.PI * 2 + time * 0.5) * 0.5;
          const wave2 = Math.cos(ny * Math.PI * 2 - time * 0.3) * 0.5;
          const wave3 = Math.sin((nx + ny) * Math.PI * 4 + time * 0.7) * 0.3;
          
          const waveValue = (wave1 + wave2 + wave3) * 3;
          
          // Dither pattern
          const bayerValue = bayerMatrix[y % 4][x % 4] / 16;
          const variation = (waveValue + bayerValue * 8 - 4);
          
          data[i] = Math.max(0, Math.min(255, baseColor.r + variation));
          data[i + 1] = Math.max(0, Math.min(255, baseColor.g + variation));
          data[i + 2] = Math.max(0, Math.min(255, baseColor.b + variation));
          data[i + 3] = 255;
        }
      }

      ctx.putImageData(imageData, 0, 0);
      time += 0.005;
      animationRef.current = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);
    draw();

    return () => {
      window.removeEventListener('resize', resize);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isDark]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full"
      style={{ zIndex: -2, imageRendering: 'pixelated' }}
    />
  );
};

