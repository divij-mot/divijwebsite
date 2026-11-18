import { Suspense, lazy, useEffect, useLayoutEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Home from './site/Home';

// every page but home loads on demand, so the landing stays light
// any other path is a QuantumPage: generated on the fly
const InfinitePage = lazy(() => import('./pages/InfinitePage'));
const TextEditor = lazy(() => import('./site/tools/TextEditor'));
const FileConverter = lazy(() => import('./site/tools/FileConverter'));
// the builder keeps its own look: its editor, worker and archive code stay out of the site bundle
const BuilderPage = lazy(() => import('./builder/ui/BuilderPage'));

function ScrollToTop() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function Builder() {
  // the builder was designed in Inter; load it only here
  useEffect(() => {
    if (document.querySelector('link[data-builder-fonts]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.dataset.builderFonts = '';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';
    document.head.appendChild(l);
  }, []);
  // the builder keeps its own near-black, whatever palette the site is in
  useEffect(() => {
    const els = [document.documentElement, document.body];
    els.forEach((el) => el.style.setProperty('background', '#050505'));
    return () => els.forEach((el) => el.style.removeProperty('background'));
  }, []);
  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      <Suspense
        fallback={<div className="flex h-screen items-center justify-center bg-neutral-950 text-sm text-neutral-600">Loading the builder</div>}
      >
        <BuilderPage />
      </Suspense>
    </div>
  );
}

function AppRoutes() {
  return (
    <>
      <ScrollToTop />
      <Suspense fallback={<div className="page-loading" />}>
        <Routes>
          <Route path="/" element={<Home />} />
          {/* the old pages all open the front page, as if you'd typed the domain */}
          {['/about', '/portfolio', '/contact', '/writings', '/blog', '/tools', '/tools/quantumpage', '/tools/word-counter', '/tools/share'].map((path) => (
            <Route key={path} path={path} element={<Navigate to="/" replace />} />
          ))}
          <Route path="/tools/editor" element={<TextEditor />} />
          <Route path="/tools/file-converter" element={<FileConverter />} />
          <Route path="/builder/*" element={<Builder />} />
          <Route path="/quantumpage/:uuid" element={<InfinitePage />} />
          <Route path="*" element={<InfinitePage />} />
        </Routes>
      </Suspense>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
