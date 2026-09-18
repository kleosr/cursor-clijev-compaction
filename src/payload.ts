import type { CapturedTool } from './types.js';

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function conversationIdOf(payload: Record<string, unknown>): string {
  return (
    asString(payload.conversation_id) ??
    asString(payload.conversationId) ??
    asString(payload.chat_id) ??
    '_unknown'
  );
}

export function eventNameOf(payload: Record<string, unknown>, argvEvent: string): string {
  return asString(payload.hook_event_name) ?? asString(payload.hookEventName) ?? argvEvent;
}

export function transcriptPathOf(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    asString(payload.transcript_path) ??
    asString(payload.transcriptPath) ??
    asString(env.CURSOR_TRANSCRIPT_PATH)
  );
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const rec = asRecord(item);
        if (rec && rec.type === 'text') return asString(rec.text) ?? '';
        return stringifyOutput(item);
      })
      .filter((part) => part.length > 0)
      .join('\n');
  }
  const rec = asRecord(value);
  if (rec) {
    if ('content' in rec) return stringifyOutput(rec.content);
    if (typeof rec.text === 'string') return rec.text;
    try {
      return JSON.stringify(rec);
    } catch {
      return '[unserializable output]';
    }
  }
  return String(value);
}

function asInput(value: unknown): Record<string, unknown> {
  const rec = asRecord(value);
  if (rec) return rec;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return asRecord(parsed) ?? { raw: value };
    } catch {
      return { raw: value };
    }
  }
  return {};
}

export function capturedToolFrom(payload: Record<string, unknown>, isError: boolean): CapturedTool | undefined {
  const tool =
    asString(payload.tool_name) ??
    asString(payload.toolName) ??
    asString(payload.tool) ??
    asString(payload.name);
  if (!tool) return undefined;
  const input = asInput(
    payload.tool_input ?? payload.toolInput ?? payload.input ?? payload.arguments,
  );
  const output = stringifyOutput(
    payload.tool_output ??
      payload.toolOutput ??
      payload.result ??
      payload.output ??
      payload.error_message ??
      payload.error ??
      payload.message,
  );
  const id =
    asString(payload.tool_use_id) ??
    asString(payload.toolUseId) ??
    asString(payload.id) ??
    `cap-${tool}-${asString(payload.at) ?? Date.now().toString()}`;
  return {
    id,
    tool,
    input,
    output,
    isError,
    at: new Date().toISOString(),
  };
}

export function stopStatusOf(payload: Record<string, unknown>): string {
  return asString(payload.status) ?? '';
}

export function triggerOf(payload: Record<string, unknown>): string | undefined {
  return asString(payload.trigger) ?? asString(payload.compact_trigger);
}
