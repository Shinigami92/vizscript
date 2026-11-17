import { describe, expect, it, vi } from 'vitest';
import { resolveImage } from '../src/markdown/links';

const config = vi.hoisted(() => ({ fail: true, calls: 0 }));

vi.mock('../src/api/client', async (original) => {
  const actual = await original<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      config: () => {
        config.calls++;
        return config.fail
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve({
              github: {
                apiUrl: 'https://ghe.example/api/v3',
                rawUrl: 'https://ghe.example/raw',
                webUrl: 'https://ghe.example',
              },
            });
      },
    },
  };
});

const repo = { provider: 'github', owner: 'team', repo: 'app', ref: 'main' };

describe('markdown images', () => {
  it('come from the deployment’s raw host', () => {
    expect(
      resolveImage('docs/a.md', '../img/x.png', repo, 'https://ghe.example/raw')
    ).toBe('https://ghe.example/raw/team/app/main/img/x.png');
  });

  it('load nothing while the raw host is unknown', () => {
    expect(resolveImage('docs/a.md', 'x.png', repo, null)).toBe('');
    // Absolute URLs are the author's choice.
    expect(resolveImage('a.md', 'https://cdn.example/x.png', repo, null)).toBe(
      'https://cdn.example/x.png'
    );
  });
});

describe('github config', () => {
  it('never falls back to public GitHub and asks again after a failure', async () => {
    const { githubConfig } = await import('../src/api/github-public');
    await expect(githubConfig()).rejects.toThrow('Failed to fetch');
    config.fail = false;
    await expect(githubConfig()).resolves.toMatchObject({
      apiUrl: 'https://ghe.example/api/v3',
    });
    expect(config.calls).toBe(2);
  });
});
