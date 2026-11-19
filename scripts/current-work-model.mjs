// Pure writer model for one "current work" record
// (references/current-work-contract.md §9).
//
// buildCurrentWorkWrite() is the single builder for the online review-service
// route and the offline/fixture path. It performs no I/O: it returns the next
// state, the complete record, the resolved adopted basis, the exact sidecar
// descriptors the caller must write (project-relative POSIX path + canonical
// bytes) and the §10.2 preview facts.
//
// Two digests, two jobs (§10.2/§10.3) — this module never merges them:
//   * previewContentDigest   - sha256 over the complete normalized content, i.e.
//                              the resolved record minus journal/after-commit
//                              fields. Bound by the preview handle, echoed by the
//                              save body. Never stored on a receipt.
//   * operationPayloadDigest - sha256 over `{version: 1, previewContentDigest,
//                              authorizationRef}`. This is the receipt's
//                              `payloadDigest` and the exact retry key (§10.3 9a).
// Only the second one covers `authorizationRef`, and only the second one is
// stored. Nothing here is derived from `operationId` or the CAS fields: a retry
// after a successful commit necessarily carries a stale `expectedStateVersion`
// and must still be recognized as the same operation.
//
// Two axes, one record (§7.4): every layer observation and every adopted claim
// carries a *content* digest (what the target said) and, separately, a
// `confirmation` fact `{status, decisionId, assessmentDigest}` (how it was
// confirmed). A confirmation edit — `candidate -> confirmed`, a governing
// decision, an assessment or review edit — can never move a content digest, and
// no confirmation key enters an adopted-basis sidecar. The record stores the
// fact, so the preview digest (§10.2 covers the resolved record) does cover it:
// the human is approving the confirmation reading they were shown.
//
// Field-level rules are not duplicated: the layer projections, the stage reading,
// the per-work current view and `validateWorkContext` come from
// scripts/feature-progress.mjs, which owns the read model (§14).
import { randomUUID } from 'node:crypto';
import { canonicalStringify } from './intent-model.mjs';
import * as progress from './feature-progress.mjs';
import { StoreError, sha256Bytes, validateFullState } from './state-store.mjs';

export const CURRENT_WORK_OPERATIONS = Object.freeze(['open', 'adjust', 'pause', 'resume', 'end']);

/** §8.3 constants; the read model owns the values, this module re-exports them. */
export const CURRENT_WORK_CONSTANTS = progress.WORK_LIMITS;

const LIMITS = progress.WORK_LIMITS;
const OPERATION_SET = new Set(CURRENT_WORK_OPERATIONS);
const WORK_ID_PATTERN = /^work:[A-Za-z0-9._:-]{1,150}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SIDECAR_ROOT = '.product-continuity/current-work';
const SUMMARY_PREFIX = '本轮工作记录（非整体进展）：';

const CONTENT_KEYS = [
  'version', 'nodeId', 'operation', 'workId', 'predecessorRecordId', 'workTitle',
  'objective', 'scope', 'exclusions', 'acceptanceCriteria', 'selection', 'upper',
  'lifecycle', 'resume', 'source', 'sourceRefs', 'basisRefs', 'adoptedBasis',
];
const SELECTION_KEYS = ['kind', 'sourceRefs'];
const UPPER_KEYS = ['productGoal', 'stage', 'openUserPaths'];
const LIFECYCLE_KEYS = ['endedReason', 'endedNote'];
const RESUME_KEYS = ['stopPoint', 'nextStep', 'responsibility', 'authorizationRequired'];
const ADOPTED_KEYS = ['claimId', 'writeSnapshot'];
const REF_KEYS = ['collection', 'id'];
const OBSERVED_KEYS = ['digest', 'label', 'kind', 'origin', 'confirmation', 'snapshotPath'];

const LAYER_COLLECTIONS = ['node', 'roadmapItem', 'intentClaim', 'checkpoint', 'evidence'];
const SELECTION_KINDS = ['user_selected', 'within_task_authorization', 'agent_proposed_unselected'];
const ENDED_REASONS = ['handoff', 'cancelled', 'scope_completed', 'other'];
const RESPONSIBILITIES = ['agent', 'user', 'device_operator', 'unknown'];
const GAP_REASONS = ['no_relation', 'kind_only', 'candidate_only'];
const EDGE_ORIGIN_KINDS = ['contains', 'part_of'];
const BUSINESS_FIELDS = ['objective', 'scope', 'exclusions', 'acceptanceCriteria', 'selection', 'upper', 'resume'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const listOf = (value) => (Array.isArray(value) ? value : []);
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && /\S/.test(value);
const isSha256 = (value) => typeof value === 'string' && SHA256_PATTERN.test(value);
const isSafeVersion = (value) => Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER;
const equal = (left, right) => canonicalStringify(left ?? null) === canonicalStringify(right ?? null);
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const truncate = (value, max) => (typeof value === 'string' && value.length > max ? value.slice(0, max) : (value ?? null));
const clone = (value) => (value === undefined ? undefined : structuredClone(value));
// §7.4's injected digest: the read model never computes a digest itself, and a
// claim's `assessmentDigest` stays null without this function.
const layerDigest = (value) => sha256Bytes(canonicalStringify(value));

class PlanFailure extends Error {
  constructor(code, messages, details = {}) {
    super(messages.join('; '));
    this.name = 'PlanFailure';
    this.code = code;
    this.messages = messages;
    this.details = details;
  }
}

function reject(code, message, details = {}) {
  throw new PlanFailure(code, [message], details);
}

function failure(code, errors, details = {}) {
  return {ok: false, code, errors: Array.isArray(errors) ? errors : [String(errors)], details};
}

function failureFrom(error) {
  if (error instanceof PlanFailure) return failure(error.code, error.messages, error.details);
  throw error;
}

// ---------------------------------------------------------------------------
// §9 content validation (shape only: no state needed, so the UI can run it)
// ---------------------------------------------------------------------------

function checkExactKeys(value, keys, location, errors, optionalKeys = []) {
  if (!isPlainObject(value)) {
    errors.push(`${location}: expected an object`);
    return false;
  }
  const allowed = optionalKeys.length > 0 ? new Set([...keys, ...optionalKeys]) : new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${location}: unexpected field "${key}"`);
  for (const key of keys) if (!Object.hasOwn(value, key)) errors.push(`${location}: missing field "${key}"`);
  return true;
}

function checkText(value, max, location, errors, {nullable = false} = {}) {
  if (nullable && value === null) return;
  if (!isText(value, max)) errors.push(`${location}: expected 1..${max} non-blank characters`);
}

function checkId(value, location, errors, {nullable = false} = {}) {
  const max = progress.FEATURE_PROGRESS_LIMITS.maxIdLength;
  if (nullable && value === null) return;
  if (!isText(value, max)) errors.push(`${location}: expected 1..${max} non-blank characters`);
}

function checkScopeItems(value, location, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${location}: expected an array`);
    return;
  }
  if (value.length > LIMITS.maxWorkScopeItems) errors.push(`${location}: expected at most ${LIMITS.maxWorkScopeItems} items`);
  value.forEach((item, index) => {
    const itemLocation = `${location}[${index}]`;
    if (!checkExactKeys(item, ['statement'], itemLocation, errors)) return;
    checkText(item.statement, LIMITS.maxWorkScopeText, `${itemLocation}.statement`, errors);
  });
}

function checkLayerRef(value, location, errors) {
  if (!checkExactKeys(value, REF_KEYS, location, errors)) return;
  if (!LAYER_COLLECTIONS.includes(value.collection)) {
    errors.push(`${location}.collection: unsupported collection "${String(value.collection)}"`);
  }
  checkId(value.id, `${location}.id`, errors);
}

