import { DEFAULT_MODEL, SYSTEM_ONE_URL } from '../src/jev.js';
import type { JevQuestions } from '../src/types.js';

export function typesafeFetch(noulFor: (name: string) => number): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== SYSTEM_ONE_URL) {
      throw new Error(`TypeSafe client must POST ${SYSTEM_ONE_URL}, got ${url}`);
    }
    const headers = init?.headers;
    const authorization =
      headers instanceof Headers
        ? headers.get('Authorization')
        : headers && !Array.isArray(headers)
          ? headers.Authorization ?? headers.authorization
          : undefined;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new Error('TypeSafe request must send Authorization: Bearer <key>');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(init?.body ?? '{}'));
    } catch {
      throw new Error('TypeSafe request body is not JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('TypeSafe request body must be an object');
    }
    const body = parsed as { model?: string; questions?: JevQuestions };
    if (body.model !== DEFAULT_MODEL) {
      throw new Error(`TypeSafe model must default to ${DEFAULT_MODEL}, got ${body.model}`);
    }
    const questions = body.questions ?? {};
    for (const question of Object.values(questions)) {
      if (question.type !== 'noul' || typeof question.instructions !== 'string') {
        throw new Error('TypeSafe questions must be noul with instructions');
      }
    }
    const answers = Object.fromEntries(
      Object.keys(questions).map((name) => [
        name,
        { type: 'noul' as const, noul: noulFor(name) },
      ]),
    );
    return new Response(
      JSON.stringify({
        model: DEFAULT_MODEL,
        answers,
        usage: { input_tokens: 12, output_tokens: 4 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}
