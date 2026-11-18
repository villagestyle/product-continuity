/**
 * Read-only project context for the local MCP server.
 *
 * Scope and honest limits:
 * - The only project input is one explicitly bound state file below one
 *   explicitly bound project root. No browser cookie, HTTP route, source file,
 *   workspace scan, git call, test execution or network request is used.
 * - Every tool call re-reads the state bytes and runs the full 0.1/0.2 schema,
 *   reference and intent validation. No state is cached between calls.
 * - This read-only context layer never acquires the writer lock, creates a
 *   backup, migrates a state or renders a view. The opt-in maintenance module is
 *   separate and uses the maintenance transaction only after a one-time grant.
 *   The read tools can run beside the review service because they do not take
 *   the cooperative lock; the two processes read the same file.
 * - Responses are bounded by record and byte limits. A response that would
 *   exceed a limit is rejected explicitly; it is never silently truncated.
 * - Roadmap horizon/status is planning context. It is not development
 *   authorization, and acceptanceCriteria are not test results.
 */

import { constants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { canonicalStringify, deriveNodeIntentSummary } from './intent-model.mjs';
import { deriveFeatureProgress, selectFeatureContext } from './feature-progress.mjs';
import { canonicalizeStatePath, sha256Bytes, validateFullState } from './state-store.mjs';

export const MCP_TOOL_NAMES = Object.freeze(['project_get', 'context_get', 'map_query']);

export const DEFAULT_MCP_LIMITS = Object.freeze({
  maxStateBytes: 10 * 1024 * 1024,
  maxResponseBytes: 512 * 1024,
  maxNodes: 100,
  maxEdges: 300,
  maxClaims: 200,
  maxDecisions: 200,
  maxProposals: 100,
  maxEvidence: 300,
  maxReviews: 200,
  maxRoadmapItems: 100,
  maxRelatedNodes: 200,
  maxUnknownNodes: 100,
  maxFeatureCheckpoints: 200,
  maxCheckpointBasisRecords: 300,
  maxCheckpointSourceSnapshots: 20,
});

const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_MCP_LIMITS));
const MAX_SELECTORS = 50;
const MAX_SELECTOR_ID_LENGTH = 200;
const MAX_PROJECT_ID_LENGTH = 200;
const MAX_STATE_PATH_LENGTH = 4096;
const MAX_TASK_LENGTH = 2000;
const MAX_FILE_PATH_LENGTH = 1024;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const READ_ONLY_CAPABILITIES = Object.freeze({
  writeTools: false,
  confirmationTools: false,
  arbitraryPaths: false,
  commands: false,
  sourceReads: false,
  workspaceScans: false,
  network: false,
  stateCaching: false,
  writerLock: false,
  viewGeneration: false,
});

const AUTHORIZATION_VIEW = Object.freeze({
  roadmapIsPlanningOnly: true,
  roadmapGrantsImplementationPermission: false,
  candidateIsConfirmedIntent: false,
  confirmedIntentRequiresRecordedDecision: true,
  historicalIsCurrentAuthorization: false,
  acceptanceCriteriaAreTestResults: false,
  testDefinitionIsExecution: false,
  featureCheckpointIsReview: false,
  latestCheckpointIsAuthoritative: false,
  nextActionsGrantExecution: false,
  checkpointsAreCompletionMetrics: false,
  deliveryStatementIsAcceptance: false,
  deliveryStatementIsReleaseAuthorization: false,
  writeToolsExposed: false,
  humanDecisionRecordedByThisServer: false,
});

/**
 * Stable error used by the context layer and translated by the stdio server.
 * Messages are deliberately generic so a caller cannot learn absolute server
 * paths, lock owners or filesystem details from an error.
 */
export class McpContextError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'McpContextError';
    this.code = code;
    this.details = { ...details };
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return structuredClone(value);
}

function byId(items) {
  const map = new Map();
  for (const item of asArray(items)) {
    if (isRecord(item) && typeof item.id === 'string' && item.id.length > 0 && !map.has(item.id)) {
      map.set(item.id, item);
    }
  }
  return map;
}

function normaliseLimits(overrides) {
  const limits = { ...DEFAULT_MCP_LIMITS };
  if (overrides === undefined || overrides === null) return limits;
  if (!isRecord(overrides)) {
    throw new McpContextError('invalid_server_option', 'Server limits must be an object.');
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!LIMIT_KEYS.includes(key)) {
      throw new McpContextError('invalid_server_option', 'An unknown server limit was supplied.', {
        limit: key,
      });
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new McpContextError('invalid_server_option', 'Server limits must be positive integers.', {
        limit: key,
      });
    }
    limits[key] = value;
  }
  return limits;
}

function publicLimits(limits) {
  return { ...limits };
}

function ensureLimit(collection, count, limit) {
  if (count > limit) {
    throw new McpContextError(
      'result_too_large',
      'The requested context exceeds a configured record limit; narrow the explicit selectors.',
      { collection, count, limit },
    );
  }
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

function hasControlCharacters(value) {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

function validateProjectId(projectId) {
  if (
    typeof projectId !== 'string' ||
    projectId.length === 0 ||
    projectId.length > MAX_PROJECT_ID_LENGTH ||
    projectId.trim() !== projectId ||
    hasControlCharacters(projectId)
  ) {
    throw new McpContextError(
      'invalid_arguments',
      `projectId must be a non-empty string of at most ${MAX_PROJECT_ID_LENGTH} characters without control characters.`,
    );
  }
  return projectId;
}

function validatePathInput(value, label, maxLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes('\u0000')
  ) {
    throw new McpContextError(
      'invalid_arguments',
      `${label} must be a non-empty path string of at most ${maxLength} characters.`,
    );
  }
  return value;
}

function normaliseProjectRelativePath(value) {
  let candidate = validatePathInput(value, 'files[]', MAX_FILE_PATH_LENGTH);
  if (candidate.trim() !== candidate) {
    throw new McpContextError('invalid_arguments', 'files[] entries must not have leading or trailing whitespace.');
  }
  candidate = candidate.replaceAll('\\', '/');
  while (candidate.startsWith('./')) candidate = candidate.slice(2);
  if (
    candidate.length === 0 ||
    candidate.startsWith('/') ||
    isUncOrDevicePath(candidate) ||
    WINDOWS_DRIVE_PATTERN.test(candidate) ||
    hasControlCharacters(candidate)
  ) {
    throw new McpContextError(
      'invalid_arguments',
      'files[] entries must be exact project-relative paths, not absolute, UNC, drive-letter or control-character paths.',
    );
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new McpContextError(
      'invalid_arguments',
      'files[] entries must not contain empty, "." or ".." path segments.',
    );
  }
  return segments.join('/');
}

function normaliseEvidencePathOrNull(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FILE_PATH_LENGTH) return null;
  try {
    return normaliseProjectRelativePath(value);
  } catch {
    return null;
  }
}

function normaliseIdList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new McpContextError('invalid_arguments', `${label} must be an array of strings.`);
  }
  if (value.length > MAX_SELECTORS) {
    throw new McpContextError('invalid_arguments', `${label} may contain at most ${MAX_SELECTORS} entries.`);
  }
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > MAX_SELECTOR_ID_LENGTH ||
      item.trim() !== item ||
      hasControlCharacters(item)
    ) {
      throw new McpContextError(
        'invalid_arguments',
        `${label} entries must be non-empty strings of at most ${MAX_SELECTOR_ID_LENGTH} characters without control characters.`,
      );
    }
    if (seen.has(item)) {
      throw new McpContextError('invalid_arguments', `${label} must not contain duplicate entries.`);
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function normaliseFileList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new McpContextError('invalid_arguments', 'files must be an array of strings.');
  }
  if (value.length > MAX_SELECTORS) {
    throw new McpContextError('invalid_arguments', `files may contain at most ${MAX_SELECTORS} entries.`);
  }
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const normalised = normaliseProjectRelativePath(item);
    if (seen.has(normalised)) {
      throw new McpContextError('invalid_arguments', 'files must not contain duplicate entries.');
    }
    seen.add(normalised);
    result.push(normalised);
  }
  return result;
}

