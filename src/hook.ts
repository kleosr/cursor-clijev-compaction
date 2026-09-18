import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compact, reductionRatio } from './compact.js';
import { buildInject } from './inject.js';
import { DEFAULT_MODEL, JevClient } from './jev.js';
import { sidecarPath } from './paths.js';
import {
  capturedToolFrom,
  conversationIdOf,
  eventNameOf,
  stopStatusOf,
  transcriptPathOf,
  triggerOf,
} from './payload.js';
import { loadCapturedTools, mergeCapturedTools, messagesFromCaptured, writeCapturedTool } from './store.js';
import { parseTranscript } from './transcript.js';
import type { CompactOptions, Message, Sidecar } from './types.js';

export interface HookOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  compact?: CompactOptions;
  readTranscript?: (file: string) => Promise<string>;
}

const EMPTY: Record<string, never> = {};

/** TypeSafe env Cursor CLI should keep on the session so later hooks can score. Never log these values. */
export function typesafeSessionEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const key = env.TYPESAFE_API_KEY?.trim();
  if (!key) return undefined;
  const session: Record<string, string> = {
    TYPESAFE_API_KEY: key,
    TYPESAFE_DEFAULT_MODEL: env.TYPESAFE_DEFAULT_MODEL?.trim() || DEFAULT_MODEL,
  };
  const base = env.TYPESAFE_BASE_URL?.trim();
  if (base) session.TYPESAFE_BASE_URL = base;
  const home = env.CURSOR_JEV_HOME?.trim();
  if (home) session.CURSOR_JEV_HOME = home;
  return session;
}

async function loadMessages(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  readTranscript: (file: string) => Promise<string>,
): Promise<Message[]> {
  const id = conversationIdOf(payload);
  const captured = await loadCapturedTools(id, env);
  const file = transcriptPathOf(payload, env);
  let parsed: Message[] = [];
  if (file) {
    try {
      parsed = parseTranscript(await readTranscript(file));
    } catch {
      parsed = [];
    }
  }
  const merged = mergeCapturedTools(parsed, captured);
  return merged.length > 0 ? merged : messagesFromCaptured(captured);
}

async function writeSidecar(sidecar: Sidecar, env: NodeJS.ProcessEnv): Promise<void> {
  const file = sidecarPath(sidecar.conversation_id, env);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
}

async function readSidecar(
  conversationId: string,
  env: NodeJS.ProcessEnv,
): Promise<Sidecar | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sidecarPath(conversationId, env), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const rec = parsed as Sidecar;
    if (typeof rec.inject !== 'string' || typeof rec.consumed !== 'boolean') return undefined;
    return rec;
  } catch {
    return undefined;
  }
}

function statsLine(sidecar: Sidecar): string {
  const { stats } = sidecar;
  return `cursor-jev: scored ${stats.calls} calls (keep ${stats.kept}, truncate ${stats.resultsDropped}, drop ${stats.callsDropped}, pinned ${stats.pinned}). Recovery queued for the next turn.`;
}

async function onCapture(
  payload: Record<string, unknown>,
  isError: boolean,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, never>> {
  const tool = capturedToolFrom(payload, isError);
  if (tool) await writeCapturedTool(conversationIdOf(payload), tool, env);
  return EMPTY;
}

async function onPreCompact(
  payload: Record<string, unknown>,
  options: HookOptions,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const messages = await loadMessages(payload, env, options.readTranscript ?? ((file) => readFile(file, 'utf8')));
  if (messages.length === 0) return EMPTY;
  const asker = new JevClient({
    apiKey: env.TYPESAFE_API_KEY ?? '',
    baseUrl: env.TYPESAFE_BASE_URL,
    model: env.TYPESAFE_DEFAULT_MODEL,
    fetch: options.fetch,
  });
  const result = await compact(messages, asker, options.compact);
  const inject = buildInject(messages, result);
  const sidecar: Sidecar = {
    conversation_id: conversationIdOf(payload),
    at: new Date().toISOString(),
    consumed: inject.trim().length === 0,
    trigger: triggerOf(payload),
    stats: result.stats,
    decisions: result.decisions,
    inject,
    reduction: reductionRatio(result),
  };
  await writeSidecar(sidecar, env);
  return { user_message: statsLine(sidecar) };
}

async function consumeInject(
  conversationId: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const sidecar = await readSidecar(conversationId, env);
  if (!sidecar || sidecar.consumed || sidecar.inject.trim().length === 0) return undefined;
  await writeSidecar({ ...sidecar, consumed: true }, env);
  return sidecar.inject;
}

async function onStop(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  if (stopStatusOf(payload) !== 'completed') return EMPTY;
  const inject = await consumeInject(conversationIdOf(payload), env);
  return inject ? { followup_message: inject } : EMPTY;
}

async function onSessionStart(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const sessionEnv = typesafeSessionEnv(env);
  if (sessionEnv) out.env = sessionEnv;
  const inject = await consumeInject(conversationIdOf(payload), env);
  if (inject) out.additional_context = inject;
  return Object.keys(out).length > 0 ? out : EMPTY;
}

export async function handleHook(
  argvEvent: string,
  payload: Record<string, unknown>,
  options: HookOptions = {},
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const event = eventNameOf(payload, argvEvent);
  try {
    switch (event) {
      case 'postToolUse':
        return await onCapture(payload, false, env);
      case 'postToolUseFailure':
        return await onCapture(payload, true, env);
      case 'preCompact':
        return await onPreCompact(payload, options, env);
      case 'stop':
        return await onStop(payload, env);
      case 'sessionStart':
        return await onSessionStart(payload, env);
      default:
        return EMPTY;
    }
  } catch {
    if (event === 'preCompact') {
      return {
        user_message:
          'cursor-jev: skipped TypeSafe scoring (key missing or Jev unavailable). Native compact continues.',
      };
    }
    return EMPTY;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function hookMain(argv = process.argv.slice(2)): Promise<void> {
  let payload: Record<string, unknown> = {};
  try {
    const raw = (await readStdin()).trim();
    if (raw.length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    }
  } catch {
    payload = {};
  }
  let output: Record<string, unknown> = EMPTY;
  try {
    output = await handleHook(argv[0] ?? '', payload);
  } catch {
    output = EMPTY;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

const entry = process.argv[1]?.replace(/\\/g, '/');
if (entry && (entry.endsWith('/hook.js') || entry.endsWith('/hook.ts'))) {
  void hookMain().catch(() => {
    process.stdout.write('{}\n');
  });
}
