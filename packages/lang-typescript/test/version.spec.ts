import { describe, expect, it } from 'vitest';
import { typescriptVersion } from '../src';

describe('typescriptVersion', () => {
  it('reads the nearest package.json that depends on typescript', () => {
    expect(
      typescriptVersion([
        { path: 'apps/web/package.json', text: '{"dependencies":{"vue":"3"}}' },
        {
          path: 'package.json',
          text: '{"devDependencies":{"typescript":"^5.9.2"}}',
        },
      ])
    ).toEqual({
      text: '5.9.2',
      detail: 'typescript ^5.9.2 in devDependencies',
      path: 'package.json',
    });
  });

  it('follows pnpm catalogs', () => {
    const files = [
      {
        path: 'package.json',
        text: '{"devDependencies":{"typescript":"catalog:"}}',
      },
      {
        path: 'pnpm-workspace.yaml',
        text: [
          'packages:',
          '  - apps/*',
          'catalog:',
          '  vue: 3.5.0',
          "  typescript: '~5.8.3'",
          'catalogs:',
          '  next:',
          '    typescript: 6.0.0',
        ].join('\n'),
      },
    ];
    expect(typescriptVersion(files)?.text).toBe('5.8.3');
    files[0] = {
      path: 'package.json',
      text: '{"devDependencies":{"typescript":"catalog:next"}}',
    };
    expect(typescriptVersion(files)).toEqual({
      text: '6.0.0',
      detail: 'typescript 6.0.0 in the next catalog',
      path: 'pnpm-workspace.yaml',
    });
  });

  it('skips workspace links and broken files', () => {
    expect(
      typescriptVersion([
        { path: 'a/package.json', text: '{' },
        {
          path: 'package.json',
          text: '{"devDependencies":{"typescript":"workspace:*"}}',
        },
      ])
    ).toBeUndefined();
  });
});
