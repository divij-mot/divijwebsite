import { NavLink } from 'react-router-dom';
import { Tool } from '../types';
import { ChevronRight, Twitter, Linkedin } from 'lucide-react';

const tools: Tool[] = [
  {
    name: 'Text Editor',
    description: 'In browser text editor',
    icon: 'edit',
    path: '/tools/editor'
  },
  {
    name: 'Word Counter', 
    description: 'Essay word and character counter',
    icon: 'type',
    path: '/tools/word-counter'
  },
  {
    name: 'P2P Share',
    description: 'P2P file sharing', 
    icon: 'share',
    path: '/tools/share' 
  }, 
  {
    name: 'File Converter',
    description: 'In Browser File Conversion',
    icon: 'repeat',
    path: '/tools/file-converter'
  },
  {
    name: 'QuantumPage',
    description: 'AI-generated infinite pages',
    icon: 'sparkles',
    path: '/tools/quantumpage'
  }
];

interface SidebarProps {
  isOpen: boolean;
  toggleSidebar: () => void;
  onReturnToMinimal?: () => void;
}

export function Sidebar({ isOpen, toggleSidebar, onReturnToMinimal }: SidebarProps) {
  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-30 md:hidden"
          onClick={toggleSidebar}
          aria-hidden="true"
        />
      )}

      <nav
        className={`fixed inset-y-0 left-0 z-40 w-64 lg:w-72 border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/30 backdrop-blur-sm transition-transform duration-300 ease-in-out
                   ${isOpen ? 'translate-x-0' : '-translate-x-full'}
                   md:translate-x-0 md:h-screen md:top-0 flex flex-col`}
      >
        <div className="flex-grow overflow-y-auto">
          <div className="p-6">
            <div className="flex items-center gap-2 mb-8">
                <button 
                  onClick={() => {
                    if (onReturnToMinimal) {
                      onReturnToMinimal();
                    } else {
                      window.location.href = '/';
                    }
                  }}
                  className="font-sans text-lg font-semibold tracking-tight text-neutral-900 dark:text-white hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors cursor-pointer"
                >
                  Divij Motwani
                </button>
            </div>
            
            <div className="space-y-6">
              <NavLink
                to="/"
                className={({ isActive }) =>
                  `block transition-colors hover:text-neutral-800 dark:hover:text-neutral-200 ${
                    isActive ? 'text-black dark:text-white font-medium' : 'text-neutral-500'
                  }`
                }
              >
                Home
              </NavLink>
              <NavLink
                to="/about"
                className={({ isActive }) =>
                  `block transition-colors hover:text-neutral-800 dark:hover:text-neutral-200 ${
                    isActive ? 'text-black dark:text-white font-medium' : 'text-neutral-500'
                  }`
                }
              >
                About
              </NavLink>
              <NavLink
                to="/portfolio"
                className={({ isActive }) =>
                  `block transition-colors hover:text-neutral-800 dark:hover:text-neutral-200 ${
                    isActive ? 'text-black dark:text-white font-medium' : 'text-neutral-500'
                  }`
                }
              >
                Portfolio
              </NavLink>
              <NavLink
                to="/blog"
                className={({ isActive }) =>
                  `block transition-colors hover:text-neutral-800 dark:hover:text-neutral-200 ${
                    isActive ? 'text-black dark:text-white font-medium' : 'text-neutral-500'
                  }`
                }
              >
                Blog
              </NavLink>
              <NavLink
                to="/contact"
                className={({ isActive }) =>
                  `block transition-colors hover:text-neutral-800 dark:hover:text-neutral-200 ${
                    isActive ? 'text-black dark:text-white font-medium' : 'text-neutral-500'
                  }`
                }
              >
                Contact
              </NavLink>

              <div className="pt-4 border-t border-neutral-200 dark:border-neutral-800">
                <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-4">Toolbox</div>
                <div className="space-y-1">
                  {tools.map((tool) => (
                    <NavLink
                      key={tool.path}
                      to={tool.path}
                      className="group block p-2 -mx-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-sm text-neutral-700 dark:text-neutral-300 group-hover:text-black dark:group-hover:text-white">
                            {tool.name}
                          </span>
                          <p className="text-xs text-neutral-500 dark:text-neutral-500 group-hover:text-neutral-600 dark:group-hover:text-neutral-400">
                            {tool.description}
                          </p>
                        </div>
                        <ChevronRight className="w-4 h-4 text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-200" />
                      </div>
                    </NavLink>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-auto p-6 border-t border-neutral-200 dark:border-neutral-800 flex-shrink-0">
          <div className="flex items-center justify-center gap-4">

            <a href="https://x.com/DivijMot" target="_blank" rel="noopener noreferrer"
               className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white transition-colors">
              <Twitter className="w-5 h-5" />
            </a>
            <a href="https://www.linkedin.com/in/divijmotwani" target="_blank" rel="noopener noreferrer"
               className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white transition-colors">
              <Linkedin className="w-5 h-5" />
            </a>
          </div>
        </div>
      </nav>
    </>
  );
}