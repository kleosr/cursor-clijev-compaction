import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDecisions, compact, decideCall } from '../src/compact.js';
import { buildJevRequest, JevClient, SYSTEM_ONE_URL } from '../src/jev.js';
import { handleHook } from '../src/hook.js';
import { sidecarPath } from '../src/paths.js';
import { parseTranscript } from '../src/transcript.js';
import { mergeCapturedTools } from '../src/store.js';
import type { CapturedTool, Message } from '../src/types.js';
import { typesafeFetch } from './typesafe-fetch.js';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const jsonlPath = path.join(fixtureDir, 'fixtures', 'cursor-no-result.jsonl');

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cursor-jev-'));
  temps.push(dir);
  return dir;
}

function pair(id: string, tool: string, result: string): Message[] {
  return [
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: id, tool, input: { path: `${id}.ts` } }],
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: result }] },
  ];
}

describe('Jev request', () => {
  it('puts the key in the Authorization header, not the body', () => {
    const request = buildJevRequest(
      { apiKey: 'secret-key' },
      { goal: 'x' },
      { call_t1: { type: 'noul', instructions: 'stay?' } },
    );
    expect(request.headers.Authorization).toBe('Bearer secret-key');
    expect(request.url).toBe(SYSTEM_ONE_URL);
    expect(request.body).not.toContain('secret-key');
  });
});

describe('compact decisions', () => {
  it('keeps, truncates, or drops from noul scores', async () => {
    const messages: Message[] = [
      { role: 'user', text: 'Do not touch secrets.env', toolUses: [] },
      ...pair('keep', 'Read', 'KEEP_ME_VERBATIM '.repeat(40)),
      ...pair('trunc', 'Grep', 'TRUNC_BODY '.repeat(40)),
      ...pair('drop', 'Shell', 'DROP_ME '.repeat(40)),
      { role: 'user', text: 'continue', toolUses: [] },
    ];
    const result = await compact(
      messages,
      new JevClient({
        apiKey: 'test-key',
        fetch: typesafeFetch((name) =>
          name.endsWith('_t1') ? 0.9 : name === 'call_t2' ? 0.8 : name === 'result_t2' ? 0.1 : 0.05,
        ),
      }),
      { preserveRecentMessages: 1 },
    );
    const byId = Object.fromEntries(result.decisions.map((d) => [d.tool, d.action]));
    expect(byId.Read).toBe('keep');
    expect(byId.Grep).toBe('drop_result');
    expect(byId.Shell).toBe('drop_call');
    const text = result.messages.map((m) => m.toolResults?.map((r) => r.text).join('') ?? m.text).join('\n');
    expect(text).toContain('KEEP_ME_VERBATIM');
    expect(text).toContain('cursor-jev truncated');
    expect(text).not.toContain('DROP_ME');
  });

  it('pins the first message even when noul says drop', () => {
    const decision = decideCall(
      { id: 't1', tool: 'Read', pinned: true },
      { keepCall: 0, keepResult: 0 },
      { keepThreshold: 0.5 },
    );
    expect(decision.action).toBe('keep');
    expect(decision.reason).toBe('pinned');
  });

  it('leaves untouched messages as the same objects', () => {
    const untouched: Message = { role: 'user', text: 'hi', toolUses: [] };
    const kept = applyDecisions([untouched], [], [], 300);
    expect(kept[0]).toBe(untouched);
  });
});

describe('transcript + store merge', () => {
  it('parses Cursor JSONL that has tool_use and no tool_result', async () => {
    const jsonl = await readFile(jsonlPath, 'utf8');
    const parsed = parseTranscript(jsonl);
    expect(parsed.some((m) => m.toolUses.some((t) => t.tool === 'Read'))).toBe(true);
    expect(parsed.every((m) => (m.toolResults ?? []).length === 0)).toBe(true);
  });

  it('fills missing results from the capture store', async () => {
    const jsonl = await readFile(jsonlPath, 'utf8');
    const captured: CapturedTool[] = [
      {
        id: 'call_read',
        tool: 'Read',
        input: { path: 'tests/flaky.test.ts' },
        output: 'describe("flaky") { it("fails", () => {}) }',
        isError: false,
        at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'call_grep',
        tool: 'Grep',
        input: { pattern: 'timeout' },
        output: 'tests/flaky.test.ts:12: timeout',
        isError: false,
        at: '2026-01-01T00:00:01.000Z',
      },
    ];
    const merged = mergeCapturedTools(parseTranscript(jsonl), captured);
    const ids = merged.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id));
    expect(ids).toContain('call_read');
    expect(ids).toContain('call_grep');
    expect(merged.some((m) => (m.toolResults ?? []).some((r) => r.text.includes('flaky')))).toBe(true);
  });
});