function checkOrigin(value, location, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${location}: expected an object`);
    return;
  }
  if (!['edge', 'adoptedBasis', 'userSelection'].includes(value.kind)) {
    errors.push(`${location}.kind: unsupported origin "${String(value.kind)}"`);
    return;
  }
  if (value.kind === 'edge') {
    if (!checkExactKeys(value, ['kind', 'edgeId', 'edgeKind'], location, errors)) return;
    checkId(value.edgeId, `${location}.edgeId`, errors);
    if (!EDGE_ORIGIN_KINDS.includes(value.edgeKind)) errors.push(`${location}.edgeKind: expected contains or part_of`);
    return;
  }
  if (value.kind === 'adoptedBasis') {
    if (!checkExactKeys(value, ['kind', 'claimId', 'basisRefIndex'], location, errors)) return;
    checkId(value.claimId, `${location}.claimId`, errors);
    if (!Number.isInteger(value.basisRefIndex) || value.basisRefIndex < 0 || value.basisRefIndex >= LIMITS.maxAdoptedBasis) {
      errors.push(`${location}.basisRefIndex: expected an index into adoptedBasis (0..${LIMITS.maxAdoptedBasis - 1})`);
    }
    return;
  }
  if (!checkExactKeys(value, ['kind', 'sourceRefIndex', 'authorizationRef'], location, errors)) return;
  if (!Number.isInteger(value.sourceRefIndex) || value.sourceRefIndex < 0 || value.sourceRefIndex >= LIMITS.maxWorkSourceRefs) {
    errors.push(`${location}.sourceRefIndex: expected an index into selection.sourceRefs`);
  }
  checkText(value.authorizationRef, LIMITS.maxWorkObjectiveText, `${location}.authorizationRef`, errors);
}

// The *content* form of a layer: refs as the human chose them. `observed` is the
// builder's output, never an input (§9), so an input that carries it is refused.
function checkContentLayer(value, location, errors) {
  if (value === null) return;
  if (!isPlainObject(value)) {
    errors.push(`${location}: expected an object or null`);
    return;
  }
  if (value.state === 'gap') {
    if (!checkExactKeys(value, ['state'], location, errors, ['reason'])) return;
    if (Object.hasOwn(value, 'reason') && !GAP_REASONS.includes(value.reason)) {
      errors.push(`${location}.reason: unsupported gap reason "${String(value.reason)}"`);
    }
    return;
  }
  if (value.state === 'unavailable') {
    if (!checkExactKeys(value, ['state', 'ref'], location, errors)) return;
    checkLayerRef(value.ref, `${location}.ref`, errors);
    return;
  }
  if (value.state === 'found') {
    if (!checkExactKeys(value, ['state', 'ref', 'origin'], location, errors)) return;
    checkLayerRef(value.ref, `${location}.ref`, errors);
    checkOrigin(value.origin, `${location}.origin`, errors);
    return;
  }
  errors.push(`${location}.state: expected found, gap or unavailable`);
}

function contentErrors(content) {
  const errors = [];
  if (!checkExactKeys(content, CONTENT_KEYS, 'content', errors)) return errors;
  if (content.version !== 1) errors.push('content.version: expected 1');
  const operation = content.operation;
  if (!OPERATION_SET.has(operation)) {
    errors.push(`content.operation: expected one of ${CURRENT_WORK_OPERATIONS.join(', ')}`);
  }

  if (content.workId === null) {
    if (operation !== 'open') errors.push('content.workId: null is only allowed for the first open');
  } else if (typeof content.workId !== 'string' || !WORK_ID_PATTERN.test(content.workId) || content.workId.length > LIMITS.maxWorkId) {
    errors.push(`content.workId: expected ${WORK_ID_PATTERN} (max ${LIMITS.maxWorkId} characters)`);
  }
  if (content.predecessorRecordId === null) {
    if (operation !== 'open') errors.push('content.predecessorRecordId: null is only allowed when the work has no record');
  } else {
    checkId(content.predecessorRecordId, 'content.predecessorRecordId', errors);
    if (operation === 'open') errors.push('content.predecessorRecordId: an open must not declare a predecessor');
  }

  checkId(content.nodeId, 'content.nodeId', errors);
  checkText(content.workTitle, LIMITS.maxWorkTitle, 'content.workTitle', errors);
  checkText(content.objective, LIMITS.maxWorkObjectiveText, 'content.objective', errors, {nullable: true});
  checkScopeItems(content.scope, 'content.scope', errors);
  checkScopeItems(content.exclusions, 'content.exclusions', errors);
  checkScopeItems(content.acceptanceCriteria, 'content.acceptanceCriteria', errors);

  if (checkExactKeys(content.selection, SELECTION_KEYS, 'content.selection', errors)) {
    if (!SELECTION_KINDS.includes(content.selection.kind)) {
      errors.push(`content.selection.kind: unsupported selection "${String(content.selection.kind)}"`);
    }
    const refs = content.selection.sourceRefs;
    if (!Array.isArray(refs)) {
      errors.push('content.selection.sourceRefs: expected an array');
    } else {
      if (refs.length > LIMITS.maxWorkSourceRefs) errors.push(`content.selection.sourceRefs: expected at most ${LIMITS.maxWorkSourceRefs} items`);
      const seen = new Set();
      refs.forEach((value, index) => {
        checkText(value, LIMITS.maxWorkSourceRefText, `content.selection.sourceRefs[${index}]`, errors);
        if (typeof value !== 'string') return;
        if (seen.has(value)) errors.push(`content.selection.sourceRefs[${index}]: duplicate source reference`);
        seen.add(value);
      });
    }
  }

  if (checkExactKeys(content.upper, UPPER_KEYS, 'content.upper', errors)) {
    checkContentLayer(content.upper.productGoal, 'content.upper.productGoal', errors);
    checkContentLayer(content.upper.stage, 'content.upper.stage', errors);
    if (!Array.isArray(content.upper.openUserPaths)) {
      errors.push('content.upper.openUserPaths: expected an array');
    } else {
      if (content.upper.openUserPaths.length > LIMITS.maxUpperOpenPaths) {
        errors.push(`content.upper.openUserPaths: expected at most ${LIMITS.maxUpperOpenPaths} items`);
      }
      content.upper.openUserPaths.forEach((entry, index) => checkContentLayer(entry, `content.upper.openUserPaths[${index}]`, errors));
    }
  }

  // `lifecycle.status` is derived from `operation`; the content carries only the
  // ended fields (§9).
  if (checkExactKeys(content.lifecycle, LIFECYCLE_KEYS, 'content.lifecycle', errors)) {
    if (operation === 'end') {
      if (!ENDED_REASONS.includes(content.lifecycle.endedReason)) {
        errors.push(`content.lifecycle.endedReason: an end requires one of ${ENDED_REASONS.join(', ')}`);
      }
    } else if (content.lifecycle.endedReason !== null) {
      errors.push('content.lifecycle.endedReason: must be null unless the operation is end');
    }
    if (content.lifecycle.endedNote !== null) {
      if (operation !== 'end') errors.push('content.lifecycle.endedNote: must be null unless the operation is end');
      else checkText(content.lifecycle.endedNote, LIMITS.maxWorkObjectiveText, 'content.lifecycle.endedNote', errors);
    }
  }

  if (content.resume !== null && checkExactKeys(content.resume, RESUME_KEYS, 'content.resume', errors)) {
    checkText(content.resume.stopPoint, LIMITS.maxWorkObjectiveText, 'content.resume.stopPoint', errors);
    checkText(content.resume.nextStep, LIMITS.maxWorkObjectiveText, 'content.resume.nextStep', errors, {nullable: true});
    if (!RESPONSIBILITIES.includes(content.resume.responsibility)) {
      errors.push(`content.resume.responsibility: unsupported responsibility "${String(content.resume.responsibility)}"`);
    }
    const authorizations = content.resume.authorizationRequired;
    if (!Array.isArray(authorizations)) {
      errors.push('content.resume.authorizationRequired: expected an array');
    } else {
      if (authorizations.length < 1 || authorizations.length > progress.FEATURE_PROGRESS_LIMITS.maxAuthorizationKinds) {
        errors.push(`content.resume.authorizationRequired: expected 1..${progress.FEATURE_PROGRESS_LIMITS.maxAuthorizationKinds} items`);
      }
      const seen = new Set();
      authorizations.forEach((value, index) => {
        if (!progress.FEATURE_CHECKPOINT_AUTHORIZATIONS.includes(value)) {
          errors.push(`content.resume.authorizationRequired[${index}]: unsupported authorization "${String(value)}"`);
        }
        if (seen.has(value)) errors.push(`content.resume.authorizationRequired[${index}]: duplicate authorization`);
        seen.add(value);
      });
      if (seen.has('none') && seen.size > 1) errors.push('content.resume.authorizationRequired: "none" cannot be combined with another authorization');
    }
  }

  if (!progress.FEATURE_CHECKPOINT_SOURCES.includes(content.source)) {
    errors.push(`content.source: unsupported source "${String(content.source)}"`);
  }
  if (!Array.isArray(content.sourceRefs)) {
    errors.push('content.sourceRefs: expected an array');
  } else {
    if (content.sourceRefs.length > progress.FEATURE_PROGRESS_LIMITS.maxSourceRefs) {
      errors.push(`content.sourceRefs: expected at most ${progress.FEATURE_PROGRESS_LIMITS.maxSourceRefs} items`);
    }
    const seen = new Set();
    content.sourceRefs.forEach((value, index) => {
      if (!isText(value, progress.FEATURE_PROGRESS_LIMITS.maxSourceRefText)) {
        errors.push(`content.sourceRefs[${index}]: expected 1..${progress.FEATURE_PROGRESS_LIMITS.maxSourceRefText} non-blank characters`);
      }
      if (typeof value !== 'string') return;
      if (seen.has(value)) errors.push(`content.sourceRefs[${index}]: duplicate source reference`);
      seen.add(value);
    });
  }

  if (!Array.isArray(content.basisRefs)) {
    errors.push('content.basisRefs: expected an array');
  } else {
    if (content.basisRefs.length > progress.FEATURE_PROGRESS_LIMITS.maxBasisRefs) {
      errors.push(`content.basisRefs: expected at most ${progress.FEATURE_PROGRESS_LIMITS.maxBasisRefs} items`);
    }
    content.basisRefs.forEach((ref, index) => {
      const location = `content.basisRefs[${index}]`;
      if (!checkExactKeys(ref, REF_KEYS, location, errors)) return;
      if (!progress.FEATURE_CHECKPOINT_REF_COLLECTIONS.includes(ref.collection)) {
        errors.push(`${location}.collection: unsupported collection "${String(ref.collection)}"`);
      }
      checkId(ref.id, `${location}.id`, errors);
    });
  }

  if (!Array.isArray(content.adoptedBasis)) {
    errors.push('content.adoptedBasis: expected an array');
  } else {
    if (content.adoptedBasis.length > LIMITS.maxAdoptedBasis) {
      errors.push(`content.adoptedBasis: expected at most ${LIMITS.maxAdoptedBasis} items`);
    }
    const seen = new Set();
    content.adoptedBasis.forEach((entry, index) => {
      const location = `content.adoptedBasis[${index}]`;
      if (!checkExactKeys(entry, ADOPTED_KEYS, location, errors)) return;
      checkId(entry.claimId, `${location}.claimId`, errors);
      if (typeof entry.writeSnapshot !== 'boolean') errors.push(`${location}.writeSnapshot: expected a boolean`);
      if (typeof entry.claimId !== 'string') return;
      if (seen.has(entry.claimId)) errors.push(`${location}.claimId: duplicate adopted claim`);
      seen.add(entry.claimId);
    });
  }

  try {
    canonicalStringify(content);
  } catch (error) {
    errors.push(`content: ${error.message}`);
  }
  return errors;
}

/**
 * The complete one-shot content validator (§9). It needs no state, so the editor
 * can run it before previewing; the builder runs this same code first.
 * Throws `StoreError('invalid_request')` with every message in `details.errors`.
 */
export function validateCurrentWorkWrite(content) {
  const errors = contentErrors(content);
  if (errors.length) {
    throw new StoreError('invalid_request', errors.join('; '), {status: 400, details: {errors}});
  }
}

// ---------------------------------------------------------------------------
// Sidecar naming (§7.2/§7.4)
// ---------------------------------------------------------------------------

/** First 16 hex characters of sha256(workId); a colon cannot appear in a Windows file name. */
export function currentWorkKey(workId) {
  return sha256Bytes(Buffer.from(String(workId), 'utf8')).slice('sha256:'.length).slice(0, 16);
}

/** `<stateDir>/current-work/<workKey>/<digestHex>.json` as a project-relative POSIX path. */
export function currentWorkSidecarPath(workId, digest) {
  return `${SIDECAR_ROOT}/${currentWorkKey(workId)}/${String(digest).replace(/^sha256:/, '')}.json`;
}

// ---------------------------------------------------------------------------
// The two digests (§10.2/§10.3)
// ---------------------------------------------------------------------------

/** §10.3: the only digest that covers `authorizationRef`; stored as receipt.payloadDigest. */
export function operationPayloadDigest(previewContentDigest, authorizationRef) {
  if (!isSha256(previewContentDigest)) reject('invalid_request', 'operationPayloadDigest: previewContentDigest must be a sha256 digest');
  return sha256Bytes(canonicalStringify({version: 1, previewContentDigest, authorizationRef}));
}

// ---------------------------------------------------------------------------
// Status/replay lookup (§10.4): read-only, never writes, never needs a CAS match
// ---------------------------------------------------------------------------

/**
 * Resolve an already committed work receipt by `operationId`.
 * `found: false` means no receipt; `integrity: 'broken'` means a receipt exists
 * but its record/chain does not line up, so the caller must refuse rather than
 * treat it as a replay.
 */
export function resolveCurrentWorkReplay(state, input = {}) {
  const operationId = typeof input.operationId === 'string' ? input.operationId : null;
  const expectedWorkId = typeof input.workId === 'string' ? input.workId : null;
  const base = {ok: true, operationId, found: false, integrity: 'missing', problems: []};
  if (!isPlainObject(state) || !operationId) return {...base, ok: false, problems: ['operationId is required']};

  const receipt = listOf(state.mapUpdates)
    .filter(isPlainObject)
    .find((update) => update.source === 'local_feature_checkpoint' && update.operationId === operationId);
  if (!receipt) return base;

  const ids = listOf(receipt.addedFeatureCheckpointIds);
  const recordId = ids.length === 1 ? ids[0] : null;
  const record = recordId ? listOf(state.featureCheckpoints).find((item) => isPlainObject(item) && item.id === recordId) : null;
  const workContext = isPlainObject(record?.workContext) ? record.workContext : null;

  const problems = [];
  if (!recordId) problems.push('receipt_points_at_no_single_record');
  if (!record) problems.push('record_missing');
  if (record && !workContext) problems.push('record_has_no_work_context');
  if (record && record.basis?.observedStateVersion !== receipt.observedStateVersion) problems.push('basis_version_mismatch');
  if (receipt.resultingStateVersion !== receipt.observedStateVersion + 1) problems.push('version_step_mismatch');
  if (record && receipt.createdAt !== record.createdAt) problems.push('created_at_mismatch');
  if (record && receipt.projectId !== state.project?.id) problems.push('project_mismatch');
  if (record && workContext && record.nodeId !== workContext.nodeId) problems.push('work_node_mismatch');
  if (record && workContext && expectedWorkId && workContext.workId !== expectedWorkId) problems.push('work_id_mismatch');

  const found = problems.length === 0;
  return {
    ok: true,
    operationId,
    found,
    integrity: found ? 'ok' : 'broken',
    problems,
    payloadDigest: typeof receipt.payloadDigest === 'string' ? receipt.payloadDigest : null,
    receiptId: typeof receipt.id === 'string' ? receipt.id : null,
    recordId: record?.id ?? recordId,
    workId: workContext?.workId ?? null,
    operation: workContext?.operation ?? null,
    observedStateVersion: receipt.observedStateVersion,
    resultingStateVersion: receipt.resultingStateVersion,
    receipt,
    record: record ?? null,
  };
}

function receiptProbe(state, operationId) {
  const replay = resolveCurrentWorkReplay(state, {operationId});
  if (!replay.found && replay.integrity === 'missing') return null;
  return {
    receipt: replay.receipt,
    record: replay.record,
    workId: replay.workId,
    operation: replay.operation,
    payloadDigest: replay.payloadDigest,
    resultingStateVersion: replay.resultingStateVersion,
    problems: replay.problems,
  };
}

function replayResult(probe, state, digest) {
  return {
    ok: true,
    replayed: true,
    dryRun: false,
    checkpoint: probe.record,
    adoptedBasis: clone(listOf(probe.record?.adoptedBasis)),
    sidecars: [],
    nextState: state,
    receipt: probe.receipt,
    workId: probe.workId,
    operation: probe.operation,
    payloadDigest: probe.payloadDigest,
    previewContentDigest: null,
    recordPreview: probe.record,
    diff: [],
    sidecarPlan: [],
    previousStateVersion: state.stateVersion,
    resultingStateVersion: probe.resultingStateVersion,
    previousDigest: digest,
  };
}

function keyConflict(probe, requestedPayloadDigest) {
  return failure('key_conflict', ['operationId was already used for a different payload'], {
    operationId: probe.receipt?.operationId ?? null,
    storedPayloadDigest: probe.payloadDigest,
    requestedPayloadDigest,
  });
}

// ---------------------------------------------------------------------------
// Upper-layer resolution (§7.3) and observation (§7.4)
// ---------------------------------------------------------------------------

function sidecarCollector() {
  const byPath = new Map();
  return {
    add(descriptor) {
      const existing = byPath.get(descriptor.path);
      if (!existing) {
        byPath.set(descriptor.path, descriptor);
        return;
      }
      if (existing.bytes.equals(descriptor.bytes)) return;
      reject('sidecar_conflict', `two sidecars resolve to ${descriptor.path} with different bytes`, {path: descriptor.path});
    },
    list() {
      return [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    },
  };
}

function collectionRecord(state, collection, id) {
  const key = {
    node: 'nodes', roadmapItem: 'roadmapItems', intentClaim: 'intentClaims',
    checkpoint: 'featureCheckpoints', evidence: 'evidence',
  }[collection];
  if (!key) return null;
  return listOf(state[key]).find((record) => isPlainObject(record) && record.id === id) ?? null;
}

function productGoalGapReason(state, nodeId) {
  const goals = listOf(state.nodes).filter((node) => isPlainObject(node) && node.kind === 'product_goal');
  if (goals.length === 0) return 'no_relation';
  const edges = listOf(state.edges).filter(isPlainObject);
  const related = goals.some((goal) => edges.some((edge) => EDGE_ORIGIN_KINDS.includes(edge.kind)
    && ((edge.from === nodeId && edge.to === goal.id) || (edge.from === goal.id && edge.to === nodeId))));
  return related ? 'candidate_only' : 'kind_only';
}

function defaultGapReason(state, nodeId, layer) {
  return layer === 'productGoal' ? productGoalGapReason(state, nodeId) : 'no_relation';
}

function layerConstraint(layer, ref, record, nodeId) {
  if (layer === 'productGoal') {
    if (ref.collection !== 'node') reject('unresolved_upper_ref', 'productGoal must reference a node', {reason: 'collection'});
    if (record.kind !== 'product_goal') reject('unresolved_upper_ref', `node "${record.id}" is not a product_goal`, {reason: 'kind'});
    return;
  }
  if (layer === 'stage') {
    if (ref.collection === 'checkpoint') {
      if (record.nodeId !== nodeId) reject('unresolved_upper_ref', 'stage checkpoint is not on this Feature', {reason: 'same_feature'});
      return;
    }
    if (ref.collection === 'roadmapItem') {
      if (record.nodeId !== nodeId) reject('unresolved_upper_ref', 'stage roadmap item is not on this Feature', {reason: 'same_feature'});
      if (!['now', 'next'].includes(record.horizon)) reject('unresolved_upper_ref', 'stage roadmap item is not horizon now/next', {reason: 'horizon'});
      return;
    }
    reject('unresolved_upper_ref', 'stage must reference a checkpoint or roadmapItem', {reason: 'collection'});
  }
  // openUserPaths
  if (ref.collection === 'node') {
    if (!['user_task', 'unknown'].includes(record.kind)) reject('unresolved_upper_ref', `node "${record.id}" is not an open user path`, {reason: 'kind'});
    if (record.status === 'retired') reject('unresolved_upper_ref', `node "${record.id}" is retired`, {reason: 'status'});
    return;
  }
  if (ref.collection === 'evidence') return;
  reject('unresolved_upper_ref', 'openUserPaths must reference a user_task/unknown node or evidence', {reason: 'collection'});
}

function verifyEdgeOrigin(state, origin, capability, targetId) {
  const edge = listOf(state.edges).find((item) => isPlainObject(item) && item.id === origin.edgeId);
  if (!edge) reject('unresolved_upper_ref', `upper origin edge "${origin.edgeId}" does not exist`, {reason: 'missing_edge'});
  if (!EDGE_ORIGIN_KINDS.includes(edge.kind) || edge.kind !== origin.edgeKind) {
    reject('unresolved_upper_ref', `upper origin edge "${origin.edgeId}" is not a contains/part_of edge`, {reason: 'edge_kind'});
  }
  const forward = edge.from === capability && edge.to === targetId;
  const backward = edge.from === targetId && edge.to === capability;
  if (!forward && !backward) {
    reject('unresolved_upper_ref', `upper origin edge "${origin.edgeId}" does not connect "${capability}" and "${targetId}"`, {reason: 'edge_endpoints'});
  }
}

function verifyAdoptedOrigin(state, content, origin, targetId, resolvedAdopted) {
  if (!content.adoptedBasis.some((entry) => entry.claimId === origin.claimId)) {
    reject('unresolved_upper_ref', `upper origin claim "${origin.claimId}" is not in adoptedBasis`, {reason: 'claim_not_adopted'});
  }
  const resolved = resolvedAdopted[origin.basisRefIndex];
  if (!resolved || resolved.claimId !== origin.claimId) {
    reject('unresolved_upper_ref', `upper origin basisRefIndex ${origin.basisRefIndex} does not resolve to "${origin.claimId}"`, {reason: 'basis_ref_index'});
  }
  const claim = collectionRecord(state, 'intentClaim', origin.claimId);
  if (!claim || claim.nodeId !== targetId) {
    reject('unresolved_upper_ref', `adopted claim "${origin.claimId}" does not name node "${targetId}"`, {reason: 'claim_node'});
  }
}

function verifyUserSelectionOrigin(content, origin, authorizationRef) {
  const selection = content.selection;
  if (!['user_selected', 'within_task_authorization'].includes(selection.kind)) {
    reject('unresolved_upper_ref', 'userSelection origin requires a user-selected working scope', {reason: 'selection_kind'});
  }
  if (!Number.isInteger(origin.sourceRefIndex) || origin.sourceRefIndex >= selection.sourceRefs.length) {
    reject('unresolved_upper_ref', 'userSelection origin sourceRefIndex does not resolve', {reason: 'source_ref_index'});
  }
  if (origin.authorizationRef !== authorizationRef) {
    reject('unresolved_upper_ref', 'userSelection origin authorizationRef does not match this save', {reason: 'authorization_ref'});
  }
}

function verifyOrigin(state, content, origin, ref, record, ctx) {
  if (origin.kind === 'edge') verifyEdgeOrigin(state, origin, content.nodeId, ref.id);
  else if (origin.kind === 'adoptedBasis') verifyAdoptedOrigin(state, content, origin, ref.id, ctx.adopted);
  else verifyUserSelectionOrigin(content, origin, ctx.authorizationRef);
  void record;
}

function layerSnapshot(state, content, ref, projection, confirmation) {
  if (ref.collection === 'checkpoint') {
    const reading = progress.layerStageReading(state, content.nodeId, ref.id);
    if (!reading.found) {
      reject('unresolved_upper_ref', `stage reading for checkpoint "${ref.id}" is unavailable (${String(reading.reason)})`, {reason: 'stage_reading'});
    }
    return {snapshot: reading.excerpt, label: reading.label};
  }
  return {
    snapshot: {
      content: projection.content,
      confirmation: confirmation.found ? clone(confirmation.projection) : null,
    },
    label: projection.label,
  };
}

function resolveFoundLayer(state, content, observation, layer, ctx) {
  const ref = observation.ref;
  const record = collectionRecord(state, ref.collection, ref.id);
  if (!record) {
    reject('unresolved_upper_ref', `upper ${layer} ref "${ref.collection}:${ref.id}" does not resolve`, {layer});
  }
  layerConstraint(layer, ref, record, content.nodeId);
  verifyOrigin(state, content, observation.origin, ref, record, ctx);

  const projection = progress.layerContentProjection(state, ref);
  if (!projection.found) {
    reject('unresolved_upper_ref', `upper ${layer} ref "${ref.collection}:${ref.id}" is unreadable (${String(projection.reason)})`, {layer});
  }
  const confirmation = progress.layerConfirmationProjection(state, ref, {digest: layerDigest});
  const observedContent = projection.content;
  const digest = sha256Bytes(canonicalStringify(observedContent));
  const {snapshot, label} = layerSnapshot(state, content, ref, projection, confirmation);

  const path = currentWorkSidecarPath(ctx.workId, digest);
  const bytes = Buffer.from(canonicalStringify(snapshot), 'utf8');
  if (bytes.byteLength > LIMITS.maxLayerSnapshotBytes) {
    reject('invalid_request', `upper ${layer} snapshot is ${bytes.byteLength} bytes, above ${LIMITS.maxLayerSnapshotBytes}`, {layer, path});
  }
  if (path.length > LIMITS.maxLayerSnapshotPath) {
    reject('invalid_request', `upper ${layer} snapshot path is longer than ${LIMITS.maxLayerSnapshotPath}`, {layer, path});
  }
  ctx.sidecars.add({path, digest, bytes});

  return {
    state: 'found',
    ref: clone(ref),
    observed: {
      digest,
      label: truncate(label, LIMITS.maxLayerLabel),
      kind: projection.kind,
      origin: clone(observation.origin),
      confirmation: confirmation.found
        ? clone(confirmation.confirmation)
        : {status: 'not_applicable', decisionId: null, assessmentDigest: null},
      snapshotPath: path,
    },
  };
}

function resolveLayer(state, content, observation, layer, ctx) {
  if (observation === null) return null;
  if (observation.state === 'gap') {
    return {state: 'gap', reason: observation.reason ?? defaultGapReason(state, content.nodeId, layer.replace(/\[\d+\]$/, ''))};
  }
  if (observation.state === 'unavailable') {
    const record = collectionRecord(state, observation.ref.collection, observation.ref.id);
    if (!record) {
      reject('unresolved_upper_ref', `unavailable ${layer} ref "${observation.ref.collection}:${observation.ref.id}" does not exist`, {layer});
    }
    return {state: 'unavailable', ref: clone(observation.ref)};
  }
  return resolveFoundLayer(state, content, observation, layer, ctx);
}

// ---------------------------------------------------------------------------
// Adopted basis (§7.2)
// ---------------------------------------------------------------------------

// §7.2/§7.4: two facts, two axes, no overlap. `contentDigest`/`snapshotPath`
// cover the four content fields only; `confirmation` is the claim's current
// confirmation fact at adoption, stored in the record and never in the sidecar.
function resolveAdoptedBasis(state, content, workId, sidecars) {
  const resolved = [];
  for (const entry of content.adoptedBasis) {
    const claim = collectionRecord(state, 'intentClaim', entry.claimId);
    if (!claim) {
      reject('invalid_request', `adoptedBasis claim "${entry.claimId}" does not exist`, {reason: 'unresolved_adopted_claim', claimId: entry.claimId});
    }
    const projection = progress.layerContentProjection(state, {collection: 'intentClaim', id: claim.id});
    if (!projection.found) {
      reject('invalid_request', `adoptedBasis claim "${entry.claimId}" is unreadable`, {reason: 'unresolved_adopted_claim', claimId: entry.claimId});
    }
    const confirmation = progress.layerConfirmationProjection(
      state, {collection: 'intentClaim', id: claim.id}, {digest: layerDigest},
    );
    if (!confirmation.found || !confirmation.confirmation) {
      reject('invalid_request', `adoptedBasis claim "${entry.claimId}" has no confirmation fact`, {reason: 'unresolved_adopted_claim', claimId: entry.claimId});
    }
    if (!isSha256(confirmation.confirmation.assessmentDigest)) {
      // Adoption targets a claim, whose assessment is always compared as one
      // digest (§7.4); a null digest here would store a fact nobody can compare.
      reject('invalid_request', `adoptedBasis claim "${entry.claimId}" has no readable assessment digest`, {reason: 'unresolved_adopted_claim', claimId: entry.claimId});
    }
    const contentDigest = sha256Bytes(canonicalStringify(projection.content));
    let snapshotPath = null;
    if (entry.writeSnapshot) {
      snapshotPath = currentWorkSidecarPath(workId, contentDigest);
      if (snapshotPath.length > LIMITS.maxSnapshotPath) {
        reject('invalid_request', `adoptedBasis snapshot path is longer than ${LIMITS.maxSnapshotPath}`, {claimId: entry.claimId});
      }
      // The sidecar holds the content projection and nothing else (no
      // confirmation key), and is named by the content digest.
      sidecars.add({path: snapshotPath, digest: contentDigest, bytes: Buffer.from(canonicalStringify(projection.content), 'utf8')});
    }
    resolved.push({claimId: claim.id, contentDigest, snapshotPath, confirmation: clone(confirmation.confirmation)});
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Record assembly (§6.7 inert shell, §3 workContext)
// ---------------------------------------------------------------------------

function readClock(options) {
  if (options.clock === undefined) return new Date().toISOString();
  const value = typeof options.clock === 'function' ? options.clock() : options.clock;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    reject('invalid_request', 'options.clock: expected an ISO date-time');
  }
  return value;
}

function idFactory(options) {
  const uuid = options.uuid;
  return () => (typeof uuid === 'function' ? String(uuid()) : randomUUID());
}

function existingIds(state) {
  const ids = new Set();
  for (const record of listOf(state.featureCheckpoints)) {
    if (!isPlainObject(record)) continue;
    if (typeof record.id === 'string') ids.add(record.id);
    if (typeof record.workContext?.workId === 'string') ids.add(record.workContext.workId);
  }
  for (const receipt of listOf(state.mapUpdates)) {
    if (isPlainObject(receipt) && typeof receipt.id === 'string') ids.add(receipt.id);
  }
  return ids;
}

function uniqueGeneratedId(prefix, used, uuid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = `${prefix}${uuid()}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  reject('invalid_request', `could not generate a unique ${prefix} id`);
}

