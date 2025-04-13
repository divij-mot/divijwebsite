import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import type { Theme } from '../types';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: (e?: React.MouseEvent) => void;
  themeTransitionPos: { x: number; y: number } | null;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [themeTransitionPos, setThemeTransitionPos] = useState<{ x: number; y: number } | null>(null);
  const transitionTimeout = useRef<number>();

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as Theme;
    if (savedTheme) {
      setTheme(savedTheme);
    }
  }, []);

  const toggleTheme = (e?: React.MouseEvent) => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    if (e) {
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      setThemeTransitionPos({ 
        x: rect.left + rect.width / 2, 
        y: rect.top + rect.height / 2 
      });
      
      clearTimeout(transitionTimeout.current);
      transitionTimeout.current = window.setTimeout(() => {
        setThemeTransitionPos(null);
      }, 400);
    }
    
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, themeTransitionPos }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}