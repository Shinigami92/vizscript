import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@vizscript/api',
    environment: 'node',
    setupFiles: ['reflect-metadata'],
  },
});
