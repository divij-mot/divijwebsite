import React, { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';

const InfinitePage: React.FC = () => {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  const { uuid } = useParams<{ uuid: string }>();

  useEffect(() => {
    const loadPage = async () => {
      setLoading(true);
      setError(null);
      
      try {
        let response;
        
        // Check if this is a UUID-based permanent link
        if (uuid) {
          // Load saved content by UUID
          response = await fetch(`/api/get-page-blob?uuid=${encodeURIComponent(uuid)}`);
          
          if (!response.ok) {
            throw new Error('Saved page not found or expired');
          }
          
          const htmlContent = await response.text();
          
          // Replace the entire document for saved pages
          document.open();
          document.write(htmlContent);
          document.close();
          return;
        } else {
          // Generate new content for regular paths
          response = await fetch(`/api/generate?path=${encodeURIComponent(location.pathname)}`);
          
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          
          // Handle the mixed stream - filter out progress comments and get final HTML
          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error('No response body');
          }

          let accumulator = '';
          const decoder = new TextDecoder();
          let finalHtmlContent = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              const chunk = decoder.decode(value, { stream: true });
              accumulator += chunk;
            }
            
            // Extract the actual HTML content (everything after the last progress comment)
            const progressCommentRegex = /<!--\s*Progress:.*?-->/g;
            const cleanContent = accumulator.replace(progressCommentRegex, '').trim();
            
            // The final HTML should be the last substantial content
            if (cleanContent) {
              finalHtmlContent = cleanContent;
            } else {
              throw new Error('No valid HTML content received');
            }
            
          } finally {
            reader.releaseLock();
          }
          
          // If it's a complete HTML document, replace the entire page
          if (finalHtmlContent.includes('<!DOCTYPE html') || finalHtmlContent.includes('<html')) {
            // Replace the entire document
            document.open();
            document.write(finalHtmlContent);
            document.close();
            return; // Don't continue with React rendering
          } else {
            // If it's just HTML content, use it with dangerouslySetInnerHTML
            setContent(finalHtmlContent);
          }
        }
      } catch (err) {
        console.error('Error loading page:', err);
        setError(err instanceof Error ? err.message : 'Failed to load page');
      } finally {
        setLoading(false);
      }
    };

    if (location.pathname !== '/' || uuid) {
      loadPage();
    }
  }, [location.pathname, uuid]);

  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-neutral-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-lg text-neutral-600 dark:text-neutral-400">
            Conjuring your page...
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-white dark:bg-neutral-900 flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <div className="text-red-500 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
            Oops! Something went wrong
          </h2>
          <p className="text-neutral-600 dark:text-neutral-400 mb-4">
            Failed to generate the page: {error}
          </p>
          <button 
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div 
      className="infinite-page-content"
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
};

export default InfinitePage;