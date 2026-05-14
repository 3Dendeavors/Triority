#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, '$1'));
const SECRETS_DIR = path.join(ROOT, '_local_secrets');

const PROVIDERS = {
  openai: {
    model: 'gpt-5.4-nano',
    secretFile: 'GPT API KEY.txt',
  },
  'claude-haiku': {
    model: 'claude-haiku-4-5',
    secretFile: 'Claude API KEY.txt',
  },
  claude: {
    model: 'claude-sonnet-4-6',
    secretFile: 'Claude API KEY.txt',
  },
  gemini: {
    model: 'gemini-2.5-flash-lite',
    secretFile: 'Gemini API key.txt',
  },
};

const GROCERY_CATEGORIES = [
  'Produce', 'Dairy', 'Meat & Seafood', 'Bakery', 'Frozen',
  'Canned & Dry Goods', 'Beverages', 'Snacks', 'Household', 'Personal Care',
  'Hardware', 'Lumber', 'Electrical', 'Plumbing', 'Automotive', 'Office Supplies',
  'Tools', 'Paint', 'Fasteners', 'Other',
];
const GROCERY_UNCATEGORIZED = 'Uncategorized';
const AI_ROUTE_INPUT_TOOL_NAME = 'route_triority_input';
const AI_WIDGET_TASK_TOOL_NAME = 'capture_widget_tasks';
const AI_GROCERY_ITEMS_TOOL_NAME = 'parse_grocery_items';
const DEFAULT_LIST_ID = 'personal';
const AI_GROCERY_CATEGORY_HINTS = 'Category hints: oils, grains, spices, sauces, protein powder, wraps, and shelf-stable staples are usually Canned & Dry Goods; yogurt/milk/cheese are Dairy; fresh vegetables/fruit are Produce; frozen vegetables/fruit are Frozen; meat/fish are Meat & Seafood.';

const AI_ROW_STYLE_RULES = `Row style:
- Output app rows, not prose. Each row should be short enough to scan in a list.
- Task text should usually be 3-10 words. Avoid paragraphs, colons, semicolon chains, and packing a whole plan into one row.
- One task row = one useful action. One grocery/material row = one buyable item.
- For plan/routine/checklist/tips/advice requests, output the actual useful steps/items, not meta tasks like "choose schedule", "pick exercises", "create list", or "plan the plan".
- Include compact practical details when a row would be incomplete without them, like sets/reps/minutes for exercise, frequency for habits, or the concrete object/tool/location for checklist/advice rows.
- For broad/vague requests, pick the best starter rows instead of covering every possible category.`;
const AI_INTENT_RULES = `Intent rules:
- Use intent frames over memorized phrases: action verb + object = task; event/appointment noun + date/time = task with reminder; ingredients/supplies/materials + topic = grocery/material rows; plan/routine/checklist/tips + topic = concrete task rows.
- If user asks for a routine, plan, checklist, ideas, tips, advice, steps, or "what should I do", convert that clause into task rows.
- If user asks for ingredients, recipe, shopping, groceries, supplies, materials, equipment, accessories, gear, tools, packing, or buy-list items, convert that clause into grocery/material rows.
- Casual words like stuff, junk, crap, or things also mean grocery/material rows when attached to a recipe, meal, smoothie, project, repair, packing, or buying clause.
- If a clause says buy/get/grab/pick up a normal grocery item such as eggs, milk, bread, fruit, or rice, convert that clause into grocery/material rows instead of a task.
- If ambiguous, prefer task rows.
- For actionable input, return at least one task or grocery/material row.`;
const AI_ROUTE_OUTPUT_RULES = `Output rules:
- Return only the requested structured JSON/tool input.
- This app schema uses tasks and grocery arrays; use an empty array for the side that has no rows, but never return both arrays empty for actionable input.
- Do not duplicate the same clause as both a task and grocery/material row unless the user clearly asks for both an action and items.`;
const OPENAI_ROUTE_EXAMPLES = `

GPT routing examples:
Input: "chest workout routine"
Output: {"tasks":[{"text":"Warm up 10 minutes","tier":"medium"},{"text":"Barbell bench press 4x8","tier":"medium"},{"text":"Incline dumbbell press 3x10","tier":"medium"},{"text":"Cable flyes 3x12","tier":"low"},{"text":"Push-ups 2 sets to failure","tier":"low"}],"grocery":[]}

Input: "ingredients for shawarma"
Output: {"tasks":[],"grocery":[{"name":"chicken","quantity":"1","unit":"lb","packageSize":"1 lb package","category":"Meat & Seafood"},{"name":"garlic","quantity":"2","unit":"cloves","packageSize":"1 bulb","category":"Produce"},{"name":"plain yogurt","quantity":"1","unit":"cup","packageSize":"32 oz tub","category":"Dairy"},{"name":"pita bread","quantity":"4","unit":"pieces","packageSize":"6-count pack","category":"Bakery"},{"name":"shawarma seasoning","quantity":"2","unit":"tbsp","packageSize":"2 oz jar","category":"Canned & Dry Goods"}]}

Input: "need a workout plan and meal prep list"
Output: {"tasks":[{"text":"Warm up 10 minutes","tier":"medium"},{"text":"Goblet squats 3x12","tier":"medium"},{"text":"Push-ups 3x10","tier":"medium"},{"text":"Dumbbell rows 3x10","tier":"medium"},{"text":"Plank 3x30 sec","tier":"low"}],"grocery":[{"name":"chicken breast","quantity":"1","unit":"lb","packageSize":"1 lb package","category":"Meat & Seafood"},{"name":"quinoa","quantity":"1","unit":"cup","packageSize":"1 lb bag","category":"Canned & Dry Goods"},{"name":"broccoli","quantity":"2","unit":"cups","packageSize":"12 oz bag","category":"Produce"},{"name":"mixed greens","quantity":"4","unit":"cups","packageSize":"5 oz clamshell","category":"Produce"},{"name":"Greek yogurt","quantity":"1","unit":"cup","packageSize":"32 oz tub","category":"Dairy"}]}`;

const LISTS = [
  {
    id: 'personal',
    name: 'To do',
    tasks: [
      { text: 'call dentist', tier: 'medium' },
      { text: 'pay electric bill', tier: 'high' },
    ],
  },
  {
    id: 'workout',
    name: 'Workout',
    tasks: [
      { text: 'chest workout routine', tier: 'medium' },
      { text: 'stretch shoulders', tier: 'low' },
    ],
  },
  {
    id: 'biomed',
    name: 'Biomed',
    tasks: [
      { text: 'build BoM for sv4 and 8', tier: 'high' },
      { text: 'revise hardware list', tier: 'medium' },
    ],
  },
  {
    id: 'bodywork',
    name: 'Body Work',
    tasks: [
      { text: 'schedule body scan equipment check', tier: 'medium' },
      { text: 'review breathing sensor notes', tier: 'low' },
    ],
  },
];

const CASES = {
  'grocery-workout': {
    screen: 'grocery',
    input: 'give me a workout routine',
    expect: { minTasks: 3, maxGrocery: 0, taskList: 'workout', noReminders: true },
  },
  'grocery-mixed': {
    screen: 'grocery',
    input: 'need workout routine and smoothie ingredients',
    expect: { minTasks: 3, minGrocery: 2, taskList: 'workout', noReminders: true },
  },
  'grocery-field-report': {
    screen: 'grocery',
    input: 'creating workout plan walking dog at 3 call grandma tomorrow and recovery smoothie ingredients',
    expect: {
      minTasks: 3,
      minGrocery: 2,
      hasLists: ['personal', 'workout'],
      hasReminder: true,
      maxReminders: 1,
      reminderTaskText: ['dog'],
      taskTextList: [{ text: 'dog', listId: 'personal' }],
      forbiddenListTaskText: [
        { text: 'warm', listId: 'personal' },
        { text: 'cool', listId: 'personal' },
        { text: 'interval', listId: 'personal' },
        { text: 'squat', listId: 'personal' },
        { text: 'plank', listId: 'personal' },
        { text: 'press', listId: 'personal' },
        { text: 'walk 20', listId: 'personal' },
        { text: 'walk 30', listId: 'personal' },
      ],
      forbiddenTaskText: ['write workout plan', 'workout plan for this week', 'set weekly frequency', 'choose rep ranges', 'pick 3-5 compound', 'define sets', 'write progression', 'add rest days'],
      noReminderTaskText: ['grandma'],
    },
  },
  'grocery-exact-biomed-workout-smoothie': {
    screen: 'grocery',
    input: 'I need a walk the dog call Grandma tomorrow at 3:00 fix one of my biomedical units test the blue stack workflow and I need a chest workout routine and recovery smoothie ingredients',
    expect: {
      minTasks: 7,
      minGrocery: 2,
      hasLists: ['personal', 'workout', 'biomed'],
      hasReminder: true,
      maxReminders: 1,
      reminderTaskText: ['grandma'],
      noReminderTaskText: ['dog'],
      taskTextList: [
        { text: 'dog', listId: 'personal' },
        { text: 'grandma', listId: 'personal' },
        { text: 'biomedical', listId: 'biomed' },
      ],
      taskTextMaxCount: [
        { text: 'biomedical', max: 1 },
        { text: 'bluestack', max: 1 },
      ],
      forbiddenTaskText: ['fix one of my biomedical units test', 'choose rep ranges', 'pick exercises', 'define sets'],
      forbiddenGroceryText: ['1 spinach', '1 greek yogurt', '1 frozen mixed berries', '1 chia seeds', '1 tub whey'],
      minWorkoutDetailRows: 3,
      workoutTextNeedsDetail: ['bench', 'incline', 'fly', 'push'],
    },
  },
  'grocery-direct-filler-duplicate': {
    screen: 'grocery',
    input: 'i need a chect workout routine and ingredients for a recovery smoothie. i also need to walk the dog tomorrow at 3 and call grandma at some point',
    expect: {
      minTasks: 5,
      minGrocery: 2,
      hasLists: ['personal', 'workout'],
      hasReminder: true,
      maxReminders: 1,
      reminderTaskText: ['dog'],
      noReminderTaskText: ['grandma'],
      taskTextList: [
        { text: 'dog', listId: 'personal' },
        { text: 'grandma', listId: 'personal' },
      ],
      taskTextMaxCount: [
        { text: 'grandma', max: 1 },
      ],
    },
  },
  'grocery-direct-filler-duplicate-general': {
    screen: 'grocery',
    input: 'i need a weekend packing checklist and snacks to buy. also email alex later and text sam at some point',
    expect: {
      minTasks: 5,
      minGrocery: 2,
      hasLists: ['personal'],
      noReminders: true,
      taskTextList: [
        { text: 'alex', listId: 'personal' },
        { text: 'sam', listId: 'personal' },
      ],
      taskTextMaxCount: [
        { text: 'alex', max: 1 },
        { text: 'sam', max: 1 },
      ],
    },
  },
  'grocery-reminder': {
    screen: 'grocery',
    input: 'call grandma at 4',
    expect: { minTasks: 1, maxGrocery: 0, taskList: 'personal', hasReminder: true },
  },
  'task-split': {
    screen: 'tasks',
    input: 'call grandma at 4 and workout later',
    expect: { minTasks: 2, hasLists: ['personal', 'workout'], hasReminder: true },
  },
  'biomed-context': {
    screen: 'tasks',
    input: 'fix sv4 unit',
    expect: { minTasks: 1, taskList: 'biomed', noGrocery: true },
  },
  'todo-messy-plan-ingredients': {
    screen: 'tasks',
    input: 'i need to walk the dog call ghrandma tomorrow as well as a meditation plan and ingredients for banana bread',
    expect: {
      minTasks: 5,
      minGrocery: 4,
      taskList: 'personal',
      noReminders: true,
      taskTextList: [
        { text: 'dog', listId: 'personal' },
        { text: 'grand', listId: 'personal' },
      ],
      forbiddenListTaskText: [
        { text: 'breath', listId: 'bodywork' },
        { text: 'body', listId: 'bodywork' },
        { text: 'scan', listId: 'bodywork' },
      ],
    },
  },
  'todo-direct-mixed-eggs-pushups-biomed': {
    screen: 'tasks',
    input: 'call grandma tomorrow at 4 walk the dog get eggs do pushups and fix sv4 biomed unit',
    expect: {
      minTasks: 4,
      minGrocery: 1,
      hasLists: ['personal', 'workout', 'biomed'],
      maxReminders: 1,
      reminderTaskText: ['grandma'],
      taskTextList: [
        { text: 'grandma', listId: 'personal' },
        { text: 'dog', listId: 'personal' },
        { text: 'push', listId: 'workout' },
        { text: 'sv4', listId: 'biomed' },
      ],
      groceryText: ['eggs'],
      forbiddenListTaskText: [
        { text: 'eggs', listId: 'personal' },
      ],
    },
  },
  'generic-checklist': {
    screen: 'tasks',
    input: 'give me a checklist for cleaning the bathroom',
    expect: { minTasks: 3, maxTasks: 5, maxGrocery: 0, taskList: 'personal', noReminders: true },
  },
  'project-mixed': {
    screen: 'tasks',
    input: 'give me a checklist and supplies for painting a bedroom',
    expect: { minTasks: 3, maxTasks: 5, minGrocery: 2, maxGrocery: 8, taskList: 'personal', noReminders: true },
  },
  'meditation-routine': {
    screen: 'tasks',
    input: 'give me a meditation routine',
    expect: { minTasks: 3, maxTasks: 5, maxGrocery: 0, taskList: 'personal', noReminders: true },
  },
  'sleep-tips': {
    screen: 'tasks',
    input: 'give me tips for better sleep',
    expect: { minTasks: 3, maxTasks: 5, maxGrocery: 0, taskList: 'personal', noReminders: true },
  },
  'packing-and-snacks': {
    screen: 'tasks',
    input: 'make me a packing checklist for a weekend trip and snacks to buy',
    expect: { minTasks: 3, maxTasks: 5, minGrocery: 2, maxGrocery: 8, taskList: 'personal', noReminders: true },
  },
  'wheelchair-health': {
    screen: 'tasks',
    input: 'give me healthy things to incorporate every day',
    personalContext: 'I am in a wheelchair and cannot do tasks that require standing.',
    expect: {
      minTasks: 3,
      maxTasks: 5,
      maxGrocery: 0,
      taskList: 'personal',
      noReminders: true,
      forbiddenTaskText: ['walk', 'walking', 'run', 'standing', 'step outside', 'take a stroll'],
    },
  },
  'deaf-meditation': {
    screen: 'tasks',
    input: 'give me a calming meditation routine',
    personalContext: 'I am deaf.',
    expect: {
      minTasks: 3,
      maxTasks: 5,
      maxGrocery: 0,
      taskList: 'personal',
      noReminders: true,
      forbiddenTaskText: ['listen', 'music', 'audio', 'sound bath', 'podcast'],
    },
  },
  'vegan-ingredients': {
    screen: 'grocery',
    input: 'ingredients for chili',
    personalContext: 'I hate meat, I am vegan, do not include anything with animal products.',
    expect: {
      minGrocery: 3,
      maxGrocery: 8,
      noTasks: true,
      forbiddenGroceryText: ['beef', 'chicken', 'turkey', 'pork', 'yogurt', 'milk', 'cheese', 'butter', 'egg', 'honey', 'whey'],
    },
  },
  'faucet-supplies': {
    screen: 'grocery',
    input: 'supplies for fixing a leaky faucet',
    expect: { minGrocery: 3, maxGrocery: 8, noTasks: true, noReminders: true },
  },
  'phone-setup-mixed': {
    screen: 'tasks',
    input: 'give me a checklist for setting up a new phone and accessories to buy',
    expect: { minTasks: 3, maxTasks: 5, minGrocery: 2, maxGrocery: 8, taskList: 'personal', noReminders: true },
  },
  'desk-tips': {
    screen: 'tasks',
    input: 'give me tips to organize my desk',
    expect: { minTasks: 3, maxTasks: 5, maxGrocery: 0, taskList: 'personal', noReminders: true },
  },
  'repeat-reminder': {
    screen: 'tasks',
    input: 'remind me every 2 hours to stretch',
    expect: { minTasks: 1, maxGrocery: 0, taskList: 'workout', hasReminder: true },
  },
  'appointment-tomorrow-330': {
    screen: 'tasks',
    input: 'i have an appointment tomorrow at 330',
    expect: {
      minTasks: 1,
      maxTasks: 1,
      maxGrocery: 0,
      taskList: 'personal',
      hasReminder: true,
      reminderTaskText: ['appointment'],
      forbiddenTaskText: ['tomorrow', '330'],
    },
  },
  'wake-up-three-days': {
    screen: 'tasks',
    input: 'remind me to wake up at 8 in 3 days',
    expect: {
      minTasks: 1,
      maxTasks: 1,
      maxGrocery: 0,
      taskList: 'personal',
      hasReminder: true,
      reminderTaskText: ['wake'],
      forbiddenTaskText: ['3 days'],
    },
  },
  'uber-pt-compact-time': {
    screen: 'tasks',
    input: 'call physical therapy for Uber at 1230',
    expect: {
      minTasks: 1,
      maxTasks: 1,
      maxGrocery: 0,
      taskList: 'personal',
      hasReminder: true,
      reminderTaskText: ['physical'],
      forbiddenTaskText: ['1230'],
    },
  },
  'casual-shit-to-do': {
    screen: 'tasks',
    input: 'shit to do today clean bathroom email Alex at 4 and fix ring doorbell',
    expect: {
      minTasks: 3,
      maxGrocery: 0,
      taskList: 'personal',
      hasReminder: true,
      reminderTaskText: ['alex'],
      taskTextList: [
        { text: 'bathroom', listId: 'personal' },
        { text: 'alex', listId: 'personal' },
        { text: 'ring', listId: 'personal' },
      ],
      noReminderTaskText: ['bathroom', 'ring'],
    },
  },
  'repair-materials-casual': {
    screen: 'grocery',
    input: 'stuff to buy to fix a leaky sink',
    expect: { minGrocery: 4, maxTasks: 0, noReminders: true, groceryText: ['tape'] },
  },
  'criteria-smoothie': {
    screen: 'grocery',
    input: 'ingredients for a high protein smoothie with no banana',
    expect: { minGrocery: 4, maxTasks: 0, noReminders: true, forbiddenGroceryText: ['banana'], groceryText: ['protein'] },
  },
  'project-materials-budget': {
    screen: 'grocery',
    input: 'materials for building a small shelf under 50 bucks',
    expect: { minGrocery: 4, maxTasks: 0, noReminders: true, groceryText: ['screw'] },
  },
  'biomed-supplies-context': {
    screen: 'tasks',
    input: 'order quick crimps for sv4',
    expect: { minTasks: 1, maxGrocery: 0, taskList: 'biomed', noReminders: true },
  },
  'date-only-and-number-control': {
    screen: 'tasks',
    input: 'call grandma tomorrow and order 12 quick crimps for sv4',
    expect: {
      minTasks: 2,
      maxGrocery: 0,
      hasLists: ['personal', 'biomed'],
      noReminders: true,
      taskTextList: [
        { text: 'grandma', listId: 'personal' },
        { text: 'crimps', listId: 'biomed' },
      ],
    },
  },
  'messy-household-capture': {
    screen: 'tasks',
    input: 'tomorrow clean fridge call alex at 445 get batteries and give me a quick garage cleanup checklist',
    expect: {
      minTasks: 5,
      minGrocery: 1,
      maxGrocery: 4,
      taskList: 'personal',
      hasReminder: true,
      maxReminders: 1,
      reminderTaskText: ['alex'],
      noReminderTaskText: ['fridge', 'garage'],
      groceryText: ['batter'],
    },
  },
  'recipe-no-extra-control': {
    screen: 'grocery',
    input: 'ingredients for pancakes but no extras only basic ingredients',
    expect: {
      minGrocery: 3,
      maxGrocery: 8,
      maxTasks: 0,
      noReminders: true,
      forbiddenGroceryText: ['cinnamon', 'vanilla', 'nutmeg', 'berries', 'syrup'],
    },
  },
  'recipe-seasoning-needed': {
    screen: 'grocery',
    input: 'ingredients for chicken fajitas',
    expect: {
      minGrocery: 5,
      maxTasks: 0,
      noReminders: true,
      groceryText: ['pepper'],
    },
  },
};