function lifecycleStatusOf(operation, existing) {
  if (operation === 'open') return 'active';
  if (operation === 'pause') return 'paused';
  if (operation === 'end') return 'ended';
  if (operation === 'resume') return 'active';
  return existing?.lifecycle?.status ?? 'active';
}

function businessSnapshot(workContext) {
  return {
    objective: workContext.objective ?? null,
    scope: listOf(workContext.scope),
    exclusions: listOf(workContext.exclusions),
    acceptanceCriteria: listOf(workContext.acceptanceCriteria),
    selection: workContext.selection ?? null,
    upper: workContext.upper ?? null,
    resume: workContext.resume ?? null,
  };
}

function differingBusinessFields(candidate, existingContext) {
  const previous = businessSnapshot(existingContext);
  return BUSINESS_FIELDS.filter((field) => !equal(candidate[field], previous[field]));
}

function assertAppendOnly(before, after) {
  if (after.stateVersion !== before.stateVersion + 1) {
    reject('validation_failed', 'the proposed state did not advance exactly one version');
  }
  const strip = (state) => {
    const copy = structuredClone(state);
    delete copy.stateVersion;
    delete copy.featureCheckpoints;
    delete copy.mapUpdates;
    return copy;
  };
  if (!equal(strip(before), strip(after))) {
    reject('validation_failed', 'a work write may only append a checkpoint and a receipt');
  }
  const beforeCheckpoints = listOf(before.featureCheckpoints);
  const beforeUpdates = listOf(before.mapUpdates);
  if (!equal(listOf(after.featureCheckpoints).slice(0, beforeCheckpoints.length), beforeCheckpoints)) {
    reject('validation_failed', 'the existing checkpoint array is not a strict prefix of the new array');
  }
  if (!equal(listOf(after.mapUpdates).slice(0, beforeUpdates.length), beforeUpdates)) {
    reject('validation_failed', 'the existing map update array is not a strict prefix of the new array');
  }
  if (listOf(after.featureCheckpoints).length !== beforeCheckpoints.length + 1) {
    reject('validation_failed', 'exactly one checkpoint must be appended');
  }
  if (listOf(after.mapUpdates).length !== beforeUpdates.length + 1) {
    reject('validation_failed', 'exactly one map update must be appended');
  }
}

