import React, { useEffect, useState } from 'react';
import { useTheme } from '../context/ThemeContext';

export function MouseLight() {
  const { theme } = useTheme();
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isMoving, setIsMoving] = useState(false);
  let timeout: number;

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setPosition({ x: e.clientX, y: e.clientY });
      setIsMoving(true);
      
      clearTimeout(timeout);
      timeout = window.setTimeout(() => setIsMoving(false), 150);
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      clearTimeout(timeout);
    };
  }, []);

  return (
    <>
      <div
        className="fixed pointer-events-none transition-opacity duration-300 z-30"
        style={{
          left: position.x,
          top: position.y,
          transform: 'translate(-50%, -50%)',
          width: '400px',
          height: '400px',
          opacity: isMoving ? 0.4 : 0,
          visibility: isMoving ? 'visible' : 'hidden',
          background: theme === 'dark' 
            ? 'radial-gradient(circle, rgba(255,255,255,0.25) 0%, rgba(255,255,255,0) 70%)'
            : 'radial-gradient(circle, rgba(20,20,20,0.5) 0%, rgba(30,30,30,0) 70%)',
          transition: 'opacity 0.3s ease-out, visibility 0.3s ease-out',
        }}
      />
    </>
  );
}