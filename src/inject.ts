import { collectToolCalls } from './state.js';
import { truncate } from './tokens.js';
import type { CompactResult, Message, ToolCall } from './types.js';

export const INJECT_BUDGET = 12_000;

function resultById(messages: readonly Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) map.set(result.tool_use_id, result.text);
  }
  return map;
}

function inputLine(call: ToolCall): string {
  try {
    return JSON.stringify(call.input);
  } catch {
    return '[unserializable input]';
  }
}

function userConstraints(messages: readonly Message[]): string[] {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text.trim(), 500));
}

function block(call: ToolCall, body: string): string {
  return `### ${call.id} ${call.tool}\ninput: ${truncate(inputLine(call), 400)}\n${body}`;
}

export function buildInject(
  messages: readonly Message[],
  result: Pick<CompactResult, 'decisions' | 'stats'>,
  budget = INJECT_BUDGET,
): string {
  const calls = collectToolCalls(messages, 0);
  const byId = new Map(calls.map((call) => [call.id, call]));
  const results = resultById(messages);
  const kept: string[] = [];
  const truncated: string[] = [];
  const dropped: string[] = [];
  for (const decision of result.decisions) {
    const call = byId.get(decision.id);
    if (!call) continue;
    const text = results.get(call.tool_use_id) ?? '';
    if (decision.action === 'keep') {
      kept.push(block(call, `result:\n${text}`));
    } else if (decision.action === 'drop_result') {
      truncated.push(
        block(call, `truncated result:\n${truncate(text, 400)}\n(re-run the tool for the rest)`),
      );
    } else {
      dropped.push(`- ${call.id} ${call.tool} ${truncate(inputLine(call), 120)}`);
    }
  }
  const parts = [
    '[cursor-jev recovery]',
    'Native compact ran. Treat the kept tool facts below as verbatim. Re-run dropped or truncated tools if you need the rest.',
    `scored ${result.stats.calls} calls: keep ${result.stats.kept}, truncate ${result.stats.resultsDropped}, drop ${result.stats.callsDropped}, pinned ${result.stats.pinned}.`,
  ];
  const constraints = userConstraints(messages);
  if (constraints.length > 0) {
    parts.push('', '## User constraints', ...constraints.map((text) => `- ${text}`));
  }
  const sections: Array<[string, string[]]> = [
    ['## Kept results', kept],
    ['## Truncated results', truncated],
    ['## Dropped (re-run if needed)', dropped],
  ];
  let omitted = 0;
  for (const [heading, items] of sections) {
    if (items.length === 0) continue;
    const chunk = [heading, ...items].join('\n');
    const next = `${parts.join('\n')}\n\n${chunk}`;
    if (next.length <= budget) {
      parts.push('', heading, ...items);
      continue;
    }
    for (const item of items) {
      const candidate = `${parts.join('\n')}\n${item}`;
      if (candidate.length <= budget) parts.push(item);
      else omitted += 1;
    }
  }
  if (omitted > 0) parts.push('', `(${omitted} more tool facts omitted to fit the inject budget)`);
  const text = parts.join('\n').trim();
  return text.length <= budget ? text : `${text.slice(0, budget - 1)}…`;
}
