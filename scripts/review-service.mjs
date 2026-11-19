#!/usr/bin/env node

/**
 * The single HTTP entry point for the local intent review service.
 *
 * Design boundaries (see docs/review-service-plan.md §9):
 * - Binds only 127.0.0.1, never 0.0.0.0 or a DNS alias.
 * - One state file per process, opened through state-store.mjs so the same
 *   cooperative lock, full validation and staged commit path apply.
 * - The session cookie is a request-isolation aid for this loopback page. It
 *   is not authentication, not port isolation and not proof that a human
 *   confirmed a product intent.
 * - The HTTP layer never accepts a whole state, a path, a command, a query
 *   test hook or a client-generated ID. Action semantics and idempotency live
 *   in review-actions.mjs / state-store.mjs; this file only guards transport,
 *   validates request shape, serialises actions and renders safe responses.
 * - A request aborted while waiting in the local queue never starts an action.
 *   A request aborted after an action has started cannot cancel the store call
 *   (the store API has no cancellation signal); the response is suppressed and
 *   the store's own idempotency rules apply. This is an explicit limit, not a
 *   claim of transactional cancellation.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REVIEW_ACTIONS,
} from './intent-model.mjs';
import { renderMap } from './render-map.mjs';
import { loadConversationAuthorization, verifyConversationSignature } from './conversation-authorization.mjs';

const DEFAULT_PORT = 8768;
const DEFAULT_MAX_STATE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_QUEUE = 16;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_HEADERS = 32;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const REVIEW_VIEW_BASENAME = 'product-map.review.html';
const COOKIE_MAX_LENGTH = 4096;
const MAX_REQUEST_TARGET_LENGTH = 2048;
const SUPPORTED_LANGUAGES = new Set(['zh-CN', 'en']);
const KNOWN_ACTIONS = new Set(REVIEW_ACTIONS);
// Current work (§10.2): the preview handle is process memory only.
const DEFAULT_CURRENT_WORK_PREVIEW_TTL_MS = 10 * 60 * 1000; // PREVIEW_TTL_SECONDS
const DEFAULT_CURRENT_WORK_PREVIEW_MAX = 256; // PREVIEW_BINDING_MAX
const DEFAULT_CURRENT_WORK_PREVIEW_MAX_BYTES = 16 * 1024 * 1024; // PREVIEW_BINDING_MAX_BYTES
const PREVIEW_ID_PATTERN =
  /^preview:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORK_ID_PATTERN = /^work:[A-Za-z0-9._:-]{1,150}$/;
const ID_VALUE_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,159}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
// §10.2: the preview body is the complete write content, never the journal.
const CURRENT_WORK_PREVIEW_KEYS = ['projectId', 'expectedStateVersion', 'expectedDigest', 'content'];
// §10.3: the save body is journal fields only; the content lives in the binding.
const CURRENT_WORK_SAVE_KEYS = [
  'projectId',
  'previewId',
  'previewContentDigest',
  'operationId',
  'authorizationRef',
  'expectedStateVersion',
  'expectedDigest',
];
// HTTP status per contract §11. Only these codes cross the HTTP boundary for a
// current-work write; anything else is a store or transport failure.
const CURRENT_WORK_FAILURE_STATUS = {
  invalid_request: 400,
  unknown_work_operation: 400,
  unresolved_upper_ref: 400,
  unsupported_schema: 409,
  feature_not_found: 404,
  wrong_project: 403,
  preview_expired: 410,
  preview_consumed: 409,
  preview_stale: 409,
  payload_mismatch: 409,
  sidecar_conflict: 409,
  state_conflict: 409,
  work_revision_conflict: 409,
  key_conflict: 409,
  validation_failed: 422,
  preview_not_reproducible: 503,
  late_schema_changed: 503,
  external_modification: 503,
  backup_failed: 500,
  prepare_failed: 500,
  queue_full: 503,
  store_unavailable: 503,
  not_committed: 500,
  unknown: 502,
};

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i;

const SENSITIVE_HEADERS = new Set([
  'host',
  'origin',
  'cookie',
  'content-type',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'x-review-action',
  'x-conversation-signature',
  'sec-fetch-site',
]);

const SAFE_MESSAGES = {
  invalid_path: 'A state file path is required.',
  dependency_unavailable:
    'Schema validation dependencies are unavailable; run npm ci in the skill directory.',
  startup_failed: 'The review service could not start.',
  port_unavailable: 'The requested loopback port could not be bound.',
  bad_host: 'Host must be exactly 127.0.0.1 with this service port.',
  bad_origin: 'Origin or Fetch Metadata does not match this service.',
  no_session: 'Open the review page to establish a session for this service.',
  missing_action_header: 'POST actions require X-Review-Action: 1.',
  method_not_allowed: 'Method not allowed for this route.',
  not_found: 'No such route.',
  invalid_request: 'The request did not match the strict review contract.',
  unknown_action: 'The requested review action is not supported.',
  invalid_json: 'The request body is not valid JSON.',
  invalid_utf8: 'The request body is not valid UTF-8.',
  payload_too_large: 'The request body exceeds the configured limit.',
  unsupported_media_type: 'Only application/json; charset=utf-8 is accepted.',
  request_timeout: 'The request body was not received in time.',
  queue_full: 'The review queue is full; no action was started.',
  client_aborted: 'The client disconnected before the action started.',
  stale_state: 'The expected state version or digest is stale.',
  snapshot_unavailable: 'The exact historical snapshot is missing, outside the read limit or no longer verifiable.',
  idempotency_conflict: 'This idempotency key was already used with different content.',
  external_modification: 'The state file changed outside this service; writes are stopped.',
  lock_lost: 'The state lock is no longer owned by this service; writes are stopped.',
  migration_required: 'This state is 0.1 and must be migrated before it can be written.',
  read_only: 'The state store is read-only.',
  wrong_project: 'The request project does not match the open state.',
  target_not_found: 'The requested target was not found.',
  preview_mismatch: 'The preview no longer matches the current state or request.',
  claim_not_ready: 'The claim is not ready for this action.',
  invalid_transition: 'The action is not allowed in the current state.',
  proposal_conflict: 'The target claim already has an open proposal.',
  proposal_stale: 'The proposal no longer matches its target claim.',
  legacy_requires_manual_reconciliation:
    'A shared or composite legacy decision cannot be partially replaced here.',
  legacy_resolution_required: 'The legacy decision must be explicitly restated first.',
  legacy_resolution_invalid: 'The legacy decision reference does not match the open state.',
  state_validation_failed: 'The generated state failed validation; writes are stopped.',
  prepare_failed: 'The next state could not be prepared; the fact source was not replaced.',
  backup_failed: 'The versioned backup failed; the fact source was not replaced.',
  replace_failed_preserved:
    'Replacement failed and the old state remains at the target path; inspect before retrying.',
  write_unverified:
    'The state was replaced but could not be verified; stop and inspect the file and backup.',
  commit_unknown: 'The replacement result is unknown; stop and inspect the state file.',
  domain_unavailable: 'Review actions are unavailable.',
  store_closed: 'The state store is closed.',
  render_failed: 'The derived review map could not be generated.',
  view_unreadable: 'The derived view could not be read back.',
  view_symlink: 'The derived view target is a symbolic link; refusing to replace it.',
  view_not_file: 'The derived view target is not a regular file.',
  view_hardlink: 'The derived view target has multiple hard links.',
  view_too_large: 'The derived view target exceeds the size limit.',
  view_is_state: 'The derived view target is the fact source; refusing to overwrite it.',
  view_not_owned: 'The derived view has no ownership marker for this service.',
  view_owner_mismatch: 'The derived view belongs to another state identity.',
  view_locked: 'The derived view is locked by another process.',
  view_lock_failed: 'The derived view lock could not be acquired.',
  view_lock_lost: 'The derived view lock was lost; the view was not written.',
  view_target_changed: 'The derived view target changed; refusing to overwrite it.',
  view_verification_failed: 'The derived view marker does not match this state.',
  view_readback_mismatch: 'The derived view readback digest does not match.',
  view_marker_invalid: 'The derived view staging marker is not the expected one.',
  view_conflict: 'The derived view conflicts with the current state or another owner.',
  view_unavailable: 'The derived view is unavailable.',
  render_no_output: 'The renderer produced no view output.',
  lock_failed: 'The state lock could not be created.',
  invalid_server_option: 'A trusted service option is invalid.',
  attestation_required: 'The required confirmation attestation is missing.',
  invalid_id_factory: 'The server-generated identifier is invalid.',
  state_not_file: 'The state path is not a regular file.',
  state_not_found: 'The state file was not found.',
  state_parent_missing: 'The state parent directory is not accessible.',
  state_unreadable: 'The state file could not be read.',
  render_page_failed: 'The review page could not be rendered.',
  store_unavailable: 'The state store is unavailable.',
  invalid_state: 'The state file did not pass full validation.',
  state_unverifiable: 'The state file cannot be verified; writes are stopped.',
  hardlink_state: 'The state file has multiple hard links; writes are stopped.',
  state_too_large: 'The state file exceeds the configured size limit.',
  preview_expired: 'The preview handle expired or belongs to another session; preview again.',
  preview_consumed: 'This preview was already used for a different save; preview again.',
  preview_stale: 'The preview was minted against different state bytes; discard it and preview again.',
  payload_mismatch: 'The save does not name the previewed content digest; preview again.',
  preview_not_reproducible: 'The rebuild on unchanged bytes produced different content; nothing was written.',
  unknown_work_operation: 'The work operation is not supported.',
  unresolved_upper_ref: 'An upper-layer reference does not resolve to a saved record.',
  unsupported_schema: 'Current work requires a 0.2 state; migrate explicitly first.',
  feature_not_found: 'The work must belong to an existing capability.',
  sidecar_conflict: 'An existing current-work sidecar holds different bytes; it is never overwritten.',
  state_conflict: 'The state file changed since this write was previewed; re-read and preview again.',
  work_revision_conflict: 'The work revision changed; re-read that work and merge explicitly.',
  key_conflict: 'This operationId was already used with different content.',
  validation_failed: 'The next state failed validation; nothing was written.',
  late_schema_changed: 'The readback saw a different schema; stop and do not retry.',
  not_committed: 'The attempt ended before any rename; a retry with the same operationId is safe.',
  unknown: 'The attempt ended without a readable outcome; read the status independently.',
  internal_error: 'The request could not be completed.',
};

class ServiceError extends Error {
  constructor(code, status, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status;
    this.commitStatus = options.commitStatus ?? 'not_committed';
    this.details = options.details;
    this.closeConnection = options.closeConnection === true;
    this.noResponse = options.noResponse === true;
  }
}

let corePromise;

function isMissingDependency(error) {
  const text = String(error?.message ?? '');
  return (
    error?.code === 'ERR_MODULE_NOT_FOUND' &&
    /(?:ajv|state-store\.mjs|validate-schema-runner\.mjs)/i.test(text)
  );
}

async function loadCore() {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    try {
      const [storeModule, validatorModule] = await Promise.all([
        import('./state-store.mjs'),
        import('./validate-schema-runner.mjs'),
      ]);
      // Compile every schema before the store can acquire a lock.
      validatorModule.getCompiledValidators();
      return {
        openStateStore: storeModule.openStateStore,
        canonicalizeStatePath: storeModule.canonicalizeStatePath,
        createIoAdapter: storeModule.createIoAdapter,
        // §10.1's lock-free status read. Loaded from the same module so the
        // status route cannot drift from the store's own state gate.
        readCurrentWorkStatusSnapshot: storeModule.readCurrentWorkStatusSnapshot,
        validateReviewRequest: validatorModule.validateReviewRequest,
        validatePreviewRequest: validatorModule.validatePreviewRequest,
      };
    } catch (error) {
      if (isMissingDependency(error)) {
        throw new ServiceError(
          'dependency_unavailable',
          500,
          `${SAFE_MESSAGES.dependency_unavailable} (${error.code ?? 'dependency'})`,
          { cause: error },
        );
      }
      throw new ServiceError(
        'startup_failed',
        500,
        'Schema validation could not be compiled; the review service did not start.',
        { cause: error },
      );
    }
  })();
  return corePromise;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneState(state) {
  try {
    return structuredClone(state);
  } catch {
    return state;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function safeMessageFor(code) {
  return SAFE_MESSAGES[code] ?? SAFE_MESSAGES.internal_error;
}

function limitErrors(errors) {
  if (!Array.isArray(errors)) return undefined;
  const safe = errors
    .filter((item) => typeof item === 'string')
    .slice(0, 20)
    .map((item) => item.slice(0, 300));
  return safe.length ? safe : undefined;
}

function safeViewCode(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : undefined;
}

function publicViewStatus(viewStatus) {
  const status = isRecord(viewStatus) ? viewStatus : null;
  const rawStatus = status?.status;
  const statusValue =
    rawStatus === 'not_rendered'
      ? 'pending'
      : rawStatus === 'rendered' || rawStatus === 'pending' || rawStatus === 'unknown'
        ? rawStatus
        : 'pending';
  const output = {
    status: statusValue,
    viewLocation:
      typeof status?.path === 'string' && status.path !== ''
        ? path.basename(status.path)
        : REVIEW_VIEW_BASENAME,
  };
  if (status && Number.isSafeInteger(status.stateVersion)) {
    output.stateVersion = status.stateVersion;
  }
  if (
    status &&
    typeof status.fileDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(status.fileDigest)
  ) {
    output.fileDigest = status.fileDigest;
  }
  const reason = safeViewCode(status?.reason);
  if (reason) output.reason = reason;
  if (status && isRecord(status.error)) {
    output.error = {
      code: safeViewCode(status.error.code) ?? 'render_failed',
    };
  }
  return output;
}

function sanitizeDetails(details) {
  if (!isRecord(details)) return undefined;
  const output = {};
  const errors = limitErrors(details.errors);
  if (errors) output.errors = errors;
  const reason = safeViewCode(details.reason);
  if (reason) output.reason = reason;
  if (Number.isSafeInteger(details.currentStateVersion)) {
    output.currentStateVersion = details.currentStateVersion;
  }
  if (
    typeof details.currentDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(details.currentDigest)
  ) {
    output.currentDigest = details.currentDigest;
  }
  // Current-work identifiers only; never a path, digest of foreign bytes or
  // free text from the file.
  if (typeof details.currentRecordId === 'string' && ID_VALUE_PATTERN.test(details.currentRecordId)) {
    output.currentRecordId = details.currentRecordId;
  }
  if (typeof details.workId === 'string' && WORK_ID_PATTERN.test(details.workId)) {
    output.workId = details.workId;
  }
  if (details.viewStatus) output.viewStatus = publicViewStatus(details.viewStatus);
  return Object.keys(output).length ? output : undefined;
}

function publicError(error) {
  if (error instanceof ServiceError) {
    return {
      status: error.status,
      code: error.code,
      commitStatus: error.commitStatus,
      message: error.message || safeMessageFor(error.code),
      details: sanitizeDetails(error.details),
      closeConnection: error.closeConnection,
      noResponse: error.noResponse,
    };
  }
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    const status = Number.isInteger(error.status) ? error.status : 500;
    return {
      status,
      code: error.code,
      commitStatus: error.commitStatus ?? (status >= 500 ? 'unknown' : 'not_committed'),
      message: safeMessageFor(error.code),
      details: sanitizeDetails(error.details),
      closeConnection: false,
      noResponse: false,
    };
  }
  return {
    status: 500,
    code: 'internal_error',
    commitStatus: 'not_committed',
    message: SAFE_MESSAGES.internal_error,
    details: undefined,
    closeConnection: false,
    noResponse: false,
  };
}

function setBaseHeaders(res) {
  if (res.headersSent) return;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function contentSecurityPolicy(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

function sendJson(req, res, status, body, options = {}) {
  if (res.writableEnded || res.destroyed) return false;
  setBaseHeaders(res);
  if (options.allow) res.setHeader('Allow', options.allow);
  let bytes;
  try {
    bytes = Buffer.from(JSON.stringify(body), 'utf8');
  } catch {
    return sendJson(req, res, 500, {
      ok: false,
      code: 'internal_error',
      commitStatus: 'not_committed',
      error: { code: 'internal_error', message: SAFE_MESSAGES.internal_error },
    });
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(bytes.byteLength));
  if (options.closeConnection) {
    res.setHeader('Connection', 'close');
    res.shouldKeepAlive = false;
    res.once('finish', () => {
      try {
        // Graceful half-close after the response is queued; destroying the
        // socket here can truncate the 413/400 response into a client reset.
        req.socket.end();
      } catch {
        // The socket may already be gone; nothing else to clean up.
      }
    });
  }
  res.end(bytes);
  return true;
}

function respondError(req, res, error) {
  const info = publicError(error);
  if (info.noResponse || res.writableEnded || res.destroyed) return;
  const body = {
    ok: false,
    code: info.code,
    commitStatus: info.commitStatus,
    error: { code: info.code, message: info.message },
  };
  if (info.details) {
    body.details = info.details;
    if (info.details.viewStatus) body.viewStatus = info.details.viewStatus;
    if (info.details.currentStateVersion !== undefined) {
      body.currentStateVersion = info.details.currentStateVersion;
    }
    if (info.details.currentDigest !== undefined) {
      body.currentDigest = info.details.currentDigest;
    }
  }
  sendJson(req, res, info.status, body, { closeConnection: info.closeConnection });
}

function headerCounts(req) {
  const counts = new Map();
  const raw = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = String(raw[index]).toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function parseCookie(req, name) {
  const header = req.headers.cookie;
  if (header === undefined) return { present: false, value: null };
  if (typeof header !== 'string' || header.length > COOKIE_MAX_LENGTH) {
    throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
      closeConnection: true,
    });
  }
  let found;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    if (found !== undefined) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
        closeConnection: true,
      });
    }
    found = part.slice(separator + 1).trim();
  }
  return found === undefined ? { present: false, value: null } : { present: true, value: found };
}

function parseTarget(req) {
  const raw = req.url;
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_REQUEST_TARGET_LENGTH ||
    !raw.startsWith('/') ||
    raw.includes('#')
  ) {
    throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request);
  }
  const queryIndex = raw.indexOf('?');
  return {
    pathname: queryIndex === -1 ? raw : raw.slice(0, queryIndex),
    search: queryIndex === -1 ? '' : raw.slice(queryIndex + 1),
  };
}

function createSerialQueue(maxQueue) {
  const pending = [];
  let active = 0;
  let running = false;
  let closed = false;

  const abortError = () =>
    new ServiceError('client_aborted', 499, SAFE_MESSAGES.client_aborted, { noResponse: true });

  function pump() {
    if (running || closed) return;
    let entry;
    while (pending.length) {
      entry = pending.shift();
      if (!entry.settled) break;
      entry = undefined;
    }
    if (!entry) return;
    running = true;
    active += 1;
    entry.started = true;
    entry.signal?.removeEventListener('abort', entry.onAbort);
    Promise.resolve()
      .then(() => entry.task())
      .then(
        (value) => {
          if (!entry.settled) {
            entry.settled = true;
            entry.resolve(value);
          }
        },
        (error) => {
          if (!entry.settled) {
            entry.settled = true;
            entry.reject(error);
          }
        },
      )
      .finally(() => {
        running = false;
        active -= 1;
        pump();
      });
  }

  return {
    enqueue(task, signal) {
      if (closed) {
        return Promise.reject(
          new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable),
        );
      }
      if (active + pending.length >= maxQueue) {
        return Promise.reject(
          new ServiceError('queue_full', 503, SAFE_MESSAGES.queue_full),
        );
      }
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const entry = {
          task,
          signal,
          resolve,
          reject,
          settled: false,
          started: false,
          onAbort: null,
        };
        entry.onAbort = () => {
          if (entry.settled || entry.started) return;
          entry.settled = true;
          entry.signal?.removeEventListener('abort', entry.onAbort);
          reject(abortError());
        };
        signal?.addEventListener('abort', entry.onAbort, { once: true });
        pending.push(entry);
        pump();
      });
    },
    close() {
      closed = true;
      for (const entry of pending.splice(0)) {
        if (!entry.settled) {
          entry.settled = true;
          entry.signal?.removeEventListener('abort', entry.onAbort);
          entry.reject(new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable));
        }
      }
    },
  };
}

function readJsonBody(req, res, controller, options) {
  const { maxBytes, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    let bodyEnded = false;

    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      res.off('close', onClose);
    };
    const fail = (error) => {
      if (done) return;
      done = true;
      cleanup();
      try {
        req.pause();
      } catch {
        // Already closed.
      }
      if (error.noResponse) controller.abort();
      reject(error);
    };
    const timer = setTimeout(() => {
      controller.abort();
      fail(
        new ServiceError('request_timeout', 408, SAFE_MESSAGES.request_timeout, {
          closeConnection: true,
        }),
      );
    }, timeoutMs);

    function onData(chunk) {
      if (done) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
        fail(
          new ServiceError('payload_too_large', 413, SAFE_MESSAGES.payload_too_large, {
            closeConnection: true,
          }),
        );
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      if (done) return;
      bodyEnded = true;
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        fail(new ServiceError('invalid_utf8', 400, SAFE_MESSAGES.invalid_utf8));
        return;
      }
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        fail(new ServiceError('invalid_json', 400, SAFE_MESSAGES.invalid_json));
        return;
      }
      if (!isRecord(value)) {
        fail(new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request));
        return;
      }
      done = true;
      cleanup();
      resolve(value);
    }
    function onError() {
      fail(new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request));
    }
    function onAborted() {
      controller.abort();
      fail(new ServiceError('client_aborted', 499, SAFE_MESSAGES.client_aborted, { noResponse: true }));
    }
    function onClose() {
      if (!bodyEnded && !done) onAborted();
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    res.on('close', onClose);
  });
}

function checkContentHeaders(req, maxBodyBytes) {
  const contentEncoding = req.headers['content-encoding'];
  if (contentEncoding !== undefined && String(contentEncoding).toLowerCase() !== 'identity') {
    throw new ServiceError('unsupported_media_type', 415, SAFE_MESSAGES.unsupported_media_type, {
      closeConnection: true,
    });
  }

  const transferEncoding = req.headers['transfer-encoding'];
  if (transferEncoding !== undefined && String(transferEncoding).toLowerCase() !== 'chunked') {
    throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
      closeConnection: true,
    });
  }

  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(String(contentLength))) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
        closeConnection: true,
      });
    }
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length)) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
        closeConnection: true,
      });
    }
    if (length > maxBodyBytes) {
      throw new ServiceError('payload_too_large', 413, SAFE_MESSAGES.payload_too_large, {
        closeConnection: true,
      });
    }
  }
  if (transferEncoding !== undefined && contentLength !== undefined) {
    throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
      closeConnection: true,
    });
  }

  const contentType = req.headers['content-type'];
  if (contentType === undefined || !JSON_CONTENT_TYPE.test(String(contentType))) {
    throw new ServiceError('unsupported_media_type', 415, SAFE_MESSAGES.unsupported_media_type, {
      closeConnection: true,
    });
  }
}

function createFallbackPage({
  snapshot,
  nonce,
  stateLocation,
  stateIdentity,
  language,
  legacySchema01 = false,
}) {
  const zh = language !== 'en';
  const projectName = snapshot.state?.project?.name ?? (zh ? '未命名项目' : 'Unnamed project');
  const version = snapshot.stateVersion ?? snapshot.state?.stateVersion ?? '?';
  const schemaVersion = snapshot.schemaVersion ?? snapshot.state?.schemaVersion ?? null;
  const digest = typeof snapshot.fileDigest === 'string' ? snapshot.fileDigest : '';
  const writable = snapshot.writable ? (zh ? '可写' : 'Writable') : (zh ? '只读' : 'Read-only');
  const readOnlyReason = snapshot.readOnlyReason ?? '';
  const viewStatus = snapshot.viewStatus?.status ?? 'pending';
  const heading = legacySchema01
    ? (zh ? '产品连续性 · 旧版 0.1 状态（只读）' : 'Product continuity · legacy 0.1 state (read-only)')
    : (zh ? '产品连续性 · 实时意图评审' : 'Product continuity · live intent review');
  const note = legacySchema01
    ? (zh
        ? '此状态文件使用旧版 schema 0.1。服务只读展示摘要，不会自动迁移，也不接受评审写入。关闭本服务后，请使用 node scripts/migrate-state.mjs <state-file> 显式迁移到 0.2，核对迁移结果后再重新启动服务。'
        : 'This state file uses legacy schema 0.1. The service displays a read-only summary, does not migrate it automatically, and rejects review writes. Stop this service, run node scripts/migrate-state.mjs <state-file> to migrate to 0.2 explicitly, verify the result, then start the service again.')
    : (zh
        ? '完整评审界面模块尚未安装到本次构建；服务接口仍按同一套来源、会话与确认规则运行。'
        : 'The full review UI module is not installed in this build; the API still follows the same origin, session and confirmation rules.');
  const legacyRows = legacySchema01
    ? `<dt>${escapeHtml(zh ? 'Schema 版本' : 'Schema version')}</dt><dd>${escapeHtml(String(schemaVersion ?? '0.1'))}</dd>
<dt>${escapeHtml(zh ? '迁移' : 'Migration')}</dt><dd>${escapeHtml(zh ? '需要关闭服务后显式迁移；服务不会自动迁移' : 'Explicit migration after stopping the service; this service never migrates automatically')}</dd>
`
    : '';
  return `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(heading)}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 52rem; padding: 0 1rem; line-height: 1.5; }
h1 { font-size: 1.35rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; }
dt { font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
.note { border-left: 3px solid currentColor; padding-left: .75rem; opacity: .8; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
<p class="note">${escapeHtml(note)}</p>
<dl>
<dt>${escapeHtml(zh ? '项目' : 'Project')}</dt><dd>${escapeHtml(projectName)}</dd>
<dt>${escapeHtml(zh ? '状态位置' : 'State location')}</dt><dd>${escapeHtml(stateLocation)}</dd>
<dt>${escapeHtml(zh ? '状态身份' : 'State identity')}</dt><dd>${escapeHtml(String(stateIdentity).slice(0, 23))}…</dd>
${legacyRows}<dt>${escapeHtml(zh ? '状态版本' : 'State version')}</dt><dd>${escapeHtml(version)}</dd>
<dt>${escapeHtml(zh ? '文件摘要' : 'File digest')}</dt><dd>${escapeHtml(digest.slice(0, 19))}…</dd>
<dt>${escapeHtml(zh ? '写入状态' : 'Write status')}</dt><dd>${escapeHtml(writable)}${readOnlyReason ? ` (${escapeHtml(readOnlyReason)})` : ''}</dd>
<dt>${escapeHtml(zh ? '派生视图' : 'Derived view')}</dt><dd>${escapeHtml(viewStatus)}</dd>
</dl>
</main>
<script nonce="${escapeHtml(nonce)}">document.documentElement.dataset.reviewService = "ready";</script>
</body>
</html>`;
}

function canonicalIdentityPath(value) {
  let resolved = path.resolve(value);
  if (process.platform === 'win32') {
    resolved = resolved.replaceAll('/', '\\').toLowerCase();
  }
  return resolved;
}

function computeStateLocation(canonicalPath, projectRoot) {
  let relative = path.relative(projectRoot, canonicalPath);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    relative = path.basename(canonicalPath);
  }
  return relative.split(path.sep).join('/');
}

function publicState(snapshot, context) {
  const stateVersion =
    snapshot.stateVersion ?? snapshot.currentStateVersion ?? snapshot.state?.stateVersion ?? null;
  const fileDigest = snapshot.fileDigest ?? snapshot.currentDigest ?? null;
  return {
    ok: true,
    state: snapshot.state,
    fileDigest,
    currentDigest: fileDigest,
    currentStateVersion: stateVersion,
    writable: Boolean(snapshot.writable),
    readOnlyReason: snapshot.readOnlyReason ?? null,
    viewStatus: publicViewStatus(snapshot.viewStatus),
    stateIdentity: context.stateIdentity,
    stateLocation: context.stateLocation,
    timelineHistory: snapshot.timelineHistory ?? null,
  };
}

function publicPreview(result) {
  const source = result?.preview ?? result;
  const preview = {};
  for (const key of ['previewDigest', 'plan', 'action', 'requiresPreview', 'attestations']) {
    if (source && source[key] !== undefined) preview[key] = source[key];
  }
  if (preview.previewDigest === undefined && result?.previewDigest !== undefined) {
    preview.previewDigest = result.previewDigest;
  }
  if (preview.requiresPreview === undefined && typeof preview.plan?.requiresPreview === 'boolean') {
    preview.requiresPreview = preview.plan.requiresPreview;
  }
  if (preview.attestations === undefined && Array.isArray(preview.plan?.attestations)) {
    preview.attestations = preview.plan.attestations;
  }
  return {
    ok: true,
    preview,
    previewDigest: preview.previewDigest ?? null,
    currentStateVersion: result?.currentStateVersion ?? null,
    currentDigest: result?.currentDigest ?? null,
    viewStatus: publicViewStatus(result?.viewStatus),
  };
}

function publicSubmit(result) {
  const output = {
    ok: result?.ok !== false,
    outcome: result?.outcome ?? 'saved',
    commitStatus: result?.commitStatus ?? 'verified',
  };
  if (result?.reviewId !== undefined) output.reviewId = result.reviewId;
  if (result?.resultingStateVersion !== undefined) {
    output.resultingStateVersion = result.resultingStateVersion;
  }
  if (result?.currentStateVersion !== undefined) {
    output.currentStateVersion = result.currentStateVersion;
  }
  if (result?.currentDigest !== undefined) output.currentDigest = result.currentDigest;
  if (result?.replayed !== undefined) output.replayed = result.replayed;
  if (result?.error && typeof result.error === 'object' && typeof result.error.code === 'string') {
    output.error = { code: result.error.code };
  }
  output.viewStatus = publicViewStatus(result?.viewStatus);
  return output;
}

function publicRender(result) {
  return {
    ok: true,
    viewStatus: publicViewStatus(result?.viewStatus),
    stateVersion: result?.stateVersion ?? null,
    currentDigest: result?.currentDigest ?? null,
  };
}

function rendererSnapshot(snapshot) {
  return {
    state: cloneState(snapshot.state),
    stateVersion: snapshot.stateVersion ?? snapshot.state?.stateVersion ?? null,
    fileDigest: snapshot.fileDigest ?? snapshot.currentDigest ?? null,
    writable: Boolean(snapshot.writable),
    readOnlyReason: snapshot.readOnlyReason ?? null,
    viewStatus: publicViewStatus(snapshot.viewStatus),
    projectId: snapshot.projectId ?? snapshot.state?.project?.id ?? null,
    schemaVersion: snapshot.schemaVersion ?? snapshot.state?.schemaVersion ?? null,
    timelineHistory: snapshot.timelineHistory ?? null,
  };
}

// ---------------------------------------------------------------------------
// Current work: preview handles, request shape and the digest boundary
// ---------------------------------------------------------------------------
//
// §10.2/§10.3 decide digests in scripts/current-work-model.mjs; this layer must
// not invent a second rule. The only digest this file ever asks for is the
// human-facing one, and it asks the builder:
//
//   * previewContentDigest - the builder's `previewContentDigest` over the
//     complete normalized content. Bound to the preview handle (§10.2), echoed
//     by the save body as `previewContentDigest`, compared at rule 6;
//   * operationPayloadDigest - the receipt's `payloadDigest`, derived by the
//     builder and the replay lookup from `{previewContentDigest, authorizationRef}`.
//     It is never recomputed or compared here; §10.3 rule 9a lives inside the
//     builder via `resolveCurrentWorkReplay`.
//
// They are different values and no code below assumes otherwise. Keeping the
// split here is what lets the contract owner change either formula without
// touching these routes.
// ---------------------------------------------------------------------------

function isSafeStateVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER;
}

// The service must not start (injected) nor answer (built-in) with a module that
// cannot enforce the contract. Checked once, at the seam.
const CURRENT_WORK_MODEL_EXPORTS = ['buildCurrentWorkWrite', 'resolveCurrentWorkReplay'];

function currentWorkModelProblems(model) {
  if (!isRecord(model)) return ['current work model: expected a module object'];
  const problems = [];
  for (const name of CURRENT_WORK_MODEL_EXPORTS) {
    if (typeof model[name] !== 'function') problems.push(`current work model: ${name}() is missing`);
  }
  if (!Array.isArray(model.CURRENT_WORK_OPERATIONS) || model.CURRENT_WORK_OPERATIONS.length === 0) {
    problems.push('current work model: CURRENT_WORK_OPERATIONS is missing');
  }
  if (!isRecord(model.CURRENT_WORK_CONSTANTS)) {
    problems.push('current work model: CURRENT_WORK_CONSTANTS is missing');
  }
  return problems;
}

function assertCurrentWorkModel(model, label) {
  const problems = currentWorkModelProblems(model);
  if (problems.length) {
    throw new ServiceError('invalid_server_option', 400, `${label}: ${problems.join('; ')}`);
  }
}

function isDigestString(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isBoundedText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /\S/.test(value);
}

function exactKeysErrors(body, keys) {
  const actual = Object.keys(body);
  const unexpected = actual.filter((key) => !keys.includes(key));
  if (unexpected.length) {
    return [
      `body: unexpected key(s) ${unexpected.map((key) => JSON.stringify(key)).join(', ')}; expected exactly ${keys.join(', ')}`,
    ];
  }
  const missing = keys.filter((key) => !Object.hasOwn(body, key));
  if (missing.length) {
    return [`body: missing key(s) ${missing.join(', ')}; expected exactly ${keys.join(', ')}`];
  }
  return [];
}

function currentWorkPreviewRequestErrors(body) {
  const errors = exactKeysErrors(body, CURRENT_WORK_PREVIEW_KEYS);
  if (errors.length) return errors;
  if (!isBoundedText(body.projectId, 2000)) errors.push('body.projectId: expected a non-empty string');
  if (!isSafeStateVersion(body.expectedStateVersion)) {
    errors.push('body.expectedStateVersion: expected a safe integer >= 1');
  }
  if (!isDigestString(body.expectedDigest)) {
    errors.push('body.expectedDigest: expected sha256:<64 lowercase hex>');
  }
  if (!isRecord(body.content)) errors.push('body.content: expected an object');
  // Shape only: the builder's own validator owns every content rule. §10.2 also
  // forbids smuggling journal fields inside the content.
  if (isRecord(body.content)) {
    for (const key of ['operationId', 'authorizationRef', 'payloadDigest', 'previewContentDigest']) {
      if (Object.hasOwn(body.content, key)) {
        errors.push(`body.content: ${key} belongs to the save, not to the preview`);
      }
    }
  }
  return errors;
}

function currentWorkSaveRequestErrors(body) {
  const errors = exactKeysErrors(body, CURRENT_WORK_SAVE_KEYS);
  if (errors.length) return errors;
  if (!isBoundedText(body.projectId, 2000)) errors.push('body.projectId: expected a non-empty string');
  if (typeof body.previewId !== 'string' || !PREVIEW_ID_PATTERN.test(body.previewId)) {
    errors.push('body.previewId: expected preview:<uuid>');
  }
  if (!isDigestString(body.previewContentDigest)) {
    errors.push('body.previewContentDigest: expected sha256:<64 lowercase hex>');
  }
  if (!isBoundedText(body.operationId, 160)) {
    errors.push('body.operationId: expected 1..160 non-blank characters');
  }
  if (!isBoundedText(body.authorizationRef, 2000)) {
    errors.push('body.authorizationRef: expected 1..2000 non-blank characters');
  }
  if (!isSafeStateVersion(body.expectedStateVersion)) {
    errors.push('body.expectedStateVersion: expected a safe integer >= 1');
  }
  if (!isDigestString(body.expectedDigest)) {
    errors.push('body.expectedDigest: expected sha256:<64 lowercase hex>');
  }
  return errors;
}

function currentWorkFailureDetails(failure) {
  const source = isRecord(failure?.details) ? failure.details : {};
  const details = {};
  const errors = limitErrors(failure?.errors) ?? limitErrors(source.errors);
  if (errors) details.errors = errors;
  if (typeof source.reason === 'string') details.reason = source.reason;
  // The builder names the freshly read values `actual*`; the error body
  // convention (and /api/state) names them `current*`.
  const version = Number.isSafeInteger(source.actualStateVersion)
    ? source.actualStateVersion
    : source.currentStateVersion;
  if (Number.isSafeInteger(version)) details.currentStateVersion = version;
  const digest = typeof source.actualDigest === 'string' ? source.actualDigest : source.currentDigest;
  if (isDigestString(digest)) details.currentDigest = digest;
  if (typeof source.currentRecordId === 'string') details.currentRecordId = source.currentRecordId;
  if (typeof source.workId === 'string') details.workId = source.workId;
  if (typeof source.validatorCode === 'string') details.reason = details.reason ?? source.validatorCode;
  return Object.keys(details).length ? details : undefined;
}

function currentWorkServiceError(failure) {
  const known =
    typeof failure?.code === 'string' && CURRENT_WORK_FAILURE_STATUS[failure.code] !== undefined;
  const code = known ? failure.code : 'not_committed';
  return new ServiceError(code, CURRENT_WORK_FAILURE_STATUS[code], safeMessageFor(code), {
    commitStatus: 'not_committed',
    details: currentWorkFailureDetails(failure),
  });
}

// Store-level failures that are not already contract codes. Anything absent
// here passes through untouched, so a contract code keeps its own status.
const CURRENT_WORK_STORE_ERRORS = {
  write_unverified: { code: 'unknown', status: 502, commitStatus: 'unknown' },
  commit_unknown: { code: 'unknown', status: 502, commitStatus: 'unknown' },
  external_modification: { code: 'external_modification', status: 503 },
  lock_lost: { code: 'external_modification', status: 503, reason: 'lock_lost' },
  state_unverifiable: { code: 'external_modification', status: 503, reason: 'state_unverifiable' },
  hardlink_state: { code: 'external_modification', status: 503, reason: 'hardlink_state' },
  replace_failed_preserved: { code: 'not_committed', status: 500, reason: 'replace_failed_preserved' },
  backup_failed: { code: 'backup_failed', status: 500 },
  prepare_failed: { code: 'prepare_failed', status: 500, reason: 'prepare_failed' },
  read_only: { code: 'store_unavailable', status: 503, reason: 'read_only' },
  store_closed: { code: 'store_unavailable', status: 503, reason: 'store_closed' },
  migration_required: { code: 'unsupported_schema', status: 409, reason: 'migration_required' },
  invalid_state: { code: 'validation_failed', status: 422, reason: 'invalid_state' },
  state_validation_failed: { code: 'validation_failed', status: 422, reason: 'state_validation_failed' },
  state_too_large: { code: 'validation_failed', status: 422, reason: 'state_too_large' },
  not_committed: { code: 'not_committed', status: 500 },
  queue_full: { code: 'queue_full', status: 503 },
};

function translateCurrentWorkStoreError(error) {
  if (!error || typeof error !== 'object' || typeof error.code !== 'string') return error;
  const mapped = CURRENT_WORK_STORE_ERRORS[error.code];
  if (!mapped) return error;
  const details = { ...(isRecord(error.details) ? error.details : {}) };
  if (mapped.reason) details.reason = mapped.reason;
  return new ServiceError(mapped.code, mapped.status, safeMessageFor(mapped.code), {
    cause: error,
    commitStatus: mapped.commitStatus ?? error.commitStatus ?? 'not_committed',
    details,
  });
}

/**
 * `/status` reads the file itself (§10.1), so its failures are read failures,
 * not commit outcomes: no `commitStatus` is invented. §11.3 treats a state that
 * trips validation as `invalid_state` "for every reader", so the vocabulary
 * stays the same one the write path uses.
 */
