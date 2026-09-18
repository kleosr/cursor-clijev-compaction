export type Role = 'user' | 'assistant';

export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

export interface ToolCall {
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  callIndex: number;
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  pinned: boolean;
}

export interface CallAnswer {
  keepCall: number;
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped';
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  tool_calls?: HistoryToolCall[] | string[];
}

export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  stage: string;
}

export interface CompactOptions {
  goal?: string;
  keepThreshold?: number;
  preserveRecentMessages?: number;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  truncateHeadChars?: number;
}

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
}

export interface CompactStats {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  calls: number;
  kept: number;
  resultsDropped: number;
  callsDropped: number;
  pinned: number;
  stateTokens: number;
  stateStage: string;
  requests: number;
  ms: number;
}

export interface CompactResult {
  messages: Message[];
  decisions: CallDecision[];
  stats: CompactStats;
}

export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export type JevQuestions = Record<string, NoulQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface JevResponse {
  model?: string;
  answers: Record<string, NoulAnswer | Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}

export interface CapturedTool {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  at: string;
}

export interface Sidecar {
  conversation_id: string;
  at: string;
  consumed: boolean;
  trigger?: string;
  stats: CompactStats;
  decisions: CallDecision[];
  inject: string;
  reduction: number;
}
