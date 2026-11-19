#!/usr/bin/env node
// Explicit, offline feature-checkpoint append. Preview is read-only; apply
// re-reads under the cooperative state lock, checks the exact version and
// raw-byte digest, appends exactly one checkpoint plus one map-update receipt,
// keeps an original-byte backup and verifies the committed state.
//
// This command never creates capabilities, roadmap items, claims, decisions,
// evidence or reviews, never runs tests and never starts/stops a service.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalStringify } from './intent-model.mjs';
import {
  deriveFeatureDelivery,
  featureContextFingerprintContent,
  featureContextRecordIds,
  validateFeatureCheckpoint,
  FEATURE_CONTEXT_FINGERPRINT_VERSION,
  FEATURE_PROGRESS_LIMITS,
} from './feature-progress.mjs';
import {
  buildCurrentWorkWrite,
} from './current-work-model.mjs';
import {
  StoreError, acquireStateLocks, assertStateLocks, canonicalizeStatePath,
  commitStateBytes, readStateFile, releaseStateLocks, sha256Bytes, validateFullState,
} from './state-store.mjs';

const PLAN_FIELDS = [
  'projectId', 'operationId', 'expectedStateVersion', 'expectedDigest', 'authorizationRef',
  'nodeId', 'supersedes', 'source', 'sourceRefs', 'summary', 'workDone', 'stopPoint',
  'remaining', 'nextActions', 'nextActionsStatus', 'basis',
];
const BASIS_FIELDS = ['refs', 'sourceSnapshots'];
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const fail = (code, message, details = {}) => { throw new StoreError(code, message, { status: 400, details }); };
const equal = (left, right) => canonicalStringify(left) === canonicalStringify(right);

function exactKeys(value, keys, label, optionalKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_feature_checkpoint_plan', `${label}: expected an object`);
  const allowed = [...keys, ...optionalKeys];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('invalid_feature_checkpoint_plan', `${label}: unexpected field "${key}"`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail('invalid_feature_checkpoint_plan', `${label}: missing field "${key}"`);
}

function isText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /\S/.test(value);
}

function exactText(value, field, maxLength = 2000) {
  if (!isText(value, maxLength)) fail('invalid_feature_checkpoint_plan', `${field}: expected 1..${maxLength} non-blank characters`);
}

/**
 * Validate the client plan (strict key set plus every field the checkpoint
 * contract shares). Returns nothing; throws StoreError on the first layer of
 * problems with all collected messages in details.errors.
 */
export function validateFeatureCheckpointPlan(plan) {
  exactKeys(plan, PLAN_FIELDS, 'plan', ['delivery']);
  exactText(plan.projectId, 'projectId');
  exactText(plan.operationId, 'operationId', 160);
  exactText(plan.authorizationRef, 'authorizationRef');
  if (!Number.isSafeInteger(plan.expectedStateVersion) || plan.expectedStateVersion < 1 || plan.expectedStateVersion >= Number.MAX_SAFE_INTEGER || !/^sha256:[0-9a-f]{64}$/.test(plan.expectedDigest)) {
    fail('invalid_feature_checkpoint_plan', 'Expected a safe version and a full raw-byte SHA-256.');
  }
  exactText(plan.nodeId, 'nodeId', FEATURE_PROGRESS_LIMITS.maxIdLength);
  if (plan.supersedes !== null) exactText(plan.supersedes, 'supersedes', FEATURE_PROGRESS_LIMITS.maxIdLength);
  exactKeys(plan.basis, BASIS_FIELDS, 'basis');
  // Reuse the record validator for every shared field. The probe has a valid
  // placeholder identity and empty context ids; real ids/timing are generated
  // later, and the final record is checked again before it is written.
  const probe = {
    id: `checkpoint:${'0'.repeat(8)}-0000-4000-8000-000000000000`,
    nodeId: plan.nodeId,
    createdAt: '1970-01-01T00:00:00.000Z',
    source: plan.source,
    sourceRefs: plan.sourceRefs,
    supersedes: plan.supersedes,
    summary: plan.summary,
    workDone: plan.workDone,
    stopPoint: plan.stopPoint,
    remaining: plan.remaining,
    nextActions: plan.nextActions,
    nextActionsStatus: plan.nextActionsStatus,
    basis: {
      observedStateVersion: plan.expectedStateVersion,
      observedDigest: plan.expectedDigest,
      contextFingerprint: ZERO_DIGEST,
      contextFingerprintVersion: FEATURE_CONTEXT_FINGERPRINT_VERSION,
      contextIds: {
        nodeIds: [], edgeIds: [], evidenceIds: [], claimIds: [],
        decisionIds: [], proposalIds: [], reviewIds: [], roadmapItemIds: [],
      },
      refs: plan.basis.refs,
      sourceSnapshots: plan.basis.sourceSnapshots,
    },
    ...(Object.hasOwn(plan, 'delivery') ? { delivery: structuredClone(plan.delivery) } : {}),
  };
  const errors = validateFeatureCheckpoint(probe);
  if (errors.length) fail('invalid_feature_checkpoint_plan', errors.join('; '), { errors });
  try {
    canonicalStringify(plan);
  } catch (error) {
    fail('invalid_feature_checkpoint_plan', error.message);
  }
}