const CURRENT_WORK_STATUS_READ_ERRORS = {
  state_not_found: { code: 'state_not_found', status: 404 },
  state_not_file: { code: 'state_not_file', status: 400 },
  state_too_large: { code: 'validation_failed', status: 422, reason: 'state_too_large' },
  invalid_state: { code: 'validation_failed', status: 422, reason: 'invalid_state' },
  invalid_utf8: { code: 'validation_failed', status: 422, reason: 'invalid_state' },
  hardlink_state: { code: 'external_modification', status: 503, reason: 'hardlink_state' },
  state_unreadable: { code: 'store_unavailable', status: 503, reason: 'state_unreadable' },
  state_unverifiable: { code: 'store_unavailable', status: 503, reason: 'state_unverifiable' },
};

function translateCurrentWorkStatusReadError(error) {
  const mapped =
    error && typeof error === 'object' && typeof error.code === 'string'
      ? CURRENT_WORK_STATUS_READ_ERRORS[error.code]
      : undefined;
  // Anything else (including a store the status read cannot interpret) fails
  // closed as `store_unavailable`: never a `found` answer and never a guess.
  if (!mapped) {
    return new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable, {
      cause: error,
    });
  }
  const details = {};
  if (mapped.reason) details.reason = mapped.reason;
  const errors = limitErrors(error.details?.errors);
  if (errors) details.errors = errors;
  return new ServiceError(mapped.code, mapped.status, safeMessageFor(mapped.code), {
    cause: error,
    ...(Object.keys(details).length ? { details } : {}),
  });
}

