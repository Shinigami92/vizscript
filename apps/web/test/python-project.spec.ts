import { describe, expect, it } from 'vitest';
import {
  normalizeName,
  pyprojectDependencies,
  pythonDependencies,
  pythonLockVersions,
  requirement,
  requirementsDependencies,
} from '../src/graph/python-project';

const PYPROJECT = `
[project]
name = "weather"
requires-python = ">=3.11"
dependencies = [
  "requests[socks] >= 2.31, <3 ; python_version < '3.13'",
  "Typing_Extensions",
  "core-lib",
]

[project.optional-dependencies]
cli = ["rich>=13"]

[dependency-groups]
dev = ["pytest>=8", { include-group = "lint" }]
lint = ["ruff"]

[tool.uv.sources]
core-lib = { workspace = true }
`;

const POETRY = `
[tool.poetry.dependencies]
python = "^3.11"
httpx = "^0.27"
numpy = { version = "^2.0", optional = true }
shared = { path = "../shared" }

[tool.poetry.group.test.dependencies]
pytest = "^8.0"
`;

describe('python manifests', () => {
  it('reads PEP 508 requirements', () => {
    expect(
      requirement("requests[socks] >= 2.31, <3 ; python_version < '3.13'")
    ).toEqual({ name: 'requests', range: '>=2.31,<3' });
    expect(requirement('ruff')).toEqual({ name: 'ruff', range: '*' });
    expect(requirement('pkg @ https://example.test/pkg.whl')).toEqual({
      name: 'pkg',
      range: '*',
    });
    expect(normalizeName('Typing_Extensions')).toBe('typing-extensions');
  });

  it('reads PEP 621, PEP 735 groups and uv workspace sources', () => {
    const deps = pyprojectDependencies(PYPROJECT, 'pyproject.toml');
    expect(deps.map((d) => [d.name, d.range, d.kind, d.local])).toEqual([
      ['requests', '>=2.31,<3', 'runtime', undefined],
      ['Typing_Extensions', '*', 'runtime', undefined],
      ['core-lib', '*', 'runtime', true],
      ['rich', '>=13', 'optional', undefined],
      ['pytest', '>=8', 'dev', undefined],
      ['ruff', '*', 'dev', undefined],
    ]);
  });

  it('reads Poetry without python itself', () => {
    const deps = pyprojectDependencies(POETRY, 'pyproject.toml');
    expect(deps.map((d) => [d.name, d.range, d.kind, d.local])).toEqual([
      ['httpx', '^0.27', 'runtime', undefined],
      ['numpy', '^2.0', 'optional', undefined],
      ['shared', '*', 'runtime', true],
      ['pytest', '^8.0', 'dev', undefined],
    ]);
  });

  it('reads requirements files, dev ones by their name', () => {
    const text = '# pinned\nrequests==2.32.3\n-r base.txt\n\nflask>=3  # web\n';
    expect(
      requirementsDependencies(text, 'requirements.txt').map((d) => [
        d.name,
        d.range,
        d.kind,
      ])
    ).toEqual([
      ['requests', '==2.32.3', 'runtime'],
      ['flask', '>=3', 'runtime'],
    ]);
    expect(
      requirementsDependencies('pytest\n', 'requirements-dev.txt')[0]?.kind
    ).toBe('dev');
  });
});

describe('pythonDependencies', () => {
  it('takes versions from uv.lock by normalized name', async () => {
    const lock = `
version = 1

[[package]]
name = "requests"
version = "2.32.3"

[[package]]
name = "typing-extensions"
version = "4.12.2"
`;
    expect([...pythonLockVersions(lock)]).toEqual([
      ['requests', '2.32.3'],
      ['typing-extensions', '4.12.2'],
    ]);

    const files = new Map([
      ['pyproject.toml', PYPROJECT],
      ['uv.lock', lock],
    ]);
    const deps = await pythonDependencies(
      new Set(files.keys()),
      async (path) => files.get(path) ?? '',
      'src/weather/main.py'
    );
    expect(deps.slice(0, 3).map((d) => [d.name, d.version])).toEqual([
      ['requests', '2.32.3'],
      ['Typing_Extensions', '4.12.2'],
      ['core-lib', undefined],
    ]);
  });
});
