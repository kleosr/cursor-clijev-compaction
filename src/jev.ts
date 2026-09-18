import type { JevAsker, JevQuestions, JevResponse, JevState, NoulAnswer } from './types.js';

export const SYSTEM_ONE_PATH = '/v1/systemone';
export const SYSTEM_ONE_ORIGIN = 'https://api.typesafe.ai';
export const SYSTEM_ONE_URL = `${SYSTEM_ONE_ORIGIN}${SYSTEM_ONE_PATH}`;
export const DEFAULT_MODEL = 'jev-latest';

export const KEY_MISSING =
  'TYPESAFE_API_KEY is not configured. Create a key in the TypeSafe console (https://docs.typesafe.ai) and export TYPESAFE_API_KEY. Scoring always uses TypeSafe Jev (jev-latest). Cursor CLI still runs without a key; keep/drop recovery is skipped.';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export function systemOneUrl(baseUrl?: string): string {
  const base = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return SYSTEM_ONE_URL;
  if (base.endsWith(SYSTEM_ONE_PATH)) return base;
  return `${base}${SYSTEM_ONE_PATH}`;
}

export function buildJevRequest(
  params: { apiKey: string; model?: string; baseUrl?: string },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: systemOneUrl(params.baseUrl),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

export function parseJevResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

export function noulAnswer(answers: JevResponse['answers'], name: string): number {
  const answer = answers[name] as NoulAnswer | undefined;
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}

export interface JevClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? process.env.TYPESAFE_BASE_URL;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error(KEY_MISSING);
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}