const PROMPT_VARIANTS = new Set(['full', 'compact', 'lean']);

function parseArgs(argv) {
  const out = { provider: 'openai', caseName: 'all', promptVariant: 'compact', measureOnly: false, modelOverride: '', localReminderOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--provider') out.provider = argv[++i] || out.provider;
    else if (value === '--case') out.caseName = argv[++i] || out.caseName;
    else if (value === '--model') out.modelOverride = argv[++i] || '';
    else if (value === '--prompt') out.prompt = argv[++i] || '';
    else if (value === '--prompt-variant') out.promptVariant = argv[++i] || out.promptVariant;
    else if (value === '--measure') out.measureOnly = true;
    else if (value === '--local-reminder') out.localReminderOnly = true;
  }
  return out;
}

function readSecret(provider) {
  const meta = PROVIDERS[provider];
  if (!meta) throw new Error(`Unknown provider "${provider}". Use ${Object.keys(PROVIDERS).join(', ')}.`);
  const file = path.join(SECRETS_DIR, meta.secretFile);
  return fs.readFileSync(file, 'utf8').trim();
}

function isAnthropicProvider(provider) {
  return provider === 'claude-haiku' || provider === 'claude';
}

function normalizeAiListText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/\bblue\s+stacks?\b/g, 'bluestacks')
    .replace(/\bwork\s+out\b/g, 'workout')
    .replace(/\bto\s+do\b/g, 'todo')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AI_LIST_GENERIC_TOKENS = new Set([
  'a', 'an', 'and', 'for', 'in', 'list', 'main', 'my', 'need', 'needs', 'of', 'on', 'our',
  'body', 'shared', 'task', 'tasks', 'the', 'to', 'todo', 'work',
]);
const AI_TASK_TEXT_STOP_TOKENS = new Set([
  'a', 'add', 'an', 'and', 'can', 'create', 'do', 'for', 'i', 'me', 'my', 'need',
  'have', 'please', 'put', 'remember', 'task', 'the', 'to', 'with',
]);
const AI_ROUTING_SAMPLE_STOP_TOKENS = new Set([
  'add', 'added', 'ask', 'call', 'check', 'create', 'do', 'fix', 'get', 'give', 'make',
  'need', 'order', 'put', 'remind', 'rub', 'set', 'task', 'tell', 'text', 'walk',
  'advice', 'checklist', 'idea', 'plan', 'program', 'routine', 'step', 'suggestion', 'thing', 'tip',
]);

function normalizeAiNameToken(token) {
  let out = normalizeAiListText(token);
  if (out.endsWith('s') && out.length > 3) out = out.slice(0, -1);
  return out;
}

function normalizedAiTokens(value) {
  return normalizeAiListText(value).split(' ').map(normalizeAiNameToken).filter(Boolean);
}

function meaningfulTaskTextTokens(value) {
  return Array.from(new Set(
    normalizedAiTokens(value)
      .filter(token => token.length >= 3 && !AI_TASK_TEXT_STOP_TOKENS.has(token)),
  ));
}

function aiTextHasToken(value, token) {
  const needle = normalizeAiNameToken(token);
  if (!needle) return false;
  return normalizedAiTokens(value).some(candidate => (
    candidate === needle
    || aiTokensCloseEnough(candidate, needle)
    || (needle.length >= 5 && candidate.length >= needle.length + 2 && candidate.startsWith(needle))
    || (candidate.length >= 5 && needle.length >= candidate.length + 2 && needle.startsWith(candidate))
  ));
}

function getTaskListSignalTokens(listName) {
  return Array.from(new Set(
    normalizedAiTokens(listName).filter(token => token.length >= 3 && !AI_LIST_GENERIC_TOKENS.has(token)),
  ));
}

function inputMentionsTaskListName(input, listName) {
  const normalizedInput = ` ${normalizeAiListText(input)} `;
  const normalizedName = normalizeAiListText(listName);
  return normalizedName.length >= 2 && normalizedInput.includes(` ${normalizedName} `);
}

function inputMentionsTaskListSignal(input, list) {
  const tokens = getTaskListSignalTokens(list.name);
  return tokens.length > 0 && tokens.some(token => aiTextHasToken(input, token));
}

function routingSampleTokens(value) {
  return normalizedAiTokens(value)
    .filter(token => token.length > 2 && !AI_TASK_TEXT_STOP_TOKENS.has(token) && !AI_ROUTING_SAMPLE_STOP_TOKENS.has(token));
}

function inferTaskDestinationHint(input, lists, activeListId) {
  const uniqueMatch = (matches, reason) => {
    const uniqueIds = Array.from(new Set(matches.map(list => list.id)));
    if (uniqueIds.length !== 1) return null;
    const list = matches.find(item => item.id === uniqueIds[0]);
    return list ? { listId: list.id, listName: list.name, active: list.id === activeListId, reason } : null;
  };
  return uniqueMatch(lists.filter(list => inputMentionsTaskListName(input, list.name)), 'exact-list-name')
    ?? uniqueMatch(lists.filter(list => inputMentionsTaskListSignal(input, list)), 'list-name-signal');
}

function inferTaskListFromExistingRows(text, lists) {
  const inputTokens = new Set(routingSampleTokens(text));
  if (inputTokens.size === 0) return null;
  let best = null;
  let secondScore = 0;
  for (const list of lists) {
    const listTokens = new Set(list.tasks.flatMap(task => routingSampleTokens(task.text)));
    let score = 0;
    inputTokens.forEach(token => { if (listTokens.has(token)) score += 1; });
    if (score > (best?.score ?? 0)) {
      secondScore = best?.score ?? 0;
      best = { listId: list.id, score };
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  return best && best.score > 0 && best.score > secondScore ? best.listId : null;
}

function inferTaskListFromListNameSignal(text, lists) {
  const exactMatches = lists.filter(list => inputMentionsTaskListName(text, list.name));
  const signalMatches = lists.filter(list => inputMentionsTaskListSignal(text, list));
  const uniqueIds = Array.from(new Set([...exactMatches, ...signalMatches].map(list => list.id)));
  return uniqueIds.length === 1 ? uniqueIds[0] : null;
}

function hasTaskGenerationIntent(input) {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (/\b(remind me|set a reminder|add (a )?task|todo|to-do)\b/i.test(normalized)) return false;
  if (/\bneed to\s+(create|make|build|write|draft|prepare|finish|do|plan)\b/i.test(normalized)) return false;
  return /\b(workout|exercise|training)\s+(routine|plan|program)\b/i.test(normalized)
    || (/\b(routine|plan|program|checklist|steps?|ideas?|suggestions?|tips?|advice|things to|ways to|healthy things|daily habits?)\b/i.test(normalized)
      && /\b(give me|suggest|recommend|ideas?|i need|need|want|build me|make me|create me|come up with|help me)\b/i.test(normalized));
}

function shouldInferGroceryQuantities(input) {
  return /\b(recipe|ingredients?|bake|cook|meal prep|materials?|equipment|accessories|gear|tools?|bill of materials|bom|project|build|repair|supplies for|shopping list for|list for|to buy|buying|purchase|make a|make an)\b/i.test(input)
    || /\b(smoothie|meal|dinner|lunch|breakfast|recipe|project|repair|packing|trip|paint|painting|phone|desk|sink|faucet)\b.{0,28}\b(stuff|junk|crap|things)\b/i.test(input)
    || /\b(stuff|junk|crap|things)\b.{0,28}\b(for|to make|to build|to buy|to purchase|to fix|needed for|for making|for a|for an)\b/i.test(input);
}

function hasGroceryGenerationIntent(input) {
  const normalized = input.replace(/\s+/g, ' ').trim();
  return hasDirectGroceryAcquisitionIntent(normalized)
    || (shouldInferGroceryQuantities(normalized)
    && (/\b(ingredients?|supplies|materials?|equipment|accessories|gear|tools?|items)\b.{0,32}\b(for|to make|to build|to buy|to purchase|needed for|for making|for a|for an)\b/i.test(normalized)
      || /\b([a-z0-9]+[-\s]+)?ingredients?\b/i.test(normalized)
      || /\b(snacks?|items?|groceries|supplies|materials?|equipment|accessories|gear|tools?)\s+to\s+(buy|purchase)\b/i.test(normalized)
      || /\b(shopping|grocery|groceries|meal[-\s]?prep|meal plan|meal planning|prep)\s+(list|items?|groceries|ingredients?)\b/i.test(normalized)
      || /\b(pack(?:ing)?|buy|purchase|shopping|supply|supplies|materials?|equipment|accessories|gear|tools?)\s+(list|items?)\b/i.test(normalized)
      || /\b(smoothie|meal|dinner|lunch|breakfast|recipe|project|repair|packing|trip|paint|painting|phone|desk|sink|faucet)\b.{0,28}\b(stuff|junk|crap|things)\b/i.test(normalized)
      || /\b(stuff|junk|crap|things)\b.{0,28}\b(for|to make|to build|to buy|to purchase|to fix|needed for|for making|for a|for an)\b/i.test(normalized)
      || /\b(accessories|equipment|gear|tools?)\b.{0,32}\b(to buy|to purchase|for|needed for)\b/i.test(normalized)
      || /\b(list|items?|groceries|ingredients?|supplies|materials?|equipment|accessories|gear|tools?)\s+(for|to make|to build|to buy|to purchase|to pack)\s+(meal[-\s]?prep|meal plan|meal planning|dinner|lunch|breakfast|recipe|recipes?|project|trip|travel|move|moving|school|work|office|home|repair|build|phone|computer|desk|bedroom)\b/i.test(normalized)));
}

function extractGroceryGenerationClause(input) {
  const normalized = input.replace(/\s+/g, ' ').trim();
  const match = normalized.match(/\b(?:and|plus|also|with)?\s*((ingredients?|supplies|materials?|equipment|accessories|gear|tools?|items|stuff|junk|crap|things)\b.{0,32}\b(?:for|to make|to build|to buy|to purchase|to fix|needed for|for making|for a|for an)\b.+|(smoothie|meal|dinner|lunch|breakfast|recipe|project|repair|packing|trip|paint|painting|phone|desk|sink|faucet)\b.{0,32}\b(stuff|junk|crap|things)\b.*|(shopping|grocery|groceries|meal[-\s]?prep|meal plan|meal planning|prep)\s+(list|items?|groceries|ingredients?)\b.*|(pack(?:ing)?|buy|purchase|shopping|supply|supplies|materials?|equipment|accessories|gear|tools?)\s+(list|items?)\b.*|(list|items?|groceries|ingredients?|supplies|materials?|equipment|accessories|gear|tools?)\s+(for|to make|to build|to buy|to purchase|to pack)\s+(meal[-\s]?prep|meal plan|meal planning|dinner|lunch|breakfast|recipe|recipes?|project|trip|travel|move|moving|school|work|office|home|repair|build|phone|computer|desk|bedroom)\b.*)$/i);
  if (!match || match.index == null) return normalized;
  return normalized.slice(match.index).replace(/^(and|plus|also|with)\s+/i, '').trim();
}

function groceryDraftLooksLikeGenerationPlaceholder(item, input) {
  if (!hasGroceryGenerationIntent(input)) return false;
  const name = String(item.name || '').replace(/\s+/g, ' ').trim();
  if (!name) return false;
  if (/\b(ingredients?|shopping list|grocery list|groceries|snacks?|supplies|materials?|equipment|accessories|gear|tools?|items|meal[-\s]?prep list|meal plan list|packing list|pack list|buy list|purchase list)\b/i.test(name)) return true;
  if (/^(for|to make|to build|needed for)\b/i.test(name)) return true;
  return false;
}

function groceryDraftsNeedGenerationRetry(items, input) {
  if (!hasGroceryGenerationIntent(input)) return false;
  if (items.length === 0) return true;
  if (items.length > 2) return false;
  return items.some(item => groceryDraftLooksLikeGenerationPlaceholder(item, input));
}

function groceryDraftsNeedPackageSizeRetry(items, input) {
  if (!shouldInferGroceryQuantities(input) || !hasGroceryGenerationIntent(input)) return false;
  const meaningful = items.filter(item => !groceryDraftLooksLikeGenerationPlaceholder(item, input));
  if (meaningful.length < 2) return false;
  const withPackageSize = meaningful.filter(item => !!cleanPackageSize(item.packageSize)).length;
  return withPackageSize < Math.ceil(meaningful.length * 0.6);
}

function groceryDraftsNeedNeededAmountRetry(items, input) {
  if (!shouldInferGroceryQuantities(input) || !hasGroceryGenerationIntent(input)) return false;
  if (!/\b(recipe|ingredients?|smoothie|meal[-\s]?prep|meal[-\s]?plan|meal|dinner|lunch|breakfast|cook|bake)\b/i.test(input)) return false;
  const meaningful = items.filter(item => !groceryDraftLooksLikeGenerationPlaceholder(item, input));
  if (meaningful.length < 2) return false;
  const withNeededAmount = meaningful.filter(item => {
    const quantity = cleanOptionalGroceryPart(item.quantity);
    const unit = cleanOptionalGroceryPart(item.unit);
    return !!quantity && (!!unit || !groceryQuantityIsBareOne(quantity));
  }).length;
  return withNeededAmount < Math.ceil(meaningful.length * 0.6);
}

const DIRECT_GROCERY_ITEM_PATTERNS = [
  { re: /\beggs?\b/i, name: 'eggs', category: 'Dairy' },
  { re: /\bmilk\b/i, name: 'milk', category: 'Dairy' },
  { re: /\bcheese\b/i, name: 'cheese', category: 'Dairy' },
  { re: /\byogurt\b/i, name: 'yogurt', category: 'Dairy' },
  { re: /\bbutter\b/i, name: 'butter', category: 'Dairy' },
  { re: /\bbananas?\b/i, name: 'bananas', category: 'Produce' },
  { re: /\bapples?\b/i, name: 'apples', category: 'Produce' },
  { re: /\bberries\b/i, name: 'berries', category: 'Produce' },
  { re: /\bspinach\b/i, name: 'spinach', category: 'Produce' },
  { re: /\bonions?\b/i, name: 'onions', category: 'Produce' },
  { re: /\bgarlic\b/i, name: 'garlic', category: 'Produce' },
  { re: /\bbread\b/i, name: 'bread', category: 'Bakery' },
  { re: /\bflou?r\b/i, name: 'flour', category: 'Canned & Dry Goods' },
  { re: /\bsugar\b/i, name: 'sugar', category: 'Canned & Dry Goods' },
  { re: /\brice\b/i, name: 'rice', category: 'Canned & Dry Goods' },
  { re: /\bcoffee\b/i, name: 'coffee', category: 'Beverages' },
  { re: /\bcereal\b/i, name: 'cereal', category: 'Canned & Dry Goods' },
];

function hasDirectGroceryAcquisitionIntent(input) {
  const normalized = input.replace(/\s+/g, ' ').trim();
  return /\b(buy|grab|get|pick up|pickup|purchase)\b/i.test(normalized)
    && DIRECT_GROCERY_ITEM_PATTERNS.some(({ re }) => re.test(normalized));
}

function directGroceryDraftsFromRaw(input) {
  if (!hasDirectGroceryAcquisitionIntent(input)) return [];
  return DIRECT_GROCERY_ITEM_PATTERNS
    .filter(({ re }) => re.test(input))
    .map(({ name, category }) => ({ name, category }));
}

function mergeRecoveredGroceryDrafts(items, input) {
  const existing = new Set(items.map(item => normalizeAiNameToken(item.name || '')));
  const recovered = directGroceryDraftsFromRaw(input)
    .filter(item => {
      const key = normalizeAiNameToken(item.name);
      if (!key || existing.has(key)) return false;
      existing.add(key);
      return true;
    });
  return recovered.length > 0 ? [...items, ...recovered] : items;
}

function hasDirectTaskActionIntent(input) {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (/\b(remind me|set a reminder|add (a )?task|todo|to-do)\b/i.test(normalized)) return true;
  const actionVerb = /\b(call|text|email|schedule|book|pay|order|fix|repair|clean|finish|submit|send|test|workout|exercise|train|walk|walking|wake|rub)\b/i;
  if (new RegExp(`^\\s*${actionVerb.source}`, 'i').test(normalized)) return true;
  return actionVerb.test(normalized)
    && /\b(today|tomorrow|tonight|later|this morning|this afternoon|this evening|morning|afternoon|evening|noon|midnight|at\s+\d{1,2}|around\s+\d{1,2}|round\s+\d{1,2}|by\s+\d{1,2}|in\s+\d+\s*(m|min|mins|minutes|h|hr|hrs|hours|days?)|\d{1,2}(:\d{2})?\s*(am|pm|a|p))\b/i.test(normalized);
}

function hasScheduledEventStatement(input) {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!aiTextHasReminderCue(normalized)) return false;
  return /\b(appointment|appt|meeting|event|reservation|interview|class|shift|therapy|physical therapy|pt|doctor|dentist|visit|pickup|pick\s+up|flight|ride)\b/i.test(normalized)
    && /\b(i have|ive got|i've got|got|have|my|there(?:'| i)?s|there is|need to be|supposed to be)\b/i.test(normalized);
}

