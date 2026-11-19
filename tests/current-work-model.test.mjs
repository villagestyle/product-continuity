import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  CURRENT_WORK_CONSTANTS,
  CURRENT_WORK_OPERATIONS,
  buildCurrentWorkWrite,
  currentWorkKey,
  currentWorkSidecarPath,
  operationPayloadDigest,
  resolveCurrentWorkReplay,
  validateCurrentWorkWrite,
} from '../scripts/current-work-model.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { previewFeatureCheckpoint } from '../scripts/record-feature-checkpoint.mjs';
import { canonicalStringify, claimContentDigest, digestNormalizedCommand, formatApplicability } from '../scripts/intent-model.mjs';
import { deriveWorkChanges, featureWorkSupportProjections } from '../scripts/feature-progress.mjs';

const fixtureBytes = await fs.readFile(new URL('./fixtures/state-0.2-feature-valid.json', import.meta.url));
const emptyStateBytes = await fs.readFile(new URL('./fixtures/state-0.2-empty.json', import.meta.url));
const clone = (value) => structuredClone(value);

function freshState() {
  return JSON.parse(fixtureBytes.toString('utf8'));
}

function digestOf(state) {
  return sha256Bytes(Buffer.from(JSON.stringify(state), 'utf8'));
}

function ids(start = 900) {
  let counter = start;
  return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
}

const FEATURE_NODE = 'capability:progress-resume';
const GOAL_NODE = 'goal:resume';
const CLAIM_ID = 'claim:resume:v1';
const TAIL_CHECKPOINT = 'checkpoint:00000000-0000-4000-8000-000000000002';

// --- The confirmation axis (§7.4), built only from the empty fixture ---
// The map validator binds a `confirmed` claim to a preparation review, a confirm
// review, a governing decision and a `decision_record` evidence entry, so the
// pair below is written out in full instead of mutated into a fixture. The two
// states describe *the same claim* before and after `candidate -> confirmed`,
// which is exactly the two-axis case: one content projection, two facts.
const AXIS_NODE = 'capability:synthetic:axis';
const AXIS_CLAIM = 'claim:synthetic:axis';
const AXIS_DECISION = 'decision:synthetic:1';
const PAIR_INTENT = {
  statement: 'Users can see where a saved feature stopped.',
  scope: ['Synthetic contract fixture'],
  conditions: [],
  exceptions: [],
};
const syntheticDigest = (seed) => `sha256:${seed.repeat(64).slice(0, 64)}`;

/** No argument: candidate. `{confirm: true}`: the same claim after confirmation. */
function pairState({confirm = false} = {}) {
  const state = JSON.parse(emptyStateBytes.toString('utf8'));
  state.stateVersion = confirm ? 3 : 2;

  state.evidence.push({
    id: 'evidence:synthetic:1', kind: 'requirement', claim: 'Synthetic intent content',
    path: 'references/current-work-contract.md', locator: 'line 1', validation: 'not_applicable',
  });
  state.nodes.push({
    id: AXIS_NODE, kind: 'capability', label: 'Synthetic axis capability',
    status: confirm ? 'confirmed' : 'candidate', evidenceIds: [],
  });

  const editCommand = {
    projectId: state.project.id,
    action: 'edit_candidate',
    targetClaimId: AXIS_CLAIM,
    payload: {content: PAIR_INTENT, assessment: {disposition: 'single', reviewedLegacyContext: false}},
  };
  state.reviews.push({
    id: 'review:synthetic:1', createdAt: '2026-01-01T00:00:01.000Z', actor: 'local-user',
    source: 'local_review_ui', command: editCommand,
    observedStateVersion: 1, observedDigest: syntheticDigest('b'),
    idempotencyKey: '00000000-0000-4000-8000-000000001001',
    payloadDigest: digestNormalizedCommand(editCommand),
    createdClaimIds: [AXIS_CLAIM], affectedClaimIds: [], resultingStateVersion: 2,
  });

  const claim = {
    id: AXIS_CLAIM, nodeId: AXIS_NODE, ...PAIR_INTENT,
    status: 'candidate', origin: 'review', createdAt: '2026-01-01T00:00:01.000Z',
    createdByReviewId: 'review:synthetic:1',
    assessment: {
      disposition: 'single', contentDigest: claimContentDigest(PAIR_INTENT),
      reviewedLegacyContext: false, reviewId: 'review:synthetic:1',
    },
    governingDecisionId: null, retiredByDecisionId: null,
    supersedesClaimIds: [], supersededByClaimIds: [],
  };

  if (confirm) {
    // The confirmation step touches the confirmation axis only: the claim's four
    // content fields, scope and statement stay exactly as the edit left them.
    state.evidence.push({
      id: 'evidence:synthetic:2', kind: 'decision_record', claim: 'Synthetic confirmed intent',
      path: '.product-continuity/project-state.json', locator: 'reviews[id=review:synthetic:2]',
      validation: 'not_applicable',
    });
    state.nodes.find((node) => node.id === AXIS_NODE).evidenceIds.push('evidence:synthetic:2');
    const confirmCommand = {
      projectId: state.project.id,
      action: 'confirm_candidate',
      targetClaimId: AXIS_CLAIM,
      payload: {previewDigest: syntheticDigest('a'), confirmationAttested: true},
    };
    state.reviews.push({
      id: 'review:synthetic:2', createdAt: '2026-01-01T00:00:02.000Z', actor: 'local-user',
      source: 'local_review_ui', command: confirmCommand,
      observedStateVersion: 2, observedDigest: syntheticDigest('c'),
      idempotencyKey: '00000000-0000-4000-8000-000000001002',
      payloadDigest: digestNormalizedCommand(confirmCommand),
      createdClaimIds: [], affectedClaimIds: [AXIS_CLAIM],
      resultingDecisionId: AXIS_DECISION, resultingStateVersion: 3,
    });
    state.decisions.push({
      id: AXIS_DECISION, recordVersion: '0.2', kind: 'adopt_intent',
      claimIds: [AXIS_CLAIM], intent: PAIR_INTENT, statement: PAIR_INTENT.statement,
      status: 'confirmed', applicability: formatApplicability(PAIR_INTENT),
      createdAt: '2026-01-01T00:00:02.000Z', confirmedAt: '2026-01-01T00:00:02.000Z', confirmedBy: 'local-user',
      reviewId: 'review:synthetic:2', evidenceIds: ['evidence:synthetic:2'],
    });
    claim.status = 'confirmed';
    claim.governingDecisionId = AXIS_DECISION;
  }

  state.intentClaims.push(claim);
  return state;
}

