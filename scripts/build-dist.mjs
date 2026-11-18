#!/usr/bin/env node

/**
 * Build an auditable `.skill` archive and an adjacent per-file manifest.
 *
 * Design constraints (see docs/review-service-plan.md §11-12):
 * - Standard library only; no package installation or global tool is required.
 * - The package contents come from an explicit checked-in list
 *   (`scripts/dist-files.json`), never from a whole-directory glob.
 * - The manifest records path, byte size and SHA-256 for every packaged file.
 *   The manifest never hashes itself.
 * - ZIP paths are validated before writing and after reading: no absolute
 *   paths, no `..`, no backslashes, no duplicate case-insensitive names and no
 *   symbolic links.
 * - Per-file byte hashes are verified after writing. Container byte-for-byte
 *   reproducibility across zip tools is not claimed.
 *
 * This tool is intentionally not invoked by `npm test` for publication. Tests
 * pass an explicit temporary `--output` and never replace an existing `dist/`.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class DistError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'DistError';
    this.code = code;
    this.details = options.details;
  }
}

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const DIST_LIST_PATH = 'scripts/dist-files.json';
const DEFAULT_ARCHIVE_ROOT = 'product-continuity';
const DEFAULT_OUTPUT = path.join('dist', 'product-continuity.skill');
const MANAGED_DIRS = ['references', 'schemas', 'scripts', 'examples', 'tests', 'integrations'];
const EXCLUDED_TOP_DIRS = new Set([
  'docs',
  'evals',
  'generated',
  'node_modules',
  'dist',
  '.git',
]);
const PRIVATE_FILE_PATTERNS = [
  /\.review\.lock$/i,
  /\.bak(?:\.|$)/i,
  /\.pending(?:\.|$)/i,
  /\.failed(?:\.|$)/i,
  /\.token$/i,
  /\.log$/i,
];

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const ZIP_DOS_DATE_1980_01_01 = 0x0021;
const ZIP_VERSION = 20;
const ZIP_VERSION_MADE_BY_UNIX = (3 << 8) | ZIP_VERSION;
const ZIP_EXTERNAL_FILE_MODE = (0o100644 << 16) >>> 0;

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {string} `sha256:<64 lowercase hex>`
 */
export function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

let crcTable;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {number}
 */
export function crc32(bytes) {
  const table = getCrcTable();
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    value = table[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Validate one archive-relative path. The same rules apply to the explicit
 * source list, archive entry names and extracted destinations.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function validateRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DistError('invalid_path', 'A package path must be a non-empty string.');
  }
  if (value.includes('\\')) {
    throw new DistError('invalid_path', `Package paths use "/" only: ${JSON.stringify(value)}`);
  }
  if (value.includes('\0')) {
    throw new DistError('invalid_path', 'Package paths must not contain NUL bytes.');
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new DistError('invalid_path', `Absolute package paths are not allowed: ${value}`);
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new DistError('invalid_path', `Package path is not a canonical relative path: ${value}`);
    }
    if (/[\u0000-\u001f]/.test(segment)) {
      throw new DistError('invalid_path', `Package path contains a control character: ${value}`);
    }
  }
  if (path.posix.normalize(value) !== value) {
    throw new DistError('invalid_path', `Package path is not canonical: ${value}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function validateArchiveRoot(value) {
  if (typeof value !== 'string' || !value || value.includes('/') || value.includes('\\')) {
    throw new DistError('invalid_root', 'The archive root must be one non-empty path segment.');
  }
  if (value === '.' || value === '..' || value.includes('\0')) {
    throw new DistError('invalid_root', `Invalid archive root: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isExcludedRelativePath(relativePath) {
  const segments = relativePath.split('/');
  if (EXCLUDED_TOP_DIRS.has(segments[0].toLowerCase())) return true;
  const basename = segments[segments.length - 1];
  return PRIVATE_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

/**
 * Validate an explicit file list and return it sorted for a stable archive
 * order. Case-insensitive duplicates are rejected so Windows and
 * case-sensitive filesystems cannot produce different extraction results.
 *
 * @param {unknown} files
 * @returns {string[]}
 */
export function validateDistFileList(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new DistError('invalid_list', 'The distribution file list must be a non-empty array.');
  }
  if (files.length > 0xffff) {
    throw new DistError('invalid_list', 'The archive would contain more than 65535 entries.');
  }
  const seen = new Map();
  for (const value of files) {
    const relativePath = validateRelativePath(value);
    if (isExcludedRelativePath(relativePath)) {
      throw new DistError(
        'excluded_path',
        `The distribution list contains an excluded/private path: ${relativePath}`,
      );
    }
    const key = relativePath.toLowerCase();
    if (seen.has(key)) {
      throw new DistError(
        'duplicate_path',
        `Duplicate case-insensitive package path: ${relativePath} and ${seen.get(key)}`,
      );
    }
    seen.set(key, relativePath);
  }
  return [...files].sort();
}

async function walkFiles(directory, base = directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await walkFiles(absolute, base)));
    } else {
      result.push(path.relative(base, absolute).split(path.sep).join('/'));
    }
  }
  return result;
}