function recordShellOf(workTitle) {
  return {
    summary: `${SUMMARY_PREFIX}${workTitle}`,
    workDone: [],
    stopPoint: null,
    remaining: [],
    nextActions: [],
    nextActionsStatus: 'not_prepared',
    delivery: null,
  };
}

/** §10.2 normalized content: the digest input, resolved, never containing a digest. */
function normalizedContentOf(record, adoptedBasis) {
  const workContext = record.workContext;
  const shell = recordShellOf(workContext.workTitle);
  return {
    version: workContext.version,
    operation: workContext.operation,
    nodeId: workContext.nodeId,
    workId: workContext.workId,
    predecessorRecordId: record.supersedes,
    workTitle: workContext.workTitle,
    objective: workContext.objective,
    scope: clone(workContext.scope),
    exclusions: clone(workContext.exclusions),
    acceptanceCriteria: clone(workContext.acceptanceCriteria),
    selection: clone(workContext.selection),
    resume: workContext.resume === null ? null : clone(workContext.resume),
    lifecycle: clone(workContext.lifecycle),
    source: record.source,
    sourceRefs: [...record.sourceRefs],
    basisRefs: record.basis.refs.map((ref) => ({collection: ref.collection, id: ref.id})),
    adoptedBasis: [...adoptedBasis]
      .sort((left, right) => (left.claimId < right.claimId ? -1 : left.claimId > right.claimId ? 1 : 0))
      .map((entry) => clone(entry)),
    upper: clone(workContext.upper),
    recordShell: {
      summary: shell.summary,
      workDone: shell.workDone,
      stopPoint: shell.stopPoint,
      remaining: shell.remaining,
      nextActions: shell.nextActions,
      nextActionsStatus: shell.nextActionsStatus,
      delivery: null,
    },
    basis: {
      observedStateVersion: record.basis.observedStateVersion,
      observedDigest: record.basis.observedDigest,
      contextFingerprint: record.basis.contextFingerprint,
      contextFingerprintVersion: record.basis.contextFingerprintVersion,
    },
    // Saved support digests are part of what the human reviewed, so a rebuild
    // whose support material moved produces a different preview digest.
    workSupportSnapshots: listOf(record.workSupportSnapshots).map((entry) => ({
      collection: entry.collection,
      id: entry.id,
      digest: entry.digest,
    })),
  };
}

