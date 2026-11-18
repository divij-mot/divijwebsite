import React, { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';

// Share one in-flight generate per path so remounts/StrictMode don't stack requests
const inflightGenerates = new Map<string, Promise<string>>();

function extractHtmlDocument(raw: string) {
  let text = raw
    .replace(/<!--\s*(?:QuantumPage generation started\.\.\.|Progress:.*?)-->/g, '')
    .trim();

  // Only strip OUTER fences — never cut on the first ``` inside page JS
  text = text.replace(/^```(?:html|HTML)?\s*\r?\n?/i, '');
  text = text.replace(/\r?\n?```\s*$/i, '');

  const doctypeIdx = text.search(/<!DOCTYPE\s+html/i);
  const htmlIdx = text.search(/<html[\s>]/i);
  let start = -1;
  if (doctypeIdx !== -1 && htmlIdx !== -1) start = Math.min(doctypeIdx, htmlIdx);
  else start = Math.max(doctypeIdx, htmlIdx);
  if (start > 0) text = text.slice(start);

  const closeIdx = text.toLowerCase().lastIndexOf('</html>');
  if (closeIdx !== -1) {
    text = text.slice(0, closeIdx + '</html>'.length).trim();
  }

  return text.trim();
}

async function fetchGeneratedHtml(pathname: string): Promise<string> {
  const existing = inflightGenerates.get(pathname);
  if (existing) return existing;

  const promise = (async () => {
    const response = await fetch(`/api/generate?path=${encodeURIComponent(pathname)}`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    let accumulator = '';
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulator += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }

    const html = extractHtmlDocument(accumulator);
    if (!html) {
      throw new Error('No valid HTML content received');
    }
    return html;
  })();

  inflightGenerates.set(pathname, promise);
  promise.finally(() => {
    if (inflightGenerates.get(pathname) === promise) {
      inflightGenerates.delete(pathname);
    }
  });

  return promise;
}

const InfinitePage: React.FC = () => {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  const { uuid } = useParams<{ uuid: string }>();

  useEffect(() => {
    let cancelled = false;

    const loadPage = async () => {
      setLoading(true);
      setError(null);

      try {
        if (uuid) {
          const response = await fetch(`/api/get-page-blob?uuid=${encodeURIComponent(uuid)}`);
          if (!response.ok) {
            throw new Error('Saved page not found or expired');
          }

          const htmlContent = await response.text();
          if (cancelled) return;

          document.open();
          document.write(htmlContent);
          document.close();
          return;
        }

        const finalHtmlContent = await fetchGeneratedHtml(location.pathname);
        if (cancelled) return;

        if (/<!DOCTYPE\s+html|<html[\s>]/i.test(finalHtmlContent)) {
          try {
            document.open();
            document.write(finalHtmlContent);
            document.close();
          } catch (writeErr) {
            throw new Error(
              writeErr instanceof Error
                ? `Generated page was incomplete (${writeErr.message})`
                : 'Generated page was incomplete'
            );
          }
          return;
        }

        setContent(finalHtmlContent);
      } catch (err) {
        if (cancelled) return;
        console.error('Error loading page:', err);
        setError(err instanceof Error ? err.message : 'Failed to load page');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    if (location.pathname !== '/' || uuid) {
      loadPage();
    }

    return () => {
      cancelled = true;
    };
  }, [location.pathname, uuid]);

  if (loading) {
    return (
      <div className="quantum">
        <p className="quantum__line serif">Conjuring your page…</p>
        <div className="quantum__bar" aria-hidden="true"><i /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="quantum">
        <p className="quantum__line serif">Something went wrong</p>
        <p className="note u-warn quantum__note">Failed to generate the page: {error}</p>
        <button className="u-action quantum__retry" onClick={() => window.location.reload()}>
          Try again
        </button>
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
