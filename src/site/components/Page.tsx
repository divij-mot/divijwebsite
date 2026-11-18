import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { Footer } from './Footer';
import { setAxis } from '../lib/wordmark.js';
import { blockReady } from '../lib/fonts.js';

type PageProps = {
  title: ReactNode;
  /** not shown: the title says what the page is */
  note?: ReactNode;
  /** document title */
  docTitle?: string;
  children?: ReactNode;
};

/**
 * Every page that isn't home: a quiet way back in the first column, the title
 * in the serif on the second, the page, then the blue plate.
 */
export function Page({ title, docTitle, children }: PageProps) {
  useLayoutEffect(() => {
    setAxis(null);
    blockReady().then(() => setAxis(null));
    let lastW = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      setAxis(null);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    document.title = docTitle ? `${docTitle} — Divij Motwani` : 'Divij Motwani';
  }, [docTitle]);

  return (
    <>
      <div className="page">
        <header className="row page__head">
          <span aria-hidden="true" />{/* the title says what the page is */}
          <h1 className="page__title serif">{title}</h1>
        </header>
        <main className="page__body">{children}</main>
      </div>
      <Footer />
    </>
  );
}
