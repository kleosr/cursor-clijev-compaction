import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function findPackageRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Plugin / package root. Never ~/.cursor. */
export function packageRoot(): string {
  return findPackageRoot(path.resolve(here, '..'));
}

export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CURSOR_JEV_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(packageRoot(), '.data');
}

export function safeConversationId(id: string | undefined): string {
  const trimmed = (id ?? '').trim();
  const raw = trimmed.length > 0 ? trimmed : '_unknown';
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180);
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned : '_unknown';
}

export function conversationDir(
  conversationId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(dataHome(env), safeConversationId(conversationId));
}

export function toolsPath(
  conversationId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(conversationDir(conversationId, env), 'tools.jsonl');
}

export function sidecarPath(
  conversationId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(conversationDir(conversationId, env), 'sidecar.json');
}
