/**
 * Opt-in MCP maintenance tools.
 *
 * The server imports this module for tool metadata, but the maintenance tools
 * are advertised and callable only when it is started with an explicit write
 * opt-in and a fixed, project-contained authorization file. Without both, the
 * server keeps exposing exactly the three read-only tools.
 *
 * Honest boundary:
 * - A model/tool argument (`authorized: true`, `approved: true`, an
 *   authorizationRef string or any value returned by preview) is not human
 *   confirmation. This layer does not accept such fields.
 * - The one-time grant is a local file created out of band, normally by a human
 *   running `scripts/authorize-maintenance.mjs` after reading the preview diff.
 *   It is a cooperative local human-review bridge, not cryptographic proof and
 *   not isolation from a malicious local process that can write the same file.
 * - The grant and its consumption marker are operational artifacts. They never
 *   create or modify `decisions`, `reviews`, `intentClaims`, `proposals`,
 *   `roadmapItems`, `featureCheckpoints`, `baselines`, `project` or migration
 *   metadata.
 * - Apply reuses the maintenance store transaction (cooperative lock, exact
 *   raw-byte backup, full validation and post-write readback). It never forces
 *   or removes a live service lock and never stops a service.
 */

import { constants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { canonicalStringify } from './intent-model.mjs';
import { DEFAULT_MCP_LIMITS, McpContextError, readBoundProjectState } from './mcp-context.mjs';
import { applyMapMaintenance, prepareMaintenanceTransition } from './maintain-map.mjs';
import { StoreError, sha256Bytes } from './state-store.mjs';

export const MAINTENANCE_TOOL_NAMES = Object.freeze(['maintenance_preview', 'maintenance_apply']);

export const MAINTENANCE_LIMITS = Object.freeze({
  maxPlanBytes: 48 * 1024,
  maxResponseBytes: 512 * 1024,
  maxDiffBytes: 256 * 1024,
  maxNodes: 50,
  maxEdges: 100,
  maxEvidence: 100,
  maxChecks: 50,
  maxGrantBytes: 8 * 1024,
  maxTextLength: 8000,
  maxSummaryLength: 2000,
  maxOperationIdLength: 160,
  maxProjectIdLength: 200,
  maxSelectorLength: 200,
  maxIdsPerRecord: 100,
  maxGrantTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxValidationErrors: 20,
});

export const MAINTENANCE_GRANT_FORMAT = 'product-continuity.maintenance-authorization/1';
export const MAINTENANCE_GRANT_FIELDS = Object.freeze([
  'format',
  'grantId',
  'projectId',
  'operationId',
  'planDigest',
  'expectedStateVersion',
  'expectedDigest',
  'approvalSource',
  'approvedBy',
  'approvedAt',
  'expiresAt',
  'oneTime',
]);

const GRANT_KEYS = new Set(MAINTENANCE_GRANT_FIELDS);
const APPROVAL_SOURCES = new Set(['host_shell', 'host_cli', 'manual_file']);
const PLAN_KEYS = ['projectId', 'operationId', 'expectedStateVersion', 'expectedDigest', 'summary', 'changes'];
const CHANGE_KEYS = ['nodes', 'edges', 'evidence', 'checks'];
const NODE_KEYS = new Set(['id', 'kind', 'label', 'description', 'status', 'conditions', 'evidenceIds', 'legacy']);
const NEW_NODE_KEYS = new Set(['id', 'kind', 'label', 'description', 'status', 'evidenceIds']);
const EDGE_KEYS = new Set(['id', 'from', 'to', 'kind', 'evidenceIds']);
const EVIDENCE_KEYS = new Set([
  'id',
  'kind',
  'claim',
  'revision',
  'path',
  'locator',
  'validation',
  'observedAt',
  'excerpt',
]);
const CHECK_KEYS = new Set(['id', 'createdAt', 'baselineId', 'base', 'head', 'taskIntent', 'scope', 'findings']);
const NODE_KINDS = new Set([
  'product_goal',
  'user_group',
  'user_task',
  'capability',
  'behavior_commitment',
  'business_object',
  'implementation',
  'verification',
  'unknown',
]);
const INTENT_KINDS = new Set([
  'product_goal',
  'user_group',
  'user_task',
  'capability',
  'behavior_commitment',
  'business_object',
]);
const ANNOTATION_KINDS = new Set(['implementation', 'verification', 'unknown']);
const EDGE_KINDS = new Set(['implemented_by', 'verified_by', 'depends_on']);
const SCHEMA_EDGE_KINDS = new Set([
  'contains',
  'serves',
  'enables',
  'constrains',
  'implemented_by',
  'verified_by',
  'depends_on',
  'supersedes',
  'conflicts_with',
  'derived_from',
  'part_of',
]);
const EVIDENCE_KINDS = new Set(['implementation', 'test_definition', 'test_execution', 'runtime_observation']);
const NODE_STATUSES = new Set(['candidate', 'confirmed', 'observed', 'unknown', 'retired']);
const EVIDENCE_VALIDATIONS = new Set([
  'not_applicable',
  'not_run',
  'defined_only',
  'passed',
  'failed',
  'observed',
]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GRANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const MAX_STATE_BYTES = DEFAULT_MCP_LIMITS.maxStateBytes;
const MAX_GRANT_SKEW_MS = 5 * 60 * 1000;
const RECEIPT_SAFETY_MARGIN_BYTES = 2048;

const SAFE_STORE_MESSAGES = Object.freeze({
  state_not_found: 'The bound project state file does not exist.',
  state_unreadable: 'The bound project state file cannot be read safely.',
  state_not_file: 'The bound state path is not a regular file.',
  hardlink_state: 'The state file has multiple hard links; writes are stopped.',
  state_too_large: 'The state file exceeds the configured byte limit.',
  invalid_utf8: 'The state file is not valid UTF-8.',
  invalid_state: 'The state file is not valid JSON or failed validation.',
  state_validation_failed: 'The current or proposed state failed full schema, reference or intent validation.',
  unsupported_schema: 'The state schemaVersion is not supported for maintenance.',
  maintenance_read_only: 'MCP maintenance writes require the strict 0.2 schema; this server never migrates.',
  project_mismatch: 'The plan or state belongs to a different project than the bound projectId.',
  stale_maintenance_plan: 'The state version or raw-byte digest changed; create a new preview and authorization.',
  maintenance_key_conflict: 'operationId was already used with different plan content.',
  maintenance_intent_boundary: 'The plan would change protected product intent or an immutable node field.',
  maintenance_history_boundary: 'The plan would rewrite or remove an existing record.',
  maintenance_relation_boundary: 'The plan would add a relation outside the narrow MCP maintenance allowlist.',
  maintenance_unknown_boundary: 'The plan would close, relabel or otherwise change an existing unknown node.',
  empty_maintenance_plan: 'The plan contains no changed record; no version was created.',
  lock_held: 'The state is locked by another process, such as the review service. Stop it normally and retry; this server will not force or remove the lock.',
  lock_failed: 'The state lock could not be acquired.',
  lock_lost: 'State lock ownership was lost before the write; the state was not replaced by this request.',
  external_modification: 'The state changed outside this transaction; the write was stopped.',
  backup_failed: 'The exact original-byte backup could not be prepared; the main state was not replaced.',
  prepare_failed: 'The proposed state could not be staged and validated; the main state was not replaced.',
  replace_failed_preserved: 'The replacement failed and the original state was preserved.',
  write_unverified: 'The state was replaced but the post-write verification failed; inspect before retrying.',
  commit_unknown: 'The replacement result cannot be determined; stop and inspect the state file, backup and temporary output.',
  invalid_maintenance_plan: 'The maintenance plan is not in the strict expected shape.',
  invalid_maintenance_clock: 'The maintenance clock is invalid.',
  dependency_unavailable: 'Schema validation dependencies are unavailable.',
  invalid_path: 'The configured path is invalid.',
  unc_path: 'UNC/device paths are not supported.',
  state_path_changed: 'The bound state path no longer has its original project-contained identity.',
  state_changed: 'The state changed while it was being read; retry with a fresh preview.',
  state_outside_project_root: 'The state path is outside the bound project root.',
});

/**
 * Stable maintenance error. It always carries an explicit commit status and an
 * authorization status so a caller cannot mistake a rejected authorization for
 * a failed or successful write.
 */
export class McpMaintenanceError extends McpContextError {
  constructor(code, message, options = {}) {
    super(code, message, options.details ?? {});
    this.name = 'McpMaintenanceError';
    this.commitStatus = typeof options.commitStatus === 'string' ? options.commitStatus : 'not_committed';
    this.authorizationStatus = typeof options.authorizationStatus === 'string'
      ? options.authorizationStatus
      : null;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasControlCharacters(value) {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isUncOrDevicePath(value) {
  return /^\\\\/.test(value) || /^\/\//.test(value);
}

function isOutsideRelative(relative) {
  return (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    relative.startsWith('../') ||
    path.isAbsolute(relative)
  );
}

function fail(code, message, options = {}) {
  throw new McpMaintenanceError(code, message, options);
}

function requireText(value, label, maxLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    fail(
      'invalid_arguments',
      `${label} must be a non-empty string of at most ${maxLength} characters without leading/trailing whitespace or control characters.`,
    );
  }
  return value;
}

function requireString(value, label, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength || hasControlCharacters(value)) {
    fail(
      'invalid_arguments',
      `${label} must be a string of at most ${maxLength} characters without control characters.`,
    );
  }
  return value;
}

function requireId(value, label, maxLength) {
  return requireText(value, label, maxLength);
}

function requireNonEmptyString(value, label, maxLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    hasControlCharacters(value)
  ) {
    fail(
      'invalid_arguments',
      `${label} must be a non-empty string of at most ${maxLength} characters without control characters.`,
    );
  }
  return value;
}

function requireStringArray(value, label, options = {}) {
  if (!Array.isArray(value)) fail('invalid_arguments', `${label} must be an array of strings.`);
  if (value.length > (options.maxItems ?? MAINTENANCE_LIMITS.maxIdsPerRecord)) {
    fail('invalid_arguments', `${label} has too many entries.`);
  }
  const seen = new Set();
  return value.map((item, index) => {
    const text = requireString(item, `${label}[${index}]`, options.maxLength ?? MAINTENANCE_LIMITS.maxSelectorLength);
    if (seen.has(text)) fail('invalid_arguments', `${label} must not contain duplicate entries.`);
    seen.add(text);
    return text;
  });
}

function requireExactKeys(value, allowed, label, options = {}) {
  if (!isRecord(value)) fail('invalid_arguments', `${label} must be an object.`);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    fail(
      'invalid_arguments',
      `${label} has fields outside the narrow MCP maintenance schema.`,
      { details: { field: extra[0] } },
    );
  }
  for (const key of options.required ?? []) {
    if (!Object.hasOwn(value, key)) fail('invalid_arguments', `${label}.${key} is required.`);
  }
}

function requireIsoTime(value, label) {
  if (typeof value !== 'string' || value.length > 80) {
    fail('invalid_arguments', `${label} must be an ISO date-time string.`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('invalid_arguments', `${label} must be an ISO date-time string.`);
  return ms;
}

function normaliseMaintenanceLimits(overrides) {
  const limits = { ...MAINTENANCE_LIMITS };
  if (overrides === undefined || overrides === null) return limits;
  if (!isRecord(overrides)) fail('invalid_server_option', 'Maintenance limits must be an object.');
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(MAINTENANCE_LIMITS, key)) {
      fail('invalid_server_option', 'An unknown maintenance limit was supplied.', { details: { limit: key } });
    }
    if (!Number.isInteger(value) || value <= 0) {
      fail('invalid_server_option', 'Maintenance limits must be positive integers.', { details: { limit: key } });
    }
    limits[key] = value;
  }
  return limits;
}

function nowMsOf(options = {}) {
  const clock = options.clock;
  const value = clock === undefined
    ? Date.now()
    : (typeof clock === 'function' ? clock() : clock);
  const ms = typeof value === 'number'
    ? value
    : value instanceof Date
      ? value.getTime()
      : Date.parse(value);
  if (!Number.isFinite(ms)) fail('invalid_maintenance_clock', 'The maintenance clock is invalid.');
  return ms;
}

function validateNodeInput(node, index) {
  requireExactKeys(node, NODE_KEYS, `changes.nodes[${index}]`, {
    required: ['id', 'kind', 'label', 'status', 'evidenceIds'],
  });
  requireId(node.id, `changes.nodes[${index}].id`, MAINTENANCE_LIMITS.maxSelectorLength);
  if (typeof node.kind !== 'string' || !NODE_KINDS.has(node.kind)) {
    fail('invalid_arguments', `changes.nodes[${index}].kind is not a recognized node kind.`);
  }
  requireNonEmptyString(node.label, `changes.nodes[${index}].label`, MAINTENANCE_LIMITS.maxTextLength);
  if (node.description !== undefined) {
    requireString(node.description, `changes.nodes[${index}].description`, MAINTENANCE_LIMITS.maxTextLength);
  }
  if (typeof node.status !== 'string' || !NODE_STATUSES.has(node.status)) {
    fail('invalid_arguments', `changes.nodes[${index}].status is not a recognized node status.`);
  }
  if (node.conditions !== undefined) {
    requireStringArray(node.conditions, `changes.nodes[${index}].conditions`, {
      maxItems: 50,
      maxLength: 2000,
    });
  }
  requireStringArray(node.evidenceIds, `changes.nodes[${index}].evidenceIds`);
  if (node.legacy !== undefined && !isRecord(node.legacy)) {
    fail('invalid_arguments', `changes.nodes[${index}].legacy must be an object when provided.`);
  }
}

function validateEdgeInput(edge, index) {
  requireExactKeys(edge, EDGE_KEYS, `changes.edges[${index}]`, {
    required: ['id', 'from', 'to', 'kind'],
  });
  requireId(edge.id, `changes.edges[${index}].id`, MAINTENANCE_LIMITS.maxSelectorLength);
  requireId(edge.from, `changes.edges[${index}].from`, MAINTENANCE_LIMITS.maxSelectorLength);
  requireId(edge.to, `changes.edges[${index}].to`, MAINTENANCE_LIMITS.maxSelectorLength);
  if (typeof edge.kind !== 'string' || !SCHEMA_EDGE_KINDS.has(edge.kind)) {
    fail('invalid_arguments', `changes.edges[${index}].kind is not a recognized edge kind.`);
  }
  if (Object.hasOwn(edge, 'evidenceIds')) requireStringArray(edge.evidenceIds, `changes.edges[${index}].evidenceIds`);
}

function validateEvidenceInput(evidence, index) {
  requireExactKeys(evidence, EVIDENCE_KEYS, `changes.evidence[${index}]`, {
    required: ['id', 'kind', 'claim'],
  });
  requireId(evidence.id, `changes.evidence[${index}].id`, MAINTENANCE_LIMITS.maxSelectorLength);
  if (typeof evidence.kind !== 'string' || evidence.kind.length === 0) {
    fail('invalid_arguments', `changes.evidence[${index}].kind is required.`);
  }
  requireNonEmptyString(evidence.claim, `changes.evidence[${index}].claim`, MAINTENANCE_LIMITS.maxTextLength);
  for (const key of ['revision', 'path', 'locator']) {
    if (evidence[key] !== undefined) {
      requireString(evidence[key], `changes.evidence[${index}].${key}`, MAINTENANCE_LIMITS.maxTextLength);
    }
  }
  if (evidence.validation !== undefined && !EVIDENCE_VALIDATIONS.has(evidence.validation)) {
    fail('invalid_arguments', `changes.evidence[${index}].validation is not a recognized value.`);
  }
  if (evidence.observedAt !== undefined) requireIsoTime(evidence.observedAt, `changes.evidence[${index}].observedAt`);
  if (evidence.excerpt !== undefined && (typeof evidence.excerpt !== 'string' || evidence.excerpt.length > 500)) {
    fail('invalid_arguments', `changes.evidence[${index}].excerpt must be at most 500 characters.`);
  }
}

function validateCheckInput(check, index) {
  requireExactKeys(check, CHECK_KEYS, `changes.checks[${index}]`, {
    required: ['id', 'createdAt', 'base', 'head', 'taskIntent', 'scope', 'findings'],
  });
  requireId(check.id, `changes.checks[${index}].id`, MAINTENANCE_LIMITS.maxSelectorLength);
  requireIsoTime(check.createdAt, `changes.checks[${index}].createdAt`);
  if (!isRecord(check.base) || !isRecord(check.head) || !isRecord(check.taskIntent) || !isRecord(check.scope)) {
    fail('invalid_arguments', `changes.checks[${index}] must use object base/head/taskIntent/scope records.`);
  }
  if (!Array.isArray(check.findings)) {
    fail('invalid_arguments', `changes.checks[${index}].findings must be an array.`);
  }
}

/**
 * Validate one tool call's arguments and return a private normalized snapshot.
 * No path, command, grant file, `authorized`/`approved` flag or arbitrary state
 * field is accepted. The plan digest is over exactly the returned object.
 *
 * @param {unknown} rawArgs
 * @param {string} boundProjectId
 */
export function normaliseMaintenanceArguments(rawArgs, boundProjectId) {
  if (!isRecord(rawArgs)) fail('invalid_arguments', 'Maintenance tool arguments must be an object.');
  const allowed = new Set(PLAN_KEYS);
  const extra = Object.keys(rawArgs).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    fail(
      'invalid_arguments',
      'Maintenance tool arguments may not include paths, commands, authorization booleans, grant paths or extra top-level fields.',
      { details: { field: extra[0] } },
    );
  }
  for (const key of PLAN_KEYS) {
    if (!Object.hasOwn(rawArgs, key)) fail('invalid_arguments', `${key} is required.`);
  }
  const plan = structuredClone(rawArgs);
  requireText(plan.projectId, 'projectId', MAINTENANCE_LIMITS.maxProjectIdLength);
  if (plan.projectId !== boundProjectId) {
    fail('project_mismatch', 'projectId does not match the bound project.');
  }
  requireText(plan.operationId, 'operationId', MAINTENANCE_LIMITS.maxOperationIdLength);
  if (
    !Number.isSafeInteger(plan.expectedStateVersion) ||
    plan.expectedStateVersion < 1 ||
    plan.expectedStateVersion >= Number.MAX_SAFE_INTEGER
  ) {
    fail('invalid_arguments', 'expectedStateVersion must be a safe positive integer.');
  }
  if (typeof plan.expectedDigest !== 'string' || !SHA256_PATTERN.test(plan.expectedDigest)) {
    fail('invalid_arguments', 'expectedDigest must be a full raw-byte sha256:<64 lowercase hex> digest.');
  }
  requireText(plan.summary, 'summary', MAINTENANCE_LIMITS.maxSummaryLength);
  requireExactKeys(plan.changes, new Set(CHANGE_KEYS), 'changes', { required: CHANGE_KEYS });
  for (const key of CHANGE_KEYS) {
    if (!Array.isArray(plan.changes[key])) fail('invalid_arguments', `changes.${key} must be an array.`);
  }
  if (plan.changes.nodes.length > MAINTENANCE_LIMITS.maxNodes) {
    fail('invalid_arguments', `changes.nodes may contain at most ${MAINTENANCE_LIMITS.maxNodes} entries.`);
  }
  if (plan.changes.edges.length > MAINTENANCE_LIMITS.maxEdges) {
    fail('invalid_arguments', `changes.edges may contain at most ${MAINTENANCE_LIMITS.maxEdges} entries.`);
  }
  if (plan.changes.evidence.length > MAINTENANCE_LIMITS.maxEvidence) {
    fail('invalid_arguments', `changes.evidence may contain at most ${MAINTENANCE_LIMITS.maxEvidence} entries.`);
  }
  if (plan.changes.checks.length > MAINTENANCE_LIMITS.maxChecks) {
    fail('invalid_arguments', `changes.checks may contain at most ${MAINTENANCE_LIMITS.maxChecks} entries.`);
  }
  for (const key of CHANGE_KEYS) {
    const ids = new Set();
    for (const item of plan.changes[key]) {
      if (!isRecord(item)) fail('invalid_arguments', `changes.${key} entries must be objects.`);
      if (Object.hasOwn(item, 'id') && typeof item.id === 'string') {
        if (ids.has(item.id)) fail('invalid_arguments', `changes.${key} must not contain duplicate ids.`);
        ids.add(item.id);
      }
    }
  }
  plan.changes.nodes.forEach(validateNodeInput);
  plan.changes.edges.forEach(validateEdgeInput);
  plan.changes.evidence.forEach(validateEvidenceInput);
  plan.changes.checks.forEach(validateCheckInput);
  let serialized;
  try {
    serialized = canonicalStringify(plan);
  } catch {
    fail('invalid_arguments', 'The maintenance plan is not a canonical JSON value.', {
      details: { field: 'plan' },
    });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAINTENANCE_LIMITS.maxPlanBytes) {
    fail(
      'invalid_arguments',
      `The maintenance plan exceeds the ${MAINTENANCE_LIMITS.maxPlanBytes}-byte MCP plan limit.`,
      { details: { maxPlanBytes: MAINTENANCE_LIMITS.maxPlanBytes } },
    );
  }
  return plan;
}