function assertAppendOnly(before, after) {
  if (after.stateVersion !== before.stateVersion + 1) {
    fail('state_validation_failed', 'The proposed state did not advance exactly one version.');
  }
  const strip = (state) => {
    const copy = structuredClone(state);
    delete copy.stateVersion;
    delete copy.featureCheckpoints;
    delete copy.mapUpdates;
    return copy;
  };
  if (!equal(strip(before), strip(after))) {
    fail('state_validation_failed', 'A feature checkpoint write may only append checkpoints and receipts.');
  }
  const beforeCheckpoints = Array.isArray(before.featureCheckpoints) ? before.featureCheckpoints : [];
  const beforeUpdates = Array.isArray(before.mapUpdates) ? before.mapUpdates : [];
  if (!equal(after.featureCheckpoints.slice(0, beforeCheckpoints.length), beforeCheckpoints)) {
    fail('state_validation_failed', 'The existing checkpoint array is not a strict prefix of the new array.');
  }
  if (!equal(after.mapUpdates.slice(0, beforeUpdates.length), beforeUpdates)) {
    fail('state_validation_failed', 'The existing map update array is not a strict prefix of the new array.');
  }
  if (after.featureCheckpoints.length !== beforeCheckpoints.length + 1) {
    fail('state_validation_failed', 'Exactly one checkpoint must be appended.');
  }
  if (after.mapUpdates.length !== beforeUpdates.length + 1) {
    fail('state_validation_failed', 'Exactly one map update must be appended.');
  }
}

function featureSummary(state, nodeId) {
  const node = (Array.isArray(state.nodes) ? state.nodes : []).find((item) => item.id === nodeId);
  return node ? { nodeId: node.id, label: node.label, status: node.status } : null;
}

function roadmapSummary(state, nodeId) {
  const items = Array.isArray(state.roadmapItems) ? state.roadmapItems : [];
  const item = items.find((record) => record.nodeId === nodeId);
  return {
    collectionPresent: Array.isArray(state.roadmapItems),
    item: item ? { id: item.id, horizon: item.horizon, status: item.status } : null,
  };
}

function chainFor(state, nodeId) {
  const records = (Array.isArray(state.featureCheckpoints) ? state.featureCheckpoints : [])
    .filter((record) => record && record.nodeId === nodeId);
  const root = records.find((record) => record.supersedes === null);
  const tail = records.find((record) => !records.some((other) => other.supersedes === record.id)) ?? null;
  return { records, rootId: root?.id ?? null, tailId: tail?.id ?? null };
}

function buildContext(state, nodeId) {
  const content = featureContextFingerprintContent(state, nodeId);
  const contextIds = featureContextRecordIds(state, nodeId);
  if (!content || !contextIds) fail('feature_checkpoint_boundary', `Feature "${nodeId}" is not a capability node.`);
  for (const [key, ids] of Object.entries(contextIds)) {
    if (ids.length > FEATURE_PROGRESS_LIMITS.maxContextIdsPerList) {
      fail('feature_checkpoint_limit', `Context ids for ${key} exceed ${FEATURE_PROGRESS_LIMITS.maxContextIdsPerList} entries.`);
    }
  }
  return { content, contextIds, fingerprint: sha256Bytes(canonicalStringify(content)) };
}

