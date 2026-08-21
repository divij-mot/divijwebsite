/**
 * Project detection and the generated scaffold.
 *
 * The scaffold tests encode the portability contract from the plan: a database-backed
 * export must build and run with no credentials, because the owner's first Vercel deploy
 * always happens before they have connected Postgres.
 */

import { describe, expect, it } from 'vitest';

import {
  detectCapabilities,
  detectFramework,
  detectPackageManager,
  detectProject,
  detectRequiredEnv,
  parseEnvExample,
} from '../transfer/detect';
import { createNextScaffold } from '../transfer/scaffold';

const paths = (...items: string[]) => new Set(items);

describe('framework detection', () => {
  it('identifies frameworks from dependencies', () => {
    expect(detectFramework(paths(), { dependencies: { next: '^15' } })).toBe('nextjs');
    expect(detectFramework(paths(), { dependencies: { '@remix-run/react': '^2' } })).toBe('remix');
    expect(detectFramework(paths(), { dependencies: { astro: '^4' } })).toBe('astro');
    expect(detectFramework(paths(), { dependencies: { nuxt: '^3' } })).toBe('nuxt');
    expect(detectFramework(paths(), { devDependencies: { '@sveltejs/kit': '^2' } })).toBe('sveltekit');
    expect(detectFramework(paths(), { devDependencies: { vite: '^5' } })).toBe('vite');
    expect(detectFramework(paths(), { dependencies: { 'react-scripts': '^5' } })).toBe('create-react-app');
  });

  it('falls back to config files when dependencies are absent', () => {
    expect(detectFramework(paths('next.config.mjs'), null)).toBe('nextjs');
    expect(detectFramework(paths('vite.config.ts'), null)).toBe('vite');
  });

  it('treats a bare index.html as static', () => {
    expect(detectFramework(paths('index.html'), null)).toBe('static');
  });

  it('prefers Next.js when a project has both Next and Vite', () => {
    // Next projects often carry vite transitively; the more specific answer wins.
    expect(detectFramework(paths('next.config.js'), { dependencies: { next: '^15', vite: '^5' } })).toBe('nextjs');
  });
});

describe('package manager detection', () => {
  it('trusts the lockfile over anything else', () => {
    expect(detectPackageManager(paths('pnpm-lock.yaml'), { packageManager: 'yarn@4' })).toBe('pnpm');
    expect(detectPackageManager(paths('yarn.lock'), null)).toBe('yarn');
    expect(detectPackageManager(paths('bun.lockb'), null)).toBe('bun');
    expect(detectPackageManager(paths('package-lock.json'), null)).toBe('npm');
  });

  it('falls back to the packageManager field, then to npm', () => {
    expect(detectPackageManager(paths(), { packageManager: 'pnpm@9.0.0' })).toBe('pnpm');
    expect(detectPackageManager(paths(), null)).toBe('npm');
  });
});

describe('environment variable detection', () => {
  it('finds names referenced in source', () => {
    const found = detectRequiredEnv([
      'const key = process.env.STRIPE_SECRET_KEY;',
      'const url = process.env["DATABASE_URL"];',
      'const pk = import.meta.env.VITE_PUBLIC_KEY;',
    ]);
    expect(found).toContain('STRIPE_SECRET_KEY');
    expect(found).toContain('DATABASE_URL');
    expect(found).toContain('VITE_PUBLIC_KEY');
  });

  it('ignores platform variables the deployment already provides', () => {
    const found = detectRequiredEnv(['process.env.NODE_ENV', 'process.env.VERCEL_URL', 'process.env.PORT']);
    expect(found).toEqual([]);
  });

  it('reads names from .env.example without reading values', () => {
    const names = parseEnvExample('# comment\nDATABASE_URL=postgres://real:secret@host/db\nexport API_KEY=abc\n\n');
    expect(names).toEqual(['DATABASE_URL', 'API_KEY']);
    expect(names.join()).not.toContain('secret');
  });
});

describe('capability detection', () => {
  it('recognizes integrations from dependencies and directories', () => {
    expect(detectCapabilities(paths('drizzle/0000_init.sql'), { dependencies: { 'drizzle-orm': '^0.44' } }).database).toBe(true);
    expect(detectCapabilities(paths(), { dependencies: { '@clerk/nextjs': '^6' } }).auth).toBe(true);
    expect(detectCapabilities(paths(), { dependencies: { '@vercel/blob': '^1' } }).storage).toBe(true);
    expect(detectCapabilities(paths(), { dependencies: { stripe: '^17' } }).payments).toBe(true);
  });
});