function aiTextHasReminderCue(input) {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /\b(remind me|reminder|set a reminder|alarm|notify|notification|repeat|repeating|hourly|daily|weekly)\b/i.test(normalized)
    || /\b(at|around|round|by|before|after)\s+(?:\d{1,2}(?::\d{2}|\s+[0-5]\d)?|\d{3,4})\s*(am|pm|a|p)?\b/i.test(normalized)
    || /\bevery\s+\d+\s*(m|min|mins|minutes|h|hr|hrs|hours|days?|weeks?)\b/i.test(normalized)
    || /\bin\s+\d+\s*(m|min|mins|minutes|h|hr|hrs|hours|days?)\b/i.test(normalized)
    || /\b(?:\d{1,2}:\d{2}|\d{3,4}|\d{1,2})\s*(am|pm)\b/i.test(normalized);
}

function aiReminderTaskTokens(value) {
  return Array.from(new Set(
    normalizeAiListText(value)
      .split(' ')
      .map(normalizeAiNameToken)
      .filter(token => token.length > 2 && !AI_TASK_TEXT_STOP_TOKENS.has(token)),
  ));
}

function aiReminderClauseForTask(raw, taskText) {
  const normalizedRaw = raw.replace(/\s+/g, ' ').trim();
  const clauses = normalizedRaw
    .split(/\s+(?:and|plus|also|then)\s+|[,;]+/i)
    .map(clause => clause.trim())
    .filter(Boolean);
  if (!taskText || clauses.length <= 1) return normalizedRaw;
  const taskTokens = aiReminderTaskTokens(taskText);
  if (taskTokens.length === 0) return normalizedRaw;
  let bestClause = '';
  let bestScore = 0;
  clauses.forEach(clause => {
    const clauseTokens = new Set(aiReminderTaskTokens(clause));
    const score = taskTokens.reduce((sum, token) => sum + (clauseTokens.has(token) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestClause = clause;
    }
  });
  return bestScore > 0 ? bestClause : normalizedRaw;
}

const AI_REMINDER_ACTION_BOUNDARY_TOKENS = new Set([
  'ask', 'book', 'build', 'buy', 'call', 'clean', 'create', 'do', 'draft', 'email', 'exercise',
  'feed', 'finish', 'fix', 'get', 'grab', 'make', 'message', 'order', 'pack', 'pay', 'pick',
  'prepare', 'repair', 'review', 'rub', 'schedule', 'send', 'set', 'submit', 'take', 'tell',
  'test', 'text', 'train', 'wake', 'walk', 'walking', 'wash', 'workout', 'write',
]);

const AI_REMINDER_MATCH_STOP_TOKENS = new Set([
  'ask', 'book', 'build', 'buy', 'call', 'clean', 'create', 'do', 'draft', 'email', 'exercise',
  'feed', 'finish', 'fix', 'get', 'grab', 'make', 'message', 'order', 'pack', 'pay', 'pick',
  'prepare', 'repair', 'review', 'rub', 'schedule', 'send', 'set', 'submit', 'take', 'tell',
  'test', 'text', 'train', 'wake', 'walk', 'walking', 'wash', 'workout', 'write',
  'advice', 'checklist', 'item', 'items', 'plan', 'program', 'routine', 'row', 'rows',
  'session', 'sessions', 'step', 'steps', 'task', 'tasks', 'thing', 'things', 'tip', 'tips',
  'hour', 'hours', 'hr', 'hrs', 'minute', 'minutes', 'min', 'mins', 'today', 'tomorrow', 'tonight',
]);

function aiReminderTokensMatch(a, b) {
  return a === b
    || (a.length >= 4 && b.startsWith(a))
    || (b.length >= 4 && a.startsWith(b));
}

function aiReminderMeaningTokens(value) {
  return aiReminderTaskTokens(value)
    .filter(token => !/^\d+$/.test(token) && !AI_REMINDER_MATCH_STOP_TOKENS.has(token));
}

function aiReminderClauseMatchesTask(clause, taskText, raw = '') {
  if (!taskText) return true;
  const taskTokens = aiReminderMeaningTokens(taskText);
  if (taskTokens.length === 0) return !hasTaskGenerationIntent(raw);
  const clauseTokens = aiReminderMeaningTokens(clause);
  const overlap = taskTokens.filter(taskToken =>
    clauseTokens.some(clauseToken => aiReminderTokensMatch(taskToken, clauseToken))
  ).length;
  return overlap >= 1;
}

function aiReminderLocalClauseForTask(raw, taskText) {
  if (!taskText) return aiReminderClauseForTask(raw, taskText);
  const normalizedRaw = normalizeAiListText(raw);
  if (!normalizedRaw) return '';
  const taskTokens = aiReminderTaskTokens(taskText);
  if (taskTokens.length === 0) return aiReminderClauseForTask(raw, taskText);
  const rawTokens = normalizedRaw.split(' ').filter(Boolean);
  const matchingIndexes = rawTokens
    .map((rawToken, index) => {
      const matches = taskTokens.some(token => (
        rawToken === token
        || (token.length >= 4 && rawToken.startsWith(token))
        || (rawToken.length >= 4 && token.startsWith(rawToken))
      ));
      return matches ? index : -1;
    })
    .filter(index => index >= 0);
  if (matchingIndexes.length === 0) return '';
  const firstMatch = Math.min(...matchingIndexes);
  const lastMatch = Math.max(...matchingIndexes);
  const connectorBeforeMatch = rawTokens.findIndex((token, index) => (
    index > 0
    && index < firstMatch
    && (token === 'and' || token === 'plus' || token === 'also' || token === 'then')
  ));
  if (/^(remind|remember|notify|alarm|set reminder|set a reminder)\b/i.test(normalizedRaw) && connectorBeforeMatch < 0) {
    return normalizedRaw;
  }
  const starts = rawTokens
    .map((token, index) => AI_REMINDER_ACTION_BOUNDARY_TOKENS.has(token) ? index : -1)
    .filter(index => index >= 0 && index <= firstMatch);
  const nearbyStart = starts.reverse().find(index => firstMatch - index <= 3);
  const start = nearbyStart ?? firstMatch;
  const endBoundary = rawTokens.findIndex((token, index) => (
    index > lastMatch
    && (AI_REMINDER_ACTION_BOUNDARY_TOKENS.has(token) || token === 'and' || token === 'plus' || token === 'also' || token === 'then')
  ));
  const end = endBoundary >= 0 ? endBoundary : rawTokens.length;
  return rawTokens.slice(start, end).join(' ') || aiReminderClauseForTask(raw, taskText);
}

function aiInputAllowsReminder(raw, taskText) {
  const clause = aiReminderLocalClauseForTask(raw, taskText);
  return aiTextHasReminderCue(clause) && aiReminderClauseMatchesTask(clause, taskText, raw);
}

function reminderDateFromClockClause(clause, nowMs = Date.now()) {
  const clockMatch = clause.match(/\b(?:at|around|round|by|before|after)?\s*(?:(\d{3,4})|(\d{1,2})(?::(\d{2})|\s+([0-5]\d))?)\s*(am|pm|a|p)?\b/i);
  if (!clockMatch) return null;
  const compactTime = clockMatch[1];
  let hour = compactTime
    ? Number(compactTime.slice(0, -2))
    : Number(clockMatch[2]);
  const minute = Math.max(0, Math.min(59, Number(compactTime ? compactTime.slice(-2) : (clockMatch[3] ?? clockMatch[4] ?? 0))));
  const suffix = clockMatch[5]?.toLowerCase();
  hour = Math.max(0, Math.min(23, hour));
  if (suffix === 'pm' || suffix === 'p') {
    if (hour < 12) hour += 12;
  } else if (suffix === 'am' || suffix === 'a') {
    if (hour === 12) hour = 0;
  } else if (/\b(wake\s+(?:me\s+)?up|wake|alarm|breakfast|morning)\b/i.test(clause)) {
    if (hour === 12) hour = 0;
  } else if (/\bmorning\b/i.test(clause) && hour === 12) {
    hour = 0;
  } else if (/\b(afternoon|evening|tonight)\b/i.test(clause) && hour >= 1 && hour <= 11) {
    hour += 12;
  } else if (hour >= 1 && hour <= 7) {
    hour += 12;
  } else if (hour >= 8 && hour <= 11) {
    const amCandidate = new Date(nowMs);
    amCandidate.setHours(hour, minute, 0, 0);
    const pmCandidate = new Date(nowMs);
    pmCandidate.setHours(hour + 12, minute, 0, 0);
    if (amCandidate.getTime() >= nowMs - 60000) {
      // Keep AM when it is still the nearest sensible occurrence.
    } else if (pmCandidate.getTime() >= nowMs - 60000) {
      hour += 12;
    }
  }
  const date = new Date(nowMs);
  if (/\btomorrow\b/i.test(clause)) date.setDate(date.getDate() + 1);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() < nowMs - 60000 && !/\btomorrow\b/i.test(clause)) {
    date.setDate(date.getDate() + 1);
  }
  return date;
}

function buildReminderFallbackFromRaw(raw, taskText = '', nowMs = Date.now()) {
  const clause = aiReminderLocalClauseForTask(raw, taskText);
  if (!aiTextHasReminderCue(clause)) return null;
  const now = nowMs;
  const relativeMatch = clause.match(/\bin\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours|days?)\b/i);
  if (relativeMatch) {
    const amount = Math.max(1, Number(relativeMatch[1]));
    const unit = relativeMatch[2].toLowerCase();
    if (/^days?$/i.test(unit)) {
      const clockDate = reminderDateFromClockClause(clause, nowMs);
      if (clockDate) {
        const date = new Date(nowMs);
        date.setDate(date.getDate() + amount);
        date.setHours(clockDate.getHours(), clockDate.getMinutes(), 0, 0);
        return { remindAt: date.getTime(), repeatHourly: false, repeatDaily: false };
      }
    }
    const ms = /^m/.test(unit) ? amount * 60000 : /^h/.test(unit) ? amount * 3600000 : amount * 86400000;
    return { remindAt: now + ms, repeatHourly: false, repeatDaily: false };
  }
  const everyMatch = clause.match(/\bevery\s+(\d+)?\s*(m|min|mins|minutes|h|hr|hrs|hours|days?|day|daily)\b/i);
  if (everyMatch) {
    const amount = Math.max(1, Number(everyMatch[1] ?? 1));
    const unit = everyMatch[2].toLowerCase();
    const clockDate = reminderDateFromClockClause(clause, nowMs);
    if (/^m/.test(unit) || /^h/.test(unit)) {
      const fallbackDelay = /^m/.test(unit) ? amount * 60000 : amount * 3600000;
      return { remindAt: clockDate?.getTime() ?? (now + fallbackDelay), repeatHourly: true, repeatDaily: false };
    }
    const first = clockDate ?? (() => {
      const date = new Date(nowMs);
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
      return date;
    })();
    return { remindAt: first.getTime(), repeatHourly: false, repeatDaily: true };
  }
  const clockDate = reminderDateFromClockClause(clause, nowMs);
  return clockDate ? { remindAt: clockDate.getTime(), repeatHourly: false, repeatDaily: false } : null;
}

function buildLocalReminderFromTaskText(text, nowMs = Date.now()) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw || (!hasDirectTaskActionIntent(raw) && !hasScheduledEventStatement(raw))) return null;
  if (!aiInputAllowsReminder(raw, raw)) return null;
  return buildReminderFallbackFromRaw(raw, raw, nowMs);
}

function taskDraftWithLocalReminder(text, tier = 'medium', reminder = null, nowMs = Date.now()) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const resolvedReminder = reminder || buildLocalReminderFromTaskText(raw, nowMs);
  return {
    text: resolvedReminder ? cleanReminderTimingFromTaskText(raw) : raw,
    tier,
    reminder: resolvedReminder,
  };
}

function shouldAllowAiReminderForTask(raw, taskText = '') {
  if (!aiInputAllowsReminder(raw, taskText)) return false;
  if (!hasTaskGenerationIntent(raw)) return true;
  const normalizedRaw = raw.replace(/\s+/g, ' ').trim();
  const generatedClause = extractTaskGenerationClause(raw);
  if (!generatedClause || generatedClause === normalizedRaw) return true;
  const generatedTokens = new Set(normalizedAiTokens(generatedClause).filter(token => token.length >= 3 && !AI_TASK_TEXT_STOP_TOKENS.has(token)));
  const rowTokens = normalizedAiTokens(taskText).filter(token => token.length >= 3 && !AI_TASK_TEXT_STOP_TOKENS.has(token));
  const rowLooksGeneratedFromClause = rowTokens.some(token => generatedTokens.has(token));
  if (!rowLooksGeneratedFromClause) return true;
  return aiTextHasReminderCue(generatedClause);
}

function explicitGeneratedRowCount(input) {
  const normalized = input.toLowerCase();
  const wordCounts = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const match = normalized.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(tasks?|items?|ideas?|steps?|rows?|things?|exercises?|meals?|groceries|supplies|materials)\b/i);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const value = /^\d+$/.test(raw) ? Number(raw) : wordCounts[raw];
  return Number.isFinite(value) ? Math.max(1, Math.min(12, value)) : null;
}

function asksForLargeGeneratedSet(input) {
  return /\b(full|complete|detailed|comprehensive|everything|all the|whole|weekly|week[-\s]?long|7[-\s]?day|seven[-\s]?day)\b/i.test(input);
}

function generatedTaskLimit(input) {
  if (!hasTaskGenerationIntent(input)) return null;
  const explicit = explicitGeneratedRowCount(input);
  if (explicit) return explicit;
  return asksForLargeGeneratedSet(input) ? 8 : 5;
}

function generatedGroceryLimit(input) {
  if (!hasGroceryGenerationIntent(input)) return null;
  const explicit = explicitGeneratedRowCount(input);
  if (explicit) return explicit;
  return asksForLargeGeneratedSet(input) ? 12 : 8;
}

function trimGeneratedTaskRowsForScope(items, input) {
  const limit = generatedTaskLimit(input);
  return limit ? items.slice(0, limit) : items;
}

function trimGeneratedGroceryRowsForScope(items, input) {
  const limit = generatedGroceryLimit(input);
  return limit ? items.slice(0, limit) : items;
}

function taskLooksLikeGenerationPlaceholder(text, input) {
  if (!hasTaskGenerationIntent(input)) return false;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/^(create|make|build|generate|write|draft|come up with|plan)\s*/i.test(normalized)
    && /\b(workout|routine|plan|program|checklist|steps?|ideas?|suggestions?|tips?|advice|things)\b/i.test(normalized)) {
    return true;
  }
  if (/\b(define sets? and reps?|write progression|add rest days?|set training goal|set strength goals?|set weekly frequency|choose weekly|choose schedule|choose rep ranges?|pick exercises?|pick .*lifts?|choose .*lifts?|select exercises?|select .*lifts?|create grocery list|make grocery list|plan meals?|plan the plan|build (the )?plan|make (the )?list)\b/i.test(normalized)) {
    return true;
  }
  const genericRequestLabel = /\b(workout|routine|plan|program|checklist|steps?|ideas?|suggestions?|tips?|advice|things)\b/i.test(normalized);
  const concreteTaskDetail = /\b(call|text|email|book|schedule|pay|buy|order|clean|wash|pack|review|read|write|draft|submit|send|install|repair|fix|replace|measure|cut|assemble|sort|organize|practice|study|set up|setup|push[-\s]?ups?|bench|press|fly|flies|dumbbell|barbell|cable|machine|incline|decline|dips?|sets?|reps?|plank|row|curl|squat|lunge|deadlift|warm[-\s]?up|cool[-\s]?down|stretch)\b/i.test(normalized);
  return genericRequestLabel && !concreteTaskDetail && normalized.split(/\s+/).length <= 8;
}

