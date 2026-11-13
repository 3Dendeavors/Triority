export {};

declare const __dirname: string;

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

const backendSource = readFileSync(join(__dirname, '../supabase/functions/triority-ai/index.ts'), 'utf8');
const backendCode = ts.transpileModule(backendSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

class TestResponse {
  status: number;
  ok: boolean;
  constructor(private body: string | null, options: { status?: number } = {}) {
    this.status = options.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
  }
  async json() { return JSON.parse(this.body || 'null'); }
}

function loadBackend(env: Record<string, string> = {}) {
  let handler: any;
  const fetchMock = jest.fn();
  const sandbox: any = {
    Deno: { env: { get: (key: string) => env[key] }, serve: (callback: any) => { handler = callback; } },
    fetch: fetchMock,
    Response: TestResponse,
    AbortController,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(backendCode, sandbox);
  sandbox.enforceRateLimit = jest.fn(async () => true);
  return { sandbox, fetchMock, handler };
}

const taskSchema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          tier: { type: 'string', enum: ['high', 'medium', 'low'] },
          reminder: {
            type: 'object',
            properties: { hour: { type: 'integer' } },
            required: ['hour'],
          },
        },
        required: ['text', 'tier'],
      },
    },
  },
  required: ['tasks'],
};

const payload = { tasks: [{ text: 'Fix unit 4', tier: 'medium' }] };
const request = (toolName = 'capture_widget_tasks') => ({
  method: 'POST',
  json: async () => ({ toolName, system: 'Organize tasks', user: 'Fix unit 4', maxTokens: 800, schema: taskSchema }),
});

test.each([undefined, 'openai', 'gemini'])('included AI stays on Google regardless of personal OpenAI configuration: %s', async (provider) => {
  const { sandbox, handler, fetchMock } = loadBackend({
    GEMINI_API_KEY: 'test-gemini-key',
    OPENAI_API_KEY: 'test-personal-openai-key',
    ...(provider ? { TRIORITY_AI_PROVIDER: provider } : {}),
  });
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
  });

  const response = await handler(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ output: payload });
  expect(sandbox.enforceRateLimit).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toContain('generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite');
  expect(options.headers['x-goog-api-key']).toBe('test-gemini-key');
  expect(options.headers.Authorization).toBeUndefined();
  expect(JSON.stringify(options)).not.toContain('test-personal-openai-key');
});

test('an OpenAI key cannot enable included AI without a Google key', async () => {
  const { handler, fetchMock } = loadBackend({ OPENAI_API_KEY: 'test-personal-openai-key', TRIORITY_AI_PROVIDER: 'openai' });
  expect((await handler(request())).status).toBe(503);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('unsupported tools never reach the included provider', async () => {
  const { handler, fetchMock } = loadBackend({ GEMINI_API_KEY: 'test-gemini-key' });
  expect((await handler(request('arbitrary_tool'))).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('included AI rate limits remain enforced', async () => {
  const { sandbox, handler, fetchMock } = loadBackend({ GEMINI_API_KEY: 'test-gemini-key' });
  sandbox.enforceRateLimit.mockResolvedValue(false);
  expect((await handler(request())).status).toBe(429);
  expect(fetchMock).not.toHaveBeenCalled();
});
