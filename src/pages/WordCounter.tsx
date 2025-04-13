import React, { useState } from 'react';

const WordCounter: React.FC = () => {
  const [text, setText] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [sentenceCount, setSentenceCount] = useState(0);
  const [paragraphCount, setParagraphCount] = useState(0);

  const handleTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = event.target.value;
    setText(newText);

    // Calculate counts
    const words = newText.trim().split(/\s+/).filter(Boolean);
    setWordCount(words.length === 1 && words[0] === '' ? 0 : words.length);

    setCharCount(newText.length);

    // Sentences (ends with . ! ?) - simple approach
    const sentences = newText.match(/[^.!?]+[.!?]+/g) || [];
    setSentenceCount(sentences.length);

    // Paragraphs (separated by newline characters) - simple approach
    const paragraphs = newText.split(/\n+/).filter(p => p.trim() !== '');
    setParagraphCount(paragraphs.length);
  };

  return (
    <div className="p-6 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 min-h-screen transition-colors duration-300"> {/* Match main background and text colors */}
      <h1 className="text-3xl font-bold mb-6">Word Counter</h1>
      <textarea
        className="w-full h-64 p-4 border border-neutral-400 dark:border-neutral-600 rounded-md bg-neutral-100 dark:bg-neutral-800 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 resize-none mb-4 text-neutral-900 dark:text-neutral-100"
        placeholder="Paste or type your text here..."
        value={text}
        onChange={handleTextChange}
      />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
        {/* Darkened stat box styling */}
        <div className="p-4 border border-neutral-500 dark:border-neutral-600 rounded-md bg-neutral-100 dark:bg-neutral-800">
          <p className="text-lg font-semibold">Words</p>
          <p className="text-2xl">{wordCount}</p>
        </div>
        <div className="p-4 border border-neutral-500 dark:border-neutral-600 rounded-md bg-neutral-100 dark:bg-neutral-800">
          <p className="text-lg font-semibold">Characters</p>
          <p className="text-2xl">{charCount}</p>
        </div>
        <div className="p-4 border border-neutral-500 dark:border-neutral-600 rounded-md bg-neutral-100 dark:bg-neutral-800">
          <p className="text-lg font-semibold">Sentences</p>
          <p className="text-2xl">{sentenceCount}</p>
        </div>
        <div className="p-4 border border-neutral-500 dark:border-neutral-600 rounded-md bg-neutral-100 dark:bg-neutral-800">
          <p className="text-lg font-semibold">Paragraphs</p>
          <p className="text-2xl">{paragraphCount}</p>
        </div>
      </div>
    </div>
  );
};

export default WordCounter;