function taskRowsNeedGenerationRetry(items, input) {
  if (!hasTaskGenerationIntent(input)) return false;
  if (items.length === 0) return true;
  return items.some(item => taskLooksLikeGenerationPlaceholder(String(item?.text ?? ''), input));
}

function mergeGeneratedTaskRetryRows(items, generatedItems, input) {
  if (generatedItems.length === 0) return items;
  if (items.length === 0) return generatedItems;
  let inserted = false;
  const merged = [];
  items.forEach(item => {
    const placeholder = taskLooksLikeGenerationPlaceholder(String(item?.text ?? ''), input);
    if (placeholder) {
      if (!inserted) {
        merged.push(...generatedItems);
        inserted = true;
      }
      return;
    }
    merged.push(item);
  });
  return inserted ? merged : generatedItems;
}

const AI_TASK_DEDUPE_CONTEXT_TOKENS = new Set([
  'after', 'afternoon', 'around', 'round', 'before', 'eventually', 'evening', 'hour', 'hours',
  'later', 'midnight', 'minute', 'minutes', 'morning', 'noon', 'of', 'one', 'point', 'remind',
  'reminder', 'someday', 'some', 'sometime', 'soon', 'today', 'tomorrow', 'tonight',
  'whenever',
]);

const AI_TASK_DEDUPE_TOKEN_ALIASES = {
  booking: 'book',
  calling: 'call',
  cleaning: 'clean',
  emailing: 'email',
  fixing: 'fix',
  messaging: 'message',
  ordering: 'order',
  paying: 'pay',
  repairing: 'repair',
  scheduling: 'schedule',
  sending: 'send',
  texting: 'text',
  walking: 'walk',
};

function normalizeAiTaskDedupeToken(token) {
  return AI_TASK_DEDUPE_TOKEN_ALIASES[token] ?? token;
}

function aiTaskDedupeKey(value) {
  const tokens = Array.from(new Set(normalizedAiTokens(value)
    .map(normalizeAiTaskDedupeToken)
    .filter(token => (
      token.length >= 3
      && !AI_TASK_TEXT_STOP_TOKENS.has(token)
      && !AI_TASK_DEDUPE_CONTEXT_TOKENS.has(token)
      && !/^\d+$/.test(token)
    ))));
  return tokens.length > 0 ? tokens.join(' ') : normalizeAiListText(value);
}

function aiTaskDedupeKeysMatch(a, b) {
  if (a === b) return true;
  const left = a.split(' ').filter(Boolean);
  const right = b.split(' ').filter(Boolean);
  return left.length === right.length
    && left.every((token, index) => aiTokensCloseEnough(token, right[index] ?? ''));
}

function dedupeAiTaskRows(items) {
  const seen = [];
  return items.filter((item) => {
    const key = aiTaskDedupeKey(String(item?.text ?? ''));
    if (!key) return false;
    if (seen.some(existing => aiTaskDedupeKeysMatch(key, existing))) return false;
    seen.push(key);
    return true;
  });
}

function aiTaskKeyTokens(value) {
  return aiTaskDedupeKey(value).split(' ').filter(Boolean);
}

function aiTaskTokensContainAll(container, subset) {
  return subset.every(token => container.some(candidate => aiTokensCloseEnough(candidate, token)));
}

function dropCoveredCompoundTaskRows(items) {
  const keyed = items.map((item, index) => ({
    index,
    tokens: aiTaskKeyTokens(String(item?.text ?? '')),
  }));
  return items.filter((_item, index) => {
    const current = keyed[index];
    if (!current || current.tokens.length < 3) return true;
    return !keyed.some(other => (
      other.index !== index
      && other.tokens.length >= 2
      && other.tokens.length < current.tokens.length
      && current.tokens.length - other.tokens.length <= 2
      && aiTaskTokensContainAll(current.tokens, other.tokens)
    ));
  });
}

function mergeGeneratedTaskExpansionRows(items, generatedItems, input) {
  if (generatedItems.length === 0) return items;
  const merged = [...generatedItems];
  items.forEach((item) => {
    const text = String(item?.text ?? '');
    if (taskLooksLikeGenerationPlaceholder(text, input)) return;
    if (taskTextMatchesGeneratedPlanTopic(text, input) && !taskRowLooksLikeDirectRawAction(item, input)) return;
    merged.push(item);
  });
  return dedupeAiTaskRows(merged);
}

function fallbackGeneratedTaskRowsFromRaw(input) {
  if (!hasTaskGenerationIntent(input)) return [];
  if (/\b(meditation|meditate|mindfulness|breathing)\b.{0,24}\b(routine|plan|program|steps?)\b|\b(routine|plan|program|steps?)\b.{0,24}\b(meditation|meditate|mindfulness|breathing)\b/i.test(input)) {
    return [
      { text: 'Sit quietly 5 minutes', tier: 'medium' },
      { text: 'Breathe slowly 10 rounds', tier: 'medium' },
      { text: 'Body scan head to toe', tier: 'medium' },
      { text: 'Notice thoughts and return', tier: 'low' },
      { text: 'Close with one intention', tier: 'low' },
    ];
  }
  if (/\b(workout|exercise|training)\s+(routine|plan|program)\b/i.test(input)) {
    if (/\b(chest|pec|pecs|bench)\b/i.test(input)) {
      return [
        { text: 'Warm up shoulders 5 minutes', tier: 'medium' },
        { text: 'Flat bench press 4x8', tier: 'medium' },
        { text: 'Incline dumbbell press 3x10', tier: 'medium' },
        { text: 'Cable chest flyes 3x12', tier: 'medium' },
        { text: 'Push-ups 2 sets to failure', tier: 'low' },
      ];
    }
    return [
      { text: 'Warm up 10 minutes', tier: 'medium' },
      { text: 'Bodyweight squats 3x12', tier: 'medium' },
      { text: 'Push-ups 3x10', tier: 'medium' },
      { text: 'Dumbbell rows 3x10', tier: 'medium' },
      { text: 'Plank 3x30 sec', tier: 'low' },
    ];
  }
  if (/\b(pack(?:ing)? checklist|packing list|pack list)\b/i.test(input)) {
    return [
      { text: 'Pack clothes', tier: 'medium' },
      { text: 'Pack toiletries', tier: 'medium' },
      { text: 'Pack chargers', tier: 'medium' },
      { text: 'Bring ID and wallet', tier: 'medium' },
      { text: 'Check travel details', tier: 'low' },
    ];
  }
  return [];
}

function workoutTaskRowHasDoseDetail(text) {
  return /\b\d+\s*x\s*\d+\b/i.test(text)
    || /\b\d+\s*(?:sets?|reps?|rounds?|m|min|mins|minutes|sec|secs|seconds)\b/i.test(text)
    || /\b(?:to failure|amrap|as many reps|each side|per side)\b/i.test(text);
}

function workoutTaskRowNeedsDoseDetail(text) {
  if (/\b(dog|pet)\b/i.test(text)) return false;
  return /\b(push[-\s]?ups?|bench|press|fly|flies|dumbbell|barbell|cable|machine|incline|decline|dips?|row|curl|squat|lunge|deadlift|plank|kettlebell|burpees?|jumping jacks?)\b/i.test(text);
}

function taskRowsNeedGenerationDetailRetry(items, input) {
  if (!/\b(workout|exercise|training)\s+(routine|plan|program)\b/i.test(input)) return false;
  const workoutRows = dropGroceryClauseTaskLeaks(items, input)
    .filter(item => taskTextMatchesGeneratedPlanTopic(String(item?.text ?? ''), input))
    .filter(item => !taskRowLooksLikeDirectRawAction(item, input));
  if (workoutRows.length < 3) return false;
  const strengthRows = workoutRows
    .map(item => String(item?.text ?? ''))
    .filter(workoutTaskRowNeedsDoseDetail);
  if (strengthRows.length === 0) return false;
  const thinRows = strengthRows.filter(text => !workoutTaskRowHasDoseDetail(text));
  return thinRows.length >= Math.min(2, strengthRows.length)
    || thinRows.length / strengthRows.length >= 0.5;
}

function taskRowsMissRequestedWorkoutFocus(items, input) {
  if (!/\b(workout|exercise|training)\s+(routine|plan|program)\b/i.test(input)) return false;
  const focus = /\b(chest|pec|pecs|bench)\b/i.test(input) ? 'chest' : '';
  if (!focus) return false;
  const workoutRows = dropGroceryClauseTaskLeaks(items, input)
    .filter(item => taskTextMatchesGeneratedPlanTopic(String(item?.text ?? ''), input))
    .filter(item => !taskRowLooksLikeDirectRawAction(item, input))
    .map(item => String(item?.text ?? ''));
  if (workoutRows.length < 3) return false;
  if (focus === 'chest') {
    const focusedRows = workoutRows.filter(text => /\b(chest|pec|pecs|bench|push[-\s]?ups?|press|fly|flies|dips?)\b/i.test(text));
    return focusedRows.length < Math.min(3, workoutRows.length);
  }
  return false;
}

function concreteGeneratedTaskRows(items, input) {
  const concrete = dropGroceryClauseTaskLeaks(items, input)
    .filter(item => !taskLooksLikeGenerationPlaceholder(String(item?.text ?? ''), input));
  const fallback = fallbackGeneratedTaskRowsFromRaw(input);
  if (concrete.length === 0) return fallback;
  if (taskRowsUnderfillGeneratedTopic(concrete, input) && fallback.length > 0) return fallback;
  if (taskRowsNeedGenerationDetailRetry(concrete, input) && fallback.length > 0) return fallback;
  if (taskRowsMissRequestedWorkoutFocus(concrete, input) && fallback.length > 0) return fallback;
  return concrete;
}

function taskTextMatchesGeneratedPlanTopic(text, input) {
  if (/\b(meditation|meditate|mindfulness|breathing)\b/i.test(input)) {
    return /\b(meditation|meditate|mindful|breath|breathe|breathing|body scan|sit quietly|thoughts?|intention)\b/i.test(text);
  }
  if (/\b(workout|exercise|training)\s+(routine|plan|program)\b/i.test(input)) {
    return taskTextMatchesGeneratedListTopic(text, { id: 'workout-topic', name: 'Workout', tasks: [] });
  }
  if (/\b(pack(?:ing)? checklist|packing list|pack list)\b/i.test(input)) {
    return /\b(pack|bring|check travel|charger|clothes|toiletries|wallet|id)\b/i.test(text);
  }
  return false;
}

function taskRowsUnderfillGeneratedTopic(items, input) {
  if (!hasTaskGenerationIntent(input)) return false;
  if (!/\b(meditation|meditate|mindfulness|breathing|workout|exercise|training|pack(?:ing)?)\b/i.test(input)) return false;
  const relatedCount = dropGroceryClauseTaskLeaks(items, input)
    .filter(item => taskTextMatchesGeneratedPlanTopic(String(item?.text ?? ''), input)).length;
  return relatedCount < 3;
}

function taskRowLooksLikeDirectRawAction(item, input) {
  if (!hasDirectTaskActionIntent(input)) return false;
  const text = String(item?.text ?? '');
  if (!hasDirectTaskActionIntent(text)) return false;
  const rawTokens = meaningfulTaskTextTokens(input);
  const textTokens = meaningfulTaskTextTokens(text)
    .filter(token => !AI_DIRECT_TASK_RECOVERY_TOKENS.has(token) && !AI_REMINDER_MATCH_STOP_TOKENS.has(token));
  return textTokens.length > 0 && textTokens.every(token => rawTokens.some(rawToken => aiTokensCloseEnough(token, rawToken)));
}

function trimGeneratedTaskRowsPreservingDirect(items, input) {
  const limit = generatedTaskLimit(input);
  if (!limit) return items;
  let generatedCount = 0;
  return items.filter((item) => {
    if (taskRowLooksLikeDirectRawAction(item, input)) return true;
    generatedCount += 1;
    return generatedCount <= limit;
  });
}

const AI_DIRECT_TASK_RECOVERY_TOKENS = new Set([
  'call', 'text', 'email', 'schedule', 'book', 'pay', 'order', 'fix', 'repair', 'clean',
  'do', 'finish', 'submit', 'send', 'test', 'wake', 'walk', 'walking', 'rub',
]);

const AI_DIRECT_TASK_SEGMENT_SPLIT_TOKENS = new Set([
  ...AI_DIRECT_TASK_RECOVERY_TOKENS,
  'buy', 'get', 'grab', 'pick', 'purchase',
]);

const AI_GENERATED_CLAUSE_BOUNDARY_TOKENS = new Set([
  'advice', 'checklist', 'idea', 'ideas', 'ingredient', 'ingredients', 'grocery', 'groceries',
  'list', 'materials', 'plan', 'program', 'recipe', 'routine', 'shopping', 'suggestion',
  'suggestions', 'supplies', 'tips',
]);

function trimDirectTaskRecoverySegment(tokens) {
  const boundary = tokens.findIndex((token, index) => (
    index > 0
    && (
      AI_GENERATED_CLAUSE_BOUNDARY_TOKENS.has(token)
      || AI_GENERATED_CLAUSE_BOUNDARY_TOKENS.has(tokens[index + 1] ?? '')
    )
  ));
  const kept = boundary >= 0 ? tokens.slice(0, boundary) : tokens;
  while (
    kept.length > 1
    && ['a', 'an', 'as', 'and', 'also', 'plus', 'the', 'to', 'well', 'with'].includes(kept[kept.length - 1])
  ) {
    kept.pop();
  }
  return kept.join(' ').trim();
}

