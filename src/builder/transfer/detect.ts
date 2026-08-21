/**
 * Work out what a project is from its files.
 *
 * Used when importing an archive that has no `.builder/project.json`. An explicit
 * manifest always wins; this is the fallback that makes a generic Next.js or Vite ZIP
 * runnable without the user configuring anything.
 */

import { PROJECT_SCHEMA_VERSION } from '../core/limits';
import type { Framework, PackageManager, ProjectCapabilities, ProjectManifest } from '../core/types';

interface PackageJsonShape {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Lockfiles are decisive; `packageManager` is the fallback; npm is the default. */
export function detectPackageManager(paths: Set<string>, pkg: PackageJsonShape | null): PackageManager {
  if (paths.has('pnpm-lock.yaml')) return 'pnpm';
  if (paths.has('bun.lockb') || paths.has('bun.lock')) return 'bun';
  if (paths.has('yarn.lock')) return 'yarn';
  if (paths.has('package-lock.json')) return 'npm';

  const declared = pkg?.packageManager?.split('@')[0];
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') {
    return declared;
  }
  return 'npm';
}

export function detectFramework(paths: Set<string>, pkg: PackageJsonShape | null): Framework {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const hasConfig = (base: string) =>
    ['js', 'mjs', 'cjs', 'ts', 'mts'].some((ext) => paths.has(`${base}.${ext}`));

  if (deps.next || hasConfig('next.config')) return 'nextjs';
  if (deps['@remix-run/react'] || deps['@remix-run/node'] || hasConfig('remix.config')) return 'remix';
  if (deps.astro || hasConfig('astro.config')) return 'astro';
  if (deps['@sveltejs/kit'] || hasConfig('svelte.config')) return 'sveltekit';
  if (deps.nuxt || deps.nuxt3 || hasConfig('nuxt.config')) return 'nuxt';
  if (deps.vite || hasConfig('vite.config')) return 'vite';
  if (deps['react-scripts']) return 'create-react-app';
  if (paths.has('index.html') && !pkg) return 'static';
  return pkg ? 'unknown' : 'static';
}

const RUN_PREFIX: Record<PackageManager, string> = {
  npm: 'npm run',
  pnpm: 'pnpm',
  yarn: 'yarn',
  bun: 'bun run',
};

const INSTALL_COMMAND: Record<PackageManager, string> = {
  npm: 'npm install',
  pnpm: 'pnpm install',
  yarn: 'yarn install',
  bun: 'bun install',
};

const DEFAULT_PORT: Partial<Record<Framework, number>> = {
  nextjs: 3000,
  remix: 3000,
  vite: 5173,
  astro: 4321,
  sveltekit: 5173,
  nuxt: 3000,
  'create-react-app': 3000,
};

/**
 * Everything is bound to 0.0.0.0 because only that is reachable through a Mosaic preview;
 * a dev server on 127.0.0.1 would appear to start and then serve nothing.
 */
export function detectCommands(
  framework: Framework,
  pm: PackageManager,
  pkg: PackageJsonShape | null,
): ProjectManifest['commands'] {
  const scripts = pkg?.scripts ?? {};
  const run = RUN_PREFIX[pm];
  const port = DEFAULT_PORT[framework] ?? 3000;

  const dev = scripts.dev
    ? `${run} dev`
    : scripts.start
      ? `${run} start`
      : framework === 'nextjs'
        ? 'npx next dev'
        : 'npx vite';

  const hostFlags =
    framework === 'nextjs' || framework === 'remix' || framework === 'nuxt'
      ? ` -H 0.0.0.0 -p ${port}`
      : ` --host 0.0.0.0 --port ${port}`;

  return {
    install: INSTALL_COMMAND[pm],
    // `--` forwards flags through the package manager to the underlying binary.
    dev: scripts.dev || scripts.start ? `${dev} --${hostFlags}` : `${dev}${hostFlags}`,
    build: scripts.build ? `${run} build` : 'npx next build',
    typecheck: scripts.typecheck
      ? `${run} typecheck`
      : scripts['type-check']
        ? `${run} type-check`
        : paths_hasTsconfig(pkg)
          ? 'npx tsc --noEmit'
          : undefined,
    migrate: scripts.migrate ? `${run} migrate` : scripts['db:migrate'] ? `${run} db:migrate` : undefined,
  };
}