/** One work over the axis claim. */
function adoptedWorkContent(nodeId, claimId, overrides = {}) {
  return {
    version: 1,
    nodeId,
    operation: 'open',
    workId: null,
    predecessorRecordId: null,
    workTitle: 'Synthetic adopted-basis work',
    objective: 'Record one synthetic round over an adopted claim.',
    scope: [{statement: 'Scope one'}],
    exclusions: [],
    acceptanceCriteria: [{statement: 'Synthetic acceptance'}],
    selection: {kind: 'user_selected', sourceRefs: ['Synthetic user instruction']},
    upper: {
      productGoal: null,
      stage: null,
      // openUserPaths admits user_task/unknown nodes and evidence only (§7.4), so
      // the adopted claim is carried by basisRefs/adoptedBasis, not here.
      openUserPaths: [],
    },
    lifecycle: {endedReason: null, endedNote: null},
    resume: {
      stopPoint: 'Synthetic stop point',
      nextStep: null,
      responsibility: 'agent',
      authorizationRequired: ['none'],
    },
    source: 'agent_organized',
    sourceRefs: ['Synthetic instruction'],
    basisRefs: [{collection: 'intentClaim', id: claimId}],
    adoptedBasis: [{claimId, writeSnapshot: true}],
    ...overrides,
  };
}

function contentInput(overrides = {}) {
  return {
    version: 1,
    nodeId: FEATURE_NODE,
    operation: 'open',
    workId: null,
    predecessorRecordId: null,
    workTitle: 'Synthetic current work',
    objective: 'Record one synthetic round of current work.',
    scope: [{statement: 'Scope one'}, {statement: 'Scope two'}, {statement: 'Scope three'}],
    exclusions: [{statement: 'Not this'}],
    acceptanceCriteria: [{statement: 'Synthetic acceptance'}],
    selection: {kind: 'user_selected', sourceRefs: ['Synthetic user instruction']},
    upper: {
      productGoal: {
        state: 'found',
        ref: {collection: 'node', id: GOAL_NODE},
        origin: {kind: 'edge', edgeId: 'edge:goal-capability', edgeKind: 'contains'},
      },
      stage: null,
      openUserPaths: [],
    },
    lifecycle: {endedReason: null, endedNote: null},
    resume: {
      stopPoint: 'Synthetic stop point',
      nextStep: null,
      responsibility: 'agent',
      authorizationRequired: ['none'],
    },
    source: 'agent_organized',
    sourceRefs: ['Synthetic instruction'],
    basisRefs: [],
    adoptedBasis: [],
    ...overrides,
  };
}