/**
 * Reject unlisted files in the dirs the package owns. This is an audit of the
 * explicit list, not a directory glob used for packaging.
 *
 * @param {string} sourceRoot
 * @param {string[]} listedFiles
 */
export async function assertNoUnlistedFiles(sourceRoot, listedFiles) {
  const listed = new Set(listedFiles.map((file) => file.toLowerCase()));
  const extras = [];

  for (const directoryName of MANAGED_DIRS) {
    const directory = path.join(sourceRoot, directoryName);
    let directoryStat;
    try {
      directoryStat = await lstat(directory);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!directoryStat.isDirectory()) continue;
    for (const relative of await walkFiles(directory)) {
      const packagePath = `${directoryName}/${relative}`;
      if (!listed.has(packagePath.toLowerCase()) && !isExcludedRelativePath(packagePath)) {
        extras.push(packagePath);
      }
    }
  }

  // Root files are part of the package too (README, SKILL, package files).
  // Hidden root files are not package candidates; they are never packaged by
  // the explicit list and are skipped here only to avoid flagging editor/VCS
  // metadata that is not part of the skill.
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!listed.has(entry.name.toLowerCase()) && !isExcludedRelativePath(entry.name)) {
      extras.push(entry.name);
    }
  }

  if (extras.length > 0) {
    throw new DistError(
      'unlisted_files',
      'The explicit distribution list does not cover every package-owned file. ' +
        `Add these to ${DIST_LIST_PATH} or remove them: ${extras.sort().join(', ')}`,
      { details: { extras: extras.sort() } },
    );
  }
}

/**
 * @param {string} sourceRoot
 * @returns {Promise<{schemaVersion: number, archiveRoot: string, files: string[]}>}
 */
export async function loadDistList(sourceRoot = DEFAULT_SOURCE_ROOT) {
  const listPath = path.join(sourceRoot, DIST_LIST_PATH);
  let raw;
  try {
    raw = JSON.parse(await readFile(listPath, 'utf8'));
  } catch (error) {
    throw new DistError('invalid_list', `Cannot read ${DIST_LIST_PATH}: ${error.message}`, {
      cause: error,
    });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DistError('invalid_list', `${DIST_LIST_PATH} must contain a JSON object.`);
  }
  if (raw.schemaVersion !== 1) {
    throw new DistError('invalid_list', `${DIST_LIST_PATH} schemaVersion must be 1.`);
  }
  return {
    schemaVersion: 1,
    archiveRoot: validateArchiveRoot(raw.archiveRoot ?? DEFAULT_ARCHIVE_ROOT),
    files: validateDistFileList(raw.files),
  };
}

/**
 * Read and hash every explicitly listed file. Symlinks, non-regular files and
 * paths that resolve outside the source root are rejected.
 *
 * @param {string} sourceRoot
 * @param {string[]} listedFiles
 * @returns {Promise<Array<{path: string, size: number, sha256: string, bytes: Buffer}>>}
 */
