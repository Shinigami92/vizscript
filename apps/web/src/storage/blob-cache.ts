/**
 * Contents of repository files by their git blob sha, in the browser's
 * Cache API: a sha names one content, so a cached file is never stale.
 * Reloads read the imported files, manifests and lockfiles from here
 * instead of asking GitHub again (seconds for big files).
 */
const CACHE = 'vizscript-blobs';

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

async function open(): Promise<Cache | undefined> {
  try {
    return await globalThis.caches?.open(CACHE);
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

/** Forgets every cached file (signing out: private repositories too). */
export async function clearBlobs(): Promise<void> {
  try {
    await globalThis.caches?.delete(CACHE);
  } catch {
    // Nothing to clear.
  }
}