/** Digest over exactly the normalized MCP plan (it binds versions and changes). */
export function maintenancePlanDigest(plan) {
  return sha256Bytes(canonicalStringify(plan));
}

/** Store-level plan: the grant is not allowed to set authorizationRef; this is server-derived and stable. */
export function buildMaintenanceStorePlan(plan, planDigest = maintenancePlanDigest(plan)) {
  return {
    projectId: plan.projectId,
    operationId: plan.operationId,
    expectedStateVersion: plan.expectedStateVersion,
    expectedDigest: plan.expectedDigest,
    summary: plan.summary,
    authorizationRef: `mcp-maintenance-proposal:${planDigest}`,
    changes: structuredClone(plan.changes),
  };
}

function sameExcept(left, right, exemptFields) {
  const strip = (value) => Object.fromEntries(
    Object.entries(value).filter(([key]) => !exemptFields.includes(key)),
  );
  return canonicalStringify(strip(left)) === canonicalStringify(strip(right));
}

function validateNewNode(node) {
  const extra = Object.keys(node).filter((key) => !NEW_NODE_KEYS.has(key));
  if (extra.length > 0) {
    fail(
      'maintenance_intent_boundary',
      'A new MCP node is limited to id, kind, label, description, status and evidenceIds.',
      { details: { nodeId: node.id, field: extra[0] } },
    );
  }
  if (!ANNOTATION_KINDS.has(node.kind)) {
    fail(
      'maintenance_intent_boundary',
      'MCP maintenance can add only implementation, verification or unknown annotation nodes; it cannot add capabilities or other intent.',
      { details: { nodeId: node.id, field: 'kind' } },
    );
  }
  if (node.kind === 'unknown') {
    if (node.status !== 'unknown') {
      fail(
        'maintenance_unknown_boundary',
        'A newly recorded unknown node must keep status unknown; MCP maintenance cannot record it as closed or resolved.',
        { details: { nodeId: node.id, field: 'status' } },
      );
    }
  } else if (!['candidate', 'observed'].includes(node.status)) {
    fail(
      'maintenance_intent_boundary',
      'A new implementation or verification annotation must be candidate or observed, never confirmed, unknown or retired.',
      { details: { nodeId: node.id, field: 'status' } },
    );
  }
}

