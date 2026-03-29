/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  moduleNameMapper: {
    '^(\\..*)/generated/prisma/client\\.js$':
      '<rootDir>/test/__mocks__/prisma-client.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@src/(.+)\\.js$': '<rootDir>/src/$1.ts',
    '^@src/(.+)$': '<rootDir>/src/$1.ts',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/types/**/*.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/src/generated/'],
  coverageDirectory: '../coverage',
  coverageThreshold: {
    global: {
      statements: 99,
      branches: 92,
      functions: 100,
      lines: 99,
    },
  },
  testEnvironment: 'node',
};
