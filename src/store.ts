import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { toolsPath } from './paths.js';
import type { CapturedTool, Message, ToolResult, ToolUse } from './types.js';

function parseCaptured(line: string): CapturedTool | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.id !== 'string' || typeof rec.tool !== 'string' || typeof rec.output !== 'string') {
    return undefined;
  }
  const input =
    rec.input !== null && typeof rec.input === 'object' && !Array.isArray(rec.input)
      ? (rec.input as Record<string, unknown>)
      : {};
  return {
    id: rec.id,
    tool: rec.tool,
    input,
    output: rec.output,
    isError: rec.isError === true,
    at: typeof rec.at === 'string' ? rec.at : '',
  };
}

export async function writeCapturedTool(
  conversationId: string | undefined,
  tool: CapturedTool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = toolsPath(conversationId, env);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(tool)}\n`, 'utf8');
}

export async function loadCapturedTools(
  conversationId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CapturedTool[]> {
  let text = '';
  try {
    text = await readFile(toolsPath(conversationId, env), 'utf8');
  } catch {
    return [];
  }
  const tools: CapturedTool[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const tool = parseCaptured(line);
    if (tool) tools.push(tool);
  }
  return tools;
}

function takeCapture(unused: CapturedTool[], id: string, tool: string): CapturedTool | undefined {
  const byId = unused.findIndex((item) => item.id === id);
  if (byId >= 0) return unused.splice(byId, 1)[0];
  const byTool = unused.findIndex((item) => item.tool === tool);
  if (byTool >= 0) return unused.splice(byTool, 1)[0];
  return unused.shift();
}

function asUse(tool: CapturedTool): ToolUse {
  return { tool_use_id: tool.id, tool: tool.tool, input: tool.input };
}

function asResult(tool: CapturedTool, toolUseId = tool.id): ToolResult {
  return { tool_use_id: toolUseId, text: tool.output, isError: tool.isError || undefined };
}

export function mergeCapturedTools(
  messages: readonly Message[],
  captured: readonly CapturedTool[],
): Message[] {
  const resultIds = new Set(
    messages.flatMap((message) => (message.toolResults ?? []).map((result) => result.tool_use_id)),
  );
  const unused = [...captured];
  const merged = messages.map((message) => {
    const extra: ToolResult[] = [];
    for (const use of message.toolUses) {
      if (resultIds.has(use.tool_use_id)) continue;
      const cap = takeCapture(unused, use.tool_use_id, use.tool);
      if (!cap) continue;
      extra.push(asResult(cap, use.tool_use_id));
      resultIds.add(use.tool_use_id);
    }
    if (extra.length === 0) return message;
    return { ...message, toolResults: [...(message.toolResults ?? []), ...extra] };
  });
  if (unused.length === 0) return merged;
  merged.push({
    role: 'assistant',
    text: '',
    toolUses: unused.map(asUse),
    toolResults: unused.map((tool) => asResult(tool)),
  });
  return merged;
}

export function messagesFromCaptured(captured: readonly CapturedTool[]): Message[] {
  if (captured.length === 0) return [];
  return [
    {
      role: 'user',
      text: 'Recovered tool I/O; the transcript had no usable messages.',
      toolUses: [],
    },
    {
      role: 'assistant',
      text: '',
      toolUses: captured.map(asUse),
      toolResults: captured.map((tool) => asResult(tool)),
    },
  ];
}
