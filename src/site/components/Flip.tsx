import { Fragment } from 'react';

/** Text whose characters turn over like discs when their link is hovered. */
export function Flip({ children }: { children: string }) {
  let i = 0;
  const words = children.trim().split(' ');
  return (
    <>
      {words.map((w, wi) => (
        <Fragment key={wi}>
          {wi > 0 && ' '}
          <span className="fw" aria-hidden="true">
            {[...w].map((c) => {
              const n = i++;
              return (
                <span className="f" style={{ ['--i' as string]: n }} key={n}>
                  <span>{c}</span>
                  <span>{c}</span>
                </span>
              );
            })}
          </span>
        </Fragment>
      ))}
      <span className="sr-only">{children}</span>
    </>
  );
}
