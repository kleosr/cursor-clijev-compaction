import { abridge, estimateTokens, truncate } from './tokens.js';
import type {
  CompactionState,
  FittedState,
  HistoryEntry,
  HistoryToolCall,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolResult,
} from './types.js';

export const STATE_CONTEXT =
  'A Cursor CLI coding session is being compacted. `history` is the conversation oldest-first; tool outputs are a short `result` note. Each question asks whether one tool call, or its full output, still needs to stay verbatim. Dropped items are gone from recovery; the assistant can re-run a tool.';

const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;

export function isPinned(
  index: number,
  total: number,
  preserveRecentMessages: number,
): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}

function inputText(input: Record<string, unknown>, limit: number): string {
  let json = '';
  try {
    json = JSON.stringify(input);
  } catch {
    json = '[unserializable input]';
  }
  return truncate(json, limit);
}

function resultNote(call: ToolCall): string {
  return `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars (omitted)`;
}

function compactCallLine(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : inputText({ [key]: value }, 200);
      return `${key}=${text.replace(/\s+/g, ' ')}`;
    })
    .join(' ');
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${
    call.isError ? 'error' : 'ok'
  } ${call.resultChars}ch`;
}

function mergeCallRuns(
  history: readonly HistoryEntry[],
  pinned: (entry: HistoryEntry) => boolean,
): HistoryEntry[] {
  const merged: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = merged[merged.length - 1];
    const foldable = (item: HistoryEntry): boolean =>
      !pinned(item) && item.text.length === 0 && typeof item.tool_calls?.[0] === 'string';
    if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [
        ...(previous.tool_calls as string[]),
        ...(entry.tool_calls as string[]),
      ];
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? [];
    list.push(call);
    byMessage.set(call.callIndex, list);
  }
  return byMessage;
}

function historyEntries(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  inputChars: number,
): HistoryEntry[] {
  const byMessage = callsByMessage(calls);
  const entries: HistoryEntry[] = [];
  messages.forEach((message, i) => {
    const toolCalls: HistoryToolCall[] = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call),
    }));
    if (message.text.trim().length === 0 && toolCalls.length === 0) return;
    const entry: HistoryEntry = { i, role: message.role, text: message.text };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    entries.push(entry);
  });
  return entries;
}

export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
}

export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'maxStateTokens' | 'preserveRecentMessages' | 'goal'>,
): FittedState {
  const goal = options.goal || goalFromMessages(messages);
  const stateOf = (history: HistoryEntry[]): CompactionState => ({
    context: STATE_CONTEXT,
    goal,
    history,
  });
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({
    state: stateOf(history),
    tokens,
    stage,
  });

  let history: HistoryEntry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const rebuild = (inputChars: number): void => {
    history = historyEntries(messages, calls, inputChars);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  };
  const fits = (): boolean => tokens <= options.maxStateTokens;
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index];
    if (!entry) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };

  rebuild(INPUT_CHARS[0]);
  if (fits()) return fitted(history, tokens, 'full');

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }

  const pinned = (entry: HistoryEntry): boolean =>
    isPinned(entry.i, messages.length, options.preserveRecentMessages);
  const indices = history.map((_, index) => index);
  const order = [
    ...indices.filter((index) => !pinned(history[index]!)),
    ...indices.filter((index) => pinned(history[index]!)),
  ];

  for (const index of order) {
    const entry = history[index]!;
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(index, (e) => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits()) return fitted(history, tokens, 'texts abridged');
  }

  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.text.length === 0) continue;
    const original = messages[entry.i]?.text.length ?? entry.text.length;
    shrink(index, (e) => {
      e.text = `[… ${original} chars omitted …]`;
    });
    if (fits()) return fitted(history, tokens, 'old messages collapsed');
  }

  const byMessage = callsByMessage(calls);
  for (const index of order) {
    const entry = history[index]!;
    const own = byMessage.get(entry.i);
    if (pinned(entry) || !own) continue;
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCallLine);
    });
    if (fits()) return fitted(history, tokens, 'old calls compacted');
  }

  const left = new Set<number>();
  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.tool_calls) continue;
    left.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        'old messages left out',
      );
    }
  }

  history = mergeCallRuns(
    history.filter((_, i) => !left.has(i)),
    pinned,
  );
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  if (fits()) return fitted(history, tokens, 'old calls merged');

  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`,
  );
}
