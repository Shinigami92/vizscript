import { inflateRawSync } from 'node:zlib';

/**
 * The type-bearing files of a Python wheel (a zip file): `.pyi` stubs, and
 * the `.py` files of packages marked typed with `py.typed` (PEP 561). Read
 * in memory with Node's zlib: a wheel needs only the zip's central
 * directory and deflate.
 */

export interface PackageTypes {
  name: string;
  version: string;
  /** Files by their path in the wheel (`httpx/_client.py`). */
  files: Record<string, string>;
}

/** One file larger than this is left out; all files together at most. */
const FILE_LIMIT = 1024 * 1024;
const TOTAL_LIMIT = 8 * 1024 * 1024;

const EOCD = 0x06_05_4b_50;
const CENTRAL = 0x02_01_4b_50;
const LOCAL = 0x04_03_4b_50;

interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

/** The entries of a zip's central directory; `[]` when it isn't a zip. */
export function zipEntries(zip: Buffer): ZipEntry[] {
  // The end record is in the last 64 KiB (after a comment of up to that).
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }

  if (end < 0) {
    return [];
  }

  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count && at + 46 <= zip.length; i++) {
    if (zip.readUInt32LE(at) !== CENTRAL) {
      break;
    }

    const nameLength = zip.readUInt16LE(at + 28);
    entries.push({
      method: zip.readUInt16LE(at + 10),
      compressed: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      offset: zip.readUInt32LE(at + 42),
      name: zip.toString('utf8', at + 46, at + 46 + nameLength),
    });
    at +=
      46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }

  return entries;
}

/** The content of one entry; `undefined` for other compressions. */
export function zipContent(zip: Buffer, entry: ZipEntry): Buffer | undefined {
  if (zip.readUInt32LE(entry.offset) !== LOCAL) {
    return undefined;
  }

  const start =
    entry.offset +
    30 +
    zip.readUInt16LE(entry.offset + 26) +
    zip.readUInt16LE(entry.offset + 28);
  const data = zip.subarray(start, start + entry.compressed);
  if (entry.method === 0) {
    return data;
  }

  return entry.method === 8
    ? inflateRawSync(data, { maxOutputLength: FILE_LIMIT })
    : undefined;
}

/** The typed files of a wheel; no files when the package has no types. */
export function wheelTypes(
  wheel: Buffer,
  name: string,
  version: string
): PackageTypes {
  const entries = zipEntries(wheel).filter(
    (entry) =>
      !/^[^/]+\.(?:dist-info|data)\//.test(entry.name) &&
      entry.size <= FILE_LIMIT
  );
  // Folders marked typed (`httpx/py.typed`): their `.py` files count.
  const typed = entries
    .filter((entry) => entry.name.endsWith('/py.typed'))
    .map((entry) => entry.name.slice(0, -'py.typed'.length));
  const stubs = new Set(
    entries.filter((e) => e.name.endsWith('.pyi')).map((e) => e.name)
  );
  // A `.py` file next to its stub isn't read (the stub wins, PEP 561).
  const wanted = entries.filter(
    (entry) =>
      stubs.has(entry.name) ||
      (entry.name.endsWith('.py') &&
        !stubs.has(`${entry.name}i`) &&
        typed.some((folder) => entry.name.startsWith(folder)))
  );

  const files: Record<string, string> = {};
  let total = 0;
  // Stubs first: they win over a `.py` file when the limit is reached.
  for (const entry of wanted.toSorted(
    (a, b) => Number(b.name.endsWith('.pyi')) - Number(a.name.endsWith('.pyi'))
  )) {
    if (total + entry.size > TOTAL_LIMIT) {
      continue;
    }

    try {
      const content = zipContent(wheel, entry);
      if (content) {
        files[entry.name] = content.toString('utf8');
        total += content.length;
      }
    } catch {
      // A broken entry: left out.
    }
  }

  return { name, version, files };
}

/**
 * The wheel to read from a release's files on PyPI: a pure-Python one
 * (`py3-none-any`) when there is one, else the smallest wheel (binary ones
 * still carry their stubs and Python files).
 */
export function pickWheel(
  files: ReadonlyArray<{ filename?: unknown; url?: unknown; size?: unknown }>
): string | undefined {
  const wheels = files.flatMap((file) =>
    typeof file.filename === 'string' &&
    typeof file.url === 'string' &&
    file.filename.endsWith('.whl')
      ? [
          {
            name: file.filename,
            url: file.url,
            size: typeof file.size === 'number' ? file.size : Infinity,
          },
        ]
      : []
  );
  const pure = wheels.find((wheel) => wheel.name.endsWith('-none-any.whl'));
  return (pure ?? wheels.toSorted((a, b) => a.size - b.size)[0])?.url;
}