describe('detectProject', () => {
  it('builds a runnable manifest for a project with no builder metadata', () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({
        name: 'inferred-app',
        scripts: { dev: 'next dev', build: 'next build' },
        dependencies: { next: '^15' },
        devDependencies: { typescript: '^5' },
      }),
      'app/page.tsx': 'const k = process.env.RESEND_API_KEY;',
    };

    const manifest = detectProject({
      paths: [...Object.keys(files), 'pnpm-lock.yaml'],
      read: (p) => files[p],
      fallbackName: 'fallback',
    });

    expect(manifest.name).toBe('inferred-app');
    expect(manifest.framework).toBe('nextjs');
    expect(manifest.packageManager).toBe('pnpm');
    expect(manifest.requiredEnv).toContain('RESEND_API_KEY');
    expect(manifest.commands.typecheck).toBe('npx tsc --noEmit');
    // Bound to all interfaces, or the sandbox preview shows nothing.
    expect(manifest.commands.dev).toContain('0.0.0.0');
  });
});

describe('createNextScaffold', () => {
  it('produces a Vercel-ready Next.js project', () => {
    const { manifest, files } = createNextScaffold({ name: 'My App', withDatabase: false });
    expect(manifest.name).toBe('my-app');
    expect(manifest.framework).toBe('nextjs');
    expect(files['app/page.tsx']).toBeDefined();
    expect(files['app/api/health/route.ts']).toBeDefined();

    const pkg = JSON.parse(files['package.json']);
    expect(pkg.scripts.dev).toContain('0.0.0.0');
    expect(pkg.scripts.build).toBe('next build');
  });

  it('never puts a credential in the scaffold', () => {
    const { files } = createNextScaffold({ name: 'secrets', withDatabase: true });
    const all = Object.values(files).join('\n');
    expect(all).not.toMatch(/postgres:\/\/[^\s"']*:[^\s"']+@/);
    expect(all).not.toMatch(/\bsk-[A-Za-z0-9]{20,}/);
    // .env.example documents the name with an empty value.
    expect(files['.env.example']).toContain('DATABASE_URL=');
    expect(files['.env.example']).not.toMatch(/DATABASE_URL=\S/);
  });

  it('builds without credentials, which is the portability contract', () => {
    const { files, manifest } = createNextScaffold({ name: 'db-app', withDatabase: true });

    // Migration runs before the build, so a later deploy applies schema automatically.
    expect(JSON.parse(files['package.json']).scripts.build).toBe('node scripts/migrate.mjs && next build');
    // ...and exits successfully when there is nothing to connect to, so the FIRST deploy
    // succeeds before the owner has connected Postgres.
    expect(files['scripts/migrate.mjs']).toContain('process.exit(0)');
    expect(files['scripts/migrate.mjs']).toContain('DATABASE_URL is not set');
    // Concurrent builds must not apply the same migration twice.
    expect(files['scripts/migrate.mjs']).toContain('pg_advisory_lock');

    // Nothing may throw at import time when the variable is absent.
    expect(files['lib/db.ts']).toContain('isDatabaseConfigured');
    expect(files['lib/db.ts']).toContain('return null');

    expect(files['app/setup/page.tsx']).toBeDefined();
    expect(manifest.requiredEnv).toEqual(['DATABASE_URL']);
    expect(manifest.capabilities.database).toBe(true);
  });

  it('degrades API routes to demo data instead of failing', () => {
    const { files } = createNextScaffold({ name: 'db-app', withDatabase: true });
    expect(files['app/api/items/route.ts']).toContain('demo: true');
    expect(files['app/api/items/route.ts']).toContain('/setup');
  });

  it('omits database machinery when it was not asked for', () => {
    const { files, manifest } = createNextScaffold({ name: 'plain', withDatabase: false });
    expect(files['lib/db.ts']).toBeUndefined();
    expect(files['scripts/migrate.mjs']).toBeUndefined();
    expect(manifest.capabilities.database).toBe(false);
    expect(manifest.requiredEnv).toEqual([]);
  });

  it('normalizes an awkward project name into a usable one', () => {
    expect(createNextScaffold({ name: '  My Cool App!! ', withDatabase: false }).manifest.name).toBe('my-cool-app');
    expect(createNextScaffold({ name: '???', withDatabase: false }).manifest.name).toBe('app');
  });
});
