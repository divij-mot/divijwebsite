/**
 * Cross-boundary contracts.
 *
 * The browser bundle and the Vercel functions cannot import from each other, so several
 * things are defined twice. These tests are what stop the two copies from drifting -- a
 * mismatch here is a bug that would otherwise surface as a confusing runtime failure.
 */

import { describe, expect, it } from 'vitest';

import { AGENT_TOOLS, LOCAL_TOOLS, MUTATING_TOOLS, TOOL_NAME_TO_ENDPOINT } from '../agent/tools';
import * as browserLimits from '../core/limits';
import * as serverLimits from '../../../api/_lib/limits.js';
import { TOOLS } from '../../../api/_lib/tools.js';

describe('limits are identical on both sides of the network boundary', () => {
  const groups = [
    'ARCHIVE_LIMITS',
    'SANDBOX_LIMITS',
    'TIMEOUTS_MS',
    'AGENT_LIMITS',
    'QUOTA_LIMITS',
  ] as const;

  for (const group of groups) {
    it(group, () => {
      const browser = browserLimits[group] as Record<string, number>;
      const server = serverLimits[group] as Record<string, number>;
      expect(server).toBeDefined();
      for (const [key, value] of Object.entries(browser)) {
        expect(server[key], `${group}.${key}`).toBe(value);
      }
    });
  }

  it('agrees on the workspace root', () => {
    expect(serverLimits.WORKSPACE_ROOT).toBe(browserLimits.WORKSPACE_ROOT);
  });
});

describe('tool registry', () => {
  it('maps every model-facing tool to something that exists server-side', () => {
    for (const [modelName, endpoint] of Object.entries(TOOL_NAME_TO_ENDPOINT)) {
      const registry = TOOLS as Record<string, unknown>;
      expect(registry[endpoint], `${modelName} -> ${endpoint}`).toBeTypeOf('function');
    }
  });

  it('declares every advertised tool as either remote or local', () => {
    for (const tool of AGENT_TOOLS) {
      const known = tool.name in TOOL_NAME_TO_ENDPOINT || LOCAL_TOOLS.has(tool.name);
      expect(known, `${tool.name} is advertised to the model but has no implementation`).toBe(true);
    }
  });

  it('advertises every mapped tool to the model', () => {
    const advertised = new Set(AGENT_TOOLS.map((t) => t.name));
    for (const name of Object.keys(TOOL_NAME_TO_ENDPOINT)) {
      expect(advertised.has(name), `${name} is implemented but never offered to the model`).toBe(true);
    }
  });

  it('classifies the project-mutating tools, which drive the pull back into OPFS', () => {
    // Missing one here means the agent's changes are never mirrored locally and are lost
    // with the sandbox.
    for (const name of ['fs_write', 'fs_patch', 'fs_move', 'fs_delete', 'shell_run', 'pkg_install']) {
      expect(MUTATING_TOOLS.has(name), name).toBe(true);
    }
    expect(MUTATING_TOOLS.has('fs_read')).toBe(false);
    expect(MUTATING_TOOLS.has('fs_tree')).toBe(false);
  });

  it('gives every tool a description and a valid JSON Schema object', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(tool.parameters).toMatchObject({ type: 'object' });
      expect(tool.parameters).toHaveProperty('properties');
      // Providers reject dots in a function name, which is why the mapping exists.
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('keeps every required parameter declared in properties', () => {
    for (const tool of AGENT_TOOLS) {
      const params = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
      for (const required of params.required ?? []) {
        expect(params.properties, `${tool.name}.${required}`).toHaveProperty(required);
      }
    }
  });
});

describe('secret patterns cover both implementations', () => {
  it('flags the same credential filenames', async () => {
    const { isSecretPath } = await import('../core/paths');
    const { isSecretPath: serverIsSecret } = await import('../../../api/_lib/validate.js');

    for (const path of ['.env', '.env.local', 'x/id_rsa', 'a/b/cert.pem', 'credentials.json', '.npmrc']) {
      expect(isSecretPath(path), `browser: ${path}`).toBe(true);
      expect(serverIsSecret(path), `server: ${path}`).toBe(true);
    }
    for (const path of ['.env.example', 'app/page.tsx', 'README.md']) {
      expect(isSecretPath(path), `browser: ${path}`).toBe(false);
      expect(serverIsSecret(path), `server: ${path}`).toBe(false);
    }
  });
});
