import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentArgs, NO_INSTALL, runCli } from '../src/cli.js';
import { resolveAgentBin } from '../src/agent.js';
import { packageRoot } from '../src/paths.js';

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('cursor-jev wrapper', () => {
  it('puts this repo on --plugin-dir and leaves user args intact', () => {
    const root = packageRoot();
    expect(buildAgentArgs(['--', '-p', 'hello'], root)).toEqual([
      '--plugin-dir',
      root,
      '-p',
      'hello',
    ]);
    expect(buildAgentArgs(['--plugin-dir', root, '--resume', 'abc'], root)).toEqual([
      '--plugin-dir',
      root,
      '--resume',
      'abc',
    ]);
  });

  it('refuses install/uninstall and does not write ~/.cursor/hooks.json', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cursor-home-'));
    temps.push(home);
    const fakeCursor = path.join(home, '.cursor');
    const logs: string[] = [];
    const code = await runCli(['install'], {
      stdout: (text) => logs.push(text),
      stderr: (text) => logs.push(text),
      env: { HOME: home, USERPROFILE: home },
    });
    expect(code).toBe(2);
    expect(logs.join('')).toContain(NO_INSTALL);
    expect(existsSync(path.join(fakeCursor, 'hooks.json'))).toBe(false);
    expect(existsSync(fakeCursor)).toBe(false);
  });

  it('agent command execs with --plugin-dir and never creates user hooks', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cursor-home-'));
    temps.push(home);
    let spawned: { bin: string; args: string[]; env?: NodeJS.ProcessEnv } | undefined;
    const code = await runCli(['agent', '--', '-p', 'hi'], {
      stdout: () => undefined,
      stderr: () => undefined,
      env: {
        HOME: home,
        USERPROFILE: home,
        CURSOR_AGENT_BIN: 'agent',
        TYPESAFE_API_KEY: 'sk-test-typesafe',
      },
      spawnAgent: async (bin, args, spawnedEnv) => {
        spawned = { bin, args, env: spawnedEnv };
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(spawned?.bin).toBe('agent');
    expect(spawned?.args[0]).toBe('--plugin-dir');
    expect(spawned?.args[1]).toBe(packageRoot());
    expect(spawned?.args.slice(2)).toEqual(['-p', 'hi']);
    expect(spawned?.env?.TYPESAFE_API_KEY).toBe('sk-test-typesafe');
    expect(JSON.stringify(spawned?.args)).not.toContain('sk-test-typesafe');
    expect(existsSync(path.join(home, '.cursor', 'hooks.json'))).toBe(false);
  });

  it('doctor never writes user hooks and reports TypeSafe as the scorer', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cursor-home-'));
    temps.push(home);
    const logs: string[] = [];
    const code = await runCli(['doctor'], {
      stdout: (text) => logs.push(text),
      stderr: (text) => logs.push(text),
      env: { HOME: home, USERPROFILE: home, LOCALAPPDATA: process.env.LOCALAPPDATA },
    });
    expect(code).toBe(0);
    expect(logs.join('')).toMatch(/api\.typesafe\.ai\/v1\/systemone/);
    expect(logs.join('')).toMatch(/jev-latest/);
    expect(logs.join('')).toMatch(/never writes/);
    expect(existsSync(path.join(home, '.cursor', 'hooks.json'))).toBe(false);
  });

  it('resolves the Cursor CLI agent binary without a fake PATH entry', () => {
    const found = resolveAgentBin({
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
    });
    expect(found.length).toBeGreaterThan(0);
  });
});

describe('plugin load path', () => {
  it('hooks.json commands are rooted at CURSOR_PLUGIN_ROOT, not ~/.cursor', async () => {
    const hooks = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'hooks.json'),
      'utf8',
    );
    expect(hooks).toContain('${CURSOR_PLUGIN_ROOT}/hooks/run.mjs');
    expect(hooks).toContain('"failClosed": false');
    expect(hooks).toContain('"loop_limit": 1');
    expect(hooks).not.toContain('~/.cursor/hooks.json');
    expect(hooks).not.toContain('.cursor/hooks.json');
  });
});
