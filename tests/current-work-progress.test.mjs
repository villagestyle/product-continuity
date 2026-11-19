import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canonicalStringify } from '../scripts/intent-model.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { validateStateSchema } from '../scripts/validate-schema-runner.mjs';
import {
  FEATURE_PROGRESS_LIMITS,
  WORK_LIMITS,
  currentWork,
  deriveCurrentWorkIndex,
  deriveFeatureProgress,
  deriveWorkChanges,
  featureContextFingerprintContent,
  featureContextRecordIds,
  featureWorkSupportProjections,
  WORK_SUPPORT_SNAPSHOT_COLLECTIONS,
  WORK_SUPPORT_SNAPSHOT_LIMIT,
  layerConfirmationProjection,
  layerContentProjection,
  layerStageReading,
  overallRecord,
  selectFeatureContext,
  validateFeatureProgress,
  validateWorkContext,
} from '../scripts/feature-progress.mjs';

/**
 * Step 2 of references/current-work-contract.md: the strict `workContext` /
 * `adoptedBasis` shape and the pure read models over it. Every fixture below is
 * synthetic (built from tests/fixtures/state-0.2-feature-valid.json); nothing
 * here reads a real project state, runs the service or writes anything.
 */

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const valid = await readJson('./fixtures/state-0.2-feature-valid.json');
const sharedDecision01 = await readJson('./fixtures/state-0.1-shared-decision.json');

const digest = (content) => sha256Bytes(canonicalStringify(content));
const options = { digest };
const clone = (value) => structuredClone(value);

const FEATURE = 'capability:progress-resume';
const SECOND = 'capability:search';
const CLAIM = 'claim:resume:v1';
const GOAL = 'goal:resume';
const STAGE_CHECKPOINT = 'checkpoint:00000000-0000-4000-8000-000000000002';
const SEARCH_CHECKPOINT = 'checkpoint:00000000-0000-4000-8000-000000000003';

const ACTIVE = Object.freeze({ status: 'active', endedReason: null, endedNote: null });
const PAUSED = Object.freeze({ status: 'paused', endedReason: null, endedNote: null });
const ENDED_HANDOFF = Object.freeze({ status: 'ended', endedReason: 'handoff', endedNote: null });

function business(overrides = {}) {
  return {
    objective: 'Show where the saved work stopped.',
    scope: [
      { statement: 'Read the saved checkpoints' },
      { statement: 'Show the saved stop point' },
      { statement: 'Show the next step' },
    ],
    exclusions: [],
    acceptanceCriteria: [],
    selection: { kind: 'user_selected', sourceRefs: ['User asked to continue the saved resume work'] },
    upper: { productGoal: null, stage: null, openUserPaths: [] },
    resume: null,
    ...overrides,
  };
}

function claimContent(claim) {
  // The §7.4 content projection of an intentClaim: the four content fields plus
  // identity, never status/decision/assessment.
  return {
    collection: 'intentClaim',
    id: claim.id,
    nodeId: typeof claim.nodeId === 'string' ? claim.nodeId : null,
    statement: typeof claim.statement === 'string' ? claim.statement : null,
    scope: [...(claim.scope ?? [])],
    conditions: [...(claim.conditions ?? [])],
    exceptions: [...(claim.exceptions ?? [])],
  };
}

function nodeLayer(state, id, origin) {
  const projection = layerContentProjection(state, { collection: 'node', id });
  const confirmation = layerConfirmationProjection(state, { collection: 'node', id }, options);
  return {
    state: 'found',
    ref: { collection: 'node', id },
    observed: {
      digest: digest(projection.content),
      label: projection.label,
      kind: projection.kind ?? 'node',
      origin,
      confirmation: confirmation.confirmation,
      snapshotPath: null,
    },
  };
}

function claimLayer(state, claimId, origin) {
  const projection = layerContentProjection(state, { collection: 'intentClaim', id: claimId });
  const confirmation = layerConfirmationProjection(state, { collection: 'intentClaim', id: claimId }, options);
  return {
    state: 'found',
    ref: { collection: 'intentClaim', id: claimId },
    observed: {
      digest: digest(projection.content),
      label: projection.label,
      kind: 'intentClaim',
      origin,
      confirmation: confirmation.confirmation,
      snapshotPath: null,
    },
  };
}

function stageLayer(state, nodeId, checkpointId, origin) {
  const reading = layerStageReading(state, nodeId, checkpointId, options);
  return {
    state: 'found',
    ref: { collection: 'checkpoint', id: checkpointId },
    observed: {
      digest: digest(reading.projection),
      label: reading.label,
      kind: 'agent_organized',
      origin,
      confirmation: { status: 'not_applicable', decisionId: null, assessmentDigest: null },
      snapshotPath: null,
    },
  };
}

// §7.2: an adopted claim stores its content digest and, separately, the
// confirmation fact at adoption (`{status, decisionId, assessmentDigest}`).
function adoptedEntry(state, claimId, snapshotPath = null) {
  return {
    claimId,
    contentDigest: digest(claimContent(state.intentClaims.find((item) => item.id === claimId))),
    snapshotPath,
    confirmation: layerConfirmationProjection(state, { collection: 'intentClaim', id: claimId }, options).confirmation,
  };
}

function makeWorkRecord({
  id,
  workId,
  workTitle,
  operation,
  lifecycle,
  fields,
  nodeId = FEATURE,
  createdAt,
  adoptedBasis = null,
}) {
  // §6.7: a work record is schema-complete but its overall fields are inert.
  const record = {
    id,
    nodeId,
    createdAt,
    source: 'agent_organized',
    sourceRefs: ['synthetic work record; not a product approval'],
    summary: `本轮工作记录（非整体进展）：${workTitle}`,
    workDone: [],
    stopPoint: null,
    remaining: [],
    nextActions: [],
    nextActionsStatus: 'not_prepared',
    workContext: {
      version: 1,
      workId,
      workTitle,
      operation,
      nodeId,
      ...fields,
      lifecycle,
    },
  };
  if (adoptedBasis !== null) record.adoptedBasis = adoptedBasis;
  return record;
}

function makeOrdinaryRecord({ id, createdAt, nodeId = FEATURE }) {
  return {
    id,
    nodeId,
    createdAt,
    source: 'agent_organized',
    sourceRefs: ['synthetic ordinary checkpoint'],
    summary: 'Synthetic ordinary checkpoint appended after work records.',
    workDone: [],
    stopPoint: null,
    remaining: [],
    nextActions: [],
    nextActionsStatus: 'not_prepared',
  };
}

// Wires the parts a real writer would produce: supersedes = the Feature chain
// tail, exact basis, one local_feature_checkpoint receipt, one version bump.
function appendRecord(state, record) {
  const nodeRecords = state.featureCheckpoints.filter((item) => item.nodeId === record.nodeId);
  const tail = nodeRecords.length > 0 ? nodeRecords[nodeRecords.length - 1] : null;
  const observedStateVersion = state.stateVersion;
  const resultingStateVersion = state.stateVersion + 1;
  const observedDigest = sha256Bytes(`synthetic observed state ${observedStateVersion}`);
  const full = {
    ...record,
    supersedes: tail ? tail.id : null,
    basis: {
      observedStateVersion,
      observedDigest,
      contextFingerprint: digest(featureContextFingerprintContent(state, record.nodeId)),
      contextFingerprintVersion: 1,
      contextIds: featureContextRecordIds(state, record.nodeId),
      refs: [{ collection: 'intentClaim', id: CLAIM }],
      sourceSnapshots: [],
    },
  };
  state.featureCheckpoints.push(full);
  state.mapUpdates.push({
    id: `map-update:${record.id.slice('checkpoint:'.length)}`,
    operationId: `current-work-${record.id.slice('checkpoint:'.length)}`,
    projectId: state.project.id,
    source: 'local_feature_checkpoint',
    createdAt: record.createdAt,
    authorizationRef: 'Synthetic current-work record for contract tests; not an approval.',
    summary: 'Synthetic current-work record for contract tests.',
    observedStateVersion,
    observedDigest,
    resultingStateVersion,
    payloadDigest: sha256Bytes(`synthetic payload ${record.id}`),
    changedNodeIds: [],
    addedFeatureCheckpointIds: [record.id],
    addedEdgeIds: [],
    addedEvidenceIds: [],
    addedCheckIds: [],
  });
  state.stateVersion = resultingStateVersion;
  return full;
}

function appendWork(state, spec) {
  return appendRecord(state, makeWorkRecord(spec));
}

// §7.2 addendum: the support digests a writer would persist with a work record,
// computed from the exact pre-write state so a later edit is detectable.
const compareIds = (left, right) => (`${left.collection}\u0000${left.id}` < `${right.collection}\u0000${right.id}` ? -1 : 1);

function supportSnapshots(state) {
  return featureWorkSupportProjections(state, FEATURE).projections
    .map((item) => ({ collection: item.collection, id: item.id, digest: digest(item.content) }))
    .sort(compareIds);
}

// Appends a work record that carries the persisted support digests, exactly as
// a builder would (computed before the record is added).
function appendWorkWithSupport(state, spec) {
  const snapshots = supportSnapshots(state);
  const record = appendWork(state, spec);
  record.workSupportSnapshots = snapshots;
  return record;
}

