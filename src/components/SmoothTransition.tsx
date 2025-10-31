import React, { useEffect, useState } from 'react';

interface SmoothTransitionProps {
  onComplete: () => void;
  fromColor: string;
  toColor: string;
  duration?: number;
}

export const SmoothTransition: React.FC<SmoothTransitionProps> = ({
  onComplete,
  fromColor,
  toColor,
  duration = 700
}) => {
  const [opacity, setOpacity] = useState(0);

  useEffect(() => {
    // Start transition immediately
    requestAnimationFrame(() => {
      setOpacity(1);
    });

    // Hold at full opacity
    const holdTimer = setTimeout(() => {
      setOpacity(0);
    }, duration * 0.5);

    // Complete transition
    const completeTimer = setTimeout(() => {
      onComplete();
    }, duration);

    return () => {
      clearTimeout(holdTimer);
      clearTimeout(completeTimer);
    };
  }, [duration, onComplete]);

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none"
      style={{
        background: `linear-gradient(135deg, ${fromColor} 0%, ${toColor} 100%)`,
        opacity,
        transition: `opacity ${duration * 0.35}ms ease-in-out`
      }}
    />
  );
};

