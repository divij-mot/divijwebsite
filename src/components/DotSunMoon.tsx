import React, { useEffect, useRef } from 'react';

interface DotSunMoonProps {
  isDark: boolean;
  isSecret: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export const DotSunMoon: React.FC<DotSunMoonProps> = ({ 
  isDark, 
  isSecret, 
  onClick,
  onMouseEnter,
  onMouseLeave 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = 80;
    canvas.width = size;
    canvas.height = size;

    let time = 0;
    const dotSize = 1.5;
    const spacing = 3;

    const draw = () => {
      ctx.clearRect(0, 0, size, size);

      const centerX = size / 2;
      const centerY = size / 2;
      const radius = 18;

      // Draw dots in circular pattern
      for (let angle = 0; angle < Math.PI * 2; angle += 0.2) {
        for (let r = 0; r < radius; r += spacing) {
          const x = centerX + Math.cos(angle) * r;
          const y = centerY + Math.sin(angle) * r;

          const distFromCenter = Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));
          
          // For moon, create crescent shape (keep shape even when secret)
          if (isDark) {
            const moonOffsetX = 8;
            const distFromMoonCenter = Math.sqrt(
              Math.pow(x - (centerX + moonOffsetX), 2) + Math.pow(y - centerY, 2)
            );
            if (distFromMoonCenter < radius * 0.7) continue;
          }

          if (distFromCenter < radius) {
            const opacity = 0.6 + Math.random() * 0.4;
            
            let color;
            if (isSecret) {
              color = `rgba(220, 38, 38, ${opacity})`; // Red for secret
            } else if (isDark) {
              color = `rgba(245, 245, 245, ${opacity})`; // White for moon
            } else {
              color = `rgba(64, 64, 64, ${opacity})`; // Dark for sun
            }

            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, dotSize, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Sun rays (keep rays even when secret if in light mode)
      if (!isDark) {
        const rayLength = 12;
        const rayAngles = [0, Math.PI/4, Math.PI/2, 3*Math.PI/4, Math.PI, 5*Math.PI/4, 3*Math.PI/2, 7*Math.PI/4];
        
        rayAngles.forEach(angle => {
          for (let i = 0; i < 4; i++) {
            const distance = radius + 2 + i * 3;
            const x = centerX + Math.cos(angle) * distance;
            const y = centerY + Math.sin(angle) * distance;
            
            const opacity = 0.5 + Math.random() * 0.3;
            const rayColor = isSecret ? `rgba(220, 38, 38, ${opacity})` : `rgba(64, 64, 64, ${opacity})`;
            ctx.fillStyle = rayColor;
            ctx.beginPath();
            ctx.arc(x, y, dotSize, 0, Math.PI * 2);
            ctx.fill();
          }
        });
      }

      time += 0.01;
      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isDark, isSecret]);

  return (
    <button
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed top-6 left-6 transition-all duration-500 z-20 cursor-pointer hover:opacity-80"
      aria-label={isSecret ? 'Enter site' : 'Toggle theme'}
    >
      <canvas
        ref={canvasRef}
        className="block"
        style={{ imageRendering: 'pixelated' }}
      />
    </button>
  );
};

