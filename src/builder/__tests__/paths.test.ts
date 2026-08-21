/**
 * Path containment.
 *
 * The corpus below is the point of this file: each entry is a real technique for escaping
 * an extraction directory. The same corpus runs against the server-side validator so the
 * two implementations cannot drift apart.
 */

import { describe, expect, it } from 'vitest';

import {
  isBinaryContent,
  isExcludedPath,
  isSecretPath,
  looksTextual,
  normalizeProjectPath,
  toWorkspacePath,
  tryNormalizeProjectPath,
} from '../core/paths';
import { assertProjectPath, assertPublicHostname } from '../../../api/_lib/validate.js';

const MUST_REJECT: [string, string][] = [
  ['../etc/passwd', 'parent traversal'],
  ['a/../../b', 'traversal in the middle'],
  ['/etc/passwd', 'absolute path'],
  ['//etc/passwd', 'protocol-relative'],
  ['C:\\Windows\\System32', 'windows drive'],
  ['c:/windows', 'lowercase drive'],
  ['~/.ssh/id_rsa', 'home relative'],
  ['a\\..\\b', 'backslash traversal'],
  ['dir\\file.txt', 'backslash separator'],
  ['%2e%2e/etc', 'percent-encoded dots'],
  ['a%2fb', 'percent-encoded slash'],
  ['a%5cb', 'percent-encoded backslash'],
  ['file\u0000.txt', 'NUL byte'],
  ['file\u001f.txt', 'control character'],
  ['a//b', 'empty interior segment'],
  ['..', 'bare parent'],
  ['.', 'bare dot'],
  ['./', 'dot slash only'],
  ['', 'empty string'],
  ['con.txt', 'windows device name'],
  ['NUL', 'windows device'],
  ['LPT1.log', 'windows device with extension'],
  ['trailing.', 'trailing dot'],
  ['trailing ', 'trailing space'],
  [`${'a/'.repeat(50)}b`, 'too deep'],
  ['x'.repeat(500), 'too long'],
];

const MUST_ACCEPT: [string, string][] = [
  ['app/page.tsx', 'app/page.tsx'],
  ['./app/page.tsx', 'app/page.tsx'],
  ['a/./b/c.ts', 'a/b/c.ts'],
  ['package.json', 'package.json'],
  ['.gitignore', '.gitignore'],
  ['components/ui/Button.tsx', 'components/ui/Button.tsx'],
  ['public/images/logo@2x.png', 'public/images/logo@2x.png'],
  ['app/(marketing)/page.tsx', 'app/(marketing)/page.tsx'],
  ['app/[slug]/page.tsx', 'app/[slug]/page.tsx'],
  ['déjà-vu/café.ts', 'déjà-vu/café.ts'],
];

describe('normalizeProjectPath', () => {
  for (const [input, reason] of MUST_REJECT) {
    it(`rejects ${JSON.stringify(input)} (${reason})`, () => {
      expect(() => normalizeProjectPath(input)).toThrow();
      expect(tryNormalizeProjectPath(input)).toBeNull();
    });
  }

  for (const [input, expected] of MUST_ACCEPT) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      expect(normalizeProjectPath(input)).toBe(expected);
    });
  }

  it('normalizes decomposed unicode so two spellings cannot collide', () => {
    // "é" as e + combining acute must normalize to the same path as precomposed "é".
    expect(normalizeProjectPath('cafe\u0301/x.ts')).toBe(normalizeProjectPath('café/x.ts'));
  });
});

describe('server-side validator agrees with the browser', () => {
  for (const [input] of MUST_REJECT) {
    it(`server rejects ${JSON.stringify(input)}`, () => {
      expect(() => assertProjectPath(input)).toThrow();
    });
  }

  for (const [input, expected] of MUST_ACCEPT) {
    it(`server accepts ${JSON.stringify(input)}`, () => {
      expect(assertProjectPath(input)).toBe(expected);
    });
  }
});

describe('toWorkspacePath', () => {
  it('joins under the workspace root', () => {
    expect(toWorkspacePath('/workspace/project', 'app/page.tsx')).toBe('/workspace/project/app/page.tsx');
  });

  it('refuses anything that would escape', () => {
    expect(() => toWorkspacePath('/workspace/project', '../../etc/passwd')).toThrow();
    expect(() => toWorkspacePath('/workspace/project', '/etc/passwd')).toThrow();
  });
});

describe('secret and exclusion detection', () => {
  it('treats credential files as secret', () => {
    for (const p of [
      '.env',
      '.env.local',
      '.env.production',
      'config/.env.staging',
      '.npmrc',
      '.netrc',
      'id_rsa',
      'certs/server.pem',
      'credentials.json',
      'service-account-key.json',
      '.git-credentials',
    ]) {
      expect(isSecretPath(p), p).toBe(true);
    }
  });

  it('keeps .env.example, which documents the variable names a deployment needs', () => {
    expect(isSecretPath('.env.example')).toBe(false);
    expect(isSecretPath('.env.sample')).toBe(false);
    expect(isSecretPath('.env.template')).toBe(false);
  });

  it('excludes dependency and build directories at any depth', () => {
    for (const p of [
      'node_modules/react/index.js',
      '.git/config',
      '.next/cache/x',
      'packages/app/node_modules/x',
      'dist/index.js',
      'coverage/lcov.info',
    ]) {
      expect(isExcludedPath(p), p).toBe(true);
    }
    expect(isExcludedPath('app/dist-helpers/x.ts')).toBe(false);
  });
});

describe('content classification', () => {
  it('recognizes textual files by extension and name', () => {
    expect(looksTextual('app/page.tsx')).toBe(true);
    expect(looksTextual('Dockerfile')).toBe(true);
    expect(looksTextual('.gitignore')).toBe(true);
    expect(looksTextual('image.png')).toBe(false);
  });

  it('detects binary content by bytes, which beats the extension guess', () => {
    expect(isBinaryContent(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
    expect(isBinaryContent(new TextEncoder().encode('const x = 1;\n'))).toBe(false);
    expect(isBinaryContent(new TextEncoder().encode('héllo wörld ✓'))).toBe(false);
  });
});

describe('assertPublicHostname', () => {
  it('accepts ordinary public hostnames', () => {
    expect(assertPublicHostname('api.example.com')).toBe('api.example.com');
    expect(assertPublicHostname('API.Example.COM')).toBe('api.example.com');
    expect(assertPublicHostname('api.example.com.')).toBe('api.example.com');
  });

  it('refuses addresses and internal names that could reach the host network', () => {
    for (const bad of [
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.1',
      'localhost',
      'db.local',
      'service.internal',
      'metadata.google',
      'http://example.com',
      'example.com:8080',
      'user@example.com',
      'example.com/path',
      '',
      'no-dot',
    ]) {
      expect(() => assertPublicHostname(bad), bad).toThrow();
    }
  });
});