/** Post-readback check: the committed bytes must hold this record and receipt. */
function currentWorkVerifyProblems(committedState, built) {
  const problems = [];
  const recordId = built?.checkpoint?.id;
  const receiptId = built?.receipt?.id;
  const records = Array.isArray(committedState?.featureCheckpoints)
    ? committedState.featureCheckpoints
    : [];
  const updates = Array.isArray(committedState?.mapUpdates) ? committedState.mapUpdates : [];
  if (typeof recordId !== 'string' || !records.some((record) => record?.id === recordId)) {
    problems.push('readback is missing the new feature checkpoint');
  }
  if (typeof receiptId !== 'string' || !updates.some((update) => update?.id === receiptId)) {
    problems.push('readback is missing the new map update receipt');
  }
  return problems;
}

/**
 * §11.1 answers the field from wherever the fact lives; it never invents one.
 * `live` is the current file as this request read it after the write, and
 * `built` is the builder's own record of the attempt (absent on a replay).
 *
 * The store and the route look exactly like each other here ("state",
 * "digest"), so only an explicitly nested `built` is trusted; anything else is
 * treated as a store result rather than silently reported as a null receipt.
 */
function currentWorkAttempt(result) {
  if (isRecord(result?.built)) return result.built;
  if (isRecord(result?.receipt) || isRecord(result?.checkpoint) || typeof result?.workId === 'string') {
    return result;
  }
  return {};
}

