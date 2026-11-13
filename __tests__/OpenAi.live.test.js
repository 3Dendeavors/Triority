// Opt-in, synthetic captures only: TRIORITY_LIVE_OPENAI=1 npm test -- --runInBand OpenAi.live
import { execFile } from 'node:child_process';
import { parseWidgetAiCapture } from '../App';

const liveTest = process.env.TRIORITY_LIVE_OPENAI === '1' ? test : test.skip;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Node owns the key and network call; neither the key nor upstream errors enter Jest output.
const requestScript = `
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const source = fs.readFileSync('_local_secrets/GPT API KEY.txt', 'utf8');
    const key = source.match(/sk-[A-Za-z0-9_-]+/)?.[0];
    if (!key) throw new Error('Local OpenAI key missing');
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: input, signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error('OpenAI HTTP ' + response.status);
    process.stdout.write(JSON.stringify(data));
  } catch (error) {
    process.stderr.write(error.message.startsWith('OpenAI HTTP') ? error.message : 'Live OpenAI check failed');
    process.exitCode = 1;
  }
});
`;

function useLiveFetch() {
  globalThis.fetch = async (url, options) => {
    if (url !== 'https://api.openai.com/v1/responses') throw new Error('Unexpected provider in live OpenAI check');
    const data = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['-e', requestScript], { cwd: process.cwd(), timeout: 40000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || 'Live OpenAI check failed'));
        else resolve(JSON.parse(stdout));
      });
      child.stdin.end(options.body);
    });
    return { ok: true, json: async () => data };
  };
}

const referenceTimeMs = new Date(2026, 10, 13, 10, 0).getTime();
const capture = {
  lists: [
    { id: 'home', name: 'To do', tasks: [] },
    { id: 'work', name: 'Work', tasks: [] },
  ],
  activeListId: 'home', defaultTier: 'medium', aiProvider: 'openai',
  apiKey: 'sk-live-test-placeholder', hasApiKey: true, personalContext: '',
  isPaid: true, widgetShorthand: true, referenceTimeMs,
};

liveTest('live model and app split widget tasks/groceries while preserving destination and clock time', async () => {
  useLiveFetch();
  const result = await parseWidgetAiCapture({ ...capture, raw: 'Fix unit 4 tomorrow at 9 am in the Work list. Add milk and eggs to groceries.' });
  const task = result.taskGroups.find(group => group.listId === 'work')?.tasks.find(row => /unit 4/i.test(row.text));
  expect(task).toBeDefined();
  expect(task.reminder?.remindAt).toBe(new Date(2026, 10, 14, 9, 0).getTime());
  expect(result.grocery.some(row => /milk/i.test(row.name))).toBe(true);
  expect(result.grocery.some(row => /eggs/i.test(row.name))).toBe(true);
  expect(result.tasks.some(row => /milk|eggs/i.test(row.text))).toBe(false);
}, 90000);

liveTest('live model preserves a relative reminder from capture time without timing unrelated tasks', async () => {
  useLiveFetch();
  const result = await parseWidgetAiCapture({ ...capture, raw: 'Remind me to call the dentist in 10 minutes. Also wash the car.' });
  const call = result.tasks.find(row => /dentist/i.test(row.text));
  const wash = result.tasks.find(row => /wash.*car/i.test(row.text));
  expect(call?.reminder?.remindAt).toBe(referenceTimeMs + 10 * 60 * 1000);
  expect(wash).toBeDefined();
  expect(wash.reminder).toBeUndefined();
}, 90000);

liveTest('live model keeps call and print reminders at their separate requested times', async () => {
  useLiveFetch();
  const result = await parseWidgetAiCapture({
    ...capture,
    raw: 'Remind me to call Alex today at 2:15 pm and remind me to start a print today at 6:30 pm. Add paper towels to groceries.',
  });
  const call = result.tasks.find(row => /call.*Alex/i.test(row.text));
  const print = result.tasks.find(row => /start.*print/i.test(row.text));
  expect(result.tasks).toHaveLength(2);
  expect(call?.reminder?.remindAt).toBe(new Date(2026, 10, 13, 14, 15).getTime());
  expect(print?.reminder?.remindAt).toBe(new Date(2026, 10, 13, 18, 30).getTime());
  expect(result.grocery.some(row => /paper towels/i.test(row.name))).toBe(true);
  expect(result.tasks.some(row => /paper towels/i.test(row.text))).toBe(false);
}, 90000);