export async function collectDistFiles(sourceRoot, listedFiles) {
  const rootReal = await realpath(sourceRoot);
  const files = [];
  for (const relativePath of listedFiles) {
    validateRelativePath(relativePath);
    const absolute = path.join(sourceRoot, ...relativePath.split('/'));
    let fileStat;
    try {
      fileStat = await lstat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new DistError('missing_file', `Listed package file does not exist: ${relativePath}`, {
          cause: error,
        });
      }
      throw error;
    }
    if (fileStat.isSymbolicLink()) {
      throw new DistError('symlink', `Symbolic links are not packaged: ${relativePath}`);
    }
    if (!fileStat.isFile()) {
      throw new DistError('not_a_file', `Listed package path is not a regular file: ${relativePath}`);
    }
    const real = await realpath(absolute);
    const realRelative = path.relative(rootReal, real).split(path.sep).join('/');
    if (realRelative.toLowerCase() !== relativePath.toLowerCase()) {
      throw new DistError(
        'path_escape',
        `Package path resolves outside or through a link: ${relativePath}`,
      );
    }
    const bytes = await readFile(absolute);
    if (bytes.length !== fileStat.size) {
      throw new DistError(
        'unstable_file',
        `Package file size changed while reading: ${relativePath}`,
      );
    }
    if (bytes.length > 0xffffffff) {
      throw new DistError('too_large', `Package file exceeds the ZIP32 limit: ${relativePath}`);
    }
    files.push({
      path: relativePath,
      size: bytes.length,
      sha256: sha256Bytes(bytes),
      bytes,
    });
  }
  return files;
}

function writeUInt16LE(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
}

function writeUInt32LE(buffer, offset, value) {
  buffer.writeUInt32LE(value, offset);
}

function readUInt16LE(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

/**
 * Build a ZIP32 archive using stored (uncompressed) entries. Stored entries
 * make the per-file byte verification unambiguous and avoid depending on an
 * external zip utility. Container byte equality with other tools is not
 * promised.
 *
 * @param {Array<{path: string, size: number, sha256: string, bytes: Buffer}>} files
 * @param {string} archiveRoot
 * @returns {Buffer}
 */
export function buildZipBuffer(files, archiveRoot = DEFAULT_ARCHIVE_ROOT) {
  validateArchiveRoot(archiveRoot);
  if (files.length > 0xffff) {
    throw new DistError('too_many_entries', 'The archive would contain more than 65535 entries.');
  }

  const localParts = [];
  const centralParts = [];
  const seen = new Set();
  let offset = 0;
  let centralSize = 0;

  for (const file of files) {
    const name = `${archiveRoot}/${file.path}`;
    validateRelativePath(name);
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new DistError('duplicate_path', `Duplicate archive entry name: ${name}`);
    }
    seen.add(key);

    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > 0xffff) {
      throw new DistError('invalid_path', `Archive entry name is too long: ${name}`);
    }
    const size = file.bytes.length;
    const crc = crc32(file.bytes);
    if (offset > 0xffffffff) {
      throw new DistError('too_large', 'The archive would exceed the ZIP32 offset limit.');
    }

    const local = Buffer.alloc(30);
    writeUInt32LE(local, 0, ZIP_LOCAL_SIGNATURE);
    writeUInt16LE(local, 4, ZIP_VERSION);
    writeUInt16LE(local, 6, ZIP_UTF8_FLAG);
    writeUInt16LE(local, 8, ZIP_STORE_METHOD);
    writeUInt16LE(local, 10, 0);
    writeUInt16LE(local, 12, ZIP_DOS_DATE_1980_01_01);
    writeUInt32LE(local, 14, crc);
    writeUInt32LE(local, 18, size);
    writeUInt32LE(local, 22, size);
    writeUInt16LE(local, 26, nameBytes.length);
    writeUInt16LE(local, 28, 0);
    localParts.push(local, nameBytes, file.bytes);

    const central = Buffer.alloc(46);
    writeUInt32LE(central, 0, ZIP_CENTRAL_SIGNATURE);
    writeUInt16LE(central, 4, ZIP_VERSION_MADE_BY_UNIX);
    writeUInt16LE(central, 6, ZIP_VERSION);
    writeUInt16LE(central, 8, ZIP_UTF8_FLAG);
    writeUInt16LE(central, 10, ZIP_STORE_METHOD);
    writeUInt16LE(central, 12, 0);
    writeUInt16LE(central, 14, ZIP_DOS_DATE_1980_01_01);
    writeUInt32LE(central, 16, crc);
    writeUInt32LE(central, 20, size);
    writeUInt32LE(central, 24, size);
    writeUInt16LE(central, 28, nameBytes.length);
    writeUInt16LE(central, 30, 0);
    writeUInt16LE(central, 32, 0);
    writeUInt16LE(central, 34, 0);
    writeUInt16LE(central, 36, 0);
    writeUInt32LE(central, 38, ZIP_EXTERNAL_FILE_MODE);
    writeUInt32LE(central, 42, offset);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + file.bytes.length;
    centralSize += central.length + nameBytes.length;
  }

  if (offset > 0xffffffff || centralSize > 0xffffffff) {
    throw new DistError('too_large', 'The archive would exceed the ZIP32 size limit.');
  }

  const centralOffset = offset;
  const eocd = Buffer.alloc(22);
  writeUInt32LE(eocd, 0, ZIP_EOCD_SIGNATURE);
  writeUInt16LE(eocd, 4, 0);
  writeUInt16LE(eocd, 6, 0);
  writeUInt16LE(eocd, 8, files.length);
  writeUInt16LE(eocd, 10, files.length);
  writeUInt32LE(eocd, 12, centralSize);
  writeUInt32LE(eocd, 16, centralOffset);
  writeUInt16LE(eocd, 20, 0);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/**
 * @param {Buffer|Uint8Array} input
 * @returns {Array<{name: string, size: number, crc32: number, externalAttributes: number, bytes: Buffer}>}
 */