function publicCurrentWorkSave(result, { liveState, liveDigest, liveStateVersion }) {
  const built = currentWorkAttempt(result);
  const replayed = result?.replayed === true;
  const receipt = isRecord(built.receipt) ? built.receipt : null;
  const checkpoint = isRecord(built.checkpoint) ? built.checkpoint : null;
  const observedStateVersion = isRecord(receipt)
    ? receipt.observedStateVersion ?? null
    : Number.isSafeInteger(built.previousStateVersion)
      ? built.previousStateVersion
      : null;
  const resultingStateVersion = isRecord(receipt)
    ? receipt.resultingStateVersion ?? null
    : Number.isSafeInteger(built.resultingStateVersion)
      ? built.resultingStateVersion
      : Number.isSafeInteger(result?.stateVersion)
        ? result.stateVersion
        : null;
  const observedDigest = isRecord(receipt)
    ? receipt.observedDigest ?? null
    : isDigestString(built.previousDigest)
      ? built.previousDigest
      : null;
  const operationId = isRecord(receipt) && typeof receipt.operationId === 'string' ? receipt.operationId : null;
  const payloadDigest = isRecord(receipt) && isDigestString(receipt.payloadDigest)
    ? receipt.payloadDigest
    : isDigestString(built.payloadDigest)
      ? built.payloadDigest
      : null;
  // The receipt's own versions are compared with the current file: a later
  // write is not this commit's bytes.
  const resultingDigest =
    resultingStateVersion !== null && resultingStateVersion === liveStateVersion ? liveDigest : null;
  const digestSource =
    resultingDigest !== null ? (replayed ? 'current_file' : 'readback') : 'unavailable';
  return {
    ok: true,
    replayed,
    // The contract has no separate "replayed" commit status: both paths report
    // the receipt, and `replayed` carries the distinction.
    commitStatus: 'committed',
    receiptId: receipt?.id ?? null,
    recordId: checkpoint?.id ?? null,
    workId: built.workId ?? checkpoint?.workContext?.workId ?? null,
    operationId: receipt?.operationId ?? null,
    observedStateVersion,
    resultingStateVersion,
    observedDigest,
    resultingDigest,
    digestSource,
    previewContentDigest: replayed ? null : built.previewContentDigest ?? null,
    payloadDigest: receipt?.payloadDigest ?? null,
    // A replay verified nothing in this request: say so instead of claiming it.
    readback: {
      verified: replayed ? null : true,
      recordPresent:
        checkpoint !== null &&
        Array.isArray(liveState?.featureCheckpoints) &&
        liveState.featureCheckpoints.some((record) => record?.id === checkpoint.id),
      receiptPresent:
        receipt !== null &&
        Array.isArray(liveState?.mapUpdates) &&
        liveState.mapUpdates.some((update) => update?.id === receipt.id),
    },
    // File name only: never the absolute path (§11).
    backupPath: !replayed && typeof result?.backupPath === 'string' ? path.basename(result.backupPath) : null,
    backupPathAvailable: !replayed && typeof result?.backupPath === 'string',
  };
}