function paths_hasTsconfig(pkg: PackageJsonShape | null): boolean {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  return Boolean(deps.typescript);
}

export function detectCapabilities(paths: Set<string>, pkg: PackageJsonShape | null): ProjectCapabilities {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const any = (...names: string[]) => names.some((n) => n in deps);
  const hasDir = (prefix: string) => [...paths].some((p) => p.startsWith(prefix));

  return {
    database:
      any('drizzle-orm', '@prisma/client', 'prisma', 'pg', 'postgres', '@neondatabase/serverless', 'kysely') ||
      hasDir('drizzle/') ||
      hasDir('prisma/') ||
      hasDir('migrations/'),
    auth: any('next-auth', '@auth/core', '@clerk/nextjs', '@supabase/auth-helpers-nextjs', 'lucia', '@descope/nextjs-sdk'),
    storage: any('@vercel/blob', '@aws-sdk/client-s3', 'uploadthing', '@supabase/storage-js'),
    payments: any('stripe', '@stripe/stripe-js', '@paddle/paddle-js', 'lemonsqueezy.ts'),
  };
}

/**
 * Environment variable names referenced by the source, so the exported `.env.example`
 * and the setup screen list what a deployment actually needs.
 *
 * Matches `process.env.NAME` and `import.meta.env.NAME`. Names only -- a value found here
 * would be a hardcoded secret, which is separately flagged by the agent policy.
 */
export function detectRequiredEnv(sources: Iterable<string>): string[] {
  const found = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
    /process\.env\[['"`]([A-Z][A-Z0-9_]{2,})['"`]\]/g,
    /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g,
  ];
  const ignored = new Set([
    'NODE_ENV', 'PORT', 'HOST', 'CI', 'PATH', 'HOME', 'PWD', 'TZ',
    'NEXT_RUNTIME', 'NEXT_TELEMETRY_DISABLED', 'VERCEL', 'VERCEL_ENV', 'VERCEL_URL',
    'VERCEL_REGION', 'npm_package_version', 'ANALYZE',
  ]);
  for (const source of sources) {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        if (!ignored.has(m[1])) found.add(m[1]);
      }
    }
  }
  return [...found].sort();
}

/** Parse `.env.example` for names the author already documented. */
export function parseEnvExample(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (m) names.push(m[1]);
  }
  return names;
}

export interface DetectionInput {
  paths: string[];
  /** Contents of files useful for detection; missing entries simply reduce confidence. */
  read: (path: string) => string | undefined;
  fallbackName: string;
}

/** Build a full manifest for a project that arrived without one. */
export function detectProject(input: DetectionInput): ProjectManifest {
  const paths = new Set(input.paths);

  let pkg: PackageJsonShape | null = null;
  const pkgRaw = input.read('package.json');
  if (pkgRaw) {
    try {
      pkg = JSON.parse(pkgRaw) as PackageJsonShape;
    } catch {
      pkg = null;
    }
  }

  const framework = detectFramework(paths, pkg);
  const packageManager = detectPackageManager(paths, pkg);
  const commands = detectCommands(framework, packageManager, pkg);

  const sources: string[] = [];
  for (const p of input.paths) {
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p)) {
      const content = input.read(p);
      if (content) sources.push(content);
    }
  }
  const fromCode = detectRequiredEnv(sources);
  const fromExample = parseEnvExample(input.read('.env.example') ?? '');
  const requiredEnv = [...new Set([...fromExample, ...fromCode])].sort();

  const now = Date.now();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name: pkg?.name || input.fallbackName,
    createdAt: now,
    updatedAt: now,
    framework,
    packageManager,
    commands,
    port: DEFAULT_PORT[framework] ?? 3000,
    requiredEnv,
    capabilities: detectCapabilities(paths, pkg),
  };
}
