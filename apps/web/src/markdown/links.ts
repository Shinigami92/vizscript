/** Repository a Markdown file belongs to (for its relative links). */
export interface RepoLocation {
  provider: string;
  owner: string;
  repo: string;
  ref: string;
}

function isAbsolute(url: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//');
}

/** Resolves `url` relative to the file `path` (`/x` = repository root). */
export function resolveRepoPath(path: string, url: string): string {
  const dir = path.includes('/')
    ? path.slice(0, path.lastIndexOf('/') + 1)
    : '';
  const base = new URL(`https://repo.invalid/${dir}`);
  const resolved = new URL(url, base);
  return decodeURIComponent(resolved.pathname.replace(/^\//, ''));
}

function splitHash(url: string): [string, string] {
  const index = url.indexOf('#');
  return index === -1 ? [url, ''] : [url.slice(0, index), url.slice(index)];
}

/** URL of a link in a Markdown file; repository files open in the app. */
export function resolveLink(
  path: string,
  href: string,
  repo: RepoLocation | undefined
): { href: string; internal: boolean } {
  if (!href || href.startsWith('#') || isAbsolute(href)) {
    return { href, internal: false };
  }

  if (!repo) {
    return { href, internal: false };
  }

  const [target, hash] = splitHash(href);
  const file = resolveRepoPath(path, target.split('?')[0] ?? '');
  return {
    href: `/${repo.provider}/${repo.owner}/${repo.repo}/tree/${encodeURIComponent(repo.ref)}/${file
      .split('/')
      .map(encodeURIComponent)
      .join('/')}${hash}`,
    internal: true,
  };
}

/** URL of an image in a Markdown file (raw file from the repository). */
export function resolveImage(
  path: string,
  src: string,
  repo: RepoLocation | undefined
): string {
  if (!src || isAbsolute(src) || !repo || repo.provider !== 'github') {
    return src;
  }

  const file = resolveRepoPath(path, src);
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.ref}/${file
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}