/** §10.2 `diff`: every group, complete before/after, unchanged groups included. */
function diffOf(beforeRecord, afterRecord) {
  const beforeContext = isPlainObject(beforeRecord?.workContext) ? beforeRecord.workContext : null;
  const afterContext = afterRecord.workContext;
  const beforeShell = beforeRecord ? {
    summary: beforeRecord.summary,
    workDone: listOf(beforeRecord.workDone),
    stopPoint: beforeRecord.stopPoint ?? null,
    remaining: listOf(beforeRecord.remaining),
    nextActions: listOf(beforeRecord.nextActions),
    nextActionsStatus: beforeRecord.nextActionsStatus ?? null,
    delivery: beforeRecord.delivery ?? null,
  } : null;
  const afterShell = recordShellOf(afterContext.workTitle);
  return [
    {group: 'lifecycle', before: beforeContext ? clone(beforeContext.lifecycle) : null, after: clone(afterContext.lifecycle)},
    {group: 'workTitle', before: beforeContext?.workTitle ?? null, after: afterContext.workTitle},
    {group: 'objective', before: beforeContext?.objective ?? null, after: afterContext.objective},
    {group: 'scope', before: clone(listOf(beforeContext?.scope)), after: clone(afterContext.scope)},
    {group: 'exclusions', before: clone(listOf(beforeContext?.exclusions)), after: clone(afterContext.exclusions)},
    {group: 'acceptanceCriteria', before: clone(listOf(beforeContext?.acceptanceCriteria)), after: clone(afterContext.acceptanceCriteria)},
    {group: 'selection', before: clone(beforeContext?.selection ?? null), after: clone(afterContext.selection)},
    {group: 'upper', before: clone(beforeContext?.upper ?? null), after: clone(afterContext.upper)},
    {group: 'resume', before: clone(beforeContext?.resume ?? null), after: clone(afterContext.resume)},
    {
      group: 'source',
      before: beforeRecord ? {source: beforeRecord.source, sourceRefs: [...listOf(beforeRecord.sourceRefs)]} : null,
      after: {source: afterRecord.source, sourceRefs: [...afterRecord.sourceRefs]},
    },
    {
      group: 'basisRefs',
      before: beforeRecord ? listOf(beforeRecord.basis?.refs).map((ref) => ({collection: ref.collection, id: ref.id})) : null,
      after: afterRecord.basis.refs.map((ref) => ({collection: ref.collection, id: ref.id})),
    },
    {
      group: 'adoptedBasis',
      before: beforeRecord ? clone(listOf(beforeRecord.adoptedBasis)) : null,
      after: clone(listOf(afterRecord.adoptedBasis)),
    },
    {group: 'recordShell', before: beforeShell, after: afterShell},
  ];
}