function aiTokensCloseEnough(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else {
      edits += 1;
      if (edits > 1) return false;
      if (a.length > b.length) i += 1;
      else if (b.length > a.length) j += 1;
      else {
        i += 1;
        j += 1;
      }
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function recoveredDirectTaskRowsFromRaw(raw, existingItems) {
  if (!hasTaskGenerationIntent(raw)) return [];
  const tokens = normalizeAiListText(raw).split(' ').filter(Boolean);
  const existingKeys = existingItems.map(item => aiTaskDedupeKey(String(item?.text ?? ''))).filter(Boolean);
  const recovered = [];
  tokens.forEach((token, index) => {
    if (!AI_DIRECT_TASK_RECOVERY_TOKENS.has(token)) return;
    const nextActionIndex = tokens.findIndex((candidate, candidateIndex) => (
      candidateIndex > index
      && (AI_DIRECT_TASK_SEGMENT_SPLIT_TOKENS.has(candidate) || candidate === 'and' || candidate === 'plus' || candidate === 'also' || candidate === 'then')
    ));
    const end = nextActionIndex >= 0 ? nextActionIndex : tokens.length;
    const segment = trimDirectTaskRecoverySegment(tokens.slice(index, end));
    if (!segment || /\b(workout|routine|plan|program|checklist|ingredients?|groceries|grocery|shopping|smoothie|supplies|materials?|equipment|accessories|gear|tools?)\b/i.test(segment)) return;
    const segmentKey = aiTaskDedupeKey(segment);
    if (!segmentKey || existingKeys.some(existing => aiTaskDedupeKeysMatch(segmentKey, existing))) return;
    recovered.push({ text: segment, tier: 'medium' });
    existingKeys.push(segmentKey);
  });
  return recovered;
}

function shouldDropIncidentalAiGroceryRows(input) {
  return (hasTaskGenerationIntent(input) || hasDirectTaskActionIntent(input)) && !hasGroceryGenerationIntent(input);
}

function taskRepeatsGroceryGenerationClause(item, input) {
  if (!hasGroceryGenerationIntent(input)) return false;
  const text = String(item?.text ?? '').toLowerCase();
  if (!text.trim()) return false;
  if (/\b(workout|exercise|training|strength|cardio|mobility|warm[-\s]?up|bench|press|row|squat|plank|stretch)\b/i.test(text)) return false;
  if (/\bpack(?:ing)?\b/i.test(text) && /\b(pack(?:ing)? checklist|packing list|pack list)\b/i.test(input)) return false;
  if (hasDirectGroceryAcquisitionIntent(text)) return true;
  return /\b(grocery|shopping|ingredient|meal[-\s]?prep|meal plan|meals?|macros?|nutrition|recipe|protein|smoothie|shake|snacks?|produce|portion|prep|cook|wash|supplies|materials|equipment|accessories|gear|tools?|packing|pack|buy|purchase)\b/i.test(text);
}

function dropGroceryClauseTaskLeaks(items, input) {
  if (!hasGroceryGenerationIntent(input)) return items;
  if (!hasTaskGenerationIntent(input) && !hasDirectTaskActionIntent(input)) return [];
  return items.filter(item => !taskRepeatsGroceryGenerationClause(item, input));
}

const VEGAN_COMPATIBLE_GROCERY_RE = /\b(vegan|plant[-\s]?based|meatless|dairy[-\s]?free|non[-\s]?dairy|egg[-\s]?free|tofu|tempeh|seitan|soy curls?|soy|beyond|impossible|jackfruit|lentils?|beans?|chickpeas?|oat|almond|coconut|cashew|peanut|nutritional yeast)\b/i;
const MEAT_GROCERY_RE = /\b(beef|pork|chicken|turkey|lamb|veal|duck|fish|salmon|tuna|shrimp|seafood|meat|bacon|sausage|ham|steak|prosciutto|pepperoni|anchov(y|ies)|gelatin|lard|bone broth|chicken broth|beef broth|stock)\b/i;
const ANIMAL_PRODUCT_GROCERY_RE = /\b(beef|pork|chicken|turkey|lamb|veal|duck|fish|salmon|tuna|shrimp|seafood|meat|bacon|sausage|ham|steak|prosciutto|pepperoni|anchov(y|ies)|gelatin|lard|bone broth|chicken broth|beef broth|stock|yogurt|milk|cheese|butter|cream|egg|eggs|honey|mayo|mayonnaise|whey|casein)\b/i;

function contextSaysVegan(personalContext) {
  return /\b(vegan|no animal products?|plant[-\s]?based)\b/i.test(personalContext);
}

function contextSaysNoMeat(personalContext) {
  return contextSaysVegan(personalContext)
    || /\b(no|dont|don't|do not|hate|avoid|without)\b.{0,40}\b(meat|seafood|fish|chicken|beef|pork|turkey|lamb)\b/i.test(personalContext)
    || /\b(meat|seafood|fish|chicken|beef|pork|turkey|lamb)\b.{0,40}\b(no|dont|don't|do not|hate|avoid)\b/i.test(personalContext);
}

function groceryDraftAllowedByPersonalContext(item, personalContext) {
  if (!personalContext.trim()) return true;
  const haystack = `${item.name || ''} ${item.packageSize || ''} ${item.unit || ''}`.trim();
  if (!haystack) return true;
  const compatible = VEGAN_COMPATIBLE_GROCERY_RE.test(haystack);
  const category = String(item.category || '').toLowerCase();
  if (contextSaysVegan(personalContext)) {
    if (!compatible && ANIMAL_PRODUCT_GROCERY_RE.test(haystack)) return false;
    if (!compatible && category.includes('meat')) return false;
  } else if (contextSaysNoMeat(personalContext)) {
    if (!compatible && MEAT_GROCERY_RE.test(haystack)) return false;
    if (!compatible && category.includes('meat')) return false;
  }
  return true;
}

function isBroadTaskSuggestionRequest(input) {
  return /\b(give me|suggest|ideas?|recommend|tips?|advice|things to|ways to|healthy things|incorporate|daily routine|routine|plan|checklist|every day|everyday|habits?)\b/i.test(input);
}

function contextSaysMobilityLimited(personalContext) {
  return /\b(wheelchair|limited mobility|mobility impaired|can't walk|cant walk|cannot walk|can't stand|cant stand|cannot stand)\b/i.test(personalContext);
}

function contextSaysDeaf(personalContext) {
  return /\b(deaf|hard of hearing|hearing impaired|can't hear|cant hear|cannot hear)\b/i.test(personalContext);
}

function taskTextConflictsPersonalContext(text, input, personalContext) {
  if (!isBroadTaskSuggestionRequest(input)) return false;
  if (contextSaysMobilityLimited(personalContext)
    && /\b(walk|walking|run|running|jog|jogging|stand|standing|steps?|step outside|go outside|take a stroll|hike)\b/i.test(text)) {
    return true;
  }
  if (contextSaysDeaf(personalContext)
    && /\b(listen|hearing|hear|music|podcast|audio|sound bath|calming sounds?)\b/i.test(text)
    && !/\b(caption|captions|transcript|visual|vibration|silent|text)\b/i.test(text)) {
    return true;
  }
  return false;
}

function extractTaskGenerationClause(input) {
  const withoutTrailingGrocery = input
    .replace(/\s+\b(and|plus|also|with)\s+((ingredients?|supplies|materials?|equipment|accessories|gear|tools?|items)\b.{0,32}\b(for|to make|to build|to buy|to purchase|needed for|for making|for a|for an)\b.+|(shopping|grocery|groceries|meal[-\s]?prep|meal plan|meal planning|prep)\s+(list|items?|groceries|ingredients?)\b.*|(pack(?:ing)?|buy|purchase|shopping|supply|supplies|materials?|equipment|accessories|gear|tools?)\s+(list|items?)\b.*|(list|items?|groceries|ingredients?|supplies|materials?|equipment|accessories|gear|tools?)\s+(for|to make|to build|to buy|to purchase|to pack)\s+(meal[-\s]?prep|meal plan|meal planning|dinner|lunch|breakfast|recipe|recipes?|project|trip|travel|move|moving|school|work|office|home|repair|build|phone|computer|desk|bedroom)\b.*)$/i, '')
    .trim();
  const withoutTrailingDirectTasks = withoutTrailingGrocery
    .replace(/\b(routine|plan|program|checklist|steps?|tips?|advice|suggestions?|ideas?)\b\s+\b(call|text|email|schedule|book|pay|order|fix|repair|clean|finish|submit|send|test|walk|walking|rub)\b.*$/i, '$1')
    .trim();
  const generationMatches = Array.from(withoutTrailingDirectTasks.matchAll(/\b((?:[a-z0-9-]+\s+){0,6}(?:workout|exercise|training|meditation|mindfulness|breathing|cleaning|packing|sleep|desk|bathroom|phone|healthy|calming|daily|morning|evening)?\s*(?:routine|plan|program|checklist|steps?|tips?|advice|suggestions?|ideas?)(?:\s+(?:for|to|about)\s+(?:[a-z0-9-]+\s*){0,6})?)/gi));
  const generationClause = generationMatches[generationMatches.length - 1]?.[1]?.replace(/\s+/g, ' ').trim();
  if (generationClause) {
    const topicStart = generationClause.search(/\b(workout|exercise|training|meditation|mindfulness|breathing|cleaning|packing|sleep|desk|bathroom|phone|healthy|calming|daily|morning|evening)\b/i);
    return (topicStart >= 0 ? generationClause.slice(topicStart) : generationClause)
      .replace(/^(?:a|an|the|some|my|me|as|well|also|and|plus|with)\s+/i, '')
      .trim();
  }
  return withoutTrailingDirectTasks || withoutTrailingGrocery || input;
}

function taskTextMatchesGeneratedListTopic(text, list) {
  const listTokens = getTaskListSignalTokens(list.name);
  const workoutList = listTokens.some(token => ['workout', 'exercise', 'training', 'fitness'].includes(token));
  if (workoutList) {
    if (/\b(dog|pet)\b/i.test(text)) return false;
    if (/\b(breath|breathe|breathing|meditat|mindful|body scan|thoughts?|intention|loving[-\s]?kindness)\b/i.test(text)) return false;
    return /\b(warm[-\s]?up|cool[-\s]?down|intervals?|incline|brisk walk|walk intervals?|walk\s+\d+\s*(?:m|min|mins|minutes)|\d+\s*(?:sets?|reps?|rounds?)|push[-\s]?ups?|bench|press|row|curl|squat|lunge|deadlift|plank|cardio|dumbbell|barbell|kettlebell|burpees?|jumping jacks?)\b/i.test(text);
  }
  return false;
}

function taskTextMatchesTaskListContext(text, list) {
  return inputMentionsTaskListName(text, list.name)
    || inputMentionsTaskListSignal(text, list)
    || taskTextMatchesGeneratedListTopic(text, list);
}

function inferTaskListFromTopic(text, lists) {
  const matches = lists.filter(list => taskTextMatchesGeneratedListTopic(text, list));
  const uniqueIds = Array.from(new Set(matches.map(list => list.id)));
  return uniqueIds.length === 1 ? uniqueIds[0] : null;
}

function shouldUseGeneratedTaskHintForRow(text, raw, hintList) {
  if (!hintList || !hasTaskGenerationIntent(raw)) return false;
  const generatedClause = extractTaskGenerationClause(raw);
  if (!taskTextMatchesTaskListContext(generatedClause, hintList)) return false;
  if (hasDirectTaskActionIntent(text) && !taskTextMatchesTaskListContext(text, hintList)) return false;
  return true;
}

function taskRowsMissingGeneratedHint(items, raw, destinationHint) {
  if (!hasTaskGenerationIntent(raw) || !destinationHint) return false;
  const hintList = LISTS.find(list => list.id === destinationHint.listId);
  if (!hintList) return false;
  const generatedClause = extractTaskGenerationClause(raw);
  if (!taskTextMatchesTaskListContext(generatedClause, hintList)) return false;
  return !items.some(item => shouldUseGeneratedTaskHintForRow(String(item?.text ?? ''), raw, hintList));
}

function inputUsesTaskListAsDestination(input, list) {
  const normalizedInput = ` ${normalizeAiListText(input)} `;
  const normalizedName = normalizeAiListText(list.name);
  return normalizedInput.includes(` to ${normalizedName} list `)
    || normalizedInput.includes(` in ${normalizedName} list `)
    || normalizedInput.includes(` into ${normalizedName} list `)
    || normalizedInput.includes(` on ${normalizedName} list `);
}

function resolveAiTaskListId({ text, raw, aiListIdValue, lists, destinationHint }) {
  const validListIds = new Set(lists.map(list => list.id));
  const defaultRouteListId = DEFAULT_LIST_ID;
  const hintListId = destinationHint && validListIds.has(destinationHint.listId) ? destinationHint.listId : undefined;
  const hintList = hintListId ? lists.find(list => list.id === hintListId) : undefined;
  const taskMatchesHint = !!hintList && taskTextMatchesTaskListContext(text, hintList);
  const globalDestinationHint = !!hintList && inputUsesTaskListAsDestination(raw, hintList);
  const generatedTaskHint = shouldUseGeneratedTaskHintForRow(text, raw, hintList);
  const rowListSignalId = inferTaskListFromListNameSignal(text, lists);
  const rowListSignal = rowListSignalId ? lists.find(list => list.id === rowListSignalId) : undefined;
  const rowListSignalIdForRow = rowListSignal && !taskRepeatsGroceryGenerationClause({ text }, raw)
    ? rowListSignal.id
    : null;
  const rowTopicListId = inferTaskListFromTopic(text, lists);
  const rawSampleListId = hasTaskGenerationIntent(raw) ? inferTaskListFromExistingRows(raw, lists) : null;
  const rawSampleList = rawSampleListId ? lists.find(list => list.id === rawSampleListId) : undefined;
  const rawSampleListIdForRow = rawSampleList && shouldUseGeneratedTaskHintForRow(text, raw, rawSampleList)
    ? rawSampleList.id
    : null;
  const rowSampleListId = hasTaskGenerationIntent(raw) ? null : inferTaskListFromExistingRows(text, lists);
  const aiList = typeof aiListIdValue === 'string' && validListIds.has(aiListIdValue)
    ? lists.find(list => list.id === aiListIdValue)
    : undefined;
  const aiListMatchesContext = !!aiList && (
    !hasTaskGenerationIntent(raw)
    || shouldUseGeneratedTaskHintForRow(text, raw, aiList)
    || inputUsesTaskListAsDestination(raw, aiList)
  );
  const aiListId = typeof aiListIdValue === 'string' && validListIds.has(aiListIdValue)
    && (!(aiListIdValue === hintListId && !taskMatchesHint && !globalDestinationHint))
    && aiListMatchesContext
    ? aiListIdValue
    : undefined;
  return rowListSignalIdForRow
    ?? rowTopicListId
    ?? rowSampleListId
    ?? ((rawSampleListIdForRow && validListIds.has(rawSampleListIdForRow)) ? rawSampleListIdForRow : undefined)
    ?? ((hintListId && generatedTaskHint) ? hintListId : undefined)
    ?? aiListId
    ?? ((hintListId && (taskMatchesHint || globalDestinationHint)) ? hintListId : undefined)
    ?? defaultRouteListId;
}

function cleanReminderTimingFromTaskText(text) {
  const cleaned = text
    .replace(/\b(?:at|around|round|by|before|after)\s+(?:\d{1,2}(?::\d{2}|\s+[0-5]\d)?|\d{3,4})\s*(?:am|pm|a|p)?\b/gi, ' ')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)\b/gi, ' ')
    .replace(/\bin\s+\d+\s*(?:m|min|mins|minutes|h|hr|hrs|hours|days?)\b/gi, ' ')
    .replace(/\bevery\s+\d*\s*(?:m|min|mins|minutes|h|hr|hrs|hours|days?|weeks?)\b/gi, ' ')
    .replace(/\b(today|tomorrow|tonight|this morning|this afternoon|this evening|morning|afternoon|evening|noon|midnight)\b/gi, ' ')
    .replace(/^(?:please\s+)?(?:remind me to|remember to|notify me to|set(?: a)? reminder to|i need to|need to|gotta|have to)\s+/i, '')
    .replace(/^(?:i have|i've got|ive got|got|have)\s+(?:an?\s+)?/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[,.;:\s-]+|[,.;:\s-]+$/g, '')
    .trim();
  return cleaned || text.trim();
}

function aiReminderSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      daysFromNow: { type: 'integer' },
      hour: { type: 'integer' },
      minute: { type: 'integer' },
      repeatHourly: { type: 'boolean' },
      repeatDaily: { type: 'boolean' },
    },
    required: ['daysFromNow', 'hour', 'minute', 'repeatHourly', 'repeatDaily'],
  };
}

function aiTaskSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      tier: { type: 'string', enum: ['high', 'medium', 'low'] },
      reminder: aiReminderSchema(),
      widgetLabel: { type: 'string' },
      listId: { type: 'string' },
    },
    required: ['text', 'tier'],
  };
}

function aiGroceryItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      category: { type: 'string', enum: [...GROCERY_CATEGORIES, GROCERY_UNCATEGORIZED] },
      quantity: { type: 'string' },
      unit: { type: 'string' },
      packageSize: { type: 'string' },
    },
    required: ['name', 'category'],
  };
}

function canonicalGroceryCategory(value) {
  if (typeof value !== 'string') return GROCERY_UNCATEGORIZED;
  return [...GROCERY_CATEGORIES, GROCERY_UNCATEGORIZED]
    .find(category => category.toLowerCase() === value.trim().toLowerCase())
    ?? GROCERY_UNCATEGORIZED;
}

function cleanOptionalGroceryPart(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const COMMON_GROCERY_FRACTIONS = [
  [1 / 8, '1/8'],
  [1 / 6, '1/6'],
  [1 / 4, '1/4'],
  [1 / 3, '1/3'],
  [3 / 8, '3/8'],
  [1 / 2, '1/2'],
  [5 / 8, '5/8'],
  [2 / 3, '2/3'],
  [3 / 4, '3/4'],
  [7 / 8, '7/8'],
];
const GROCERY_DECIMAL_QUANTITY_RE = /(^|[^0-9A-Za-z.])(-?(?:\d+\.\d+|\.\d+))(?=$|[^0-9A-Za-z.])/g;

function decimalGroceryAmountToFraction(amountText) {
  const amount = Number(amountText.startsWith('.') ? `0${amountText}` : amountText);
  if (!Number.isFinite(amount)) return amountText;
  const sign = amount < 0 ? '-' : '';
  const absAmount = Math.abs(amount);
  const whole = Math.floor(absAmount);
  const fraction = absAmount - whole;
  if (fraction < 0.005) return `${sign}${whole}`;
  const closest = COMMON_GROCERY_FRACTIONS.reduce((best, current) => {
    const diff = Math.abs(fraction - current[0]);
    return diff < best.diff ? { value: current[0], label: current[1], diff } : best;
  }, { value: 0, label: '', diff: Number.POSITIVE_INFINITY });
  if (!closest.label || closest.diff > 0.015) return amountText;
  return `${sign}${whole > 0 ? `${whole} ` : ''}${closest.label}`;
}

function formatGroceryQuantityText(value) {
  const cleaned = cleanOptionalGroceryPart(value);
  if (!cleaned) return undefined;
  return cleaned.replace(
    GROCERY_DECIMAL_QUANTITY_RE,
    (_match, prefix, amount) => `${prefix}${decimalGroceryAmountToFraction(amount)}`,
  );
}

function normalizePackageSizeText(value) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\b(\d+(?:\.\d+)?)\s*(fl\s*oz|floz|oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|ml|l|liter|liters|gallon|gallons|quart|quarts|qt|pt|pint|pints)\b/gi, (_match, amount, unit) => {
      const normalizedUnit = String(unit)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/^floz$/u, 'fl oz')
        .replace(/^ounces?$/u, 'oz')
        .replace(/^pounds?$/u, 'lb')
        .replace(/^grams?$/u, 'g')
        .replace(/^liters?$/u, 'l')
        .replace(/^gallons?$/u, 'gallon')
        .replace(/^quarts?$/u, 'qt')
        .replace(/^pints?$/u, 'pt');
      return `${amount} ${normalizedUnit}`;
    })
    .trim();
}

function cleanPackageSize(value) {
  const cleaned = cleanOptionalGroceryPart(value);
  if (!cleaned) return undefined;
  const unwrapped = normalizePackageSizeText(cleaned.replace(/^\((.*)\)$/u, '$1').trim())
    .replace(/\bassorted\s+assortment\b/iu, 'assorted');
  if (/^\d+(\.\d+)?$/u.test(unwrapped)) return undefined;
  return unwrapped || undefined;
}