function prepare(state, digest, plan, options = {}) {
  validateFeatureCheckpointPlan(plan);
  const currentErrors = validateFullState(state);
  if (currentErrors.length) fail('state_validation_failed', 'The current state failed full validation.', { errors: currentErrors });
  if (state.schemaVersion !== '0.2') fail('feature_checkpoint_read_only', 'Feature checkpoints require schema 0.2; this command never migrates.');
  if (state.project?.id !== plan.projectId) fail('project_mismatch', 'The plan belongs to a different project.');
  const payloadDigest = sha256Bytes(canonicalStringify(plan));
  const previous = (state.mapUpdates ?? []).find((item) => item.operationId === plan.operationId);
  if (previous) {
    const existingId = Array.isArray(previous.addedFeatureCheckpointIds) && previous.addedFeatureCheckpointIds.length === 1
      ? previous.addedFeatureCheckpointIds[0]
      : null;
    const existing = existingId ? (state.featureCheckpoints ?? []).find((record) => record.id === existingId) : null;
    if (previous.source === 'local_feature_checkpoint' && previous.payloadDigest === payloadDigest && existing) {
      return { nextState: state, checkpoint: existing, record: previous, replayed: true, payloadDigest };
    }
    fail('feature_checkpoint_key_conflict', 'operationId was already used for different content or its checkpoint is missing.');
  }
  if (state.stateVersion !== plan.expectedStateVersion || digest !== plan.expectedDigest) {
    fail('stale_feature_checkpoint_plan', 'The file version or raw-byte digest changed; prepare a new plan.', {
      expectedStateVersion: plan.expectedStateVersion,
      actualStateVersion: state.stateVersion,
      expectedDigest: plan.expectedDigest,
      actualDigest: digest,
    });
  }
  const node = (state.nodes ?? []).find((item) => item.id === plan.nodeId);
  if (!node) fail('feature_checkpoint_boundary', `Feature node "${plan.nodeId}" does not exist.`);
  if (node.kind !== 'capability') fail('feature_checkpoint_boundary', `Node "${plan.nodeId}" is not a kind=capability node.`);
  const chain = chainFor(state, plan.nodeId);
  if (plan.supersedes !== chain.tailId) {
    fail('feature_checkpoint_tail_conflict', 'supersedes must equal the current chain tail.', {
      requested: plan.supersedes,
      currentTailId: chain.tailId,
    });
  }
  const context = buildContext(state, plan.nodeId);

  const time = options.clock ? (typeof options.clock === 'function' ? options.clock() : options.clock) : new Date().toISOString();
  if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))) fail('invalid_feature_checkpoint_clock', 'Invalid checkpoint time.');

  const checkpoint = {
    id: `checkpoint:${randomUUID()}`,
    nodeId: plan.nodeId,
    createdAt: time,
    source: plan.source,
    sourceRefs: [...plan.sourceRefs],
    supersedes: plan.supersedes,
    summary: plan.summary,
    workDone: structuredClone(plan.workDone),
    stopPoint: plan.stopPoint,
    remaining: structuredClone(plan.remaining),
    nextActions: structuredClone(plan.nextActions),
    nextActionsStatus: plan.nextActionsStatus,
    basis: {
      observedStateVersion: state.stateVersion,
      observedDigest: digest,
      contextFingerprint: context.fingerprint,
      contextFingerprintVersion: FEATURE_CONTEXT_FINGERPRINT_VERSION,
      contextIds: context.contextIds,
      refs: structuredClone(plan.basis.refs),
      sourceSnapshots: structuredClone(plan.basis.sourceSnapshots),
    },
    ...(Object.hasOwn(plan, 'delivery') ? { delivery: structuredClone(plan.delivery) } : {}),
  };
  const recordErrors = validateFeatureCheckpoint(checkpoint, state);
  if (recordErrors.length) fail('feature_checkpoint_boundary', recordErrors.join('; '), { errors: recordErrors });
  const checkpointBytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');
  if (checkpointBytes > FEATURE_PROGRESS_LIMITS.maxCheckpointBytes) {
    fail('feature_checkpoint_limit', `The checkpoint is ${checkpointBytes} bytes, above ${FEATURE_PROGRESS_LIMITS.maxCheckpointBytes}.`);
  }
  const existingCount = Array.isArray(state.featureCheckpoints) ? state.featureCheckpoints.length : 0;
  if (existingCount + 1 > FEATURE_PROGRESS_LIMITS.maxFeatureCheckpoints) {
    fail('feature_checkpoint_limit', `The state already holds ${existingCount} checkpoints; the limit is ${FEATURE_PROGRESS_LIMITS.maxFeatureCheckpoints}.`);
  }
  if (chain.records.length + 1 > FEATURE_PROGRESS_LIMITS.maxCheckpointsPerFeature) {
    fail('feature_checkpoint_limit', `Feature "${plan.nodeId}" already holds ${chain.records.length} checkpoints; the limit is ${FEATURE_PROGRESS_LIMITS.maxCheckpointsPerFeature}.`);
  }

  const record = {
    id: `map-update:${randomUUID()}`,
    operationId: plan.operationId,
    projectId: state.project.id,
    source: 'local_feature_checkpoint',
    createdAt: time,
    authorizationRef: plan.authorizationRef,
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
  const next = structuredClone(state);
  next.featureCheckpoints = [...(Array.isArray(state.featureCheckpoints) ? state.featureCheckpoints : []), checkpoint];
  next.mapUpdates = [...(Array.isArray(state.mapUpdates) ? state.mapUpdates : []), record];
  next.stateVersion = state.stateVersion + 1;
  assertAppendOnly(state, next);
  const nextErrors = validateFullState(next);
  if (nextErrors.length) fail('state_validation_failed', 'The proposed state failed full validation.', { errors: nextErrors });
  return { nextState: next, checkpoint, record, replayed: false, payloadDigest };
}

