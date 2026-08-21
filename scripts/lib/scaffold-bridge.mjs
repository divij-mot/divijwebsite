/**
 * A minimal Next.js project for the live acceptance test.
 *
 * Deliberately hand-written rather than imported from src/builder/transfer/scaffold.ts:
 * that module is TypeScript and this script runs under plain Node. Keeping it small also
 * keeps the end-to-end run fast, since the point is to exercise the sandbox tooling
 * rather than to test the scaffold, which has its own unit tests.
 *
 * It does include a form, because the acceptance scenario requires the browser agent to
 * verify a real interaction rather than just a page load.
 */

export function createNextScaffoldForTest(name) {
  return {
    'package.json': JSON.stringify(
      {
        name,
        version: '0.1.0',
        private: true,
        scripts: {
          dev: 'next dev -H 0.0.0.0 -p 3000',
          build: 'next build',
          start: 'next start -H 0.0.0.0 -p 3000',
        },
        dependencies: { next: '^15.5.0', react: '^19.1.0', 'react-dom': '^19.1.0' },
        devDependencies: {
          '@types/node': '^22.10.0',
          '@types/react': '^19.1.0',
          '@types/react-dom': '^19.1.0',
          typescript: '^5.7.0',
        },
      },
      null,
      2,
    ),

    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'preserve',
          incremental: true,
          plugins: [{ name: 'next' }],
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      },
      null,
      2,
    ),

    'next.config.mjs': 'export default {};\n',

    'app/layout.tsx': `export const metadata = { title: '${name}' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,

    // A client component with a controlled input and a submit button: enough for the
    // browser agent to snapshot, fill, click, and then observe a changed page.
    'app/page.tsx': `'use client';

import { useState } from 'react';

export default function Home() {
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 40 }}>
      <h1>${name}</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(value);
        }}
      >
        <input
          type="text"
          aria-label="Message"
          placeholder="Type a message"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit">Submit</button>
      </form>
      {submitted && <p data-testid="result">{submitted}</p>}
    </main>
  );
}
`,

    'app/api/health/route.ts': `export async function GET() {
  return Response.json({ ok: true, app: '${name}' });
}
`,
  };
}