function cleanGroceryUnit(value, packageSize) {
  const cleaned = cleanOptionalGroceryPart(value);
  if (!cleaned) return undefined;
  const normalized = cleaned.toLowerCase();
  if (packageSize && normalized === packageSize.toLowerCase()) return undefined;
  if (packageSize && /\d/.test(normalized) && /\b(package|container|bottle|jar|bag|box|can|head|bunch|pack)\b/i.test(cleaned)) return undefined;
  if (packageSize && /^(small|medium|large)\s+(package|container|bottle|jar|bag|box|can|head|bunch|pack)$/i.test(cleaned)) return undefined;
  return cleaned;
}

function inputMentionsQuantityForItem(input, itemName) {
  const raw = input.toLowerCase();
  const words = itemName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const anchor = words[0];
  if (!anchor) return false;
  const idx = raw.indexOf(anchor);
  if (idx < 0) return false;
  const near = raw.slice(Math.max(0, idx - 32), Math.min(raw.length, idx + anchor.length + 32));
  return /(\d+(\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|dozen|half|quarter)\s*(ct|count|pack|packs|box|boxes|bag|bags|loaf|loaves|dozen|gal|gallon|gallons|qt|quart|oz|ounce|ounces|lb|lbs|pound|pounds|cup|cups|tbsp|tsp|scoop|scoops|clove|cloves|sheet|sheets|screw|screws|ft|feet|foot|inch|inches|piece|pieces|bunch|head|stick|sticks|bottle|bottles|jar|jars|carton|cartons|tub|tubs|container|containers|can|cans)?\b/i.test(near);
}

function groceryQuantityIsBareOne(value) {
  return /^(1|one)$/i.test(String(value || '').trim());
}

const GROCERY_PACKAGE_CONTAINER_UNIT_RE = /^(bag|bags|box|boxes|carton|cartons|tub|tubs|container|containers|package|packages|pack|packs|jar|jars|bottle|bottles|pouch|pouches)$/i;

function groceryQuantityInstruction(inferGroceryQuantities) {
  return inferGroceryQuantities
    ? [
      'Use quantity + unit for the amount needed/used for the recipe, project, plan, or supply list; this is shown before the item name.',
      'Use packageSize only for the smallest common purchasable package/container hint; this is shown on the right in parentheses.',
      'For generated grocery/material rows, include packageSize whenever the item has a normal retail size; most generated rows should have one.',
      'For generated recipe, meal, smoothie, or ingredient rows, include quantity + unit for most rows whenever a practical starter amount is possible.',
      'Prefer simple fraction text like "1/2", "1/4", or "1 1/2" instead of decimals for cooking or recipe quantities.',
      'Keep name as the item only. Do not repeat quantity, unit, or packageSize in name.',
      'Do not use bare quantity "1" with an empty unit for generated rows. If the needed amount is unknown, omit quantity/unit instead of guessing.',
      'Use recipe/project units like cups, tbsp, scoops, cloves, sheets, screws, or feet. Do not use bag/tub/carton/package as unit unless the needed amount is truly that whole container.',
      'packageSize should be buyable text like "10 oz bag", "32 oz tub", "2 lb tub", "14 oz can", "25-count pack", or "1 small bottle", not a bare number.',
    ].join(' ')
    : 'Use quantity/unit only when the user wrote the amount; do not infer amounts for simple lists. Keep any packageSize as a buyable package hint, not a needed amount.';
}

function groceryDisplayName(item) {
  const quantity = formatGroceryQuantityText(item?.quantity);
  const unit = cleanOptionalGroceryPart(item?.unit);
  const prefix = [quantity, unit].filter(Boolean).join(' ');
  return prefix ? `${prefix} ${item?.name || ''}`.trim() : String(item?.name || '').trim();
}

function grocerySearchText(item) {
  return `${groceryDisplayName(item)} ${item?.packageSize || ''}`.trim().toLowerCase();
}

function normalizeGroceryItem(item, input = '', allowInferredQuantity = true) {
  if (!item || typeof item !== 'object') return item;
  let name = typeof item.name === 'string' ? item.name.trim().replace(/\s*\([^)]*$/u, '').trim() : '';
  const userMentionedQuantity = inputMentionsQuantityForItem(input, name);
  const keepQuantity = allowInferredQuantity || userMentionedQuantity;
  let packageSize = keepQuantity ? cleanPackageSize(item.packageSize ?? item.purchaseSize ?? item.package ?? item.purchaseHint) : undefined;
  if (packageSize) {
    const withoutBalancedNote = name.replace(/\s*\([^()]{2,80}\)\s*$/u, '').trim();
    if (withoutBalancedNote) name = withoutBalancedNote;
  }
  let unit = keepQuantity ? cleanGroceryUnit(item.unit, packageSize) : undefined;
  let quantity = keepQuantity ? formatGroceryQuantityText(item.quantity) : undefined;
  const generatedQuantity = allowInferredQuantity && !userMentionedQuantity;
  if (generatedQuantity && groceryQuantityIsBareOne(quantity) && unit && GROCERY_PACKAGE_CONTAINER_UNIT_RE.test(unit)) {
    packageSize = packageSize || normalizePackageSizeText(`${quantity} ${unit}`);
    quantity = undefined;
    unit = undefined;
  }
  if (generatedQuantity && groceryQuantityIsBareOne(quantity) && !unit) {
    quantity = undefined;
  }
  return {
    ...item,
    name,
    category: canonicalGroceryCategory(item.category ?? item.aisle ?? item.section),
    quantity,
    unit,
    packageSize,
  };
}

function aiRouteSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      tasks: { type: 'array', items: aiTaskSchema() },
      grocery: { type: 'array', items: aiGroceryItemSchema() },
    },
    required: ['tasks', 'grocery'],
  };
}

function aiGroceryItemsOnlySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: { type: 'array', items: aiGroceryItemSchema() },
    },
    required: ['items'],
  };
}

function aiTaskOnlySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      tasks: { type: 'array', items: aiTaskSchema() },
    },
    required: ['tasks'],
  };
}

function openAiOutputBudget(maxTokens) {
  return Math.min(4096, Math.max(maxTokens * 2, maxTokens + 700));
}

function openAiInstructionDetail() {
  return `

GPT structured-output detail:
- For generated recipe, meal, project, supply, or material grocery rows, include quantity + unit for the amount needed/used, and packageSize for the smallest common purchasable package/container hint.
- If no serving/project size is given, assume a small household starter amount.
- Keep name as the item only; do not repeat quantity, unit, or packageSize in name.
- For recipe, meal, smoothie, or ingredient requests, most rows should include a needed quantity + unit such as cup, tbsp, scoop, handful, whole, cloves, or lb.
- Prefer simple fraction text like "1/2", "1/4", or "1 1/2" instead of decimals for cooking or recipe quantities.
- Do not output bare quantity "1" with no unit for generated rows. If the needed amount is not known, omit quantity/unit.
- unit must be a simple needed-amount measurement/count such as "cups", "tbsp", "scoops", "cloves", "lb", "sheets", "screws", or "feet"; do not put full package hints in unit.
- packageSize must be a buyable hint like "10 oz bag", "32 oz tub", "1 lb package", "14 oz can", "25-count pack", or "1 small bottle", not a bare number.
- Category hints: oils, grains, spices, sauces, protein powder, wraps, and shelf-stable staples are usually Canned & Dry Goods; yogurt/milk/cheese are Dairy; fresh vegetables/fruit are Produce; frozen vegetables/fruit are Frozen; meat/fish are Meat & Seafood.${OPENAI_ROUTE_EXAMPLES}`;
}

function buildWorkspaceContext(input, lists, activeListId, promptVariant = 'full') {
  const activeList = lists.find(list => list.id === activeListId) || lists[0];
  const defaultList = lists.find(list => list.id === DEFAULT_LIST_ID) || lists[0];
  const destinationHint = inferTaskDestinationHint(input, lists, activeListId);
  const listContext = lists.map(list => ({
    id: list.id,
    name: list.name,
    active: list.id === activeListId,
    count: list.tasks.length,
    samples: list.tasks.map((task, index) => ({ n: index + 1, text: task.text, tier: task.tier })).slice(0, 4),
  }));
  const prompt = promptVariant === 'full'
    ? `WORKSPACE:
active=${JSON.stringify({ id: activeList.id, name: activeList.name, count: activeList.tasks.length })}
default=${JSON.stringify({ id: defaultList.id, name: defaultList.name, count: defaultList.tasks.length })}
lists=${JSON.stringify(listContext)}
activeSamples=${JSON.stringify(activeList.tasks.map((task, index) => ({ n: index + 1, text: task.text, tier: task.tier })).slice(0, 12))}
strongHint=${JSON.stringify(destinationHint)}
sourceLists=[]

Workspace rules:
- Default to the normal To-do list unless the user names another list, strongHint is set, or the task clearly fits the active list topic/name/samples.
- Active list is viewport context, not the generic fallback.
- Use list samples as routing context; matching device/model/project terms from a task to a list sample is a strong signal for that list.
- If strongHint is set, treat it as an item-level destination hint for tasks that match it; do not force unrelated tasks from the same prompt into that list.
- Multi-item prompts may split tasks across different destination lists when list names, Personal Context, or existing list topics make that clear.`
    : `WORKSPACE:
active=${JSON.stringify({ id: activeList.id, name: activeList.name, count: activeList.tasks.length })}
default=${JSON.stringify({ id: defaultList.id, name: defaultList.name, count: defaultList.tasks.length })}
lists=${JSON.stringify(listContext)}
activeSamples=${JSON.stringify(activeList.tasks.map((task, index) => ({ n: index + 1, text: task.text, tier: task.tier })).slice(0, 12))}
strongHint=${JSON.stringify(destinationHint)}
sourceLists=[]
Rules: default unnamed tasks to default, not active. Use list names/samples/strongHint per row; split lists only when the row itself has that signal.`;
  return { prompt, destinationHint };
}

