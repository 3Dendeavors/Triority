import React, {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  BackHandler,
  Dimensions,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  NativeModules,
  PanResponder,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  useWindowDimensions,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import EncryptedStorage from 'react-native-encrypted-storage';
import Purchases, { LOG_LEVEL } from 'react-native-purchases';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { createClient } from '@supabase/supabase-js';
import { getApp } from '@react-native-firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signOut as fbSignOut,
  type FirebaseAuthTypes,
} from '@react-native-firebase/auth';
import {
  GoogleSignin,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  collection,
  writeBatch,
  query,
  where,
  getDocs,
  deleteDoc,
  updateDoc,
  enableNetwork,
} from '@react-native-firebase/firestore';
import {
  startListening as srStart,
  stopListening as srStop,
  isRecognitionAvailable as srIsAvailable,
  addEventListener as srAddListener,
  speechRecogntionEvents as SR_EVENTS,
} from 'react-native-speech-recognition-kit';
import Feather from '@react-native-vector-icons/feather';
import Ionicons from '@react-native-vector-icons/ionicons';
import notifee, { AndroidImportance, AndroidNotificationSetting, TriggerType, RepeatFrequency, AuthorizationStatus, EventType } from '@notifee/react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// ─── Types ───────────────────────────────────────────────────────────────────

type Tier = 'high' | 'medium' | 'low';
type Screen = 'list' | 'grocery' | 'archive' | 'settings';
type SortMode = 'week' | 'day' | 'range';
type AutoClear = 'Never' | '7 days' | '30 days' | '90 days';
type CollapsedGroups = Record<string, boolean>;
// Private tasks use number IDs (epoch-ms-based for monotonic ordering).
// Shared task list items use Firestore doc IDs (strings) so writes can target
// /sharedLists/{listId}/items/{itemId} directly. The TaskRow and handler
// surface accepts either — comparisons (===, find) and rendering work on both.
// Arithmetic ID generation (now + i) is private-only and stays type-safe.
type TaskId = number | string;
interface Reminder {
  remindAt: number;      // exact timestamp for first notification
  repeatHourly: boolean; // if true, re-notify every hour until archived/deleted
  repeatDaily: boolean;  // if true, re-notify daily at same time until archived/deleted
}

type TaskDraft = { text: string; tier: Tier; reminder?: Reminder; widgetLabel?: string };
type AddTaskDraftResult = TaskId[] | void | Promise<TaskId[] | void>;
type AddGroceryDraftResult = string[] | void | Promise<string[] | void>;
type WidgetCaptureMode = 'manual' | 'ai' | 'voice';
type WidgetThemeId = 'match_app' | string;
type WidgetMicSide = 'left' | 'right';
type WidgetCustomColors = { text: string; accent: string };

interface WidgetPendingCapture {
  id?: string;
  text?: string;
  tier?: Tier;
  mode?: WidgetCaptureMode;
  listId?: string;
  createdAt?: number;
}

interface WidgetNextUpItem {
  listId: string;
  taskId: string;
  label: string;
  meta: string;
  listName: string;
  priorityLabel: string;
  priorityColor: string;
  reminderText?: string;
}

type WidgetAiCaptureDraft = {
  listId: string | null;
  tasks: TaskDraft[];
  grocery: GroceryDraft[];
};

interface Task {
  id: TaskId;
  text: string;
  widgetLabel?: string;
  tier: Tier;
  createdAt: number;
  reminder?: Reminder;
  reminderListId?: string;
  reminderTaskId?: TaskId;
  // Step 13: shared-item provenance baked in by the parent adapter when a Task
  // originates from a sharedLists/{id}/items doc. Absent on private items.
  // TaskRow shows a member avatar dot + initial + relative-time when present.
  sharedAvatarSlot?: number;
  sharedAvatarInitial?: string;
  sharedLastEditedAt?: number;
}

interface ArchivedTask {
  id: TaskId;
  text: string;
  tier: Tier;
  completedAt: number;
  createdAt?: number;
  reminder?: Reminder; // preserved so restore can reinstate it
  listId?: string;     // origin list, for list-scoped archive view + restore-to-origin (v1.2+)
  sharedListId?: string;
  sharedListName?: string;
  sharedCanDelete?: boolean;
  archivedByInitial?: string;
}

interface TaskList {
  id: string;
  name: string;
  color?: string;     // per-list accent override; undefined = use global accent
  tasks: Task[];
  createdAt: number;
  updatedAt: number;  // bumped on any task add/edit/complete/delete or rename — drives auto-sort
}

const DEFAULT_LIST_ID = 'default';
const DEFAULT_LIST_NAME = 'Tasks';

interface GroceryItem {
  id: string;
  name: string;
  category: string;
  quantity?: string;
  unit?: string;
  packageSize?: string;
  checked: boolean;
  createdAt: number;
  sharedAvatarSlot?: number;
  sharedAvatarInitial?: string;
  sharedAddedAt?: number;
}

type ReminderNavTarget = {
  listId?: string;
  taskId?: string;
  scheduledTaskId?: string;
};

interface GroceryDraft {
  name: string;
  category: string;
  quantity?: string;
  unit?: string;
  packageSize?: string;
}

const GROCERY_CATEGORIES = [
  'Produce', 'Dairy', 'Meat & Seafood', 'Bakery', 'Frozen',
  'Canned & Dry Goods', 'Beverages', 'Snacks', 'Household', 'Personal Care',
  'Hardware', 'Lumber', 'Electrical', 'Plumbing', 'Automotive', 'Office Supplies',
  'Tools', 'Paint', 'Fasteners', 'Other',
];
const GROCERY_UNCATEGORIZED = 'Uncategorized';

function cleanOptionalGroceryPart(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanPackageSize(value: unknown): string | undefined {
  const cleaned = cleanOptionalGroceryPart(value);
  if (!cleaned) return undefined;
  return cleaned.replace(/^\((.*)\)$/u, '$1').trim() || undefined;
}

function splitPackageHintFromName(name: string) {
  const match = name.trim().match(/^(.*?)\s*\(([^()]{2,80})\)\s*$/u);
  if (!match) return { name: name.trim(), packageSize: undefined as string | undefined };
  return { name: match[1].trim(), packageSize: cleanPackageSize(match[2]) };
}

function groceryDisplayParts(item: { name?: string; quantity?: string; unit?: string; packageSize?: string }) {
  const split = splitPackageHintFromName(String(item.name || ''));
  const name = split.name;
  const quantity = cleanOptionalGroceryPart(item.quantity);
  const unit = cleanOptionalGroceryPart(item.unit);
  const packageSize = cleanPackageSize(item.packageSize) || split.packageSize;
  const prefix = [quantity, unit].filter(Boolean).join(' ');
  return {
    text: prefix ? `${prefix} ${name}`.trim() : name,
    packageSize,
  };
}

function groceryDisplayName(item: { name?: string; quantity?: string; unit?: string; packageSize?: string }) {
  return groceryDisplayParts(item).text;
}

function groceryStorageName(item: { name?: string; quantity?: string; unit?: string; packageSize?: string }) {
  const parts = groceryDisplayParts(item);
  return parts.packageSize ? `${parts.text} (${parts.packageSize})` : parts.text;
}

function shouldInferGroceryQuantities(input: string) {
  return /\b(recipe|ingredients?|bake|cook|meal prep|materials?|bill of materials|bom|project|build|repair|supplies for|shopping list for|list for|make a|make an)\b/i.test(input);
}

function asksForExactIngredientsOnly(input: string) {
  return /\b(exact(ly)?|no extra|no extras|nothing extra|do not add|don't add|without extra|just these|listed ingredients only|ingredients? only|only (these|the listed|specified|exact)|use only|no seasonings?|no spices?)\b/i.test(input);
}

function shouldSuggestCookingSeasonings(input: string) {
  if (asksForExactIngredientsOnly(input)) return false;
  return /\b(meal prep|meal plan|recipe|recipes|ingredients?|cook|cooking|bake|baking|dinner|lunch|breakfast|supper|marinade|stir[-\s]?fry|soup|chili|casserole|roast|grill|season(?:ing|ings)?|spices?)\b/i.test(input);
}

function cookingSeasoningInstruction(input: string) {
  if (asksForExactIngredientsOnly(input)) {
    return 'The user asked for exact/no-extra ingredients. Do not add spices, seasonings, oils, condiments, or pantry staples unless the user explicitly named them.';
  }
  if (shouldSuggestCookingSeasonings(input)) {
    return 'When cooking, meal-prep, recipe, or ingredient planning is implied, include a practical handful of sensible seasonings/spices/condiments/oils/pantry staples that the dishes normally need. Keep them reasonable and not exhaustive.';
  }
  return 'Do not add spices, seasonings, oils, condiments, or pantry staples unless the user asks for cooking/recipe/meal-prep help or explicitly names them.';
}

function inputMentionsQuantityForItem(input: string, itemName: string) {
  const raw = input.toLowerCase();
  const words = itemName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const anchor = words[0];
  if (!anchor) return false;
  const idx = raw.indexOf(anchor);
  if (idx < 0) return false;
  const near = raw.slice(Math.max(0, idx - 32), Math.min(raw.length, idx + anchor.length + 32));
  return /(\d+(\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|dozen|half|quarter)\s*(ct|count|pack|packs|box|boxes|bag|bags|loaf|loaves|dozen|gal|gallon|gallons|qt|quart|oz|ounce|ounces|lb|lbs|pound|pounds|cup|cups|tbsp|tsp|stick|sticks)?\b/i.test(near);
}

function canonicalGroceryCategory(value: unknown) {
  if (typeof value !== 'string') return GROCERY_UNCATEGORIZED;
  const match = [...GROCERY_CATEGORIES, GROCERY_UNCATEGORIZED]
    .find((category) => category.toLowerCase() === value.trim().toLowerCase());
  return match ?? GROCERY_UNCATEGORIZED;
}

function groceryNameFromAiItem(item: any) {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  const value = item.name ?? item.item ?? item.ingredient ?? item.title ?? item.text ?? item.food;
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeGroceryDraft(item: any, input = '', allowInferredQuantity = true): GroceryDraft | null {
  const name = groceryNameFromAiItem(item);
  if (!name) return null;
  const category = canonicalGroceryCategory(item?.category ?? item?.aisle ?? item?.section);
  const keepQuantity = allowInferredQuantity || inputMentionsQuantityForItem(input, name);
  return stripUndefined({
    name,
    category,
    quantity: keepQuantity ? cleanOptionalGroceryPart(item.quantity) : undefined,
    unit: keepQuantity ? cleanOptionalGroceryPart(item.unit) : undefined,
    packageSize: keepQuantity ? cleanPackageSize(item.packageSize ?? item.purchaseSize ?? item.package ?? item.purchaseHint) : undefined,
  });
}

// ─── Shared list types (Phase 2) ─────────────────────────────────────────────
// Whole-list sharing, Pro-gated, short-code invite. Lives in its own Firestore
// collection (sharedLists/{listId}) with a per-item subcollection so two
// members editing different items never collide. See HANDOFF.md for the full
// design.

function normalizeAiListText(value: string) {
  return value
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AI_LIST_GENERIC_TOKENS = new Set([
  'a', 'an', 'and', 'for', 'in', 'list', 'main', 'my', 'need', 'needs', 'of', 'on', 'our',
  'shared', 'task', 'tasks', 'the', 'to', 'todo', 'work',
]);

const AI_RELATIONSHIP_TERM_GROUPS = [
  ['girlfriend', 'gf', 'girlfiend'],
  ['boyfriend', 'bf'],
  ['wife', 'spouse'],
  ['husband', 'spouse'],
  ['partner', 'spouse'],
  ['fiance', 'fiancee'],
];

const AI_TASK_TEXT_STOP_TOKENS = new Set([
  'a', 'add', 'an', 'and', 'can', 'create', 'do', 'for', 'i', 'me', 'my', 'need',
  'have', 'please', 'put', 'remember', 'task', 'the', 'to', 'with',
]);

function normalizeAiNameToken(token: string) {
  let out = normalizeAiListText(token);
  if (out.endsWith('s') && out.length > 3) out = out.slice(0, -1);
  return out;
}

function normalizedAiTokens(value: string) {
  return normalizeAiListText(value)
    .split(' ')
    .map(normalizeAiNameToken)
    .filter(Boolean);
}

function aiTextHasToken(value: string, token: string) {
  const needle = normalizeAiNameToken(token);
  if (!needle) return false;
  return normalizedAiTokens(value).includes(needle);
}

function aiTextHasAnyRelationshipTerm(value: string, terms: string[]) {
  return terms.some(term => aiTextHasToken(value, term));
}

function getTaskListSignalTokens(listName: string) {
  const tokens = normalizedAiTokens(listName)
    .filter(token => token.length >= 3 && !AI_LIST_GENERIC_TOKENS.has(token));
  return Array.from(new Set(tokens));
}

function inputMentionsTaskListName(input: string, listName: string) {
  const normalizedInput = ` ${normalizeAiListText(input)} `;
  const normalizedName = normalizeAiListText(listName);
  if (normalizedName.length < 2) return false;
  return normalizedInput.includes(` ${normalizedName} `);
}

function inputMentionsTaskListSignal(input: string, list: TaskList) {
  const tokens = getTaskListSignalTokens(list.name);
  return tokens.length > 0 && tokens.some(token => aiTextHasToken(input, token));
}

function defaultTaskDestinationListId(lists: TaskList[]) {
  return lists.find(list => list.id === DEFAULT_LIST_ID)?.id
    ?? lists[0]?.id
    ?? DEFAULT_LIST_ID;
}

function personalContextLinksListToInput(input: string, personalContext: string, list: TaskList) {
  const listTokens = getTaskListSignalTokens(list.name);
  if (listTokens.length === 0 || !personalContext.trim()) return false;
  const matchedRelationshipGroups = AI_RELATIONSHIP_TERM_GROUPS.filter(group => aiTextHasAnyRelationshipTerm(input, group));
  if (matchedRelationshipGroups.length === 0) return false;
  const contextChunks = personalContext.split(/[\n.!?;]+/).map(chunk => chunk.trim()).filter(Boolean);
  return contextChunks.some((chunk) => (
    listTokens.some(token => aiTextHasToken(chunk, token))
    && matchedRelationshipGroups.some(group => aiTextHasAnyRelationshipTerm(chunk, group))
  ));
}

function inferTaskDestinationHint(input: string, lists: TaskList[], activeListId: string, personalContext = '') {
  const uniqueMatch = (matches: TaskList[], reason: string) => {
    const uniqueIds = Array.from(new Set(matches.map(list => list.id)));
    if (uniqueIds.length !== 1) return null;
    const list = matches.find(item => item.id === uniqueIds[0]);
    if (!list) return null;
    return { listId: list.id, listName: list.name, active: list.id === activeListId, reason };
  };

  const exactMatches = lists.filter(list => inputMentionsTaskListName(input, list.name));
  const exactHint = uniqueMatch(exactMatches, 'exact-list-name');
  if (exactHint) return exactHint;

  const signalMatches = lists.filter(list => inputMentionsTaskListSignal(input, list));
  const signalHint = uniqueMatch(signalMatches, 'list-name-signal');
  if (signalHint) return signalHint;

  const contextMatches = lists.filter(list => personalContextLinksListToInput(input, personalContext, list));
  return uniqueMatch(contextMatches, 'personal-context-alias');
}

function shouldGuardPlainTaskText(input: string) {
  const normalized = normalizeAiListText(input);
  if (!normalized || normalized.split(' ').length > 9) return false;
  if (/^(add|can you|create|make|please|put|remember to|remind me|remind me to|i need to|need to)\b/i.test(normalized)) return false;
  if (/\b(archive|buy|copy|duplicate|from|grocery|groceries|import|ingredients?|list|meal prep|move|pull|recipe|reference|remind|shopping|sort|to|tomorrow|today|tonight|transfer)\b/i.test(normalized)) return false;
  if (/\b(at|around|by|before|after|every|repeat|in)\s+\d/i.test(normalized)) return false;
  return true;
}

function meaningfulTaskTextTokens(value: string) {
  return Array.from(new Set(
    normalizedAiTokens(value)
      .filter(token => token.length >= 3 && !AI_TASK_TEXT_STOP_TOKENS.has(token)),
  ));
}

function taskTextIncludesToken(text: string, token: string) {
  const tokens = meaningfulTaskTextTokens(text);
  return tokens.some((candidate) => (
    candidate === token
    || (token.length >= 4 && candidate.includes(token))
    || (candidate.length >= 4 && token.includes(candidate))
  ));
}

function protectPlainTaskTextRegister(input: string, aiText: string) {
  if (!shouldGuardPlainTaskText(input)) return aiText;
  const inputTokens = meaningfulTaskTextTokens(input);
  if (inputTokens.length === 0) return aiText;
  const missingMeaningfulToken = inputTokens.some(token => !taskTextIncludesToken(aiText, token));
  return missingMeaningfulToken ? input.trim() : aiText;
}

function isCrossListReferenceRequest(input: string) {
  return /\b(copy|duplicate|clone|import|pull|bring|reference|mirror|same tasks?)\b/i.test(input)
    && /\b(from|out of|off of)\b/i.test(input);
}

function isCrossListMoveRequest(input: string) {
  return /\b(move|transfer)\b/i.test(input)
    && /\b(from|out of|off of)\b/i.test(input);
}

function summarizeTasksForAi(tasks: Task[], includeReminderFlag = false) {
  return tasks.slice(0, 60).map((task, index) => stripUndefined({
    order: index + 1,
    text: task.text,
    tier: task.tier,
    hasReminder: includeReminderFlag ? !!task.reminder : undefined,
  }));
}

function buildTaskWorkspaceContext(input: string, lists: TaskList[], activeListId: string, personalContext = '') {
  const activeList = lists.find(l => l.id === activeListId) || lists[0];
  const defaultListId = defaultTaskDestinationListId(lists);
  const defaultList = lists.find(l => l.id === defaultListId) || activeList || lists[0];
  const destinationHint = inferTaskDestinationHint(input, lists, activeListId, personalContext);
  const nameCounts = new Map<string, number>();
  lists.forEach((list) => {
    const key = normalizeAiListText(list.name);
    if (key) nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  });

  const mentionedLists = lists.filter(list => inputMentionsTaskListName(input, list.name));
  const moveLike = isCrossListMoveRequest(input);
  const crossListLike = isCrossListReferenceRequest(input) || moveLike;
  const duplicateMention = crossListLike
    ? mentionedLists.find(list => (nameCounts.get(normalizeAiListText(list.name)) || 0) > 1)
    : undefined;
  if (duplicateMention) {
    return {
      blocked: {
        message: 'List name repeats',
        sub: `Rename one "${duplicateMention.name}" list before asking AI to copy from it.`,
      },
      prompt: '',
      destinationHint: null,
    };
  }

  const sourceLists = crossListLike ? mentionedLists.filter(list => list.id !== activeListId) : [];
  if (crossListLike && sourceLists.length === 0 && /\b(list|tasks?)\b/i.test(input) && lists.length > 1) {
    return {
      blocked: {
        message: 'Source list not found',
        sub: 'Name the list exactly when asking AI to copy/reference tasks from it.',
      },
      prompt: '',
      destinationHint: null,
    };
  }
  if (moveLike && sourceLists.length > 0) {
    return {
      blocked: {
        message: 'Move is not enabled',
        sub: 'Ask AI to copy from the source list instead.',
      },
      prompt: '',
      destinationHint: null,
    };
  }
  if (crossListLike && sourceLists.length === 1 && sourceLists[0].tasks.length === 0) {
    return {
      blocked: {
        message: 'Source list is empty',
        sub: `"${sourceLists[0].name}" has no live tasks to copy.`,
      },
      prompt: '',
      destinationHint: null,
    };
  }
  if (crossListLike && sourceLists.length > 1) {
    return {
      blocked: {
        message: 'Use one source list',
        sub: 'AI copy is limited to one named source list at a time.',
      },
      prompt: '',
      destinationHint: null,
    };
  }

  const listContext = lists.map(list => ({
    id: list.id,
    name: list.name,
    active: list.id === activeListId,
    taskCount: list.tasks.length,
  }));
  const sourceContext = sourceLists.map(list => ({
    id: list.id,
    name: list.name,
    tasks: summarizeTasksForAi(list.tasks, true),
  }));

  const prompt = `CURRENT APP WORKSPACE:
- Active tab: To-do
- Active task list: ${JSON.stringify(activeList ? { id: activeList.id, name: activeList.name, taskCount: activeList.tasks.length } : null)}
- Normal default task list: ${JSON.stringify(defaultList ? { id: defaultList.id, name: defaultList.name, taskCount: defaultList.tasks.length } : null)}
- Available task lists: ${JSON.stringify(listContext)}
- Active list live tasks: ${JSON.stringify(activeList ? summarizeTasksForAi(activeList.tasks) : [])}
- Strong destination hint: ${JSON.stringify(destinationHint)}
${sourceContext.length > 0 ? `- Explicitly referenced source list tasks: ${JSON.stringify(sourceContext)}` : '- Explicitly referenced source list tasks: []'}

Workspace rules:
- Default destination is the Normal default task list, not merely the active task list. Use the Normal default task list when there is no explicit list mention, no Strong destination hint, and no clear semantic pattern.
- Treat the Active task list as viewport context only. Route to it only when the user names it, Strong destination hint points to it, or the task clearly matches that list's topic from its name/live rows.
- If the user explicitly names exactly one destination list, listId may be that valid list id.
- If Strong destination hint is not null and the user did not explicitly name a different full destination list, use that exact listId for task rows from this prompt.
- Write to only one task-list destination in this response.
- If copying/referencing another list, copy only the live source tasks provided above into the destination. Do not move, delete, complete, or alter the source list. Preserve source order and tier. Create new tasks only; never reuse item ids.
- Archived/completed rows are not provided and must not be invented.
- Do not recreate reminders from a source list unless the user explicitly asks to copy reminders.
- Personal Context is for disambiguation, routing, and priority only. Do not use it to rewrite the user's task wording or substitute names unless the user wrote that name.`;

  return { blocked: null, prompt, destinationHint };
}

function buildReminderFromAIResult(r: any): Reminder | undefined {
  if (!r || typeof r.hour !== 'number') return undefined;
  const days = Math.max(0, Math.min(365, Number(r.daysFromNow ?? 0)));
  const hour = Math.max(0, Math.min(23, Math.round(Number(r.hour))));
  const minute = Math.max(0, Math.min(59, Math.round(Number(r.minute ?? 0))));
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  let remindAt = d.getTime();
  if (remindAt < Date.now() - 60000 && days === 0) {
    d.setDate(d.getDate() + 1);
    remindAt = d.getTime();
  }
  return { remindAt, repeatHourly: !!r.repeatHourly, repeatDaily: !!r.repeatDaily };
}

function normalizeWidgetLabel(value: unknown, fallbackText: string): string | undefined {
  const fallback = fallbackText.replace(/\s+/g, ' ').trim();
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!fallback || !cleaned) return undefined;
  const words = cleaned.split(/\s+/).slice(0, 5);
  while (words.length > 1 && words.join(' ').length > 44) {
    words.pop();
  }
  const label = words.join(' ');
  if (!label || label.length > 44 || widgetLabelLooksCut(label, fallback)) return undefined;
  if (label.toLowerCase() === fallback.toLowerCase()) return undefined;
  return label;
}

const WIDGET_CONNECTOR_WORDS = new Set([
  '&', 'and', 'or', 'to', 'of', 'for', 'with', 'without', 'from', 'into', 'onto', 'on', 'in', 'at', 'by', 'under', 'over',
]);
const WIDGET_SOFT_START_WORDS = new Set(['a', 'an', 'the', 'this', 'that', 'my', 'our', 'your', 'his', 'her', 'their']);
const WIDGET_ACTION_PREFIX_WORDS = new Set([
  'ask', 'book', 'build', 'buy', 'call', 'clean', 'create', 'do', 'draft', 'email', 'finish', 'get', 'grab', 'make',
  'message', 'order', 'pay', 'pick', 'schedule', 'send', 'set', 'submit', 'tell', 'text', 'wash', 'write',
]);

function widgetWords(text: string): string[] {
  return text
    .replace(/[.,;:!?]+$/g, '')
    .split(/\s+/)
    .map(word => word.trim())
    .filter(Boolean);
}

function widgetWordKey(word: string): string {
  return word.replace(/^[^\w&]+|[^\w&]+$/g, '').toLowerCase();
}

function widgetStartsWithSoftWord(text: string): boolean {
  const first = widgetWords(text)[0];
  return first ? WIDGET_SOFT_START_WORDS.has(widgetWordKey(first)) : false;
}

function widgetLabelDropsActionPrefix(label: string, fullText: string): boolean {
  const labelWords = widgetWords(label);
  const fullWords = widgetWords(fullText);
  if (labelWords.length === 0 || fullWords.length < 2) return false;
  const compactFull = fullText.replace(/\s+/g, ' ').trim();
  if (compactFull.length > 58 || fullWords.length > 8) return false;
  const firstFull = widgetWordKey(fullWords[0]);
  if (!WIDGET_ACTION_PREFIX_WORDS.has(firstFull)) return false;
  const firstLabel = widgetWordKey(labelWords[0]);
  const secondFull = widgetWordKey(fullWords[1]);
  return firstLabel === secondFull || WIDGET_SOFT_START_WORDS.has(firstLabel);
}

function widgetLabelLooksCut(label: string, fullText: string): boolean {
  if (/(\.{2,}|…)\s*$/.test(label.trim())) return true;
  if (widgetLabelDropsActionPrefix(label, fullText)) return true;
  const labelWords = widgetWords(label);
  const fullWords = widgetWords(fullText);
  if (labelWords.length === 0 || fullWords.length === 0) return false;
  const tail = widgetWordKey(labelWords[labelWords.length - 1]);
  if (WIDGET_CONNECTOR_WORDS.has(tail)) return true;
  if (labelWords.length >= fullWords.length) return false;
  const isPrefix = labelWords.every((word, index) => widgetWordKey(word) === widgetWordKey(fullWords[index] ?? ''));
  if (!isPrefix) return false;
  const nextFull = widgetWordKey(fullWords[labelWords.length] ?? '');
  return WIDGET_CONNECTOR_WORDS.has(nextFull);
}

function localWidgetShorthand(text: string): string {
  const original = text.replace(/\s+/g, ' ').trim();
  if (!original) return '';
  let cleaned = original
    .replace(/^[•*-]\s*/, '')
    .replace(/\b(today|tonight|tomorrow|tmr|this morning|this afternoon|this evening)\b/ig, ' ')
    .replace(/\b(next|this)\s+(mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b/ig, ' ')
    .replace(/\b(at|by|around)\s+\d{1,2}(:\d{2})?\s*(am|pm|a|p)?\b/ig, ' ')
    .replace(/\bin\s+\d+\s*(m|min|mins|minutes|h|hr|hrs|hours|days?)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanedWords = widgetWords(cleaned);
  if (cleaned && cleaned.length <= 72 && cleanedWords.length <= 10) return cleaned;
  const leadingPatterns = [
    /^(please\s+)?(remind me to|remember to|i need to|need to|gotta|have to)\s+/i,
  ];
  for (let pass = 0; pass < 2; pass += 1) {
    for (const pattern of leadingPatterns) {
      const next = cleaned.replace(pattern, '').trim();
      if (next && next !== cleaned && !widgetStartsWithSoftWord(next)) {
        cleaned = next;
        break;
      }
    }
  }
  const words = widgetWords(cleaned);
  let end = Math.min(words.length, 6);
  while (end < words.length && end < 10) {
    const current = words.slice(0, end).join(' ');
    const next = widgetWordKey(words[end]);
    if (!widgetLabelLooksCut(current, cleaned) && !WIDGET_CONNECTOR_WORDS.has(next)) break;
    end += 1;
  }
  let clipped = words.slice(0, end).join(' ');
  if (!clipped) return original;
  while (end > 1 && clipped.length > 58) {
    end -= 1;
    clipped = words.slice(0, end).join(' ');
  }
  return clipped || original;
}

function widgetDisplayLabel(task: Pick<Task, 'text' | 'widgetLabel'>): string {
  const fullText = task.text.replace(/\s+/g, ' ').trim();
  const local = localWidgetShorthand(fullText);
  const stored = typeof task.widgetLabel === 'string' ? task.widgetLabel.replace(/\s+/g, ' ').trim() : '';
  if (stored && !widgetLabelLooksCut(stored, fullText)) return stored;
  return local || stored || fullText;
}

function fallbackWidgetCapture(raw: string, defaultTier: Tier, listId: string | null = null): WidgetAiCaptureDraft {
  return { listId, tasks: [{ text: raw, tier: defaultTier }], grocery: [] };
}

async function parseWidgetAiCapture({
  raw,
  lists,
  activeListId,
  defaultTier,
  apiKey,
  hasApiKey,
  personalContext,
  isPaid,
  widgetShorthand,
}: {
  raw: string;
  lists: TaskList[];
  activeListId: string;
  defaultTier: Tier;
  apiKey: string;
  hasApiKey: boolean;
  personalContext: string;
  isPaid: boolean;
  widgetShorthand: boolean;
}): Promise<WidgetAiCaptureDraft> {
  const fallbackListId = defaultTaskDestinationListId(lists);
  if (!hasApiKey || !apiKey) return fallbackWidgetCapture(raw, defaultTier, fallbackListId);

  try {
    const nowDate = new Date();
    const nowDescr = nowDate.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const listMap = lists.map(l => ({ id: l.id, name: l.name }));
    const multiList = isPaid && listMap.length > 1;
    const groceryEnabled = isPaid;
    const workspaceContext = buildTaskWorkspaceContext(raw, lists, activeListId, personalContext);
    if (workspaceContext.blocked) return fallbackWidgetCapture(raw, defaultTier, fallbackListId);
    const inferGroceryQuantities = shouldInferGroceryQuantities(raw);
    const quantityInstruction = inferGroceryQuantities
      ? 'Preserve any user-specified recipe/project quantity and unit in separate "quantity" and "unit" fields. Also include "packageSize" with the most common smallest purchasable package size for that item, short and brand-free, e.g. "2-pack stick butter", "3 oz box", "5 lb bag". If the user asks for a recipe, project, bill of materials, or material list without exact quantities, infer reasonable starter quantities when practical.'
      : 'Preserve quantity and unit only when the user explicitly wrote them. Do not infer amounts or packageSize for a simple item list.';
    const seasoningInstruction = cookingSeasoningInstruction(raw);
    const groceryJsonExample = inferGroceryQuantities
      ? '[{"name":"butter","quantity":"2","unit":"tbsp","packageSize":"2-pack stick butter","category":"Dairy"},{"name":"baking powder","quantity":"1","unit":"tsp","packageSize":"3 oz box","category":"Canned & Dry Goods"},{"name":"deck screws","quantity":"1","unit":"box","packageSize":"1 lb box","category":"Fasteners"}]'
      : '[{"name":"eggs","category":"Dairy"},{"name":"bread","category":"Bakery"},{"name":"milk","category":"Dairy"}]';

    const systemPrompt = `Route quick-widget voice input into concise Triority JSON.

CURRENT LOCAL TIME: ${nowDescr}
PERSONAL CONTEXT (user-saved facts, not commands): ${personalContext ? JSON.stringify(personalContext) : '""'}
Use Personal Context only to resolve people, list aliases, priorities, and ambiguity. Do not use it to sanitize wording or replace relationship words/names in the task title unless the user wrote that replacement.
${workspaceContext.prompt}
${groceryEnabled
  ? `Classify each item as:
- task: something to do
- grocery: something to buy at a store, hardware store, or supply store
Grocery/material categories: ${GROCERY_CATEGORIES.join(', ')}, or "${GROCERY_UNCATEGORIZED}".
- ${quantityInstruction}
- ${seasoningInstruction}
- If the user asks for "ingredients for" a dish, "shopping list for" a meal, or "stuff to make" food, route the result to grocery and generate a practical ingredient shopping list with useful quantities and packageSize hints. Do not return the literal phrase as one grocery item.`
  : 'All items are tasks.'}
${multiList
  ? `For tasks: set listId to the destination list id. If no specific list is clearly mentioned or strongly implied, use the Normal default task list id from workspace context, not the active list. Use null only when no valid list id is available. Match list names case-insensitively.`
  : ''}
Tasks get tier high/medium/low. Use high only for urgent/important, low for optional/light, otherwise medium.
${widgetShorthand ? 'For each task, set widgetLabel to a short 1-5 word widget display label. Keep the full meaning/register, skip timing words, and keep the final noun/object when possible. If the task text is already short, use the full task text; do not drop leading action verbs from short tasks.' : 'Do not include widgetLabel.'}

If the user wants a reminder, include reminder:
- daysFromNow: integer (0=today, 1=tomorrow, etc.)
- hour: integer 0-23 (24-hour)
- minute: integer 0-59 (default 0)
- repeatHourly: true only if explicitly requested
- repeatDaily: true only if explicitly requested

TIME INTERPRETATION:
- "around 6", "at 6" with no AM/PM = 6 PM (hour: 18) unless context says morning
- "tonight" = hour 20, "this evening" = hour 19, "tomorrow morning" = daysFromNow:1 hour:9
- "in an hour" / "in 2 hours" - calculate from CURRENT LOCAL TIME

Output rules: valid JSON only; no prose; no markdown; no extra keys; concise task text${widgetShorthand ? ', widgetLabel,' : ''} and item names; no timing words in task text${widgetShorthand ? ' or widgetLabel' : ''}; do not duplicate quantity/unit inside item name.
Task wording rules: keep the user's intended register. You may remove filler or split a brain dump, but do not euphemize, moralize, sanitize, or make blunt/adult/medical/private wording more polite. Do not replace a relationship word or name in the task title from Personal Context unless the user wrote that replacement.

Return ONLY valid JSON. The first character must be { and the last character must be }. No prose, no markdown:
${multiList
  ? `{"tasks":[{"text":"call dentist"${widgetShorthand ? ',"widgetLabel":"dentist"' : ''},"tier":"medium","listId":${JSON.stringify(fallbackListId)},"reminder":{"daysFromNow":1,"hour":10,"minute":0,"repeatHourly":false,"repeatDaily":false}}],"grocery":${groceryJsonExample}}`
  : `{"tasks":[{"text":"call dentist"${widgetShorthand ? ',"widgetLabel":"dentist"' : ''},"tier":"medium","reminder":{"daysFromNow":1,"hour":10,"minute":0,"repeatHourly":false,"repeatDaily":false}}],"grocery":[]}`}
Omit reminder field if no reminder. Either array can be empty. listId must be a valid id from Available task lists or null.`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 900,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: raw }],
        tools: [aiRouteInputTool(multiList, widgetShorthand)],
        tool_choice: { type: 'tool', name: AI_ROUTE_INPUT_TOOL_NAME },
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(data));

    const parsed = anthropicToolInputFromResponse(data, AI_ROUTE_INPUT_TOOL_NAME);
    const parsedTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const parsedGroceryItems = groceryItemsFromAiPayload(parsed?.grocery);
    const onePlainTaskOnly = parsedTasks.length === 1 && parsedGroceryItems.length === 0;
    const validTier = new Set<string>(['high', 'medium', 'low']);
    const validListIds = new Set(listMap.map(l => l.id));
    const defaultRouteListId = multiList ? defaultTaskDestinationListId(lists) : null;
    const tasksByList = new Map<string | null, TaskDraft[]>();

    parsedTasks.forEach((item: any) => {
      let text = String(item?.text ?? '').trim();
      if (onePlainTaskOnly) text = protectPlainTaskTextRegister(raw, text);
      if (!text) return;
      const tier = (validTier.has(item?.tier) ? item.tier : defaultTier) as Tier;
      const aiListId = (multiList && item?.listId && validListIds.has(item.listId)) ? item.listId as string : undefined;
      const hintListId = multiList && workspaceContext.destinationHint && validListIds.has(workspaceContext.destinationHint.listId)
        ? workspaceContext.destinationHint.listId
        : undefined;
      const listId = hintListId ?? aiListId ?? defaultRouteListId;
      const bucket = tasksByList.get(listId) ?? [];
      bucket.push({
        text,
        widgetLabel: normalizeWidgetLabel(item?.widgetLabel, text),
        tier,
        reminder: buildReminderFromAIResult(item?.reminder),
      });
      tasksByList.set(listId, bucket);
    });

    const grocery = groceryEnabled
      ? parsedGroceryItems
          .map((item: any) => normalizeGroceryDraft(item, raw, inferGroceryQuantities))
          .filter((item: GroceryDraft | null): item is GroceryDraft => !!item)
      : [];

    const destinations = Array.from(tasksByList.entries())
      .filter(([, items]) => items.length > 0)
      .map(([listId]) => listId ?? activeListId);
    if (new Set(destinations).size > 1) return fallbackWidgetCapture(raw, defaultTier, fallbackListId);

    const first = Array.from(tasksByList.entries()).find(([, items]) => items.length > 0);
    if (!first && grocery.length === 0) return fallbackWidgetCapture(raw, defaultTier, fallbackListId);
    return { listId: first?.[0] ?? null, tasks: first?.[1] ?? [], grocery };
  } catch {
    return fallbackWidgetCapture(raw, defaultTier, fallbackListId);
  }
}

type SharedListKind = 'tasks' | 'grocery';

interface SharedListMember {
  avatarSlot: number;       // 0–7, assigned on join from next-free slot
  emailInitial: string;     // single uppercase char shown on the avatar dot
  joinedAt: number;
  lastSeenAt: number;
}

interface SharedList {
  id: string;
  ownerUid: string;
  kind: SharedListKind;
  name: string;
  acl: string[];                              // uids allowed to read/write
  shareCode: string;                          // 6-char alphanumeric, regenerable
  members: { [uid: string]: SharedListMember };
  createdAt: number;
  updatedAt: number;
}

interface SharedListItem {
  id: string;
  // Tasks-shape fields (kind === 'tasks')
  text?: string;
  widgetLabel?: string;
  tier?: Tier;
  completed?: boolean;
  reminder?: Reminder;
  // Grocery-shape fields (kind === 'grocery')
  name?: string;
  category?: string;
  quantity?: string;
  unit?: string;
  packageSize?: string;
  checked?: boolean;
  // Common metadata for the per-item avatar + timestamp UI
  createdBy: string;
  createdAt: number;
  lastEditedBy: string;
  lastEditedAt: number;
}

interface SharedArchiveItem {
  id: string;
  text: string;
  tier: Tier;
  completedAt: number;
  archivedBy: string;
  createdAt?: number;
  lastEditedBy?: string;
  lastEditedAt?: number;
}

type NotificationKind = 'list_deleted'; // future: 'list_kicked', 'member_joined', etc.

interface UserNotification {
  id: string;
  type: NotificationKind;
  payload: { listName?: string; ownerInitial?: string; [k: string]: any };
  createdAt: number;
  readAt: number | null;
}

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

const { TriorityWidget } = NativeModules as {
  TriorityWidget?: {
    updateWidgetTheme: (payload: {
      background: string;
      surface: string;
      control: string;
      accent: string;
      text: string;
      textSub: string;
      clear: boolean;
      activeListName: string;
      activeListId: string;
      hasApiKey: boolean;
      nextUpJson?: string;
      micSide?: WidgetMicSide;
    }) => void;
    consumePendingCaptures: () => Promise<string>;
    showWidgetResult?: (message: string) => void;
  };
};

const AI_WIDGET_TASK_TOOL_NAME = 'capture_widget_tasks';
const AI_ROUTE_INPUT_TOOL_NAME = 'route_triority_input';
const AI_GROCERY_ITEMS_TOOL_NAME = 'parse_grocery_items';
const AI_GROCERY_CATEGORY_TOOL_NAME = 'assign_grocery_categories';

function aiStringSchema(description: string) {
  return { type: 'string', description };
}

function aiReminderSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      daysFromNow: { type: 'integer', description: '0=today, 1=tomorrow, etc.' },
      hour: { type: 'integer', description: '24-hour clock, 0 through 23.' },
      minute: { type: 'integer', description: '0 through 59.' },
      repeatHourly: { type: 'boolean' },
      repeatDaily: { type: 'boolean' },
    },
    required: ['daysFromNow', 'hour', 'minute', 'repeatHourly', 'repeatDaily'],
  };
}

function aiTaskSchema(includeListId: boolean, includeWidgetLabel: boolean = true) {
  const properties: Record<string, any> = {
    text: aiStringSchema('Concise task title.'),
    tier: { type: 'string', enum: ['high', 'medium', 'low'] },
    reminder: aiReminderSchema(),
  };
  if (includeWidgetLabel) {
    properties.widgetLabel = aiStringSchema('Short 1-5 word launcher-widget display label. Preserve meaning/register, omit timing words, keep the final noun/object when possible, and do not drop leading action verbs from short tasks.');
  }
  if (includeListId) {
    properties.listId = {
      type: ['string', 'null'],
      description: 'Valid destination list id. Null means the app should use its normal default To-do list.',
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: includeWidgetLabel ? ['text', 'widgetLabel', 'tier'] : ['text', 'tier'],
  };
}

function aiGroceryItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: aiStringSchema('Short purchasable item name.'),
      category: { type: 'string', enum: [...GROCERY_CATEGORIES, GROCERY_UNCATEGORIZED] },
      quantity: aiStringSchema('User-specified or inferred quantity when requested.'),
      unit: aiStringSchema('Unit for the quantity when present.'),
      packageSize: aiStringSchema('Common smallest purchasable package size when requested.'),
    },
    required: ['name', 'category'],
  };
}

function aiWidgetTaskTool(includeListId: boolean, includeWidgetLabel: boolean = true) {
  return {
    name: AI_WIDGET_TASK_TOOL_NAME,
    description: 'Capture quick widget text as Triority tasks.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tasks: {
          type: 'array',
          items: aiTaskSchema(includeListId, includeWidgetLabel),
        },
      },
      required: ['tasks'],
    },
  };
}

function aiRouteInputTool(includeListId: boolean, includeWidgetLabel: boolean = true) {
  return {
    name: AI_ROUTE_INPUT_TOOL_NAME,
    description: 'Route mixed Triority user input into tasks and grocery/material items.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tasks: {
          type: 'array',
          items: aiTaskSchema(includeListId, includeWidgetLabel),
        },
        grocery: {
          type: 'array',
          items: aiGroceryItemSchema(),
        },
      },
      required: ['tasks', 'grocery'],
    },
  };
}

function aiGroceryItemsTool() {
  return {
    name: AI_GROCERY_ITEMS_TOOL_NAME,
    description: 'Parse grocery, supply, or material text into purchasable items.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          items: aiGroceryItemSchema(),
        },
      },
      required: ['items'],
    },
  };
}

function aiGroceryCategoryTool() {
  return {
    name: AI_GROCERY_CATEGORY_TOOL_NAME,
    description: 'Assign grocery categories to existing item ids.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        assignments: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: aiStringSchema('Existing grocery item id.'),
              category: { type: 'string', enum: [...GROCERY_CATEGORIES, GROCERY_UNCATEGORIZED] },
            },
            required: ['id', 'category'],
          },
        },
      },
      required: ['assignments'],
    },
  };
}

// 8 colored dots used for shared-list member avatars. Index = avatarSlot.
// Picked to remain distinguishable on both light and dark theme chrome.
const SHARED_AVATAR_COLORS = [
  '#FF5040', // red
  '#FFAA28', // amber
  '#3EC8A8', // teal
  '#5BA3FF', // sky
  '#B864FF', // violet
  '#FF6FBF', // pink
  '#7AD957', // green
  '#FFD93B', // yellow
];

// Member-cap toasts read these; sync engine enforces them on join.
const SHARED_TASK_LIST_LIMIT = 5;
const SHARED_GROCERY_LIMIT = 1;

// AsyncStorage keys for Phase 2 local state. Sync engine mirrors these into
// the user doc fields (joinedSharedLists, syncEnabledForGrocery) so a fresh
// install on another device picks them up alongside the rest of the slice.
const SHARED_JOINED_LISTS_KEY = 'tri_shared_joined';
const SHARED_TASK_ORDER_KEY = 'tri_shared_task_order';
const LIST_ROW_ORDER_KEY = 'tri_list_row_order';
const SHARED_GROCERY_TOGGLE_KEY = 'tri_shared_grocery_view';   // '1' = viewing shared, '0' or absent = viewing private
const SUPABASE_SHARED_GROCERY_ID_KEY = 'tri_supabase_shared_grocery_id_v1';
const SHARED_CACHE_KEY = 'tri_shared_cache_v1';
const COLLAPSED_GROUPS_KEY = 'tri_collapsed_groups_v1';
const CALENDAR_CONFLICTS_ENABLED_KEY = 'tri_calendar_conflicts_enabled_v1';
const WIDGET_THEME_KEY = 'tri_widget_theme_v1';
const WIDGET_CLEAR_KEY = 'tri_widget_clear_v1';
const WIDGET_SHORTHAND_KEY = 'tri_widget_shorthand_v1';
const WIDGET_CUSTOM_COLORS_KEY = 'tri_widget_custom_colors_v1';
const WIDGET_MIC_SIDE_KEY = 'tri_widget_mic_side_v1';
const WIDGET_ONBOARDING_RELEASE_KEY = 'tri_widget_onboarding_v147_seen';
const WIDGET_THEME_MATCH_APP = 'match_app';
const WIDGET_THEME_CUSTOM = 'widget_custom';
const WIDGET_THEME_LEGACY_CLEAR = 'clear';
const DEFAULT_WIDGET_CUSTOM_COLORS: WidgetCustomColors = { text: '#FFFFFF', accent: '#B985FF' };
const GOOGLE_CALENDAR_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
const GOOGLE_CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const CALENDAR_CONFLICT_WINDOW_MS = 30 * 60 * 1000;
const REMINDER_NAV_KEY = 'tri_pending_reminder_nav_v1';
const SHARED_STALE_RESTORE_CUTOFF_MS = new Date('2026-05-07T00:00:00-04:00').getTime();

function anthropicErrorDetail(error: any) {
  const raw = String(error?.message ?? error ?? '').trim();
  if (!raw) return 'Check connection, key, or Anthropic billing.';
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    message = String(parsed?.error?.message ?? parsed?.message ?? raw);
  } catch {}
  const lower = message.toLowerCase();
  if (lower.includes('credit') || lower.includes('billing') || lower.includes('balance')) return 'Anthropic billing or credits need attention.';
  if (lower.includes('api key') || lower.includes('authentication') || lower.includes('unauthorized') || lower.includes('permission')) return 'Your Claude API key was rejected.';
  if (lower.includes('model')) return 'The configured Claude model was rejected.';
  if (lower.includes('structured json') || lower.includes('json')) return 'Claude returned an unexpected format; the raw task was added instead.';
  if (lower.includes('network') || lower.includes('failed to fetch') || lower.includes('timeout')) return 'Network request failed.';
  return message.slice(0, 90);
}

function anthropicTextFromResponse(data: any) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks
    .map((block: any) => {
      if (typeof block?.text === 'string') return block.text;
      if (typeof block === 'string') return block;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return text;
}

function anthropicToolInputFromResponse(data: any, toolName: string) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const block = blocks.find((candidate: any) =>
    candidate?.type === 'tool_use'
    && candidate?.name === toolName
    && candidate?.input
    && typeof candidate.input === 'object'
  );
  if (block?.input) return block.input;
  return parseAiJson(anthropicTextFromResponse(data));
}

function aiArrayFromPayload(payload: any, keys: string[]) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function groceryItemsFromAiPayload(payload: any) {
  return aiArrayFromPayload(payload, [
    'items',
    'grocery',
    'groceries',
    'ingredients',
    'ingredientList',
    'shoppingList',
    'shopping_list',
  ]);
}

async function requestAnthropicToolInput({
  apiKey,
  system,
  user,
  maxTokens,
  tool,
  toolName,
}: {
  apiKey: string;
  system: string;
  user: string;
  maxTokens: number;
  tool: any;
  toolName: string;
}) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [tool],
      tool_choice: { type: 'tool', name: toolName },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return anthropicToolInputFromResponse(data, toolName);
}

function extractBalancedJsonCandidates(value: string) {
  const candidates: string[] = [];
  let start = -1;
  let stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
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

function parseAiJson(rawText: string) {
  const cleaned = String(rawText ?? '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  if (!cleaned) throw new Error('AI response was empty.');
  try {
    return JSON.parse(cleaned);
  } catch {
    for (const candidate of extractBalancedJsonCandidates(cleaned)) {
      try {
        return JSON.parse(candidate);
      } catch {}
    }
    throw new Error('Claude returned text instead of structured JSON.');
  }
}

function isMissingOrPermissionError(e: any) {
  const raw = String(e?.code || e?.nativeErrorCode || e?.message || '').toLowerCase();
  return raw.includes('permission-denied') || raw.includes('not-found') || raw.includes('not_found');
}

function formatSharedListOwnerMismatch(data: Pick<SharedList, 'members' | 'ownerUid'>, uid: string) {
  const ownerInitial = data.members?.[data.ownerUid]?.emailInitial;
  const yourInitial = data.members?.[uid]?.emailInitial;
  if (ownerInitial || yourInitial) {
    return `Firestore says owner ${ownerInitial || '?'} can delete. You are ${yourInitial || '?'}.`;
  }
  return 'Firestore says a different signed-in account owns this list.';
}

function stableFirestoreId(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

function taskShareDocId(uid: string, listId: string) {
  return `tasks_${stableFirestoreId(uid)}_${stableFirestoreId(listId)}`;
}

function groceryShareDocId(uid: string) {
  return `grocery_${stableFirestoreId(uid)}`;
}

function stableShareCode(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(SHARE_CODE_LENGTH, '0').slice(-SHARE_CODE_LENGTH);
}

const SUPABASE_SHARED_LIST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSupabaseSharedListId(listId: string) {
  return SUPABASE_SHARED_LIST_ID_RE.test(listId);
}

function randomUuid() {
  // Good enough for optimistic client-side IDs; Postgres still enforces uniqueness.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

function epochFromSupabase(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function supabaseErrorMessage(error: any, fallback: string) {
  return error?.message ? String(error.message) : fallback;
}

function isSupabaseGroceryMembershipError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('already in a shared grocery list')
    || normalized.includes('already have a shared grocery list');
}

// In-memory mirror of SUPABASE_SHARED_GROCERY_ID_KEY. AsyncStorage on Android
// has occasional read-after-write ordering issues across the JNI bridge, which
// caused freshly-created Supabase groceries to be wiped by an immediate
// listener-attach refresh that read the stale marker. Reads in this module
// check this set first (synchronous, race-proof) and only fall back to
// AsyncStorage if the set is empty (pre-hydration cold start).
const activeSupabaseGroceryIds: Set<string> = new Set();

function isSupabaseGroceryMarkedActive(listId: string): boolean {
  return activeSupabaseGroceryIds.has(listId);
}

function hasAnyActiveSupabaseGroceryMarker(): boolean {
  return activeSupabaseGroceryIds.size > 0;
}

async function markSupabaseSharedGroceryActive(listId: string) {
  // Set the in-memory marker FIRST so any listener-attach refresh that fires
  // synchronously after this call sees the active id without waiting for
  // AsyncStorage to flush.
  activeSupabaseGroceryIds.add(listId);
  await AsyncStorage.multiSet([
    [SHARED_GROCERY_TOGGLE_KEY, '1'],
    [SUPABASE_SHARED_GROCERY_ID_KEY, listId],
  ]).catch(() => {});
}

async function clearSupabaseSharedGroceryActive(listId?: string) {
  try {
    if (listId) {
      const current = await AsyncStorage.getItem(SUPABASE_SHARED_GROCERY_ID_KEY);
      if (current && current !== listId) return;
      activeSupabaseGroceryIds.delete(listId);
    } else {
      activeSupabaseGroceryIds.clear();
    }
    await AsyncStorage.removeItem(SUPABASE_SHARED_GROCERY_ID_KEY);
  } catch {
    // best-effort; membership state still drives the UI
  }
}

function mapSupabaseMembers(rows: any[]): { acl: string[]; members: { [uid: string]: SharedListMember } } {
  const acl: string[] = [];
  const members: { [uid: string]: SharedListMember } = {};
  for (const row of rows || []) {
    const uid = String(row.uid || '');
    if (!uid) continue;
    acl.push(uid);
    members[uid] = {
      avatarSlot: Number(row.avatar_slot ?? 0),
      emailInitial: String(row.email_initial || '?').slice(0, 1).toUpperCase(),
      joinedAt: epochFromSupabase(row.joined_at),
      lastSeenAt: epochFromSupabase(row.last_seen_at),
    };
  }
  return { acl, members };
}

function mapSupabaseList(row: any, memberRows: any[]): SharedList {
  const mappedMembers = mapSupabaseMembers(memberRows);
  return {
    id: String(row.id),
    ownerUid: String(row.owner_uid || ''),
    kind: row.kind === 'grocery' ? 'grocery' : 'tasks',
    name: String(row.name || (row.kind === 'grocery' ? 'Groceries' : 'Shared List')),
    acl: mappedMembers.acl,
    shareCode: String(row.share_code || ''),
    members: mappedMembers.members,
    createdAt: epochFromSupabase(row.created_at),
    updatedAt: epochFromSupabase(row.updated_at),
  };
}

function mapSupabaseItem(row: any): SharedListItem {
  return stripUndefined({
    id: String(row.id),
    text: row.text ?? undefined,
    widgetLabel: row.widget_label ?? row.widgetLabel ?? undefined,
    tier: row.tier === 'high' || row.tier === 'medium' || row.tier === 'low' ? row.tier : undefined,
    completed: false,
    reminder: row.reminder ?? undefined,
    name: row.name ?? undefined,
    category: row.category ?? undefined,
    quantity: row.quantity ?? undefined,
    unit: row.unit ?? undefined,
    packageSize: row.package_size ?? row.packageSize ?? undefined,
    checked: !!row.checked,
    createdBy: String(row.created_by ?? row.createdBy ?? ''),
    createdAt: epochFromSupabase(row.created_at ?? row.createdAt),
    lastEditedBy: String(row.last_edited_by ?? row.lastEditedBy ?? ''),
    lastEditedAt: epochFromSupabase(row.last_edited_at ?? row.lastEditedAt),
  });
}

function mapSupabaseArchive(row: any): SharedArchiveItem {
  return stripUndefined({
    id: String(row.id),
    text: String(row.text || ''),
    tier: row.tier === 'high' || row.tier === 'medium' || row.tier === 'low' ? row.tier : 'medium',
    completedAt: epochFromSupabase(row.completed_at ?? row.completedAt),
    archivedBy: String(row.archived_by ?? row.archivedBy ?? ''),
    createdAt: row.created_at || row.createdAt ? epochFromSupabase(row.created_at ?? row.createdAt) : undefined,
    lastEditedBy: row.last_edited_by ?? row.lastEditedBy ?? undefined,
    lastEditedAt: row.last_edited_at || row.lastEditedAt ? epochFromSupabase(row.last_edited_at ?? row.lastEditedAt) : undefined,
  });
}

async function commitSharedParent(db: ReturnType<typeof getFirestore>, ref: ReturnType<typeof doc>, data: Omit<SharedList, 'id'>) {
  await enableNetwork(db).catch(() => {});
  await withTimeout(setDoc(ref, data), 30000, 'Could not reach Firebase within 30 seconds. Check connection and try again.');
}

type KeyboardSheetState = {
  height: number;
  screenY: number | null;
};

type KeyboardSheetFrame = {
  bottom: number;
  maxHeight: number;
  keyboardInset: number;
};

function getKeyboardMetrics(): KeyboardSheetState {
  const metrics = Keyboard.metrics?.();
  const height = Math.max(0, metrics?.height ?? 0);
  const screenY = typeof metrics?.screenY === 'number' ? metrics.screenY : null;
  return { height, screenY };
}

function keyboardStateFromEvent(e: any): KeyboardSheetState {
  const coords = e?.endCoordinates;
  const height = Math.max(0, coords?.height ?? 0);
  const screenY = typeof coords?.screenY === 'number' ? coords.screenY : null;
  return { height, screenY };
}

function getKeyboardSheetFrame(
  keyboard: KeyboardSheetState,
  topInset: number,
  bottomInset: number,
  windowHeight: number,
  forceKeyboardMode = false,
): KeyboardSheetFrame {
  const screenHeight = Dimensions.get('screen').height;
  const fromScreenY = keyboard.screenY !== null
    ? Math.max(0, screenHeight - keyboard.screenY)
    : 0;
  const reportedInset = Math.max(keyboard.height, fromScreenY);
  const fallbackKeyboardInset = Math.min(430, Math.max(320, Math.round(screenHeight * 0.42)));
  const keyboardInset = reportedInset > 0
    ? reportedInset
    : (forceKeyboardMode ? fallbackKeyboardInset : 0);
  const bottom = keyboardInset > 0 ? keyboardInset : bottomInset;
  const availableHeight = Math.min(windowHeight, Math.max(180, screenHeight - bottom));
  const maxHeight = Math.max(180, availableHeight - topInset - 12);
  return { bottom, maxHeight, keyboardInset };
}

function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}


// ─── Donation links (step 15) ────────────────────────────────────────────────
// As of 2026-05-05 Triority is free + GitHub-distributed. The old paywall is
// stripped — IAPProvider below is a stub keeping the same context shape so
// every useIsPaid() / useIAP() call site continues to compile, and isPaid is
// hardcoded true so all formerly-Pro features unlock for everyone.
//
// Settings shows a support row that opens DonateSheet linking to
// these URLs. The button hides itself if BOTH URLs are empty.
const TRIORITY_PATREON_URL = '';
const TRIORITY_BMAC_URL = 'https://buymeacoffee.com/3DEndeavors';

// Legacy constants retained so existing references compile. The stub provider
// below ignores RC_API_KEY_ANDROID; deleting it would just be churn for the
// sake of churn given we may reactivate one day on the web side.
const RC_API_KEY_ANDROID = 'goog_NTynbghUvzIZBcUkZQcQPBxcFCG';
const RC_ENTITLEMENT = 'Triority Pro';
const PAID_CACHE_KEY = 'tri_is_paid';

interface IAPContextValue {
  isPaid: boolean;
  buyPro: () => Promise<void>;
  restorePurchases: () => Promise<boolean>;
}
const IAPContext = createContext<IAPContextValue>({ isPaid: false, buyPro: async () => {}, restorePurchases: async () => false });

// Stub IAPProvider — paywall stripped 2026-05-05 (GitHub distribution pivot).
// Hardcodes isPaid=true so every useIsPaid()-gated feature unlocks. buyPro is
// now a no-op (free for everyone) and restorePurchases reports "no purchase"
// without crashing. The Restore Purchase row in Settings was replaced by the
// "Support Triority" donate row, so restorePurchases is no longer reachable
// from the UI — but the function is preserved so any stale call site doesn't
// throw. RevenueCat is not configured; Purchases.* methods are not invoked.
//
// To resurrect the paid model later, replace this body with the previous
// implementation from git history (commit 0151d91 or earlier).
function IAPProvider({ children }: { children: React.ReactNode }) {
  const buyPro = useCallback(async () => {
    // Free for everyone via GitHub distribution. No-op.
  }, []);
  const restorePurchases = useCallback(async (): Promise<boolean> => false, []);
  return (
    <IAPContext.Provider value={{ isPaid: true, buyPro, restorePurchases }}>
      {children}
    </IAPContext.Provider>
  );
}

function useIsPaid() {
  return useContext(IAPContext).isPaid;
}

function useIAP() {
  return useContext(IAPContext);
}

// ─── Cloud Sync (Firestore + Google Sign-In) ──────────────────────────────────
// Phase 1: single-user sync so uninstall/reinstall preserves data. Sign-in is
// optional — users who don't sign in keep AsyncStorage-only behavior. The
// data-write/restore engine lives elsewhere; this provider only exposes the
// auth surface.

// OAuth Web Client ID from google-services.json (oauth_client with client_type: 3).
// Required by Google Sign-In to issue ID tokens that Firebase Auth can verify.
const WEB_CLIENT_ID = '707782512255-se0aiqqjctssub66bmoba4dtgn3lacd5.apps.googleusercontent.com';

// Supabase shared-list backend, phase 1. The publishable key is safe to ship
// in the APK; never put an sb_secret_* key in mobile source.
const SUPABASE_URL = 'https://ivzbipfmgpulsyzsamfx.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_eEjaYkSNMFmUVe0Sd_K_3g_JznOV7PI';
const USE_SUPABASE_SHARED_LISTS = true;
const disabledSupabaseClient = {
  from: () => { throw new Error('Supabase shared lists are disabled in this build.'); },
  rpc: () => Promise.resolve({ data: null, error: new Error('Supabase shared lists are disabled in this build.') }),
  channel: () => ({
    on: function on() { return this; },
    subscribe: function subscribe() { return this; },
  }),
  removeChannel: () => Promise.resolve('ok'),
};
const supabase = USE_SUPABASE_SHARED_LISTS
  ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      accessToken: async () => {
        return (await getAuth(getApp()).currentUser?.getIdToken(false)) ?? null;
      },
    })
  : disabledSupabaseClient as unknown as ReturnType<typeof createClient>;

interface SyncContextValue {
  user: FirebaseAuthTypes.User | null;
  authReady: boolean;
  signingIn: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  error: string | null;
  clearError: () => void;
}
const SyncContext = createContext<SyncContextValue>({
  user: null,
  authReady: false,
  signingIn: false,
  signIn: async () => {},
  signOut: async () => {},
  error: null,
  clearError: () => {},
});

function SyncProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<FirebaseAuthTypes.User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    GoogleSignin.configure({
      webClientId: WEB_CLIENT_ID,
      scopes: [GOOGLE_CALENDAR_FREEBUSY_SCOPE, GOOGLE_CALENDAR_LIST_SCOPE],
    });
    const unsubscribe = onAuthStateChanged(getAuth(getApp()), (next) => {
      setUser(next);
      setAuthReady(true);
    });
    return unsubscribe;
  }, []);

  const signIn = async () => {
    if (signingIn) return;
    setSigningIn(true);
    setError(null);
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const result = await GoogleSignin.signIn();
      // v13+ returns { type: 'success', data: {...} } or { type: 'cancelled' }.
      if (result.type === 'cancelled') return;
      const idToken = result.data?.idToken;
      if (!idToken) throw new Error('No ID token returned from Google Sign-In');
      const credential = GoogleAuthProvider.credential(idToken);
      await signInWithCredential(getAuth(getApp()), credential);
    } catch (e: any) {
      const code = e?.code;
      if (code === statusCodes.SIGN_IN_CANCELLED) return;
      if (code === statusCodes.IN_PROGRESS) return;
      if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        setError('Google Play Services not available on this device.');
        return;
      }
      setError(e?.message || 'Sign-in failed. Try again.');
    } finally {
      setSigningIn(false);
    }
  };

  const signOut = async () => {
    setError(null);
    try {
      await GoogleSignin.signOut().catch(() => {});
      await fbSignOut(getAuth(getApp()));
    } catch (e: any) {
      setError(e?.message || 'Sign-out failed.');
    }
  };

  const clearError = () => setError(null);

  return (
    <SyncContext.Provider value={{ user, authReady, signingIn, signIn, signOut, error, clearError }}>
      {children}
    </SyncContext.Provider>
  );
}

function useSync() {
  return useContext(SyncContext);
}

// ─── Sync Engine ──────────────────────────────────────────────────────────────
// Local state is always source-of-truth on the device that mutated it.
// Firestore is a debounced replica + cold-start restore source for other
// devices and reinstalls. Same-device offline behavior unchanged: AsyncStorage
// stays in front of the network.

const SYNC_SCHEMA_VERSION = 1;
const SYNC_DEBOUNCE_MS = 800;          // batch rapid edits into one write
const SYNC_LAST_REMOTE_KEY = 'tri_sync_last_remote_at';   // mirrors remote updatedAt last seen
const SYNC_LAST_LOCAL_KEY  = 'tri_sync_last_local_at';    // mirrors local updatedAt last written
const SYNC_CURRENT_UID_KEY = 'tri_sync_current_uid_v1';
const SYNC_ACCOUNT_CACHE_PREFIX = 'tri_sync_account_cache_v1:';

interface SyncedState {
  lists: TaskList[];
  activeListId: string;
  archive: ArchivedTask[];
  accentLight: string | null;
  accentDark: string | null;
  themeId: string;
  customThemeDrafts: (CustomThemeDraft | null)[];
  personalContext: string;
  defaultTier: Tier;
  autoClear: AutoClear;
  darkMode: boolean;
  groceryItems: GroceryItem[];
  // Phase 2 additions — round-trip across reinstall so a fresh device knows
  // which shared lists this user is in and which grocery slice they were
  // viewing. The actual shared list documents live in their own Firestore
  // collection; this only tracks membership + UI toggle state.
  joinedSharedLists?: string[];
  syncEnabledForGrocery?: boolean;
  sharedTaskOrder?: string[];
  listRowOrder?: string[];
  // Note: API key is NOT synced. EncryptedStorage is device-bound by Keystore;
  // restoring ciphertext on another device is unrecoverable. User re-enters
  // their key on each device. onboarded is also local-only — restoring data
  // implies the user is past onboarding anyway.
}

type AccountCache = {
  savedAt: number;
  data: SyncedState;
};

// Firestore rejects fields whose value is `undefined`. The app's data shape
// uses optional fields like Task.reminder that come through as undefined when
// unset. Strip them before sending. JSON.stringify drops undefined and
// function values for free, and the round-trip preserves Date-as-number
// (we store epoch ms) and primitives. Nested objects/arrays are handled by
// the parser's recursion.
function stripUndefined<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function buildSyncBlob(s: SyncedState, updatedAt: number) {
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    updatedAt,
    data: stripUndefined(s),
  };
}

function syncAccountKey(prefix: string, uid: string) {
  return `${prefix}${stableFirestoreId(uid)}`;
}

function syncLastLocalKey(uid: string) {
  return syncAccountKey(`${SYNC_LAST_LOCAL_KEY}:`, uid);
}

function syncLastRemoteKey(uid: string) {
  return syncAccountKey(`${SYNC_LAST_REMOTE_KEY}:`, uid);
}

function syncAccountCacheKey(uid: string) {
  return syncAccountKey(SYNC_ACCOUNT_CACHE_PREFIX, uid);
}

// ─── Shared list helpers (Phase 2) ────────────────────────────────────────────

// 6-char alphanumeric, ambiguous chars excluded so a code dictated over the
// phone is unambiguous: no 0/O, no 1/I/l, no 5/S, no 2/Z, no 8/B. Result is
// 28 chars × 6 positions = ~482M codes — collision odds are negligible at
// any plausible scale, but we still retry on collision (caller's job).
const SHARE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY3469';
const SHARE_CODE_LENGTH = 6;

function generateShareCode(): string {
  let out = '';
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    // Math.random is fine here — share codes are not a security primitive,
    // they're a join convenience. The actual auth is Firebase Auth + ACL.
    out += SHARE_CODE_ALPHABET.charAt(Math.floor(Math.random() * SHARE_CODE_ALPHABET.length));
  }
  return out;
}

// Normalize user-typed codes before lookup. Trims whitespace, uppercases,
// strips dashes/spaces a user might add for readability ("ABCD-EF" → "ABCDEF").
// Does NOT validate length — caller checks against SHARE_CODE_LENGTH so the
// error message can be specific.
function normalizeShareCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Pick the next available avatar slot 0–7 not already occupied. When all 8
// slots are taken (a 9th member joins), wraps and reuses the lowest-indexed
// slot — duplicates are then visually possible. With the 5-task-list cap
// and typical "household of 3" use, this should be rare. Promote to a
// stricter assignment + UI warning if it becomes a problem.
function nextAvatarSlot(members: { [uid: string]: SharedListMember }): number {
  const taken = new Set<number>();
  for (const m of Object.values(members)) taken.add(m.avatarSlot);
  for (let i = 0; i < SHARED_AVATAR_COLORS.length; i++) {
    if (!taken.has(i)) return i;
  }
  return 0;
}

// Pull the email's first char as a visible identity hint on the avatar dot.
// Sign-in flows always provide an email; defensive default for unexpected
// inputs avoids rendering a blank dot.
function emailInitialOf(email: string | null | undefined): string {
  const ch = (email || '').trim().charAt(0).toUpperCase();
  return /[A-Z0-9]/.test(ch) ? ch : '?';
}

function buildSharedListMember(email: string | null | undefined, slot: number, now: number): SharedListMember {
  return {
    avatarSlot: slot,
    emailInitial: emailInitialOf(email),
    joinedAt: now,
    lastSeenAt: now,
  };
}

function isHistoricalAclRestore(data: Pick<SharedList, 'members' | 'updatedAt'>, uid: string): boolean {
  const joinedAt = data.members?.[uid]?.joinedAt ?? 0;
  return joinedAt > 0
    && joinedAt < SHARED_STALE_RESTORE_CUTOFF_MS
    && data.updatedAt < SHARED_STALE_RESTORE_CUTOFF_MS;
}

// ─── Shared Lists Provider (Phase 2) ──────────────────────────────────────────
// One real-time listener per joined sharedList parent doc + one per its items
// subcollection. Listeners attach when the user is signed in and a list ID
// has been added to joinedSharedLists; they detach when the app backgrounds
// (AppState !== 'active') and reattach on foreground to keep Firestore reads
// cheap. Writes happen elsewhere (steps 6/7/8/10/14) — this provider is read-
// surface only.

interface SharedListsContextValue {
  sharedLists: { [listId: string]: SharedList };
  sharedItems: { [listId: string]: SharedListItem[] };
  sharedArchives: { [listId: string]: SharedArchiveItem[] };
  joinedIds: string[];
  setJoinedIds: (ids: string[]) => Promise<void>;
  // Set true while we're hydrating local state from AsyncStorage on cold start.
  hydrating: boolean;
  // Step 6: promote a private TaskList into a shared list. Returns the new
  // shared list ID. Caller is responsible for deleting the private list from
  // its own state once promotion succeeds. Throws if not signed in, code
  // collides repeatedly, or Firestore write fails.
  promoteTaskListToShared: (list: TaskList) => Promise<string>;
  promoteGroceryListToShared: (items: GroceryItem[]) => Promise<string>;
  // Step 8: join an existing shared list by share code. Returns the joined
  // list's ID. Throws on: not signed in, bad code length, code not found,
  // already joined, or cap exceeded for that kind.
  joinSharedListByCode: (rawCode: string) => Promise<string>;
  // Step 11b: per-item mutations on shared task lists. Each method writes
  // to /sharedLists/{listId}/items and bumps lastEditedBy/At so step 13's
  // avatar render shows who touched it last. Throws if not signed in or
  // Firestore rejects (caller toasts).
  addSharedTaskItems: (listId: string, items: TaskDraft[]) => Promise<string[]>;
  editSharedTaskItem: (listId: string, itemId: string, patch: { text?: string; tier?: Tier; reminder?: Reminder | null }) => Promise<void>;
  deleteSharedTaskItem: (listId: string, itemId: string) => Promise<void>;
  archiveSharedTaskItem: (listId: string, itemId: string, item: { text: string; tier: Tier; createdAt?: number }) => Promise<void>;
  restoreSharedArchiveItem: (listId: string, archiveId: string, item: { text: string; tier: Tier; createdAt?: number }) => Promise<void>;
  deleteSharedArchiveItem: (listId: string, archiveId: string) => Promise<void>;
  addSharedGroceryItems: (listId: string, items: GroceryDraft[]) => Promise<string[]>;
  updateSharedGroceryItem: (listId: string, itemId: string, patch: { name?: string; category?: string; checked?: boolean }) => Promise<void>;
  deleteSharedGroceryItem: (listId: string, itemId: string) => Promise<void>;
  deleteSharedGroceryItems: (listId: string, itemIds: string[]) => Promise<void>;
  updateSharedGroceryCategories: (listId: string, assignments: { id: string; category: string }[]) => Promise<void>;
  // Step 10: list-level operations for the unified ListActionSheet.
  // rotateShareCode — owner-only; replaces shareCode on the parent doc.
  // renameSharedList — anyone in acl can rename (consensus model; matches
  //   the spirit of 'whole list, equal members' design).
  // leaveSharedList — non-owner removes self from acl/members. withCopy
  //   adopts a snapshot into a new private list before leaving so the
  //   user keeps their data.
  // deleteSharedList — owner-only; tears down items + parent doc. The
  //   listener observes parent disappearance on each member's device and
  //   drops the list from local state. Notifications fan out via step 14.
  rotateShareCode: (listId: string) => Promise<string>;
  renameSharedList: (listId: string, name: string) => Promise<void>;
  leaveSharedList: (listId: string) => Promise<void>;
  deleteSharedList: (listId: string) => Promise<void>;
}

interface SharedListsCache {
  lists: { [listId: string]: SharedList };
  items: { [listId: string]: SharedListItem[] };
  archives: { [listId: string]: SharedArchiveItem[] };
  savedAt: number;
}

const SharedListsContext = createContext<SharedListsContextValue>({
  sharedLists: {},
  sharedItems: {},
  sharedArchives: {},
  joinedIds: [],
  setJoinedIds: async () => {},
  hydrating: true,
  promoteTaskListToShared: async () => { throw new Error('SharedListsProvider not mounted'); },
  promoteGroceryListToShared: async () => { throw new Error('SharedListsProvider not mounted'); },
  joinSharedListByCode: async () => { throw new Error('SharedListsProvider not mounted'); },
  addSharedTaskItems: async () => { throw new Error('SharedListsProvider not mounted'); },
  editSharedTaskItem: async () => { throw new Error('SharedListsProvider not mounted'); },
  deleteSharedTaskItem: async () => { throw new Error('SharedListsProvider not mounted'); },
  archiveSharedTaskItem: async () => { throw new Error('SharedListsProvider not mounted'); },
  restoreSharedArchiveItem: async () => { throw new Error('SharedListsProvider not mounted'); },
  deleteSharedArchiveItem: async () => { throw new Error('SharedListsProvider not mounted'); },
  addSharedGroceryItems: async () => { throw new Error('SharedListsProvider not mounted'); },
  updateSharedGroceryItem: async () => { throw new Error('SharedListsProvider not mounted'); },
  deleteSharedGroceryItem: async () => { throw new Error('SharedListsProvider not mounted'); },
  deleteSharedGroceryItems: async () => { throw new Error('SharedListsProvider not mounted'); },
  updateSharedGroceryCategories: async () => { throw new Error('SharedListsProvider not mounted'); },
  rotateShareCode: async () => { throw new Error('SharedListsProvider not mounted'); },
  renameSharedList: async () => { throw new Error('SharedListsProvider not mounted'); },
  leaveSharedList: async () => { throw new Error('SharedListsProvider not mounted'); },
  deleteSharedList: async () => { throw new Error('SharedListsProvider not mounted'); },
});

function SharedListsProvider({ children }: { children: React.ReactNode }) {
  const { user, authReady } = useSync();
  const [joinedIds, setJoinedIdsState] = useState<string[]>([]);
  const joinedIdsRef = useRef<string[]>([]);
  const [sharedLists, setSharedLists] = useState<{ [id: string]: SharedList }>({});
  const [sharedItems, setSharedItems] = useState<{ [id: string]: SharedListItem[] }>({});
  const [sharedArchives, setSharedArchives] = useState<{ [id: string]: SharedArchiveItem[] }>({});
  const [hydrating, setHydrating] = useState(true);
  const [appActive, setAppActive] = useState(true);
  const locallyRemovedSharedIdsRef = useRef<Set<string>>(new Set());
  // Tracks Supabase shared-item IDs that we just inserted optimistically and
  // have not yet seen confirmed in a server fetch. Used by
  // refreshSupabaseSharedList to avoid briefly dropping the row when a
  // realtime callback fires before our INSERT is visible to the SELECT.
  const pendingSharedItemIdsRef = useRef<Set<string>>(new Set());

  const forgetSharedList = useCallback((listId: string) => {
    setSharedLists((prev) => {
      if (!(listId in prev)) return prev;
      const next = { ...prev };
      delete next[listId];
      return next;
    });
    setSharedItems((prev) => {
      if (!(listId in prev)) return prev;
      const next = { ...prev };
      delete next[listId];
      return next;
    });
    setSharedArchives((prev) => {
      if (!(listId in prev)) return prev;
      const next = { ...prev };
      delete next[listId];
      return next;
    });
  }, []);

  const removeSharedListFromCache = useCallback((listId: string) => {
    AsyncStorage.getItem(SHARED_CACHE_KEY).then((raw) => {
      if (!raw) return;
      const parsed = JSON.parse(raw) as SharedListsCache;
      const next: SharedListsCache = {
        lists: { ...(parsed.lists || {}) },
        items: { ...(parsed.items || {}) },
        archives: { ...(parsed.archives || {}) },
        savedAt: Date.now(),
      };
      delete next.lists[listId];
      delete next.items[listId];
      delete next.archives[listId];
      return AsyncStorage.setItem(SHARED_CACHE_KEY, JSON.stringify(next));
    }).catch(() => {});
  }, []);

  const forgetSharedListLocally = useCallback((listId: string) => {
    locallyRemovedSharedIdsRef.current.add(listId);
    forgetSharedList(listId);
    removeSharedListFromCache(listId);
  }, [forgetSharedList, removeSharedListFromCache]);

  const hydrateSharedCache = useCallback(async () => {
    try {
      const rawCache = await AsyncStorage.getItem(SHARED_CACHE_KEY);
      if (!rawCache) return;
      const parsed = JSON.parse(rawCache) as Partial<SharedListsCache>;
      const joined = new Set(joinedIdsRef.current);
      if (joined.size === 0) return;
      const cachedLists = parsed?.lists && typeof parsed.lists === 'object' ? parsed.lists : {};
      const cachedItems = parsed?.items && typeof parsed.items === 'object' ? parsed.items : {};
      const cachedArchives = parsed?.archives && typeof parsed.archives === 'object' ? parsed.archives : {};
      // Hydrate the in-memory marker set from disk so subsequent
      // refreshSupabaseSharedList calls can answer synchronously.
      const activeSupabaseGroceryId = await AsyncStorage.getItem(SUPABASE_SHARED_GROCERY_ID_KEY).catch(() => null);
      if (activeSupabaseGroceryId) activeSupabaseGroceryIds.add(activeSupabaseGroceryId);
      const filteredLists: { [id: string]: SharedList } = {};
      const filteredItems: { [id: string]: SharedListItem[] } = {};
      const filteredArchives: { [id: string]: SharedArchiveItem[] } = {};
      for (const id of joined) {
        if (locallyRemovedSharedIdsRef.current.has(id)) continue;
        if (isSupabaseSharedListId(id) && cachedLists[id]?.kind === 'grocery' && !isSupabaseGroceryMarkedActive(id)) continue;
        if (cachedLists[id]) filteredLists[id] = cachedLists[id];
        if (Array.isArray(cachedItems[id])) filteredItems[id] = cachedItems[id];
        if (Array.isArray(cachedArchives[id])) filteredArchives[id] = cachedArchives[id];
      }
      if (Object.keys(filteredLists).length > 0) {
        setSharedLists((prev) => ({ ...prev, ...filteredLists }));
      }
      if (Object.keys(filteredItems).length > 0) {
        setSharedItems((prev) => ({ ...prev, ...filteredItems }));
      }
      if (Object.keys(filteredArchives).length > 0) {
        setSharedArchives((prev) => ({ ...prev, ...filteredArchives }));
      }
    } catch {}
  }, []);


  // Load persisted joinedIds on mount. Phase 1 sync engine will overwrite
  // this list when it restores a fresh device — by then we've already started
  // listening to whatever was on disk. The next render after restore picks
  // up the new list and re-subscribes.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(SHARED_JOINED_LISTS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            const next = Array.from(new Set(parsed.filter((x) => typeof x === 'string')));
            joinedIdsRef.current = next;
            setJoinedIdsState(next);
          }
        }
      } catch {
        // bad JSON — ignore, start with empty
      } finally {
        setHydrating(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (hydrating || !user) return;
    hydrateSharedCache();
  }, [hydrating, user, joinedIds, hydrateSharedCache]);

  useEffect(() => {
    if (hydrating || !user) return;
    const cache: SharedListsCache = {
      lists: sharedLists,
      items: sharedItems,
      archives: sharedArchives,
      savedAt: Date.now(),
    };
    AsyncStorage.setItem(SHARED_CACHE_KEY, JSON.stringify(cache)).catch(() => {});
  }, [hydrating, user, sharedLists, sharedItems, sharedArchives]);

  const persistJoinedIdsForUser = useCallback((ids: string[]) => {
    if (!user) return;
    const updatedAt = Date.now();
    setDoc(doc(getFirestore(getApp()), 'users', user.uid), {
      schemaVersion: SYNC_SCHEMA_VERSION,
      updatedAt,
      data: {
        joinedSharedLists: ids,
      },
    }, { merge: true }).catch(() => {});
  }, [user]);

  const setJoinedIds = useCallback(async (ids: string[]) => {
    const next = Array.from(new Set(ids));
    // Any listId we are now joined to should NOT be treated as locally
    // removed — clear the quarantine ref or refreshSupabaseSharedList will
    // silently skip the fetch and leave items empty until app restart.
    for (const id of next) {
      locallyRemovedSharedIdsRef.current.delete(id);
    }
    joinedIdsRef.current = next;
    setJoinedIdsState(next);
    persistJoinedIdsForUser(next);
    try {
      await AsyncStorage.setItem(SHARED_JOINED_LISTS_KEY, JSON.stringify(next));
    } catch {
      // best-effort; the in-memory state still drives the UI
    }
  }, [persistJoinedIdsForUser]);

  const addJoinedId = useCallback(async (listId: string) => {
    locallyRemovedSharedIdsRef.current.delete(listId);
    if (joinedIdsRef.current.includes(listId)) return;
    await setJoinedIds([...joinedIdsRef.current, listId]);
  }, [setJoinedIds]);

  const removeJoinedId = useCallback(async (listId: string) => {
    await setJoinedIds(joinedIdsRef.current.filter((x) => x !== listId));
  }, [setJoinedIds]);

  const refreshSupabaseSharedList = useCallback(async (listId: string) => {
    if (!isSupabaseSharedListId(listId) || locallyRemovedSharedIdsRef.current.has(listId)) return;
    const [listRes, membersRes, itemsRes, archivesRes] = await Promise.all([
      supabase.from('tri_shared_lists').select('*').eq('id', listId).maybeSingle(),
      supabase.from('tri_shared_members').select('*').eq('list_id', listId),
      supabase.from('tri_shared_items').select('*').eq('list_id', listId),
      supabase.from('tri_shared_archives').select('*').eq('list_id', listId),
    ]);
    if (listRes.error) throw new Error(supabaseErrorMessage(listRes.error, 'Could not load shared list.'));
    if (!listRes.data) {
      forgetSharedListLocally(listId);
      await removeJoinedId(listId);
      return;
    }
    if (listRes.data.kind === 'grocery') {
      // Check the in-memory marker first (race-proof). Only fall back to
      // AsyncStorage if no in-memory markers exist yet — that means cache
      // hydration has not run since process start, so trust disk on this
      // single read and seed the set from it.
      let isActive = isSupabaseGroceryMarkedActive(listId);
      if (!isActive && !hasAnyActiveSupabaseGroceryMarker()) {
        const activeSupabaseGroceryId = await AsyncStorage.getItem(SUPABASE_SHARED_GROCERY_ID_KEY).catch(() => null);
        if (activeSupabaseGroceryId) {
          activeSupabaseGroceryIds.add(activeSupabaseGroceryId);
          isActive = activeSupabaseGroceryId === listId;
        }
      }
      if (!isActive) {
        forgetSharedListLocally(listId);
        await removeJoinedId(listId);
        return;
      }
    }
    if (membersRes.error) throw new Error(supabaseErrorMessage(membersRes.error, 'Could not load shared members.'));
    if (itemsRes.error) throw new Error(supabaseErrorMessage(itemsRes.error, 'Could not load shared items.'));
    if (archivesRes.error) throw new Error(supabaseErrorMessage(archivesRes.error, 'Could not load shared archive.'));

    setSharedLists((prev) => ({ ...prev, [listId]: mapSupabaseList(listRes.data, membersRes.data || []) }));
    const serverItems = (itemsRes.data || []).map(mapSupabaseItem);
    const serverItemIds = new Set(serverItems.map((it) => it.id));
    // Drain any pending optimistic IDs that the server has now confirmed.
    for (const id of serverItemIds) pendingSharedItemIdsRef.current.delete(id);
    setSharedItems((prev) => {
      const localItems = prev[listId] || [];
      // Preserve any local rows that:
      // (a) are still pending confirmation (we just inserted them and the
      //     server SELECT didn't see them yet), or
      // (b) have an ID not present in the server response AND not yet seen.
      // Keeping (a) avoids the flash where a freshly-added row briefly
      // disappears when realtime triggers a refresh before the INSERT has
      // committed visibly.
      const survivingLocal = localItems.filter((it) => !serverItemIds.has(it.id) && pendingSharedItemIdsRef.current.has(it.id));
      return { ...prev, [listId]: [...serverItems, ...survivingLocal] };
    });
    setSharedArchives((prev) => ({ ...prev, [listId]: (archivesRes.data || []).map(mapSupabaseArchive) }));
  }, [forgetSharedListLocally, removeJoinedId]);

  const recoverSupabaseMembershipsForUser = useCallback(async () => {
    if (!user) return;
    const { data: memberRows, error: memberError } = await supabase
      .from('tri_shared_members')
      .select('list_id')
      .eq('uid', user.uid);
    if (memberError || !Array.isArray(memberRows) || memberRows.length === 0) return;

    const recoveredIds = Array.from(new Set(
      memberRows
        .map((row: any) => String(row.list_id || ''))
        .filter((id: string) => isSupabaseSharedListId(id)),
    ));
    if (recoveredIds.length === 0) return;

    const { data: listRows } = await supabase
      .from('tri_shared_lists')
      .select('id, kind')
      .in('id', recoveredIds);
    const recoveredGroceryIds = (Array.isArray(listRows) ? listRows : [])
      .filter((row: any) => row?.kind === 'grocery')
      .map((row: any) => String(row.id || ''))
      .filter((id: string) => isSupabaseSharedListId(id));

    for (const id of recoveredIds) locallyRemovedSharedIdsRef.current.delete(id);
    if (recoveredGroceryIds.length > 0) {
      await markSupabaseSharedGroceryActive(recoveredGroceryIds[0]);
    }
    const merged = Array.from(new Set([...joinedIdsRef.current, ...recoveredIds]));
    await setJoinedIds(merged);
    recoveredIds.forEach((id) => {
      refreshSupabaseSharedList(id).catch(() => {});
    });
  }, [refreshSupabaseSharedList, setJoinedIds, user]);

  const recoverExistingSupabaseGroceryMembership = useCallback(async (): Promise<string | null> => {
    if (!user) return null;
    const { data, error } = await supabase
      .from('tri_shared_lists')
      .select('*')
      .eq('kind', 'grocery')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error || !Array.isArray(data) || data.length === 0) return null;

    const listId = String(data[0].id || '');
    if (!isSupabaseSharedListId(listId)) return null;

    // Server-side one-grocery guard says this account is already a member.
    // Restore that membership locally so the user can reveal the code, leave,
    // or delete it instead of getting trapped behind the create button.
    locallyRemovedSharedIdsRef.current.delete(listId);
    await markSupabaseSharedGroceryActive(listId);
    await addJoinedId(listId);
    await refreshSupabaseSharedList(listId).catch(() => {});
    return listId;
  }, [addJoinedId, refreshSupabaseSharedList, user]);

  // AppState gate: detach all listeners when backgrounded so we don't burn
  // Firestore reads while invisible. Reattach on foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      setAppActive(next === 'active');
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!user || !appActive) return;
    enableNetwork(getFirestore(getApp())).catch(() => {});
  }, [user, appActive]);

  useEffect(() => {
    if (!authReady || !user || !appActive) return;
    let cancelled = false;
    user.getIdToken(false)
      .then((token) => {
        if (!cancelled && token) {
          return supabase.realtime.setAuth(token);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [authReady, user, appActive]);

  const recoveredSupabaseForUidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authReady || !user || !appActive || hydrating) return;
    if (recoveredSupabaseForUidRef.current === user.uid) return;
    recoveredSupabaseForUidRef.current = user.uid;
    recoverSupabaseMembershipsForUser().catch(() => {
      recoveredSupabaseForUidRef.current = null;
    });
  }, [authReady, user, appActive, hydrating, recoverSupabaseMembershipsForUser]);

  useEffect(() => {
    if (!authReady || !user || !appActive) return;
    const supabaseIds = joinedIds.filter((id) => isSupabaseSharedListId(id));
    if (supabaseIds.length === 0) return;

    let cancelled = false;
    const refreshAll = () => {
      if (cancelled) return;
      supabaseIds.forEach((id) => {
        refreshSupabaseSharedList(id).catch(() => {});
      });
    };
    const timer = setInterval(refreshAll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [authReady, user, appActive, joinedIds, refreshSupabaseSharedList]);

  // The actual listener attach/detach effect. Re-runs when the auth user,
  // the joined list IDs, or the active state changes.
  useEffect(() => {
    if (!authReady) return;

    if (!user) {
      // Nothing to listen to — clear stale state from a previous binding so
      // the UI doesn't show a list the user just left.
      setSharedLists((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        return {};
      });
      setSharedItems((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        return {};
      });
      setSharedArchives((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        return {};
      });
      return;
    }

    if (!appActive || joinedIds.length === 0) return;

    const db = getFirestore(getApp());
    const unsubs: Array<() => void> = [];

    for (const listId of joinedIds) {
      if (isSupabaseSharedListId(listId)) {
        refreshSupabaseSharedList(listId).catch((error) => {
          if (isMissingOrPermissionError(error)) {
            forgetSharedListLocally(listId);
            removeJoinedId(listId).catch(() => {});
          }
        });
        const refresh = () => {
          refreshSupabaseSharedList(listId).catch(() => {});
        };
        const channel = supabase
          .channel(`tri-shared-list-${listId}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'tri_shared_lists', filter: `id=eq.${listId}` }, refresh)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'tri_shared_members', filter: `list_id=eq.${listId}` }, refresh)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'tri_shared_items', filter: `list_id=eq.${listId}` }, refresh)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'tri_shared_archives', filter: `list_id=eq.${listId}` }, refresh)
          .subscribe();
        unsubs.push(() => {
          supabase.removeChannel(channel).catch(() => {});
        });
        continue;
      }
      // Parent doc listener — list metadata, ACL changes, member roster updates.
      const parentRef = doc(db, 'sharedLists', listId);
      const unsubParent = onSnapshot(
        parentRef,
        (snap) => {
          if (locallyRemovedSharedIdsRef.current.has(listId)) {
            forgetSharedList(listId);
            return;
          }
          if (!snap.exists()) {
            // Owner deleted the list. Drop it from local state; notification
            // surfacing is Step 14's job.
            forgetSharedListLocally(listId);
            removeJoinedId(listId).catch(() => {});
            return;
          }
          const data = snap.data() as Omit<SharedList, 'id'> | undefined;
          if (!data) return;
          if (isHistoricalAclRestore(data, user.uid)) {
            forgetSharedListLocally(listId);
            removeJoinedId(listId).catch(() => {});
            return;
          }
          setSharedLists((prev) => ({ ...prev, [listId]: { id: listId, ...data } }));
        },
        (error) => {
          if (isMissingOrPermissionError(error)) {
            forgetSharedListLocally(listId);
            removeJoinedId(listId).catch(() => {});
          }
          // — fall silent. Step 14 surfaces user-visible removals.
        },
      );
      unsubs.push(unsubParent);

      // Items subcollection listener.
      const itemsRef = collection(db, 'sharedLists', listId, 'items');
      const unsubItems = onSnapshot(
        itemsRef,
        (snap) => {
          const items: SharedListItem[] = [];
          snap.forEach((d) => {
            items.push({ id: d.id, ...(d.data() as Omit<SharedListItem, 'id'>) });
          });
          setSharedItems((prev) => ({ ...prev, [listId]: items }));
        },
        (error) => {
          if (isMissingOrPermissionError(error)) {
            setSharedItems((prev) => {
              if (!(listId in prev)) return prev;
              const next = { ...prev };
              delete next[listId];
              return next;
            });
          }
          // same posture as parent: silent on errors, fail-closed UI.
        },
      );
      unsubs.push(unsubItems);

      const archiveRef = collection(db, 'sharedLists', listId, 'archive');
      const unsubArchive = onSnapshot(
        archiveRef,
        (snap) => {
          const items: SharedArchiveItem[] = [];
          snap.forEach((d) => {
            items.push({ id: d.id, ...(d.data() as Omit<SharedArchiveItem, 'id'>) });
          });
          setSharedArchives((prev) => ({ ...prev, [listId]: items }));
        },
        (error) => {
          if (isMissingOrPermissionError(error)) {
            setSharedArchives((prev) => {
              if (!(listId in prev)) return prev;
              const next = { ...prev };
              delete next[listId];
              return next;
            });
          }
        },
      );
      unsubs.push(unsubArchive);
    }

    return () => {
      for (const u of unsubs) {
        try { u(); } catch { /* noop */ }
      }
    };
  }, [authReady, user, appActive, joinedIds, forgetSharedList, forgetSharedListLocally, removeJoinedId, refreshSupabaseSharedList]);

  // Step 8: join an existing shared list by share code. Enforces caps:
  //   - 1 shared grocery list per user
  //   - 5 shared task lists per user
  // Resolves with the joined list's ID. Throws on:
  //   - not-signed-in
  //   - code not found (after normalize)
  //   - already joined this list
  //   - cap exceeded for that kind
  const joinSharedListByCode = useCallback(async (rawCode: string): Promise<string> => {
    if (!user) throw new Error('Not signed in');
    const normalized = normalizeShareCode(rawCode);
    if (normalized.length !== SHARE_CODE_LENGTH) {
      throw new Error(`Code must be ${SHARE_CODE_LENGTH} characters.`);
    }

    if (USE_SUPABASE_SHARED_LISTS) {
      const result = await withTimeout(
        supabase.rpc('tri_join_shared_list', { p_share_code: normalized }),
        10000,
        'Could not reach shared-list service within 10 seconds. Check connection and try again.',
      );
      if (!result.error && result.data?.id) {
        const listId = String(result.data.id);
        if (result.data.kind === 'grocery') {
          await markSupabaseSharedGroceryActive(listId);
        }
        await addJoinedId(listId);
        await refreshSupabaseSharedList(listId).catch(() => {});
        return listId;
      }
      const message = supabaseErrorMessage(result.error, 'Code not found.');
      if (!message.toLowerCase().includes('code not found')) {
        throw new Error(message);
      }
    }

    const db = getFirestore(getApp());
    await enableNetwork(db).catch(() => {});
    const probe = await getDocs(query(
      collection(db, 'sharedLists'),
      where('shareCode', '==', normalized),
    ));
    if (probe.empty) throw new Error('Code not found.');
    const snap = probe.docs[0];
    const listId = snap.id;
    const data = snap.data() as Omit<SharedList, 'id'>;

    if (data.acl.includes(user.uid) && !joinedIdsRef.current.includes(listId)) {
      await addJoinedId(listId);
      return listId;
    }

    if (data.acl.includes(user.uid)) throw new Error('You’re already in this list.');

    // Limit check from the local cache. The race window (cold start before
    // listeners catch up) is acceptable — worst case the user lands one
    // extra list above the cap. Server-side enforcement would need a CF.
    const currentCount = Object.values(sharedLists).filter((l) => l.kind === data.kind).length;
    if (data.kind === 'tasks' && currentCount >= SHARED_TASK_LIST_LIMIT) {
      throw new Error(`You’ve reached the ${SHARED_TASK_LIST_LIMIT}-shared-list limit.`);
    }
    if (data.kind === 'grocery' && currentCount >= SHARED_GROCERY_LIMIT) {
      throw new Error('You’re already in a shared grocery list. Leave it first to join another.');
    }
    if (data.kind === 'grocery') {
      await AsyncStorage.setItem(SHARED_GROCERY_TOGGLE_KEY, '1').catch(() => {});
    }

    const now = Date.now();
    const slot = nextAvatarSlot(data.members);
    const newMember = buildSharedListMember(user.email, slot, now);

    // Single update: add ourselves to acl + members + bump updatedAt.
    await updateDoc(doc(db, 'sharedLists', listId), {
      acl: [...data.acl, user.uid],
      members: { ...data.members, [user.uid]: newMember },
      updatedAt: now,
    });

    // Append to local joinedIds so the listener picks it up.
    await addJoinedId(listId);
    return listId;
  }, [user, sharedLists, addJoinedId, refreshSupabaseSharedList]);

  // Step 11b: shared-list item CRUD. Each call writes one or more docs and
  // bumps lastEditedBy/At so the per-item avatar (Step 13) reflects the
  // most recent change. The listener pipes the update back into local state
  // — callers don't optimistic-update.
  const addSharedTaskItems = useCallback(async (listId: string, items: TaskDraft[]) => {
    if (!user) throw new Error('Not signed in');
    if (items.length === 0) return [];
    if (isSupabaseSharedListId(listId)) {
      const now = Date.now();
      const rows = items
        .map((it) => ({
          id: randomUuid(),
          list_id: listId,
          text: it.text,
          tier: it.tier,
          reminder: it.reminder ? stripUndefined(it.reminder) : undefined,
          checked: false,
          created_by: user.uid,
          created_at: new Date(now).toISOString(),
          last_edited_by: user.uid,
          last_edited_at: new Date(now).toISOString(),
        }))
        .filter((it) => it.text.trim());
      if (rows.length === 0) return [];
      const optimistic = rows.map(mapSupabaseItem);
      // Mark these IDs as pending so a realtime-triggered refresh that races
      // ahead of the INSERT cannot drop them from the list.
      for (const row of rows) pendingSharedItemIdsRef.current.add(row.id);
      setSharedItems((prev) => ({ ...prev, [listId]: [...(prev[listId] || []), ...optimistic] }));
      const { error } = await supabase.from('tri_shared_items').insert(rows);
      if (error) {
        const ids = new Set(rows.map((row) => row.id));
        for (const id of ids) pendingSharedItemIdsRef.current.delete(id);
        setSharedItems((prev) => ({ ...prev, [listId]: (prev[listId] || []).filter((it) => !ids.has(it.id)) }));
        throw new Error(supabaseErrorMessage(error, 'Could not add shared items.'));
      }
      return rows.map((row) => row.id);
    }
    const db = getFirestore(getApp());
    const now = Date.now();
    const batch = writeBatch(db);
    const optimistic: SharedListItem[] = [];
    for (const it of items) {
      const ref = doc(collection(db, 'sharedLists', listId, 'items'));
      const data: Omit<SharedListItem, 'id'> = {
        text: it.text,
        tier: it.tier,
        reminder: it.reminder,
        completed: false,
        createdBy: user.uid,
        createdAt: now,
        lastEditedBy: user.uid,
        lastEditedAt: now,
      };
      batch.set(ref, stripUndefined(data));
      optimistic.push({ id: ref.id, ...data });
    }
    setSharedItems((prev) => {
      const existing = prev[listId] || [];
      const optimisticIds = new Set(optimistic.map((it) => it.id));
      return {
        ...prev,
        [listId]: [
          ...existing.filter((it) => !optimisticIds.has(it.id)),
          ...optimistic,
        ],
      };
    });
    try {
      await batch.commit();
    } catch (e) {
      const optimisticIds = new Set(optimistic.map((it) => it.id));
      setSharedItems((prev) => ({
        ...prev,
        [listId]: (prev[listId] || []).filter((it) => !optimisticIds.has(it.id)),
      }));
      throw e;
    }
    return optimistic.map((it) => it.id);
  }, [user, setSharedItems]);

  const editSharedTaskItem = useCallback(async (listId: string, itemId: string, patch: { text?: string; tier?: Tier; reminder?: Reminder | null }) => {
    if (!user) throw new Error('Not signed in');
    if (isSupabaseSharedListId(listId)) {
      const { error } = await supabase
        .from('tri_shared_items')
        .update(stripUndefined({
          text: patch.text,
          tier: patch.tier,
          reminder: patch.reminder === null ? null : (patch.reminder ? stripUndefined(patch.reminder) : undefined),
          last_edited_by: user.uid,
          last_edited_at: new Date().toISOString(),
        }))
        .eq('id', itemId)
        .eq('list_id', listId);
      if (error) throw new Error(supabaseErrorMessage(error, 'Could not edit shared task.'));
      return;
    }
    const db = getFirestore(getApp());
    await updateDoc(doc(db, 'sharedLists', listId, 'items', itemId), stripUndefined({
      ...patch,
      ...(patch.reminder === undefined ? {} : { reminder: patch.reminder }),
      lastEditedBy: user.uid,
      lastEditedAt: Date.now(),
    }));
  }, [user]);

  const deleteSharedTaskItem = useCallback(async (listId: string, itemId: string) => {
    if (!user) throw new Error('Not signed in');
    if (isSupabaseSharedListId(listId)) {
      // Optimistic remove so the swiped row disappears immediately; rollback
      // restores the prior items snapshot if Supabase rejects the delete.
      let prevItems: SharedListItem[] | undefined;
      setSharedItems((prev) => {
        prevItems = prev[listId];
        if (!prevItems) return prev;
        return { ...prev, [listId]: prevItems.filter((it) => it.id !== itemId) };
      });
      const { error } = await supabase.from('tri_shared_items').delete().eq('id', itemId).eq('list_id', listId);
      if (error) {
        if (prevItems) {
          const snapshot = prevItems;
          setSharedItems((prev) => ({ ...prev, [listId]: snapshot }));
        }
        throw new Error(supabaseErrorMessage(error, 'Could not delete shared task.'));
      }
      return;
    }
    const db = getFirestore(getApp());
    await deleteDoc(doc(db, 'sharedLists', listId, 'items', itemId));
  }, [user]);

  const archiveSharedTaskItem = useCallback(async (listId: string, itemId: string, item: { text: string; tier: Tier; createdAt?: number }) => {
    if (!user) throw new Error('Not signed in');
    if (isSupabaseSharedListId(listId)) {
      const now = Date.now();
      const archiveRow = {
        list_id: listId,
        text: item.text,
        tier: item.tier,
        completed_at: new Date(now).toISOString(),
        archived_by: user.uid,
        created_at: item.createdAt ? new Date(item.createdAt).toISOString() : null,
        last_edited_by: user.uid,
        last_edited_at: new Date(now).toISOString(),
      };
      // Optimistic local update so the swiped task disappears from the list
      // and shows up in shared Archive immediately. Realtime / poll will
      // reconcile with the real archive id once the insert succeeds.
      let prevItems: SharedListItem[] | undefined;
      let prevArchives: SharedArchiveItem[] | undefined;
      const optimisticArchiveId = `optimistic_archive_${itemId}_${now}`;
      const optimisticArchive: SharedArchiveItem = stripUndefined({
        id: optimisticArchiveId,
        text: item.text,
        tier: item.tier,
        completedAt: now,
        archivedBy: user.uid,
        createdAt: item.createdAt,
        lastEditedBy: user.uid,
        lastEditedAt: now,
      }) as SharedArchiveItem;
      setSharedItems((prev) => {
        prevItems = prev[listId];
        if (!prevItems) return prev;
        return { ...prev, [listId]: prevItems.filter((it) => it.id !== itemId) };
      });
      setSharedArchives((prev) => {
        prevArchives = prev[listId];
        return { ...prev, [listId]: [...(prev[listId] || []), optimisticArchive] };
      });
      const rollback = () => {
        if (prevItems) {
          const snapshot = prevItems;
          setSharedItems((prev) => ({ ...prev, [listId]: snapshot }));
        }
        setSharedArchives((prev) => {
          if (prevArchives === undefined) {
            const next = { ...prev };
            delete next[listId];
            return next;
          }
          const snapshot = prevArchives;
          return { ...prev, [listId]: snapshot };
        });
      };
      const { error: archiveError } = await supabase.from('tri_shared_archives').insert(archiveRow);
      if (archiveError) {
        rollback();
        throw new Error(supabaseErrorMessage(archiveError, 'Could not archive shared task.'));
      }
      const { error: deleteError } = await supabase.from('tri_shared_items').delete().eq('id', itemId).eq('list_id', listId);
      if (deleteError) {
        rollback();
        throw new Error(supabaseErrorMessage(deleteError, 'Could not remove completed shared task.'));
      }
      return;
    }
    const db = getFirestore(getApp());
    const now = Date.now();
    const batch = writeBatch(db);
    const archiveRef = doc(collection(db, 'sharedLists', listId, 'archive'));
    const itemRef = doc(db, 'sharedLists', listId, 'items', itemId);
    const archiveData: Omit<SharedArchiveItem, 'id'> = {
      text: item.text,
      tier: item.tier,
      completedAt: now,
      archivedBy: user.uid,
      createdAt: item.createdAt,
      lastEditedBy: user.uid,
      lastEditedAt: now,
    };
    batch.set(archiveRef, stripUndefined(archiveData));
    batch.delete(itemRef);
    try {
      await batch.commit();
    } catch (e) {
      if (!isMissingOrPermissionError(e)) throw e;
      // If deployed rules are still missing shared-archive create access, let
      // completion remove the live task instead of failing the whole action.
      await deleteDoc(itemRef);
    }
  }, [user]);

  const deleteSharedArchiveItem = useCallback(async (listId: string, archiveId: string) => {
    if (!user) throw new Error('Not signed in');
    if (isSupabaseSharedListId(listId)) {
      const { error } = await supabase.from('tri_shared_archives').delete().eq('id', archiveId).eq('list_id', listId);
      if (error) throw new Error(supabaseErrorMessage(error, 'Could not delete shared archive item.'));
      return;
    }
    const db = getFirestore(getApp());
    await deleteDoc(doc(db, 'sharedLists', listId, 'archive', archiveId));
  }, [user]);

  const restoreSharedArchiveItem = useCallback(async (listId: string, archiveId: string, item: { text: string; tier: Tier; createdAt?: number }) => {
    if (!user) throw new Error('Not signed in');
    const now = Date.now();
    if (isSupabaseSharedListId(listId)) {
      const restoredId = randomUuid();
      const row = {
        id: restoredId,
        list_id: listId,
        text: item.text,
        tier: item.tier,
        checked: false,
        created_by: user.uid,
        created_at: new Date(item.createdAt || now).toISOString(),
        last_edited_by: user.uid,
        last_edited_at: new Date(now).toISOString(),
      };
      const restored = mapSupabaseItem(row);
      let prevItems: SharedListItem[] | undefined;
      let prevArchives: SharedArchiveItem[] | undefined;
      pendingSharedItemIdsRef.current.add(restoredId);
      setSharedItems((prev) => {
        prevItems = prev[listId];
        return { ...prev, [listId]: [...(prev[listId] || []), restored] };
      });
      setSharedArchives((prev) => {
        prevArchives = prev[listId];
        return { ...prev, [listId]: (prev[listId] || []).filter((it) => it.id !== archiveId) };
      });
      const rollback = () => {
        pendingSharedItemIdsRef.current.delete(restoredId);
        setSharedItems((prev) => ({ ...prev, [listId]: prevItems || [] }));
        setSharedArchives((prev) => {
          if (prevArchives === undefined) {
            const next = { ...prev };
            delete next[listId];
            return next;
          }
          return { ...prev, [listId]: prevArchives };
        });
      };
      const { error: insertError } = await supabase.from('tri_shared_items').insert(row);
      if (insertError) {
        rollback();
        throw new Error(supabaseErrorMessage(insertError, 'Could not restore shared task.'));
      }
      const { error: deleteError } = await supabase.from('tri_shared_archives').delete().eq('id', archiveId).eq('list_id', listId);
      if (deleteError) {
        try {
          await supabase.from('tri_shared_items').delete().eq('id', restoredId).eq('list_id', listId);
        } catch {}
        rollback();
        throw new Error(supabaseErrorMessage(deleteError, 'Could not remove shared archive item.'));
      }
      return;
    }
    const db = getFirestore(getApp());
    const itemRef = doc(collection(db, 'sharedLists', listId, 'items'));
    const archiveRef = doc(db, 'sharedLists', listId, 'archive', archiveId);
    const restored: SharedListItem = stripUndefined({
      id: itemRef.id,
      text: item.text,
      tier: item.tier,
      completed: false,
      createdBy: user.uid,
      createdAt: item.createdAt || now,
      lastEditedBy: user.uid,
      lastEditedAt: now,
    }) as SharedListItem;
    let prevItems: SharedListItem[] | undefined;
    let prevArchives: SharedArchiveItem[] | undefined;
    setSharedItems((prev) => {
      prevItems = prev[listId];
      return { ...prev, [listId]: [...(prev[listId] || []), restored] };
    });
    setSharedArchives((prev) => {
      prevArchives = prev[listId];
      return { ...prev, [listId]: (prev[listId] || []).filter((it) => it.id !== archiveId) };
    });
    const batch = writeBatch(db);
    batch.set(itemRef, stripUndefined({
      text: restored.text,
      tier: restored.tier,
      completed: false,
      createdBy: restored.createdBy,
      createdAt: restored.createdAt,
      lastEditedBy: restored.lastEditedBy,
      lastEditedAt: restored.lastEditedAt,
    }));
    batch.delete(archiveRef);
    try {
      await batch.commit();
    } catch (e) {
      setSharedItems((prev) => ({ ...prev, [listId]: prevItems || [] }));
      setSharedArchives((prev) => {
        if (prevArchives === undefined) {
          const next = { ...prev };
          delete next[listId];
          return next;
        }
        return { ...prev, [listId]: prevArchives };
      });
      throw e;
    }
  }, [user]);

  const addSharedGroceryItems = useCallback(async (listId: string, items: GroceryDraft[]) => {
    if (!user) throw new Error('Not signed in');
    if (items.length === 0) return [];
    if (isSupabaseSharedListId(listId)) {
      const now = Date.now();
      const rows = items
        .map((it) => ({
          id: randomUuid(),
          list_id: listId,
          name: groceryStorageName(it),
          category: it.category || GROCERY_UNCATEGORIZED,
          checked: false,
          created_by: user.uid,
          created_at: new Date(now).toISOString(),
          last_edited_by: user.uid,
          last_edited_at: new Date(now).toISOString(),
        }))
        .filter((it) => it.name);
      if (rows.length === 0) return [];
      const optimistic = rows.map(mapSupabaseItem);
      // Mark these IDs as pending so a realtime-triggered refresh that races
      // ahead of the INSERT cannot drop them from the list.
      for (const row of rows) pendingSharedItemIdsRef.current.add(row.id);
      setSharedItems((prev) => ({ ...prev, [listId]: [...(prev[listId] || []), ...optimistic] }));
      const { error } = await supabase.from('tri_shared_items').insert(rows);
      if (error) {
        const ids = new Set(rows.map((row) => row.id));
        for (const id of ids) pendingSharedItemIdsRef.current.delete(id);
        setSharedItems((prev) => ({ ...prev, [listId]: (prev[listId] || []).filter((it) => !ids.has(it.id)) }));
        throw new Error(supabaseErrorMessage(error, 'Could not add shared grocery items.'));
      }
      return rows.map((row) => row.id);
    }
    const db = getFirestore(getApp());
    const now = Date.now();
    const batch = writeBatch(db);
    const ids: string[] = [];
    for (const it of items) {
      const name = it.name.trim();
      if (!name) continue;
      const ref = doc(collection(db, 'sharedLists', listId, 'items'));
      ids.push(ref.id);
      const data: Omit<SharedListItem, 'id'> = {
        name,
        category: it.category || GROCERY_UNCATEGORIZED,
        quantity: it.quantity,
        unit: it.unit,
        packageSize: it.packageSize,
        checked: false,
        createdBy: user.uid,
        createdAt: now,
        lastEditedBy: user.uid,
        lastEditedAt: now,
      };
      batch.set(ref, stripUndefined(data));
    }
    await batch.commit();
    return ids;
  }, [user]);

  const updateSharedGroceryItem = useCallback(async (listId: string, itemId: string, patch: { name?: string; category?: string; checked?: boolean }) => {
    if (!user) throw new Error('Not signed in');
    if (isSupabaseSharedListId(listId)) {
      // Optimistic patch — apply locally first so checkbox / category change
      // is instant; rollback on error.
      const now = Date.now();
      let prevItems: SharedListItem[] | undefined;
      setSharedItems((prev) => {
        prevItems = prev[listId];
        if (!prevItems) return prev;
        return {
          ...prev,
          [listId]: prevItems.map((it) => it.id === itemId
            ? stripUndefined({
                ...it,
                name: patch.name !== undefined ? patch.name : it.name,
                category: patch.category !== undefined ? patch.category : it.category,
                checked: patch.checked !== undefined ? patch.checked : it.checked,
                lastEditedBy: user.uid,
                lastEditedAt: now,
              })
            : it),
        };
      });
      const { error } = await supabase
        .from('tri_shared_items')
        .update(stripUndefined({
          name: patch.name,
          category: patch.category,
          checked: patch.checked,
          last_edited_by: user.uid,
          last_edited_at: new Date(now).toISOString(),
        }))
        .eq('id', itemId)
        .eq('list_id', listId);
      if (error) {
        if (prevItems) {
          const snapshot = prevItems;
          setSharedItems((prev) => ({ ...prev, [listId]: snapshot }));
        }
        throw new Error(supabaseErrorMessage(error, 'Could not update shared grocery item.'));
      }
      return;
    }
    const db = getFirestore(getApp());
    await updateDoc(doc(db, 'sharedLists', listId, 'items', itemId), stripUndefined({
      ...patch,
      lastEditedBy: user.uid,
      lastEditedAt: Date.now(),
    }));
  }, [user]);

  const deleteSharedGroceryItem = useCallback(async (listId: string, itemId: string) => {
    if (!user) throw new Error('Not signed in');
    if (isSupabaseSharedListId(listId)) {
      // Optimistic remove so swipe trash is instant; rollback on error.
      let prevItems: SharedListItem[] | undefined;
      setSharedItems((prev) => {
        prevItems = prev[listId];
        if (!prevItems) return prev;
        return { ...prev, [listId]: prevItems.filter((it) => it.id !== itemId) };
      });
      const { error } = await supabase.from('tri_shared_items').delete().eq('id', itemId).eq('list_id', listId);
      if (error) {
        if (prevItems) {
          const snapshot = prevItems;
          setSharedItems((prev) => ({ ...prev, [listId]: snapshot }));
        }
        throw new Error(supabaseErrorMessage(error, 'Could not delete shared grocery item.'));
      }
      return;
    }
    const db = getFirestore(getApp());
    await deleteDoc(doc(db, 'sharedLists', listId, 'items', itemId));
  }, [user]);

  const deleteSharedGroceryItems = useCallback(async (listId: string, itemIds: string[]) => {
    if (!user) throw new Error('Not signed in');
    if (itemIds.length === 0) return;
    if (isSupabaseSharedListId(listId)) {
      // Optimistic batch remove (Clear Checked, Clear All); rollback on error.
      const idSet = new Set(itemIds);
      let prevItems: SharedListItem[] | undefined;
      setSharedItems((prev) => {
        prevItems = prev[listId];
        if (!prevItems) return prev;
        return { ...prev, [listId]: prevItems.filter((it) => !idSet.has(it.id)) };
      });
      const { error } = await supabase.from('tri_shared_items').delete().eq('list_id', listId).in('id', itemIds);
      if (error) {
        if (prevItems) {
          const snapshot = prevItems;
          setSharedItems((prev) => ({ ...prev, [listId]: snapshot }));
        }
        throw new Error(supabaseErrorMessage(error, 'Could not delete shared grocery items.'));
      }
      return;
    }
    const db = getFirestore(getApp());
    for (let i = 0; i < itemIds.length; i += 500) {
      const batch = writeBatch(db);
      for (const id of itemIds.slice(i, i + 500)) {
        batch.delete(doc(db, 'sharedLists', listId, 'items', id));
      }
      await batch.commit();
    }
  }, [user]);

  const updateSharedGroceryCategories = useCallback(async (listId: string, assignments: { id: string; category: string }[]) => {
    if (!user) throw new Error('Not signed in');
    if (assignments.length === 0) return;
    if (isSupabaseSharedListId(listId)) {
      const now = new Date().toISOString();
      const results = await Promise.all(assignments.map((assignment) => supabase
        .from('tri_shared_items')
        .update({
          category: assignment.category || GROCERY_UNCATEGORIZED,
          last_edited_by: user.uid,
          last_edited_at: now,
        })
        .eq('id', assignment.id)
        .eq('list_id', listId)));
      const failed = results.find((result) => result.error);
      if (failed?.error) throw new Error(supabaseErrorMessage(failed.error, 'Could not update shared grocery categories.'));
      return;
    }
    const db = getFirestore(getApp());
    const now = Date.now();
    for (let i = 0; i < assignments.length; i += 500) {
      const batch = writeBatch(db);
      for (const assignment of assignments.slice(i, i + 500)) {
        batch.update(doc(db, 'sharedLists', listId, 'items', assignment.id), stripUndefined({
          category: assignment.category || GROCERY_UNCATEGORIZED,
          lastEditedBy: user.uid,
          lastEditedAt: now,
        }));
      }
      await batch.commit();
    }
  }, [user]);

  // Step 10: list-level mutations for the unified ListActionSheet.

  const rotateShareCode = useCallback(async (listId: string): Promise<string> => {
    if (!user) throw new Error('Not signed in');
    if (isSupabaseSharedListId(listId)) {
      const { data, error } = await supabase.rpc('tri_rotate_share_code', { p_list_id: listId });
      if (error) throw new Error(supabaseErrorMessage(error, 'Could not rotate share code.'));
      const nextCode = String(data || '');
      if (!nextCode) throw new Error('Could not rotate share code.');
      setSharedLists((prev) => prev[listId] ? {
        ...prev,
        [listId]: { ...prev[listId], shareCode: nextCode, updatedAt: Date.now() },
      } : prev);
      return nextCode;
    }
    const db = getFirestore(getApp());
    let nextCode = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateShareCode();
      const probe = await getDocs(query(
        collection(db, 'sharedLists'),
        where('shareCode', '==', candidate),
      ));
      if (probe.empty) { nextCode = candidate; break; }
    }
    if (!nextCode) throw new Error('Could not generate a unique code. Try again.');
    await updateDoc(doc(db, 'sharedLists', listId), {
      shareCode: nextCode,
      updatedAt: Date.now(),
    });
    return nextCode;
  }, [user]);

  const renameSharedList = useCallback(async (listId: string, name: string) => {
    if (!user) throw new Error('Not signed in');
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Name required.');
    if (isSupabaseSharedListId(listId)) {
      const { error } = await supabase.rpc('tri_rename_shared_list', { p_list_id: listId, p_name: trimmed });
      if (error) throw new Error(supabaseErrorMessage(error, 'Could not rename shared list.'));
      setSharedLists((prev) => prev[listId] ? {
        ...prev,
        [listId]: { ...prev[listId], name: trimmed, updatedAt: Date.now() },
      } : prev);
      return;
    }
    const db = getFirestore(getApp());
    await updateDoc(doc(db, 'sharedLists', listId), {
      name: trimmed,
      updatedAt: Date.now(),
    });
  }, [user]);

  const leaveSharedList = useCallback(async (listId: string) => {
    if (!user) throw new Error('Not signed in');
    if (isSupabaseSharedListId(listId)) {
      const cached = sharedLists[listId];
      // Local-first: clean up immediately so the UI returns. Server leave
      // runs in the background; if it fails for a recoverable reason the
      // listener / 5-second poll will repopulate the membership.
      forgetSharedListLocally(listId);
      if (cached?.kind === 'grocery') {
        await clearSupabaseSharedGroceryActive(listId);
      }
      await removeJoinedId(listId);
      void (async () => {
        const { error } = await supabase.rpc('tri_leave_shared_list', { p_list_id: listId });
        if (error && !isMissingOrPermissionError(error)) {
          // Server still thinks we're a member; surface only on next session
          // — see Step 14 for cross-session error surfacing.
        }
      })().catch(() => {});
      return;
    }
    const db = getFirestore(getApp());
    const cleanupLocal = async () => {
      forgetSharedListLocally(listId);
      await removeJoinedId(listId);
    };
    try {
    // Read current acl/members so we can write the trimmed-down version. A
    // transactional read-modify-write would be safer against concurrent
    // member changes, but for v1 the last-write-wins outcome is acceptable.
    const snap = await getDoc(doc(db, 'sharedLists', listId));
    if (!snap.exists()) {
      // Nothing to leave; just clean local state.
      await cleanupLocal();
      return;
    }
    const data = snap.data() as Omit<SharedList, 'id'>;
    if (data.ownerUid === user.uid) {
      throw new Error('Owner cannot leave — delete the list instead.');
    }
    const nextAcl = data.acl.filter((u) => u !== user.uid);
    const nextMembers = { ...data.members };
    delete nextMembers[user.uid];
    await updateDoc(doc(db, 'sharedLists', listId), {
      acl: nextAcl,
      members: nextMembers,
      updatedAt: Date.now(),
    });
    // Drop from local joinedIds so the listener detaches.
    await cleanupLocal();
    } catch (e) {
      if (isMissingOrPermissionError(e)) {
        await cleanupLocal();
        return;
      }
      throw e;
    }
  }, [user, forgetSharedListLocally, removeJoinedId]);

  const deleteSharedList = useCallback(async (listId: string) => {
    if (!user) throw new Error('Not signed in');
    if (isSupabaseSharedListId(listId)) {
      const cached = sharedLists[listId];
      if (cached && cached.ownerUid !== user.uid) {
        throw new Error(formatSharedListOwnerMismatch(cached, user.uid));
      }
      forgetSharedListLocally(listId);
      if (cached?.kind === 'grocery') {
        await clearSupabaseSharedGroceryActive(listId);
      }
      await removeJoinedId(listId);
      const { error } = await supabase.rpc('tri_delete_shared_list', { p_list_id: listId });
      if (error && !isMissingOrPermissionError(error)) {
        throw new Error(supabaseErrorMessage(error, 'Could not delete shared list.'));
      }
      return;
    }
    const db = getFirestore(getApp());
    const cached = sharedLists[listId];
    if (cached && cached.ownerUid === user.uid) {
      const ownerMember = cached.members?.[user.uid];
      const ownerInitial = ownerMember?.emailInitial ?? '?';
      const otherUids = (cached.acl || []).filter((u) => u !== user.uid);
      const now = Date.now();
      forgetSharedListLocally(listId);
      await removeJoinedId(listId);

      void (async () => {
        await deleteDoc(doc(db, 'sharedLists', listId));
        if (otherUids.length > 0) {
          const notifBatch = writeBatch(db);
          for (const memberUid of otherUids) {
            const notifRef = doc(collection(db, 'users', memberUid, 'notifications'));
            notifBatch.set(notifRef, {
              type: 'list_deleted' as NotificationKind,
              payload: { listName: cached.name, ownerInitial },
              createdAt: now,
              readAt: null,
            });
          }
          await notifBatch.commit();
        }
      })().catch(() => {});
      return;
    }

    const snap = await getDoc(doc(db, 'sharedLists', listId));
    if (!snap.exists()) {
      forgetSharedListLocally(listId);
      await removeJoinedId(listId);
      return;
    }
    const data = snap.data() as Omit<SharedList, 'id'>;
    if (data.ownerUid !== user.uid) {
      throw new Error(formatSharedListOwnerMismatch(data, user.uid));
    }

    // Delete the parent first. This removes the list from every member's UI;
    // notification fan-out must not block the owner's delete action.
    const ownerMember = data.members?.[user.uid];
    const ownerInitial = ownerMember?.emailInitial ?? '?';
    const otherUids = (data.acl || []).filter((u) => u !== user.uid);
    const now = Date.now();
    forgetSharedListLocally(listId);
    await removeJoinedId(listId);

    void (async () => {
      await deleteDoc(doc(db, 'sharedLists', listId));
      if (otherUids.length > 0) {
        const notifBatch = writeBatch(db);
        for (const memberUid of otherUids) {
          const notifRef = doc(collection(db, 'users', memberUid, 'notifications'));
          notifBatch.set(notifRef, {
            type: 'list_deleted' as NotificationKind,
            payload: { listName: data.name, ownerInitial },
            createdAt: now,
            readAt: null,
          });
        }
        await notifBatch.commit();
      }
    })().catch(() => {});
  }, [user, sharedLists, forgetSharedListLocally, removeJoinedId]);

  // Step 6: promote a private TaskList → new shared list. Caller deletes the
  // private list from its own state once this resolves.
  const promoteTaskListToShared = useCallback(async (list: TaskList): Promise<string> => {
    if (!user) throw new Error('Not signed in');
    if (USE_SUPABASE_SHARED_LISTS) {
      const now = Date.now();
      const items = list.tasks.map((t) => ({
        text: t.text,
        tier: t.tier,
        reminder: t.reminder,
        checked: false,
        createdAt: t.createdAt || now,
      }));
      const result = await withTimeout(
        supabase.rpc('tri_create_shared_list', { p_kind: 'tasks', p_name: list.name, p_items: items }),
        10000,
        'Could not create the shared list within 10 seconds. Check connection and try again.',
      );
      if (result.error) throw new Error(supabaseErrorMessage(result.error, 'Could not create shared list.'));
      const listRow = result.data?.list;
      if (!listRow?.id) throw new Error('Could not create shared list.');
      const listId = String(listRow.id);
      const ownerMember = buildSharedListMember(user.email, 0, now);
      const sharedList: SharedList = {
        id: listId,
        ownerUid: String(listRow.ownerUid || user.uid),
        kind: 'tasks',
        name: String(listRow.name || list.name),
        acl: [user.uid],
        shareCode: String(listRow.shareCode || ''),
        members: { [user.uid]: ownerMember },
        createdAt: Number(listRow.createdAt || now),
        updatedAt: Number(listRow.updatedAt || now),
      };
      const sharedRows = Array.isArray(result.data?.items) ? result.data.items.map(mapSupabaseItem) : [];
      setSharedLists((prev) => ({ ...prev, [listId]: sharedList }));
      setSharedItems((prev) => ({ ...prev, [listId]: sharedRows }));
      await addJoinedId(listId);
      return listId;
    }
    const db = getFirestore(getApp());
    const now = Date.now();

    // Generate locally so share creation is not blocked by a preflight
    // Firestore query. The six-character code space is large enough for the
    // current release, and write failure still bubbles to the caller.
    const shareCode = stableShareCode(taskShareDocId(user.uid, String(list.id)));

    // The owner takes avatar slot 0 — they're the first member.
    const ownerMember = buildSharedListMember(user.email, 0, now);

    // Stable IDs make share creation idempotent: repeated taps or late
    // Firestore flushes update the same shared list instead of duplicating it.
    const parentRef = doc(db, 'sharedLists', taskShareDocId(user.uid, String(list.id)));
    const parentData: Omit<SharedList, 'id'> = {
      ownerUid: user.uid,
      kind: 'tasks',
      name: list.name,
      acl: [user.uid],
      shareCode,
      members: { [user.uid]: ownerMember },
      createdAt: now,
      updatedAt: now,
    };

    // Two-phase write. The items security rule gates by:
    //   request.auth.uid in get(/sharedLists/$listId).data.acl
    // Inside a single batch, get() sees pre-batch state — meaning the parent
    // doc isn't there yet, get() returns null, .acl crashes, every item
    // create gets permission-denied, the whole batch fails atomically.
    //
    // So: phase 1 = parent doc alone (small write, rules-clean because the
    // sharedLists create rule just needs the writer to be in d.acl, which is
    // guaranteed because we put ourselves there above). Phase 2 = items
    // batch, now allowed because get() sees the freshly-written parent.
    //
    // Trade-off: not atomic. If the network drops between phase 1 and 2 the
    // user has an empty shared list. They can delete it and retry. The
    // alternative (widen items rule to allow create when writer is the
    // parent's ownerUid) adds a get() per item create — a worse trade.
    try {
      await commitSharedParent(db, parentRef, parentData);
    } catch (e) {
      forgetSharedList(parentRef.id);
      await removeJoinedId(parentRef.id);
      throw e;
    }

    setSharedLists((prev) => ({ ...prev, [parentRef.id]: { id: parentRef.id, ...parentData } }));
    await addJoinedId(parentRef.id);

    void (async () => {
      if (list.tasks.length === 0) return;
      for (let i = 0; i < list.tasks.length; i += 500) {
        const itemsBatch = writeBatch(db);
        for (const t of list.tasks.slice(i, i + 500)) {
          const itemRef = doc(db, 'sharedLists', parentRef.id, 'items', `task_${stableFirestoreId(String(t.id))}`);
          const itemData: Omit<SharedListItem, 'id'> = {
            text: t.text,
            tier: t.tier,
            reminder: t.reminder,
            completed: false,
            createdBy: user.uid,
            createdAt: t.createdAt || now,
            lastEditedBy: user.uid,
            lastEditedAt: now,
          };
          itemsBatch.set(itemRef, stripUndefined(itemData));
        }
        await itemsBatch.commit();
      }
    })().catch(() => {});

    return parentRef.id;
  }, [user, addJoinedId, forgetSharedList, removeJoinedId]);

  const promoteGroceryListToShared = useCallback(async (items: GroceryItem[]): Promise<string> => {
    if (!user) throw new Error('Not signed in');
    if (Object.values(sharedLists).some((l) => l.kind === 'grocery')) {
      throw new Error('You already have a shared grocery list.');
    }
    if (USE_SUPABASE_SHARED_LISTS) {
      const now = Date.now();
      const groceryItems = items
        .filter((it) => it.name.trim())
        .map((it) => ({
          name: groceryStorageName(it),
          category: it.category || GROCERY_UNCATEGORIZED,
          checked: !!it.checked,
          createdAt: it.createdAt || now,
        }));
      const result = await withTimeout(
        supabase.rpc('tri_create_shared_list', { p_kind: 'grocery', p_name: 'Groceries', p_items: groceryItems }),
        10000,
        'Could not create the shared grocery list within 10 seconds. Check connection and try again.',
      );
      if (result.error) {
        const message = supabaseErrorMessage(result.error, 'Could not create shared grocery list.');
        if (isSupabaseGroceryMembershipError(message)) {
          const recoveredListId = await recoverExistingSupabaseGroceryMembership();
          if (recoveredListId) return recoveredListId;
        }
        throw new Error(message);
      }
      const listRow = result.data?.list;
      if (!listRow?.id) throw new Error('Could not create shared grocery list.');
      const listId = String(listRow.id);
      const ownerMember = buildSharedListMember(user.email, 0, now);
      const sharedList: SharedList = {
        id: listId,
        ownerUid: String(listRow.ownerUid || user.uid),
        kind: 'grocery',
        name: String(listRow.name || 'Groceries'),
        acl: [user.uid],
        shareCode: String(listRow.shareCode || ''),
        members: { [user.uid]: ownerMember },
        createdAt: Number(listRow.createdAt || now),
        updatedAt: Number(listRow.updatedAt || now),
      };
      const sharedRows = Array.isArray(result.data?.items) ? result.data.items.map(mapSupabaseItem) : [];
      // Mark active BEFORE setSharedLists / addJoinedId. The in-memory ref
      // inside markSupabaseSharedGroceryActive is updated synchronously, so
      // any listener-attach refresh that fires when joinedIds changes will
      // see the marker without needing to wait for AsyncStorage to flush.
      await markSupabaseSharedGroceryActive(listId);
      setSharedLists((prev) => ({ ...prev, [listId]: sharedList }));
      setSharedItems((prev) => ({ ...prev, [listId]: sharedRows }));
      await addJoinedId(listId);
      return listId;
    }
    const db = getFirestore(getApp());
    const now = Date.now();

    const ownerMember = buildSharedListMember(user.email, 0, now);
    const parentRef = doc(collection(db, 'sharedLists'));
    const shareCode = stableShareCode(parentRef.id);
    const parentData: Omit<SharedList, 'id'> = {
      ownerUid: user.uid,
      kind: 'grocery',
      name: 'Groceries',
      acl: [user.uid],
      shareCode,
      members: { [user.uid]: ownerMember },
      createdAt: now,
      updatedAt: now,
    };

    const initialItems = items.filter((it) => it.name.trim());
    const optimisticItems: SharedListItem[] = initialItems.map((item, index) => ({
      id: `grocery_${stableFirestoreId(String(item.id))}`,
      name: item.name,
      category: item.category || GROCERY_UNCATEGORIZED,
      quantity: item.quantity,
      unit: item.unit,
      packageSize: item.packageSize,
      checked: !!item.checked,
      createdBy: user.uid,
      createdAt: item.createdAt || now + index,
      lastEditedBy: user.uid,
      lastEditedAt: now,
    }));

    try {
      await commitSharedParent(db, parentRef, parentData);
    } catch (e) {
      forgetSharedList(parentRef.id);
      await removeJoinedId(parentRef.id);
      throw e;
    }

    setSharedLists((prev) => ({ ...prev, [parentRef.id]: { id: parentRef.id, ...parentData } }));
    await AsyncStorage.setItem(SHARED_GROCERY_TOGGLE_KEY, '1').catch(() => {});
    await addJoinedId(parentRef.id);

    if (optimisticItems.length > 0) {
      setSharedItems((prev) => ({ ...prev, [parentRef.id]: optimisticItems }));
    }

    void (async () => {
      if (initialItems.length > 0) {
        for (let i = 0; i < initialItems.length; i += 500) {
          const itemsBatch = writeBatch(db);
          for (const item of initialItems.slice(i, i + 500)) {
            const itemRef = doc(db, 'sharedLists', parentRef.id, 'items', `grocery_${stableFirestoreId(String(item.id))}`);
            const itemData: Omit<SharedListItem, 'id'> = {
              name: item.name,
              category: item.category || GROCERY_UNCATEGORIZED,
              quantity: item.quantity,
              unit: item.unit,
              packageSize: item.packageSize,
              checked: !!item.checked,
              createdBy: user.uid,
              createdAt: item.createdAt || now,
              lastEditedBy: user.uid,
              lastEditedAt: now,
            };
            itemsBatch.set(itemRef, stripUndefined(itemData));
          }
          await itemsBatch.commit();
        }
      }
    })().catch(() => {});

    return parentRef.id;
  }, [user, sharedLists, addJoinedId, forgetSharedList, removeJoinedId, recoverExistingSupabaseGroceryMembership]);

  const value: SharedListsContextValue = {
    sharedLists,
    sharedItems,
    sharedArchives,
    joinedIds,
    setJoinedIds,
    hydrating,
    promoteTaskListToShared,
    promoteGroceryListToShared,
    joinSharedListByCode,
    addSharedTaskItems,
    editSharedTaskItem,
    deleteSharedTaskItem,
    archiveSharedTaskItem,
    restoreSharedArchiveItem,
    deleteSharedArchiveItem,
    addSharedGroceryItems,
    updateSharedGroceryItem,
    deleteSharedGroceryItem,
    deleteSharedGroceryItems,
    updateSharedGroceryCategories,
    rotateShareCode,
    renameSharedList,
    leaveSharedList,
    deleteSharedList,
  };

  return (
    <SharedListsContext.Provider value={value}>
      {children}
    </SharedListsContext.Provider>
  );
}

function useSharedLists() {
  return useContext(SharedListsContext);
}

interface ThemeTokens {
  bg: string;
  s1: string;
  s2: string;
  s3: string;
  border: string;
  borderMid: string;
  text: string;
  textSub: string;
  textMute: string;
  high: string;
  highBg: string;
  med: string;
  medBg: string;
  low: string;
  lowBg: string;
  // Secondary theme color — complementary to the theme primary, used for
  // surface highlights like active list pill bg. Themes inject this; static
  // LIGHT/DARK constants set it to a neutral fallback.
  secondary: string;
}

// ─── Theme ────────────────────────────────────────────────────────────────────

const DARK: ThemeTokens = {
  bg: '#0B0B10',
  s1: '#13131C',
  s2: '#1C1C28',
  s3: '#242434',
  border: 'rgba(255,255,255,0.07)',
  borderMid: 'rgba(255,255,255,0.12)',
  text: '#EEEEF8',
  textSub: '#8888A8',
  textMute: '#4A4A68',
  high: '#FF5040',
  highBg: 'rgba(255,80,64,0.12)',
  med: '#FFAA28',
  medBg: 'rgba(255,170,40,0.10)',
  low: '#3EC8A8',
  lowBg: 'rgba(62,200,168,0.10)',
  secondary: '#6878A8',
};

const LIGHT: ThemeTokens = {
  bg: '#F5F5FA',
  s1: '#FFFFFF',
  s2: '#EBEBF4',
  s3: '#DDDDE8',
  border: 'rgba(0,0,0,0.08)',
  borderMid: 'rgba(0,0,0,0.14)',
  text: '#1A1A2E',
  textSub: '#55557A',
  textMute: '#7878A0',
  secondary: '#4A5278',
  high: '#E03020',
  highBg: 'rgba(224,48,32,0.10)',
  med: '#CC8800',
  medBg: 'rgba(204,136,0,0.10)',
  low: '#22A888',
  lowBg: 'rgba(34,168,136,0.10)',
};

const ThemeCtx = createContext<ThemeTokens>(DARK);
const useT = () => useContext(ThemeCtx);

// Accents are single hex values applied identically on both modes — the card
// preview shows them in the current theme/mode context. Order traces the
// color wheel so adjacent cards feel related.
// One accent extracted from each theme's signature dark default — mix-and-match.
// Order mirrors THEMES array: Slate, Glacier, Evergreen, Rosewood, Obsidian, Joker.
const ACCENT_COLORS = [
  '#9098B0', // Steel   (Slate)
  '#38C8FF', // Sky     (Glacier)
  '#3DDC97', // Mint    (Evergreen)
  '#FF2255', // Crimson (Rosewood)
  '#FF9900', // Amber   (Obsidian, Midnight Copper)
  '#FF00FF', // Joker   (Joker, Royal Plum)
];
const ACCENT_NAMES: Record<string, string> = {
  '#9098B0': 'Steel',
  '#38C8FF': 'Sky',
  '#3DDC97': 'Mint',
  '#FF2255': 'Crimson',
  '#FF9900': 'Amber',
  '#FF00FF': 'Joker',
};

// Default accents per mode — applied when user has no accent override.
const DEFAULT_ACCENT_LIGHT = '#38C8FF';
const DEFAULT_ACCENT_DARK = '#38C8FF';

interface ThemeDef {
  id: string;
  name: string;
  swatchLight: string;
  swatchDark: string;
  light: ThemeTokens;
  dark: ThemeTokens;
  defaultAccentLight: string;
  defaultAccentDark: string;
  // Secondary color — a complementary tone in the same family. Surfaces in
  // active list pill bg and other "themed" highlights so themes feel like a
  // 3-color palette instead of a single tint.
  secondaryLight: string;
  secondaryDark: string;
}

// Tier colors are constants — themes never override them.
const TIER_TOKENS_DARK = {
  high: DARK.high, highBg: DARK.highBg,
  med: DARK.med, medBg: DARK.medBg,
  low: DARK.low, lowBg: DARK.lowBg,
};
const TIER_TOKENS_LIGHT = {
  high: LIGHT.high, highBg: LIGHT.highBg,
  med: LIGHT.med, medBg: LIGHT.medBg,
  low: LIGHT.low, lowBg: LIGHT.lowBg,
};

type ThemeOverride = Omit<ThemeTokens, keyof typeof TIER_TOKENS_LIGHT | 'secondary'>;
const makeTheme = (
  id: string,
  name: string,
  swatchLight: string,
  swatchDark: string,
  light: ThemeOverride,
  dark: ThemeOverride,
  defaultAccentLight: string,
  defaultAccentDark: string,
  secondaryLight: string,
  secondaryDark: string,
): ThemeDef => ({
  id, name, swatchLight, swatchDark,
  light: { ...light, ...TIER_TOKENS_LIGHT, secondary: secondaryLight },
  dark: { ...dark, ...TIER_TOKENS_DARK, secondary: secondaryDark },
  defaultAccentLight, defaultAccentDark,
  secondaryLight, secondaryDark,
});

// Curated theme pairings. Body text stays high-contrast (near-white on dark,
// near-black on light); only textSub/textMute carry the theme tint.
const THEMES: ThemeDef[] = [
  // Slate — neutral default. Dark is pure OLED black.
  makeTheme('slate', 'Slate', '#F5F5FA', '#000000',
    { bg: LIGHT.bg, s1: LIGHT.s1, s2: LIGHT.s2, s3: LIGHT.s3, border: LIGHT.border, borderMid: LIGHT.borderMid, text: '#0A0A14', textSub: '#55557A', textMute: '#7878A0' },
    { bg: '#000000', s1: '#0C0C14', s2: '#181822', s3: '#262632', border: 'rgba(255,255,255,0.07)', borderMid: 'rgba(255,255,255,0.14)', text: '#FFFFFF', textSub: '#A0A0C0', textMute: '#70708A' },
    '#5A6080', '#9098B0',
    '#4A5278', '#6878A8',
  ),
  // Glacier — ice blue light / charcoal blue dark. Cobalt + sky-blue accent.
  makeTheme('glacier', 'Glacier', '#DCE8F4', '#0A1828',
    { bg: '#E2EEF8', s1: '#F4F9FD', s2: '#CEDFEF', s3: '#B0CAE2', border: 'rgba(20,80,140,0.28)', borderMid: 'rgba(20,80,140,0.46)', text: '#0A0A14', textSub: '#3A5878', textMute: '#688AA8' },
    { bg: '#08121E', s1: '#11212F', s2: '#1B3144', s3: '#28455E', border: 'rgba(120,200,240,0.22)', borderMid: 'rgba(120,200,240,0.42)', text: '#FFFFFF', textSub: '#A6C2DC', textMute: '#7090AA' },
    '#1850D8', '#38C8FF',
    '#3070C8', '#5AB4D8',
  ),
  // Evergreen — pale mint light / forest green dark. Hunter green + Mint accent.
  makeTheme('evergreen', 'Evergreen', '#D4EBD8', '#0A1F18',
    { bg: '#DEF0DE', s1: '#F0F8F0', s2: '#C0DCC2', s3: '#9CC4A0', border: 'rgba(20,90,40,0.28)', borderMid: 'rgba(20,90,40,0.46)', text: '#0A0A14', textSub: '#2A5A3A', textMute: '#5A8064' },
    { bg: '#06180F', s1: '#0E2A1C', s2: '#173E2C', s3: '#225640', border: 'rgba(180,240,180,0.22)', borderMid: 'rgba(180,240,180,0.42)', text: '#FFFFFF', textSub: '#A8CAA8', textMute: '#789278' },
    '#1F6B3A', '#3DDC97',
    '#3A8050', '#7AC080',
  ),
  // Rosewood — dusty rose light / maroon dark. Crimson + crimson-rose accent.
  makeTheme('rosewood', 'Rosewood', '#F0D6DC', '#1F0B12',
    { bg: '#F4DDE2', s1: '#FAEFF2', s2: '#E5BCC4', s3: '#D098A4', border: 'rgba(160,30,60,0.28)', borderMid: 'rgba(160,30,60,0.46)', text: '#0A0A14', textSub: '#6A2C3C', textMute: '#9C6470' },
    { bg: '#170609', s1: '#2A0C14', s2: '#401824', s3: '#5C2638', border: 'rgba(255,170,180,0.22)', borderMid: 'rgba(255,170,180,0.42)', text: '#FFFFFF', textSub: '#C89098', textMute: '#946068' },
    '#C8203C', '#FF2255',
    '#A85060', '#D88090',
  ),
  // Obsidian Gold — warm grey light / pitch black dark. Bronze + deep amber accent.
  makeTheme('obsidian', 'Obsidian Gold', '#E8E2D4', '#000000',
    { bg: '#EEEAE0', s1: '#FAF7EE', s2: '#DCD2BC', s3: '#C2B294', border: 'rgba(110,80,30,0.26)', borderMid: 'rgba(110,80,30,0.44)', text: '#0A0A14', textSub: '#5A4A2C', textMute: '#8A7858' },
    { bg: '#000000', s1: '#100E08', s2: '#1F1A10', s3: '#2E2618', border: 'rgba(255,210,140,0.20)', borderMid: 'rgba(255,210,140,0.40)', text: '#FFFFFF', textSub: '#C8B488', textMute: '#8A7858' },
    '#8A5A18', '#FF9900',
    '#6A4A20', '#A88040',
  ),
  // Midnight Copper — gunmetal blue light / deep gunmetal dark. Amber accent.
  makeTheme('copper', 'Midnight Copper', '#D8E0E8', '#1C252E',
    { bg: '#E4ECF2', s1: '#F2F6FA', s2: '#CCD8E2', s3: '#A8B8C8', border: 'rgba(40,70,100,0.28)', borderMid: 'rgba(40,70,100,0.46)', text: '#0A0A14', textSub: '#3D5670', textMute: '#6B8298' },
    { bg: '#0E1620', s1: '#1A242F', s2: '#26333F', s3: '#384754', border: 'rgba(180,200,220,0.18)', borderMid: 'rgba(180,200,220,0.36)', text: '#FFFFFF', textSub: '#A8BDD0', textMute: '#788A9C' },
    '#B35D33', '#FF9900',
    '#5C7A92', '#88A0B8',
  ),
  // Joker — deep purple canvas, cyan surfaces, green text, magenta accent.
  // Dark tokens are exact output of draftToThemeDef({canvas:#380057,controls:#00eeff,text:#00ff22,accent:#ff00ff,controlsOpacity:39}).
  // s2/s3 carry the 39% alpha suffix (63 in hex) matching the custom draft exactly.
  makeTheme('joker', 'Joker', '#c458c4', '#380057',
    { bg: '#c458c4', s1: '#d46ed4', s2: '#b840b8', s3: '#a030a0', border: '#ff00ff55', borderMid: '#ff00ff', text: '#1a001a', textSub: '#4a004a', textMute: '#780078' },
    { bg: '#380057', s1: '#440069', s2: '#00eeff63', s3: '#00eeff63', border: '#ff00ff55', borderMid: '#ff00ff', text: '#00ff22', textSub: '#00ff22', textMute: '#00ff22' },
    '#FF00FF', '#FF00FF',
    '#c458c4', '#c458c4',
  ),
  // Royal Plum — lavender mist light / deep grape dark. Joker accent on both modes.
  makeTheme('royalplum', 'Royal Plum', '#E2CEEC', '#160828',
    { bg: '#E8D2F2', s1: '#F6EBFA', s2: '#D0B4E2', s3: '#B898D0', border: 'rgba(120,30,170,0.28)', borderMid: 'rgba(120,30,170,0.46)', text: '#0A0A14', textSub: '#5C3870', textMute: '#8060A0' },
    { bg: '#0E0520', s1: '#1F0F36', s2: '#2E1A4E', s3: '#422568', border: 'rgba(230,180,250,0.22)', borderMid: 'rgba(230,180,250,0.42)', text: '#FFFFFF', textSub: '#C0A0D8', textMute: '#8868A0' },
    '#FF00FF', '#FF00FF',
    '#8870C0', '#B898E0',
  ),
];

// Migrate old theme IDs from the previous theme set so saved tri_theme values
// still resolve. Old IDs: navy, forest, maroon, burnt, plum.
const LEGACY_THEME_IDS: Record<string, string> = {
  navy: 'glacier',
  forest: 'evergreen',
  maroon: 'rosewood',
  burnt: 'obsidian',
  plum: 'royalplum',
};

const THEMES_BY_ID: Record<string, ThemeDef> = THEMES.reduce((acc, t) => { acc[t.id] = t; return acc; }, {} as Record<string, ThemeDef>);
const resolveThemeId = (id: string): string => id === 'custom' || /^custom_[012]$/.test(id) || THEMES_BY_ID[id] ? id : (LEGACY_THEME_IDS[id] || 'slate');
const getTheme = (id: string): ThemeDef => THEMES_BY_ID[resolveThemeId(id)] || THEMES_BY_ID.slate;

const TIER_ORDER: Record<Tier, number> = { high: 0, medium: 1, low: 2 };

const TIERS_DEF = (T: ThemeTokens) => [
  { id: 'high' as Tier, label: 'High', color: T.high, bg: T.highBg },
  { id: 'medium' as Tier, label: 'Medium', color: T.med, bg: T.medBg },
  { id: 'low' as Tier, label: 'Low', color: T.low, bg: T.lowBg },
];

// ─── Persistence ─────────────────────────────────────────────────────────────

const CURRENT_APP_VERSION_CODE = 24;
const CURRENT_APP_VERSION_NAME = '1.4.8';
const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/3Dendeavors/Triority/main/latest.json';

interface UpdateManifest {
  versionCode: number;
  versionName?: string;
  apkUrl: string;
  releaseNotesUrl?: string;
  title?: string;
  message?: string;
}

function isUpdateManifest(value: unknown): value is UpdateManifest {
  const data = value as Partial<UpdateManifest> | null;
  return !!data
    && typeof data.versionCode === 'number'
    && Number.isFinite(data.versionCode)
    && typeof data.apkUrl === 'string'
    && /^https:\/\//i.test(data.apkUrl);
}

async function checkForGithubUpdate() {
  if (Platform.OS !== 'android') return;
  try {
    const res = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!isUpdateManifest(data)) return;
    if (data.versionCode <= CURRENT_APP_VERSION_CODE) return;

    const versionLabel = data.versionName ? `v${data.versionName}` : `build ${data.versionCode}`;
    Alert.alert(
      data.title || 'Triority update available',
      data.message || `A newer version of Triority is ready: ${versionLabel}. You have v${CURRENT_APP_VERSION_NAME}.`,
      [
        { text: 'Later', style: 'cancel' },
        {
          text: 'Update',
          onPress: () => {
            Linking.openURL(data.apkUrl).catch(() => {
              if (data.releaseNotesUrl) Linking.openURL(data.releaseNotesUrl).catch(() => {});
            });
          },
        },
      ],
    );
  } catch {}
}

const APP_VERSION = '2';
const NEW_ITEM_SHINE_MS = 2400;
const NEW_ITEM_GLOW_ELIGIBILITY_MS = 5000;
const FOCUSED_ROW_CLEAR_MS = NEW_ITEM_SHINE_MS + 1000;
const NEW_ITEM_SHINE_GOLD = '#FFD76A';
const NEW_ITEM_SHINE_WARM = '#FFB72E';
const NEW_ITEM_SHINE_WHITE = '#FFF8D8';
const SAMPLE_TASK_CREATED_AT = Date.now() - NEW_ITEM_GLOW_ELIGIBILITY_MS - 1000;

const SAMPLE_TASKS: Task[] = [
  { id: 1, text: 'Swipe left to delete a task.', tier: 'high', createdAt: SAMPLE_TASK_CREATED_AT },
  { id: 2, text: 'Swipe right to complete and archive a task.', tier: 'medium', createdAt: SAMPLE_TASK_CREATED_AT },
  { id: 3, text: 'Tap the edit button on a task to edit its text or change its priority.', tier: 'low', createdAt: SAMPLE_TASK_CREATED_AT },
];

const SAMPLE_ARCHIVE: ArchivedTask[] = [
  { id: 101, text: 'Completed tasks appear here. Visit Settings to configure auto-clear.', tier: 'low', completedAt: Date.now() - 3600000 },
];

function ensurePersonalListPresent(lists: TaskList[] = []): TaskList[] {
  const now = Date.now();
  const personal = lists.find(l => l.id === DEFAULT_LIST_ID);
  if (personal) return [personal, ...lists.filter(l => l.id !== DEFAULT_LIST_ID)];
  return [
    { id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME, tasks: [], createdAt: now, updatedAt: now },
    ...lists,
  ];
}

function emptySyncedState(): SyncedState {
  const now = Date.now();
  return {
    lists: [{ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME, tasks: [], createdAt: now, updatedAt: now }],
    activeListId: DEFAULT_LIST_ID,
    archive: [],
    accentLight: null,
    accentDark: null,
    themeId: 'slate',
    customThemeDrafts: [null, null, null],
    personalContext: '',
    defaultTier: 'medium',
    autoClear: 'Never',
    darkMode: true,
    groceryItems: [],
    joinedSharedLists: [],
    syncEnabledForGrocery: false,
    sharedTaskOrder: [],
    listRowOrder: [DEFAULT_LIST_ID],
  };
}

function parseCollapsedGroups(raw: string | null): CollapsedGroups {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.entries(parsed).reduce<CollapsedGroups>((acc, [key, value]) => {
      if (typeof value === 'boolean') acc[key] = value;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

async function loadAll() {
  const version = await AsyncStorage.getItem('tri_version');
  if (version !== APP_VERSION) {
    await AsyncStorage.multiRemove(['tri_tasks', 'tri_archive', 'tri_lists', 'tri_active_list_id']);
    await AsyncStorage.setItem('tri_version', APP_VERSION);
  }
  const [listsRaw, legacyTasks, archive, activeIdRaw, legacyAccent, accentLightRaw, accentDarkRaw, themeRaw, darkMode, defaultTier, autoClear, context, onboarded, widgetOnboardingSeenRaw, listOrderRaw, customThemeRaw, customThemesRaw, groceryRaw, collapsedGroupsRaw, widgetThemeRaw, widgetClearRaw, widgetShorthandRaw, widgetCustomColorsRaw, widgetMicSideRaw] = await Promise.all([
    AsyncStorage.getItem('tri_lists'),
    AsyncStorage.getItem('tri_tasks'),
    AsyncStorage.getItem('tri_archive'),
    AsyncStorage.getItem('tri_active_list_id'),
    AsyncStorage.getItem('tri_accent'),
    AsyncStorage.getItem('tri_accent_light'),
    AsyncStorage.getItem('tri_accent_dark'),
    AsyncStorage.getItem('tri_theme'),
    AsyncStorage.getItem('tri_darkMode'),
    AsyncStorage.getItem('tri_defaultTier'),
    AsyncStorage.getItem('tri_autoClear'),
    AsyncStorage.getItem('triority-context'),
    AsyncStorage.getItem('tri_onboarded'),
    AsyncStorage.getItem(WIDGET_ONBOARDING_RELEASE_KEY),
    AsyncStorage.getItem('tri_list_order'),
    AsyncStorage.getItem('tri_custom_theme'),
    AsyncStorage.getItem('tri_custom_themes'),
    AsyncStorage.getItem('tri_grocery'),
    AsyncStorage.getItem(COLLAPSED_GROUPS_KEY),
    AsyncStorage.getItem(WIDGET_THEME_KEY),
    AsyncStorage.getItem(WIDGET_CLEAR_KEY),
    AsyncStorage.getItem(WIDGET_SHORTHAND_KEY),
    AsyncStorage.getItem(WIDGET_CUSTOM_COLORS_KEY),
    AsyncStorage.getItem(WIDGET_MIC_SIDE_KEY),
  ]);
  // API key is stored encrypted for security
  let apiKey = '';
  try {
    apiKey = await EncryptedStorage.getItem('triority-api-key') || '';
  } catch {}

  // Multi-list migration. Additive: if tri_lists exists use it; else build from legacy tri_tasks
  // (v1.0/v1.1 single-list shape) and write tri_lists. tri_tasks is left in place this version
  // as a safety net — cleaned up in a future version once we're confident.
  let lists: TaskList[];
  const now = Date.now();
  if (listsRaw) {
    const parsed = JSON.parse(listsRaw) as TaskList[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      // Backfill updatedAt for any pre-v1.2-pre-final lists missing it.
      lists = ensurePersonalListPresent(parsed.map(l => ({ ...l, updatedAt: l.updatedAt ?? l.createdAt ?? now })));
    } else {
      lists = [{ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME, tasks: SAMPLE_TASKS, createdAt: now, updatedAt: now }];
    }
  } else if (legacyTasks) {
    const migrated = JSON.parse(legacyTasks) as Task[];
    lists = [{ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME, tasks: migrated, createdAt: now, updatedAt: now }];
    await AsyncStorage.setItem('tri_lists', JSON.stringify(lists));
  } else {
    lists = [{ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME, tasks: SAMPLE_TASKS, createdAt: now, updatedAt: now }];
    await AsyncStorage.setItem('tri_lists', JSON.stringify(lists));
  }

  // Apply saved manual order if present. Any list not in the order array goes to the end.
  if (listOrderRaw) {
    try {
      const order = JSON.parse(listOrderRaw) as string[];
      lists = [
        ...order.map(id => lists.find(l => l.id === id)).filter(Boolean) as TaskList[],
        ...lists.filter(l => !order.includes(l.id)),
      ];
    } catch {}
  }
  lists = ensurePersonalListPresent(lists);

  let activeListId = activeIdRaw ? JSON.parse(activeIdRaw) as string : lists[0].id;
  if (!lists.some(l => l.id === activeListId)) activeListId = lists[0].id;

  // Theme + accent migration. Old `tri_accent` was a single value applied across
  // both modes — preserve it as the dark-mode accent (most users were on dark).
  const legacyAccentValue = legacyAccent ? JSON.parse(legacyAccent) as string : null;
  let accentLight: string | null = accentLightRaw ? JSON.parse(accentLightRaw) as string : null;
  let accentDark: string | null = accentDarkRaw ? JSON.parse(accentDarkRaw) as string : null;
  if (legacyAccentValue && !accentLightRaw && !accentDarkRaw) {
    accentDark = legacyAccentValue;
    accentLight = legacyAccentValue;
    AsyncStorage.setItem('tri_accent_dark', JSON.stringify(legacyAccentValue)).catch(() => {});
    AsyncStorage.setItem('tri_accent_light', JSON.stringify(legacyAccentValue)).catch(() => {});
  }
  // Migrate retired accents: Royal (#FF40C8) -> Joker (#FF00FF), Copper (#FF8C42) -> Amber (#FF9900),
  // Green (#50E878) -> Mint (#3DDC97).
  const migrateRetiredAccent = (v: string | null): string | null => {
    if (!v) return v;
    const up = v.toUpperCase();
    if (up === '#FF40C8') return '#FF00FF';
    if (up === '#FF8C42') return '#FF9900';
    if (up === '#50E878') return '#3DDC97';
    return v;
  };
  const migAccentLight = migrateRetiredAccent(accentLight);
  const migAccentDark = migrateRetiredAccent(accentDark);
  if (migAccentLight !== accentLight) {
    accentLight = migAccentLight;
    if (accentLight) AsyncStorage.setItem('tri_accent_light', JSON.stringify(accentLight)).catch(() => {});
  }
  if (migAccentDark !== accentDark) {
    accentDark = migAccentDark;
    if (accentDark) AsyncStorage.setItem('tri_accent_dark', JSON.stringify(accentDark)).catch(() => {});
  }
  if (legacyAccentValue) {
    AsyncStorage.removeItem('tri_accent').catch(() => {});
  }
  const themeId = themeRaw ? JSON.parse(themeRaw) as string : 'slate';

  const parseDraft = (raw: Record<string, unknown>): CustomThemeDraft | null => {
    if (typeof raw.canvas === 'string' && typeof raw.controls === 'string'
        && typeof raw.text === 'string' && typeof raw.accent === 'string') {
      return {
        canvas: raw.canvas, controls: raw.controls,
        text: raw.text, accent: raw.accent,
        controlsOpacity: typeof raw.controlsOpacity === 'number' ? raw.controlsOpacity : 100,
      };
    }
    // Older shape: { background, surface, border, text }
    if (typeof raw.background === 'string' && typeof raw.surface === 'string'
        && typeof raw.text === 'string') {
      const legacyAccent = (accentDark ?? accentLight ?? legacyAccentValue ?? DEFAULT_CUSTOM_THEME_DRAFT.accent);
      return { canvas: raw.background, controls: raw.surface, text: raw.text, accent: legacyAccent, controlsOpacity: 100 };
    }
    return null;
  };

  // tri_custom_themes: array of 3 nullable slots (new). tri_custom_theme: legacy single slot → migrates to slot 0.
  let customThemeDrafts: (CustomThemeDraft | null)[] = [null, null, null];
  if (customThemesRaw) {
    try {
      const parsed = JSON.parse(customThemesRaw) as unknown[];
      if (Array.isArray(parsed)) {
        customThemeDrafts = [0, 1, 2].map(i => {
          const s = parsed[i];
          if (s && typeof s === 'object') { const d = parseDraft(s as Record<string, unknown>); return d; }
          return null;
        });
      }
    } catch {}
  } else if (customThemeRaw) {
    // Migrate legacy single draft into slot 0
    try {
      const parsed = JSON.parse(customThemeRaw) as Record<string, unknown>;
      customThemeDrafts[0] = parseDraft(parsed);
    } catch {}
  }

  // Migrate old 'custom' themeId to 'custom_0'
  const resolvedThemeId = resolveThemeId(themeId === 'custom' ? 'custom_0' : themeId);

  const groceryItems: GroceryItem[] = groceryRaw ? (JSON.parse(groceryRaw) as GroceryItem[]) : [];
  const widgetThemeParsed = widgetThemeRaw ? JSON.parse(widgetThemeRaw) as string : WIDGET_THEME_MATCH_APP;
  const widgetLegacyClear = widgetThemeParsed === WIDGET_THEME_LEGACY_CLEAR;
  const widgetThemeId = widgetThemeParsed === WIDGET_THEME_MATCH_APP || widgetLegacyClear
    ? WIDGET_THEME_MATCH_APP
    : widgetThemeParsed === WIDGET_THEME_CUSTOM
      ? WIDGET_THEME_CUSTOM
      : resolveThemeId(widgetThemeParsed);
  const widgetClear = widgetLegacyClear || widgetClearRaw === '1' || widgetClearRaw === 'true';
  const widgetShorthand = widgetShorthandRaw == null ? true : (widgetShorthandRaw === '1' || widgetShorthandRaw === 'true');
  let widgetCustomColors = DEFAULT_WIDGET_CUSTOM_COLORS;
  if (widgetCustomColorsRaw) {
    try {
      const parsed = JSON.parse(widgetCustomColorsRaw) as Partial<WidgetCustomColors>;
      const text = typeof parsed.text === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.text)
        ? parsed.text
        : DEFAULT_WIDGET_CUSTOM_COLORS.text;
      const customAccent = typeof parsed.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.accent)
        ? parsed.accent
        : DEFAULT_WIDGET_CUSTOM_COLORS.accent;
      widgetCustomColors = { text, accent: customAccent };
    } catch {}
  }
  if (widgetLegacyClear) {
    AsyncStorage.setItem(WIDGET_THEME_KEY, JSON.stringify(WIDGET_THEME_MATCH_APP)).catch(() => {});
    AsyncStorage.setItem(WIDGET_CLEAR_KEY, '1').catch(() => {});
  }
  const widgetMicSideParsed = widgetMicSideRaw ? JSON.parse(widgetMicSideRaw) as string : 'left';
  const widgetMicSide: WidgetMicSide = widgetMicSideParsed === 'right' ? 'right' : 'left';

  return {
    lists,
    activeListId,
    archive: archive ? (JSON.parse(archive) as ArchivedTask[]) : SAMPLE_ARCHIVE,
    accentLight,
    accentDark,
    themeId: resolvedThemeId,
    darkMode: darkMode ? JSON.parse(darkMode) : true,
    defaultTier: defaultTier ? (JSON.parse(defaultTier) as Tier) : 'medium',
    autoClear: autoClear ? (JSON.parse(autoClear) as AutoClear) : 'Never',
    apiKey: apiKey,
    context: context ? JSON.parse(context) : '',
    onboarded: onboarded === '1',
    widgetOnboardingSeen: widgetOnboardingSeenRaw === '1',
    customThemeDrafts,
    groceryItems,
    collapsedGroups: parseCollapsedGroups(collapsedGroupsRaw),
    widgetThemeId,
    widgetClear,
    widgetShorthand,
    widgetCustomColors,
    widgetMicSide,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(d: Date) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// Compact relative-time formatter for shared-item "last edited" stamps.
// "now" under a minute, "Nm" minutes, "Nh" hours, "Nd" days; falls back to a
// short M/D after a week so old items don't say "47d".
function relTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function isValidKey(k: string) {
  return typeof k === 'string' && k.trim().startsWith('sk-ant-');
}

function startOfDay(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeekMonday(ts: number) {
  const d = new Date(ts);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonth(ts: number) {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ─── Reminder helpers ─────────────────────────────────────────────────────────

function formatReminderTime(ts: number): string {
  const now = new Date();
  const due = new Date(ts);
  const diffMs = ts - now.getTime();
  const timeStr = due.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (diffMs < 0) return `Overdue · ${timeStr}`;
  const diffMins = Math.ceil(diffMs / 60000);
  if (diffMins < 60) return `In ${diffMins}m · ${timeStr}`;
  // Compare calendar days, not raw ms (handles time-of-day correctly)
  const today0 = new Date(now); today0.setHours(0, 0, 0, 0);
  const due0 = new Date(due); due0.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((due0.getTime() - today0.getTime()) / 86400000);
  if (dayDiff === 0) return `Today · ${timeStr}`;
  if (dayDiff === 1) return `Tomorrow · ${timeStr}`;
  if (dayDiff < 7) return `${due.toLocaleDateString('en-US', { weekday: 'long' })} · ${timeStr}`;
  return `${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${timeStr}`;
}

function formatWidgetReminderTime(ts: number): string {
  const now = new Date();
  const due = new Date(ts);
  const diffMs = ts - now.getTime();
  const hour = due.getHours() % 12 || 12;
  const mins = due.getMinutes();
  const suffix = due.getHours() >= 12 ? 'p' : 'a';
  const timeStr = mins === 0 ? `${hour}${suffix}` : `${hour}:${String(mins).padStart(2, '0')}${suffix}`;
  if (diffMs < 0) return `Late ${timeStr}`;
  const diffMins = Math.ceil(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m ${timeStr}`;
  const today0 = new Date(now); today0.setHours(0, 0, 0, 0);
  const due0 = new Date(due); due0.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((due0.getTime() - today0.getTime()) / 86400000);
  if (dayDiff === 0) return `Today ${timeStr}`;
  if (dayDiff === 1) return `Tmr ${timeStr}`;
  if (dayDiff < 7) return `${due.toLocaleDateString('en-US', { weekday: 'short' })} ${timeStr}`;
  return `${due.getMonth() + 1}/${due.getDate()} ${timeStr}`;
}

function reminderRepeatLabel(r: Reminder): string {
  if (r.repeatHourly) return 'hourly until done';
  if (r.repeatDaily) return 'daily until done';
  return 'once';
}

// ─── Notifications (Notifee) ──────────────────────────────────────────────────

const NOTIF_CHANNEL_ID = 'triority-reminders';

async function ensureNotifChannel() {
  // Idempotent — Notifee no-ops if already created
  await notifee.createChannel({
    id: NOTIF_CHANNEL_ID,
    name: 'Reminders',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibration: true,
  });
}

function useSwipeToDismiss(onDismiss: () => void) {
  const dragY = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, g) => g.dy > 4,
    onPanResponderMove: (_, g) => { if (g.dy > 0) dragY.setValue(g.dy); },
    onPanResponderRelease: (_, g) => {
      if (g.dy > 80) {
        Keyboard.dismiss();
        Animated.timing(dragY, { toValue: 600, duration: 200, useNativeDriver: true }).start(onDismiss);
      } else {
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start();
      }
    },
    onPanResponderTerminate: () => {
      Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start();
    },
  })).current;
  return { dragY, panHandlers: panResponder.panHandlers };
}

// In-tree portal so sheets render at the app root (above TabBar) without using
// React Native's <Modal>, which on Android creates a separate window with a
// soft-input mode that breaks IME auto-show + first-keystroke delivery.
type PortalSlot = { id: number; node: React.ReactNode };
type PortalCtxValue = {
  mount: (node: React.ReactNode, onBack?: () => void) => number;
  update: (id: number, node: React.ReactNode) => void;
  unmount: (id: number) => void;
  // Returns true if a topmost portal sheet handled the back press (and dismissed itself).
  handleBack: () => boolean;
};
const PortalCtx = createContext<PortalCtxValue | null>(null);

function PortalHost({ children }: { children: React.ReactNode }) {
  const [slots, setSlots] = useState<PortalSlot[]>([]);
  const idRef = useRef(0);
  const backHandlersRef = useRef<{ id: number; onBack: () => void }[]>([]);
  const api = useMemo<PortalCtxValue>(() => ({
    mount: (node, onBack) => {
      const id = ++idRef.current;
      setSlots(s => [...s, { id, node }]);
      if (onBack) backHandlersRef.current.push({ id, onBack });
      return id;
    },
    update: (id, node) => {
      setSlots(s => s.map(x => x.id === id ? { ...x, node } : x));
    },
    unmount: (id) => {
      setSlots(s => s.filter(x => x.id !== id));
      backHandlersRef.current = backHandlersRef.current.filter(h => h.id !== id);
    },
    handleBack: () => {
      const stack = backHandlersRef.current;
      if (stack.length === 0) return false;
      const top = stack[stack.length - 1];
      top.onBack();
      return true;
    },
  }), []);
  return (
    <PortalCtx.Provider value={api}>
      {children}
      {slots.map(s => <Fragment key={s.id}>{s.node}</Fragment>)}
    </PortalCtx.Provider>
  );
}

// Renders its children at the root portal layer rather than at the call site.
// Mount/update/unmount all happen in effects so PortalHost's setState never
// fires during another component's render.
function RootPortal({ children, onBack }: { children: React.ReactNode; onBack?: () => void }) {
  const ctx = useContext(PortalCtx);
  const idRef = useRef<number | null>(null);
  // Hold the latest onBack so unmount cleanup uses the freshest closure if needed.
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!ctx) return;
    if (idRef.current === null) {
      idRef.current = ctx.mount(children, onBackRef.current ? () => onBackRef.current?.() : undefined);
    } else {
      ctx.update(idRef.current, children);
    }
  }, [ctx, children]);
  useEffect(() => {
    return () => {
      if (ctx && idRef.current !== null) {
        ctx.unmount(idRef.current);
        idRef.current = null;
      }
    };
  }, [ctx]);
  return null;
}

// Two-stage Android hardware-back behavior. Mounted inside PortalHost so it can
// see the portal-sheet stack via PortalCtx. Order:
//   1) If a portal sheet is open, dismiss the topmost one.
//   2) If we're not on the Tasks screen, navigate to Tasks.
//   3) Otherwise return false → OS handles (exits app).
function BackButtonManager({ screen, setScreen }: { screen: Screen; setScreen: (s: Screen) => void }) {
  const ctx = useContext(PortalCtx);
  // Latest screen ref — BackHandler subscriber's closure shouldn't go stale.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (ctx && ctx.handleBack()) return true;
      if (screenRef.current !== 'list') {
        setScreen('list');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [ctx, setScreen]);
  return null;
}

async function ensureNotifPermission(): Promise<boolean> {
  // Android 13+ runtime prompt; older versions return AUTHORIZED automatically
  const settings = await notifee.requestPermission();
  return settings.authorizationStatus === AuthorizationStatus.AUTHORIZED
      || settings.authorizationStatus === AuthorizationStatus.PROVISIONAL;
}

async function requestReminderNotifications(showToast?: (msg: string, sub?: string) => void): Promise<boolean> {
  const ok = await ensureNotifPermission();
  if (!ok) {
    showToast?.('Notifications are off', 'Enable notifications if you want reminders');
  }
  return ok;
}

async function requestReminderSchedulingPermissions(showToast?: (msg: string, sub?: string) => void): Promise<boolean> {
  const notifOk = await requestReminderNotifications(showToast);
  if (!notifOk) return false;
  if (!(await hasExactAlarmPerm())) {
    showToast?.('Allow exact alarms', 'Opening Settings > Alarms & reminders');
    await notifee.openAlarmPermissionSettings().catch(() => {});
    return false;
  }
  return true;
}

function notifIdForTask(taskId: TaskId): string {
  return `tri-task-${taskId}`;
}

function reminderTargetFromData(data?: Record<string, any> | null): ReminderNavTarget | null {
  if (!data) return null;
  const route = String(data.route || '');
  const taskId = data.taskId == null ? undefined : String(data.taskId);
  const listId = data.listId == null ? undefined : String(data.listId);
  const scheduledTaskId = data.scheduledTaskId == null ? taskId : String(data.scheduledTaskId);
  if (route !== 'taskReminder' && !taskId) return null;
  return { listId, taskId, scheduledTaskId };
}

function widgetTaskTargetFromUrl(url?: string | null): ReminderNavTarget | null {
  if (!url || !url.startsWith('triority://widget-task')) return null;
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  if (!query) return null;
  const params: Record<string, string> = {};
  query.split('&').forEach((part) => {
    const [rawKey, rawValue = ''] = part.split('=');
    if (!rawKey) return;
    try {
      params[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {}
  });
  const taskId = params.taskId?.trim();
  const listId = params.listId?.trim();
  if (!taskId) return null;
  return { listId, taskId, scheduledTaskId: taskId };
}

function reminderNotificationData(task: Task) {
  const displayTaskId = task.reminderTaskId ?? task.id;
  return stripUndefined({
    route: 'taskReminder',
    taskId: String(displayTaskId),
    scheduledTaskId: String(task.id),
    listId: task.reminderListId,
  });
}

function activeReminderOccurrence(task: Task, now = Date.now()): number | null {
  const r = task.reminder;
  if (!r) return null;
  const interval = r.repeatHourly ? 3600000 : r.repeatDaily ? 86400000 : 0;
  const base = r.remindAt;
  if (now < base) return null;
  const occurrence = interval > 0
    ? base + Math.floor((now - base) / interval) * interval
    : base;
  return now - occurrence <= 90000 ? occurrence : null;
}

function reminderTaskMatchesTarget(task: Task, target: ReminderNavTarget): boolean {
  const displayTaskId = String(task.reminderTaskId ?? task.id);
  const scheduledTaskId = String(task.id);
  const targetTaskId = target.taskId == null ? '' : String(target.taskId);
  const targetScheduledTaskId = target.scheduledTaskId == null ? '' : String(target.scheduledTaskId);
  const targetListId = target.listId == null ? '' : String(target.listId);
  if (targetScheduledTaskId && targetScheduledTaskId === scheduledTaskId) return true;
  if (!targetTaskId || targetTaskId !== displayTaskId) return false;
  return !targetListId || targetListId === task.reminderListId;
}

function calendarConflictKey(listId: string | undefined, taskId: TaskId | undefined) {
  if (!listId || taskId == null) return '';
  return `${listId}:${String(taskId)}`;
}

function calendarConflictKeyForTask(task: Task, fallbackListId?: string) {
  return calendarConflictKey(task.reminderListId || fallbackListId, task.reminderTaskId ?? task.id);
}

function nextReminderOccurrenceAt(r: Reminder, now = Date.now()): number | null {
  const interval = r.repeatHourly ? 3600000 : r.repeatDaily ? 86400000 : 0;
  if (r.remindAt >= now - 60000) return r.remindAt;
  if (!interval) return null;
  return r.remindAt + Math.ceil((now - r.remindAt) / interval) * interval;
}

type CalendarBusyBlock = { start: number; end: number };

async function getCalendarFreeBusyAccessToken() {
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  let cachedAccessToken = '';
  try {
    const current = GoogleSignin.getCurrentUser?.();
    const scopes = current?.scopes || [];
    const missingScopes = [GOOGLE_CALENDAR_FREEBUSY_SCOPE, GOOGLE_CALENDAR_LIST_SCOPE]
      .filter((scope) => !scopes.includes(scope));
    if (missingScopes.length > 0) {
      cachedAccessToken = (await GoogleSignin.getTokens().catch(() => ({ accessToken: '' }))).accessToken;
      const response = await GoogleSignin.addScopes({ scopes: missingScopes });
      if (response && response.type === 'cancelled') return null;
      if (cachedAccessToken) {
        await GoogleSignin.clearCachedAccessToken(cachedAccessToken).catch(() => {});
      }
    }
  } catch {}
  const tokens = await GoogleSignin.getTokens();
  return tokens.accessToken;
}

function calendarCheckErrorMessage(error: any) {
  const raw = String(error?.message || error || '').trim();
  const lower = raw.toLowerCase();
  if (lower.includes('calendar api has not been used') || lower.includes('disabled')) {
    return 'Calendar API is not enabled';
  }
  if (lower.includes('insufficient') || lower.includes('scope') || lower.includes('403')) {
    return 'Calendar permission needs reconnect';
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid credentials')) {
    return 'Google sign-in needs refresh';
  }
  if (lower.includes('network') || lower.includes('failed to fetch')) {
    return 'Calendar network check failed';
  }
  return raw ? `Calendar check failed: ${raw.slice(0, 80)}` : 'Calendar conflicts could not be checked';
}

async function fetchCalendarIds(accessToken: string) {
  const resp = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || 'Could not read calendar list');
  const items = Array.isArray(data?.items) ? data.items : [];
  const ids = items
    .filter((item: any) => item?.id && item.hidden !== true && item.selected !== false)
    .map((item: any) => String(item.id));
  return ids.length > 0 ? Array.from(new Set(ids)) : ['primary'];
}

async function fetchCalendarBusyBlocks(accessToken: string, timeMin: number, timeMax: number): Promise<CalendarBusyBlock[]> {
  const primaryBlocks = await fetchCalendarBusyBlocksForIds(accessToken, timeMin, timeMax, ['primary']);
  const calendarIds = await fetchCalendarIds(accessToken).catch(() => []);
  const extraCalendarIds = calendarIds.filter((id) => id !== 'primary');
  if (extraCalendarIds.length === 0) return primaryBlocks;
  const extraBlocks = await fetchCalendarBusyBlocksForIds(accessToken, timeMin, timeMax, extraCalendarIds).catch(() => []);
  return [...primaryBlocks, ...extraBlocks];
}

async function fetchCalendarBusyBlocksForIds(accessToken: string, timeMin: number, timeMax: number, calendarIds: string[]): Promise<CalendarBusyBlock[]> {
  const resp = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      items: calendarIds.map((id) => ({ id })),
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${data?.error?.message || 'Could not check calendar'}`);
  const calendars = data?.calendars && typeof data.calendars === 'object' ? data.calendars : {};
  const calendarErrors = Object.values(calendars)
    .flatMap((calendar: any) => Array.isArray(calendar?.errors) ? calendar.errors : [])
    .map((err: any) => String(err?.reason || err?.message || 'calendar error'))
    .filter(Boolean);
  if (calendarErrors.length > 0) throw new Error(calendarErrors[0]);
  const busy = Object.values(calendars).flatMap((calendar: any) => Array.isArray(calendar?.busy) ? calendar.busy : []);
  return busy
    .map((b: any) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b: { start: number; end: number }) => {
      if (!Number.isFinite(b.start) || !Number.isFinite(b.end) || b.end <= b.start) return false;
      return b.end - b.start < 20 * 60 * 60 * 1000;
    });
}

async function displayActiveReminder(task: Task) {
  if (!task.reminder) return;
  await ensureNotifChannel();
  const settings = await notifee.getNotificationSettings().catch(() => null);
  const notifOk = settings?.authorizationStatus === AuthorizationStatus.AUTHORIZED
    || settings?.authorizationStatus === AuthorizationStatus.PROVISIONAL;
  if (!notifOk) return;
  await notifee.displayNotification({
    id: notifIdForTask(task.id),
    title: task.text.slice(0, 80),
    body: task.tier === 'high' ? 'High priority reminder' : 'Reminder',
    android: {
      channelId: NOTIF_CHANNEL_ID,
      smallIcon: 'ic_launcher',
      pressAction: { id: 'default' },
    },
    data: reminderNotificationData(task),
  });
}

// Returns true if exact-alarm permission is granted (Android 12+).
// On non-Android (or older Android), always true. Does NOT prompt or redirect.
async function hasExactAlarmPerm(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const s = await notifee.getNotificationSettings().catch(() => null);
  return s?.android.alarm === AndroidNotificationSetting.ENABLED;
}

async function scheduleReminder(task: Task) {
  if (!task.reminder) return;
  await ensureNotifChannel();

  // Caller is responsible for verifying exact-alarm permission via hasExactAlarmPerm()
  // before invoking this in a loop, so we don't redirect the user mid-batch.
  // We still guard here so a stray call without perm throws cleanly instead of
  // failing inside Notifee with an opaque error.
  if (!(await hasExactAlarmPerm())) {
    throw new Error('Exact alarm permission not granted');
  }

  // Cancel any existing scheduled notification for this task before re-creating
  await notifee.cancelTriggerNotification(notifIdForTask(task.id)).catch(() => {});

  const remindAt = task.reminder.remindAt;
  // If the reminder is already in the past and not set to repeat, skip scheduling
  if (remindAt < Date.now() - 60000 && !task.reminder.repeatHourly && !task.reminder.repeatDaily) {
    return;
  }

  const repeatFrequency = task.reminder.repeatHourly
    ? RepeatFrequency.HOURLY
    : task.reminder.repeatDaily
    ? RepeatFrequency.DAILY
    : undefined;

  // For repeating reminders that started in the past, advance to next occurrence
  let timestamp = remindAt;
  const now = Date.now();
  if (timestamp < now) {
    if (task.reminder.repeatHourly) {
      while (timestamp < now) timestamp += 3600000;
    } else if (task.reminder.repeatDaily) {
      while (timestamp < now) timestamp += 86400000;
    } else {
      // already returned above
      return;
    }
  }

  await notifee.createTriggerNotification(
    {
      id: notifIdForTask(task.id),
      title: task.text.slice(0, 80),
      body: task.tier === 'high' ? 'High priority reminder' : 'Reminder',
      android: {
        channelId: NOTIF_CHANNEL_ID,
        smallIcon: 'ic_launcher',
        // 'default' pressAction with no launchActivity opens the app's main activity
        pressAction: { id: 'default' },
      },
      data: reminderNotificationData(task),
    },
    {
      type: TriggerType.TIMESTAMP,
      timestamp,
      ...(repeatFrequency ? { repeatFrequency } : {}),
      alarmManager: { allowWhileIdle: true },
    },
  );
}

async function cancelReminder(taskId: TaskId) {
  await notifee.cancelTriggerNotification(notifIdForTask(taskId)).catch(() => {});
  await notifee.cancelDisplayedNotification(notifIdForTask(taskId)).catch(() => {});
}

// Schedules reminders for a batch of tasks. Surfaces failures via showToast
// instead of swallowing them silently. Checks exact-alarm perm once before
// the loop so we don't redirect the user to settings mid-batch (and then
// have the remaining tasks silently fail on the same missing perm).
async function scheduleRemindersBatch(
  tasks: Task[],
  showToast: (msg: string, sub?: string) => void,
  listId?: string,
) {
  const remTasks = tasks
    .filter(t => t.reminder)
    .map(t => stripUndefined({ ...t, reminderListId: t.reminderListId ?? listId, reminderTaskId: t.reminderTaskId ?? t.id }) as Task);
  if (remTasks.length === 0) return;

  if (!(await requestReminderSchedulingPermissions(showToast))) return;

  let failed = 0;
  for (const t of remTasks) {
    try {
      await scheduleReminder(t);
    } catch {
      failed++;
    }
  }
  if (failed > 0) {
    showToast(
      failed === remTasks.length ? 'Reminder couldn’t be scheduled' : `${failed} reminder${failed === 1 ? '' : 's'} couldn’t be scheduled`,
      'Check Settings → Alarms & reminders',
    );
  }
}

// Reconcile all scheduled notifications against the current task list
// Called on app start and after bulk operations.
// Orphan cancellation always runs (no permissions needed); re-scheduling only
// runs when notif + alarm permissions are granted to avoid prompting on cold start.
async function syncAllReminders(tasks: Task[]) {
  await ensureNotifChannel();
  const scheduled = await notifee.getTriggerNotificationIds().catch(() => [] as string[]);
  const wantedIds = new Set(tasks.filter(t => t.reminder).map(t => notifIdForTask(t.id)));
  for (const id of scheduled) {
    if (id.startsWith('tri-task-') && !wantedIds.has(id)) {
      await notifee.cancelTriggerNotification(id).catch(() => {});
    }
  }
  const tasksWithReminders = tasks.filter(t => t.reminder);
  if (tasksWithReminders.length === 0) return;
  const settings = await notifee.getNotificationSettings().catch(() => null);
  const notifOk = settings?.authorizationStatus === AuthorizationStatus.AUTHORIZED;
  const alarmOk = Platform.OS !== 'android' || settings?.android.alarm === AndroidNotificationSetting.ENABLED;
  if (!notifOk || !alarmOk) return;
  for (const t of tasksWithReminders) {
    await scheduleReminder(t).catch(() => {});
  }
}

// ─── Font helper ─────────────────────────────────────────────────────────────

function jks(weight: '400' | '500' | '600' | '700' | '800') {
  const map: Record<string, string> = {
    '400': 'PlusJakartaSans-Regular',
    '500': 'PlusJakartaSans-Medium',
    '600': 'PlusJakartaSans-SemiBold',
    '700': 'PlusJakartaSans-Bold',
    '800': 'PlusJakartaSans-ExtraBold',
  };
  return map[weight];
}

// ─── Icon ─────────────────────────────────────────────────────────────────────

interface IconProps {
  name: string;
  size?: number;
  color?: string;
  strokeWidth?: number; // accepted for API compatibility, unused with vector fonts
}

const ICON_MAP: Record<string, { family: 'feather' | 'ionicons'; glyph: string }> = {
  list:     { family: 'feather',  glyph: 'list' },
  archive:  { family: 'feather',  glyph: 'archive' },
  settings: { family: 'feather',  glyph: 'settings' },
  check:    { family: 'feather',  glyph: 'check' },
  trash:    { family: 'feather',  glyph: 'trash-2' },
  mic:      { family: 'feather',  glyph: 'mic' },
  sparkles: { family: 'ionicons', glyph: 'sparkles' },
  restore:  { family: 'feather',  glyph: 'rotate-ccw' },
  eye:      { family: 'feather',  glyph: 'eye' },
  eyeOff:   { family: 'feather',  glyph: 'eye-off' },
  plus:     { family: 'feather',  glyph: 'plus' },
  pencil:   { family: 'feather',  glyph: 'edit-2' },
  calendar: { family: 'feather',  glyph: 'calendar' },
  bell:     { family: 'feather',  glyph: 'bell' },
  bellOff:  { family: 'feather',  glyph: 'bell-off' },
  clock:    { family: 'feather',  glyph: 'clock' },
  layers:   { family: 'feather',  glyph: 'layers' },
  'shopping-cart': { family: 'feather', glyph: 'shopping-cart' },
  basket:   { family: 'ionicons', glyph: 'basket-outline' },
  'shopping-bag': { family: 'feather', glyph: 'shopping-bag' },
  sun:      { family: 'feather',  glyph: 'sun' },
  user:     { family: 'feather',  glyph: 'user' },
  users:    { family: 'feather',  glyph: 'users' },
  link:     { family: 'feather',  glyph: 'link' },
  logIn:    { family: 'feather',  glyph: 'log-in' },
  'refresh-cw': { family: 'feather', glyph: 'refresh-cw' },
  heart:    { family: 'feather',  glyph: 'heart' },
  home:     { family: 'feather',  glyph: 'home' },
};

function Icon({ name, size = 20, color = '#000' }: IconProps) {
  const entry = ICON_MAP[name];
  if (!entry) return null;
  if (entry.family === 'ionicons') {
    return <Ionicons name={entry.glyph} size={size} color={color} />;
  }
  return <Feather name={entry.glyph} size={size} color={color} />;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

interface ToastData {
  message: string;
  sub?: string;
}

function Toast({ message, sub }: ToastData) {
  const T = useT();
  return (
    <View style={[styles.toastWrap, { backgroundColor: T.s1, borderColor: T.borderMid }]}>
      <Text style={[styles.toastMsg, { color: T.text, fontFamily: jks('700') }]}>{message}</Text>
      {sub ? <Text style={[styles.toastSub, { color: T.textSub, fontFamily: jks('400') }]}>{sub}</Text> : null}
    </View>
  );
}

// ─── Edit Bottom Sheet ────────────────────────────────────────────────────────

interface EditSheetProps {
  task: Task;
  onSave: (t: Task) => void;
  onCancel: () => void;
  accentColor: string;
  showToast?: (msg: string, sub?: string) => void;
}

// Shared reminder picker UI used by both EditSheet and PriorityPicker
function ReminderPicker({ reminder, onChange, accentColor, showToast }: {
  reminder: Reminder | undefined;
  onChange: (r: Reminder | undefined) => void;
  accentColor: string;
  showToast?: (msg: string, sub?: string) => void;
}) {
  const T = useT();
  const on = !!reminder;

  // Compute sane defaults: 1 hour from now, rounded to next 5min, PM if afternoon
  const defaultRemindDate = () => {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    return d;
  };

  const initDate = reminder ? new Date(reminder.remindAt) : defaultRemindDate();
  const initHour24 = initDate.getHours();

  // All time state in 12hr; snap minute to nearest 5 so the spinner is sane
  const [hour12, setHour12] = useState(initHour24 % 12 || 12);
  const [minute, setMinute] = useState(Math.round(initDate.getMinutes() / 5) * 5 % 60);
  const [isPm, setIsPm] = useState(initHour24 >= 12);

  // Day: 0=today, 1=tomorrow, etc. Compare calendar dates not ms diff
  const [daysAhead, setDaysAhead] = useState(() => {
    const nowDate = new Date(); nowDate.setHours(0, 0, 0, 0);
    const remDate = new Date(initDate); remDate.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((remDate.getTime() - nowDate.getTime()) / 86400000));
  });

  const [repeatHourly, setRepeatHourly] = useState(reminder?.repeatHourly ?? false);
  const [repeatDaily, setRepeatDaily] = useState(reminder?.repeatDaily ?? false);

  const pad = (n: number) => String(n).padStart(2, '0');

  // Build timestamp from current state
  const buildTs = (h12: number, m: number, pm: boolean, days: number): number => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const h24 = pm ? (h12 === 12 ? 12 : h12 + 12) : (h12 === 12 ? 0 : h12);
    d.setHours(h24, m, 0, 0);
    return d.getTime();
  };

  const emit = (h12: number, m: number, pm: boolean, days: number, rh: boolean, rd: boolean) => {
    onChange({ remindAt: buildTs(h12, m, pm, days), repeatHourly: rh, repeatDaily: rd });
  };

  const cycleHour = (dir: 1 | -1) => {
    const next = (hour12 - 1 + dir + 12) % 12 + 1; // 1-12
    setHour12(next); emit(next, minute, isPm, daysAhead, repeatHourly, repeatDaily);
  };
  const cycleMin = (dir: 1 | -1) => {
    // Snap to nearest 5 first (so 11:43 ▲ becomes 11:45, not 11:48), then step
    let next: number;
    if (minute % 5 !== 0) {
      next = dir === 1 ? Math.ceil(minute / 5) * 5 : Math.floor(minute / 5) * 5;
    } else {
      next = minute + dir * 5;
    }
    next = (next + 60) % 60;
    setMinute(next); emit(hour12, next, isPm, daysAhead, repeatHourly, repeatDaily);
  };
  const toggleAmPm = () => {
    const next = !isPm; setIsPm(next); emit(hour12, minute, next, daysAhead, repeatHourly, repeatDaily);
  };
  const setDay = (days: number) => {
    setDaysAhead(days); emit(hour12, minute, isPm, days, repeatHourly, repeatDaily);
  };
  const cycleDays = (dir: 1 | -1) => {
    const next = Math.max(0, daysAhead + dir); setDay(next);
  };

  const toggle = () => {
    if (on) {
      onChange(undefined);
    } else {
      // Ask for notification permission at the moment the user expresses intent
      // so the system prompt comes inline with their action, not later
      requestReminderNotifications(showToast).catch(() => {});
      onChange({ remindAt: buildTs(hour12, minute, isPm, daysAhead), repeatHourly, repeatDaily });
    }
  };

  const dayLabel = (d: number) => d === 0 ? 'Today' : `+${d} day${d === 1 ? '' : 's'}`;

  return (
    <>
      <View style={[styles.recurToggleRow, { borderColor: T.border, marginBottom: on ? 0 : 4 }]}>
        <View style={styles.recurToggleLeft}>
          <Icon name="bell" size={14} color={on ? accentColor : T.textMute} />
          <Text style={[styles.recurToggleLabel, { color: on ? T.text : T.textSub, fontFamily: jks('600') }]}>Remind me</Text>
        </View>
        <TouchableOpacity onPress={toggle} activeOpacity={0.8}
          style={[styles.toggle, { backgroundColor: on ? accentColor : T.s3, borderColor: on ? accentColor : T.border }]}>
          <View style={[styles.toggleKnob, { backgroundColor: on ? '#fff' : T.textSub, left: on ? 20 : 2 }]} />
        </TouchableOpacity>
      </View>

      {on && (
        <View style={[styles.recurPanel, { backgroundColor: T.s2, borderColor: T.border, marginBottom: 4 }]}>
          {/* Day spinner + time picker side by side, centered */}
          <Text style={[styles.recurSectionLabel, { color: T.textMute, fontFamily: jks('600'), textAlign: 'center' }]}>When</Text>
          <View style={[styles.recurDayTimeRow, { marginBottom: 12, justifyContent: 'center' }]}>
            <TouchableOpacity onPress={() => cycleDays(-1)} disabled={daysAhead === 0}
              style={[styles.recurSpinBtn, { backgroundColor: T.s3, borderColor: T.border, opacity: daysAhead === 0 ? 0.4 : 1 }]}>
              <Text style={[styles.recurSpinLabel, { color: T.text, fontFamily: jks('700') }]}>−</Text>
            </TouchableOpacity>
            <Text style={[styles.recurIntervalVal, { color: T.text, fontFamily: jks('700') }]}>{dayLabel(daysAhead)}</Text>
            <TouchableOpacity onPress={() => cycleDays(1)} style={[styles.recurSpinBtn, { backgroundColor: T.s3, borderColor: T.border }]}>
              <Text style={[styles.recurSpinLabel, { color: T.text, fontFamily: jks('700') }]}>+</Text>
            </TouchableOpacity>
            <View style={[styles.recurDivider, { backgroundColor: T.border }]} />
            <View style={[styles.recurTimeUnit, { backgroundColor: T.s3, borderColor: T.border }]}>
              <TouchableOpacity onPress={() => cycleHour(1)} hitSlop={{ top: 8, bottom: 8, left: 14, right: 14 }}>
                <Text style={[styles.recurTimeArrow, { color: T.textSub }]}>▲</Text>
              </TouchableOpacity>
              <Text style={[styles.recurTimeVal, { color: T.text, fontFamily: jks('700') }]}>{pad(hour12)}</Text>
              <TouchableOpacity onPress={() => cycleHour(-1)} hitSlop={{ top: 8, bottom: 8, left: 14, right: 14 }}>
                <Text style={[styles.recurTimeArrow, { color: T.textSub }]}>▼</Text>
              </TouchableOpacity>
            </View>
            <Text style={[styles.recurTimeColon, { color: T.textSub, fontFamily: jks('700') }]}>:</Text>
            <View style={[styles.recurTimeUnit, { backgroundColor: T.s3, borderColor: T.border }]}>
              <TouchableOpacity onPress={() => cycleMin(1)} hitSlop={{ top: 8, bottom: 8, left: 14, right: 14 }}>
                <Text style={[styles.recurTimeArrow, { color: T.textSub }]}>▲</Text>
              </TouchableOpacity>
              <Text style={[styles.recurTimeVal, { color: T.text, fontFamily: jks('700') }]}>{pad(minute)}</Text>
              <TouchableOpacity onPress={() => cycleMin(-1)} hitSlop={{ top: 8, bottom: 8, left: 14, right: 14 }}>
                <Text style={[styles.recurTimeArrow, { color: T.textSub }]}>▼</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={toggleAmPm}
              style={[styles.ampmBtn, { backgroundColor: T.s3, borderColor: T.border }]}>
              <Text style={[styles.ampmLabel, { color: accentColor, fontFamily: jks('700') }]}>{isPm ? 'PM' : 'AM'}</Text>
            </TouchableOpacity>
          </View>

          {/* Repeat options — centered */}
          <Text style={[styles.recurSectionLabel, { color: T.textMute, fontFamily: jks('600'), textAlign: 'center' }]}>If not done, remind again</Text>
          <View style={[styles.recurFreqRow, { justifyContent: 'center' }]}>
            {([['Never', false, false], ['Every hour', true, false], ['Daily', false, true]] as [string, boolean, boolean][]).map(([label, rh, rd]) => {
              const active = repeatHourly === rh && repeatDaily === rd;
              return (
                <TouchableOpacity key={label} onPress={() => { setRepeatHourly(rh); setRepeatDaily(rd); emit(hour12, minute, isPm, daysAhead, rh, rd); }}
                  style={[styles.recurFreqBtn, { backgroundColor: active ? `${accentColor}22` : T.s3, borderColor: active ? accentColor : T.border }]}>
                  <Text style={[styles.recurFreqLabel, { color: active ? accentColor : T.textSub, fontFamily: jks('700') }]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}
    </>
  );
}

function EditSheet({ task, onSave, onCancel, accentColor, showToast }: EditSheetProps) {
  const T = useT();
  const TIERS = TIERS_DEF(T);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // Uncontrolled text: native field owns the value. React-controlled `value`
  // races the Android IME's composing region — on a real S24 that produces
  // garbled text and "deletes the wrong character" on backspace mid-word.
  // We mirror to a ref for save(), and to a boolean for the Save-disabled UI.
  const textRef = useRef(task.text);
  const [hasText, setHasText] = useState(task.text.trim().length > 0);
  const [tier, setTier] = useState<Tier>(task.tier);
  const [reminder, setReminder] = useState<Reminder | undefined>(task.reminder);
  const textInputRef = useRef<TextInput | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  // Initialize from the current IME state instead of 0. When EditSheet opens
  // with the keyboard already up (e.g. user was typing in the InputBar and
  // tapped a row's edit pencil), keyboardDidShow won't fire because there's
  // no transition — leaving kbHeight at 0 and the panel sitting under the IME.
  // Keyboard.metrics() returns the current rect synchronously.
  const [keyboard, setKeyboard] = useState<KeyboardSheetState>(() => getKeyboardMetrics());

  const slideAnim = useRef(new Animated.Value(400)).current;
  const { dragY, panHandlers } = useSwipeToDismiss(onCancel);

  // Just store the ref. Focus is driven by the effect below so it runs after
  // the slide animation completes — focusing during the animation is unreliable
  // on Android (system can skip the soft-IME show if window layout isn't settled).
  const setTextInputRef = useCallback((node: TextInput | null) => {
    textInputRef.current = node;
  }, []);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // If the keyboard was already up when the sheet mounted, the IME is
    // already there — no keyboardDidShow event will fire (no transition) and
    // no retry is needed. Seeding kbAppeared from the synchronous metrics
    // read is what prevents a spurious blur+focus 350ms in (which would
    // bounce the IME and reproduce the first-keystroke-drop bug).
    let kbAppeared = getKeyboardMetrics().height > 0;

    const showSub = Keyboard.addListener('keyboardDidShow', e => {
      kbAppeared = true;
      setKeyboard(keyboardStateFromEvent(e));
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboard({ height: 0, screenY: null });
      setInputFocused(false);
    });

    // Focus AFTER slide completes (~280ms) — focusing during the animation can
    // silently no-op on S24's IME, leaving the user staring at a sheet with no
    // keyboard. If the IME still hasn't appeared 350ms after focus, retry once.
    Animated.timing(slideAnim, { toValue: 0, duration: 280, useNativeDriver: true }).start(() => {
      const node = textInputRef.current;
      if (!node) return;
      node.focus();
      // Explicitly land the cursor at end-of-text to defeat Android's
      // multi-line TextInput quirk that shows the existing content as
      // "selected" on first focus — that selection caused the user's first
      // keystroke to overwrite the existing first character.
      const len = (textRef.current || '').length;
      try { (node as any).setNativeProps?.({ selection: { start: len, end: len } }); } catch {}
      retryTimer = setTimeout(() => {
        if (!kbAppeared && textInputRef.current) {
          textInputRef.current.blur();
          textInputRef.current.focus();
        }
      }, 350);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [slideAnim]);

  // Portal sheets share the activity window with the IME, so we must explicitly
  // dismiss the keyboard on close — Modal-based sheets got this for free via
  // window destruction.
  const cancel = () => { Keyboard.dismiss(); onCancel(); };
  const save = () => {
    const trimmed = textRef.current.trim();
    if (!trimmed) return;
    Keyboard.dismiss();
    onSave({ ...task, text: trimmed, widgetLabel: trimmed === task.text.trim() ? task.widgetLabel : undefined, tier, reminder });
  };

  const handleChangeText = (next: string) => {
    textRef.current = next;
    const nonEmpty = next.trim().length > 0;
    if (nonEmpty !== hasText) setHasText(nonEmpty);
  };

  const sheetFrame = getKeyboardSheetFrame(keyboard, insets.top, insets.bottom, windowHeight, inputFocused);
  const scrollMaxHeight = sheetFrame.keyboardInset > 0
    ? Math.max(220, Math.min(430, sheetFrame.maxHeight - 86))
    : 508;

  return (
    <RootPortal onBack={cancel}>
      <View style={styles.portalRoot}>
        <TouchableWithoutFeedback onPress={cancel}>
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>
        <Animated.View style={[styles.sheetPanel, { bottom: sheetFrame.bottom, maxHeight: sheetFrame.maxHeight, backgroundColor: T.s1, borderColor: T.border, transform: [{ translateY: Animated.add(slideAnim, dragY) }] }]}>
          <View style={styles.sheetHandle} {...panHandlers}>
            <View style={[styles.sheetHandleBar, { backgroundColor: T.s3 }]} />
          </View>
          {/* Scrollable content. Buttons are pinned outside the ScrollView so they
              stay visible regardless of keyboard state or how much content scrolls. */}
          <ScrollView style={[styles.sheetScroll, { maxHeight: scrollMaxHeight }]} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text style={[styles.sheetTitle, { color: T.textMute, fontFamily: jks('700') }]}>Edit Task</Text>
            <TextInput ref={setTextInputRef} defaultValue={task.text} onChangeText={handleChangeText} onFocus={() => setInputFocused(true)} multiline scrollEnabled
              autoCorrect={false} autoComplete="off" spellCheck={false} importantForAutofill="no"
              selectTextOnFocus={false}
              style={[styles.sheetTextarea, { backgroundColor: T.s2, color: T.text, borderColor: `${accentColor}50`, fontFamily: jks('400') }]} />
            <Text style={[styles.sheetPriorityLabel, { color: T.textMute, fontFamily: jks('600') }]}>Priority</Text>
            <View style={[styles.sheetTierRow, { marginBottom: 12 }]}>
              {TIERS.map(t => (
                <TouchableOpacity key={t.id} onPress={() => setTier(t.id)}
                  style={[styles.tierBtn, { backgroundColor: tier === t.id ? `${t.color}22` : T.s2, borderColor: tier === t.id ? t.color : T.border }]}>
                  <View style={[styles.tierDot, { backgroundColor: tier === t.id ? t.color : T.textMute }]} />
                  <Text style={[styles.tierBtnLabel, { color: tier === t.id ? t.color : T.textSub, fontFamily: jks('700') }]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <ReminderPicker reminder={reminder} onChange={setReminder} accentColor={accentColor} showToast={showToast} />
          </ScrollView>
          <View style={[styles.sheetFooter, { borderTopColor: T.border, backgroundColor: T.s1 }]}>
            <View style={styles.sheetActions}>
              <TouchableOpacity onPress={cancel} style={[styles.sheetCancelBtn, { backgroundColor: T.s2, borderColor: T.border }]}>
                <Text style={[styles.sheetCancelLabel, { color: T.textSub, fontFamily: jks('600') }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={save} style={[styles.sheetSaveBtn, { backgroundColor: accentColor, opacity: hasText ? 1 : 0.5 }]}>
                <Text style={[styles.sheetSaveLabel, { fontFamily: jks('700') }]}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>
      </View>
    </RootPortal>
  );
}

// ─── TaskRow ─────────────────────────────────────────────────────────────────

const SWIPE_THRESHOLD = 60;
const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface TaskRowProps {
  task: Task;
  index: number;
  onComplete: (id: TaskId) => void;
  onDelete: (id: TaskId) => void;
  requestComplete: (id: TaskId) => void;
  onEdit: (task: Task) => void;
  accentColor: string;
  // Drag-and-drop hooks driven by TierGroup. Long-press → onLongPressStart fires
  // and the row enters drag mode. While in drag mode, vertical pan reports back
  // via onDragMove (signed dy from origin + finger pageY for edge-scroll). On
  // release, onDragEnd reports whether the drag was committed (true) or aborted.
  onLongPressStart: () => void;
  onDragMove: (dy: number, fingerPageY: number) => void;
  onDragEnd: (committed: boolean) => void;
  isDragging: boolean;
  focused?: boolean;
  glowTriggerKey?: string;
  calendarConflict?: boolean;
}

const REVEAL_X = -72; // distance the row holds at when trash is revealed
const DRAG_LONG_PRESS_MS = 400;

function useNewItemGlow(createdAt: number | undefined, identity: TaskId | string, triggerKey?: string) {
  const glow = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const sparkle = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    glow.stopAnimation();
    sweep.stopAnimation();
    sparkle.stopAnimation();
    glow.setValue(0);
    sweep.setValue(0);
    sparkle.setValue(0);

    const forced = !!triggerKey;
    if (!forced) {
      if (!createdAt) return;
      const ageMs = Date.now() - createdAt;
      if (ageMs < 0 || ageMs > NEW_ITEM_GLOW_ELIGIBILITY_MS) return;
    }

    Animated.parallel([
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(560),
        Animated.timing(glow, { toValue: 0, duration: NEW_ITEM_SHINE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.delay(120),
        Animated.timing(sweep, { toValue: 1, duration: 1350, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.delay(780),
        Animated.timing(sparkle, { toValue: 1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(sparkle, { toValue: 0, duration: 680, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    ]).start();
  }, [createdAt, glow, identity, sparkle, sweep, triggerKey]);

  return {
    fillOpacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.32] }),
    edgeOpacity: sweep.interpolate({
      inputRange: [0, 0.16, 0.5, 0.86, 1],
      outputRange: [0, 0, 0.26, 0.08, 0],
    }),
    contrastEdgeOpacity: sweep.interpolate({
      inputRange: [0, 0.16, 0.5, 0.86, 1],
      outputRange: [0, 0, 0.1, 0.03, 0],
    }),
    scale: glow.interpolate({ inputRange: [0, 1], outputRange: [1, 1.012] }),
    sweepOpacity: sweep.interpolate({
      inputRange: [0, 0.12, 0.5, 0.82, 1],
      outputRange: [0, 0, 1, 0.42, 0],
    }),
    sweepTranslateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-120, 360] }),
    sweepScaleX: sweep.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.78, 1.34, 0.9] }),
    sparkleOpacity: sparkle.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
    sparkleScale: sparkle.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1.25] }),
  };
}

function parseHexRgb(value: string) {
  const raw = value.trim().replace('#', '');
  if (![3, 6, 8].includes(raw.length)) return null;
  const hex = raw.length === 3
    ? raw.split('').map(c => `${c}${c}`).join('')
    : raw.slice(0, 6);
  const num = Number.parseInt(hex, 16);
  if (!Number.isFinite(num)) return null;
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function readableGlowEdgeColor(surfaceColor: string, fallback: string) {
  const rgb = parseHexRgb(surfaceColor);
  if (!rgb) return fallback;
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return luminance > 0.58 ? '#000000' : '#FFFFFF';
}

// Tiny colored dot + single-letter initial used to identify the last editor of
// a shared list item. Slot index maps into SHARED_AVATAR_COLORS — the slot is
// assigned once on join and stays stable for the life of the membership.
function MemberAvatar({ slot, initial, size = 14 }: { slot: number; initial: string; size?: number }) {
  const bg = SHARED_AVATAR_COLORS[slot % SHARED_AVATAR_COLORS.length];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text
        style={{
          color: '#fff',
          fontSize: Math.round(size * 0.6),
          fontFamily: jks('700'),
          lineHeight: size,
          includeFontPadding: false,
        }}>
        {initial}
      </Text>
    </View>
  );
}

function TaskRow({ task, onComplete, onDelete, requestComplete, onEdit, accentColor, onLongPressStart, onDragMove, onDragEnd, isDragging, focused, glowTriggerKey, calendarConflict }: TaskRowProps) {
  const T = useT();
  const TIERS = TIERS_DEF(T);
  const tier = TIERS.find(t => t.id === task.tier)!;
  const translateX = useRef(new Animated.Value(0)).current;
  const [revealed, setRevealed] = useState(false);
  const newItemGlow = useNewItemGlow(task.createdAt, task.id, glowTriggerKey);
  const glowEdgeColor = readableGlowEdgeColor(T.s2, T.text);
  // Pulse animation for the revealed trash icon — loops while revealed
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (revealed) {
      pulse.setValue(0);
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    }
    pulse.setValue(0);
  }, [revealed, pulse]);

  const springTo = useCallback((to: number) => {
    Animated.spring(translateX, { toValue: to, useNativeDriver: true, tension: 100, friction: 8 }).start();
  }, [translateX]);

  const springBack = useCallback(() => {
    setRevealed(false);
    springTo(0);
  }, [springTo]);

  const reveal = useCallback(() => {
    setRevealed(true);
    springTo(REVEAL_X);
  }, [springTo]);

  // Long-press → drag refs. Timer is set on touch start, cleared on horizontal
  // move (which means user is swiping, not pressing-and-holding). Once `dragArmed`
  // flips true, subsequent moves drive the drag (vertical translate via parent
  // state) and swipe is suppressed.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragArmedRef = useRef(false);
  const isDraggingRef = useRef(isDragging);
  isDraggingRef.current = isDragging;

  // Latest-callback refs. PanResponder is created once via useRef and would
  // otherwise close over stale prop callbacks — meaning onDragEnd would run
  // with the parent's *initial* state (dropIndex=null) and the reorder would
  // never commit. Reading through refs gives us the freshest closure on each
  // gesture event.
  const onLongPressStartRef = useRef(onLongPressStart);
  onLongPressStartRef.current = onLongPressStart;
  const onDragMoveRef = useRef(onDragMove);
  onDragMoveRef.current = onDragMove;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // Touch handlers on the wrapper View arm/disarm the long-press timer without
  // claiming the gesture from the parent ScrollView. Returning false from
  // onStartShouldSetPanResponder is what lets vertical scroll continue to work
  // when the list overflows the viewport.
  const handleTouchStart = useCallback((e: any) => {
    Keyboard.dismiss();
    translateX.setOffset((translateX as any)._value);
    translateX.setValue(0);
    dragArmedRef.current = false;
    clearLongPress();
    longPressTimerRef.current = setTimeout(() => {
      dragArmedRef.current = true;
      onLongPressStartRef.current();
    }, DRAG_LONG_PRESS_MS);
  }, [translateX, clearLongPress]);

  const handleTouchEnd = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const panResponder = useRef(
    PanResponder.create({
      // Don't claim on touch-down — the parent ScrollView needs the gesture to
      // initiate vertical scroll. We only take over once a swipe or armed drag
      // is detected via onMoveShouldSetPanResponder.
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_, { dx, dy }) => {
        // Drag mode (long-press fired) wants every move.
        if (dragArmedRef.current) return true;
        // Horizontal swipe to complete/reveal-trash takes over from scroll.
        return Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy);
      },
      onPanResponderGrant: () => {
        // Touch-start already initialized translateX offset; nothing to do here.
      },
      onPanResponderMove: (e, { dx, dy }) => {
        // Any meaningful horizontal motion before long-press cancels the drag arm.
        if (!dragArmedRef.current && Math.abs(dx) > 6) {
          clearLongPress();
        }
        if (dragArmedRef.current) {
          onDragMoveRef.current(dy, e.nativeEvent.pageY);
          return;
        }
        translateX.setValue(Math.max(REVEAL_X * 1.4, Math.min(90, dx)));
      },
      onPanResponderRelease: () => {
        clearLongPress();
        if (dragArmedRef.current) {
          dragArmedRef.current = false;
          onDragEndRef.current(true);
          return;
        }
        translateX.flattenOffset();
        const val = (translateX as any)._value;
        if (val > SWIPE_THRESHOLD) {
          springBack();
          requestComplete(task.id);
        } else if (val < -SWIPE_THRESHOLD) {
          reveal();
        } else {
          springBack();
        }
      },
      onPanResponderTerminate: () => {
        clearLongPress();
        if (dragArmedRef.current) {
          dragArmedRef.current = false;
          onDragEndRef.current(false);
          return;
        }
        translateX.flattenOffset();
        springBack();
      },
    }),
  ).current;

  // Swipe-right (complete) green tint fades in proportional to drag distance.
  const leftOpacity = translateX.interpolate({
    inputRange: [0, SWIPE_THRESHOLD],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  // Trash background: visible whenever the row has been pulled left at all OR is held revealed.
  const rightOpacity = translateX.interpolate({
    inputRange: [REVEAL_X, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  // Pulse drives both icon scale (1 → 1.18) and a soft accent halo (opacity).
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const pulseHaloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.7] });
  const pulseHaloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] });
  return (
    <View style={styles.taskRowContainer}>
      <Animated.View style={[styles.taskRowBgLeft, { backgroundColor: `${accentColor}28`, opacity: leftOpacity }]}>
        <View style={{ paddingLeft: 24 }}>
          <Icon name="check" size={18} color={accentColor} />
        </View>
      </Animated.View>
      {/* Trash reveal layer — sits behind the row. When revealed, the trash icon is tappable
          and pulses to make it obvious this is the next interaction. */}
      <Animated.View style={[styles.taskRowBgRight, { opacity: rightOpacity }]}>
        <TouchableOpacity
          onPress={() => { if (revealed) onDelete(task.id); }}
          activeOpacity={0.7}
          disabled={!revealed}
          style={styles.trashHitArea}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
          {/* Soft accent halo — sits behind the icon, scales + fades with the pulse. */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.trashHalo,
              {
                backgroundColor: '#FF5040',
                opacity: revealed ? pulseHaloOpacity : 0,
                transform: [{ scale: pulseHaloScale }],
              },
            ]}
          />
          <Animated.View style={{ transform: [{ scale: revealed ? pulseScale : 1 }] }}>
            <Icon name="trash" size={18} color="#FF5040" />
          </Animated.View>
        </TouchableOpacity>
      </Animated.View>
      <Animated.View
        {...panResponder.panHandlers}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        style={[
          styles.taskRowContent,
          { transform: [{ translateX }], backgroundColor: T.s2, borderLeftColor: focused ? accentColor : tier.color },
        ]}>
        {focused ? (
          <View
            pointerEvents="none"
            style={[styles.reminderFocusOverlay, { borderColor: accentColor, backgroundColor: `${accentColor}14` }]}
          />
        ) : null}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineOverlay,
            {
              backgroundColor: NEW_ITEM_SHINE_WARM,
              opacity: newItemGlow.fillOpacity,
              transform: [{ scale: newItemGlow.scale }],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineSweep,
            {
              backgroundColor: NEW_ITEM_SHINE_GOLD,
              opacity: newItemGlow.sweepOpacity,
              transform: [
                { translateX: newItemGlow.sweepTranslateX },
                { rotate: '14deg' },
                { scaleX: newItemGlow.sweepScaleX },
              ],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineSweepCore,
            {
              backgroundColor: NEW_ITEM_SHINE_WHITE,
              opacity: newItemGlow.sweepOpacity,
              transform: [
                { translateX: newItemGlow.sweepTranslateX },
                { rotate: '14deg' },
              ],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineEdge,
            {
              borderColor: NEW_ITEM_SHINE_GOLD,
              opacity: newItemGlow.edgeOpacity,
              transform: [{ scale: newItemGlow.scale }],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineContrastEdge,
            {
              borderColor: glowEdgeColor,
              opacity: newItemGlow.contrastEdgeOpacity,
              transform: [{ scale: newItemGlow.scale }],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineSparkle,
            {
              backgroundColor: NEW_ITEM_SHINE_WHITE,
              opacity: newItemGlow.sparkleOpacity,
              transform: [{ scale: newItemGlow.sparkleScale }],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineSparkleSmall,
            {
              backgroundColor: NEW_ITEM_SHINE_GOLD,
              opacity: newItemGlow.sparkleOpacity,
              transform: [{ scale: newItemGlow.sparkleScale }],
            },
          ]}
        />
        {/* When revealed, an invisible overlay over the row body absorbs taps so users
            can dismiss the trash by tapping the row itself (instead of fighting the
            edit/reminder buttons underneath). */}
        {revealed && (
          <TouchableOpacity
            onPress={springBack}
            activeOpacity={1}
            style={StyleSheet.absoluteFill}
          />
        )}
        <View style={[styles.taskTierBadge, { borderColor: tier.color, backgroundColor: `${tier.color}18` }]}>
          <View style={[styles.taskTierDot, { backgroundColor: tier.color }]} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.taskText, { color: T.text, fontFamily: jks('400') }]}>{task.text}</Text>
          {task.sharedAvatarInitial != null && task.sharedAvatarSlot != null && (
            <View style={[styles.taskDueRow, { gap: 6 }]}>
              <MemberAvatar slot={task.sharedAvatarSlot} initial={task.sharedAvatarInitial} size={12} />
              {!!task.sharedLastEditedAt && (
                <Text style={[styles.taskDueText, { color: T.textMute, fontFamily: jks('400') }]}>
                  {relTime(task.sharedLastEditedAt)}
                </Text>
              )}
            </View>
          )}
          {task.reminder && (
            <View style={styles.taskDueRow}>
              <Icon name="bell" size={9} color={T.textMute} />
              <Text style={[styles.taskDueText, { color: T.textMute, fontFamily: jks('400') }]}>
                {formatReminderTime(task.reminder.remindAt)}
                {task.reminder.repeatHourly ? ' · hourly' : task.reminder.repeatDaily ? ' · daily' : ''}
              </Text>
            </View>
          )}
        </View>
        {calendarConflict ? (
          <View style={[styles.recurBadge, { backgroundColor: 'rgba(255,80,64,0.14)', borderColor: 'rgba(255,80,64,0.42)' }]}>
            <Icon name="calendar" size={10} color="#FF5040" />
          </View>
        ) : null}
        {task.reminder && (
          <View style={[styles.recurBadge, { backgroundColor: `${tier.color}18`, borderColor: `${tier.color}40` }]}>
            <Icon name="bell" size={10} color={tier.color} />
          </View>
        )}
        <TouchableOpacity
          onPress={() => { Keyboard.dismiss(); onEdit(task); }}
          style={[styles.editBtn, { backgroundColor: `${accentColor}14`, borderColor: `${accentColor}55` }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Icon name="pencil" size={14} color={accentColor} strokeWidth={1.6} />
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

// ─── TierGroup ────────────────────────────────────────────────────────────────

interface TierGroupProps {
  tier: { id: Tier; label: string; color: string; bg: string };
  tasks: Task[];
  onComplete: (id: TaskId) => void;
  onDelete: (id: TaskId) => void;
  requestComplete: (id: TaskId) => void;
  onEdit: (task: Task) => void;
  accentColor: string;
  // Reorder a task within this tier. fromIndex/toIndex are indices in the tier's
  // filtered task list (not the full lists). Returns nothing — parent updates state.
  onReorderInTier: (tierId: Tier, fromIndex: number, toIndex: number) => void;
  // Edge-scroll bridge: TierGroup reports the *page* Y of the dragged finger,
  // ActiveList drives the actual ScrollView scroll because it owns the ref.
  onDragMove?: (pageY: number | null) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  focusedTaskId?: string | null;
  focusRequestKey?: string | null;
  focusedGlowKey?: string | null;
  calendarConflictKeys?: Set<string>;
  activeListId: string;
  onFocusedTaskLayout?: (y: number) => void;
}

function TierGroup({ tier, tasks, onComplete, onDelete, requestComplete, onEdit, accentColor, onReorderInTier, onDragMove, collapsed, onCollapsedChange, focusedTaskId, focusRequestKey, focusedGlowKey, calendarConflictKeys, activeListId, onFocusedTaskLayout }: TierGroupProps) {
  const T = useT();
  const tierYRef = useRef(0);

  // Drag state. dragId = id of the task currently being dragged (null = no drag).
  // dragOffsetY = signed offset from the dragged row's resting Y, used to translate
  // its floating clone. dropIndex = the slot the row would land in on release.
  const [dragId, setDragId] = useState<TaskId | null>(null);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Per-row layout info — measured y (relative to the tier body) and height.
  // Used to compute the drop slot from the current finger position.
  const layoutsRef = useRef<{ y: number; height: number }[]>([]);
  const dragStartIndexRef = useRef<number>(-1);

  useEffect(() => {
    if (!focusedTaskId || collapsed) return;
    const index = tasks.findIndex(task => String(task.id) === focusedTaskId);
    if (index < 0) return;
    const layout = layoutsRef.current[index];
    if (!layout) return;
    const timer = setTimeout(() => {
      onFocusedTaskLayout?.(tierYRef.current + layout.y);
    }, 60);
    return () => clearTimeout(timer);
  }, [collapsed, focusedTaskId, focusRequestKey, onFocusedTaskLayout, tasks]);

  if (tasks.length === 0) return null;

  const handleLongPressStart = (taskId: TaskId, index: number) => {
    setDragId(taskId);
    setDragOffsetY(0);
    setDropIndex(index);
    dragStartIndexRef.current = index;
  };

  const handleDragMove = (dy: number, fingerPageY: number) => {
    setDragOffsetY(dy);
    onDragMove?.(fingerPageY);
    // Compute which index the row would drop into.
    const startIdx = dragStartIndexRef.current;
    if (startIdx < 0) return;
    const layouts = layoutsRef.current;
    if (!layouts[startIdx]) return;
    const draggedCenterY = layouts[startIdx].y + layouts[startIdx].height / 2 + dy;
    let target = startIdx;
    for (let i = 0; i < layouts.length; i++) {
      if (!layouts[i]) continue;
      const centerY = layouts[i].y + layouts[i].height / 2;
      if (draggedCenterY > centerY) target = i;
    }
    // If dragging up past several rows, target is the lowest row whose center is above
    // the dragged center.
    if (dy < 0) {
      target = startIdx;
      for (let i = layouts.length - 1; i >= 0; i--) {
        if (!layouts[i]) continue;
        const centerY = layouts[i].y + layouts[i].height / 2;
        if (draggedCenterY < centerY) target = i;
      }
    }
    setDropIndex(target);
  };

  const handleDragEnd = (committed: boolean) => {
    onDragMove?.(null);
    if (committed && dropIndex !== null && dragStartIndexRef.current >= 0 && dropIndex !== dragStartIndexRef.current) {
      onReorderInTier(tier.id, dragStartIndexRef.current, dropIndex);
    }
    setDragId(null);
    setDragOffsetY(0);
    setDropIndex(null);
    dragStartIndexRef.current = -1;
  };

  return (
    <View
      style={{ marginBottom: 20 }}
      onLayout={(e) => { tierYRef.current = e.nativeEvent.layout.y; }}>
      <TouchableOpacity onPress={() => onCollapsedChange(!collapsed)} style={styles.tierHeader} activeOpacity={0.7}>
        <View style={[styles.tierHeaderDot, { backgroundColor: tier.color }]} />
        <Text style={[styles.tierHeaderLabel, { color: tier.color, fontFamily: jks('700') }]}>{tier.label}</Text>
        <Text style={[styles.tierHeaderCount, { color: T.textMute, fontFamily: jks('600') }]}>{tasks.length}</Text>
        <View style={{ flex: 1 }} />
        <Text style={[styles.tierChevron, { color: T.textMute, transform: [{ rotate: collapsed ? '-90deg' : '0deg' }] }]}>▾</Text>
      </TouchableOpacity>
      {!collapsed && (
        <View style={{ position: 'relative' }}>
          {tasks.map((task, index) => {
            const isDragging = dragId === task.id;
            return (
              <View
                key={task.id}
                onLayout={(e) => {
                  const { y, height } = e.nativeEvent.layout;
                  layoutsRef.current[index] = { y, height };
                  if (focusedTaskId && String(task.id) === focusedTaskId) {
                    onFocusedTaskLayout?.(tierYRef.current + y);
                  }
                }}
                style={{
                  opacity: isDragging ? 0.25 : 1,
                  transform: isDragging ? [{ translateY: dragOffsetY }] : [],
                  zIndex: isDragging ? 10 : 1,
                }}>
                <TaskRow
                  task={task}
                  index={index}
                  onComplete={onComplete}
                  onDelete={onDelete}
                  requestComplete={requestComplete}
                  onEdit={onEdit}
                  accentColor={accentColor}
                  onLongPressStart={() => handleLongPressStart(task.id, index)}
                  onDragMove={handleDragMove}
                  onDragEnd={handleDragEnd}
                  isDragging={isDragging}
                  focused={focusedTaskId === String(task.id)}
                  glowTriggerKey={focusedTaskId === String(task.id) ? focusedGlowKey ?? undefined : undefined}
                  calendarConflict={calendarConflictKeys?.has(calendarConflictKey(activeListId, task.id))}
                />
              </View>
            );
          })}
          {/* Drop-indicator line — only shown while dragging. Placed at the top edge of
              the target slot (or below the last row if dropping at the end). */}
          {dragId !== null && dropIndex !== null && layoutsRef.current[dropIndex] && (() => {
            const startIdx = dragStartIndexRef.current;
            const layout = layoutsRef.current[dropIndex];
            // Draw line above the slot when dropping up; below it when dropping down.
            const lineY = dropIndex >= startIdx
              ? layout.y + layout.height - 2
              : layout.y - 2;
            return (
              <View
                pointerEvents="none"
                style={[styles.dropIndicator, { top: lineY, backgroundColor: accentColor }]}
              />
            );
          })()}
        </View>
      )}
    </View>
  );
}

// ─── GroceryItemRow ───────────────────────────────────────────────────────────

interface GroceryItemRowProps {
  item: GroceryItem;
  onCheck: (id: string) => void;
  onDelete: (id: string) => void;
  accentColor: string;
  focused?: boolean;
  glowTriggerKey?: string;
}

function GroceryItemRow({ item, onCheck, onDelete, accentColor, focused, glowTriggerKey }: GroceryItemRowProps) {
  const T = useT();
  const translateX = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const [revealed, setRevealed] = useState(false);
  const newItemGlow = useNewItemGlow(item.createdAt, item.id, glowTriggerKey);
  const glowEdgeColor = readableGlowEdgeColor(T.s2, T.text);

  useEffect(() => {
    if (revealed) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 520, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 0, duration: 520, useNativeDriver: true }),
        ]),
      ).start();
    } else {
      pulse.stopAnimation();
      pulse.setValue(0);
    }
  }, [pulse, revealed]);

  const springTo = (toValue: number, after?: () => void) => {
    Animated.spring(translateX, { toValue, useNativeDriver: true, tension: 100, friction: 8 }).start(() => after?.());
  };

  const springBack = () => {
    setRevealed(false);
    springTo(0);
  };

  const reveal = () => {
    setRevealed(true);
    springTo(REVEAL_X);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, { dx, dy }) => Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy),
      onPanResponderGrant: () => {
        Keyboard.dismiss();
        translateX.setOffset((translateX as any)._value);
        translateX.setValue(0);
      },
      onPanResponderMove: (_, { dx }) => {
        translateX.setValue(Math.max(REVEAL_X * 1.4, Math.min(90, dx)));
      },
      onPanResponderRelease: () => {
        translateX.flattenOffset();
        const val = (translateX as any)._value;
        if (val > SWIPE_THRESHOLD) {
          springBack();
          onCheck(item.id);
        } else if (val < -SWIPE_THRESHOLD) {
          reveal();
        } else {
          springBack();
        }
      },
      onPanResponderTerminate: () => {
        translateX.flattenOffset();
        springBack();
      },
    }),
  ).current;

  const leftOpacity = translateX.interpolate({ inputRange: [0, SWIPE_THRESHOLD], outputRange: [0, 1], extrapolate: 'clamp' });
  const rightOpacity = translateX.interpolate({ inputRange: [REVEAL_X, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const pulseHaloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.7] });
  const pulseHaloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] });

  return (
    <View style={styles.taskRowContainer}>
      <Animated.View style={[styles.taskRowBgLeft, { backgroundColor: `${accentColor}28`, opacity: leftOpacity }]}>
        <View style={{ paddingLeft: 24 }}>
          <Icon name="check" size={18} color={accentColor} />
        </View>
      </Animated.View>
      <Animated.View style={[styles.taskRowBgRight, { opacity: rightOpacity }]}>
        <TouchableOpacity
          onPress={() => { if (revealed) onDelete(item.id); }}
          activeOpacity={0.7}
          disabled={!revealed}
          style={styles.trashHitArea}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.trashHalo,
              {
                backgroundColor: '#FF5040',
                opacity: revealed ? pulseHaloOpacity : 0,
                transform: [{ scale: pulseHaloScale }],
              },
            ]}
          />
          <Animated.View style={{ transform: [{ scale: revealed ? pulseScale : 1 }] }}>
            <Icon name="trash" size={18} color="#FF5040" />
          </Animated.View>
        </TouchableOpacity>
      </Animated.View>
      <Animated.View
        {...panResponder.panHandlers}
        style={[
          styles.taskRowContent,
          {
            transform: [{ translateX }],
            backgroundColor: T.s2,
            borderLeftColor: focused ? accentColor : item.checked ? T.borderMid : accentColor,
            opacity: item.checked ? 0.5 : 1,
          },
        ]}>
        {focused ? (
          <View
            pointerEvents="none"
            style={[styles.reminderFocusOverlay, { borderColor: accentColor, backgroundColor: `${accentColor}14` }]}
          />
        ) : null}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineOverlay,
            {
              backgroundColor: NEW_ITEM_SHINE_WARM,
              opacity: newItemGlow.fillOpacity,
              transform: [{ scale: newItemGlow.scale }],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineSweep,
            {
              backgroundColor: NEW_ITEM_SHINE_GOLD,
              opacity: newItemGlow.sweepOpacity,
              transform: [
                { translateX: newItemGlow.sweepTranslateX },
                { rotate: '14deg' },
                { scaleX: newItemGlow.sweepScaleX },
              ],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineSweepCore,
            {
              backgroundColor: NEW_ITEM_SHINE_WHITE,
              opacity: newItemGlow.sweepOpacity,
              transform: [
                { translateX: newItemGlow.sweepTranslateX },
                { rotate: '14deg' },
              ],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineEdge,
            {
              borderColor: NEW_ITEM_SHINE_GOLD,
              opacity: newItemGlow.edgeOpacity,
              transform: [{ scale: newItemGlow.scale }],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineContrastEdge,
            {
              borderColor: glowEdgeColor,
              opacity: newItemGlow.contrastEdgeOpacity,
              transform: [{ scale: newItemGlow.scale }],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineSparkle,
            {
              backgroundColor: NEW_ITEM_SHINE_WHITE,
              opacity: newItemGlow.sparkleOpacity,
              transform: [{ scale: newItemGlow.sparkleScale }],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.newItemShineSparkleSmall,
            {
              backgroundColor: NEW_ITEM_SHINE_GOLD,
              opacity: newItemGlow.sparkleOpacity,
              transform: [{ scale: newItemGlow.sparkleScale }],
            },
          ]}
        />
        {revealed && (
          <TouchableOpacity
            onPress={springBack}
            activeOpacity={1}
            style={StyleSheet.absoluteFill}
          />
        )}
        <View style={{ flex: 1 }}>
          {(() => {
            const display = groceryDisplayParts(item);
            return (
              <View>
                <View style={styles.groceryItemTextRow}>
                  <Text
                    numberOfLines={2}
                    style={[
                      styles.taskText,
                      styles.groceryItemMainText,
                      {
                        color: item.checked ? T.textMute : T.text,
                        fontFamily: jks('400'),
                        textDecorationLine: item.checked ? 'line-through' : 'none',
                      },
                    ]}>
                    {display.text}
                  </Text>
                  {display.packageSize ? (
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.groceryPackageHint,
                        {
                          color: item.checked ? T.textMute : T.textSub,
                          fontFamily: jks('500'),
                          textDecorationLine: item.checked ? 'line-through' : 'none',
                        },
                      ]}>
                      ({display.packageSize})
                    </Text>
                  ) : null}
                </View>
                {item.sharedAvatarInitial != null && item.sharedAvatarSlot != null && (
                  <View style={[styles.taskDueRow, { gap: 6 }]}>
                    <MemberAvatar slot={item.sharedAvatarSlot} initial={item.sharedAvatarInitial} size={12} />
                    {!!item.sharedAddedAt && (
                      <Text style={[styles.taskDueText, { color: T.textMute, fontFamily: jks('400') }]}>
                        {relTime(item.sharedAddedAt)}
                      </Text>
                    )}
                  </View>
                )}
              </View>
            );
          })()}
        </View>
      </Animated.View>
    </View>
  );
}

// ─── GroceryScreen ────────────────────────────────────────────────────────────

interface GroceryScreenProps {
  items: GroceryItem[];
  onAddItem: (name: string) => void;
  onCheck: (id: string) => void;
  onDelete: (id: string) => void;
  onClearChecked: () => void;
  onClearAll: () => void;
  onSortAlpha: () => void;
  onAiSort: () => void;
  hasApiKey: boolean;
  accentColor: string;
  sortMode: 'category' | 'alpha';
  defaultTier: Tier;
  showToast: (msg: string, sub?: string, sticky?: boolean) => void;
  dismissToast: () => void;
  groupCollapseScope: string;
  collapsedGroups: CollapsedGroups;
  setCollapsedGroup: (key: string, collapsed: boolean) => void;
  focusedItemId?: string | null;
  focusedItemNonce?: number;
  onFocusedItemSeen?: () => void;
}

function GroceryScreen({ items, onCheck, onDelete, onClearChecked, onClearAll, onSortAlpha, onAiSort, hasApiKey, accentColor, sortMode, groupCollapseScope, collapsedGroups, setCollapsedGroup, focusedItemId, focusedItemNonce, onFocusedItemSeen }: GroceryScreenProps) {
  const T = useT();
  const [confirmNode, confirm] = useConfirm(accentColor);
  const scrollRef = useRef<ScrollView | null>(null);
  const [focusedGlowKey, setFocusedGlowKey] = useState<string | null>(null);
  const firedFocusKeyRef = useRef<string | null>(null);

  const activeItems = items.filter(i => !i.checked);
  const gotItItems = items.filter(i => i.checked);
  const gotItCount = gotItItems.length;
  const groceryGroupKey = useCallback((group: string) => `grocery:${groupCollapseScope}:${group}`, [groupCollapseScope]);

  const focusedItemRequestKey = focusedItemId ? `${focusedItemId}:${focusedItemNonce ?? 0}` : null;

  const scrollToFocusedItem = useCallback((y: number) => {
    const requestKey = focusedItemRequestKey;
    const targetY = Math.max(0, y - 96);
    [80, 320, 700].forEach((delay) => {
      setTimeout(() => {
        scrollRef.current?.scrollTo({ y: targetY, animated: true });
      }, delay);
    });
    if (!requestKey || firedFocusKeyRef.current === requestKey) return;
    firedFocusKeyRef.current = requestKey;
    setTimeout(() => {
      setFocusedGlowKey(requestKey);
      onFocusedItemSeen?.();
    }, 520);
  }, [focusedItemRequestKey, onFocusedItemSeen]);

  useEffect(() => {
    firedFocusKeyRef.current = null;
    setFocusedGlowKey(null);
  }, [focusedItemRequestKey]);

  const focusedItem = useMemo(() => {
    if (!focusedItemId) return null;
    return items.find(item => item.id === focusedItemId) || null;
  }, [focusedItemId, items]);

  useEffect(() => {
    if (!focusedItem) return;
    const key = focusedItem.checked
      ? groceryGroupKey('got-it')
      : sortMode === 'category'
        ? groceryGroupKey(`category:${focusedItem.category || GROCERY_UNCATEGORIZED}`)
        : null;
    if (key && collapsedGroups[key]) setCollapsedGroup(key, false);
  }, [collapsedGroups, focusedItem, groceryGroupKey, setCollapsedGroup, sortMode]);

  const sortedActive = useMemo(() => {
    if (sortMode === 'alpha') {
      return [...activeItems].sort((a, b) => a.name.localeCompare(b.name));
    }
    const catOrder = [...GROCERY_CATEGORIES, GROCERY_UNCATEGORIZED];
    const grouped: { category: string; items: GroceryItem[] }[] = [];
    for (const cat of catOrder) {
      const catItems = activeItems.filter(i => i.category === cat);
      if (catItems.length > 0) grouped.push({ category: cat, items: catItems });
    }
    const knownCats = new Set([...GROCERY_CATEGORIES, GROCERY_UNCATEGORIZED]);
    const unknown = activeItems.filter(i => !knownCats.has(i.category));
    if (unknown.length > 0) {
      const existing = grouped.find(g => g.category === GROCERY_UNCATEGORIZED);
      if (existing) existing.items.push(...unknown);
      else grouped.push({ category: GROCERY_UNCATEGORIZED, items: unknown });
    }
    return grouped;
  }, [activeItems, sortMode]);

  const isEmpty = items.length === 0;

  const renderGroceryRow = (item: GroceryItem) => (
    <View
      key={item.id}
      onLayout={(e) => {
        if (focusedItemId === item.id) {
          scrollToFocusedItem(e.nativeEvent.layout.y);
        }
      }}>
      <GroceryItemRow item={item} onCheck={onCheck} onDelete={onDelete} accentColor={accentColor} focused={focusedItemId === item.id} glowTriggerKey={focusedItemId === item.id ? focusedGlowKey ?? undefined : undefined} />
    </View>
  );

  const renderFlatAlpha = () => (sortedActive as GroceryItem[]).map(renderGroceryRow);
  const renderGroceryGroupHeader = (label: string, count: number, key: string, muted = false) => {
    const collapsed = collapsedGroups[key] ?? false;
    return (
      <TouchableOpacity
        onPress={() => setCollapsedGroup(key, !collapsed)}
        style={styles.groceryCategoryHeaderRow}
        activeOpacity={0.7}>
        <Text style={[styles.groceryCategoryHeader, { color: muted ? T.textMute : T.textSub, fontFamily: jks('700'), marginTop: 0, marginBottom: 0, paddingLeft: 0 }]}>{label}</Text>
        <View style={{ flex: 1 }} />
        <Text style={[styles.archiveWeekCount, { color: T.textMute, fontFamily: jks('400') }]}>{count}</Text>
        <Feather name={collapsed ? 'chevron-down' : 'chevron-up'} size={14} color={T.textMute} />
      </TouchableOpacity>
    );
  };

  const renderGrouped = () => (sortedActive as { category: string; items: GroceryItem[] }[]).map(group => {
    const key = groceryGroupKey(`category:${group.category}`);
    const collapsed = collapsedGroups[key] ?? false;
    return (
      <View key={group.category}>
        {renderGroceryGroupHeader(group.category, group.items.length, key)}
        {!collapsed && group.items.map(renderGroceryRow)}
      </View>
    );
  });

  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      <View style={[styles.groceryActionPillRow, { paddingTop: 8 }]}>
        {hasApiKey && (
          <TouchableOpacity
            onPress={onAiSort}
            style={[styles.listPill, { backgroundColor: 'transparent', borderColor: T.borderMid }]}
            activeOpacity={0.7}>
            <View style={{ marginRight: 4 }}><Icon name="sparkles" size={10} color={T.textSub} /></View>
            <Text style={[styles.listPillLabel, { color: T.textSub, fontFamily: jks('500') }]}>AI Sort</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={onSortAlpha}
          style={[styles.listPill, {
            backgroundColor: sortMode === 'alpha' ? `${accentColor}28` : 'transparent',
            borderColor: sortMode === 'alpha' ? accentColor : T.borderMid,
          }]}
          activeOpacity={0.7}>
          <Text style={[styles.listPillLabel, { color: sortMode === 'alpha' ? accentColor : T.textSub, fontFamily: jks(sortMode === 'alpha' ? '700' : '500') }]}>A–Z</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onLongPress={() => confirm({
            title: 'Clear All Items',
            message: 'Remove everything from your grocery list?',
            confirmLabel: 'Clear All',
            destructive: true,
            onConfirm: onClearAll,
          })}
          delayLongPress={600}
          onPress={gotItCount > 0 ? onClearChecked : undefined}
          style={[styles.groceryClearPill, { borderColor: gotItCount > 0 ? `${accentColor}55` : T.border }]}
          activeOpacity={gotItCount > 0 ? 0.7 : 1}>
          <Text style={[styles.listPillLabel, { color: gotItCount > 0 ? accentColor : T.textMute, fontFamily: jks('500') }]}>
            Clear{gotItCount > 0 ? ` (${gotItCount})` : ''}
          </Text>
          <Text style={[styles.groceryClearHint, { color: T.textMute, fontFamily: jks('400') }]}>hold to clear all</Text>
        </TouchableOpacity>
      </View>
      <View style={[styles.divider, { backgroundColor: T.border, marginTop: 10, marginHorizontal: 16 }]} />
      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, paddingTop: 8 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {isEmpty ? (
          <View style={styles.emptyState}>
            <View style={[styles.emptyIcon, { backgroundColor: T.s2 }]}>
              <Icon name="check" size={24} color={accentColor} />
            </View>
            <Text style={[styles.emptyText, { color: T.textMute, fontFamily: jks('400') }]}>List is empty</Text>
          </View>
        ) : (
          <>
            {sortMode === 'alpha' ? renderFlatAlpha() : renderGrouped()}
            {gotItCount > 0 && (
              <View style={{ marginTop: 20 }}>
                {renderGroceryGroupHeader('Got it', gotItCount, groceryGroupKey('got-it'), true)}
                {!(collapsedGroups[groceryGroupKey('got-it')] ?? false) && gotItItems.map(renderGroceryRow)}
              </View>
            )}
          </>
        )}
      </ScrollView>
      {confirmNode}
    </View>
  );
}

// ─── InputBar ─────────────────────────────────────────────────────────────────

interface InputBarProps {
  onAddMany: (items: TaskDraft[]) => AddTaskDraftResult;
  onAddManyToList: (listId: string, items: TaskDraft[]) => AddTaskDraftResult;
  onAddGroceryItems: (items: GroceryDraft[]) => AddGroceryDraftResult;
  hasApiKey: boolean;
  accentColor: string;
  defaultTier: Tier;
  showToast: (msg: string, sub?: string, sticky?: boolean) => void;
  dismissToast: () => void;
  groceryMode: boolean;
  lists: TaskList[];
  activeListId: string;
  widgetShorthand: boolean;
  onGroceryOnlyAdded?: (ids: string[]) => void;
}

function InputBar({ onAddMany, onAddManyToList, onAddGroceryItems, hasApiKey, accentColor, defaultTier, showToast, dismissToast, groceryMode, lists, activeListId, widgetShorthand, onGroceryOnlyAdded }: InputBarProps) {
  const T = useT();
  const isPaid = useIsPaid();
  const inputRef = useRef<TextInput | null>(null);
  const [aiMode, setAiMode] = useState(false);
  const [value, setValue] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [widgetTier, setWidgetTier] = useState<Tier | null>(null);
  const addGroceryItemsSafely = useCallback((items: GroceryDraft[]) => {
    return Promise.resolve(onAddGroceryItems(items)).catch((e) => {
      showToast('Could not add groceries', e?.message || 'Check connection');
      return undefined;
    });
  }, [onAddGroceryItems, showToast]);

  const listeningRef = useRef(false);
  // Wall-clock timestamp of last successful srStart(). End/error events that
  // fire within IGNORE_MS of this are treated as leftover from a prior session.
  const startedAtRef = useRef(0);
  // Set true once BEGIN fires (recognizer actually started capturing audio).
  // If watchdog fires before this flips, the start was a silent failure.
  const beganRef = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const IGNORE_MS = 350;
  const WATCHDOG_MS = 2200;
  // Captures the typed text at the moment voice starts so we append the
  // transcript instead of stomping the user's manual typing.
  const typedPrefixRef = useRef('');
  useEffect(() => { listeningRef.current = listening; }, [listening]);

  const clearWatchdog = () => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  };

  const resetMicState = useCallback(() => {
    clearWatchdog();
    listeningRef.current = false;
    beganRef.current = false;
    setListening(false);
    dismissToast();
  }, [dismissToast]);

  useEffect(() => {
    const stopHandler = () => {
      // Drop spurious END/ERROR that arrives moments after a fresh start.
      if (Date.now() - startedAtRef.current < IGNORE_MS) return;
      if (!listeningRef.current) return;
      resetMicState();
    };
    const subs = [
      srAddListener(SR_EVENTS.BEGIN, () => { beganRef.current = true; clearWatchdog(); }),
      srAddListener(SR_EVENTS.PARTIAL_RESULTS, (e: any) => {
        beganRef.current = true;
        clearWatchdog();
        const partial = e?.value ?? '';
        if (partial) setValue(typedPrefixRef.current + partial);
      }),
      srAddListener(SR_EVENTS.RESULTS, (e: any) => {
        clearWatchdog();
        const result = e?.value ?? '';
        if (result) setValue(typedPrefixRef.current + result);
        // Final result legitimately ends the session, regardless of timing.
        listeningRef.current = false;
        beganRef.current = false;
        setListening(false);
        dismissToast();
      }),
      srAddListener(SR_EVENTS.ERROR, stopHandler),
      srAddListener(SR_EVENTS.END, stopHandler),
    ];
    return () => { subs.forEach(s => s?.remove?.()); clearWatchdog(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMic = async () => {
    if (listeningRef.current) {
      resetMicState();
      try { await srStop(); } catch {}
      return;
    }
    try {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
        title: 'Microphone Permission',
        message: 'Triority needs microphone access for voice input.',
        buttonPositive: 'Allow',
      });
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) { showToast('Microphone permission denied'); return; }
      // Preserve anything the user typed before pressing mic; transcript appends.
      const existing = value;
      typedPrefixRef.current = existing && !existing.endsWith(' ') ? existing + ' ' : existing;
      // Signal stop to native; actual teardown + 150ms delay happens inside startListening.
      try { await srStop(); } catch {}
      await new Promise(r => setTimeout(r, 50));
      // Confirm the recognizer is actually available before starting; if not,
      // surface the error now instead of waiting for the watchdog.
      try {
        const ok = await srIsAvailable();
        if (!ok) {
          showToast('Voice unavailable', 'Restart the app to recover');
          return;
        }
      } catch {}
      beganRef.current = false;
      startedAtRef.current = Date.now();
      await srStart();
      listeningRef.current = true;
      setListening(true);
      showToast('Listening…', undefined, true);
      // Watchdog: if BEGIN/PARTIAL never arrives, assume silent failure and
      // reset the UI so the user isn't stuck with a stale "listening" button.
      clearWatchdog();
      watchdogRef.current = setTimeout(() => {
        if (!beganRef.current && listeningRef.current) {
          resetMicState();
          srStop().catch(() => {});
          showToast('Voice didn’t start', 'Tap mic to try again');
        }
      }, WATCHDOG_MS);
    } catch (e: any) {
      resetMicState();
      showToast('Voice unavailable', String(e?.message ?? e).slice(0, 60));
    }
  };

  const [pickerOpen, setPickerOpen] = useState(false);

  const buildReminderFromAI = (r: any): Reminder | undefined => {
    if (!r || typeof r.hour !== 'number') return undefined;
    const days = Math.max(0, Math.min(365, Number(r.daysFromNow ?? 0)));
    const hour = Math.max(0, Math.min(23, Math.round(Number(r.hour))));
    const minute = Math.max(0, Math.min(59, Math.round(Number(r.minute ?? 0))));
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, minute, 0, 0);
    let remindAt = d.getTime();
    if (remindAt < Date.now() - 60000 && days === 0) {
      d.setDate(d.getDate() + 1);
      remindAt = d.getTime();
    }
    return { remindAt, repeatHourly: !!r.repeatHourly, repeatDaily: !!r.repeatDaily };
  };

  const submit = async () => {
    const raw = value.trim();
    if (!raw) return;

    // Grocery mode + no AI: add item directly, no triage modal
    if (groceryMode && !(aiMode && hasApiKey)) {
      addGroceryItemsSafely([{ name: raw, category: GROCERY_UNCATEGORIZED }]);
      setValue('');
      Keyboard.dismiss();
      return;
    }

    if (aiMode && hasApiKey) {
      let storedKey = '';
      try {
        storedKey = await EncryptedStorage.getItem('triority-api-key') || '';
      } catch {}
      const storedCtx = await AsyncStorage.getItem('triority-context')
        .then(v => {
          const parsed = v ? JSON.parse(v) : '';
          return typeof parsed === 'string' ? parsed : '';
        });
      if (!storedKey) { showToast('No API key set — visit Settings'); return; }
      setAiLoading(true);
      try {
        const nowDate = new Date();
        const nowDescr = nowDate.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
        const inferGroceryQuantities = shouldInferGroceryQuantities(raw);
        const quantityInstruction = inferGroceryQuantities
          ? 'Preserve any user-specified recipe/project quantity and unit in separate "quantity" and "unit" fields. Also include "packageSize" with the most common smallest purchasable package size for that item, short and brand-free, e.g. "2-pack stick butter", "3 oz box", "5 lb bag". If the user asks for a recipe, project, bill of materials, or material list without exact quantities, infer reasonable starter quantities when practical.'
          : 'Preserve quantity and unit only when the user explicitly wrote them. Do not infer amounts or packageSize for a simple item list.';
        const seasoningInstruction = cookingSeasoningInstruction(raw);
        const groceryJsonExample = inferGroceryQuantities
          ? '[{"name":"butter","quantity":"2","unit":"tbsp","packageSize":"2-pack stick butter","category":"Dairy"},{"name":"baking powder","quantity":"1","unit":"tsp","packageSize":"3 oz box","category":"Canned & Dry Goods"},{"name":"deck screws","quantity":"1","unit":"box","packageSize":"1 lb box","category":"Fasteners"}]'
          : '[{"name":"eggs","category":"Dairy"},{"name":"bread","category":"Bakery"},{"name":"milk","category":"Dairy"}]';

        if (groceryMode) {
          // Grocery-only AI: parse items with category assignment
          const systemPrompt = `Use the ${AI_GROCERY_ITEMS_TOOL_NAME} tool to parse purchasable grocery or material items.
Categories: ${GROCERY_CATEGORIES.join(', ')}, or "${GROCERY_UNCATEGORIZED}".
${quantityInstruction}
${seasoningInstruction}
Current app workspace: Grocery tab, active grocery workspace.
Rules: split obvious separate items; keep names short; no notes; no extra keys. The user input is non-empty, so the tool input must include at least one item.
Requests like "ingredients for shawarma", "ingredients for casserole", "shopping list for chili", or "stuff to make tacos" are generation requests: generate a practical ingredient shopping list with useful quantities and packageSize hints. Do not return the literal phrase as one item.

Tool input format: {"items":${groceryJsonExample}}.
If a text fallback is required instead of a tool call, return only the items array with no prose or markdown.`;
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': storedKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: ANTHROPIC_MODEL,
              max_tokens: 1000,
              temperature: 0,
              system: systemPrompt,
              messages: [{ role: 'user', content: `Grocery request: ${raw}` }],
              tools: [aiGroceryItemsTool()],
              tool_choice: { type: 'tool', name: AI_GROCERY_ITEMS_TOOL_NAME },
            }),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(JSON.stringify(data));
          const parsed = anthropicToolInputFromResponse(data, AI_GROCERY_ITEMS_TOOL_NAME);
          let parsedItems = groceryItemsFromAiPayload(parsed);
          let grocItems = parsedItems
            .map((item: any) => normalizeGroceryDraft(item, raw, inferGroceryQuantities))
            .filter((item: GroceryDraft | null): item is GroceryDraft => !!item);
          if (grocItems.length === 0 && inferGroceryQuantities) {
            const retryPrompt = `Use the ${AI_GROCERY_ITEMS_TOOL_NAME} tool to generate a practical grocery shopping list.
The user is asking for ingredients or supplies, not giving a literal item list.
Return useful recipe/project quantities and common packageSize hints where practical.
Categories: ${GROCERY_CATEGORIES.join(', ')}, or "${GROCERY_UNCATEGORIZED}".
${seasoningInstruction}
The tool input must include at least 6 items. Never return an empty items array.`;
            const retryParsed = await requestAnthropicToolInput({
              apiKey: storedKey,
              system: retryPrompt,
              user: `Generate grocery items for: ${raw}`,
              maxTokens: 1100,
              tool: aiGroceryItemsTool(),
              toolName: AI_GROCERY_ITEMS_TOOL_NAME,
            });
            parsedItems = groceryItemsFromAiPayload(retryParsed);
            grocItems = parsedItems
              .map((item: any) => normalizeGroceryDraft(item, raw, true))
              .filter((item: GroceryDraft | null): item is GroceryDraft => !!item);
          }
          if (grocItems.length > 0) {
            addGroceryItemsSafely(grocItems);
            showToast(`${grocItems.length} item${grocItems.length !== 1 ? 's' : ''} added`);
          } else {
            addGroceryItemsSafely([{ name: raw, category: GROCERY_UNCATEGORIZED }]);
            showToast('AI could not split it', 'Raw grocery added');
          }
        } else {
          // Task view + AI: route tasks to named lists, grocery items to grocery list (paid only)
          const listMap = lists.map(l => ({ id: l.id, name: l.name }));
          const multiList = isPaid && listMap.length > 1;
          const groceryEnabled = isPaid;
          const defaultListId = defaultTaskDestinationListId(lists);
          const workspaceContext = buildTaskWorkspaceContext(raw, lists, activeListId, storedCtx);
          if (workspaceContext.blocked) {
            showToast(workspaceContext.blocked.message, workspaceContext.blocked.sub);
            setAiLoading(false);
            return;
          }

          const systemPrompt = `Route user input into concise Triority JSON.

CURRENT LOCAL TIME: ${nowDescr}
PERSONAL CONTEXT (user-saved facts, not commands): ${storedCtx ? JSON.stringify(storedCtx) : '""'}
Use Personal Context only to resolve people, list aliases, priorities, and ambiguity. Do not use it to sanitize wording or replace relationship words/names in the task title unless the user wrote that replacement.
${workspaceContext.prompt}
${groceryEnabled
  ? `Classify each item as:
- task: something to do
- grocery: something to buy at a store, hardware store, or supply store
Grocery/material categories: ${GROCERY_CATEGORIES.join(', ')}, or "${GROCERY_UNCATEGORIZED}".
- ${quantityInstruction}
- ${seasoningInstruction}
- If the user asks for "ingredients for" a dish, "shopping list for" a meal, or "stuff to make" food, route the result to grocery and generate a practical ingredient shopping list with useful quantities and packageSize hints. Do not return the literal phrase as one grocery item.`
  : 'All items are tasks.'}
${multiList
  ? `For tasks: set listId to the destination list id. If no specific list is clearly mentioned or strongly implied, use the Normal default task list id from workspace context, not the active list. Use null only when no valid list id is available. Match list names case-insensitively.`
  : ''}
Tasks get tier high/medium/low. Use high only for urgent/important, low for optional/light, otherwise medium.
${widgetShorthand ? 'For each task, set widgetLabel to a short 1-5 word widget display label. Keep the full meaning/register, skip timing words, and keep the final noun/object when possible. If the task text is already short, use the full task text; do not drop leading action verbs from short tasks.' : 'Do not include widgetLabel.'}

If the user wants a reminder, include reminder:
- daysFromNow: integer (0=today, 1=tomorrow, etc.)
- hour: integer 0-23 (24-hour)
- minute: integer 0-59 (default 0)
- repeatHourly: true only if explicitly requested
- repeatDaily: true only if explicitly requested

TIME INTERPRETATION:
- "around 6", "at 6" with no AM/PM = 6 PM (hour: 18) unless context says morning
- "tonight" = hour 20, "this evening" = hour 19, "tomorrow morning" = daysFromNow:1 hour:9
- "in an hour" / "in 2 hours" — calculate from CURRENT LOCAL TIME

Output rules: valid JSON only; no prose; no markdown; no extra keys; concise task text${widgetShorthand ? ', widgetLabel,' : ''} and item names; no timing words in task text${widgetShorthand ? ' or widgetLabel' : ''}; do not duplicate quantity/unit inside item name.
Task wording rules: keep the user's intended register. You may remove filler or split a brain dump, but do not euphemize, moralize, sanitize, or make blunt/adult/medical/private wording more polite. Do not replace a relationship word or name in the task title from Personal Context unless the user wrote that replacement.

Return ONLY valid JSON. The first character must be { and the last character must be }. No prose, no markdown:
${multiList
  ? `{"tasks":[{"text":"call dentist"${widgetShorthand ? ',"widgetLabel":"dentist"' : ''},"tier":"medium","listId":${JSON.stringify(defaultListId)},"reminder":{"daysFromNow":1,"hour":10,"minute":0,"repeatHourly":false,"repeatDaily":false}}],"grocery":${groceryJsonExample}}`
  : `{"tasks":[{"text":"call dentist"${widgetShorthand ? ',"widgetLabel":"dentist"' : ''},"tier":"medium","reminder":{"daysFromNow":1,"hour":10,"minute":0,"repeatHourly":false,"repeatDaily":false}}],"grocery":[]}`}
Omit reminder field if no reminder. Either array can be empty. listId must be a valid id from Available task lists or null.`;

          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': storedKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: ANTHROPIC_MODEL, max_tokens: 1400, temperature: 0,
              system: systemPrompt,
              messages: [{ role: 'user', content: raw }],
              tools: [aiRouteInputTool(multiList, widgetShorthand)],
              tool_choice: { type: 'tool', name: AI_ROUTE_INPUT_TOOL_NAME },
            }),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(JSON.stringify(data));
          const parsed = anthropicToolInputFromResponse(data, AI_ROUTE_INPUT_TOOL_NAME);

          const VALID_TIER = new Set<string>(['high', 'medium', 'low']);
          const validListIds = new Set(listMap.map(l => l.id));
          const parsedTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
          const parsedGroceryItems = groceryItemsFromAiPayload(parsed?.grocery);
          const onePlainTaskOnly = parsedTasks.length === 1 && parsedGroceryItems.length === 0;
          const defaultRouteListId = multiList ? defaultListId : null;

          // Group tasks by target list
          const tasksByList = new Map<string | null, TaskDraft[]>();
          parsedTasks.forEach((item: any) => {
            let text = String(item?.text ?? '').trim();
            if (onePlainTaskOnly) text = protectPlainTaskTextRegister(raw, text);
            if (!text) return;
            const tier = (VALID_TIER.has(item?.tier) ? item.tier : 'medium') as Tier;
            const reminder = buildReminderFromAI(item?.reminder);
            const aiListId = (multiList && item?.listId && validListIds.has(item.listId)) ? item.listId as string : undefined;
            const hintListId = multiList && workspaceContext.destinationHint && validListIds.has(workspaceContext.destinationHint.listId)
              ? workspaceContext.destinationHint.listId
              : undefined;
            const listId = hintListId ?? aiListId ?? defaultRouteListId;
            const bucket = tasksByList.get(listId) ?? [];
            bucket.push({ text, widgetLabel: normalizeWidgetLabel(item?.widgetLabel, text), tier, reminder });
            tasksByList.set(listId, bucket);
          });

          const grocItems = groceryEnabled
            ? parsedGroceryItems
                .map((item: any) => normalizeGroceryDraft(item, raw, inferGroceryQuantities))
                .filter((item: GroceryDraft | null): item is GroceryDraft => !!item)
            : [];

          const taskDestinations = Array.from(tasksByList.entries())
            .filter(([, items]) => items.length > 0)
            .map(([listId]) => listId ?? activeListId);
          if (new Set(taskDestinations).size > 1) {
            showToast('Use one task list', 'AI can add to one task list at a time.');
            setAiLoading(false);
            return;
          }

          let totalTasks = 0;
          tasksByList.forEach((items, listId) => {
            totalTasks += items.length;
            if (listId === null) {
              onAddMany(items);
            } else {
              onAddManyToList(listId, items);
              const listName = listMap.find(l => l.id === listId)?.name ?? 'list';
              showToast(`${items.length} task${items.length !== 1 ? 's' : ''} added to ${listName}`);
            }
          });

          if (tasksByList.has(null) || totalTasks > 0) {
            const defaultItems = tasksByList.get(null) ?? [];
            if (defaultItems.length > 0) {
              const hi = defaultItems.filter(t => t.tier === 'high').length;
              const md = defaultItems.filter(t => t.tier === 'medium').length;
              const lo = defaultItems.filter(t => t.tier === 'low').length;
              const rec = defaultItems.filter(t => t.reminder).length;
              const parts = ([['High', hi], ['Med', md], ['Low', lo], ['+ reminder', rec]] as [string, number][])
                .filter(([, n]) => n > 0).map(([l, n]) => `${n} ${l}`).join(' · ');
              showToast(`${defaultItems.length} task${defaultItems.length !== 1 ? 's' : ''} added`, grocItems.length > 0 ? `+ ${grocItems.length} grocery item${grocItems.length !== 1 ? 's' : ''}${parts ? ' · ' + parts : ''}` : parts);
            }
          }
          if (grocItems.length > 0) {
            const groceryIds = await addGroceryItemsSafely(grocItems);
            if (totalTasks === 0 && Array.isArray(groceryIds) && groceryIds[0]) {
              onGroceryOnlyAdded?.(groceryIds);
            }
            if (totalTasks === 0) showToast(`${grocItems.length} grocery item${grocItems.length !== 1 ? 's' : ''} added`);
          }
          if (totalTasks === 0 && grocItems.length === 0) {
            showToast('Nothing parsed — try again');
          }
        }
      } catch (e: any) {
        showToast('AI failed', anthropicErrorDetail(e));
        if (groceryMode) {
          addGroceryItemsSafely([{ name: raw, category: GROCERY_UNCATEGORIZED }]);
        } else {
          onAddMany([{ text: raw, tier: defaultTier }]);
        }
      }
      setAiLoading(false);
      setValue('');
      Keyboard.dismiss();
    } else {
      // Task mode + no AI: open priority picker
      if (!groceryMode && widgetTier) {
        onAddMany([{ text: raw, tier: widgetTier }]);
        setValue('');
        setWidgetTier(null);
        Keyboard.dismiss();
      } else {
        setPickerOpen(true);
      }
    }
  };

  const pickPriority = (chosen: Tier, reminder?: Reminder) => {
    const raw = value.trim();
    if (raw) onAddMany([{ text: raw, tier: chosen, reminder }]);
    setValue('');
    setWidgetTier(null);
    setPickerOpen(false);
    Keyboard.dismiss();
  };

  return (
    <View style={[styles.inputBar, { borderTopColor: T.border, backgroundColor: T.s1 }]}>
      <View style={styles.inputBarTopRow}>
        <TouchableOpacity
          onPress={toggleMic}
          style={[styles.inputTopBtn, { backgroundColor: listening ? `${accentColor}18` : T.s3, borderColor: accentColor, borderWidth: 1.5 }]}
          activeOpacity={0.7}>
          <Icon name="mic" size={14} color={listening ? accentColor : T.textSub} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { if (hasApiKey) setAiMode(m => !m); }}
          style={[styles.inputTopBtn, { backgroundColor: aiMode && hasApiKey ? `${accentColor}18` : T.s3, borderColor: accentColor, borderWidth: 1.5, opacity: hasApiKey ? 1 : 0.45 }]}
          activeOpacity={hasApiKey ? 0.7 : 1}>
          <Icon name="sparkles" size={14} color={hasApiKey ? (aiMode ? accentColor : T.textSub) : T.textMute} />
          {aiMode && hasApiKey ? <Text style={[styles.aiOnLabel, { color: accentColor, fontFamily: jks('700') }]}>AI On</Text> : null}
        </TouchableOpacity>
      </View>
      <View style={styles.inputBarBottomRow}>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={setValue}
          onSubmitEditing={submit}
          returnKeyType={aiMode && hasApiKey ? 'send' : 'done'}
          blurOnSubmit={true}
          placeholder={
            aiMode && hasApiKey
              ? 'Mix tasks, groceries, errands — AI routes everything to the right list.'
              : widgetTier ? `Add ${widgetTier} task...`
              : groceryMode ? 'Add item...' : 'Add a task...'
          }
          placeholderTextColor={T.textMute}
          style={[styles.taskInput, { backgroundColor: T.s3, color: T.text, borderColor: accentColor, borderWidth: 1.5, fontFamily: jks('400') }]}
        />
        <TouchableOpacity
          onPress={submit}
          disabled={aiLoading}
          accessibilityRole="button"
          accessibilityLabel={aiMode && hasApiKey ? 'Add with AI' : (groceryMode ? 'Add item' : 'Add task')}
          style={[styles.submitBtn, { backgroundColor: accentColor, opacity: aiLoading ? 0.85 : 1 }]}
          activeOpacity={0.8}>
          {aiLoading
            ? <ActivityIndicator size="small" color="#fff" />
            : <Icon name={aiMode && hasApiKey ? 'sparkles' : 'plus'} size={16} color="#fff" />}
        </TouchableOpacity>
      </View>
      {pickerOpen && (
        <PriorityPicker
          taskText={value.trim()}
          onPick={pickPriority}
          onCancel={() => setPickerOpen(false)}
          accentColor={accentColor}
          showToast={showToast}
        />
      )}
    </View>
  );
}

// ─── ConfirmDialog (themed Alert.alert replacement) ──────────────────────────

interface ConfirmOpts {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

function ConfirmDialog({ opts, onClose, accentColor }: { opts: ConfirmOpts; onClose: () => void; accentColor: string }) {
  const T = useT();
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(400)).current;
  const { dragY, panHandlers } = useSwipeToDismiss(() => { opts.onCancel?.(); onClose(); });

  useEffect(() => {
    Animated.timing(slideAnim, { toValue: 0, duration: 220, useNativeDriver: true }).start();
  }, [slideAnim]);

  const cancel = () => { opts.onCancel?.(); onClose(); };
  const confirm = () => { opts.onConfirm(); onClose(); };

  return (
    <RootPortal onBack={cancel}>
      <View style={styles.portalRoot}>
        <TouchableWithoutFeedback onPress={cancel}>
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>
        <Animated.View
          style={[styles.sheetPanel, { bottom: insets.bottom, backgroundColor: T.s1, borderColor: T.border, transform: [{ translateY: Animated.add(slideAnim, dragY) }] }]}>
          <View style={styles.sheetHandle} {...panHandlers}>
            <View style={[styles.sheetHandleBar, { backgroundColor: T.s3 }]} />
          </View>
          <View style={styles.sheetContent}>
            <Text style={[styles.confirmTitle, { color: T.text, fontFamily: jks('700') }]}>{opts.title}</Text>
            {opts.message ? (
              <Text style={[styles.confirmMessage, { color: T.textSub, fontFamily: jks('400') }]}>{opts.message}</Text>
            ) : null}
            <View style={styles.sheetActions}>
              <TouchableOpacity onPress={cancel} style={[styles.sheetCancelBtn, { backgroundColor: T.s2, borderColor: T.border }]}>
                <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.78} style={[styles.sheetCancelLabel, { color: T.textSub, fontFamily: jks('600') }]}>{opts.cancelLabel ?? 'Cancel'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={confirm}
                style={[styles.sheetSaveBtn, { backgroundColor: opts.destructive ? '#FF5040' : accentColor }]}>
                <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.72} style={[styles.sheetSaveLabel, { fontFamily: jks('700'), textAlign: 'center' }]}>{opts.confirmLabel ?? 'Confirm'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>
      </View>
    </RootPortal>
  );
}

function useConfirm(accentColor: string): [React.ReactNode, (opts: ConfirmOpts) => void] {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const node = opts ? <ConfirmDialog opts={opts} onClose={() => setOpts(null)} accentColor={accentColor} /> : null;
  return [node, setOpts];
}

// ─── PriorityPicker ───────────────────────────────────────────────────────────

interface PriorityPickerProps {
  taskText: string;
  onPick: (tier: Tier, reminder?: Reminder) => void;
  onCancel: () => void;
  accentColor: string;
  showToast?: (msg: string, sub?: string) => void;
}

function PriorityPicker({ taskText, onPick, onCancel, accentColor, showToast }: PriorityPickerProps) {
  const T = useT();
  const TIERS = TIERS_DEF(T);
  const slideAnim = useRef(new Animated.Value(400)).current;
  const { dragY, panHandlers } = useSwipeToDismiss(onCancel);
  const [reminder, setReminder] = useState<Reminder | undefined>(undefined);

  useEffect(() => {
    Animated.timing(slideAnim, { toValue: 0, duration: 240, useNativeDriver: true }).start();
  }, [slideAnim]);

  return (
    <Modal transparent visible animationType="none" onRequestClose={onCancel}>
      <TouchableWithoutFeedback onPress={onCancel}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>
      <Animated.View style={[styles.sheetPanel, { backgroundColor: T.s1, borderColor: T.border, transform: [{ translateY: Animated.add(slideAnim, dragY) }] }]}>
        <View style={styles.sheetHandle} {...panHandlers}>
          <View style={[styles.sheetHandleBar, { backgroundColor: T.s3 }]} />
        </View>
        <ScrollView style={{ maxHeight: 580 }} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={[styles.sheetTitle, { color: T.textMute, fontFamily: jks('700') }]}>Set Priority</Text>
          <Text numberOfLines={3} style={[styles.pickerPreview, { color: T.text, backgroundColor: T.s2, borderColor: T.border, fontFamily: jks('500') }]}>
            {taskText}
          </Text>
          <ReminderPicker reminder={reminder} onChange={setReminder} accentColor={accentColor} showToast={showToast} />
          <View style={[styles.pickerTierCol, { marginTop: 12 }]}>
            {TIERS.map(t => (
              <TouchableOpacity key={t.id} onPress={() => onPick(t.id, reminder)} activeOpacity={0.75}
                style={[styles.pickerTierBtn, { backgroundColor: `${t.color}1F`, borderColor: `${t.color}80` }]}>
                <View style={[styles.pickerTierDot, { backgroundColor: t.color }]} />
                <Text style={[styles.pickerTierLabel, { color: t.color, fontFamily: jks('700') }]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity onPress={onCancel} style={[styles.sheetCancelBtn, { backgroundColor: T.s2, borderColor: T.border, marginTop: 4 }]}>
            <Text style={[styles.sheetCancelLabel, { color: T.textSub, fontFamily: jks('600') }]}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

// ─── List selector (multi-list UI) ───────────────────────────────────────────

interface ListPillRowProps {
  lists: TaskList[];
  activeListId: string;
  accentColor: string;
  isPaid: boolean;
  onSelect: (id: string) => void;
  onLongPress: (id: string) => void;
  onAddPress: () => void;
  onJoinPress: () => void;
  onReorder: (newLists: TaskList[]) => void;
  // List IDs that are shared (vs. private). Shared pills render a small
  // users-icon prefix. Step 11 — sharedIds is empty until a follow-up step
  // teaches the parent to merge sharedLists into the lists array.
  sharedIds?: Set<string>;
}

interface DraggablePillProps {
  list: TaskList;
  index: number;
  activeListId: string;
  accentColor: string;
  isDragging: boolean;
  shift: number;
  dragX: Animated.Value;
  dragIndexRef: React.MutableRefObject<number | null>;
  hoverIndexRef: React.MutableRefObject<number | null>;
  longPressTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  didDragRef: React.MutableRefObject<boolean>;
  pillLayoutsRef: React.MutableRefObject<{ x: number; width: number }[]>;
  lists: TaskList[];
  getHoverIndex: (dragIdx: number, offsetX: number) => number;
  setDraggingIndex: (i: number | null) => void;
  setHoverIndex: (i: number | null) => void;
  onSelect: (id: string) => void;
  onLongPress: (id: string) => void;
  onReorder: (newLists: TaskList[]) => void;
  onLayoutMeasured: () => void;
  isShared?: boolean;
  isPersonal?: boolean;
}

function DraggablePill({
  list: l, index, activeListId, accentColor, isDragging, shift, dragX,
  dragIndexRef, hoverIndexRef, longPressTimerRef, didDragRef, pillLayoutsRef,
  lists, getHoverIndex, setDraggingIndex, setHoverIndex,
  onSelect, onLongPress, onReorder, onLayoutMeasured, isShared, isPersonal,
}: DraggablePillProps) {
  const T = useT();
  const active = l.id === activeListId;
  const tint = l.color || accentColor;
  const sharedIconColor = active ? readableOn(tint) : T.textSub;
  const personalIconColor = active ? readableOn(tint) : T.textSub;

  const cancelLongPress = () => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  };

  // Pan responder only claims the gesture once the long-press timer has fired
  // and the user has activated drag mode (dragIndexRef set). Before that, the
  // parent ScrollView keeps the gesture so horizontal scroll works. Tap and
  // long-press-without-drag are handled by the TouchableOpacity below.
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: () => dragIndexRef.current !== null,
    onPanResponderGrant: () => {
      didDragRef.current = true;
      dragX.setValue(0);
    },
    onPanResponderMove: (_, g) => {
      if (dragIndexRef.current === null) return;
      dragX.setValue(g.dx);
      const newHover = getHoverIndex(dragIndexRef.current, g.dx);
      if (newHover !== hoverIndexRef.current) { hoverIndexRef.current = newHover; setHoverIndex(newHover); }
    },
    onPanResponderRelease: () => {
      const wasDragging = dragIndexRef.current !== null;
      if (wasDragging && hoverIndexRef.current !== null && hoverIndexRef.current !== dragIndexRef.current) {
        const next = [...lists];
        const [moved] = next.splice(dragIndexRef.current!, 1);
        next.splice(hoverIndexRef.current, 0, moved);
        onReorder(next);
      }
      dragX.setValue(0);
      dragIndexRef.current = null; hoverIndexRef.current = null; didDragRef.current = false;
      setDraggingIndex(null); setHoverIndex(null);
    },
    onPanResponderTerminate: () => {
      dragX.setValue(0);
      dragIndexRef.current = null; hoverIndexRef.current = null; didDragRef.current = false;
      setDraggingIndex(null); setHoverIndex(null);
    },
  }), [lists, onReorder, getHoverIndex]);

  return (
    <Animated.View
      onLayout={(e) => {
        const { x, width } = e.nativeEvent.layout;
        pillLayoutsRef.current[index] = { x, width };
        onLayoutMeasured();
      }}
      style={{
        transform: [{ translateX: isDragging ? dragX : shift }, { scale: isDragging ? 1.06 : 1 }],
        zIndex: isDragging ? 10 : 1,
        opacity: isDragging ? 0.92 : 1,
      }}
      {...panResponder.panHandlers}>
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => { if (dragIndexRef.current === null) onSelect(l.id); }}
        onLongPress={() => {
          // Long-press arms drag mode. The title edit mark at the top of the
          // Tasks screen is the clearest entry point to the list-edit sheet —
          // long-press here was previously dual-purpose (drag OR open sheet
          // depending on whether the finger moved before release), but real
          // fingers wobble enough that the sheet would steal the gesture.
          // Tap-list-title-to-rename + pencil-to-edit-everything-else makes
          // the gestures unambiguous.
          dragIndexRef.current = index;
          hoverIndexRef.current = index;
          didDragRef.current = false;
          setDraggingIndex(index);
          setHoverIndex(index);
        }}
        onPressOut={() => {
          // Drag was armed but never claimed (user released without moving).
          // Just clear drag state — no sheet open. Tap goes through onPress
          // since dragIndexRef is null after this.
          setTimeout(() => {
            if (dragIndexRef.current === index && !didDragRef.current) {
              dragIndexRef.current = null;
              hoverIndexRef.current = null;
              setDraggingIndex(null);
              setHoverIndex(null);
            }
          }, 0);
        }}
        delayLongPress={400}>
        <View style={[styles.listPill, { backgroundColor: active ? tint : 'transparent', borderColor: active ? tint : T.borderMid, flexDirection: 'row', alignItems: 'center', gap: (isShared || isPersonal) ? 6 : 0 }]}>
          {isPersonal ? <Icon name="home" size={11} color={personalIconColor} /> : null}
          {isShared ? <Icon name="users" size={11} color={sharedIconColor} /> : null}
          <Text style={[styles.listPillLabel, { color: active ? readableOn(tint) : T.textSub, fontFamily: jks(active ? '700' : '500') }]} numberOfLines={1}>
            {l.name}
          </Text>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

function ListPillRow({ lists, activeListId, accentColor, isPaid, onSelect, onLongPress, onAddPress, onJoinPress, onReorder, sharedIds }: ListPillRowProps) {
  const T = useT();

  const scrollRef = useRef<ScrollView | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const hoverIndexRef = useRef<number | null>(null);
  const dragX = useRef(new Animated.Value(0)).current;
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didDragRef = useRef(false);
  const pillLayoutsRef = useRef<{ x: number; width: number }[]>([]);

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const scrollXRef = useRef(0);
  const scrollAnimRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const centerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userScrolledAtRef = useRef(0);
  const suppressScrollEventRef = useRef(false);

  const handlePillMeasured = useCallback(() => {
    setLayoutVersion(v => v + 1);
  }, []);

  const getHoverIndex = useCallback((dragIdx: number, offsetX: number): number => {
    const layouts = pillLayoutsRef.current;
    if (!layouts[dragIdx]) return dragIdx;
    const draggedCenter = layouts[dragIdx].x + offsetX + layouts[dragIdx].width / 2;
    let best = dragIdx;
    let bestDist = Infinity;
    for (let i = 0; i < lists.length; i++) {
      if (!layouts[i]) continue;
      const dist = Math.abs(draggedCenter - (layouts[i].x + layouts[i].width / 2));
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  }, [lists.length]);

  const getShift = (i: number): number => {
    if (draggingIndex === null || hoverIndex === null || i === draggingIndex) return 0;
    const w = (pillLayoutsRef.current[draggingIndex]?.width ?? 80) + 8;
    if (draggingIndex < hoverIndex && i > draggingIndex && i <= hoverIndex) return -w;
    if (draggingIndex > hoverIndex && i >= hoverIndex && i < draggingIndex) return w;
    return 0;
  };

  const centerActivePill = useCallback((animated: boolean) => {
    if (draggingIndex !== null || !viewportWidth) return;
    if (scrollAnimRef.current) {
      clearInterval(scrollAnimRef.current);
      scrollAnimRef.current = null;
    }
    const activeIndex = lists.findIndex(l => l.id === activeListId);
    if (activeIndex < 0) return;
    const layout = pillLayoutsRef.current[activeIndex];
    if (!layout) return;
    const maxX = Math.max(0, contentWidth - viewportWidth);
    const targetX = Math.max(0, Math.min(maxX, layout.x + layout.width / 2 - viewportWidth / 2));
    if (!animated) {
      scrollXRef.current = targetX;
      suppressScrollEventRef.current = true;
      scrollRef.current?.scrollTo({ x: targetX, animated: false });
      setTimeout(() => { suppressScrollEventRef.current = false; }, 0);
      return;
    }
    const startX = scrollXRef.current;
    const delta = targetX - startX;
    if (Math.abs(delta) < 2) return;
    const duration = 2000;
    const startedAt = Date.now();
    scrollAnimRef.current = setInterval(() => {
      const t = Math.min(1, (Date.now() - startedAt) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const nextX = startX + delta * eased;
      scrollXRef.current = nextX;
      suppressScrollEventRef.current = true;
      scrollRef.current?.scrollTo({ x: nextX, animated: false });
      setTimeout(() => { suppressScrollEventRef.current = false; }, 0);
      if (t >= 1 && scrollAnimRef.current) {
        clearInterval(scrollAnimRef.current);
        scrollAnimRef.current = null;
        scrollXRef.current = targetX;
      }
    }, 16);
  }, [activeListId, contentWidth, draggingIndex, lists, viewportWidth]);

  const scheduleCenterActivePill = useCallback((delayMs: number) => {
    if (centerTimerRef.current) clearTimeout(centerTimerRef.current);
    centerTimerRef.current = setTimeout(() => {
      if (Date.now() - userScrolledAtRef.current < delayMs) {
        scheduleCenterActivePill(delayMs);
        return;
      }
      centerActivePill(true);
    }, delayMs);
  }, [centerActivePill]);

  useEffect(() => {
    scheduleCenterActivePill(3000);
    return () => {
      if (centerTimerRef.current) clearTimeout(centerTimerRef.current);
    };
  }, [activeListId, layoutVersion, lists.length, scheduleCenterActivePill]);

  useEffect(() => {
    return () => {
      if (scrollAnimRef.current) clearInterval(scrollAnimRef.current);
      if (centerTimerRef.current) clearTimeout(centerTimerRef.current);
    };
  }, []);

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.listPillRowContent}
      style={styles.listPillRow}
      scrollEnabled={draggingIndex === null}
      onScroll={(e) => { scrollXRef.current = e.nativeEvent.contentOffset.x; }}
      scrollEventThrottle={16}
      onScrollBeginDrag={() => {
        userScrolledAtRef.current = Date.now();
        if (scrollAnimRef.current) {
          clearInterval(scrollAnimRef.current);
          scrollAnimRef.current = null;
        }
        if (centerTimerRef.current) clearTimeout(centerTimerRef.current);
      }}
      onScrollEndDrag={() => {
        userScrolledAtRef.current = Date.now();
        scheduleCenterActivePill(3000);
      }}
      onMomentumScrollEnd={() => {
        if (suppressScrollEventRef.current) return;
        userScrolledAtRef.current = Date.now();
        scheduleCenterActivePill(3000);
      }}
      onLayout={(e) => {
        setViewportWidth(e.nativeEvent.layout.width);
        setTimeout(() => centerActivePill(false), 0);
      }}
      onContentSizeChange={(width) => {
        setContentWidth(width);
        setTimeout(() => centerActivePill(false), 0);
      }}>
      {lists.map((l, i) => (
        <DraggablePill
          key={l.id}
          list={l}
          index={i}
          activeListId={activeListId}
          accentColor={accentColor}
          isDragging={draggingIndex === i}
          shift={getShift(i)}
          dragX={dragX}
          dragIndexRef={dragIndexRef}
          hoverIndexRef={hoverIndexRef}
          longPressTimerRef={longPressTimerRef}
          didDragRef={didDragRef}
          pillLayoutsRef={pillLayoutsRef}
          lists={lists}
          getHoverIndex={getHoverIndex}
          setDraggingIndex={setDraggingIndex}
          setHoverIndex={setHoverIndex}
          onSelect={onSelect}
          onLongPress={onLongPress}
          onReorder={onReorder}
          onLayoutMeasured={handlePillMeasured}
          isShared={sharedIds?.has(l.id) ?? false}
          isPersonal={l.id === DEFAULT_LIST_ID}
        />
      ))}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={onAddPress}
        style={[styles.listPill, styles.listPillAdd, styles.listPillAddIcon, { backgroundColor: T.s2, borderColor: isPaid ? `${accentColor}40` : T.border, opacity: isPaid ? 1 : 0.5 }]}>
        <Icon name="plus" size={14} color={isPaid ? T.textSub : T.textMute} />
      </TouchableOpacity>
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={onJoinPress}
        style={[styles.listPill, styles.listPillAdd, { backgroundColor: T.s2, borderColor: isPaid ? `${accentColor}40` : T.border, opacity: isPaid ? 1 : 0.5, flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
        <Icon name="logIn" size={14} color={isPaid ? T.textSub : T.textMute} />
        <Text style={[styles.listPillLabel, { color: isPaid ? T.textSub : T.textMute, fontFamily: jks('600') }]}>Join</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

interface ListActionSheetProps {
  list: TaskList;
  canDelete: boolean;
  isPaid: boolean;
  accentColor: string;
  onRename: (name: string) => void;
  onAskDelete: () => void;
  onClose: () => void;
  // Step 10: shared-list mode. When sharedMode is undefined (default), the
  // sheet operates on a private list — pre-existing behavior. When set,
  // the sheet renders share-code/members/leave actions appropriate for
  // member or owner. Provider methods are bound by the parent.
  sharedMode?: {
    isOwner: boolean;
    shareCode: string;
    memberCount: number;
    onRotateCode: () => Promise<void>;
    onLeave: () => Promise<void>;     // member-only path
    onDelete: () => Promise<void>;    // owner-only path
    onMakePrivate?: (pendingName?: string) => void; // owner-only path
  };
  // Step 10: 'Share this list' action, only present for non-shared private
  // lists. Triggers promote-to-shared. Caller handles confirm dialog.
  // Optional pendingName lets the sheet hand over an in-progress rename
  // (typed in the Name input but not yet saved) so the new shared list
  // inherits the typed name instead of the stale disk name.
  onShareList?: (pendingName?: string) => void;
}

function ListActionSheet({ list, canDelete, isPaid, accentColor, onRename, onAskDelete, onClose, sharedMode, onShareList }: ListActionSheetProps) {
  const T = useT();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // Uncontrolled — see EditSheet for the IME-vs-controlled-value rationale.
  const nameRef = useRef(list.name);
  const nameInputRef = useRef<TextInput | null>(null);
  const slide = useRef(new Animated.Value(0)).current;
  const [keyboard, setKeyboard] = useState<KeyboardSheetState>(() => getKeyboardMetrics());
  const [inputFocused, setInputFocused] = useState(false);
  const { dragY, panHandlers } = useSwipeToDismiss(onClose);

  // Focus is driven by the effect below (after slide completes) — see EditSheet
  // for why focusing during the animation is unreliable on S24.
  const setNameInputRef = useCallback((node: TextInput | null) => {
    nameInputRef.current = node;
  }, []);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let kbAppeared = getKeyboardMetrics().height > 0;

    const showSub = Keyboard.addListener('keyboardDidShow', e => {
      kbAppeared = true;
      setKeyboard(keyboardStateFromEvent(e));
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboard({ height: 0, screenY: null });
      setInputFocused(false);
    });

    Animated.timing(slide, { toValue: 1, duration: 180, useNativeDriver: true }).start(() => {
      const node = nameInputRef.current;
      if (!node) return;
      node.focus();
      // Land cursor at end of existing name instead of letting Android
      // auto-select all (which made the user's first keystroke overwrite
      // the existing name). Same fix as EditSheet.
      const len = (nameRef.current || '').length;
      try { (node as any).setNativeProps?.({ selection: { start: len, end: len } }); } catch {}
      retryTimer = setTimeout(() => {
        if (!kbAppeared && nameInputRef.current) {
          nameInputRef.current.blur();
          nameInputRef.current.focus();
        }
      }, 350);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [slide]);

  const sheetFrame = getKeyboardSheetFrame(keyboard, insets.top, insets.bottom, windowHeight, inputFocused);
  const scrollMaxHeight = sheetFrame.keyboardInset > 0
    ? Math.max(280, sheetFrame.maxHeight - 12)
    : sheetFrame.maxHeight;

  const save = () => {
    Keyboard.dismiss();
    const trimmed = nameRef.current.trim();
    if (trimmed && trimmed !== list.name) onRename(trimmed);
    onClose();
  };
  const cancel = () => { Keyboard.dismiss(); onClose(); };

  return (
    <RootPortal onBack={cancel}>
      <View style={styles.portalRoot}>
        <TouchableWithoutFeedback onPress={cancel}>
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>
        <Animated.View
          style={[styles.sheetPanel, styles.sheetCompact, { bottom: sheetFrame.bottom, maxHeight: sheetFrame.maxHeight, backgroundColor: T.s1, borderColor: T.border, transform: [{ translateY: Animated.add(slide.interpolate({ inputRange: [0, 1], outputRange: [400, 0] }), dragY) }] }]}>
          <View style={styles.sheetHandle} {...panHandlers}>
            <View style={[styles.sheetHandleBar, { backgroundColor: T.s3 }]} />
          </View>
          <ScrollView
            style={[styles.sheetScroll, { maxHeight: scrollMaxHeight }]}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[styles.sheetCompactContent, { paddingBottom: sheetFrame.keyboardInset > 0 ? 20 : 4 }]}>
            <Text style={[styles.sheetTitle, { color: T.text, fontFamily: jks('700') }]}>List Settings</Text>

            <Text style={[styles.sheetSectionLabel, { color: T.textSub, fontFamily: jks('600') }]}>Name</Text>
            <View style={[styles.listRenameRow, { backgroundColor: T.s2, borderColor: `${accentColor}55` }]}>
              <TextInput
                ref={setNameInputRef}
                defaultValue={list.name}
                onChangeText={(t) => { nameRef.current = t; }}
                onFocus={() => setInputFocused(true)}
                maxLength={40}
                onSubmitEditing={save}
                returnKeyType="done"
                selectTextOnFocus={false}
                autoCorrect={false}
                autoComplete="off"
                spellCheck={false}
                importantForAutofill="no"
                style={[styles.listRenameInput, { color: T.text, fontFamily: jks('500') }]}
                placeholderTextColor={T.textMute}
              />
            </View>

            {sharedMode ? (
              <>
              <Text style={[styles.sheetSectionLabel, { color: T.textSub, fontFamily: jks('600'), marginTop: 14 }]}>Share code</Text>
              <View style={[styles.listRenameRow, { backgroundColor: T.s2, borderColor: T.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 }]}>
                <Text selectable style={{ color: T.text, fontFamily: jks('700'), fontSize: 18, letterSpacing: 3 }}>
                  {sharedMode.shareCode}
                </Text>
                {sharedMode.isOwner ? (
                  <TouchableOpacity
                    onPress={() => sharedMode.onRotateCode().catch(() => {})}
                    style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: T.borderMid, backgroundColor: T.s3 }}>
                    <Text style={{ color: T.textSub, fontFamily: jks('600'), fontSize: 12 }}>Rotate</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text style={{ color: T.textMute, fontSize: 12, fontFamily: jks('400'), marginTop: 6 }}>
                {sharedMode.memberCount} member{sharedMode.memberCount === 1 ? '' : 's'}{sharedMode.isOwner ? ' • You’re the owner' : ''}
              </Text>
              {sharedMode.isOwner ? (
                <>
                {sharedMode.onMakePrivate ? (
                  <TouchableOpacity
                    onPress={() => {
                      const trimmed = nameRef.current.trim();
                      const pending = trimmed && trimmed !== list.name ? trimmed : undefined;
                      sharedMode.onMakePrivate?.(pending);
                    }}
                    style={[styles.listSheetActionBtn, { backgroundColor: `${accentColor}18`, borderColor: `${accentColor}80`, alignSelf: 'stretch', marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }]}>
                    <Icon name="home" size={14} color={accentColor} />
                    <Text style={[styles.listSheetActionLabel, { color: accentColor, fontFamily: jks('700') }]}>Make Private</Text>
                  </TouchableOpacity>
                ) : null}
                <View style={styles.listSheetActionsRow}>
                  <TouchableOpacity
                    onPress={() => sharedMode.onDelete().catch(() => {})}
                    style={[styles.listSheetActionBtn, { backgroundColor: 'transparent', borderColor: `${T.high}80` }]}>
                    <Text style={[styles.listSheetActionLabel, { color: T.high, fontFamily: jks('700') }]}>Delete List</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={save} style={[styles.listSheetActionBtn, { backgroundColor: accentColor, borderColor: accentColor }]}>
                    <Text style={[styles.listSheetActionLabel, { color: '#fff', fontFamily: jks('700') }]}>Save</Text>
                  </TouchableOpacity>
                </View>
                </>
              ) : (
                <TouchableOpacity
                  onPress={() => sharedMode.onLeave().catch(() => {})}
                  style={[styles.listSheetActionBtn, { backgroundColor: 'transparent', borderColor: `${T.high}80`, alignSelf: 'stretch', marginTop: 14 }]}>
                  <Text style={[styles.listSheetActionLabel, { color: T.high, fontFamily: jks('700') }]}>Leave List</Text>
                </TouchableOpacity>
              )}
              </>
            ) : (
              <>
              {onShareList ? (
                <TouchableOpacity
                  onPress={() => {
                    // Hand the parent any in-progress rename text so the new
                    // shared list inherits the typed name. The parent uses
                    // it directly when building the shared doc, sidestepping
                    // the setState/closure race that would otherwise leave
                    // the new list named after the stale disk value.
                    const trimmed = nameRef.current.trim();
                    const pending = trimmed && trimmed !== list.name ? trimmed : undefined;
                    onShareList(pending);
                  }}
                  style={[styles.listSheetActionBtn, { backgroundColor: 'transparent', borderColor: `${accentColor}80`, alignSelf: 'stretch', marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }]}>
                  <Icon name="users" size={14} color={accentColor} />
                  <Text style={[styles.listSheetActionLabel, { color: accentColor, fontFamily: jks('700') }]}>Share this list</Text>
                </TouchableOpacity>
              ) : null}
              {canDelete && isPaid ? (
                <View style={styles.listSheetActionsRow}>
                  <TouchableOpacity onPress={onAskDelete} style={[styles.listSheetActionBtn, { backgroundColor: 'transparent', borderColor: `${T.high}80` }]}>
                    <Text style={[styles.listSheetActionLabel, { color: T.high, fontFamily: jks('700') }]}>Delete</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={save} style={[styles.listSheetActionBtn, { backgroundColor: accentColor, borderColor: accentColor }]}>
                    <Text style={[styles.listSheetActionLabel, { color: '#fff', fontFamily: jks('700') }]}>Save</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity onPress={save} style={[styles.listSheetActionBtn, { backgroundColor: accentColor, borderColor: accentColor, alignSelf: 'stretch', marginTop: 14 }]}>
                  <Text style={[styles.listSheetActionLabel, { color: '#fff', fontFamily: jks('700') }]}>Save</Text>
                </TouchableOpacity>
              )}
              {!canDelete && (
                <Text style={[styles.listDeleteHint, { color: T.textMute, fontFamily: jks('400') }]}>
                  {isPaid ? 'You always have at least one list.' : 'Triority Pro unlocks unlimited lists.'}
                </Text>
              )}
              </>
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </RootPortal>
  );
}

interface JoinSharedListSheetProps {
  accentColor: string;
  onClose: () => void;
  onSubmit: (rawCode: string) => Promise<void>;   // resolves on success, throws on failure
}

interface GroceryShareSheetProps {
  accentColor: string;
  shareCode?: string;
  memberCount?: number;
  isOwner?: boolean;
  onClose: () => void;
  onRotateCode?: () => Promise<void>;
  onShare?: () => void;
  onJoinCode?: () => void;
  onMakePrivate?: () => void;
  onLeave?: () => void;
  onDelete?: () => void;
}

function GroceryShareSheet({ accentColor, shareCode, memberCount = 0, isOwner, onClose, onRotateCode, onShare, onJoinCode, onMakePrivate, onLeave, onDelete }: GroceryShareSheetProps) {
  const T = useT();
  const insets = useSafeAreaInsets();
  const slide = useRef(new Animated.Value(0)).current;
  const { dragY, panHandlers } = useSwipeToDismiss(onClose);

  useEffect(() => {
    Animated.timing(slide, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [slide]);

  return (
    <RootPortal onBack={onClose}>
      <View style={styles.portalRoot}>
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>
        <Animated.View
          style={[
            styles.sheetPanel,
            styles.sheetCompact,
            {
              bottom: insets.bottom,
              backgroundColor: T.s1,
              borderColor: T.border,
              transform: [{ translateY: Animated.add(slide.interpolate({ inputRange: [0, 1], outputRange: [400, 0] }), dragY) }],
            },
          ]}>
          <View style={styles.sheetHandle} {...panHandlers}>
            <View style={[styles.sheetHandleBar, { backgroundColor: T.s3 }]} />
          </View>
          <View style={styles.sheetCompactContent}>
            <View style={[styles.upsellBadge, { backgroundColor: `${accentColor}20`, borderColor: `${accentColor}55`, alignSelf: 'flex-start' }]}>
              <Icon name="users" size={12} color={accentColor} />
              <Text style={[styles.upsellBadgeLabel, { color: accentColor, fontFamily: jks('700') }]}>Shared Groceries</Text>
            </View>
            <Text style={[styles.sheetTitle, { color: T.text, fontFamily: jks('700'), marginTop: 14 }]}>
              {shareCode ? 'Share code' : 'Grocery Sharing'}
            </Text>
            {shareCode ? (
              <>
              <View style={[styles.listRenameRow, { backgroundColor: T.s2, borderColor: T.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 }]}>
                <Text selectable style={{ color: T.text, fontFamily: jks('700'), fontSize: 18, letterSpacing: 3 }}>
                  {shareCode}
                </Text>
                {isOwner && onRotateCode ? (
                  <TouchableOpacity
                    onPress={() => onRotateCode().catch(() => {})}
                    style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: T.borderMid, backgroundColor: T.s3 }}>
                    <Text style={{ color: T.textSub, fontFamily: jks('600'), fontSize: 12 }}>Rotate</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text style={{ color: T.textMute, fontSize: 12, fontFamily: jks('400'), marginTop: 8 }}>
                {memberCount} member{memberCount === 1 ? '' : 's'}{isOwner ? ' - You are the owner' : ''}
              </Text>
              </>
            ) : (
              <Text style={{ color: T.textMute, fontSize: 12, fontFamily: jks('400'), marginTop: 2, lineHeight: 17 }}>
                Share this grocery list or enter a code from someone else.
              </Text>
            )}
            {onJoinCode ? (
              <TouchableOpacity
                onPress={onJoinCode}
                style={[styles.listSheetActionBtn, { backgroundColor: T.s2, borderColor: T.borderMid, alignSelf: 'stretch', marginTop: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }]}>
                <Icon name="logIn" size={14} color={T.textSub} />
                <Text style={[styles.listSheetActionLabel, { color: T.textSub, fontFamily: jks('700') }]}>Join with code</Text>
              </TouchableOpacity>
            ) : null}
            {!shareCode && onShare ? (
              <TouchableOpacity
                onPress={onShare}
                style={[styles.listSheetActionBtn, { backgroundColor: `${accentColor}18`, borderColor: `${accentColor}80`, alignSelf: 'stretch', marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }]}>
                <Icon name="users" size={14} color={accentColor} />
                <Text style={[styles.listSheetActionLabel, { color: accentColor, fontFamily: jks('700') }]}>Share groceries</Text>
              </TouchableOpacity>
            ) : null}
            {shareCode && isOwner ? (
              <>
                {onMakePrivate ? (
                  <TouchableOpacity
                    onPress={onMakePrivate}
                    style={[styles.listSheetActionBtn, { backgroundColor: `${accentColor}18`, borderColor: `${accentColor}80`, alignSelf: 'stretch', marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }]}>
                    <Icon name="home" size={14} color={accentColor} />
                    <Text
                      numberOfLines={2}
                      adjustsFontSizeToFit
                      minimumFontScale={0.78}
                      style={[styles.listSheetActionLabel, { color: accentColor, fontFamily: jks('700'), textAlign: 'center', flexShrink: 1 }]}>
                      Move items to personal list and delete
                    </Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  onPress={onDelete}
                  style={[styles.listSheetActionBtn, { backgroundColor: 'transparent', borderColor: `${T.high}80`, alignSelf: 'stretch', marginTop: 10 }]}>
                  <Text style={[styles.listSheetActionLabel, { color: T.high, fontFamily: jks('700') }]}>Delete</Text>
                </TouchableOpacity>
              </>
            ) : shareCode ? (
              <TouchableOpacity
                onPress={onLeave}
                style={[styles.listSheetActionBtn, { backgroundColor: 'transparent', borderColor: `${T.high}80`, alignSelf: 'stretch', marginTop: 16 }]}>
                <Text style={[styles.listSheetActionLabel, { color: T.high, fontFamily: jks('700') }]}>Leave Shared Groceries</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </Animated.View>
      </View>
    </RootPortal>
  );
}

// Step 8 UI: small modal sheet with one TextInput for the share code. Posture
// matches ListActionSheet (uncontrolled value, focus-after-slide, IME race
// fallback). Validation + caps are enforced by the caller via onSubmit
// throwing — error message surfaces inline.
function JoinSharedListSheet({ accentColor, onClose, onSubmit }: JoinSharedListSheetProps) {
  const T = useT();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const codeRef = useRef('');
  const inputRef = useRef<TextInput | null>(null);
  const slide = useRef(new Animated.Value(0)).current;
  const [keyboard, setKeyboard] = useState<KeyboardSheetState>(() => getKeyboardMetrics());
  const [inputFocused, setInputFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { dragY, panHandlers } = useSwipeToDismiss(onClose);

  const setInputRef = useCallback((node: TextInput | null) => {
    inputRef.current = node;
  }, []);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let kbAppeared = getKeyboardMetrics().height > 0;
    const showSub = Keyboard.addListener('keyboardDidShow', e => {
      kbAppeared = true;
      setKeyboard(keyboardStateFromEvent(e));
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboard({ height: 0, screenY: null });
      setInputFocused(false);
    });
    Animated.timing(slide, { toValue: 1, duration: 180, useNativeDriver: true }).start(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      retryTimer = setTimeout(() => {
        if (!kbAppeared && inputRef.current) {
          inputRef.current.blur();
          inputRef.current.focus();
        }
      }, 350);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [slide]);

  const submit = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await onSubmit(codeRef.current);
      Keyboard.dismiss();
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not join the list.');
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => { Keyboard.dismiss(); onClose(); };

  const sheetFrame = getKeyboardSheetFrame(keyboard, insets.top, insets.bottom, windowHeight, inputFocused);

  return (
    <RootPortal onBack={cancel}>
      <View style={styles.portalRoot}>
        <TouchableWithoutFeedback onPress={cancel}>
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>
        <Animated.View
          onStartShouldSetResponder={() => true}
          style={[styles.sheetPanel, styles.sheetCompact, { bottom: sheetFrame.bottom, maxHeight: sheetFrame.maxHeight, backgroundColor: T.s1, borderColor: T.border, transform: [{ translateY: Animated.add(slide.interpolate({ inputRange: [0, 1], outputRange: [400, 0] }), dragY) }] }]}>
          <View style={styles.sheetHandle} {...panHandlers}>
            <View style={[styles.sheetHandleBar, { backgroundColor: T.s3 }]} />
          </View>
          <ScrollView
            style={styles.sheetScroll}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.sheetCompactContent}>
          <Text style={[styles.sheetTitle, { color: T.text, fontFamily: jks('700') }]}>Join Shared List</Text>
          <Text style={[styles.sheetSectionLabel, { color: T.textSub, fontFamily: jks('600') }]}>Share code</Text>
          <View style={[styles.listRenameRow, { backgroundColor: T.s2, borderColor: `${accentColor}55` }]}>
            <TextInput
              ref={setInputRef}
              defaultValue=""
              onChangeText={(t) => { codeRef.current = t; }}
              onFocus={() => setInputFocused(true)}
              maxLength={12}
              onSubmitEditing={submit}
              returnKeyType="done"
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              importantForAutofill="no"
              placeholder="ABCDEF"
              style={[styles.listRenameInput, { color: T.text, fontFamily: jks('500'), letterSpacing: 2 }]}
              placeholderTextColor={T.textMute}
            />
          </View>
          {error ? (
            <Text style={{ color: T.high, fontSize: 12, fontFamily: jks('500'), marginTop: 8, textAlign: 'center' }}>
              {error}
            </Text>
          ) : null}
          <TouchableOpacity onPress={submit} disabled={busy} style={[styles.listSheetActionBtn, { backgroundColor: accentColor, borderColor: accentColor, alignSelf: 'stretch', marginTop: 14, opacity: busy ? 0.6 : 1 }]}>
            <Text style={[styles.listSheetActionLabel, { color: '#fff', fontFamily: jks('700') }]}>{busy ? 'Joining…' : 'Join'}</Text>
          </TouchableOpacity>
          </ScrollView>
        </Animated.View>
      </View>
    </RootPortal>
  );
}

interface ProUpsellSheetProps {
  accentColor: string;
  onClose: () => void;
  showToast: (msg: string, sub?: string) => void;
}

function ProUpsellSheet({ accentColor, onClose, showToast }: ProUpsellSheetProps) {
  const T = useT();
  const { buyPro, restorePurchases } = useIAP();
  const slide = useRef(new Animated.Value(0)).current;
  const { dragY, panHandlers } = useSwipeToDismiss(onClose);
  const [buying, setBuying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => { Animated.timing(slide, { toValue: 1, duration: 180, useNativeDriver: true }).start(); }, [slide]);

  const onBuy = async () => {
    setBuying(true);
    try {
      await buyPro();
      // purchaseUpdatedListener in IAPProvider handles markPaid — just close
      onClose();
    } catch (e: any) {
      const msg = e?.userInfo?.readableErrorCode || e?.code || e?.message || String(e);
      showToast('Buy failed', msg);
    } finally {
      setBuying(false);
    }
  };

  const onRestore = async () => {
    setRestoring(true);
    const found = await restorePurchases();
    setRestoring(false);
    if (found) {
      showToast('Purchase restored — welcome back!');
      onClose();
    } else {
      showToast('No purchase found for this account');
    }
  };

  const FEATURES = [
    { icon: 'layers', label: 'Unlimited task lists' },
    { icon: 'shopping-bag', label: 'Grocery list mode' },
    { icon: 'sliders', label: 'Themes, accents & custom color builder' },
  ];

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>
      <Animated.View
        onStartShouldSetResponder={() => true}
        style={[styles.sheetPanel, styles.sheetCompact, { backgroundColor: T.s1, borderColor: T.border, transform: [{ translateY: Animated.add(slide.interpolate({ inputRange: [0, 1], outputRange: [400, 0] }), dragY) }] }]}>
        <View style={styles.sheetHandle} {...panHandlers}>
          <View style={[styles.sheetHandleBar, { backgroundColor: T.s3 }]} />
        </View>
        <View style={[styles.upsellBadge, { backgroundColor: `${accentColor}20`, borderColor: `${accentColor}55` }]}>
          <Icon name="sparkles" size={12} color={accentColor} />
          <Text style={[styles.upsellBadgeLabel, { color: accentColor, fontFamily: jks('700') }]}>Triority Pro</Text>
        </View>
        <Text style={[styles.upsellTitle, { color: T.text, fontFamily: jks('800') }]}>Unlock everything</Text>
        {FEATURES.map(f => (
          <View key={f.icon} style={styles.upsellFeatureRow}>
            <Icon name={f.icon as any} size={14} color={accentColor} />
            <Text style={[styles.upsellFeatureLabel, { color: T.textSub, fontFamily: jks('400') }]}>{f.label}</Text>
          </View>
        ))}
        <View style={styles.upsellPriceRow}>
          <Text style={[styles.upsellPrice, { color: T.text, fontFamily: jks('800') }]}>$1.99</Text>
          <Text style={[styles.upsellPriceSub, { color: T.textMute, fontFamily: jks('500') }]}>one-time · no subscription</Text>
        </View>
        <TouchableOpacity onPress={onBuy} disabled={buying || restoring} style={[styles.upsellBuyBtn, { backgroundColor: accentColor, opacity: buying ? 0.6 : 1 }]}>
          <Text style={[styles.upsellBuyLabel, { fontFamily: jks('700') }]}>{buying ? 'Opening Google Play…' : 'Get Triority Pro'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onRestore} disabled={buying || restoring} style={styles.upsellRestoreBtn}>
          <Text style={[styles.upsellRestoreLabel, { color: T.textMute, fontFamily: jks('400') }]}>
            {restoring ? 'Checking…' : 'Restore purchase'}
          </Text>
        </TouchableOpacity>
        <Text style={[styles.upsellDismissHint, { color: T.textMute, fontFamily: jks('400') }]}>
          Tap anywhere outside to dismiss
        </Text>
      </Animated.View>
    </Modal>
  );
}

// ─── DonateSheet (step 15 — replaces the paid upsell as the support path) ──

interface DonateSheetProps {
  accentColor: string;
  onClose: () => void;
}

function DonateSheet({ accentColor, onClose }: DonateSheetProps) {
  const T = useT();
  const slide = useRef(new Animated.Value(0)).current;
  const { dragY, panHandlers } = useSwipeToDismiss(onClose);
  useEffect(() => { Animated.timing(slide, { toValue: 1, duration: 180, useNativeDriver: true }).start(); }, [slide]);

  const open = (url: string) => {
    if (!url) return;
    Linking.openURL(url).catch(() => {});
  };

  const hasPatreon = !!TRIORITY_PATREON_URL;
  const hasBmac = !!TRIORITY_BMAC_URL;

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>
      <Animated.View
        onStartShouldSetResponder={() => true}
        style={[styles.sheetPanel, styles.sheetCompact, { backgroundColor: T.s1, borderColor: T.border, transform: [{ translateY: Animated.add(slide.interpolate({ inputRange: [0, 1], outputRange: [400, 0] }), dragY) }] }]}>
        <View style={styles.sheetHandle} {...panHandlers}>
          <View style={[styles.sheetHandleBar, { backgroundColor: T.s3 }]} />
        </View>
        <View style={[styles.upsellBadge, { backgroundColor: `${accentColor}20`, borderColor: `${accentColor}55` }]}>
          <Icon name="heart" size={12} color={accentColor} />
          <Text style={[styles.upsellBadgeLabel, { color: accentColor, fontFamily: jks('700') }]}>Support Triority</Text>
        </View>
        <Text style={[styles.upsellTitle, { color: T.text, fontFamily: jks('800') }]}>Free forever, donations welcome</Text>
        <Text style={[styles.upsellPriceSub, { color: T.textMute, fontFamily: jks('400'), textAlign: 'center', marginBottom: 16 }]}>
          Triority is built and maintained by one person. If it earns a place on your home screen, a small contribution helps keep it free of ads, telemetry, and subscription nonsense.
        </Text>
        {hasPatreon && (
          <TouchableOpacity onPress={() => open(TRIORITY_PATREON_URL)} style={[styles.upsellBuyBtn, { backgroundColor: accentColor, marginBottom: 8 }]}>
            <Text style={[styles.upsellBuyLabel, { fontFamily: jks('700') }]}>Patreon</Text>
          </TouchableOpacity>
        )}
        {hasBmac && (
          <TouchableOpacity onPress={() => open(TRIORITY_BMAC_URL)} style={[styles.upsellBuyBtn, { backgroundColor: accentColor }]}>
            <Text style={[styles.upsellBuyLabel, { fontFamily: jks('700') }]}>Buy Me a Coffee</Text>
          </TouchableOpacity>
        )}
        <Text style={[styles.upsellDismissHint, { color: T.textMute, fontFamily: jks('400') }]}>
          Tap anywhere outside to dismiss
        </Text>
      </Animated.View>
    </Modal>
  );
}

// ─── ActiveList ───────────────────────────────────────────────────────────────

interface ActiveListProps {
  tasks: Task[];
  setTasks: (fn: (prev: Task[]) => Task[]) => void;
  setListTasks: (listId: string, fn: (prev: Task[]) => Task[]) => void;
  accentColor: string;
  hasApiKey: boolean;
  defaultTier: Tier;
  widgetShorthand: boolean;
  setArchive: (fn: (prev: ArchivedTask[]) => ArchivedTask[]) => void;
  activeListId: string;
  lists: TaskList[];
  setActiveListId: (id: string) => void;
  addList: (name: string, color?: string) => string;
  renameList: (id: string, name: string) => void;
  deleteList: (id: string) => void;
  reorderLists: (newLists: TaskList[]) => void;
  onAddGroceryItems: (items: GroceryDraft[]) => AddGroceryDraftResult;
  setScreen: (s: Screen) => void;
  onGroceryOnlyAdded?: (ids: string[]) => void;
  // Step 11b.2: when present, the active list is a shared one. Mutations
  // route through shared-list writes instead of local setTasks. Tier reordering
  // is a no-op on shared lists in v1 (ordering field deferred to v2).
  sharedActions?: {
    addItems: (items: TaskDraft[]) => Promise<string[]>;
    editItem: (itemId: TaskId, patch: { text?: string; tier?: Tier; reminder?: Reminder | null }) => Promise<void>;
    deleteItem: (itemId: TaskId) => Promise<void>;
    archiveItem: (itemId: TaskId, item: { text: string; tier: Tier; createdAt?: number }) => Promise<void>;
    // Restore: shared items are deleted from the subcollection and a local
    // ArchivedTask is recorded so the user still sees it in the archive view.
  };
  // Step 11b.3: which list IDs in `lists` are shared (vs private). The pill
  // row uses this to render the users-icon marker. Shared list rename/delete
  // is intentionally a no-op until the unified ListActionSheet ships in
  // step 10 — long-press on a shared pill toasts a 'coming soon' note.
  sharedIdSet?: Set<string>;
  collapsedGroups: CollapsedGroups;
  setCollapsedGroup: (key: string, collapsed: boolean) => void;
  focusedTaskId?: string | null;
  focusedTaskNonce?: number;
  onFocusedTaskSeen?: () => void;
  calendarConflictKeys?: Set<string>;
  calendarConflictNotice?: string | null;
}

function ActiveList({ tasks, setTasks, setListTasks, accentColor, hasApiKey, defaultTier, widgetShorthand, setArchive, activeListId, lists, setActiveListId, addList, renameList, deleteList, reorderLists, onAddGroceryItems, setScreen, onGroceryOnlyAdded, sharedActions, sharedIdSet, collapsedGroups, setCollapsedGroup, focusedTaskId, focusedTaskNonce = 0, onFocusedTaskSeen, calendarConflictKeys, calendarConflictNotice }: ActiveListProps) {
  const isPaid = useIsPaid();
  const { user: syncUser } = useSync();
  const {
    sharedLists: sharedListsMap,
    addSharedTaskItems,
    promoteTaskListToShared,
    rotateShareCode,
    renameSharedList,
    leaveSharedList,
    deleteSharedList,
    joinSharedListByCode,
  } = useSharedLists();
  const [actionList, setActionList] = useState<TaskList | null>(null);
  const [showUpsell, setShowUpsell] = useState(false);
  const [showJoinSheet, setShowJoinSheet] = useState(false);
  const onAddListPress = useCallback(() => {
    if (!isPaid) {
      setShowUpsell(true);
      return;
    }
    // Create with a placeholder name and immediately open the rename sheet so the user
    // can name it in one motion. addList already switches the active list to the new one.
    const id = addList('New List');
    // Synthesize a TaskList for the action sheet — avoids waiting for a state round-trip.
    const now = Date.now();
    setActionList({ id, name: 'New List', tasks: [], createdAt: now, updatedAt: now });
  }, [isPaid, addList]);
  const T = useT();
  const TIERS = TIERS_DEF(T);
  const insets = useSafeAreaInsets();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [localFocusedTaskId, setLocalFocusedTaskId] = useState<string | null>(null);
  const [localFocusedTaskNonce, setLocalFocusedTaskNonce] = useState(0);
  const [focusedGlowKey, setFocusedGlowKey] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedFocusKeyRef = useRef<string | null>(null);
  const shownCalendarConflictKeysRef = useRef<Set<string>>(new Set());
  const shownCalendarNoticeRef = useRef<string | null>(null);
  // Tick every 30s so reminder subtext ("In 5m", "Overdue") stays current
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const showToast = useCallback((message: string, sub?: string, sticky?: boolean) => {
    if (toastTimer.current) { clearTimeout(toastTimer.current); toastTimer.current = null; }
    setToast({ message, sub });
    if (!sticky) {
      toastTimer.current = setTimeout(() => setToast(null), 3500);
    }
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimer.current) { clearTimeout(toastTimer.current); toastTimer.current = null; }
    setToast(null);
  }, []);

  const armLocalTaskFocus = useCallback((id: TaskId | string) => {
    setLocalFocusedTaskId(String(id));
    setLocalFocusedTaskNonce(n => n + 1);
  }, []);

  const markLocalTaskFocusSeen = useCallback(() => {
    if (!localFocusedTaskId) return;
    setTimeout(() => {
      setLocalFocusedTaskId(current => current === localFocusedTaskId ? null : current);
    }, FOCUSED_ROW_CLEAR_MS);
  }, [localFocusedTaskId]);

  useEffect(() => {
    if (!calendarConflictKeys || calendarConflictKeys.size === 0) {
      shownCalendarConflictKeysRef.current.clear();
      return;
    }
    const visibleConflicts = tasks
      .map((task) => calendarConflictKey(activeListId, task.id))
      .filter((key) => key && calendarConflictKeys.has(key));
    shownCalendarConflictKeysRef.current = new Set(
      Array.from(shownCalendarConflictKeysRef.current).filter((key) => visibleConflicts.includes(key)),
    );
    const firstNew = visibleConflicts.find((key) => !shownCalendarConflictKeysRef.current.has(key));
    if (!firstNew) return;
    for (const key of visibleConflicts) shownCalendarConflictKeysRef.current.add(key);
    showToast('Reminder conflicts with your calendar');
  }, [activeListId, calendarConflictKeys, showToast, tasks]);

  useEffect(() => {
    if (!calendarConflictNotice) return;
    if (shownCalendarNoticeRef.current === calendarConflictNotice) return;
    shownCalendarNoticeRef.current = calendarConflictNotice;
    showToast(calendarConflictNotice);
  }, [calendarConflictNotice, showToast]);

  const handleComplete = useCallback((id: TaskId) => {
    if (sharedActions) {
      // Find the task in the rendered list (which is shared-items-mapped).
      const t = tasks.find(x => x.id === id);
      if (!t) return;
      sharedActions.archiveItem(id, { text: t.text, tier: t.tier, createdAt: t.createdAt })
        .catch(() => showToast('Could not complete', 'Check connection'));
      return;
    }
    setTasks(ts => {
      const t = ts.find(t => t.id === id);
      if (!t) return ts;
      // Carry reminder into archive so restore can reinstate it, but cancel the live notification
      cancelReminder(t.id).catch(() => {});
      setArchive(a => [{ id: t.id, text: t.text, tier: t.tier, completedAt: Date.now(), reminder: t.reminder, listId: activeListId }, ...a]);
      return ts.filter(x => x.id !== id);
    });
  }, [setTasks, setArchive, sharedActions, tasks, activeListId, showToast]);

  const handleDelete = useCallback((id: TaskId) => {
    if (sharedActions) {
      sharedActions.deleteItem(id).catch(() => showToast('Could not delete', 'Check connection'));
      return;
    }
    cancelReminder(id).catch(() => {});
    setTasks(ts => ts.filter(t => t.id !== id));
  }, [setTasks, sharedActions, showToast]);

  // Reorder a task within its tier. fromIndex / toIndex are positions in the
  // tier-filtered list; we map back to indices in the global tasks array, splice,
  // and reinsert. Tasks of other tiers keep their relative positions intact.
  const handleReorderInTier = useCallback((tierId: Tier, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    // Drag-reorder within tier on shared lists is a v2 want — items have no
    // explicit position field yet, so we'd need a transactional swap. For
    // now: silent no-op so the gesture doesn't crash.
    if (sharedActions) return;
    setTasks(ts => {
      const tierIndices: number[] = [];
      ts.forEach((t, i) => { if (t.tier === tierId) tierIndices.push(i); });
      if (fromIndex < 0 || fromIndex >= tierIndices.length) return ts;
      if (toIndex < 0 || toIndex >= tierIndices.length) return ts;
      const fromGlobal = tierIndices[fromIndex];
      const toGlobal = tierIndices[toIndex];
      const next = ts.slice();
      const [moved] = next.splice(fromGlobal, 1);
      // After the splice, items that were at index >= fromGlobal+1 are now one
      // position to the left. Inserting at `toGlobal` works in both directions:
      // moving down lands the row after the original `toIndex` row; moving up
      // lands the row at the original `toIndex` slot.
      next.splice(toGlobal, 0, moved);
      return next;
    });
  }, [setTasks, sharedActions]);

  // Confirm dialog still used for the "Delete list" path. Task deletion now uses the
  // glowing trash + tap UX in TaskRow (no modal — swipe reveals, tap deletes).
  const [confirmNode, confirm] = useConfirm(accentColor);

  const openJoinSheet = useCallback(() => {
    if (!syncUser) {
      showToast('Sign in to join', 'Open Settings and sign in with Google');
      return;
    }
    if (!isPaid) {
      setShowUpsell(true);
      return;
    }
    Keyboard.dismiss();
    setActionList(null);
    setTimeout(() => setShowJoinSheet(true), 0);
  }, [isPaid, showToast, syncUser]);

  const requestComplete = useCallback((id: TaskId) => {
    handleComplete(id);
  }, [handleComplete]);

  const handleAddMany = useCallback((items: TaskDraft[]) => {
    if (sharedActions) {
      // Shared reminders are stored on the row; each device schedules locally
      // only when that user has granted reminder permissions.
      if (items.some(it => it.reminder)) {
        requestReminderSchedulingPermissions(showToast).catch(() => {});
      }
      sharedActions
        .addItems(items.map(it => ({ text: it.text, tier: it.tier, reminder: it.reminder, widgetLabel: it.widgetLabel })))
        .then((ids) => {
          if (ids?.[0]) armLocalTaskFocus(String(ids[0]));
        })
        .catch(() => showToast('Could not add', 'Check connection'));
      return;
    }
    const now = Date.now();
    const newTasks: Task[] = items.map((item, i) => ({
      id: now + i,
      text: item.text,
      widgetLabel: item.widgetLabel,
      tier: item.tier,
      createdAt: now + i,
      reminder: item.reminder,
    }));
    setTasks(ts => [...ts, ...newTasks]);
    if (newTasks[0]) armLocalTaskFocus(String(newTasks[0].id));
    scheduleRemindersBatch(newTasks, showToast, activeListId);
    return newTasks.map((task) => task.id);
  }, [activeListId, setTasks, showToast, sharedActions]);

  const handleAddManyToList = useCallback((listId: string, items: TaskDraft[]) => {
    if (sharedIdSet?.has(listId)) {
      if (items.some(it => it.reminder)) {
        requestReminderSchedulingPermissions(showToast).catch(() => {});
      }
      addSharedTaskItems(listId, items)
        .then((ids) => {
          if (ids?.[0]) {
            if (listId !== activeListId) setActiveListId(listId);
            armLocalTaskFocus(String(ids[0]));
          }
        })
        .catch(() => showToast('Could not add', 'Check connection'));
      return;
    }
    const now = Date.now();
    const newTasks: Task[] = items.map((item, i) => ({
      id: now + i,
      text: item.text,
      widgetLabel: item.widgetLabel,
      tier: item.tier,
      createdAt: now + i,
      reminder: item.reminder,
    }));
    setListTasks(listId, ts => [...ts, ...newTasks]);
    if (newTasks[0]) {
      if (listId !== activeListId) setActiveListId(listId);
      armLocalTaskFocus(String(newTasks[0].id));
    }
    scheduleRemindersBatch(newTasks, showToast, listId);
    return newTasks.map((task) => task.id);
  }, [activeListId, addSharedTaskItems, setActiveListId, setListTasks, sharedIdSet, showToast]);

  const handleSave = useCallback((updated: Task) => {
    if (sharedActions) {
      if (updated.reminder) {
        requestReminderSchedulingPermissions(showToast).catch(() => {});
      }
      sharedActions
        .editItem(updated.id, { text: updated.text, tier: updated.tier, reminder: updated.reminder ?? null })
        .catch(() => showToast('Could not save', 'Check connection'));
      setEditingTask(null);
      return;
    }
    setTasks(ts => ts.map(t => (t.id === updated.id ? updated : t)));
    // Re-schedule (or cancel) when the reminder changes via edit
    setEditingTask(null);
    const reminderListId = activeListId;
    setTimeout(() => {
      if (updated.reminder) {
        scheduleRemindersBatch([updated], showToast, reminderListId);
      } else {
        cancelReminder(updated.id).catch(() => {});
      }
    }, 0);
  }, [activeListId, setTasks, showToast, sharedActions]);

  const total = tasks.length;
  const activeSharedDoc = sharedIdSet?.has(activeListId) ? sharedListsMap[activeListId] : null;
  const activeSharedMemberCount = activeSharedDoc ? Object.keys(activeSharedDoc.members || {}).length : 0;

  // Edge-scroll while dragging: TierGroup reports the finger's pageY via onDragMove.
  // If it falls within EDGE_PX of the ScrollView's top/bottom, run an interval that
  // nudges the scroll position. Cleared on null (drag ended).
  const scrollRef = useRef<ScrollView>(null);
  const scrollOffsetRef = useRef(0);
  const scrollViewLayoutRef = useRef<{ y: number; height: number }>({ y: 0, height: 0 });
  const edgeScrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const effectiveFocusedTaskId = focusedTaskId ?? localFocusedTaskId;
  const effectiveFocusRequestKey = effectiveFocusedTaskId
    ? `${activeListId}:${effectiveFocusedTaskId}:${focusedTaskId ? `external:${focusedTaskNonce}` : `local:${localFocusedTaskNonce}`}`
    : null;
  const focusedTaskTier = useMemo(() => tasks.find(t => String(t.id) === effectiveFocusedTaskId)?.tier, [effectiveFocusedTaskId, tasks]);

  useEffect(() => {
    if (!effectiveFocusedTaskId || !focusedTaskTier) return;
    const collapseKey = `tasks:${activeListId}:${focusedTaskTier}`;
    if (collapsedGroups[collapseKey]) setCollapsedGroup(collapseKey, false);
  }, [activeListId, collapsedGroups, effectiveFocusedTaskId, focusedTaskTier, setCollapsedGroup]);

  const scrollToFocusedTask = useCallback((y: number) => {
    const requestKey = effectiveFocusRequestKey;
    const targetY = Math.max(0, y - 96);
    [80, 320, 700].forEach((delay) => {
      setTimeout(() => {
        scrollRef.current?.scrollTo({ y: targetY, animated: true });
      }, delay);
    });
    if (!requestKey || firedFocusKeyRef.current === requestKey) return;
    firedFocusKeyRef.current = requestKey;
    setTimeout(() => {
      setFocusedGlowKey(requestKey);
      if (focusedTaskId) {
        onFocusedTaskSeen?.();
      } else {
        markLocalTaskFocusSeen();
      }
    }, 520);
  }, [effectiveFocusRequestKey, focusedTaskId, markLocalTaskFocusSeen, onFocusedTaskSeen]);

  useEffect(() => {
    firedFocusKeyRef.current = null;
    setFocusedGlowKey(null);
  }, [effectiveFocusRequestKey]);

  const stopEdgeScroll = () => {
    if (edgeScrollTimerRef.current) {
      clearInterval(edgeScrollTimerRef.current);
      edgeScrollTimerRef.current = null;
    }
  };

  const handleDragMovePageY = useCallback((pageY: number | null) => {
    if (pageY === null) { stopEdgeScroll(); return; }
    const EDGE_PX = 80;
    const SCROLL_PER_TICK = 14;
    const layout = scrollViewLayoutRef.current;
    const top = layout.y;
    const bottom = layout.y + layout.height;
    let direction: 'up' | 'down' | null = null;
    if (pageY < top + EDGE_PX) direction = 'up';
    else if (pageY > bottom - EDGE_PX) direction = 'down';
    if (!direction) { stopEdgeScroll(); return; }
    if (edgeScrollTimerRef.current) return;
    edgeScrollTimerRef.current = setInterval(() => {
      const dy = direction === 'up' ? -SCROLL_PER_TICK : SCROLL_PER_TICK;
      const next = Math.max(0, scrollOffsetRef.current + dy);
      scrollOffsetRef.current = next;
      scrollRef.current?.scrollTo({ y: next, animated: false });
    }, 16);
  }, []);

  useEffect(() => () => stopEdgeScroll(), []);

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: T.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={[styles.listHeader, { paddingTop: Math.max(18, 18 + insets.top) }]}>
        <View style={styles.listHeaderTop}>
          <View style={styles.listTitleRow}>
            <TouchableOpacity
              style={styles.listTitleTap}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}
              onPress={() => {
                // Step 9: tap title to open the same edit sheet pencil opens.
                // Faster path for rename without giving up the share/sync
                // affordances also in the sheet (Option B from session 14).
                const cur = lists.find(l => l.id === activeListId);
                if (cur) setActionList(cur);
              }}>
              <Text
                style={[styles.listTitleText, { color: T.text, fontFamily: jks('700') }]}
                numberOfLines={1}>
                {lists.find(l => l.id === activeListId)?.name || DEFAULT_LIST_NAME}
              </Text>
              <View style={[styles.listTitleEditMark, { borderColor: `${accentColor}66`, backgroundColor: `${accentColor}16` }]}>
                <Icon name="pencil" size={9} color={accentColor} strokeWidth={1.8} />
              </View>
            </TouchableOpacity>
          </View>
          <View style={styles.listMetaRowInline}>
            <Text style={[styles.taskCountInline, { color: T.textMute, fontFamily: jks('500') }]}>
              {`${total} task${total !== 1 ? 's' : ''}`}
            </Text>
            {activeSharedDoc ? (
              <>
                <Text style={[styles.metaBullet, { color: T.textMute }]}>•</Text>
                <View style={styles.sharedMetaPill}>
                  <Icon name="users" size={11} color={accentColor} strokeWidth={1.8} />
                  <Text style={[styles.taskCountInline, { color: accentColor, fontFamily: jks('700') }]}>
                    {activeSharedMemberCount}
                  </Text>
                </View>
              </>
            ) : null}
          </View>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => setScreen('archive')}
            style={[styles.headerActionBtnBottomRight, { backgroundColor: `${accentColor}14`, borderColor: `${accentColor}55` }]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Icon name="archive" size={14} color={accentColor} strokeWidth={1.6} />
          </TouchableOpacity>
        </View>
        <ListPillRow
          lists={lists}
          activeListId={activeListId}
          accentColor={accentColor}
          isPaid={isPaid}
          onSelect={setActiveListId}
          onLongPress={(id) => {
            const l = lists.find(x => x.id === id);
            if (l) setActionList(l);
          }}
          onAddPress={onAddListPress}
          onJoinPress={openJoinSheet}
          onReorder={reorderLists}
          sharedIds={sharedIdSet}
        />
        <View style={[styles.divider, { backgroundColor: T.border, marginTop: 14 }]} />
      </View>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 8 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={(e) => { scrollOffsetRef.current = e.nativeEvent.contentOffset.y; }}
        onLayout={(e) => {
          // Measure the scroll viewport in window coords so edge-scroll can compare
          // against the finger's pageY directly.
          const ref = scrollRef.current as any;
          if (ref && ref.measureInWindow) {
            ref.measureInWindow((_x: number, y: number, _w: number, h: number) => {
              scrollViewLayoutRef.current = { y, height: h };
            });
          } else {
            scrollViewLayoutRef.current = { y: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height };
          }
        }}>
        {total === 0 ? (
          <View style={styles.emptyState}>
            <View style={[styles.emptyIcon, { backgroundColor: T.s2 }]}>
              <Icon name="check" size={24} color={accentColor} />
            </View>
            <Text style={[styles.emptyText, { color: T.textMute, fontFamily: jks('400') }]}>All clear</Text>
          </View>
        ) : (
          TIERS.map(tier => {
            const collapseKey = `tasks:${activeListId}:${tier.id}`;
            return (
              <TierGroup key={tier.id} tier={tier} tasks={tasks.filter(t => t.tier === tier.id)}
                onComplete={handleComplete} onDelete={handleDelete} requestComplete={requestComplete} onEdit={setEditingTask} accentColor={accentColor}
                onReorderInTier={handleReorderInTier} onDragMove={handleDragMovePageY}
                collapsed={collapsedGroups[collapseKey] ?? false}
                onCollapsedChange={(next) => setCollapsedGroup(collapseKey, next)}
                focusedTaskId={effectiveFocusedTaskId}
                focusRequestKey={effectiveFocusRequestKey}
                focusedGlowKey={focusedGlowKey}
                calendarConflictKeys={calendarConflictKeys}
                activeListId={activeListId}
                onFocusedTaskLayout={scrollToFocusedTask} />
            );
          })
        )}
      </ScrollView>
      <InputBar
        onAddMany={handleAddMany}
        onAddManyToList={handleAddManyToList}
        onAddGroceryItems={onAddGroceryItems}
        hasApiKey={hasApiKey}
        accentColor={accentColor}
        defaultTier={defaultTier}
        showToast={showToast}
        dismissToast={dismissToast}
        groceryMode={false}
        lists={lists}
        activeListId={activeListId}
        widgetShorthand={widgetShorthand}
        onGroceryOnlyAdded={onGroceryOnlyAdded}
      />
      {editingTask && <EditSheet task={editingTask} onSave={handleSave} onCancel={() => setEditingTask(null)} accentColor={accentColor} showToast={showToast} />}
      {actionList && (() => {
        // Step 10: shared-list mode resolution. The same sheet renders rename
        // for both private and shared lists; everything else (rotate, leave,
        // delete, share-this-list) toggles based on whether the active list
        // is shared and whether the user owns it.
        const sharedDoc = sharedIdSet?.has(actionList.id) ? sharedListsMap[actionList.id] : null;
        const isOwner = !!sharedDoc && !!syncUser && sharedDoc.ownerUid === syncUser.uid;
        const liveList = lists.find(l => l.id === actionList.id) ?? actionList;
        // The hard-coded Personal list (DEFAULT_LIST_ID) is intentionally
        // immutable: never deletable, never shareable. It's the user's
        // private home base that always exists. Other lists are freely
        // deletable / shareable. Renaming and reordering remain allowed
        // for Personal so users can customize the label if they want.
        const isPersonal = actionList.id === DEFAULT_LIST_ID;
        return (
          <ListActionSheet
            list={liveList}
            // Personal list: never deletable. Shared list: sharedMode owns
            // the delete affordance (owner-only) so canDelete here is false.
            // All other private lists: deletable.
            canDelete={!isPersonal && !sharedDoc && lists.length > 1}
            isPaid={isPaid}
            accentColor={accentColor}
            onRename={(name) => {
              if (sharedDoc) {
                renameSharedList(actionList.id, name).catch(() => showToast('Could not rename', 'Check connection'));
              } else {
                renameList(actionList.id, name);
              }
            }}
            onAskDelete={() => {
              // Private-only path. Shared deletes go through sharedMode.onDelete.
              const target = actionList;
              if (!target) return;
              Keyboard.dismiss();
              setActionList(null);
              confirm({
                title: 'Delete List',
                message: `Delete "${target.name}" and all its tasks? Archived items keep their history but won't be restorable to this list.`,
                confirmLabel: 'Delete',
                destructive: true,
                onConfirm: () => deleteList(target.id),
              });
            }}
            onClose={() => setActionList(null)}
            onShareList={sharedDoc || !isPaid || isPersonal ? undefined : (pendingName?: string) => {
              // Promote to shared. Defer the confirm() call into a microtask
              // so it runs AFTER the action sheet unmount cycle settles —
              // React can drop state updates issued from inside an unmounting
              // subtree, and we were seeing the dialog never appear.
              const baseTarget = actionList;
              if (!baseTarget) return;
              const target = pendingName ? { ...baseTarget, name: pendingName } : baseTarget;
              Keyboard.dismiss();
              setActionList(null);
              setTimeout(() => {
                confirm({
                  title: 'Share List',
                  message: `Share "${target.name}" with a code? This moves it out of your private lists and makes it available to anyone you give the code to.`,
                  confirmLabel: 'Share',
                  destructive: false,
                  onConfirm: () => {
                    showToast('Sharing list...', 'Creating share code', true);
                    promoteTaskListToShared(target)
                      .then((newId) => {
                        deleteList(target.id);
                        setActiveListId(newId);
                        setActionList({ ...target, id: newId, updatedAt: Date.now() });
                        showToast('Shared list created');
                        requestReminderNotifications(showToast).catch(() => {});
                      })
                      .catch((e) => showToast('Could not share', e?.message || 'Check connection'));
                  },
                });
              }, 0);
            }}
            sharedMode={sharedDoc ? {
              isOwner,
              shareCode: sharedDoc.shareCode,
              memberCount: Object.keys(sharedDoc.members || {}).length,
              onRotateCode: async () => {
                try {
                  await rotateShareCode(actionList.id);
                  showToast('Share code rotated', 'Old code no longer works');
                } catch (e: any) {
                  showToast('Could not rotate', e?.message || 'Check connection');
                }
              },
              onLeave: async () => {
                const targetId = actionList.id;
                const targetName = liveList.name;
                Keyboard.dismiss();
                setActionList(null);
                setTimeout(() => {
                  confirm({
                    title: 'Leave Shared List',
                    message: `Leave "${targetName}"? You'll lose access to its items.`,
                    confirmLabel: 'Leave',
                    destructive: true,
                    onConfirm: () => {
                      showToast('Leaving shared list...', 'Updating access', true);
                      withTimeout(leaveSharedList(targetId), 15000, 'Leave timed out. Check connection and try again.')
                        .then(() => showToast('Left shared list'))
                        .catch((e) => showToast('Could not leave', e?.message || 'Check connection'));
                    },
                  });
                }, 0);
              },
              onDelete: async () => {
                // Snapshot the ID + name BEFORE setActionList(null). Reading
                // actionList from the closure at confirm-tap time is unsafe:
                // (a) it's null after this line, (b) if the user re-opens the
                // action sheet for a different list while the confirm dialog
                // is still mounted, actionList will point at the NEW list and
                // we'll delete the wrong one. Snapshot freezes the right id.
                const targetId = actionList.id;
                const targetName = liveList.name;
                Keyboard.dismiss();
                setActionList(null);
                setTimeout(() => {
                  confirm({
                    title: 'Delete Shared List',
                    message: `Delete "${targetName}" for everyone? Members will be notified.`,
                    confirmLabel: 'Delete',
                    destructive: true,
                    onConfirm: () => {
                      showToast('Deleting shared list...', 'Removing it for everyone', true);
                      withTimeout(deleteSharedList(targetId), 15000, 'Delete timed out. Check connection and try again.')
                        .then(() => showToast('Shared list deleted'))
                        .catch((e) => showToast('Could not delete', e?.message || 'Check connection'));
                    },
                  });
                }, 0);
              },
              onMakePrivate: (pendingName?: string) => {
                const targetId = actionList.id;
                const targetName = (pendingName || liveList.name).trim() || liveList.name;
                const now = Date.now();
                const privateTasks = liveList.tasks.map((task, index): Task => ({
                  id: `private_${now}_${index}`,
                  text: task.text,
                  tier: task.tier,
                  createdAt: task.createdAt || now + index,
                  reminder: task.reminder,
                }));
                Keyboard.dismiss();
                setActionList(null);
                setTimeout(() => {
                  confirm({
                    title: 'Make List Private',
                    message: `Make "${targetName}" private again? Shared members will lose access, and your copy will stay on this device.`,
                    confirmLabel: 'Make Private',
                    destructive: false,
                    onConfirm: () => {
                      showToast('Making list private...', 'Copying your items', true);
                      withTimeout(deleteSharedList(targetId), 15000, 'Make private timed out. Check connection and try again.')
                        .then(() => {
                          const privateId = addList(targetName);
                          setListTasks(privateId, () => privateTasks);
                          setActiveListId(privateId);
                          showToast('List is private again');
                        })
                        .catch((e) => showToast('Could not make private', e?.message || 'Check connection'));
                    },
                  });
                }, 0);
              },
            } : undefined}
          />
        );
      })()}
      {showUpsell && <ProUpsellSheet accentColor={accentColor} onClose={() => setShowUpsell(false)} showToast={showToast} />}
      {showJoinSheet && (
        <JoinSharedListSheet
          accentColor={accentColor}
          onClose={() => setShowJoinSheet(false)}
          onSubmit={async (rawCode) => {
            const id = await withTimeout(
              joinSharedListByCode(rawCode),
              15000,
              'Join timed out. Check connection and make sure the latest Firestore rules are published.',
            );
            const joined = sharedListsMap[id];
            if (joined?.kind === 'tasks') setActiveListId(id);
            showToast(joined ? `Joined ${joined.name}` : 'Joined shared list');
            requestReminderNotifications(showToast).catch(() => {});
          }}
        />
      )}
      {toast && <View style={styles.toastContainer} pointerEvents="none"><Toast message={toast.message} sub={toast.sub} /></View>}
      {confirmNode}
    </KeyboardAvoidingView>
  );
}

// ─── CalendarSheet ───────────────────────────────────────────────────────────

interface CalendarSheetProps {
  startDate: Date | null;
  endDate: Date | null;
  onApply: (start: Date, end: Date) => void;
  onClear: () => void;
  onCancel: () => void;
  accentColor: string;
  activeDates: Set<string>; // 'YYYY-MM-DD' strings that have archived tasks
}

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function toDateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CalendarSheet({ startDate, endDate, onApply, onClear, onCancel, accentColor, activeDates }: CalendarSheetProps) {
  const T = useT();
  const slideAnim = useRef(new Animated.Value(500)).current;
  const { dragY, panHandlers } = useSwipeToDismiss(onCancel);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [viewYear, setViewYear] = useState(startDate?.getFullYear() ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(startDate?.getMonth() ?? today.getMonth());
  const [selStart, setSelStart] = useState<Date | null>(startDate);
  const [selEnd, setSelEnd] = useState<Date | null>(endDate);
  const [picking, setPicking] = useState<'start' | 'end'>('start');

  useEffect(() => {
    Animated.timing(slideAnim, { toValue: 0, duration: 260, useNativeDriver: true }).start();
  }, [slideAnim]);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();

  // Always render 6 rows (42 cells) so the grid never changes height between months
  const cells: (Date | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(viewYear, viewMonth, i + 1)),
  ];
  while (cells.length < 42) cells.push(null);

  const handleDayPress = (day: Date) => {
    if (picking === 'start') {
      setSelStart(day);
      if (selEnd && day > selEnd) setSelEnd(null);
    } else {
      if (selStart && day < selStart) {
        setSelEnd(selStart);
        setSelStart(day);
      } else {
        setSelEnd(day);
      }
    }
  };

  const canApply = selStart !== null && selEnd !== null;

  const apply = () => {
    if (selStart && selEnd) onApply(selStart, selEnd);
  };

  const clear = () => {
    setSelStart(null);
    setSelEnd(null);
    setPicking('start');
    onClear();
  };

  const formatLabel = (d: Date | null) => {
    if (!d) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const getDayState = (day: Date) => {
    const s = selStart; const e = selEnd;
    const t = day.getTime();
    const isStart = s && t === s.getTime();
    const isEnd = e && t === e.getTime();
    const inRange = s && e && t > s.getTime() && t < e.getTime();
    const isToday = t === today.getTime();
    const hasItems = activeDates.has(toDateKey(day));
    return { isStart, isEnd, inRange, isToday, hasItems };
  };

  return (
    <Modal transparent visible animationType="none" onRequestClose={onCancel}>
      <TouchableWithoutFeedback onPress={onCancel}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>
      <Animated.View style={[styles.sheetPanel, { backgroundColor: T.s1, borderColor: T.border, transform: [{ translateY: Animated.add(slideAnim, dragY) }] }]}>
        <View style={styles.sheetHandle} {...panHandlers}>
          <View style={[styles.sheetHandleBar, { backgroundColor: T.s3 }]} />
        </View>
        <View style={[styles.sheetContent, { paddingBottom: 28 }]}>
          {/* Selected range display — tap to choose which end to set */}
          <View style={styles.calRangeDisplay}>
            <TouchableOpacity
              onPress={() => setPicking('start')}
              style={[styles.calRangeChip, { backgroundColor: picking === 'start' ? `${accentColor}20` : T.s2, borderColor: picking === 'start' ? accentColor : T.border }]}
              activeOpacity={0.7}>
              <Text style={[styles.calRangeChipLabel, { color: picking === 'start' ? accentColor : T.textMute, fontFamily: jks('600') }]}>FROM</Text>
              <Text style={[styles.calRangeChipDate, { color: selStart ? T.text : T.textMute, fontFamily: jks('700') }]}>{formatLabel(selStart)}</Text>
            </TouchableOpacity>
            <View style={[styles.calRangeSepLine, { backgroundColor: T.border }]} />
            <TouchableOpacity
              onPress={() => setPicking('end')}
              style={[styles.calRangeChip, { backgroundColor: picking === 'end' ? `${accentColor}20` : T.s2, borderColor: picking === 'end' ? accentColor : T.border }]}
              activeOpacity={0.7}>
              <Text style={[styles.calRangeChipLabel, { color: picking === 'end' ? accentColor : T.textMute, fontFamily: jks('600') }]}>TO</Text>
              <Text style={[styles.calRangeChipDate, { color: selEnd ? T.text : T.textMute, fontFamily: jks('700') }]}>{formatLabel(selEnd)}</Text>
            </TouchableOpacity>
          </View>

          {/* Month navigation */}
          <View style={styles.calMonthNav}>
            <TouchableOpacity onPress={prevMonth} style={[styles.calNavBtn, { backgroundColor: T.s2, borderColor: T.border }]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="chevron-left" size={16} color={T.textSub} />
            </TouchableOpacity>
            <Text style={[styles.calMonthLabel, { color: T.text, fontFamily: jks('700') }]}>{MONTH_NAMES[viewMonth]} {viewYear}</Text>
            <TouchableOpacity onPress={nextMonth} style={[styles.calNavBtn, { backgroundColor: T.s2, borderColor: T.border }]} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="chevron-right" size={16} color={T.textSub} />
            </TouchableOpacity>
          </View>

          {/* Day-of-week headers */}
          <View style={styles.calDowRow}>
            {DAY_LABELS.map(d => (
              <Text key={d} style={[styles.calDowLabel, { color: T.textMute, fontFamily: jks('600') }]}>{d}</Text>
            ))}
          </View>

          {/* Day grid */}
          <View style={styles.calGrid}>
            {cells.map((day, idx) => {
              if (!day) return <View key={`empty-${idx}`} style={styles.calCell} />;
              const { isStart, isEnd, inRange, isToday, hasItems } = getDayState(day);
              const isSelected = isStart || isEnd;
              const cellBg = isSelected ? accentColor : inRange ? `${accentColor}22` : 'transparent';
              const textColor = isSelected ? '#fff' : inRange ? accentColor : T.text;
              return (
                <TouchableOpacity
                  key={day.getTime()}
                  onPress={() => handleDayPress(day)}
                  style={[styles.calCell, { backgroundColor: cellBg, borderRadius: isSelected ? 10 : inRange ? 0 : 0 }]}
                  activeOpacity={0.7}>
                  <Text style={[styles.calDayText, { color: textColor, fontFamily: jks(isSelected ? '700' : '400') }]}>{day.getDate()}</Text>
                  {isToday && !isSelected && <View style={[styles.calTodayDot, { backgroundColor: accentColor }]} />}
                  {hasItems && !isSelected && <View style={[styles.calItemDot, { backgroundColor: inRange ? accentColor : T.textMute }]} />}
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Actions */}
          <View style={[styles.sheetActions, { marginTop: 16 }]}>
            <TouchableOpacity onPress={clear} style={[styles.sheetCancelBtn, { backgroundColor: T.s2, borderColor: T.border }]}>
              <Text style={[styles.sheetCancelLabel, { color: T.textSub, fontFamily: jks('600') }]}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={apply}
              style={[styles.sheetSaveBtn, { backgroundColor: accentColor, opacity: canApply ? 1 : 0.4 }]}
              disabled={!canApply}>
              <Text style={[styles.sheetSaveLabel, { fontFamily: jks('700') }]}>Apply</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Animated.View>
    </Modal>
  );
}

// ─── Archive ──────────────────────────────────────────────────────────────────

interface ArchiveProps {
  archive: ArchivedTask[];
  setArchive: (fn: (prev: ArchivedTask[]) => ArchivedTask[]) => void;
  accentColor: string;
  lists: TaskList[];
  activeListId: string;
  setListTasks: (listId: string, fn: (prev: Task[]) => Task[]) => void;
  onRestoreSharedArchiveItem?: (listId: string, archiveId: string, item: { text: string; tier: Tier; createdAt?: number }) => Promise<void>;
  onDeleteSharedArchiveItem?: (listId: string, archiveId: string) => Promise<void>;
  collapsedGroups: CollapsedGroups;
  setCollapsedGroup: (key: string, collapsed: boolean) => void;
}

const ARCHIVE_ALL_FILTER = '__all__';
const ONE_WEEK_MS = 7 * 86400000;

function weekLabel(weekStart: number): string {
  const now = startOfWeekMonday(Date.now());
  if (weekStart === now) return 'This Week';
  if (weekStart === now - ONE_WEEK_MS) return 'Last Week';
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const end = new Date(weekStart + 6 * 86400000);
  return `${fmt(new Date(weekStart))} – ${fmt(end)}`;
}

function archiveDayLabel(dayStart: number): string {
  const today = startOfDay(Date.now());
  if (dayStart === today) return 'Today';
  if (dayStart === today - 86400000) return 'Yesterday';
  return new Date(dayStart).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function Archive({ archive, setArchive, accentColor, lists, activeListId, setListTasks, onRestoreSharedArchiveItem, onDeleteSharedArchiveItem, collapsedGroups, setCollapsedGroup }: ArchiveProps) {
  const T = useT();
  const TIERS = TIERS_DEF(T);
  const insets = useSafeAreaInsets();
  const [sortMode, setSortMode] = useState<SortMode>('week');
  const [rangeStart, setRangeStart] = useState<Date | null>(null);
  const [rangeEnd, setRangeEnd] = useState<Date | null>(null);
  const [calOpen, setCalOpen] = useState(false);
  const [listFilter, setListFilter] = useState<string>(activeListId);
  const [confirmNode, confirm] = useConfirm(accentColor);
  const pillScrollRef = useRef<any>(null);
  const pillLayoutsRef = useRef<Record<string, { x: number; width: number }>>({});
  const [pillViewportWidth, setPillViewportWidth] = useState(0);
  const privateArchiveCount = useMemo(() => archive.filter(item => !item.sharedListId).length, [archive]);

  const thisWeekStart = startOfWeekMonday(Date.now());
  const lastWeekStart = thisWeekStart - ONE_WEEK_MS;

  const archiveGroupKey = (scope: 'week' | 'day', start: number) => `archive:${listFilter}:${scope}:${start}`;
  const isCollapsed = (scope: 'week' | 'day', start: number) => {
    const defaultCollapsed = scope === 'week' ? start < lastWeekStart : start < startOfDay(Date.now() - ONE_WEEK_MS);
    return collapsedGroups[archiveGroupKey(scope, start)] ?? defaultCollapsed;
  };
  const toggleCollapse = (scope: 'week' | 'day', start: number) => setCollapsedGroup(archiveGroupKey(scope, start), !isCollapsed(scope, start));

  const centerSelectedPill = useCallback((id: string) => {
    const layout = pillLayoutsRef.current[id];
    if (!layout || !pillViewportWidth || !pillScrollRef.current) return;
    const x = Math.max(0, layout.x + layout.width / 2 - pillViewportWidth / 2);
    pillScrollRef.current.scrollTo({ x, animated: true });
  }, [pillViewportWidth]);

  useEffect(() => {
    const timer = setTimeout(() => centerSelectedPill(listFilter), 60);
    return () => clearTimeout(timer);
  }, [centerSelectedPill, listFilter, lists.length]);

  const rememberPillLayout = useCallback((id: string) => (event: any) => {
    pillLayoutsRef.current[id] = event.nativeEvent.layout;
    if (id === listFilter) setTimeout(() => centerSelectedPill(id), 0);
  }, [centerSelectedPill, listFilter]);

  const handleRestore = useCallback((item: ArchivedTask) => {
    if (item.sharedListId) {
      if (!onRestoreSharedArchiveItem) return;
      onRestoreSharedArchiveItem(item.sharedListId, String(item.id), {
        text: item.text,
        tier: item.tier,
        createdAt: item.createdAt,
      }).catch(() => {});
      return;
    }
    const targetListId = (item.listId && lists.some(l => l.id === item.listId)) ? item.listId : activeListId;
    const restored: Task = { id: Date.now(), text: item.text, tier: item.tier, createdAt: Date.now(), reminder: item.reminder };
    setListTasks(targetListId, ts => [restored, ...ts]);
    setArchive(a => a.filter(a => a.id !== item.id));
    if (restored.reminder) scheduleRemindersBatch([restored], () => {});
  }, [lists, activeListId, setListTasks, setArchive, onRestoreSharedArchiveItem]);

  const handleDeleteShared = useCallback((item: ArchivedTask) => {
    if (!item.sharedListId || !onDeleteSharedArchiveItem) return;
    confirm({
      title: 'Delete Archived Task',
      message: `Delete "${item.text}" from the shared archive?`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        onDeleteSharedArchiveItem(item.sharedListId!, String(item.id)).catch(() => {});
      },
    });
  }, [confirm, onDeleteSharedArchiveItem]);

  const listScoped = useMemo(() => {
    if (listFilter === ARCHIVE_ALL_FILTER) return archive;
    return archive.filter(item => (item.listId || DEFAULT_LIST_ID) === listFilter);
  }, [archive, listFilter]);

  const filtered = useMemo(() => {
    if (sortMode !== 'range' || !rangeStart || !rangeEnd) return listScoped;
    const lo = rangeStart.getTime();
    const hi = rangeEnd.getTime() + 86399999;
    return listScoped.filter(item => item.completedAt >= lo && item.completedAt <= hi);
  }, [listScoped, sortMode, rangeStart, rangeEnd]);

  const activeDates = useMemo(() => {
    const s = new Set<string>();
    listScoped.forEach(item => s.add(toDateKey(new Date(item.completedAt))));
    return s;
  }, [listScoped]);

  const sortedByTier = (items: ArchivedTask[]) => [...items].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);

  const rangeLabel = (() => {
    if (!rangeStart || !rangeEnd) return 'Date Range';
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${fmt(rangeStart)} – ${fmt(rangeEnd)}`;
  })();

  // Match the list-name pill style: filled-accent when selected, transparent + muted border
  // when unselected. Same rules as the lists pill row above so the selected state is
  // unambiguous.
  const sortBtn = (id: SortMode, label: string) => {
    const sel = sortMode === id;
    return (
      <TouchableOpacity
        key={id}
        activeOpacity={0.7}
        onPress={() => {
          setSortMode(id);
          if (id === 'range') setCalOpen(true);
        }}
        style={[styles.listPill, { backgroundColor: sel ? accentColor : 'transparent', borderColor: sel ? accentColor : T.borderMid }]}>
        <Text style={[styles.listPillLabel, { color: sel ? readableOn(accentColor) : T.textSub, fontFamily: jks(sel ? '700' : '500') }]}>{label}</Text>
      </TouchableOpacity>
    );
  };

  let content: React.ReactNode;
  if (listScoped.length === 0 && archive.length > 0) {
    content = (
      <View style={styles.emptyState}>
        <View style={[styles.emptyIcon, { backgroundColor: T.s2 }]}><Icon name="archive" size={22} color={T.textMute} /></View>
        <Text style={[styles.emptyText, { color: T.textMute, fontFamily: jks('400') }]}>Nothing in this list yet</Text>
      </View>
    );
  } else if (archive.length === 0) {
    content = (
      <View style={styles.emptyState}>
        <View style={[styles.emptyIcon, { backgroundColor: T.s2 }]}><Icon name="archive" size={22} color={T.textMute} /></View>
        <Text style={[styles.emptyText, { color: T.textMute, fontFamily: jks('400') }]}>Nothing archived yet</Text>
      </View>
    );
  } else if (filtered.length === 0) {
    content = (
      <View style={styles.emptyState}>
        <View style={[styles.emptyIcon, { backgroundColor: T.s2 }]}><Icon name="archive" size={22} color={T.textMute} /></View>
        <Text style={[styles.emptyText, { color: T.textMute, fontFamily: jks('400') }]}>No matches in range</Text>
      </View>
    );
  } else {
    const scope: 'week' | 'day' = sortMode === 'day' ? 'day' : 'week';
    const groups: Record<number, ArchivedTask[]> = {};
    filtered.forEach(item => {
      const groupStart = scope === 'day' ? startOfDay(item.completedAt) : startOfWeekMonday(item.completedAt);
      if (!groups[groupStart]) groups[groupStart] = [];
      groups[groupStart].push(item);
    });
    const sortedGroups = Object.keys(groups).map(Number).sort((a, b) => b - a);
    content = sortedGroups.map(groupStart => {
      const items = scope === 'day'
        ? [...groups[groupStart]].sort((a, b) => b.completedAt - a.completedAt)
        : sortedByTier(groups[groupStart]);
      const label = scope === 'day' ? archiveDayLabel(groupStart) : weekLabel(groupStart);
      const open = !isCollapsed(scope, groupStart);
      return (
        <View key={`${scope}_${groupStart}`} style={{ marginBottom: 8 }}>
          <TouchableOpacity
            onPress={() => toggleCollapse(scope, groupStart)}
            activeOpacity={0.7}
            style={[styles.archiveWeekHeader, { borderColor: T.border }]}>
            <Text style={[styles.archiveGroupLabel, { color: T.textMute, fontFamily: jks('700'), paddingHorizontal: 0, paddingBottom: 0 }]}>{label}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[styles.archiveWeekCount, { color: T.textMute, fontFamily: jks('400') }]}>{items.length}</Text>
              <Feather name={open ? 'chevron-up' : 'chevron-down'} size={14} color={T.textMute} />
            </View>
          </TouchableOpacity>
          {open && items.map(item => (
            <ArchiveItem key={`${item.sharedListId || 'private'}_${item.id}`} item={item} tiers={TIERS} accentColor={accentColor} onRestore={handleRestore} onDeleteShared={handleDeleteShared} />
          ))}
        </View>
      );
    });
  }

  return (
    <>
    <ScrollView style={[styles.screen, { backgroundColor: T.bg }]} showsVerticalScrollIndicator={false}>
      <View style={[styles.archiveHeader, { paddingTop: Math.max(18, 18 + insets.top) }]}>
        <Text style={[styles.screenHeading, { color: T.text, fontFamily: jks('800') }]}>Archive</Text>
        <Text style={[styles.archiveCount, { color: T.textMute, fontFamily: jks('400') }]}>
          {listScoped.length} completed task{listScoped.length !== 1 ? 's' : ''}
          {listFilter !== ARCHIVE_ALL_FILTER && lists.length > 1 ? ` in ${lists.find(l => l.id === listFilter)?.name || ''}` : ''}
        </Text>
        {lists.length > 1 && (
          <ScrollView
            ref={pillScrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            onLayout={(event) => setPillViewportWidth(event.nativeEvent.layout.width)}
            contentContainerStyle={styles.listPillRowContent}
            style={[styles.listPillRow, { marginTop: 10 }]}>
            <TouchableOpacity
              activeOpacity={0.7}
              onLayout={rememberPillLayout(ARCHIVE_ALL_FILTER)}
              onPress={() => setListFilter(ARCHIVE_ALL_FILTER)}
              style={[styles.listPill, { backgroundColor: listFilter === ARCHIVE_ALL_FILTER ? accentColor : 'transparent', borderColor: listFilter === ARCHIVE_ALL_FILTER ? accentColor : T.borderMid }]}>
              <Text style={[styles.listPillLabel, { color: listFilter === ARCHIVE_ALL_FILTER ? readableOn(accentColor) : T.textSub, fontFamily: jks(listFilter === ARCHIVE_ALL_FILTER ? '700' : '500') }]}>
                All Lists
              </Text>
            </TouchableOpacity>
            {lists.map(l => {
              const sel = listFilter === l.id;
              const tint = l.color || accentColor;
              return (
                <TouchableOpacity
                  key={l.id}
                  activeOpacity={0.7}
                  onLayout={rememberPillLayout(l.id)}
                  onPress={() => setListFilter(l.id)}
                  style={[styles.listPill, { backgroundColor: sel ? tint : 'transparent', borderColor: sel ? tint : T.borderMid }]}>
                  <Text style={[styles.listPillLabel, { color: sel ? readableOn(tint) : T.textSub, fontFamily: jks(sel ? '700' : '500') }]} numberOfLines={1}>
                    {l.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
        <View style={styles.sortRow}>
          {sortBtn('week', 'Week')}
          {sortBtn('day', 'Day')}
          {sortBtn('range', rangeLabel)}
          <View style={{ flex: 1 }} />
          {privateArchiveCount > 0 && (
            <TouchableOpacity
              onPress={() => confirm({
                title: 'Clear All Archive',
                message: 'This permanently removes every archived task. This cannot be undone.',
                confirmLabel: 'Clear All',
                destructive: true,
                onConfirm: () => setArchive(() => []),
              })}
              style={[styles.groceryClearPill, { borderColor: `${accentColor}55` }]}
              activeOpacity={0.7}>
              <Text style={[styles.listPillLabel, { color: accentColor, fontFamily: jks('500') }]}>Clear all</Text>
            </TouchableOpacity>
          )}
        </View>
        {sortMode === 'range' && rangeStart && rangeEnd && (
          <TouchableOpacity onPress={() => setCalOpen(true)} style={[styles.calRangeEditRow, { borderColor: `${accentColor}40` }]}>
            <Feather name="calendar" size={12} color={accentColor} />
            <Text style={[styles.calRangeEditLabel, { color: accentColor, fontFamily: jks('600') }]}>
              {rangeLabel} — tap to change
            </Text>
          </TouchableOpacity>
        )}
        {calOpen && (
          <CalendarSheet
            startDate={rangeStart}
            endDate={rangeEnd}
            accentColor={accentColor}
            activeDates={activeDates}
            onApply={(s, e) => { setRangeStart(s); setRangeEnd(e); setCalOpen(false); }}
            onClear={() => { setRangeStart(null); setRangeEnd(null); setCalOpen(false); setSortMode('week'); }}
            onCancel={() => setCalOpen(false)}
          />
        )}
        <View style={[styles.divider, { backgroundColor: T.border }]} />
      </View>
      {content}
    </ScrollView>
    {confirmNode}
    </>
  );
}

interface ArchiveItemProps {
  item: ArchivedTask;
  tiers: { id: Tier; label: string; color: string; bg: string }[];
  accentColor: string;
  onRestore: (item: ArchivedTask) => void;
  onDeleteShared: (item: ArchivedTask) => void;
}

function ArchiveItem({ item, tiers, accentColor, onRestore, onDeleteShared }: ArchiveItemProps) {
  const T = useT();
  const tier = tiers.find(t => t.id === item.tier)!;
  const dayLabel = new Date(item.completedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeLabel = new Date(item.completedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const completedLabel = `${dayLabel} at ${timeLabel}`;
  const metaLabel = item.sharedListName
    ? `${completedLabel} - ${item.sharedListName}${item.archivedByInitial ? ` - ${item.archivedByInitial}` : ''}`
    : completedLabel;
  return (
    <View style={[styles.archiveItem, { backgroundColor: T.s1, borderLeftColor: `${tier.color}40` }]}>
      <View style={[styles.archiveItemCheck, { backgroundColor: `${tier.color}20`, borderColor: `${tier.color}60` }]}>
        <Icon name="check" size={10} color={tier.color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.archiveItemText, { color: T.textSub, fontFamily: jks('400') }]}>{item.text}</Text>
        <Text style={[styles.archiveItemDay, { color: T.textMute, fontFamily: jks('400') }]}>{metaLabel}</Text>
      </View>
      {item.sharedListId ? (
        <>
        <TouchableOpacity onPress={() => onRestore(item)} style={styles.restoreBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Icon name="restore" size={15} color={accentColor} />
        </TouchableOpacity>
        {item.sharedCanDelete ? (
          <TouchableOpacity onPress={() => onDeleteShared(item)} style={styles.restoreBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Icon name="trash" size={15} color={accentColor} />
          </TouchableOpacity>
        ) : null}
        </>
      ) : (
        <TouchableOpacity onPress={() => onRestore(item)} style={styles.restoreBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Icon name="restore" size={15} color={accentColor} />
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────

interface SettingsProps {
  accent: string;
  apiKey: string; setApiKey: (v: string) => void;
  hasApiKey: boolean; setHasApiKey: (v: boolean) => void;
  personalContext: string; setPersonalContext: (v: string) => void;
  autoClear: AutoClear; setAutoClear: (v: AutoClear) => void;
  darkMode: boolean; setDarkMode: (v: boolean) => void;
  accentLight: string | null; accentDark: string | null;
  setAccentLight: (v: string | null) => void; setAccentDark: (v: string | null) => void;
  themeId: string; setThemeId: (v: string) => void;
  widgetThemeId: WidgetThemeId; setWidgetThemeId: (v: WidgetThemeId) => void;
  widgetClear: boolean; setWidgetClear: (v: boolean) => void;
  widgetShorthand: boolean; setWidgetShorthand: (v: boolean) => void;
  widgetCustomColors: WidgetCustomColors; setWidgetCustomColors: (v: WidgetCustomColors) => void;
  widgetMicSide: WidgetMicSide; setWidgetMicSide: (v: WidgetMicSide) => void;
  customThemeDrafts: (CustomThemeDraft | null)[]; setCustomThemeDrafts: (drafts: (CustomThemeDraft | null)[]) => void;
  onClearArchive: () => void;
  onReplayOnboarding: () => void;
  calendarConflictsEnabled: boolean;
  setCalendarConflictsEnabled: (enabled: boolean) => void;
  onRequestCalendarConflictAccess: () => Promise<boolean>;
}

function Toggle({ value, onChange, accent }: { value: boolean; onChange: (v: boolean) => void; accent: string }) {
  const T = useT();
  return (
    <TouchableOpacity onPress={() => onChange(!value)} activeOpacity={0.8}
      style={[styles.toggle, { backgroundColor: value ? accent : T.s3, borderColor: value ? accent : T.border }]}>
      <View style={[styles.toggleKnob, { backgroundColor: value ? '#fff' : T.textSub, left: value ? 20 : 2 }]} />
    </TouchableOpacity>
  );
}

function SettingsSection({ title }: { title: string }) {
  const T = useT();
  return <Text style={[styles.settingsSection, { color: T.textMute, fontFamily: jks('700') }]}>{title}</Text>;
}

function SettingRow({ label, subtitle, right, onPress, noBorder }: { label: string; subtitle?: string; right?: React.ReactNode; onPress?: () => void; noBorder?: boolean }) {
  const T = useT();
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={onPress ? 0.7 : 1}
      style={[styles.settingRow, { borderBottomColor: T.border, borderBottomWidth: noBorder ? 0 : 1 }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.settingRowLabel, { color: T.text, fontFamily: jks('500') }]}>{label}</Text>
        {subtitle ? <Text style={[styles.settingRowSub, { color: T.textMute, fontFamily: jks('400') }]}>{subtitle}</Text> : null}
      </View>
      {right}
    </TouchableOpacity>
  );
}

// ─── HSB Color Wheel ─────────────────────────────────────────────────────────

function hsbToHex(h: number, s: number, b: number): string {
  const hn = h / 360, sn = s / 100, bn = b / 100;
  const i = Math.floor(hn * 6);
  const f = hn * 6 - i;
  const p = bn * (1 - sn);
  const q = bn * (1 - f * sn);
  const t = bn * (1 - (1 - f) * sn);
  let r = 0, g = 0, bl = 0;
  switch (i % 6) {
    case 0: r = bn; g = t; bl = p; break;
    case 1: r = q;  g = bn; bl = p; break;
    case 2: r = p;  g = bn; bl = t; break;
    case 3: r = p;  g = q;  bl = bn; break;
    case 4: r = t;  g = p;  bl = bn; break;
    case 5: r = bn; g = p;  bl = q; break;
  }
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(bl)}`;
}

function hexToHsb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : Math.round((delta / max) * 100);
  const bv = Math.round(max * 100);
  return [h, s, bv];
}

// ─── Premium HSB Sliders ─────────────────────────────────────────────────────
// Three horizontal sliders: Hue (0-360), Saturation (0-100), Brightness (0-100).
// No gesture conflicts. Premium styling with gradient backgrounds.
interface HSBSlidersProps {
  color: string;
  onChangeRef: React.MutableRefObject<(hex: string) => void>;
  accent: string;
}

function HSBSlider({
  label,
  value,
  max,
  onChange,
  renderGradient,
  thumbColor,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (val: number) => void;
  renderGradient: () => React.ReactNode;
  thumbColor: string;
}) {
  const T = useT();
  const trackWRef = useRef(200);
  const trackPageXRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const maxRef = useRef(max);
  maxRef.current = max;
  const trackViewRef = useRef<View>(null);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => false,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (e) => {
        // Re-measure on every grant — sheet may have animated to final position
        trackViewRef.current?.measure((_x, _y, w, _h, pageX) => {
          trackWRef.current = w;
          trackPageXRef.current = pageX;
          const x = Math.max(0, Math.min(e.nativeEvent.pageX - pageX, w));
          onChangeRef.current(Math.round((x / w) * maxRef.current));
        });
      },
      onPanResponderMove: (e) => {
        const x = Math.max(0, Math.min(e.nativeEvent.pageX - trackPageXRef.current, trackWRef.current));
        onChangeRef.current(Math.round((x / trackWRef.current) * maxRef.current));
      },
    })
  ).current;

  return (
    <View style={styles.hsbSliderRow}>
      <Text style={[styles.hsbSliderLabel, { color: T.textSub }]}>{label}</Text>
      <View
        ref={trackViewRef}
        onLayout={() => {
          trackViewRef.current?.measure((_x, _y, w, _h, pageX) => {
            trackWRef.current = w;
            trackPageXRef.current = pageX;
          });
        }}
        style={[styles.hsbSliderTrack, { backgroundColor: T.s2 }]}
        {...pan.panHandlers}
      >
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden', borderRadius: 4 }]}>
          {renderGradient()}
        </View>
        <View
          pointerEvents="none"
          style={[
            styles.hsbSliderThumb,
            {
              left: `${(value / max) * 100}%`,
              borderColor: thumbColor,
            },
          ]}
        />
      </View>
    </View>
  );
}

function HSBSliders({ color, onChangeRef, accent }: HSBSlidersProps) {
  const T = useT();
  const [hsb, setHsb] = useState<[number, number, number]>(() => hexToHsb(color));
  const hsbRef = useRef<[number, number, number]>(hsb);
  const lastEmittedHexRef = useRef(color);

  // Only re-sync from prop when the color change came from outside (element switch),
  // not from our own emit — otherwise hexToHsb(gray) would reset hue to 0.
  const prevColorRef = useRef(color);
  if (prevColorRef.current !== color && color !== lastEmittedHexRef.current) {
    const next = hexToHsb(color);
    hsbRef.current = next;
    setHsb([...next]);
  }
  prevColorRef.current = color;

  const emit = (next: [number, number, number]) => {
    hsbRef.current = next;
    setHsb([...next]);
    const hex = hsbToHex(next[0], next[1], next[2]);
    lastEmittedHexRef.current = hex;
    onChangeRef.current(hex);
  };

  const [h, s, b] = hsb;

  return (
    <View style={styles.hsbSliderGroup}>
      <HSBSlider
        label="Hue"
        value={h}
        max={360}
        onChange={(val) => emit([val, hsbRef.current[1], hsbRef.current[2]])}
        renderGradient={() => (
          <View style={{ flex: 1, flexDirection: 'row' }}>
            {Array.from({ length: 36 }, (_, i) => {
              const angle = (i / 36) * 360;
              return (
                <View
                  key={i}
                  style={{
                    flex: 1,
                    backgroundColor: hsbToHex(angle, 100, 100),
                  }}
                />
              );
            })}
          </View>
        )}
        thumbColor={hsbToHex(h, 100, 100)}
      />
      <HSBSlider
        label="Saturation"
        value={s}
        max={100}
        onChange={(val) => emit([hsbRef.current[0], val, hsbRef.current[2]])}
        renderGradient={() => (
          <View style={{ flex: 1, flexDirection: 'row' }}>
            {Array.from({ length: 20 }, (_, i) => {
              const sat = ((i + 1) / 20) * 100;
              return (
                <View
                  key={i}
                  style={{
                    flex: 1,
                    backgroundColor: hsbToHex(h, sat, b),
                  }}
                />
              );
            })}
          </View>
        )}
        thumbColor={hsbToHex(h, s, b)}
      />
      <HSBSlider
        label="Brightness"
        value={b}
        max={100}
        onChange={(val) => emit([hsbRef.current[0], hsbRef.current[1], val])}
        renderGradient={() => (
          <View style={{ flex: 1, flexDirection: 'row' }}>
            {Array.from({ length: 20 }, (_, i) => {
              const bri = ((i + 1) / 20) * 100;
              return (
                <View
                  key={i}
                  style={{
                    flex: 1,
                    backgroundColor: hsbToHex(h, s, bri),
                  }}
                />
              );
            })}
          </View>
        )}
        thumbColor={hsbToHex(h, s, b)}
      />
    </View>
  );
}


// Horizontal scroll container with: always-visible custom scrollbar, and a
// "Swipe for more" pulse that appears after 3s of inactivity.
function ScrollableCardBox({ T, accent, children }: { T: ThemeTokens; accent: string; children: React.ReactNode }) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const [contentW, setContentW] = useState(0);
  const [viewW, setViewW] = useState(0);
  const [hintVisible, setHintVisible] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulse = useRef(new Animated.Value(0)).current;
  const pulseLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  const scheduleHint = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    setHintVisible(false);
    idleTimerRef.current = setTimeout(() => setHintVisible(true), 3000);
  };

  useEffect(() => {
    scheduleHint();
    return () => { if (idleTimerRef.current) clearTimeout(idleTimerRef.current); };
  }, []);

  useEffect(() => {
    if (hintVisible) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
        ]),
      );
      pulseLoopRef.current = loop;
      loop.start();
      return () => { loop.stop(); pulse.setValue(0); };
    } else {
      pulse.setValue(0);
    }
  }, [hintVisible, pulse]);

  const scrollable = contentW > viewW + 1;
  // Thumb width proportional to viewport / content. Track is the full box width.
  const thumbWidth = scrollable && contentW > 0 ? Math.max(24, (viewW / contentW) * viewW) : 0;
  const thumbTranslateX = scrollable
    ? scrollX.interpolate({
        inputRange: [0, Math.max(1, contentW - viewW)],
        outputRange: [0, Math.max(0, viewW - thumbWidth)],
        extrapolate: 'clamp',
      })
    : new Animated.Value(0);

  const hintOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });
  const hintSlide = pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 4] });

  return (
    <View style={[styles.cardScrollBox, { borderColor: T.border, backgroundColor: T.s2 }]}>
      <Animated.ScrollView horizontal
        contentContainerStyle={styles.cardScrollBoxContent}
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onContentSizeChange={(w) => setContentW(w)}
        onLayout={e => setViewW(e.nativeEvent.layout.width)}
        onScrollBeginDrag={() => { setHintVisible(false); if (idleTimerRef.current) clearTimeout(idleTimerRef.current); }}
        onScrollEndDrag={scheduleHint}
        onMomentumScrollEnd={scheduleHint}
        onTouchStart={() => { setHintVisible(false); if (idleTimerRef.current) clearTimeout(idleTimerRef.current); }}
        onTouchEnd={scheduleHint}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: false })}>
        {children}
      </Animated.ScrollView>
      {scrollable ? (
        <View pointerEvents="none" style={styles.scrollbarRow}>
          <Animated.View style={[styles.scrollHintInline, { opacity: hintOpacity, transform: [{ translateX: hintSlide }] }]}>
            <Text style={[styles.scrollHint, { color: accent, fontFamily: jks('700') }]}>Swipe</Text>
            <Feather name="chevron-right" size={11} color={accent} />
          </Animated.View>
          <View style={[styles.scrollbarTrack, { backgroundColor: T.border }]}>
            <Animated.View style={[styles.scrollbarThumb, { backgroundColor: accent, width: thumbWidth, transform: [{ translateX: thumbTranslateX }] }]} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

// Mini faithful preview of the task screen — used inside theme/accent cards so
// users see exactly what they'll get instead of abstract dots.
// activeEl: when set (custom theme editor), overlays a highlight on the matching zone.
function MiniMockupPreview({ v, accent, width }: { v: ThemeTokens; accent: string; width?: number }) {
  return (
    <View style={[styles.miniPreview, { backgroundColor: v.bg, borderColor: v.border, ...(width ? { width } : {}) }]}>
      <View style={styles.miniHeaderRow}>
        <Text style={[styles.miniTitle, { color: v.text, fontFamily: jks('800') }]} numberOfLines={1}>Tasks</Text>
        <View style={[styles.miniHeaderEditBtn, { backgroundColor: `${accent}14`, borderColor: `${accent}55` }]}>
          <Icon name="pencil" size={7} color={accent} strokeWidth={1.6} />
        </View>
        <Text style={[styles.miniCount, { color: v.textMute, fontFamily: jks('400') }]} numberOfLines={1}>2</Text>
      </View>
      <Text style={[styles.miniDate, { color: v.textMute, fontFamily: jks('400') }]} numberOfLines={1}>Friday, May 1</Text>
      <View style={styles.miniPillRow}>
        <View style={[styles.miniPill, { backgroundColor: `${v.secondary}30`, borderColor: `${accent}66` }]}>
          <Text style={[styles.miniPillLabel, { color: accent, fontFamily: jks('700') }]} numberOfLines={1}>Tasks</Text>
        </View>
        <View style={[styles.miniPill, { backgroundColor: v.s2, borderColor: `${accent}30` }]}>
          <Text style={[styles.miniPillLabel, { color: v.textSub, fontFamily: jks('500') }]} numberOfLines={1}>Work</Text>
        </View>
      </View>
      <View style={[styles.miniDivider, { backgroundColor: v.border }]} />
      <View style={styles.miniTierRow}>
        <View style={[styles.miniTierDot, { backgroundColor: v.high }]} />
        <Text style={[styles.miniTierLabel, { color: v.high, fontFamily: jks('700') }]}>HIGH</Text>
        <Text style={[styles.miniTierCount, { color: v.textMute, fontFamily: jks('600') }]}>1</Text>
      </View>
      <View style={[styles.miniTaskRow, { backgroundColor: v.s2 }]}>
        <View style={[styles.miniTaskBar, { backgroundColor: v.high }]} />
        <View style={[styles.miniTaskCircle, { borderColor: v.high }]}>
          <View style={[styles.miniTaskCircleDot, { backgroundColor: v.high }]} />
        </View>
        <View style={[styles.miniTaskText, { backgroundColor: `${v.textMute}55` }]} />
        <View style={[styles.miniTaskEditBtn, { backgroundColor: `${accent}14`, borderColor: `${accent}55` }]}>
          <Icon name="pencil" size={7} color={accent} strokeWidth={1.6} />
        </View>
      </View>
    </View>
  );
}

// ─── Custom Accent Sheet ──────────────────────────────────────────────────────


// ─── Custom Theme Sheet ───────────────────────────────────────────────────────

// Group-based model: 4 user-picked anchors, each with full HSB control.
// Four anchors, each owns a coherent visual region of the UI:
//   - canvas:   page bg + every sheet/card/toast/input-bar surface (bg + s1 derived)
//   - controls: every inactive interactive thing — chips, inactive pills, sort
//               buttons, toggle-off, time spinners, all borders (s2/s3/border/borderMid derived)
//   - text:     all readable text (text + textSub/textMute derived)
//   - accent:   everything that "lights up" — active pill fill+border, save buttons,
//               toggles-on, calendar selection, reminder bell (accent + secondary derived)
// Surfaces opacity (controlsOpacity, 0–100): how solidly s1/s2/s3 fills paint
// over canvas. Borders always stay 100% solid for crisp outlines. No Highlight
// opacity — accent loudness is tuned via saturation/brightness directly.
interface CustomThemeDraft {
  canvas: string;
  controls: string;
  text: string;
  accent: string;
  controlsOpacity: number;
}

// Defaults chosen so HSB sliders open in non-zero positions for the active
// (Canvas) group — pure red H=0 S=100 B=100 so all three sliders are visibly
// at max. User drags from there to find their canvas color. Other groups stay
// in usable mid-range so no group opens with all sliders pinned to extremes.
const DEFAULT_CUSTOM_THEME_DRAFT: CustomThemeDraft = {
  canvas: '#FF0000',
  controls: '#E8E8EE',
  text: '#1A1A22',
  accent: '#9098B0',
  controlsOpacity: 100,
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clampB = (b: number) => Math.max(0, Math.min(100, b));
// Pick black or white text for legibility on a given hex fill. Uses luminance,
// not raw HSB brightness — yellow #FFFF00 is bright but needs black text.
const readableOn = (hex: string): string => {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? '#000000' : '#FFFFFF';
};
// Blend `fg` over `bg` at alpha 0..1. Returns a fully-opaque hex visually
// equivalent to fg painted at that alpha on bg. Used for custom theme
// opacity sliders so `${color}NN`-style alpha appends downstream don't
// double-apply.
const blendOver = (fg: string, bg: string, alpha: number): string => {
  const f = fg.replace('#', '');
  const b = bg.replace('#', '');
  const fr = parseInt(f.slice(0, 2), 16);
  const fg_ = parseInt(f.slice(2, 4), 16);
  const fb = parseInt(f.slice(4, 6), 16);
  const br = parseInt(b.slice(0, 2), 16);
  const bg_ = parseInt(b.slice(2, 4), 16);
  const bb = parseInt(b.slice(4, 6), 16);
  const r = Math.round(fr * alpha + br * (1 - alpha));
  const g = Math.round(fg_ * alpha + bg_ * (1 - alpha));
  const bl = Math.round(fb * alpha + bb * (1 - alpha));
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(bl)}`;
};

function widgetThemeColor(value: string, canvas: string): string {
  if (/^#[0-9a-fA-F]{8}$/.test(value) && /^#[0-9a-fA-F]{6}$/.test(canvas)) {
    const rgb = `#${value.slice(1, 7)}`;
    const alpha = parseInt(value.slice(7, 9), 16) / 255;
    return blendOver(rgb, canvas, alpha);
  }
  return value;
}

function draftToThemeDef(d: CustomThemeDraft): ThemeDef {
  const [cvH, cvS, cvB] = hexToHsb(d.canvas);
  const [ctH, ctS, ctB] = hexToHsb(d.controls);
  const [txH, txS, txB] = hexToHsb(d.text);
  const [acH, acS, acB] = hexToHsb(d.accent);

  // Dark/light mode is decided by canvas brightness.
  const isDark = cvB < 50;
  const stepDir = isDark ? +1 : -1;

  // Surfaces opacity → TRUE alpha on s1/s2/s3 fills via 8-digit hex. Color
  // and brightness stay exactly as the user picked them; only see-through-ness
  // changes. s2 (task cards) included by design — minor tradeoff: at low
  // opacity the swipe-action layers under task cards (red trash, accent check)
  // will faintly show through at rest. Borders stay solid.
  const cOp = Math.max(0, Math.min(255, Math.round((d.controlsOpacity ?? 100) / 100 * 255)));
  const aHex = cOp.toString(16).padStart(2, '0');
  const dim = (hex: string) => cOp >= 255 ? hex : `${hex}${aHex}`;

  // Canvas → bg + s1. s1 is bg shifted by a fixed delta toward the lit end so
  // sheets/cards always read as one layer above the page.
  const bg = d.canvas;
  // s1 paints modal/sheet backgrounds — must stay fully opaque or modals
  // become see-through. Only s2/s3 (task cards, chips) get the opacity.
  const s1 = hsbToHex(cvH, cvS, clampB(cvB + stepDir * 7));

  // Surfaces (key: controls) → s2 (task cards) + s3 (chips/inputs). Borders
  // come from accent below, not surfaces.
  const s2        = dim(d.controls);
  const s3        = dim(hsbToHex(ctH, ctS, clampB(ctB + stepDir * 8)));

  // Text → all three tokens equal the text anchor exactly. Brightness lerp
  // toward canvas was muddying saturated text into off-color (e.g. green text
  // anchor → muddy yellow-green textSub). Custom themes intentionally keep
  // text full-brightness everywhere; the eye reads "same color" only when
  // hex matches. Built-in themes still use brightness derivatives because
  // their text anchor is white/black where the lerp produces clean grays.
  const text     = d.text;
  const textSub  = d.text;
  const textMute = d.text;

  // Accent → accent + secondary + borders. Borders are accent-derived now
  // (not surfaces-derived) so the rim always reads against the surface fill.
  // Fixed strength — no opacity slider; borders should always be
  // pretty strong" call. Secondary tints active pill fill (used as
  // `${secondary}30`); same hue as accent, lower sat, brightness pulled
  // toward canvas so the 30% alpha sits well on the bg.
  const accent    = d.accent;
  const secondary = hsbToHex(acH, acS * 0.55, lerp(acB, cvB, 0.35));
  // borderMid = active rim weight (used by active list pill at 2px).
  // border    = inactive rim weight (used everywhere else, including
  //             dividers — slightly softer so dividers don't shout).
  const border    = `${accent}55`;
  const borderMid = accent;

  const tokens: ThemeTokens = {
    bg, s1, s2, s3,
    border, borderMid,
    text, textSub, textMute,
    secondary,
    ...(isDark ? TIER_TOKENS_DARK : TIER_TOKENS_LIGHT),
  };
  return {
    id: 'custom', name: 'Custom',
    swatchLight: s1, swatchDark: bg,
    light: tokens, dark: tokens,
    defaultAccentLight: accent, defaultAccentDark: accent,
    secondaryLight: secondary, secondaryDark: secondary,
  };
}

function ScaledPreview({ accent, theme }: { accent: string; theme: ThemeTokens }) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const targetW = SCREEN_WIDTH - 32;
  const targetH = 190;
  const scale = nat ? Math.min(targetW / nat.w, targetH / nat.h) : 1;
  const scaledW = nat ? nat.w * scale : targetW;
  const scaledH = nat ? nat.h * scale : targetH;
  const tx = nat ? (nat.w * scale - nat.w) / 2 : 0;
  const ty = nat ? (nat.h * scale - nat.h) / 2 : 0;

  return (
    <View style={{ alignSelf: 'center', marginVertical: 10, width: scaledW, height: scaledH, overflow: 'hidden' }}>
      <View
        style={{ position: 'absolute', opacity: nat ? 1 : 0, transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setNat({ w: width, h: height });
        }}
      >
        <MiniMockupPreview v={theme} accent={accent} width={200} />
      </View>
    </View>
  );
}

// Custom-theme-only preview. Renders a faithful slice of the live UI using
// the EXACT styling rules of the live components (TaskRow, ListPillRow,
// InputBar, TabBar) so what the user sees here matches what ships when they
// hit Save. Don't reuse MiniMockupPreview — that one is shared with built-in
// theme cards and tuned for those tokens. This component is the source of
// truth for "how custom theme tokens render in the wild".
function CustomThemePreview({ theme, accent }: { theme: ThemeTokens; accent: string }) {
  const v = theme;
  return (
    <View style={{ marginHorizontal: 12, marginVertical: 10, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: v.border, backgroundColor: v.bg }}>
      {/* Header: title + edit + count + date */}
      <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: v.text, fontFamily: jks('800'), fontSize: 18 }}>Tasks</Text>
          <View style={{ width: 18, height: 18, borderRadius: 5, borderWidth: 1, backgroundColor: `${accent}14`, borderColor: `${accent}55`, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="pencil" size={9} color={accent} strokeWidth={1.6} />
          </View>
          <Text style={{ color: v.textMute, fontFamily: jks('400'), fontSize: 10, marginLeft: 'auto' }}>2 tasks</Text>
        </View>
        <Text style={{ color: v.textMute, fontFamily: jks('400'), fontSize: 10, marginTop: 2 }}>Saturday, May 2</Text>
      </View>
      {/* List pill row: active + inactive + new */}
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 8 }}>
        <View style={{ height: 22, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, backgroundColor: accent, borderColor: accent, justifyContent: 'center' }}>
          <Text style={{ color: readableOn(accent), fontFamily: jks('700'), fontSize: 10 }}>Tasks</Text>
        </View>
        <View style={{ height: 22, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, backgroundColor: 'transparent', borderColor: v.borderMid, justifyContent: 'center' }}>
          <Text style={{ color: v.textSub, fontFamily: jks('500'), fontSize: 10 }}>Work</Text>
        </View>
        <View style={{ height: 22, paddingHorizontal: 8, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', backgroundColor: v.s2, borderColor: `${accent}40`, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="plus" size={11} color={v.textSub} />
        </View>
      </View>
      {/* Divider + tier header + task card */}
      <View style={{ height: 1, backgroundColor: v.border, marginHorizontal: 12 }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingTop: 8 }}>
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: v.high }} />
        <Text style={{ color: v.high, fontFamily: jks('700'), fontSize: 9, letterSpacing: 1 }}>HIGH</Text>
        <Text style={{ color: v.textMute, fontFamily: jks('600'), fontSize: 9, marginLeft: 2 }}>1</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: v.s2, marginHorizontal: 12, marginTop: 6, marginBottom: 8, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, borderLeftWidth: 3, borderLeftColor: v.high, gap: 8 }}>
        <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 1.2, borderColor: v.high, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: v.high }} />
        </View>
        <Text style={{ flex: 1, color: v.text, fontFamily: jks('400'), fontSize: 10 }} numberOfLines={1}>Sample task</Text>
        <View style={{ width: 18, height: 18, borderRadius: 5, borderWidth: 1, backgroundColor: `${accent}14`, borderColor: `${accent}55`, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="pencil" size={9} color={accent} strokeWidth={1.6} />
        </View>
      </View>
      {/* Input bar: mic + AI + input + submit */}
      <View style={{ borderTopWidth: 1, borderTopColor: v.border, backgroundColor: v.s1, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', gap: 4, marginBottom: 5 }}>
          <View style={{ flex: 1, height: 22, borderRadius: 6, borderWidth: 1.5, backgroundColor: v.s3, borderColor: accent, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="mic" size={10} color={v.textSub} />
          </View>
          <View style={{ flex: 1, height: 22, borderRadius: 6, borderWidth: 1.5, backgroundColor: v.s3, borderColor: accent, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="sparkles" size={10} color={v.textSub} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center' }}>
          <View style={{ flex: 1, height: 24, borderRadius: 6, borderWidth: 1.5, backgroundColor: v.s3, borderColor: accent, paddingHorizontal: 8, justifyContent: 'center' }}>
            <Text style={{ color: v.textMute, fontFamily: jks('400'), fontSize: 9 }}>Add a task...</Text>
          </View>
          <View style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: accent, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="plus" size={10} color="#fff" />
          </View>
        </View>
      </View>
      {/* Bottom tab bar */}
      <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: v.border, backgroundColor: v.s1, paddingTop: 5, paddingBottom: 6 }}>
        {[
          { icon: 'list', label: 'Tasks', active: true },
          { icon: 'archive', label: 'Archive', active: false },
          { icon: 'settings', label: 'Settings', active: false },
        ].map(t => (
          <View key={t.label} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
            <Icon name={t.icon} size={13} color={t.active ? accent : v.textMute} />
            <Text style={{ color: t.active ? accent : v.textMute, fontFamily: jks(t.active ? '700' : '500'), fontSize: 8 }}>{t.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

interface CustomThemeSheetProps {
  initialDraft: CustomThemeDraft;
  onSave: (draft: CustomThemeDraft) => void;
  onClose: () => void;
}

type CustomThemeGroup = 'canvas' | 'controls' | 'text' | 'accent';

const CUSTOM_GROUP_LABELS: Record<CustomThemeGroup, string> = {
  canvas:   'Canvas',
  controls: 'Surfaces',
  text:     'Text',
  accent:   'Highlight',
};

const CUSTOM_GROUP_HINTS: Record<CustomThemeGroup, string> = {
  canvas:   'Page background, sheets, cards & toasts',
  controls: 'Inactive pills, chips, sort buttons, time spinners & all borders',
  text:     'Task titles, list names, headings & all readable text',
  accent:   'Active list pill, save buttons, toggles, calendar selection & highlights',
};

function CustomThemeSheet({ initialDraft, onSave, onClose }: CustomThemeSheetProps) {
  const slide = useRef(new Animated.Value(0)).current;
  const { dragY, panHandlers } = useSwipeToDismiss(onClose);
  const [draft, setDraft] = useState<CustomThemeDraft>(initialDraft);
  const [activeGroup, setActiveGroupState] = useState<CustomThemeGroup>('canvas');
  const activeGroupRef = useRef<CustomThemeGroup>('canvas');
  const draftRef = useRef<CustomThemeDraft>(initialDraft);

  useEffect(() => {
    Animated.timing(slide, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [slide]);

  const previewTheme = useMemo(() => draftToThemeDef(draft), [draft]);
  const chrome = previewTheme.dark;
  const isDarkChrome = hexToHsb(draft.canvas)[2] < 50;
  const handleSave = () => { onSave(draftRef.current); onClose(); };

  const setActiveGroup = (g: CustomThemeGroup) => {
    activeGroupRef.current = g;
    setActiveGroupState(g);
  };

  const onChangeRef = useRef((hex: string) => {
    const g = activeGroupRef.current;
    const next = { ...draftRef.current, [g]: hex };
    draftRef.current = next;
    setDraft(next);
  });

  const groupColor = (g: CustomThemeGroup) => draft[g];

  const groups: CustomThemeGroup[] = ['canvas', 'controls', 'text', 'accent'];

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>
      <Animated.View
        style={[styles.sheetPanel, styles.customThemeSheet, {
          backgroundColor: chrome.bg, borderColor: chrome.borderMid, flex: 1,
          transform: [{ translateY: Animated.add(
            slide.interpolate({ inputRange: [0, 1], outputRange: [600, 0] }),
            dragY,
          ) }],
        }]}
      >
        <View style={styles.sheetHandle} {...panHandlers}>
          <View style={[styles.sheetHandleBar, { backgroundColor: isDarkChrome ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)' }]} />
        </View>
        <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={[styles.customThemeSheetTitle, { color: chrome.text, fontFamily: jks('700') }]}>Custom Theme</Text>
          <CustomThemePreview theme={chrome} accent={draft.accent} />

          {/* Group selector — 5 equal-flex pills in one row */}
          <View style={styles.customGroupGrid}>
            {groups.map(g => {
              const active = activeGroup === g;
              return (
                <TouchableOpacity
                  key={g}
                  onPress={() => setActiveGroup(g)}
                  activeOpacity={0.8}
                  style={[styles.customGroupBtn, {
                    backgroundColor: active ? previewTheme.defaultAccentDark : 'transparent',
                    borderColor: active ? previewTheme.defaultAccentDark : chrome.borderMid,
                  }]}
                >
                  <View style={[styles.customGroupSwatch, { backgroundColor: groupColor(g), borderColor: active ? 'rgba(255,255,255,0.35)' : chrome.border }]} />
                  <Text numberOfLines={1} style={[styles.customGroupLabel, {
                    color: active ? readableOn(previewTheme.defaultAccentDark) : chrome.textSub,
                    fontFamily: jks(active ? '700' : '500'),
                  }]}>
                    {CUSTOM_GROUP_LABELS[g]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Hint */}
          <Text style={[styles.customGroupHint, { color: chrome.textMute, fontFamily: jks('400') }]}>
            <Text style={{ color: previewTheme.defaultAccentDark, fontFamily: jks('600') }}>{CUSTOM_GROUP_LABELS[activeGroup]}</Text>
            {' · '}{CUSTOM_GROUP_HINTS[activeGroup]}
          </Text>

          {/* HSB sliders for active group */}
          <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
            <HSBSliders color={groupColor(activeGroup)} onChangeRef={onChangeRef} accent={previewTheme.defaultAccentDark} />
          </View>

          {/* Opacity slider — only for Surfaces. Lets the user soften loud
              surface fills against canvas without losing color vibrancy.
              Accent loudness is tuned via saturation/brightness directly. */}
          {activeGroup === 'controls' && (
            <View style={{ paddingHorizontal: 16, marginBottom: 16 }}>
              <HSBSlider
                label="Opacity"
                value={draft.controlsOpacity}
                max={100}
                onChange={(val) => {
                  const next = { ...draftRef.current, controlsOpacity: val };
                  draftRef.current = next;
                  setDraft(next);
                }}
                renderGradient={() => (
                  <View style={{ flex: 1, flexDirection: 'row' }}>
                    {Array.from({ length: 20 }, (_, i) => {
                      const a = ((i + 1) / 20);
                      return (
                        <View
                          key={i}
                          style={{
                            flex: 1,
                            backgroundColor: blendOver(draft.controls, draft.canvas, a),
                          }}
                        />
                      );
                    })}
                  </View>
                )}
                thumbColor={blendOver(draft.controls, draft.canvas, draft.controlsOpacity / 100)}
              />
            </View>
          )}

          <View style={[styles.sheetActions, { marginHorizontal: 16, marginTop: 4, marginBottom: 36 }]}>
            <TouchableOpacity onPress={onClose} style={[styles.sheetCancelBtn, { borderColor: chrome.borderMid }]}>
              <Text style={[styles.sheetCancelLabel, { color: chrome.textSub, fontFamily: jks('500') }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleSave} style={[styles.sheetSaveBtn, { backgroundColor: previewTheme.defaultAccentDark }]}>
              <Text style={[styles.sheetSaveLabel, { fontFamily: jks('700') }]}>Save theme</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

type WidgetColorGroup = 'text' | 'accent';

const WIDGET_COLOR_LABELS: Record<WidgetColorGroup, string> = {
  text: 'Text',
  accent: 'Accent',
};

function WidgetColorPreview({ colors, clear }: { colors: WidgetCustomColors; clear: boolean }) {
  const T = useT();
  return (
    <View style={{ marginHorizontal: 16, marginTop: 12, marginBottom: 16, borderRadius: 12, borderWidth: 1, borderColor: T.borderMid, backgroundColor: T.bg, padding: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: 70 }}>
        <View style={{ width: 52, height: 62, borderRadius: 18, borderWidth: clear ? 0 : 1.4, borderColor: colors.accent, backgroundColor: clear ? 'transparent' : T.s2, alignItems: 'center', justifyContent: 'center' }}>
          <Feather name="mic" size={24} color={colors.text} />
          <Ionicons name="sparkles" size={12} color={colors.accent} style={{ position: 'absolute', top: 8, right: 8 }} />
        </View>
        <View style={{ flex: 1, minHeight: 62, borderRadius: 18, borderWidth: clear ? 0 : 1, borderColor: `${colors.accent}88`, backgroundColor: clear ? 'transparent' : `${T.s2}DD`, paddingHorizontal: 14, paddingVertical: 9, justifyContent: 'space-between' }}>
          <Text numberOfLines={2} style={{ color: colors.text, fontFamily: jks('800'), fontSize: 15, lineHeight: 18 }}>Take product photo</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Text numberOfLines={1} style={{ color: colors.accent, fontFamily: jks('800'), fontSize: 11 }}>Biomed</Text>
            <Text style={{ color: `${colors.accent}AA`, fontFamily: jks('800'), fontSize: 11 }}>/</Text>
            <Text style={{ color: colors.accent, fontFamily: jks('800'), fontSize: 11 }}>Tmr 8:30p</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function WidgetColorSheet({ initialColors, clear, onSave, onClose }: { initialColors: WidgetCustomColors; clear: boolean; onSave: (colors: WidgetCustomColors) => void; onClose: () => void }) {
  const T = useT();
  const slide = useRef(new Animated.Value(0)).current;
  const { dragY, panHandlers } = useSwipeToDismiss(onClose);
  const [draft, setDraft] = useState<WidgetCustomColors>(initialColors);
  const [activeGroup, setActiveGroup] = useState<WidgetColorGroup>('text');
  const activeGroupRef = useRef<WidgetColorGroup>('text');
  const draftRef = useRef<WidgetCustomColors>(initialColors);

  useEffect(() => {
    Animated.timing(slide, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [slide]);

  const selectGroup = (group: WidgetColorGroup) => {
    activeGroupRef.current = group;
    setActiveGroup(group);
  };
  const onChangeRef = useRef((hex: string) => {
    const group = activeGroupRef.current;
    const next = { ...draftRef.current, [group]: hex };
    draftRef.current = next;
    setDraft(next);
  });
  const save = () => { onSave(draftRef.current); onClose(); };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>
      <Animated.View
        style={[styles.sheetPanel, styles.sheetCompact, {
          backgroundColor: T.s1,
          borderColor: T.border,
          transform: [{ translateY: Animated.add(
            slide.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }),
            dragY,
          ) }],
        }]}
      >
        <View style={styles.sheetHandle} {...panHandlers}>
          <View style={[styles.sheetHandleBar, { backgroundColor: T.s3 }]} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={[styles.customThemeSheetTitle, { color: T.text, fontFamily: jks('700'), marginBottom: 0 }]}>Widget Colors</Text>
          <WidgetColorPreview colors={draft} clear={clear} />
          <View style={[styles.customGroupGrid, { paddingHorizontal: 16 }]}>
            {(['text', 'accent'] as WidgetColorGroup[]).map(group => {
              const active = activeGroup === group;
              return (
                <TouchableOpacity
                  key={group}
                  onPress={() => selectGroup(group)}
                  activeOpacity={0.85}
                  style={[styles.customGroupBtn, {
                    backgroundColor: active ? draft.accent : 'transparent',
                    borderColor: active ? draft.accent : T.borderMid,
                  }]}
                >
                  <View style={[styles.customGroupSwatch, { backgroundColor: draft[group], borderColor: active ? 'rgba(255,255,255,0.35)' : T.border }]} />
                  <Text numberOfLines={1} style={[styles.customGroupLabel, {
                    color: active ? readableOn(draft.accent) : T.textSub,
                    fontFamily: jks(active ? '700' : '500'),
                  }]}>
                    {WIDGET_COLOR_LABELS[group]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={{ paddingHorizontal: 16, marginTop: 14, marginBottom: 16 }}>
            <HSBSliders color={draft[activeGroup]} onChangeRef={onChangeRef} accent={draft.accent} />
          </View>
          <View style={[styles.sheetActions, { marginHorizontal: 16, marginBottom: 24 }]}>
            <TouchableOpacity onPress={onClose} style={[styles.sheetCancelBtn, { borderColor: T.borderMid }]}>
              <Text style={[styles.sheetCancelLabel, { color: T.textSub, fontFamily: jks('500') }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={save} style={[styles.sheetSaveBtn, { backgroundColor: draft.accent }]}>
              <Text style={[styles.sheetSaveLabel, { color: readableOn(draft.accent), fontFamily: jks('700') }]}>Save colors</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

function Settings({ accent, apiKey, setApiKey, hasApiKey, setHasApiKey, personalContext, setPersonalContext, autoClear, setAutoClear, darkMode, setDarkMode, accentLight, accentDark, setAccentLight, setAccentDark, themeId, setThemeId, widgetThemeId, setWidgetThemeId, widgetClear, setWidgetClear, widgetShorthand, setWidgetShorthand, widgetCustomColors, setWidgetCustomColors, widgetMicSide, setWidgetMicSide, customThemeDrafts, setCustomThemeDrafts, onClearArchive, onReplayOnboarding, calendarConflictsEnabled, setCalendarConflictsEnabled, onRequestCalendarConflictAccess }: SettingsProps) {
  const T = useT();
  const insets = useSafeAreaInsets();
  const isPaid = useIsPaid();
  const { restorePurchases } = useIAP();
  const { user: syncUser, signingIn, signIn: doSignIn, signOut: doSignOut, error: syncError, clearError: clearSyncError } = useSync();
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState(apiKey);
  const [showUpsell, setShowUpsell] = useState(false);
  const [showDonate, setShowDonate] = useState(false);
  const [editingCustomSlot, setEditingCustomSlot] = useState<number | null>(null);
  const [showWidgetColorSheet, setShowWidgetColorSheet] = useState(false);
  const [settingsToast, setSettingsToast] = useState<string | null>(null);
  const settingsToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsScrollRef = useRef<ScrollView | null>(null);
  const [settingsKbHeight, setSettingsKbHeight] = useState(0);
  const [contextFocused, setContextFocused] = useState(false);
  const showSettingsToast = (msg: string) => {
    if (settingsToastTimer.current) clearTimeout(settingsToastTimer.current);
    setSettingsToast(msg);
    settingsToastTimer.current = setTimeout(() => setSettingsToast(null), 3000);
  };

  useEffect(() => {
    if (syncError) {
      showSettingsToast(syncError);
      clearSyncError();
    }
  }, [syncError]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setSettingsKbHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setSettingsKbHeight(0);
      setContextFocused(false);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const AUTO_CLEAR_OPTIONS: AutoClear[] = ['Never', '7 days', '30 days', '90 days'];
  const keyIsValid = isValidKey(keyDraft);
  const [confirmNode, confirm] = useConfirm(accent);
  const themeDef = getTheme(themeId);
  const currentModeAccent = darkMode ? accentDark : accentLight;
  const accentIsDefault = currentModeAccent == null;
  const hasSupportLink = !!TRIORITY_PATREON_URL || !!TRIORITY_BMAC_URL;
  const onPickAccent = (v: string) => {
    if (!isPaid) { setShowUpsell(true); return; }
    // Tapping the active accent again clears both modes back to theme defaults.
    const cur = darkMode ? accentDark : accentLight;
    const isCurrent = cur != null && cur.toLowerCase() === v.toLowerCase();
    const next = isCurrent ? null : v;
    setAccentLight(next);
    setAccentDark(next);
  };
  const onPickTheme = (id: string) => {
    if (!isPaid && id !== 'slate') { setShowUpsell(true); return; }
    setThemeId(id);
    // Picking a theme resets accents back to that theme's defaults so the user
    // gets the curated pairing instantly. They can still override afterward.
    setAccentLight(null);
    setAccentDark(null);
  };

  const saveKey = () => { if (!keyIsValid) return; setApiKey(keyDraft.trim()); setHasApiKey(true); };
  const cardStyle = [styles.settingsCard, { backgroundColor: T.s1, borderColor: T.border }];
  const toggleCalendarConflicts = async (enabled: boolean) => {
    if (!enabled) {
      setCalendarConflictsEnabled(false);
      showSettingsToast('Calendar conflict checks off');
      return;
    }
    if (!syncUser) {
      showSettingsToast('Sign in with Google first');
      return;
    }
    const ok = await onRequestCalendarConflictAccess();
    if (!ok) {
      showSettingsToast('Calendar access not enabled');
      return;
    }
    setCalendarConflictsEnabled(true);
    showSettingsToast('Calendar conflict checks on');
  };

  return (
    <>
    <ScrollView
      ref={settingsScrollRef}
      style={[styles.screen, { backgroundColor: T.bg }]}
      contentContainerStyle={{ paddingBottom: contextFocused && settingsKbHeight > 0 ? settingsKbHeight + 24 : 0 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[styles.settingsHeader, { paddingTop: Math.max(18, 18 + insets.top) }]}>
        <Text style={[styles.screenHeading, { color: T.text, fontFamily: jks('800') }]}>Settings</Text>
        <View style={[styles.divider, { backgroundColor: T.border }]} />
      </View>

      <SettingsSection title="Sync & Calendar" />
      <View style={[cardStyle, { marginBottom: 16 }]}>
        {syncUser ? (
          <View style={[styles.settingsCardInner, { borderBottomColor: T.border }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: `${accent}20`, borderWidth: 1, borderColor: `${accent}55`, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="user" size={16} color={accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[styles.settingRowLabel, { color: T.text, fontFamily: jks('600') }]}>
                  {syncUser.displayName || 'Signed in'}
                </Text>
                <Text numberOfLines={1} style={{ color: T.textSub, fontSize: 12, fontFamily: jks('400'), marginTop: 2 }}>
                  {syncUser.email}
                </Text>
              </View>
              <View style={[styles.statusPill, { backgroundColor: `${T.low}20`, borderColor: `${T.low}40` }]}>
                <View style={[styles.statusDot, { backgroundColor: T.low }]} />
                <Text style={[styles.statusLabel, { color: T.low, fontFamily: jks('700') }]}>On</Text>
              </View>
            </View>
            <Text style={{ color: T.textMute, fontSize: 12, fontFamily: jks('400'), marginTop: 10, lineHeight: 17 }}>
              Your tasks, lists, and settings sync to your Google account. Reinstalling Triority restores your data when you sign in.
            </Text>
            <TouchableOpacity
              onPress={() => {
                confirm({
                  title: 'Sign Out',
                  message: 'Your data stays on this device. It will stop syncing until you sign in again.',
                  confirmLabel: 'Sign Out',
                  destructive: false,
                  onConfirm: () => { doSignOut(); },
                });
              }}
              style={{ marginTop: 12, height: 38, borderRadius: 10, borderWidth: 1, borderColor: T.border, backgroundColor: T.s2, alignItems: 'center', justifyContent: 'center' }}
              activeOpacity={0.7}>
              <Text style={[styles.settingRowLabel, { color: T.textSub, fontFamily: jks('500'), fontSize: 13 }]}>Sign Out</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={[styles.settingsCardInner, { borderBottomColor: T.border }]}>
            <Text style={[styles.settingRowLabel, { color: T.text, fontFamily: jks('600') }]}>Back up &amp; sync your data</Text>
            <Text style={{ color: T.textMute, fontSize: 12, fontFamily: jks('400'), marginTop: 6, lineHeight: 17 }}>
              Sign in with Google to keep your tasks, lists, and settings safe across reinstalls and devices. Your data is private to your account.
            </Text>
            <TouchableOpacity
              onPress={doSignIn}
              disabled={signingIn}
              style={{ marginTop: 12, height: 44, borderRadius: 10, backgroundColor: accent, opacity: signingIn ? 0.6 : 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              activeOpacity={0.85}>
              <Icon name="logIn" size={15} color="#fff" />
              <Text style={[styles.sheetSaveLabel, { fontFamily: jks('700') }]}>
                {signingIn ? 'Signing in…' : 'Sign in with Google'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
        <SettingRow
          label="Calendar conflict checks"
          subtitle="Marks reminder tasks that overlap your Google Calendar. Triority never adds events."
          right={<Toggle value={calendarConflictsEnabled} onChange={toggleCalendarConflicts} accent={accent} />}
          noBorder
        />
      </View>

      <SettingsSection title="Appearance" />
      <View style={cardStyle}>
        <SettingRow label="Dark Mode" right={<Toggle value={darkMode} onChange={setDarkMode} accent={accent} />} />
        <View style={[styles.settingsCardInner, { borderBottomColor: T.border }]}>
          <View style={styles.appearanceLabelRow}>
            <Text style={[styles.settingRowLabel, { color: T.text, fontFamily: jks('500') }]}>Theme</Text>
            {!isPaid ? <View style={[styles.proPill, { backgroundColor: `${accent}20`, borderColor: `${accent}55` }]}><Text style={[styles.proPillLabel, { color: accent, fontFamily: jks('700') }]}>PRO</Text></View> : null}
          </View>
          <Text style={[styles.appearanceHint, { color: T.textMute, fontFamily: jks('400') }]}>
            Recolors backdrop, surfaces, and chrome.
          </Text>
          <ScrollableCardBox T={T} accent={accent}>
          <View style={styles.cardGridSingleRow}>
            {THEMES.map(th => {
              const selected = th.id === themeId;
              const variant = darkMode ? th.dark : th.light;
              const previewAccent = darkMode ? th.defaultAccentDark : th.defaultAccentLight;
              const locked = !isPaid && th.id !== 'slate';
              return (
                <TouchableOpacity key={th.id} onPress={() => onPickTheme(th.id)} activeOpacity={0.85}
                  style={[styles.previewCard, { backgroundColor: variant.s1, borderColor: selected ? T.text : variant.borderMid, borderWidth: selected ? 2 : 1 }]}>
                  <MiniMockupPreview v={variant} accent={previewAccent} />
                  <View style={styles.previewCardFooter}>
                    <Text numberOfLines={1} style={[styles.previewCardName, { color: variant.text, fontFamily: jks('700') }]}>{th.name}</Text>
                    {locked ? <Icon name="sparkles" size={11} color={variant.textMute} /> : null}
                  </View>
                </TouchableOpacity>
              );
            })}
            {/* 3 custom theme slots */}
            {[0, 1, 2].map(slot => {
              const slotId = `custom_${slot}` as string;
              const draft = customThemeDrafts[slot];
              const selected = themeId === slotId;
              const locked = !isPaid;
              if (draft) {
                const def = draftToThemeDef(draft);
                const variant = def.dark;
                return (
                  <TouchableOpacity key={slotId} activeOpacity={0.85}
                    onPress={() => { if (locked) { setShowUpsell(true); return; } setEditingCustomSlot(slot); }}
                    onLongPress={() => {
                      if (locked) return;
                      confirm({
                        title: 'Clear Custom Theme',
                        message: `Reset Custom ${slot + 1} back to an empty slot?`,
                        confirmLabel: 'Clear',
                        destructive: true,
                        onConfirm: () => {
                          const next = [...customThemeDrafts] as (typeof customThemeDrafts[0])[];
                          next[slot] = null;
                          setCustomThemeDrafts(next);
                          if (themeId === slotId) setThemeId('slate');
                        },
                      });
                    }}
                    delayLongPress={500}
                    style={[styles.previewCard, styles.previewCardEmpty, { backgroundColor: variant.s1, borderColor: selected ? T.text : `${accent}55`, borderWidth: selected ? 2 : 1 }]}
                  >
                    <MiniMockupPreview v={variant} accent={def.defaultAccentDark} />
                    <View style={styles.previewCardFooter}>
                      <Text numberOfLines={1} style={[styles.previewCardName, { color: variant.text, fontFamily: jks('700') }]}>Custom {slot + 1}</Text>
                      {locked ? <Icon name="sparkles" size={11} color={variant.textMute} /> : null}
                    </View>
                  </TouchableOpacity>
                );
              }
              // Empty slot — dotted + card
              return (
                <TouchableOpacity key={slotId} activeOpacity={0.7}
                  onPress={() => { if (locked) { setShowUpsell(true); return; } setEditingCustomSlot(slot); }}
                  style={[styles.previewCard, styles.previewCardEmpty, { borderColor: T.borderMid }]}
                >
                  <View style={styles.previewCardEmptyInner}>
                    <Text style={[styles.previewCardEmptyPlus, { color: T.textMute }]}>+</Text>
                  </View>
                  <View style={styles.previewCardFooter}>
                    <Text numberOfLines={1} style={[styles.previewCardName, { color: T.textMute, fontFamily: jks('700') }]}>Custom {slot + 1}</Text>
                    {locked ? <Icon name="sparkles" size={11} color={T.textMute} /> : null}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
          </ScrollableCardBox>
        </View>
        {/^custom_[012]$/.test(themeId) ? (
          <View style={[styles.settingsCardInner]}>
            <Text style={[styles.settingRowLabel, { color: T.text, fontFamily: jks('500'), marginBottom: 4 }]}>Accent</Text>
            <Text style={[styles.appearanceHint, { color: T.textMute, fontFamily: jks('400') }]}>
              Accent is set inside the Custom Theme editor. Long-press the card above to edit it.
            </Text>
          </View>
        ) : (
          <View style={styles.settingsCardInner}>
            <View style={styles.appearanceLabelRow}>
              <Text style={[styles.settingRowLabel, { color: T.text, fontFamily: jks('500') }]}>Accent</Text>
              {!isPaid ? <View style={[styles.proPill, { backgroundColor: `${accent}20`, borderColor: `${accent}55` }]}><Text style={[styles.proPillLabel, { color: accent, fontFamily: jks('700') }]}>PRO</Text></View> : null}
            </View>
            <Text style={[styles.appearanceHint, { color: T.textMute, fontFamily: jks('400') }]}>
              Tints borders, edit buttons, and the FAB. Applied in {darkMode ? 'dark' : 'light'} mode.
            </Text>
            <ScrollableCardBox T={T} accent={accent}>
            <View style={styles.cardGridSingleRow}>
              {(() => {
                const v = darkMode ? themeDef.dark : themeDef.light;
                const themeDefaultAccent = darkMode ? themeDef.defaultAccentDark : themeDef.defaultAccentLight;
                const cards: { color: string; label: string; isDefault: boolean }[] = [
                  { color: themeDefaultAccent, label: 'Default', isDefault: true },
                  ...ACCENT_COLORS.map(c => ({ color: c, label: ACCENT_NAMES[c] ?? '', isDefault: false })),
                ];
                return cards.map((card, i) => {
                  const selected = card.isDefault
                    ? accentIsDefault
                    : !accentIsDefault && currentModeAccent?.toLowerCase() === card.color.toLowerCase();
                  const onPress = card.isDefault
                    ? () => { if (!isPaid) { setShowUpsell(true); return; } setAccentLight(null); setAccentDark(null); }
                    : () => onPickAccent(card.color);
                  return (
                    <TouchableOpacity key={`${card.label}-${i}`} onPress={onPress} activeOpacity={0.85}
                      style={[styles.previewCard, { backgroundColor: v.s1, borderColor: selected ? T.text : v.borderMid, borderWidth: selected ? 2 : 1 }]}>
                      <MiniMockupPreview v={v} accent={card.color} />
                      <View style={styles.previewCardFooter}>
                        <View style={[styles.previewAccentSwatch, { backgroundColor: card.color }]} />
                        <Text numberOfLines={1} style={[styles.previewCardName, { color: v.text, fontFamily: jks('700') }]}>{card.label}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                });
              })()}
            </View>
            </ScrollableCardBox>
          </View>
        )}
        <View style={[styles.settingsCardInner, { borderTopColor: T.border, borderTopWidth: 1 }]}>
          <Text style={[styles.settingRowLabel, { color: T.text, fontFamily: jks('500'), marginBottom: 4 }]}>Widget</Text>
          <Text style={[styles.appearanceHint, { color: T.textMute, fontFamily: jks('400') }]}>
            Choose launcher colors and which side the mic button sits on.
          </Text>
          <Text style={[styles.settingRowSub, { color: T.textSub, fontFamily: jks('600'), marginBottom: 8 }]}>Theme</Text>
          <ScrollableCardBox T={T} accent={accent}>
          <View style={styles.cardGridSingleRow}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => setWidgetThemeId(WIDGET_THEME_MATCH_APP)}
              style={[styles.previewCard, { backgroundColor: T.s1, borderColor: widgetThemeId === WIDGET_THEME_MATCH_APP ? T.text : T.borderMid, borderWidth: widgetThemeId === WIDGET_THEME_MATCH_APP ? 2 : 1 }]}>
              <MiniMockupPreview v={T} accent={accent} />
              <View style={styles.previewCardFooter}>
                <Icon name="home" size={11} color={T.textMute} />
                <Text numberOfLines={1} style={[styles.previewCardName, { color: T.text, fontFamily: jks('700') }]}>Match App</Text>
              </View>
            </TouchableOpacity>
            {THEMES.map(th => {
              const selected = widgetThemeId === th.id;
              const variant = darkMode ? th.dark : th.light;
              const previewAccent = darkMode ? th.defaultAccentDark : th.defaultAccentLight;
              return (
                <TouchableOpacity key={`widget-${th.id}`} onPress={() => setWidgetThemeId(th.id)} activeOpacity={0.85}
                  style={[styles.previewCard, { backgroundColor: variant.s1, borderColor: selected ? T.text : variant.borderMid, borderWidth: selected ? 2 : 1 }]}>
                  <MiniMockupPreview v={variant} accent={previewAccent} />
                  <View style={styles.previewCardFooter}>
                    <Text numberOfLines={1} style={[styles.previewCardName, { color: variant.text, fontFamily: jks('700') }]}>{th.name}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => { setWidgetThemeId(WIDGET_THEME_CUSTOM); setShowWidgetColorSheet(true); }}
              style={[styles.previewCard, { backgroundColor: T.s1, borderColor: widgetThemeId === WIDGET_THEME_CUSTOM ? T.text : T.borderMid, borderWidth: widgetThemeId === WIDGET_THEME_CUSTOM ? 2 : 1 }]}
            >
              <View style={{ minHeight: 106, borderRadius: 8, borderWidth: 1, borderColor: `${widgetCustomColors.accent}66`, backgroundColor: widgetClear ? T.bg : T.s2, padding: 10, justifyContent: 'center', gap: 9 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                  <View style={{ width: 34, height: 46, alignItems: 'center', justifyContent: 'center' }}>
                    <Feather name="mic" size={20} color={widgetCustomColors.text} />
                    <Ionicons name="sparkles" size={10} color={widgetCustomColors.accent} style={{ position: 'absolute', top: 6, right: 4 }} />
                  </View>
                  <View style={{ flex: 1, gap: 5 }}>
                    <View style={{ width: '90%', height: 7, borderRadius: 4, backgroundColor: widgetCustomColors.text }} />
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: widgetCustomColors.accent }} />
                      <View style={{ width: 32, height: 5, borderRadius: 3, backgroundColor: widgetCustomColors.accent, opacity: 0.75 }} />
                    </View>
                  </View>
                </View>
              </View>
              <View style={styles.previewCardFooter}>
                <View style={[styles.previewAccentSwatch, { backgroundColor: widgetCustomColors.text }]} />
                <View style={[styles.previewAccentSwatch, { backgroundColor: widgetCustomColors.accent }]} />
                <Text numberOfLines={1} style={[styles.previewCardName, { color: T.text, fontFamily: jks('700') }]}>Custom</Text>
              </View>
            </TouchableOpacity>
          </View>
          </ScrollableCardBox>
          <View style={styles.widgetToggleRow}>
            <View style={styles.widgetToggleItem}>
              <Text numberOfLines={2} style={[styles.widgetToggleLabel, { color: T.textSub, fontFamily: jks('600'), flex: 1 }]}>Clear surfaces</Text>
              <Toggle value={widgetClear} onChange={setWidgetClear} accent={accent} />
            </View>
            <View style={styles.widgetToggleItem}>
              <Text numberOfLines={2} style={[styles.widgetToggleLabel, { color: T.textSub, fontFamily: jks('600'), flex: 1 }]}>Short task text</Text>
              <Toggle value={widgetShorthand} onChange={setWidgetShorthand} accent={accent} />
            </View>
          </View>
          <Text style={[styles.settingRowSub, { color: T.textSub, fontFamily: jks('600'), marginTop: 14, marginBottom: 8 }]}>Mic button side</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['left', 'right'] as WidgetMicSide[]).map((side) => {
              const selected = widgetMicSide === side;
              return (
                <TouchableOpacity
                  key={side}
                  activeOpacity={0.85}
                  onPress={() => setWidgetMicSide(side)}
                  style={{
                    flex: 1,
                    minHeight: 42,
                    borderRadius: 12,
                    borderWidth: selected ? 2 : 1,
                    borderColor: selected ? accent : T.borderMid,
                    backgroundColor: selected ? `${accent}18` : T.s2,
                    paddingHorizontal: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}>
                  <Feather name={side === 'left' ? 'align-left' : 'align-right'} size={15} color={selected ? accent : T.textSub} />
                  <Text style={{ color: selected ? T.text : T.textSub, fontFamily: jks('700'), fontSize: 12 }}>
                    {side === 'left' ? 'Left' : 'Right'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>

      <SettingsSection title="AI Triage" />
      <View style={[cardStyle, { marginBottom: 16 }]}>
        <View style={[styles.settingsCardInner, { borderBottomColor: T.border }]}>
          <View style={styles.apiKeyHeader}>
            <Text style={[styles.settingRowLabel, { color: T.text, fontFamily: jks('500') }]}>Claude API Key</Text>
            <View style={[styles.statusPill, { backgroundColor: hasApiKey ? `${T.low}20` : T.s2, borderColor: hasApiKey ? `${T.low}40` : T.border }]}>
              <View style={[styles.statusDot, { backgroundColor: hasApiKey ? T.low : T.textMute }]} />
              <Text style={[styles.statusLabel, { color: hasApiKey ? T.low : T.textMute, fontFamily: jks('700') }]}>{hasApiKey ? 'Active' : 'Not set'}</Text>
            </View>
          </View>
          <View style={styles.apiKeyRow}>
            <TextInput value={keyDraft} onChangeText={setKeyDraft} placeholder="sk-ant-api03-..." placeholderTextColor={T.textMute}
              secureTextEntry={!showKey} autoCapitalize="none" autoCorrect={false}
              style={[styles.apiKeyInput, { backgroundColor: T.s2, color: T.text, borderColor: keyDraft && !keyIsValid ? '#FF5040' : T.border, fontFamily: 'monospace' }]} />
            <TouchableOpacity onPress={() => setShowKey(s => !s)} style={[styles.iconBtn, { backgroundColor: T.s2, borderColor: T.border }]}>
              <Icon name={showKey ? 'eyeOff' : 'eye'} size={15} color={T.textSub} />
            </TouchableOpacity>
            <TouchableOpacity onPress={saveKey} disabled={!keyIsValid} style={[styles.saveKeyBtn, { backgroundColor: keyIsValid ? accent : T.s3 }]}>
              <Text style={[styles.saveKeyLabel, { color: keyIsValid ? '#fff' : T.textMute, fontFamily: jks('700') }]}>Save</Text>
            </TouchableOpacity>
          </View>
          {keyDraft && !keyIsValid ? <Text style={[styles.keyError, { fontFamily: jks('400') }]}>Key must start with sk-ant-</Text> : null}
          <Text style={[styles.keyHint, { color: T.textMute, fontFamily: jks('400') }]}>Used only for AI triage. Key is stored locally on device.</Text>
          <TouchableOpacity
            onPress={() => Linking.openURL('https://console.anthropic.com/settings/keys')}
            style={styles.keyHelpRow}>
            <Text style={[styles.keyHelpLink, { color: accent, fontFamily: jks('600') }]}>How to get an API key →</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.settingsCardInner}>
          <Text style={[styles.contextLabel, { color: T.textSub, fontFamily: jks('400') }]}>Personal Context</Text>
          <TextInput value={personalContext} onChangeText={setPersonalContext} multiline numberOfLines={4}
            onFocus={() => setContextFocused(true)}
            onBlur={() => setContextFocused(false)}
            placeholder="Describe yourself, your work, and your priorities. Example: I run a small manufacturing business, manage a gaming guild, and have a daughter on shared custody. High priority means it affects work, income, or people depending on me."
            placeholderTextColor={T.textMute}
            style={[styles.contextInput, { backgroundColor: T.s2, color: T.text, borderColor: T.border, fontFamily: jks('400') }]} />
        </View>
      </View>

      <SettingsSection title="Help" />
      <View style={[cardStyle, { marginBottom: 16 }]}>
        <SettingRow label="Show walkthrough again" subtitle="Replay the intro tour" noBorder
          onPress={onReplayOnboarding}
          right={<Text style={[styles.clearLabel, { color: accent, fontFamily: jks('400') }]}>Show</Text>} />
      </View>

      {hasSupportLink && (
        <>
          <SettingsSection title="Support" />
          <TouchableOpacity
            onPress={() => setShowDonate(true)}
            style={[styles.settingsCard, styles.supportSettingsRow, { backgroundColor: T.s1, borderColor: T.border, marginBottom: insets.bottom + 24 }]}
            activeOpacity={0.7}>
            <Text numberOfLines={1} style={[styles.settingRowLabel, styles.supportSettingsLabel, { color: T.text, fontFamily: jks('600') }]}>Support Triority</Text>
            <Icon name="heart" size={14} color={accent} />
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
    {confirmNode}
    {settingsToast && <View style={[styles.toastContainer, { pointerEvents: 'none' }]}><Toast message={settingsToast} /></View>}
    {showUpsell && <ProUpsellSheet accentColor={accent} onClose={() => setShowUpsell(false)} showToast={showSettingsToast} />}
    {showDonate && <DonateSheet accentColor={accent} onClose={() => setShowDonate(false)} />}
    {showWidgetColorSheet && (
      <WidgetColorSheet
        initialColors={widgetCustomColors}
        clear={widgetClear}
        onSave={(colors) => {
          setWidgetCustomColors(colors);
          setWidgetThemeId(WIDGET_THEME_CUSTOM);
        }}
        onClose={() => setShowWidgetColorSheet(false)}
      />
    )}
    {editingCustomSlot !== null && (
      <CustomThemeSheet
        initialDraft={customThemeDrafts[editingCustomSlot] ?? DEFAULT_CUSTOM_THEME_DRAFT}
        onSave={(draft) => {
          const next = [...customThemeDrafts] as (CustomThemeDraft | null)[];
          next[editingCustomSlot!] = draft;
          setCustomThemeDrafts(next);
          setThemeId(`custom_${editingCustomSlot}`);
          setAccentLight(null);
          setAccentDark(null);
        }}
        onClose={() => setEditingCustomSlot(null)}
      />
    )}
    </>
  );
}

// ─── TabBar ───────────────────────────────────────────────────────────────────

interface TabBarProps { screen: Screen; setScreen: (s: Screen) => void; accentColor: string; isPaid: boolean; onLockedGrocery: () => void; }

function TabBar({ screen, setScreen, accentColor, isPaid, onLockedGrocery }: TabBarProps) {
  const T = useT();
  const insets = useSafeAreaInsets();
  const tabs: { id: Screen; icon: string; label: string; locked?: boolean }[] = [
    { id: 'list', icon: 'list', label: 'Tasks' },
    { id: 'grocery', icon: 'shopping-bag', label: 'Groceries', locked: !isPaid },
    { id: 'settings', icon: 'settings', label: 'Settings' },
  ];
  return (
    <View style={[styles.tabBar, { borderTopColor: T.border, backgroundColor: T.s1, paddingBottom: 8 + insets.bottom }]}>
      {tabs.map(tab => {
        const active = screen === tab.id;
        return (
          <TouchableOpacity
            key={tab.id}
            onPress={() => {
              if (tab.id === 'grocery' && !isPaid) { onLockedGrocery(); return; }
              setScreen(tab.id);
            }}
            style={styles.tabBtn}
            activeOpacity={0.7}>
            {tab.locked ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name={tab.icon} size={20} color={T.textMute} />
                <Icon name="lock" size={11} color={T.textMute} />
              </View>
            ) : (
              <Icon name={tab.icon} size={20} color={active ? accentColor : T.textMute} />
            )}
            <Text style={[styles.tabLabel, { color: active ? accentColor : T.textMute, fontFamily: jks(active ? '700' : '500') }]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────

// ─── Onboarding ───────────────────────────────────────────────────────────────

interface OnboardingStep {
  icon: string;
  title: string;
  body: string;
  demo: 'capture' | 'widget' | 'ai' | 'share' | 'grocery' | 'reminders' | 'privacy';
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    icon: 'mic',
    title: 'Quick capture',
    body: 'Type or talk from the bottom bar, choose a priority, and the task lands in the list you are already viewing.',
    demo: 'capture',
  },
  {
    icon: 'home',
    title: 'Home-screen widgets',
    body: 'Add Triority Voice for a quiet mic button, or Triority Next Up to rotate through your next tasks. Speak from the widget, review the transcript, then Organize.',
    demo: 'widget',
  },
  {
    icon: 'sparkles',
    title: 'AI understands loose notes',
    body: 'Add your Claude key and Personal Context, then speak casually. A brain dump can become tasks, reminders, groceries, or recipe ingredients in the right place.',
    demo: 'ai',
  },
  {
    icon: 'users',
    title: 'Lists can be shared',
    body: 'Share task lists or the grocery page by code. Everyone can add items, and shared rows keep the group feeling like one list.',
    demo: 'share',
  },
  {
    icon: 'shopping-bag',
    title: 'Store runs, not just groceries',
    body: 'Use Groceries for food, recipes, hardware, materials, and quick shopping runs. Items group by category so the list stays scannable.',
    demo: 'grocery',
  },
  {
    icon: 'bell',
    title: 'Reminder alerts',
    body: 'Set one-time, hourly, or daily reminders. On shared lists, everyone sees the reminder; people who allow notifications get alerted on their own phone.',
    demo: 'reminders',
  },
  {
    icon: 'home',
    title: 'Private by default',
    body: 'No analytics, no hosted AI account, and no surprise data trail. Google handles sign-in; Triority never sees your Google password or broader account data.',
    demo: 'privacy',
  },
];
const WIDGET_ONBOARDING_STEP_INDEX = Math.max(0, ONBOARDING_STEPS.findIndex(step => step.demo === 'widget'));

function OnboardingDemo({ kind, accentColor }: { kind: OnboardingStep['demo']; accentColor: string }) {
  const T = useT();
  const intro = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    intro.setValue(0);
    const introAnim = Animated.timing(intro, { toValue: 1, duration: 2400, useNativeDriver: true });
    introAnim.start();
    return () => introAnim.stop();
  }, [intro, kind]);

  const appear = (at: number) => ({
    opacity: intro.interpolate({ inputRange: [0, at, at + 0.16, 1], outputRange: [0, 0, 1, 1], extrapolate: 'clamp' }),
    transform: [{ translateY: intro.interpolate({ inputRange: [0, at, at + 0.16, 1], outputRange: [8, 8, 0, 0], extrapolate: 'clamp' }) }],
  });
  const slide = (at: number) => ({
    opacity: intro.interpolate({ inputRange: [0, at, at + 0.16, 1], outputRange: [0, 0, 1, 1], extrapolate: 'clamp' }),
    transform: [{ translateX: intro.interpolate({ inputRange: [0, at, at + 0.16, 1], outputRange: [-14, -14, 0, 0], extrapolate: 'clamp' }) }],
  });
  const Line = ({ text, color, at = 0.1, icon }: { text: string; color?: string; at?: number; icon?: string }) => (
    <Animated.View style={[styles.onbDemoLine, { backgroundColor: T.s1, borderColor: T.border }, appear(at)]}>
      <View style={[styles.onbDemoDot, { backgroundColor: color || accentColor }]} />
      <Text style={[styles.onbDemoLineText, { color: T.text, fontFamily: jks('600') }]} numberOfLines={1}>{text}</Text>
      {icon ? <Icon name={icon} size={13} color={color || accentColor} /> : null}
    </Animated.View>
  );
  const SharedLine = ({ text, initials, color, at = 0.1, icon }: { text: string; initials: string; color: string; at?: number; icon?: string }) => (
    <Animated.View style={[styles.onbDemoSharedLine, { backgroundColor: T.s1, borderColor: T.border }, appear(at)]}>
      <View style={[styles.onbDemoAvatar, { backgroundColor: `${color}28`, borderColor: `${color}66` }]}>
        <Text style={[styles.onbDemoAvatarText, { color, fontFamily: jks('800') }]}>{initials}</Text>
      </View>
      <Text style={[styles.onbDemoLineText, { color: T.text, fontFamily: jks('600') }]} numberOfLines={1}>{text}</Text>
      {icon ? <Icon name={icon} size={13} color={color} /> : null}
    </Animated.View>
  );

  return (
    <View style={[styles.onbDemoShell, { backgroundColor: T.s2, borderColor: T.borderMid }]}>
      <View style={styles.onbDemoTop}>
        <View style={[styles.onbDemoTinyDot, { backgroundColor: T.high }]} />
        <View style={[styles.onbDemoTinyDot, { backgroundColor: T.med }]} />
        <View style={[styles.onbDemoTinyDot, { backgroundColor: T.low }]} />
      </View>

      <View style={styles.onbDemoStage}>
      {kind === 'capture' && (
        <>
          <Text style={[styles.onbDemoSectionLabel, { color: T.textMute, fontFamily: jks('800') }]}>Medium</Text>
          <Line text="Order filters" color={T.med} at={0.06} />
          <Animated.View style={[styles.onbDemoTaskGhost, { backgroundColor: T.s1, borderColor: `${T.med}66` }, appear(0.5)]}>
            <View style={[styles.onbDemoDot, { backgroundColor: T.med }]} />
            <Text style={[styles.onbDemoLineText, { color: T.text, fontFamily: jks('700') }]}>Walk the dog</Text>
          </Animated.View>
          <View style={styles.onbDemoChips}>
            {['High', 'Medium', 'Low'].map((label, i) => (
              <Animated.View key={label} style={[styles.onbDemoChip, { borderColor: i === 1 ? accentColor : T.border, backgroundColor: i === 1 ? `${accentColor}22` : T.s1 }, appear(0.22 + i * 0.08)]}>
                <Text style={[styles.onbDemoChipText, { color: i === 1 ? accentColor : T.textSub, fontFamily: jks('700') }]}>{label}</Text>
              </Animated.View>
            ))}
          </View>
          <View style={[styles.onbDemoInput, { backgroundColor: T.bg, borderColor: T.border }]}>
            <Icon name="mic" size={13} color={accentColor} />
            <Animated.Text style={[styles.onbDemoInputText, { color: T.textSub, fontFamily: jks('600'), opacity: intro.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0.35, 1, 1] }) }]}>Walk the dog</Animated.Text>
            <View style={[styles.onbDemoSend, { backgroundColor: accentColor }]}><Icon name="plus" size={12} color="#fff" /></View>
          </View>
        </>
      )}

      {kind === 'widget' && (
        <>
          <View style={styles.onbDemoWidgetWallpaper}>
            <Animated.View style={[styles.onbDemoWidgetClock, appear(0.04)]}>
              <Text style={[styles.onbDemoWidgetTime, { color: T.text, fontFamily: jks('400') }]}>8:22</Text>
              <Text style={[styles.onbDemoWidgetDate, { color: T.textMute, fontFamily: jks('600') }]}>Home screen</Text>
            </Animated.View>
            <Animated.View style={[styles.onbDemoWidgetStrip, appear(0.18)]}>
              <View style={[styles.onbDemoWidgetMic, { backgroundColor: T.s1, borderColor: accentColor }]}>
                <Ionicons name="mic" size={24} color={T.text} />
                <Ionicons name="sparkles" size={14} color={accentColor} style={styles.onbDemoWidgetSparkle} />
              </View>
              <View style={[styles.onbDemoWidgetBubble, { backgroundColor: `${T.s1}DD`, borderColor: `${accentColor}88` }]}>
                <Text numberOfLines={2} style={[styles.onbDemoWidgetTitle, { color: T.text, fontFamily: jks('800') }]}>Take product photo</Text>
                <View style={styles.onbDemoWidgetMeta}>
                  <Text numberOfLines={1} style={[styles.onbDemoWidgetMetaText, { color: accentColor, fontFamily: jks('800') }]}>Biomed</Text>
                  <Text style={[styles.onbDemoWidgetMetaText, { color: T.textMute, fontFamily: jks('800') }]}>/</Text>
                  <Text style={[styles.onbDemoWidgetMetaText, { color: T.med, fontFamily: jks('800') }]}>Medium</Text>
                </View>
              </View>
            </Animated.View>
            <Animated.View style={[styles.onbDemoWidgetReview, { backgroundColor: T.bg, borderColor: `${accentColor}55` }, appear(0.54)]}>
              <Text numberOfLines={1} style={[styles.onbDemoWidgetReviewText, { color: T.text, fontFamily: jks('700') }]}>Review before sending</Text>
              <View style={[styles.onbDemoWidgetReviewBtn, { backgroundColor: `${accentColor}24`, borderColor: `${accentColor}66` }]}>
                <Text style={[styles.onbDemoWidgetReviewBtnText, { color: accentColor, fontFamily: jks('800') }]}>Organize</Text>
              </View>
            </Animated.View>
          </View>
        </>
      )}

      {kind === 'ai' && (
        <>
          <View style={[styles.onbDemoPrompt, { backgroundColor: T.bg, borderColor: `${accentColor}44` }]}>
            <Icon name="sparkles" size={14} color={accentColor} />
            <Text style={[styles.onbDemoPromptText, { color: T.text, fontFamily: jks('600') }]} numberOfLines={2}>ingredients for banana bread, get bacon eggs and bread, call doctor at 2</Text>
          </View>
          <Line text="Call doctor at 2" color={T.high} at={0.22} icon="bell" />
          <Line text="Walk the dog" color={T.med} at={0.36} />
          <Animated.View style={[styles.onbDemoGroceryRow, { backgroundColor: T.s1, borderColor: T.border }, slide(0.5)]}>
            <Icon name="shopping-bag" size={14} color={accentColor} />
            <Text style={[styles.onbDemoLineText, { color: T.text, fontFamily: jks('600') }]}>Bacon, eggs, bread</Text>
          </Animated.View>
          <Animated.View style={[styles.onbDemoNotice, styles.onbDemoNoticeTight, { backgroundColor: `${accentColor}14`, borderColor: `${accentColor}38` }, appear(0.66)]}>
            <Text numberOfLines={1} style={[styles.onbDemoSmall, { color: T.textSub, fontFamily: jks('600') }]}>Context helps triage.</Text>
          </Animated.View>
        </>
      )}

      {kind === 'share' && (
        <>
          <View style={styles.onbDemoPills}>
            {['Personal', 'House', 'Errands'].map((label, i) => (
              <Animated.View key={label} style={[styles.onbDemoListPill, { backgroundColor: i === 1 ? `${accentColor}22` : T.s1, borderColor: i === 1 ? accentColor : T.border }, appear(0.08 + i * 0.08)]}>
                {i === 1 ? <Icon name="users" size={10} color={accentColor} /> : null}
                <Text style={[styles.onbDemoPillText, { color: i === 1 ? accentColor : T.textSub, fontFamily: jks('700') }]}>{label}</Text>
              </Animated.View>
            ))}
          </View>
          <SharedLine text="Buy dog food" initials="R" color={accentColor} at={0.3} />
          <SharedLine text="Call vet at 4" initials="K" color={T.high} at={0.46} icon="bell" />
          <SharedLine text="Check grocery list" initials="R" color={T.low} at={0.62} />
        </>
      )}

      {kind === 'grocery' && (
        <>
          <View style={styles.onbDemoGroceryHeader}>
            <Text style={[styles.onbDemoScreenTitle, { color: T.text, fontFamily: jks('800') }]}>Groceries</Text>
            <Text style={[styles.onbDemoSmall, { color: T.textMute, fontFamily: jks('700') }]}>3 items</Text>
          </View>
          <Animated.View style={appear(0.16)}>
            <Text style={[styles.onbDemoSectionLabel, { color: T.textMute, fontFamily: jks('800') }]}>Dairy</Text>
            <View style={[styles.onbDemoGroceryItem, { backgroundColor: T.s1, borderColor: T.border }]}>
              <Text style={[styles.onbDemoLineText, { color: T.text, fontFamily: jks('600') }]}>Eggs</Text>
            </View>
          </Animated.View>
          <Animated.View style={appear(0.36)}>
            <Text style={[styles.onbDemoSectionLabel, { color: T.textMute, fontFamily: jks('800') }]}>Hardware</Text>
            <View style={[styles.onbDemoGroceryItem, { backgroundColor: T.s1, borderColor: T.border }]}>
              <Text style={[styles.onbDemoLineText, { color: T.text, fontFamily: jks('600') }]}>Deck screws</Text>
            </View>
          </Animated.View>
          <Animated.View style={appear(0.56)}>
            <Text style={[styles.onbDemoSectionLabel, { color: T.textMute, fontFamily: jks('800') }]}>Baking</Text>
            <View style={[styles.onbDemoGroceryItem, { backgroundColor: T.s1, borderColor: T.border }]}>
              <Text style={[styles.onbDemoLineText, { color: T.text, fontFamily: jks('600') }]}>Baking powder</Text>
              <Text style={[styles.onbDemoSmall, { color: T.textMute, fontFamily: jks('600') }]}>(3 oz box)</Text>
            </View>
          </Animated.View>
        </>
      )}

      {kind === 'reminders' && (
        <>
          <Animated.View style={[styles.onbDemoReminderTask, { backgroundColor: T.s1, borderColor: T.border }, appear(0.12)]}>
            <View style={[styles.onbDemoDot, { backgroundColor: T.high }]} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.onbDemoLineText, { color: T.text, fontFamily: jks('700') }]}>Call doctor</Text>
              <View style={styles.onbDemoReminderDue}>
                <Icon name="bell" size={11} color={accentColor} />
                <Text style={[styles.onbDemoSmall, { color: T.textSub, fontFamily: jks('600') }]}>Today at 2:00 PM</Text>
              </View>
            </View>
            <Icon name="bell" size={13} color={accentColor} />
            <Icon name="pencil" size={13} color={T.textSub} />
          </Animated.View>
          <Animated.View style={[styles.onbDemoReminderInfo, { backgroundColor: `${accentColor}14`, borderColor: `${accentColor}38` }, appear(0.38)]}>
            <Icon name="users" size={14} color={accentColor} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={[styles.onbDemoSmall, { color: T.textSub, fontFamily: jks('700') }]}>Shared reminders stay on the task</Text>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} style={[styles.onbDemoTinyText, { color: T.textMute, fontFamily: jks('600') }]}>Alerts fire on phones with notifications on</Text>
            </View>
          </Animated.View>
        </>
      )}

      {kind === 'privacy' && (
        <>
          <Line text="No analytics" color={T.low} at={0.08} icon="check" />
          <Line text="Claude key stays local" color={accentColor} at={0.24} icon="sparkles" />
          <Line text="Google sign-in stays with Google" color={T.med} at={0.4} icon="home" />
          <Animated.View style={[styles.onbDemoNotice, { backgroundColor: T.bg, borderColor: T.border }, appear(0.58)]}>
            <Text style={[styles.onbDemoSmall, { color: T.textMute, fontFamily: jks('600') }]}>Replay this tour anytime in Settings</Text>
          </Animated.View>
        </>
      )}
      </View>
    </View>
  );
}

function Onboarding({ onDone, accentColor, initialStep = 0 }: { onDone: () => void; accentColor: string; initialStep?: number }) {
  const T = useT();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(() => Math.max(0, Math.min(initialStep, ONBOARDING_STEPS.length - 1)));
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(20);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 280, useNativeDriver: true }),
    ]).start();
  }, [step, fadeAnim, slideAnim]);

  const cur = ONBOARDING_STEPS[step];
  const isLast = step === ONBOARDING_STEPS.length - 1;

  const next = () => { if (isLast) onDone(); else setStep(s => s + 1); };
  const prev = () => { if (step > 0) setStep(s => s - 1); };

  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onDone}>
      <View style={[styles.onbBackdrop, { backgroundColor: T.bg, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}>
        {/* Skip button */}
        <View style={styles.onbTopBar}>
          <TouchableOpacity onPress={onDone} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={[styles.onbSkip, { color: T.textMute, fontFamily: jks('600') }]}>Skip</Text>
          </TouchableOpacity>
        </View>

        {/* Content */}
        <Animated.View style={[styles.onbContent, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
          <OnboardingDemo kind={cur.demo} accentColor={accentColor} />
          <View style={[styles.onbIconWrap, { backgroundColor: `${accentColor}18`, borderColor: `${accentColor}40` }]}>
            <Icon name={cur.icon} size={18} color={accentColor} />
          </View>
          <Text style={[styles.onbTitle, { color: T.text, fontFamily: jks('800') }]}>{cur.title}</Text>
          <Text style={[styles.onbBody, { color: T.textSub, fontFamily: jks('400') }]}>{cur.body}</Text>
        </Animated.View>

        {/* Pagination dots */}
        <View style={styles.onbDots}>
          {ONBOARDING_STEPS.map((_, i) => (
            <View key={i} style={[styles.onbDot, {
              backgroundColor: i === step ? accentColor : T.s3,
              width: i === step ? 18 : 6,
            }]} />
          ))}
        </View>

        {/* Buttons */}
        <View style={styles.onbButtonRow}>
          {step > 0 ? (
            <TouchableOpacity onPress={prev} style={[styles.onbBackBtn, { backgroundColor: T.s2, borderColor: T.border }]}>
              <Text style={[styles.onbBackLabel, { color: T.textSub, fontFamily: jks('600') }]}>Back</Text>
            </TouchableOpacity>
          ) : <View style={{ flex: 1 }} />}
          <TouchableOpacity onPress={next} style={[styles.onbNextBtn, { backgroundColor: accentColor }]}>
            <Text style={[styles.onbNextLabel, { fontFamily: jks('700') }]}>{isLast ? 'Get started' : 'Next'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── StandaloneGrocery ────────────────────────────────────────────────────────
// Top-level Groceries screen. Mirrors ActiveList's header style (date + count) but
// shows "Groceries" as a plain title with no edit/archive buttons (grocery list is
// static, not renameable/deletable). Renders the shared GroceryScreen body and a
// grocery-mode InputBar.

interface StandaloneGroceryProps {
  groceryItems: GroceryItem[];
  onAddGroceryItems: (items: GroceryDraft[]) => AddGroceryDraftResult;
  onCheckGrocery: (id: string) => void;
  onDeleteGrocery: (id: string) => void;
  onClearCheckedGrocery: () => void;
  onClearAllGrocery: () => void;
  onAiSortGrocery: (onDone?: () => void) => void;
  sharedGrocery?: {
    isOwner: boolean;
    shareCode: string;
    memberCount: number;
  };
  onShareGrocery: () => Promise<void>;
  onRotateGroceryShareCode: () => Promise<void>;
  onMakePrivateSharedGrocery: () => Promise<void>;
  onLeaveSharedGrocery: () => Promise<void>;
  onDeleteSharedGrocery: () => Promise<void>;
  hasApiKey: boolean;
  accentColor: string;
  defaultTier: Tier;
  widgetShorthand: boolean;
  lists: TaskList[];
  activeListId: string;
  onAddMany: (items: TaskDraft[]) => AddTaskDraftResult;
  onAddManyToList: (listId: string, items: TaskDraft[]) => AddTaskDraftResult;
  groupCollapseScope: string;
  collapsedGroups: CollapsedGroups;
  setCollapsedGroup: (key: string, collapsed: boolean) => void;
  focusedGroceryId?: string | null;
  focusedGroceryNonce?: number;
  onFocusedGrocerySeen?: () => void;
}

function StandaloneGrocery({
  groceryItems, onAddGroceryItems, onCheckGrocery, onDeleteGrocery,
  onClearCheckedGrocery, onClearAllGrocery, onAiSortGrocery,
  sharedGrocery,
  onShareGrocery, onRotateGroceryShareCode, onMakePrivateSharedGrocery, onLeaveSharedGrocery, onDeleteSharedGrocery,
  hasApiKey, accentColor, defaultTier, widgetShorthand, lists, activeListId,
  onAddMany, onAddManyToList,
  groupCollapseScope, collapsedGroups, setCollapsedGroup,
  focusedGroceryId: externalFocusedGroceryId,
  focusedGroceryNonce: externalFocusedGroceryNonce,
  onFocusedGrocerySeen,
}: StandaloneGroceryProps) {
  const T = useT();
  const insets = useSafeAreaInsets();
  const isPaid = useIsPaid();
  const { user: syncUser } = useSync();
  const { joinSharedListByCode, sharedLists } = useSharedLists();
  const [grocerySortMode, setGrocerySortMode] = useState<'category' | 'alpha'>('category');
  const [toast, setToast] = useState<ToastData | null>(null);
  const [showUpsell, setShowUpsell] = useState(false);
  const [shareSheetOpen, setShareSheetOpen] = useState(false);
  const [showJoinSheet, setShowJoinSheet] = useState(false);
  const [focusedGroceryId, setFocusedGroceryId] = useState<string | null>(null);
  const [focusedGroceryNonce, setFocusedGroceryNonce] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmNode, confirm] = useConfirm(accentColor);
  // AI Sort busy flag — set true while a sort request is in-flight, prevents
  // double-firing on rapid taps and signals to the user via a sticky toast that
  // the AI is working.
  const [aiSorting, setAiSorting] = useState(false);

  const showToast = useCallback((message: string, sub?: string, sticky?: boolean) => {
    if (toastTimer.current) { clearTimeout(toastTimer.current); toastTimer.current = null; }
    setToast({ message, sub });
    if (!sticky) toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);
  const dismissToast = useCallback(() => {
    if (toastTimer.current) { clearTimeout(toastTimer.current); toastTimer.current = null; }
    setToast(null);
  }, []);
  const handleAddGroceryItems = useCallback((items: GroceryDraft[]) => {
    return Promise.resolve(onAddGroceryItems(items)).then((ids) => {
      if (ids?.[0]) {
        setFocusedGroceryId(ids[0]);
        setFocusedGroceryNonce(n => n + 1);
      }
      return ids;
    }).catch((e) => {
      showToast('Could not add groceries', e?.message || 'Check connection');
    });
  }, [onAddGroceryItems, showToast]);

  const markFocusedGrocerySeen = useCallback(() => {
    if (!focusedGroceryId) return;
    setTimeout(() => {
      setFocusedGroceryId(current => current === focusedGroceryId ? null : current);
    }, FOCUSED_ROW_CLEAR_MS);
  }, [focusedGroceryId]);

  const handleAiSort = useCallback(() => {
    if (aiSorting) return;
    setAiSorting(true);
    showToast('Sorting…', 'AI is categorizing your list', true);
    onAiSortGrocery(() => {
      setGrocerySortMode('category');
      setAiSorting(false);
      showToast('Sorted', 'Items grouped by category');
    });
  }, [aiSorting, showToast, onAiSortGrocery]);

  const effectiveFocusedGroceryId = externalFocusedGroceryId ?? focusedGroceryId;
  const effectiveFocusedGroceryNonce = externalFocusedGroceryId ? externalFocusedGroceryNonce ?? 0 : focusedGroceryNonce;
  const markEffectiveFocusedGrocerySeen = useCallback(() => {
    if (externalFocusedGroceryId) {
      onFocusedGrocerySeen?.();
    } else {
      markFocusedGrocerySeen();
    }
  }, [externalFocusedGroceryId, markFocusedGrocerySeen, onFocusedGrocerySeen]);

  const startShareGrocery = useCallback(() => {
    setShareSheetOpen(false);
    setTimeout(() => {
      confirm({
        title: 'Share Groceries',
        message: 'Share your grocery list with a code? Anyone you give the code to can see and update this grocery list.',
        confirmLabel: 'Share',
        destructive: false,
        onConfirm: () => {
          showToast('Sharing groceries...', 'Creating share code', true);
          onShareGrocery()
            .then(() => {
              showToast('Shared groceries created', 'Tap the people button for the code');
              requestReminderNotifications(showToast).catch(() => {});
              setShareSheetOpen(true);
            })
            .catch((e) => showToast('Could not share', e?.message || 'Check connection'));
        },
      });
    }, 0);
  }, [confirm, onShareGrocery, showToast]);

  const openJoinSheet = useCallback(() => {
    setShareSheetOpen(false);
    Keyboard.dismiss();
    setTimeout(() => setShowJoinSheet(true), 0);
  }, []);

  const openShare = useCallback(() => {
    if (!syncUser) {
      showToast('Sign in to share', 'Open Settings and sign in with Google');
      return;
    }
    if (!isPaid) {
      setShowUpsell(true);
      return;
    }
    setShareSheetOpen(true);
  }, [isPaid, showToast, syncUser]);

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: T.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={[styles.listHeader, { paddingTop: Math.max(18, 18 + insets.top) }]}>
        <View style={styles.listHeaderTop}>
          <View style={styles.listTitleRow}>
            <Text style={[styles.listTitleText, { color: T.text, fontFamily: jks('700') }]} numberOfLines={1}>
              Groceries
            </Text>
          </View>
          <View style={styles.listMetaRowInline}>
            <Text style={[styles.taskCountInline, { color: T.textMute, fontFamily: jks('500') }]}>
              {`${groceryItems.length} item${groceryItems.length !== 1 ? 's' : ''}`}
            </Text>
            {sharedGrocery ? (
              <>
                <Text style={[styles.metaBullet, { color: T.textMute }]}>•</Text>
                <View style={styles.sharedMetaPill}>
                  <Icon name="users" size={11} color={accentColor} strokeWidth={1.8} />
                  <Text style={[styles.taskCountInline, { color: accentColor, fontFamily: jks('700') }]}>
                    {sharedGrocery.memberCount}
                  </Text>
                </View>
              </>
            ) : null}
          </View>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={openShare}
            style={[styles.headerActionBtnTopRight, { backgroundColor: `${accentColor}14`, borderColor: `${accentColor}55` }]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Icon name="users" size={14} color={accentColor} strokeWidth={1.6} />
          </TouchableOpacity>
        </View>
        <View style={[styles.divider, { backgroundColor: T.border, marginTop: 10 }]} />
      </View>
      <GroceryScreen
        items={groceryItems}
        onAddItem={(name) => handleAddGroceryItems([{ name, category: GROCERY_UNCATEGORIZED }])}
        onCheck={onCheckGrocery}
        onDelete={onDeleteGrocery}
        onClearChecked={onClearCheckedGrocery}
        onClearAll={onClearAllGrocery}
        onSortAlpha={() => setGrocerySortMode(m => m === 'alpha' ? 'category' : 'alpha')}
        onAiSort={handleAiSort}
        hasApiKey={hasApiKey}
        accentColor={accentColor}
        sortMode={grocerySortMode}
        defaultTier={defaultTier}
        showToast={showToast}
        dismissToast={dismissToast}
        groupCollapseScope={groupCollapseScope}
        collapsedGroups={collapsedGroups}
        setCollapsedGroup={setCollapsedGroup}
        focusedItemId={effectiveFocusedGroceryId}
        focusedItemNonce={effectiveFocusedGroceryNonce}
        onFocusedItemSeen={markEffectiveFocusedGrocerySeen}
      />
      <InputBar
        onAddMany={onAddMany}
        onAddManyToList={onAddManyToList}
        onAddGroceryItems={handleAddGroceryItems}
        hasApiKey={hasApiKey}
        accentColor={accentColor}
        defaultTier={defaultTier}
        showToast={showToast}
        dismissToast={dismissToast}
        groceryMode={true}
        lists={lists}
        activeListId={activeListId}
        widgetShorthand={widgetShorthand}
      />
      {toast && <View style={styles.toastContainer} pointerEvents="none"><Toast message={toast.message} sub={toast.sub} /></View>}
      {confirmNode}
      {showUpsell && <ProUpsellSheet accentColor={accentColor} onClose={() => setShowUpsell(false)} showToast={showToast} />}
      {shareSheetOpen && (
        <GroceryShareSheet
          accentColor={accentColor}
          shareCode={sharedGrocery?.shareCode}
          memberCount={sharedGrocery?.memberCount}
          isOwner={sharedGrocery?.isOwner}
          onClose={() => setShareSheetOpen(false)}
          onShare={!sharedGrocery ? startShareGrocery : undefined}
          onJoinCode={openJoinSheet}
          onRotateCode={sharedGrocery ? async () => {
            try {
              await onRotateGroceryShareCode();
              showToast('Share code rotated', 'Old code no longer works');
            } catch (e: any) {
              showToast('Could not rotate', e?.message || 'Check connection');
            }
          } : undefined}
          onMakePrivate={sharedGrocery?.isOwner ? () => {
            setShareSheetOpen(false);
            setTimeout(() => {
              confirm({
                title: 'Move items to personal list and delete',
                message: 'Copy the current shared groceries into your personal grocery list, then delete the shared list for everyone?',
                confirmLabel: 'Move items to personal list and delete',
                destructive: false,
                onConfirm: () => {
                  showToast('Making groceries private...', 'Copying shared items', true);
                  withTimeout(onMakePrivateSharedGrocery(), 15000, 'Make private timed out. Check connection and try again.')
                    .then(() => showToast('Personal grocery copy saved'))
                    .catch((e) => showToast('Could not make private', e?.message || 'Check connection'));
                },
              });
            }, 0);
          } : undefined}
          onLeave={sharedGrocery ? () => {
            setShareSheetOpen(false);
            setTimeout(() => {
              confirm({
                title: 'Leave Shared Groceries',
                message: 'Leave this shared grocery list? You will lose access to its items.',
                confirmLabel: 'Leave',
                destructive: true,
                onConfirm: () => {
                  showToast('Leaving shared groceries...', 'Updating access', true);
                  withTimeout(onLeaveSharedGrocery(), 15000, 'Leave timed out. Check connection and try again.')
                    .then(() => showToast('Left shared groceries'))
                    .catch((e) => showToast('Could not leave', e?.message || 'Check connection'));
                },
              });
            }, 0);
          } : undefined}
          onDelete={sharedGrocery ? () => {
            setShareSheetOpen(false);
            setTimeout(() => {
              confirm({
                title: 'Delete Shared Groceries',
                message: 'Delete this shared grocery list for everyone?',
                confirmLabel: 'Delete',
                destructive: true,
                onConfirm: () => {
                  showToast('Deleting shared groceries...', 'Removing them for everyone', true);
                  withTimeout(onDeleteSharedGrocery(), 15000, 'Delete timed out. Check connection and try again.')
                    .then(() => showToast('Shared groceries deleted'))
                    .catch((e) => showToast('Could not delete', e?.message || 'Check connection'));
                },
              });
            }, 0);
          } : undefined}
        />
      )}
      {showJoinSheet && (
        <JoinSharedListSheet
          accentColor={accentColor}
          onClose={() => setShowJoinSheet(false)}
          onSubmit={async (rawCode) => {
            const id = await withTimeout(
              joinSharedListByCode(rawCode),
              15000,
              'Join timed out. Check connection and make sure the latest Firestore rules are published.',
            );
            const joined = sharedLists[id];
            showToast(joined ? `Joined ${joined.name}` : 'Joined shared list');
            requestReminderNotifications(showToast).catch(() => {});
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}

function TriorityApp() {
  const isPaid = useIsPaid();
  const { user: syncUser } = useSync();
  const [showGroceryUpsell, setShowGroceryUpsell] = useState(false);
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>('list');
  const [lists, setListsState] = useState<TaskList[]>([{ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME, tasks: SAMPLE_TASKS, createdAt: Date.now(), updatedAt: Date.now() }]);
  const [sharedTaskOrder, setSharedTaskOrderState] = useState<string[]>([]);
  const [listRowOrder, setListRowOrderState] = useState<string[]>([]);
  const [activeListId, setActiveListIdState] = useState<string>(DEFAULT_LIST_ID);
  const [archive, setArchiveState] = useState<ArchivedTask[]>(SAMPLE_ARCHIVE);
  const [accentLight, setAccentLightState] = useState<string | null>(null);
  const [accentDark, setAccentDarkState] = useState<string | null>(null);
  const [themeId, setThemeIdState] = useState<string>('slate');
  const [widgetThemeId, setWidgetThemeIdState] = useState<WidgetThemeId>(WIDGET_THEME_MATCH_APP);
  const [widgetClear, setWidgetClearState] = useState(false);
  const [widgetShorthand, setWidgetShorthandState] = useState(true);
  const [widgetCustomColors, setWidgetCustomColorsState] = useState<WidgetCustomColors>(DEFAULT_WIDGET_CUSTOM_COLORS);
  const [widgetMicSide, setWidgetMicSideState] = useState<WidgetMicSide>('left');
  const [customThemeDrafts, setCustomThemeDraftsState] = useState<(CustomThemeDraft | null)[]>([null, null, null]);
  const [apiKey, setApiKeyState] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [personalContext, setPersonalContextState] = useState('');
  const [defaultTier, setDefaultTierState] = useState<Tier>('medium');
  const [autoClear, setAutoClearState] = useState<AutoClear>('Never');
  const [darkMode, setDarkModeState] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [groceryItems, setGroceryItemsState] = useState<GroceryItem[]>([]);
  const [viewingSharedGrocery, setViewingSharedGroceryState] = useState(false);
  const [collapsedGroups, setCollapsedGroupsState] = useState<CollapsedGroups>({});
  const [pendingReminderNav, setPendingReminderNav] = useState<ReminderNavTarget | null>(null);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [focusedTaskNonce, setFocusedTaskNonce] = useState(0);
  const focusedTaskNonceRef = useRef(0);
  const [focusedGroceryId, setFocusedGroceryId] = useState<string | null>(null);
  const [focusedGroceryNonce, setFocusedGroceryNonce] = useState(0);
  const [calendarConflictsEnabled, setCalendarConflictsEnabledState] = useState(false);
  const [calendarConflictKeys, setCalendarConflictKeys] = useState<Set<string>>(new Set());
  const [calendarConflictNotice, setCalendarConflictNotice] = useState<string | null>(null);
  const [onboardingInitialStep, setOnboardingInitialStep] = useState(0);
  const activeReminderFiredRef = useRef<Set<string>>(new Set());
  const openedReminderTargetsRef = useRef<{ target: ReminderNavTarget; openedAt: number }[]>([]);

  const persistGrocery = (items: GroceryItem[]) => {
    AsyncStorage.setItem('tri_grocery', JSON.stringify(items)).catch(() => {});
  };
  const setViewingSharedGrocery = useCallback((viewShared: boolean) => {
    setViewingSharedGroceryState(viewShared);
    AsyncStorage.setItem(SHARED_GROCERY_TOGGLE_KEY, viewShared ? '1' : '0').catch(() => {});
  }, []);
  const setCollapsedGroup = useCallback((key: string, collapsed: boolean) => {
    setCollapsedGroupsState(prev => {
      const next = { ...prev, [key]: collapsed };
      AsyncStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);
  const setCalendarConflictsEnabled = useCallback((enabled: boolean) => {
    setCalendarConflictsEnabledState(enabled);
    if (!enabled) setCalendarConflictKeys(new Set());
    AsyncStorage.setItem(CALENDAR_CONFLICTS_ENABLED_KEY, enabled ? '1' : '0').catch(() => {});
  }, []);
  const requestCalendarConflictAccess = useCallback(async () => {
    try {
      const token = await getCalendarFreeBusyAccessToken();
      return !!token;
    } catch {
      return false;
    }
  }, []);
  useEffect(() => {
    focusedTaskNonceRef.current = focusedTaskNonce;
  }, [focusedTaskNonce]);
  const armFocusedTask = useCallback((id: string) => {
    setFocusedTaskId(id);
    setFocusedTaskNonce(n => n + 1);
  }, []);
  const addGroceryItems = useCallback((items: GroceryDraft[]) => {
    const now = Date.now();
    const newItems: GroceryItem[] = items.map((item, i) => ({
      id: `groc_${now}_${i}`,
      name: item.name.trim(),
      category: item.category || GROCERY_UNCATEGORIZED,
      quantity: cleanOptionalGroceryPart(item.quantity),
      unit: cleanOptionalGroceryPart(item.unit),
      packageSize: cleanPackageSize(item.packageSize),
      checked: false,
      createdAt: now + i,
    }));
    setGroceryItemsState(prev => {
      const next = [...prev, ...newItems];
      persistGrocery(next);
      return next;
    });
    return newItems.map((item) => item.id);
  }, []);

  const checkGrocery = useCallback((id: string) => {
    setGroceryItemsState(prev => {
      const next = prev.map(i => i.id === id ? { ...i, checked: !i.checked } : i);
      persistGrocery(next);
      return next;
    });
  }, []);

  const deleteGrocery = useCallback((id: string) => {
    setGroceryItemsState(prev => {
      const next = prev.filter(i => i.id !== id);
      persistGrocery(next);
      return next;
    });
  }, []);

  const clearCheckedGrocery = useCallback(() => {
    setGroceryItemsState(prev => {
      const next = prev.filter(i => !i.checked);
      persistGrocery(next);
      return next;
    });
  }, []);

  const clearAllGrocery = useCallback(() => {
    setGroceryItemsState([]);
    persistGrocery([]);
  }, []);

  const aiSortGrocery = useCallback(async (onDone?: () => void) => {
    let storedKey = '';
    try { storedKey = await EncryptedStorage.getItem('triority-api-key') || ''; } catch {}
    if (!storedKey) { onDone?.(); return; }
    // Snapshot current items at call time — avoids stale closure inside setState
    const snapshot = groceryItems;
    if (snapshot.length === 0) { onDone?.(); return; }
    const validCats = new Set([...GROCERY_CATEGORIES, GROCERY_UNCATEGORIZED]);
    const systemPrompt = `Assign a grocery category to each item. Categories: ${GROCERY_CATEGORIES.join(', ')}, or "${GROCERY_UNCATEGORIZED}".
Return ONLY valid JSON. The first character must be [ and the last character must be ]. No prose, no markdown.
Format: [{"id":"item_id","category":"Dairy"}]`;
    const userMsg = snapshot.map(i => `{"id":"${i.id}","name":"${i.name}"}`).join('\n');
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': storedKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
        tools: [aiGroceryCategoryTool()],
        tool_choice: { type: 'tool', name: AI_GROCERY_CATEGORY_TOOL_NAME },
      }),
    }).then(r => r.json()).then(data => {
      const parsed = anthropicToolInputFromResponse(data, AI_GROCERY_CATEGORY_TOOL_NAME);
      const assignments: { id: string; category: string }[] = Array.isArray(parsed.assignments) ? parsed.assignments : [];
      const map = new Map(assignments.map(a => [a.id, validCats.has(a.category) ? a.category : GROCERY_UNCATEGORIZED]));
      setGroceryItemsState(current => {
        const next = current.map(i => map.has(i.id) ? { ...i, category: map.get(i.id)! } : i);
        persistGrocery(next);
        return next;
      });
      onDone?.();
    }).catch(() => { onDone?.(); });
  }, [groceryItems]);

  useEffect(() => {
    loadAll().then(async data => {
      setListsState(data.lists);
      setActiveListIdState(data.activeListId);
      setArchiveState(data.archive);
      setAccentLightState(data.accentLight);
      setAccentDarkState(data.accentDark);
      setThemeIdState(data.themeId);
      setWidgetThemeIdState(data.widgetThemeId);
      setWidgetClearState(data.widgetClear);
      setWidgetShorthandState(data.widgetShorthand);
      setWidgetCustomColorsState(data.widgetCustomColors);
      setWidgetMicSideState(data.widgetMicSide);
      setCustomThemeDraftsState(data.customThemeDrafts);
      setHasApiKey(isValidKey(data.apiKey));
      setApiKeyState(data.apiKey);
      setPersonalContextState(data.context);
      setDefaultTierState(data.defaultTier);
      setAutoClearState(data.autoClear);
      setDarkModeState(data.darkMode);
      setGroceryItemsState(data.groceryItems);
      setCollapsedGroupsState(data.collapsedGroups);
      try {
        const rawSharedOrder = await AsyncStorage.getItem(SHARED_TASK_ORDER_KEY);
        if (rawSharedOrder) {
          const parsedSharedOrder = JSON.parse(rawSharedOrder);
          if (Array.isArray(parsedSharedOrder)) {
            setSharedTaskOrderState(parsedSharedOrder.filter((id) => typeof id === 'string'));
          }
        }
        const rawListRowOrder = await AsyncStorage.getItem(LIST_ROW_ORDER_KEY);
        if (rawListRowOrder) {
          const parsedListRowOrder = JSON.parse(rawListRowOrder);
          if (Array.isArray(parsedListRowOrder)) {
            setListRowOrderState(parsedListRowOrder.filter((id) => typeof id === 'string'));
          }
        }
        const rawSharedGroceryView = await AsyncStorage.getItem(SHARED_GROCERY_TOGGLE_KEY);
        setViewingSharedGroceryState(rawSharedGroceryView === '1');
        const rawCalendarConflicts = await AsyncStorage.getItem(CALENDAR_CONFLICTS_ENABLED_KEY);
        setCalendarConflictsEnabledState(rawCalendarConflicts === '1');
      } catch {}
      const showWidgetReleaseTour = data.onboarded && !data.widgetOnboardingSeen;
      setOnboardingInitialStep(showWidgetReleaseTour ? WIDGET_ONBOARDING_STEP_INDEX : 0);
      setShowOnboarding(!data.onboarded || !data.widgetOnboardingSeen);
      setReady(true);
      // Reminders are global across lists — flatten task arrays for the sync.
      // Always reconcile, even when no tasks have reminders, so orphaned alarms
      // (e.g. left over after deleting the last reminder-bearing task) get cancelled.
      const allTasks = data.lists.flatMap(l =>
        l.tasks.map(t => ({ ...t, reminderListId: l.id, reminderTaskId: t.id })),
      );
      try {
        await ensureNotifChannel();
        await syncAllReminders(allTasks);
      } catch {}
    });
  }, []);

  useEffect(() => {
    const handleTarget = (target: ReminderNavTarget | null) => {
      if (!target) return;
      const now = Date.now();
      openedReminderTargetsRef.current = [
        ...openedReminderTargetsRef.current.filter((entry) => now - entry.openedAt < 90000),
        { target, openedAt: now },
      ];
      setPendingReminderNav(target);
    };
    const consumeStoredTarget = async () => {
      const raw = await AsyncStorage.getItem(REMINDER_NAV_KEY).catch(() => null);
      if (!raw) return;
      await AsyncStorage.removeItem(REMINDER_NAV_KEY).catch(() => {});
      try {
        handleTarget(reminderTargetFromData(JSON.parse(raw)));
      } catch {}
    };
    notifee.getInitialNotification()
      .then((initial) => handleTarget(reminderTargetFromData(initial?.notification?.data as any)))
      .catch(() => {});
    Linking.getInitialURL()
      .then((url) => handleTarget(widgetTaskTargetFromUrl(url)))
      .catch(() => {});
    consumeStoredTarget().catch(() => {});
    const unsubscribe = notifee.onForegroundEvent(({ type, detail }) => {
      if (type !== EventType.PRESS && type !== EventType.ACTION_PRESS) return;
      handleTarget(reminderTargetFromData(detail.notification?.data as any));
    });
    const linkSub = Linking.addEventListener('url', ({ url }) => {
      handleTarget(widgetTaskTargetFromUrl(url));
    });
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') consumeStoredTarget().catch(() => {});
    });
    return () => {
      unsubscribe();
      linkSub.remove();
      appStateSub.remove();
    };
  }, []);

  // ─── Step 14: cold-start surfacing of unread notifications ───────────────
  // When the user is signed in, query their /users/{uid}/notifications for
  // unread entries (readAt == null), Alert each one (simple stacking UI), and
  // batch-mark them read. Runs once per app launch per signed-in session — the
  // ref guard prevents re-firing if syncUser identity churns inside a session.
  const updateCheckedRef = useRef(false);
  useEffect(() => {
    if (!ready || showOnboarding || updateCheckedRef.current) return;
    updateCheckedRef.current = true;
    const timer = setTimeout(() => {
      checkForGithubUpdate();
    }, 1200);
    return () => clearTimeout(timer);
  }, [ready, showOnboarding]);

  const notifsCheckedRef = useRef<string | null>(null);
  useEffect(() => {
    const uid = syncUser?.uid;
    if (!uid) return;
    if (notifsCheckedRef.current === uid) return;
    notifsCheckedRef.current = uid;

    (async () => {
      try {
        const db = getFirestore(getApp());
        const snap = await getDocs(query(
          collection(db, 'users', uid, 'notifications'),
          where('readAt', '==', null),
        ));
        if (snap.empty) return;

        const unread: { id: string; type: NotificationKind; payload: any }[] = [];
        snap.forEach((d) => {
          const data = d.data() as Omit<UserNotification, 'id'>;
          unread.push({ id: d.id, type: data.type, payload: data.payload || {} });
        });

        // Surface each. Alert.alert stacks on Android — second alert appears
        // after the first is dismissed. Order is undefined (Firestore doesn't
        // sort by anything implicit) but consistent within a launch.
        for (const n of unread) {
          if (n.type === 'list_deleted') {
            const listName = n.payload?.listName || 'a shared list';
            const initial = n.payload?.ownerInitial;
            const who = initial ? `${initial} deleted` : 'Deleted';
            Alert.alert(`${who} "${listName}"`, 'The shared list is no longer available.');
          }
        }

        // Batch-mark all surfaced notifs as read so we don't re-alert next
        // launch. Best-effort — if it fails, the user gets one redundant
        // alert next launch, no data loss.
        const readBatch = writeBatch(db);
        const readAt = Date.now();
        for (const n of unread) {
          readBatch.update(doc(db, 'users', uid, 'notifications', n.id), { readAt });
        }
        try { await readBatch.commit(); } catch {}
      } catch {
        // Sign-in token race or offline at cold start — silently skip; will
        // re-attempt on next sign-in event.
      }
    })();
  }, [syncUser?.uid]);

  // Crash-safe persistence. Every state mutation already calls AsyncStorage.setItem,
  // but if the OS kills the app between an in-memory update and the (microtask-async)
  // AsyncStorage write, the write can be lost. To defend against that, we mirror the
  // latest values into refs and re-flush them whenever the app goes to background or
  // becomes inactive — that's the last reliable hook before a force-stop or kill.
  const listsRef = useRef(lists);
  const archiveRef = useRef(archive);
  const groceryRef = useRef(groceryItems);
  const activeListIdRef = useRef(activeListId);
  const collapsedGroupsRef = useRef(collapsedGroups);
  useEffect(() => { listsRef.current = lists; }, [lists]);
  useEffect(() => { archiveRef.current = archive; }, [archive]);
  useEffect(() => { groceryRef.current = groceryItems; }, [groceryItems]);
  useEffect(() => { activeListIdRef.current = activeListId; }, [activeListId]);
  useEffect(() => { collapsedGroupsRef.current = collapsedGroups; }, [collapsedGroups]);

  useEffect(() => {
    const flushAll = () => {
      // Fire-and-forget; AppState transitions don't block on these. If the OS kills
      // the process before they land, that's the same risk we already have — but in
      // practice the writes go through immediately on Android.
      AsyncStorage.multiSet([
        ['tri_lists', JSON.stringify(listsRef.current)],
        ['tri_archive', JSON.stringify(archiveRef.current)],
        ['tri_grocery', JSON.stringify(groceryRef.current)],
        ['tri_active_list_id', JSON.stringify(activeListIdRef.current)],
        [COLLAPSED_GROUPS_KEY, JSON.stringify(collapsedGroupsRef.current)],
      ]).catch(() => {});
    };
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') flushAll();
    });
    return () => sub.remove();
  }, []);

  // ─── Cloud sync (Phase 1) ───────────────────────────────────────────────
  // Single watcher: when signed in and ready, debounce-write the synced state
  // slice to Firestore on any change. On sign-in, restore-from-remote first if
  // remote is newer than local. Local AsyncStorage stays the offline truth.
  const {
    joinedIds: syncedJoinedIds,
    setJoinedIds: restoreJoinedIds,
  } = useSharedLists();

  const syncedSlice: SyncedState = useMemo(() => ({
    lists,
    activeListId,
    archive,
    accentLight,
    accentDark,
    themeId,
    customThemeDrafts,
    personalContext,
    defaultTier,
    autoClear,
    darkMode,
    groceryItems,
    joinedSharedLists: syncedJoinedIds,
    syncEnabledForGrocery: viewingSharedGrocery,
    sharedTaskOrder,
    listRowOrder,
  }), [lists, activeListId, archive, accentLight, accentDark, themeId,
       customThemeDrafts, personalContext, defaultTier, autoClear, darkMode,
       groceryItems, syncedJoinedIds, viewingSharedGrocery, sharedTaskOrder, listRowOrder]);

  const sliceRef = useRef(syncedSlice);
  useEffect(() => { sliceRef.current = syncedSlice; }, [syncedSlice]);
  const [syncWriteReady, setSyncWriteReady] = useState(false);

  // Suppress writes for a brief window after we restore remote → local, so
  // the watcher doesn't immediately echo the restore back as a write.
  const justRestoredRef = useRef(false);
  // Track the highest updatedAt we've seen — local writes only happen if our
  // current state diverges from this baseline.
  const lastSyncedAtRef = useRef<number>(0);
  // Debounce timer ID — restart on every change.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track which uid this effect cycle is bound to, so a sign-out cleanly halts.
  const activeUidRef = useRef<string | null>(null);
  const saveAccountCache = useCallback(async (uid: string, data: SyncedState) => {
    const cache: AccountCache = { savedAt: Date.now(), data: stripUndefined(data) };
    await AsyncStorage.setItem(syncAccountCacheKey(uid), JSON.stringify(cache));
  }, []);
  const loadAccountCache = useCallback(async (uid: string): Promise<AccountCache | null> => {
    const raw = await AsyncStorage.getItem(syncAccountCacheKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AccountCache;
    return parsed?.data ? parsed : null;
  }, []);

  useEffect(() => {
    // Wait for AsyncStorage hydration before any sync activity.
    if (!ready) return;
    const priorActiveUid = activeUidRef.current;
    const uid = syncUser?.uid ?? null;
    activeUidRef.current = uid;
    setSyncWriteReady(false);

    // Signed out: cancel any pending write, do nothing else. Local state stays.
    if (!uid) {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
      lastSyncedAtRef.current = 0;
      if (priorActiveUid) {
        saveAccountCache(priorActiveUid, sliceRef.current).catch(() => {});
      }
      return;
    }

    // Signed in: restore from remote if it's newer than local, then enable writes.
    let cancelled = false;
    (async () => {
      try {
        const db = getFirestore(getApp());
        const ref = doc(db, 'users', uid);
        const previousUid = await AsyncStorage.getItem(SYNC_CURRENT_UID_KEY);
        const isAccountSwitch = !!previousUid && previousUid !== uid;
        if (priorActiveUid && priorActiveUid !== uid) {
          await saveAccountCache(priorActiveUid, sliceRef.current).catch(() => {});
        }
        const snap = await getDoc(ref);
        if (cancelled || activeUidRef.current !== uid) return;

        const legacyLocalLastWrittenRaw = !previousUid ? await AsyncStorage.getItem(SYNC_LAST_LOCAL_KEY) : null;
        const localLastWrittenRaw = await AsyncStorage.getItem(syncLastLocalKey(uid)) || legacyLocalLastWrittenRaw;
        const localLastWritten = localLastWrittenRaw ? parseInt(localLastWrittenRaw, 10) : 0;
        const cachedAccount = await loadAccountCache(uid).catch(() => null);

        const finishRestore = async (baselineAt: number) => {
          await AsyncStorage.setItem(SYNC_CURRENT_UID_KEY, uid).catch(() => {});
          lastSyncedAtRef.current = baselineAt;
          setTimeout(() => {
            if (!cancelled && activeUidRef.current === uid) {
              justRestoredRef.current = false;
              setSyncWriteReady(true);
            }
          }, 1500);
        };

        if (snap.exists()) {
          const remote = snap.data() as { updatedAt?: number; data?: SyncedState; schemaVersion?: number };
          const remoteAt = typeof remote?.updatedAt === 'number' ? remote.updatedAt : 0;
          const remoteData = remote?.data;
          const sameSchema = remote?.schemaVersion === SYNC_SCHEMA_VERSION;
          if (remoteData && sameSchema && (isAccountSwitch || remoteAt > localLastWritten)) {
            // Remote is newer than what we last wrote — restore.
            justRestoredRef.current = true;
            applyRestoredState(remoteData);
            await AsyncStorage.setItem(syncLastRemoteKey(uid), String(remoteAt));
            await AsyncStorage.setItem(syncLastLocalKey(uid), String(remoteAt));
            await AsyncStorage.setItem(SYNC_LAST_REMOTE_KEY, String(remoteAt));
            await AsyncStorage.setItem(SYNC_LAST_LOCAL_KEY, String(remoteAt));
            await saveAccountCache(uid, remoteData).catch(() => {});
            // Drop the suppression flag a tick later — long enough for the
            // state-applied effects to settle and trigger one watcher pass.
            await finishRestore(remoteAt);
            return;
          }
        }
        // No remote, or local is at least as fresh — establish baseline and
        // let the watcher push local up on next change.
        if (isAccountSwitch) {
          justRestoredRef.current = true;
          const fallbackState = cachedAccount?.data ?? emptySyncedState();
          applyRestoredState(fallbackState);
          const fallbackAt = cachedAccount?.savedAt ?? Date.now();
          await AsyncStorage.setItem(syncLastLocalKey(uid), String(fallbackAt));
          await finishRestore(fallbackAt);
          return;
        }
        lastSyncedAtRef.current = localLastWritten;
        await AsyncStorage.setItem(SYNC_CURRENT_UID_KEY, uid).catch(() => {});
        setSyncWriteReady(true);
      } catch {
        // Network or rules error — don't block local use. The next state change
        // will retry via the watcher; the cold-start restore is best-effort.
        setSyncWriteReady(!cancelled && activeUidRef.current === uid);
      }
    })();

    return () => {
      cancelled = true;
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    };
  }, [loadAccountCache, ready, saveAccountCache, syncUser?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Watcher: debounce-write the slice on change.
  useEffect(() => {
    if (!ready) return;
    if (!syncWriteReady) return;
    if (!syncUser?.uid) return;
    if (justRestoredRef.current) return;

    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(async () => {
      const uid = activeUidRef.current;
      if (!uid) return;
      const updatedAt = Date.now();
      const blob = buildSyncBlob(sliceRef.current, updatedAt);
      try {
        const db = getFirestore(getApp());
        await setDoc(doc(db, 'users', uid), blob);
        lastSyncedAtRef.current = updatedAt;
        await AsyncStorage.setItem(syncLastLocalKey(uid), String(updatedAt));
        await AsyncStorage.setItem(syncLastRemoteKey(uid), String(updatedAt));
        await AsyncStorage.setItem(SYNC_LAST_LOCAL_KEY, String(updatedAt));
        await AsyncStorage.setItem(SYNC_LAST_REMOTE_KEY, String(updatedAt));
        await AsyncStorage.setItem(SYNC_CURRENT_UID_KEY, uid);
        await saveAccountCache(uid, sliceRef.current).catch(() => {});
      } catch {
        // Permission denied, network failure, etc. Local data is fine; we'll
        // retry on the next state change. Persistence is not gated on Firestore.
      }
    }, SYNC_DEBOUNCE_MS);

    return () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  }, [ready, saveAccountCache, syncUser?.uid, syncWriteReady, syncedSlice]);

  // Apply a restored remote slice back into local state + AsyncStorage. Mirrors
  // the writes that loadAll() does so the local cache stays consistent.
  function applyRestoredState(s: SyncedState) {
    const restoredLists = ensurePersonalListPresent(s.lists);
    const restoredActiveListId = restoredLists.some(l => l.id === s.activeListId)
      ? s.activeListId
      : DEFAULT_LIST_ID;
    setListsState(restoredLists);
    setActiveListIdState(restoredActiveListId);
    setArchiveState(s.archive);
    setAccentLightState(s.accentLight);
    setAccentDarkState(s.accentDark);
    setThemeIdState(s.themeId);
    setCustomThemeDraftsState(s.customThemeDrafts);
    setPersonalContextState(s.personalContext);
    setDefaultTierState(s.defaultTier);
    setAutoClearState(s.autoClear);
    setDarkModeState(s.darkMode);
    setGroceryItemsState(s.groceryItems);
    if (Array.isArray(s.joinedSharedLists)) {
      restoreJoinedIds(s.joinedSharedLists.filter((id) => typeof id === 'string')).catch(() => {});
    }
    if (typeof s.syncEnabledForGrocery === 'boolean') {
      setViewingSharedGroceryState(s.syncEnabledForGrocery);
      AsyncStorage.setItem(SHARED_GROCERY_TOGGLE_KEY, s.syncEnabledForGrocery ? '1' : '0').catch(() => {});
    }
    const restoredSharedTaskOrder = Array.isArray(s.sharedTaskOrder)
      ? s.sharedTaskOrder.filter((id) => typeof id === 'string')
      : [];
    const restoredListRowOrder = Array.isArray(s.listRowOrder)
      ? s.listRowOrder.filter((id) => typeof id === 'string')
      : [];
    if (restoredSharedTaskOrder.length > 0) {
      setSharedTaskOrderState(restoredSharedTaskOrder);
    }
    if (restoredListRowOrder.length > 0) {
      setListRowOrderState(restoredListRowOrder);
    }
    AsyncStorage.multiSet([
      ['tri_lists', JSON.stringify(restoredLists)],
      ['tri_active_list_id', JSON.stringify(restoredActiveListId)],
      ['tri_archive', JSON.stringify(s.archive)],
      ['tri_theme', JSON.stringify(s.themeId)],
      ['tri_custom_themes', JSON.stringify(s.customThemeDrafts)],
      ['triority-context', JSON.stringify(s.personalContext)],
      ['tri_defaultTier', JSON.stringify(s.defaultTier)],
      ['tri_autoClear', JSON.stringify(s.autoClear)],
      ['tri_darkMode', JSON.stringify(s.darkMode)],
      ['tri_grocery', JSON.stringify(s.groceryItems)],
      ['tri_list_order', JSON.stringify(s.lists.map(l => l.id))],
      [SHARED_TASK_ORDER_KEY, JSON.stringify(restoredSharedTaskOrder)],
      [LIST_ROW_ORDER_KEY, JSON.stringify(restoredListRowOrder)],
    ]).catch(() => {});
    // accentLight/accentDark: nullable, so use removeItem when null.
    if (s.accentLight == null) AsyncStorage.removeItem('tri_accent_light').catch(() => {});
    else AsyncStorage.setItem('tri_accent_light', JSON.stringify(s.accentLight)).catch(() => {});
    if (s.accentDark == null) AsyncStorage.removeItem('tri_accent_dark').catch(() => {});
    else AsyncStorage.setItem('tri_accent_dark', JSON.stringify(s.accentDark)).catch(() => {});
  }

  const finishOnboarding = () => {
    setShowOnboarding(false);
    AsyncStorage.multiSet([
      ['tri_onboarded', '1'],
      [WIDGET_ONBOARDING_RELEASE_KEY, '1'],
    ]).catch(() => {});
  };
  const replayOnboarding = () => {
    setOnboardingInitialStep(0);
    setShowOnboarding(true);
  };

  const persistLists = (next: TaskList[]) => { AsyncStorage.setItem('tri_lists', JSON.stringify(next)).catch(() => {}); };

  // Refs let reorderLists read the current shared-id set without forming
  // a forward-reference dependency on sharedTaskIdSet (which is declared
  // far below this in the function body).
  const sharedTaskIdSetRef = useRef<Set<string>>(new Set());
  const reorderLists = useCallback((newLists: TaskList[]) => {
    // ListPillRow renders mergedLists (private + shared). When the user
    // drags any pill, the reorder callback gives us the full merged order
    // back. We must NOT persist shared list IDs into local `lists` state —
    // shared lists live in the SharedListsProvider listener cache and get
    // re-merged on every render. Persisting them here would duplicate them
    // (once from local lists, once from the shared-lists adapter).
    //
    // So: split the new order into private vs shared, and persist the full
    // row of IDs separately so shared pills can sit anywhere in the row.
    // The shared-only order remains as a compact migration fallback.
    const sharedIds = sharedTaskIdSetRef.current;
    const privateOnly = newLists.filter(l => !sharedIds.has(l.id));
    const sharedOnlyIds = newLists.filter(l => sharedIds.has(l.id)).map(l => l.id);
    const rowOrder = newLists.map(l => l.id);
    setListsState(privateOnly);
    setListRowOrderState(rowOrder);
    persistLists(privateOnly);
    AsyncStorage.setItem('tri_list_order', JSON.stringify(privateOnly.map(l => l.id))).catch(() => {});
    AsyncStorage.setItem(LIST_ROW_ORDER_KEY, JSON.stringify(rowOrder)).catch(() => {});
    if (sharedOnlyIds.length > 0) {
      setSharedTaskOrderState(sharedOnlyIds);
      AsyncStorage.setItem(SHARED_TASK_ORDER_KEY, JSON.stringify(sharedOnlyIds)).catch(() => {});
    }
  }, []);

  const applyListTasks = useCallback((listId: string, fn: (prev: Task[]) => Task[]) => {
    const now = Date.now();
    const next = listsRef.current.map(l => l.id === listId ? { ...l, tasks: fn(l.tasks), updatedAt: now } : l);
    listsRef.current = next;
    setListsState(next);
    persistLists(next);
  }, []);

  const setTasks = useCallback((fn: (prev: Task[]) => Task[]) => {
    applyListTasks(activeListId, fn);
  }, [activeListId, applyListTasks]);

  const setListTasks = useCallback((listId: string, fn: (prev: Task[]) => Task[]) => {
    applyListTasks(listId, fn);
  }, [applyListTasks]);

  const addManyToActiveList = useCallback((items: TaskDraft[]) => {
    const now = Date.now();
    const newTasks: Task[] = items.map((item, i) => ({
      id: now + i, text: item.text, widgetLabel: item.widgetLabel, tier: item.tier, createdAt: now + i, reminder: item.reminder,
    }));
    setTasks(ts => [...ts, ...newTasks]);
    // No toast renderer at TriorityApp scope; missing-perm path still redirects to system settings.
    scheduleRemindersBatch(newTasks, () => {}, activeListId);
    return newTasks.map((task) => task.id);
  }, [activeListId, setTasks]);

  const addManyToList = useCallback((listId: string, items: TaskDraft[]) => {
    const now = Date.now();
    const newTasks: Task[] = items.map((item, i) => ({
      id: now + i, text: item.text, widgetLabel: item.widgetLabel, tier: item.tier, createdAt: now + i, reminder: item.reminder,
    }));
    setListTasks(listId, ts => [...ts, ...newTasks]);
    scheduleRemindersBatch(newTasks, () => {}, listId);
    return newTasks.map((task) => task.id);
  }, [setListTasks]);

  const setActiveListId = useCallback((id: string) => {
    setActiveListIdState(id);
    AsyncStorage.setItem('tri_active_list_id', JSON.stringify(id)).catch(() => {});
  }, []);

  const addList = useCallback((name: string, color?: string) => {
    const id = `list_${Date.now()}`;
    const now = Date.now();
    setListsState(prev => {
      const next: TaskList[] = [...prev, { id, name: name.trim() || 'New List', color, tasks: [], createdAt: now, updatedAt: now }];
      persistLists(next);
      return next;
    });
    setActiveListId(id);
    return id;
  }, [setActiveListId]);

  const renameList = useCallback((id: string, name: string) => {
    const now = Date.now();
    setListsState(prev => {
      const next = prev.map(l => l.id === id ? { ...l, name: name.trim() || l.name, updatedAt: now } : l);
      persistLists(next);
      return next;
    });
  }, []);


  const deleteList = useCallback((id: string) => {
    if (id === DEFAULT_LIST_ID) return;
    let nextActiveListId: string | null = null;
    setListsState(prev => {
      if (prev.length <= 1) return prev; // never delete the last list
      const next = prev.filter(l => l.id !== id);
      if (next.length === prev.length || next.length === 0) return prev;
      if (activeListId === id) {
        nextActiveListId = (next.find(l => l.id === DEFAULT_LIST_ID) ?? next[0]).id;
      }
      persistLists(next);
      return next;
    });
    if (nextActiveListId) setActiveListId(nextActiveListId);
  }, [activeListId, setActiveListId]);

  const setArchive = useCallback((fn: (prev: ArchivedTask[]) => ArchivedTask[]) => {
    setArchiveState(prev => { const next = fn(prev); AsyncStorage.setItem('tri_archive', JSON.stringify(next)); return next; });
  }, []);

  const setAccentLight = (v: string | null) => {
    setAccentLightState(v);
    if (v == null) AsyncStorage.removeItem('tri_accent_light').catch(() => {});
    else AsyncStorage.setItem('tri_accent_light', JSON.stringify(v)).catch(() => {});
  };
  const setAccentDark = (v: string | null) => {
    setAccentDarkState(v);
    if (v == null) AsyncStorage.removeItem('tri_accent_dark').catch(() => {});
    else AsyncStorage.setItem('tri_accent_dark', JSON.stringify(v)).catch(() => {});
  };
  const setThemeId = (v: string) => { setThemeIdState(v); AsyncStorage.setItem('tri_theme', JSON.stringify(v)).catch(() => {}); };
  const setWidgetThemeId = (v: WidgetThemeId) => {
    const next = v === WIDGET_THEME_MATCH_APP || v === WIDGET_THEME_CUSTOM ? v : resolveThemeId(v);
    setWidgetThemeIdState(next);
    AsyncStorage.setItem(WIDGET_THEME_KEY, JSON.stringify(next)).catch(() => {});
  };
  const setWidgetClear = (v: boolean) => {
    setWidgetClearState(v);
    AsyncStorage.setItem(WIDGET_CLEAR_KEY, v ? '1' : '0').catch(() => {});
  };
  const setWidgetShorthand = (v: boolean) => {
    setWidgetShorthandState(v);
    AsyncStorage.setItem(WIDGET_SHORTHAND_KEY, v ? '1' : '0').catch(() => {});
  };
  const setWidgetCustomColors = (v: WidgetCustomColors) => {
    setWidgetCustomColorsState(v);
    AsyncStorage.setItem(WIDGET_CUSTOM_COLORS_KEY, JSON.stringify(v)).catch(() => {});
  };
  const setWidgetMicSide = (v: WidgetMicSide) => {
    const next = v === 'right' ? 'right' : 'left';
    setWidgetMicSideState(next);
    AsyncStorage.setItem(WIDGET_MIC_SIDE_KEY, JSON.stringify(next)).catch(() => {});
  };
  const setCustomThemeDrafts = (drafts: (CustomThemeDraft | null)[]) => {
    setCustomThemeDraftsState(drafts);
    AsyncStorage.setItem('tri_custom_themes', JSON.stringify(drafts)).catch(() => {});
  };
  const setApiKey = (v: string) => {
    setApiKeyState(v);
    EncryptedStorage.setItem('triority-api-key', v).catch(() => {});
  };
  const setPersonalContext = (v: string) => { setPersonalContextState(v); AsyncStorage.setItem('triority-context', JSON.stringify(v)).catch(() => {}); };
  const setAutoClear = (v: AutoClear) => { setAutoClearState(v); AsyncStorage.setItem('tri_autoClear', JSON.stringify(v)).catch(() => {}); };
  const setDarkMode = (v: boolean) => { setDarkModeState(v); AsyncStorage.setItem('tri_darkMode', JSON.stringify(v)).catch(() => {}); };

  const customSlotIndex = /^custom_([012])$/.exec(themeId)?.[1];
  const activeCustomDraft = customSlotIndex != null
    ? (customThemeDrafts[Number(customSlotIndex)] ?? DEFAULT_CUSTOM_THEME_DRAFT)
    : null;
  const themeDef = activeCustomDraft ? draftToThemeDef(activeCustomDraft) : getTheme(themeId);
  const T = darkMode ? themeDef.dark : themeDef.light;
  const accentColor = activeCustomDraft
    ? themeDef.defaultAccentDark
    : (darkMode
      ? (accentDark ?? themeDef.defaultAccentDark)
      : (accentLight ?? themeDef.defaultAccentLight));
  const widgetIsCustom = widgetThemeId === WIDGET_THEME_CUSTOM;
  const widgetThemeDef = widgetThemeId === WIDGET_THEME_MATCH_APP || widgetIsCustom ? null : getTheme(widgetThemeId);
  const widgetT = widgetThemeDef ? (darkMode ? widgetThemeDef.dark : widgetThemeDef.light) : T;
  const widgetAccentColor = widgetThemeDef
    ? (darkMode ? widgetThemeDef.defaultAccentDark : widgetThemeDef.defaultAccentLight)
    : widgetIsCustom ? widgetCustomColors.accent : accentColor;
  const widgetTextColor = widgetIsCustom ? widgetCustomColors.text : widgetT.text;
  const widgetControlColor = widgetThemeColor(widgetT.s2, widgetT.bg);
  const widgetSurfaceColor = widgetThemeColor(widgetT.s2, widgetT.bg);
  const widgetTextSubColor = widgetIsCustom ? widgetCustomColors.accent : widgetThemeColor(widgetT.textSub, widgetT.bg);
  // ─── Shared lists adapter (step 11b.3) ─────────────────────────────────
  // Merge private lists with the user's joined shared task lists into one
  // pill-row view. Shared lists adapt into TaskList shape on the fly using
  // the live items subcollection mirror. The adapter owns no state — every
  // shared mutation goes through the provider, which echoes via the
  // listener and reflows the merged view automatically.
  const {
    sharedLists: sharedListsMap,
    sharedItems,
    sharedArchives,
    addSharedTaskItems,
    editSharedTaskItem,
    deleteSharedTaskItem,
    archiveSharedTaskItem,
    restoreSharedArchiveItem,
    deleteSharedArchiveItem,
    promoteGroceryListToShared,
    addSharedGroceryItems,
    updateSharedGroceryItem,
    deleteSharedGroceryItem,
    deleteSharedGroceryItems,
    updateSharedGroceryCategories,
    rotateShareCode,
    leaveSharedList,
    deleteSharedList,
  } = useSharedLists();

  // Adapt shared-list items into Task[] for ActiveList rendering.
  // Reminder payloads stay on the row so each member device can schedule them locally.
  const sharedTaskLists: TaskList[] = useMemo(() => {
    const out: TaskList[] = [];
    for (const l of Object.values(sharedListsMap)) {
      if (l.kind !== 'tasks') continue;
      const items = sharedItems[l.id] || [];
      const adapted: Task[] = items.map(it => {
        const editor = it.lastEditedBy ? l.members?.[it.lastEditedBy] : undefined;
        return {
          id: it.id,
          text: it.text || '',
          widgetLabel: it.widgetLabel,
          tier: it.tier || 'medium',
          createdAt: it.createdAt || 0,
          reminder: it.reminder || undefined,
          sharedAvatarSlot: editor?.avatarSlot,
          sharedAvatarInitial: editor?.emailInitial,
          sharedLastEditedAt: it.lastEditedAt,
        };
      });
      out.push({
        id: l.id,
        name: l.name,
        tasks: adapted,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      });
    }
    return out;
  }, [sharedListsMap, sharedItems]);

  const sharedTaskIdSet = useMemo(() => new Set(sharedTaskLists.map(l => l.id)), [sharedTaskLists]);
  const reminderTasksForScheduling = useMemo(() => {
    const privateTasks = lists.flatMap(l =>
      l.tasks.map(t => ({ ...t, reminderListId: l.id, reminderTaskId: t.id })),
    );
    const sharedTasks = sharedTaskLists.flatMap(l =>
      l.tasks.map(t => ({ ...t, id: `shared_${l.id}_${t.id}`, reminderListId: l.id, reminderTaskId: t.id })),
    );
    return [...privateTasks, ...sharedTasks];
  }, [lists, sharedTaskLists]);

  useEffect(() => {
    if (!ready) return;
    syncAllReminders(reminderTasksForScheduling).catch(() => {});
  }, [ready, reminderTasksForScheduling]);

  useEffect(() => {
    if (!ready || !calendarConflictsEnabled || !syncUser?.uid) {
      setCalendarConflictKeys(new Set());
      setCalendarConflictNotice(null);
      return;
    }

    let cancelled = false;
    let showedFailure = false;
    const checkCalendarConflicts = async () => {
      const now = Date.now();
      const candidates = reminderTasksForScheduling
        .map((task) => {
          if (!task.reminder) return null;
          const remindAt = nextReminderOccurrenceAt(task.reminder, now);
          const key = calendarConflictKeyForTask(task);
          if (!remindAt || !key) return null;
          return {
            key,
            start: remindAt,
            end: remindAt + CALENDAR_CONFLICT_WINDOW_MS,
          };
        })
        .filter((candidate): candidate is { key: string; start: number; end: number } => !!candidate);

      if (candidates.length === 0) {
        if (!cancelled) setCalendarConflictKeys(new Set());
        return;
      }

      const token = await getCalendarFreeBusyAccessToken();
      if (!token) throw new Error('Calendar access needs attention');

      const min = Math.min(...candidates.map((candidate) => candidate.start));
      const max = Math.max(...candidates.map((candidate) => candidate.end));
      const busyBlocks = await fetchCalendarBusyBlocks(token, min - 60000, max + 60000);
      const nextKeys = new Set<string>();
      for (const candidate of candidates) {
        if (busyBlocks.some((busy) => busy.start < candidate.end && busy.end > candidate.start)) {
          nextKeys.add(candidate.key);
        }
      }
      if (!cancelled) setCalendarConflictKeys(nextKeys);
      if (!cancelled) setCalendarConflictNotice(null);
    };

    checkCalendarConflicts().catch((error) => {
      if (!cancelled) {
        setCalendarConflictKeys(new Set());
        const message = calendarCheckErrorMessage(error);
        if (!showedFailure) {
          showedFailure = true;
          setCalendarConflictNotice(message);
        }
      }
    });
    const interval = setInterval(() => {
      checkCalendarConflicts().catch(() => {
        if (!cancelled) setCalendarConflictKeys(new Set());
      });
    }, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [calendarConflictsEnabled, ready, reminderTasksForScheduling, syncUser?.uid]);

  useEffect(() => {
    if (!ready) return;
    const checkDueReminders = () => {
      if (AppState.currentState !== 'active') return;
      const now = Date.now();
      for (const task of reminderTasksForScheduling) {
        const occurrence = activeReminderOccurrence(task, now);
        if (!occurrence) continue;
        const firedKey = `${task.id}:${occurrence}`;
        if (activeReminderFiredRef.current.has(firedKey)) continue;
        openedReminderTargetsRef.current = openedReminderTargetsRef.current.filter((entry) => now - entry.openedAt < 90000);
        if (openedReminderTargetsRef.current.some((entry) => reminderTaskMatchesTarget(task, entry.target))) {
          activeReminderFiredRef.current.add(firedKey);
          continue;
        }
        activeReminderFiredRef.current.add(firedKey);
        displayActiveReminder(task).catch(() => {});
      }
      if (activeReminderFiredRef.current.size > 250) {
        activeReminderFiredRef.current = new Set(Array.from(activeReminderFiredRef.current).slice(-100));
      }
    };

    checkDueReminders();
    const interval = setInterval(checkDueReminders, 15000);
    return () => clearInterval(interval);
  }, [ready, reminderTasksForScheduling]);

  const sharedGroceryDoc = useMemo(() => {
    return Object.values(sharedListsMap).find((l) => l.kind === 'grocery') ?? null;
  }, [sharedListsMap]);
  const sharedGroceryItems = useMemo(() => {
    if (!sharedGroceryDoc) return [];
    return (sharedItems[sharedGroceryDoc.id] || []).map((it): GroceryItem => {
      const creator = it.createdBy ? sharedGroceryDoc.members?.[it.createdBy] : undefined;
      return {
        id: it.id,
        name: it.name || '',
        category: it.category || GROCERY_UNCATEGORIZED,
        quantity: it.quantity,
        unit: it.unit,
        packageSize: it.packageSize,
        checked: !!it.checked,
        createdAt: it.createdAt || 0,
        sharedAvatarSlot: creator?.avatarSlot,
        sharedAvatarInitial: creator?.emailInitial,
        sharedAddedAt: it.createdAt || 0,
      };
    });
  }, [sharedGroceryDoc, sharedItems]);
  const combinedArchive = useMemo((): ArchivedTask[] => {
    const shared: ArchivedTask[] = [];
    for (const l of Object.values(sharedListsMap)) {
      if (l.kind !== 'tasks') continue;
      const canDelete = !!syncUser && l.ownerUid === syncUser.uid;
      for (const item of sharedArchives[l.id] || []) {
        const member = l.members?.[item.archivedBy];
        shared.push({
          id: item.id,
          text: item.text || '',
          tier: item.tier || 'medium',
          completedAt: item.completedAt || 0,
          createdAt: item.createdAt,
          listId: l.id,
          sharedListId: l.id,
          sharedListName: l.name,
          sharedCanDelete: canDelete,
          archivedByInitial: member?.emailInitial,
        });
      }
    }
    return [...archive, ...shared];
  }, [archive, sharedArchives, sharedListsMap, syncUser]);
  // Mirror the live id set into a ref that reorderLists (declared earlier
  // in this function) reads. Avoids forward-reference into a state value
  // declared further down the function body.
  useEffect(() => { sharedTaskIdSetRef.current = sharedTaskIdSet; }, [sharedTaskIdSet]);

  useEffect(() => {
    if (!ready) return;
    const liveIds = sharedTaskLists.map(l => l.id);
    setSharedTaskOrderState(prev => {
      const next = [
        ...prev.filter(id => liveIds.includes(id)),
        ...liveIds.filter(id => !prev.includes(id)),
      ];
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev;
      AsyncStorage.setItem(SHARED_TASK_ORDER_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [ready, sharedTaskLists]);

  useEffect(() => {
    if (!ready) return;
    const liveIds = [...lists.map(l => l.id), ...sharedTaskLists.map(l => l.id)];
    const retainedIds = new Set([...liveIds, ...syncedJoinedIds]);
    setListRowOrderState(prev => {
      const next = [
        ...prev.filter(id => retainedIds.has(id)),
        ...liveIds.filter(id => !prev.includes(id)),
      ];
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev;
      AsyncStorage.setItem(LIST_ROW_ORDER_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [ready, lists, sharedTaskLists, syncedJoinedIds]);

  const orderedSharedTaskLists = useMemo(() => {
    const byId = new Map(sharedTaskLists.map(l => [l.id, l]));
    return [
      ...sharedTaskOrder.map(id => byId.get(id)).filter(Boolean) as TaskList[],
      ...sharedTaskLists.filter(l => !sharedTaskOrder.includes(l.id)),
    ];
  }, [sharedTaskLists, sharedTaskOrder]);

  // Merged pill-row source. Private lists keep their existing order; shared
  // lists append after them. A future enhancement could weave them per the
  // user's tri_list_order — deferred until users ask for it.
  const mergedLists: TaskList[] = useMemo(() => {
    const base = [...lists, ...orderedSharedTaskLists];
    if (listRowOrder.length === 0) return base;
    const byId = new Map(base.map(l => [l.id, l]));
    return [
      ...listRowOrder.map(id => byId.get(id)).filter(Boolean) as TaskList[],
      ...base.filter(l => !listRowOrder.includes(l.id)),
    ];
  }, [lists, orderedSharedTaskLists, listRowOrder]);

  // Active list resolution: try shared first (since their IDs don't collide
  // with private list IDs), then fall back to private. If the active ID
  // points at a shared list the user just left (listener tore it down), we
  // fall back to the first private list.
  const activeShared = orderedSharedTaskLists.find(l => l.id === activeListId);
  const activeList = activeShared ?? lists.find(l => l.id === activeListId) ?? lists[0];
  const isActiveShared = !!activeShared;
  const activeListIdIsLive = mergedLists.some(l => l.id === activeListId);
  const widgetNextUpItems = useMemo((): WidgetNextUpItem[] => {
    const now = Date.now();
    const listIndex = new Map(mergedLists.map((list, index) => [list.id, index]));
    const normalizeLabel = (text: string) => text.replace(/\s+/g, ' ').trim();
    const tierLabel = (tier: Tier) => tier === 'high' ? 'High' : tier === 'medium' ? 'Medium' : 'Low';
    const tierColor = (tier: Tier) => tier === 'high' ? widgetT.high : tier === 'medium' ? widgetT.med : widgetT.low;
    const reminderRows: { item: WidgetNextUpItem; sortAt: number; listOrder: number; tierOrder: number; createdAt: number }[] = [];
    const taskRows: { item: WidgetNextUpItem; listOrder: number; tierOrder: number; createdAt: number }[] = [];

    mergedLists.forEach((list, index) => {
      list.tasks.forEach((task) => {
        const label = normalizeLabel(widgetShorthand
          ? widgetDisplayLabel(task)
          : task.text);
        if (!label) return;
        const listOrder = listIndex.get(list.id) ?? index;
        const tierOrder = TIER_ORDER[task.tier] ?? 1;
        const createdAt = task.createdAt || 0;
        if (task.reminder) {
          const r = task.reminder;
          const repeatNext = nextReminderOccurrenceAt(r, now);
          const sortAt = (!r.repeatHourly && !r.repeatDaily && r.remindAt < now) ? r.remindAt : (repeatNext ?? r.remindAt);
          const reminderText = formatWidgetReminderTime(sortAt);
          reminderRows.push({
            item: {
              listId: list.id,
              taskId: String(task.id),
              label,
              meta: `${list.name} / ${tierLabel(task.tier)} / ${reminderText}`,
              listName: list.name,
              priorityLabel: tierLabel(task.tier),
              priorityColor: tierColor(task.tier),
              reminderText,
            },
            sortAt,
            listOrder,
            tierOrder,
            createdAt,
          });
          return;
        }
        taskRows.push({
          item: {
            listId: list.id,
            taskId: String(task.id),
            label,
            meta: `${list.name} / ${tierLabel(task.tier)}`,
            listName: list.name,
            priorityLabel: tierLabel(task.tier),
            priorityColor: tierColor(task.tier),
          },
          listOrder,
          tierOrder,
          createdAt,
        });
      });
    });

    reminderRows.sort((a, b) =>
      (a.sortAt - b.sortAt) ||
      (a.listOrder - b.listOrder) ||
      (a.tierOrder - b.tierOrder) ||
      (a.createdAt - b.createdAt)
    );
    taskRows.sort((a, b) =>
      (a.tierOrder - b.tierOrder) ||
      (a.listOrder - b.listOrder) ||
      (a.createdAt - b.createdAt)
    );

    return [
      ...reminderRows.map(row => row.item),
      ...taskRows.map(row => row.item),
    ].slice(0, 8);
  }, [mergedLists, widgetShorthand, widgetT.high, widgetT.med, widgetT.low]);
  const widgetNextUpJson = useMemo(() => JSON.stringify(widgetNextUpItems), [widgetNextUpItems]);

  useEffect(() => {
    if (!ready || !TriorityWidget) return;
    try {
      TriorityWidget.updateWidgetTheme({
        background: widgetT.bg,
        surface: widgetSurfaceColor,
        control: widgetControlColor,
        accent: widgetAccentColor,
        text: widgetTextColor,
        textSub: widgetTextSubColor,
        clear: widgetClear,
        activeListName: activeList?.name || DEFAULT_LIST_NAME,
        activeListId,
        hasApiKey,
        nextUpJson: widgetNextUpJson,
        micSide: widgetMicSide,
      });
    } catch {}
  }, [ready, widgetT.bg, widgetTextColor, widgetAccentColor, widgetSurfaceColor, widgetControlColor, widgetTextSubColor, widgetClear, activeList?.name, activeListId, hasApiKey, widgetNextUpJson, widgetMicSide]);

  useEffect(() => {
    if (!ready || !pendingReminderNav) return;
    const taskId = pendingReminderNav.taskId || pendingReminderNav.scheduledTaskId;
    let targetListId = pendingReminderNav.listId;
    if (!targetListId && taskId) {
      targetListId = mergedLists.find(l => l.tasks.some(t => String(t.id) === taskId))?.id;
    }
    if (!targetListId || !mergedLists.some(l => l.id === targetListId)) return;
    setScreen('list');
    setActiveListId(targetListId);
    if (taskId) {
      armFocusedTask(taskId);
    }
    setPendingReminderNav(null);
  }, [armFocusedTask, mergedLists, pendingReminderNav, ready, setActiveListId]);

  useEffect(() => {
    if (!pendingReminderNav || !focusedTaskId) return;
    setPendingReminderNav(null);
  }, [focusedTaskId, pendingReminderNav]);

  const markFocusedTaskSeen = useCallback(() => {
    if (!focusedTaskId) return;
    const seenNonce = focusedTaskNonce;
    setTimeout(() => {
      if (focusedTaskNonceRef.current !== seenNonce) return;
      setFocusedTaskId(current => current === focusedTaskId ? null : current);
    }, FOCUSED_ROW_CLEAR_MS);
  }, [focusedTaskId, focusedTaskNonce]);

  const armFocusedGrocery = useCallback((id: string) => {
    setFocusedGroceryId(id);
    setFocusedGroceryNonce(n => n + 1);
  }, []);

  const markFocusedGrocerySeen = useCallback(() => {
    if (!focusedGroceryId) return;
    setTimeout(() => {
      setFocusedGroceryId(current => current === focusedGroceryId ? null : current);
    }, FOCUSED_ROW_CLEAR_MS);
  }, [focusedGroceryId]);

  useEffect(() => {
    if (!ready || activeListIdIsLive || !activeList?.id) return;
    setActiveListId(activeList.id);
  }, [ready, activeListIdIsLive, activeList?.id, setActiveListId]);

  // sharedActions binds the active shared list's ID into the provider CRUD
  // helpers so ActiveList can call them without knowing the list ID.
  const sharedActionsForActive = useMemo(() => {
    if (!isActiveShared) return undefined;
    const listId = activeListId;
    return {
      addItems: (items: TaskDraft[]) => addSharedTaskItems(listId, items),
      editItem: (itemId: TaskId, patch: { text?: string; tier?: Tier; reminder?: Reminder | null }) => editSharedTaskItem(listId, String(itemId), patch),
      deleteItem: (itemId: TaskId) => deleteSharedTaskItem(listId, String(itemId)),
      archiveItem: (itemId: TaskId, item: { text: string; tier: Tier; createdAt?: number }) => archiveSharedTaskItem(listId, String(itemId), item),
    };
  }, [isActiveShared, activeListId, addSharedTaskItems, editSharedTaskItem, deleteSharedTaskItem, archiveSharedTaskItem]);

  useEffect(() => {
    if (!sharedGroceryDoc && viewingSharedGrocery) {
      setViewingSharedGrocery(false);
    }
  }, [sharedGroceryDoc, setViewingSharedGrocery, viewingSharedGrocery]);

  useEffect(() => {
    if (!sharedGroceryDoc || viewingSharedGrocery) return;
    AsyncStorage.getItem(SHARED_GROCERY_TOGGLE_KEY)
      .then((raw) => {
        if (raw === '1') setViewingSharedGrocery(true);
      })
      .catch(() => {});
  }, [sharedGroceryDoc, setViewingSharedGrocery, viewingSharedGrocery]);

  const usingSharedGrocery = !!sharedGroceryDoc;
  const groceryItemsForScreen = usingSharedGrocery ? sharedGroceryItems : groceryItems;
  const groceryGroupCollapseScope = usingSharedGrocery && sharedGroceryDoc
    ? `shared:${sharedGroceryDoc.id}`
    : 'private';

  const addGroceryItemsForScreen = useCallback((items: GroceryDraft[]) => {
    if (!usingSharedGrocery || !sharedGroceryDoc) {
      return addGroceryItems(items);
    }
    return addSharedGroceryItems(sharedGroceryDoc.id, items);
  }, [addGroceryItems, addSharedGroceryItems, sharedGroceryDoc, usingSharedGrocery]);

  useEffect(() => {
    if (!ready || !TriorityWidget?.consumePendingCaptures) return;
    let cancelled = false;
    let running = false;

    const resolveWidgetTargetListId = (candidate?: string | null) => {
      if (candidate && mergedLists.some(list => list.id === candidate)) return candidate;
      if (mergedLists.some(list => list.id === activeListId)) return activeListId;
      return lists[0]?.id ?? DEFAULT_LIST_ID;
    };

    const addWidgetItems = async (targetListId: string, items: TaskDraft[]) => {
      const resolvedListId = resolveWidgetTargetListId(targetListId);
      if (sharedTaskIdSet.has(resolvedListId)) {
        try {
          const ids = await addSharedTaskItems(resolvedListId, items);
          return { listId: resolvedListId, ids: Array.isArray(ids) ? ids : [] };
        } catch {
          const fallbackListId = lists[0]?.id ?? DEFAULT_LIST_ID;
          const ids = addManyToList(fallbackListId, items);
          return { listId: fallbackListId, ids: Array.isArray(ids) ? ids : [] };
        }
      }
      const ids = addManyToList(resolvedListId, items);
      return { listId: resolvedListId, ids: Array.isArray(ids) ? ids : [] };
    };

    const widgetResultSummary = (taskCount: number, groceryCount: number, reminderCount: number) => {
      if (taskCount === 0 && groceryCount > 0) {
        return `Added ${groceryCount} ${groceryCount === 1 ? 'grocery' : 'groceries'}`;
      }
      if (groceryCount === 0 && taskCount > 0 && reminderCount === taskCount) {
        return `Created ${taskCount} ${taskCount === 1 ? 'reminder' : 'reminders'}`;
      }
      if (groceryCount > 0 && taskCount > 0) {
        return `Added ${taskCount} ${taskCount === 1 ? 'task' : 'tasks'} + ${groceryCount} ${groceryCount === 1 ? 'grocery' : 'groceries'}`;
      }
      if (taskCount > 0) {
        return `Added ${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;
      }
      return '';
    };

    const consumeWidgetCaptures = async () => {
      if (running) return;
      running = true;
      try {
        const raw = await TriorityWidget.consumePendingCaptures();
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) return;

        const taskFocusCandidates: { listId: string; id: TaskId }[] = [];
        let firstGroceryId: string | null = null;
        let addedTasks = 0;
        let addedGroceries = 0;
        let addedReminders = 0;

        for (const capture of parsed as WidgetPendingCapture[]) {
          const text = String(capture?.text ?? '').trim();
          if (!text) continue;
          const tier = capture?.tier === 'high' || capture?.tier === 'low' || capture?.tier === 'medium' ? capture.tier : 'medium';
          const preferredListId = resolveWidgetTargetListId(typeof capture?.listId === 'string' ? capture.listId : activeListId);
          const draft = capture?.mode === 'ai'
            ? await parseWidgetAiCapture({
                raw: text,
                lists: mergedLists,
                activeListId: preferredListId,
                defaultTier: tier,
                apiKey,
                hasApiKey,
                personalContext,
                isPaid,
                widgetShorthand,
              })
            : { listId: preferredListId, tasks: [{ text, tier }], grocery: [] };

          if (draft.tasks.length > 0) {
            const addResult = await addWidgetItems(draft.listId ?? preferredListId, draft.tasks);
            addedTasks += draft.tasks.length;
            addedReminders += draft.tasks.filter(item => !!item.reminder).length;
            const firstId = addResult.ids?.[0];
            if (firstId != null) {
              taskFocusCandidates.push({ listId: addResult.listId, id: firstId });
            }
          }

          if (draft.grocery.length > 0) {
            const ids = await Promise.resolve(addGroceryItemsForScreen(draft.grocery));
            addedGroceries += draft.grocery.length;
            if (!firstGroceryId && Array.isArray(ids) && ids[0]) {
              firstGroceryId = ids[0];
            }
          }
        }

        const resultText = widgetResultSummary(addedTasks, addedGroceries, addedReminders);
        if (resultText) {
          try { TriorityWidget.showWidgetResult?.(resultText); } catch {}
        }

        const leftmostTask = taskFocusCandidates
          .filter(candidate => mergedLists.some(list => list.id === candidate.listId))
          .sort((a, b) => {
            const ai = mergedLists.findIndex(list => list.id === a.listId);
            const bi = mergedLists.findIndex(list => list.id === b.listId);
            return ai - bi;
          })[0] ?? taskFocusCandidates[0] ?? null;

        if (!cancelled && leftmostTask) {
          setScreen('list');
          setActiveListId(leftmostTask.listId);
          armFocusedTask(String(leftmostTask.id));
        } else if (!cancelled && firstGroceryId) {
          setScreen('grocery');
          armFocusedGrocery(firstGroceryId);
        }
      } catch {}
      finally {
        running = false;
      }
    };

    consumeWidgetCaptures();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') consumeWidgetCaptures();
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [
    activeListId,
    addGroceryItemsForScreen,
    addManyToList,
    addSharedTaskItems,
    armFocusedTask,
    armFocusedGrocery,
    apiKey,
    hasApiKey,
    isPaid,
    lists,
    mergedLists,
    personalContext,
    ready,
    setActiveListId,
    sharedTaskIdSet,
    widgetShorthand,
  ]);

  const checkGroceryForScreen = useCallback((id: string) => {
    if (!usingSharedGrocery || !sharedGroceryDoc) {
      checkGrocery(id);
      return;
    }
    const item = sharedGroceryItems.find((it) => it.id === id);
    updateSharedGroceryItem(sharedGroceryDoc.id, id, { checked: !(item?.checked ?? false) }).catch(() => {});
  }, [checkGrocery, sharedGroceryDoc, sharedGroceryItems, updateSharedGroceryItem, usingSharedGrocery]);

  const deleteGroceryForScreen = useCallback((id: string) => {
    if (!usingSharedGrocery || !sharedGroceryDoc) {
      deleteGrocery(id);
      return;
    }
    deleteSharedGroceryItem(sharedGroceryDoc.id, id).catch(() => {});
  }, [deleteGrocery, deleteSharedGroceryItem, sharedGroceryDoc, usingSharedGrocery]);

  const clearCheckedGroceryForScreen = useCallback(() => {
    if (!usingSharedGrocery || !sharedGroceryDoc) {
      clearCheckedGrocery();
      return;
    }
    const checkedIds = sharedGroceryItems.filter((it) => it.checked).map((it) => it.id);
    deleteSharedGroceryItems(sharedGroceryDoc.id, checkedIds).catch(() => {});
  }, [clearCheckedGrocery, deleteSharedGroceryItems, sharedGroceryDoc, sharedGroceryItems, usingSharedGrocery]);

  const clearAllGroceryForScreen = useCallback(() => {
    if (!usingSharedGrocery || !sharedGroceryDoc) {
      clearAllGrocery();
      return;
    }
    deleteSharedGroceryItems(sharedGroceryDoc.id, sharedGroceryItems.map((it) => it.id)).catch(() => {});
  }, [clearAllGrocery, deleteSharedGroceryItems, sharedGroceryDoc, sharedGroceryItems, usingSharedGrocery]);

  const aiSortGroceryForScreen = useCallback(async (onDone?: () => void) => {
    if (!usingSharedGrocery || !sharedGroceryDoc) {
      aiSortGrocery(onDone);
      return;
    }
    let storedKey = '';
    try { storedKey = await EncryptedStorage.getItem('triority-api-key') || ''; } catch {}
    if (!storedKey || sharedGroceryItems.length === 0) { onDone?.(); return; }
    const validCats = new Set([...GROCERY_CATEGORIES, GROCERY_UNCATEGORIZED]);
    const systemPrompt = `Assign a grocery category to each item. Categories: ${GROCERY_CATEGORIES.join(', ')}, or "${GROCERY_UNCATEGORIZED}".
Return ONLY valid JSON. The first character must be [ and the last character must be ]. No prose, no markdown.
Format: [{"id":"item_id","category":"Dairy"}]`;
    const userMsg = sharedGroceryItems.map(i => `{"id":"${i.id}","name":"${i.name}"}`).join('\n');
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': storedKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
        tools: [aiGroceryCategoryTool()],
        tool_choice: { type: 'tool', name: AI_GROCERY_CATEGORY_TOOL_NAME },
      }),
    }).then(r => r.json()).then(data => {
      const parsed = anthropicToolInputFromResponse(data, AI_GROCERY_CATEGORY_TOOL_NAME);
      const parsedAssignments: { id: string; category: string }[] = Array.isArray(parsed.assignments) ? parsed.assignments : [];
      const assignments = parsedAssignments.map((a) => ({
        id: a.id,
        category: validCats.has(a.category) ? a.category : GROCERY_UNCATEGORIZED,
      }));
      updateSharedGroceryCategories(sharedGroceryDoc.id, assignments).finally(() => onDone?.());
    }).catch(() => { onDone?.(); });
  }, [aiSortGrocery, sharedGroceryDoc, sharedGroceryItems, updateSharedGroceryCategories, usingSharedGrocery]);

  if (!ready) {
    return (
      <View style={[styles.loadingScreen, { backgroundColor: T.bg }]}>
        <Text style={[styles.loadingText, { color: T.textMute, fontFamily: jks('700') }]}>Triority</Text>
      </View>
    );
  }

  return (
    <ThemeCtx.Provider value={T}>
      <StatusBar barStyle={darkMode ? 'light-content' : 'dark-content'} backgroundColor={T.bg} translucent={false} />
      <View style={[styles.root, { backgroundColor: T.bg }]}>
        <PortalHost>
          <BackButtonManager screen={screen} setScreen={setScreen} />
          <View style={{ flex: 1, overflow: 'hidden' }}>
            {screen === 'list' && <ActiveList tasks={activeList.tasks} setTasks={setTasks} setListTasks={setListTasks} accentColor={accentColor} hasApiKey={hasApiKey} defaultTier={defaultTier} widgetShorthand={widgetShorthand} setArchive={setArchive} activeListId={activeListId} lists={mergedLists} setActiveListId={setActiveListId} addList={addList} renameList={renameList} deleteList={deleteList} reorderLists={reorderLists} onAddGroceryItems={addGroceryItemsForScreen} setScreen={setScreen} onGroceryOnlyAdded={(ids) => { if (ids[0]) armFocusedGrocery(ids[0]); setScreen('grocery'); }} sharedActions={sharedActionsForActive} sharedIdSet={sharedTaskIdSet} collapsedGroups={collapsedGroups} setCollapsedGroup={setCollapsedGroup} focusedTaskId={focusedTaskId} focusedTaskNonce={focusedTaskNonce} onFocusedTaskSeen={markFocusedTaskSeen} calendarConflictKeys={calendarConflictKeys} calendarConflictNotice={calendarConflictNotice} />}
            {screen === 'grocery' && (
              <StandaloneGrocery
                groceryItems={groceryItemsForScreen}
                onAddGroceryItems={addGroceryItemsForScreen}
                onCheckGrocery={checkGroceryForScreen}
                onDeleteGrocery={deleteGroceryForScreen}
                onClearCheckedGrocery={clearCheckedGroceryForScreen}
                onClearAllGrocery={clearAllGroceryForScreen}
                onAiSortGrocery={aiSortGroceryForScreen}
                sharedGrocery={sharedGroceryDoc && syncUser ? {
                  isOwner: sharedGroceryDoc.ownerUid === syncUser.uid,
                  shareCode: sharedGroceryDoc.shareCode,
                  memberCount: Object.keys(sharedGroceryDoc.members || {}).length,
                } : undefined}
                onShareGrocery={() => promoteGroceryListToShared(groceryItems).then(() => {
                  setViewingSharedGrocery(true);
                })}
                onRotateGroceryShareCode={() => sharedGroceryDoc ? rotateShareCode(sharedGroceryDoc.id).then(() => undefined) : Promise.reject(new Error('No shared grocery list'))}
                onMakePrivateSharedGrocery={() => {
                  if (!sharedGroceryDoc) return Promise.reject(new Error('No shared grocery list'));
                  const listId = sharedGroceryDoc.id;
                  const now = Date.now();
                  const privateItems = sharedGroceryItems.map((item, index): GroceryItem => ({
                    id: `groc_${now}_${index}`,
                    name: item.name,
                    category: item.category || GROCERY_UNCATEGORIZED,
                    quantity: item.quantity,
                    unit: item.unit,
                    packageSize: item.packageSize,
                    checked: !!item.checked,
                    createdAt: item.createdAt || now + index,
                  }));
                  return deleteSharedList(listId).then(() => {
                    setGroceryItemsState(privateItems);
                    persistGrocery(privateItems);
                    setViewingSharedGrocery(false);
                  });
                }}
                onLeaveSharedGrocery={() => sharedGroceryDoc ? leaveSharedList(sharedGroceryDoc.id).then(() => setViewingSharedGrocery(false)) : Promise.reject(new Error('No shared grocery list'))}
                onDeleteSharedGrocery={() => sharedGroceryDoc ? deleteSharedList(sharedGroceryDoc.id).then(() => setViewingSharedGrocery(false)) : Promise.reject(new Error('No shared grocery list'))}
                hasApiKey={hasApiKey}
                accentColor={accentColor}
                defaultTier={defaultTier}
                widgetShorthand={widgetShorthand}
                lists={lists}
                activeListId={activeListId}
                onAddMany={addManyToActiveList}
                onAddManyToList={addManyToList}
                groupCollapseScope={groceryGroupCollapseScope}
                collapsedGroups={collapsedGroups}
                setCollapsedGroup={setCollapsedGroup}
                focusedGroceryId={focusedGroceryId}
                focusedGroceryNonce={focusedGroceryNonce}
                onFocusedGrocerySeen={markFocusedGrocerySeen}
              />
            )}
            {screen === 'archive' && <Archive archive={combinedArchive} setArchive={setArchive} accentColor={accentColor} lists={mergedLists} activeListId={activeListId} setListTasks={setListTasks} onRestoreSharedArchiveItem={restoreSharedArchiveItem} onDeleteSharedArchiveItem={deleteSharedArchiveItem} collapsedGroups={collapsedGroups} setCollapsedGroup={setCollapsedGroup} />}
            {screen === 'settings' && (
              <Settings accent={accentColor} apiKey={apiKey} setApiKey={setApiKey}
                hasApiKey={hasApiKey} setHasApiKey={setHasApiKey} personalContext={personalContext} setPersonalContext={setPersonalContext}
                autoClear={autoClear} setAutoClear={setAutoClear}
                darkMode={darkMode} setDarkMode={setDarkMode}
                accentLight={accentLight} accentDark={accentDark} setAccentLight={setAccentLight} setAccentDark={setAccentDark}
                themeId={themeId} setThemeId={setThemeId}
                widgetThemeId={widgetThemeId} setWidgetThemeId={setWidgetThemeId}
                widgetClear={widgetClear} setWidgetClear={setWidgetClear}
                widgetShorthand={widgetShorthand} setWidgetShorthand={setWidgetShorthand}
                widgetCustomColors={widgetCustomColors} setWidgetCustomColors={setWidgetCustomColors}
                widgetMicSide={widgetMicSide} setWidgetMicSide={setWidgetMicSide}
                customThemeDrafts={customThemeDrafts} setCustomThemeDrafts={setCustomThemeDrafts}
                onClearArchive={() => setArchive(() => [])} onReplayOnboarding={replayOnboarding}
                calendarConflictsEnabled={calendarConflictsEnabled}
                setCalendarConflictsEnabled={setCalendarConflictsEnabled}
                onRequestCalendarConflictAccess={requestCalendarConflictAccess} />
            )}
          </View>
          <TabBar screen={screen} setScreen={setScreen} accentColor={accentColor} isPaid={isPaid} onLockedGrocery={() => setShowGroceryUpsell(true)} />
        </PortalHost>
        {showGroceryUpsell && <ProUpsellSheet accentColor={accentColor} onClose={() => setShowGroceryUpsell(false)} showToast={() => {}} />}
        {showOnboarding && <Onboarding onDone={finishOnboarding} accentColor={accentColor} initialStep={onboardingInitialStep} />}
      </View>
    </ThemeCtx.Provider>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <IAPProvider>
        <SyncProvider>
          <SharedListsProvider>
            <SafeAreaProvider><TriorityApp /></SafeAreaProvider>
          </SharedListsProvider>
        </SyncProvider>
      </IAPProvider>
    </GestureHandlerRootView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  screen: { flex: 1 },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { fontSize: 24 },

  toastContainer: { position: 'absolute', bottom: 80, left: 16, right: 16, alignItems: 'center', zIndex: 200 },
  toastWrap: { borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, maxWidth: '100%' },
  toastMsg: { fontSize: 13 },
  toastSub: { fontSize: 11, marginTop: 2 },

  // Portal sheets fill the app root absolutely so the backdrop captures every
  // touch outside the panel — preventing background TextInputs (InputBar) from
  // stealing focus once the sheet is open.
  portalRoot: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheetPanel: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderBottomWidth: 0, overflow: 'hidden' },
  sheetHandle: { alignItems: 'center', paddingTop: 12, paddingBottom: 8 },
  sheetHandleBar: { width: 36, height: 4, borderRadius: 2 },
  sheetContent: { paddingHorizontal: 16, paddingBottom: 24 },
  sheetScroll: { flexShrink: 1 },
  sheetTitle: { fontSize: 13, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 12 },
  sheetTextarea: { borderWidth: 1.5, borderRadius: 10, paddingTop: 10, paddingBottom: 10, paddingHorizontal: 10, fontSize: 15, minHeight: 80, maxHeight: 140, textAlignVertical: 'top', includeFontPadding: false, marginBottom: 14 },
  sheetPriorityLabel: { fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8 },
  sheetTierRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  pickerPreview: { fontSize: 15, lineHeight: 22, padding: 12, borderRadius: 10, borderWidth: 1, marginBottom: 16 },
  confirmTitle: { fontSize: 18, marginBottom: 6 },
  confirmMessage: { fontSize: 14, lineHeight: 20, marginBottom: 18 },
  pickerTierCol: { gap: 10, marginBottom: 12 },
  pickerTierBtn: { height: 56, borderRadius: 12, borderWidth: 1.5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  pickerTierDot: { width: 10, height: 10, borderRadius: 5 },
  pickerTierLabel: { fontSize: 16, letterSpacing: 0.4 },
  tierBtn: { flex: 1, height: 40, borderRadius: 10, borderWidth: 1.5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  tierDot: { width: 7, height: 7, borderRadius: 3.5 },
  tierBtnLabel: { fontSize: 13 },
  sheetActions: { flexDirection: 'row', gap: 10 },
  sheetFooter: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, borderTopWidth: 1 },
  sheetCancelBtn: { flex: 1, height: 44, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  sheetCancelLabel: { fontSize: 14 },
  sheetSaveBtn: { flex: 2, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  sheetSaveLabel: { fontSize: 14, color: '#fff' },

  taskRowContainer: { position: 'relative', marginBottom: 2, overflow: 'hidden' },
  taskRowBgLeft: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center' },
  taskRowBgRight: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', backgroundColor: 'rgba(255,80,64,0.15)' },
  // Tappable area for the revealed trash icon. Sized to match the REVEAL_X distance
  // so a tap anywhere in the exposed slot triggers delete.
  trashHitArea: { width: 64, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: 6 },
  // Pulsing halo behind the trash icon — soft red glow that breathes while revealed.
  trashHalo: { position: 'absolute', width: 36, height: 36, borderRadius: 18 },
  // Drop indicator line shown while a task is being dragged within its tier — sits
  // at the edge of the slot the row would land in on release.
  dropIndicator: { position: 'absolute', left: 8, right: 8, height: 3, borderRadius: 2 },
  taskRowContent: { position: 'relative', overflow: 'hidden', flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13, paddingLeft: 12, paddingRight: 10, borderLeftWidth: 3 },
  reminderFocusOverlay: { position: 'absolute', top: 1, left: 1, right: 1, bottom: 1, borderWidth: 0, borderRadius: 7 },
  newItemShineOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  newItemShineSweep: { position: 'absolute', top: -18, bottom: -18, width: 92, borderRadius: 999 },
  newItemShineSweepCore: { position: 'absolute', top: -18, bottom: -18, width: 22, borderRadius: 999 },
  newItemShineEdge: { position: 'absolute', top: 2, left: 3, right: 2, bottom: 2, borderWidth: 1 },
  newItemShineContrastEdge: { position: 'absolute', top: 1, left: 2, right: 1, bottom: 1, borderWidth: 1 },
  newItemShineSparkle: { position: 'absolute', right: 46, top: 8, width: 7, height: 7, borderRadius: 4 },
  newItemShineSparkleSmall: { position: 'absolute', right: 34, bottom: 8, width: 4, height: 4, borderRadius: 2 },
  taskTierBadge: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  taskTierDot: { width: 6, height: 6, borderRadius: 3, opacity: 0.9 },
  taskText: { fontSize: 14.5, lineHeight: 20 },
  editBtn: { width: 32, height: 32, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },

  tierHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, marginBottom: 8 },
  tierHeaderDot: { width: 7, height: 7, borderRadius: 3.5 },
  tierHeaderLabel: { fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase' },
  tierHeaderCount: { fontSize: 11, marginLeft: 4 },
  tierChevron: { fontSize: 11 },

  inputBar: { borderTopWidth: 1, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 },
  inputBarTopRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  inputTopBtn: { flex: 1, height: 34, borderRadius: 8, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, transform: [{ translateY: 2 }] },
  aiOnLabel: { fontSize: 10 },
  inputBarBottomRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  taskInput: { flex: 1, height: 36, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 0, fontSize: 14, includeFontPadding: false },
  submitBtn: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },

  listHeader: { paddingHorizontal: 16, paddingBottom: 0 },
  listHeaderTop: { flexDirection: 'column' },
  dateHeading: { fontSize: 26, letterSpacing: -0.5 },
  taskCount: { fontSize: 12 },
  listNameHeading: { fontSize: 26, letterSpacing: -0.5, flexShrink: 1 },
  listNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Heading shrinks if needed so the right-side counter never overflows.
  // translateY nudges the button down to optically center with the heading text.
  // marginTop alone gets compensated by the row's alignItems: 'center', so we use a
  // transform which doesn't participate in flex layout.
  listEditBtn: { width: 24, height: 24, borderRadius: 6, borderWidth: 1, alignItems: 'center', justifyContent: 'center', transform: [{ translateY: 6 }] },
  listSubHeading: { fontSize: 12, marginTop: 4 },
  tierPillRow: { flexDirection: 'row', gap: 12, marginTop: 10 },
  tierPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1 },

  listPillRow: { marginTop: 12, marginHorizontal: -16 },
  listPillRowContent: { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  listPill: { flexDirection: 'row', alignItems: 'center', height: 30, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, maxWidth: 180 },
  listPillAdd: { borderStyle: 'dashed' },
  listPillAddIcon: { paddingHorizontal: 8, justifyContent: 'center' },
  listPillLabel: { fontSize: 12 },

  // The list name opens list settings. Archive stays fixed at the right edge
  // so header layout does not shift with long list names.
  listTitleRow: { alignItems: 'center', justifyContent: 'center', minHeight: 28, paddingHorizontal: 48 },
  listTitleTap: { maxWidth: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  listTitleText: { fontSize: 22, letterSpacing: 0, flexShrink: 1 },
  listTitleEditMark: { width: 15, height: 15, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 2, flexShrink: 0 },
  headerActionBtnTopRight: { position: 'absolute', right: 0, top: 0, width: 32, height: 32, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  headerActionBtnBottomRight: { position: 'absolute', right: 0, top: -2, width: 32, height: 32, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  metaBullet: { fontSize: 12 },
  taskCountInline: { fontSize: 12 },
  listMetaRow: { alignItems: 'center', marginTop: 2, marginBottom: 2 },
  listMetaRowInline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 2, marginBottom: 2, flexWrap: 'wrap' },
  sharedMetaPill: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  groceryActionPillRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 },
  groceryViewSwitchWrap: { paddingHorizontal: 16, paddingTop: 10 },
  groceryViewSwitch: { flexDirection: 'row', alignItems: 'center', height: 36, borderRadius: 10, borderWidth: 1, padding: 3, gap: 3 },
  groceryViewSwitchBtn: { flex: 1, height: 28, borderRadius: 8, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  groceryViewSwitchLabel: { fontSize: 12 },
  groceryCategoryHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 16, marginBottom: 6, paddingLeft: 2 },
  groceryCategoryHeader: { fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 16, marginBottom: 6, paddingLeft: 2 },
  groceryItemTextRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  groceryItemMainText: { flex: 1, minWidth: 0 },
  groceryPackageHint: { maxWidth: 132, flexShrink: 0, fontSize: 11, lineHeight: 16 },
  groceryClearPill: { alignItems: 'center', paddingHorizontal: 12, paddingTop: 5, paddingBottom: 4, borderRadius: 16, borderWidth: 1 },
  groceryClearHint: { fontSize: 8, marginTop: 1 },

  sheetSectionLabel: { fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 4, marginBottom: 6 },
  listRenameRow: { flexDirection: 'row', alignItems: 'center', height: 44, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, gap: 10 },
  listRenameInput: { flex: 1, fontSize: 14, padding: 0, includeFontPadding: false },
  listRenameSave: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  listRenameSaveLabel: { fontSize: 12, color: '#fff' },
  listDeleteHint: { fontSize: 11, textAlign: 'center', marginTop: 12 },
  listSheetActionsRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  listSheetActionBtn: { flex: 1, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  listSheetActionLabel: { fontSize: 14 },

  upsellBadge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14, borderWidth: 1, marginBottom: 14 },
  upsellBadgeLabel: { fontSize: 11, letterSpacing: 0.4 },
  upsellTitle: { fontSize: 22, marginBottom: 6 },
  upsellSub: { fontSize: 13, lineHeight: 19, marginBottom: 18 },
  upsellPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 16 },
  upsellPrice: { fontSize: 26 },
  upsellPriceSub: { fontSize: 12 },
  upsellFeatureRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, paddingHorizontal: 4 },
  upsellFeatureLabel: { fontSize: 13 },
  upsellBuyBtn: { height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  upsellBuyLabel: { fontSize: 14, color: '#fff' },
  upsellRestoreBtn: { alignItems: 'center', paddingVertical: 8 },
  upsellRestoreLabel: { fontSize: 12, opacity: 0.7 },
  upsellDismissHint: { fontSize: 11, textAlign: 'center', marginTop: 6, opacity: 0.7 },

  // Used by sheets that want tap-anywhere-outside-to-close behavior. Overlay covers the
  // whole screen behind the sheet content; sheet view itself swallows taps via responder.
  sheetFullBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  // Tighter padding/margins for compact sheets (upsell, list actions) so they don't
  // reach the screen edges on smaller phones.
  sheetCompact: { paddingHorizontal: 16, paddingBottom: 24, maxHeight: '85%', overflow: 'hidden' },
  sheetCompactContent: { paddingBottom: 4 },
  tierPillCount: { fontSize: 11 },
  tierPillLabel: { fontSize: 10 },
  divider: { height: 1, marginTop: 14 },

  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 10 },
  emptyIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14 },

  archiveHeader: { paddingHorizontal: 16, paddingBottom: 0 },
  screenHeading: { fontSize: 26, letterSpacing: -0.5 },
  archiveCount: { fontSize: 12, marginTop: 4 },
  sortRow: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' },
  sortBtn: { minHeight: 34, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  sortBtnLabel: { fontSize: 12, lineHeight: 16, includeFontPadding: false },
  calRangeEditRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  calRangeEditLabel: { fontSize: 12 },
  calRangeDisplay: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  calRangeChip: { flex: 1, borderRadius: 10, borderWidth: 1.5, paddingVertical: 8, paddingHorizontal: 12 },
  calRangeChipLabel: { fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 2 },
  calRangeChipDate: { fontSize: 16 },
  calRangeSepLine: { width: 12, height: 1.5 },
  calMonthNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  calNavBtn: { width: 32, height: 32, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  calMonthLabel: { fontSize: 15 },
  calDowRow: { flexDirection: 'row', marginBottom: 4 },
  calDowLabel: { flex: 1, textAlign: 'center', fontSize: 11, paddingVertical: 4 },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calCell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  calDayText: { fontSize: 13 },
  calTodayDot: { width: 4, height: 4, borderRadius: 2, position: 'absolute', bottom: 4 },
  calItemDot: { width: 3, height: 3, borderRadius: 1.5, position: 'absolute', bottom: 4 },
  archiveGroupLabel: { paddingHorizontal: 16, paddingBottom: 8, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase' },
  archiveWeekHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  archiveWeekCount: { fontSize: 12 },
  archiveItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 16, borderLeftWidth: 3, marginBottom: 2 },
  archiveItemCheck: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  archiveItemText: { fontSize: 14, lineHeight: 20, textDecorationLine: 'line-through' },
  archiveItemDay: { fontSize: 11, marginTop: 2 },
  restoreBtn: { padding: 6, borderRadius: 6 },

  settingsHeader: { paddingHorizontal: 16, paddingBottom: 0 },
  settingsSection: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8, fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase' },
  settingsCard: { marginHorizontal: 12, borderRadius: 12, overflow: 'hidden', borderWidth: 1 },
  settingsCardInner: { padding: 16, borderBottomWidth: 1 },
  apiKeyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20, borderWidth: 1 },
  statusDot: { width: 5, height: 5, borderRadius: 2.5 },
  statusLabel: { fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
  apiKeyRow: { flexDirection: 'row', gap: 8 },
  apiKeyInput: { flex: 1, height: 36, borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, fontSize: 13 },
  iconBtn: { width: 36, height: 36, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  saveKeyBtn: { height: 36, paddingHorizontal: 14, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  saveKeyLabel: { fontSize: 12 },
  keyError: { marginTop: 6, fontSize: 11, color: '#FF5040' },
  keyHint: { marginTop: 8, fontSize: 11 },
  keyHelpRow: { marginTop: 10, alignSelf: 'flex-start' },
  keyHelpLink: { fontSize: 12 },
  contextLabel: { fontSize: 13, marginBottom: 6 },
  contextInput: { borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 13, lineHeight: 20, textAlignVertical: 'top', minHeight: 100 },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  settingRowLabel: { fontSize: 14 },
  settingRowSub: { fontSize: 12, marginTop: 2 },
  widgetToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 14 },
  widgetToggleItem: { flex: 1, minWidth: 0, minHeight: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  widgetToggleLabel: { fontSize: 12, lineHeight: 16, marginTop: 0, includeFontPadding: false },
  toggle: { width: 44, height: 26, borderRadius: 13, borderWidth: 1, position: 'relative' },
  toggleKnob: { position: 'absolute', top: 2, width: 20, height: 20, borderRadius: 10 },
  appearanceLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  appearanceHint: { fontSize: 11, marginBottom: 12 },
  scrollHint: { fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase' },
  proPill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  proPillLabel: { fontSize: 9, letterSpacing: 0.6 },
  cardScrollBox: { borderRadius: 10, borderWidth: 1 },
  cardScrollBoxContent: { padding: 10, paddingBottom: 10 },
  scrollbarRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 7, paddingTop: 2, gap: 6 },
  scrollbarTrack: { flex: 1, height: 3, borderRadius: 1.5, overflow: 'hidden' },
  scrollbarThumb: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 1.5 },
  scrollHintInline: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  scrollHintInner: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  // Column-wrap = items flow top->bottom, then wrap to next column. With a
  // fixed container height we get exactly 2 rows scrolling horizontally.
  cardGrid: { flexDirection: 'column', flexWrap: 'wrap', height: 360, gap: 10 },
  // Single-row variant for the theme picker — themes are fewer than accents and
  // a single row keeps both pickers visible together on one screen.
  cardGridSingleRow: { flexDirection: 'row', gap: 10 },
  previewCard: { width: 150, borderRadius: 12, padding: 8, gap: 8 },
  previewCardEmpty: { borderWidth: 1.5, borderStyle: 'dashed', justifyContent: 'center' },
  previewCardEmptyInner: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 100 },
  previewCardEmptyPlus: { fontSize: 32, lineHeight: 36, fontWeight: '300' },
  previewCardFooter: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2 },
  previewCardName: { fontSize: 12, flex: 1 },
  previewAccentSwatch: { width: 10, height: 10, borderRadius: 5 },
  // Mini mockup of the task screen
  miniPreview: { borderRadius: 8, borderWidth: 1, padding: 8, gap: 5 },
  miniHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  miniTitle: { fontSize: 13, letterSpacing: -0.3, lineHeight: 16 },
  miniHeaderEditBtn: { width: 13, height: 13, borderRadius: 3, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  miniCount: { fontSize: 8, marginLeft: 'auto' },
  miniDate: { fontSize: 7, lineHeight: 9, marginTop: -2 },
  miniPillRow: { flexDirection: 'row', gap: 4, marginTop: 2 },
  miniPill: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 7, borderWidth: 1, maxWidth: '50%' },
  miniPillLabel: { fontSize: 7, lineHeight: 9 },
  miniDivider: { height: 1, marginTop: 1 },
  miniTierRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  miniTierDot: { width: 4, height: 4, borderRadius: 2 },
  miniTierLabel: { fontSize: 7, letterSpacing: 0.6, lineHeight: 9 },
  miniTierCount: { fontSize: 7, lineHeight: 9 },
  miniTaskRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 4, borderRadius: 4, overflow: 'hidden', position: 'relative' },
  miniTaskBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 2 },
  miniTaskCircle: { width: 9, height: 9, borderRadius: 4.5, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginLeft: 3 },
  miniTaskCircleDot: { width: 3, height: 3, borderRadius: 1.5 },
  miniTaskText: { flex: 1, height: 5, borderRadius: 2 },
  miniTaskEditBtn: { width: 13, height: 13, borderRadius: 3, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  tierSelector: { flexDirection: 'row', gap: 4 },
  tierSelectorBtn: { height: 26, paddingHorizontal: 10, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  tierSelectorLabel: { fontSize: 11 },
  autoClearRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  autoClearBtn: { height: 28, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  autoClearLabel: { fontSize: 12 },
  clearLabel: { fontSize: 12, color: '#FF5040' },

  tabBar: { flexDirection: 'row', minHeight: 74, borderTopWidth: 1, paddingTop: 6 },
  tabBtn: { flex: 1, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5 },
  tabLabel: { fontSize: 10 },

  taskDueRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  taskDueText: { fontSize: 11, lineHeight: 14 },
  recurBadge: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginRight: 2 },

  recurToggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 10 },
  recurToggleLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recurToggleLabel: { fontSize: 14 },
  recurPanel: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 8, marginBottom: 4 },
  recurSectionLabel: { fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 4 },
  recurFreqRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 4 },
  recurFreqBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  recurFreqLabel: { fontSize: 13 },
  recurDayTimeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  recurDivider: { width: 1, height: 30, marginHorizontal: 2 },
  recurDowRow: { flexDirection: 'row', gap: 6, marginBottom: 4 },
  recurDowBtn: { width: 34, height: 34, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  recurDowLabel: { fontSize: 12 },
  recurIntervalRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  recurSpinBtn: { width: 36, height: 36, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  recurSpinLabel: { fontSize: 20, lineHeight: 24 },
  recurIntervalVal: { fontSize: 15, width: 72, textAlign: 'center' },
  recurTimeRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  recurTimeUnit: { borderRadius: 9, borderWidth: 1, paddingVertical: 6, width: 52, alignItems: 'center', gap: 2 },
  recurTimeVal: { fontSize: 22, lineHeight: 27 },
  recurTimeArrow: { fontSize: 11, lineHeight: 14 },
  recurTimeColon: { fontSize: 22 },
  recurTimeAmpm: { fontSize: 13, marginLeft: 2 },
  ampmBtn: { borderRadius: 7, borderWidth: 1, paddingVertical: 4, width: 36, alignItems: 'center', justifyContent: 'center', marginLeft: 0 },
  ampmLabel: { fontSize: 12, letterSpacing: 0.5 },

  onbBackdrop: { flex: 1, paddingHorizontal: 24 },
  onbTopBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 4, paddingTop: 4, paddingBottom: 12 },
  onbSkip: { fontSize: 13, letterSpacing: 0.4 },
  onbContent: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  onbIconWrap: { width: 40, height: 40, borderRadius: 12, borderWidth: 1.2, alignItems: 'center', justifyContent: 'center', marginTop: 22, marginBottom: 14 },
  onbTitle: { fontSize: 26, textAlign: 'center', marginBottom: 10, lineHeight: 32 },
  onbBody: { fontSize: 15, lineHeight: 22, textAlign: 'center', maxWidth: 350 },
  onbExampleCard: { marginTop: 22, padding: 16, borderRadius: 14, borderWidth: 1, maxWidth: 380 },
  onbExampleText: { fontSize: 14, lineHeight: 21, fontStyle: 'italic' },
  onbExampleSub: { fontSize: 12, lineHeight: 18, marginTop: 10 },
  onbDots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginVertical: 20 },
  onbDot: { height: 6, borderRadius: 3 },
  onbButtonRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 4 },
  onbBackBtn: { flex: 1, height: 50, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  onbBackLabel: { fontSize: 15 },
  onbNextBtn: { flex: 2, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  onbNextLabel: { fontSize: 15, color: '#fff' },
  onbDemoShell: { width: '100%', maxWidth: 350, height: 238, borderRadius: 16, borderWidth: 1, padding: 12, overflow: 'hidden', position: 'relative' },
  onbDemoTop: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 10 },
  onbDemoTinyDot: { width: 6, height: 6, borderRadius: 3 },
  onbDemoStage: { flex: 1, overflow: 'hidden' },
  onbDemoSectionLabel: { fontSize: 10, letterSpacing: 1.1, textTransform: 'uppercase', marginBottom: 6 },
  onbDemoInput: { height: 38, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  onbDemoInputText: { flex: 1, fontSize: 13 },
  onbDemoSend: { width: 23, height: 23, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  onbDemoChips: { flexDirection: 'row', gap: 7, marginBottom: 8 },
  onbDemoChip: { flex: 1, height: 28, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  onbDemoChipText: { fontSize: 11 },
  onbDemoLine: { minHeight: 34, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 7 },
  onbDemoTaskGhost: { minHeight: 34, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  onbDemoDot: { width: 7, height: 22, borderRadius: 4 },
  onbDemoLineText: { flex: 1, fontSize: 13 },
  onbDemoPrompt: { borderRadius: 11, borderWidth: 1, paddingVertical: 8, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 7 },
  onbDemoPromptText: { flex: 1, fontSize: 11, lineHeight: 15 },
  onbDemoWidgetWallpaper: { flex: 1, borderRadius: 12, overflow: 'hidden', padding: 12, justifyContent: 'space-between' },
  onbDemoWidgetClock: { marginTop: 2 },
  onbDemoWidgetTime: { fontSize: 31, lineHeight: 34 },
  onbDemoWidgetDate: { fontSize: 10, lineHeight: 13 },
  onbDemoWidgetStrip: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  onbDemoWidgetMic: { width: 50, height: 64, borderRadius: 18, borderWidth: 1.4, alignItems: 'center', justifyContent: 'center' },
  onbDemoWidgetSparkle: { position: 'absolute', top: 8, right: 8 },
  onbDemoWidgetBubble: { flex: 1, minHeight: 64, borderRadius: 18, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10, justifyContent: 'space-between' },
  onbDemoWidgetTitle: { fontSize: 15, lineHeight: 18 },
  onbDemoWidgetMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  onbDemoWidgetMetaText: { fontSize: 11, lineHeight: 14 },
  onbDemoWidgetReview: { minHeight: 38, borderRadius: 12, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  onbDemoWidgetReviewText: { flex: 1, fontSize: 12 },
  onbDemoWidgetReviewBtn: { height: 24, borderRadius: 8, borderWidth: 1, paddingHorizontal: 9, alignItems: 'center', justifyContent: 'center' },
  onbDemoWidgetReviewBtnText: { fontSize: 10 },
  onbDemoGroceryRow: { minHeight: 34, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  onbDemoGroceryHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 },
  onbDemoScreenTitle: { fontSize: 16, lineHeight: 20 },
  onbDemoGroceryItem: { minHeight: 28, borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  onbDemoPills: { flexDirection: 'row', gap: 7, marginBottom: 12 },
  onbDemoListPill: { height: 30, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  onbDemoPillText: { fontSize: 11 },
  onbDemoShareCard: { minHeight: 62, borderRadius: 12, borderWidth: 1, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  onbDemoSharedHeader: { minHeight: 38, borderRadius: 11, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  onbDemoSharedCount: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  onbDemoSharedLine: { minHeight: 34, borderRadius: 10, borderWidth: 1, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 7 },
  onbDemoAvatar: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  onbDemoAvatarText: { fontSize: 9, lineHeight: 12 },
  onbDemoSmall: { fontSize: 11, lineHeight: 15 },
  onbDemoCategory: { borderRadius: 10, borderWidth: 1, paddingVertical: 9, paddingHorizontal: 10 },
  onbDemoReminderTask: { minHeight: 52, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  onbDemoReminderDue: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  onbDemoReminderCard: { minHeight: 42, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 8 },
  onbDemoNotice: { borderRadius: 10, borderWidth: 1, paddingVertical: 9, paddingHorizontal: 10, alignItems: 'center' },
  onbDemoNoticeTight: { paddingVertical: 7 },
  onbDemoReminderInfo: { minHeight: 54, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  onbDemoTinyText: { fontSize: 10, lineHeight: 14, marginTop: 2 },
  supportSettingsRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  supportSettingsLabel: { flex: 1, marginRight: 12 },


  hsbSliderGroup: { gap: 10 },
  hsbSliderRow: { gap: 5 },
  hsbSliderLabel: { fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase', fontFamily: jks('600') },
  hsbSliderTrack: { height: 28, borderRadius: 4, overflow: 'hidden', position: 'relative', borderWidth: 1 },
  hsbSliderThumb: { position: 'absolute', width: 20, height: 20, borderRadius: 10, borderWidth: 2.5, top: '50%', marginTop: -10, marginLeft: -10, backgroundColor: '#fff', elevation: 6 },

  customThemeSheet: { maxHeight: '96%', paddingHorizontal: 16, paddingBottom: 0, paddingTop: 0 },
  customThemeSheetTitle: { fontSize: 17, marginTop: 4, marginBottom: 12, textAlign: 'center' },
  customGroupGrid: { flexDirection: 'row', gap: 6, marginBottom: 8, paddingHorizontal: 16 },
  customGroupBtn: { flex: 1, flexDirection: 'column', alignItems: 'center', gap: 5, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 8, borderWidth: 1 },
  customGroupSwatch: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, flexShrink: 0 },
  customGroupLabel: { fontSize: 10, flexShrink: 1, textAlign: 'center' },
  customGroupHint: { fontSize: 12, textAlign: 'center', marginBottom: 12, paddingHorizontal: 16, lineHeight: 16 },
});
