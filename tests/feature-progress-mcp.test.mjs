import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildContextGet,
  buildMapQuery,
  buildProjectGet,
  resolveProjectBinding,
} from '../scripts/mcp-context.mjs';
import {
  normaliseMaintenanceArguments,
  previewMaintenance,
  resolveMaintenanceAuthorizationBinding,
} from '../scripts/mcp-maintenance.mjs';
import { sha256Bytes } from '../scripts/state-store.mjs';
import { makeTempDir } from './store-fixtures.mjs';

const skillRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturePath = path.join(skillRoot, 'examples', 'feature-progress-state-0.2.json');
const RESUME = 'capability:progress-resume';
const SEARCH = 'capability:search';
const ROADMAP = 'roadmap:progress-resume';

async function readFixture() {
  return JSON.parse(await fs.readFile(fixturePath, 'utf8'));
}

function snapshotOf(state) {
  return {
    projectId: state.project.id,
    schemaVersion: state.schemaVersion,
    stateVersion: state.stateVersion,
    fileDigest: `sha256:${'0'.repeat(64)}`,
    byteSize: 1,
    relativeStatePath: '.product-continuity/project-state.json',
    readAt: '2026-11-13T00:00:00.000Z',
  };
}

function argsOf(state, extra = {}) {
  return { projectId: state.project.id, ...extra };
}

test('project_get returns a bounded Feature index with explicit omissions and no completion claim', async () => {
  const state = await readFixture();
  const value = buildProjectGet(state, snapshotOf(state), argsOf(state));
  const progress = value.featureProgress;
  assert.equal(progress.supported, true);
  assert.equal(progress.checkpointCollection, 'present');
  assert.equal(progress.capabilityNodes, 2);
  assert.equal(progress.checkpoints, 1);
  assert.equal(progress.featuresWithCheckpoints, 1);
  assert.equal(progress.featuresWithoutCheckpoints, 1);
  assert.equal(progress.index.truncated, false);
  assert.equal(progress.index.limit, 100);
  assert.equal(progress.index.features.length, 2);
  assert.match(progress.note, /not a review/i);
  assert.match(progress.note, /nextAction/i);

  const resume = progress.index.features.find((feature) => feature.nodeId === RESUME);
  assert.ok(resume);
  assert.equal(resume.checkpointCount, 1);
  assert.equal(resume.latestId, state.featureCheckpoints[0].id);
  assert.equal(resume.latestSummary, state.featureCheckpoints[0].summary);
  assert.equal(resume.latestAt, state.featureCheckpoints[0].createdAt);
  assert.equal(resume.nextActionsStatus, 'recorded');
  assert.equal(resume.roadmap.id, ROADMAP);
  assert.equal(resume.roadmap.horizon, 'next');

  const search = progress.index.features.find((feature) => feature.nodeId === SEARCH);
  assert.ok(search);
  assert.equal(search.latestId, null);
  assert.equal(search.checkpointCount, 0);

  const bounded = buildProjectGet(state, snapshotOf(state), argsOf(state), {
    limits: { maxNodes: 1 },
  });
  assert.equal(bounded.featureProgress.index.features.length, 1);
  assert.equal(bounded.featureProgress.index.truncated, true);
});