/**
 * Narrower than `maintain-map.mjs`: only annotation additions, annotation
 * label/description/evidence additions, and append-only edges/evidence/checks.
 * Intent-bearing nodes are never modified here, even to add evidence links.
 *
 * @param {object} state
 * @param {object} plan normalized MCP plan (without authorizationRef)
 */
export function assertMaintenancePermission(state, plan) {
  if (!isRecord(state) || state.project?.id !== plan.projectId) {
    fail('project_mismatch', 'The plan belongs to a different project.');
  }
  const beforeById = new Map(
    (Array.isArray(state.nodes) ? state.nodes : [])
      .filter((node) => isRecord(node) && typeof node.id === 'string')
      .map((node) => [node.id, node]),
  );
  const effective = new Map(beforeById);
  const changed = new Set();

  for (const node of plan.changes.nodes) {
    const old = beforeById.get(node.id);
    if (!old) {
      validateNewNode(node);
      effective.set(node.id, node);
      changed.add(node.id);
      continue;
    }
    if (INTENT_KINDS.has(old.kind)) {
      fail(
        'maintenance_intent_boundary',
        'MCP maintenance never modifies an intent-bearing node; record implementation/verification as separate annotation nodes and link them.',
        { details: { nodeId: node.id } },
      );
    }
    if (old.kind !== node.kind) {
      fail(
        'maintenance_intent_boundary',
        'MCP maintenance cannot change an existing node kind.',
        { details: { nodeId: node.id, field: 'kind' } },
      );
    }
    if (old.kind === 'unknown') {
      if (node.status !== old.status) {
        fail(
          'maintenance_unknown_boundary',
          'MCP maintenance cannot close or change the status of an existing unknown node.',
          { details: { nodeId: node.id, field: 'status' } },
        );
      }
      if (node.label !== old.label) {
        fail(
          'maintenance_unknown_boundary',
          'MCP maintenance cannot relabel an existing unknown node.',
          { details: { nodeId: node.id, field: 'label' } },
        );
      }
      if (!sameExcept(old, node, ['description', 'evidenceIds'])) {
        fail(
          'maintenance_intent_boundary',
          'An existing unknown may only receive description text and additional evidenceIds; all other fields must remain byte-identical.',
          { details: { nodeId: node.id } },
        );
      }
    } else {
      if (node.status !== old.status) {
        fail(
          'maintenance_node_status_boundary',
          'MCP maintenance never changes an existing annotation status.',
          { details: { nodeId: node.id, field: 'status' } },
        );
      }
      if (!sameExcept(old, node, ['label', 'description', 'evidenceIds'])) {
        fail(
          'maintenance_intent_boundary',
          'An implementation/verification annotation may change only label, description and evidenceIds; kind, status and every other field must remain byte-identical.',
          { details: { nodeId: node.id } },
        );
      }
    }
    const oldEvidence = Array.isArray(old.evidenceIds) ? old.evidenceIds : [];
    if (oldEvidence.some((id) => !node.evidenceIds.includes(id))) {
      fail(
        'maintenance_history_boundary',
        'Existing evidence links on a node must be retained; MCP maintenance cannot remove old evidence.',
        { details: { nodeId: node.id } },
      );
    }
    effective.set(node.id, node);
    changed.add(node.id);
  }

  const existingTriples = new Set(
    (Array.isArray(state.edges) ? state.edges : [])
      .filter((edge) => isRecord(edge))
      .map((edge) => `${edge.kind}\u0000${edge.from}\u0000${edge.to}`),
  );
  for (const edge of plan.changes.edges) {
    if (!EDGE_KINDS.has(edge.kind)) {
      fail(
        'maintenance_relation_boundary',
        'MCP maintenance only allows implemented_by, verified_by and depends_on relations; it cannot change product structure through contains, constrains, part_of, serves, enables, supersedes, conflicts_with or derived_from.',
        { details: { edgeId: edge.id, field: 'kind' } },
      );
    }
    const from = effective.get(edge.from);
    const to = effective.get(edge.to);
    if (!from || !to) {
      fail(
        'maintenance_relation_boundary',
        'Both endpoints of an added relation must exist after the proposed node additions.',
        { details: { edgeId: edge.id } },
      );
    }
    if (edge.from === edge.to) {
      fail('maintenance_relation_boundary', 'Self relations are not allowed.', {
        details: { edgeId: edge.id },
      });
    }
    if (edge.kind === 'implemented_by' && (to.kind !== 'implementation' || !INTENT_KINDS.has(from.kind))) {
      fail(
        'maintenance_relation_boundary',
        'implemented_by must go from an existing intent-bearing node to an implementation annotation.',
        { details: { edgeId: edge.id } },
      );
    }
    if (edge.kind === 'verified_by' && (to.kind !== 'verification' || !INTENT_KINDS.has(from.kind))) {
      fail(
        'maintenance_relation_boundary',
        'verified_by must go from an existing intent-bearing node to a verification annotation.',
        { details: { edgeId: edge.id } },
      );
    }
    if (edge.kind === 'depends_on' && !(ANNOTATION_KINDS.has(from.kind) || ANNOTATION_KINDS.has(to.kind))) {
      fail(
        'maintenance_relation_boundary',
        'depends_on is allowed only when at least one endpoint is an implementation, verification or unknown annotation; it cannot link two intent nodes.',
        { details: { edgeId: edge.id } },
      );
    }
    const triple = `${edge.kind}\u0000${edge.from}\u0000${edge.to}`;
    if (existingTriples.has(triple)) {
      fail(
        'maintenance_relation_boundary',
        'An equivalent relation already exists; MCP maintenance does not duplicate or rewrite relationships.',
        { details: { edgeId: edge.id } },
      );
    }
    existingTriples.add(triple);
  }

  for (const evidence of plan.changes.evidence) {
    if (!EVIDENCE_KINDS.has(evidence.kind)) {
      fail(
        'maintenance_intent_boundary',
        'MCP maintenance evidence is limited to implementation, test_definition, test_execution and runtime_observation; it cannot fabricate decision, user-statement, requirement, product-document, git-history or inference evidence.',
        { details: { evidenceId: evidence.id, field: 'kind' } },
      );
    }
  }
  return { changedNodeIds: [...changed] };
}

function assertResponseSize(value, limits, label = 'response') {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > limits.maxResponseBytes) {
    fail(
      'result_too_large',
      `The ${label} exceeds the configured ${limits.maxResponseBytes}-byte limit; reduce the plan or use the offline CLI.`,
      { details: { maxResponseBytes: limits.maxResponseBytes } },
    );
  }
  return bytes;
}

function collectionCounts(state) {
  const count = (value) => (Array.isArray(value) ? value.length : 0);
  return {
    baselines: count(state.baselines),
    nodes: count(state.nodes),
    edges: count(state.edges),
    evidence: count(state.evidence),
    decisions: count(state.decisions),
    intentClaims: count(state.intentClaims),
    proposals: count(state.proposals),
    reviews: count(state.reviews),
    checks: count(state.checks),
    roadmapItems: count(state.roadmapItems),
    featureCheckpoints: count(state.featureCheckpoints),
    mapUpdates: count(state.mapUpdates),
  };
}

