import { useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import markup from './home/home.html?raw';
import { initHome } from './home/home.js';

// the opening plays once: on the first page load, and only at "/"
let firstLoad = true;
// ...and again, in the new colours, right after the Berkeley lens switches the palette
let replay = false;

export default function Home() {
  const root = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { hash } = useLocation();
  const section = hash === '#work' ? 'work' : null;
  const [run, setRun] = useState(0);

  useLayoutEffect(() => {
    const el = root.current!;
    el.innerHTML = markup;
    const replaying = replay;
    const playIntro =
      replaying || (firstLoad && location.pathname === '/' && !new URLSearchParams(location.search).has('skip'));
    firstLoad = false;
    replay = false;
    document.title = 'Divij Motwani';
    const onPalette = () => {
      replay = true;
      setRun((n) => n + 1);
    };
    const destroy = initHome(el, { playIntro, section: replaying ? null : section, navigate, onPalette });
    return () => {
      destroy();
      el.innerHTML = '';
    };
  }, [section, navigate, run]);

  return <div ref={root} className="home" />;
}