function sidecarPlanOf(record, sidecars) {
  const plan = sidecars.map((sidecar) => ({collection: 'layer', path: sidecar.path, digest: sidecar.digest}));
  for (const entry of listOf(record.adoptedBasis)) {
    if (entry.snapshotPath === null) continue;
    plan.push({collection: 'adoptedBasis', claimId: entry.claimId, path: entry.snapshotPath, digest: entry.contentDigest});
  }
  return plan.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * `workSupportSnapshots`: one saved digest per support id (§8.1 support set),
 * sorted unique by collection then id. A digest covers the CONTENT projection
 * only, so a confirmation move never shows up as a content move here.
 *
 * The count is bounded by the read model's own limit (`WORK_SUPPORT_SNAPSHOT_LIMIT`),
 * shared with `validateFeatureCheckpoint`; exceeding it is a refusal, never a
 * truncation, because a record that silently held "the first N" would report
 * support as unchanged for every id it never looked at.
 */
function supportSnapshotEntries(state, nodeId) {
  const projections = progress.featureWorkSupportProjections(state, nodeId);
  if (projections.truncated || projections.projections.length > progress.WORK_SUPPORT_SNAPSHOT_LIMIT) {
    return failure('invalid_request', [
      `workSupportSnapshots: the support set exceeds ${progress.WORK_SUPPORT_SNAPSHOT_LIMIT} entries; nothing was written`,
    ], {reason: 'work_support_snapshot_limit', limit: progress.WORK_SUPPORT_SNAPSHOT_LIMIT});
  }
  const entries = [];
  const seen = new Set();
  for (const projection of projections.projections) {
    // A projection with no readable content shape cannot be digested honestly;
    // the support set is then incomplete, so the record refuses instead of
    // saving a digest for `null`.
    if (projection.content === null || projection.content === undefined) {
      return failure('invalid_request', [
        `workSupportSnapshots: ${projection.collection}:${projection.id} has no readable content projection`,
      ], {reason: 'work_support_unreadable', collection: projection.collection, id: projection.id});
    }
    const key = `${projection.collection}\u0000${projection.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      collection: projection.collection,
      id: projection.id,
      digest: sha256Bytes(canonicalStringify(projection.content)),
    });
  }
  entries.sort((left, right) => {
    const byCollection = left.collection < right.collection ? -1 : left.collection > right.collection ? 1 : 0;
    if (byCollection !== 0) return byCollection;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return {ok: true, entries};
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build one current-work record (§9).
 *
 * @param {object} state parsed saved state (never mutated)
 * @param {object} content complete CurrentWorkWriteContent (§9)
 * @param {object} options
 * @param {string} options.digest raw-byte sha256 of `state`
 * @param {string} [options.projectId] must equal state.project.id when present
 * @param {string} [options.operationId] journal field; required unless dryRun
 * @param {string} [options.authorizationRef] journal field; required unless dryRun
 * @param {number} [options.expectedStateVersion] §6.4 CAS; required unless dryRun
 * @param {string} [options.expectedDigest] §6.4 CAS; required unless dryRun
 * @param {boolean} [options.dryRun] preview mode: no receipt, no `nextState`
 * @param {string|Function} [options.clock]
 * @param {Function} [options.uuid] id source for deterministic fixtures
 */
export function buildCurrentWorkWrite(state, content, options = {}) {
  const errors = contentErrors(content);
  if (errors.length) return failure('invalid_request', errors);

  const dryRun = options.dryRun === true;
  const digest = options.digest;
  if (!isSha256(digest)) {
    return failure('invalid_request', [`options.digest: expected the raw-byte sha256 of the state, got ${String(digest)}`]);
  }
  if (!isPlainObject(state)) return failure('invalid_state', ['state: expected an object']);
  if (state.schemaVersion !== '0.2') {
    return failure('unsupported_schema', [`state.schemaVersion: ${String(state.schemaVersion)} is read-only; work records require 0.2`]);
  }
  if (options.projectId !== undefined && options.projectId !== state.project?.id) {
    return failure('wrong_project', ['options.projectId does not match the saved state']);
  }

  const operationId = typeof options.operationId === 'string' && options.operationId.length > 0 ? options.operationId : null;
  const authorizationRef = typeof options.authorizationRef === 'string' && options.authorizationRef.length > 0 ? options.authorizationRef : null;
  const expectedStateVersion = options.expectedStateVersion;
  const expectedDigest = options.expectedDigest;

  if (!dryRun) {
    const missing = [];
    if (!operationId) missing.push('operationId');
    if (!authorizationRef) missing.push('authorizationRef');
    if (!isSafeVersion(expectedStateVersion)) missing.push('expectedStateVersion');
    if (!isSha256(expectedDigest)) missing.push('expectedDigest');
    if (missing.length) return failure('invalid_request', [`missing required options: ${missing.join(', ')}`]);
  }
  if (!dryRun && content.operation !== 'open' && !authorizationRef) {
    return failure('invalid_request', ['options.authorizationRef is required for this operation']);
  }

  try {
    const uuid = idFactory(options);
    const createdAt = readClock(options);
    const used = existingIds(state);
    const workId = typeof content.workId === 'string'
      ? content.workId
      : uniqueGeneratedId('work:', used, uuid);

    // §10.3 rule 9: idempotency precedes the CAS comparison, because a successful
    // first commit is exactly what made the client's expected* stale. The retry
    // key is `operationPayloadDigest`, i.e. {previewContentDigest from the
    // reviewed binding, authorizationRef} — never the current state's content.
    const probe = operationId ? receiptProbe(state, operationId) : null;
    if (probe?.problems.length) {
      return failure('external_modification', ['the saved receipt exists but its record or chain is inconsistent'], {
        operationId,
        problems: probe.problems,
      });
    }
    const bindingDigest = isSha256(options.previewContentDigest) ? options.previewContentDigest : null;
    if (probe) {
      if (typeof content.workId === 'string' && probe.workId !== content.workId) {
        return keyConflict(probe, bindingDigest ? operationPayloadDigest(bindingDigest, authorizationRef) : null);
      }
      if (bindingDigest) {
        const requested = operationPayloadDigest(bindingDigest, authorizationRef);
        if (probe.payloadDigest !== requested) return keyConflict(probe, requested);
        return replayResult(probe, state, digest);
      }
    }

    // Offline/apply path with no preview binding: the content itself is the
    // request, so an existing receipt still has to be compared after the build.
    if (!probe && isSafeVersion(expectedStateVersion) && isSha256(expectedDigest)
      && (state.stateVersion !== expectedStateVersion || digest !== expectedDigest)) {
      return failure('state_conflict', ['The state version or raw-byte digest changed; re-read and prepare a new plan.'], {
        expectedStateVersion,
        actualStateVersion: state.stateVersion,
        expectedDigest,
        actualDigest: digest,
      });
    }

    const stateErrors = validateFullState(state);
    if (stateErrors.length) return failure('invalid_state', ['the current state failed full validation'], {errors: stateErrors});

    const capability = listOf(state.nodes).find((node) => isPlainObject(node) && node.id === content.nodeId);
    if (!capability || capability.kind !== 'capability') {
      return failure('feature_not_found', [`node "${content.nodeId}" is not a saved capability`]);
    }

    const existing = progress.currentWork(state, workId);
    if (content.operation === 'open') {
      if (existing.found) return failure('invalid_request', [`work "${workId}" is already open`], {reason: 'work_already_exists'});
    } else {
      if (!existing.found) return failure('invalid_request', [`work "${workId}" has no saved record`], {reason: 'work_not_found'});
      if (existing.nodeId !== content.nodeId) {
        return failure('validation_failed', ['the work already belongs to another capability'], {
          validatorCode: 'work_rebound_capability',
          workId,
          existingNodeId: existing.nodeId,
          requestedNodeId: content.nodeId,
        });
      }
      if (content.predecessorRecordId !== existing.currentRecordId) {
        return failure('work_revision_conflict', ['the work revision changed; re-read that work and merge explicitly'], {
          workId,
          currentRecordId: existing.currentRecordId,
          requestedPredecessorRecordId: content.predecessorRecordId,
        });
      }
      if (content.operation === 'adjust') {
        const previousLifecycle = existing.currentRecord?.workContext?.lifecycle ?? {};
        if (content.lifecycle.endedReason !== (previousLifecycle.endedReason ?? null)
          || content.lifecycle.endedNote !== (previousLifecycle.endedNote ?? null)) {
          return failure('invalid_request', ['adjust must keep the predecessor lifecycle'], {reason: 'lifecycle_mismatch'});
        }
      }
    }

    const sidecars = sidecarCollector();
    const adopted = resolveAdoptedBasis(state, content, workId, sidecars);
    const ctx = {workId, sidecars, adopted, authorizationRef: authorizationRef ?? ''};

    const upper = {
      productGoal: resolveLayer(state, content, content.upper.productGoal, 'productGoal', ctx),
      stage: resolveLayer(state, content, content.upper.stage, 'stage', ctx),
      openUserPaths: content.upper.openUserPaths.map((entry, index) => resolveLayer(state, content, entry, `openUserPath[${index}]`, ctx)),
    };

    const candidateSnapshot = {
      objective: content.objective,
      scope: clone(content.scope),
      exclusions: clone(content.exclusions),
      acceptanceCriteria: clone(content.acceptanceCriteria),
      selection: clone(content.selection),
      upper,
      resume: content.resume === null ? null : clone(content.resume),
    };

    // §4/§9: pause/resume/end repeat the predecessor's business snapshot byte for
    // byte, compared after resolution (the record stores resolved observations).
    // A difference is refused, never merged, never silently refrozen.
    if (['pause', 'resume', 'end'].includes(content.operation)) {
      const differing = differingBusinessFields(candidateSnapshot, existing.content);
      if (differing.length > 0) {
        return failure('invalid_request', [`${content.operation} changes the business snapshot`], {
          reason: 'business_snapshot_mismatch',
          fields: differing,
        });
      }
    }

    const workContext = {
      version: 1,
      workId,
      workTitle: content.workTitle,
      operation: content.operation,
      nodeId: content.nodeId,
      objective: content.objective,
      scope: clone(content.scope),
      exclusions: clone(content.exclusions),
      acceptanceCriteria: clone(content.acceptanceCriteria),
      selection: clone(content.selection),
      upper,
      lifecycle: {
        status: lifecycleStatusOf(content.operation, existing),
        endedReason: content.lifecycle.endedReason,
        endedNote: content.lifecycle.endedNote,
      },
      resume: content.resume === null ? null : clone(content.resume),
    };

    const contextContent = progress.featureContextFingerprintContent(state, content.nodeId);
    const contextIds = progress.featureContextRecordIds(state, content.nodeId);
    if (!contextContent || !contextIds) return failure('feature_not_found', [`node "${content.nodeId}" is not a capability`]);
    for (const [key, ids] of Object.entries(contextIds)) {
      if (listOf(ids).length > progress.FEATURE_PROGRESS_LIMITS.maxContextIdsPerList) {
        return failure('validation_failed', [`context ids for ${key} exceed ${progress.FEATURE_PROGRESS_LIMITS.maxContextIdsPerList}`]);
      }
    }

    // §8.1 support set: what "the implementation/verification material" means
    // for this Feature. Refused (never truncated) above the read-model limit.
    const support = supportSnapshotEntries(state, content.nodeId);
    if (!support.ok) return support;

    const chain = listOf(state.featureCheckpoints).filter((record) => isPlainObject(record) && record.nodeId === content.nodeId);
    const tail = chain.find((record) => !chain.some((other) => other.supersedes === record.id)) ?? null;
    const shell = recordShellOf(content.workTitle);
    const checkpoint = {
      id: uniqueGeneratedId('checkpoint:', used, uuid),
      nodeId: content.nodeId,
      createdAt,
      source: content.source,
      sourceRefs: [...content.sourceRefs],
      supersedes: tail?.id ?? null,
      summary: shell.summary,
      workDone: [],
      stopPoint: null,
      remaining: [],
      nextActions: [],
      nextActionsStatus: 'not_prepared',
      basis: {
        observedStateVersion: state.stateVersion,
        observedDigest: digest,
        contextFingerprint: sha256Bytes(canonicalStringify(contextContent)),
        contextFingerprintVersion: progress.FEATURE_CONTEXT_FINGERPRINT_VERSION,
        contextIds,
        refs: content.basisRefs.map((ref) => ({collection: ref.collection, id: ref.id})),
        sourceSnapshots: [],
      },
      workContext,
    };
    if (adopted.length > 0) checkpoint.adoptedBasis = adopted;
    // Additive key: a work record says what its support material was. Ordinary
    // checkpoints never reach here, so their bytes are unchanged.
    checkpoint.workSupportSnapshots = support.entries;

    const workErrors = progress.validateWorkContext(workContext, {location: 'checkpoint.workContext'});
    if (workErrors.length) return failure('validation_failed', workErrors, {validatorCode: 'validateWorkContext'});
    if (jsonBytes(workContext) > LIMITS.maxWorkContextBytes) {
      return failure('invalid_request', [`workContext: ${jsonBytes(workContext)} bytes, above ${LIMITS.maxWorkContextBytes}`]);
    }
    if (jsonBytes(upper) > LIMITS.maxUpperBytes) {
      return failure('invalid_request', [`workContext.upper: ${jsonBytes(upper)} bytes, above ${LIMITS.maxUpperBytes}`]);
    }
    if (jsonBytes(adopted) > LIMITS.maxAdoptedBasisBytes) {
      return failure('invalid_request', [`adoptedBasis: ${jsonBytes(adopted)} bytes, above ${LIMITS.maxAdoptedBasisBytes}`]);
    }
    if (listOf(state.featureCheckpoints).length + 1 > progress.FEATURE_PROGRESS_LIMITS.maxFeatureCheckpoints) {
      return failure('invalid_request', [`the state already holds ${listOf(state.featureCheckpoints).length} checkpoints; the limit is ${progress.FEATURE_PROGRESS_LIMITS.maxFeatureCheckpoints}`]);
    }
    if (chain.length + 1 > progress.FEATURE_PROGRESS_LIMITS.maxCheckpointsPerFeature) {
      return failure('invalid_request', [`Feature "${content.nodeId}" already holds ${chain.length} checkpoints; the limit is ${progress.FEATURE_PROGRESS_LIMITS.maxCheckpointsPerFeature}`]);
    }

    const recordErrors = progress.validateFeatureCheckpoint(checkpoint, state, 'currentWork checkpoint');
    if (recordErrors.length) return failure('validation_failed', recordErrors);

    const normalizedContent = normalizedContentOf(checkpoint, adopted);
    const previewContentDigest = sha256Bytes(canonicalStringify(normalizedContent));
    const payloadDigest = authorizationRef ? operationPayloadDigest(previewContentDigest, authorizationRef) : null;

    if (bindingDigest && bindingDigest !== previewContentDigest) {
      return failure('validation_failed', ['the rebuild did not reproduce the previewed content'], {
        reason: 'preview_not_reproducible',
        expectedPreviewContentDigest: bindingDigest,
        actualPreviewContentDigest: previewContentDigest,
      });
    }
    if (probe) {
      if (probe.payloadDigest !== payloadDigest) return keyConflict(probe, payloadDigest);
      return replayResult(probe, state, digest);
    }

    const recordPreview = {...clone(checkpoint), id: null, createdAt: null};
    const beforeRecord = existing.found ? existing.currentRecord : null;
    const diff = diffOf(beforeRecord, checkpoint);

    if (dryRun) {
      return {
        ok: true,
        replayed: false,
        dryRun: true,
        checkpoint,
        adoptedBasis: adopted,
        sidecars: sidecars.list(),
        nextState: null,
        receipt: null,
        workId,
        operation: content.operation,
        payloadDigest,
        previewContentDigest,
        normalizedContent,
        recordPreview,
        diff,
        sidecarPlan: sidecarPlanOf(checkpoint, sidecars.list()),
        previousStateVersion: state.stateVersion,
        resultingStateVersion: state.stateVersion + 1,
        previousDigest: digest,
      };
    }

    const receipt = {
      id: uniqueGeneratedId('map-update:', used, uuid),
      operationId,
      projectId: state.project.id,
      source: 'local_feature_checkpoint',
      createdAt,
      authorizationRef,
      summary: checkpoint.summary,
      observedStateVersion: state.stateVersion,
      observedDigest: digest,
      resultingStateVersion: state.stateVersion + 1,
      payloadDigest,
      changedNodeIds: [],
      addedFeatureCheckpointIds: [checkpoint.id],
      addedEdgeIds: [],
      addedEvidenceIds: [],
      addedCheckIds: [],
    };

    const nextState = structuredClone(state);
    nextState.featureCheckpoints = [...listOf(state.featureCheckpoints), checkpoint];
    nextState.mapUpdates = [...listOf(state.mapUpdates), receipt];
    nextState.stateVersion = state.stateVersion + 1;

    assertAppendOnly(state, nextState);
    const nextErrors = validateFullState(nextState);
    if (nextErrors.length) return failure('validation_failed', ['the proposed state failed full validation'], {errors: nextErrors});

    return {
      ok: true,
      replayed: false,
      dryRun: false,
      checkpoint,
      adoptedBasis: adopted,
      sidecars: sidecars.list(),
      nextState,
      receipt,
      workId,
      operation: content.operation,
      payloadDigest,
      previewContentDigest,
      normalizedContent,
      recordPreview,
      diff,
      sidecarPlan: sidecarPlanOf(checkpoint, sidecars.list()),
      previousStateVersion: state.stateVersion,
      resultingStateVersion: nextState.stateVersion,
      previousDigest: digest,
    };
  } catch (error) {
    return failureFrom(error);
  }
}