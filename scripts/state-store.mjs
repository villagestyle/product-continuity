/**
 * Reliable local state-file layer shared by the review service and the
 * migration CLI.
 *
 * Scope and honest limits:
 * - Single local project, cooperative single-writer lock, Node >= 22.
 * - Primary target is Windows NTFS; UNC and recognised network volumes are
 *   rejected, but mapped network drives that look local cannot always be
 *   detected.
 * - The lock is cooperative. It does not stop an arbitrary external editor,
 *   and the final check-to-rename gap is not OS-level write isolation.
 * - A verified replacement means "a complete, fully validated state was read
 *   back after rename". It is not a claim about power-loss durability.
 * - Backups and temporary files are never deleted automatically after a
 *   failure and no state is rolled back automatically.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalStringify, isSha256Digest } from './intent-model.mjs';
import { validateStateReferences } from './validate-state.mjs';

// Load the AJV-backed validator lazily enough that missing node_modules does
// not kill module loading before a caller can print the npm ci hint. The file
// itself is still the single full-schema implementation.
let schemaRunner = null;
let schemaRunnerError = null;
try {
  schemaRunner = await import('./validate-schema-runner.mjs');
} catch (error) {
  schemaRunnerError = error;
}

function requireSchemaRunner() {
  if (!schemaRunner) {
    throw new StoreError(
      'dependency_unavailable',
      'Schema validation dependencies are unavailable; run npm ci in the extracted Skill directory.',
      { status: 500, cause: schemaRunnerError },
    );
  }
  return schemaRunner;
}

function getCompiledValidators() {
  return requireSchemaRunner().getCompiledValidators();
}

function validateStateSchema(state) {
  return requireSchemaRunner().validateStateSchema(state);
}

function validateReviewRequest(request) {
  return requireSchemaRunner().validateReviewRequest(request);
}

function validatePreviewRequest(request) {
  return requireSchemaRunner().validatePreviewRequest(request);
}

export const DEFAULT_MAX_STATE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_QUEUE = 16;
export const LOCK_SUFFIX = '.review.lock';
export const DEFAULT_VIEW_BASENAME = 'product-map.review.html';

const RENAME_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MAX_RENAME_ATTEMPTS = 5;
const RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160];

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const IO_MARK = Symbol('product-continuity-state-store-io');

const NETWORK_FS_MAGIC = new Set([
  0x6969, // NFS
  0xff534d42, // CIFS
  0x517b, // SMB
  0xfe534d42, // SMB2
  0x5346414f, // AFS
]);

/**
 * Stable, code-bearing error used by both the CLI and the future HTTP layer.
 * `commitStatus` answers only what the storage layer can prove.
 */
export class StoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'StoreError';
    this.code = code;
    this.status = options.status ?? 500;
    this.commitStatus = options.commitStatus ?? 'not_committed';
    this.details = options.details ?? {};
  }
}

const defaultIo = {
  readFile: (...args) => fsp.readFile(...args),
  writeFile: (...args) => fsp.writeFile(...args),
  open: (...args) => fsp.open(...args),
  rename: (...args) => fsp.rename(...args),
  unlink: (...args) => fsp.unlink(...args),
  stat: (...args) => fsp.stat(...args),
  lstat: (...args) => fsp.lstat(...args),
  readdir: (...args) => fsp.readdir(...args),
  realpath: (...args) => fsp.realpath(...args),
  statfs: typeof fsp.statfs === 'function' ? (...args) => fsp.statfs(...args) : undefined,
};
Object.defineProperty(defaultIo, IO_MARK, { value: true });

/**
 * Merge a test-only fs adapter over the default fs/promises calls. Only the
 * methods actually present are replaced. HTTP must never expose this option;
 * production requests cannot turn failure hooks on.
 *
 * @param {object|undefined} overrides
 */
export function createIoAdapter(overrides) {
  if (!overrides) return defaultIo;
  if (overrides[IO_MARK]) return overrides;
  const adapter = { ...defaultIo, ...overrides };
  Object.defineProperty(adapter, IO_MARK, { value: true });
  return adapter;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

/**
 * @param {Buffer|Uint8Array|string} bytes
 * @returns {string} `sha256:<64 lowercase hex>`
 */
export function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeUtf8(bytes) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new StoreError('invalid_utf8', 'The state file is not valid UTF-8.', {
      status: 400,
      cause: error,
    });
  }
}

function parseStateText(text, label = 'state') {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StoreError('invalid_state', `${label}: cannot parse JSON: ${error.message}`, {
      status: 500,
      cause: error,
    });
  }
}

/**
 * Full gate: version-specific JSON Schema plus reference checks and intent
 * invariants. Returns readable errors; [] means this layer found no problem.
 *
 * @param {unknown} state
 * @returns {string[]}
 */
export function validateFullState(state) {
  const schemaErrors = validateStateSchema(state);
  if (schemaErrors.length) return schemaErrors;
  return validateStateReferences(state);
}

/**
 * Read a state file with a hard byte limit. The limit is checked before and
 * after reading; oversized input is rejected, never truncated.
 *
 * @param {string} statePath
 * @param {{io?: object, maxStateBytes?: number}} [options]
 * @returns {Promise<{bytes: Buffer, text: string, digest: string, size: number, stat: import('node:fs').Stats}>}
 */
export async function readStateFile(statePath, options = {}) {
  const io = createIoAdapter(options.io);
  const maxStateBytes = options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES;
  let stat;
  try {
    stat = await io.stat(statePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new StoreError('state_not_found', `State file not found: ${statePath}`, {
        status: 404,
        cause: error,
      });
    }
    throw new StoreError('state_unreadable', `Cannot stat state file: ${error.message}`, {
      status: 500,
      cause: error,
    });
  }
  if (!stat.isFile()) {
    throw new StoreError('state_not_file', `State path is not a regular file: ${statePath}`, {
      status: 400,
    });
  }
  if (stat.nlink > 1) {
    throw new StoreError(
      'hardlink_state',
      'The state file now has multiple hard links; the path lock can be bypassed, so writes are stopped.',
      { status: 400, details: { nlink: stat.nlink } },
    );
  }
  if (stat.size > maxStateBytes) {
    throw new StoreError(
      'state_too_large',
      `State file is ${stat.size} bytes, above the configured limit of ${maxStateBytes} bytes.`,
      { status: 413, details: { size: stat.size, maxStateBytes } },
    );
  }
  let bytes;
  try {
    const raw = await io.readFile(statePath);
    bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  } catch (error) {
    throw new StoreError('state_unreadable', `Cannot read state file: ${error.message}`, {
      status: 500,
      cause: error,
    });
  }
  if (bytes.byteLength > maxStateBytes) {
    throw new StoreError(
      'state_too_large',
      `State file grew to ${bytes.byteLength} bytes, above the configured limit of ${maxStateBytes} bytes.`,
      { status: 413, details: { size: bytes.byteLength, maxStateBytes } },
    );
  }
  return {
    bytes,
    text: decodeUtf8(bytes),
    digest: sha256Bytes(bytes),
    size: bytes.byteLength,
    stat,
  };
}

function isWindowsUncOrDevicePath(absPath) {
  // path.resolve() turns //server/share into \\server\share on Windows.
  return /^\\\\/.test(absPath);
}

function normaliseIdentityPath(absPath) {
  let value = path.resolve(absPath);
  if (process.platform === 'win32') {
    value = value.replaceAll('/', '\\');
    value = value.toLowerCase();
  }
  return value;
}

async function assertNotNetworkVolume(io, probePath) {
  if (process.platform === 'win32') {
    // UNC is rejected above. Mapped network drives are not reliably
    // distinguishable from local drives through Node's fs API.
    return;
  }
  if (typeof io.statfs !== 'function') return;
  try {
    const stats = await io.statfs(probePath);
    if (NETWORK_FS_MAGIC.has(Number(stats.type))) {
      throw new StoreError(
        'network_volume',
        'The state path is on a recognised network filesystem; local state only.',
        { status: 400, details: { statfsType: Number(stats.type) } },
      );
    }
  } catch (error) {
    if (error instanceof StoreError) throw error;
    // statfs may be unsupported; do not invent a network verdict.
  }
}

/**
 * Resolve a state path to its real target. Existing files use realpath; new
 * output uses the real parent directory plus the requested basename. Windows
 * lock identity folds case and separators. UNC/device paths and hard-linked
 * fact sources are rejected.
 *
 * @param {string} statePath
 * @param {{io?: object, mustExist?: boolean}} [options]
 */
