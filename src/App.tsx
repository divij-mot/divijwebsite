import React, { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
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


function Layout({ children, isFullScreen = false }: { children: React.ReactNode; isFullScreen?: boolean }) {
  const { theme } = useTheme();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const toggleSidebar = () => setIsSidebarOpen(!isSidebarOpen);
  
  return (
    <div className={theme}>
      <div className="min-h-screen bg-white dark:bg-neutral-900 text-black dark:text-white transition-colors duration-300">
        <Sidebar isOpen={isSidebarOpen} toggleSidebar={toggleSidebar} />
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
        I'm currently an 18-year old student studying EECS @ UC Berkeley. In my free time, I'm focused on building elegant solutions to whatever problems I encounter.
        This space serves as both my portfolio and a collection of useful tools I've created along the way. I hope you'll use some of them! 
      </p>
      <div className="h-px w-full bg-neutral-200 dark:bg-neutral-800 my-12" />
      <div className="prose prose-neutral dark:prose-invert">
        <h2 className="text-2xl font-semibold mb-4">Recently</h2>
        <ul className="space-y-3 ml-4">
          <li className="flex items-start">
            <span className="text-neutral-400 mr-2">•</span>
            <span className="text-neutral-600 dark:text-neutral-400">
              In my sophomore year of high school, I founded a <a href="https://issuu.com/palyveritas" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">STEM publication</a> which covered tech innovation in the Bay Area. During my time there, we covered TechCrunch Disrupt, Amazon's Robotics Centers, Waymo, and much more. I love to read and write, and hope you'll enjoy some of <a href="/blogs" className="text-blue-500 hover:underline">my blogs</a>.
            </span>
          </li>
          <li className="flex items-start">
            <span className="text-neutral-400 mr-2">•</span>
            <span className="text-neutral-600 dark:text-neutral-400">
              Some time ago, I competed at the <a href="https://www.societyforscience.org/isef/" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">Regeneron International Science and Engineering Fair</a>. We presented <a href="https://oralai.tech" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">OralAI</a>, a new consumer dental disease detection system, which ended up winning the First Place Grand Award within the Biomedical Engineering category. The system is now non-provisional patent pending under a pro-bono grant from <a href="https://www.procopio.com/" className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">Procopio LLP</a>.
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout><Home /></Layout>} />
          <Route path="/about" element={<Layout><About /></Layout>} />
          <Route path="/portfolio" element={<Layout><Portfolio /></Layout>} />
          <Route path="/blog" element={<Layout><Blog /></Layout>} />
          <Route path="/contact" element={<Layout><Contact /></Layout>} />
          <Route path="/tools/word-counter" element={<Layout><WordCounter /></Layout>} />
          <Route path="/tools/editor" element={<Layout><TextEditor /></Layout>} />
          <Route path="/tools/share" element={<Layout><Share /></Layout>} />
          <Route path="/tools/file-converter" element={<Layout><FileConverter /></Layout>} />
          <Route path="/tools/quantumpage" element={<Layout><QuantumPage /></Layout>} />
          <Route path="/quantumpage/:uuid" element={<InfinitePage />} />
          <Route path="*" element={<InfinitePage />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