function protectedFieldsUnchanged(before, after) {
  const fields = ['project', 'activeBaselineId', 'baselines', 'decisions', 'intentClaims', 'proposals', 'reviews', 'roadmapItems', 'featureCheckpoints', 'migration'];
  const result = {};
  for (const field of fields) {
    const left = before[field];
    const right = after[field];
    const same = left === undefined && right === undefined
      ? true
      : canonicalStringify(left ?? null) === canonicalStringify(right ?? null);
    result[field] = same;
    if (!same) {
      fail(
        'maintenance_intent_boundary',
        'The proposed transition would change a protected top-level field. No write was made.',
        { details: { field } },
      );
    }
  }
  return result;
}

function fieldDiff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const fields = [];
  for (const key of [...keys].sort()) {
    const beforePresent = Object.hasOwn(before, key);
    const afterPresent = Object.hasOwn(after, key);
    const same = beforePresent === afterPresent &&
      (!beforePresent || canonicalStringify(before[key]) === canonicalStringify(after[key]));
    if (same) continue;
    fields.push({
      field: key,
      beforePresent,
      afterPresent,
      before: beforePresent ? structuredClone(before[key]) : null,
      after: afterPresent ? structuredClone(after[key]) : null,
    });
  }
  return fields;
}

function buildMaintenanceDiff(before, after, plan, limits) {
  const beforeNodes = new Map((Array.isArray(before.nodes) ? before.nodes : []).map((node) => [node.id, node]));
  const afterNodes = new Map((Array.isArray(after.nodes) ? after.nodes : []).map((node) => [node.id, node]));
  const beforeEdges = new Set((Array.isArray(before.edges) ? before.edges : []).map((edge) => edge.id));
  const beforeEvidence = new Set((Array.isArray(before.evidence) ? before.evidence : []).map((item) => item.id));
  const beforeChecks = new Set((Array.isArray(before.checks) ? before.checks : []).map((item) => item.id));
  const plannedNodeIds = new Set(plan.changes.nodes.map((node) => node.id));

  const addedNodes = [];
  const changedNodes = [];
  for (const nodeId of plannedNodeIds) {
    const oldNode = beforeNodes.get(nodeId);
    const newNode = afterNodes.get(nodeId);
    if (!newNode) continue;
    if (!oldNode) {
      addedNodes.push(structuredClone(newNode));
    } else {
      const fields = fieldDiff(oldNode, newNode);
      if (fields.length > 0) changedNodes.push({ id: nodeId, kind: newNode.kind, fields });
    }
  }
  const addedEdges = (Array.isArray(after.edges) ? after.edges : [])
    .filter((edge) => !beforeEdges.has(edge.id))
    .map((edge) => structuredClone(edge));
  const addedEvidence = (Array.isArray(after.evidence) ? after.evidence : [])
    .filter((item) => !beforeEvidence.has(item.id))
    .map((item) => structuredClone(item));
  const addedChecks = (Array.isArray(after.checks) ? after.checks : [])
    .filter((item) => !beforeChecks.has(item.id))
    .map((item) => structuredClone(item));

  const diff = {
    nodes: { added: addedNodes, changed: changedNodes, removed: [] },
    edges: { added: addedEdges, removed: [] },
    evidence: { added: addedEvidence, removed: [] },
    checks: { added: addedChecks, removed: [] },
    counts: {
      nodesAdded: addedNodes.length,
      nodesChanged: changedNodes.length,
      edgesAdded: addedEdges.length,
      evidenceAdded: addedEvidence.length,
      checksAdded: addedChecks.length,
    },
  };
  const bytes = Buffer.byteLength(JSON.stringify(diff), 'utf8');
  if (bytes > limits.maxDiffBytes) {
    fail(
      'result_too_large',
      `The preview diff exceeds the configured ${limits.maxDiffBytes}-byte limit; narrow the plan.`,
      { details: { maxDiffBytes: limits.maxDiffBytes } },
    );
  }
  return diff;
}

function authorizationView(maintenance, plan, planDigest) {
  return {
    writeToolsExposed: true,
    humanConfirmationRequired: true,
    humanConfirmationPerformedByThisTool: false,
    toolParametersCannotAuthorize: true,
    previewIsNotAuthorization: true,
    bearerTokenIssued: false,
    grantFileConfigured: Boolean(maintenance),
    relativeAuthorizationPath: maintenance?.relativeAuthorizationPath ?? null,
    grantFormat: MAINTENANCE_GRANT_FORMAT,
    grantFields: [...MAINTENANCE_GRANT_FIELDS],
    planDigest,
    expectedStateVersion: plan.expectedStateVersion,
    expectedDigest: plan.expectedDigest,
    maxTtlHours: MAINTENANCE_LIMITS.maxGrantTtlMs / (60 * 60 * 1000),
    approvalSources: [...APPROVAL_SOURCES],
    note: 'A one-time grant must be created out of band, normally by a human running scripts/authorize-maintenance.mjs after reviewing this diff. This preview value is a content digest, not a bearer token. The bridge is cooperative and local; it is not cryptographic proof of a human decision or isolation from a malicious local writer.',
  };
}

function permissionView() {
  return {
    allowed: {
      newNodeKinds: ['implementation', 'verification', 'unknown'],
      existingNodeKinds: ['implementation', 'verification', 'unknown'],
      existingAnnotationEditableFields: ['label', 'description', 'evidenceIds'],
      existingUnknownEditableFields: ['description', 'evidenceIds'],
      edgeKinds: ['implemented_by', 'verified_by', 'depends_on'],
      evidenceKinds: ['implementation', 'test_definition', 'test_execution', 'runtime_observation'],
      appendOnlyCollections: ['edges', 'evidence', 'checks'],
    },
    forbidden: [
      'Adding capabilities or any other intent-bearing node',
      'Changing any label, description, status, conditions, legacy material, evidenceIds or kind of an intent-bearing node',
      'Closing, relabeling or changing the status of an existing unknown node',
      'Removing old evidence links, or changing/removing existing edges, evidence and checks',
      'Adding decision_record, user_statement, requirement, product_document, git_history or inference evidence',
      'Adding contains, constrains, part_of, serves, enables, supersedes, conflicts_with or derived_from relations',
      'Changing decisions, reviews, intent claims, proposals, roadmap items, baselines, project identity or migration metadata',
      'Running tests, executing commands or treating supplied evidence as a verified product result',
    ],
  };
}

function maintenanceBoundaries(writeMode = true) {
  return [
    'Maintenance preview performs no lock, backup, staged file, grant consumption or state write.',
    'Only the bound project state file and the fixed server-configured authorization file are accessed; no arbitrary path, command, source read, workspace scan or network request is accepted.',
    'A human must review the preview diff and create a one-time authorization grant out of band. Tool arguments, preview output and digest values cannot prove human confirmation.',
    'The grant and its consumption marker are local operational artifacts, not product decisions; they never create or modify decisions, reviews, claims or proposals.',
    'Supplied evidence and checks are external input facts. The server does not run tests and does not treat an evidence claim as product confirmation.',
    'The grant bridge is a cooperative local human-review mechanism, not cryptographic authentication and not a security boundary against a malicious local process that can write the same file.',
    'Apply refuses a live review-service lock and never stops a service, deletes a lock or forces a write.',
    'The read-only context tools remain read-only under this opt-in; their responses are not write authorization.',
    writeMode ? 'Write tools are exposed only because the server was started with an explicit opt-in and a fixed grant path.' : 'Write tools are not exposed.',
  ];
}

function assertStateBindingIdentity(binding) {
  return (async () => {
    let real;
    try {
      real = await fsp.realpath(binding.statePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        fail('state_not_found', 'The bound project state file does not exist.');
      }
      fail('state_unreadable', 'The bound project state file cannot be read safely.');
    }
    if (!samePath(real, binding.statePath) || isOutsideRelative(path.relative(binding.projectRoot, real))) {
      fail('state_path_changed', 'The bound state path no longer has its original project-contained identity.');
    }
    let stat;
    try {
      stat = await fsp.lstat(binding.statePath);
    } catch {
      fail('state_unreadable', 'The bound state path cannot be inspected safely.');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      fail('state_unreadable', 'The bound state must remain a single-link regular file.');
    }
  })();
}

function assertProjectIdentity(state, binding) {
  if (!isRecord(state.project) || state.project.id !== binding.projectId) {
    fail('project_mismatch', 'The state file belongs to a different project than the bound projectId.', {
      commitStatus: 'not_committed',
    });
  }
}

/**
 * Resolve the startup-configured authorization file. The path must stay inside
 * the project root, must not be the state file/lock/backup, and must not be a
 * symlink or a hard-linked file. No MCP tool argument can change it.
 */
export async function resolveMaintenanceAuthorizationBinding(binding, authorizationInput) {
  if (!isRecord(binding) || typeof binding.projectRoot !== 'string' || typeof binding.statePath !== 'string') {
    fail('invalid_server_option', 'A resolved project binding is required before the authorization path.');
  }
  if (
    typeof authorizationInput !== 'string' ||
    authorizationInput.length === 0 ||
    authorizationInput.length > 4096 ||
    authorizationInput.includes('\u0000')
  ) {
    fail('invalid_server_option', 'A non-empty authorization file path is required for write mode.');
  }
  const absolute = path.isAbsolute(authorizationInput)
    ? path.resolve(authorizationInput)
    : path.resolve(binding.projectRoot, authorizationInput);
  if (isUncOrDevicePath(absolute)) {
    fail('unc_path', 'UNC/device authorization paths are not supported.');
  }
  const basename = path.basename(absolute);
  if (!basename || basename === '.' || basename === '..') {
    fail('invalid_authorization_path', 'The authorization path must name a file.');
  }
  if (/(\.review\.lock|\.bak\.|\.pending$|\.failed$|\.consumed-)/.test(basename)) {
    fail('invalid_authorization_path', 'The authorization path must not use a state lock, backup, temporary, failed or consumed name.');
  }
  let parentReal;
  try {
    parentReal = await fsp.realpath(path.dirname(absolute));
    const parentStat = await fsp.stat(parentReal);
    if (!parentStat.isDirectory()) throw new Error('not a directory');
  } catch {
    fail('invalid_authorization_path', 'The authorization parent directory does not exist or is not accessible.');
  }
  const canonical = path.join(parentReal, basename);
  const relative = path.relative(binding.projectRoot, canonical);
  if (isOutsideRelative(relative)) {
    fail('authorization_outside_project_root', 'The normalized authorization path must remain inside the bound project root.');
  }
  if (samePath(canonical, binding.statePath)) {
    fail('invalid_authorization_path', 'The authorization file must not be the project state file.');
  }
  let stat = null;
  try {
    stat = await fsp.lstat(canonical);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      fail('invalid_authorization_path', 'The authorization path cannot be inspected safely.');
    }
  }
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      fail('maintenance_authorization_unsafe', 'The authorization file must be a single-link regular file, not a symlink or directory.');
    }
    let real;
    try {
      real = await fsp.realpath(canonical);
    } catch {
      fail('maintenance_authorization_unsafe', 'The authorization file cannot be resolved safely.');
    }
    if (!samePath(real, canonical)) {
      fail('maintenance_authorization_unsafe', 'The authorization file resolves outside its fixed configured identity.');
    }
  }
  return {
    authorizationPath: canonical,
    relativeAuthorizationPath: relative.split(path.sep).join('/'),
    parentReal,
    projectRoot: binding.projectRoot,
  };
}

