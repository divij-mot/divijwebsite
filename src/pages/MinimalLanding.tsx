import React, { useState, useEffect } from 'react';
import { SimpleDither } from '../components/SimpleDither';
import { DotsLandscape } from '../components/DotsLandscape';
import { DotSunMoon } from '../components/DotSunMoon';
import { useNavigate } from 'react-router-dom';
import { Copyright } from '../components/Copyright';

interface MinimalLandingProps {
  onEnter: (isDark: boolean) => void;
}

export const MinimalLanding: React.FC<MinimalLandingProps> = ({ onEnter }) => {
  const [isDark, setIsDark] = useState(false);
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [showPulse, setShowPulse] = useState(false);
  const [hasClickedName, setHasClickedName] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!hasClickedName) {
        setShowPulse(true);
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, [hasClickedName]);

  const toggleTheme = () => {
    setIsDark(!isDark);
  };

  const handleNameClick = () => {
    if (!hasClickedName) {
      setHasClickedName(true);
      setShowPulse(false);
    }
    setSecretRevealed(!secretRevealed);
  };

  const handleWritingsClick = () => {
    navigate('/writings');
  };

  return (
    <div className="fixed inset-0 overflow-hidden transition-colors duration-500" style={{ fontFamily: 'Georgia, serif' }}>
      <SimpleDither isDark={isDark} />
      <DotsLandscape isDark={isDark} />
      
      <DotSunMoon 
        isDark={isDark}
        isSecret={secretRevealed}
        onClick={secretRevealed ? () => onEnter(isDark) : toggleTheme}
      />

      <div className="absolute inset-0 overflow-y-auto overflow-x-hidden z-10">
        <div className="min-h-full flex items-start justify-center px-6 pt-32 pb-40">
          <div className="max-w-2xl w-full">
        <h1 
          onClick={handleNameClick}
          className={`text-4xl md:text-5xl font-bold mb-4 cursor-pointer transition-colors duration-500 ${
            isDark ? 'text-neutral-100' : 'text-neutral-900'
          } ${showPulse && !secretRevealed ? (isDark ? 'animate-subtle-pulse-dark' : 'animate-subtle-pulse') : ''}`}
        >
          Divij Motwani
        </h1>
        
        <p className={`text-base md:text-lg mb-2 transition-colors duration-500 ${
          isDark ? 'text-neutral-400' : 'text-neutral-700'
        }`}>
          divij [at] berkeley [dot] edu
        </p>

        <div className="flex gap-4 mb-8">
          <button
            onClick={handleWritingsClick}
            className={`writings-link text-sm underline underline-offset-4 decoration-2 transition-colors duration-300 ${
              isDark
                ? 'text-red-500/90 hover:text-red-400 decoration-red-500/70'
                : 'text-red-800 hover:text-red-900 decoration-red-800/70'
            }`}
          >
            Writings
            <span className="writings-dot" aria-hidden="true" />
          </button>
          <a
            href="https://github.com/divij-mot"
            target="_blank"
            rel="noopener noreferrer"
            className={`text-sm underline transition-colors duration-300 ${
              isDark 
                ? 'text-neutral-400 hover:text-neutral-200' 
                : 'text-neutral-700 hover:text-neutral-900'
            }`}
          >
            GitHub
          </a>
          <a
            href="https://www.linkedin.com/in/divijmotwani/"
            target="_blank"
            rel="noopener noreferrer"
            className={`text-sm underline transition-colors duration-300 ${
              isDark 
                ? 'text-neutral-400 hover:text-neutral-200' 
                : 'text-neutral-700 hover:text-neutral-900'
            }`}
          >
            LinkedIn
          </a>
        </div>

          <div className={`space-y-4 transition-colors duration-500 ${
          isDark ? 'text-neutral-300' : 'text-neutral-800'
        }`}>
            <p className="text-base leading-relaxed transition-colors duration-500">
            I'm currently a student studying EECS @ UC Berkeley. In my free time, I'm focused on building elegant solutions to whatever problems I encounter. 
            In the past I've been captivated by biotech and retrieval systems. Currently I find myself fragmented between robotics, blockchain, and ...
          </p>
        </div>

        <div className={`mt-6 pt-6 border-t ${
          isDark ? 'border-neutral-700' : 'border-neutral-400'
        }`}>
          <Copyright className={`text-xs text-center ${
            isDark ? 'text-neutral-500' : 'text-neutral-600'
          }`} />
        </div>
          </div>
        </div>
      </div>
    </div>
  );
};
