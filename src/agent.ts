import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveAgentBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CURSOR_AGENT_BIN?.trim();
  if (override) return override;
  const localApp = env.LOCALAPPDATA?.trim();
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  const candidates = [
    localApp ? path.join(localApp, 'cursor-agent', 'agent.cmd') : '',
    localApp ? path.join(localApp, 'cursor-agent', 'agent.exe') : '',
    localApp ? path.join(localApp, 'cursor-agent', 'agent') : '',
    home ? path.join(home, '.local', 'bin', 'agent') : '',
  ].filter((candidate) => candidate.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'agent';
}
