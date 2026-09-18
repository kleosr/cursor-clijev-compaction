import type { Message, Role, ToolResult, ToolUse } from './types.js';
import { asRecord, asString } from './payload.js';

function roleOf(value: unknown): Role | undefined {
  return value === 'user' || value === 'assistant' ? value : undefined;
}

function textFrom(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    const rec = asRecord(content);
    if (rec && typeof rec.text === 'string') return rec.text;
    return '';
  }
  return content
    .map((block) => {
      const rec = asRecord(block);
      if (!rec) return typeof block === 'string' ? block : '';
      if (rec.type === 'text' || rec.type === 'input_text' || rec.type === 'output_text') {
        return asString(rec.text) ?? '';
      }
      return '';
    })
    .filter((part) => part.length > 0)
    .join('\n');
}

function inputOf(rec: Record<string, unknown>): Record<string, unknown> {
  const input = rec.input ?? rec.arguments ?? rec.args ?? rec.tool_input;
  const asObj = asRecord(input);
  if (asObj) return asObj;
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return asRecord(parsed) ?? { raw: input };
    } catch {
      return { raw: input };
    }
  }
  return {};
}

function resultText(rec: Record<string, unknown>): string {
  if (typeof rec.text === 'string') return rec.text;
  if (typeof rec.content === 'string') return rec.content;
  if (Array.isArray(rec.content)) return textFrom(rec.content);
  if (typeof rec.output === 'string') return rec.output;
  if (typeof rec.result === 'string') return rec.result;
  try {
    return JSON.stringify(rec.content ?? rec.output ?? rec.result ?? '');
  } catch {
    return '';
  }
}

function toolUsesFrom(content: unknown): ToolUse[] {
  const uses: ToolUse[] = [];
  const push = (rec: Record<string, unknown>, fallbackId: string): void => {
    const nested = asRecord(rec.toolCall) ?? asRecord(rec.tool_call) ?? rec;
    const type = asString(nested.type) ?? asString(rec.type);
    const isCall =
      type === 'tool_use' ||
      type === 'tool_call' ||
      type === 'tool-call' ||
      (asString(nested.name) !== undefined && (nested.input !== undefined || nested.arguments !== undefined));
    if (!isCall) return;
    const id =
      asString(nested.tool_use_id) ??
      asString(nested.toolUseId) ??
      asString(nested.toolCallId) ??
      asString(nested.id) ??
      asString(rec.id) ??
      fallbackId;
    const tool =
      asString(nested.tool) ??
      asString(nested.name) ??
      asString(rec.tool) ??
      asString(rec.name) ??
      'unknown';
    uses.push({ tool_use_id: id, tool, input: inputOf(nested) });
  };
  if (Array.isArray(content)) {
    content.forEach((block, index) => {
      const rec = asRecord(block);
      if (rec) push(rec, `jsonl-${index}`);
    });
    return uses;
  }
  const rec = asRecord(content);
  if (rec) push(rec, 'jsonl-0');
  return uses;
}

function toolResultsFrom(content: unknown): ToolResult[] {
  const results: ToolResult[] = [];
  const push = (rec: Record<string, unknown>): void => {
    const type = asString(rec.type);
    if (type && type !== 'tool_result' && type !== 'tool-result') return;
    if (!type && !('tool_use_id' in rec) && !('toolUseId' in rec)) return;
    const id = asString(rec.tool_use_id) ?? asString(rec.toolUseId) ?? asString(rec.id);
    if (!id) return;
    const isError = rec.is_error === true || rec.isError === true;
    results.push({ tool_use_id: id, text: resultText(rec), isError: isError || undefined });
  };
  if (Array.isArray(content)) {
    for (const block of content) {
      const rec = asRecord(block);
      if (rec) push(rec);
    }
    return results;
  }
  const rec = asRecord(content);
  if (rec) push(rec);
  return results;
}

function envelope(line: Record<string, unknown>): Record<string, unknown> {
  return asRecord(line.message) ?? asRecord(line.data) ?? line;
}

export function parseTranscriptLine(raw: unknown): Message | undefined {
  const line = asRecord(raw);
  if (!line) return undefined;
  const body = envelope(line);
  const content = body.content ?? line.content ?? body.text;
  const role =
    roleOf(body.role) ??
    roleOf(line.role) ??
    (asString(line.type) === 'assistant'
      ? 'assistant'
      : asString(line.type) === 'user' || asString(line.type) === 'tool'
        ? 'user'
        : undefined);
  const toolUses = [
    ...toolUsesFrom(content),
    ...toolUsesFrom(body.tool_calls),
    ...toolUsesFrom(body.toolCalls),
    ...toolUsesFrom(line.tool_use),
  ];
  const toolResults = [
    ...toolResultsFrom(content),
    ...toolResultsFrom(body.tool_results),
    ...toolResultsFrom(line.tool_result),
  ];
  const text =
    textFrom(content) ||
    (typeof body.text === 'string' ? body.text : '') ||
    (typeof line.text === 'string' ? line.text : '');
  const inferred: Role | undefined =
    role ?? (toolResults.length > 0 && toolUses.length === 0 ? 'user' : toolUses.length > 0 ? 'assistant' : undefined);
  if (!inferred) return undefined;
  if (text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) return undefined;
  const message: Message = { role: inferred, text, toolUses };
  if (toolResults.length > 0) message.toolResults = toolResults;
  return message;
}

export function parseTranscript(jsonl: string): Message[] {
  const messages: Message[] = [];
  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const message = parseTranscriptLine(parsed);
    if (message) messages.push(message);
  }
  return messages;
}
