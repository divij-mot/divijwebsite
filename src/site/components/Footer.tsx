import { useLayoutEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Flip } from './Flip';
import { splitWord, kernWord, fitWord, gutter } from '../lib/wordmark.js';
import { blockReady } from '../lib/fonts.js';
import { attachSwap } from '../lib/swap.js';

/** The blue plate: email, links, and MOTWANI edge to edge. */
export function Footer() {
  const word = useRef<HTMLSpanElement>(null);
  const plate = useRef<HTMLElement>(null);

  // "berkeley" in the email: a lens onto the other palette, a click switches to it
  useLayoutEffect(() => attachSwap(plate.current!), []);

  useLayoutEffect(() => {
    const el = word.current!;
    splitWord(el);
    const fit = () => {
      kernWord(el);
      fitWord(el, document.documentElement.clientWidth - 2 * gutter())();
    };
    fit();
    blockReady().then(fit);
    let lastW = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      fit();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <footer className="contact" ref={plate}>
      <div className="row">
        <span aria-hidden="true" />
        <div>
          <p className="contact__mail serif">
            divij&nbsp;[at]{' '}
            <button type="button" className="swap" data-swap>
              berkeley
            </button>{' '}
            [dot]&nbsp;edu
          </p>
          <p className="links">
            <a href="https://github.com/divij-mot"><Flip>GitHub</Flip></a>
            <a href="https://www.linkedin.com/in/divijmotwani/"><Flip>LinkedIn</Flip></a>
            <a href="https://x.com/DivijMot"><Flip>X</Flip></a>
          </p>
        </div>
      </div>
      {/* on inner pages the name is the way home */}
      <Link to="/" className="contact__name contact__home" aria-label="Divij Motwani — home">
        <span className="word contact__word" data-word="MOTWANI" ref={word} aria-hidden="true" />
      </Link>
      <p className="contact__base">© 2026 Divij Motwani. All rights reserved.</p>
    </footer>
  );
}