export async function canonicalizeStatePath(statePath, options = {}) {
  if (typeof statePath !== 'string' || statePath.trim() === '') {
    throw new StoreError('invalid_path', 'A non-empty state path is required.', { status: 400 });
  }
  const io = createIoAdapter(options.io);
  const absolute = path.resolve(statePath);
  if (path.basename(absolute) === '' || path.basename(absolute) === '.' || path.basename(absolute) === '..') {
    throw new StoreError('invalid_path', `State path has no file name: ${statePath}`, { status: 400 });
  }
  if (process.platform === 'win32' && isWindowsUncOrDevicePath(absolute)) {
    throw new StoreError(
      'unc_path',
      'UNC/device paths are not supported for local state files.',
      { status: 400 },
    );
  }

  let canonical = null;
  let stat = null;
  try {
    canonical = await io.realpath(absolute);
    stat = await io.stat(canonical);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new StoreError('state_unreadable', `Cannot resolve state path: ${error.message}`, {
        status: 500,
        cause: error,
      });
    }
    if (options.mustExist) {
      throw new StoreError('state_not_found', `State file not found: ${statePath}`, {
        status: 404,
        cause: error,
      });
    }
    const parent = path.dirname(absolute);
    let parentReal;
    let parentStat;
    try {
      parentReal = await io.realpath(parent);
      parentStat = await io.stat(parentReal);
    } catch (parentError) {
      throw new StoreError(
        'state_parent_missing',
        `State parent directory is not accessible: ${parentError.message}`,
        { status: 400, cause: parentError },
      );
    }
    if (!parentStat.isDirectory()) {
      throw new StoreError('state_parent_missing', 'State parent path is not a directory.', {
        status: 400,
      });
    }
    canonical = path.join(parentReal, path.basename(absolute));
    await assertNotNetworkVolume(io, parentReal);
  }

  if (stat) {
    if (!stat.isFile()) {
      throw new StoreError('state_not_file', `State path is not a regular file: ${statePath}`, {
        status: 400,
      });
    }
    if (stat.nlink > 1) {
      throw new StoreError(
        'hardlink_state',
        'The state file has multiple hard links; refusing a path lock that can be bypassed.',
        { status: 400, details: { nlink: stat.nlink } },
      );
    }
    await assertNotNetworkVolume(io, canonical);
  }

  return {
    path: canonical,
    identity: normaliseIdentityPath(canonical),
    lockPath: `${canonical}${LOCK_SUFFIX}`,
    exists: Boolean(stat),
    stat,
  };
}

async function readLockRecord(io, lockPath) {
  try {
    const text = await io.readFile(lockPath, 'utf8');
    const record = JSON.parse(text);
    return isRecord(record) ? record : null;
  } catch {
    return null;
  }
}

function publicLockOwner(record) {
  if (!record) return null;
  return {
    pid: record.pid ?? null,
    host: record.host ?? null,
    startedAt: record.startedAt ?? null,
    statePath: record.statePath ?? null,
  };
}

async function verifyStateLock(handle, io) {
  const record = await readLockRecord(io, handle.lockPath);
  return Boolean(record && typeof record.token === 'string' && record.token === handle.token);
}

/**
 * Verify every lock is still owned by this process. Used before replacements
 * and by the migration CLI for both source and target locks.
 *
 * @param {Array<object>} handles
 * @param {{io?: object}} [options]
 */
export async function assertStateLocks(handles, options = {}) {
  const io = createIoAdapter(options.io);
  for (const handle of handles) {
    if (!(await verifyStateLock(handle, io))) {
      throw new StoreError(
        'lock_lost',
        `State lock ownership was lost: ${handle.lockPath}`,
        { status: 503, details: { lockPath: handle.lockPath } },
      );
    }
  }
}