function normaliseTask(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new McpContextError('invalid_arguments', 'task must be a string when provided.');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TASK_LENGTH) {
    throw new McpContextError(
      'invalid_arguments',
      `task must be a non-empty description of at most ${MAX_TASK_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/**
 * Validate and normalize one tool's arguments. Unknown fields are rejected so
 * a caller cannot smuggle a path, command or write option through the tool.
 *
 * @param {'project_get'|'context_get'|'map_query'} tool
 * @param {unknown} args
 */
export function normaliseToolArguments(tool, args) {
  if (!MCP_TOOL_NAMES.includes(tool)) {
    throw new McpContextError('invalid_arguments', 'Unknown tool.');
  }
  if (!isRecord(args)) {
    throw new McpContextError('invalid_arguments', 'Tool arguments must be an object.');
  }
  const allowed =
    tool === 'project_get'
      ? ['projectId']
      : ['projectId', 'nodeIds', 'roadmapItemIds', 'files', 'task'];
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new McpContextError(
      'invalid_arguments',
      'Unknown tool argument; arbitrary paths, commands and write options are not accepted.',
      { unknownArguments: unknown.slice(0, 10), allowedArguments: allowed },
    );
  }
  if (!Object.hasOwn(args, 'projectId')) {
    throw new McpContextError('invalid_arguments', 'projectId is required.');
  }
  const result = { projectId: validateProjectId(args.projectId) };
  if (tool === 'project_get') return result;

  result.nodeIds = normaliseIdList(args.nodeIds, 'nodeIds');
  result.roadmapItemIds = normaliseIdList(args.roadmapItemIds, 'roadmapItemIds');
  result.files = normaliseFileList(args.files);
  if (args.task !== undefined) result.task = normaliseTask(args.task);

  if (
    tool === 'context_get' &&
    result.nodeIds.length === 0 &&
    result.roadmapItemIds.length === 0 &&
    result.files.length === 0
  ) {
    throw new McpContextError(
      'explicit_selector_required',
      'context_get requires explicit nodeIds, roadmapItemIds or exact project-relative files; task text is only a purpose description and is not a semantic search.',
    );
  }
  return result;
}

/**
 * Resolve the fixed project binding once at startup. A relative --state is
 * resolved inside the project root, then both paths are canonicalized and the
 * state must remain inside that root. A missing state file is allowed so a
 * later call can report state_not_found and recover when the file appears.
 *
 * @param {{projectRoot: string, state: string, projectId: string}} input
 */
export async function resolveProjectBinding(input) {
  if (!isRecord(input)) {
    throw new McpContextError('invalid_arguments', 'A project binding object is required.');
  }
  validatePathInput(input.projectRoot, 'projectRoot', MAX_STATE_PATH_LENGTH);
  const stateInput = validatePathInput(input.state, 'state', MAX_STATE_PATH_LENGTH);
  const projectId = validateProjectId(input.projectId);

  const absoluteRoot = path.resolve(input.projectRoot);
  if (isUncOrDevicePath(absoluteRoot)) {
    throw new McpContextError('unc_path', 'UNC/device project roots are not supported.');
  }
  let rootReal;
  let rootStat;
  try {
    rootReal = await fsp.realpath(absoluteRoot);
    rootStat = await fsp.stat(rootReal);
  } catch {
    throw new McpContextError('invalid_project_root', 'The project root does not exist or is not accessible.');
  }
  if (!rootStat.isDirectory()) {
    throw new McpContextError('invalid_project_root', 'The project root is not a directory.');
  }

  const absoluteState = path.isAbsolute(stateInput)
    ? path.resolve(stateInput)
    : path.resolve(rootReal, stateInput);
  if (isUncOrDevicePath(absoluteState)) {
    throw new McpContextError('unc_path', 'UNC/device state paths are not supported.');
  }

  let canonical;
  try {
    canonical = await canonicalizeStatePath(absoluteState, { mustExist: false });
  } catch (error) {
    if (error?.code === 'unc_path') {
      throw new McpContextError('unc_path', 'UNC/device state paths are not supported.');
    }
    if (error?.code === 'state_parent_missing') {
      throw new McpContextError('invalid_state_path', 'The state parent directory is not accessible.');
    }
    if (error?.code === 'state_not_file') {
      throw new McpContextError('invalid_state_path', 'The state path is not a regular file.');
    }
    throw new McpContextError('invalid_state_path', 'The state path cannot be canonicalized safely.');
  }

  const relativeStatePath = path.relative(rootReal, canonical.path);
  if (isOutsideRelative(relativeStatePath)) {
    throw new McpContextError(
      'state_outside_project_root',
      'The normalized state path must remain inside the bound project root.',
    );
  }

  return {
    projectRoot: rootReal,
    statePath: canonical.path,
    projectId,
    relativeStatePath: relativeStatePath.split(path.sep).join('/'),
  };
}

function mapStateReadError(error, limits) {
  if (error instanceof McpContextError) return error;
  switch (error?.code) {
    case 'state_not_found':
      return new McpContextError('state_not_found', 'The bound project state file does not exist.');
    case 'state_too_large':
      return new McpContextError(
        'state_too_large',
        `The bound project state file exceeds the ${limits.maxStateBytes}-byte limit.`,
        { maxStateBytes: limits.maxStateBytes },
      );
    case 'hardlink_state':
      return new McpContextError(
        'state_unreadable',
        'The state file has multiple hard links and is rejected by the read-only reader.',
      );
    case 'invalid_utf8':
      return new McpContextError('invalid_state', 'The state file is not valid UTF-8.');
    case 'state_not_file':
      return new McpContextError('state_unreadable', 'The state path is not a regular file.');
    default:
      return new McpContextError('state_unreadable', 'The state file cannot be read safely.');
  }
}

/**
 * Re-read and fully validate the bound state for exactly one request. Nothing
 * is cached: a caller that repeats a tool call sees the current bytes or a
 * safe rejection, never a previous response.
 *
 * @param {{statePath: string, projectId: string, relativeStatePath: string}} binding
 * @param {{limits?: object}} [options]
 */
export async function readBoundProjectState(binding, options = {}) {
  const limits = normaliseLimits(options.limits);
  let loaded;
  try {
    loaded = await readBoundBytes(binding, limits);
  } catch (error) {
    throw mapStateReadError(error, limits);
  }

  let state;
  try {
    state = JSON.parse(loaded.text);
  } catch {
    throw new McpContextError('invalid_state', 'The state file is not valid JSON.');
  }
  if (!isRecord(state)) {
    throw new McpContextError('invalid_state', 'The state file must contain a JSON object.');
  }
  if (state.schemaVersion !== '0.1' && state.schemaVersion !== '0.2') {
    throw new McpContextError(
      'unsupported_schema',
      'The state schemaVersion is not supported; only the frozen 0.1 and strict 0.2 contracts are read.',
      { supportedSchemaVersions: ['0.1', '0.2'] },
    );
  }
  let validationErrors;
  try {
    validationErrors = validateFullState(state);
  } catch (error) {
    if (error?.code === 'dependency_unavailable') {
      throw new McpContextError(
        'dependency_unavailable',
        'Schema validation dependencies are unavailable; run npm ci in the skill directory.',
      );
    }
    throw new McpContextError('invalid_state', 'The state validator failed.');
  }
  if (validationErrors.length > 0) {
    throw new McpContextError(
      'invalid_state',
      'The state file failed full schema, reference or intent validation.',
      { validationErrorCount: validationErrors.length },
    );
  }
  if (!isRecord(state.project) || state.project.id !== binding.projectId) {
    throw new McpContextError(
      'project_mismatch',
      'The state file belongs to a different project than the bound projectId.',
    );
  }

  return {
    state,
    schemaVersion: state.schemaVersion,
    stateVersion: state.stateVersion,
    projectId: state.project.id,
    fileDigest: loaded.digest,
    byteSize: loaded.size,
    relativeStatePath: binding.relativeStatePath,
    readAt: new Date().toISOString(),
  };
}

// Bound reads use an opened handle and bounded allocation, not stat + readFile.
// Re-check canonical identity on every request (including parent junction swaps).
// This detects cooperative replacements; it is not OS-level isolation from a
// hostile local process racing a reparse point between these checks.
async function readBoundBytes(binding, limits) {
  const samePath = (a, b) => process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase() : a === b;
  const checkPath = async () => {
    const actual = await fsp.realpath(binding.statePath);
    if (isOutsideRelative(path.relative(binding.projectRoot, actual)) || !samePath(actual, binding.statePath)) {
      throw new McpContextError('state_path_changed', 'The bound state path no longer has its original project-contained identity.');
    }
    const stat = await fsp.lstat(binding.statePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new McpContextError('state_unreadable', 'The bound state must remain a single-link regular file.');
    }
    return stat;
  };
  let handle;
  try {
    const before = await checkPath();
    if (before.size > limits.maxStateBytes) throw new McpContextError('state_too_large', 'The bound state exceeds the configured byte limit.');
    handle = await fsp.open(binding.statePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) throw new McpContextError('state_changed', 'The state changed while opening; retry the request.');
    const buffer = Buffer.alloc(Math.min(before.size + 1, limits.maxStateBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await checkPath(), final = await handle.stat();
    if (length !== before.size || !sameFile(before, after) || !sameFile(opened, final)) throw new McpContextError('state_changed', 'The state changed while reading; retry the request.');
    const bytes = buffer.subarray(0, length);
    let text;
    try { text = new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
    catch { throw new McpContextError('invalid_state', 'The bound state is not valid UTF-8.'); }
    return { text, digest:sha256Bytes(bytes), size:length };
  } catch (error) {
    if (error?.code === 'ENOENT') throw new McpContextError('state_not_found', 'The bound state file does not exist.');
    throw error;
  } finally { await handle?.close(); }
}

function collectionsOf(state) {
  return {
    baselines: asArray(state.baselines),
    nodes: asArray(state.nodes),
    edges: asArray(state.edges),
    evidence: asArray(state.evidence),
    decisions: asArray(state.decisions),
    claims: asArray(state.intentClaims),
    proposals: asArray(state.proposals),
    reviews: asArray(state.reviews),
    checks: asArray(state.checks),
    roadmapItems: asArray(state.roadmapItems),
    roadmapItemsPresent: Array.isArray(state.roadmapItems),
    featureCheckpoints: asArray(state.featureCheckpoints),
    featureCheckpointsPresent: Array.isArray(state.featureCheckpoints),
    conversationCaptures: asArray(state.conversationCaptures),
  };
}

function countsOf(collections) {
  return {
    baselines: collections.baselines.length,
    nodes: collections.nodes.length,
    edges: collections.edges.length,
    evidence: collections.evidence.length,
    decisions: collections.decisions.length,
    intentClaims: collections.claims.length,
    proposals: collections.proposals.length,
    reviews: collections.reviews.length,
    checks: collections.checks.length,
    roadmapItems: collections.roadmapItems.length,
    featureCheckpoints: collections.featureCheckpoints.length,
  };
}

function roadmapSummaryOf(state, collections) {
  const horizons = { unplanned: 0, now: 0, next: 0, later: 0, other: 0 };
  const statuses = { idea: 0, ready: 0, in_progress: 0, paused: 0, closed: 0, other: 0 };
  for (const item of collections.roadmapItems) {
    if (!isRecord(item)) continue;
    if (Object.hasOwn(horizons, item.horizon)) horizons[item.horizon] += 1;
    else horizons.other += 1;
    if (Object.hasOwn(statuses, item.status)) statuses[item.status] += 1;
    else statuses.other += 1;
  }
  return {
    present: collections.roadmapItemsPresent,
    itemCount: collections.roadmapItems.length,
    horizons,
    statuses,
    planningOnly: true,
    grantsImplementationPermission: false,
    note: 'Roadmap horizon and status describe planning position only; they do not authorize implementation, merge or release.',
  };
}

function selectedCapabilityIds(scope) {
  return scope.selectedNodes
    .filter((node) => node.kind === 'capability')
    .map((node) => node.id);
}

// Feature progress is bound to explicit selector seeds, not to the full
// node/item/file closure. A shared implementation or verification node can
// pull a sibling capability into selectedNodes; that must not add its progress.
// nodeIds and roadmapItemIds name capability seeds directly. A file contributes
// only the capability that directly lists the exact evidence path. With no
// selectors, map_query keeps its whole-state behavior.
function selectedFeatureCapabilityIds(scope, collections, args) {
  const hasSelectors =
    (args.nodeIds?.length ?? 0) + (args.roadmapItemIds?.length ?? 0) + (args.files?.length ?? 0) > 0;
  if (!hasSelectors) return selectedCapabilityIds(scope);
  const nodes = collections.nodes.filter(isRecord);
  const capabilities = new Set(nodes.filter((node) => node.kind === 'capability').map((node) => node.id));
  const itemsById = byId(collections.roadmapItems.filter(isRecord));
  const evidence = collections.evidence.filter(isRecord);
  const result = [];
  const seen = new Set();
  const add = (id) => {
    if (typeof id !== 'string' || !capabilities.has(id) || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  };
  for (const id of args.nodeIds ?? []) add(id);
  for (const id of args.roadmapItemIds ?? []) add(itemsById.get(id)?.nodeId);
  if ((args.files?.length ?? 0) > 0) {
    const paths = new Set(args.files);
    const directEvidenceIds = new Set(
      evidence
        .filter((entry) => paths.has(normaliseEvidencePathOrNull(entry.path)))
        .map((entry) => entry.id),
    );
    for (const node of nodes) {
      if (node.kind !== 'capability') continue;
      if (asArray(node.evidenceIds).some((id) => directEvidenceIds.has(id))) add(node.id);
    }
  }
  return result;
}

function roadmapItemById(collections, id) {
  if (typeof id !== 'string') return null;
  return collections.roadmapItems.find((item) => isRecord(item) && item.id === id) ?? null;
}

function featureDigest(content) {
  return sha256Bytes(canonicalStringify(content));
}

const FEATURE_PROGRESS_NOTE = 'Feature progress is a saved work summary, not a review, product decision, completion metric or execution authorization.';
const FEATURE_CHECKPOINT_NOTE = 'A checkpoint nextAction is descriptive only; this server does not execute it and its authorizationRequired values are declarations, not grants.';

function projectFeatureProgress(state, limits) {
  // Counts are always whole-state; the index is a separate bounded projection
  // and deliberately does not compute per-Feature content fingerprints.
  const counts = deriveFeatureProgress(state, { includeFeatures: false });
  const indexView = deriveFeatureProgress(state, {
    includeFeatures: true,
    includeRetired: false,
    maxFeatures: limits.maxNodes,
  });
  const features = indexView.features.map((feature) => ({
    nodeId: feature.nodeId,
    label: feature.label,
    status: feature.status,
    retired: feature.retired === true,
    checkpointCount: feature.checkpoints.count,
    latestId: feature.latest?.id ?? null,
    latestSummary: feature.latest?.summary ?? null,
    latestAt: feature.latest?.createdAt ?? null,
    nextActionsStatus: feature.latest?.nextActionsStatus ?? null,
    // Bounded reading of the saved delivery statement; the full reason and
    // basis text stay in map_query/context_get for explicitly selected nodes.
    delivery: feature.delivery
      ? {
          status: feature.delivery.status,
          label: feature.delivery.label,
          origin: feature.delivery.origin,
          needsReview: feature.delivery.needsReview === true,
          savedAt: feature.delivery.savedAt ?? null,
        }
      : null,
    roadmap: feature.roadmap.item
      ? {
          id: feature.roadmap.item.id,
          horizon: feature.roadmap.item.horizon,
          status: feature.roadmap.item.status,
        }
      : null,
  }));
  const emptyState =
    counts.totals.capabilityNodes === 0
      ? 'no_capability_nodes'
      : counts.totals.checkpoints === 0
        ? 'no_checkpoints_recorded'
        : null;
  return {
    supported: counts.supported === true,
    checkpointCollection: counts.checkpointCollection,
    capabilityNodes: counts.totals.capabilityNodes,
    retiredCapabilityNodes: counts.totals.retiredCapabilityNodes,
    featuresWithCheckpoints: counts.totals.featuresWithCheckpoints,
    featuresWithoutCheckpoints: counts.totals.featuresWithoutCheckpoints,
    checkpoints: counts.totals.checkpoints,
    featuresWithRoadmap: counts.totals.featuresWithRoadmap,
    featuresWithoutRoadmap: counts.totals.featuresWithoutRoadmap,
    roadmapCollectionPresent: counts.totals.roadmapCollectionPresent,
    emptyState,
    note: `${FEATURE_PROGRESS_NOTE} ${FEATURE_CHECKPOINT_NOTE}`,
    index: {
      limit: limits.maxNodes,
      truncated: indexView.totals.featuresOmitted > 0,
      features,
    },
  };
}

function mapFeatureProgressEntry(state, nodeId) {
  if (state?.schemaVersion !== '0.2') return null;
  const view = selectFeatureContext(state, nodeId, { digest: featureDigest });
  return {
    nodeId,
    label: view.feature?.label ?? '',
    status: view.feature?.status ?? '',
    roadmap: view.roadmap.item
      ? {
          id: view.roadmap.item.id,
          horizon: view.roadmap.item.horizon,
          status: view.roadmap.item.status,
          objective: view.roadmap.item.objective,
        }
      : null,
    checkpoints: {
      count: view.checkpoints.count,
      tailId: view.checkpoints.tailId,
    },
    latest: view.latest
      ? {
          id: view.latest.id,
          createdAt: view.latest.createdAt,
          summary: view.latest.summary,
          stopPoint: view.latest.stopPoint ?? null,
          nextActionsStatus: view.latest.nextActionsStatus,
          firstNextAction: view.latest.nextActions?.[0] ?? null,
          remainingCount: asArray(view.latest.remaining).length,
          workDoneCount: asArray(view.latest.workDone).length,
        }
      : null,
    // Full saved-delivery reading for an explicitly selected node.
    delivery: view.delivery ?? null,
    context: view.context,
    source: view.source,
    warnings: view.checkpoints.validation.ok
      ? []
      : asArray(view.checkpoints.validation.errors).slice(0, 50),
  };
}

function basisRefKey(collection, id) {
  return `${collection}\u0000${id}`;
}

function collectBasisRefs(latest) {
  const result = [];
  const seen = new Set();
  const add = (ref) => {
    if (!isRecord(ref) || typeof ref.collection !== 'string' || typeof ref.id !== 'string') return;
    const key = basisRefKey(ref.collection, ref.id);
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ collection: ref.collection, id: ref.id });
  };
  if (!isRecord(latest)) return result;
  for (const ref of asArray(latest.basis?.refs)) add(ref);
  for (const work of asArray(latest.workDone)) {
    for (const ref of asArray(work?.basisRefs)) add(ref);
  }
  for (const remaining of asArray(latest.remaining)) {
    for (const ref of asArray(remaining?.basisRefs)) add(ref);
  }
  for (const ref of asArray(latest.delivery?.basisRefs)) add(ref);
  return result;
}

function basisCollectionIndex(collections) {
  return {
    node: byId(collections.nodes),
    edge: byId(collections.edges),
    evidence: byId(collections.evidence),
    check: byId(collections.checks),
    intentClaim: byId(collections.claims),
    decision: byId(collections.decisions),
    proposal: byId(collections.proposals),
    review: byId(collections.reviews),
    roadmapItem: byId(collections.roadmapItems),
    featureCheckpoint: byId(collections.featureCheckpoints),
  };
}

function resolveBasisRecord(ref, featureNodeId, index) {
  const byCollection = index[ref.collection];
  if (!byCollection) return { found: false, record: null };
  const record = byCollection.get(ref.id) ?? null;
  if (!record) return { found: false, record: null };
  if (ref.collection === 'featureCheckpoint' && record.nodeId !== featureNodeId) {
    return { found: false, record: null };
  }
  return { found: true, record: clone(record) };
}

function resolveBasisRecords(refs, featureNodeId, index) {
  return refs.map((ref) => {
    // A referenced checkpoint is resolved exactly one hop (the saved record),
    // never by recursively expanding its own basis refs.
    const resolved = resolveBasisRecord(ref, featureNodeId, index);
    return {
      collection: ref.collection,
      id: ref.id,
      found: resolved.found,
      record: resolved.record,
    };
  });
}

function contextFeatureProgress(state, scope, collections, limits, featureNodeIds) {
  if (state?.schemaVersion !== '0.2') return [];
  const nodeIds = featureNodeIds;
  if (nodeIds.length === 0) return [];
  const views = nodeIds.map((nodeId) =>
    selectFeatureContext(state, nodeId, { digest: featureDigest, includeChain: true }),
  );
  const totalCheckpoints = views.reduce(
    (total, view) => total + (Number.isInteger(view.checkpoints.count) ? view.checkpoints.count : 0),
    0,
  );
  if (totalCheckpoints > limits.maxFeatureCheckpoints) {
    throw new McpContextError(
      'result_too_large',
      'The selected Feature checkpoint chains exceed the configured record limit; narrow nodeIds and retry.',
      {
        collection: 'featureCheckpoints',
        count: totalCheckpoints,
        limit: limits.maxFeatureCheckpoints,
        nodeIds: nodeIds.slice(0, MAX_SELECTORS),
      },
    );
  }
  const refsByFeature = views.map((view) => collectBasisRefs(view.latest));
  const totalBasisRefs = refsByFeature.reduce((total, refs) => total + refs.length, 0);
  if (totalBasisRefs > limits.maxCheckpointBasisRecords) {
    throw new McpContextError(
      'result_too_large',
      'The selected Feature basis records exceed the configured limit; narrow nodeIds and retry.',
      {
        collection: 'checkpointBasisRecords',
        count: totalBasisRefs,
        limit: limits.maxCheckpointBasisRecords,
        nodeIds: nodeIds.slice(0, MAX_SELECTORS),
      },
    );
  }
  const index = basisCollectionIndex(collections);
  return views.map((view, position) => {
    const fullItem = view.roadmap.item ? roadmapItemById(collections, view.roadmap.item.id) : null;
    const records = view.checkpoints.ordered.map((record) => clone(record));
    return {
      feature: view.feature
        ? { nodeId: view.feature.id, label: view.feature.label, status: view.feature.status }
        : null,
      roadmap: {
        collectionPresent: view.roadmap.collectionPresent === true,
        item: fullItem ? clone(fullItem) : null,
      },
      checkpoints: {
        supported: view.checkpoints.supported === true,
        count: view.checkpoints.count,
        rootId: view.checkpoints.rootId,
        tailId: view.checkpoints.tailId,
        returned: records.length,
        truncated: false,
        records,
      },
      latest: view.latest ? clone(view.latest) : null,
      // Saved delivery-stage reading; a projection of the saved record, not a
      // fresh acceptance or release decision.
      delivery: view.delivery ?? null,
      context: view.context,
      source: view.source,
      basisRecords: resolveBasisRecords(refsByFeature[position], nodeIds[position], index),
      authorization: {
        checkpointIsNotReview: view.authorization.checkpointIsNotReview,
        latestIsNotAuthoritative: view.authorization.latestIsNotAuthoritative,
        nextActionsAreNotAuthorization: view.authorization.nextActionsAreNotAuthorization,
        planningIsNotPermission: view.authorization.planningIsNotPermission,
        sourceNotVerifiedByThisRead: view.authorization.sourceNotVerifiedByThisRead,
        deliveryIsNotAcceptance: view.authorization.deliveryIsNotAcceptance,
        deliveryIsNotReleaseAuthorization: view.authorization.deliveryIsNotReleaseAuthorization,
        writeToolsExposed: view.authorization.writeToolsExposed,
      },
      notes: [...asArray(view.notes)],
    };
  });
}

function stateView(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    stateVersion: snapshot.stateVersion,
    fileDigest: snapshot.fileDigest,
    byteSize: snapshot.byteSize,
    relativePath: snapshot.relativeStatePath,
    readAt: snapshot.readAt,
  };
}

function boundaryNotes(snapshot, extra = []) {
  const notes = [
    'Read-only state query: no write, confirmation, migration, lock or view-generation operation is exposed.',
    'Only the bound state file is read. Source files, workspace scans, git, tests and network access are not used.',
    'Candidate claims are not confirmed product intent; confirmed intent is only what a recorded governing decision confirms.',
    'Historical superseded, retired and dismissed claims are history, not current authorization.',
    'A test definition is not a test execution; the recorded validation status is returned unchanged.',
    'Roadmap horizon, status and objective are planning context only and grant no permission to implement, merge or release.',
    'acceptanceCriteria are planning targets, not test results or verification evidence.',
    'Feature progress checkpoints are saved work summaries, not reviews, product decisions, completion percentages or proof of delivery.',
    'A checkpoint nextAction is a description only; this server does not execute it and a listed authorization category is not a grant.',
    'featureProgress.delivery is a reading projection of saved checkpoint content (an optional saved delivery statement, or structured remaining/nextAction categories); it is not a fresh acceptance, intent confirmation or release authorization, and a changed or invalid context downgrades it to needs-review.',
    'A checkpoint context fingerprint covers saved-state context only; no source file, runtime behavior or current test result is verified by this read.',
    'task text is a purpose description only; no semantic search, natural-language retrieval or source inspection is performed.',
    'Each response is a snapshot of the state bytes read for that request; a later file change requires another request.',
  ];
  if (snapshot.schemaVersion === '0.1') {
    notes.push(
      'This state is schema 0.1: claim-level intent and roadmapItems are unavailable; migrate explicitly before relying on those records.',
    );
  }
  return [...notes, ...extra];
}

function coverageView(state, snapshot, collections, activeBaseline, unmatched, limits) {
  return {
    stateOnly: true,
    sourceFilesRead: false,
    workspaceScanned: false,
    networkUsed: false,
    writerLockAcquired: false,
    viewGenerated: false,
    state: stateView(snapshot),
    baseline: activeBaseline
      ? {
          id: activeBaseline.id,
          revision: clone(activeBaseline.revision ?? null),
          scope: clone(activeBaseline.scope ?? null),
        }
      : null,
    migration: stateMigrationView(state),
    unmatched: clone(unmatched),
    limits: publicLimits(limits),
    truncated: false,
    omissions: ['Records outside the explicit selectors and documented relation closure are not searched. Neighbor references are not complete intent context; query their IDs before acting on them.'],
    selectionRules: ['explicit node/item IDs or exact stored evidence paths', 'contains/part_of ancestors', 'incoming constrains sources', 'outgoing implemented_by/verified_by evidence nodes and their incoming owners', 'direct roadmap dependencies are planning references; query their IDs for intent context', 'Feature progress is selected only for capability nodes explicitly named by nodeIds, by a selected roadmap item, or as the direct evidence-file owner; its basis records are the latest checkpoint refs plus workDone/remaining refs, with same-Feature checkpoint refs resolved one hop'],
    counts: countsOf(collections),
  };
}

function stateMigrationView(state) {
  return isRecord(state.migration) ? clone(state.migration) : null;
}

function activeBaselineOf(state, collections) {
  return collections.baselines.find((baseline) => baseline?.id === state.activeBaselineId) ?? null;
}

function claimIntent(claim) {
  return {
    statement: typeof claim.statement === 'string' ? claim.statement : '',
    scope: asArray(claim.scope).filter((item) => typeof item === 'string'),
    conditions: asArray(claim.conditions).filter((item) => typeof item === 'string'),
    exceptions: asArray(claim.exceptions).filter((item) => typeof item === 'string'),
  };
}

function decisionIntent(decision) {
  if (!isRecord(decision.intent)) return null;
  return claimIntent(decision.intent);
}

function reviewSummary(review) {
  const command = isRecord(review.command) ? review.command : {};
  return {
    id: review.id ?? null,
    createdAt: review.createdAt ?? null,
    actor: review.actor ?? null,
    source: review.source ?? null,
    action: command.action ?? null,
    targetClaimId: command.targetClaimId ?? null,
    targetProposalId: command.targetProposalId ?? null,
    observedStateVersion: review.observedStateVersion ?? null,
    resultingStateVersion: review.resultingStateVersion ?? null,
    createdClaimIds: asArray(review.createdClaimIds).filter((item) => typeof item === 'string'),
    affectedClaimIds: asArray(review.affectedClaimIds).filter((item) => typeof item === 'string'),
    resultingDecisionId: review.resultingDecisionId ?? null,
    resultingProposalId: review.resultingProposalId ?? null,
    payloadDigest: review.payloadDigest ?? null,
    commandPayloadOmitted: true,
  };
}

function claimView(claim, reviewsById) {
  const review = typeof claim.createdByReviewId === 'string'
    ? reviewsById.get(claim.createdByReviewId) ?? null
    : null;
  let interpretation;
  if (claim.status === 'confirmed') interpretation = 'confirmed_intent_recorded_by_decision';
  else if (claim.status === 'candidate') interpretation = 'candidate_not_confirmed_intent';
  else if (claim.status === 'superseded') interpretation = 'historical_replaced_intent';
  else if (claim.status === 'retired') interpretation = 'historical_stopped_intent';
  else if (claim.status === 'dismissed') interpretation = 'historical_dismissed_candidate';
  else interpretation = 'unknown_lifecycle_state';

  return {
    ...clone(claim),
    intent: claimIntent(claim),
    source: {
      origin: claim.origin ?? null,
      createdAt: claim.createdAt ?? null,
      createdByReviewId: claim.createdByReviewId ?? null,
      conversation: claim.conversationSource ?? null,
      review: review ? reviewSummary(review) : null,
      assessment: isRecord(claim.assessment) ? clone(claim.assessment) : null,
    },
    decision: {
      governingDecisionId: claim.governingDecisionId ?? null,
      retiredByDecisionId: claim.retiredByDecisionId ?? null,
    },
    history: {
      supersedesClaimIds: asArray(claim.supersedesClaimIds).filter((item) => typeof item === 'string'),
      supersededByClaimIds: asArray(claim.supersededByClaimIds).filter((item) => typeof item === 'string'),
    },
    interpretation,
  };
}

function decisionAuthorization(decision) {
  if (decision.recordVersion === '0.1') {
    if (decision.status === 'superseded') return 'historical_superseded_legacy_decision';
    if (decision.status === 'confirmed') return 'legacy_confirmation_not_aligned_to_current_claims';
    return 'legacy_decision_not_current_product_intent';
  }
  if (decision.status === 'superseded') return 'historical_superseded_decision';
  if (decision.kind === 'adopt_intent') return 'current_confirmed_intent';
  if (decision.kind === 'stop_intent') return 'current_stop_decision';
  return 'unknown_decision_kind';
}

function decisionView(decision) {
  return {
    ...clone(decision),
    intent: decisionIntent(decision),
    recordKind:
      decision.recordVersion === '0.2'
        ? (decision.kind ?? 'intent_decision')
        : 'legacy_0_1_confirmation',
    authorization: decisionAuthorization(decision),
    applicability: typeof decision.applicability === 'string' ? decision.applicability : null,
  };
}

function evidenceView(evidence) {
  const kind = evidence.kind;
  let role = 'other';
  if (kind === 'test_definition') role = 'test_definition';
  else if (kind === 'test_execution') role = 'test_execution';
  else if (kind === 'runtime_observation') role = 'runtime_observation';
  else if (kind === 'decision_record') role = 'decision_record';
  else if (kind === 'implementation') role = 'implementation_reference';
  else if (
    kind === 'product_document' ||
    kind === 'requirement' ||
    kind === 'user_statement' ||
    kind === 'git_history' ||
    kind === 'inference'
  ) {
    role = 'source_reference';
  }
  return {
    ...clone(evidence),
    role,
    isDefinition: kind === 'test_definition',
    isExecution: kind === 'test_execution' || kind === 'runtime_observation',
    applicableRevision: typeof evidence.revision === 'string' ? evidence.revision : null,
    definitionExecutionNote:
      kind === 'test_definition'
        ? 'A stored test definition is not an execution result.'
        : null,
  };
}

function roadmapItemView(item) {
  return {
    ...clone(item),
    planningOnly: true,
    grantsImplementationPermission: false,
    authorization: 'none',
    horizonMeaning: 'ordering_context_not_permission',
    acceptanceCriteriaRole: 'planning_targets_not_test_results',
    closedReasonRole:
      typeof item.closedReason === 'string' && item.closedReason.length > 0
        ? 'closing_is_not_implementation_or_verification'
        : null,
  };
}

function roadmapItemSummary(item) {
  return {
    id: item.id ?? null,
    nodeId: item.nodeId ?? null,
    objective: item.objective ?? null,
    horizon: item.horizon ?? null,
    status: item.status ?? null,
    planningOnly: true,
    grantsImplementationPermission: false,
  };
}

function selectScope(state, collections, args, limits, options = {}) {
  const nodes = collections.nodes.filter(isRecord);
  const edges = collections.edges.filter(isRecord);
  const items = collections.roadmapItems.filter(isRecord);
  const evidence = collections.evidence.filter(isRecord);
  const decisions = collections.decisions.filter(isRecord);
  const claims = collections.claims.filter(isRecord);
  const nodesById = byId(nodes);
  const itemsById = byId(items);
  const evidenceById = byId(evidence);
  const claimsById = byId(claims);

  const matched = { nodeIds: [], roadmapItemIds: [], files: [] };
  const unmatched = { nodeIds: [], roadmapItemIds: [], files: [] };
  const selectedNodeIds = new Set();
  const requestedItemIds = new Set();
  const matchedEvidenceIds = new Set();

  for (const nodeId of args.nodeIds ?? []) {
    if (nodesById.has(nodeId)) {
      matched.nodeIds.push(nodeId);
      selectedNodeIds.add(nodeId);
    } else {
      unmatched.nodeIds.push(nodeId);
    }
  }
  for (const itemId of args.roadmapItemIds ?? []) {
    const item = itemsById.get(itemId);
    if (!item) {
      unmatched.roadmapItemIds.push(itemId);
      continue;
    }
    matched.roadmapItemIds.push(itemId);
    requestedItemIds.add(itemId);
    if (typeof item.nodeId === 'string' && nodesById.has(item.nodeId)) {
      selectedNodeIds.add(item.nodeId);
    }
  }

  for (const file of args.files ?? []) {
    const hits = evidence.filter((entry) => normaliseEvidencePathOrNull(entry.path) === file);
    if (hits.length === 0) {
      unmatched.files.push(file);
      continue;
    }
    matched.files.push(file);
    for (const entry of hits) {
      matchedEvidenceIds.add(entry.id);
      for (const node of nodes) {
        if (asArray(node.evidenceIds).includes(entry.id)) selectedNodeIds.add(node.id);
      }
      for (const edge of edges) {
        if (!asArray(edge.evidenceIds).includes(entry.id)) continue;
        if (nodesById.has(edge.from)) selectedNodeIds.add(edge.from);
        if (nodesById.has(edge.to)) selectedNodeIds.add(edge.to);
      }
      for (const decision of decisions) {
        if (!asArray(decision.evidenceIds).includes(entry.id)) continue;
        for (const claimId of asArray(decision.claimIds)) {
          const claim = claimsById.get(claimId);
          if (claim && nodesById.has(claim.nodeId)) selectedNodeIds.add(claim.nodeId);
        }
      }
    }
  }

  const hasSelectors =
    (args.nodeIds?.length ?? 0) + (args.roadmapItemIds?.length ?? 0) + (args.files?.length ?? 0) > 0;
  if (!hasSelectors && options.includeAllWhenEmpty) {
    for (const node of nodes) selectedNodeIds.add(node.id);
  }

  // Include governing ancestor/constraint intent and actual implementation /
  // verification evidence nodes. Never silently return a feature title while
  // leaving its recorded governing commitment in a neighbor-only summary.
  let scopeGrew = true;
  while (scopeGrew) {
    scopeGrew = false;
    const include = (id) => {
      if (nodesById.has(id) && !selectedNodeIds.has(id)) { selectedNodeIds.add(id); scopeGrew = true; }
    };
    for (const edge of edges) {
      if (edge.kind === 'contains' && selectedNodeIds.has(edge.to)) include(edge.from);
      if (edge.kind === 'part_of' && selectedNodeIds.has(edge.from)) include(edge.to);
      if (edge.kind === 'constrains' && selectedNodeIds.has(edge.to)) include(edge.from);
      if (['implemented_by', 'verified_by'].includes(edge.kind) && selectedNodeIds.has(edge.from)) include(edge.to);
      if (['implemented_by', 'verified_by'].includes(edge.kind) && selectedNodeIds.has(edge.to) && ['implementation','verification'].includes(nodesById.get(edge.to)?.kind)) include(edge.from);
    }
    ensureLimit('nodes', selectedNodeIds.size, limits.maxNodes);
  }

  const selectedNodes = nodes.filter((node) => selectedNodeIds.has(node.id));
  const selectedEdges = edges.filter(
    (edge) => selectedNodeIds.has(edge.from) || selectedNodeIds.has(edge.to),
  );
  ensureLimit('nodes', selectedNodes.length, limits.maxNodes);
  ensureLimit('edges', selectedEdges.length, limits.maxEdges);

  const relatedIds = new Set();
  for (const edge of selectedEdges) {
    if (!selectedNodeIds.has(edge.from) && nodesById.has(edge.from)) relatedIds.add(edge.from);
    if (!selectedNodeIds.has(edge.to) && nodesById.has(edge.to)) relatedIds.add(edge.to);
  }
  ensureLimit('relatedNodes', relatedIds.size, limits.maxRelatedNodes);

  const edgeIdsByRelated = new Map();
  for (const edge of selectedEdges) {
    for (const endpoint of [edge.from, edge.to]) {
      if (!relatedIds.has(endpoint)) continue;
      if (!edgeIdsByRelated.has(endpoint)) edgeIdsByRelated.set(endpoint, []);
      edgeIdsByRelated.get(endpoint).push(edge.id);
    }
  }
  const relatedNodes = nodes
    .filter((node) => relatedIds.has(node.id))
    .map((node) => ({
      id: node.id,
      kind: node.kind ?? null,
      label: node.label ?? null,
      status: node.status ?? null,
      evidenceIds: asArray(node.evidenceIds).filter((item) => typeof item === 'string'),
      relation: 'edge_neighbor',
      edgeIds: [...(edgeIdsByRelated.get(node.id) ?? [])],
    }));

  const unknownIds = new Set();
  for (const node of selectedNodes) if (node.kind === 'unknown') unknownIds.add(node.id);
  for (const nodeId of relatedIds) {
    if (nodesById.get(nodeId)?.kind === 'unknown') unknownIds.add(nodeId);
  }
  ensureLimit('unknownNodes', unknownIds.size, limits.maxUnknownNodes);
  const unknowns = nodes.filter((node) => unknownIds.has(node.id)).map((node) => ({
    ...clone(node),
    unknown: true,
    note: 'This is an explicitly recorded unknown node, not a negative test result.',
  }));

  const selectedItems = items.filter(
    (item) => requestedItemIds.has(item.id) || (typeof item.nodeId === 'string' && selectedNodeIds.has(item.nodeId)),
  );
  const selectedItemIds = new Set(selectedItems.map((item) => item.id));
  const dependencyIds = new Set();
  for (const item of selectedItems) {
    for (const dependencyId of asArray(item.dependsOn)) {
      if (typeof dependencyId === 'string' && !selectedItemIds.has(dependencyId)) dependencyIds.add(dependencyId);
    }
  }
  const dependencyItems = items.filter((item) => dependencyIds.has(item.id));
  ensureLimit(
    'roadmapItems',
    selectedItems.length + dependencyItems.length,
    limits.maxRoadmapItems,
  );

  // Claims are collected for every selected node, including historical ones.
  // A selected claim's whole decision chain is then closed over below.
  const selectedClaims =
    state.schemaVersion === '0.2'
      ? claims.filter((claim) => selectedNodeIds.has(claim.nodeId))
      : [];
  ensureLimit('intentClaims', selectedClaims.length, limits.maxClaims);
  const selectedClaimIds = new Set(selectedClaims.map((claim) => claim.id));

  const selectedDecisionIds = new Set();
  for (const claim of selectedClaims) {
    if (typeof claim.governingDecisionId === 'string') selectedDecisionIds.add(claim.governingDecisionId);
    if (typeof claim.retiredByDecisionId === 'string') selectedDecisionIds.add(claim.retiredByDecisionId);
  }
  for (const decision of decisions) {
    if (asArray(decision.claimIds).some((claimId) => selectedClaimIds.has(claimId))) {
      selectedDecisionIds.add(decision.id);
    }
    if (asArray(decision.evidenceIds).some((evidenceId) => matchedEvidenceIds.has(evidenceId))) {
      selectedDecisionIds.add(decision.id);
    }
  }
  for (const node of selectedNodes) {
    if (typeof node.decisionId === 'string') selectedDecisionIds.add(node.decisionId);
    if (typeof node.legacy?.snapshot?.decisionId === 'string') {
      selectedDecisionIds.add(node.legacy.snapshot.decisionId);
    }
  }
  // Close over both directions of the decision chain so a selected claim
  // receives its full recorded history, not only the current pointer.
  const decisionById = byId(decisions);
  let grew = true;
  while (grew) {
    grew = false;
    for (const decision of decisions) {
      if (selectedDecisionIds.has(decision.id)) continue;
      if (
        (typeof decision.supersededByDecisionId === 'string' &&
          selectedDecisionIds.has(decision.supersededByDecisionId)) ||
        asArray(decision.supersedesDecisionIds).some((id) => selectedDecisionIds.has(id))
      ) {
        selectedDecisionIds.add(decision.id);
        grew = true;
      }
    }
    for (const decisionId of [...selectedDecisionIds]) {
      const decision = decisionById.get(decisionId);
      if (!decision) continue;
      if (typeof decision.supersededByDecisionId === 'string' && !selectedDecisionIds.has(decision.supersededByDecisionId)) {
        selectedDecisionIds.add(decision.supersededByDecisionId);
        grew = true;
      }
      for (const oldId of asArray(decision.supersedesDecisionIds)) {
        if (typeof oldId === 'string' && !selectedDecisionIds.has(oldId)) {
          selectedDecisionIds.add(oldId);
          grew = true;
        }
      }
    }
  }
  const selectedDecisions = decisions.filter((decision) => selectedDecisionIds.has(decision.id));
  ensureLimit('decisions', selectedDecisions.length, limits.maxDecisions);

  const selectedProposals = collections.proposals.filter(
    (proposal) =>
      isRecord(proposal) &&
      (selectedClaimIds.has(proposal.targetClaimId) ||
        selectedClaimIds.has(proposal.resultingClaimId) ||
        (typeof proposal.targetDecisionId === 'string' && selectedDecisionIds.has(proposal.targetDecisionId))),
  );
  ensureLimit('proposals', selectedProposals.length, limits.maxProposals);
  const selectedProposalIds = new Set(selectedProposals.map((proposal) => proposal.id));

  const reviewIds = new Set();
  for (const claim of selectedClaims) {
    if (typeof claim.createdByReviewId === 'string') reviewIds.add(claim.createdByReviewId);
    if (typeof claim.assessment?.reviewId === 'string') reviewIds.add(claim.assessment.reviewId);
  }
  for (const decision of selectedDecisions) {
    if (typeof decision.reviewId === 'string') reviewIds.add(decision.reviewId);
    if (typeof decision.supersededByReviewId === 'string') reviewIds.add(decision.supersededByReviewId);
  }
  for (const proposal of selectedProposals) {
    if (typeof proposal.createdByReviewId === 'string') reviewIds.add(proposal.createdByReviewId);
    if (typeof proposal.closedByReviewId === 'string') reviewIds.add(proposal.closedByReviewId);
  }
  for (const review of collections.reviews) {
    if (!isRecord(review)) continue;
    if (
      selectedClaimIds.has(review.command?.targetClaimId) ||
      asArray(review.createdClaimIds).some((id) => selectedClaimIds.has(id)) ||
      asArray(review.affectedClaimIds).some((id) => selectedClaimIds.has(id)) ||
      selectedDecisionIds.has(review.resultingDecisionId) ||
      selectedProposalIds.has(review.resultingProposalId)
    ) {
      reviewIds.add(review.id);
    }
  }
  const selectedReviews = collections.reviews.filter(
    (review) => isRecord(review) && reviewIds.has(review.id),
  );
  ensureLimit('reviews', selectedReviews.length, limits.maxReviews);

  const evidenceIds = new Set(matchedEvidenceIds);
  for (const node of selectedNodes) {
    for (const id of asArray(node.evidenceIds)) evidenceIds.add(id);
    for (const id of asArray(node.legacy?.snapshot?.evidenceIds)) evidenceIds.add(id);
  }
  for (const edge of selectedEdges) {
    for (const id of asArray(edge.evidenceIds)) evidenceIds.add(id);
  }
  for (const decision of selectedDecisions) {
    for (const id of asArray(decision.evidenceIds)) evidenceIds.add(id);
  }
  const selectedEvidence = collections.evidence.filter(
    (entry) => isRecord(entry) && evidenceIds.has(entry.id),
  );
  ensureLimit('evidence', selectedEvidence.length, limits.maxEvidence);
  const unresolvedEvidenceIds = [...evidenceIds].filter((id) => !evidenceById.has(id));

  const anyMatched =
    matched.nodeIds.length > 0 ||
    matched.roadmapItemIds.length > 0 ||
    matched.files.length > 0 ||
    (!hasSelectors && selectedNodes.length > 0);
  const status = hasSelectors && !anyMatched ? 'no_match' : 'ok';

  return {
    hasSelectors,
    status,
    matched,
    unmatched,
    selectedNodes,
    selectedEdges,
    relatedNodes,
    unknowns,
    selectedItems,
    dependencyItems,
    selectedClaims,
    selectedDecisions,
    selectedProposals,
    selectedReviews,
    selectedEvidence,
    selectedProposalIds,
    matchedEvidenceIds,
    unresolvedEvidenceIds,
    selectedClaimIds,
  };
}

function selectorView(args) {
  return {
    nodeIds: [...(args.nodeIds ?? [])],
    roadmapItemIds: [...(args.roadmapItemIds ?? [])],
    files: [...(args.files ?? [])],
    task:
      typeof args.task === 'string'
        ? {
            description: args.task,
            role: 'purpose_description_only',
            semanticSearchPerformed: false,
            retrievalGuarantee: false,
          }
        : null,
  };
}

function returnedCounts(scope, includeDetails) {
  return {
    nodes: scope.selectedNodes.length,
    edges: scope.selectedEdges.length,
    relatedNodes: scope.relatedNodes.length,
    unknowns: scope.unknowns.length,
    roadmapItems: scope.selectedItems.length,
    roadmapDependencyItems: scope.dependencyItems.length,
    intentClaims: includeDetails ? scope.selectedClaims.length : 0,
    decisions: scope.selectedDecisions.length,
    proposals: includeDetails ? scope.selectedProposals.length : 0,
    reviews: includeDetails ? scope.selectedReviews.length : 0,
    evidence: scope.selectedEvidence.length,
  };
}

function mapIntentSummaries(state, scope, collections) {
  if (state.schemaVersion !== '0.2') return [];
  return scope.selectedNodes.map((node) => ({
    ...clone(deriveNodeIntentSummary(node, collections.claims)),
    intentDetailTool: 'context_get',
  }));
}

function buildBase(state, snapshot, collections, limits, scope, args, tool, options = {}) {
  const writeMode = options.writeMode === true;
  return {
    tool,
    projectId: snapshot.projectId,
    projectName: state.project?.name ?? null,
    state: stateView(snapshot),
    readOnly: true,
    serverMode: writeMode ? 'maintenance_opt_in' : 'read_only',
    capabilities: { ...READ_ONLY_CAPABILITIES, writeTools: writeMode },
    selectors: selectorView(args),
    status: scope.status,
    matched: clone(scope.matched),
    unmatched: clone(scope.unmatched),
    limits: publicLimits(limits),
    authorization: { ...AUTHORIZATION_VIEW, writeToolsExposed: writeMode },
    boundaries: writeMode
      ? [
          ...boundaryNotes(snapshot),
          'This tool call itself made no write. The server was started with the opt-in maintenance tool, but this read result is not human confirmation and exposes no authority to write.',
        ]
      : boundaryNotes(snapshot),
    coverage: coverageView(
      state,
      snapshot,
      collections,
      activeBaselineOf(state, collections),
      scope.unmatched,
      limits,
    ),
  };
}

/**
 * project_get: identity, active baseline, versions, digest and counts only.
 */
export function buildProjectGet(state, snapshot, rawArgs, options = {}) {
  const args = normaliseToolArguments('project_get', rawArgs);
  if (args.projectId !== snapshot.projectId) {
    throw new McpContextError('project_mismatch', 'projectId does not match the bound project.');
  }
  const limits = normaliseLimits(options.limits);
  const writeMode = options.writeMode === true;
  const collections = collectionsOf(state);
  const baseline = activeBaselineOf(state, collections);
  return {
    tool: 'project_get',
    projectId: snapshot.projectId,
    project: isRecord(state.project) ? clone(state.project) : null,
    state: stateView(snapshot),
    activeBaseline: baseline ? clone(baseline) : null,
    counts: countsOf(collections),
    roadmap: roadmapSummaryOf(state, collections),
    featureProgress: projectFeatureProgress(state, limits),
    migration: stateMigrationView(state),
    readOnly: true,
    serverMode: writeMode ? 'maintenance_opt_in' : 'read_only',
    capabilities: { ...READ_ONLY_CAPABILITIES, writeTools: writeMode },
    limits: publicLimits(limits),
    authorization: { ...AUTHORIZATION_VIEW, writeToolsExposed: writeMode },
    boundaries: writeMode
      ? [
          ...boundaryNotes(snapshot),
          'This tool call itself made no write. The server was started with the opt-in maintenance tool, but this read result is not human confirmation and exposes no authority to write.',
        ]
      : boundaryNotes(snapshot),
    coverage: coverageView(
      state,
      snapshot,
      collections,
      baseline,
      { nodeIds: [], roadmapItemIds: [], files: [] },
      limits,
    ),
  };
}

/**
 * map_query: structural map context. Intent is summarized; full claim text,
 * source, decisions and evidence are available through context_get.
 */
export function buildMapQuery(state, snapshot, rawArgs, options = {}) {
  const args = normaliseToolArguments('map_query', rawArgs);
  if (args.projectId !== snapshot.projectId) {
    throw new McpContextError('project_mismatch', 'projectId does not match the bound project.');
  }
  const limits = normaliseLimits(options.limits);
  const collections = collectionsOf(state);
  const scope = selectScope(state, collections, args, limits, { includeAllWhenEmpty: true });
  const base = buildBase(state, snapshot, collections, limits, scope, args, 'map_query', {writeMode: options.writeMode});
  const featureNodeIds = state.schemaVersion === '0.2'
    ? selectedFeatureCapabilityIds(scope, collections, args)
    : [];
  return {
    ...base,
    nodes: scope.selectedNodes.map((node) => clone(node)),
    intentSummaries: mapIntentSummaries(state, scope, collections),
    edges: scope.selectedEdges.map((edge) => clone(edge)),
    relatedNodes: clone(scope.relatedNodes),
    unknowns: clone(scope.unknowns),
    roadmapItems: scope.selectedItems.map(roadmapItemView),
    roadmapDependencyItems: scope.dependencyItems.map(roadmapItemView),
    roadmap: roadmapSummaryOf(state, collections),
    featureProgress: state.schemaVersion === '0.2'
      ? featureNodeIds.map((nodeId) => mapFeatureProgressEntry(state, nodeId))
      : [],
    decisions: scope.selectedDecisions.map(decisionView),
    evidence: scope.selectedEvidence.map(evidenceView),
    unresolvedEvidenceIds: [...scope.unresolvedEvidenceIds],
    returned: returnedCounts(scope, false),
    totals: countsOf(collections),
    boundaries: [
      ...base.boundaries,
      'map_query returns intent summaries and full decision/evidence records; use context_get with explicit selectors for complete claim text, source reviews and proposals.',
    ],
  };
}

/**
 * context_get: complete selected intent context, including every claim on the
 * selected nodes (candidate, confirmed and historical), its recorded source,
 * governing/stopping decisions, related proposals/reviews, evidence with
 * definition/execution distinction, roadmap items and coverage boundaries.
 */
export function buildContextGet(state, snapshot, rawArgs, options = {}) {
  const args = normaliseToolArguments('context_get', rawArgs);
  if (args.projectId !== snapshot.projectId) {
    throw new McpContextError('project_mismatch', 'projectId does not match the bound project.');
  }
  const limits = normaliseLimits(options.limits);
  const collections = collectionsOf(state);
  const scope = selectScope(state, collections, args, limits, { includeAllWhenEmpty: false });
  const base = buildBase(state, snapshot, collections, limits, scope, args, 'context_get', {writeMode: options.writeMode});
  const featureNodeIds = selectedFeatureCapabilityIds(scope, collections, args);
  const reviewsById = byId(collections.reviews);
  return {
    ...base,
    nodes: scope.selectedNodes.map((node) => clone(node)),
    edges: scope.selectedEdges.map((edge) => clone(edge)),
    relatedNodes: clone(scope.relatedNodes),
    unknowns: clone(scope.unknowns),
    intentClaims: scope.selectedClaims.map((claim) => claimView(claim, reviewsById)),
    decisions: scope.selectedDecisions.map(decisionView),
    proposals: scope.selectedProposals.map((proposal) => clone(proposal)),
    reviews: scope.selectedReviews.map(reviewSummary),
    evidence: scope.selectedEvidence.map(evidenceView),
    roadmapItems: scope.selectedItems.map(roadmapItemView),
    conversationCaptures: collections.conversationCaptures.filter((c) => c.items.some((item) => scope.selectedNodes.some((node) => node.id === item.nodeId))).map((c) => ({ ...clone(c), items: c.items.map((item, itemIndex) => ({ ...clone(item), itemIndex })).filter((item) => scope.selectedNodes.some((node) => node.id === item.nodeId)) })),
    roadmapDependencyItems: scope.dependencyItems.map(roadmapItemView),
    roadmap: roadmapSummaryOf(state, collections),
    featureProgress: contextFeatureProgress(state, scope, collections, limits, featureNodeIds),
    unresolvedEvidenceIds: [...scope.unresolvedEvidenceIds],
    returned: returnedCounts(scope, true),
    totals: countsOf(collections),
    boundaries: [
      ...base.boundaries,
    'All claims for the selected nodes are returned, including superseded, retired and dismissed history; no normative claim is silently omitted.',
    'roadmapDependencyItems are direct planning dependencies, not recursively expanded intent context; query their explicit item/node IDs before acting on them.',
    'featureProgress contains one complete context per explicitly selected capability seed; checkpoint chains are returned oldest-to-newest and basisRecords cover only the latest checkpoint (including delivery.basisRefs), with same-Feature checkpoint references resolved one hop; delivery is a saved-record reading projection, not acceptance or release authorization.',
    ],
  };
}

/**
 * Run one tool against the fixed binding. The state is re-read and fully
 * validated for every call; the final JSON response is bounded by bytes.
 *
 * @param {'project_get'|'context_get'|'map_query'} tool
 * @param {{projectId: string, statePath: string, relativeStatePath: string}} binding
 * @param {unknown} rawArgs
 * @param {{limits?: object}} [options]
 */
export async function runTool(tool, binding, rawArgs, options = {}) {
  const args = normaliseToolArguments(tool, rawArgs);
  if (args.projectId !== binding.projectId) {
    throw new McpContextError('project_mismatch', 'projectId does not match the bound project.');
  }
  const limits = normaliseLimits(options.limits);
  const snapshot = await readBoundProjectState(binding, { limits });
  let result;
  if (tool === 'project_get') {
    result = buildProjectGet(snapshot.state, snapshot, args, { limits, writeMode: options.writeMode });
  } else if (tool === 'map_query') {
    result = buildMapQuery(snapshot.state, snapshot, args, { limits, writeMode: options.writeMode });
  } else {
    result = buildContextGet(snapshot.state, snapshot, args, { limits, writeMode: options.writeMode });
  }
  const responseBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (responseBytes > limits.maxResponseBytes) {
    throw new McpContextError(
      'result_too_large',
      'The response exceeds the configured byte limit; narrow the explicit selectors.',
      { responseBytes, maxResponseBytes: limits.maxResponseBytes },
    );
  }
  return result;
}

/**
 * Tool metadata for MCP tools/list. Only the implemented read-only tools are
 * advertised; no resources, prompts, subscriptions or write tools are implied.
 */
export function getToolDefinitions() {
  const selectorProperties = {
    projectId: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_PROJECT_ID_LENGTH,
      description: 'Must equal the projectId fixed at server startup.',
    },
    nodeIds: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: MAX_SELECTOR_ID_LENGTH },
      maxItems: MAX_SELECTORS,
      uniqueItems: true,
      description: 'Explicit stable node IDs. No fuzzy matching is performed.',
    },
    roadmapItemIds: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: MAX_SELECTOR_ID_LENGTH },
      maxItems: MAX_SELECTORS,
      uniqueItems: true,
      description: 'Explicit roadmap item IDs.',
    },
    files: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: MAX_FILE_PATH_LENGTH },
      maxItems: MAX_SELECTORS,
      uniqueItems: true,
      description:
        'Exact normalized project-relative paths matched against existing evidence.path values. Not globs; no source file is read.',
    },
    task: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TASK_LENGTH,
      description:
        'Optional purpose description for the caller. It is not a semantic query and does not select records.',
    },
  };
  return [
    {
      name: 'project_get',
      description:
        'Read the bound project identity, active baseline, state version, file digest, record counts and a bounded Feature progress index (checkpoint IDs, stop points, planning references). Read-only; no source, workspace or network access.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['projectId'],
        properties: {
          projectId: selectorProperties.projectId,
        },
      },
    },
    {
      name: 'context_get',
      description:
        'Read complete intent context for explicit nodeIds, roadmapItemIds or exact project-relative evidence files: full claim fields and history, source, decisions, proposals, evidence definitions/executions, coverage, and one complete Feature progress context per selected capability with its ordered checkpoints and bounded basis closure. Roadmap and checkpoints are context, not authorization.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['projectId'],
        properties: selectorProperties,
      },
    },
    {
      name: 'map_query',
      description:
        'Read map nodes, incident edges, related unknown nodes, roadmap items, decisions and evidence for explicit selectors or the whole bounded map, plus a compact progress summary for every selected capability. Intent is summarized; use context_get for full claim text and complete checkpoint context. Read-only.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['projectId'],
        properties: selectorProperties,
      },
    },
  ];
}