async function assertAuthorizationBindingIdentity(maintenance) {
  let parentReal;
  try {
    parentReal = await fsp.realpath(maintenance.parentReal);
  } catch {
    fail('maintenance_authorization_unsafe', 'The authorization parent directory is no longer accessible.');
  }
  if (!samePath(parentReal, maintenance.parentReal)) {
    fail('maintenance_authorization_unsafe', 'The authorization parent directory changed identity.');
  }
  const relative = path.relative(maintenance.projectRoot, maintenance.authorizationPath);
  if (isOutsideRelative(relative)) {
    fail('maintenance_authorization_unsafe', 'The authorization path escaped the bound project root.');
  }
  let stat;
  try {
    stat = await fsp.lstat(maintenance.authorizationPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    fail('maintenance_authorization_unsafe', 'The authorization path cannot be inspected safely.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail('maintenance_authorization_unsafe', 'The authorization file must remain a single-link regular file.');
  }
  let real;
  try {
    real = await fsp.realpath(maintenance.authorizationPath);
  } catch {
    fail('maintenance_authorization_unsafe', 'The authorization file cannot be resolved safely.');
  }
  if (!samePath(real, maintenance.authorizationPath)) {
    fail('maintenance_authorization_unsafe', 'The authorization file changed identity.');
  }
}

async function readRegularFileBytes(filePath, maxBytes, options = {}) {
  let before;
  try {
    before = await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(
        options.missingCode ?? 'maintenance_authorization_missing',
        options.missingMessage ?? 'No unconsumed authorization grant exists at the fixed server-configured path.',
        { authorizationStatus: 'missing' },
      );
    }
    fail('maintenance_authorization_unsafe', 'The authorization file cannot be inspected safely.');
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail('maintenance_authorization_unsafe', 'The authorization file must be a single-link regular file.');
  }
  if (before.size > maxBytes) {
    fail('maintenance_authorization_invalid', 'The authorization file exceeds its byte limit.');
  }
  let handle;
  try {
    handle = await fsp.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    const sameFile = (left, right) => left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs;
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) {
      fail('maintenance_authorization_unsafe', 'The authorization file changed while opening it.');
    }
    const buffer = Buffer.alloc(Math.min(opened.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const final = await handle.stat();
    const after = await fsp.lstat(filePath);
    if (length !== opened.size || !sameFile(opened, final) || !sameFile(before, after)) {
      fail('maintenance_authorization_unsafe', 'The authorization file changed while it was read.');
    }
    return {
      bytes: buffer.subarray(0, length),
      digest: sha256Bytes(buffer.subarray(0, length)),
      size: length,
    };
  } catch (error) {
    if (error instanceof McpContextError) throw error;
    fail('maintenance_authorization_unsafe', 'The authorization file cannot be read safely.');
  } finally {
    await handle?.close();
  }
}

function parseGrant(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('maintenance_authorization_invalid', 'The authorization file is not valid UTF-8.');
  }
  let grant;
  try {
    grant = JSON.parse(text);
  } catch {
    fail('maintenance_authorization_invalid', 'The authorization file is not valid JSON.');
  }
  if (!isRecord(grant)) fail('maintenance_authorization_invalid', 'The authorization file must contain one JSON object.');
  const keys = Object.keys(grant);
  if (keys.length !== MAINTENANCE_GRANT_FIELDS.length || keys.some((key) => !GRANT_KEYS.has(key))) {
    fail('maintenance_authorization_invalid', 'The authorization grant must use exactly the documented fields.', {
      details: { field: 'format' },
    });
  }
  for (const key of ['format', 'grantId', 'projectId', 'operationId', 'planDigest', 'expectedDigest', 'approvalSource', 'approvedBy', 'approvedAt', 'expiresAt']) {
    if (typeof grant[key] !== 'string' || grant[key].length === 0) {
      fail('maintenance_authorization_invalid', `The authorization grant field ${key} must be a non-empty string.`, {
        details: { field: key },
      });
    }
  }
  if (grant.format !== MAINTENANCE_GRANT_FORMAT) {
    fail('maintenance_authorization_invalid', 'The authorization grant format is not supported.', {
      details: { field: 'format' },
    });
  }
  if (grant.planDigest !== undefined && !SHA256_PATTERN.test(grant.planDigest)) {
    fail('maintenance_authorization_invalid', 'The authorization planDigest is not a full SHA-256 digest.', {
      details: { field: 'planDigest' },
    });
  }
  if (!Number.isSafeInteger(grant.expectedStateVersion) || grant.expectedStateVersion < 1) {
    fail('maintenance_authorization_invalid', 'The authorization expectedStateVersion must be a safe positive integer.', {
      details: { field: 'expectedStateVersion' },
    });
  }
  if (typeof grant.expectedDigest !== 'string' || !SHA256_PATTERN.test(grant.expectedDigest)) {
    fail('maintenance_authorization_invalid', 'The authorization expectedDigest is not a full SHA-256 digest.', {
      details: { field: 'expectedDigest' },
    });
  }
  const grantTime = (value, field) => {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      fail('maintenance_authorization_invalid', `The authorization ${field} is not an ISO date-time.`, {
        details: { field },
      });
    }
    return ms;
  };
  grant.approvedAtMs = grantTime(grant.approvedAt, 'approvedAt');
  grant.expiresAtMs = grantTime(grant.expiresAt, 'expiresAt');
  return grant;
}

function verifyGrant(grant, plan, planDigest, options = {}) {
  if (!APPROVAL_SOURCES.has(grant.approvalSource)) {
    fail('maintenance_authorization_invalid', 'The authorization approvalSource is not recognized.', {
      details: { field: 'approvalSource' },
    });
  }
  if (grant.oneTime !== true) {
    fail('maintenance_authorization_invalid', 'The authorization grant must be explicitly one-time.', {
      details: { field: 'oneTime' },
    });
  }
  if (typeof grant.grantId !== 'string' || !GRANT_ID_PATTERN.test(grant.grantId)) {
    fail(
      'maintenance_authorization_invalid',
      'The authorization grantId must be a canonical UUID; path separators, colons, ADS names, traversal and arbitrary file-name characters are refused.',
      { details: { field: 'grantId' } },
    );
  }
  if (typeof grant.approvedBy !== 'string' || grant.approvedBy.length > 200 || hasControlCharacters(grant.approvedBy)) {
    fail('maintenance_authorization_invalid', 'The authorization approvedBy value is invalid.', {
      details: { field: 'approvedBy' },
    });
  }
  if (grant.projectId !== plan.projectId) {
    fail('maintenance_authorization_mismatch', 'The authorization grant is bound to a different project.', {
      details: { field: 'projectId' },
    });
  }
  if (grant.operationId !== plan.operationId) {
    fail('maintenance_authorization_mismatch', 'The authorization grant is bound to a different operationId.', {
      details: { field: 'operationId' },
    });
  }
  if (grant.planDigest !== planDigest) {
    fail('maintenance_authorization_mismatch', 'The authorization grant is bound to different plan content.', {
      details: { field: 'planDigest' },
    });
  }
  if (grant.expectedStateVersion !== plan.expectedStateVersion) {
    fail('maintenance_authorization_mismatch', 'The authorization grant is bound to a different expected state version.', {
      details: { field: 'expectedStateVersion' },
    });
  }
  if (grant.expectedDigest !== plan.expectedDigest) {
    fail('maintenance_authorization_mismatch', 'The authorization grant is bound to a different expected raw-byte digest.', {
      details: { field: 'expectedDigest' },
    });
  }
  const now = nowMsOf(options);
  if (grant.expiresAtMs <= now) {
    fail('maintenance_authorization_expired', 'The authorization grant has expired; request a new human review and grant.', {
      details: { field: 'expiresAt' },
    });
  }
  if (grant.approvedAtMs > now + MAX_GRANT_SKEW_MS) {
    fail('maintenance_authorization_not_yet_valid', 'The authorization grant approval time is in the future.', {
      details: { field: 'approvedAt' },
    });
  }
  const ttl = grant.expiresAtMs - grant.approvedAtMs;
  if (ttl <= 0 || ttl > MAINTENANCE_LIMITS.maxGrantTtlMs) {
    fail('maintenance_authorization_invalid', 'The authorization grant lifetime is zero, negative or longer than the maximum.', {
      details: { field: 'expiresAt' },
    });
  }
  return grant;
}

/**
 * Read and verify the one-time grant without consuming it. The grant path is
 * fixed by startup configuration; the plan digest and explicit versions must
 * match exactly.
 */
