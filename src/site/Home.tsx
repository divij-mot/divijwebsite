import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import markup from './home/home.html?raw';
import { initHome } from './home/home.js';

// the opening plays once: on the first page load, and only at "/"
let firstLoad = true;

export default function Home() {
  const root = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { hash } = useLocation();
  const section = hash === '#work' ? 'work' : null;

  useLayoutEffect(() => {
    const el = root.current!;
    el.innerHTML = markup;
    const playIntro =
      firstLoad && location.pathname === '/' && !new URLSearchParams(location.search).has('skip');
    firstLoad = false;
    document.title = 'Divij Motwani';
    const destroy = initHome(el, { playIntro, section, navigate });
    return () => {
      destroy();
      el.innerHTML = '';
    };
  }, [section, navigate]);

  return <div ref={root} className="home" />;
}
