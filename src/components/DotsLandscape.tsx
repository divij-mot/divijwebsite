import React, { useEffect, useRef } from 'react';

interface DotsLandscapeProps {
  isDark?: boolean;
}

export const DotsLandscape: React.FC<DotsLandscapeProps> = ({ isDark = false }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    resize();
    window.addEventListener('resize', resize);

    // Dot grid parameters
    const dotSpacing = 8;
    const dotSize = 1.5;
    let time = 0;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const cols = Math.ceil(canvas.width / dotSpacing);
      const rows = Math.ceil(canvas.height / dotSpacing);
      
      // Start from bottom 30% of screen (so it doesn't cover footer text)
      const startRow = Math.floor(rows * 0.7);
      
      // Calculate color transition ONCE per frame (not per dot - huge performance boost!)
      if (!canvas.dataset.currentDotR) {
        canvas.dataset.currentDotR = isDark ? '200' : '50';
        canvas.dataset.currentDotG = isDark ? '200' : '50';
        canvas.dataset.currentDotB = isDark ? '200' : '50';
      }
      
      const targetR = isDark ? 200 : 50;
      const targetG = isDark ? 200 : 50;
      const targetB = isDark ? 200 : 50;
      
      const currentDotR = parseFloat(canvas.dataset.currentDotR || '200');
      const currentDotG = parseFloat(canvas.dataset.currentDotG || '200');
      const currentDotB = parseFloat(canvas.dataset.currentDotB || '200');
      
      const lerpSpeed = 0.15; // Faster and matches SimpleDither
      const newDotR = currentDotR + (targetR - currentDotR) * lerpSpeed;
      const newDotG = currentDotG + (targetG - currentDotG) * lerpSpeed;
      const newDotB = currentDotB + (targetB - currentDotB) * lerpSpeed;
      
      canvas.dataset.currentDotR = String(newDotR);
      canvas.dataset.currentDotG = String(newDotG);
      canvas.dataset.currentDotB = String(newDotB);
      
      // Draw landscape dots
      for (let y = startRow; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const posX = x * dotSpacing;
          const posY = y * dotSpacing;
          
          // Normalized position
          const normX = x / cols;
          const normY = (y - startRow) / (rows - startRow);
          
          // Create wave patterns for landscape
          const wave1 = Math.sin(normX * Math.PI * 4 + time * 0.5) * 0.1;
          const wave2 = Math.sin(normX * Math.PI * 2 - time * 0.3) * 0.15;
          const wave3 = Math.cos(normX * Math.PI * 6 + time * 0.7) * 0.05;
          
          // Mountain-like shapes
          const mountain = Math.sin(normX * Math.PI * 2) * 0.3 * (1 - normY);
          
          // Combine waves
          const elevation = wave1 + wave2 + wave3 + mountain;
          
          // Determine if dot should be visible based on elevation and position
          const threshold = normY - 0.5 + elevation;
          
          if (threshold > 0) {
            // Size variation based on depth
            const depthFactor = 1 - normY * 0.7;
            const size = dotSize * depthFactor * (0.8 + Math.random() * 0.4);
            
            // Opacity variation for depth
            const opacity = isDark 
              ? 0.3 + normY * 0.5 + elevation * 0.2
              : 0.4 + normY * 0.4 + elevation * 0.2;
            
            // Use pre-calculated color (much more efficient!)
            ctx.fillStyle = `rgba(${newDotR}, ${newDotG}, ${newDotB}, ${Math.min(opacity, isDark ? 0.9 : 0.8)})`;
            
            ctx.beginPath();
            ctx.arc(posX, posY, size, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      
      time += 0.01;
      animationRef.current = requestAnimationFrame(draw);
    };

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
      className="fixed inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: 1, bottom: 0 }}
    />
  );
};