export async function readMaintenanceAuthorizationGrant(maintenance, plan, options = {}) {
  if (!maintenance) {
    fail('maintenance_write_disabled', 'Write mode is disabled; no authorization path is configured.');
  }
  const limits = normaliseMaintenanceLimits(options.limits);
  const planDigest = maintenancePlanDigest(plan);
  await assertAuthorizationBindingIdentity(maintenance);
  const read = await readRegularFileBytes(maintenance.authorizationPath, limits.maxGrantBytes);
  const after = await readRegularFileBytes(maintenance.authorizationPath, limits.maxGrantBytes);
  if (read.digest !== after.digest) {
    fail('maintenance_authorization_changed', 'The authorization file changed while it was verified.');
  }
  await assertAuthorizationBindingIdentity(maintenance);
  const grant = verifyGrant(parseGrant(read.bytes), plan, planDigest, options);
  return { grant, bytesDigest: read.digest, planDigest, bytes: read.bytes };
}

async function claimAuthorization(maintenance, plan, planDigest, expected, options, limits, claimState) {
  await assertAuthorizationBindingIdentity(maintenance);
  const fresh = await readRegularFileBytes(maintenance.authorizationPath, limits.maxGrantBytes);
  if (fresh.digest !== expected.bytesDigest) {
    fail('maintenance_authorization_changed', 'The authorization file changed after it was verified; no state write was made.');
  }
  verifyGrant(parseGrant(fresh.bytes), plan, planDigest, options);
  const marker = `${maintenance.authorizationPath}.consumed-${expected.grant.grantId}`;
  if (!samePath(path.dirname(marker), maintenance.parentReal)) {
    fail(
      'maintenance_authorization_unsafe',
      'The consumed marker would leave the fixed authorization directory; no state write was made.',
      { authorizationStatus: 'not_consumed' },
    );
  }
  // `rename` replaces an existing destination on POSIX, which would destroy an
  // earlier one-time consumed record. `link` fails atomically with EEXIST on
  // both Windows and POSIX, so a repeated grantId or restored original bytes
  // can never overwrite the consumed history. The original name is removed only
  // after the marker exists.
  try {
    await fsp.link(maintenance.authorizationPath, marker);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail(
        'maintenance_authorization_consumed',
        'A consumed record for this exact grant already exists; refusing to overwrite one-time history and making no state write.',
        { authorizationStatus: 'not_consumed' },
      );
    }
    if (error?.code === 'ENOENT') {
      fail(
        'maintenance_authorization_missing',
        'No unconsumed authorization grant exists; a valid grant is single-use and was already consumed or removed.',
        { authorizationStatus: 'missing_or_consumed' },
      );
    }
    fail(
      'maintenance_authorization_claim_failed',
      'The one-time authorization grant could not be claimed; no state write was made.',
      { authorizationStatus: 'claim_failed' },
    );
  }
  claimState.status = 'claimed';
  claimState.grantId = expected.grant.grantId;
  claimState.markerBasename = path.basename(marker);
  try {
    await fsp.unlink(maintenance.authorizationPath);
  } catch {
    // Attempt to remove only the marker this call just created, restoring the
    // single unconsumed grant. If rollback fails, fail closed as consumed but
    // leave both names for inspection.
    try {
      await fsp.unlink(marker);
    } catch {
      fail(
        'maintenance_authorization_claim_failed',
        'The grant marker was created but the original grant name could not be removed; do not reuse it. No state write was made.',
        { authorizationStatus: 'consumed_unverified' },
      );
    }
    fail(
      'maintenance_authorization_claim_failed',
      'The grant could not be consumed atomically; the marker was rolled back and no state write was made.',
      { authorizationStatus: 'not_consumed' },
    );
  }
  let claimed;
  try {
    claimed = await readRegularFileBytes(marker, limits.maxGrantBytes);
  } catch {
    fail(
      'maintenance_authorization_changed_after_claim',
      'The authorization grant was claimed but its claimed bytes could not be verified; no state write was made.',
      { authorizationStatus: 'consumed_unverified' },
    );
  }
  if (claimed.digest !== fresh.digest) {
    fail(
      'maintenance_authorization_changed_after_claim',
      'The authorization grant was claimed but its content changed; no state write was made.',
      { authorizationStatus: 'consumed_unverified' },
    );
  }
  const claim = {
    grantId: expected.grant.grantId,
    approvalSource: expected.grant.approvalSource,
    approvedBy: expected.grant.approvedBy,
    approvedAt: expected.grant.approvedAt,
    expiresAt: expected.grant.expiresAt,
    consumedMarkerFileName: path.basename(marker),
    consumedAt: new Date(nowMsOf(options)).toISOString(),
    bytesDigest: claimed.digest,
  };
  claimState.claim = claim;
  return claim;
}

async function describeExistingOperation(binding, plan, storePlan, options) {
  try {
    const snapshot = await readBoundProjectState(binding, {
      limits: { maxStateBytes: options.maxStateBytes ?? MAX_STATE_BYTES },
    });
    const record = (snapshot.state.mapUpdates ?? []).find((item) => item.operationId === plan.operationId);
    if (!record) return { present: false };
    const payloadDigest = sha256Bytes(canonicalStringify(storePlan));
    return {
      present: true,
      stateVersion: snapshot.stateVersion,
      resultingStateVersion: record.resultingStateVersion ?? null,
      payloadMatches: record.payloadDigest === payloadDigest,
    };
  } catch {
    return null;
  }
}

function safeDetails(details) {
  if (!isRecord(details)) return {};
  const safe = {};
  for (const key of [
    'field',
    'operationId',
    'expectedStateVersion',
    'actualStateVersion',
    'expectedDigest',
    'actualDigest',
    'validationErrorCount',
    'maxPlanBytes',
    'maxResponseBytes',
    'maxDiffBytes',
    'limit',
    'collection',
    'count',
    'grantId',
    'stateVersion',
    'resultingStateVersion',
    'digest',
    'observedDigest',
    'applied',
    'replayed',
  ]) {
    if (Object.hasOwn(details, key) && (
      typeof details[key] === 'string' ||
      typeof details[key] === 'number' ||
      typeof details[key] === 'boolean' ||
      details[key] === null
    )) {
      safe[key] = details[key];
    }
  }
  if (Array.isArray(details.errors)) {
    safe.errors = details.errors
      .filter((item) => typeof item === 'string')
      .slice(0, MAINTENANCE_LIMITS.maxValidationErrors)
      .map((item) => item.slice(0, 500));
  }
  if (isRecord(details.owner)) {
    safe.owner = {
      pid: Number.isSafeInteger(details.owner.pid) ? details.owner.pid : null,
      host: typeof details.owner.host === 'string' ? details.owner.host : null,
      startedAt: typeof details.owner.startedAt === 'string' ? details.owner.startedAt : null,
    };
  }
  if (isRecord(details.existingOperation)) {
    safe.existingOperation = {
      present: details.existingOperation.present === true,
      stateVersion: Number.isSafeInteger(details.existingOperation.stateVersion)
        ? details.existingOperation.stateVersion
        : null,
      resultingStateVersion: Number.isSafeInteger(details.existingOperation.resultingStateVersion)
        ? details.existingOperation.resultingStateVersion
        : null,
      payloadMatches: details.existingOperation.payloadMatches === true,
    };
  }
  return safe;
}

function toMaintenanceError(error, options = {}) {
  if (error instanceof McpMaintenanceError) {
    if (!error.authorizationStatus && options.claimState) {
      if (options.claimState.status === 'claimed') error.authorizationStatus = 'consumed';
      else if (options.claimState.status === 'none') error.authorizationStatus = 'not_consumed';
    }
    return error;
  }
  if (error instanceof StoreError) {
    return new McpMaintenanceError(
      error.code,
      SAFE_STORE_MESSAGES[error.code] ?? 'The maintenance operation failed safely; inspect the state directory diagnostics.',
      {
        commitStatus: typeof error.commitStatus === 'string' ? error.commitStatus : 'not_committed',
        authorizationStatus: options.claimState?.status === 'claimed'
          ? 'consumed'
          : (options.claimState ? 'not_consumed' : null),
        details: safeDetails(error.details),
      },
    );
  }
  if (error instanceof McpContextError) {
    return new McpMaintenanceError(
      error.code,
      SAFE_STORE_MESSAGES[error.code] ?? error.message,
      {
        commitStatus: 'not_committed',
        authorizationStatus: options.claimState?.status === 'claimed' ? 'consumed' : null,
        details: safeDetails(error.details),
      },
    );
  }
  return new McpMaintenanceError(
    'internal_error',
    'The maintenance request failed safely.',
    {
      commitStatus: 'not_committed',
      authorizationStatus: options.claimState?.status === 'claimed' ? 'consumed' : null,
    },
  );
}

function assertTransitionPermission(state, plan) {
  // An exact operation retry is settled by maintain-map as a read-only replay
  // (or a key conflict) before any transition is built. Policy only needs to
  // inspect new transitions; this prevents a replay plan from being rejected
  // merely because its appended records already exist.
  const previous = (Array.isArray(state.mapUpdates) ? state.mapUpdates : [])
    .find((item) => item?.operationId === plan.operationId);
  if (previous) return { replayed: true, changedNodeIds: [] };
  return assertMaintenancePermission(state, plan);
}

/**
 * Preview one maintenance plan. This function performs a bounded state read and
 * pure transition only: no lock, backup, staged file, grant read/consumption or
 * state write.
 */
