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


function Layout({ children }: { children: React.ReactNode }) {
  const { theme, themeTransitionPos } = useTheme();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const toggleSidebar = () => setIsSidebarOpen(!isSidebarOpen);
  
  return (
    <div className={theme}>
      <div className="min-h-screen bg-white dark:bg-neutral-900 text-black dark:text-white transition-colors duration-300">
        <Sidebar isOpen={isSidebarOpen} toggleSidebar={toggleSidebar} />
        <MouseLight />
        <ThemeToggle />
        <div className="md:ml-64 lg:ml-72 relative"> {/* Add lg:ml-72 */}
          {/* Hamburger Menu Button - visible only on small screens */}
          <button
            onClick={toggleSidebar}
            className="md:hidden absolute top-4 left-4 z-50 p-2 rounded-md bg-neutral-100/50 dark:bg-neutral-800/50 backdrop-blur-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors" // Changed fixed to absolute
            aria-label="Toggle menu"
          >
            <Menu className="w-6 h-6" />
          </button>
          <main className="p-8 pt-16 md:pt-8"> {/* Add padding-top on small screens for the button */}
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

function Home() {
  return (
    <div className="max-w-2xl lg:max-w-4xl pt-12"> {/* Added lg:max-w-4xl */}
      <h1 className="text-5xl font-bold mb-6">Hi! I'm Divij</h1>
      <p className="text-lg text-neutral-600 dark:text-neutral-400 leading-relaxed">
        I'm currently a 17-year old student studying EECS @ UC Berkeley. In my free time, I'm focused on building elegant solutions to whatever problems I encounter. {/* Updated sentence structure */}
        This space serves as both my portfolio and a collection of useful tools I've created along the way. I hope you'll use some of them! 
      </p>
      <div className="h-px w-full bg-neutral-200 dark:bg-neutral-800 my-12" />
      <div className="prose prose-neutral dark:prose-invert">
        <h2 className="text-2xl font-semibold mb-4">Recently</h2>
        <ul className="space-y-3 ml-4">
          <li className="flex items-start">
            <span className="text-neutral-400 mr-2">•</span>
            <span className="text-neutral-600 dark:text-neutral-400">
              In my sophomore year of high school, I founded a STEM publication which covered tech innovation in the Bay Area. During my time there, we covered TechCrunch Disrupt, Amazon's Robotics Centers, Waymo, and much more. I love to read and write, and hope you'll enjoy some of <a href="/blogs" className="text-blue-500 hover:underline">my blogs</a>.
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
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;