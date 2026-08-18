import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { Sidebar } from './components/Sidebar';
import { ThemeToggle } from './components/ThemeToggle';
import { MouseLight } from './components/MouseLight';
import { useTheme } from './context/ThemeContext';
import { Menu } from 'lucide-react';
import About from './pages/About';
import Portfolio from './pages/Portfolio';
import Blog from './pages/Blog';
import Contact from './pages/Contact';
import WordCounter from './pages/WordCounter';
import TextEditor from './pages/TextEditor';
import Share from './pages/Share';
import FileConverter from './pages/FileConverter';
import QuantumPage from './pages/QuantumPage';
import InfinitePage from './pages/InfinitePage';
import { MinimalLanding } from './pages/MinimalLanding';
import { Writings } from './pages/Writings';
import { SmoothTransition } from './components/SmoothTransition';


interface LayoutProps {
  children: React.ReactNode;
  isFullScreen?: boolean;
  onReturnToMinimal?: () => void;
}

function Layout({ children, isFullScreen = false, onReturnToMinimal }: LayoutProps) {
  const { theme } = useTheme();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const toggleSidebar = () => setIsSidebarOpen(!isSidebarOpen);
  
  return (
    <div className={theme}>
      <div className="min-h-screen bg-white dark:bg-neutral-900 text-black dark:text-white transition-colors duration-300">
        <Sidebar isOpen={isSidebarOpen} toggleSidebar={toggleSidebar} onReturnToMinimal={onReturnToMinimal} />
        <MouseLight />
        {!isFullScreen && <ThemeToggle />}
        <div className="md:ml-64 lg:ml-72 relative">
          <button
            onClick={toggleSidebar}
            className="md:hidden absolute top-4 left-4 z-50 p-2 rounded-md bg-neutral-100/50 dark:bg-neutral-800/50 backdrop-blur-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors" // Changed fixed to absolute
            aria-label="Toggle menu"
          >
            <Menu className="w-6 h-6" />
          </button>
          <main className={isFullScreen ? "h-screen" : "p-8 pt-16 md:pt-8"}>
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

function Home() {
  return (
    <div className="max-w-2xl lg:max-w-4xl pt-12">
      <h1 className="text-5xl font-bold mb-6">Hi! I'm Divij</h1>
      <p className="text-lg text-neutral-600 dark:text-neutral-400 leading-relaxed">
        I'm studying EECS at UC Berkeley, currently an FDE intern at Palantir. In my free time I build things I want to exist — lately that's been end-to-end robotics, and the unglamorous work of getting those models onto real cars. This space is both a portfolio and a set of tools I've made along the way.
      </p>
      <div className="h-px w-full bg-neutral-200 dark:bg-neutral-800 my-12" />
      <div className="prose prose-neutral dark:prose-invert">
        <h2 className="text-2xl font-semibold mb-4">Recently</h2>
        <ul className="space-y-3 ml-4">
          <li className="flex items-start">
            <span className="text-neutral-400 mr-2">•</span>
            <span className="text-neutral-600 dark:text-neutral-400">
              Won <a href="https://blog.comma.ai/comma-hack-6/" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">comma.ai Hack 6</a> with <a href="https://therefore.sh/projects/period" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">period</a> — an end-to-end car parking world model with 11M parameters that runs at 120hz on a MacBook.
            </span>
          </li>
          <li className="flex items-start">
            <span className="text-neutral-400 mr-2">•</span>
            <span className="text-neutral-600 dark:text-neutral-400">
              <a href="https://www.beepbooprobotics.com/posts/causal-video-generation" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">Causal Video Generation as a Policy</a> — a direct video action model created to model and dream/act in the push-t environment.
            </span>
          </li>
          <li className="flex items-start">
            <span className="text-neutral-400 mr-2">•</span>
            <span className="text-neutral-600 dark:text-neutral-400">
              Co-authored <a href="https://papers.nips.cc/paper_files/paper/2025/hash/ed25c00ff6900989116d3ba5d607d33d-Abstract-Datasets_and_Benchmarks_Track.html" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">RAGuard</a>, a fact-checking benchmark for RAG under misleading retrievals, accepted to NeurIPS 2025.
            </span>
          </li>
          <li className="flex items-start">
            <span className="text-neutral-400 mr-2">•</span>
            <span className="text-neutral-600 dark:text-neutral-400">
              Built <a href="https://oralai.tech" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">OralAI</a>, a consumer dental disease detection system that won First Place Grand Award in Biomedical Engineering at <a href="https://www.societyforscience.org/isef/" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">ISEF</a>. Non-provisional patent pending under a pro-bono grant from <a href="https://www.procopio.com/" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">Procopio LLP</a>.
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function AppRouter() {
  const location = useLocation();
  
  // Automatically show fancy site if not on root path
  const [showFancySite, setShowFancySite] = useState(() => {
    return location.pathname !== '/';
  });
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitionDirection, setTransitionDirection] = useState<'to-fancy' | 'to-minimal'>('to-fancy');
  const [fromColor, setFromColor] = useState('#FFFFFF');

  const handleEnterSite = (isDark: boolean) => {
    // Set the starting color based on current theme
    setFromColor(isDark ? '#2d2d2d' : '#EEE5D5');
    setTransitionDirection('to-fancy');
    setIsTransitioning(true);
  };

  const handleReturnToMinimal = () => {
    // Always return to light mode minimal site
    setFromColor('#EEE5D5');
    setTransitionDirection('to-minimal');
    setIsTransitioning(true);
  };

  const handleTransitionComplete = () => {
    if (transitionDirection === 'to-fancy') {
      setShowFancySite(true);
    } else {
      setShowFancySite(false);
    }
    setIsTransitioning(false);
  };

  // Show writings page without transition
  if (location.pathname === '/writings') {
    return <Writings />;
  }

  const minimalSite = <MinimalLanding onEnter={handleEnterSite} />;
  const fancySite = (
    <Routes>
      <Route path="/" element={<Layout onReturnToMinimal={handleReturnToMinimal}><Home /></Layout>} />
      <Route path="/about" element={<Layout onReturnToMinimal={handleReturnToMinimal}><About /></Layout>} />
      <Route path="/portfolio" element={<Layout onReturnToMinimal={handleReturnToMinimal}><Portfolio /></Layout>} />
      <Route path="/blog" element={<Layout onReturnToMinimal={handleReturnToMinimal}><Blog /></Layout>} />
      <Route path="/contact" element={<Layout onReturnToMinimal={handleReturnToMinimal}><Contact /></Layout>} />
      <Route path="/tools/word-counter" element={<Layout onReturnToMinimal={handleReturnToMinimal}><WordCounter /></Layout>} />
      <Route path="/tools/editor" element={<Layout onReturnToMinimal={handleReturnToMinimal}><TextEditor /></Layout>} />
      <Route path="/tools/share" element={<Layout onReturnToMinimal={handleReturnToMinimal}><Share /></Layout>} />
      <Route path="/tools/file-converter" element={<Layout onReturnToMinimal={handleReturnToMinimal}><FileConverter /></Layout>} />
      <Route path="/tools/quantumpage" element={<Layout onReturnToMinimal={handleReturnToMinimal}><QuantumPage /></Layout>} />
      <Route path="/quantumpage/:uuid" element={<InfinitePage />} />
      <Route path="*" element={<InfinitePage />} />
    </Routes>
  );

  // Render both sites, control visibility with opacity
  return (
    <div className="relative">
      {/* Minimal site */}
      <div 
        className={`${!showFancySite && !isTransitioning ? 'relative z-10' : 'absolute inset-0 z-0'} transition-opacity duration-700 ${
          !showFancySite && !isTransitioning ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {minimalSite}
      </div>

      {/* Fancy site */}
      <div 
        className={`${showFancySite && !isTransitioning ? 'relative z-10' : 'absolute inset-0 z-0'} transition-opacity duration-700 ${
          showFancySite && !isTransitioning ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {fancySite}
      </div>

      {/* Transition overlay */}
      {isTransitioning && (
        <SmoothTransition 
          onComplete={handleTransitionComplete} 
          duration={700}
          fromColor={transitionDirection === 'to-fancy' ? fromColor : '#171717'}
          toColor={transitionDirection === 'to-fancy' ? '#171717' : fromColor}
        />
      )}
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