export function readZipEntries(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 22) {
    throw new DistError('invalid_zip', 'Archive is too short to contain an end-of-central-directory record.');
  }
  const minimumEocd = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= minimumEocd; index -= 1) {
    if (readUInt32LE(buffer, index) === ZIP_EOCD_SIGNATURE) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) {
    throw new DistError('invalid_zip', 'No end-of-central-directory record was found.');
  }
  const diskNumber = readUInt16LE(buffer, eocd + 4);
  const centralDisk = readUInt16LE(buffer, eocd + 6);
  const entriesOnDisk = readUInt16LE(buffer, eocd + 8);
  const entryCount = readUInt16LE(buffer, eocd + 10);
  const centralSize = readUInt32LE(buffer, eocd + 12);
  const centralOffset = readUInt32LE(buffer, eocd + 16);
  const commentLength = readUInt16LE(buffer, eocd + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new DistError('invalid_zip', 'Multi-disk archives are not supported.');
  }
  if (eocd + 22 + commentLength !== buffer.length) {
    throw new DistError('invalid_zip', 'The end-of-central-directory comment length is inconsistent.');
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new DistError('invalid_zip', 'The central directory points outside the archive.');
  }

  const entries = [];
  const names = new Set();
  let position = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (position + 46 > buffer.length || readUInt32LE(buffer, position) !== ZIP_CENTRAL_SIGNATURE) {
      throw new DistError('invalid_zip', `Central directory entry ${index} is malformed.`);
    }
    const flags = readUInt16LE(buffer, position + 8);
    const method = readUInt16LE(buffer, position + 10);
    const crc = readUInt32LE(buffer, position + 16);
    const compressedSize = readUInt32LE(buffer, position + 20);
    const uncompressedSize = readUInt32LE(buffer, position + 24);
    const nameLength = readUInt16LE(buffer, position + 28);
    const extraLength = readUInt16LE(buffer, position + 30);
    const entryCommentLength = readUInt16LE(buffer, position + 32);
    const localOffset = readUInt32LE(buffer, position + 42);
    if (flags & 0x0001) {
      throw new DistError('encrypted_entry', 'Encrypted archive entries are not supported.');
    }
    if (method !== ZIP_STORE_METHOD) {
      throw new DistError('unsupported_compression', 'Only stored (uncompressed) entries are supported.');
    }
    if (position + 46 + nameLength + extraLength + entryCommentLength > buffer.length) {
      throw new DistError('invalid_zip', 'A central directory entry extends past the archive.');
    }
    const name = buffer
      .subarray(position + 46, position + 46 + nameLength)
      .toString('utf8');
    validateRelativePath(name);
    if (names.has(name.toLowerCase())) {
      throw new DistError('duplicate_path', `Duplicate archive entry name: ${name}`);
    }
    names.add(name.toLowerCase());

    if (localOffset + 30 > buffer.length || readUInt32LE(buffer, localOffset) !== ZIP_LOCAL_SIGNATURE) {
      throw new DistError('invalid_zip', `Local header for ${name} is malformed.`);
    }
    const localNameLength = readUInt16LE(buffer, localOffset + 26);
    const localExtraLength = readUInt16LE(buffer, localOffset + 28);
    const localName = buffer
      .subarray(localOffset + 30, localOffset + 30 + localNameLength)
      .toString('utf8');
    if (localName !== name) {
      throw new DistError('invalid_zip', `Local and central names differ for ${name}.`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length || compressedSize !== uncompressedSize) {
      throw new DistError('invalid_zip', `Stored entry size is inconsistent for ${name}.`);
    }
    const bytes = buffer.subarray(dataStart, dataEnd);
    const actualCrc = crc32(bytes);
    if (actualCrc !== crc) {
      throw new DistError('invalid_zip', `CRC mismatch for archive entry ${name}.`);
    }

    entries.push({
      name,
      size: uncompressedSize,
      crc32: crc,
      externalAttributes: readUInt32LE(buffer, position + 38),
      bytes,
    });
    position += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (position !== centralOffset + centralSize) {
    throw new DistError('invalid_zip', 'Central directory size does not match its entries.');
  }
  return entries;
}

