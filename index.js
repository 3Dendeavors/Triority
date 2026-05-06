/**
 * @format
 */

import { AppRegistry } from 'react-native';
import notifee from '@notifee/react-native';
import App from './App';
import { name as appName } from './app.json';

// Register a background event handler so Notifee can route taps/dismisses
// when the app is killed or in the background. The actual cancellation of
// displayed notifications happens automatically via the AUTO_CANCEL flag;
// this just satisfies Notifee's requirement and silences the dev warning.
notifee.onBackgroundEvent(async () => {
  // Notifee handles dismissal/auto-cancel itself; no-op is sufficient for
  // our current behavior (tap → opens app, no per-notification deep link)
});

AppRegistry.registerComponent(appName, () => App);
