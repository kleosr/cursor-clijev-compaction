#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAgentBin } from './agent.js';
import { compact, reductionRatio } from './compact.js';
import { DEFAULT_MODEL, JevClient, SYSTEM_ONE_URL } from './jev.js';
import { packageRoot } from './paths.js';
import { parseTranscript } from './transcript.js';

export const NO_INSTALL =
  'cursor-jev does not install or merge hooks. It never writes ~/.cursor/hooks.json. Load it with: cursor-jev agent -- …  or  agent --plugin-dir <this-repo>';

export function stripLeadingDashDash(args: string[]): string[] {
  return args[0] === '--' ? args.slice(1) : args;
}

export function buildAgentArgs(userArgs: string[], pluginDir: string): string[] {
  const args = stripLeadingDashDash(userArgs);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--plugin-dir' && args[i + 1] === pluginDir) return args;
  }
  return ['--plugin-dir', pluginDir, ...args];
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  spawnAgent?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  readFile?: (file: string) => Promise<string>;
}

const defaultIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

function spawnAgent(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const winCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const child: ChildProcess = winCmd
      ? spawn('cmd.exe', ['/d', '/s', '/c', bin, ...args], { env, stdio: 'inherit' })
      : spawn(bin, args, { env, stdio: 'inherit' });
    child.on('error', (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 1);
    });
  });
}

function printHelp(io: CliIo): void {
  io.stdout(`cursor-jev — TypeSafe Jev recovery for Cursor CLI (agent) only

Usage:
  cursor-jev agent [--] [agent-args...]
  cursor-jev compact <transcript.jsonl>
  cursor-jev doctor
  cursor-jev help

Scoring always uses TypeSafe Jev (jev-latest) at POST ${SYSTEM_ONE_URL}.
Same TYPESAFE_API_KEY as TypeSafe / the Claude plugin; this wrapper is Cursor CLI only.
\`cursor-jev agent\` forwards that key into \`agent --plugin-dir <this-repo>\`.
It does not write ~/.cursor/hooks.json.

Environment:
  TYPESAFE_API_KEY        TypeSafe System One key (required to score)
  TYPESAFE_BASE_URL       Default https://api.typesafe.ai
  TYPESAFE_DEFAULT_MODEL  Default jev-latest
  CURSOR_JEV_HOME         Store directory (default: <this-repo>/.data)
  CURSOR_AGENT_BIN        agent binary override
`);
}

export function agentChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...process.env, ...env };
  const key = (env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_API_KEY)?.trim();
  if (key) child.TYPESAFE_API_KEY = key;
  const base = (env.TYPESAFE_BASE_URL ?? process.env.TYPESAFE_BASE_URL)?.trim();
  if (base) child.TYPESAFE_BASE_URL = base;
  child.TYPESAFE_DEFAULT_MODEL =
    (env.TYPESAFE_DEFAULT_MODEL ?? process.env.TYPESAFE_DEFAULT_MODEL)?.trim() || DEFAULT_MODEL;
  return child;
}

function typesafeClient(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): JevClient {
  return new JevClient({
    apiKey: env.TYPESAFE_API_KEY ?? '',
    baseUrl: env.TYPESAFE_BASE_URL,
    model: env.TYPESAFE_DEFAULT_MODEL,
    fetch: fetchImpl,
  });
}

function runDoctor(io: CliIo, env: NodeJS.ProcessEnv): number {
  const root = packageRoot();
  const agent = resolveAgentBin(env);
  const hook = path.join(root, 'dist', 'hook.js');
  const key = Boolean(env.TYPESAFE_API_KEY?.trim());
  io.stdout(`cursor-jev doctor — Cursor CLI (agent) only
plugin:  ${root}
agent:   ${agent}
hook:    ${existsSync(hook) ? hook : 'missing (run pnpm build)'}
typesafe: ${SYSTEM_ONE_URL}  model=${env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_MODEL}
key:     ${key ? 'set — forwarded into Cursor CLI so hooks can score' : 'missing — CLI still runs; scoring skips until TYPESAFE_API_KEY is set'}
hooks.json: this tool never writes ~/.cursor/hooks.json
`);
  if (!existsSync(hook)) return 1;
  if (agent !== 'agent' && !existsSync(agent) && !env.CURSOR_AGENT_BIN) return 1;
  return 0;
}

async function runCompact(file: string, io: CliIo, env: NodeJS.ProcessEnv): Promise<number> {
  const read = io.readFile ?? ((path) => readFile(path, 'utf8'));
  const messages = parseTranscript(await read(file));
  const result = await compact(messages, typesafeClient(env));
  io.stdout(`${JSON.stringify({ ...result, reduction: reductionRatio(result) }, null, 2)}\n`);
  return 0;
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const env = io.env ?? process.env;
  const [command, ...rest] = argv;
  if (
    command === undefined ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    printHelp(io);
    return command === undefined ? 1 : 0;
  }
  if (command === 'install' || command === 'uninstall') {
    io.stderr(`${NO_INSTALL}\n`);
    return 2;
  }
  if (command === 'doctor') {
    return runDoctor(io, env);
  }
  if (command === 'agent') {
    const pluginDir = packageRoot();
    const args = buildAgentArgs(rest, pluginDir);
    const bin = resolveAgentBin(env);
    const run = io.spawnAgent ?? spawnAgent;
    return run(bin, args, agentChildEnv(env));
  }
  if (command === 'compact') {
    const file = rest[0];
    if (!file) {
      io.stderr('usage: cursor-jev compact <transcript.jsonl>\n');
      return 1;
    }
    try {
      return await runCompact(file, io, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr(`${message}\n`);
      return 1;
    }
  }
  io.stderr(`unknown command: ${command}\n${NO_INSTALL}\n`);
  return 1;
}

export async function cliMain(argv = process.argv.slice(2)): Promise<void> {
  const code = await runCli(argv);
  if (code !== 0) process.exitCode = code;
}

const entry = process.argv[1]?.replace(/\\/g, '/');
if (entry && (entry.endsWith('/cli.js') || entry.endsWith('/cli.ts'))) {
  void cliMain().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
