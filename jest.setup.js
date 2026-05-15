import 'react-native-gesture-handler/jestSetup';
import React from 'react';
import { NativeModules, Text } from 'react-native';

NativeModules.TriorityWidget = NativeModules.TriorityWidget || {
  configure: jest.fn(),
  consumePendingCaptures: jest.fn(() => Promise.resolve('[]')),
  showWidgetResult: jest.fn(),
};

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('react-native-encrypted-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
  clear: jest.fn(() => Promise.resolve()),
}));

jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
    setLogLevel: jest.fn(),
    getCustomerInfo: jest.fn(() => Promise.resolve({ entitlements: { active: {} } })),
  },
  LOG_LEVEL: { DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' },
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('@react-native-firebase/app', () => ({
  getApp: jest.fn(() => ({})),
}));

jest.mock('@react-native-firebase/auth', () => ({
  getAuth: jest.fn(() => ({})),
  GoogleAuthProvider: { credential: jest.fn(() => ({})) },
  onAuthStateChanged: jest.fn((_auth, cb) => {
    cb(null);
    return jest.fn();
  }),
  signInWithCredential: jest.fn(() => Promise.resolve({ user: null })),
  signOut: jest.fn(() => Promise.resolve()),
}));

const mockSupabaseQuery = {
  get: jest.fn(() => Promise.resolve({ data: null, error: null })),
  select: jest.fn(() => mockSupabaseQuery),
  eq: jest.fn(() => mockSupabaseQuery),
  in: jest.fn(() => mockSupabaseQuery),
  order: jest.fn(() => mockSupabaseQuery),
  maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
  single: jest.fn(() => Promise.resolve({ data: null, error: null })),
  insert: jest.fn(() => Promise.resolve({ data: null, error: null })),
  update: jest.fn(() => mockSupabaseQuery),
  delete: jest.fn(() => mockSupabaseQuery),
};

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(() => Promise.resolve({ exists: () => false, data: () => undefined })),
  setDoc: jest.fn(() => Promise.resolve()),
  onSnapshot: jest.fn((_ref, cb) => {
    cb({ exists: () => false, data: () => undefined, docs: [] });
    return jest.fn();
  }),
  collection: jest.fn(() => ({})),
  writeBatch: jest.fn(() => ({
    set: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    commit: jest.fn(() => Promise.resolve()),
  })),
  query: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
  getDocs: jest.fn(() => Promise.resolve({ docs: [] })),
  deleteDoc: jest.fn(() => Promise.resolve()),
  updateDoc: jest.fn(() => Promise.resolve()),
  enableNetwork: jest.fn(() => Promise.resolve()),
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(() => Promise.resolve(true)),
    signIn: jest.fn(() => Promise.resolve({ idToken: 'test-token' })),
    signOut: jest.fn(() => Promise.resolve()),
    getCurrentUser: jest.fn(() => Promise.resolve(null)),
  },
  statusCodes: {
    SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
    IN_PROGRESS: 'IN_PROGRESS',
    PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
  },
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: { setSession: jest.fn(() => Promise.resolve()) },
    realtime: { setAuth: jest.fn(() => Promise.resolve()) },
    from: jest.fn(() => mockSupabaseQuery),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
    })),
    removeChannel: jest.fn(() => Promise.resolve()),
  })),
}));

jest.mock('react-native-speech-recognition-kit', () => ({
  startListening: jest.fn(() => Promise.resolve()),
  stopListening: jest.fn(() => Promise.resolve()),
  isRecognitionAvailable: jest.fn(() => Promise.resolve(false)),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  speechRecogntionEvents: {
    START: 'START',
    END: 'END',
    RESULT: 'RESULT',
    ERROR: 'ERROR',
  },
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    requestPermission: jest.fn(() => Promise.resolve()),
    getNotificationSettings: jest.fn(() => Promise.resolve({ android: {} })),
    createChannel: jest.fn(() => Promise.resolve('default')),
    displayNotification: jest.fn(() => Promise.resolve()),
    createTriggerNotification: jest.fn(() => Promise.resolve()),
    cancelNotification: jest.fn(() => Promise.resolve()),
    cancelTriggerNotification: jest.fn(() => Promise.resolve()),
    getInitialNotification: jest.fn(() => Promise.resolve(null)),
    onForegroundEvent: jest.fn(() => jest.fn()),
    getTriggerNotifications: jest.fn(() => Promise.resolve([])),
  },
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  AndroidNotificationSetting: { ENABLED: 1 },
  TriggerType: { TIMESTAMP: 0 },
  RepeatFrequency: { HOURLY: 0, DAILY: 1 },
  AuthorizationStatus: { AUTHORIZED: 1, DENIED: 0 },
  EventType: { PRESS: 1, ACTION_PRESS: 2 },
}));

const mockIcon = ({ name }) => React.createElement(Text, null, name || 'icon');
jest.mock('@react-native-vector-icons/feather', () => mockIcon);
jest.mock('@react-native-vector-icons/ionicons', () => mockIcon);