export async function previewMaintenance(binding, maintenance, rawArgs, options = {}) {
  if (!maintenance) {
    fail('maintenance_write_disabled', 'Write mode is disabled; no authorization path is configured.');
  }
  const limits = normaliseMaintenanceLimits(options.limits);
  const plan = normaliseMaintenanceArguments(rawArgs, binding.projectId);
  const planDigest = maintenancePlanDigest(plan);
  const storePlan = buildMaintenanceStorePlan(plan, planDigest);
  let snapshot;
  try {
    // A preview does not read or consume the grant, but it does check that the
    // fixed grant path is still a safe regular-file identity so the human is not
    // asked to authorize a path that apply will refuse.
    await assertAuthorizationBindingIdentity(maintenance);
    snapshot = await readBoundProjectState(binding, {
      limits: { maxStateBytes: options.maxStateBytes ?? MAX_STATE_BYTES },
    });
  } catch (error) {
    throw toMaintenanceError(error);
  }
  let transition;
  try {
    transition = prepareMaintenanceTransition(snapshot.state, snapshot.fileDigest, storePlan, {
      clock: options.clock,
      validate: ({ state }) => assertTransitionPermission(state, plan),
    });
  } catch (error) {
    throw toMaintenanceError(error);
  }
  const diff = buildMaintenanceDiff(snapshot.state, transition.state, plan, limits);
  const result = {
    tool: 'maintenance_preview',
    ok: true,
    applied: false,
    writeMode: true,
    projectId: snapshot.projectId,
    state: {
      schemaVersion: snapshot.schemaVersion,
      stateVersion: snapshot.stateVersion,
      fileDigest: snapshot.fileDigest,
      byteSize: snapshot.byteSize,
      relativePath: snapshot.relativeStatePath,
      readAt: snapshot.readAt,
    },
    plan: {
      operationId: plan.operationId,
      planDigest,
      summary: plan.summary,
      expectedStateVersion: plan.expectedStateVersion,
      expectedDigest: plan.expectedDigest,
      counts: {
        nodes: plan.changes.nodes.length,
        edges: plan.changes.edges.length,
        evidence: plan.changes.evidence.length,
        checks: plan.changes.checks.length,
      },
    },
    result: {
      stateVersion: transition.state.stateVersion,
      replayed: transition.replayed,
      wouldWrite: !transition.replayed,
      changedNodeIds: transition.record.changedNodeIds,
      addedEdgeIds: transition.record.addedEdgeIds,
      addedEvidenceIds: transition.record.addedEvidenceIds,
      addedCheckIds: transition.record.addedCheckIds,
      sampleRecordIdIsNotSaved: true,
    },
    diff,
    preserved: {
      fields: protectedFieldsUnchanged(snapshot.state, transition.state),
      countsBefore: collectionCounts(snapshot.state),
      countsAfter: collectionCounts(transition.state),
      note: 'Protected collections are checked byte-semantically; they are not returned in full here.',
    },
    authorization: authorizationView(maintenance, plan, planDigest),
    permissions: permissionView(),
    limits: { ...limits },
    boundaries: maintenanceBoundaries(true),
  };
  assertResponseSize(result, limits, 'preview response');
  return result;
}

function buildApplyReceipt(result, claimState, binding) {
  const record = result.record ?? null;
  return {
    tool: 'maintenance_apply',
    ok: true,
    applied: result.applied === true,
    replayed: result.replayed === true,
    writeMode: true,
    projectId: binding.projectId,
    commitStatus: result.commitStatus,
    stateVersion: result.stateVersion,
    observedStateVersion: record?.observedStateVersion ?? null,
    observedDigest: record?.observedDigest ?? null,
    digest: result.digest ?? null,
    backup: result.backupPath
      ? {
          fileName: path.basename(result.backupPath),
          digest: record?.observedDigest ?? null,
          verified: true,
          note: 'The store verified the backup readback digest before replacement.',
        }
      : null,
    mapUpdate: record
      ? {
          id: record.id,
          operationId: record.operationId,
          source: record.source,
          createdAt: record.createdAt,
          authorizationRef: record.authorizationRef,
          observedStateVersion: record.observedStateVersion,
          observedDigest: record.observedDigest,
          resultingStateVersion: record.resultingStateVersion,
          payloadDigest: record.payloadDigest,
          changedNodeIds: [...record.changedNodeIds],
          addedEdgeIds: [...record.addedEdgeIds],
          addedEvidenceIds: [...record.addedEvidenceIds],
          addedCheckIds: [...record.addedCheckIds],
        }
      : null,
    authorization: {
      status: 'consumed',
      grantId: claimState.claim?.grantId ?? claimState.grantId ?? null,
      approvalSource: claimState.claim?.approvalSource ?? null,
      approvedBy: claimState.claim?.approvedBy ?? null,
      approvedAt: claimState.claim?.approvedAt ?? null,
      expiresAt: claimState.claim?.expiresAt ?? null,
      consumedMarkerFileName: claimState.claim?.consumedMarkerFileName ?? claimState.markerBasename ?? null,
      bytesDigest: claimState.claim?.bytesDigest ?? null,
      isHumanDecisionRecord: false,
      note: 'The grant is a local operational artifact, not a product decision or a human decision record.',
    },
    boundaries: [
      ...maintenanceBoundaries(true),
      result.replayed
        ? 'This apply call found an existing identical operation and consumed the new one-time grant without writing a new state version.'
        : 'This apply call wrote one new state version through the maintenance transaction.',
    ],
  };
}

// A conservative pre-commit probe: it uses the exact plan ID arrays and
// overlong placeholders for server-generated IDs, timestamps, backup and marker
// file names. If this upper bound does not fit the configured response limit,
// apply fails before the state lock/commit, so `not_committed` is truthful.
function buildApplyReceiptProbe(plan, storePlan, preliminary) {
  const zeroDigest = `sha256:${'0'.repeat(64)}`;
  const probeRecord = {
    id: `map-update:${'0'.repeat(36)}`,
    operationId: plan.operationId,
    source: 'local_map_maintenance',
    createdAt: '2026-01-01T00:00:00.000Z',
    authorizationRef: storePlan.authorizationRef,
    observedStateVersion: plan.expectedStateVersion,
    observedDigest: plan.expectedDigest,
    resultingStateVersion: plan.expectedStateVersion + 1,
    payloadDigest: zeroDigest,
    changedNodeIds: plan.changes.nodes.map((node) => node.id),
    addedEdgeIds: plan.changes.edges.map((edge) => edge.id),
    addedEvidenceIds: plan.changes.evidence.map((evidence) => evidence.id),
    addedCheckIds: plan.changes.checks.map((check) => check.id),
  };
  const probeClaimState = {
    status: 'none',
    claim: {
      grantId: preliminary.grant.grantId,
      approvalSource: preliminary.grant.approvalSource,
      approvedBy: preliminary.grant.approvedBy,
      approvedAt: preliminary.grant.approvedAt,
      expiresAt: preliminary.grant.expiresAt,
      consumedMarkerFileName: 'x'.repeat(512),
      bytesDigest: zeroDigest,
    },
  };
  return buildApplyReceipt(
    {
      applied: true,
      replayed: false,
      commitStatus: 'verified',
      stateVersion: plan.expectedStateVersion + 1,
      observedStateVersion: plan.expectedStateVersion,
      observedDigest: plan.expectedDigest,
      digest: zeroDigest,
      backupPath: 'x'.repeat(255),
      record: probeRecord,
    },
    probeClaimState,
    { projectId: plan.projectId },
  );
}

/**
 * Apply one maintenance plan after verifying the fixed, one-time, out-of-band
 * grant. The grant is claimed inside the state lock after full validation and
 * before any temporary/backup file is written. The maintenance store performs
 * the exact-byte backup, replacement and post-write verification.
 */
export async function applyMaintenance(binding, maintenance, rawArgs, options = {}) {
  if (!maintenance) {
    fail('maintenance_write_disabled', 'Write mode is disabled; no authorization path is configured.');
  }
  const limits = normaliseMaintenanceLimits(options.limits);
  const plan = normaliseMaintenanceArguments(rawArgs, binding.projectId);
  const planDigest = maintenancePlanDigest(plan);
  const storePlan = buildMaintenanceStorePlan(plan, planDigest);
  const claimState = { status: 'none' };
  let preliminary;
  try {
    await assertStateBindingIdentity(binding);
    preliminary = await readMaintenanceAuthorizationGrant(maintenance, plan, {
      ...options,
      limits,
    });
  } catch (error) {
    throw toMaintenanceError(error, { claimState });
  }

  let result;
  try {
    result = await applyMapMaintenance(binding.statePath, storePlan, {
      authorized: true,
      clock: options.clock,
      io: options.io,
      hooks: options.hooks,
      maxStateBytes: options.maxStateBytes,
      validate: ({ state }) => {
        assertTransitionPermission(state, plan);
      },
      assertPath: async () => {
        try {
          await assertStateBindingIdentity(binding);
        } catch (error) {
          throw new StoreError(
            error.code ?? 'state_path_changed',
            error.message,
            { status: 503, details: error.details },
          );
        }
      },
      beforeSettle: async ({ statePath, before }) => {
        if (!samePath(statePath, binding.statePath)) {
          fail('state_path_changed', 'The canonical state path changed before settling the write.');
        }
        await assertStateBindingIdentity(binding);
        assertProjectIdentity(before, binding);
        const fresh = await readMaintenanceAuthorizationGrant(maintenance, plan, {
          ...options,
          limits,
        });
        if (fresh.bytesDigest !== preliminary.bytesDigest) {
          fail('maintenance_authorization_changed', 'The authorization file changed after it was verified; no state write was made.');
        }
        const probeBytes = Buffer.byteLength(
          JSON.stringify(buildApplyReceiptProbe(plan, storePlan, fresh)),
          'utf8',
        ) + RECEIPT_SAFETY_MARGIN_BYTES;
        if (probeBytes > limits.maxResponseBytes) {
          fail(
            'result_too_large',
            `The configured ${limits.maxResponseBytes}-byte response limit cannot hold the verified apply receipt; no grant was consumed and no state write was made. Increase maxResponseBytes or use the offline CLI.`,
            { details: { maxResponseBytes: limits.maxResponseBytes } },
          );
        }
        await claimAuthorization(maintenance, plan, planDigest, fresh, options, limits, claimState);
        await assertStateBindingIdentity(binding);
      },
    });
  } catch (error) {
    const safe = toMaintenanceError(error, { claimState });
    if (
      ['maintenance_authorization_missing', 'maintenance_authorization_consumed', 'maintenance_authorization_mismatch', 'maintenance_authorization_expired', 'maintenance_authorization_not_yet_valid'].includes(safe.code)
    ) {
      const existing = await describeExistingOperation(binding, plan, storePlan, options);
      if (existing) safe.details = { ...safe.details, existingOperation: existing };
    }
    throw safe;
  }

  const record = result.record ?? null;
  const receipt = buildApplyReceipt(result, claimState, binding);
  try {
    assertResponseSize(receipt, limits, 'apply response');
  } catch (error) {
    if (error instanceof McpMaintenanceError && error.code === 'result_too_large') {
      // The commit already happened. Never let a post-commit size failure look
      // like `not_committed`: report the store's real status and version/digest,
      // and make the consumed authorization explicit.
      throw new McpMaintenanceError(
        'result_too_large',
        'The state was committed, but the full receipt exceeds the configured response limit. The commit is not reported as not_committed; inspect the version/digest and backup before retrying.',
        {
          commitStatus: typeof result.commitStatus === 'string' ? result.commitStatus : 'verified',
          authorizationStatus: 'consumed',
          details: {
            stateVersion: result.stateVersion,
            resultingStateVersion: record?.resultingStateVersion ?? null,
            digest: result.digest ?? null,
            observedDigest: record?.observedDigest ?? null,
            maxResponseBytes: limits.maxResponseBytes,
            applied: result.applied === true,
            replayed: result.replayed === true,
          },
        },
      );
    }
    throw error;
  }
  return receipt;
}

