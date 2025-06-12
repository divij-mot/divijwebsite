import React, { useState, useCallback, useRef, useEffect } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { html as htmlLang } from '@codemirror/lang-html';
import { useTheme } from '../context/ThemeContext';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import { Upload, Download, FilePlus, Edit3 } from 'lucide-react';

const TextEditor: React.FC = () => {
  const initialCode = '\n'.repeat(19);
  const [code, setCode] = useState(initialCode);
  const [fileName, setFileName] = useState('untitled.txt');
  const [language, setLanguage] = useState('javascript');
  const { theme } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const langToExt: Record<string, string> = {
    javascript: 'js',
    python: 'py',
    cpp: 'cpp',
    java: 'java',
    html: 'html',
    text: 'txt',
  };

  useEffect(() => {
    setFileName((prev) => {
      const parts = prev.split('.');
      const newExt = langToExt[language] || 'txt';
      if (parts.length > 1) {
        parts[parts.length - 1] = newExt;
        return parts.join('.');
      }
      return `${prev}.${newExt}`;
    });
  }, [language]);

  const onChange = useCallback((value: string) => {
    setCode(value);
  }, []);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        setCode(text);
        setFileName(file.name);
        const extension = file.name.split('.').pop()?.toLowerCase();
        if (extension === 'js' || extension === 'jsx' || extension === 'ts' || extension === 'tsx') {
          setLanguage('javascript');
        } else if (extension === 'py') {
          setLanguage('python');
        } else if (extension === 'cpp' || extension === 'cxx' || extension === 'h' || extension === 'hpp') {
          setLanguage('cpp');
        } else if (extension === 'java') {
          setLanguage('java');
        } else if (extension === 'html' || extension === 'htm') {
          setLanguage('html');
        } else {
          setLanguage('text');
        }
      };
      reader.readAsText(file);
    }
     if (event.target) {
        event.target.value = '';
     }
  };

  const triggerFileUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileDownload = () => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleNewFile = () => {
    setCode(initialCode);
    setFileName('untitled.txt');
    setLanguage('text');
  };

  const getLanguageExtension = () => {
    switch (language) {
      case 'javascript': return javascript({ jsx: true, typescript: true });
      case 'python': return python();
      case 'cpp': return cpp();
      case 'java': return java();
      case 'html': return htmlLang();
      default: return [];
    }
  };

  return (
    <div className="p-6 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 min-h-screen transition-colors duration-300 flex flex-col">
      <h1 className="text-3xl font-bold mb-4">Text Editor</h1>
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={triggerFileUpload}
          className="flex items-center gap-1 px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors text-sm"
          title="Upload File"
        >
          <Upload size={16} /> Upload
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          className="hidden"
          accept=".txt,.js,.jsx,.ts,.tsx,.py,.cpp,.cxx,.h,.hpp,.java,.html,.htm,.md,.css,.json"
        />
        <div className="flex items-center border border-neutral-300 dark:border-neutral-700 rounded-md overflow-hidden text-sm">
           <input
             type="text"
             value={fileName}
             onChange={(e) => setFileName(e.target.value)}
             className="px-2 py-[7px] bg-white dark:bg-gray-800 focus:outline-none w-32 md:w-40 text-neutral-900 dark:text-neutral-100"
             placeholder="Filename"
           />
           <button
             onClick={handleFileDownload}
             className="flex items-center gap-1 px-3 py-2 bg-green-500 hover:bg-green-600 text-white transition-colors"
             title="Download File"
           >
             <Download size={16} /> Download
           </button>
        </div>
        <button
          onClick={handleNewFile}
          className="flex items-center gap-1 px-3 py-2 bg-gray-500 hover:bg-gray-600 text-white rounded-md transition-colors text-sm"
          title="New File"
        >
          <FilePlus size={16} /> New
        </button>
        <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-gray-50 dark:bg-gray-800 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 ml-auto"
            title="Select Language"
        >
            <option value="javascript">JavaScript</option>
            <option value="python">Python</option>
            <option value="cpp">C++</option>
            <option value="java">Java</option>
            <option value="html">HTML</option>
            <option value="text">Plain Text</option>
        </select>
      </div>
      <div className="flex-grow rounded-md overflow-hidden">
        <CodeMirror
          value={code}
          height="100%"
          extensions={[getLanguageExtension()]}
          onChange={onChange}
          theme={githubDark}
          style={{ fontSize: '14px', height: '100%' }}
        />
      </div>
    </div>
  );
};

export default TextEditor;