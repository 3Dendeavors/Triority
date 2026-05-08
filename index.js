/**
 * @format
 */

import 'react-native-url-polyfill/auto';
import { AppRegistry } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import notifee, { EventType } from '@notifee/react-native';
import App from './App';
import { name as appName } from './app.json';

const REMINDER_NAV_KEY = 'tri_pending_reminder_nav_v1';

// Register a background event handler so Notifee can route taps/dismisses
// when the app is killed or in the background. The actual cancellation of
// displayed notifications happens automatically via the AUTO_CANCEL flag;
// this just satisfies Notifee's requirement and silences the dev warning.
notifee.onBackgroundEvent(async ({ type, detail }) => {
  if (type !== EventType.PRESS && type !== EventType.ACTION_PRESS) return;
  const data = detail.notification?.data;
  if (!data?.taskId && data?.route !== 'taskReminder') return;
  await AsyncStorage.setItem(REMINDER_NAV_KEY, JSON.stringify(data)).catch(() => {});
  // our current behavior (tap → opens app, no per-notification deep link)
});

AppRegistry.registerComponent(appName, () => App);