describe('hooks stdin → stdout JSON', () => {
  it('captures postToolUse into the conversation store', async () => {
    const home = await tmpHome();
    const env = { CURSOR_JEV_HOME: home };
    const out = await handleHook(
      'postToolUse',
      {
        conversation_id: 'conv-1',
        tool_name: 'Read',
        tool_use_id: 'call_read',
        tool_input: { path: 'a.ts' },
        tool_output: 'export const n = 1',
      },
      { env },
    );
    expect(out).toEqual({});
    const stored = await readFile(path.join(home, 'conv-1', 'tools.jsonl'), 'utf8');
    expect(stored).toContain('call_read');
    expect(stored).toContain('export const n = 1');
  });

  it('preCompact scores, stop injects, and sessionStart is a leftover path', async () => {
    const home = await tmpHome();
    const env = { CURSOR_JEV_HOME: home, TYPESAFE_API_KEY: 'test-key' };
    await handleHook(
      'postToolUse',
      {
        conversation_id: 'conv-2',
        tool_name: 'Read',
        tool_use_id: 'call_read',
        tool_input: { path: 'tests/flaky.test.ts' },
        tool_output: 'describe("flaky") { /* exact assertion */ expect(1).toBe(1) }',
      },
      { env },
    );
    const pre = await handleHook(
      'preCompact',
      { conversation_id: 'conv-2', transcript_path: jsonlPath, trigger: 'auto' },
      {
        env,
        fetch: typesafeFetch(() => 1),
        compact: { preserveRecentMessages: 1 },
      },
    );
    expect(pre.user_message).toMatch(/cursor-jev: scored/);
    const sidecar = JSON.parse(await readFile(sidecarPath('conv-2', env), 'utf8')) as {
      inject: string;
      consumed: boolean;
    };
    expect(sidecar.consumed).toBe(false);
    expect(sidecar.inject).toContain('[cursor-jev recovery]');
    expect(sidecar.inject).toContain('Never edit generated.ts');

    const stop = await handleHook(
      'stop',
      { conversation_id: 'conv-2', status: 'completed', loop_count: 0 },
      { env },
    );
    expect(stop.followup_message).toContain('[cursor-jev recovery]');
    const afterStop = JSON.parse(await readFile(sidecarPath('conv-2', env), 'utf8')) as {
      consumed: boolean;
    };
    expect(afterStop.consumed).toBe(true);

    const resume = await handleHook('sessionStart', { conversation_id: 'conv-2' }, { env });
    expect(resume.additional_context).toBeUndefined();
    expect((resume.env as Record<string, string>).TYPESAFE_API_KEY).toBe('test-key');
  });

  it('sessionStart injects leftover sidecar when stop did not consume it', async () => {
    const home = await tmpHome();
    const env = { CURSOR_JEV_HOME: home };
    const dir = path.join(home, 'conv-3');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'sidecar.json'),
      JSON.stringify({
        conversation_id: 'conv-3',
        at: '2026-01-01T00:00:00.000Z',
        consumed: false,
        stats: {
          messagesBefore: 1,
          messagesAfter: 1,
          charsBefore: 1,
          charsAfter: 1,
          calls: 1,
          kept: 1,
          resultsDropped: 0,
          callsDropped: 0,
          pinned: 0,
          stateTokens: 10,
          stateStage: 'full',
          requests: 1,
          ms: 1,
        },
        decisions: [],
        inject: '[cursor-jev recovery]\nleftover fact',
        reduction: 0,
      }),
      'utf8',
    );
    const start = await handleHook('sessionStart', { conversation_id: 'conv-3' }, { env });
    expect(start.additional_context).toContain('leftover fact');
  });

  it('sessionStart forwards TypeSafe key into Cursor CLI session env', async () => {
    const home = await tmpHome();
    const out = await handleHook(
      'sessionStart',
      { conversation_id: 'conv-key' },
      {
        env: {
          CURSOR_JEV_HOME: home,
          TYPESAFE_API_KEY: 'sk-test-typesafe',
          TYPESAFE_DEFAULT_MODEL: 'jev-latest',
        },
      },
    );
    const sessionEnv = out.env as Record<string, string>;
    expect(sessionEnv.TYPESAFE_API_KEY).toBe('sk-test-typesafe');
    expect(sessionEnv.TYPESAFE_DEFAULT_MODEL).toBe('jev-latest');
    expect(sessionEnv.CURSOR_JEV_HOME).toBe(home);
  });

  it('fail-opens preCompact when Jev is missing', async () => {
    const home = await tmpHome();
    const env = { CURSOR_JEV_HOME: home };
    await handleHook(
      'postToolUse',
      {
        conversation_id: 'conv-4',
        tool_name: 'Read',
        tool_use_id: 'call_read',
        tool_input: { path: 'tests/flaky.test.ts' },
        tool_output: 'file body',
      },
      { env },
    );
    const out = await handleHook(
      'preCompact',
      { conversation_id: 'conv-4', transcript_path: jsonlPath },
      { env, compact: { preserveRecentMessages: 1 } },
    );
    expect(out.user_message).toMatch(/skipped TypeSafe scoring/);
  });
});
