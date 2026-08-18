import React, { useState } from 'react';
import { SimpleDither } from '../components/SimpleDither';
import { DotsLandscape } from '../components/DotsLandscape';
import { DotSunMoon } from '../components/DotSunMoon';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { WritingList } from '../components/WritingList';
import { Copyright } from '../components/Copyright';

export const Writings: React.FC = () => {
  const [isDark, setIsDark] = useState(false);
  const navigate = useNavigate();

  const toggleTheme = () => {
    setIsDark(!isDark);
  };

  const handleBack = () => {
    navigate('/');
  };

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ fontFamily: 'Georgia, serif' }}>
      <SimpleDither isDark={isDark} />
      <DotsLandscape isDark={isDark} />
      
      <DotSunMoon 
        isDark={isDark}
        isSecret={false}
        onClick={toggleTheme}
      />

      <button
        onClick={handleBack}
        className={`fixed top-6 right-6 p-3 rounded-full transition-all duration-300 z-20 ${
          isDark 
            ? 'bg-neutral-800/30 hover:bg-neutral-700/40 text-neutral-300' 
            : 'bg-neutral-200/30 hover:bg-neutral-300/40 text-neutral-700'
        }`}
        aria-label="Go back"
      >
        <ArrowLeft className="w-5 h-5" />
      </button>

      <div className="absolute inset-0 overflow-y-auto overflow-x-hidden z-10">
        <div className="min-h-full flex items-start justify-center px-6 pt-32 pb-40">
          <div className="max-w-2xl w-full">
        <h1 className={`text-4xl md:text-5xl font-bold mb-12 transition-colors duration-300 ${
          isDark ? 'text-neutral-100' : 'text-neutral-900'
        }`}>
          Writings
        </h1>

        <WritingList variant="editorial" isDark={isDark} />

        <div className={`mt-12 pt-8 border-t ${
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
