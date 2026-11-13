import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import notifee from '@notifee/react-native';
import App from '../App';

const widget = NativeModules.TriorityWidget;
const originalSave = (AsyncStorage.setItem as jest.Mock).getMockImplementation()!;
let queued: any[];
let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await AsyncStorage.setItem('tri_lists', JSON.stringify([{ id: 'default', name: 'To do', tasks: [] }]));
  await AsyncStorage.setItem('tri_active_list_id', JSON.stringify('default'));
  queued = [];
  widget.peekPendingCaptures.mockImplementation(async () => JSON.stringify(queued));
  widget.updatePendingCaptureDraft.mockImplementation(async (id: string, draft: string) => {
    queued.find(capture => capture.id === id).remainingDraft = JSON.parse(draft);
  });
  widget.acknowledgePendingCapture.mockImplementation(async (id: string) => {
    queued = queued.filter(capture => capture.id !== id);
  });
  (notifee.getNotificationSettings as jest.Mock).mockResolvedValue({ authorizationStatus: 1, android: { alarm: 1 } });
  (notifee.requestPermission as jest.Mock).mockResolvedValue({ authorizationStatus: 1, android: { alarm: 1 } });
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => renderer?.unmount());
  renderer = undefined;
  jest.restoreAllMocks();
  (AsyncStorage.setItem as jest.Mock).mockImplementation(originalSave);
});

async function renderApp() {
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
  });
}

test('manual widget import saves and schedules the captured reminder before acknowledging', async () => {
  const createdAt = Date.now() - 60000;
  queued = [{ id: 'manual-reminder', text: 'Remind me to call Alex in 10 minutes', listId: 'default', mode: 'manual', createdAt }];
  widget.acknowledgePendingCapture.mockImplementation(async (id: string) => {
    const stored = JSON.parse((await AsyncStorage.getItem('tri_lists'))!);
    expect(stored[0].tasks[0].reminder.remindAt).toBe(createdAt + 600000);
    queued = queued.filter(capture => capture.id !== id);
  });

  await renderApp();

  expect(widget.acknowledgePendingCapture).toHaveBeenCalledWith('manual-reminder');
  expect(notifee.createTriggerNotification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timestamp: createdAt + 600000 }));
  expect(queued).toEqual([]);
  expect(widget.consumePendingCaptures).not.toHaveBeenCalled();
});

test('failed AI widget capture stays queued without a raw fallback task or render retry loop', async () => {
  await AsyncStorage.setItem('tri_ai_provider_v1', JSON.stringify('openai'));
  queued = [{ id: 'ai-failure', text: 'Call Alex tomorrow at 5 pm', listId: 'default', mode: 'ai', createdAt: Date.now() }];

  await renderApp();
  await ReactTestRenderer.act(async () => renderer?.update(<App />));

  expect(queued).toHaveLength(1);
  expect(widget.acknowledgePendingCapture).not.toHaveBeenCalled();
  const stored = JSON.parse((await AsyncStorage.getItem('tri_lists'))!);
  expect(stored[0].tasks).toEqual([]);
  expect(widget.updatePendingCaptureDraft).not.toHaveBeenCalled();
});

test('failed local task persistence retains the capture and its remaining parsed draft', async () => {
  queued = [{ id: 'save-failure', text: 'Call Alex', listId: 'default', mode: 'manual', createdAt: Date.now() }];
  const save = (AsyncStorage.setItem as jest.Mock).getMockImplementation()!;
  jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, value) => {
    if (key === 'tri_lists' && value.includes('save-failure:')) throw new Error('Storage unavailable');
    return save(key, value);
  });

  await renderApp();

  expect(queued).toHaveLength(1);
  expect(queued[0].remainingDraft.taskGroups[0].tasks[0].text).toBe('Call Alex');
  expect(widget.acknowledgePendingCapture).not.toHaveBeenCalled();
});
