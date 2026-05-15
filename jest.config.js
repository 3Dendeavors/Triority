module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/_archive/',
    '/_exports/',
    '/_screenshots/',
    '/\\.claude/',
    '<rootDir>/Triority/',
    '/docs/archive/',
    '/archive/',
  ],
  modulePathIgnorePatterns: [
    '<rootDir>/_archive/',
    '<rootDir>/_exports/',
    '<rootDir>/_screenshots/',
    '<rootDir>/.claude/',
    '<rootDir>/Triority/',
    '<rootDir>/docs/archive/',
    '<rootDir>/archive/',
  ],
};