/**
 * Extract already-read entries into an explicit temporary directory. Every
 * destination is checked to stay under that directory; existing files are not
 * overwritten.
 *
 * @param {Array<{name: string, bytes: Buffer}>} entries
 * @param {string} targetDirectory
 * @param {{root?: string}} [options]
 * @returns {Promise<string[]>} extracted relative paths
 */
export async function extractZipEntries(entries, targetDirectory, options = {}) {
  const root = validateArchiveRoot(options.root ?? DEFAULT_ARCHIVE_ROOT);
  const target = path.resolve(targetDirectory);
  await mkdir(target, { recursive: true });
  const seen = new Set();
  const extracted = [];
  for (const entry of entries) {
    validateRelativePath(entry.name);
    if (!entry.name.startsWith(`${root}/`)) {
      throw new DistError('invalid_zip', `Archive entry is outside the ${root}/ root: ${entry.name}`);
    }
    const relativePath = entry.name.slice(root.length + 1);
    validateRelativePath(relativePath);
    const key = relativePath.toLowerCase();
    if (seen.has(key)) {
      throw new DistError('duplicate_path', `Duplicate extraction path: ${relativePath}`);
    }
    seen.add(key);

    const destination = path.resolve(target, ...relativePath.split('/'));
    const relative = path.relative(target, destination);
    if (
      relative === '' ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      path.dirname(relative) === relative
    ) {
      throw new DistError('path_escape', `Archive entry escapes the extraction directory: ${entry.name}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(destination, entry.bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new DistError('existing_file', `Extraction would overwrite an existing file: ${relativePath}`);
      }
      throw error;
    }
    extracted.push(relativePath);
  }
  return extracted.sort();
}

/**
 * @param {Array<{path: string, size: number, sha256: string}>} files
 * @param {Buffer} archiveBytes
 * @param {{archiveName: string, archiveRoot: string, version?: string}} options
 * @returns {object}
 */
export function createManifest(files, archiveBytes, options) {
  const archiveRoot = validateArchiveRoot(options.archiveRoot);
  return {
    schemaVersion: 1,
    skill: 'product-continuity',
    version: options.version ?? null,
    archiveRoot,
    archive: {
      file: options.archiveName,
      size: archiveBytes.length,
      sha256: sha256Bytes(archiveBytes),
    },
    files: files.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
    })),
  };
}

function assertPackedEntries(entries, files, archiveRoot) {
  if (entries.length !== files.length) {
    throw new DistError(
      'manifest_mismatch',
      `Archive has ${entries.length} entries but the explicit list has ${files.length} files.`,
    );
  }
  const expected = new Map(files.map((file) => [`${archiveRoot}/${file.path}`.toLowerCase(), file]));
  for (const entry of entries) {
    const file = expected.get(entry.name.toLowerCase());
    if (!file) {
      throw new DistError('manifest_mismatch', `Unexpected archive entry: ${entry.name}`);
    }
    if (entry.size !== file.size) {
      throw new DistError('manifest_mismatch', `Archive entry size differs: ${entry.name}`);
    }
    if (sha256Bytes(entry.bytes) !== file.sha256) {
      throw new DistError('manifest_mismatch', `Archive entry digest differs: ${entry.name}`);
    }
    if (((entry.externalAttributes >>> 16) & 0xf000) !== 0x8000) {
      throw new DistError('manifest_mismatch', `Archive entry is not a regular file: ${entry.name}`);
    }
  }
}

function assertManifestMatches(manifest, files, archiveBytes, options) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
    throw new DistError('manifest_mismatch', 'The manifest does not contain a files array.');
  }
  if (manifest.archiveRoot !== options.archiveRoot) {
    throw new DistError('manifest_mismatch', 'The manifest archiveRoot is inconsistent.');
  }
  if (manifest.archive?.file !== options.archiveName) {
    throw new DistError('manifest_mismatch', 'The manifest archive file name is inconsistent.');
  }
  if (manifest.archive?.size !== archiveBytes.length) {
    throw new DistError('manifest_mismatch', 'The manifest archive size is inconsistent.');
  }
  if (manifest.archive?.sha256 !== sha256Bytes(archiveBytes)) {
    throw new DistError('manifest_mismatch', 'The manifest archive digest is inconsistent.');
  }
  if (manifest.files.length !== files.length) {
    throw new DistError('manifest_mismatch', 'The manifest file count is inconsistent.');
  }
  const byPath = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  const seen = new Set();
  for (const item of manifest.files) {
    const relativePath = validateRelativePath(item.path);
    const key = relativePath.toLowerCase();
    if (seen.has(key)) {
      throw new DistError('manifest_mismatch', `Duplicate manifest path: ${relativePath}`);
    }
    seen.add(key);
    const file = byPath.get(key);
    if (!file) {
      throw new DistError('manifest_mismatch', `Unexpected manifest path: ${relativePath}`);
    }
    if (item.size !== file.size || item.sha256 !== file.sha256) {
      throw new DistError('manifest_mismatch', `Manifest entry differs from source bytes: ${relativePath}`);
    }
  }
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeBytesAtomic(target, bytes, { force }) {
  await mkdir(path.dirname(target), { recursive: true });
  if (!force && (await pathExists(target))) {
    throw new DistError('output_exists', `Refusing to overwrite an existing file: ${target}`);
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${process.pid}-${randomUUID()}`,
  );
  await writeFile(temporary, bytes, { flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    if (force && ['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) {
      await rm(target, { force: true });
      await rename(temporary, target);
    } else {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function defaultManifestPath(outputPath) {
  const extension = path.extname(outputPath);
  const base = extension ? outputPath.slice(0, -extension.length) : outputPath;
  return `${base}.manifest.json`;
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === 'win32') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

async function readPackageVersion(sourceRoot) {
  try {
    const packageJson = JSON.parse(
      await readFile(path.join(sourceRoot, 'package.json'), 'utf8'),
    );
    return typeof packageJson.version === 'string' ? packageJson.version : null;
  } catch {
    return null;
  }
}

/**
 * Build, write and verify a distribution. With `checkOnly`, everything is
 * assembled and verified in memory but no output is written.
 *
 * @param {{
 *   sourceRoot?: string,
 *   output?: string,
 *   manifestPath?: string,
 *   force?: boolean,
 *   checkOnly?: boolean
 * }} [options]
 */
export async function buildDistribution(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT);
  const checkOnly = options.checkOnly === true;
  const force = options.force === true;
  const output = path.resolve(options.output ?? path.join(sourceRoot, DEFAULT_OUTPUT));
  const list = await loadDistList(sourceRoot);
  await assertNoUnlistedFiles(sourceRoot, list.files);
  const files = await collectDistFiles(sourceRoot, list.files);
  const archiveBytes = buildZipBuffer(files, list.archiveRoot);
  const archiveEntries = readZipEntries(archiveBytes);
  assertPackedEntries(archiveEntries, files, list.archiveRoot);

  const manifest = createManifest(files, archiveBytes, {
    archiveName: path.basename(output),
    archiveRoot: list.archiveRoot,
    version: await readPackageVersion(sourceRoot),
  });
  const manifestPath = path.resolve(
    options.manifestPath ?? defaultManifestPath(output),
  );
  if (samePath(output, manifestPath)) {
    throw new DistError('invalid_output', 'The archive and manifest paths must differ.');
  }
  const sourcePaths = new Set(
    files.map((file) => path.resolve(sourceRoot, ...file.path.split('/')).toLowerCase()),
  );
  if (sourcePaths.has(output.toLowerCase()) || sourcePaths.has(manifestPath.toLowerCase())) {
    throw new DistError('invalid_output', 'Output paths must not overwrite a packaged source file.');
  }

  if (checkOnly) {
    return {
      checkOnly: true,
      output: null,
      manifestPath: null,
      manifest,
      files,
      archiveEntries,
      archiveBytes,
    };
  }

  if (!force) {
    for (const target of [output, manifestPath]) {
      if (await pathExists(target)) {
        throw new DistError('output_exists', `Refusing to overwrite an existing file: ${target}`);
      }
    }
  }

  await writeBytesAtomic(output, archiveBytes, { force });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeBytesAtomic(manifestPath, manifestBytes, { force });

  const writtenArchive = await readFile(output);
  const writtenEntries = readZipEntries(writtenArchive);
  assertPackedEntries(writtenEntries, files, list.archiveRoot);
  const writtenManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assertManifestMatches(writtenManifest, files, writtenArchive, {
    archiveName: path.basename(output),
    archiveRoot: list.archiveRoot,
  });
  const expectedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  if (`${JSON.stringify(writtenManifest, null, 2)}\n` !== expectedManifest) {
    throw new DistError('manifest_mismatch', 'The written manifest differs from the in-memory manifest.');
  }

  return {
    checkOnly: false,
    output,
    manifestPath,
    manifest,
    files,
    archiveEntries: writtenEntries,
    archiveBytes: writtenArchive,
  };
}

function parseArguments(argv) {
  const args = {
    sourceRoot: DEFAULT_SOURCE_ROOT,
    output: null,
    manifestPath: null,
    force: false,
    checkOnly: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      args.help = true;
      continue;
    }
    if (argument === '--force') {
      args.force = true;
      continue;
    }
    if (argument === '--check') {
      args.checkOnly = true;
      continue;
    }
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=');
      const name = equals === -1 ? argument : argument.slice(0, equals);
      let value = equals === -1 ? undefined : argument.slice(equals + 1);
      if (value === undefined) {
        value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new DistError('usage', `Missing value for ${name}.`);
        }
        index += 1;
      }
      if (name === '--source') {
        args.sourceRoot = path.resolve(value);
      } else if (name === '--output') {
        args.output = path.resolve(value);
      } else if (name === '--manifest') {
        args.manifestPath = path.resolve(value);
      } else {
        throw new DistError('usage', `Unknown option: ${name}`);
      }
      continue;
    }
    throw new DistError('usage', `Unexpected argument: ${argument}`);
  }
  return args;
}

/**
 * @param {string[]} [argv]
 */
export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArguments(argv);
  } catch (error) {
    console.error(`[build-dist] ${error.message}`);
    process.exitCode = 2;
    return null;
  }
  if (args.help) {
    console.log(
      'Usage: node scripts/build-dist.mjs [--output <file>] [--manifest <file>]\n' +
        '                                 [--source <skill-dir>] [--force] [--check]\n' +
        'Default output: <skill-dir>/dist/product-continuity.skill\n' +
        'Default manifest: <output-without-extension>.manifest.json',
    );
    return null;
  }
  try {
    const result = await buildDistribution({
      sourceRoot: args.sourceRoot,
      output: args.output ?? undefined,
      manifestPath: args.manifestPath ?? undefined,
      force: args.force,
      checkOnly: args.checkOnly,
    });
    if (result.checkOnly) {
      console.log(
        `Verified explicit list: ${result.files.length} files, ${result.archiveBytes.length} archive bytes; nothing was written.`,
      );
      console.log(`Archive root: ${result.manifest.archiveRoot}/`);
      return result;
    }
    console.log(`Archive: ${result.output} (${result.archiveBytes.length} bytes)`);
    console.log(`Manifest: ${result.manifestPath} (${result.files.length} files)`);
    console.log(
      `Verified per-file bytes: ${result.archiveEntries.length}/${result.files.length} entries match size and SHA-256.`,
    );
    return result;
  } catch (error) {
    console.error(`[build-dist] ${error.code ?? 'error'}: ${error.message}`);
    if (error.details?.extras) {
      console.error(`[build-dist] unlisted: ${error.details.extras.join(', ')}`);
    }
    process.exitCode = 1;
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
