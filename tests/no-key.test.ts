import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { handleHook } from '../src/hook.js';
import { packageRoot } from '../src/paths.js';

const root = packageRoot();
const withResult = path.join(root, 'tests', 'fixtures', 'cursor-with-result.jsonl');
const noResult = path.join(root, 'tests', 'fixtures', 'cursor-no-result.jsonl');
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function envWithoutKey(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...extra };
  delete env.TYPESAFE_API_KEY;
  return env;
}

function runNode(script: string, args: string[], input: string, env: NodeJS.ProcessEnv): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, ...env, TYPESAFE_API_KEY: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on('exit', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

describe('no TypeSafe key', () => {
  it('help and capture work; compact of scored history fails closed', async () => {
    const logs: string[] = [];
    const help = await runCli(['help'], {
      stdout: (text) => logs.push(text),
      stderr: (text) => logs.push(text),
      env: envWithoutKey(),
    });
    expect(help).toBe(0);
    expect(logs.join('')).toContain('cursor-jev agent');

    const compactCode = await runCli(['compact', withResult], {
      stdout: (text) => logs.push(text),
      stderr: (text) => logs.push(text),
      env: envWithoutKey(),
    });
    expect(compactCode).toBe(1);
    expect(logs.join('')).toMatch(/TYPESAFE_API_KEY is not configured/);
  });

  it('preCompact fail-opens when the real Jev client has no key', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cursor-jev-nokey-'));
    temps.push(dir);
    const env = envWithoutKey({ CURSOR_JEV_HOME: dir });
    await handleHook(
      'postToolUse',
      {
        conversation_id: 'nokey',
        tool_name: 'Read',
        tool_use_id: 'call_read',
        tool_input: { path: 'tests/flaky.test.ts' },
        tool_output: 'file body',
      },
      { env },
    );
    const out = await handleHook(
      'preCompact',
      { conversation_id: 'nokey', transcript_path: noResult },
      { env, compact: { preserveRecentMessages: 1 } },
    );
    expect(out.user_message).toMatch(/skipped TypeSafe scoring/);
  });

  it('built hook.js prints JSON and exits 0 with no key', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cursor-jev-hook-'));
    temps.push(dir);
    const hook = path.join(root, 'dist', 'hook.js');
    const capture = await runNode(
      hook,
      ['postToolUse'],
      JSON.stringify({
        conversation_id: 'bin',
        tool_name: 'Read',
        tool_use_id: 'call_read',
        tool_input: { path: 'a.ts' },
        tool_output: 'export const n = 1',
      }),
      { CURSOR_JEV_HOME: dir },
    );
    expect(capture.code).toBe(0);
    expect(JSON.parse(capture.stdout)).toEqual({});

    const scored = await runNode(
      hook,
      ['preCompact'],
      JSON.stringify({ conversation_id: 'bin', transcript_path: noResult }),
      { CURSOR_JEV_HOME: dir },
    );
    expect(scored.code).toBe(0);
    const body = JSON.parse(scored.stdout) as { user_message?: string };
    expect(typeof body.user_message === 'string' || Object.keys(body).length === 0).toBe(true);
    expect(scored.stderr).not.toMatch(/TYPESAFE_API_KEY is not configured/);
  });
});
