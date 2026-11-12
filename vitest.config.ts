import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    reporters: process.env.CI_PREFLIGHT
      ? ['default', 'github-actions']
      : [['default', { summary: false }]],
  },
});
