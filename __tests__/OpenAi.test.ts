import { isValidAiKey, normalizeAiProvider, openAiStructuredSchema, requestAiStructuredOutput } from '../App';

const schema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          reminder: {
            type: 'object',
            properties: { hour: { type: 'number' }, minute: { type: 'number' } },
            required: ['hour'],
          },
          listId: { type: 'string', enum: ['home', 'work'] },
        },
        required: ['text'],
      },
    },
  },
  required: ['tasks'],
};

const request = {
  provider: 'openai' as const,
  apiKey: 'sk-test-only-placeholder',
  system: 'Organize tasks.',
  user: 'Fix unit 4 tomorrow at 9 am in Work',
  maxTokens: 800,
  tool: { input_schema: schema },
  toolName: 'capture_widget_tasks',
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
});

test('OpenAI selection and keys stay with OpenAI instead of migrating to Gemini', () => {
  expect(normalizeAiProvider('openai')).toBe('openai');
  expect(normalizeAiProvider(null, request.apiKey)).toBe('openai');
  expect(normalizeAiProvider(null, 'sk-ant-test')).toBe('claude');
  expect(normalizeAiProvider('gemini', request.apiKey)).toBe('gemini');
  expect(isValidAiKey('openai', request.apiKey)).toBe(true);
  expect(isValidAiKey('openai', 'sk-ant-anthropic-placeholder')).toBe(false);
  expect(isValidAiKey('gemini', request.apiKey)).toBe(false);
});

test('strict schema keeps absent reminders and destinations nullable without mutating the source', () => {
  const converted = openAiStructuredSchema(schema);
  const task = converted.properties.tasks.items;
  expect(converted.additionalProperties).toBe(false);
  expect(task.required).toEqual(['text', 'reminder', 'listId']);
  expect(task.additionalProperties).toBe(false);
  expect(task.reminder).toBeUndefined();
  const reminder = task.properties.reminder.anyOf[0];
  expect(task.properties.reminder.anyOf[1]).toEqual({ type: 'null' });
  expect(reminder.required).toEqual(['hour', 'minute']);
  expect(reminder.properties.minute.anyOf[1]).toEqual({ type: 'null' });
  expect(task.properties.listId.anyOf[0].enum).toEqual(['home', 'work']);
  expect(schema.properties.tasks.items.required).toEqual(['text']);
});

test('provider routing calls Responses with strict output and storage disabled', async () => {
  const output = { tasks: [{ text: 'Fix unit 4', reminder: null, listId: 'work' }] };
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }),
  });
  globalThis.fetch = fetchMock as any;
  await expect(requestAiStructuredOutput(request)).resolves.toEqual(output);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/responses');
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ model: 'gpt-6-luna', store: false, reasoning: { effort: 'none' }, text: { format: { strict: true } } });
  expect(body.text.format.schema).toEqual(openAiStructuredSchema(schema));
});

test.each([
  [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"tasks":[]}' }, /output limit/],
  [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, /could not finish/],
  [{ output: [{ content: [{ type: 'refusal', refusal: 'Cannot process this request.' }] }] }, /Cannot process/],
  [{ output_text: '{"tasks":null}' }, /JSON schema/],
])('OpenAI rejects incomplete, refused, and malformed results', async (payload, error) => {
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => payload }) as any;
  await expect(requestAiStructuredOutput(request)).rejects.toThrow(error as RegExp);
});

test('rejected keys are not echoed and do not silently fall back to another provider', async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: request.apiKey } }) });
  globalThis.fetch = fetchMock as any;
  await expect(requestAiStructuredOutput(request)).rejects.toThrow('OpenAI API key or permission was rejected.');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('included AI never receives the personal OpenAI key', async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ output: { tasks: [] } }) });
  globalThis.fetch = fetchMock as any;
  await expect(requestAiStructuredOutput({ ...request, provider: 'built-in' })).resolves.toEqual({ tasks: [] });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toMatch(/\/functions\/v1\/triority-ai$/);
  expect(JSON.stringify(init)).not.toContain(request.apiKey);
});

test('stalled requests time out so widget captures can be retried', async () => {
  jest.useFakeTimers();
  globalThis.fetch = jest.fn((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
  })) as any;
  const result = expect(requestAiStructuredOutput(request)).rejects.toThrow(/timed out/);
  await jest.advanceTimersByTimeAsync(30_000);
  await result;
});
