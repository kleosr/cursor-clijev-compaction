export {
  compact,
  decideCall,
  applyDecisions,
  batchCalls,
  questionsFor,
  resolveOptions,
  DEFAULT_OPTIONS,
  reductionRatio,
  messageChars,
} from './compact.js';
export {
  JevClient,
  buildJevRequest,
  parseJevResponse,
  noulAnswer,
  systemOneUrl,
  SYSTEM_ONE_URL,
  SYSTEM_ONE_ORIGIN,
  DEFAULT_MODEL,
  KEY_MISSING,
} from './jev.js';
export type { JevClientOptions } from './jev.js';
export { collectToolCalls, fitState, goalFromMessages, isPinned } from './state.js';
export { estimateTokens, truncate, abridge } from './tokens.js';
export { parseTranscript, parseTranscriptLine } from './transcript.js';
export {
  mergeCapturedTools,
  messagesFromCaptured,
  loadCapturedTools,
  writeCapturedTool,
} from './store.js';
export { buildInject, INJECT_BUDGET } from './inject.js';
export { handleHook, typesafeSessionEnv } from './hook.js';
export { buildAgentArgs, runCli, NO_INSTALL, agentChildEnv } from './cli.js';
export { resolveAgentBin } from './agent.js';
export { packageRoot, dataHome } from './paths.js';

import { compact } from './compact.js';
import { JevClient, type JevClientOptions } from './jev.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions & JevClientOptions;

export async function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compact(messages, new JevClient(options), options);
}

export type {
  CallAction,
  CallAnswer,
  CallDecision,
  CapturedTool,
  CompactOptions,
  CompactResult,
  CompactStats,
  CompactionState,
  JevAsker,
  JevQuestions,
  JevResponse,
  Message,
  Role,
  Sidecar,
  ToolCall,
  ToolResult,
  ToolUse,
} from './types.js';