// Case A: one work opened with three scope items, then paused.
function caseAState() {
  const state = clone(valid);
  const open = appendWork(state, {
    id: 'checkpoint:work-a-open',
    workId: 'work:resume-a',
    workTitle: 'Resume work A',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const pause = appendWork(state, {
    id: 'checkpoint:work-a-pause',
    workId: 'work:resume-a',
    workTitle: 'Resume work A',
    operation: 'pause',
    lifecycle: PAUSED,
    fields: business(),
    createdAt: '2026-02-02T00:00:00.000Z',
  });
  return { state, open, pause };
}

// §6.7: two works interleaved on one Feature chain (A open/adjust/pause, B
// open/pause). Every record is a real chain record; none of them is an overall
// progress statement.
function interleavedState() {
  const state = clone(valid);
  const workAOpen = appendWork(state, {
    id: 'checkpoint:work-a-open',
    workId: 'work:resume-a',
    workTitle: 'Resume work A',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const workBOpen = appendWork(state, {
    id: 'checkpoint:work-b-open',
    workId: 'work:resume-b',
    workTitle: 'Resume work B',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-02T00:00:00.000Z',
  });
  const narrowed = business({
    objective: null,
    scope: [],
    exclusions: [],
    acceptanceCriteria: [],
    selection: { kind: 'user_selected', sourceRefs: [] },
    upper: { productGoal: null, stage: null, openUserPaths: [] },
    resume: null,
  });
  const workAAdjust = appendWork(state, {
    id: 'checkpoint:work-a-adjust',
    workId: 'work:resume-a',
    workTitle: 'Resume work A',
    operation: 'adjust',
    lifecycle: ACTIVE,
    fields: narrowed,
    createdAt: '2026-02-03T00:00:00.000Z',
  });
  const workBPause = appendWork(state, {
    id: 'checkpoint:work-b-pause',
    workId: 'work:resume-b',
    workTitle: 'Resume work B',
    operation: 'pause',
    lifecycle: PAUSED,
    fields: business(),
    createdAt: '2026-02-04T00:00:00.000Z',
  });
  const workAPause = appendWork(state, {
    id: 'checkpoint:work-a-pause',
    workId: 'work:resume-a',
    workTitle: 'Resume work A',
    operation: 'pause',
    lifecycle: PAUSED,
    fields: narrowed,
    createdAt: '2026-02-05T00:00:00.000Z',
  });
  return { state, workAOpen, workBOpen, workAAdjust, workBPause, workAPause };
}

test('old states stay readable: no work key means no work, and 0.1 is unsupported', () => {
  // A 0.2 state written before this contract carries no workContext anywhere.
  assert.deepEqual(validateFullState(valid), []);
  const index = deriveCurrentWorkIndex(valid, options);
  assert.equal(index.supported, true);
  assert.equal(index.collectionPresent, true);
  assert.deepEqual(index.entries, []);
  assert.equal(index.truncated, false);
  assert.equal(index.omitted, 0);
  assert.equal(index.limits.historyDefault, WORK_LIMITS.maxWorkHistoryDefault);
  assert.ok(index.notes.some((note) => note.includes('不是进度报告')));

  const missing = currentWork(valid, 'work:absent', options);
  assert.equal(missing.supported, true);
  assert.equal(missing.found, false);
  assert.equal(missing.revisionCount, 0);
  assert.equal(missing.contextStatus, 'no_checkpoint');
  assert.ok(missing.notes.includes('本轮工作未记录'));

  // Schema 0.1 never receives work records and must stay unsupported.
  assert.deepEqual(validateStateSchema(sharedDecision01), []);
  const unsupportedIndex = deriveCurrentWorkIndex(sharedDecision01);
  assert.equal(unsupportedIndex.supported, false);
  assert.equal(unsupportedIndex.collectionPresent, false);
  assert.deepEqual(unsupportedIndex.entries, []);
  assert.equal(currentWork(sharedDecision01, 'work:absent').supported, false);
  assert.equal(deriveWorkChanges(sharedDecision01, 'work:absent').supported, false);
});

test('validateWorkContext enforces the complete-snapshot shape, limits and origin credentials', () => {
  const state = clone(valid);
  const context = makeWorkRecord({
    id: 'checkpoint:work-shape',
    workId: 'work:resume-shape',
    workTitle: 'Resume work shape',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-01T00:00:00.000Z',
  }).workContext;
  assert.deepEqual(validateWorkContext(context), []);

  assert.ok(validateWorkContext({ ...context, version: 2 }).some((error) => error.includes('version: expected 1')));
  const missingScope = clone(context);
  delete missingScope.scope;
  assert.ok(validateWorkContext(missingScope).some((error) => error.includes('missing field "scope"')));
  assert.ok(validateWorkContext({ ...context, extra: true }).some((error) => error.includes('unexpected field "extra"')));
  assert.ok(validateWorkContext({ ...context, workId: 'work:' }).some((error) => error.includes('workId')));
  assert.ok(validateWorkContext({ ...context, scope: [{ statement: 'x'.repeat(WORK_LIMITS.maxWorkScopeText + 1) }] })
    .some((error) => error.includes('scope[0].statement')));

  // lifecycle: a reason only when ended, a reason required when ended.
  assert.ok(validateWorkContext({ ...context, lifecycle: { status: 'active', endedReason: 'handoff', endedNote: null } })
    .some((error) => error.includes('must be null unless the work is ended')));
  assert.ok(validateWorkContext({ ...context, lifecycle: { status: 'ended', endedReason: null, endedNote: null } })
    .some((error) => error.includes('requires one of')));

  // resume: "none" cannot be combined with a second authorization.
  assert.ok(validateWorkContext({
    ...context,
    resume: { stopPoint: 'Stopped at the panel', nextStep: null, responsibility: 'agent', authorizationRequired: ['none', 'source_write'] },
  }).some((error) => error.includes('cannot be combined')));

  // A found layer without its observed digest is invalid (§7.3).
  const noDigest = clone(context);
  noDigest.upper.productGoal = {
    state: 'found',
    ref: { collection: 'node', id: GOAL },
    observed: {
      label: 'Resume saved work',
      kind: 'product_goal',
      origin: { kind: 'edge', edgeId: 'edge:goal-capability', edgeKind: 'contains' },
      confirmation: { status: 'candidate', decisionId: null, assessmentDigest: null },
      snapshotPath: null,
    },
  };
  assert.ok(validateWorkContext(noDigest).some((error) => error.includes('observed: missing field "digest"')));

  // A userSelection origin needs a human selection credential on the record.
  assert.ok(validateWorkContext({
    ...context,
    selection: { kind: 'agent_proposed_unselected', sourceRefs: ['agent: suggestion only'] },
    upper: {
      productGoal: nodeLayer(state, GOAL, { kind: 'userSelection', sourceRefIndex: 0, authorizationRef: 'ui:explicit-save' }),
      stage: null,
      openUserPaths: [],
    },
  }).some((error) => error.includes('userSelection requires selection.kind')));
});

test('the 0.2 schema accepts a work record and rejects a missing or unknown work key', () => {
  const { state } = caseAState();
  assert.deepEqual(validateStateSchema(state), []);
  assert.deepEqual(validateFullState(state), []);

  const missing = clone(state);
  delete missing.featureCheckpoints.at(-1).workContext.resume;
  const missingErrors = validateStateSchema(missing);
  assert.ok(missingErrors.some((error) => error.includes("'resume'")), JSON.stringify(missingErrors));

  const unknown = clone(state);
  unknown.featureCheckpoints.at(-1).workContext.extra = true;
  const unknownErrors = validateStateSchema(unknown);
  assert.ok(unknownErrors.some((error) => error.includes('additional properties') || error.includes('unexpected field')));

  // adoptedBasis is a sibling of workContext: it cannot appear alone.
  const orphanAdopted = clone(state);
  const orphaned = orphanAdopted.featureCheckpoints.at(-1);
  orphaned.adoptedBasis = [adoptedEntry(state, CLAIM)];
  delete orphaned.workContext;
  assert.ok(validateFeatureProgress(orphanAdopted).some((error) => error.includes('adopted basis belongs to a current-work record')));
});

test('case A: pausing keeps the three scope items verbatim and only moves the lifecycle', () => {
  const { state, open, pause } = caseAState();
  assert.deepEqual(validateFullState(state), []);

  const view = currentWork(state, 'work:resume-a', options);
  assert.equal(view.found, true);
  assert.equal(view.nodeId, FEATURE);
  assert.equal(view.operation, 'pause');
  assert.equal(view.revisionCount, 2);
  assert.equal(view.currentRecordId, pause.id);
  assert.equal(view.previousRecordId, open.id);
  assert.equal(view.lifecycle.status, 'paused');
  assert.equal(view.contextStatus, 'unchanged');
  assert.deepEqual(view.content.scope, business().scope);
  assert.equal(view.content.scope.length, 3);

  // §6.7 inert overall fields: the record claims no overall progress.
  assert.equal(pause.summary.startsWith('本轮工作记录（非整体进展）：'), true);
  assert.deepEqual(pause.workDone, []);
  assert.equal(pause.stopPoint, null);
  assert.deepEqual(pause.remaining, []);
  assert.deepEqual(pause.nextActions, []);
  assert.equal(pause.nextActionsStatus, 'not_prepared');
  assert.equal(Object.hasOwn(pause, 'delivery'), false);

  // §6.3 an ordinary checkpoint leaves every per-work view exactly as it was.
  const ordinary = appendRecord(state, makeOrdinaryRecord({ id: 'checkpoint:ordinary-after-work', createdAt: '2026-02-03T00:00:00.000Z' }));
  assert.deepEqual(validateFullState(state), []);
  const afterOrdinary = currentWork(state, 'work:resume-a', options);
  assert.equal(afterOrdinary.currentRecordId, pause.id);
  assert.equal(afterOrdinary.revisionCount, 2);
  assert.equal(afterOrdinary.contextStatus, 'unchanged');
  assert.deepEqual(afterOrdinary.content.scope, business().scope);
  assert.equal(ordinary.workContext, undefined);

  // A pause that silently changes the snapshot is a state-integrity error.
  const mismatched = clone(state);
  mismatched.featureCheckpoints.find((record) => record.id === pause.id).workContext.scope[1].statement = 'Scope silently dropped';
  assert.ok(validateFeatureProgress(mismatched).some((error) => error.includes('business_snapshot_mismatch')));
});

test('case B: an adjust replaces the whole snapshot and never falls back to the earlier revision', () => {
  const state = clone(valid);
  const open = appendWork(state, {
    id: 'checkpoint:work-b-open',
    workId: 'work:resume-b',
    workTitle: 'Resume work B',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const adjust = appendWork(state, {
    id: 'checkpoint:work-b-adjust',
    workId: 'work:resume-b',
    workTitle: 'Resume work B',
    operation: 'adjust',
    lifecycle: ACTIVE,
    fields: business({
      objective: null,
      scope: [],
      exclusions: [],
      acceptanceCriteria: [],
      selection: { kind: 'user_selected', sourceRefs: [] },
      upper: { productGoal: null, stage: null, openUserPaths: [] },
      resume: null,
    }),
    createdAt: '2026-02-02T00:00:00.000Z',
  });
  assert.deepEqual(validateFullState(state), []);

  const view = currentWork(state, 'work:resume-b', options);
  assert.equal(view.revisionCount, 2);
  assert.equal(view.operation, 'adjust');
  assert.deepEqual(view.content.scope, []);
  assert.equal(view.content.objective, null);
  assert.equal(view.content.resume, null);
  // The previous three items are readable in that work's history, not inherited.
  assert.equal(view.previousRecordId, open.id);
  assert.equal(view.previousRecord.workContext.scope.length, 3);
  assert.equal(view.previousRecord.workContext.objective, business().objective);
  assert.equal(view.currentRecord.workContext.scope.length, 0);

  const lifecycleMoved = clone(state);
  lifecycleMoved.featureCheckpoints.find((record) => record.id === adjust.id).workContext.lifecycle = PAUSED;
  assert.ok(validateFeatureProgress(lifecycleMoved).some((error) => error.includes('adjust keeps the predecessor')));
});

test('work rebinding and operation/lifecycle mismatches are state-integrity errors', () => {
  const { state, open, pause } = caseAState();

  const rebound = clone(state);
  const reboundPause = rebound.featureCheckpoints.find((record) => record.id === pause.id);
  reboundPause.nodeId = SECOND;
  reboundPause.workContext.nodeId = SECOND;
  assert.ok(validateFeatureProgress(rebound).some((error) => error.includes('work_rebound_capability')));

  const reopened = clone(state);
  reopened.featureCheckpoints.find((record) => record.id === open.id).workContext.operation = 'adjust';
  assert.ok(validateFeatureProgress(reopened).some((error) => error.includes('must be "open"')));

  const wrongStatus = clone(state);
  wrongStatus.featureCheckpoints.find((record) => record.id === pause.id).workContext.lifecycle = ACTIVE;
  assert.ok(validateFeatureProgress(wrongStatus).some((error) => error.includes('requires lifecycle status "paused"')));

  const resumed = caseAState().state;
  const resume = appendWork(resumed, {
    id: 'checkpoint:work-a-resume',
    workId: 'work:resume-a',
    workTitle: 'Resume work A',
    operation: 'resume',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-03T00:00:00.000Z',
  });
  assert.deepEqual(validateFullState(resumed), []);
  assert.equal(currentWork(resumed, 'work:resume-a', options).revisionCount, 3);
  const secondOpen = clone(resumed);
  secondOpen.featureCheckpoints.find((record) => record.id === resume.id).workContext.operation = 'open';
  assert.ok(validateFeatureProgress(secondOpen).some((error) => error.includes('is already open')));
});

test('upper layers: a recorded gap is not a change, a linked goal reports content and confirmation separately', () => {
  const state = clone(valid);
  const gapWork = appendWork(state, {
    id: 'checkpoint:work-gap',
    workId: 'work:gap',
    workTitle: 'Gap work',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business({ upper: { productGoal: { state: 'gap', reason: 'kind_only' }, stage: null, openUserPaths: [] } }),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const linkedWork = appendWork(state, {
    id: 'checkpoint:work-linked',
    workId: 'work:linked',
    workTitle: 'Linked work',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business({
      upper: {
        productGoal: nodeLayer(state, GOAL, { kind: 'edge', edgeId: 'edge:goal-capability', edgeKind: 'contains' }),
        stage: null,
        openUserPaths: [],
      },
    }),
    createdAt: '2026-02-02T00:00:00.000Z',
  });
  assert.deepEqual(validateFullState(state), []);

  const gapView = deriveWorkChanges(state, gapWork.workContext.workId, options);
  assert.equal(gapView.upper.productGoal.state, 'gap');
  assert.equal(gapView.upper.productGoal.reason, 'kind_only');
  assert.deepEqual(gapView.changes, []);

  const linkedView = deriveWorkChanges(state, linkedWork.workContext.workId, options);
  assert.equal(linkedView.upper.productGoal.state, 'found');
  assert.deepEqual(linkedView.upper.productGoal.origin, { kind: 'edge', edgeId: 'edge:goal-capability', edgeKind: 'contains' });
  assert.equal(linkedView.upper.productGoal.observed.snapshotAvailable, false);
  assert.equal(linkedView.upper.productGoal.current.confirmation.status, 'candidate');
  assert.equal(linkedView.contextStatus, 'unchanged');
  assert.deepEqual(linkedView.changes, []);

  // A content-only edit is exactly one content item naming the moved key.
  const savedContent = layerContentProjection(state, { collection: 'node', id: GOAL }).content;
  const savedConfirmation = layerConfirmationProjection(state, { collection: 'node', id: GOAL }, options).confirmation;
  state.nodes.find((node) => node.id === GOAL).description = 'Changed description after the record was saved.';
  const contentView = deriveWorkChanges(state, linkedWork.workContext.workId, {
    ...options,
    layerSnapshots: { [`node:${GOAL}`]: { content: savedContent, confirmation: savedConfirmation } },
  });
  assert.equal(contentView.contextStatus, 'changed');
  assert.equal(contentView.changes.length, 1);
  assert.equal(contentView.changes[0].class, 'requirement_content_changed');
  assert.equal(contentView.changes[0].layer, 'productGoal');
  assert.equal(contentView.changes[0].collection, 'node');
  assert.deepEqual(contentView.changes[0].fields, ['description']);
  assert.equal(contentView.changes[0].hasBothContents, true);
  assert.deepEqual(contentView.changes.filter((item) => item.class === 'confirmation_changed'), []);
  // The gap work is untouched by another work's observation change.
  assert.deepEqual(deriveWorkChanges(state, gapWork.workContext.workId, options).changes, []);

  // A confirmation-only transition is one confirmation item, zero content items.
  const confirmState = clone(valid);
  const confirmWork = appendWork(confirmState, {
    id: 'checkpoint:work-confirm',
    workId: 'work:confirm',
    workTitle: 'Confirm work',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business({
      upper: {
        productGoal: nodeLayer(confirmState, GOAL, { kind: 'edge', edgeId: 'edge:goal-capability', edgeKind: 'contains' }),
        stage: null,
        openUserPaths: [],
      },
    }),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  confirmState.nodes.find((node) => node.id === GOAL).status = 'confirmed';
  const confirmationView = deriveWorkChanges(confirmState, confirmWork.workContext.workId, options);
  assert.deepEqual(confirmationView.changes.filter((item) => item.class === 'requirement_content_changed'), []);
  assert.equal(confirmationView.changes.length, 1);
  assert.equal(confirmationView.changes[0].class, 'confirmation_changed');
  assert.equal(confirmationView.changes[0].layer, 'productGoal');
  assert.deepEqual(confirmationView.changes[0].fields, ['status']);
});

test('an adopted claim compares content and confirmation on separate axes; a missing claim is unavailable', () => {
  const state = clone(valid);
  const claim = state.intentClaims.find((item) => item.id === CLAIM);
  const savedClaimContent = claimContent(claim);
  const savedClaimConfirmation = layerConfirmationProjection(state, { collection: 'intentClaim', id: CLAIM }, options).confirmation;
  const adopted = [adoptedEntry(state, CLAIM)];
  const work = appendWork(state, {
    id: 'checkpoint:work-adopted',
    workId: 'work:adopted',
    workTitle: 'Adopted work',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business({
      selection: { kind: 'user_selected', sourceRefs: ['User adopted the resume claim as this round basis'] },
      upper: {
        productGoal: claimLayer(state, CLAIM, { kind: 'adoptedBasis', claimId: CLAIM, basisRefIndex: 0 }),
        stage: null,
        openUserPaths: [],
      },
    }),
    adoptedBasis: adopted,
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  assert.deepEqual(validateFullState(state), []);

  const workId = work.workContext.workId;
  const baseView = deriveWorkChanges(state, workId, options);
  assert.equal(baseView.contentComparable, true);
  assert.equal(baseView.adopted.length, 1);
  assert.equal(baseView.adopted[0].claimId, CLAIM);
  assert.equal(baseView.adopted[0].state, 'available');
  assert.equal(baseView.adopted[0].matches, true);
  assert.equal(baseView.adopted[0].confirmation.status, 'candidate');
  assert.equal(typeof baseView.adopted[0].confirmation.assessmentDigest, 'string');
  assert.deepEqual(baseView.adopted[0].confirmationFields, []);
  assert.deepEqual(baseView.changes, []);

  // A statement edit is a content change on both closure entries (upper layer
  // and adopted basis), and never a confirmation change.
  const statementState = clone(state);
  statementState.intentClaims.find((item) => item.id === CLAIM).statement = 'Users can see where a saved feature stopped, including excluded paths.';
  const statementView = deriveWorkChanges(statementState, workId, {
    ...options,
    layerSnapshots: { [`intentClaim:${CLAIM}`]: { content: savedClaimContent, confirmation: savedClaimConfirmation } },
  });
  const contentItems = statementView.changes.filter((item) => item.class === 'requirement_content_changed');
  assert.equal(contentItems.length, 2);
  assert.deepEqual(contentItems.map((item) => item.layer).sort(), ['adopted', 'productGoal']);
  for (const item of contentItems) {
    assert.deepEqual(item.fields, ['statement']);
    assert.equal(item.hasBothContents, true);
  }
  assert.deepEqual(statementView.changes.filter((item) => item.class === 'confirmation_changed'), []);

  // A confirmation transition is reported on both entries that observed the
  // claim (upper layer and adopted basis), each as one confirmation item and
  // zero content items; the record-backed adopted fact makes this
  // reconstructible.
  const confirmedState = clone(state);
  const confirmedClaim = confirmedState.intentClaims.find((item) => item.id === CLAIM);
  confirmedClaim.status = 'confirmed';
  confirmedClaim.governingDecisionId = 'decision:resume-approved';
  const confirmationView = deriveWorkChanges(confirmedState, workId, options);
  assert.deepEqual(confirmationView.changes.filter((item) => item.class === 'requirement_content_changed'), []);
  assert.equal(confirmationView.changes.length, 2);
  for (const item of confirmationView.changes) {
    assert.equal(item.class, 'confirmation_changed');
    assert.deepEqual(item.fields, ['status', 'governingDecisionId']);
  }
  assert.deepEqual(confirmationView.changes.map((item) => item.layer).sort(), ['adopted', 'productGoal']);

  // An assessment-only edit is also exactly one confirmation class per entry:
  // the four assessment keys are compared as one digest, never as content.
  const assessedState = clone(state);
  assessedState.intentClaims.find((item) => item.id === CLAIM).assessment.disposition = 'accepted';
  const assessmentView = deriveWorkChanges(assessedState, workId, {
    ...options,
    layerSnapshots: { [`intentClaim:${CLAIM}`]: { content: savedClaimContent, confirmation: savedClaimConfirmation } },
  });
  assert.deepEqual(assessmentView.changes.filter((item) => item.class === 'requirement_content_changed'), []);
  assert.equal(assessmentView.changes.length, 2);
  for (const item of assessmentView.changes) {
    assert.equal(item.class, 'confirmation_changed');
    assert.deepEqual(item.fields, ['assessment']);
  }
  assert.notEqual(
    assessmentView.adopted[0].confirmation.assessmentDigest,
    layerConfirmationProjection(assessedState, { collection: 'intentClaim', id: CLAIM }, options).confirmation.assessmentDigest,
  );

  // A claim that no longer resolves is unavailable, never a fabricated diff.
  const removedState = clone(state);
  removedState.intentClaims = removedState.intentClaims.filter((item) => item.id !== CLAIM);
  const removedView = deriveWorkChanges(removedState, workId, options);
  const unavailable = removedView.changes.filter((item) => item.class === 'requirement_unavailable');
  assert.ok(unavailable.length >= 1);
  assert.ok(unavailable.some((item) => item.layer === 'adopted' && item.id === CLAIM && item.hasBothContents === false));
  assert.equal(removedView.adopted[0].state, 'unavailable');
});

test('the confirmation fact carries an assessment digest for claims only and work records require it', () => {
  const claimChip = layerConfirmationProjection(valid, { collection: 'intentClaim', id: CLAIM }, options).confirmation;
  assert.deepEqual(claimChip, {
    status: 'candidate',
    decisionId: null,
    assessmentDigest: digest({ disposition: 'unreviewed', contentDigest: null, reviewId: null }),
  });
  // Without an injected digest the fact is unreadable, not invented.
  assert.equal(layerConfirmationProjection(valid, { collection: 'intentClaim', id: CLAIM }).confirmation.assessmentDigest, null);
  assert.equal(layerConfirmationProjection(valid, { collection: 'node', id: GOAL }, options).confirmation.assessmentDigest, null);
  assert.equal(layerStageReading(valid, FEATURE, STAGE_CHECKPOINT, options).excerpt.confirmation, null);

  const state = clone(valid);
  const work = appendWork(state, {
    id: 'checkpoint:work-confirmation-fact',
    workId: 'work:confirmation-fact',
    workTitle: 'Confirmation fact',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business({
      selection: { kind: 'user_selected', sourceRefs: ['User adopted the resume claim as this round basis'] },
      upper: {
        productGoal: claimLayer(state, CLAIM, { kind: 'adoptedBasis', claimId: CLAIM, basisRefIndex: 0 }),
        stage: stageLayer(state, FEATURE, STAGE_CHECKPOINT, { kind: 'edge', edgeId: 'edge:goal-capability', edgeKind: 'contains' }),
        openUserPaths: [],
      },
    }),
    adoptedBasis: [adoptedEntry(state, CLAIM)],
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  assert.deepEqual(validateStateSchema(state), []);
  assert.deepEqual(validateFullState(state), []);
  const saved = state.featureCheckpoints.find((record) => record.id === work.id);
  assert.equal(typeof saved.workContext.upper.productGoal.observed.confirmation.assessmentDigest, 'string');
  assert.equal(saved.workContext.upper.stage.observed.confirmation.assessmentDigest, null);
  assert.equal(typeof saved.adoptedBasis[0].confirmation.assessmentDigest, 'string');

  // A missing digest on a claim layer is rejected by both the schema and the
  // model validator.
  const missing = clone(state);
  delete missing.featureCheckpoints.at(-1).workContext.upper.productGoal.observed.confirmation.assessmentDigest;
  assert.ok(validateStateSchema(missing).length > 0);
  assert.ok(validateFeatureProgress(missing).some((error) => error.includes('assessmentDigest')));

  // A non-null digest outside a claim is rejected on both surfaces.
  const wrongAxis = clone(state);
  wrongAxis.featureCheckpoints.at(-1).workContext.upper.stage.observed.confirmation.assessmentDigest = digest(claimContent(valid.intentClaims[0]));
  assert.ok(validateStateSchema(wrongAxis).length > 0);
  assert.ok(validateFeatureProgress(wrongAxis).some((error) => error.includes('assessmentDigest')));

  // adoptedBasis stores the confirmation fact and always a digest.
  const missingAdoptedConfirmation = clone(state);
  delete missingAdoptedConfirmation.featureCheckpoints.at(-1).adoptedBasis[0].confirmation;
  assert.ok(validateStateSchema(missingAdoptedConfirmation).length > 0);
  assert.ok(validateFeatureProgress(missingAdoptedConfirmation).some((error) => error.includes('adoptedBasis[0].confirmation')));
  const nullAdoptedDigest = clone(state);
  nullAdoptedDigest.featureCheckpoints.at(-1).adoptedBasis[0].confirmation.assessmentDigest = null;
  assert.ok(validateStateSchema(nullAdoptedDigest).length > 0);
  assert.ok(validateFeatureProgress(nullAdoptedDigest).some((error) => error.includes('assessmentDigest')));
});

test('implementation_or_verification_changed is a hint over the frozen support ids only', () => {
  const businessFields = business();
  // Support that entered the closure after the record was saved: one hint, no
  // saved side to diff, and the existing context status still reports changed.
  const added = clone(valid);
  const implementationEdge = added.edges.find((edge) => edge.id === 'edge:capability-impl');
  added.edges = added.edges.filter((edge) => edge.id !== 'edge:capability-impl');
  const addedWork = appendWork(added, {
    id: 'checkpoint:work-support-added',
    workId: 'work:support-added',
    workTitle: 'Support added',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: businessFields,
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  added.edges.push(implementationEdge);
  assert.deepEqual(validateFullState(added), []);
  const addedView = deriveWorkChanges(added, addedWork.workContext.workId, options);
  const addedItems = addedView.changes.filter((item) => item.class === 'implementation_or_verification_changed');
  // A record without `workSupportSnapshots` is explicitly uncomparable, so a
  // support entry added later is not guessed into a hint.
  assert.deepEqual(addedItems, []);
  assert.equal(addedView.supportDigestSource, 'missing');
  assert.ok(addedView.supportDigestMissing.includes('node:impl:checkpoint-cli'));
  // The Feature-context comparison is unchanged by this class: it still says
  // the saved closure ids moved.
  assert.equal(addedView.contextStatus, 'changed');
  assert.deepEqual(addedView.changes.filter((item) => item.class === 'requirement_content_changed'), []);

  // A content move of a still-saved support id is one hint naming the field,
  // once the caller supplies that id's saved projection (legacy record: no
  // persisted digests, so the hint comes from the supplied content).
  const movedState = clone(valid);
  const movedWork = appendWork(movedState, {
    id: 'checkpoint:work-support-moved',
    workId: 'work:support-moved',
    workTitle: 'Support moved',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: businessFields,
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const savedSupport = layerContentProjection(movedState, { collection: 'node', id: 'impl:checkpoint-cli' }).content;
  movedState.nodes.find((node) => node.id === 'impl:checkpoint-cli').description = 'Implementation content moved after the record was saved.';
  const movedView = deriveWorkChanges(movedState, movedWork.workContext.workId, {
    ...options,
    layerSnapshots: {
      'node:impl:checkpoint-cli': { content: savedSupport, confirmation: null },
      'node:verification:checkpoint-tests': {
        content: layerContentProjection(valid, { collection: 'node', id: 'verification:checkpoint-tests' }).content,
        confirmation: null,
      },
    },
  });
  const movedItems = movedView.changes.filter((item) => item.class === 'implementation_or_verification_changed');
  // The legacy record has no empty `workSupportSnapshots` array, so the
  // supplied projection cannot be upgraded to a verdict this record did not save.
  assert.deepEqual(movedItems, []);
  assert.match(movedView.supportDigestMissing.join(','), /impl:checkpoint-cli/);

  // Evidence that left the closure (record kept, link removed) is a hint.
  const evidenceState = clone(valid);
  evidenceState.nodes.find((node) => node.id === 'verification:checkpoint-tests').evidenceIds = ['evidence:checkpoint-tests'];
  const evidenceWork = appendWork(evidenceState, {
    id: 'checkpoint:work-support-evidence',
    workId: 'work:support-evidence',
    workTitle: 'Support evidence',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: businessFields,
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  evidenceState.nodes.find((node) => node.id === 'verification:checkpoint-tests').evidenceIds = [];
  assert.deepEqual(validateFullState(evidenceState), []);
  const evidenceView = deriveWorkChanges(evidenceState, evidenceWork.workContext.workId, options);
  const evidenceItems = evidenceView.changes
    .filter((item) => item.class === 'implementation_or_verification_changed' && item.collection === 'evidence');
  assert.equal(evidenceItems.length, 1);
  assert.equal(evidenceItems[0].id, 'evidence:checkpoint-tests');

  // An unrelated Feature's node edit never raises this class.
  const unrelated = clone(valid);
  const unrelatedWork = appendWork(unrelated, {
    id: 'checkpoint:work-support-unrelated',
    workId: 'work:support-unrelated',
    workTitle: 'Support unrelated',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: businessFields,
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  unrelated.nodes.find((node) => node.id === SECOND).description = 'Unrelated feature edit.';
  assert.deepEqual(deriveWorkChanges(unrelated, unrelatedWork.workContext.workId, options).changes, []);
});

/**
 * The §8.2 phrase is "content changed vs the saved ids", not "membership
 * changed". A record written by today's builder persists `basis.contextIds` and
 * one `basis.contextFingerprint`; it carries no per-id support digest and no
 * support snapshot, and neither the MCP read nor the UI supplies one. This test
 * pins that gap instead of letting the class quietly mean membership only.
 */
test('a normal saved record cannot reconstruct a same-id support content move, and says so', () => {
  const state = clone(valid);
  const work = appendWork(state, {
    id: 'checkpoint:work-support-same-id',
    workId: 'work:support-same-id',
    workTitle: 'Support same id',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const workId = work.workContext.workId;
  const savedRecord = state.featureCheckpoints.at(-1);
  const savedSupport = layerContentProjection(state, { collection: 'node', id: 'impl:checkpoint-cli' }).content;

  // What the record persists about support: ids plus one closure-wide digest.
  // `contextIds` is a list of plain string ids, so there is no per-id content
  // fact anywhere in the record, and `sourceSnapshots` stays empty.
  assert.deepEqual(savedRecord.basis.sourceSnapshots, []);
  assert.ok(savedRecord.basis.contextIds.nodeIds.every((id) => typeof id === 'string'));
  assert.ok(savedRecord.basis.contextIds.nodeIds.includes('impl:checkpoint-cli'));

  // Edit the implementation node's content without touching any id.
  const impl = state.nodes.find((node) => node.id === 'impl:checkpoint-cli');
  impl.description = 'Implementation content moved after the record was saved.';
  assert.deepEqual(validateFullState(state), []);
  assert.deepEqual(
    featureContextRecordIds(state, FEATURE).nodeIds,
    savedRecord.basis.contextIds.nodeIds,
    'the edit must not change closure membership, or this test would prove nothing',
  );

  // The closure fingerprint does move, so the gap is narrow: only the support
  // attribution is lost, not the fact that *something* in the closure moved.
  assert.notEqual(digest(featureContextFingerprintContent(state, FEATURE)), savedRecord.basis.contextFingerprint);

  // ...but the work reading has no per-id saved content, so the hint class
  // cannot name the node; it reports the uncomparable id instead of "unchanged".
  const view = deriveWorkChanges(state, workId, options);
  assert.deepEqual(view.changes.filter((item) => item.class === 'implementation_or_verification_changed'), []);
  assert.equal(view.supportContentComparable, false);
  assert.equal(view.supportDigestSource, 'missing');
  assert.equal(view.supportSnapshotEntries, 0);
  assert.ok(view.supportDigestMissing.includes('node:impl:checkpoint-cli'));
  assert.ok(view.notes.some((note) => note.includes('同 ID 内容变化无法核对')));
  // The Feature-context axis still cannot turn this into a class: ids match and
  // the fingerprint differs, which is exactly the 'content' section, not a class.
  assert.equal(view.contextStatus, 'changed');
  assert.deepEqual(view.contextDifferences, []);

  // A caller-supplied projection cannot upgrade a legacy record either: only the
  // persisted `workSupportSnapshots` makes a support verdict sayable.
  const supplied = deriveWorkChanges(state, workId, {
    ...options,
    layerSnapshots: {
      'node:impl:checkpoint-cli': { content: savedSupport, confirmation: null },
      'node:verification:checkpoint-tests': {
        content: layerContentProjection(valid, { collection: 'node', id: 'verification:checkpoint-tests' }).content,
        confirmation: null,
      },
    },
  });
  assert.deepEqual(supplied.changes.filter((item) => item.class === 'implementation_or_verification_changed'), []);
  assert.equal(supplied.supportContentComparable, false);
  assert.equal(supplied.supportDigestSource, 'missing');
});

/**
 * §7.2 addendum: a record that persists `workSupportSnapshots` is what finally
 * lets §8.2's "content changed vs the saved ids" be answered for a same id.
 */
test('workSupportSnapshots makes same-id support content detectable, and only those ids', () => {
  const state = clone(valid);
  // A check whose finding names the verification node: in scope.
  state.checks = [{
    id: 'check:resume-support',
    createdAt: '2026-01-05T00:00:00.000Z',
    base: {},
    head: {},
    taskIntent: { status: 'not_provided' },
    scope: { description: 'Resume support check.', includedPaths: [], excludedPaths: [], coverageNote: 'Synthetic.' },
    findings: [{
      id: 'finding:resume-support-1',
      status: 'consistent_with_confirmed_intent',
      summary: 'Synthetic finding naming the verification node.',
      affectedNodeIds: ['verification:checkpoint-tests'],
      evidenceIds: [],
    }],
  }];
  // A check that names nothing in this Feature: out of scope on purpose.
  const unrelatedCheck = {
    id: 'check:unrelated',
    createdAt: '2026-01-05T00:00:00.000Z',
    base: {},
    head: {},
    taskIntent: { status: 'not_provided' },
    scope: { description: 'Unrelated check.', includedPaths: [], excludedPaths: [], coverageNote: 'Synthetic.' },
    findings: [{
      id: 'finding:unrelated-1',
      status: 'insufficient_evidence',
      summary: 'Synthetic finding about another Feature.',
      affectedNodeIds: [SECOND],
      evidenceIds: [],
    }],
  };

  const projections = featureWorkSupportProjections(state, FEATURE);
  assert.deepEqual(projections.projections.map((item) => `${item.collection}:${item.id}`), [
    'check:check:resume-support',
    'node:impl:checkpoint-cli',
    'node:verification:checkpoint-tests',
  ]);
  assert.equal(projections.truncated, false);
  assert.deepEqual(projections.skipped, []);
  // Deterministic: two calls produce byte-identical output.
  assert.equal(JSON.stringify(featureWorkSupportProjections(state, FEATURE)), JSON.stringify(projections));

  const work = appendWorkWithSupport(state, {
    id: 'checkpoint:work-support-snapshots',
    workId: 'work:support-snapshots',
    workTitle: 'Support snapshots',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const workId = work.workContext.workId;
  const saved = state.featureCheckpoints.at(-1).workSupportSnapshots;
  assert.deepEqual(saved.map((entry) => `${entry.collection}:${entry.id}`), [
    'check:check:resume-support',
    'node:impl:checkpoint-cli',
    'node:verification:checkpoint-tests',
  ]);
  assert.deepEqual(validateFullState(state), []);
  assert.deepEqual(validateStateSchema(state), []);

  const base = deriveWorkChanges(state, workId, options);
  assert.deepEqual(base.changes, []);
  assert.equal(base.supportContentComparable, true);
  assert.equal(base.supportDigestSource, 'persisted');
  assert.deepEqual(base.supportDigestMissing, []);
  assert.equal(base.supportSnapshotEntries, 3);

  const withoutDigest = deriveWorkChanges(state, workId, {});
  assert.equal(withoutDigest.supportDigestSource, 'unverified');
  assert.equal(withoutDigest.supportContentComparable, false);
  assert.equal(withoutDigest.supportSnapshotEntries, 3);

  // An implementation content move is one hint: the persisted digest says it
  // moved, the record cannot name the key, so `fields` stays empty.
  const implState = clone(state);
  implState.nodes.find((node) => node.id === 'impl:checkpoint-cli').description = 'Implementation content moved.';
  implState.checks = [...state.checks, unrelatedCheck];
  const implView = deriveWorkChanges(implState, workId, options);
  const implItems = implView.changes.filter((item) => item.class === 'implementation_or_verification_changed');
  assert.equal(implItems.length, 1);
  assert.equal(implItems[0].collection, 'node');
  assert.equal(implItems[0].id, 'impl:checkpoint-cli');
  assert.deepEqual(implItems[0].fields, []);
  assert.equal(implItems[0].hasBothContents, false);
  assert.equal(implItems[0].layer, 'implementation_or_verification');
  assert.deepEqual(implView.changes.filter((item) => item.class === 'requirement_content_changed'), []);

  // Evidence content move: the same id, a different digest, one hint.
  const evidenceState = clone(state);
  evidenceState.nodes.find((node) => node.id === 'verification:checkpoint-tests').evidenceIds = ['evidence:checkpoint-tests'];
  evidenceState.featureCheckpoints.at(-1).workSupportSnapshots = [
    ...saved.filter((entry) => entry.collection !== 'evidence'),
    { collection: 'evidence', id: 'evidence:checkpoint-tests', digest: saved.find((entry) => entry.collection === 'node' && entry.id === 'impl:checkpoint-cli').digest },
  ].sort(compareIds);
  const evidenceView = deriveWorkChanges(evidenceState, workId, options);
  const evidenceItems = evidenceView.changes
    .filter((item) => item.class === 'implementation_or_verification_changed' && item.collection === 'evidence');
  assert.equal(evidenceItems.length, 1);
  assert.equal(evidenceItems[0].id, 'evidence:checkpoint-tests');
  assert.deepEqual(evidenceItems[0].fields, []);
  assert.equal(evidenceItems[0].hasBothContents, false);

  // Check finding move: the check's own projection is what is compared.
  const checkState = clone(state);
  checkState.checks[0].findings[0].status = 'potential_mismatch';
  const checkView = deriveWorkChanges(checkState, workId, options);
  const checkItems = checkView.changes.filter((item) => item.class === 'implementation_or_verification_changed');
  assert.equal(checkItems.length, 1);
  assert.equal(checkItems[0].collection, 'check');
  assert.equal(checkItems[0].id, 'check:resume-support');
  assert.deepEqual(checkItems[0].fields, []);

  // A finding that names nothing in this Feature is out of the projection
  // entirely, so editing it inside the same check raises no hint: only the
  // connected finding can move the check's digest.
  const mixedState = clone(state);
  mixedState.checks[0].findings.push({
    id: 'finding:resume-support-unrelated',
    status: 'insufficient_evidence',
    summary: 'Synthetic finding that names no support id.',
    affectedNodeIds: [SECOND],
    evidenceIds: [],
  });
  assert.deepEqual(validateFullState(mixedState), []);
  const unrelatedOnlyEdit = clone(mixedState);
  unrelatedOnlyEdit.checks[0].findings.find((finding) => finding.id === 'finding:resume-support-unrelated').summary = 'Edited after the record was saved.';
  unrelatedOnlyEdit.checks[0].findings.find((finding) => finding.id === 'finding:resume-support-unrelated').status = 'no_supported_behavior_change';
  const unrelatedOnlyView = deriveWorkChanges(unrelatedOnlyEdit, workId, options);
  assert.deepEqual(unrelatedOnlyView.changes.filter((item) => item.class === 'implementation_or_verification_changed'), []);
  // The connected finding still moves, and only through its own edit.
  const connectedEdit = clone(mixedState);
  connectedEdit.checks[0].findings.find((finding) => finding.id === 'finding:resume-support-1').status = 'potential_mismatch';
  const connectedItems = deriveWorkChanges(connectedEdit, workId, options).changes
    .filter((item) => item.class === 'implementation_or_verification_changed');
  assert.equal(connectedItems.length, 1);
  assert.equal(connectedItems[0].collection, 'check');
  assert.equal(connectedItems[0].id, 'check:resume-support');
  assert.deepEqual(connectedItems[0].fields, []);
  // The projection itself only carries the connected finding, in id order.
  const mixedProjection = featureWorkSupportProjections(mixedState, FEATURE).projections
    .find((item) => item.collection === 'check' && item.id === 'check:resume-support');
  assert.deepEqual(mixedProjection.content.findings.map((finding) => finding.id), ['finding:resume-support-1']);

  // A caller-supplied projection names the field but cannot contradict the
  // persisted digest: unchanged content stays silent even with a stale snapshot.
  const staleSnapshot = deriveWorkChanges(state, workId, {
    ...options,
    layerSnapshots: { 'node:impl:checkpoint-cli': { content: { collection: 'node', id: 'impl:checkpoint-cli', kind: 'implementation', label: 'Checkpoint CLI', description: 'stale' }, confirmation: null } },
  });
  assert.deepEqual(staleSnapshot.changes, []);

  // ...and when the digest really moved, the supplied projection supplies the
  // field name without changing the verdict.
  const named = deriveWorkChanges(implState, workId, {
    ...options,
    layerSnapshots: { 'node:impl:checkpoint-cli': { content: layerContentProjection(state, { collection: 'node', id: 'impl:checkpoint-cli' }).content, confirmation: null } },
  });
  const namedItems = named.changes.filter((item) => item.class === 'implementation_or_verification_changed');
  assert.equal(namedItems.length, 1);
  assert.deepEqual(namedItems[0].fields, ['description']);

  // Unrelated Feature edits (node or a check that names no support id) stay silent.
  const unrelatedState = clone(implState);
  unrelatedState.nodes.find((node) => node.id === SECOND).description = 'Unrelated feature edit.';
  unrelatedState.checks.push(unrelatedCheck);
  unrelatedState.checks.find((check) => check.id === 'check:unrelated').findings[0].status = 'no_supported_behavior_change';
  assert.deepEqual(
    deriveWorkChanges(unrelatedState, workId, options).changes
      .filter((item) => item.class === 'implementation_or_verification_changed' && item.id !== 'impl:checkpoint-cli'),
    [],
  );
});

test('a support id that left the closure is a hint, and one that arrived is one too', () => {
  const state = clone(valid);
  state.nodes.find((node) => node.id === 'verification:checkpoint-tests').evidenceIds = ['evidence:checkpoint-tests'];
  const work = appendWorkWithSupport(state, {
    id: 'checkpoint:work-support-membership',
    workId: 'work:support-membership',
    workTitle: 'Support membership',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const workId = work.workContext.workId;

  // Evidence unlinked (record kept): a membership hint, no field detail.
  const removed = clone(state);
  removed.nodes.find((node) => node.id === 'verification:checkpoint-tests').evidenceIds = [];
  assert.deepEqual(validateFullState(removed), []);
  const removedItems = deriveWorkChanges(removed, workId, options).changes
    .filter((item) => item.class === 'implementation_or_verification_changed' && item.collection === 'evidence');
  assert.equal(removedItems.length, 1);
  assert.equal(removedItems[0].id, 'evidence:checkpoint-tests');
  assert.deepEqual(removedItems[0].fields, []);
  assert.equal(removedItems[0].hasBothContents, false);

  // An implementation node linked after the record was saved: one addition hint.
  const added = clone(state);
  added.nodes.push({
    id: 'impl:resume-support',
    kind: 'implementation',
    label: 'Resume support',
    status: 'candidate',
    evidenceIds: [],
  });
  added.edges.push({
    id: 'edge:feature-impl-resume-support',
    kind: 'implemented_by',
    from: FEATURE,
    to: 'impl:resume-support',
    evidenceIds: [],
  });
  assert.deepEqual(validateFullState(added), []);
  const addedItems = deriveWorkChanges(added, workId, options).changes
    .filter((item) => item.class === 'implementation_or_verification_changed');
  const addedNode = addedItems.filter((item) => item.collection === 'node' && item.id === 'impl:resume-support');
  assert.equal(addedNode.length, 1);
  assert.deepEqual(addedNode[0].fields, []);
  assert.equal(addedNode[0].hasBothContents, false);
});

test('a truncated support projection says so instead of dropping ids silently', () => {
  const state = clone(valid);
  const work = appendWorkWithSupport(state, {
    id: 'checkpoint:work-support-truncated',
    workId: 'work:support-truncated',
    workTitle: 'Support truncated',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const projections = featureWorkSupportProjections(state, work.workContext.nodeId);
  assert.ok(projections.projections.length <= WORK_LIMITS.maxWorkSupportSnapshots);
  assert.equal(WORK_LIMITS.maxWorkSupportSnapshots, 200);
  assert.equal(WORK_SUPPORT_SNAPSHOT_LIMIT, 200);
  assert.deepEqual(WORK_SUPPORT_SNAPSHOT_COLLECTIONS, ['node', 'evidence', 'check']);
});

test('workSupportSnapshots is work-only, bounded and validated by both surfaces', () => {
  const state = clone(valid);
  const work = appendWorkWithSupport(state, {
    id: 'checkpoint:work-support-schema',
    workId: 'work:support-schema',
    workTitle: 'Support schema',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  const recordLocation = 'featureCheckpoints[3]';
  assert.deepEqual(validateStateSchema(state), []);
  assert.deepEqual(validateFullState(state), []);
  assert.deepEqual(validateFeatureProgress(state), []);

  // An ordinary checkpoint may not carry it.
  const ordinary = clone(state);
  ordinary.featureCheckpoints.push({ ...makeOrdinaryRecord({ id: 'checkpoint:ordinary-support', createdAt: '2026-02-03T00:00:00.000Z' }), supersedes: ordinary.featureCheckpoints.at(-1).id, workSupportSnapshots: [] });
  ordinary.featureCheckpoints.at(-1).basis = clone(state.featureCheckpoints.at(-1).basis);
  assert.ok(validateStateSchema(ordinary).length > 0);
  assert.ok(validateFeatureProgress(ordinary).some((error) => error.includes('workSupportSnapshots')));

  // Unsorted entries are rejected by the progress reader (the schema cannot see
  // order; `uniqueItems` sees duplicates).
  const unsorted = clone(state);
  const entries = unsorted.featureCheckpoints.at(-1).workSupportSnapshots;
  unsorted.featureCheckpoints.at(-1).workSupportSnapshots = [...entries].reverse();
  assert.ok(validateFeatureProgress(unsorted).some((error) => error.includes('sorted unique')));
  const duplicate = clone(state);
  duplicate.featureCheckpoints.at(-1).workSupportSnapshots = [entries[0], entries[0]];
  assert.ok(validateStateSchema(duplicate).length > 0);
  assert.ok(validateFeatureProgress(duplicate).length > 0);

  // A bad collection or a non-digest is rejected on both surfaces.
  const badCollection = clone(state);
  badCollection.featureCheckpoints.at(-1).workSupportSnapshots[0].collection = 'roadmapItem';
  assert.ok(validateStateSchema(badCollection).length > 0);
  assert.ok(validateFeatureProgress(badCollection).length > 0);
  const badDigest = clone(state);
  badDigest.featureCheckpoints.at(-1).workSupportSnapshots[0].digest = 'sha256:xyz';
  assert.ok(validateStateSchema(badDigest).length > 0);
  assert.ok(validateFeatureProgress(badDigest).length > 0);

  // The cap is 200: one more item is rejected.
  const overCap = clone(state);
  overCap.featureCheckpoints.at(-1).workSupportSnapshots = Array.from({ length: 201 }, (_, index) => ({
    collection: 'node',
    id: `impl:generated-${String(index).padStart(3, '0')}`,
    digest: entries[0].digest,
  }));
  assert.ok(validateStateSchema(overCap).length > 0);
  assert.ok(validateFeatureProgress(overCap).some((error) => error.includes('at most 200')));

  // An old record without the key stays valid and reads as uncomparable.
  const legacy = clone(state);
  delete legacy.featureCheckpoints.at(-1).workSupportSnapshots;
  assert.deepEqual(validateStateSchema(legacy), []);
  assert.deepEqual(validateFullState(legacy), []);
  const view = deriveWorkChanges(legacy, work.workContext.workId, options);
  assert.equal(view.supportDigestSource, 'missing');
  assert.equal(view.supportContentComparable, false);
  assert.deepEqual(view.supportDigestMissing, [
    'node:impl:checkpoint-cli',
    'node:verification:checkpoint-tests',
  ]);
  void recordLocation;
});

test('a stage reading freezes the referenced checkpoint and survives a later work record', () => {
  const before = layerStageReading(valid, FEATURE, STAGE_CHECKPOINT, options);
  assert.equal(before.found, true);
  assert.equal(before.sourceCheckpointId, STAGE_CHECKPOINT);
  assert.equal(before.projection.collection, 'checkpoint');
  assert.equal(before.projection.sourceCheckpointId, STAGE_CHECKPOINT);
  assert.equal(before.projection.derived.origin, 'saved_remaining');
  assert.equal(before.projection.derived.status, 'awaiting_verification');
  assert.equal(before.projection.derived.chainValid, true);
  assert.equal(before.projection.derived.validationOk, true);
  assert.deepEqual(before.projection.remaining.statements, ['Synthetic remaining item; no execution happened.']);
  assert.deepEqual(before.excerpt.content.remaining.statements, ['Synthetic remaining item; no execution happened.']);
  assert.equal(before.excerpt.confirmation, null);
  assert.equal(before.excerptTooLarge, false);
  assert.ok(before.excerptBytes > 0 && before.excerptBytes <= WORK_LIMITS.maxLayerSnapshotBytes);

  const state = clone(valid);
  const work = appendWork(state, {
    id: 'checkpoint:work-stage',
    workId: 'work:stage',
    workTitle: 'Stage work',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business({
      upper: {
        productGoal: null,
        stage: stageLayer(state, FEATURE, STAGE_CHECKPOINT, { kind: 'userSelection', sourceRefIndex: 0, authorizationRef: 'ui:explicit-save' }),
        openUserPaths: [],
      },
    }),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  assert.deepEqual(validateFullState(state), []);

  const after = layerStageReading(state, FEATURE, STAGE_CHECKPOINT, options);
  assert.deepEqual(after.projection, before.projection);

  const workId = work.workContext.workId;
  const view = deriveWorkChanges(state, workId, options);
  assert.equal(view.upper.stage.state, 'found');
  assert.equal(view.upper.stage.observed.snapshotAvailable, false);
  assert.deepEqual(view.changes, []);

  // The referenced record's own reading is what is frozen: editing it is a
  // content change of the stage layer, reported once.
  const changed = clone(state);
  changed.featureCheckpoints.find((record) => record.id === STAGE_CHECKPOINT).remaining[0].statement = 'Changed remaining item after the record was saved.';
  const changedView = deriveWorkChanges(changed, workId, {
    ...options,
    layerSnapshots: { [`checkpoint:${STAGE_CHECKPOINT}`]: { content: before.projection, confirmation: null } },
  });
  assert.equal(changedView.changes.length, 1);
  assert.equal(changedView.changes[0].class, 'requirement_content_changed');
  assert.equal(changedView.changes[0].layer, 'stage');
  assert.deepEqual(changedView.changes[0].fields, ['remaining']);
  assert.equal(changedView.changes[0].hasBothContents, true);
});

test('§6.7: the overall reading stays on the last ordinary record while work records extend the chain', () => {
  const baseline = selectFeatureContext(valid, FEATURE, options);
  assert.equal(baseline.checkpoints.count, 2);
  assert.equal(baseline.checkpoints.tailId, STAGE_CHECKPOINT);
  // Compatibility: with no work record the overall source is the chain tail.
  assert.equal(baseline.latest.id, STAGE_CHECKPOINT);
  assert.equal(baseline.overallSourceId, STAGE_CHECKPOINT);
  assert.equal(overallRecord(valid, FEATURE).id, STAGE_CHECKPOINT);

  const { state, workAOpen, workBOpen, workAAdjust, workBPause, workAPause } = interleavedState();
  assert.deepEqual(validateFullState(state), []);

  const view = selectFeatureContext(state, FEATURE, options);
  // Chain facts keep reporting the whole chain, work records included.
  assert.equal(view.checkpoints.count, 7);
  assert.equal(view.checkpoints.tailId, workAPause.id);
  assert.equal(view.checkpoints.ordered.length, 7);
  assert.equal(view.checkpoints.ordered.at(-1).id, workAPause.id);
  // The overall reading is the last record without `workContext`. `latest` is
  // therefore NOT the chain tail, and both ids are pinned separately so a
  // compatible reading of "latest" cannot hide the difference.
  assert.equal(view.latest.id, STAGE_CHECKPOINT);
  assert.equal(view.overallSourceId, STAGE_CHECKPOINT);
  assert.notEqual(view.latest.id, view.checkpoints.tailId);
  assert.equal(overallRecord(state, FEATURE).id, STAGE_CHECKPOINT);

  // Interleaved work changes nothing else in the overall projection.
  assert.deepEqual(view.delivery, baseline.delivery);
  assert.deepEqual(view.context, baseline.context);
  assert.deepEqual(view.source, baseline.source);
  assert.equal(view.latest.stopPoint, baseline.latest.stopPoint);
  assert.deepEqual(view.latest.nextActions, baseline.latest.nextActions);
  assert.equal(view.delivery.savedAt, '2026-01-02T00:00:00.000Z');
  // Each work keeps its own revision history and its own current record.
  const workA = currentWork(state, workAOpen.workContext.workId, options);
  assert.equal(workA.revisionCount, 3);
  assert.equal(workA.currentRecordId, workAPause.id);
  assert.equal(workA.operation, 'pause');
  assert.deepEqual(workA.content.scope, []);
  const workB = currentWork(state, workBOpen.workContext.workId, options);
  assert.equal(workB.revisionCount, 2);
  assert.equal(workB.currentRecordId, workBPause.id);
  assert.deepEqual(workB.content.scope, business().scope);
  // Interleaved work records are ordinary chain links: each points at the
  // record appended before it, whichever work that record belongs to.
  assert.equal(workBOpen.supersedes, workAOpen.id);
  assert.equal(workAAdjust.supersedes, workBOpen.id);
  assert.equal(workBPause.supersedes, workAAdjust.id);
  assert.equal(workAPause.supersedes, workBPause.id);

  // The aggregate read model follows the same source and keeps both ids apart.
  const derived = deriveFeatureProgress(state, options);
  const feature = derived.features.find((item) => item.nodeId === FEATURE);
  assert.equal(feature.checkpoints.count, 7);
  assert.equal(feature.checkpoints.tailId, workAPause.id);
  assert.equal(feature.checkpoints.latestId, STAGE_CHECKPOINT);
  assert.equal(feature.latest.id, STAGE_CHECKPOINT);
  assert.equal(feature.overallSourceId, STAGE_CHECKPOINT);

  // A later ordinary checkpoint restores the existing behaviour: it becomes
  // both the chain tail and the overall source.
  const ordinary = appendRecord(state, makeOrdinaryRecord({ id: 'checkpoint:ordinary-after-work', createdAt: '2026-02-06T00:00:00.000Z' }));
  assert.deepEqual(validateFullState(state), []);
  const resumed = selectFeatureContext(state, FEATURE, options);
  assert.equal(resumed.checkpoints.count, 8);
  assert.equal(resumed.checkpoints.tailId, ordinary.id);
  assert.equal(resumed.latest.id, ordinary.id);
  assert.equal(resumed.overallSourceId, ordinary.id);
  assert.equal(resumed.delivery.status, 'unknown');
  assert.equal(resumed.delivery.origin, 'no_basis');
  assert.equal(resumed.delivery.savedAt, ordinary.createdAt);
  assert.equal(resumed.source.status, 'recorded_not_verified');
  assert.equal(resumed.source.snapshotCount, 0);
  // Work revisions are untouched by the ordinary checkpoint.
  assert.equal(currentWork(state, workAOpen.workContext.workId, options).currentRecordId, workAPause.id);
  assert.equal(currentWork(state, workBOpen.workContext.workId, options).currentRecordId, workBPause.id);
  const resumedDerived = deriveFeatureProgress(state, options);
  const resumedFeature = resumedDerived.features.find((item) => item.nodeId === FEATURE);
  assert.equal(resumedFeature.checkpoints.count, 8);
  assert.equal(resumedFeature.checkpoints.tailId, ordinary.id);
  assert.equal(resumedFeature.checkpoints.latestId, ordinary.id);
  assert.equal(resumedFeature.latest.id, ordinary.id);
  assert.equal(resumedFeature.overallSourceId, ordinary.id);

  // A Feature whose chain is only work records has no overall source at all:
  // empty reading, while the chain facts still report the work record.
  const searchState = clone(valid);
  searchState.featureCheckpoints = searchState.featureCheckpoints.filter((record) => record.id !== SEARCH_CHECKPOINT);
  searchState.mapUpdates = searchState.mapUpdates.filter((update) => !update.addedFeatureCheckpointIds.includes(SEARCH_CHECKPOINT));
  searchState.stateVersion = 3;
  const workOnly = appendWork(searchState, {
    id: 'checkpoint:work-search-only',
    workId: 'work:search-only',
    workTitle: 'Search work',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    nodeId: SECOND,
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  assert.deepEqual(validateFullState(searchState), []);
  const searchView = selectFeatureContext(searchState, SECOND, options);
  assert.equal(searchView.checkpoints.count, 1);
  assert.equal(searchView.checkpoints.tailId, workOnly.id);
  assert.equal(searchView.latest, null);
  assert.equal(searchView.overallSourceId, null);
  assert.equal(overallRecord(searchState, SECOND), null);
  assert.equal(searchView.delivery.status, 'unknown');
  assert.equal(searchView.delivery.origin, 'no_basis');
  assert.equal(searchView.delivery.savedAt, null);
  assert.equal(searchView.context.status, 'no_checkpoint');
  assert.equal(searchView.source.status, 'not_recorded');
  const workOnlyView = currentWork(searchState, workOnly.workContext.workId, options);
  assert.equal(workOnlyView.found, true);
  assert.equal(workOnlyView.currentRecordId, workOnly.id);
  const searchDerived = deriveFeatureProgress(searchState, options);
  const searchFeature = searchDerived.features.find((item) => item.nodeId === SECOND);
  assert.equal(searchFeature.checkpoints.count, 1);
  assert.equal(searchFeature.checkpoints.tailId, workOnly.id);
  assert.equal(searchFeature.checkpoints.latestId, null);
  assert.equal(searchFeature.latest, null);
  assert.equal(searchFeature.overallSourceId, null);
  // A work-only chain is not an empty Feature: the record is counted.
  assert.equal(searchFeature.emptyState, null);
});

test('the work index orders active first, then updatedAt descending, with deterministic caps', () => {
  const state = clone(valid);
  appendWork(state, {
    id: 'checkpoint:work-index-a',
    workId: 'work:resume-a',
    workTitle: 'Resume work A',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  appendWork(state, {
    id: 'checkpoint:work-index-b-open',
    workId: 'work:resume-b',
    workTitle: 'Resume work B',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    createdAt: '2026-02-02T00:00:00.000Z',
  });
  appendWork(state, {
    id: 'checkpoint:work-index-b-pause',
    workId: 'work:resume-b',
    workTitle: 'Resume work B',
    operation: 'pause',
    lifecycle: PAUSED,
    fields: business(),
    createdAt: '2026-02-02T00:30:00.000Z',
  });
  const finished = appendWork(state, {
    id: 'checkpoint:work-index-b-end',
    workId: 'work:resume-b',
    workTitle: 'Resume work B',
    operation: 'end',
    lifecycle: ENDED_HANDOFF,
    fields: business(),
    createdAt: '2026-02-03T00:00:00.000Z',
  });
  const other = appendWork(state, {
    id: 'checkpoint:work-index-c',
    workId: 'work:resume-c',
    workTitle: 'Resume work C',
    operation: 'open',
    lifecycle: ACTIVE,
    fields: business(),
    nodeId: SECOND,
    createdAt: '2026-02-04T00:00:00.000Z',
  });
  assert.deepEqual(validateFullState(state), []);

  const index = deriveCurrentWorkIndex(state, options);
  assert.deepEqual(index.entries.map((entry) => entry.workId), ['work:resume-c', 'work:resume-a', 'work:resume-b']);
  assert.equal(index.truncated, false);
  assert.equal(index.omitted, 0);
  const [first, second, third] = index.entries;
  assert.equal(first.nodeId, SECOND);
  assert.equal(first.featureLabel, 'Search records');
  assert.equal(first.lifecycle, 'active');
  assert.equal(first.basisReview, 'unchanged');
  assert.equal(first.currentRecordId, other.id);
  assert.equal(second.nodeId, FEATURE);
  assert.equal(second.featureLabel, 'Resume progress');
  assert.equal(third.lifecycle, 'ended');
  assert.equal(third.endsReason, 'handoff');
  assert.equal(third.currentRecordId, finished.id);
  assert.equal(third.workTitle, 'Resume work B');

  const endedView = currentWork(state, 'work:resume-b', options);
  assert.equal(endedView.revisionCount, 3);
  assert.equal(endedView.lifecycle.status, 'ended');
  assert.equal(endedView.lifecycle.endedReason, 'handoff');

  // One busy Feature cannot starve the index: the per-Feature cap runs first.
  const capped = deriveCurrentWorkIndex(state, { ...options, maxWorksPerFeature: 1 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.omitted, 1);
  assert.deepEqual(capped.entries.map((entry) => entry.workId), ['work:resume-c', 'work:resume-a']);

  const projectCapped = deriveCurrentWorkIndex(state, { ...options, maxWorkIndexEntries: 2 });
  assert.equal(projectCapped.entries.length, 2);
  assert.equal(projectCapped.omitted, 1);
  assert.equal(projectCapped.truncated, true);
});

test('the frozen work-side budgets stay inside the unchanged record limit', () => {
  assert.equal(FEATURE_PROGRESS_LIMITS.maxCheckpointBytes, 131072);
  assert.equal(WORK_LIMITS.maxWorkContextBytes, 32768);
  assert.equal(WORK_LIMITS.maxAdoptedBasisBytes, 24576);
  assert.equal(WORK_LIMITS.maxUpperBytes, 5120);
  assert.equal(WORK_LIMITS.maxLayerSnapshotBytes, 8192);
  assert.equal(WORK_LIMITS.maxLayerSnapshotPath, 160);
  assert.equal(WORK_LIMITS.maxSnapshotPath, 1024);
  assert.equal(WORK_LIMITS.maxWorkScopeItems, 8);
  assert.equal(WORK_LIMITS.maxWorkScopeText, 400);
  assert.equal(WORK_LIMITS.maxUpperOpenPaths, 5);
  assert.equal(WORK_LIMITS.maxLayerStageItems, 5);
  assert.equal(WORK_LIMITS.maxLayerStageText, 300);

  // The composite budget is the binding one, not the per-field maxima.
  assert.ok(WORK_LIMITS.maxWorkContextBytes + WORK_LIMITS.maxAdoptedBasisBytes < FEATURE_PROGRESS_LIMITS.maxCheckpointBytes);
  const adoptedWorstCase = WORK_LIMITS.maxAdoptedBasis * (WORK_LIMITS.maxWorkId + 71 + WORK_LIMITS.maxSnapshotPath + 60);
  assert.ok(adoptedWorstCase > WORK_LIMITS.maxAdoptedBasisBytes);

  const layerPath = `.product-continuity/current-work/${'0'.repeat(16)}/${'a'.repeat(64)}.json`;
  assert.ok(layerPath.length <= WORK_LIMITS.maxLayerSnapshotPath);
  assert.match(layerPath, /^\.product-continuity\/current-work\/[0-9a-f]{16}\/[0-9a-f]{64}\.json$/);
});