function publicCurrentWorkStatus(state, liveDigest, liveStateVersion, query, replay) {
  if (query.operationId !== null) {
    // The shared lookup also guards the replay path (§10.3 9a), so it is
    // stricter than §11.3 in two named ways. A read-only answer must not turn
    // either into a false alarm:
    //   * a valid receipt for another work is `integrity: 'ok'`, not `broken`;
    //   * a receipt whose record was later superseded still *did* commit, so it
    //     stays `found: true`.
    const problems = Array.isArray(replay?.problems) ? replay.problems : [];
    const anotherWork = problems.includes('work_id_mismatch');
    const onlySuperseded =
      problems.length > 0 && problems.every((problem) => problem === 'record_is_not_current_work');
    const found = replay?.found === true || (onlySuperseded && !anotherWork);
    if (!found) {
      const output = {
        ok: true,
        found: false,
        operationId: query.operationId,
        currentStateVersion: liveStateVersion,
        currentDigest: liveDigest,
      };
      // §11.3: no receipt at all is not an integrity finding; a receipt whose
      // record or chain does not line up is.
      if (anotherWork) output.integrity = 'ok';
      else if (replay?.integrity === 'broken') output.integrity = 'broken';
      return output;
    }
    const resultingDigest =
      replay.resultingStateVersion !== null && replay.resultingStateVersion === liveStateVersion
        ? liveDigest
        : null;
    const recordPresent =
      isRecord(replay.record) &&
      Array.isArray(state?.featureCheckpoints) &&
      state.featureCheckpoints.some((record) => record?.id === replay.record.id);
    const receiptPresent =
      isRecord(replay.receipt) &&
      Array.isArray(state?.mapUpdates) &&
      state.mapUpdates.some((update) => update?.id === replay.receipt.id);
    return {
      ok: true,
      found: true,
      source: 'local_feature_checkpoint',
      operationId: query.operationId,
      receiptId: replay.receiptId ?? null,
      recordId: replay.recordId ?? null,
      workId: replay.workId ?? null,
      operation: replay.operation ?? null,
      observedStateVersion: replay.observedStateVersion ?? null,
      resultingStateVersion: replay.resultingStateVersion ?? null,
      observedDigest: replay.receipt?.observedDigest ?? null,
      payloadDigest: replay.payloadDigest ?? null,
      currentStateVersion: liveStateVersion,
      currentDigest: liveDigest,
      resultingDigest,
      digestBasis: resultingDigest !== null ? 'current_file' : 'unavailable',
      integrity: 'ok',
      readback: { recordPresent, receiptPresent },
    };
  }
  // workId only: the receipt that produced this work's current record — what a
  // panel opening on a work needs (§11.3).
  const records = Array.isArray(state?.featureCheckpoints) ? state.featureCheckpoints : [];
  let record = null;
  for (const item of records) {
    if (isRecord(item) && isRecord(item.workContext) && item.workContext.workId === query.workId) {
      record = item;
    }
  }
  if (!record) {
    return { ok: true, found: false, workId: query.workId, currentStateVersion: liveStateVersion, currentDigest: liveDigest };
  }
  const updates = Array.isArray(state?.mapUpdates) ? state.mapUpdates : [];
  const receipt = updates.find(
    (update) =>
      isRecord(update) &&
      update.source === 'local_feature_checkpoint' &&
      Array.isArray(update.addedFeatureCheckpointIds) &&
      update.addedFeatureCheckpointIds.includes(record.id),
  );
  const resultingStateVersion =
    receipt?.resultingStateVersion ??
    (isSafeStateVersion(record.basis?.observedStateVersion) ? record.basis.observedStateVersion + 1 : null);
  const resultingDigest =
    resultingStateVersion !== null && resultingStateVersion === liveStateVersion ? liveDigest : null;
  return {
    ok: true,
    found: true,
    source: 'local_feature_checkpoint',
    operationId: typeof receipt?.operationId === 'string' ? receipt.operationId : null,
    receiptId: typeof receipt?.id === 'string' ? receipt.id : null,
    recordId: record.id,
    workId: query.workId,
    resultingStateVersion,
    currentStateVersion: liveStateVersion,
    currentDigest: liveDigest,
    resultingDigest,
    digestBasis: resultingDigest !== null ? 'current_file' : 'unavailable',
    integrity: 'ok',
    readback: { recordPresent: true, receiptPresent: Boolean(receipt) },
  };
}

/**
 * Start the one HTTP entry point for a single state file.
 *
 * @param {string} statePath
 * @param {{
 *   port?: number,
 *   language?: 'zh-CN'|'en',
 *   maxStateBytes?: number,
 *   maxBodyBytes?: number,
 *   maxQueue?: number,
 *   bodyTimeoutMs?: number,
 *   headersTimeoutMs?: number,
 *   requestTimeoutMs?: number,
 *   keepAliveTimeoutMs?: number,
 *   closeTimeoutMs?: number,
 *   renderReview?: Function|null,
 *   renderViews?: Function|null,
 *   store?: object,
 *   logger?: Function,
 *   actor?: string,
 *   clock?: Function|Date|string,
 *   idFactory?: Function,
 *   domain?: object,
 *   fs?: object,
 *   hooks?: object,
 *   projectRoot?: string,
 *   previewTtlMs?: number,
 *   previewMax?: number,
 *   currentWorkModel?: object
 * }} [options]
 * @returns {Promise<{url: string, port: number, server: import('node:http').Server, store: object, close: Function}>}
 */
