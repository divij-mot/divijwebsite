/**
 * Tool schemas shown to the model.
 *
 * Descriptions are written for the model, not for a human reading docs: they say when to
 * reach for a tool and what mistake to avoid, because that is what changes behaviour.
 * Parameter schemas stay small — every property costs context on every turn.
 *
 * The names match the keys in api/_lib/tools.js. `src/builder/__tests__/tools.test.ts`
 * fails if the two sets diverge.
 */

import type { ToolSchema } from './providers/types';

const str = (description: string) => ({ type: 'string', description });
const bool = (description: string) => ({ type: 'boolean', description });

export const AGENT_TOOLS: ToolSchema[] = [
  {
    name: 'fs_tree',
    description:
      'List every source file in the project. Call this first on an unfamiliar project. Dependencies and build output are already excluded.',
    parameters: {
      type: 'object',
      properties: { max_depth: { type: 'integer', description: 'Default 12.' } },
      required: [],
    },
  },
  {
    name: 'fs_read',
    description:
      'Read up to 20 files at once. Always read a file before editing it — editing from memory is the most common cause of a failed patch.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Project-relative paths.' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'fs_search',
    description:
      'Search file contents (ripgrep). Use this to find where something is defined or used instead of reading files speculatively.',
    parameters: {
      type: 'object',
      properties: {
        query: str('Literal text, or a regex when regex is true.'),
        regex: bool('Treat the query as a regular expression.'),
        glob: str('Restrict to matching paths, for example "**/*.tsx".'),
      },
      required: ['query'],
    },
  },
  {
    name: 'fs_write',
    description:
      'Create files or replace them entirely. For an existing file prefer fs_patch: a full rewrite discards code you did not intend to touch. Never write a secret value into a file.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Files to write.',
          items: {
            type: 'object',
            properties: { path: str('Project-relative path.'), content: str('Full file content.') },
            required: ['path', 'content'],
          },
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'fs_patch',
    description:
      'Replace exact snippets inside one file. `old` must match the file byte for byte, including indentation, and must be unique unless replace_all is set. This is the preferred way to edit.',
    parameters: {
      type: 'object',
      properties: {
        path: str('Project-relative path.'),
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old: str('Exact text to find, with enough surrounding lines to be unique.'),
              new: str('Replacement text.'),
              replace_all: bool('Replace every occurrence instead of requiring uniqueness.'),
            },
            required: ['old', 'new'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'fs_move',
    description: 'Rename or move one file.',
    parameters: {
      type: 'object',
      properties: { from: str('Current path.'), to: str('New path.') },
      required: ['from', 'to'],
    },
  },
  {
    name: 'fs_delete',
    description:
      'Delete files. Deleting more than five files, or anything at the project root, pauses for the user to confirm before it happens.',
    parameters: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'],
    },
  },
  {
    name: 'shell_run',
    description:
      'Run a shell command in the project directory as an unprivileged user. Use it for scaffolding and one-off scripts. Do not start the dev server with it — use dev_start, which manages the process and the preview.',
    parameters: {
      type: 'object',
      properties: {
        command: str('The command line to run.'),
        cwd: str('Project-relative working directory. Defaults to the project root.'),
        timeout_ms: { type: 'integer', description: 'Default 120000, maximum 300000.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'pkg_install',
    description:
      'Install npm packages by name. Only registry names work; URLs and git references are refused. Omit `packages` to install what package.json already lists.',
    parameters: {
      type: 'object',
      properties: {
        packages: { type: 'array', items: { type: 'string' }, description: 'Package names, optionally with a version.' },
        manager: { type: 'string', enum: ['npm', 'pnpm', 'yarn', 'bun'] },
      },
      required: [],
    },
  },
  {
    name: 'dev_start',
    description:
      'Start or restart the dev server and wait for it to answer. Bind 0.0.0.0:3000 so the public preview URL works for other phones, not just the iframe. Call this after installing dependencies and after any change to config that the dev server reads at boot.',
    parameters: {
      type: 'object',
      properties: {
        command: str('Defaults to the project\'s dev script bound to 0.0.0.0:3000.'),
      },
      required: [],
    },
  },
  {
    name: 'dev_logs',
    description: 'Read new dev server output. Use this when a page renders wrong to see the server-side error behind it.',
    parameters: {
      type: 'object',
      properties: {
        process_id: str('From dev_start.'),
        stdout_offset: { type: 'integer' },
        stderr_offset: { type: 'integer' },
      },
      required: ['process_id'],
    },
  },
  {
    name: 'browser_action',
    description:
      'Drive a real Chromium against the running app to verify it works. `snapshot` returns the page structure with [ref] handles; pass a ref to click or fill rather than inventing a CSS selector. Always snapshot before acting on a page you have not seen.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'navigate', 'snapshot', 'screenshot', 'click', 'fill', 'press',
            'resize', 'wait_for', 'console_logs', 'network_failures', 'inspect', 'reset',
          ],
        },
        url: str('For navigate. Only the local app is reachable. Defaults to /.'),
        ref: str('Element handle from a snapshot, such as "e12".'),
        selector: str('CSS selector, when no ref is available.'),
        text: str('Visible text to match, or to wait for.'),
        value: str('For fill.'),
        key: str('For press, such as "Enter".'),
        width: { type: 'integer' },
        height: { type: 'integer' },
        full_page: bool('For screenshot.'),
      },
      required: ['action'],
    },
  },
  {
    name: 'verify_build',
    description:
      'Run the typecheck and the production build. A turn is not finished until this passes. Reports the first failing step with its output.',
    parameters: {
      type: 'object',
      properties: {
        build: str('Build command. Defaults to the project\'s build script.'),
        typecheck: str('Typecheck command, or empty string to skip.'),
      },
      required: [],
    },
  },
  {
    name: 'request_network_access',
    description:
      'Ask the user to allow the sandbox to reach a hostname. Needed only when the app must call an external API; the npm registry is already allowed. The user must approve, and you cannot approve on their behalf.',
    parameters: {
      type: 'object',
      properties: {
        hostname: str('Bare hostname, such as api.example.com.'),
        reason: str('One sentence the user will read explaining why it is needed.'),
      },
      required: ['hostname', 'reason'],
    },
  },
  {
    name: 'set_tasks',
    description:
      'Publish the checklist you are working through, so the user can follow along. Call once when you plan, then again as statuses change.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: str('Short imperative description.'),
              status: { type: 'string', enum: ['pending', 'active', 'done', 'failed'] },
            },
            required: ['title', 'status'],
          },
        },
      },
      required: ['tasks'],
    },
  },
];

/**
 * Model-facing tool names use underscores because some providers reject dots in a function
 * name; the control plane uses dotted names. This is the only place the two meet.
 */
export const TOOL_NAME_TO_ENDPOINT: Record<string, string> = {
  fs_tree: 'fs.tree',
  fs_read: 'fs.read',
  fs_search: 'fs.search',
  fs_write: 'fs.write',
  fs_patch: 'fs.patch',
  fs_move: 'fs.move',
  fs_delete: 'fs.delete',
  shell_run: 'shell.run',
  pkg_install: 'pkg.install',
  dev_start: 'dev.start',
  dev_logs: 'dev.logs',
  browser_action: 'browser',
  verify_build: 'verify.build',
};

/** Handled inside the worker rather than forwarded to the sandbox. */
export const LOCAL_TOOLS = new Set(['set_tasks', 'request_network_access']);

/** Tools that change the project, and therefore should trigger a pull back into OPFS. */
export const MUTATING_TOOLS = new Set([
  'fs_write', 'fs_patch', 'fs_move', 'fs_delete', 'shell_run', 'pkg_install',
]);
