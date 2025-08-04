import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Share2, X, Copy, Check } from 'lucide-react';

const QuantumPage: React.FC = () => {
  const [inputValue, setInputValue] = useState('');
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareLink, setShareLink] = useState('');
  const [isGeneratingLink, setIsGeneratingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
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

  const handleShare = async () => {
    if (!inputValue.trim()) {
      alert('Please enter a page idea first!');
      return;
    }

    setShowShareModal(true);
    setIsGeneratingLink(true);
    setLinkCopied(false);

    try {
      // Generate the HTML content first
      const response = await fetch(`/api/generate?path=${encodeURIComponent('/' + inputValue.trim())}`);
      if (!response.ok) throw new Error('Failed to generate content');
      
      const htmlContent = await response.text();
      
      // Save the content and get a permanent UUID link
      const saveResponse = await fetch('/api/save-page-blob', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: htmlContent,
          title: inputValue.trim()
        })
      });

      if (!saveResponse.ok) throw new Error('Failed to save page');
      
      const { uuid } = await saveResponse.json();
      const permanentLink = `${window.location.origin}/quantumpage/${uuid}`;
      setShareLink(permanentLink);
    } catch (error) {
      console.error('Error creating share link:', error);
      alert('Failed to create share link. Please try again.');
      setShowShareModal(false);
    } finally {
      setIsGeneratingLink(false);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy link:', error);
    }
  };

  const closeModal = () => {
    setShowShareModal(false);
    setShareLink('');
    setLinkCopied(false);
  };

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-900 flex items-center justify-center p-4 relative">
      {/* Share Button */}
      <button
        onClick={handleShare}
        className="fixed top-6 right-6 p-3 rounded-full bg-blue-600 hover:bg-blue-700 text-white shadow-lg transition-colors z-10"
        title="Share this page"
      >
        <Share2 className="w-5 h-5" />
      </button>

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

      {/* Share Modal */}
      {showShareModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-2xl max-w-md w-full p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                Share Your Page
              </h3>
              <button
                onClick={closeModal}
                className="p-1 rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
              >
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>

            {isGeneratingLink ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
                <p className="text-neutral-600 dark:text-neutral-400">
                  Generating permanent link...
                </p>
              </div>
            ) : shareLink ? (
              <div>
                <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
                  Your permanent link has been created. Copy it now - this link won't be shown again.
                </p>
                <div className="flex items-center gap-2 p-3 bg-neutral-100 dark:bg-neutral-700 rounded-lg mb-4">
                  <input
                    type="text"
                    value={shareLink}
                    readOnly
                    className="flex-1 bg-transparent text-sm text-neutral-700 dark:text-neutral-300 outline-none"
                  />
                  <button
                    onClick={copyToClipboard}
                    className="p-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                    title="Copy link"
                  >
                    {linkCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                {linkCopied && (
                  <p className="text-sm text-green-600 dark:text-green-400 text-center">
                    Link copied to clipboard!
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

export default QuantumPage;