test('context_get returns one complete Feature context per selected capability, never only the first', async () => {
  const state = await readFixture();
  const value = buildContextGet(
    state,
    snapshotOf(state),
    argsOf(state, { nodeIds: [RESUME, SEARCH] }),
  );
  assert.equal(value.featureProgress.length, 2);
  const byId = new Map(value.featureProgress.map((entry) => [entry.feature.nodeId, entry]));

  const resume = byId.get(RESUME);
  assert.ok(resume);
  assert.equal(resume.feature.label, 'Resume progress');
  assert.equal(resume.checkpoints.count, 1);
  assert.equal(resume.checkpoints.returned, 1);
  assert.equal(resume.checkpoints.truncated, false);
  assert.equal(resume.checkpoints.records.length, 1);
  assert.equal(resume.checkpoints.records[0].id, state.featureCheckpoints[0].id);
  assert.equal(resume.latest.id, state.featureCheckpoints[0].id);
  assert.equal(resume.authorization.checkpointIsNotReview, true);
  assert.equal(resume.authorization.latestIsNotAuthoritative, true);
  assert.equal(resume.authorization.nextActionsAreNotAuthorization, true);
  assert.equal(resume.context.status, 'unchanged');
  assert.equal(resume.context.fingerprintVersion, 1);
  assert.match(resume.context.recordedFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(resume.context.currentFingerprint, resume.context.recordedFingerprint);
  assert.deepEqual(resume.context.changedSections, []);
  assert.deepEqual(
    resume.basisRecords.map((record) => `${record.collection}:${record.id}`).sort(),
    [
      'evidence:evidence:checkpoint-tests',
      'intentClaim:claim:resume:v1',
      'node:impl:checkpoint-cli',
      'roadmapItem:roadmap:progress-resume',
    ],
  );
  assert.ok(resume.basisRecords.every((record) => record.found === true));
  assert.deepEqual(
    Object.keys(resume.basisRecords[0]).sort(),
    ['collection', 'found', 'id', 'record'],
  );

  const search = byId.get(SEARCH);
  assert.ok(search);
  assert.equal(search.checkpoints.count, 0);
  assert.equal(search.checkpoints.records.length, 0);
  assert.equal(search.latest, null);
  assert.deepEqual(search.basisRecords, []);
  assert.equal(search.context.status, 'no_checkpoint');
});

test('MCP context comparison uses the content-object digest for unchanged and changed saved context', async () => {
  const state = await readFixture();
  const unchanged = buildContextGet(
    state,
    snapshotOf(state),
    argsOf(state, { nodeIds: [RESUME] }),
  ).featureProgress[0].context;
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.fingerprintVersion, 1);
  assert.match(unchanged.currentFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(unchanged.currentFingerprint, unchanged.recordedFingerprint);
  assert.deepEqual(unchanged.changedSections, []);
  assert.deepEqual(unchanged.differences, []);

  const changedState = await readFixture();
  const claim = changedState.intentClaims.find((item) => item.id === 'claim:resume:v1');
  assert.ok(claim);
  claim.statement = `${claim.statement} Edited after the checkpoint.`;
  const changed = buildContextGet(
    changedState,
    snapshotOf(changedState),
    argsOf(changedState, { nodeIds: [RESUME] }),
  ).featureProgress[0].context;
  assert.equal(changed.status, 'changed');
  assert.equal(changed.fingerprintVersion, 1);
  assert.ok(changed.changedSections.includes('content'));
  assert.notEqual(changed.currentFingerprint, changed.recordedFingerprint);
  assert.deepEqual(changed.differences, []);
});

test('basis records merge basis.refs, workDone and remaining refs, and resolve a checkpoint ref one hop only', async () => {
  const state = await readFixture();
  const root = state.featureCheckpoints[0];
  const rootId = root.id;
  // A reference stored only on the older checkpoint must not be expanded when
  // the latest checkpoint points at that older checkpoint.
  root.basis.refs.push({ collection: 'node', id: 'goal:resume' });
  const second = structuredClone(root);
  second.id = 'checkpoint:test-second';
  second.createdAt = '2026-11-13T01:00:00.000Z';
  second.supersedes = rootId;
  second.basis.refs = [
    { collection: 'intentClaim', id: 'claim:resume:v1' },
    { collection: 'roadmapItem', id: ROADMAP },
  ];
  second.workDone = [
    { statement: 'Synthetic follow-up work.', basisRefs: [{ collection: 'featureCheckpoint', id: rootId }] },
  ];
  second.remaining = [
    {
      category: 'verification',
      responsibility: 'agent',
      statement: 'Synthetic follow-up verification.',
      basisRefs: [{ collection: 'evidence', id: 'evidence:checkpoint-tests' }],
    },
  ];
  state.featureCheckpoints.push(second);

  const value = buildContextGet(state, snapshotOf(state), argsOf(state, { nodeIds: [RESUME] }));
  const entry = value.featureProgress[0];
  assert.equal(entry.checkpoints.count, 2);
  assert.equal(entry.latest.id, second.id);
  assert.equal(entry.basisRecords.length, 4);
  assert.ok(entry.basisRecords.every((record) => record.found === true));
  const checkpointRecord = entry.basisRecords.find((record) => record.collection === 'featureCheckpoint');
  assert.ok(checkpointRecord);
  assert.equal(checkpointRecord.id, rootId);
  assert.equal(checkpointRecord.found, true);
  assert.equal(checkpointRecord.record.id, rootId);
  assert.equal(entry.basisRecords.some((record) => record.id === 'goal:resume'), false);
});

test('context_get rejects over-limit checkpoint chains and basis records instead of truncating', async () => {
  const state = await readFixture();
  assert.throws(
    () => buildContextGet(state, snapshotOf(state), argsOf(state, { nodeIds: [RESUME] }), {
      limits: { maxCheckpointBasisRecords: 3 },
    }),
    (error) => error.code === 'result_too_large' && error.details.collection === 'checkpointBasisRecords',
  );

  const second = structuredClone(state.featureCheckpoints[0]);
  second.id = 'checkpoint:test-second';
  second.nodeId = SEARCH;
  second.supersedes = null;
  second.basis.refs = [];
  state.featureCheckpoints.push(second);
  assert.throws(
    () => buildContextGet(state, snapshotOf(state), argsOf(state, { nodeIds: [RESUME, SEARCH] }), {
      limits: { maxFeatureCheckpoints: 1 },
    }),
    (error) => error.code === 'result_too_large'
      && error.details.collection === 'featureCheckpoints'
      && error.details.count === 2
      && error.details.limit === 1,
  );
});

test('map_query returns one compact progress summary per selected capability, not the first only', async () => {
  const state = await readFixture();
  const value = buildMapQuery(
    state,
    snapshotOf(state),
    argsOf(state, { nodeIds: [RESUME, SEARCH] }),
  );
  assert.deepEqual(value.featureProgress.map((entry) => entry.nodeId), [RESUME, SEARCH]);
  const resume = value.featureProgress[0];
  assert.equal(resume.latest.id, state.featureCheckpoints[0].id);
  assert.equal(resume.latest.firstNextAction.actor, 'agent');
  assert.equal(resume.source.status, 'recorded_not_verified');
  const search = value.featureProgress[1];
  assert.equal(search.latest, null);
  assert.equal(search.checkpoints.count, 0);
});

test('delivery readings agree across project_get/map_query/context_get and a delivery-only basisRef is returned', async () => {
  const state = await readFixture();
  // Executed evidence referenced only by delivery.basisRefs: outside basis.refs,
  // workDone/remaining refs and the v1 fingerprint closure.
  state.evidence.push({
    id: 'evidence:delivery-exec', kind: 'test_execution',
    claim: 'Synthetic executed check; fixture only.', validation: 'passed',
    observedAt: '2026-11-13T00:00:00Z',
  });
  const tail = state.featureCheckpoints[0];
  tail.remaining = [];
  tail.nextActions = [];
  tail.nextActionsStatus = 'none';
  tail.delivery = {
    status: 'completed',
    summary: 'Synthetic saved completion; not acceptance or release authorization.',
    basisRefs: [{ collection: 'evidence', id: 'evidence:delivery-exec' }],
  };

  const project = buildProjectGet(state, snapshotOf(state), argsOf(state)).featureProgress;
  const map = buildMapQuery(state, snapshotOf(state), argsOf(state, { nodeIds: [RESUME, SEARCH] })).featureProgress;
  const context = buildContextGet(state, snapshotOf(state), argsOf(state, { nodeIds: [RESUME, SEARCH] })).featureProgress;

  const projectResume = project.index.features.find((feature) => feature.nodeId === RESUME);
  assert.deepEqual(projectResume.delivery, {
    status: 'completed', label: '已完成', origin: 'explicit_delivery', needsReview: false,
    savedAt: tail.createdAt,
  });
  const mapResume = map.find((entry) => entry.nodeId === RESUME);
  const contextResume = context.find((entry) => entry.feature.nodeId === RESUME);
  // Full readings agree between map_query and context_get.
  assert.deepEqual(mapResume.delivery, contextResume.delivery);
  assert.equal(mapResume.delivery.status, 'completed');
  assert.equal(mapResume.delivery.label, '已完成');
  assert.equal(mapResume.delivery.origin, 'explicit_delivery');
  assert.equal(mapResume.delivery.needsReview, false);
  assert.equal(mapResume.delivery.summary, tail.delivery.summary);
  assert.deepEqual(mapResume.delivery.basisRefs, [{ collection: 'evidence', id: 'evidence:delivery-exec' }]);
  assert.equal(mapResume.delivery.savedAt, tail.createdAt);
  assert.match(mapResume.delivery.reason, /不是本次运行验收/);
  assert.equal(mapResume.context.status, 'unchanged');
  // The bounded index stays consistent with the full reading.
  assert.equal(projectResume.delivery.status, mapResume.delivery.status);
  assert.equal(projectResume.delivery.label, mapResume.delivery.label);
  assert.equal(projectResume.delivery.needsReview, mapResume.delivery.needsReview);
  assert.equal(projectResume.delivery.savedAt, mapResume.delivery.savedAt);
  // The delivery-only basisRef is resolved and returned by context_get.
  const deliveryRecord = contextResume.basisRecords.find((record) => record.id === 'evidence:delivery-exec');
  assert.ok(deliveryRecord, 'delivery-only basisRef must be returned');
  assert.equal(deliveryRecord.collection, 'evidence');
  assert.equal(deliveryRecord.found, true);
  assert.equal(deliveryRecord.record.kind, 'test_execution');
  assert.equal(deliveryRecord.record.validation, 'passed');
  assert.equal(contextResume.authorization.deliveryIsNotAcceptance, true);
  assert.equal(contextResume.authorization.deliveryIsNotReleaseAuthorization, true);
  // The empty capability reads unknown/no_basis consistently on every surface.
  const projectSearch = project.index.features.find((feature) => feature.nodeId === SEARCH);
  const mapSearch = map.find((entry) => entry.nodeId === SEARCH);
  const contextSearch = context.find((entry) => entry.feature.nodeId === SEARCH);
  assert.equal(projectSearch.delivery.status, 'unknown');
  assert.equal(projectSearch.delivery.origin, 'no_basis');
  assert.deepEqual(mapSearch.delivery, contextSearch.delivery);
  assert.equal(mapSearch.delivery.status, 'unknown');

  // The delivery-only evidence later fails: every surface must flag review and
  // stop claiming completion even though the fingerprint closure is unchanged.
  state.evidence.find((item) => item.id === 'evidence:delivery-exec').validation = 'failed';
  const failedProject = buildProjectGet(state, snapshotOf(state), argsOf(state)).featureProgress.index.features.find((feature) => feature.nodeId === RESUME);
  const failedMap = buildMapQuery(state, snapshotOf(state), argsOf(state, { nodeIds: [RESUME] })).featureProgress[0];
  const failedContext = buildContextGet(state, snapshotOf(state), argsOf(state, { nodeIds: [RESUME] })).featureProgress[0];
  assert.equal(failedProject.delivery.status, 'unknown');
  assert.equal(failedProject.delivery.needsReview, true);
  assert.equal(failedMap.delivery.status, 'unknown');
  assert.equal(failedMap.delivery.needsReview, true);
  assert.equal(failedMap.context.status, 'unchanged');
  assert.ok(failedMap.warnings.length > 0);
  assert.deepEqual(failedMap.delivery, failedContext.delivery);
  assert.equal(failedContext.delivery.label, '状态待补充');
  assert.ok(failedContext.delivery.reviewReason.includes('需复核'));
});

test('frozen 0.1 reports unsupported progress without inventing checkpoints', async () => {
  const state = await readFixture();
  state.schemaVersion = '0.1';
  const snapshot = { ...snapshotOf(state), schemaVersion: '0.1' };
  const progress = buildProjectGet(state, snapshot, argsOf(state)).featureProgress;
  assert.equal(progress.supported, false);
  assert.equal(progress.checkpointCollection, 'unsupported');
  assert.equal(progress.checkpoints, 0);
  assert.equal(progress.index.features.length, 0);
  assert.equal(progress.index.truncated, false);
  assert.deepEqual(
    buildContextGet(state, snapshot, argsOf(state, { nodeIds: [RESUME] })).featureProgress,
    [],
  );
  assert.deepEqual(
    buildMapQuery(state, snapshot, argsOf(state, { nodeIds: [RESUME] })).featureProgress,
    [],
  );
});

test('MCP maintenance preview reports checkpoints as preserved and rejects any checkpoint input', async (t) => {
  const state = await readFixture();
  const root = await makeTempDir('mcp-progress-maintenance-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'auth'));
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const statePath = path.join(root, 'state.json');
  await fs.writeFile(statePath, bytes);
  const binding = await resolveProjectBinding({
    projectRoot: root,
    state: 'state.json',
    projectId: state.project.id,
  });
  const maintenance = await resolveMaintenanceAuthorizationBinding(binding, 'auth/grant.json');
  const plan = {
    projectId: state.project.id,
    operationId: 'mcp-progress-preserve',
    expectedStateVersion: state.stateVersion,
    expectedDigest: sha256Bytes(bytes),
    summary: 'Synthetic annotation next to saved progress checkpoints',
    changes: {
      nodes: [
        {
          id: 'unknown:progress-probe',
          kind: 'unknown',
          label: 'Synthetic unresolved probe',
          status: 'unknown',
          evidenceIds: [],
        },
      ],
      edges: [],
      evidence: [],
      checks: [],
    },
  };
  const preview = await previewMaintenance(binding, maintenance, plan, {
    clock: '2026-11-13T05:00:00.000Z',
  });
  assert.equal(preview.applied, false);
  assert.equal(preview.preserved.fields.featureCheckpoints, true);
  assert.equal(preview.preserved.countsBefore.featureCheckpoints, 1);
  assert.equal(preview.preserved.countsAfter.featureCheckpoints, 1);
  assert.equal(JSON.stringify(preview.diff).includes('featureCheckpoints'), false);

  assert.throws(
    () => normaliseMaintenanceArguments(
      { ...plan, changes: { ...plan.changes, featureCheckpoints: [] } },
      state.project.id,
    ),
    (error) => error.code === 'invalid_arguments',
  );
});