/** Run one maintenance tool against a fixed binding. */
export async function runMaintenanceTool(tool, binding, maintenance, rawArgs, options = {}) {
  if (!MAINTENANCE_TOOL_NAMES.includes(tool)) {
    fail('invalid_arguments', 'Unknown maintenance tool.');
  }
  if (!maintenance) {
    fail('maintenance_write_disabled', 'Write mode is disabled; maintenance tools are not exposed.');
  }
  return tool === 'maintenance_preview'
    ? previewMaintenance(binding, maintenance, rawArgs, options)
    : applyMaintenance(binding, maintenance, rawArgs, options);
}

/** Tool metadata for MCP tools/list in opt-in write mode. */
export function getMaintenanceToolDefinitions() {
  const projectId = {
    type: 'string',
    minLength: 1,
    maxLength: MAINTENANCE_LIMITS.maxProjectIdLength,
    description: 'Must equal the projectId fixed at server startup.',
  };
  const nodeItemSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'kind', 'label', 'status', 'evidenceIds'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: MAINTENANCE_LIMITS.maxSelectorLength },
      kind: {
        type: 'string',
        enum: ['implementation', 'verification', 'unknown'],
        description: 'Only annotation nodes. Capabilities and all other intent-bearing nodes are rejected.',
      },
      label: { type: 'string', minLength: 1, maxLength: MAINTENANCE_LIMITS.maxTextLength },
      description: { type: 'string', maxLength: MAINTENANCE_LIMITS.maxTextLength },
      status: {
        type: 'string',
        enum: ['candidate', 'observed', 'unknown', 'retired'],
        description: 'Existing annotations must keep their current status. New implementations/verifications may be candidate/observed; a new unknown must be unknown.',
      },
      conditions: {
        type: 'array',
        maxItems: 50,
        items: { type: 'string', maxLength: 2000 },
        description: 'Only a byte-identical resubmission of an existing annotation; new nodes cannot use this field.',
      },
      legacy: {
        type: 'object',
        description: 'Only a byte-identical resubmission of an existing annotation; new nodes cannot use this field.',
      },
      evidenceIds: {
        type: 'array',
        maxItems: MAINTENANCE_LIMITS.maxIdsPerRecord,
        uniqueItems: true,
        items: { type: 'string', minLength: 1, maxLength: MAINTENANCE_LIMITS.maxSelectorLength },
      },
    },
  };
  const edgeItemSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'from', 'to', 'kind'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: MAINTENANCE_LIMITS.maxSelectorLength },
      from: { type: 'string', minLength: 1, maxLength: MAINTENANCE_LIMITS.maxSelectorLength },
      to: { type: 'string', minLength: 1, maxLength: MAINTENANCE_LIMITS.maxSelectorLength },
      kind: {
        type: 'string',
        enum: ['implemented_by', 'verified_by', 'depends_on'],
        description: 'implemented_by: intent -> implementation; verified_by: intent -> verification; depends_on: at least one annotation endpoint. No contains/constrains/part_of/other structural edits.',
      },
      evidenceIds: {
        type: 'array',
        maxItems: MAINTENANCE_LIMITS.maxIdsPerRecord,
        uniqueItems: true,
        items: { type: 'string', minLength: 1, maxLength: MAINTENANCE_LIMITS.maxSelectorLength },
      },
    },
  };
  const evidenceItemSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'kind', 'claim'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: MAINTENANCE_LIMITS.maxSelectorLength },
      kind: {
        type: 'string',
        enum: ['implementation', 'test_definition', 'test_execution', 'runtime_observation'],
        description: 'No decision_record, user_statement, requirement, product_document, git_history or inference evidence.',
      },
      claim: { type: 'string', minLength: 1, maxLength: MAINTENANCE_LIMITS.maxTextLength },
      revision: { type: 'string', maxLength: MAINTENANCE_LIMITS.maxTextLength },
      path: { type: 'string', maxLength: MAINTENANCE_LIMITS.maxTextLength, description: 'Stored evidence path text; it is not read or executed by this server.' },
      locator: { type: 'string', maxLength: MAINTENANCE_LIMITS.maxTextLength },
      validation: {
        type: 'string',
        enum: ['not_applicable', 'not_run', 'defined_only', 'passed', 'failed', 'observed'],
      },
      observedAt: { type: 'string', format: 'date-time' },
      excerpt: { type: 'string', maxLength: 500 },
    },
  };
  const revisionSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      commit: { type: 'string' },
      branch: { type: 'string' },
      worktree: { type: 'string', enum: ['clean', 'dirty', 'unknown'] },
      label: { type: 'string' },
    },
  };
  const findingSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status', 'summary', 'evidenceIds'],
    properties: {
      id: { type: 'string', minLength: 1 },
      status: {
        type: 'string',
        enum: [
          'no_supported_behavior_change',
          'consistent_with_confirmed_intent',
          'potential_mismatch',
          'proposed_evolution',
          'existing_discrepancy',
          'insufficient_evidence',
        ],
      },
      summary: { type: 'string', minLength: 1 },
      affectedNodeIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      decisionIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      evidenceIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      nextAction: { type: 'string' },
    },
  };
  const checkItemSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'createdAt', 'base', 'head', 'taskIntent', 'scope', 'findings'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: MAINTENANCE_LIMITS.maxSelectorLength },
      createdAt: { type: 'string', format: 'date-time' },
      baselineId: { type: 'string' },
      base: revisionSchema,
      head: revisionSchema,
      taskIntent: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['provided', 'not_provided', 'reconstructed', 'confirmed'] },
          statement: { type: 'string' },
          source: { type: 'string' },
        },
      },
      scope: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'includedPaths', 'excludedPaths', 'coverageNote'],
        properties: {
          description: { type: 'string', minLength: 1 },
          includedPaths: { type: 'array', items: { type: 'string' } },
          excludedPaths: { type: 'array', items: { type: 'string' } },
          coverageNote: { type: 'string' },
        },
      },
      findings: {
        type: 'array',
        maxItems: 100,
        items: findingSchema,
      },
    },
  };
  const common = {
    type: 'object',
    additionalProperties: false,
    description:
      'Strict maintenance plan. The canonical JSON digest binds projectId, operationId, expected version/digest, summary and changes. No decision, review, claim, proposal, roadmap, baseline, project, path, command or authorization field is accepted.',
    required: ['projectId', 'operationId', 'expectedStateVersion', 'expectedDigest', 'summary', 'changes'],
    properties: {
      projectId,
      operationId: {
        type: 'string',
        minLength: 1,
        maxLength: MAINTENANCE_LIMITS.maxOperationIdLength,
        description: 'Stable idempotency key for this exact plan.',
      },
      expectedStateVersion: {
        type: 'integer',
        minimum: 1,
        maximum: 9007199254740990,
        description: 'Base version returned by a fresh preview.',
      },
      expectedDigest: {
        type: 'string',
        pattern: '^sha256:[0-9a-f]{64}$',
        description: 'Full raw-byte digest of the base state file.',
      },
      summary: {
        type: 'string',
        minLength: 1,
        maxLength: MAINTENANCE_LIMITS.maxSummaryLength,
        description: 'Short non-review maintenance summary. It is not a product decision and is bound into the plan digest.',
      },
      changes: {
        type: 'object',
        additionalProperties: false,
        required: ['nodes', 'edges', 'evidence', 'checks'],
        description:
          'Only annotation nodes and append-only edges/evidence/checks. Intent-bearing nodes, decisions, reviews, claims, proposals, roadmap items, baselines, project identity and migration metadata cannot be supplied.',
        properties: {
          nodes: {
            type: 'array',
            maxItems: MAINTENANCE_LIMITS.maxNodes,
            description:
              'New implementation/verification/unknown annotations, or existing annotation updates limited to label/description/evidenceIds. Existing status, intent nodes and unknown labels/status are protected.',
            items: nodeItemSchema,
          },
          edges: {
            type: 'array',
            maxItems: MAINTENANCE_LIMITS.maxEdges,
            description: 'Append-only implemented_by/verified_by/depends_on relations within the endpoint allowlist.',
            items: edgeItemSchema,
          },
          evidence: {
            type: 'array',
            maxItems: MAINTENANCE_LIMITS.maxEvidence,
            description:
              'Append-only implementation/test_definition/test_execution/runtime_observation evidence. Supplied claims are external input and are not verified by this server.',
            items: evidenceItemSchema,
          },
          checks: {
            type: 'array',
            maxItems: MAINTENANCE_LIMITS.maxChecks,
            description:
              'Append-only check records matching the stored check contract. The server does not run the check and full runtime schema/reference validation still applies.',
            items: checkItemSchema,
          },
        },
      },
    },
  };
  return [
    {
      name: 'maintenance_preview',
      description:
        'Preview a bounded, non-intent implementation/evidence maintenance plan. Performs no lock, backup, grant consumption or state write. Returns base stateVersion/full raw-byte digest, exact before/after diff, plan digest and the permission boundary. This is not human confirmation and issues no bearer token.',
      inputSchema: common,
    },
    {
      name: 'maintenance_apply',
      description:
        'Apply a previously previewed maintenance plan. Requires an unconsumed one-time authorization grant at the fixed server-configured path, created out of band by a human after reviewing the diff. Tool arguments cannot authorize; the grant is claimed once inside the state lock. Refuses a live service lock and returns an explicit commitStatus.',
      inputSchema: common,
    },
  ];
}

// The module intentionally exports no authorization writer. The out-of-band
// grant is created by scripts/authorize-maintenance.mjs, not by an MCP tool.
