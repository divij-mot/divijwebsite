import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const QuantumPage: React.FC = () => {
  const [inputValue, setInputValue] = useState('');
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      const slug = inputValue
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      
      if (slug) {
        navigate(`/${slug}`);
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit(e as any);
    }
  };

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-900 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-neutral-900 dark:text-neutral-100 mb-2">
            QuantumPage
          </h1>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col items-center">
          <input
            type="text"
            placeholder="Which page on the website do you want to go to?"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            className="w-full px-6 py-4 text-lg rounded-xl border border-gray-300 dark:border-neutral-600 
                     bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100
                     focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400
                     shadow-sm hover:shadow-md transition-shadow duration-200
                     placeholder-gray-500 dark:placeholder-neutral-400"
            autoComplete="off"
            autoFocus
          />
        </form>
        
        <div className="mt-8 text-center">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Press Enter to visit your page
          </p>
        </div>
      </div>
    </div>
  );
};

export default QuantumPage;