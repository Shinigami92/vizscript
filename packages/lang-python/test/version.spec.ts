import { describe, expect, it } from 'vitest';
import { pythonVersion } from '../src';

describe('pythonVersion', () => {
  it('prefers the interpreter of .python-version', () => {
    expect(
      pythonVersion([
        { path: '.python-version', text: '# pyenv\n3.12.4\n' },
        {
          path: 'pyproject.toml',
          text: '[project]\nrequires-python = ">=3.9"',
        },
      ])
    ).toEqual({
      text: '3.12.4',
      detail: '3.12.4 in .python-version',
      path: '.python-version',
    });
  });

  it('reads the type checker target before requires-python', () => {
    const text = [
      '[project]',
      'requires-python = ">=3.9,<4"',
      '[tool.mypy]',
      'python_version = "3.11"',
    ].join('\n');
    expect(pythonVersion([{ path: 'pyproject.toml', text }])?.text).toBe(
      '3.11'
    );
    expect(
      pythonVersion([
        {
          path: 'pyproject.toml',
          text: '[project]\nrequires-python = ">=3.9,<4"',
        },
      ])
    ).toEqual({
      text: '≥3.9',
      detail: 'requires-python >=3.9,<4',
      path: 'pyproject.toml',
    });
  });

  it('reads setup.cfg and runtime.txt', () => {
    expect(
      pythonVersion([
        { path: 'setup.cfg', text: '[options]\npython_requires = >=3.8' },
      ])?.text
    ).toBe('≥3.8');
    expect(
      pythonVersion([{ path: 'runtime.txt', text: 'python-3.11.4' }])?.text
    ).toBe('3.11.4');
  });
});
