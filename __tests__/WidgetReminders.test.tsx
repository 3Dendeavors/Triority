import {
  buildReminderFromAIResult,
  parseWidgetAiCapture,
  taskDraftWithLocalReminder,
  widgetCaptureReferenceTime,
} from '../App';

const capturedAt = new Date(2026, 10, 13, 10, 0, 0).getTime();
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

test.each([
  ['Call mom in 2 days at 6 pm', new Date(2026, 10, 15, 18, 0).getTime()],
  ['Call mom in 2 days at noon', new Date(2026, 10, 15, 12, 0).getTime()],
  ['Fix unit 4 tomorrow at 9 am', new Date(2026, 10, 14, 9, 0).getTime()],
  ['Call mom at noon', new Date(2026, 10, 13, 12, 0).getTime()],
  ['Call mom at midnight', new Date(2026, 10, 14, 0, 0).getTime()],
  ['Call mom at 9:30 pm', new Date(2026, 10, 13, 21, 30).getTime()],
])('manual capture finds the requested clock time: %s', (text, expectedTime) => {
  const task = taskDraftWithLocalReminder(text, 'medium', undefined, capturedAt);
  expect(task.reminder?.remindAt).toBe(expectedTime);
});

test('delayed manual capture keeps relative reminder time even after it is overdue', () => {
  jest.spyOn(Date, 'now').mockReturnValue(capturedAt + 60 * 60_000);
  const task = taskDraftWithLocalReminder('Remind me to call mom in 10 minutes', 'medium', undefined, capturedAt);
  expect(task.reminder?.remindAt).toBe(capturedAt + 10 * 60_000);
  expect(task.reminder!.remindAt).toBeLessThan(Date.now());
});

test('AI reminder dates use capture time instead of the day the queue is imported', () => {
  jest.spyOn(Date, 'now').mockReturnValue(new Date(2026, 10, 16, 14, 0).getTime());
  const reminder = buildReminderFromAIResult(
    { daysFromNow: 1, hour: 9, minute: 0, repeatHourly: false, repeatDaily: false },
    'Call mom tomorrow at 9 am',
    'Call mom',
    capturedAt,
  );
  expect(reminder?.remindAt).toBe(new Date(2026, 10, 14, 9, 0).getTime());
});

test('AI reminder fallback uses the same capture clock', () => {
  const reminder = buildReminderFromAIResult(undefined, 'Call mom in 10 minutes', 'Call mom', capturedAt);
  expect(reminder?.remindAt).toBe(capturedAt + 10 * 60_000);
});

test('one timed clause does not put a reminder on an unrelated task', () => {
  const raw = 'Call mom at noon and clean garage';
  expect(buildReminderFromAIResult(undefined, raw, 'Call mom', capturedAt)?.remindAt)
    .toBe(new Date(2026, 10, 13, 12, 0).getTime());
  expect(buildReminderFromAIResult({ hour: 12 }, raw, 'Clean garage', capturedAt)).toBeUndefined();
  expect(taskDraftWithLocalReminder('Call mom tomorrow', 'medium', undefined, capturedAt).reminder).toBeUndefined();
});

test('capture timestamp validation preserves queued time and rejects invalid future values', () => {
  const importedAt = capturedAt + 60_000;
  expect(widgetCaptureReferenceTime(capturedAt, importedAt)).toBe(capturedAt);
  for (const value of [undefined, null, 'yesterday', 0, -1, NaN, Infinity, importedAt + 60_000]) {
    expect(widgetCaptureReferenceTime(value, importedAt)).toBe(importedAt);
  }
});

const widgetRequest = {
  raw: 'Call mom in 10 minutes',
  lists: [{ id: 'personal', name: 'To do', tasks: [], createdAt: capturedAt, updatedAt: capturedAt }],
  activeListId: 'personal',
  defaultTier: 'medium' as const,
  aiProvider: 'gemini' as const,
  apiKey: 'test-key',
  hasApiKey: true,
  personalContext: '',
  isPaid: true,
  widgetShorthand: false,
  referenceTimeMs: capturedAt,
};

test('AI widget failures propagate so the queued capture can be retried', async () => {
  globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network unavailable'));
  await expect(parseWidgetAiCapture(widgetRequest)).rejects.toThrow('Network unavailable');
  await expect(parseWidgetAiCapture({ ...widgetRequest, apiKey: '', hasApiKey: false })).rejects.toThrow('Set up your AI provider');
});

test('AI widget prompt and missing-reminder recovery share the capture clock', async () => {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ tasks: [{ text: 'Call mom', tier: 'medium' }], grocery: [] }) }] } }] }),
  });
  jest.spyOn(Date, 'now').mockReturnValue(capturedAt + 60 * 60_000);
  const result = await parseWidgetAiCapture(widgetRequest);
  expect(result.tasks[0].reminder?.remindAt).toBe(capturedAt + 10 * 60_000);
  const body = JSON.parse((globalThis.fetch as jest.Mock).mock.calls[0][1].body);
  expect(body.systemInstruction.parts[0].text).toContain('10:00 AM');
});

test('nullable OpenAI fields preserve local reminders and default routing in mixed tasks', async () => {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        tasks: [
          { text: 'Call mom', tier: 'medium', listId: null, reminder: null, widgetLabel: null },
          { text: 'Clean garage', tier: 'medium', listId: null, reminder: null, widgetLabel: null },
        ],
        grocery: [],
      }) }] }],
    }),
  });
  jest.spyOn(Date, 'now').mockReturnValue(capturedAt + 60 * 60_000);
  const result = await parseWidgetAiCapture({
    ...widgetRequest,
    aiProvider: 'openai',
    raw: 'Call mom in 10 minutes and clean garage',
    activeListId: 'work',
    lists: [...widgetRequest.lists, { ...widgetRequest.lists[0], id: 'work', name: 'Work' }],
  });
  expect(result.taskGroups).toHaveLength(1);
  expect(result.taskGroups![0].listId).toBe('personal');
  expect(result.taskGroups![0].tasks[0].reminder?.remindAt).toBe(capturedAt + 10 * 60_000);
  expect(result.taskGroups![0].tasks[1].reminder).toBeUndefined();
});

test('locally recovered AI task keeps its captured reminder after final normalization', async () => {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ tasks: [], grocery: [] }) }] } }] }),
  });
  const result = await parseWidgetAiCapture(widgetRequest);
  expect(result.tasks).toHaveLength(1);
  expect(result.tasks[0].reminder?.remindAt).toBe(capturedAt + 10 * 60_000);
});
