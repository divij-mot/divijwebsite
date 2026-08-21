#!/usr/bin/env npx tsx
/**
 * The full agent loop, headless, against a real model and a real sandbox.
 *
 * This is the "does it actually behave like Lovable" test. It gives the agent a plain
 * English request and checks that it inspects the project, edits files, runs the dev
 * server, verifies in a browser, and produces something that builds — using the real
 * provider adapter, the real system prompt, the real tool schemas, and the real tool
 * implementations. Only the worker's postMessage plumbing and the React UI are absent,
 * and those are covered by the browser smoke test.
 *
 *   npx tsx scripts/e2e-agent.ts
 *   npx tsx scripts/e2e-agent.ts --prompt "add a dark mode toggle" --model deepseek-v4-flash
 *   npx tsx scripts/e2e-agent.ts --keep
 *
 * Reads DEEPSEEK_API_KEY (or BUILDER_TEST_MODEL_KEY) from .env.local or .env.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i === -1) continue;
        const k = t.slice(0, i).trim();
        const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        if (v && !process.env[k]) process.env[k] = v;
      }
    } catch {
      /* optional */
    }
  }
}
loadEnv();

const arg = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const MODEL = arg('--model', 'deepseek-v4-pro');
const PROMPT = arg(
  '--prompt',
  'Build a simple todo list on the home page. I should be able to type a task, ' +
    'press Add, see it appear in a list, and click it to mark it done with a line through it. ' +
    'Keep it to one file and make it look clean.',
);
const KEEP = process.argv.includes('--keep');

const API_KEY = process.env.BUILDER_TEST_MODEL_KEY || process.env.DEEPSEEK_API_KEY || '';
if (!API_KEY) {
  console.error('No model key. Set DEEPSEEK_API_KEY in .env.local or .env.');
  process.exit(1);
}

// The control plane reads Mosaic credentials from the environment.
const { resolveMosaicAuth } = await import('./lib/mosaic-auth.mjs');
const auth = resolveMosaicAuth();
process.env.MOSAIC_API_KEY = auth.token;
process.env.MOSAIC_API_URL = auth.endpoint;
process.env.MOSAIC_ENVIRONMENT ||= 'divij-builder-runtime';

// Real implementations, not reimplementations.
const mosaic = await import('../api/_lib/mosaic.js');
const { TOOLS, createContext } = await import('../api/_lib/tools.js');
const { initializeGuest } = await import('../api/_lib/workspace.js');
const { createChatCompletionsAdapter } = await import('../src/builder/agent/providers/chatCompletions');
const { getPreset } = await import('../src/builder/agent/presets');
const { buildSystemPrompt } = await import('../src/builder/agent/prompt');
const { AGENT_TOOLS, MUTATING_TOOLS, TOOL_NAME_TO_ENDPOINT } = await import('../src/builder/agent/tools');
const { AGENT_LIMITS } = await import('../src/builder/core/limits');
const { createNextScaffold } = await import('../src/builder/transfer/scaffold');
import type { ToolCallRequest, TurnMessage } from '../src/builder/agent/providers/types';

const results: { name: string; ok: boolean; detail?: string }[] = [];
const record = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

let sandboxId: string | null = null;
const toolLog: { name: string; ok: boolean; ms: number }[] = [];

