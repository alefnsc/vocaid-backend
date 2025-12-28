import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/*.test.ts'
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 30000,
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Mock uuid module to avoid ESM import issues
    '^uuid$': '<rootDir>/src/__tests__/__mocks__/uuid.ts'
  },
  // Don't transform node_modules except for specific ESM packages
  transformIgnorePatterns: [
    'node_modules/(?!(resend|uuid)/)'
  ],
  // Clear mocks between tests
  clearMocks: true,
  // Verbose output for debugging
  verbose: true
};

export default config;
