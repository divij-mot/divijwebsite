import React, { useState } from 'react';
import { SimpleDither } from '../components/SimpleDither';
import { DotsLandscape } from '../components/DotsLandscape';
import { DotSunMoon } from '../components/DotSunMoon';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

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
    <div className="relative min-h-screen overflow-hidden" style={{ fontFamily: 'Georgia, serif' }}>
      <SimpleDither isDark={isDark} />
      <DotsLandscape isDark={isDark} />
      
      <DotSunMoon 
        isDark={isDark}
        isSecret={false}
        onClick={toggleTheme}
      />

      {/* Back Button */}
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

      {/* Main Content */}
      <div className="relative z-10 max-w-2xl mx-auto px-6 pt-32 pb-64">
        <h1 className={`text-4xl md:text-5xl font-bold mb-8 transition-colors duration-300 ${
          isDark ? 'text-neutral-100' : 'text-neutral-900'
        }`}>
          Writings
        </h1>

        <div className={`prose max-w-none transition-colors duration-300 ${
          isDark ? 'prose-invert' : ''
        }`}>
          <p className={`text-base italic ${
            isDark ? 'text-neutral-400' : 'text-neutral-600'
          }`}>
            Nothing here yet. Check back soon!
          </p>
        </div>

        <div className={`mt-12 pt-8 border-t ${
          isDark ? 'border-neutral-700' : 'border-neutral-400'
        }`}>
          <p className={`text-xs text-center ${
            isDark ? 'text-neutral-500' : 'text-neutral-600'
          }`}>
            © 2025 Divij Motwani. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
};