async function runTool(name: string, args: Record<string, unknown>) {
  const endpoint = TOOL_NAME_TO_ENDPOINT[name];
  if (!endpoint) return { error: `unknown tool ${name}` };
  const ctx = createContext(sandboxId!, new AbortController().signal);
  const started = Date.now();
  let result: unknown;
  let error: string | undefined;
  try {
    for await (const event of (TOOLS as Record<string, (c: unknown, a: unknown) => AsyncGenerator<Record<string, unknown>>>)[endpoint](ctx, args)) {
      if (event.kind === 'result') result = event.data;
      if (event.kind === 'error') error = String(event.error);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  toolLog.push({ name, ok: !error, ms: Date.now() - started });
  return error ? { error } : (result as Record<string, unknown>);
}

try {
  console.log(`\nModel: ${MODEL} (DeepSeek, called directly)\nPrompt: "${PROMPT.slice(0, 90)}..."\n`);

  console.log('\u25B6 Sandbox');
  const sandbox = await mosaic.createSandbox({ labels: { builder_agent_e2e: '1' }, ttlSeconds: 2400 });
  sandboxId = sandbox.id;
  const runtime = await initializeGuest(sandboxId);
  record('sandbox ready with containment', runtime.containment === 'enforced', `runtime ${runtime.version}`);

  console.log('\n\u25B6 Scaffold and hydrate');
  const scaffold = createNextScaffold({ name: 'agent-e2e', withDatabase: false });
  const files = Object.entries(scaffold.files).map(([path, content]) => ({
    path,
    content_base64: Buffer.from(content, 'utf8').toString('base64'),
  }));
  const sync = await runTool('fs_write', { files: [] }); // warm the path
  void sync;
  const ctx = createContext(sandboxId, new AbortController().signal);
  for await (const _ of TOOLS['fs.sync'](ctx, { files })) void _;
  record('project hydrated', true, `${files.length} files`);

  const install = await runTool('pkg_install', {});
  record('dependencies installed', (install as { exit_code?: number }).exit_code === 0);

  console.log('\n\u25B6 Agent turn');
  const adapter = createChatCompletionsAdapter(getPreset('deepseek'));
  const conversation: TurnMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        manifest: scaffold.manifest,
        capabilities: { streaming: true, functionCalling: true, vision: false },
        fileCount: files.length,
        projectContext: '',
        isNewProject: true,
      }),
    },
    { role: 'user', content: PROMPT },
  ];

  let assistantText = '';
  let steps = 0;
  let mutated = false;
  let sawVerify = false;
  let sawBrowser = false;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 12 * 60_000);

  for (let step = 0; step < AGENT_LIMITS.maxToolStepsPerTurn; step += 1) {
    steps = step + 1;
    const calls: ToolCallRequest[] = [];
    let stepText = '';
    let failed: string | null = null;

    for await (const event of adapter.stream({
      model: MODEL,
      messages: conversation,
      tools: AGENT_TOOLS,
      apiKey: API_KEY,
      signal: controller.signal,
    })) {
      if (event.type === 'text-delta') stepText += event.text;
      else if (event.type === 'tool-call') calls.push(event.call);
      else if (event.type === 'error') failed = event.message;
    }

    if (failed) {
      record('provider stream', false, failed);
      break;
    }
    assistantText += stepText;

    if (!calls.length) {
      console.log(`  step ${steps}: finished (no more tools)`);
      break;
    }

    conversation.push({ role: 'assistant', content: stepText, toolCalls: calls });

    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
      } catch {
        conversation.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: 'Tool arguments were not valid JSON. Send a smaller, well-formed call.',
        });
        continue;
      }

      if (call.name === 'set_tasks') {
        const tasks = (args.tasks as { title: string; status: string }[]) ?? [];
        console.log(`  step ${steps}: plan -> ${tasks.map((t) => t.title).join(' | ').slice(0, 120)}`);
        conversation.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'Plan recorded.' });
        continue;
      }
      if (call.name === 'request_network_access') {
        conversation.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: 'Declined in this automated run. Build it without that host.',
        });
        continue;
      }

      const summary = `${call.name}(${JSON.stringify(args).slice(0, 80)})`;
      const out = await runTool(call.name, args);
      const errored = Boolean((out as { error?: string }).error);
      console.log(`  step ${steps}: ${errored ? 'x' : 'ok'} ${summary}`);

      mutated ||= MUTATING_TOOLS.has(call.name);
      if (call.name === 'verify_build') sawVerify = true;
      if (call.name === 'browser_action') sawBrowser = true;

      conversation.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(out).slice(0, AGENT_LIMITS.maxToolOutputBytes),
      });
    }
  }
  clearTimeout(deadline);

  console.log('\n\u25B6 What the agent did');
  console.log(`  ${steps} model turns, ${toolLog.length} tool calls`);
  const byTool = toolLog.reduce<Record<string, number>>((acc, t) => {
    acc[t.name] = (acc[t.name] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  ${Object.entries(byTool).map(([k, v]) => `${k}x${v}`).join(', ')}`);

  record('agent used tools rather than only talking', toolLog.length > 0, `${toolLog.length} calls`);
  record('agent edited the project', mutated);
  record('agent inspected before editing', toolLog.some((t) => t.name === 'fs_read' || t.name === 'fs_tree'));
  record('agent verified with a build', sawVerify);
  record('agent checked the result in a browser', sawBrowser);
  record('agent produced a written summary', assistantText.trim().length > 40, `${assistantText.trim().length} chars`);

  console.log('\n\u25B6 Independent verification of the result');
  const build = await runTool('verify_build', { typecheck: 'npx tsc --noEmit', build: 'npx next build' });
  record(
    'project builds cleanly at the end',
    (build as { ok?: boolean }).ok === true,
    (build as { ok?: boolean }).ok ? '' : JSON.stringify((build as { steps?: unknown }).steps).slice(0, 300),
  );

  const dev = await runTool('dev_start', { command: 'npx next dev -H 0.0.0.0 -p 3000' });
  record('dev server runs the result', (dev as { ready?: boolean }).ready === true);

  const nav = await runTool('browser_action', { action: 'navigate', url: 'http://127.0.0.1:3000/' });
  record('page loads', (nav as { status?: number }).status === 200);

  const snap = (await runTool('browser_action', { action: 'snapshot' })) as { snapshot?: string };
  const page = snap.snapshot ?? '';
  record('page has an input and a button', /textbox|type=text/i.test(page) && /button/i.test(page));

  // Actually use the feature the prompt asked for.
  const inputRef = /\[(e\d+)\][^\n]*type=text/.exec(page)?.[1];
  const buttonRef = /\[(e\d+)\] button/.exec(page)?.[1];
  if (inputRef && buttonRef) {
    await runTool('browser_action', { action: 'fill', ref: inputRef, value: 'buy milk' });
    await runTool('browser_action', { action: 'click', ref: buttonRef });
    const after = (await runTool('browser_action', { action: 'snapshot' })) as { snapshot?: string };
    record('adding a todo actually works', (after.snapshot ?? '').includes('buy milk'));
  } else {
    record('adding a todo actually works', false, 'could not find an input and button to drive');
  }

  const logs = (await runTool('browser_action', { action: 'console_logs' })) as {
    console?: { type: string; text: string }[];
  };
  const errors = (logs.console ?? []).filter((c) => c.type === 'error');
  record('no console errors', errors.length === 0, errors.map((e) => e.text).join(' | ').slice(0, 200));

  console.log('\n\u25B6 Agent summary\n');
  console.log(assistantText.trim().split('\n').map((l) => `  ${l}`).join('\n').slice(0, 1500));
} catch (err) {
  record('unexpected failure', false, err instanceof Error ? err.message : String(err));
} finally {
  if (sandboxId && !KEEP) {
    await mosaic.destroySandbox(sandboxId).catch(() => {});
    console.log(`\nDestroyed ${sandboxId}`);
  } else if (sandboxId) {
    console.log(`\nKept ${sandboxId}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
