import { defineProject } from 'vitest/config';

// Tests of the web app's plain modules (no components, no Monaco).
export default defineProject({
  test: {
    name: '@vizscript/web',
    environment: 'node',
  },
});
