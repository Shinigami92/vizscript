import { api } from '../api/client';

/**
 * The server's type registry (`/api/types`): library type files of
 * jsDelivr, cached on the server for every user. Used when the server says
 * it has one (`ClientConfig.typeRegistry`); static deployments without an
 * API (the playground on GitHub Pages) read jsDelivr directly.
 */

const CDN = 'https://cdn.jsdelivr.net/';
const LISTING = 'https://data.jsdelivr.com/v1/packages/';

let available: Promise<boolean> | undefined;

/** Whether the server serves library types; asked once per visit. */
export function typeRegistryAvailable(): Promise<boolean> {
  available ??= api
    .config()
    .then((config) => config.typeRegistry)
    .catch(() => false);
  return available;
}

/**
 * The registry's URL for a jsDelivr URL: a file of the CDN or a listing
 * (`?structure=flat`); `undefined` for anything else.
 */
export function registryUrl(url: string): string | undefined {
  if (url.startsWith(CDN)) {
    return `/api/types?path=${encodeURIComponent(url.slice(CDN.length))}`;
  }

  if (url.startsWith(LISTING) && url.endsWith('?structure=flat')) {
    const path = url.slice(LISTING.length, -'?structure=flat'.length);
    return `/api/types/listing?path=${encodeURIComponent(path)}`;
  }

  return undefined;
}
