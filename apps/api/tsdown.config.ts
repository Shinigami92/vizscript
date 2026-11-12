import { readdirSync } from 'node:fs';
import { defineConfig } from 'tsdown';

// Every migration becomes its own entry so the runner can load it from
// `dist/migrations` at startup.
const migrations = Object.fromEntries(
  readdirSync('migrations')
    .filter((file) => file.endsWith('.ts'))
    .map((file) => [
      `migrations/${file.replace(/\.ts$/, '')}`,
      `migrations/${file}`,
    ])
);

export default defineConfig({
  entry: { main: 'src/main.ts', ...migrations },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: false,
  // Bundle workspace packages, keep real dependencies external.
  deps: { alwaysBundle: [/^@vizscript\//] },
});