function optionsFor(state, overrides = {}) {
  return {
    digest: digestOf(state),
    projectId: state.project.id,
    operationId: 'synthetic-work-open',
    authorizationRef: 'ui:explicit-save',
    expectedStateVersion: state.stateVersion,
    expectedDigest: digestOf(state),
    clock: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

function build(state, content, options = {}) {
  return buildCurrentWorkWrite(state, content, optionsFor(state, options));
}

function expectOk(result) {
  if (!result.ok) throw new Error(`${result.code}: ${result.errors.join('; ')}`);
  return result;
}

function expectFailure(result, code) {
  assert.equal(result.ok, false, 'expected a refused build');
  assert.equal(result.code, code, result.errors.join('; '));
}

function openWork(state, options = {}) {
  return expectOk(build(state, contentInput(), options));
}

/** Continue the open work with one lifecycle-only operation. */
function continueWork(state, opened, operation, overrides = {}, optionOverrides = {}) {
  const previous = opened.checkpoint;
  const workContext = previous.workContext;
  const content = contentInput({
    operation,
    workId: workContext.workId,
    predecessorRecordId: previous.id,
    objective: workContext.objective,
    scope: clone(workContext.scope),
    exclusions: clone(workContext.exclusions),
    acceptanceCriteria: clone(workContext.acceptanceCriteria),
    selection: clone(workContext.selection),
    resume: clone(workContext.resume),
    upper: {
      productGoal: {
        state: 'found',
        ref: {collection: 'node', id: GOAL_NODE},
        origin: {kind: 'edge', edgeId: 'edge:goal-capability', edgeKind: 'contains'},
      },
      stage: null,
      openUserPaths: [],
    },
    ...overrides,
  });
  return build(state, content, {
    operationId: `synthetic-${operation}-${previous.id}`,
    expectedStateVersion: state.stateVersion,
    expectedDigest: digestOf(state),
    uuid: ids(1300),
    ...optionOverrides,
  });
}

test('open builds one complete record, one receipt and pure sidecar descriptors', () => {
  const state = freshState();
  const built = openWork(state, {uuid: ids(900)});

  assert.match(built.workId, /^work:[A-Za-z0-9._:-]{1,150}$/);
  const workContext = built.checkpoint.workContext;
  assert.equal(workContext.version, 1);
  assert.equal(workContext.operation, 'open');
  assert.equal(workContext.lifecycle.status, 'active');
  assert.deepEqual(workContext.scope.map((item) => item.statement), ['Scope one', 'Scope two', 'Scope three']);
  assert.equal(built.checkpoint.nodeId, FEATURE_NODE);
  assert.equal(built.checkpoint.source, 'agent_organized');
  assert.equal(built.checkpoint.summary, `本轮工作记录（非整体进展）：${workContext.workTitle}`);
  assert.deepEqual(built.checkpoint.workDone, []);
  assert.equal(built.checkpoint.stopPoint, null);
  assert.deepEqual(built.checkpoint.remaining, []);
  assert.deepEqual(built.checkpoint.nextActions, []);
  assert.equal(built.checkpoint.nextActionsStatus, 'not_prepared');
  assert.equal(Object.hasOwn(built.checkpoint, 'delivery'), false);
  assert.equal(Object.hasOwn(built.checkpoint, 'adoptedBasis'), false);
  assert.equal(built.checkpoint.supersedes, TAIL_CHECKPOINT);

  // One appended record, one receipt, one version step.
  assert.equal(built.nextState.stateVersion, state.stateVersion + 1);
  assert.equal(built.nextState.featureCheckpoints.length, state.featureCheckpoints.length + 1);
  assert.equal(built.nextState.mapUpdates.length, state.mapUpdates.length + 1);
  const receipt = built.nextState.mapUpdates.at(-1);
  assert.equal(receipt.source, 'local_feature_checkpoint');
  assert.equal(receipt.operationId, 'synthetic-work-open');
  assert.equal(receipt.authorizationRef, 'ui:explicit-save');
  assert.deepEqual(receipt.addedFeatureCheckpointIds, [built.checkpoint.id]);
  assert.equal(receipt.resultingStateVersion, state.stateVersion + 1);
  assert.equal(receipt.observedStateVersion, state.stateVersion);
  assert.equal(receipt.observedDigest, digestOf(state));
  assert.equal(receipt.payloadDigest, operationPayloadDigest(built.previewContentDigest, 'ui:explicit-save'));
  assert.equal(receipt.createdAt, built.checkpoint.createdAt);
  assert.equal(Object.hasOwn(receipt, 'changedRoadmapItemIds'), false);
  assert.deepEqual(receipt.changedNodeIds, []);
  assert.deepEqual(validateFullState(built.nextState), []);

  // The observation comes from the state, never from the plan.
  const goal = workContext.upper.productGoal;
  assert.equal(goal.state, 'found');
  assert.equal(goal.observed.label, 'Resume saved work');
  assert.equal(goal.observed.kind, 'product_goal');
  // A node's confirmation axis is its status only; assessmentDigest belongs to
  // a claim and is always null elsewhere (§7.4).
  assert.deepEqual(goal.observed.confirmation, {status: 'candidate', decisionId: null, assessmentDigest: null});
  assert.equal(goal.observed.origin.kind, 'edge');
  assert.equal(goal.observed.snapshotPath, currentWorkSidecarPath(built.workId, goal.observed.digest));
  assert.equal(goal.observed.digest, sha256Bytes(canonicalStringify({
    collection: 'node', id: GOAL_NODE, kind: 'product_goal', label: 'Resume saved work', description: null,
  })));

  assert.equal(built.sidecars.length, 1);
  const [sidecar] = built.sidecars;
  assert.equal(sidecar.path, goal.observed.snapshotPath);
  assert.equal(sidecar.digest, goal.observed.digest);
  assert.ok(sidecar.bytes.length <= CURRENT_WORK_CONSTANTS.maxLayerSnapshotBytes);
  const snapshot = JSON.parse(sidecar.bytes.toString('utf8'));
  assert.deepEqual(snapshot.content, {
    collection: 'node',
    id: GOAL_NODE,
    kind: 'product_goal',
    label: 'Resume saved work',
    description: null,
  });
  assert.deepEqual(snapshot.confirmation, {status: 'candidate'});
  assert.match(currentWorkKey(built.workId), /^[0-9a-f]{16}$/);
});

test('new work records persist bounded support digests from the exact Feature projections', () => {
  const state = freshState();
  const built = openWork(state, {uuid: ids(1450)});
  const expected = featureWorkSupportProjections(state, FEATURE_NODE).projections
    .map(({collection, id, content}) => ({
      collection,
      id,
      digest: sha256Bytes(Buffer.from(canonicalStringify(content), 'utf8')),
    }));
  assert.deepEqual(built.checkpoint.workSupportSnapshots, expected);
  assert.deepEqual(built.normalizedContent.workSupportSnapshots, expected);
  assert.equal(built.checkpoint.workSupportSnapshots.length <= 200, true);
  assert.deepEqual(validateFullState(built.nextState), []);

  const editedSupport = freshState();
  editedSupport.nodes.find((node) => node.id === 'impl:checkpoint-cli').description = 'Edited support description.';
  const changed = openWork(editedSupport, {uuid: ids(1451), operationId: 'support-content-change'});
  const beforeEntry = built.checkpoint.workSupportSnapshots.find((entry) => entry.collection === 'node' && entry.id === 'impl:checkpoint-cli');
  const afterEntry = changed.checkpoint.workSupportSnapshots.find((entry) => entry.collection === 'node' && entry.id === 'impl:checkpoint-cli');
  assert.notEqual(afterEntry.digest, beforeEntry.digest);
  assert.notEqual(changed.previewContentDigest, built.previewContentDigest);

  const unrelated = freshState();
  unrelated.nodes.find((node) => node.id === 'capability:search').description = 'Unrelated Feature changed.';
  const unrelatedBuilt = openWork(unrelated, {uuid: ids(1452), operationId: 'unrelated-feature-change'});
  assert.deepEqual(unrelatedBuilt.checkpoint.workSupportSnapshots, built.checkpoint.workSupportSnapshots);
});

test('empty support is recorded as an empty array and oversized support is refused', () => {
  const state = JSON.parse(emptyStateBytes.toString('utf8'));
  state.nodes.push({
    id: 'capability:synthetic:empty-support', kind: 'capability', label: 'No support',
    status: 'candidate', evidenceIds: [],
  });
  const noSupportContent = contentInput({
    nodeId: 'capability:synthetic:empty-support',
    upper: {productGoal: null, stage: null, openUserPaths: []},
  });
  const emptyBuilt = expectOk(build(state, noSupportContent, {
    uuid: ids(1453), operationId: 'empty-support-work',
  }));
  assert.deepEqual(emptyBuilt.checkpoint.workSupportSnapshots, []);
  assert.equal(Object.hasOwn(emptyBuilt.checkpoint, 'workSupportSnapshots'), true);
  assert.deepEqual(validateFullState(emptyBuilt.nextState), []);
  const emptyRead = deriveWorkChanges(emptyBuilt.nextState, emptyBuilt.workId, {
    digest: (value) => sha256Bytes(Buffer.from(canonicalStringify(value), 'utf8')),
  });
  assert.equal(emptyRead.supportDigestSource, 'persisted');
  assert.equal(emptyRead.supportContentComparable, true);
  assert.deepEqual(emptyRead.supportDigestMissing, []);

  const oversized = freshState();
  oversized.checks = Array.from({length: 201}, (_, index) => ({
    id: `check:support-overflow:${String(index).padStart(3, '0')}`,
    createdAt: '2026-11-19T00:00:00.000Z',
    base: {},
    head: {},
    taskIntent: {status: 'not_provided'},
    scope: {description: 'Synthetic connected check.', includedPaths: [], excludedPaths: [], coverageNote: 'Bound test.'},
    findings: [{
      id: `finding:support-overflow:${String(index).padStart(3, '0')}`,
      status: 'insufficient_evidence',
      summary: 'Synthetic finding connected to support.',
      affectedNodeIds: ['impl:checkpoint-cli'],
      evidenceIds: [],
    }],
  }));
  const refused = build(oversized, contentInput(), {operationId: 'support-overflow-work'});
  expectFailure(refused, 'invalid_request');
  assert.equal(refused.details.reason, 'work_support_snapshot_limit');
  assert.equal(refused.details.limit, 200);
  assert.equal(Object.hasOwn(refused, 'nextState'), false);
});

test('the preview digest covers the resolved record and excludes the journal fields', () => {
  const state = freshState();
  const built = openWork(state, {uuid: ids(910)});
  const normalized = built.normalizedContent;
  assert.equal(Object.hasOwn(normalized, 'projectId'), false);
  assert.equal(Object.hasOwn(normalized, 'operationId'), false);
  assert.equal(Object.hasOwn(normalized, 'authorizationRef'), false);
  assert.equal(Object.hasOwn(normalized, 'payloadDigest'), false);
  assert.equal(Object.hasOwn(normalized, 'previewContentDigest'), false);
  assert.deepEqual(normalized.lifecycle, {status: 'active', endedReason: null, endedNote: null});
  assert.equal(normalized.upper.productGoal.state, 'found');
  assert.equal(built.previewContentDigest, sha256Bytes(canonicalStringify(normalized)));
  assert.notEqual(
    built.previewContentDigest,
    operationPayloadDigest(built.previewContentDigest, 'ui:explicit-save'),
  );

  // The same content previewed (dry run) yields the same digest, but no receipt.
  // Preview never carries the journal fields (§10.2), so it cannot name them.
  const dry = expectOk(buildCurrentWorkWrite(state, contentInput(), {
    digest: digestOf(state),
    projectId: state.project.id,
    expectedStateVersion: state.stateVersion,
    expectedDigest: digestOf(state),
    dryRun: true,
    uuid: ids(910),
  }));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.nextState, null);
  assert.equal(dry.receipt, null);
  assert.equal(dry.payloadDigest, null);
  assert.equal(dry.previewContentDigest, built.previewContentDigest);
  assert.equal(dry.recordPreview.id, null);
  assert.equal(dry.recordPreview.createdAt, null);
  assert.equal(dry.recordPreview.workContext.workId, built.checkpoint.workContext.workId);
});

test('diff lists every group with complete before/after values', () => {
  const state = freshState();
  const built = openWork(state, {uuid: ids(915)});
  const groups = built.diff.map((entry) => entry.group);
  assert.deepEqual(groups, [
    'lifecycle', 'workTitle', 'objective', 'scope', 'exclusions', 'acceptanceCriteria',
    'selection', 'upper', 'resume', 'source', 'basisRefs', 'adoptedBasis', 'recordShell',
  ]);
  const lifecycle = built.diff.find((entry) => entry.group === 'lifecycle');
  assert.equal(lifecycle.before, null);
  assert.deepEqual(lifecycle.after, {status: 'active', endedReason: null, endedNote: null});
  const shell = built.diff.find((entry) => entry.group === 'recordShell');
  assert.equal(shell.before, null);
  assert.deepEqual(shell.after.workDone, []);
  assert.equal(shell.after.delivery, null);
});

test('an exact operationId replay returns the original record before any CAS comparison', () => {
  const state = freshState();
  const built = openWork(state, {uuid: ids(920)});
  const staleDigest = digestOf(state);

  const replay = buildCurrentWorkWrite(built.nextState, contentInput({workId: built.workId}), {
    digest: staleDigest,
    operationId: 'synthetic-work-open',
    authorizationRef: 'ui:explicit-save',
    expectedStateVersion: state.stateVersion,
    expectedDigest: staleDigest,
    previewContentDigest: built.previewContentDigest,
    clock: '2026-11-19T01:00:00.000Z',
    uuid: ids(930),
  });
  assert.equal(replay.ok, true, replay.errors?.join('; '));
  assert.equal(replay.replayed, true);
  assert.equal(replay.checkpoint.id, built.checkpoint.id);
  assert.equal(replay.workId, built.workId);
  assert.equal(replay.payloadDigest, built.payloadDigest);
  assert.equal(replay.previewContentDigest, null);
  assert.equal(replay.resultingStateVersion, built.nextState.stateVersion);
  assert.equal(replay.nextState, built.nextState);
  assert.deepEqual(replay.sidecars, []);
});

test('same operationId with a different digest is key_conflict and writes nothing', () => {
  const state = freshState();
  const built = openWork(state, {uuid: ids(940)});
  const other = expectOk(build(state, contentInput({
    objective: 'A different synthetic objective.',
  }), {uuid: ids(941)}));
  const result = buildCurrentWorkWrite(built.nextState, contentInput({workId: built.workId}), {
    digest: digestOf(built.nextState),
    operationId: 'synthetic-work-open',
    authorizationRef: 'ui:explicit-save',
    expectedStateVersion: built.nextState.stateVersion,
    expectedDigest: digestOf(built.nextState),
    previewContentDigest: other.previewContentDigest,
  });
  expectFailure(result, 'key_conflict');
  assert.equal(result.details.storedPayloadDigest, built.payloadDigest);
});

test('a recorded payloadDigest is immutable: a different authorizationRef conflicts', () => {
  const state = freshState();
  const built = openWork(state, {uuid: ids(945)});
  const result = buildCurrentWorkWrite(built.nextState, contentInput({workId: built.workId}), {
    digest: digestOf(built.nextState),
    operationId: 'synthetic-work-open',
    authorizationRef: 'cli:apply',
    expectedStateVersion: built.nextState.stateVersion,
    expectedDigest: digestOf(built.nextState),
    previewContentDigest: built.previewContentDigest,
  });
  expectFailure(result, 'key_conflict');
});

test('a receipt whose record disappeared is external_modification, not a replay', () => {
  const state = freshState();
  const built = openWork(state, {uuid: ids(950)});
  const broken = clone(built.nextState);
  broken.featureCheckpoints = broken.featureCheckpoints.filter((record) => record.id !== built.checkpoint.id);
  const result = buildCurrentWorkWrite(broken, contentInput({workId: built.workId}), {
    digest: digestOf(broken),
    operationId: 'synthetic-work-open',
    authorizationRef: 'ui:explicit-save',
    expectedStateVersion: broken.stateVersion,
    expectedDigest: digestOf(broken),
  });
  expectFailure(result, 'external_modification');
  assert.ok(result.details.problems.includes('record_missing'));
});

test('pause repeats the whole business snapshot and only moves the lifecycle', () => {
  const state = freshState();
  const opened = openWork(state, {uuid: ids(960)});
  const paused = expectOk(continueWork(opened.nextState, opened, 'pause'));
  assert.equal(paused.checkpoint.workContext.operation, 'pause');
  assert.equal(paused.checkpoint.workContext.lifecycle.status, 'paused');
  assert.deepEqual(paused.checkpoint.workContext.scope, opened.checkpoint.workContext.scope);
  assert.deepEqual(paused.checkpoint.workContext.upper, opened.checkpoint.workContext.upper);
  assert.deepEqual(paused.checkpoint.workContext.resume, opened.checkpoint.workContext.resume);
  assert.deepEqual(validateFullState(paused.nextState), []);
});

test('pause with a changed business field is refused, never merged', () => {
  const state = freshState();
  const opened = openWork(state, {uuid: ids(970)});
  const result = continueWork(opened.nextState, opened, 'pause', {
    scope: [{statement: 'A silently narrower scope'}],
  });
  expectFailure(result, 'invalid_request');
  assert.equal(result.details.reason, 'business_snapshot_mismatch');
  assert.deepEqual(result.details.fields, ['scope']);
});

test('adjust replaces the snapshot; the older revision stays in history', () => {
  const state = freshState();
  const opened = openWork(state, {uuid: ids(980)});
  const adjusted = expectOk(continueWork(opened.nextState, opened, 'adjust', {scope: []}));
  assert.deepEqual(adjusted.checkpoint.workContext.scope, []);
  assert.equal(adjusted.checkpoint.workContext.lifecycle.status, 'active');
  assert.equal(
    adjusted.nextState.featureCheckpoints.filter((record) => record.workContext?.workId === opened.workId).length,
    2,
  );
  assert.equal(
    adjusted.nextState.featureCheckpoints.find((record) => record.id === opened.checkpoint.id).workContext.scope.length,
    3,
  );

  // The dropped items are not inherited: a pause must repeat [] to pass.
  const stale = continueWork(adjusted.nextState, adjusted, 'pause', {
    scope: [{statement: 'Scope one'}, {statement: 'Scope two'}, {statement: 'Scope three'}],
  });
  expectFailure(stale, 'invalid_request');
  assert.deepEqual(stale.details.fields, ['scope']);

  const paused = continueWork(adjusted.nextState, adjusted, 'pause', {scope: []});
  assert.equal(paused.ok, true, paused.errors?.join('; '));
  assert.deepEqual(paused.checkpoint.workContext.scope, []);
});

test('a stale work predecessor is work_revision_conflict and names the current record', () => {
  const state = freshState();
  const opened = openWork(state, {uuid: ids(990)});
  const paused = expectOk(continueWork(opened.nextState, opened, 'pause'));
  const stale = continueWork(paused.nextState, paused, 'resume', {
    predecessorRecordId: opened.checkpoint.id,
  });
  expectFailure(stale, 'work_revision_conflict');
  assert.equal(stale.details.currentRecordId, paused.checkpoint.id);
});

test('a stale global CAS is state_conflict with the actual version and digest', () => {
  const state = freshState();
  const opened = openWork(state, {uuid: ids(1000)});
  const content = contentInput({
    operation: 'adjust',
    workId: opened.workId,
    predecessorRecordId: opened.checkpoint.id,
    objective: 'Another synthetic objective.',
    scope: [],
  });
  const result = build(opened.nextState, content, {
    operationId: 'synthetic-cas-check',
    expectedStateVersion: state.stateVersion,
    expectedDigest: digestOf(state),
  });
  expectFailure(result, 'state_conflict');
  assert.equal(result.details.actualStateVersion, opened.nextState.stateVersion);
  assert.equal(result.details.actualDigest, digestOf(opened.nextState));
});

test('end records lifecycle and reason while repeating the snapshot', () => {
  const state = freshState();
  const opened = openWork(state, {uuid: ids(1010)});
  const ended = expectOk(continueWork(opened.nextState, opened, 'end', {
    lifecycle: {endedReason: 'handoff', endedNote: 'Synthetic handoff note.'},
  }));
  assert.equal(ended.checkpoint.workContext.lifecycle.status, 'ended');
  assert.equal(ended.checkpoint.workContext.lifecycle.endedReason, 'handoff');
  assert.equal(ended.checkpoint.workContext.lifecycle.endedNote, 'Synthetic handoff note.');
  assert.deepEqual(ended.checkpoint.workContext.scope, opened.checkpoint.workContext.scope);
  assert.deepEqual(validateFullState(ended.nextState), []);
});

test('anchor D: "nothing qualifies" is recorded as a gap, and a bogus relation is refused', () => {
  const state = freshState();
  // A goal exists in the map but this save attaches nothing: the gap carries the
  // reason category instead of a guessed link.
  const gap = expectOk(build(state, contentInput({
    upper: {productGoal: {state: 'gap'}, stage: null, openUserPaths: []},
  }), {uuid: ids(1020)}));
  assert.deepEqual(gap.checkpoint.workContext.upper.productGoal, {state: 'gap', reason: 'candidate_only'});
  assert.deepEqual(gap.sidecars, []);

  // An edge that is not contains/part_of is never a qualification.
  const forced = build(state, contentInput({
    upper: {
      productGoal: {
        state: 'found',
        ref: {collection: 'node', id: GOAL_NODE},
        origin: {kind: 'edge', edgeId: 'edge:capability-impl', edgeKind: 'contains'},
      },
      stage: null,
      openUserPaths: [],
    },
  }), {uuid: ids(1030)});
  expectFailure(forced, 'unresolved_upper_ref');
});

test('an adopted-basis sidecar stores the four content fields and its digest', () => {
  const state = freshState();
  const built = expectOk(build(state, contentInput({
    adoptedBasis: [{claimId: CLAIM_ID, writeSnapshot: true}],
    basisRefs: [{collection: 'intentClaim', id: CLAIM_ID}],
  }), {uuid: ids(1040)}));
  const [adopted] = built.checkpoint.adoptedBasis;
  const claim = state.intentClaims.find((item) => item.id === CLAIM_ID);
  const content = {
    collection: 'intentClaim',
    id: claim.id,
    nodeId: claim.nodeId,
    statement: claim.statement,
    scope: claim.scope,
    conditions: claim.conditions,
    exceptions: claim.exceptions,
  };
  assert.equal(adopted.claimId, CLAIM_ID);
  assert.equal(adopted.contentDigest, sha256Bytes(canonicalStringify(content)));
  assert.equal(adopted.snapshotPath, currentWorkSidecarPath(built.workId, adopted.contentDigest));
  // The confirmation fact is stored in the record, never in the content digest.
  assert.deepEqual(adopted.confirmation, {
    status: 'candidate',
    decisionId: null,
    assessmentDigest: sha256Bytes(canonicalStringify({disposition: 'unreviewed', contentDigest: null, reviewId: null})),
  });
  const sidecar = built.sidecars.find((item) => item.path === adopted.snapshotPath);
  assert.ok(sidecar, 'adopted basis sidecar descriptor is missing');
  assert.deepEqual(JSON.parse(sidecar.bytes.toString('utf8')), content);
  assert.equal(Object.hasOwn(JSON.parse(sidecar.bytes.toString('utf8')), 'confirmation'), false);
  assert.equal(JSON.stringify(JSON.parse(sidecar.bytes.toString('utf8'))).includes('assessment'), false);
  assert.deepEqual(built.checkpoint.basis.refs, [{collection: 'intentClaim', id: CLAIM_ID}]);

  // The sidecar path is named by the content digest, so it never moves when only
  // the confirmation axis moves (§7.2).
  assert.equal(adopted.snapshotPath, currentWorkSidecarPath(built.workId, adopted.contentDigest));
  assert.equal(built.normalizedContent.adoptedBasis[0].confirmation.assessmentDigest, adopted.confirmation.assessmentDigest);

  const noSnapshot = expectOk(build(state, contentInput({
    adoptedBasis: [{claimId: CLAIM_ID, writeSnapshot: false}],
  }), {operationId: 'synthetic-adopt-no-snapshot', uuid: ids(1050)}));
  assert.equal(noSnapshot.checkpoint.adoptedBasis[0].snapshotPath, null);
  // Only the productGoal observation wrote a file; the adopted claim did not.
  assert.deepEqual(
    noSnapshot.sidecars.map((item) => item.path),
    [noSnapshot.checkpoint.workContext.upper.productGoal.observed.snapshotPath],
  );

  // The preview digest sorts adoptedBasis by claimId, the record keeps input order.
  assert.deepEqual(built.normalizedContent.adoptedBasis.map((entry) => entry.claimId), [CLAIM_ID]);
});

test('a stage layer freezes the referenced checkpoint reading, not the chain tail', () => {
  const state = freshState();
  const built = expectOk(build(state, contentInput({
    upper: {
      productGoal: null,
      stage: {
        state: 'found',
        ref: {collection: 'checkpoint', id: TAIL_CHECKPOINT},
        origin: {kind: 'userSelection', sourceRefIndex: 0, authorizationRef: 'ui:explicit-save'},
      },
      openUserPaths: [],
    },
  }), {operationId: 'synthetic-stage', uuid: ids(1060)}));
  const stage = built.checkpoint.workContext.upper.stage;
  assert.equal(stage.state, 'found');
  assert.equal(stage.observed.kind, 'agent_organized');
  assert.deepEqual(stage.observed.confirmation, {status: 'not_applicable', decisionId: null, assessmentDigest: null});
  assert.equal(stage.observed.snapshotPath, currentWorkSidecarPath(built.workId, stage.observed.digest));
  const sidecar = built.sidecars.find((item) => item.path === stage.observed.snapshotPath);
  assert.ok(sidecar);
  const snapshot = JSON.parse(sidecar.bytes.toString('utf8'));
  assert.equal(snapshot.content.sourceCheckpointId, TAIL_CHECKPOINT);
  assert.equal(typeof snapshot.content.derived.status, 'string');
  assert.equal(snapshot.content.remaining.count, 1);
  assert.equal(snapshot.content.nextActions.count, 1);
  assert.equal(snapshot.confirmation, null);
  assert.ok(sidecar.bytes.length <= CURRENT_WORK_CONSTANTS.maxLayerSnapshotBytes);
});

test('plan limits are refusals, never truncation', () => {
  assert.throws(
    () => validateCurrentWorkWrite(contentInput({
      scope: Array.from({length: 9}, (_, index) => ({statement: `Item ${index}`})),
    })),
    (error) => error.code === 'invalid_request' && error.details.errors.some((message) => message.includes('at most 8')),
  );
  assert.throws(() => validateCurrentWorkWrite({...contentInput(), extra: true}), (error) => error.code === 'invalid_request');
  assert.throws(
    () => validateCurrentWorkWrite(contentInput({workId: 'work:bad id', operation: 'adjust', predecessorRecordId: 'checkpoint:x'})),
    (error) => error.code === 'invalid_request',
  );
  assert.throws(
    () => validateCurrentWorkWrite(contentInput({
      upper: {
        productGoal: {
          state: 'found',
          ref: {collection: 'node', id: GOAL_NODE},
          origin: {kind: 'edge', edgeId: 'edge:goal-capability', edgeKind: 'contains'},
          observed: {digest: 'sha256:not-a-digest'},
        },
        stage: null,
        openUserPaths: [],
      },
    })),
    (error) => error.code === 'invalid_request',
  );
  assert.deepEqual([...CURRENT_WORK_OPERATIONS], ['open', 'adjust', 'pause', 'resume', 'end']);
  assert.equal(CURRENT_WORK_CONSTANTS.maxCheckpointBytes, undefined);
  assert.equal(CURRENT_WORK_CONSTANTS.maxWorkContextBytes, 32768);
});

test('resolveCurrentWorkReplay reports missing and intact receipts without writing', () => {
  const state = freshState();
  const missing = resolveCurrentWorkReplay(state, {operationId: 'synthetic-work-open'});
  assert.equal(missing.found, false);
  assert.equal(missing.integrity, 'missing');

  const built = openWork(state, {uuid: ids(1070)});
  const replay = resolveCurrentWorkReplay(built.nextState, {operationId: 'synthetic-work-open'});
  assert.equal(replay.found, true);
  assert.equal(replay.integrity, 'ok');
  assert.equal(replay.recordId, built.checkpoint.id);
  assert.equal(replay.workId, built.workId);
  assert.equal(replay.payloadDigest, built.payloadDigest);
  assert.equal(replay.resultingStateVersion, built.nextState.stateVersion);
});

test('the offline preview delegates work plans to the shared builder and writes nothing', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'product-continuity-tests', 'current-work-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const statePath = path.join(directory, 'project-state.json');
  await fs.writeFile(statePath, fixtureBytes);
  const state = freshState();

  const preview = await previewFeatureCheckpoint(statePath, {
    projectId: state.project.id,
    expectedStateVersion: state.stateVersion,
    expectedDigest: sha256Bytes(fixtureBytes),
    content: contentInput(),
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.applied, false);
  assert.equal(preview.recordPreview.workContext.operation, 'open');
  assert.equal(preview.recordPreview.id, null);
  assert.match(preview.work.workId, /^work:/);
  assert.equal(preview.recordPreview.workContext.workId, preview.work.workId);
  assert.match(preview.previewContentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(preview.payloadDigest, undefined);
  assert.ok(preview.diff.some((entry) => entry.group === 'scope'));
  assert.ok(preview.sidecarPlan.every((sidecar) => sidecar.path.startsWith('.product-continuity/current-work/')));
  assert.deepEqual(await fs.readFile(statePath), fixtureBytes);

  // The ordinary checkpoint path is untouched.
  const ordinaryPlan = {
    projectId: state.project.id,
    operationId: 'ordinary-preview-regression',
    expectedStateVersion: state.stateVersion,
    expectedDigest: sha256Bytes(fixtureBytes),
    authorizationRef: 'Synthetic test authorization; not a product approval.',
    nodeId: FEATURE_NODE,
    supersedes: TAIL_CHECKPOINT,
    source: 'agent_organized',
    sourceRefs: ['Synthetic ordinary checkpoint'],
    summary: 'Synthetic ordinary checkpoint preview.',
    workDone: [],
    stopPoint: null,
    remaining: [],
    nextActions: [],
    nextActionsStatus: 'not_prepared',
    basis: {refs: [], sourceSnapshots: []},
  };
  const ordinary = await previewFeatureCheckpoint(statePath, ordinaryPlan);
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.draft.id, null);
  assert.equal(Object.hasOwn(ordinary.draft, 'workContext'), false);
});

// ---------------------------------------------------------------------------
// §7.4 / §11.20: two facts, two axes, no overlap
// ---------------------------------------------------------------------------

/** Build one work over the axis claim at the state's current version. */
function buildAxis(state, uuid) {
  return expectOk(build(state, adoptedWorkContent(AXIS_NODE, AXIS_CLAIM), {uuid}));
}

test('candidate -> confirmed moves the confirmation axis and leaves the content axis byte-identical', () => {
  const candidateState = pairState();
  const confirmedState = pairState({confirm: true});
  assert.deepEqual(validateFullState(candidateState), []);
  assert.deepEqual(validateFullState(confirmedState), []);

  // The same uuid on both sides keeps the work id — and therefore the sidecar
  // directory — identical, so the only remaining variable is the confirmation.
  const before = buildAxis(candidateState, ids(1200));
  const after = buildAxis(confirmedState, ids(1200));
  assert.equal(after.workId, before.workId);

  const [beforeAdopted] = before.checkpoint.adoptedBasis;
  const [afterAdopted] = after.checkpoint.adoptedBasis;

  // Content axis (§7.2): the four content fields are untouched by a confirmation,
  // so digest, path and bytes are all literally the same.
  assert.equal(afterAdopted.contentDigest, beforeAdopted.contentDigest);
  assert.equal(afterAdopted.snapshotPath, beforeAdopted.snapshotPath);
  assert.equal(afterAdopted.snapshotPath, currentWorkSidecarPath(before.workId, beforeAdopted.contentDigest));
  const beforeSidecar = before.sidecars.find((item) => item.path === beforeAdopted.snapshotPath);
  const afterSidecar = after.sidecars.find((item) => item.path === afterAdopted.snapshotPath);
  assert.ok(beforeSidecar && afterSidecar);
  assert.deepEqual(afterSidecar.bytes, beforeSidecar.bytes);
  // The digest input is §7.4's content projection (collection/id/nodeId plus the
  // four intent fields) — deliberately not `claimContentDigest`, which covers the
  // intent fields alone.
  assert.equal(beforeAdopted.contentDigest, sha256Bytes(canonicalStringify({
    collection: 'intentClaim', id: AXIS_CLAIM, nodeId: AXIS_NODE,
    statement: PAIR_INTENT.statement, scope: PAIR_INTENT.scope,
    conditions: PAIR_INTENT.conditions, exceptions: PAIR_INTENT.exceptions,
  })));
  assert.notEqual(beforeAdopted.contentDigest, claimContentDigest(PAIR_INTENT));

  // The sidecar is the content projection and nothing else: no confirmation key,
  // no assessment, no confirmation fact.
  for (const sidecar of [beforeSidecar, afterSidecar]) {
    const parsed = JSON.parse(sidecar.bytes.toString('utf8'));
    assert.deepEqual(Object.keys(parsed).sort(),
      ['collection', 'conditions', 'exceptions', 'id', 'nodeId', 'scope', 'statement']);
    assert.equal(JSON.stringify(parsed).includes('confirmation'), false);
    assert.equal(JSON.stringify(parsed).includes('assessment'), false);
  }

  // Confirmation axis (§7.4): the compared fact is `{status, decisionId,
  // assessmentDigest}`, `assessmentDigest` being sha256 of the three assessment
  // fields. Confirmation moves all of it; nothing else does.
  const assessmentDigest = sha256Bytes(canonicalStringify({
    disposition: 'single',
    contentDigest: claimContentDigest(PAIR_INTENT),
    reviewId: 'review:synthetic:1',
  }));
  assert.deepEqual(beforeAdopted.confirmation, {
    status: 'candidate', decisionId: null, assessmentDigest,
  });
  assert.deepEqual(afterAdopted.confirmation, {
    status: 'confirmed', decisionId: AXIS_DECISION, assessmentDigest,
  });
  assert.equal(afterAdopted.confirmation.assessmentDigest, beforeAdopted.confirmation.assessmentDigest);
  assert.notEqual(afterAdopted.confirmation.status, beforeAdopted.confirmation.status);
  assert.notEqual(afterAdopted.confirmation.decisionId, beforeAdopted.confirmation.decisionId);

  // The record carries the fact, so the preview digest (which covers the resolved
  // record) does see the transition: a candidate -> confirmed is a real change the
  // human approves.
  assert.notEqual(after.previewContentDigest, before.previewContentDigest);
  assert.equal(after.previewContentDigest, sha256Bytes(canonicalStringify(after.normalizedContent)));
  assert.deepEqual(after.normalizedContent.adoptedBasis[0].confirmation, afterAdopted.confirmation);
  assert.deepEqual(before.normalizedContent.adoptedBasis[0].confirmation, beforeAdopted.confirmation);
  assert.equal(after.normalizedContent.adoptedBasis[0].contentDigest, before.normalizedContent.adoptedBasis[0].contentDigest);

  // The receipt is the *operation* digest (§10.3) and never carries the fact.
  const beforeReceipt = before.nextState.mapUpdates.at(-1);
  const afterReceipt = after.nextState.mapUpdates.at(-1);
  assert.equal(beforeReceipt.payloadDigest, operationPayloadDigest(before.previewContentDigest, 'ui:explicit-save'));
  assert.equal(afterReceipt.payloadDigest, operationPayloadDigest(after.previewContentDigest, 'ui:explicit-save'));
  assert.notEqual(afterReceipt.payloadDigest, beforeReceipt.payloadDigest);
  assert.equal(JSON.stringify(afterReceipt).includes('assessmentDigest'), false);
  assert.equal(JSON.stringify(afterReceipt).includes('confirmation'), false);
  assert.deepEqual(validateFullState(before.nextState), []);
  assert.deepEqual(validateFullState(after.nextState), []);
});

test('an assessment-only edit outside the compared fact cannot move either axis', () => {
  // A re-recorded preparation review for the same claim, differing only in
  // `reviewedLegacyContext` — the one assessment field outside §7.4's compared
  // fact `{disposition, contentDigest, reviewId}`. Neither axis may move.
  const state = pairState();
  const claim = state.intentClaims.find((item) => item.id === AXIS_CLAIM);
  claim.assessment.reviewedLegacyContext = true;
  assert.deepEqual(validateFullState(state), []);

  const before = buildAxis(pairState(), ids(1220));
  const after = buildAxis(state, ids(1220));
  assert.equal(after.workId, before.workId);
  const [beforeAdopted] = before.checkpoint.adoptedBasis;
  const [afterAdopted] = after.checkpoint.adoptedBasis;

  // Content axis: identical digest, path and bytes.
  assert.equal(afterAdopted.contentDigest, beforeAdopted.contentDigest);
  assert.equal(afterAdopted.snapshotPath, beforeAdopted.snapshotPath);
  assert.deepEqual(
    after.sidecars.find((item) => item.path === afterAdopted.snapshotPath).bytes,
    before.sidecars.find((item) => item.path === beforeAdopted.snapshotPath).bytes,
  );

  // Confirmation axis: `reviewedLegacyContext` is outside the compared fact, so
  // the fact is literally unchanged, key for key.
  assert.deepEqual(afterAdopted.confirmation, beforeAdopted.confirmation);
  assert.equal(afterAdopted.confirmation.assessmentDigest, sha256Bytes(canonicalStringify({
    disposition: 'single',
    contentDigest: claimContentDigest(PAIR_INTENT),
    reviewId: 'review:synthetic:1',
  })));
  // ... and it is deliberately *not* the digest of the full assessment object.
  assert.notEqual(afterAdopted.confirmation.assessmentDigest, sha256Bytes(canonicalStringify({
    disposition: 'single',
    contentDigest: claimContentDigest(PAIR_INTENT),
    reviewedLegacyContext: true,
    reviewId: 'review:synthetic:1',
  })));

  // With both axes unchanged the preview digest moves only because of the record
  // shape it covers; the asserted invariant is that the two adopted facts agree.
  assert.deepEqual(after.normalizedContent.adoptedBasis[0], before.normalizedContent.adoptedBasis[0]);
  assert.equal(after.nextState.mapUpdates.at(-1).payloadDigest,
    operationPayloadDigest(after.previewContentDigest, 'ui:explicit-save'));
  assert.deepEqual(validateFullState(after.nextState), []);
});

test('adoption always persists a comparable confirmation fact, never a bare content digest', () => {
  for (const [state, status, decisionId] of [
    [pairState(), 'candidate', null],
    [pairState({confirm: true}), 'confirmed', AXIS_DECISION],
  ]) {
    const built = buildAxis(state, ids(1240));
    const [adopted] = built.checkpoint.adoptedBasis;
    assert.deepEqual(Object.keys(adopted).sort(), ['claimId', 'confirmation', 'contentDigest', 'snapshotPath']);
    assert.deepEqual(Object.keys(adopted.confirmation).sort(), ['assessmentDigest', 'decisionId', 'status']);
    assert.equal(adopted.confirmation.status, status);
    assert.equal(adopted.confirmation.decisionId, decisionId);
    assert.match(adopted.confirmation.assessmentDigest, /^sha256:[0-9a-f]{64}$/);
    // Two facts, two values: the confirmation digest is never the content digest.
    assert.notEqual(adopted.confirmation.assessmentDigest, adopted.contentDigest);
    assert.deepEqual(validateFullState(built.nextState), []);
  }
});

test('older ordinary records keep their shape: the compatibility fixture still validates', () => {
  const state = freshState();
  assert.deepEqual(validateFullState(state), []);
  // The candidate claim in the compatibility fixture is adopted with its own
  // confirmation fact and an unchanged content reading.
  const built = expectOk(build(state, contentInput({
    adoptedBasis: [{claimId: CLAIM_ID, writeSnapshot: true}],
    basisRefs: [{collection: 'intentClaim', id: CLAIM_ID}],
  }), {uuid: ids(1260)}));
  const [adopted] = built.checkpoint.adoptedBasis;
  assert.deepEqual(Object.keys(adopted).sort(), ['claimId', 'confirmation', 'contentDigest', 'snapshotPath']);
  assert.deepEqual(adopted.confirmation, {
    status: 'candidate',
    decisionId: null,
    assessmentDigest: sha256Bytes(canonicalStringify({
      disposition: 'unreviewed', contentDigest: null, reviewId: null,
    })),
  });
  assert.deepEqual(validateFullState(built.nextState), []);
});
