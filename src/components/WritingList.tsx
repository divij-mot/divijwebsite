import { writings, type Writing } from '../data/writings';

type WritingListProps = {
  variant: 'editorial' | 'site';
  isDark?: boolean;
};

function WritingEntry({
  writing,
  variant,
  isDark = false,
}: {
  writing: Writing;
  variant: WritingListProps['variant'];
  isDark?: boolean;
}) {
  if (variant === 'editorial') {
    return (
      <article className="group">
        <a
          href={writing.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-800/40 rounded-sm"
        >
          <p
            className={`text-[0.7rem] tracking-[0.22em] uppercase mb-3 ${
              isDark ? 'text-neutral-500' : 'text-neutral-500'
            }`}
          >
            {writing.date}
            <span className="mx-2 text-neutral-400">·</span>
            {writing.venue}
          </p>

          <p
            className={`text-2xl md:text-[1.75rem] leading-snug mb-3 ${
              isDark ? 'text-neutral-100' : 'text-neutral-900'
            }`}
          >
            {writing.title}
            <span
              className={`ml-2 text-base font-normal italic ${
                isDark
                  ? 'text-neutral-500 group-hover:text-neutral-300'
                  : 'text-neutral-400 group-hover:text-neutral-700'
              }`}
            >
              ↗
            </span>
          </p>

          <p
            className={`text-[1.05rem] leading-relaxed mb-3 ${
              isDark ? 'text-neutral-300' : 'text-neutral-700'
            }`}
          >
            {writing.description}
          </p>

          <p
            className={`text-sm italic ${
              isDark ? 'text-neutral-500' : 'text-neutral-500'
            }`}
          >
            with {writing.with}
          </p>
        </a>
      </article>
    );
  }

  return (
    <article className="group">
      <a
        href={writing.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block pl-5 border-l border-neutral-200 dark:border-neutral-700 hover:border-red-800/60 dark:hover:border-red-700/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-800/40"
      >
        <p className="text-[0.7rem] tracking-[0.18em] uppercase text-neutral-500 mb-3">
          {writing.date}
          <span className="mx-2">·</span>
          {writing.venue}
        </p>

        <p className="text-2xl md:text-[1.7rem] font-medium leading-snug text-neutral-900 dark:text-neutral-100 mb-3">
          {writing.title}
          <span className="ml-2 text-sm font-normal text-neutral-400 group-hover:text-red-800 dark:group-hover:text-red-500 transition-colors">
            ↗
          </span>
        </p>

        <p className="text-[1.05rem] leading-relaxed text-neutral-600 dark:text-neutral-400 mb-2">
          {writing.description}
        </p>

        <p className="text-sm italic text-neutral-500">with {writing.with}</p>
      </a>
    </article>
  );
}

export function WritingList({ variant, isDark = false }: WritingListProps) {
  const divider =
    variant === 'editorial'
      ? `border-t ${isDark ? 'border-neutral-700' : 'border-neutral-400'}`
      : 'border-t border-neutral-200 dark:border-neutral-800';

  return (
    <div className="space-y-12">
      {writings.map((writing, index) => (
        <div key={writing.id}>
          {index > 0 && <div className={`${divider} mb-12`} />}
          <WritingEntry writing={writing} variant={variant} isDark={isDark} />
        </div>
      ))}
    </div>
  );
}