export async function startReviewService(statePath, options = {}) {
  if (typeof statePath !== 'string' || statePath.trim() === '') {
    throw new ServiceError('invalid_path', 400, SAFE_MESSAGES.invalid_path);
  }
  const language = options.language ?? 'zh-CN';
  if (!SUPPORTED_LANGUAGES.has(language)) {
    throw new ServiceError('invalid_request', 400, 'Unsupported language option.');
  }
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ServiceError('invalid_request', 400, 'Port must be an integer from 0 to 65535.');
  }
  const maxStateBytes = options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES;
  if (!Number.isSafeInteger(maxStateBytes) || maxStateBytes <= 0) {
    throw new ServiceError('invalid_request', 400, 'maxStateBytes must be a positive safe integer.');
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new ServiceError('invalid_request', 400, 'maxBodyBytes must be a positive safe integer.');
  }
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) {
    throw new ServiceError('invalid_request', 400, 'maxQueue must be a positive safe integer.');
  }
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1) {
    throw new ServiceError('invalid_request', 400, 'bodyTimeoutMs must be a positive safe integer.');
  }
  const previewTtlMs = options.previewTtlMs ?? DEFAULT_CURRENT_WORK_PREVIEW_TTL_MS;
  if (!Number.isSafeInteger(previewTtlMs) || previewTtlMs < 1) {
    throw new ServiceError(
      'invalid_server_option',
      400,
      'previewTtlMs must be a positive safe integer.',
    );
  }
  const previewMax = options.previewMax ?? DEFAULT_CURRENT_WORK_PREVIEW_MAX;
  if (!Number.isSafeInteger(previewMax) || previewMax < 1) {
    throw new ServiceError('invalid_server_option', 400, 'previewMax must be a positive safe integer.');
  }
  const previewMaxBytes = DEFAULT_CURRENT_WORK_PREVIEW_MAX_BYTES;
  if (options.currentWorkModel !== undefined) {
    if (options.currentWorkModel === null || typeof options.currentWorkModel !== 'object') {
      throw new ServiceError('invalid_server_option', 400, 'currentWorkModel must be a module object.');
    }
    assertCurrentWorkModel(options.currentWorkModel, 'currentWorkModel');
  }
  if (
    options.renderReview !== undefined &&
    options.renderReview !== null &&
    typeof options.renderReview !== 'function'
  ) {
    throw new ServiceError('invalid_request', 400, 'renderReview must be a function or null.');
  }
  if (
    options.renderViews !== undefined &&
    options.renderViews !== null &&
    typeof options.renderViews !== 'function'
  ) {
    throw new ServiceError('invalid_request', 400, 'renderViews must be a function or null.');
  }
  if (options.projectRoot !== undefined && typeof options.projectRoot !== 'string') {
    throw new ServiceError('invalid_request', 400, 'projectRoot must be a string.');
  }
  if (
    options.store !== undefined &&
    (options.store === null || typeof options.store !== 'object')
  ) {
    throw new ServiceError('invalid_request', 400, 'store must be a store object.');
  }

  const core = await loadCore();
  const projectRoot = options.projectRoot ?? process.cwd();
  let canonicalPath;
  let stateLocation;
  let store;
  // Validate authorization before taking any writer/view lock.
  const conversationAuthorization = options.conversationAuthorization
    ? await loadConversationAuthorization(options.conversationAuthorization, { statePath })
    : null;
  try {
    if (options.store) {
      store = options.store;
      canonicalPath =
        typeof store.statePath === 'string' && store.statePath !== ''
          ? store.statePath
          : path.resolve(statePath);
      stateLocation = computeStateLocation(canonicalPath, projectRoot);
    } else {
      // Compute the same canonical location and project-relative display path
      // before the store is opened. That exact value is passed as the trusted
      // decisionRecordPath so previewReview and applyReview write the same
      // decision_record.path as GET /api/state exposes. It is never client
      // input. State outside projectRoot falls back to a basename, explicitly
      // avoiding absolute paths in both the API and persisted evidence.
      const io = core.createIoAdapter(options.fs);
      const canonical = await core.canonicalizeStatePath(statePath, {
        io,
        mustExist: true,
      });
      canonicalPath = canonical.path;
      let locationRoot = path.resolve(projectRoot);
      try {
        // Prefer the real project root so a symlinked project directory still
        // yields a project-relative decisionRecordPath instead of a basename.
        locationRoot = await io.realpath(locationRoot);
      } catch {
        // Keep the resolved lexical root when the root cannot be resolved.
      }
      stateLocation = computeStateLocation(canonicalPath, locationRoot);
      store = await core.openStateStore(statePath, {
        actor: options.actor,
        clock: options.clock,
        idFactory: options.idFactory,
        domain: options.domain,
        fs: options.fs,
        hooks: options.hooks,
        maxStateBytes,
        maxQueue,
        port,
        decisionRecordPath: stateLocation,
        renderViews:
          options.renderViews !== undefined
            ? options.renderViews
            : ({ state }) => renderMap(state, language),
      });
    }
  } catch (error) {
    throw error;
  }

  const identityPath = canonicalIdentityPath(canonicalPath);
  const stateIdentity = `sha256:${createHash('sha256').update(identityPath).digest('hex')}`;
  let sessionCookieName = '';
  const sessionValue = randomBytes(32).toString('hex');
  const logger =
    typeof options.logger === 'function'
      ? options.logger
      : (entry) => console.error(JSON.stringify(entry));

  let expectedHost = '';
  let expectedOrigin = '';
  let closed = false;
  let closePromise = null;
  let rendererPromise;

  const queue = createSerialQueue(maxQueue);

  // Current-work preview handles (§10.2): process memory only, bounded by entry
  // count and held bytes, TTL, one table per service instance. Nothing here is
  // written to disk and a restart forgets every handle.
  const previews = new Map();
  let previewBytes = 0;
  let currentWorkModelPromise;

  function currentWorkNow() {
    try {
      const value = typeof options.clock === 'function' ? options.clock() : options.clock;
      if (value instanceof Date) return value.getTime();
      if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch {
      // A bad test clock must not wedge the route; fall back to real time.
    }
    return Date.now();
  }

  function currentWorkBuildOptions() {
    // The shared builder takes an ISO string (not a Date), so normalise here.
    let clock;
    try {
      const value = typeof options.clock === 'function' ? options.clock() : options.clock;
      if (typeof value === 'string' && Number.isFinite(Date.parse(value))) clock = value;
      else if (value instanceof Date) clock = value.toISOString();
    } catch {
      clock = undefined;
    }
    return clock === undefined
      ? { uuid: () => randomUUID() }
      : { clock, uuid: () => randomUUID() };
  }

  async function requireCurrentWorkModel() {
    if (options.currentWorkModel) return options.currentWorkModel;
    if (currentWorkModelPromise === undefined) {
      currentWorkModelPromise = import('./current-work-model.mjs').then(
        (module) => {
          if (currentWorkModelProblems(module).length) {
            throw new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable);
          }
          return module;
        },
        (error) => {
          if (
            error?.code === 'ERR_MODULE_NOT_FOUND' &&
            /current-work-model\.mjs/i.test(String(error.message))
          ) {
            throw new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable);
          }
          throw error;
        },
      );
    }
    return currentWorkModelPromise;
  }

  function requireCurrentWorkStore() {
    // The work write needs the file-backed store: its serial queue, lock,
    // `saveCurrentWork` staging/cache adoption, and a state path for the sidecar
    // root. An injected store is not silently trusted with that.
    if (
      options.store ||
      typeof store.saveCurrentWork !== 'function' ||
      typeof store.read !== 'function' ||
      typeof store.statePath !== 'string' ||
      store.statePath === ''
    ) {
      throw new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable);
    }
  }

  function currentWorkSidecarRoot() {
    // §7.2: `.product-continuity/current-work/<workKey>/…` is project-relative.
    // The state file normally lives in `<project>/.product-continuity/`, so the
    // project root is its parent; otherwise use the configured project root.
    const stateDir = path.dirname(path.resolve(store.statePath));
    if (path.basename(stateDir) === '.product-continuity') return path.dirname(stateDir);
    return path.resolve(projectRoot);
  }

  /**
   * §10.1: `/status` is read-only — no lock, no queue entry, no write. So it may
   * not use `readSnapshot()` either when that resolves to `store.read()`, which
   * enqueues and verifies the cooperative lock. This reads the bound canonical
   * path directly, bounded and fully validated, and touches no store state.
   *
   * An injected store owns its own bytes; it is never read through the
   * filesystem behind the test adapter's back, so it fails closed unless the
   * adapter explicitly exposes `readCurrentWorkStatus`.
   */
  async function currentWorkStatusSnapshot() {
    if (options.store) {
      if (typeof options.store.readCurrentWorkStatus === 'function') {
        return await options.store.readCurrentWorkStatus();
      }
      throw new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable);
    }
    try {
      return await core.readCurrentWorkStatusSnapshot(canonicalPath, {
        io: options.fs ? core.createIoAdapter(options.fs) : undefined,
        maxStateBytes,
      });
    } catch (error) {
      throw translateCurrentWorkStatusReadError(error);
    }
  }

  function prunePreviews() {
    const now = currentWorkNow();
    for (const [id, entry] of previews) {
      if (entry.expiresAtMs <= now) {
        previews.delete(id);
        previewBytes -= entry.bytes;
      }
    }
  }

  function rememberPreview(previewId, entry) {
    prunePreviews();
    if (entry.bytes > previewMaxBytes) {
      // A single binding cannot be held inside the byte cap; §10.2's table is
      // bounded, so refuse instead of storing something the cap forbids.
      throw new ServiceError('payload_too_large', 413, SAFE_MESSAGES.payload_too_large);
    }
    // Oldest first: Map keeps insertion order, so the first key is the oldest.
    // At either cap the oldest entry is dropped, so the table can only ever
    // answer `preview_expired`, never grow without bound.
    const overCount = () => previews.size >= previewMax;
    const overBytes = () => previewBytes + entry.bytes > previewMaxBytes;
    while (previews.size > 0 && (overCount() || overBytes())) {
      const oldest = previews.keys().next();
      if (oldest.done) break;
      const dropped = previews.get(oldest.value);
      previews.delete(oldest.value);
      previewBytes -= dropped.bytes;
    }
    previews.set(previewId, entry);
    previewBytes += entry.bytes;
  }

  function readPreviewSession(req) {
    const cookie = parseCookie(req, sessionCookieName);
    return cookie.present ? cookie.value : null;
  }

  function readPreviewBinding(previewId, session) {
    const entry = previews.get(previewId);
    if (!entry) return null;
    if (entry.expiresAtMs <= currentWorkNow()) {
      previews.delete(previewId);
      previewBytes -= entry.bytes;
      return null;
    }
    // A handle is bound to the session cookie value that minted it (§10.2).
    if (entry.session !== session) return null;
    return entry;
  }

  function claimPreview(binding, operationId) {
    if (binding.claimedBy !== null) {
      // §10.3 rule 8: only a *different* operationId is a consumption. The same
      // operationId continues to rule 9a, which decides replay vs key_conflict
      // from the saved receipt (the builder owns that comparison).
      if (binding.claimedBy !== operationId) {
        throw new ServiceError('preview_consumed', 409, SAFE_MESSAGES.preview_consumed);
      }
      return;
    }
    // Synchronous check-and-set: two saves cannot both claim this handle.
    binding.claimedBy = operationId;
  }

  function logAction(entry) {
    try {
      logger({
        reviewId: entry.reviewId ?? null,
        action: entry.action ?? null,
        target: entry.target ?? null,
        result: entry.result ?? null,
        phase: entry.phase ?? null,
      });
    } catch {
      // Logging must never affect the response.
    }
  }

  async function readSnapshot() {
    if (typeof store.read === 'function') return await store.read();
    if (typeof store.getSnapshot === 'function') return await store.getSnapshot();
    throw new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable);
  }

  async function withTimelineHistory(snapshot) {
    if (snapshot.state?.schemaVersion !== '0.2') return snapshot;
    // An injected store has no implied permission to inspect filesystem paths.
    if (options.store) return snapshot;
    const { readTimelineHistory } = await import('./timeline-history.mjs');
    const timelineHistory = await readTimelineHistory(canonicalPath, snapshot, { maxStateBytes });
    return { ...snapshot, timelineHistory };
  }

  function verifySession(req) {
    const cookie = parseCookie(req, sessionCookieName);
    if (!cookie.present) {
      throw new ServiceError('no_session', 403, SAFE_MESSAGES.no_session);
    }
    if (
      typeof cookie.value !== 'string' ||
      cookie.value.length !== sessionValue.length ||
      !/^[0-9a-f]+$/.test(cookie.value)
    ) {
      throw new ServiceError('no_session', 403, SAFE_MESSAGES.no_session);
    }
    const supplied = Buffer.from(cookie.value, 'utf8');
    const expected = Buffer.from(sessionValue, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ServiceError('no_session', 403, SAFE_MESSAGES.no_session);
    }
  }

  function assertKnownAction(body) {
    if (typeof body?.action === 'string' && !KNOWN_ACTIONS.has(body.action)) {
      throw new ServiceError('unknown_action', 400, SAFE_MESSAGES.unknown_action);
    }
  }

  function guardTransport(req) {
    const counts = headerCounts(req);
    const hostCount = counts.get('host') ?? 0;
    if (hostCount !== 1) {
      throw new ServiceError('bad_host', 403, SAFE_MESSAGES.bad_host, {
        closeConnection: true,
      });
    }
    if (req.headers.host !== expectedHost) {
      throw new ServiceError('bad_host', 403, SAFE_MESSAGES.bad_host);
    }
    for (const name of SENSITIVE_HEADERS) {
      if (name === 'host') continue;
      if ((counts.get(name) ?? 0) > 1) {
        throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
          closeConnection: true,
        });
      }
    }
    const origin = req.headers.origin;
    if (origin !== undefined && (typeof origin !== 'string' || origin !== expectedOrigin)) {
      throw new ServiceError('bad_origin', 403, SAFE_MESSAGES.bad_origin);
    }
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && String(fetchSite).toLowerCase() === 'cross-site') {
      throw new ServiceError('bad_origin', 403, SAFE_MESSAGES.bad_origin);
    }
  }

  function guardRoute(req, route) {
    if (route.originRequired) {
      if (req.headers.origin !== expectedOrigin) {
        throw new ServiceError('bad_origin', 403, SAFE_MESSAGES.bad_origin);
      }
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite !== undefined) {
        const value = String(fetchSite).toLowerCase();
        if (value !== 'same-origin' && value !== 'none') {
          throw new ServiceError('bad_origin', 403, SAFE_MESSAGES.bad_origin);
        }
      }
    }
    if (route.session) verifySession(req);
    if (route.actionRequired) {
      const actionHeader = req.headers['x-review-action'];
      if (actionHeader !== '1') {
        throw new ServiceError(
          'missing_action_header',
          403,
          SAFE_MESSAGES.missing_action_header,
        );
      }
    }
  }

  async function resolveRenderer() {
    if (options.renderReview === null) return null;
    if (typeof options.renderReview === 'function') return options.renderReview;
    if (rendererPromise === undefined) {
      rendererPromise = import('./render-review.mjs')
        .then((module) => {
          if (typeof module.renderReview !== 'function') {
            throw new ServiceError(
              'render_page_failed',
              500,
              'render-review.mjs does not export renderReview().',
            );
          }
          return module.renderReview;
        })
        .catch((error) => {
          if (
            error?.code === 'ERR_MODULE_NOT_FOUND' &&
            /render-review\.mjs/i.test(String(error.message))
          ) {
            return null;
          }
          throw new ServiceError(
            'render_page_failed',
            500,
            SAFE_MESSAGES.render_page_failed,
            { cause: error },
          );
        });
    }
    return rendererPromise;
  }

  async function handlePage(req, res, signal) {
    const snapshot = await withTimelineHistory(
      typeof store.getSnapshot === 'function'
        ? await store.getSnapshot()
        : await readSnapshot());
    if (signal.aborted || res.destroyed) return;
    const nonce = randomBytes(16).toString('base64');
    const schemaVersion = snapshot.schemaVersion ?? snapshot.state?.schemaVersion ?? null;
    let html;
    if (schemaVersion === '0.1') {
      // render-review.mjs deliberately accepts only 0.2 states. A 0.1 file is
      // always opened read-only by state-store, so render the explicit legacy
      // notice here and never invoke a 0.2-only renderer. Migration stays a
      // separate, manual step; this service never rewrites a 0.1 state.
      html = createFallbackPage({
        snapshot: rendererSnapshot(snapshot),
        nonce,
        stateLocation,
        stateIdentity,
        language,
        legacySchema01: true,
      });
    } else {
      const renderer = await resolveRenderer();
      if (typeof renderer === 'function') {
        html = await renderer(rendererSnapshot(snapshot), {
          nonce,
          stateLocation,
          stateIdentity,
          language,
        });
        if (typeof html !== 'string' || html.length === 0) {
          throw new ServiceError('render_page_failed', 500, SAFE_MESSAGES.render_page_failed);
        }
      } else {
        html = createFallbackPage({
          snapshot: rendererSnapshot(snapshot),
          nonce,
          stateLocation,
          stateIdentity,
          language,
        });
      }
    }
    if (signal.aborted || res.writableEnded || res.destroyed) return;
    setBaseHeaders(res);
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce));
    res.setHeader(
      'Set-Cookie',
      `${sessionCookieName}=${sessionValue}; HttpOnly; SameSite=Strict; Path=/`,
    );
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const bytes = Buffer.from(html, 'utf8');
    res.setHeader('Content-Length', String(bytes.byteLength));
    res.end(bytes);
  }

  async function handleState(req, res, signal) {
    const snapshot = await withTimelineHistory(await readSnapshot());
    if (signal.aborted || res.destroyed) return;
    sendJson(req, res, 200, publicState(snapshot, { stateIdentity, stateLocation }));
  }

  async function handleSnapshot(req, res, signal) {
    const params = new URLSearchParams(parseTarget(req).search);
    const keys = [...params.keys()];
    const version = params.get('version'), digest = params.get('digest');
    if (keys.length !== 2 || !keys.includes('version') || !keys.includes('digest') || !/^[1-9][0-9]{0,15}$/.test(version || '') || !Number.isSafeInteger(Number(version)) || !/^sha256:[0-9a-f]{64}$/.test(digest || '')) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request);
    }
    const snapshot = await readSnapshot();
    // Injected stores never imply permission to read adjacent filesystem paths.
    if (options.store || snapshot.state?.schemaVersion !== '0.2') {
      throw new ServiceError('snapshot_unavailable', 404, SAFE_MESSAGES.snapshot_unavailable);
    }
    const { readTimelineSnapshot } = await import('./timeline-history.mjs');
    const result = await readTimelineSnapshot(canonicalPath, snapshot, {stateVersion:Number(version), digest}, {maxStateBytes,signal});
    if (signal.aborted || res.destroyed) return;
    if (!result) throw new ServiceError('snapshot_unavailable', 404, SAFE_MESSAGES.snapshot_unavailable);
    sendJson(req, res, 200, {
      ok:true, state:result.state, sample:result.sample, fileDigest:digest,
      stateIdentity, writable:false, historical:true,
      currentStateVersion:snapshot.state.stateVersion,
      currentDigest:snapshot.fileDigest ?? snapshot.currentDigest,
    });
  }

  function handleHealth(req, res) {
    sendJson(req, res, 200, { ok: true });
  }

  async function handlePreview(req, res, signal, controller) {
    checkContentHeaders(req, maxBodyBytes);
    const body = await readJsonBody(req, res, controller, {
      maxBytes: maxBodyBytes,
      timeoutMs: bodyTimeoutMs,
    });
    assertKnownAction(body);
    const errors = core.validatePreviewRequest(body);
    if (errors.length) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
        details: { errors },
      });
    }
    const result = await queue.enqueue(() => {
      if (signal.aborted) {
        throw new ServiceError('client_aborted', 499, SAFE_MESSAGES.client_aborted, {
          noResponse: true,
        });
      }
      if (typeof store.preview !== 'function') {
        throw new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable);
      }
      return store.preview(body);
    }, signal);
    if (signal.aborted || res.destroyed) return;
    sendJson(req, res, 200, publicPreview(result));
  }

  async function handleReviews(req, res, signal, controller) {
    checkContentHeaders(req, maxBodyBytes);
    const body = await readJsonBody(req, res, controller, {
      maxBytes: maxBodyBytes,
      timeoutMs: bodyTimeoutMs,
    });
    assertKnownAction(body);
    const errors = core.validateReviewRequest(body);
    if (errors.length) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
        details: { errors },
      });
    }
    const action = body.action;
    const target = body.targetClaimId ?? body.targetProposalId ?? null;
    try {
      const result = await queue.enqueue(() => {
        if (signal.aborted) {
          throw new ServiceError('client_aborted', 499, SAFE_MESSAGES.client_aborted, {
            noResponse: true,
          });
        }
        if (typeof store.submitReview !== 'function') {
          throw new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable);
        }
        return store.submitReview(body);
      }, signal);
      logAction({
        reviewId: result?.reviewId ?? null,
        action,
        target,
        result: result?.outcome ?? 'saved',
        phase: 'submit',
      });
      if (signal.aborted || res.destroyed) return;
      sendJson(req, res, 200, publicSubmit(result));
    } catch (error) {
      logAction({
        reviewId: null,
        action,
        target,
        result: publicError(error).code,
        phase: 'submit',
      });
      throw error;
    }
  }

  async function handleRender(req, res, signal, controller) {
    checkContentHeaders(req, maxBodyBytes);
    const body = await readJsonBody(req, res, controller, {
      maxBytes: maxBodyBytes,
      timeoutMs: bodyTimeoutMs,
    });
    if (Object.keys(body).length !== 0) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request);
    }
    try {
      const result = await queue.enqueue(() => {
        if (signal.aborted) {
          throw new ServiceError('client_aborted', 499, SAFE_MESSAGES.client_aborted, {
            noResponse: true,
          });
        }
        if (typeof store.regenerateView === 'function') return store.regenerateView();
        if (typeof store.renderView === 'function') return store.renderView();
        throw new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable);
      }, signal);
      logAction({
        reviewId: null,
        action: 'render_view',
        target: null,
        result: result?.viewStatus?.status ?? 'rendered',
        phase: 'render',
      });
      if (signal.aborted || res.destroyed) return;
      sendJson(req, res, 200, publicRender(result));
    } catch (error) {
      logAction({
        reviewId: null,
        action: 'render_view',
        target: null,
        result: publicError(error).code,
        phase: 'render',
      });
      throw error;
    }
  }

  async function handleCurrentWorkPreview(req, res, signal, controller) {
    checkContentHeaders(req, maxBodyBytes);
    const body = await readJsonBody(req, res, controller, {
      maxBytes: maxBodyBytes,
      timeoutMs: bodyTimeoutMs,
    });
    requireCurrentWorkStore();
    const model = await requireCurrentWorkModel();
    // §10.2 is read-only: no lock of its own, no staging, no write. It reuses
    // the same fresh read `/api/state` performs.
    const snapshot = await readSnapshot();
    if (signal.aborted || res.destroyed) return;
    const state = snapshot.state;
    // §10.2 mirrors §10.3 rule 2: the bound project is checked before shape.
    if (body.projectId !== (state?.project?.id ?? null)) {
      throw new ServiceError('wrong_project', 403, SAFE_MESSAGES.wrong_project);
    }
    const shapeErrors = currentWorkPreviewRequestErrors(body);
    if (shapeErrors.length) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
        details: { errors: shapeErrors },
      });
    }
    // Same stable code as the save path: an operation outside §3 is its own
    // failure, not a generic content error.
    if (!model.CURRENT_WORK_OPERATIONS.includes(body.content?.operation)) {
      throw new ServiceError('unknown_work_operation', 400, SAFE_MESSAGES.unknown_work_operation);
    }
    const digest = snapshot.fileDigest ?? snapshot.currentDigest ?? null;
    if (!isDigestString(digest)) {
      // Without the exact bytes there is no binding to hold; never guess one.
      throw new ServiceError('store_unavailable', 503, SAFE_MESSAGES.store_unavailable);
    }
    // A dry run through the same pure builder: it validates the content,
    // resolves the upper layers and produces the record preview. Nothing is
    // written — no state, no backup, no sidecar, no preview file.
    const built = model.buildCurrentWorkWrite(state, body.content, {
      digest,
      dryRun: true,
      ...currentWorkBuildOptions(),
    });
    if (!built.ok) throw currentWorkServiceError(built);
    const previewContentDigest = built.previewContentDigest;
    if (!isDigestString(previewContentDigest) || typeof built.workId !== 'string') {
      throw new ServiceError('not_committed', 500, SAFE_MESSAGES.not_committed);
    }
    // The binding holds the content *with the minted workId* so the save
    // rebuilds the same normalized content (§10.2 binding, §10.3 9c).
    const boundContent = { ...structuredClone(body.content), workId: built.workId };
    const heldBytes = Buffer.byteLength(JSON.stringify(boundContent), 'utf8');
    const expiresAtMs = currentWorkNow() + previewTtlMs;
    const previewId = `preview:${randomUUID()}`;
    rememberPreview(previewId, {
      projectId: body.projectId,
      stateVersion: snapshot.stateVersion ?? state.stateVersion,
      digest,
      content: boundContent,
      previewContentDigest,
      session: readPreviewSession(req),
      expiresAtMs,
      bytes: heldBytes,
      claimedBy: null,
    });
    if (signal.aborted || res.destroyed) return;
    sendJson(req, res, 200, {
      ok: true,
      previewId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      workId: built.workId,
      operation: built.operation ?? boundContent.operation ?? null,
      previewContentDigest,
      recordPreview: built.recordPreview ?? null,
      // The receipt row is planned, not created: it will point at the one
      // record in `recordPreview`, whose id is null until commit.
      receiptPreview: { source: 'local_feature_checkpoint', addedFeatureCheckpointIds: [null] },
      diff: Array.isArray(built.diff) ? built.diff : [],
      sidecarPlan: Array.isArray(built.sidecarPlan) ? built.sidecarPlan : [],
      notes: [],
    });
  }

  async function handleCurrentWorkSave(req, res, signal, controller) {
    checkContentHeaders(req, maxBodyBytes);
    const body = await readJsonBody(req, res, controller, {
      maxBytes: maxBodyBytes,
      timeoutMs: bodyTimeoutMs,
    });
    requireCurrentWorkStore();
    const model = await requireCurrentWorkModel();
    const snapshot = await readSnapshot();
    if (signal.aborted || res.destroyed) return;
    // §10.3 rule 2 runs before rule 3: a wrong project is a 403 even when the
    // rest of the body is also wrong.
    if (body.projectId !== (snapshot.state?.project?.id ?? null)) {
      throw new ServiceError('wrong_project', 403, SAFE_MESSAGES.wrong_project);
    }
    const shapeErrors = currentWorkSaveRequestErrors(body);
    if (shapeErrors.length) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
        details: { errors: shapeErrors },
      });
    }
    // Rules 4-8 are read-only checks against the in-memory binding; the state
    // is not re-read for them, and the authoritative CAS is rule 9b.
    const binding = readPreviewBinding(body.previewId, readPreviewSession(req));
    if (!binding) {
      throw new ServiceError('preview_expired', 410, SAFE_MESSAGES.preview_expired);
    }
    if (
      binding.projectId !== body.projectId ||
      binding.stateVersion !== body.expectedStateVersion ||
      binding.digest !== body.expectedDigest
    ) {
      throw new ServiceError('preview_stale', 409, SAFE_MESSAGES.preview_stale, {
        details: {
          currentStateVersion: snapshot.stateVersion ?? null,
          currentDigest: snapshot.fileDigest ?? null,
        },
      });
    }
    if (binding.previewContentDigest !== body.previewContentDigest) {
      throw new ServiceError('payload_mismatch', 409, SAFE_MESSAGES.payload_mismatch);
    }
    if (!model.CURRENT_WORK_OPERATIONS.includes(binding.content?.operation)) {
      throw new ServiceError('unknown_work_operation', 400, SAFE_MESSAGES.unknown_work_operation);
    }
    if (typeof model.validateCurrentWorkWrite === 'function') {
      try {
        model.validateCurrentWorkWrite(binding.content);
      } catch (error) {
        throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request, {
          cause: error,
          details: { errors: limitErrors(error?.details?.errors) },
        });
      }
    }
    claimPreview(binding, body.operationId);

    let result;
    try {
      result = await queue.enqueue(async () => {
        if (signal.aborted) {
          throw new ServiceError('client_aborted', 499, SAFE_MESSAGES.client_aborted, {
            noResponse: true,
          });
        }
        return await store.saveCurrentWork({
          build: (state, context) => {
            // The bound content, never anything from the request body (§10.4).
            const built = model.buildCurrentWorkWrite(state, binding.content, {
              digest: context.digest,
              projectId: body.projectId,
              operationId: body.operationId,
              authorizationRef: body.authorizationRef,
              expectedStateVersion: body.expectedStateVersion,
              expectedDigest: body.expectedDigest,
              previewContentDigest: binding.previewContentDigest,
              ...currentWorkBuildOptions(),
            });
            if (!built.ok) {
              // The builder already ran rule 9a (replay / key_conflict /
              // external_modification) before its own CAS, so a refusal here is
              // final and nothing was written.
              const failure = currentWorkServiceError(built);
              return {
                ok: false,
                code: failure.code,
                status: failure.status,
                message: failure.message,
                details: failure.details,
              };
            }
            if (built.replayed === true) {
              // The store returns this value verbatim; keep the builder's own
              // result shape so §11.1 reads the receipt from one place only.
              return built;
            }
            // One level, not two: the store calls this whole value `built`, so
            // nesting the builder result under `built` would hide the receipt.
            return {
              ...built,
              verify: (committedState) => currentWorkVerifyProblems(committedState, built),
            };
          },
          sidecarRoot: currentWorkSidecarRoot(),
        });
      }, signal);
    } catch (error) {
      throw translateCurrentWorkStoreError(error);
    }
    if (signal.aborted || res.destroyed) return;
    // §11.1 reports what this request observed: the store's own readback after
    // a commit, or the bytes it just read on a replay.
    sendJson(
      req,
      res,
      200,
      publicCurrentWorkSave(result, {
        liveState: result?.state ?? null,
        liveDigest: isDigestString(result?.digest) ? result.digest : null,
        liveStateVersion: Number.isSafeInteger(result?.stateVersion) ? result.stateVersion : null,
      }),
    );
  }

  async function handleCurrentWorkStatus(req, res, signal) {
    const model = await requireCurrentWorkModel();
    const params = new URLSearchParams(parseTarget(req).search);
    const keys = [...params.keys()];
    if (
      keys.length === 0 ||
      keys.some((key) => key !== 'workId' && key !== 'operationId') ||
      new Set(keys).size !== keys.length
    ) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request);
    }
    const workId = params.get('workId');
    const operationId = params.get('operationId');
    if (workId !== null && !WORK_ID_PATTERN.test(workId)) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request);
    }
    if (operationId !== null && !isBoundedText(operationId, 160)) {
      throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request);
    }
    const snapshot = await currentWorkStatusSnapshot();
    if (signal.aborted || res.destroyed) return;
    // Read-only: no expected version, no queue slot of its own, no write. The
    // same lookup rule 9a performs answers "did this operation commit?".
    const replay =
      operationId === null
        ? null
        : model.resolveCurrentWorkReplay(snapshot.state, {
            operationId,
            workId: workId ?? undefined,
          });
    sendJson(
      req,
      res,
      200,
      publicCurrentWorkStatus(
        snapshot.state,
        snapshot.fileDigest ?? snapshot.currentDigest ?? null,
        snapshot.stateVersion ?? snapshot.state?.stateVersion ?? null,
        { workId, operationId },
        replay,
      ),
    );
  }

  const routes = new Map([
    [
      '/',
      {
        allow: 'GET',
        session: false,
        originRequired: false,
        actionRequired: false,
        queryAllowed: true,
        handler: handlePage,
      },
    ],
    [
      '/api/state',
      {
        allow: 'GET',
        session: true,
        originRequired: false,
        actionRequired: false,
        queryAllowed: false,
        handler: handleState,
      },
    ],
    [
      '/api/snapshot',
      {
        allow: 'GET',
        session: true,
        originRequired: false,
        actionRequired: false,
        queryAllowed: true,
        handler: handleSnapshot,
      },
    ],
    [
      '/api/health',
      {
        allow: 'GET',
        session: false,
        originRequired: false,
        actionRequired: false,
        queryAllowed: false,
        handler: handleHealth,
      },
    ],
    [
      '/api/preview',
      {
        allow: 'POST',
        session: true,
        originRequired: true,
        actionRequired: true,
        queryAllowed: false,
        handler: handlePreview,
      },
    ],
    [
      '/api/reviews',
      {
        allow: 'POST',
        session: true,
        originRequired: true,
        actionRequired: true,
        queryAllowed: false,
        handler: handleReviews,
      },
    ],
    [
      '/api/render',
      {
        allow: 'POST',
        session: true,
        originRequired: true,
        actionRequired: true,
        queryAllowed: false,
        handler: handleRender,
      },
    ],
    // Current work (§10.1): same server, port, origin policy and queue.
    [
      '/api/current-work/preview',
      {
        allow: 'POST',
        session: true,
        originRequired: true,
        actionRequired: true,
        queryAllowed: false,
        handler: handleCurrentWorkPreview,
      },
    ],
    [
      '/api/current-work/save',
      {
        allow: 'POST',
        session: true,
        originRequired: true,
        actionRequired: true,
        queryAllowed: false,
        handler: handleCurrentWorkSave,
      },
    ],
    [
      '/api/current-work/status',
      {
        allow: 'GET',
        session: true,
        originRequired: false,
        actionRequired: false,
        queryAllowed: true,
        handler: handleCurrentWorkStatus,
      },
    ],
  ]);

  // Separate from the human review cookie and endpoints: possession of this
  // adapter credential authorizes capture only, never confirmation actions.
  if (options.conversationAuthorization) {
    const initialAuthorization = conversationAuthorization;
    if (initialAuthorization.projectId !== store.getSnapshot().state.project.id) {
      await store.close();
      throw new ServiceError('wrong_project', 403, SAFE_MESSAGES.wrong_project);
    }
    const handleConversation = (purpose) => async (req, res, signal, controller) => {
      checkContentHeaders(req, maxBodyBytes);
      const body = await readJsonBody(req, res, controller, { maxBytes: maxBodyBytes, timeoutMs: bodyTimeoutMs });
      const authorization = await loadConversationAuthorization(options.conversationAuthorization, { statePath: canonicalPath, projectId: initialAuthorization.projectId, serviceUrl: expectedOrigin });
      verifyConversationSignature(authorization, purpose, body, req.headers['x-conversation-signature']);
      if (purpose === 'context') {
        if (Object.keys(body).length !== 1 || body.projectId !== authorization.projectId) throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request);
        const snapshot = await readSnapshot();
        sendJson(req, res, 200, { ok: true, projectId: authorization.projectId, stateVersion: snapshot.state.stateVersion, digest: snapshot.fileDigest ?? snapshot.currentDigest });
        return;
      }
      if (Object.keys(body).length !== 2 || !body.request || !Array.isArray(body.verifiedSources) || body.request.projectId !== authorization.projectId) throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request);
      const result = await queue.enqueue(() => store.captureConversation(body.request, { verifiedSources: body.verifiedSources, authorizationId: authorization.authorizationId }), signal);
      if (!signal.aborted && !res.destroyed) sendJson(req, res, 200, result);
    };
    for (const purpose of ['context', 'capture']) routes.set(`/api/conversation/${purpose}`, { allow: 'POST', session: false, originRequired: false, actionRequired: false, queryAllowed: false, handler: handleConversation(purpose) });
  }

  async function handleRequest(req, res) {
    const controller = new AbortController();
    const signal = controller.signal;
    const onRequestAborted = () => controller.abort();
    const onResponseClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('aborted', onRequestAborted);
    res.on('close', onResponseClose);
    try {
      guardTransport(req);
      if (req.method === 'OPTIONS' || req.method === 'TRACE') {
        let pathname = null;
        try {
          pathname = parseTarget(req).pathname;
        } catch {
          // OPTIONS * and other non-path targets are rejected with 405 below.
        }
        const route = pathname ? routes.get(pathname) : null;
        sendJson(
          req,
          res,
          405,
          {
            ok: false,
            code: 'method_not_allowed',
            commitStatus: 'not_committed',
            error: {
              code: 'method_not_allowed',
              message: SAFE_MESSAGES.method_not_allowed,
            },
          },
          { allow: route?.allow ?? 'GET, POST' },
        );
        return;
      }
      const target = parseTarget(req);
      const route = routes.get(target.pathname);
      if (!route) {
        throw new ServiceError('not_found', 404, SAFE_MESSAGES.not_found);
      }
      if (req.method !== route.allow) {
        sendJson(
          req,
          res,
          405,
          {
            ok: false,
            code: 'method_not_allowed',
            commitStatus: 'not_committed',
            error: {
              code: 'method_not_allowed',
              message: SAFE_MESSAGES.method_not_allowed,
            },
          },
          { allow: route.allow },
        );
        return;
      }
      if (!route.queryAllowed && target.search !== '') {
        throw new ServiceError('invalid_request', 400, SAFE_MESSAGES.invalid_request);
      }
      guardRoute(req, route);
      await route.handler(req, res, signal, controller);
    } finally {
      req.off('aborted', onRequestAborted);
      res.off('close', onResponseClose);
    }
  }

  const server = http.createServer((req, res) => {
    try {
      void handleRequest(req, res).catch((error) => {
        try {
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            respondError(req, res, error);
          } else if (!res.destroyed) {
            res.destroy();
          }
        } catch {
          try {
            req.socket.destroy();
          } catch {
            // Nothing else to clean up.
          }
        }
      });
    } catch (error) {
      try {
        respondError(req, res, error);
      } catch {
        try {
          req.socket.destroy();
        } catch {
          // Nothing else to clean up.
        }
      }
    }
  });

  server.headersTimeout = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  server.requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = options.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = DEFAULT_MAX_HEADERS;
  // Make slow/incomplete request handling take effect close to the configured
  // deadlines instead of waiting for the next coarse Node timer tick.
  server.connectionsCheckingInterval = 1000;

  server.on('clientError', (error, socket) => {
    try {
      if (!socket.writable || socket.destroyed) {
        socket.destroy();
        return;
      }
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
    } catch {
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    }
  });
  server.on('connect', (req, socket) => {
    try {
      socket.end('HTTP/1.1 405 Method Not Allowed\r\nAllow: GET\r\nConnection: close\r\n\r\n');
    } catch {
      socket.destroy();
    }
  });
  server.on('upgrade', (req, socket) => {
    try {
      socket.end('HTTP/1.1 405 Method Not Allowed\r\nAllow: GET\r\nConnection: close\r\n\r\n');
    } catch {
      socket.destroy();
    }
  });
  server.on('connection', (socket) => {
    socket.on('error', () => {
      // A broken client must not crash the review service.
    });
  });

  const listen = () =>
    new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

  try {
    await listen();
  } catch (error) {
    if (typeof store.close === 'function') {
      try {
        await store.close();
      } catch {
        // Releasing the lock is the store's job; preserve the original error.
      }
    }
    const code = error?.code === 'EADDRINUSE' ? 'port_unavailable' : 'startup_failed';
    throw new ServiceError(code, 503, `${SAFE_MESSAGES[code]} (${error?.code ?? 'listen'})`, {
      cause: error,
    });
  }

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  expectedHost = `127.0.0.1:${actualPort}`;
  expectedOrigin = `http://${expectedHost}`;
  sessionCookieName = `pc_review_${createHash('sha256')
    .update(`${expectedHost}\n${identityPath}`)
    .digest('hex')
    .slice(0, 16)}`;
  server.on('error', () => {
    // Runtime socket errors are handled per request; keep the process alive.
  });

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (closed) return { serverClosed: true, storeClosed: false, alreadyClosed: true };
      closed = true;
      queue.close();
      const result = { serverClosed: false, storeClosed: false, alreadyClosed: false };
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            server.closeAllConnections?.();
          } catch {
            // Best effort.
          }
          finish();
        }, options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
        try {
          server.close(() => finish());
          server.closeIdleConnections?.();
        } catch {
          finish();
        }
      });
      result.serverClosed = true;
      if (typeof store.close === 'function') {
        try {
          const closedStore = await store.close();
          result.storeClosed = closedStore?.released !== false;
        } catch (error) {
          result.storeClosed = false;
          result.storeError = typeof error?.code === 'string' ? error.code : 'close_failed';
        }
      }
      return result;
    })();
    return closePromise;
  }

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    server,
    store,
    close,
  };
}