async function releaseOneLock(handle, io) {
  if (!(await verifyStateLock(handle, io))) return false;
  // Re-check immediately before unlinking so a lock replaced by another owner
  // is not deleted by this process.
  if (!(await verifyStateLock(handle, io))) return false;
  try {
    await io.unlink(handle.lockPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return false;
  }
}

/**
 * Release only locks still owned by this process. Returns one boolean per
 * handle in the order given. Never removes another owner's lock.
 *
 * @param {Array<object>} handles
 * @param {{io?: object}} [options]
 * @returns {Promise<boolean[]>}
 */
export async function releaseStateLocks(handles, options = {}) {
  const io = createIoAdapter(options.io);
  const released = [];
  for (const handle of [...handles].reverse()) {
    released.unshift(await releaseOneLock(handle, io));
  }
  return released;
}

/**
 * Acquire one `wx` lock per canonical state path. Paths are deduplicated and
 * sorted by normalised identity; if any acquisition fails, every lock already
 * taken by this call is released.
 *
 * @param {Array<string|{path: string}>} canonicalPaths
 * @param {{io?: object, port?: number}} [options]
 * @returns {Promise<Array<{lockPath: string, statePath: string, token: string}>>}
 */
export async function acquireStateLocks(canonicalPaths, options = {}) {
  const io = createIoAdapter(options.io);
  const unique = new Map();
  for (const entry of canonicalPaths) {
    const statePath = typeof entry === 'string' ? entry : entry?.path;
    if (typeof statePath !== 'string' || statePath === '') {
      throw new StoreError('invalid_path', 'Lock acquisition requires canonical state paths.', {
        status: 400,
      });
    }
    const identity = normaliseIdentityPath(statePath);
    if (!unique.has(identity)) unique.set(identity, statePath);
  }
  const ordered = [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, statePath]) => statePath);

  const handles = [];
  try {
    for (const statePath of ordered) {
      const lockPath = `${statePath}${LOCK_SUFFIX}`;
      const token = randomHex(32);
      const record = {
        version: 1,
        token,
        pid: process.pid,
        host: hostname(),
        statePath,
        startedAt: new Date().toISOString(),
      };
      if (Number.isInteger(options.port)) record.port = options.port;
      try {
        await io.writeFile(lockPath, `${JSON.stringify(record)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if (error.code === 'EEXIST') {
          const existing = await readLockRecord(io, lockPath);
          throw new StoreError(
            'lock_held',
            `State lock already exists${existing ? ` (pid ${existing.pid ?? 'unknown'} on ${existing.host ?? 'unknown'})` : ''}; inspect it and stop the other process rather than forcing.`,
            {
              status: 503,
              details: { lockPath, owner: publicLockOwner(existing) },
            },
          );
        }
        // A non-EEXIST failure can happen after a partial write. Remove only
        // the lock whose recorded token is the one this attempt generated.
        const partial = await readLockRecord(io, lockPath);
        if (partial && partial.token === token) {
          try {
            await io.unlink(lockPath);
          } catch {
            // Leave it for explicit inspection rather than deleting blindly.
          }
        }
        throw new StoreError('lock_failed', `Cannot create state lock: ${error.message}`, {
          status: 500,
          cause: error,
          details: { lockPath },
        });
      }
      handles.push({ lockPath, statePath, token });
    }
    return handles;
  } catch (error) {
    await releaseStateLocks(handles, { io });
    throw error;
  }
}

function lastAckFromLoaded(loaded) {
  return {
    digest: loaded.digest,
    size: loaded.size,
    mtimeMs: loaded.stat.mtimeMs,
    ino: loaded.stat.ino,
    dev: loaded.stat.dev,
  };
}

function sameFileIdentity(stat, lastAck) {
  if (!stat || !lastAck) return true;
  if (Number.isFinite(stat.size) && Number.isFinite(lastAck.size) && stat.size !== lastAck.size) {
    return false;
  }
  if (stat.ino && lastAck.ino && stat.ino !== lastAck.ino) return false;
  if (stat.dev !== undefined && lastAck.dev !== undefined && stat.dev !== lastAck.dev) return false;
  return true;
}

function targetMatchesOldSnapshot(reread, oldDigest, oldSize, oldStat) {
  if (reread.digest !== oldDigest) return false;
  if (reread.size !== oldSize) return false;
  if (oldStat) {
    if (Number.isFinite(oldStat.mtimeMs) && reread.stat.mtimeMs !== oldStat.mtimeMs) return false;
    if (oldStat.ino && reread.stat.ino && oldStat.ino !== reread.stat.ino) return false;
    if (
      oldStat.dev !== undefined &&
      reread.stat.dev !== undefined &&
      oldStat.dev !== reread.stat.dev
    ) {
      return false;
    }
  }
  return true;
}

function serialiseState(state) {
  try {
    return Buffer.from(`${canonicalStringify(state)}\n`, 'utf8');
  } catch (error) {
    throw new StoreError('state_validation_failed', `Cannot serialise the next state: ${error.message}`, {
      status: 500,
      cause: error,
    });
  }
}

async function pathExists(io, targetPath) {
  try {
    await io.stat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeAndSyncNewFile(io, filePath, bytes) {
  let handle;
  try {
    handle = await io.open(filePath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Closing failure is reported by the caller's next readback/rename.
      }
    }
  }
}

async function markPendingAsFailed(io, pendingPath) {
  if (typeof pendingPath !== 'string' || !pendingPath.endsWith('.pending')) return pendingPath;
  const failedPath = pendingPath.replace(/\.pending$/, '.failed');
  try {
    await io.rename(pendingPath, failedPath);
    return failedPath;
  } catch {
    return pendingPath;
  }
}

async function syncDirectoryBestEffort(io, directory) {
  if (process.platform === 'win32') return 'unsupported_on_windows';
  let handle;
  try {
    handle = await io.open(directory, 'r');
    await handle.sync();
    return 'synced';
  } catch {
    return 'failed';
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Directory sync is best effort and explicitly not a power-loss claim.
      }
    }
  }
}

const VIEW_MARKER_PATTERN =
  /^<!-- product-continuity-view owner=(sha256:[0-9a-f]{64}) stateVersion=(\d+) fileDigest=(sha256:[0-9a-f]{64}) -->/;

function viewOwnerId(statePath) {
  return sha256Bytes(Buffer.from(normaliseIdentityPath(statePath), 'utf8'));
}

function viewMarkerLine(owner, stateVersion, fileDigest) {
  return `<!-- product-continuity-view owner=${owner} stateVersion=${stateVersion} fileDigest=${fileDigest} -->\n`;
}

function parseViewMarker(text) {
  const match = VIEW_MARKER_PATTERN.exec(text);
  if (!match) return null;
  return {
    owner: match[1],
    stateVersion: Number(match[2]),
    fileDigest: match[3],
  };
}

function buildViewBytes(content, owner, stateVersion, fileDigest) {
  const body = clampViewContent(content);
  if (body.byteLength === 0) {
    const error = new Error('renderer produced empty view output');
    error.code = 'render_no_output';
    throw error;
  }
  return Buffer.concat([
    Buffer.from(viewMarkerLine(owner, stateVersion, fileDigest), 'utf8'),
    body,
  ]);
}

function viewFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Inspect the fixed derived-view target without following a symlink or
 * treating an unowned file as replaceable. A missing target is safe; an
 * existing target is safe only when its leading marker names the same stable
 * state identity.
 */
async function inspectViewTarget(viewPath, io, statePath, maxStateBytes) {
  const absolute = path.resolve(viewPath);
  let info = null;
  try {
    info = await io.lstat(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { ok: false, reason: 'view_unreadable', path: absolute, exists: false };
    }
  }
  if (info) {
    if (info.isSymbolicLink()) {
      return { ok: false, reason: 'view_symlink', path: absolute, exists: true };
    }
    if (!info.isFile()) {
      return { ok: false, reason: 'view_not_file', path: absolute, exists: true };
    }
    if (info.nlink > 1) {
      return { ok: false, reason: 'view_hardlink', path: absolute, exists: true };
    }
    if (info.size > maxStateBytes) {
      return { ok: false, reason: 'view_too_large', path: absolute, exists: true };
    }
  }

  let canonical;
  try {
    if (info) {
      canonical = await io.realpath(absolute);
    } else {
      const parent = await io.realpath(path.dirname(absolute));
      canonical = path.join(parent, path.basename(absolute));
    }
  } catch {
    return { ok: false, reason: 'view_unreadable', path: absolute, exists: Boolean(info) };
  }
  if (normaliseIdentityPath(canonical) === normaliseIdentityPath(statePath)) {
    return { ok: false, reason: 'view_is_state', path: canonical, exists: Boolean(info) };
  }
  if (!info) return { ok: true, path: canonical, exists: false, owner: null };

  let text;
  try {
    const raw = await io.readFile(canonical);
    text = decodeUtf8(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  } catch {
    return { ok: false, reason: 'view_unreadable', path: canonical, exists: true };
  }
  const marker = parseViewMarker(text);
  if (!marker) {
    return { ok: false, reason: 'view_not_owned', path: canonical, exists: true };
  }
  return { ok: true, path: canonical, exists: true, owner: marker.owner };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Report (but never delete or read as state) leftover transaction files that
 * exactly match this state's own transaction naming. Only names are inspected.
 *
 * @param {string} statePath
 * @param {{io?: object}} [options]
 */
export async function scanStateArtifacts(statePath, options = {}) {
  const io = createIoAdapter(options.io);
  const absolute = path.resolve(statePath);
  const directory = path.dirname(absolute);
  const base = escapeRegExp(path.basename(absolute));
  const stateTemporary = new RegExp(`^${base}\\.\\d+\\.[0-9a-f]{12}\\.(pending|failed)$`);
  const backupTemporary = new RegExp(`^${base}\\.bak\\..*\\.(pending|failed)$`);
  let names;
  try {
    names = await io.readdir(directory);
  } catch {
    return {
      scanned: false,
      pending: [],
      failed: [],
      warnings: ['Leftover transaction artifact scan was unavailable.'],
    };
  }
  const pending = [];
  const failed = [];
  for (const name of names) {
    if (typeof name !== 'string') continue;
    if (!stateTemporary.test(name) && !backupTemporary.test(name)) continue;
    if (name.endsWith('.pending')) pending.push(name);
    else failed.push(name);
  }
  pending.sort();
  failed.sort();
  return {
    scanned: true,
    pending,
    failed,
    warnings: [
      ...pending.map((name) => `Leftover pending transaction file is present and ignored as state: ${name}`),
      ...failed.map((name) => `Leftover failed transaction file is present and ignored as state: ${name}`),
    ],
  };
}

async function acquireOptionalLocks(entries, options = {}) {
  const io = createIoAdapter(options.io);
  const unique = new Map();
  for (const entry of entries) {
    const identity = normaliseIdentityPath(entry.path);
    const previous = unique.get(identity);
    if (!previous || entry.required) unique.set(identity, entry);
  }
  const ordered = [...unique.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const acquired = [];
  const optionalFailures = [];
  for (const [, entry] of ordered) {
    try {
      const [handle] = await acquireStateLocks([entry.path], { io, port: options.port });
      acquired.push({ role: entry.role, handle });
    } catch (error) {
      if (
        !entry.required &&
        error instanceof StoreError &&
        (error.code === 'lock_held' || error.code === 'lock_failed')
      ) {
        optionalFailures.push({ role: entry.role, error });
        continue;
      }
      await releaseStateLocks(acquired.map((item) => item.handle), { io });
      throw error;
    }
  }
  return { acquired, optionalFailures };
}

/**
 * Replace a state file through the staged commit path shared by service
 * submissions and in-place migration. The caller must already own the state
 * lock and must have validated the in-memory next state. This function:
 *
 *   temp wx -> write -> sync -> close -> readback/full validate
 *   -> versioned backup of the old raw bytes -> re-check lock/target
 *   -> same-directory rename with bounded retry -> post-read verification.
 *
 * It never deletes the old fact source, never rolls back automatically and
 * never deletes a backup. On failure the diagnostics name temporary/backup
 * files with `.pending`/`.failed` names.
 *
 * @param {object} input
 * @returns {Promise<object>}
 */
export async function commitStateBytes(input) {
  const {
    statePath,
    oldBytes,
    oldDigest,
    oldStat,
    oldVersion,
    nextBytes,
    nextDigest,
    lockCheck,
    hooks,
    maxStateBytes = DEFAULT_MAX_STATE_BYTES,
    verifyCommitted,
  } = input;
  const io = createIoAdapter(input.io);
  if (sha256Bytes(nextBytes) !== nextDigest) {
    throw new StoreError('prepare_failed', 'nextDigest does not match nextBytes.', {
      status: 500,
    });
  }
  if (oldBytes && sha256Bytes(oldBytes) !== oldDigest) {
    throw new StoreError('prepare_failed', 'oldDigest does not match oldBytes.', {
      status: 500,
    });
  }
  const directory = path.dirname(statePath);
  const random = randomHex(6);
  const temporaryPath = `${statePath}.${process.pid}.${random}.pending`;
  let temporaryAlive = false;
  let backupPath = null;
  let backupPendingPath = null;
  let renameAttempts = 0;
  let lastRenameError = null;

  const runHook = async (name, context) => {
    if (hooks && typeof hooks[name] === 'function') await hooks[name](context);
  };
  const checkLock = async () => {
    if (typeof lockCheck === 'function') await lockCheck();
  };
  const assertTargetUnchanged = async (stage) => {
    let reread;
    try {
      reread = await readStateFile(statePath, { io, maxStateBytes });
    } catch (error) {
      if (error instanceof StoreError && error.code === 'hardlink_state') {
        throw new StoreError(
          'hardlink_state',
          `The state file gained a hard link ${stage}; writes are stopped.`,
          {
            status: 400,
            cause: error,
            details: { temporaryPath, backupPath },
          },
        );
      }
      throw new StoreError(
        'external_modification',
        `Cannot re-read the state ${stage}: ${error.message}`,
        {
          status: 503,
          cause: error,
          details: { temporaryPath, backupPath },
        },
      );
    }
    if (!targetMatchesOldSnapshot(reread, oldDigest, oldBytes.byteLength, oldStat)) {
      throw new StoreError(
        'external_modification',
        `The state file changed outside this store ${stage}; writes are stopped.`,
        {
          status: 503,
          details: {
            expectedDigest: oldDigest,
            actualDigest: reread.digest,
            temporaryPath,
            backupPath,
          },
        },
      );
    }
  };

  // 1. Write and verify the next state in a same-directory temporary file.
  try {
    await runHook('beforeTemporaryWrite', { statePath, temporaryPath });
    await writeAndSyncNewFile(io, temporaryPath, nextBytes);
    temporaryAlive = true;
    await runHook('beforeTemporaryReadback', { statePath, temporaryPath });
    const temporaryRead = await readStateFile(temporaryPath, { io, maxStateBytes });
    if (temporaryRead.digest !== nextDigest) {
      throw new StoreError('prepare_failed', 'Temporary state readback digest does not match.', {
        status: 500,
        details: {
          expectedDigest: nextDigest,
          actualDigest: temporaryRead.digest,
          temporaryPath,
        },
      });
    }
    const temporaryState = parseStateText(temporaryRead.text, 'temporary state');
    const temporaryErrors = validateFullState(temporaryState);
    if (temporaryErrors.length) {
      throw new StoreError('prepare_failed', 'Temporary state failed full validation.', {
        status: 500,
        details: { temporaryPath, errors: temporaryErrors },
      });
    }
  } catch (error) {
    const failedPath = temporaryAlive ? await markPendingAsFailed(io, temporaryPath) : temporaryPath;
    if (error instanceof StoreError) {
      error.details = { ...error.details, temporaryPath: failedPath };
      throw error;
    }
    throw new StoreError('prepare_failed', `Cannot prepare the next state: ${error.message}`, {
      status: 500,
      cause: error,
      details: { temporaryPath: failedPath },
    });
  }

  // 2. Back up the old raw bytes under a versioned, non-overwriting name.
  backupPath = `${statePath}.bak.${oldVersion}.${oldDigest.slice(7, 15)}.${randomHex(4)}`;
  backupPendingPath = `${backupPath}.${randomHex(3)}.pending`;
  try {
    await checkLock();
    await runHook('beforeBackupWrite', { statePath, backupPath, backupPendingPath });
    if (await pathExists(io, backupPath)) {
      throw new StoreError('backup_failed', 'Versioned backup path already exists; refusing to overwrite it.', {
        status: 500,
        details: { backupPath },
      });
    }
    await writeAndSyncNewFile(io, backupPendingPath, oldBytes);
    const backupRead = await readStateFile(backupPendingPath, { io, maxStateBytes });
    if (backupRead.digest !== oldDigest) {
      throw new StoreError('backup_failed', 'Backup readback digest does not match the old state.', {
        status: 500,
        details: { backupPath, backupPendingPath },
      });
    }
    await runHook('beforeBackupRename', { statePath, backupPath, backupPendingPath });
    if (await pathExists(io, backupPath)) {
      throw new StoreError('backup_failed', 'Versioned backup path appeared during preparation.', {
        status: 500,
        details: { backupPath },
      });
    }
    await io.rename(backupPendingPath, backupPath);
    backupPendingPath = null;
  } catch (error) {
    const failedBackup = backupPendingPath
      ? await markPendingAsFailed(io, backupPendingPath)
      : backupPendingPath;
    const failedTemporary = await markPendingAsFailed(io, temporaryPath);
    if (
      error instanceof StoreError &&
      (error.code === 'backup_failed' || error.code === 'lock_lost')
    ) {
      error.details = {
        ...error.details,
        temporaryPath: failedTemporary,
        backupPendingPath: failedBackup,
      };
      throw error;
    }
    throw new StoreError('backup_failed', `Cannot create the versioned backup: ${error.message}`, {
      status: 500,
      cause: error,
      details: { temporaryPath: failedTemporary, backupPath, backupPendingPath: failedBackup },
    });
  }

  // 3. Immediately before replacement, re-check the lock and the target bytes.
  await checkLock();
  try {
    await runHook('beforeReread', { statePath, temporaryPath, backupPath });
  } catch (hookError) {
    throw new StoreError('prepare_failed', `beforeReread hook failed: ${hookError.message}`, {
      status: 500,
      cause: hookError,
      details: { temporaryPath, backupPath },
    });
  }
  await assertTargetUnchanged('after the action started');

  // 4. Same-directory rename with bounded Windows retry. Each retry re-checks
  // the lock and the old bytes; the target is never moved or deleted first.
  let renamed = false;
  for (let attempt = 1; attempt <= MAX_RENAME_ATTEMPTS; attempt += 1) {
    renameAttempts = attempt;
    try {
      await runHook('beforeRename', { statePath, temporaryPath, attempt });
    } catch (hookError) {
      throw new StoreError('prepare_failed', `beforeRename hook failed: ${hookError.message}`, {
        status: 500,
        cause: hookError,
        details: { temporaryPath, backupPath },
      });
    }
    // Re-check ownership and the exact target bytes immediately before every
    // replacement attempt, including the first one after the reread checks.
    await checkLock();
    await assertTargetUnchanged(`immediately before rename attempt ${attempt}`);
    try {
      await io.rename(temporaryPath, statePath);
      renamed = true;
      temporaryAlive = false;
      break;
    } catch (error) {
      lastRenameError = error;
      if (!RENAME_RETRY_CODES.has(error.code) || attempt === MAX_RENAME_ATTEMPTS) break;
      await delay(RENAME_RETRY_DELAYS_MS[attempt - 1] ?? 160);
      try {
        await checkLock();
        await assertTargetUnchanged(`while retrying rename attempt ${attempt + 1}`);
      } catch (retryError) {
        if (
          retryError instanceof StoreError &&
          (retryError.code === 'lock_lost' || retryError.code === 'external_modification')
        ) {
          throw retryError;
        }
        // An unreadable target during a retry is classified after the loop by
        // the final probe instead of being reported as a lock/path failure.
        break;
      }
    }
  }

  const verifyTarget = async () => {
    let read;
    try {
      read = await readStateFile(statePath, { io, maxStateBytes });
    } catch (error) {
      return { ok: false, reason: `target unreadable: ${error.message}` };
    }
    if (read.digest !== nextDigest) {
      return { ok: false, reason: 'target digest does not match the next state', digest: read.digest };
    }
    let state;
    try {
      state = parseStateText(read.text, 'committed state');
    } catch (error) {
      return { ok: false, reason: `committed state is not JSON: ${error.message}` };
    }
    const errors = validateFullState(state);
    if (errors.length) return { ok: false, reason: 'committed state failed validation', errors };
    if (typeof verifyCommitted === 'function') {
      let extra;
      try {
        extra = await verifyCommitted(state, read);
      } catch (error) {
        return { ok: false, reason: `commit verification failed: ${error.message}` };
      }
      if (extra === false) return { ok: false, reason: 'commit verification returned false' };
      if (Array.isArray(extra) && extra.length) {
        return { ok: false, reason: 'commit verification found mismatches', errors: extra };
      }
    }
    return { ok: true, state, read };
  };

  if (!renamed) {
    const probe = await verifyTarget();
    if (probe.ok) {
      return {
        ok: true,
        commitStatus: 'verified',
        outcome: 'verified',
        backupPath,
        temporaryPath: null,
        directorySync: await syncDirectoryBestEffort(io, directory),
        renameAttempts,
        recoveredFromRenameError: true,
        state: probe.state,
        digest: nextDigest,
        stat: probe.read.stat,
      };
    }
    let probeDigest = null;
    try {
      probeDigest = (await readStateFile(statePath, { io, maxStateBytes })).digest;
    } catch {
      probeDigest = null;
    }
    if (probeDigest === nextDigest) {
      throw new StoreError(
        'write_unverified',
        `The replacement appears to have happened but the new state could not be verified: ${probe.reason}`,
        {
          status: 500,
          commitStatus: 'replaced_unverified',
          details: {
            backupPath,
            temporaryPath,
            targetDigest: probeDigest,
            errors: probe.errors ?? [],
            renameCode: lastRenameError?.code ?? null,
          },
        },
      );
    }
    if (probeDigest === oldDigest) {
      throw new StoreError(
        'replace_failed_preserved',
        'The replacement failed and the old state is still at the target path.',
        {
          status: 500,
          details: {
            backupPath,
            temporaryPath,
            renameCode: lastRenameError?.code ?? null,
            renameMessage: lastRenameError?.message ?? null,
          },
        },
      );
    }
    throw new StoreError(
      'commit_unknown',
      'The replacement result cannot be determined; stop and inspect the file, backup and temporary output.',
      {
        status: 503,
        commitStatus: 'unknown',
        details: {
          backupPath,
          temporaryPath,
          targetDigest: probeDigest,
          renameCode: lastRenameError?.code ?? null,
          renameMessage: lastRenameError?.message ?? null,
        },
      },
    );
  }

  // 5. Post-read verification of the new fact source. An afterRename hook
  // failure is recorded but does not hide a newly written, verifiable state.
  let afterRenameHookError = null;
  try {
    await runHook('afterRename', { statePath, backupPath, renameAttempts });
  } catch (hookError) {
    afterRenameHookError = hookError.message;
  }
  const verified = await verifyTarget();
  if (!verified.ok) {
    throw new StoreError(
      'write_unverified',
      `The state was replaced but could not be verified: ${verified.reason}`,
      {
        status: 500,
        commitStatus: 'replaced_unverified',
        details: {
          backupPath,
          temporaryPath: null,
          targetDigest: verified.digest ?? null,
          errors: verified.errors ?? [],
        },
      },
    );
  }

  return {
    ok: true,
    commitStatus: 'verified',
    outcome: 'verified',
    backupPath,
    temporaryPath: null,
    directorySync: await syncDirectoryBestEffort(io, directory),
    renameAttempts,
    recoveredFromRenameError: false,
    ...(afterRenameHookError ? { afterRenameHookError } : {}),
    state: verified.state,
    digest: nextDigest,
    stat: verified.read.stat,
  };
}

function clampViewContent(content) {
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (content instanceof ArrayBuffer) return Buffer.from(new Uint8Array(content));
  throw new TypeError('renderViews must return a string, Buffer, Uint8Array or ArrayBuffer');
}

/**
 * Open the single project state for the review service.
 *
 * The returned store keeps a cooperative lock until close(). It exposes no
 * ownership token. Writes are only accepted for a fully validated 0.2 state;
 * 0.1 opens read-only and points at the explicit migration step.
 *
 * @param {string} statePath
 * @param {{
 *   actor?: string,
 *   clock?: Function|Date|string,
 *   idFactory?: Function,
 *   domain?: object,
 *   fs?: object,
 *   hooks?: object,
 *   maxStateBytes?: number,
 *   maxQueue?: number,
 *   renderViews?: Function,
 *   decisionRecordPath?: string,
 *   port?: number
 * }} [options]
 */
export async function openStateStore(statePath, options = {}) {
  // Compile AJV and load schemas before any lock is created. Missing
  // dependencies must fail without leaving a lock behind.
  try {
    getCompiledValidators();
  } catch (error) {
    throw new StoreError(
      'dependency_unavailable',
      `Schema validation dependencies are unavailable; run npm ci in the extracted Skill directory. ${error.message}`,
      { status: 500, cause: error },
    );
  }
  if (!options.domain) {
    try {
      await import('./review-actions.mjs');
    } catch (error) {
      throw new StoreError('domain_unavailable', `Review actions are unavailable: ${error.message}`, {
        status: 500,
        cause: error,
      });
    }
  }

  const io = createIoAdapter(options.fs);
  const maxStateBytes = options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES;
  const canonical = await canonicalizeStatePath(statePath, { io, mustExist: true });
  const decisionRecordPath = options.decisionRecordPath;
  if (
    decisionRecordPath !== undefined &&
    (typeof decisionRecordPath !== 'string' || decisionRecordPath.trim() === '')
  ) {
    throw new StoreError(
      'invalid_request',
      'decisionRecordPath must be a non-empty trusted string when provided.',
      { status: 400 },
    );
  }

  const defaultViewPath = path.join(path.dirname(canonical.path), DEFAULT_VIEW_BASENAME);
  const viewOwner = viewOwnerId(canonical.path);
  const hasRenderer = typeof options.renderViews === 'function';
  let viewTarget = null;
  let viewUnavailableReason = hasRenderer ? 'view_not_checked' : 'no_renderer';
  if (hasRenderer) {
    viewTarget = await inspectViewTarget(defaultViewPath, io, canonical.path, maxStateBytes);
    if (!viewTarget.ok) {
      viewUnavailableReason = viewTarget.reason;
    } else if (viewTarget.exists && viewTarget.owner !== viewOwner) {
      viewUnavailableReason = 'view_owner_mismatch';
    }
  }

  const lockEntries = [{ path: canonical.path, required: true, role: 'state' }];
  if (
    hasRenderer &&
    viewTarget &&
    viewTarget.ok &&
    (!viewTarget.exists || viewTarget.owner === viewOwner)
  ) {
    lockEntries.push({ path: viewTarget.path, required: false, role: 'view' });
  }
  const lockResult = await acquireOptionalLocks(lockEntries, { io, port: options.port });
  const stateLock = lockResult.acquired.find((item) => item.role === 'state')?.handle;
  let viewLock = lockResult.acquired.find((item) => item.role === 'view')?.handle ?? null;
  if (!stateLock) {
    await releaseStateLocks(lockResult.acquired.map((item) => item.handle), { io });
    throw new StoreError('lock_failed', 'The state lock could not be acquired.', { status: 500 });
  }
  const viewLockFailure = lockResult.optionalFailures.find((item) => item.role === 'view');
  if (hasRenderer && !viewLock && viewLockFailure) {
    viewUnavailableReason =
      viewLockFailure.error.code === 'lock_held' ? 'view_locked' : 'view_lock_failed';
  }

  let loaded;
  let state;
  try {
    loaded = await readStateFile(canonical.path, { io, maxStateBytes });
    state = parseStateText(loaded.text);
    const errors = validateFullState(state);
    if (errors.length) {
      throw new StoreError('invalid_state', 'The state file failed full validation.', {
        status: 500,
        details: { errors },
      });
    }
    if (state.schemaVersion !== '0.2' && viewLock) {
      await releaseStateLocks([viewLock], { io });
      viewLock = null;
      viewUnavailableReason = 'read_only_state';
    }
    if (viewLock) {
      const current = await inspectViewTarget(viewTarget.path, io, canonical.path, maxStateBytes);
      const sameTarget =
        current.ok &&
        normaliseIdentityPath(current.path) === normaliseIdentityPath(viewTarget.path);
      if (!sameTarget || (current.exists && current.owner !== viewOwner)) {
        await releaseStateLocks([viewLock], { io });
        viewLock = null;
        viewUnavailableReason = current.ok ? 'view_target_changed' : current.reason;
      } else {
        viewTarget = current;
      }
    }
  } catch (error) {
    await releaseStateLocks(
      [stateLock, ...(viewLock ? [viewLock] : [])],
      { io },
    );
    throw error;
  }

  let artifacts;
  try {
    artifacts = await scanStateArtifacts(canonical.path, { io });
  } catch (error) {
    artifacts = {
      scanned: false,
      pending: [],
      failed: [],
      warnings: [`Leftover transaction artifact scan was unavailable: ${error.message}`],
    };
  }
  return createStore({
    statePath: canonical.path,
    stateLock,
    viewLock,
    viewPath: viewTarget?.ok ? viewTarget.path : defaultViewPath,
    viewOwner,
    viewUnavailableReason,
    artifacts,
    io,
    options,
    maxStateBytes,
    initial: { state, loaded },
  });
}

function createStore({
  statePath,
  stateLock,
  viewLock: initialViewLock,
  viewPath,
  viewOwner,
  viewUnavailableReason,
  artifacts,
  io,
  options,
  maxStateBytes,
  initial,
}) {
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  const hasRenderer = typeof options.renderViews === 'function';
  const decisionRecordPath = options.decisionRecordPath;

  let viewLock = initialViewLock;
  let cachedState = initial.state;
  let currentDigest = initial.loaded.digest;
  let lastAck = lastAckFromLoaded(initial.loaded);
  let writable = initial.state.schemaVersion === '0.2';
  let readOnlyReason = writable ? null : 'schema_0_1_requires_migration';
  let viewStatus = {
    status: 'not_rendered',
    path: viewPath,
    reason: hasRenderer
      ? (viewLock ? 'not_generated' : (viewUnavailableReason ?? 'view_unavailable'))
      : 'no_renderer',
  };
  let closed = false;
  let queueTail = Promise.resolve();
  let active = 0;
  let domainPromise = null;

  const snapshot = () => ({
    statePath,
    path: statePath,
    state: clone(cachedState),
    schemaVersion: cachedState.schemaVersion,
    stateVersion: cachedState.stateVersion,
    projectId: cachedState.project?.id ?? null,
    fileDigest: currentDigest,
    writable,
    readOnlyReason,
    viewStatus: clone(viewStatus),
    viewPath,
    startupWarnings: [...(artifacts?.warnings ?? [])],
    diagnostics: {
      artifactsScanned: artifacts?.scanned !== false,
      pendingArtifacts: [...(artifacts?.pending ?? [])],
      failedArtifacts: [...(artifacts?.failed ?? [])],
    },
    closed,
  });

  const markReadOnly = (reason) => {
    writable = false;
    if (!readOnlyReason) readOnlyReason = reason;
  };

  const readOnlyError = () => {
    const reasonCode = {
      schema_0_1_requires_migration: 'migration_required',
      external_modification: 'external_modification',
      lock_lost: 'lock_lost',
      write_unverified: 'write_unverified',
      commit_unknown: 'commit_unknown',
      state_validation_failed: 'state_validation_failed',
      invalid_state_on_disk: 'invalid_state',
      state_unverifiable: 'state_unverifiable',
      hardlink_state: 'hardlink_state',
    }[readOnlyReason] ?? 'read_only';
    const status =
      reasonCode === 'migration_required' ? 409 : reasonCode === 'invalid_state' ? 500 : 503;
    return new StoreError(
      reasonCode,
      `The state store is read-only: ${readOnlyReason ?? 'unknown reason'}`,
      { status, details: { readOnlyReason } },
    );
  };

  const ensureOpen = () => {
    if (closed) {
      throw new StoreError('store_closed', 'The state store is closed.', { status: 503 });
    }
  };
  const ensureWritable = () => {
    if (!writable) throw readOnlyError();
  };
  const ensureLock = async () => {
    if (!(await verifyStateLock(stateLock, io))) {
      markReadOnly('lock_lost');
      throw new StoreError('lock_lost', 'The state lock is no longer owned by this store; writes stopped.', {
        status: 503,
        details: { lockPath: stateLock.lockPath },
      });
    }
  };
  const ensureViewLock = async () => {
    if (!viewLock) {
      return { ok: false, reason: viewUnavailableReason ?? 'view_unavailable' };
    }
    if (!(await verifyStateLock(viewLock, io))) {
      viewLock = null;
      viewUnavailableReason = 'view_lock_lost';
      return { ok: false, reason: 'view_lock_lost' };
    }
    return { ok: true };
  };

  const enqueue = (task) => {
    if (closed) {
      return Promise.reject(new StoreError('store_closed', 'The state store is closed.', { status: 503 }));
    }
    if (active >= maxQueue) {
      return Promise.reject(
        new StoreError('queue_full', `The state store queue is full (${maxQueue}); no action was started.`, {
          status: 503,
        }),
      );
    }
    active += 1;
    const run = queueTail.then(() => task());
    queueTail = run.then(
      () => {},
      () => {},
    );
    return run.finally(() => {
      active -= 1;
    });
  };

  const loadDomain = async () => {
    if (options.domain) return options.domain;
    if (!domainPromise) {
      domainPromise = import('./review-actions.mjs')
        .then((module) => module)
        .catch((error) => {
          throw new StoreError(
            'domain_unavailable',
            `Review actions are unavailable: ${error.message}`,
            { status: 500, cause: error },
          );
        });
    }
    return domainPromise;
  };

  const loadDisk = async ({ forWrite }) => {
    let loaded;
    try {
      loaded = await readStateFile(statePath, { io, maxStateBytes });
    } catch (error) {
      if (error instanceof StoreError && error.code === 'hardlink_state') {
        markReadOnly('hardlink_state');
        throw error;
      }
      if (error instanceof StoreError && error.code === 'invalid_utf8') {
        markReadOnly('invalid_state_on_disk');
        throw error;
      }
      markReadOnly('state_unverifiable');
      if (error instanceof StoreError) throw error;
      throw new StoreError('state_unverifiable', `The state file cannot be verified: ${error.message}`, {
        status: 503,
        cause: error,
      });
    }

    let parsed;
    try {
      parsed = parseStateText(loaded.text);
    } catch (error) {
      markReadOnly('invalid_state_on_disk');
      throw error;
    }
    let errors;
    try {
      errors = validateFullState(parsed);
    } catch (error) {
      markReadOnly('invalid_state_on_disk');
      throw new StoreError('invalid_state', `The state validator failed: ${error.message}`, {
        status: 500,
        cause: error,
      });
    }
    const external =
      loaded.digest !== lastAck.digest || !sameFileIdentity(loaded.stat, lastAck);
    if (errors.length) {
      markReadOnly('invalid_state_on_disk');
      throw new StoreError('invalid_state', 'The state on disk failed full validation.', {
        status: 500,
        details: { errors, external },
      });
    }
    if (external && parsed.project?.id !== cachedState.project?.id) {
      markReadOnly('external_modification');
      throw new StoreError(
        'external_modification',
        'The state file now belongs to a different project id; this store is read-only.',
        {
          status: 503,
          details: {
            expectedProjectId: cachedState.project?.id ?? null,
            currentProjectId: parsed.project?.id ?? null,
          },
        },
      );
    }
    if (external) {
      if (forWrite) {
        markReadOnly('external_modification');
        throw new StoreError(
          'external_modification',
          'The state file changed outside this store; writes are stopped.',
          {
            status: 503,
            details: {
              expectedDigest: lastAck.digest,
              currentDigest: loaded.digest,
            },
          },
        );
      }
      cachedState = parsed;
      currentDigest = loaded.digest;
      markReadOnly('external_modification');
    }
    return { ...loaded, state: parsed, external };
  };

  const renderView = async (state, digest) => {
    const pending = (code, message) => ({
      status: 'pending',
      path: viewPath,
      stateVersion: state.stateVersion,
      fileDigest: digest,
      error: { code, message },
    });
    if (!hasRenderer) {
      viewStatus = {
        status: 'not_rendered',
        path: viewPath,
        reason: 'no_renderer',
        stateVersion: state.stateVersion,
        fileDigest: digest,
      };
      return viewStatus;
    }

    const lockState = await ensureViewLock();
    if (!lockState.ok) {
      viewStatus = pending(
        lockState.reason,
        'The derived view has no owned cooperative lock; refusing to write it.',
      );
      return viewStatus;
    }

    let viewDirectorySync = null;
    let wrote = false;

    const releaseUnavailableView = async (reason) => {
      if (viewLock) {
        await releaseStateLocks([viewLock], { io });
        viewLock = null;
      }
      viewUnavailableReason = reason;
    };

    const assertViewLockOwned = async (stage) => {
      if (!viewLock) {
        throw viewFailure('view_lock_lost', 'The derived view no longer has an owned lock.');
      }
      if (!(await verifyStateLock(viewLock, io))) {
        viewLock = null;
        viewUnavailableReason = 'view_lock_lost';
        throw viewFailure(
          'view_lock_lost',
          `The view lock token was replaced ${stage}; refusing to write the view and leaving the foreign lock untouched.`,
        );
      }
    };

    const verifyViewFile = async () => {
      let read;
      try {
        read = await readStateFile(viewPath, { io, maxStateBytes });
      } catch {
        throw viewFailure('view_unreadable', 'The generated view file cannot be read back.');
      }
      const marker = parseViewMarker(read.text);
      if (!marker) {
        throw viewFailure('view_not_owned', 'The generated view file has no ownership marker.');
      }
      if (marker.owner !== viewOwner) {
        throw viewFailure('view_owner_mismatch', 'The view file belongs to another state identity.');
      }
      if (marker.stateVersion !== state.stateVersion || marker.fileDigest !== digest) {
        throw viewFailure(
          'view_verification_failed',
          'The view file marker does not match this state version and digest.',
        );
      }
      return marker;
    };

    const writeView = async (content) => {
      await ensureLock();
      await assertViewLockOwned('at writeView entry');
      const current = await inspectViewTarget(viewPath, io, statePath, maxStateBytes);
      if (!current.ok) {
        await releaseUnavailableView(current.reason);
        throw viewFailure(current.reason, 'The view target is not a replaceable generated view.');
      }
      if (normaliseIdentityPath(current.path) !== normaliseIdentityPath(viewPath)) {
        await releaseUnavailableView('view_target_changed');
        throw viewFailure('view_target_changed', 'The view target canonical path changed.');
      }
      if (current.exists && current.owner !== viewOwner) {
        await releaseUnavailableView('view_owner_mismatch');
        throw viewFailure('view_owner_mismatch', 'The view file belongs to another state identity.');
      }
      const bytes = buildViewBytes(content, viewOwner, state.stateVersion, digest);
      const temporary = `${viewPath}.${process.pid}.${randomHex(4)}.pending`;
      try {
        await writeAndSyncNewFile(io, temporary, bytes);
        const read = await readStateFile(temporary, { io, maxStateBytes });
        if (read.digest !== sha256Bytes(bytes)) {
          throw viewFailure('view_readback_mismatch', 'View readback digest does not match.');
        }
        const marker = parseViewMarker(read.text);
        if (
          !marker ||
          marker.owner !== viewOwner ||
          marker.stateVersion !== state.stateVersion ||
          marker.fileDigest !== digest
        ) {
          throw viewFailure('view_marker_invalid', 'The staged view marker is not the expected one.');
        }
        const beforeRename = await inspectViewTarget(viewPath, io, statePath, maxStateBytes);
        if (
          !beforeRename.ok ||
          normaliseIdentityPath(beforeRename.path) !== normaliseIdentityPath(viewPath) ||
          (beforeRename.exists && beforeRename.owner !== viewOwner)
        ) {
          const reason = beforeRename.ok ? 'view_target_changed' : beforeRename.reason;
          await releaseUnavailableView(reason);
          throw viewFailure(
            reason,
            'The view target changed before replacement; refusing to overwrite it.',
          );
        }
        // The renderer runs asynchronously between staging and rename. Re-check
        // both cooperative locks immediately before the replacement; a replaced
        // view token must leave the foreign lock and any old view untouched.
        await ensureLock();
        await assertViewLockOwned('immediately before the view rename');
        await io.rename(temporary, viewPath);
      } catch (error) {
        await markPendingAsFailed(io, temporary);
        throw error;
      }
      viewDirectorySync = await syncDirectoryBestEffort(io, path.dirname(viewPath));
      await verifyViewFile();
      wrote = true;
    };

    try {
      const initial = await inspectViewTarget(viewPath, io, statePath, maxStateBytes);
      if (!initial.ok) {
        await releaseUnavailableView(initial.reason);
        throw viewFailure(initial.reason, 'The view target is not a replaceable generated view.');
      }
      if (normaliseIdentityPath(initial.path) !== normaliseIdentityPath(viewPath)) {
        await releaseUnavailableView('view_target_changed');
        throw viewFailure('view_target_changed', 'The view target canonical path changed.');
      }
      if (initial.exists && initial.owner !== viewOwner) {
        await releaseUnavailableView('view_owner_mismatch');
        throw viewFailure('view_owner_mismatch', 'The view file belongs to another state identity.');
      }

      const result = await options.renderViews({
        state: clone(state),
        snapshot: {
          statePath,
          stateVersion: state.stateVersion,
          fileDigest: digest,
        },
        statePath,
        viewPath,
        writeView: async (content) => {
          await writeView(content);
        },
      });
      let unwrapped = result;
      if (isRecord(result) && Object.hasOwn(result, 'content')) unwrapped = result.content;
      if (!wrote && unwrapped !== undefined && unwrapped !== null) {
        await writeView(unwrapped);
      }
      if (!wrote) {
        throw viewFailure(
          'render_no_output',
          'The renderer neither wrote through writeView nor returned content; an old view is not this render success.',
        );
      }
      await verifyViewFile();
      viewStatus = {
        status: 'rendered',
        path: viewPath,
        stateVersion: state.stateVersion,
        fileDigest: digest,
        directorySync: viewDirectorySync,
      };
    } catch (error) {
      viewStatus = pending(
        typeof error?.code === 'string' ? error.code : 'render_failed',
        error?.message ?? String(error),
      );
    }
    return viewStatus;
  };

  const normaliseDomainError = (error) => {
    if (error instanceof StoreError) {
      if (error.code === 'state_validation_failed') markReadOnly('state_validation_failed');
      return error;
    }
    if (error && typeof error === 'object' && typeof error.code === 'string' && 'commitStatus' in error) {
      if (error.code === 'state_validation_failed') markReadOnly('state_validation_failed');
      return error;
    }
    markReadOnly('state_validation_failed');
    return new StoreError(
      'state_validation_failed',
      `The action produced an unexpected failure: ${error?.message ?? String(error)}`,
      { status: 500, cause: error },
    );
  };

  const commandDigest = async (domain, request) => {
    if (typeof domain.commandDigest !== 'function') {
      throw new StoreError('domain_unavailable', 'The review domain has no commandDigest().', {
        status: 500,
      });
    }
    let digest;
    try {
      digest = await domain.commandDigest(request);
    } catch (error) {
      throw normaliseDomainError(error);
    }
    if (!isSha256Digest(digest)) {
      markReadOnly('state_validation_failed');
      throw new StoreError('state_validation_failed', 'commandDigest() did not return sha256:<64 hex>.', {
        status: 500,
      });
    }
    return digest;
  };

  const findReview = (state, projectId, idempotencyKey) => {
    for (const review of state.reviews ?? []) {
      const reviewProjectId = review.projectId ?? review.command?.projectId;
      if (reviewProjectId === projectId && review.idempotencyKey === idempotencyKey) {
        return review;
      }
    }
    return null;
  };

  const validateApplied = ({ before, after, review, request, requestDigest, fileDigest }) => {
    const errors = [];
    if (!isRecord(after)) return ['applyReview did not return a state object'];
    errors.push(...validateFullState(after));
    if (after.schemaVersion !== '0.2') errors.push('applyReview changed schemaVersion away from 0.2');
    if (after.project?.id !== before.project?.id) errors.push('applyReview changed the project id');
    if (canonicalStringify(after.mapUpdates ?? []) !== canonicalStringify(before.mapUpdates ?? [])) errors.push('applyReview changed non-review map maintenance/planning history');
    if (canonicalStringify(after.roadmapItems ?? []) !== canonicalStringify(before.roadmapItems ?? [])) errors.push('applyReview changed roadmap planning items; roadmap changes require an authorized offline plan');
    if (after.stateVersion !== before.stateVersion + 1) {
      errors.push(`applyReview must increment stateVersion once (${before.stateVersion} -> ${after.stateVersion})`);
    }
    if (!Array.isArray(after.reviews) || after.reviews.length !== before.reviews.length + 1) {
      errors.push('applyReview must append exactly one review');
    } else {
      const previous = canonicalStringify(before.reviews);
      const kept = canonicalStringify(after.reviews.slice(0, before.reviews.length));
      if (previous !== kept) errors.push('applyReview changed existing reviews instead of appending');
    }
    if (!isRecord(review) || typeof review.id !== 'string') {
      errors.push('applyReview did not return the appended review');
    } else {
      const stored = (after.reviews ?? []).find((item) => item.id === review.id);
      if (!stored) {
        errors.push('the returned review is not present in the next state');
      } else {
        if ((stored.projectId ?? stored.command?.projectId) !== request.projectId) {
          errors.push('stored review projectId does not match the request');
        }
        if (stored.idempotencyKey !== request.idempotencyKey) {
          errors.push('stored review idempotencyKey does not match the request');
        }
        if (stored.payloadDigest !== requestDigest) {
          errors.push('stored review payloadDigest does not match commandDigest(request)');
        }
        if (stored.observedDigest !== fileDigest) {
          errors.push('stored review observedDigest does not match the pre-action file digest');
        }
        if (stored.observedStateVersion !== before.stateVersion) {
          errors.push('stored review observedStateVersion does not match the pre-action version');
        }
        if (stored.resultingStateVersion !== after.stateVersion) {
          errors.push('stored review resultingStateVersion does not match the next version');
        }
        if (stored.command?.action !== request.action) {
          errors.push('stored review command.action does not match the request');
        }
        if (
          request.targetClaimId !== undefined &&
          stored.command?.targetClaimId !== request.targetClaimId
        ) {
          errors.push('stored review command.targetClaimId does not match the request');
        }
        if (
          request.targetProposalId !== undefined &&
          stored.command?.targetProposalId !== request.targetProposalId
        ) {
          errors.push('stored review command.targetProposalId does not match the request');
        }
        const created = new Set(stored.createdClaimIds ?? []);
        for (const id of stored.affectedClaimIds ?? []) {
          if (created.has(id)) errors.push(`review claim "${id}" is both created and affected`);
        }
      }
    }
    return errors;
  };

  const applyCommitFailure = (error) => {
    if (!(error instanceof StoreError)) return;
    if (error.code === 'write_unverified') markReadOnly('write_unverified');
    else if (error.code === 'commit_unknown') markReadOnly('commit_unknown');
    else if (error.code === 'external_modification') markReadOnly('external_modification');
    else if (error.code === 'lock_lost') markReadOnly('lock_lost');
    else if (error.code === 'hardlink_state') markReadOnly('hardlink_state');
    else if (error.code === 'state_validation_failed') markReadOnly('state_validation_failed');
  };

  const store = {
    statePath,
    viewPath,

    getSnapshot() {
      return snapshot();
    },

    /**
     * Re-read the file. A valid external change is adopted for display but makes
     * the store read-only; an invalid external change throws and stops writes.
     */
    async read() {
      ensureOpen();
      return enqueue(async () => {
        await ensureLock();
        await loadDisk({ forWrite: false });
        return snapshot();
      });
    },

    async preview(request) {
      const requestErrors = validatePreviewRequest(request);
      if (requestErrors.length) {
        throw new StoreError('invalid_request', 'Preview request failed strict validation.', {
          status: 400,
          details: { errors: requestErrors },
        });
      }
      return enqueue(async () => {
        ensureOpen();
        ensureWritable();
        await ensureLock();
        const domain = await loadDomain();
        const loaded = await loadDisk({ forWrite: true });
        let preview;
        try {
          if (typeof domain.previewReview !== 'function') {
            throw new StoreError('domain_unavailable', 'The review domain has no previewReview().', {
              status: 500,
            });
          }
          preview = await domain.previewReview(loaded.state, request, {
            fileDigest: loaded.digest,
            ...(decisionRecordPath !== undefined ? { decisionRecordPath } : {}),
          });
        } catch (error) {
          throw normaliseDomainError(error);
        }
        return {
          ok: true,
          ...(isRecord(preview) ? preview : {}),
          preview,
          projectId: loaded.state.project?.id ?? null,
          currentStateVersion: loaded.state.stateVersion,
          currentDigest: loaded.digest,
          viewStatus: clone(viewStatus),
        };
      });
    },

    async submitReview(request) {
      const requestErrors = validateReviewRequest(request);
      if (requestErrors.length) {
        throw new StoreError('invalid_request', 'Review request failed strict validation.', {
          status: 400,
          details: { errors: requestErrors },
        });
      }
      return enqueue(async () => {
        ensureOpen();
        ensureWritable();
        await ensureLock();
        const domain = await loadDomain();
        const loaded = await loadDisk({ forWrite: true });
        const state = loaded.state;
        const requestDigest = await commandDigest(domain, request);

        // Idempotency is checked before expected version/digest and before any
        // target precondition inside applyReview.
        const existing = findReview(state, request.projectId, request.idempotencyKey);
        if (existing) {
          if (existing.payloadDigest === requestDigest) {
            return {
              ok: true,
              outcome: 'replayed',
              commitStatus: 'verified',
              replayed: true,
              reviewId: existing.id,
              resultingStateVersion: existing.resultingStateVersion,
              currentStateVersion: state.stateVersion,
              currentDigest: loaded.digest,
              viewStatus: clone(viewStatus),
            };
          }
          throw new StoreError(
            'idempotency_conflict',
            'This idempotency key was already used with a different command.',
            { status: 409 },
          );
        }

        let applied;
        try {
          if (typeof domain.applyReview !== 'function') {
            throw new StoreError('domain_unavailable', 'The review domain has no applyReview().', {
              status: 500,
            });
          }
          applied = await domain.applyReview(state, request, {
            fileDigest: loaded.digest,
            actor: options.actor ?? 'local-user',
            clock: options.clock ?? (() => new Date()),
            idFactory: options.idFactory,
            ...(decisionRecordPath !== undefined ? { decisionRecordPath } : {}),
          });
        } catch (error) {
          throw normaliseDomainError(error);
        }

        const nextState = applied?.state;
        const review = applied?.review;
        const consistencyErrors = validateApplied({
          before: state,
          after: nextState,
          review,
          request,
          requestDigest,
          fileDigest: loaded.digest,
        });
        if (consistencyErrors.length) {
          markReadOnly('state_validation_failed');
          throw new StoreError(
            'state_validation_failed',
            'The generated next state failed the store consistency gate.',
            { status: 500, details: { errors: consistencyErrors } },
          );
        }
        if (typeof domain.validateTransition === 'function') {
          let transitionErrors;
          try {
            transitionErrors = await domain.validateTransition(
              state,
              nextState,
              applied?.command ?? request,
            );
          } catch (error) {
            markReadOnly('state_validation_failed');
            throw new StoreError('state_validation_failed', `validateTransition threw: ${error.message}`, {
              status: 500,
              cause: error,
            });
          }
          if (Array.isArray(transitionErrors) && transitionErrors.length) {
            markReadOnly('state_validation_failed');
            throw new StoreError('state_validation_failed', 'validateTransition rejected the action result.', {
              status: 500,
              details: { errors: transitionErrors },
            });
          }
        }

        let nextBytes;
        try {
          nextBytes = serialiseState(nextState);
        } catch (error) {
          if (error instanceof StoreError && error.code === 'state_validation_failed') {
            markReadOnly('state_validation_failed');
          }
          throw error;
        }
        if (nextBytes.byteLength > maxStateBytes) {
          throw new StoreError(
            'state_too_large',
            `The next state would be ${nextBytes.byteLength} bytes, above the configured limit of ${maxStateBytes} bytes; refusing to write or truncate.`,
            { status: 413, details: { size: nextBytes.byteLength, maxStateBytes } },
          );
        }
        const nextDigest = sha256Bytes(nextBytes);
        const expectedStateVersion = nextState.stateVersion;

        let commit;
        try {
          commit = await commitStateBytes({
            statePath,
            oldBytes: loaded.bytes,
            oldDigest: loaded.digest,
            oldStat: loaded.stat,
            oldVersion: state.stateVersion,
            nextBytes,
            nextDigest,
            io,
            hooks: options.hooks,
            maxStateBytes,
            lockCheck: ensureLock,
            verifyCommitted: (committedState) => {
              const errors = [];
              if (committedState.stateVersion !== expectedStateVersion) {
                errors.push('post-read stateVersion does not match the next version');
              }
              if (!(committedState.reviews ?? []).some((item) => item.id === review.id)) {
                errors.push('post-read state does not contain the new review');
              }
              return errors;
            },
          });
        } catch (error) {
          applyCommitFailure(error);
          throw error;
        }

        cachedState = nextState;
        currentDigest = nextDigest;
        lastAck = lastAckFromLoaded({ digest: nextDigest, size: nextBytes.byteLength, stat: commit.stat });
        const rendered = await renderView(nextState, nextDigest);
        return {
          ok: true,
          outcome: rendered.status === 'pending' ? 'saved_view_pending' : 'saved',
          commitStatus: 'verified',
          reviewId: review.id,
          resultingStateVersion: expectedStateVersion,
          currentStateVersion: expectedStateVersion,
          currentDigest: nextDigest,
          backupPath: commit.backupPath,
          directorySync: commit.directorySync,
          renameAttempts: commit.renameAttempts,
          viewStatus: clone(rendered),
        };
      });
    },

    async captureConversation(request, { verifiedSources, authorizationId } = {}) {
      // Called only by the authenticated host-adapter route. It shares this
      // store's queue, live lock, cache, commit checks and derived-view writer.
      const { applyCapture } = await import('./conversation-model.mjs');
      return enqueue(async () => {
        ensureOpen(); ensureWritable(); await ensureLock();
        const loaded = await loadDisk({ forWrite: true });
        const applied = applyCapture(loaded.state, request, { fileDigest: loaded.digest, verifiedSources, authorizationId, clock: options.clock, idFactory: options.idFactory });
        if (applied.replayed) return { ok: true, outcome: 'replayed', commitStatus: 'verified', captureId: applied.capture.id, resultingStateVersion: applied.capture.resultingStateVersion, currentStateVersion: loaded.state.stateVersion, currentDigest: loaded.digest };
        const errors = validateFullState(applied.state);
        if (errors.length) throw new StoreError('state_validation_failed', 'Conversation capture failed validation.', { status: 500, details: { errors } });
        const nextBytes = serialiseState(applied.state), nextDigest = sha256Bytes(nextBytes);
        if (nextBytes.length > maxStateBytes) throw new StoreError('state_too_large', 'Capture exceeds the state size limit.', { status: 413 });
        let commit;
        try {
          commit = await commitStateBytes({ statePath, oldBytes: loaded.bytes, oldDigest: loaded.digest, oldStat: loaded.stat, oldVersion: loaded.state.stateVersion, nextBytes, nextDigest, io, hooks: options.hooks, maxStateBytes, lockCheck: ensureLock, verifyCommitted: (s) => s.stateVersion === applied.state.stateVersion && s.conversationCaptures?.some((c) => c.id === applied.capture.id) ? [] : ['Missing capture after commit'] });
        } catch (error) { applyCommitFailure(error); throw error; }
        cachedState = applied.state; currentDigest = nextDigest;
        lastAck = lastAckFromLoaded({ digest: nextDigest, size: nextBytes.length, stat: commit.stat });
        const rendered = await renderView(cachedState, nextDigest);
        return { ok: true, outcome: rendered.status === 'pending' ? 'saved_view_pending' : 'saved', commitStatus: 'verified', captureId: applied.capture.id, resultingStateVersion: cachedState.stateVersion, currentStateVersion: cachedState.stateVersion, currentDigest, viewStatus: clone(rendered) };
      });
    },

    async regenerateView() {
      return enqueue(async () => {
        ensureOpen();
        ensureWritable();
        await ensureLock();
        await loadDisk({ forWrite: true });
        const rendered = await renderView(cachedState, currentDigest);
        if (rendered.status !== 'rendered') {
          throw new StoreError('render_failed', 'The derived view could not be generated.', {
            status: 500,
            details: { viewStatus: clone(rendered) },
          });
        }
        return {
          ok: true,
          viewStatus: clone(rendered),
          stateVersion: cachedState.stateVersion,
          currentDigest,
        };
      });
    },

    async close() {
      if (closed) {
        return { released: false, viewReleased: false, alreadyClosed: true };
      }
      closed = true;
      await queueTail.catch(() => {});
      const handles = [stateLock, ...(viewLock ? [viewLock] : [])];
      const released = await releaseStateLocks(handles, { io });
      return {
        released: Boolean(released[0]),
        viewReleased: handles.length > 1 ? Boolean(released[1]) : false,
        alreadyClosed: false,
      };
    },
  };

  return Object.freeze(store);
}
