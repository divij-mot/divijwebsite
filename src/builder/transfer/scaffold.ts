/**
 * The starting point for a new project.
 *
 * Next.js App Router, TypeScript, Tailwind, and API routes, arranged so the very first
 * `vercel` deploy succeeds before the user has connected anything. That constraint drives
 * most of what is here: the database module degrades to a clearly-labelled demo mode
 * instead of throwing, the migration script no-ops without `DATABASE_URL`, and `/setup`
 * tells the owner exactly what is missing.
 *
 * A build that fails because a credential is absent is a broken export, since the first
 * deploy always happens before the database exists.
 */

import { PROJECT_SCHEMA_VERSION } from '../core/limits';
import type { ProjectManifest } from '../core/types';

export interface ScaffoldOptions {
  name: string;
  withDatabase: boolean;
}

export interface Scaffold {
  manifest: ProjectManifest;
  files: Record<string, string>;
}

export function createNextScaffold(options: ScaffoldOptions): Scaffold {
  const { name, withDatabase } = options;
  const safeName = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';

  const files: Record<string, string> = {
    'package.json': packageJson(safeName, withDatabase),
    'tsconfig.json': tsconfig(),
    'next.config.mjs': nextConfig(),
    'postcss.config.mjs': "export default { plugins: { '@tailwindcss/postcss': {} } };\n",
    '.gitignore': gitignore(),
    '.env.example': envExample(withDatabase),
    'app/layout.tsx': layout(safeName),
    'app/page.tsx': homePage(safeName, withDatabase),
    'app/globals.css': globalsCss(),
    'app/api/health/route.ts': healthRoute(withDatabase),
    'README.md': readme(safeName, withDatabase),
  };

  if (withDatabase) {
    Object.assign(files, {
      'lib/db.ts': dbModule(),
      'lib/schema.ts': schemaModule(),
      'drizzle.config.ts': drizzleConfig(),
      'scripts/migrate.mjs': migrateScript(),
      'app/setup/page.tsx': setupPage(),
      'app/api/items/route.ts': itemsRoute(),
    });
  }

  const now = Date.now();
  const manifest: ProjectManifest = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name: safeName,
    createdAt: now,
    updatedAt: now,
    framework: 'nextjs',
    packageManager: 'npm',
    commands: {
      install: 'npm install',
      dev: 'npm run dev',
      build: 'npm run build',
      typecheck: 'npx tsc --noEmit',
      ...(withDatabase ? { migrate: 'node scripts/migrate.mjs' } : {}),
    },
    port: 3000,
    requiredEnv: withDatabase ? ['DATABASE_URL'] : [],
    capabilities: { database: withDatabase, auth: false, storage: false, payments: false },
  };

  return { manifest, files };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function packageJson(name: string, withDatabase: boolean): string {
  const pkg = {
    name,
    version: '0.1.0',
    private: true,
    scripts: {
      // -H 0.0.0.0 is required: bound to localhost the sandbox preview shows nothing.
      dev: 'next dev -H 0.0.0.0 -p 3000',
      // The migration runs before the build and is a no-op without DATABASE_URL, so the
      // first deploy succeeds and later deploys apply schema automatically.
      build: withDatabase ? 'node scripts/migrate.mjs && next build' : 'next build',
      start: 'next start -H 0.0.0.0 -p 3000',
      typecheck: 'tsc --noEmit',
      ...(withDatabase ? { migrate: 'node scripts/migrate.mjs' } : {}),
    },
    dependencies: {
      next: '^15.5.0',
      react: '^19.1.0',
      'react-dom': '^19.1.0',
      ...(withDatabase ? { 'drizzle-orm': '^0.44.0', postgres: '^3.4.5' } : {}),
    },
    devDependencies: {
      '@types/node': '^22.10.0',
      '@types/react': '^19.1.0',
      '@types/react-dom': '^19.1.0',
      '@tailwindcss/postcss': '^4.1.0',
      tailwindcss: '^4.1.0',
      typescript: '^5.7.0',
      ...(withDatabase ? { 'drizzle-kit': '^0.31.0' } : {}),
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function tsconfig(): string {
  return (
    JSON.stringify(
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
          paths: { '@/*': ['./*'] },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      },
      null,
      2,
    ) + '\n'
  );
}

function nextConfig(): string {
  return `/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
`;
}

function gitignore(): string {
  return `node_modules/
.next/
out/
dist/
.env
.env.*
!.env.example
.vercel
*.log
.DS_Store
`;
}

function envExample(withDatabase: boolean): string {
  if (!withDatabase) {
    return `# This project needs no environment variables yet.
# Add names here as you add integrations. Values never belong in this file.
`;
  }
  return `# Postgres connection string.
#
# Leave this unset and the app still builds and runs, in demo mode, with /setup
# explaining what is missing. To make it persistent, connect Neon, Supabase, or any
# Postgres provider under Storage in your Vercel project and redeploy: Vercel injects
# this variable for you.
DATABASE_URL=
`;
}

function layout(name: string): string {
  return `import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '${name}',
  description: 'Built with the portable builder.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        {children}
      </body>
    </html>
  );
}
`;
}

function globalsCss(): string {
  return `@import 'tailwindcss';
`;
}

function homePage(name: string, withDatabase: boolean): string {
  return `${withDatabase ? "import Link from 'next/link';\nimport { isDatabaseConfigured } from '@/lib/db';\n\n" : ''}export default function Home() {
${withDatabase ? '  const configured = isDatabaseConfigured();\n\n' : ''}  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">${name}</h1>
      <p className="text-neutral-600 dark:text-neutral-400">
        Your app is running. Describe what you want next and it will be built here.
      </p>
${
  withDatabase
    ? `      {!configured && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <p className="font-medium text-amber-900 dark:text-amber-200">Running in demo mode</p>
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            No database is connected, so data is not saved.{' '}
            <Link href="/setup" className="underline underline-offset-2">
              See what to connect
            </Link>
            .
          </p>
        </div>
      )}
`
    : ''
}    </main>
  );
}
`;
}

function healthRoute(withDatabase: boolean): string {
  return `import { NextResponse } from 'next/server';
${withDatabase ? "import { isDatabaseConfigured } from '@/lib/db';\n" : ''}
export async function GET() {
  return NextResponse.json({
    ok: true,
    time: new Date().toISOString(),
${withDatabase ? '    database: isDatabaseConfigured() ? \'connected\' : \'demo-mode\',\n' : ''}  });
}
`;
}

/**
 * The database boundary.
 *
 * Every rule here exists so a missing `DATABASE_URL` produces a working demo app rather
 * than a failed build: the connection is created lazily, `isDatabaseConfigured` is the
 * single thing UI code branches on, and nothing throws at import time.
 */
function dbModule(): string {
  return `import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

/**
 * Whether a real database is available.
 *
 * The app is designed to run without one so the first Vercel deploy succeeds before the
 * owner has connected Postgres. Branch on this rather than on DATABASE_URL directly.
 */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

type Database = ReturnType<typeof drizzle<typeof schema>>;

let cached: Database | null = null;

/**
 * Returns the database, or null in demo mode.
 *
 * Connecting lazily matters on Vercel: creating a client at module scope would open a
 * connection during the build, when DATABASE_URL may legitimately be absent.
 */
export function getDb(): Database | null {
  if (!isDatabaseConfigured()) return null;
  if (!cached) {
    const client = postgres(process.env.DATABASE_URL!, {
      // Serverless functions are short-lived; a large pool exhausts Postgres connections.
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    cached = drizzle(client, { schema });
  }
  return cached;
}

/** Use where a caller genuinely cannot proceed without persistence. */
export function requireDb(): Database {
  const db = getDb();
  if (!db) {
    throw new Error('DATABASE_URL is not set. Connect a Postgres database in Vercel and redeploy.');
  }
  return db;
}
`;
}

function schemaModule(): string {
  return `import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/** Starter table. Replace it with your own model. */
export const items = pgTable('items', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
`;
}

function drizzleConfig(): string {
  return `import type { Config } from 'drizzle-kit';

export default {
  schema: './lib/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
} satisfies Config;
`;
}

/**
 * Migrations run before `next build`.
 *
 * Two properties make this safe to wire into the build command: it exits successfully
 * when DATABASE_URL is absent, and it takes a Postgres advisory lock so two builds racing
 * on the same database cannot apply the same migration twice.
 */
function migrateScript(): string {
  return `#!/usr/bin/env node
/**
 * Idempotent migration runner, invoked from the build.
 *
 * Without DATABASE_URL it exits 0 and does nothing, which is what lets the first Vercel
 * deploy succeed before any database exists. With it, an advisory lock serialises
 * concurrent builds so the same migration is never applied twice.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('[migrate] DATABASE_URL is not set; skipping. The app will run in demo mode.');
  process.exit(0);
}

// A lock id unique to this application, so unrelated apps sharing a database do not block
// each other.
const LOCK_ID = 8172634509n;

const { default: postgres } = await import('postgres');
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await sql\`SELECT pg_advisory_lock(\${LOCK_ID})\`;

  await sql\`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  \`;

  let files = [];
  try {
    files = (await readdir(join(process.cwd(), 'drizzle')))
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    console.log('[migrate] No drizzle/ directory yet; nothing to apply.');
  }

  const applied = new Set((await sql\`SELECT name FROM _migrations\`).map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(join(process.cwd(), 'drizzle', file), 'utf8');
    console.log(\`[migrate] applying \${file}\`);
    // Each migration and its bookkeeping row commit together, so a crash mid-run cannot
    // record a migration that did not fully apply.
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx\`INSERT INTO _migrations (name) VALUES (\${file})\`;
    });
  }

  console.log(\`[migrate] up to date (\${files.length} migration file(s))\`);
} catch (error) {
  console.error('[migrate] failed:', error.message);
  process.exit(1);
} finally {
  await sql\`SELECT pg_advisory_unlock(\${LOCK_ID})\`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
}
`;
}

function setupPage(): string {
  return `import { isDatabaseConfigured } from '@/lib/db';

/**
 * Honest status page. Rendered dynamically so it reflects the running deployment's
 * environment rather than whatever was set at build time.
 */
export const dynamic = 'force-dynamic';

export default function SetupPage() {
  const checks = [
    {
      name: 'Database',
      ok: isDatabaseConfigured(),
      variable: 'DATABASE_URL',
      how: 'Open your Vercel project, go to Storage, connect Neon or Supabase Postgres, then redeploy. Vercel sets this variable for you.',
    },
  ];

  const ready = checks.every((c) => c.ok);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Setup</h1>
      <p className="mt-2 text-neutral-600 dark:text-neutral-400">
        {ready
          ? 'Everything is connected. The app is running with full persistence.'
          : 'The app is running in demo mode. Connect the following to make data persistent.'}
      </p>

      <ul className="mt-8 space-y-4">
        {checks.map((check) => (
          <li
            key={check.name}
            className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <div className="flex items-center justify-between gap-4">
              <span className="font-medium">{check.name}</span>
              <span
                className={
                  check.ok
                    ? 'text-sm font-medium text-emerald-600 dark:text-emerald-400'
                    : 'text-sm font-medium text-amber-600 dark:text-amber-400'
                }
              >
                {check.ok ? 'Connected' : 'Not configured'}
              </span>
            </div>
            {!check.ok && (
              <>
                <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{check.how}</p>
                <code className="mt-2 inline-block rounded bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-900">
                  {check.variable}
                </code>
              </>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-8 text-sm text-neutral-500">
        Your data lives in your own database. It is never stored by the builder.
      </p>
    </main>
  );
}
`;
}

function itemsRoute(): string {
  return `import { NextResponse } from 'next/server';

import { getDb } from '@/lib/db';
import { items } from '@/lib/schema';

/**
 * Demonstrates the degradation contract: without a database the route still answers, with
 * demo data and a flag saying so, instead of returning a 500 that looks like a bug.
 */
export async function GET() {
  const db = getDb();
  if (!db) {
    return NextResponse.json({
      demo: true,
      message: 'No database connected. Visit /setup to connect one.',
      items: [{ id: 1, title: 'Example item (not saved)', createdAt: new Date().toISOString() }],
    });
  }
  const rows = await db.select().from(items).orderBy(items.createdAt).limit(100);
  return NextResponse.json({ demo: false, items: rows });
}

export async function POST(request: Request) {
  const db = getDb();
  const body = (await request.json().catch(() => ({}))) as { title?: string };
  const title = String(body.title ?? '').trim();

  if (!title) {
    return NextResponse.json({ error: 'A title is required.' }, { status: 400 });
  }
  if (!db) {
    return NextResponse.json(
      { demo: true, error: 'Not saved: no database is connected. Visit /setup.' },
      { status: 503 },
    );
  }

  const [created] = await db.insert(items).values({ title }).returning();
  return NextResponse.json({ demo: false, item: created }, { status: 201 });
}
`;
}

function readme(name: string, withDatabase: boolean): string {
  return `# ${name}

Next.js App Router with TypeScript and Tailwind, ready to deploy to Vercel.

## Local development

\`\`\`bash
npm install
npm run dev
\`\`\`

## Deploy

Drag the exported ZIP onto https://vercel.com/drop, or run \`vercel\` from this directory.

${
  withDatabase
    ? `## Database

The app builds and runs without a database, in demo mode, so your first deploy works
before you have connected anything. \`/setup\` shows what is missing.

To add persistence: connect Postgres under Storage in your Vercel project and redeploy.
Vercel injects \`DATABASE_URL\`, and the migration script runs automatically before the
build. It is idempotent and holds an advisory lock, so concurrent builds are safe.
`
    : ''
}`;
}
