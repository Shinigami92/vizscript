import type { TreeResponse } from '@vizscript/api-contract';

/**
 * Contents of repository files by their git blob sha, in the browser's
 * Cache API: a sha names one content, so a cached file is never stale.
 * Reloads read the imported files, manifests and lockfiles from here
 * instead of asking GitHub again (seconds for big files).
 */
const CACHE = 'vizscript-blobs';

/**
 * The last tree of each branch, shown before GitHub answers (seconds for
 * big trees); the fresh one replaces it.
 */
const TREES = 'vizscript-trees';

/** Trees bigger than this aren't kept (huge monorepos). */
const MAX_TREE_BYTES = 20 * 1024 * 1024;

/** Bigger files are not kept (generated bundles, huge lockfiles). */
const MAX_BYTES = 5 * 1024 * 1024;

/** A key per file content: `github/owner/repo/<sha>`. */
export interface BlobKey {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
}

function request(key: BlobKey): Request {
  const path = [key.provider, key.owner, key.repo, key.sha]
    .map(encodeURIComponent)
    .join('/');
  return new Request(`${globalThis.location.origin}/__blobs/${path}`);
}

async function open(name = CACHE): Promise<Cache | undefined> {
  try {
    return await globalThis.caches?.open(name);
  } catch {
    // Not available (an insecure origin, private browsing).
    return undefined;
  }
}

/** The cached text of a file, if any. */
export async function cachedBlob(key: BlobKey): Promise<string | undefined> {
  try {
    const response = await (await open())?.match(request(key));
    return response ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a file's text (nothing happens where the cache can't be used). */
export async function storeBlob(key: BlobKey, text: string): Promise<void> {
  if (text.length > MAX_BYTES) {
    return;
  }

  try {
    await (
      await open()
    )?.put(
      request(key),
      new Response(text, { headers: { 'content-type': 'text/plain' } })
    );
  } catch {
    // Full or unavailable: the file is read again next time.
  }
}

/** A branch of a repository: `github/owner/repo@main`. */
export interface TreeKey {
  provider: string;
  owner: string;
  repo: string;
  ref: string;
}

function treeRequest(key: TreeKey): Request {
  const path = [key.provider, key.owner, key.repo, key.ref]
    .map(encodeURIComponent)
    .join('/');
  return new Request(`${globalThis.location.origin}/__trees/${path}`);
}

/** The branch's tree as it was last seen, if kept. */
export async function cachedTree(
  key: TreeKey
): Promise<TreeResponse | undefined> {
  try {
    const response = await (await open(TREES))?.match(treeRequest(key));
    const tree = response ? ((await response.json()) as unknown) : undefined;
    return isTree(tree) ? tree : undefined;
  } catch {
    return undefined;
  }
}

function isTree(value: unknown): value is TreeResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as TreeResponse).entries)
  );
}

/** Keeps the branch's tree for the next visit. */
export async function storeTree(
  key: TreeKey,
  tree: TreeResponse
): Promise<void> {
  const json = JSON.stringify(tree);
  if (json.length > MAX_TREE_BYTES) {
    return;
  }

  try {
    await (
      await open(TREES)
    )?.put(
      treeRequest(key),
      new Response(json, { headers: { 'content-type': 'application/json' } })
    );
  } catch {
    // Full or unavailable: GitHub is asked again next time.
  }
}

/**
 * Forgets every cached file and tree (signing out: private repositories
 * too).
 */
export async function clearRepoCache(): Promise<void> {
  try {
    await globalThis.caches?.delete(CACHE);
    await globalThis.caches?.delete(TREES);
  } catch {
    // Nothing to clear.
  }
}