function parseArgs(argv) {
  const args = { statePath: null, port: DEFAULT_PORT, maxStateBytes: DEFAULT_MAX_STATE_BYTES, language: 'zh-CN' };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      args.help = true;
      continue;
    }
    if (argument.startsWith('--')) {
      const equalsIndex = argument.indexOf('=');
      const name = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
      let value = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
      if (value === undefined) {
        value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`Missing value for ${name}.`);
        }
        index += 1;
      }
      if (name === '--port') {
        if (!/^\d+$/.test(value)) throw new Error('--port must be an integer.');
        args.port = Number(value);
      } else if (name === '--max-state-bytes') {
        if (!/^\d+$/.test(value)) throw new Error('--max-state-bytes must be an integer.');
        args.maxStateBytes = Number(value);
      } else if (name === '--language') {
        if (!SUPPORTED_LANGUAGES.has(value)) {
          throw new Error('--language must be zh-CN or en.');
        }
        args.language = value;
      } else if (name === '--conversation-authorization') {
        args.conversationAuthorization = value;
      } else {
        throw new Error(`Unknown option ${name}; --force is not supported.`);
      }
      continue;
    }
    positionals.push(argument);
  }
  if (args.help) return args;
  if (positionals.length !== 1) {
    throw new Error('Usage: node scripts/review-service.mjs <state.json> [--port N] [--max-state-bytes N] [--language zh-CN|en] [--conversation-authorization <file>]');
  }
  args.statePath = positionals[0];
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    throw new Error('--port must be between 0 and 65535.');
  }
  if (!Number.isSafeInteger(args.maxStateBytes) || args.maxStateBytes < 1) {
    throw new Error('--max-state-bytes must be a positive integer.');
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[review-service] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(
      'Usage: node scripts/review-service.mjs <state.json> [--port N] [--max-state-bytes N] [--language zh-CN|en] [--conversation-authorization <file>]',
    );
    return;
  }

  let service;
  try {
    service = await startReviewService(args.statePath, {
      port: args.port,
      maxStateBytes: args.maxStateBytes,
      language: args.language,
      conversationAuthorization: args.conversationAuthorization,
    });
  } catch (error) {
    console.error(
      `[review-service] ${error?.code ?? 'startup_failed'}: ${error?.message ?? 'startup failed'}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Review service: ${service.url}`);
  console.log(
    `State limit: ${args.maxStateBytes} bytes; language: ${args.language}; loopback only.`,
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[review-service] ${signal}: closing`);
    try {
      const result = await service.close();
      if (!result.storeClosed && result.storeError) {
        console.error(`[review-service] store close: ${result.storeError}`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`[review-service] close failed: ${error?.code ?? 'close_failed'}`);
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGBREAK', () => void shutdown('SIGBREAK'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
