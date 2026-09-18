#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, 'dist', 'hook.js');

if (!existsSync(hook)) {
  process.stdout.write('{}\n');
  process.stderr.write('cursor-jev: dist/hook.js missing; run pnpm build in the plugin directory\n');
  process.exit(0);
}

const child = spawn(process.execPath, [hook, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', () => {
  process.stdout.write('{}\n');
  process.exit(0);
});
child.on('exit', (code, signal) => {
  if (signal) process.exit(0);
  process.exit(code === null ? 0 : code);
});
