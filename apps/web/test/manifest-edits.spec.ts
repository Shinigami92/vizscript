import { describe, expect, it } from 'vitest';
import {
  addCargoDependency,
  addNpmDependency,
  addPythonDependency,
  npmRangeStyle,
} from '../src/graph/manifest-edits';

const PACKAGE = `{
  "name": "app",
  "dependencies": {
    "pinia": "~4.1.0",
    "vue": "~3.5.45"
  },
  "scripts": {}
}
`;

describe('addNpmDependency', () => {
  it('inserts in alphabetical order with the indentation of its section', () => {
    expect(addNpmDependency(PACKAGE, 'smol-toml', '1.9.1', 'runtime')).toBe(`{
  "name": "app",
  "dependencies": {
    "pinia": "~4.1.0",
    "smol-toml": "~1.9.1",
    "vue": "~3.5.45"
  },
  "scripts": {}
}
`);
    expect(addNpmDependency(PACKAGE, 'zod', '4.0.0', 'runtime')).toContain(
      '"vue": "~3.5.45",\n    "zod": "~4.0.0"\n  },'
    );
  });

  it('writes a package of the repository with its protocol', () => {
    expect(
      addNpmDependency(PACKAGE, '@acme/api', 'workspace:*', 'runtime')
    ).toContain('"@acme/api": "workspace:*",\n    "pinia"');
  });

  it('adds a missing section at the end, and leaves listed packages', () => {
    // A new section takes the file's style.
    expect(addNpmDependency(PACKAGE, 'vitest', '5.0.5', 'dev')).toBe(`{
  "name": "app",
  "dependencies": {
    "pinia": "~4.1.0",
    "vue": "~3.5.45"
  },
  "scripts": {},
  "devDependencies": {
    "vitest": "~5.0.5"
  }
}
`);
    expect(addNpmDependency(PACKAGE, 'vue', '3.0.0', 'runtime')).toBe(PACKAGE);
    expect(
      addNpmDependency('{\n  "devDependencies": {}\n}\n', 'x', '1.0.0', 'dev')
    ).toBe('{\n  "devDependencies": {\n    "x": "^1.0.0"\n  }\n}\n');
  });

  it('writes versions like the section it goes into', () => {
    const mixed = `{
  "dependencies": { "vue": "~3.5.45" },
  "devDependencies": { "vite": "8.3.7" }
}`;
    expect(addNpmDependency(mixed, 'dayjs', '1.11.23', 'dev')).toContain(
      '"dayjs": "1.11.23"'
    );
    expect(addNpmDependency(mixed, 'zod', '4.6.7', 'runtime')).toContain(
      '"zod": "~4.6.7"'
    );
  });

  it('follows the file’s range style', () => {
    expect(npmRangeStyle(PACKAGE)).toBe('~');
    expect(npmRangeStyle('{"a": "1.2.3", "b": "4.0.0", "c": "^1.0.0"}')).toBe(
      ''
    );
    expect(npmRangeStyle('{}')).toBe('^');
  });
});

describe('addCargoDependency', () => {
  const CARGO = `[package]
name = "hsml"

[dependencies]
nom = "8.0.0"
serde = { version = "1.0.228", features = ["derive"] }

[dev-dependencies]
insta = "1"
`;

  it('inserts into the table of the kind, in order', () => {
    expect(addCargoDependency(CARGO, 'regex', '1.11.1', 'runtime')).toContain(
      'nom = "8.0.0"\nregex = "1.11.1"\nserde = {'
    );
    expect(addCargoDependency(CARGO, 'pretty_assertions', '1.4.1', 'dev')).toBe(
      `${CARGO.trimEnd()}\npretty_assertions = "1.4.1"\n`
    );
    expect(addCargoDependency(CARGO, 'cc', '1.2.0', 'build')).toBe(
      `${CARGO.trimEnd()}\n\n[build-dependencies]\ncc = "1.2.0"\n`
    );
    expect(addCargoDependency(CARGO, 'nom', '9.0.0', 'runtime')).toBe(CARGO);
  });
});

describe('addPythonDependency', () => {
  const PYPROJECT = `[project]
name = "weather"
dependencies = [
    "requests>=2.31",
    "rich",
]

[tool.ruff]
line-length = 88
`;

  it('adds to a multi-line array, and dev to a dependency group', () => {
    expect(
      addPythonDependency(
        'pyproject.toml',
        PYPROJECT,
        'httpx',
        '0.28.1',
        'runtime'
      )
    ).toContain('    "rich",\n    "httpx>=0.28.1",\n]');
    expect(
      addPythonDependency('pyproject.toml', PYPROJECT, 'pytest', '8.3.0', 'dev')
    ).toContain('[dependency-groups]\ndev = [\n    "pytest>=8.3.0",\n]\n');
  });

  it('adds to a one-line array and to requirements files', () => {
    expect(
      addPythonDependency(
        'pyproject.toml',
        '[project]\ndependencies = ["a"]\n',
        'httpx',
        '0.28.1',
        'runtime'
      )
    ).toBe('[project]\ndependencies = ["a", "httpx>=0.28.1"]\n');
    expect(
      addPythonDependency(
        'pyproject.toml',
        '[project]\ndependencies = []\n',
        'b',
        '1.0',
        'runtime'
      )
    ).toBe('[project]\ndependencies = ["b>=1.0"]\n');
    expect(
      addPythonDependency(
        'requirements.txt',
        'flask>=3\n',
        'httpx',
        '0.28.1',
        'runtime'
      )
    ).toBe('flask>=3\nhttpx>=0.28.1\n');
  });

  it('writes Poetry projects in Poetry’s tables', () => {
    expect(
      addPythonDependency(
        'pyproject.toml',
        '[tool.poetry.dependencies]\npython = "^3.11"\n',
        'httpx',
        '0.28.1',
        'runtime'
      )
    ).toBe('[tool.poetry.dependencies]\nhttpx = "^0.28.1"\npython = "^3.11"\n');
  });
});