function previewShape(state, digest, prepared) {
  const checkpoint = prepared.checkpoint;
  const draft = {
    ...structuredClone(checkpoint),
    id: null,
    createdAt: null,
  };
  return {
    ok: true,
    applied: false,
    replayed: prepared.replayed,
    stateVersion: state.stateVersion,
    observedDigest: digest,
    feature: featureSummary(state, checkpoint.nodeId),
    roadmap: roadmapSummary(state, checkpoint.nodeId),
    chain: { currentTailId: chainFor(state, checkpoint.nodeId).tailId, requestedSupersedes: checkpoint.supersedes },
    draft,
    // Reading of the saved delivery statement only; the write itself neither
    // accepts the Feature nor authorizes a release.
    delivery: deriveFeatureDelivery(checkpoint, { status: 'unchanged' }),
    computed: { checkpointBytes: Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') },
    warnings: [],
    authorization: { previewOnly: true, sampleIdNotPersisted: true, nextActionsGrantNothing: true, deliveryIsNotAcceptance: true, deliveryIsNotReleaseAuthorization: true },
  };
}

// --- Current-work delegation -------------------------------------------------
// A plan that carries `content` (and no checkpoint `nodeId`) is one current-work
// write from references/current-work-contract.md §9/§10. Every rule lives in the
// shared pure builder; this file only does its existing read/lock/commit work.

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const CURRENT_WORK_PREVIEW_FIELDS = ['projectId', 'expectedStateVersion', 'expectedDigest', 'content'];
const CURRENT_WORK_APPLY_FIELDS = [...CURRENT_WORK_PREVIEW_FIELDS, 'operationId', 'authorizationRef'];

function isCurrentWorkPlan(plan) {
  return isPlainObject(plan) && Object.hasOwn(plan, 'content') && !Object.hasOwn(plan, 'nodeId');
}

const CURRENT_WORK_STATUS = {
  invalid_request: 400,
  unresolved_upper_ref: 400,
  unsupported_schema: 409,
  feature_not_found: 404,
  wrong_project: 403,
  sidecar_conflict: 409,
  state_conflict: 409,
  work_revision_conflict: 409,
  key_conflict: 409,
  invalid_state: 422,
  validation_failed: 422,
  external_modification: 503,
};

function throwCurrentWorkFailure(result) {
  if (result.code === 'validation_failed' && result.details?.reason === 'preview_not_reproducible') {
    throw new StoreError('validation_failed', 'The rebuild did not reproduce the previewed content.', {
      status: 503, details: result.details,
    });
  }
  const status = CURRENT_WORK_STATUS[result.code] ?? 500;
  throw new StoreError(result.code, result.errors.join('; ') || result.code, {
    status,
    details: result.details ?? {errors: result.errors},
  });
}

function currentWorkPlanFields(plan, fields) {
  const extra = Object.keys(plan).filter((key) => !fields.includes(key));
  if (extra.length) fail('invalid_feature_checkpoint_plan', `plan: unexpected field "${extra[0]}"`);
  const missing = fields.filter((key) => !Object.hasOwn(plan, key));
  if (missing.length) fail('invalid_feature_checkpoint_plan', `plan: missing field "${missing[0]}"`);
}

function currentWorkPreviewShape(state, digest, prepared, plan) {
  const checkpoint = prepared.checkpoint ?? null;
  return {
    ok: true,
    applied: false,
    replayed: Boolean(prepared.replayed),
    stateVersion: state.stateVersion,
    observedDigest: digest,
    feature: featureSummary(state, plan.content.nodeId),
    work: { workId: prepared.workId ?? plan.content.workId ?? null, operation: plan.content.operation },
    recordPreview: prepared.recordPreview,
    diff: prepared.diff,
    previewContentDigest: prepared.previewContentDigest,
    sidecarPlan: prepared.sidecarPlan,
    computed: checkpoint ? { checkpointBytes: Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') } : null,
    warnings: [],
    authorization: {
      previewOnly: true,
      sampleIdNotPersisted: true,
      nextActionsGrantNothing: true,
      deliveryIsNotAcceptance: true,
      deliveryIsNotReleaseAuthorization: true,
    },
  };
}

async function previewCurrentWorkCheckpoint(statePath, plan, options = {}) {
  currentWorkPlanFields(plan, CURRENT_WORK_PREVIEW_FIELDS);
  const canonical = await canonicalizeStatePath(statePath, {mustExist: true, io: options.io});
  const read = await readStateFile(canonical.path, options);
  const state = JSON.parse(read.text);
  const prepared = buildCurrentWorkWrite(state, plan.content, {
    ...options,
    dryRun: true,
    digest: read.digest,
    projectId: plan.projectId,
    expectedStateVersion: plan.expectedStateVersion,
    expectedDigest: plan.expectedDigest,
  });
  if (!prepared.ok) throwCurrentWorkFailure(prepared);
  return currentWorkPreviewShape(state, read.digest, prepared, plan);
}

async function applyCurrentWorkCheckpoint(statePath, plan, options = {}) {
  if (options.authorized !== true) fail('feature_checkpoint_authorization_required', 'Explicit authorization is required; CLI writes use --apply.');
  currentWorkPlanFields(plan, CURRENT_WORK_APPLY_FIELDS);
  const canonical = await canonicalizeStatePath(statePath, {mustExist: true, io: options.io});
  const locks = await acquireStateLocks([canonical.path], {io: options.io});
  try {
    const read = await readStateFile(canonical.path, options);
    const before = JSON.parse(read.text);
    const prepared = buildCurrentWorkWrite(before, plan.content, {
      ...options,
      digest: read.digest,
      projectId: plan.projectId,
      operationId: plan.operationId,
      authorizationRef: plan.authorizationRef,
      expectedStateVersion: plan.expectedStateVersion,
      expectedDigest: plan.expectedDigest,
    });
    if (!prepared.ok) throwCurrentWorkFailure(prepared);
    if (prepared.replayed) {
      return {
        ok: true, applied: false, replayed: true, commitStatus: 'verified_existing_record',
        stateVersion: before.stateVersion, digest: read.digest,
        record: prepared.receipt, checkpoint: prepared.checkpoint,
        workId: prepared.workId, payloadDigest: prepared.payloadDigest,
        feature: featureSummary(before, plan.content.nodeId),
      };
    }
    // Sidecar I/O belongs to the store/service layer (contract §7.2). This offline
    // path delegates it through an injected writer and fails closed otherwise: it
    // must never rename the state while the sidecars it points at are absent.
    let sidecarAttempt = null;
    if (prepared.sidecars.length > 0) {
      if (typeof options.writeSidecars !== 'function') {
        fail('prepare_failed', 'Sidecar writing is not available in this offline path; inject options.writeSidecars or use the service route.');
      }
      sidecarAttempt = await options.writeSidecars(prepared.sidecars);
    }
    const nextBytes = Buffer.from(`${JSON.stringify(prepared.nextState, null, 2)}\n`, 'utf8');
    let commit;
    try {
      commit = await commitStateBytes({
        statePath: canonical.path, oldBytes: read.bytes, oldDigest: read.digest, oldStat: read.stat,
        oldVersion: before.stateVersion, nextBytes, nextDigest: sha256Bytes(nextBytes),
        lockCheck: () => assertStateLocks(locks, {io: options.io}), io: options.io,
        maxStateBytes: options.maxStateBytes, hooks: options.hooks,
        verifyCommitted: (saved) => equal(saved, prepared.nextState),
      });
    } catch (error) {
      if (sidecarAttempt && typeof sidecarAttempt.rollback === 'function') await sidecarAttempt.rollback();
      throw error;
    }
    return {
      ok: true, applied: true, replayed: false, commitStatus: commit.commitStatus,
      stateVersion: commit.state.stateVersion, digest: commit.digest,
      backupPath: commit.backupPath, directorySync: commit.directorySync,
      record: prepared.receipt, checkpoint: prepared.checkpoint,
      workId: prepared.workId, payloadDigest: prepared.payloadDigest,
      previewContentDigest: prepared.previewContentDigest,
      sidecars: prepared.sidecarPlan,
      feature: featureSummary(prepared.nextState, plan.content.nodeId),
    };
  } finally {
    await releaseStateLocks(locks, {io: options.io});
  }
}

// Read-only preview: no lock, backup, temporary file or state write.
export async function previewFeatureCheckpoint(statePath, plan, options = {}) {
  if (isCurrentWorkPlan(plan)) return previewCurrentWorkCheckpoint(statePath, plan, options);
  validateFeatureCheckpointPlan(plan);
  plan = structuredClone(plan);
  const canonical = await canonicalizeStatePath(statePath, { mustExist: true, io: options.io });
  const read = await readStateFile(canonical.path, options);
  const state = JSON.parse(read.text);
  const prepared = prepare(state, read.digest, plan, options);
  return previewShape(state, read.digest, prepared);
}

export async function applyFeatureCheckpoint(statePath, plan, options = {}) {
  if (isCurrentWorkPlan(plan)) return applyCurrentWorkCheckpoint(statePath, plan, options);
  if (options.authorized !== true) fail('feature_checkpoint_authorization_required', 'Explicit authorization is required; CLI writes use --apply.');
  validateFeatureCheckpointPlan(plan);
  plan = structuredClone(plan);
  const canonical = await canonicalizeStatePath(statePath, { mustExist: true, io: options.io });
  const locks = await acquireStateLocks([canonical.path], { io: options.io });
  try {
    const read = await readStateFile(canonical.path, options);
    const before = JSON.parse(read.text);
    const prepared = prepare(before, read.digest, plan, options);
    if (prepared.replayed) {
      return {
        ok: true, applied: false, replayed: true, commitStatus: 'verified_existing_record',
        stateVersion: before.stateVersion, digest: read.digest,
        record: prepared.record, checkpoint: prepared.checkpoint,
        feature: featureSummary(before, prepared.checkpoint.nodeId),
      };
    }
    const nextBytes = Buffer.from(`${JSON.stringify(prepared.nextState, null, 2)}\n`, 'utf8');
    const commit = await commitStateBytes({
      statePath: canonical.path, oldBytes: read.bytes, oldDigest: read.digest, oldStat: read.stat,
      oldVersion: before.stateVersion, nextBytes, nextDigest: sha256Bytes(nextBytes),
      lockCheck: () => assertStateLocks(locks, { io: options.io }), io: options.io,
      maxStateBytes: options.maxStateBytes, hooks: options.hooks,
      verifyCommitted: (saved) => equal(saved, prepared.nextState),
    });
    return {
      ok: true, applied: true, replayed: false, commitStatus: commit.commitStatus,
      stateVersion: commit.state.stateVersion, digest: commit.digest,
      backupPath: commit.backupPath, directorySync: commit.directorySync,
      record: prepared.record, checkpoint: prepared.checkpoint,
      feature: featureSummary(prepared.nextState, prepared.checkpoint.nodeId),
    };
  } finally {
    await releaseStateLocks(locks, { io: options.io });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3 || (args[2] !== undefined && args[2] !== '--apply')) {
    console.error('Usage: node scripts/record-feature-checkpoint.mjs <state.json> <plan.json> [--apply]');
    process.exitCode = 2;
    return;
  }
  try {
    const plan = JSON.parse((await readStateFile(args[1])).text);
    const result = args[2] === '--apply'
      ? await applyFeatureCheckpoint(args[0], plan, { authorized: true })
      : await previewFeatureCheckpoint(args[0], plan);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error.code ?? 'feature_checkpoint_failed',
      commitStatus: error.commitStatus ?? 'not_committed',
      message: error.message,
      details: error.details ?? {},
    }, null, 2));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