function buildRouteSystem({ input, screen, personalContext = '', promptVariant = 'full' }) {
  const nowDescr = new Date().toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const activeListId = screen === 'grocery' ? DEFAULT_LIST_ID : DEFAULT_LIST_ID;
  const workspaceContext = buildWorkspaceContext(input, LISTS, activeListId, promptVariant);
  const groceryEnabled = true;
  const inferGroceryQuantities = shouldInferGroceryQuantities(input);
  if (promptVariant === 'lean') {
    return {
      destinationHint: workspaceContext.destinationHint,
      system: `Route Triority input to tool JSON.

NOW: ${nowDescr}
CTX: ${personalContext ? JSON.stringify(personalContext) : '""'}; obey CTX for broad suggestions, accessibility, diet, allergies, and product bans.
${workspaceContext.prompt}
Rows:
- tasks=3-10 word actions with tier high/medium/low; grocery=buyable material/item with category.
- plans/routines/checklists/tips/advice -> 3-5 concrete task rows, no meta rows like choose/create/plan the plan.
- include compact practical details when needed, such as sets/reps/minutes for workout rows.
- recipe/shopping/grocery/supplies/materials/equipment/accessories/gear/tools/packing/buy lists -> 5-8 grocery rows, not placeholder items; ${groceryQuantityInstruction(inferGroceryQuantities)}
- Split mixed clauses; do not duplicate a clause as both task and grocery. Ambiguous actionable input -> task. Non-empty actionable input must return a row.
- Reminders only for explicit reminder/alarm/notify/repeat, scheduled-event wording with a time, or a clear clock time. Date-only today/tomorrow/later is not a reminder. Infer the next sensible occurrence from NOW.
- listId per task from WORKSPACE; otherwise default. Keep user wording/register; do not sanitize names/relationships.
Output only schema fields. Empty side arrays allowed.`
    };
  }
  if (promptVariant === 'compact') {
    return {
      destinationHint: workspaceContext.destinationHint,
      system: `Route user input into Triority tool JSON.

NOW: ${nowDescr}
PERSONAL CONTEXT: ${personalContext ? JSON.stringify(personalContext) : '""'}
Use Personal Context for people, priorities, list aliases, accessibility, diet/allergy/product-ban constraints, and ambiguity. Preserve exact commands unless a broad suggestion conflicts with context.
${workspaceContext.prompt}
Rows:
- Short app rows, not prose. One task = one useful action; one grocery/material row = one buyable item.
- Use intent frames over memorized phrases: action verb + object = task; event/appointment noun + date/time = task with reminder; ingredients/supplies/materials + topic = grocery/material rows; plan/routine/checklist/tips + topic = concrete task rows.
- Plans/routines/checklists/tips/advice become concrete task rows, not meta rows like choose/create/schedule/plan the plan.
- Ingredients/recipes/shopping/groceries/supplies/materials/equipment/accessories/gear/tools/packing/buy lists become grocery/material rows.
- Casual words like stuff, junk, crap, or things also mean grocery/material rows when attached to a recipe, meal, smoothie, project, repair, packing, or buying clause.
- Broad/vague requests stay compact: 3-5 task rows and 5-8 grocery rows unless full/weekly/detailed/exact-count is requested.
- Avoid vague group/session rows like "upper body strength", "cardio", "back session", or "meal prep list"; make rows directly usable.
- Include compact practical details when needed, such as sets/reps/minutes for workout rows.
- Workout routines are concrete exercises with sets/reps/rounds/minutes or "to failure" when practical; grocery/material lists should not also create tasks to choose, prep, shop, or pack the list.
- Split mixed prompts by clause; do not duplicate the same clause as both task and grocery. If ambiguous, prefer task rows.
- Categories: ${GROCERY_CATEGORIES.join(', ')}, or "${GROCERY_UNCATEGORIZED}".
- ${AI_GROCERY_CATEGORY_HINTS}
- ${groceryQuantityInstruction(inferGroceryQuantities)}
- Tasks set listId from WORKSPACE when named/implied; otherwise use default, not active.
- Reminders only for explicit reminder/alarm/notify/repeat wording, scheduled-event wording with a time ("appointment tomorrow at 330"), or a clear clock time ("at 4", "at 12:30", "at 1230"). Date-only today/tomorrow/later is not a reminder. repeat* only if explicit.
- Time: infer the next sensible occurrence from NOW. "at/around/round 6" usually means next 6 PM unless morning/wake/alarm context; "at 9" at 8 PM means 9 PM, while "at 9" at 11 PM means tomorrow 9 AM. Compact "1230" means 12:30. "wake up at 8 in 3 days" means 8 AM three days from NOW.
- Output concise text; remove timing words only when a reminder is created; keep user wording/register and do not sanitize names/relationships.

Return only schema fields. Either array can be empty, but actionable input must not return both empty.`
    };
  }
  return {
    destinationHint: workspaceContext.destinationHint,
    system: `Route user input into Triority tool JSON.

NOW: ${nowDescr}
PERSONAL CONTEXT: ""
Use Personal Context for people, list aliases, priorities, ambiguity, accessibility constraints, and grocery constraints.
${personalContext ? `TASK PERSONAL CONTEXT: ${JSON.stringify(personalContext)}
Task context rules:
- Treat explicit accessibility, health, sensory, mobility, lifestyle, and "cannot/do not" notes in Personal Context as constraints when generating or splitting suggested tasks.
- Suggestions must be realistically usable for the user. For example, wheelchair context means avoid standing/walking/step-outside suggestions unless framed as an accessible alternative; deaf context means avoid listening-based suggestions unless an accessible visual/tactile alternative is named.
- If the user's exact command conflicts with Personal Context, preserve the command unless it is a broad suggestion request; broad suggestion requests should adapt to the context.` : 'TASK PERSONAL CONTEXT: ""'}
${workspaceContext.prompt}
${AI_ROW_STYLE_RULES}
${AI_INTENT_RULES}
${AI_ROUTE_OUTPUT_RULES}
${groceryEnabled ? `Classify each item as task or grocery/material.
${personalContext ? `GROCERY PERSONAL CONTEXT: ${JSON.stringify(personalContext)}
Grocery context rules:
- Treat explicit diet, allergy, product-ban, lifestyle, accessibility, and "do not include" notes in Personal Context as hard constraints for generated grocery/material items unless the user explicitly says to ignore them or buy for someone else.
- For recipe/meal generation, substitute compatible purchasable alternatives instead of outputting forbidden products; omit the item when no safe substitute is obvious.
- Vegan/no-meat context means no meat, seafood, dairy, eggs, honey, gelatin, lard, whey, or casein unless the item itself is clearly vegan, plant-based, dairy-free, or egg-free.` : 'GROCERY PERSONAL CONTEXT: ""'}
Categories: ${GROCERY_CATEGORIES.join(', ')}, or "${GROCERY_UNCATEGORIZED}".
- ${AI_GROCERY_CATEGORY_HINTS}
- ${groceryQuantityInstruction(inferGroceryQuantities)}
- Ingredients/shopping/grocery/supplies/materials/equipment/accessories/gear/tools/packing/buy lists for X, meal-prep lists, and meal-plan lists should generate practical purchasable grocery/material rows, not one literal placeholder.
- If a clause is phrased as a list for groceries/shopping/meal-prep/supplies/materials/equipment/accessories/gear/tools/packing/buying, route that clause only to grocery/material rows; do not also create task rows for choosing, prepping, shopping, or packing that list.
 - Workout/exercise/training routines or plans should generate concrete exercise task rows with sets/reps/rounds/minutes or "to failure" when practical, not one placeholder task, unless the user clearly asks for a reminder to make the plan later.
- A workout plan means the workout actions/exercises, not meta tasks like setting goals, choosing schedules, or picking exercises.
- Routine/plan/checklist/ideas requests in any domain should generate concrete task rows, not one placeholder task, unless the user clearly asks for a reminder to make the plan later.
- Broad/vague requests should be compact starter sets: 3-5 task rows and 5-8 grocery/material rows unless the user asks for a full, weekly, detailed, or exact-count plan/list. Never exceed those vague-request limits.
- Avoid vague category/session rows like "back session" or "meal prep list"; make rows directly usable.
- In mixed prompts, satisfy each clause independently: tasks/routines/checklists go to tasks; grocery/shopping/meal-prep/supplies/materials/equipment/accessories/gear/tools/packing/buy lists go to grocery.` : 'All items are tasks.'}
Tasks: set listId per task. Different tasks in one prompt may use different listIds. If a task has no destination named/implied, use the default list from WORKSPACE, not active.
Tasks get tier high/medium/low. Use high only for urgent/important, low for optional/light, otherwise medium.
Set widgetLabel to 1-5 words. Keep meaning/action/final object; if text is already short, use full text.

Reminders: include daysFromNow/hour/minute/repeatHourly/repeatDaily only for explicit reminder/alarm/notify/repeat wording, scheduled-event wording with a time, or a clear clock time like "at 4", "at 12:30", or "at 1230". Date-only words like today/tomorrow/later are not reminders by themselves. repeat* true only if explicit.

TIME INTERPRETATION:
- infer the next sensible occurrence from NOW
- compact "1230" means 12:30
- "around 6", "at 6" with no AM/PM = next 6 PM unless context says morning/wake/alarm
- "at 9" at 8 PM means 9 PM; "at 9" at 11 PM means tomorrow 9 AM
- "wake up at 8 in 3 days" means 8 AM three days from NOW
- "tonight" = hour 20, "this evening" = hour 19, "tomorrow morning" = daysFromNow:1 hour:9
- "in an hour" / "in 2 hours" - calculate from NOW

Output: concise task text/item names; remove timing words from task text and widgetLabel only when a reminder is created; no extra keys; do not duplicate quantity/unit in item name.
Wording: keep the user's register. Split/clean filler, but do not euphemize, sanitize, or replace relationship words/names from Personal Context unless the user wrote them.

If text fallback happens, return only JSON:
{"tasks":[{"text":"call dentist","widgetLabel":"dentist","tier":"medium","listId":"personal","reminder":{"daysFromNow":1,"hour":10,"minute":0,"repeatHourly":false,"repeatDaily":false}}],"grocery":[{"name":"eggs","category":"Dairy"}]}
Omit reminder if none. Either array can be empty. listId must be valid from WORKSPACE lists or null.`,
  };
}

async function requestOpenAi({ apiKey, system, user, schema = aiRouteSchema(), schemaName = AI_ROUTE_INPUT_TOOL_NAME, includeRouteDetail = true }) {
  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: PROVIDERS.openai.model,
      instructions: `${system}${includeRouteDetail ? openAiInstructionDetail() : ''}`,
      input: [{ role: 'user', content: user }],
      max_output_tokens: openAiOutputBudget(1000),
      reasoning: { effort: 'none' },
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          strict: false,
          schema,
        },
      },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  const text = typeof data.output_text === 'string'
    ? data.output_text
    : (Array.isArray(data.output)
      ? data.output.flatMap(item => item.content || []).map(part => part.text || '').join('\n')
      : '');
  if (!text.trim()) throw new Error(`Provider returned no text: ${JSON.stringify(data).slice(0, 500)}`);
  return parseJsonText(text);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function googleRetryDelayFromError(data, headers) {
  const retryAfter = headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  const retryInfo = Array.isArray(data?.error?.details)
    ? data.error.details.find(detail => typeof detail?.retryDelay === 'string')
    : null;
  const delayText = retryInfo?.retryDelay;
  const secondsMatch = typeof delayText === 'string' ? delayText.match(/^(\d+(?:\.\d+)?)s$/) : null;
  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return null;
}

function isRetriableGeminiError(status, data) {
  const code = Number(data?.error?.code ?? status);
  const apiStatus = String(data?.error?.status ?? '');
  return code === 429 || code === 500 || code === 502 || code === 503 || code === 504
    || apiStatus === 'RESOURCE_EXHAUSTED' || apiStatus === 'UNAVAILABLE';
}

function geminiBackoffMs(attempt, data, headers) {
  const explicit = googleRetryDelayFromError(data, headers);
  const maxHarnessDelay = 12000;
  if (explicit != null) return explicit <= maxHarnessDelay ? explicit : null;
  const base = [1000, 2500, 5000][attempt] ?? 5000;
  return base + Math.floor(Math.random() * 300);
}

async function requestGemini({ apiKey, system, user, schema = aiRouteSchema() }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(PROVIDERS.gemini.model)}:generateContent`;
  const schemaText = JSON.stringify(schema);
  const base = {
    systemInstruction: { parts: [{ text: `${system}\n\nReturn ONLY a complete valid JSON object matching this schema. No markdown, no explanation:\n${schemaText}` }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
  };
  const requests = [
    {
      ...base,
      generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: 'application/json' },
    },
    {
      ...base,
      contents: [{
        role: 'user',
        parts: [{ text: `${user}\n\nReturn only a complete valid JSON object. Close every array/object. Schema:\n${schemaText}` }],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: 'application/json' },
    },
    {
      ...base,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
      },
    },
  ];
  let totalHttpAttempts = 0;
  let totalRequestChars = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastError = null;

  for (const requestBody of requests) {
    const requestBodyText = JSON.stringify(requestBody);
    totalRequestChars += requestBodyText.length;
    let resp = null;
    let data = null;
    let httpAttempts = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      httpAttempts = attempt + 1;
      totalHttpAttempts += 1;
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: requestBodyText,
      });
      try {
        data = await resp.json();
      } catch {
        data = { error: { code: resp.status, message: resp.statusText || 'Gemini request failed.' } };
      }
      if (resp.ok || !isRetriableGeminiError(resp.status, data)) break;
      const delayMs = geminiBackoffMs(attempt, data, resp.headers);
      if (attempt >= 3 || delayMs == null) break;
      await delay(delayMs);
    }

    totalRequestChars += requestBodyText.length * Math.max(0, httpAttempts - 1);
    totalInputTokens += data?.usageMetadata?.promptTokenCount ?? 0;
    totalOutputTokens += data?.usageMetadata?.candidatesTokenCount ?? 0;
    lastProviderUsage = {
      schemaName: 'gemini-json',
      inputTokens: totalInputTokens || null,
      outputTokens: totalOutputTokens || null,
      requestChars: totalRequestChars,
      httpAttempts: totalHttpAttempts,
      systemChars: system.length,
      userChars: user.length,
      schemaChars: schemaText.length,
    };

    if (!resp.ok) {
      lastError = new Error(JSON.stringify(data));
      if (isRetriableGeminiError(resp.status, data)) break;
      continue;
    }
    const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n') || '';
    if (!text.trim()) {
      lastError = new Error(`Provider returned no text: ${JSON.stringify(data).slice(0, 500)}`);
      continue;
    }
    try {
      return parseJsonText(text);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Gemini request failed.');
}

function extractBalancedJsonCandidates(value) {
  const candidates = [];
  let start = -1;
  let stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      if (start >= 0) inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      if (start < 0) {
        start = i;
        stack = [];
      }
      stack.push(ch === '{' ? '}' : ']');
      continue;
    }

    if ((ch === '}' || ch === ']') && start >= 0) {
      const expected = stack.pop();
      if (expected !== ch) {
        start = -1;
        stack = [];
        inString = false;
        escaped = false;
        continue;
      }
      if (stack.length === 0) {
        candidates.push(value.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function parseJsonText(text) {
  const raw = String(text || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  if (!raw) throw new Error('Provider returned no text.');
  try {
    return JSON.parse(raw);
  } catch {
    for (const candidate of extractBalancedJsonCandidates(raw)) {
      try {
        return JSON.parse(candidate);
      } catch {}
    }
    throw new Error(`Provider returned text instead of JSON: ${raw.slice(0, 200)}`);
  }
}

function anthropicTextFromResponse(data) {
  return Array.isArray(data?.content)
    ? data.content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n')
    : '';
}

function anthropicToolInputFromResponse(data, toolName) {
  const block = Array.isArray(data?.content)
    ? data.content.find(part => part?.type === 'tool_use' && part?.name === toolName && part?.input && typeof part.input === 'object')
    : null;
  if (block?.input) return block.input;
  return parseJsonText(anthropicTextFromResponse(data));
}

let lastProviderUsage = null;

async function requestAnthropic({ provider, apiKey, system, user, schema = aiRouteSchema(), schemaName = AI_ROUTE_INPUT_TOOL_NAME }) {
  const requestBody = {
    model: PROVIDERS[provider].model,
    max_tokens: 1200,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [{
      name: schemaName,
      description: 'Return structured Triority app rows.',
      input_schema: schema,
    }],
    tool_choice: { type: 'tool', name: schemaName },
  };
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(requestBody),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  lastProviderUsage = {
    schemaName,
    inputTokens: data?.usage?.input_tokens ?? null,
    outputTokens: data?.usage?.output_tokens ?? null,
    requestChars: JSON.stringify(requestBody).length,
    systemChars: system.length,
    userChars: user.length,
    schemaChars: JSON.stringify(schema).length,
  };
  return anthropicToolInputFromResponse(data, schemaName);
}

async function requestProvider({ provider, apiKey, system, user, schema = aiRouteSchema(), schemaName = AI_ROUTE_INPUT_TOOL_NAME, includeRouteDetail = true }) {
  lastProviderUsage = null;
  if (provider === 'openai') {
    return requestOpenAi({ apiKey, system, user, schema, schemaName, includeRouteDetail });
  }
  if (provider === 'gemini') {
    return requestGemini({ apiKey, system, user, schema });
  }
  if (isAnthropicProvider(provider)) {
    return requestAnthropic({ provider, apiKey, system, user, schema, schemaName });
  }
  throw new Error(`Unknown provider "${provider}".`);
}

function groceryItemsFromPayload(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.grocery)) return parsed.grocery;
  return [];
}

async function generateGroceryItemsForAiSlice({ provider, apiKey, input, personalContext = '' }) {
  const requestText = extractGroceryGenerationClause(input);
  const system = `Generate grocery/material rows from candid user speech.
Only satisfy the grocery, ingredient, shopping, supply, material, equipment, accessory, gear, or tool part of the request. Ignore task, routine, reminder, or planning clauses.
GROCERY PERSONAL CONTEXT: ${personalContext ? JSON.stringify(personalContext) : '""'}
Categories: ${GROCERY_CATEGORIES.join(', ')}, or "${GROCERY_UNCATEGORIZED}".
${AI_GROCERY_CATEGORY_HINTS}
Rules:
${AI_ROW_STYLE_RULES}
- If the user asks for ingredients, supplies, materials, shopping/grocery items, packing/buy lists, a meal-prep list, or a meal-plan list, expand it into practical purchasable rows for that thing.
- Treat casual grocery/material wording like "smoothie stuff", "project junk", "crap to buy", or "things for the repair" as a request for practical purchasable rows.
- Never return one placeholder item like "ingredients for smoothie", "shopping list for dinner", or "supplies for project".
- For broad/vague requests, return 5-8 rows unless the user asks for a full, weekly, detailed, or exact-count list. Never exceed 8 rows for vague list requests.
- ${groceryQuantityInstruction(true)}
- For recipe, meal, smoothie, or ingredient requests, most rows should include a needed quantity + unit such as cup, tbsp, scoop, handful, whole, cloves, or lb.

Return only schema fields.`;
  const parsed = await requestProvider({
    provider,
    apiKey,
    system,
    user: `Grocery/material clause: ${requestText}`,
    schema: aiGroceryItemsOnlySchema(),
    schemaName: AI_GROCERY_ITEMS_TOOL_NAME,
    includeRouteDetail: false,
  });
  return groceryItemsFromPayload(parsed)
    .map(item => normalizeGroceryItem(item, input, true))
    .filter(item => item?.name)
    .filter(item => groceryDraftAllowedByPersonalContext(item, personalContext))
    .slice(0, generatedGroceryLimit(input) ?? undefined);
}

async function generateTaskRowsForAiSlice({ provider, apiKey, input, personalContext = '', promptVariant = 'full' }) {
  const nowDescr = new Date().toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const workspaceContext = buildWorkspaceContext(input, LISTS, DEFAULT_LIST_ID, promptVariant);
  const requestText = extractTaskGenerationClause(input);
  const system = promptVariant === 'full'
    ? `Generate Triority task rows from candid user speech.

NOW: ${nowDescr}
TASK PERSONAL CONTEXT: ${personalContext ? JSON.stringify(personalContext) : '""'}
${workspaceContext.prompt}

Only satisfy the task, routine, plan, checklist, tip, advice, or suggestion part of the request. Ignore grocery, ingredient, shopping, supply, material, equipment, accessory, gear, or tool clauses.
Rules:
${AI_ROW_STYLE_RULES}
- If the user asks for a routine, plan, checklist, tips, advice, ideas, or things to do, expand it into concrete useful rows.
- Do not return one placeholder task like "create workout routine" unless the user clearly asked for a reminder to create it later.
- For broad/vague requests, return 3-5 task rows unless the user asks for a full, weekly, detailed, or exact-count plan. Never exceed 5 task rows for vague plan requests.
- For workout/fitness routines, create compact exercise rows with simple sets/reps, rounds, minutes, or "to failure" when useful; avoid broad labels like "back session" unless the user specifically asks for a split schedule.
- For any plan/routine, output the plan's actual useful rows, not meta tasks to choose, create, schedule, or research the plan.
- Use concise row text, keep the user's register, and keep rows actionable.
- Tasks get tier high/medium/low. Use high only for urgent/important, low for optional/light, otherwise medium.
- Reminders only for explicit reminder/alarm/notify/repeat wording, scheduled-event wording with a time, or a clear clock time like "at 4", "at 12:30", or "at 1230"; date-only words like today/tomorrow/later are not reminders by themselves.
- Set listId using WORKSPACE. If no destination is named or implied, use the default list.

Return only JSON: {"tasks":[{"text":"bench press 3x8","tier":"medium","listId":"workout"}]}.`
    : `Generate concrete Triority task rows for the task/planning clause only.

NOW: ${nowDescr}
CTX: ${personalContext ? JSON.stringify(personalContext) : '""'}
${workspaceContext.prompt}
Rules: ignore grocery/material clauses; plans/routines/checklists/tips/advice become 3-5 concrete useful task rows, not meta rows; workout strength rows should include simple sets/reps, rounds, minutes, or "to failure" when practical; other advice/checklist rows should include the concrete object/tool/location/frequency when needed; tasks are short actions with tier high/medium/low; reminders only for explicit reminder/alarm/notify/repeat or clear clock time; listId from WORKSPACE else default.
Return only schema fields.`;
  const parsed = await requestProvider({
    provider,
    apiKey,
    system,
    user: `Task/planning clause: ${requestText}`,
    schema: aiTaskOnlySchema(),
    schemaName: AI_WIDGET_TASK_TOOL_NAME,
    includeRouteDetail: false,
  });
  return Array.isArray(parsed?.tasks) ? trimGeneratedTaskRowsForScope(parsed.tasks, input) : [];
}

function localRoute(parsed, input, destinationHint, personalContext = '') {
  let tasks = Array.isArray(parsed.tasks) ? dropGroceryClauseTaskLeaks(dropCoveredCompoundTaskRows(dedupeAiTaskRows(parsed.tasks)), input) : [];
  let grocery = Array.isArray(parsed.grocery) ? parsed.grocery.map(item => normalizeGroceryItem(item, input, shouldInferGroceryQuantities(input))) : [];
  grocery = mergeRecoveredGroceryDrafts(grocery, input);
  if (tasks.length === 0 && shouldDropIncidentalAiGroceryRows(input) && grocery.length > 0) {
    tasks = [{ text: input, tier: 'medium' }];
  }
  return {
    tasks: trimGeneratedTaskRowsPreservingDirect(tasks, input)
      .filter(task => !taskTextConflictsPersonalContext(String(task.text || ''), input, personalContext))
      .map(task => {
        const text = String(task.text || '');
        const reminder = shouldAllowAiReminderForTask(input, text)
          ? (task.reminder || buildReminderFallbackFromRaw(input, text) || null)
          : null;
        return {
          text: reminder ? cleanReminderTimingFromTaskText(text) : text,
          tier: task.tier || 'medium',
          modelListId: task.listId || null,
          routedListId: resolveAiTaskListId({
            text,
            raw: input,
            aiListIdValue: task.listId,
            lists: LISTS,
            destinationHint,
          }),
          reminder,
        };
      }),
    grocery: shouldDropIncidentalAiGroceryRows(input)
      ? []
      : trimGeneratedGroceryRowsForScope(grocery, input)
        .filter(item => groceryDraftAllowedByPersonalContext(item, personalContext)),
  };
}

function assertCase(caseName, routed) {
  const test = CASES[caseName];
  const failures = [];
  const { expect } = test;
  if (expect.minTasks != null && routed.tasks.length < expect.minTasks) failures.push(`expected at least ${expect.minTasks} task(s), got ${routed.tasks.length}`);
  if (expect.maxTasks != null && routed.tasks.length > expect.maxTasks) failures.push(`expected at most ${expect.maxTasks} task(s), got ${routed.tasks.length}`);
  if (expect.noTasks && routed.tasks.length > 0) failures.push(`expected no tasks, got ${routed.tasks.length}`);
  if (expect.minGrocery != null && routed.grocery.length < expect.minGrocery) failures.push(`expected at least ${expect.minGrocery} grocery item(s), got ${routed.grocery.length}`);
  if (expect.maxGrocery != null && routed.grocery.length > expect.maxGrocery) failures.push(`expected at most ${expect.maxGrocery} grocery item(s), got ${routed.grocery.length}`);
  if (expect.noGrocery && routed.grocery.length > 0) failures.push(`expected no grocery items, got ${routed.grocery.length}`);
  if (expect.taskList && routed.tasks.some(task => task.routedListId !== expect.taskList)) {
    failures.push(`expected all tasks routed to ${expect.taskList}, got ${[...new Set(routed.tasks.map(task => task.routedListId))].join(', ')}`);
  }
  if (expect.noReminders && routed.tasks.some(task => !!task.reminder)) failures.push('expected no reminders');
  if (expect.hasReminder && !routed.tasks.some(task => !!task.reminder)) failures.push('expected at least one reminder');
  if (expect.maxReminders != null) {
    const reminderCount = routed.tasks.filter(task => !!task.reminder).length;
    if (reminderCount > expect.maxReminders) failures.push(`expected at most ${expect.maxReminders} reminder(s), got ${reminderCount}`);
  }
  if (expect.noReminderTaskText) {
    expect.noReminderTaskText.forEach(term => {
      if (routed.tasks.some(task => task.reminder && task.text.toLowerCase().includes(term.toLowerCase()))) {
        failures.push(`expected no reminder on task text containing "${term}"`);
      }
    });
  }
  if (expect.reminderTaskText) {
    expect.reminderTaskText.forEach(term => {
      if (!routed.tasks.some(task => task.reminder && task.text.toLowerCase().includes(term.toLowerCase()))) {
        failures.push(`expected reminder on task text containing "${term}"`);
      }
    });
  }
  if (expect.taskTextList) {
    expect.taskTextList.forEach(({ text, listId }) => {
      if (!routed.tasks.some(task => task.routedListId === listId && task.text.toLowerCase().includes(text.toLowerCase()))) {
        failures.push(`expected task text containing "${text}" routed to ${listId}`);
      }
    });
  }
  if (expect.taskTextMaxCount) {
    expect.taskTextMaxCount.forEach(({ text, max }) => {
      const count = routed.tasks.filter(task => task.text.toLowerCase().includes(text.toLowerCase())).length;
      if (count > max) failures.push(`expected task text containing "${text}" at most ${max} time(s), got ${count}`);
    });
  }
  if (expect.minWorkoutDetailRows != null) {
    const count = routed.tasks.filter(task =>
      task.routedListId === 'workout' && workoutTaskRowHasDoseDetail(task.text)
    ).length;
    if (count < expect.minWorkoutDetailRows) failures.push(`expected at least ${expect.minWorkoutDetailRows} detailed workout row(s), got ${count}`);
  }
  if (expect.workoutTextNeedsDetail) {
    expect.workoutTextNeedsDetail.forEach(term => {
      const rows = routed.tasks.filter(task =>
        task.routedListId === 'workout'
        && task.text.toLowerCase().includes(term.toLowerCase())
      );
      if (rows.some(task => !workoutTaskRowHasDoseDetail(task.text))) {
        failures.push(`expected workout task text containing "${term}" to include sets/reps/minutes`);
      }
    });
  }
  if (expect.forbiddenListTaskText) {
    expect.forbiddenListTaskText.forEach(({ text, listId }) => {
      if (routed.tasks.some(task => task.routedListId === listId && task.text.toLowerCase().includes(text.toLowerCase()))) {
        failures.push(`expected no task text containing "${text}" routed to ${listId}`);
      }
    });
  }
  if (expect.forbiddenTaskText) {
    expect.forbiddenTaskText.forEach(term => {
      if (routed.tasks.some(task => task.text.toLowerCase().includes(term.toLowerCase()))) failures.push(`forbidden task text "${term}" found`);
    });
  }
  if (expect.forbiddenGroceryText) {
    const groceryText = routed.grocery.map(grocerySearchText).join(' ');
    expect.forbiddenGroceryText.forEach(term => {
      if (groceryText.includes(term.toLowerCase())) failures.push(`forbidden grocery text "${term}" found`);
    });
  }
  if (expect.groceryText) {
    const groceryText = routed.grocery.map(grocerySearchText).join(' ');
    expect.groceryText.forEach(term => {
      if (!groceryText.includes(term.toLowerCase())) failures.push(`expected grocery text containing "${term}"`);
    });
  }
  if (expect.hasLists) {
    expect.hasLists.forEach(listId => {
      if (!routed.tasks.some(task => task.routedListId === listId)) failures.push(`expected at least one task routed to ${listId}`);
    });
  }
  return failures;
}

async function runCase(provider, apiKey, caseName, promptOverride, promptVariant = 'full') {
  const test = CASES[caseName] || {
    screen: 'grocery',
    input: promptOverride,
    expect: {},
  };
  const input = promptOverride || test.input;
  const personalContext = test.personalContext || '';
  const { system, destinationHint } = buildRouteSystem({ input, screen: test.screen, personalContext, promptVariant });
  const parsed = await requestProvider({ provider, apiKey, system, user: input });
  const usage = lastProviderUsage ? [lastProviderUsage] : [];
  const parsedTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const retryGeneratedTasks = taskRowsNeedGenerationRetry(parsedTasks, input);
  const missingGeneratedTasks = !retryGeneratedTasks && taskRowsMissingGeneratedHint(parsedTasks, input, destinationHint);
  const thinGeneratedTasks = !retryGeneratedTasks && taskRowsNeedGenerationDetailRetry(parsedTasks, input);
  const underfilledGeneratedTasks = !retryGeneratedTasks && !thinGeneratedTasks && taskRowsUnderfillGeneratedTopic(parsedTasks, input);
  if (retryGeneratedTasks || missingGeneratedTasks || underfilledGeneratedTasks || thinGeneratedTasks) {
    const generatedTasks = await generateTaskRowsForAiSlice({ provider, apiKey, input, personalContext, promptVariant }).catch(() => []);
    if (lastProviderUsage) usage.push(lastProviderUsage);
    const concreteGeneratedTasks = concreteGeneratedTaskRows(generatedTasks, input);
    parsed.tasks = retryGeneratedTasks
      ? mergeGeneratedTaskRetryRows(parsedTasks, concreteGeneratedTasks, input)
      : mergeGeneratedTaskExpansionRows(parsedTasks, concreteGeneratedTasks, input);
  }
  parsed.tasks = dropCoveredCompoundTaskRows(dedupeAiTaskRows([...recoveredDirectTaskRowsFromRaw(input, Array.isArray(parsed.tasks) ? parsed.tasks : []), ...(Array.isArray(parsed.tasks) ? parsed.tasks : [])]));
  if (taskRowsUnderfillGeneratedTopic(parsed.tasks, input)) {
    parsed.tasks = mergeGeneratedTaskExpansionRows(parsed.tasks, fallbackGeneratedTaskRowsFromRaw(input), input);
  }
  if (parsed.tasks.length === 0 && (hasDirectTaskActionIntent(input) || hasScheduledEventStatement(input))) {
    parsed.tasks = [taskDraftWithLocalReminder(input, 'medium')];
  }
  let parsedGrocery = Array.isArray(parsed.grocery)
    ? parsed.grocery
      .map(item => normalizeGroceryItem(item, input, shouldInferGroceryQuantities(input)))
      .filter(item => item?.name)
      .filter(item => groceryDraftAllowedByPersonalContext(item, personalContext))
    : [];
  if (groceryDraftsNeedGenerationRetry(parsedGrocery, input) || groceryDraftsNeedPackageSizeRetry(parsedGrocery, input) || groceryDraftsNeedNeededAmountRetry(parsedGrocery, input)) {
    const generatedGrocery = await generateGroceryItemsForAiSlice({ provider, apiKey, input, personalContext }).catch(() => []);
    if (lastProviderUsage) usage.push(lastProviderUsage);
    if (generatedGrocery.length > 0) parsedGrocery = generatedGrocery;
  }
  parsed.grocery = parsedGrocery;
  const routed = localRoute(parsed, input, destinationHint, personalContext);
  const failures = CASES[caseName] ? assertCase(caseName, routed) : [];
  return { caseName, input, promptVariant, destinationHint, parsed, routed, failures, usage };
}

function printResult(result) {
  const status = result.failures.length ? 'FAIL' : 'PASS';
  console.log(`\n[${status}] ${result.caseName} (${result.promptVariant}): ${result.input}`);
  console.log(`hint=${result.destinationHint ? `${result.destinationHint.listName}/${result.destinationHint.listId}` : 'none'}`);
  if (result.usage?.length) {
    const inputTokens = result.usage.reduce((sum, item) => sum + (item.inputTokens || 0), 0);
    const outputTokens = result.usage.reduce((sum, item) => sum + (item.outputTokens || 0), 0);
    const requestChars = result.usage.reduce((sum, item) => sum + (item.requestChars || 0), 0);
    const httpAttempts = result.usage.reduce((sum, item) => sum + (item.httpAttempts || 1), 0);
    console.log(`usage=input ${inputTokens} output ${outputTokens} requests ${result.usage.length} httpAttempts ${httpAttempts} requestChars ${requestChars}`);
  }
  console.log(`tasks=${result.routed.tasks.length} grocery=${result.routed.grocery.length}`);
  result.routed.tasks.forEach((task, index) => {
    console.log(`  task ${index + 1}: [${task.routedListId}] ${task.text}${task.reminder ? ' (reminder)' : ''}`);
  });
  result.routed.grocery.slice(0, 8).forEach((item, index) => {
    console.log(`  grocery ${index + 1}: [${item.category}] ${groceryDisplayName(item)}${item.packageSize ? ` (${item.packageSize})` : ''}`);
  });
  result.failures.forEach(failure => console.log(`  - ${failure}`));
}

function measureCase(caseName, promptOverride, promptVariant = 'full') {
  const test = CASES[caseName] || {
    screen: 'grocery',
    input: promptOverride,
    expect: {},
  };
  const input = promptOverride || test.input;
  const personalContext = test.personalContext || '';
  const { system } = buildRouteSystem({ input, screen: test.screen, personalContext, promptVariant });
  const schema = aiRouteSchema();
  const requestChars = JSON.stringify({
    model: PROVIDERS['claude-haiku'].model,
    max_tokens: 1200,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: input }],
    tools: [{
      name: AI_ROUTE_INPUT_TOOL_NAME,
      description: 'Return structured Triority app rows.',
      input_schema: schema,
    }],
    tool_choice: { type: 'tool', name: AI_ROUTE_INPUT_TOOL_NAME },
  }).length;
  return {
    caseName,
    promptVariant,
    systemChars: system.length,
    userChars: input.length,
    schemaChars: JSON.stringify(schema).length,
    requestChars,
    approxInputTokens: Math.ceil((system.length + input.length + JSON.stringify(schema).length) / 4) + 346,
  };
}

function printMeasure(result) {
  console.log(`${result.caseName} (${result.promptVariant}): approxInput=${result.approxInputTokens} systemChars=${result.systemChars} schemaChars=${result.schemaChars} requestChars=${result.requestChars}`);
}

const LOCAL_REMINDER_CASES = [
  {
    name: 'noon-colon-today',
    now: '2026-05-12T09:00:00-04:00',
    input: 'call physical therapy for Uber at 12:30',
    expectText: 'call physical therapy for Uber',
    expectReminder: true,
    hour: 12,
    minute: 30,
    dayOffset: 0,
  },
  {
    name: 'late-night-compact-next-noon',
    now: '2026-05-12T23:00:00-04:00',
    input: 'call an Uber for PT at 1230',
    expectText: 'call an Uber for PT',
    expectReminder: true,
    hour: 12,
    minute: 30,
    dayOffset: 1,
  },
  {
    name: 'evening-9-means-tonight',
    now: '2026-05-12T20:00:00-04:00',
    input: 'call grandma at 9',
    expectText: 'call grandma',
    expectReminder: true,
    hour: 21,
    minute: 0,
    dayOffset: 0,
  },
  {
    name: 'late-9-means-next-morning',
    now: '2026-05-12T23:00:00-04:00',
    input: 'call grandma at 9',
    expectText: 'call grandma',
    expectReminder: true,
    hour: 9,
    minute: 0,
    dayOffset: 1,
  },
  {
    name: 'explicit-am',
    now: '2026-05-12T23:00:00-04:00',
    input: 'call grandma at 9am',
    expectText: 'call grandma',
    expectReminder: true,
    hour: 9,
    minute: 0,
    dayOffset: 1,
  },
  {
    name: 'appointment-tomorrow-compact',
    now: '2026-05-12T09:00:00-04:00',
    input: 'i have an appointment tomorrow at 330',
    expectText: 'appointment',
    expectReminder: true,
    hour: 15,
    minute: 30,
    dayOffset: 1,
  },
  {
    name: 'wake-relative-days',
    now: '2026-05-12T21:00:00-04:00',
    input: 'remind me to wake up at 8 in 3 days',
    expectText: 'wake up',
    expectReminder: true,
    hour: 8,
    minute: 0,
    dayOffset: 3,
  },
  {
    name: 'meeting-today-compact',
    now: '2026-05-12T09:00:00-04:00',
    input: 'got a meeting at 1045',
    expectText: 'meeting',
    expectReminder: true,
    hour: 10,
    minute: 45,
    dayOffset: 0,
  },
  {
    name: 'date-only-is-not-reminder',
    now: '2026-05-12T09:00:00-04:00',
    input: 'call grandma tomorrow',
    expectReminder: false,
  },
  {
    name: 'plain-number-is-not-time',
    now: '2026-05-12T09:00:00-04:00',
    input: 'order 12 quick crimps for sv4',
    expectReminder: false,
  },
  {
    name: 'listing-task-no-time',
    now: '2026-05-12T09:00:00-04:00',
    input: 'Make a listing for custom orders on Etsy',
    expectReminder: false,
  },
  {
    name: 'tools-list-no-time',
    now: '2026-05-12T09:00:00-04:00',
    input: 'Make list of in-house tools vs shed tools',
    expectReminder: false,
  },
  {
    name: 'ring-doorbell-no-time',
    now: '2026-05-12T09:00:00-04:00',
    input: 'Set up Ring doorbell Wi-Fi again',
    expectReminder: false,
  },
];

function localCalendarDayOffset(nowMs, remindAt) {
  const nowDate = new Date(nowMs);
  const reminderDate = new Date(remindAt);
  const nowStart = new Date(nowDate);
  nowStart.setHours(0, 0, 0, 0);
  const reminderStart = new Date(reminderDate);
  reminderStart.setHours(0, 0, 0, 0);
  return Math.round((reminderStart.getTime() - nowStart.getTime()) / 86400000);
}

function runLocalReminderCases() {
  let failed = 0;
  LOCAL_REMINDER_CASES.forEach((test) => {
    const nowMs = new Date(test.now).getTime();
    const draft = taskDraftWithLocalReminder(test.input, 'medium', null, nowMs);
    const failures = [];
    if (test.expectReminder && !draft.reminder) {
      failures.push('expected reminder');
    }
    if (!test.expectReminder && draft.reminder) {
      failures.push('expected no reminder');
    }
    if (test.expectText && draft.text !== test.expectText) {
      failures.push(`expected text "${test.expectText}", got "${draft.text}"`);
    }
    if (draft.reminder && test.hour != null) {
      const reminderDate = new Date(draft.reminder.remindAt);
      if (reminderDate.getHours() !== test.hour) failures.push(`expected hour ${test.hour}, got ${reminderDate.getHours()}`);
      if (reminderDate.getMinutes() !== test.minute) failures.push(`expected minute ${test.minute}, got ${reminderDate.getMinutes()}`);
      const dayOffset = localCalendarDayOffset(nowMs, draft.reminder.remindAt);
      if (dayOffset !== test.dayOffset) failures.push(`expected day offset ${test.dayOffset}, got ${dayOffset}`);
    }
    const status = failures.length ? 'FAIL' : 'PASS';
    console.log(`[${status}] ${test.name}: ${test.input}${draft.reminder ? ` -> ${draft.text} @ ${new Date(draft.reminder.remindAt).toLocaleString()}` : ' -> no reminder'}`);
    failures.forEach(failure => console.log(`  - ${failure}`));
    if (failures.length) failed += 1;
  });
  return failed;
}

const args = parseArgs(process.argv);
if (!PROMPT_VARIANTS.has(args.promptVariant)) {
  throw new Error(`Unknown prompt variant "${args.promptVariant}". Use ${Array.from(PROMPT_VARIANTS).join(', ')}.`);
}
if (args.modelOverride) {
  if (!PROVIDERS[args.provider]) throw new Error(`Unknown provider "${args.provider}". Use ${Object.keys(PROVIDERS).join(', ')}.`);
  PROVIDERS[args.provider].model = args.modelOverride;
}
if (args.localReminderOnly) {
  process.exitCode = runLocalReminderCases() ? 1 : 0;
} else {
const apiKey = args.measureOnly ? '' : readSecret(args.provider);
const caseNames = args.prompt
  ? ['custom']
  : args.caseName === 'all'
    ? Object.keys(CASES)
    : [args.caseName];

let failed = 0;
for (const caseName of caseNames) {
  try {
    if (args.measureOnly) {
      printMeasure(measureCase(caseName, args.prompt, args.promptVariant));
    } else {
      const result = await runCase(args.provider, apiKey, caseName, args.prompt, args.promptVariant);
      printResult(result);
      if (result.failures.length) failed += 1;
    }
  } catch (error) {
    failed += 1;
    console.log(`\n[ERROR] ${caseName}: ${error?.message || error}`);
  }
}

process.exitCode = failed ? 1 : 0;
}
